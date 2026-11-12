import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { getUserDatabaseSettings } from "../../src/lib/db/databaseSettings.ts";
import os from "node:os";
import path from "node:path";

// Regression guard for the 2026-11-04 524 incident: an in-process `VACUUM` inside
// startCleanupScheduler() froze the Node event loop for 175s, so Cloudflare timed
// out every request. VACUUM must never run inside the process again, and
// conversation_turn_nodes must be pruned in bounded batches instead.

const CLEANUP_PATH = path.resolve(import.meta.dirname, "../../src/lib/db/cleanup.ts");

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// Point DATA_DIR at a private dir BEFORE core.ts is evaluated, so the module
// opens (and migrates) a throwaway database instead of the operator's real one.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cleanup-novacuum-"));
process.env.DATA_DIR = tmpDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const mod = await import("../../src/lib/db/cleanup.ts");

const db = core.getDbInstance();

after(() => {
  try {
    core.resetDbInstance();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("cleanup: scheduler never runs VACUUM", () => {
  it("no VACUUM statement remains in cleanup.ts", () => {
    const source = fs.readFileSync(CLEANUP_PATH, "utf-8");
    // Strip comments so the explanatory "VACUUM disabled" log text does not count.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.ok(
      !/\.exec\(\s*["'`]\s*VACUUM/i.test(code),
      "cleanup.ts must not execute VACUUM — it blocked the event loop for 175s on 2026-11-04"
    );
  });

  it("the scheduler log line records VACUUM as disabled", () => {
    const source = fs.readFileSync(CLEANUP_PATH, "utf-8");
    assert.ok(
      source.includes("in-process VACUUM disabled to prevent event loop freeze"),
      "scheduler must log why VACUUM is gone, so operators do not re-add it"
    );
  });
});

describe("cleanup: conversation retention pruning", () => {
  const insConv = () =>
    db.prepare(
      "INSERT INTO agentic_conversations (id, fingerprint_hash, last_message_count, last_messages_hash, first_seen_at, last_seen_at) VALUES (?, 'fp', 0, 'mh', ?, ?)"
    );
  const insNode = () =>
    db.prepare(
      "INSERT INTO conversation_turn_nodes (id, conversation_id, parent_id, role, first_seen_at, last_seen_at) VALUES (?, ?, NULL, 'user', ?, ?)"
    );

  before(() => {
    db.exec("DELETE FROM conversation_turn_nodes; DELETE FROM agentic_conversations;");
  });

  it("deletes rows older than the cutoff and keeps recent rows", async () => {
    const oldIso = isoDaysAgo(120);
    const newIso = isoDaysAgo(1);
    const conv = insConv();
    const node = insNode();
    for (let i = 0; i < 3; i++) {
      conv.run(`conv_old_${i}`, oldIso, oldIso);
      node.run(`node_old_${i}`, `conv_old_${i}`, oldIso, oldIso);
    }
    conv.run("conv_new", newIso, newIso);
    node.run("node_new", "conv_new", newIso, newIso);

    const result = await mod.cleanupAgenticConversations();

    assert.equal(result.errors, 0, "cleanup must not error");
    assert.equal(result.deleted, 6, "3 old nodes + 3 old conversations");
    assert.deepEqual(
      db.prepare("SELECT id FROM conversation_turn_nodes").all(),
      [{ id: "node_new" }],
      "recent turn node must survive"
    );
    assert.deepEqual(
      db.prepare("SELECT id FROM agentic_conversations").all(),
      [{ id: "conv_new" }],
      "recent conversation must survive"
    );
  });

  it("prunes a 12,500-row backlog in bounded batches and terminates", async () => {
    db.exec("DELETE FROM conversation_turn_nodes; DELETE FROM agentic_conversations;");
    const oldIso = isoDaysAgo(120);
    const node = insNode();
    // A parent row is required now: phase 1 skips nodes whose conversation is
    // still active, so an unparented node is never age-pruned.
    insConv().run("c", oldIso, oldIso);
    db.transaction(() => {
      for (let i = 0; i < 12_500; i++) node.run(`bulk_${i}`, "c", oldIso, oldIso);
    })();

    // Record each phase-1 chunk DELETE's changes: 5000, 5000, 2500. The short
    // 2500 chunk is what terminates the loop; matched on the SELECT body so the
    // phase-3 orphan sweep does not record here.
    const chunkChanges: number[] = [];
    const realPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const stmt = realPrepare(sql) as unknown as {
        run: (...a: unknown[]) => { changes: number };
      };
      // Matched on the phase-1 body only. The newer form selects "n.id FROM
      // conversation_turn_nodes n", so match that too rather than pinning the
      // exact old SQL (phase 3 must not record here).
      if (
        !sql.includes("SELECT id FROM conversation_turn_nodes WHERE last_seen_at < ?") &&
        !sql.includes("SELECT n.id FROM conversation_turn_nodes n")
      ) {
        return stmt;
      }
      const realRun = stmt.run.bind(stmt);
      stmt.run = (...args: unknown[]) => {
        const r = realRun(...args);
        chunkChanges.push(r.changes);
        return r;
      };
      return stmt;
    };

    let result;
    try {
      result = await mod.cleanupAgenticConversations();
    } finally {
      (db as unknown as { prepare: typeof realPrepare }).prepare = realPrepare;
    }

    assert.equal(result.errors, 0);
    // 12,500 nodes + the 1 parent conversation row this fixture now needs.
    assert.equal(result.deleted, 12_501, "all 12,500 nodes plus the expired parent are pruned");
    assert.deepEqual(
      chunkChanges,
      [5000, 5000, 2500],
      "must delete in 5000-row chunks and stop at the short chunk"
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) c FROM conversation_turn_nodes").get() as { c: number }).c,
      0,
      "no rows may remain"
    );
  });

  it("prunes only by age — a node inside the window survives without a parent", async () => {
    // No orphan sweep exists: pruning is purely age-based, so a recent node is
    // kept even if its parent conversation row is missing (crash window between
    // the parent bump and the node insert).
    db.exec("DELETE FROM conversation_turn_nodes; DELETE FROM agentic_conversations;");
    const recent = isoDaysAgo(1);
    const stale = isoDaysAgo(120);
    insNode().run("crash_window_node", "not_yet_written", recent, recent);
    insNode().run("stale_orphan", "missing_conv", stale, stale);

    const result = await mod.cleanupAgenticConversations();

    assert.equal(result.errors, 0);
    assert.equal(result.deleted, 1, "only the stale node is pruned");
    assert.deepEqual(
      db.prepare("SELECT id FROM conversation_turn_nodes ORDER BY id").all(),
      [{ id: "crash_window_node" }],
      "age decides, not parent presence"
    );
  });

  it("bounds each tick with a time budget, a chunk cap, and chunk-sized deletes", () => {
    // Guards the property that keeps this off the event loop for long stretches.
    // Asserted on the source because the values are module-private constants and
    // wall-clock assertions on a loaded host (loadavg >10 observed) are flaky.
    const source = fs.readFileSync(CLEANUP_PATH, "utf-8");
    const budget = /const CHUNK_TIME_BUDGET_MS = (\d+);/.exec(source)?.[1];
    const cap = /const CHUNK_LOOP_CAP = (\d+);/.exec(source)?.[1];
    const size = /const CHUNK_SIZE = (\d+);/.exec(source)?.[1];
    assert.ok(budget && Number(budget) > 0 && Number(budget) <= 5000, `tick budget too large: ${budget}`);
    assert.ok(cap && Number(cap) > 0 && Number(cap) <= 500, `chunk cap too large: ${cap}`);
    assert.equal(size, "5000", "chunk size must stay at 5000 rows per statement");
    assert.ok(
      source.includes("setImmediate(resolve)"),
      "chunk loop must yield to the event loop between batches"
    );
  });

  it("follows the configured retention window, and never prunes an active conversation", async () => {
    // The cutoff is retention.callLogs, derived from the live setting rather
    // than hard-coded so this stays honest at 30, 90, or 365 days.
    //
    // Active-conversation protection was added deliberately (2026-11-13).
    // conversation_turn_nodes.last_seen_at is written once at insert and never
    // updated, so EVERY early turn of a live conversation is "old" by that
    // column. Without the guard, a 30-day window would delete the chain head of
    // exactly the transcripts still in use -- which is what this test used to
    // assert ("parents stay recent so only the age rule can decide").
    const days = getUserDatabaseSettings().retention?.callLogs ?? 30;
    db.exec("DELETE FROM conversation_turn_nodes; DELETE FROM agentic_conversations;");
    const node = insNode();
    const conv = insConv();
    const now = isoDaysAgo(0);
    const stale = isoDaysAgo(days + 1);
    for (const d of [days - 1, days + 1]) {
      conv.run(`bound_conv_${d}`, now, now);
      node.run(`bound_node_${d}`, `bound_conv_${d}`, isoDaysAgo(d), isoDaysAgo(d));
    }
    // Same node ages, but under an IDLE conversation (last_seen_at well past the
    // cutoff): this one must be pruned, proving age still decides.
    conv.run("idle_conv", stale, stale);
    node.run("idle_node", "idle_conv", stale, stale);

    const result = await mod.cleanupAgenticConversations();

    assert.equal(result.errors, 0);
    assert.deepEqual(
      db.prepare("SELECT id FROM conversation_turn_nodes ORDER BY id").all(),
      [{ id: `bound_node_${days - 1}` }, { id: `bound_node_${days + 1}` }],
      `both nodes of the ACTIVE conversation survive (the ${days + 1}-day one only ` +
        "because its parent is recent), and the idle conversation's stale node is pruned"
    );
  });
});
