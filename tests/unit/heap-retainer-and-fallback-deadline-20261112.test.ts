import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Regression guards for the 2026-11-12 slow-API audit (F1..F5).
// See /home/admin_user/lyrics-scraper-production/docs/audits/
//     2026-11-12-omniroute-slow-api-multi-axis-audit.md

const WT = path.resolve(import.meta.dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(WT, rel), "utf-8");

// ---------------------------------------------------------------- FIX-A
describe("FIX-A: stream terminal callbacks are released", () => {
  const src = read("open-sse/utils/streamHandler.ts");

  it("terminal callbacks are mutable bindings, not frozen params", () => {
    assert.ok(
      src.includes("onDisconnect: initialOnDisconnect"),
      "onDisconnect must be destructured under a rename so a `let` can own it"
    );
    assert.ok(
      src.includes("let onDisconnect = initialOnDisconnect"),
      "onDisconnect must be a mutable let binding"
    );
    assert.ok(src.includes("let onError = initialOnError"), "onError must be mutable");
  });

  it("a release helper clears all three retainer slots", () => {
    const fn = src.slice(src.indexOf("const releaseTerminalCallbacks"), src.indexOf("const controller = {"));
    assert.ok(fn.includes("onDisconnect = undefined"), "must clear onDisconnect");
    assert.ok(fn.includes("onError = undefined"), "must clear onError");
    assert.ok(fn.includes("completedToolHandoffDrain = null"), "must clear the drain");
  });

  it("release is called from complete, disconnect and error", () => {
    // Three call sites strictly inside the controller methods, plus the
    // `const releaseTerminalCallbacks` declaration line.
    const calls = (src.match(/releaseTerminalCallbacks\(\)/g) || []).length;
    assert.equal(calls, 3, `expected 3 call sites inside the handlers, saw ${calls}`);
    assert.ok(src.includes("const releaseTerminalCallbacks"), "declaration must exist");
  });
});

describe("FIX-A: truncation detaches SlicedString parents", () => {
  it("flatCopy is applied to every truncation return", () => {
    const src = read("open-sse/handlers/chatCore/logTruncation.ts");
    assert.ok(
      src.includes('from "@/lib/usage/usageHistory/helpers"'),
      "must import flatCopy from the usage helpers"
    );
    assert.ok(!src.includes("return value.slice("), "no bare slice() may be returned");
    const exports = src.slice(src.indexOf("export function capMemoryExtractionText"));
    const flat = (exports.match(/flatCopy\(/g) || []).length;
    assert.ok(flat >= 3, `expected flatCopy on every branch, saw ${flat}`);
  });
});

// ---------------------------------------------------------------- FIX-B
describe("FIX-B: combo walk shares one deadline", () => {
  it("handleComboChat wraps the inner call in runWithRequestDeadline", () => {
    const src = read("open-sse/services/combo.ts");
    assert.ok(
      src.includes('import { runWithRequestDeadline } from "../utils/requestDeadline.ts"'),
      "combo.ts must import runWithRequestDeadline"
    );
    const body = src.slice(
      src.indexOf("export async function handleComboChat("),
      src.indexOf("async function handleComboChatInner")
    );
    assert.ok(
      body.includes("runWithRequestDeadline(() =>"),
      "the combo entry must stamp one deadline for the whole walk"
    );
  });

  it("nested wrap reuses the outermost budget instead of resetting", async () => {
    const { runWithRequestDeadline, getRemainingBudgetMs } = await import(
      "../../open-sse/utils/requestDeadline.ts"
    );
    await runWithRequestDeadline(async () => {
      const outer = getRemainingBudgetMs();
      assert.ok(outer !== null, "outer context must exist");
      // Simulate sequential fallback targets: each re-enters the wrap.
      for (let i = 0; i < 3; i++) {
        await runWithRequestDeadline(async () => {
          const inner = getRemainingBudgetMs();
          assert.ok(inner !== null);
          assert.ok(inner! <= outer!, "an inner wrap must never extend the budget");
        });
      }
    });
  });
});

// ---------------------------------------------------------------- FIX-C
describe("FIX-C: in-process VACUUM is gone", () => {
  it("vacuumScheduler never executes VACUUM", () => {
    const src = read("src/lib/db/vacuumScheduler.ts");
    assert.ok(!/\.exec\(\s*["'`]\s*VACUUM/i.test(src), "VACUUM must not run in-process");
    assert.ok(src.includes('wal_checkpoint(PASSIVE)'), "must fall back to a PASSIVE checkpoint");
    assert.ok(src.includes("In-process VACUUM disabled"), "must log why it changed");
  });

  it("default scheduledVacuum is never", () => {
    const src = read("src/types/databaseSettings.ts");
    assert.ok(
      /scheduledVacuum:\s*"never",/.test(src),
      "the shipped default must be never, so a settings reset cannot re-arm VACUUM"
    );
  });
});

// ---------------------------------------------------------------- FIX-D
describe("FIX-D: volume-capped retention", () => {
  const src = read("src/lib/db/cleanup.ts");

  it("exports a row ceiling with env override", () => {
    assert.ok(
      src.includes("export const MAX_TURN_NODES_ROWS"),
      "the cap must be exported so tests and operators can see it"
    );
    assert.ok(
      src.includes("OMNIROUTE_MAX_TURN_NODES_ROWS"),
      "the cap must be overridable by env"
    );
  });

  it("prunes oldest rows when over the cap", () => {
    assert.ok(
      src.includes("ORDER BY last_seen_at ASC LIMIT"),
      "must delete the oldest rows first once over the cap"
    );
    assert.ok(
      src.includes("NOT EXISTS (SELECT 1 FROM conversation_turn_nodes n"),
      "must prune conversations newly orphaned by the cap sweep"
    );
  });
});

// ---------------------------------------------------------------- FIX-E
describe("FIX-E: one log line per heap rejection", () => {
  const src = read("open-sse/utils/resourcePressure.ts");

  it("the critical builder no longer logs", () => {
    const fn = src.slice(src.indexOf("function buildCriticalGuard"), src.indexOf("function immediateHeapGuard"));
    assert.ok(!fn.includes("console.warn"), "the builder must not log; callers own the message");
  });

  it("exactly one warning is emitted on the immediate heap path", () => {
    const fn = src.slice(src.indexOf("function immediateHeapGuard"), src.indexOf("export function createResourcePressureRuntime"));
    const warns = (fn.match(/console\.warn\(/g) || []).length;
    assert.equal(warns, 1, `expected exactly 1 warning in immediateHeapGuard, saw ${warns}`);
  });
});

// ---------------------------------------------------------------- integration
describe("no regression: cleanup entry still wired", () => {
  it("runAutoCleanup includes agenticConversations", () => {
    assert.ok(read("src/lib/db/cleanup.ts").includes("agenticConversations: await cleanupAgenticConversations()"));
  });
});
