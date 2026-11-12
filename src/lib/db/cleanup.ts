/**
 * Database cleanup functions for removing old data based on retention policies.
 *
 * @module lib/db/cleanup
 */

import { getDbInstance } from "./core";
import { getUserDatabaseSettings } from "./databaseSettings";
import { rollupUsageHistoryBeforeDate } from "@/lib/usage/aggregateHistory";
import { purgeCallLogArtifactDirectory } from "@/lib/usage/callLogArtifacts";
import {
  collectCallLogArtifactsBefore,
  deleteAllFromTable,
  deleteCallLogArtifacts,
  deleteFromTableBefore,
  type DeleteByPeriodTarget,
} from "./cleanup/usagePurge";

// Agentic-conversation retention: rows per DELETE statement, wall-clock budget
// per scheduler tick (the remainder drains on later ticks), and a hard iteration
// cap so a mis-reporting driver cannot spin the loop forever.
const CHUNK_SIZE = 5000;
// Hard row ceiling for conversation_turn_nodes. Age retention alone cannot
// bound a table growing faster than its window; see cleanupAgenticConversations.
const DEFAULT_MAX_TURN_NODES_ROWS = 500_000;
/** Conversations inspected per cap iteration; bounds the id set per pass. */
const MAX_CAP_CONVERSATIONS_PER_TICK = 100;
/** Clamped to a positive integer: `-5` or `1e400` must not become a wipe. */
export const MAX_TURN_NODES_ROWS = (() => {
  const raw = Number(process.env.OMNIROUTE_MAX_TURN_NODES_ROWS);
  if (Number.isInteger(raw) && raw > 0) return raw;
  if (process.env.OMNIROUTE_MAX_TURN_NODES_ROWS !== undefined) {
    console.warn(
      `[Cleanup] Ignoring invalid OMNIROUTE_MAX_TURN_NODES_ROWS="${process.env.OMNIROUTE_MAX_TURN_NODES_ROWS}"; using ${DEFAULT_MAX_TURN_NODES_ROWS}`
    );
  }
  return DEFAULT_MAX_TURN_NODES_ROWS;
})();
const CHUNK_TIME_BUDGET_MS = 2000;
const CHUNK_LOOP_CAP = 200;

interface CleanupResult {
  deleted: number;
  deletedArtifacts?: number;
  errors: number;
}

function getRetentionSettings() {
  return getUserDatabaseSettings().retention;
}

/**
 * Clean up old quota_snapshots based on retention settings.
 */
export async function cleanupQuotaSnapshots(): Promise<CleanupResult> {
  const db = getDbInstance();
  const retention = getRetentionSettings();

  const retentionDays = retention.quotaSnapshots;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffISO = cutoffDate.toISOString();

  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const stmt = db.prepare("DELETE FROM quota_snapshots WHERE created_at < ?");
    const runResult = stmt.run(cutoffISO);
    result.deleted = runResult.changes;

    console.log(
      `[Cleanup] Deleted ${result.deleted} quota_snapshots older than ${retentionDays} days`
    );
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning quota_snapshots:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up old call_logs based on retention settings.
 */
export async function cleanupCallLogs(): Promise<CleanupResult> {
  const db = getDbInstance();
  const retention = getRetentionSettings();

  const retentionDays = retention.callLogs;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffISO = cutoffDate.toISOString();

  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const stmt = db.prepare("DELETE FROM call_logs WHERE timestamp < ?");
    const runResult = stmt.run(cutoffISO);
    result.deleted = runResult.changes;

    console.log(`[Cleanup] Deleted ${result.deleted} call_logs older than ${retentionDays} days`);
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning call_logs:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up old usage_history based on retention settings.
 */
export async function cleanupUsageHistory(): Promise<CleanupResult> {
  const db = getDbInstance();
  const retention = getRetentionSettings();

  const retentionDays = retention.usageHistory;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffISO = cutoffDate.toISOString();
  const cutoffDateStr = cutoffISO.split("T")[0];

  const result: CleanupResult = { deleted: 0, errors: 0 };

  // Roll up rows that are about to be deleted into daily_usage_summary so that the
  // analytics route can still surface historical data via the UNION query. The rollup
  // uses the exact same day boundary as the DELETE below, so every deleted row
  // is guaranteed to have been aggregated first.
  //
  // rollupUsageHistoryBeforeDate catches its own errors and reports them via the
  // returned result, so we inspect that rather than relying on a thrown exception.
  // If the rollup failed, abort the DELETE to avoid permanently losing raw usage data
  // that was never aggregated.
  const rollupResult = await rollupUsageHistoryBeforeDate(cutoffDateStr);
  if (rollupResult.errors > 0) {
    console.error(
      "[Cleanup] Aborting usage_history deletion because the pre-delete rollup failed."
    );
    result.errors += rollupResult.errors;
    return result;
  }

  try {
    const stmt = db.prepare("DELETE FROM usage_history WHERE timestamp < ?");
    const runResult = stmt.run(cutoffDateStr);
    result.deleted = runResult.changes;

    console.log(
      `[Cleanup] Deleted ${result.deleted} usage_history older than ${retentionDays} days`
    );
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning usage_history:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up old compression_analytics based on retention settings.
 */
export async function cleanupCompressionAnalytics(): Promise<CleanupResult> {
  const db = getDbInstance();
  const retention = getRetentionSettings();

  const retentionDays = retention.compressionAnalytics;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffISO = cutoffDate.toISOString();

  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const stmt = db.prepare("DELETE FROM compression_analytics WHERE timestamp < ?");
    const runResult = stmt.run(cutoffISO);
    result.deleted = runResult.changes;

    console.log(
      `[Cleanup] Deleted ${result.deleted} compression_analytics older than ${retentionDays} days`
    );
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning compression_analytics:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up old mcp_tool_audit based on retention settings.
 */
export async function cleanupMcpAudit(): Promise<CleanupResult> {
  const db = getDbInstance();
  const retention = getRetentionSettings();

  const retentionDays = retention.mcpAudit;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffISO = cutoffDate.toISOString();

  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const stmt = db.prepare("DELETE FROM mcp_tool_audit WHERE created_at < ?");
    const runResult = stmt.run(cutoffISO);
    result.deleted = runResult.changes;

    console.log(
      `[Cleanup] Deleted ${result.deleted} mcp_tool_audit older than ${retentionDays} days`
    );
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning mcp_tool_audit:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up old config_audit_log based on retention settings.
 */
export async function cleanupConfigAudit(retentionDays = getRetentionSettings().configAudit): Promise<CleanupResult> {
  const db = getDbInstance();
  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const stmt = db.prepare(
      "DELETE FROM config_audit_log WHERE datetime(timestamp) < datetime('now', '-' || ? || ' days')"
    );
    const runResult = stmt.run(String(retentionDays));
    result.deleted = runResult.changes;

    console.log(
      `[Cleanup] Deleted ${result.deleted} config_audit_log older than ${retentionDays} days`
    );
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning config_audit_log:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up old a2a_task_events based on retention settings.
 */
export async function cleanupA2aEvents(): Promise<CleanupResult> {
  const db = getDbInstance();
  const retention = getRetentionSettings();

  const retentionDays = retention.a2aEvents;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffISO = cutoffDate.toISOString();

  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const stmt = db.prepare("DELETE FROM a2a_task_events WHERE created_at < ?");
    const runResult = stmt.run(cutoffISO);
    result.deleted = runResult.changes;

    console.log(`[Cleanup] Deleted ${result.deleted} a2a_task_events older than ${retentionDays} days`);
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning a2a_task_events:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up old memory_entries based on retention settings.
 */
export async function cleanupMemoryEntries(): Promise<CleanupResult> {
  const db = getDbInstance();
  const retention = getRetentionSettings();

  const retentionDays = retention.memoryEntries;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffISO = cutoffDate.toISOString();

  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const stmt = db.prepare("DELETE FROM memories WHERE created_at < ?");
    const runResult = stmt.run(cutoffISO);
    result.deleted = runResult.changes;

    console.log(
      `[Cleanup] Deleted ${result.deleted} memory_entries older than ${retentionDays} days`
    );
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning memory_entries:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up old domain_cost_history based on retention settings. (#6848)
 * The `timestamp` column stores epoch milliseconds (saveCostEntry default
 * is Date.now()), so the cutoff must be in milliseconds to match. (#9625)
 */
export async function cleanupDomainCostHistory(): Promise<CleanupResult> {
  const db = getDbInstance();
  const retention = getRetentionSettings();

  const retentionDays = retention.domainCostHistory;
  const cutoffEpoch = Date.now() - retentionDays * 86_400_000;

  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const stmt = db.prepare("DELETE FROM domain_cost_history WHERE timestamp < ?");
    const runResult = stmt.run(cutoffEpoch);
    result.deleted = runResult.changes;

    console.log(
      `[Cleanup] Deleted ${result.deleted} domain_cost_history older than ${retentionDays} days`
    );
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning domain_cost_history:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up old compression_cache_stats based on retention settings. (#6848)
 * Uses `created_at` column (DATETIME string).
 */
export async function cleanupCompressionCacheStats(): Promise<CleanupResult> {
  const db = getDbInstance();
  const retention = getRetentionSettings();

  const retentionDays = retention.compressionCacheStats;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffISO = cutoffDate.toISOString();

  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const stmt = db.prepare("DELETE FROM compression_cache_stats WHERE created_at < ?");
    const runResult = stmt.run(cutoffISO);
    result.deleted = runResult.changes;

    console.log(
      `[Cleanup] Deleted ${result.deleted} compression_cache_stats older than ${retentionDays} days`
    );
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning compression_cache_stats:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up old xp_audit_log based on retention settings.
 */
export async function cleanupXpAuditLog(): Promise<CleanupResult> {
  const db = getDbInstance();
  const retention = getRetentionSettings();

  const retentionDays = retention.xpAuditLog;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffISO = cutoffDate.toISOString();

  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const stmt = db.prepare("DELETE FROM xp_audit_log WHERE created_at < ?");
    const runResult = stmt.run(cutoffISO);
    result.deleted = runResult.changes;

    console.log(
      `[Cleanup] Deleted ${result.deleted} xp_audit_log older than ${retentionDays} days`
    );
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning xp_audit_log:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up old compression_run_telemetry based on retention settings. (#6848)
 * The `timestamp` column stores epoch milliseconds (recordCompressionRun stamps
 * Date.now()), so the cutoff must be in milliseconds to match. Same unit bug as
 * domain_cost_history (#9625), which this function was missed by.
 */
export async function cleanupCompressionRunTelemetry(): Promise<CleanupResult> {
  const db = getDbInstance();
  const retention = getRetentionSettings();

  const retentionDays = retention.compressionRunTelemetry;
  const cutoffEpoch = Date.now() - retentionDays * 86_400_000;

  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const stmt = db.prepare("DELETE FROM compression_run_telemetry WHERE timestamp < ?");
    const runResult = stmt.run(cutoffEpoch);
    result.deleted = runResult.changes;

    console.log(
      `[Cleanup] Deleted ${result.deleted} compression_run_telemetry older than ${retentionDays} days`
    );
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning compression_run_telemetry:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up expired CCR blocks (#9061).
 *
 * Unlike the tables above, these rows carry their own expiry: the engine writes
 * `expires_at` from the block's TTL, so this needs no retention-days setting of its own.
 * It is the same sweep the engine does opportunistically, run on the operator's schedule
 * so the table cannot sit on rows nobody will read again.
 */
export async function cleanupCcrBlocks(): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const { pruneExpiredCcrBlocks } = await import("./ccrBlocks");
    result.deleted = pruneExpiredCcrBlocks(Date.now());
    console.log(`[Cleanup] Deleted ${result.deleted} expired ccr_blocks`);
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning ccr_blocks:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up old agentic_conversations and conversation_turn_nodes.
 * conversation_turn_nodes has accumulated 2.3M+ rows (1.5GB+) without any pruning.
 * Deletes run as atomic subquery LIMIT chunks — no db.transaction() wrapper, so
 * each chunk commits on its own and never holds a long SQLite write lock.
 */
export async function cleanupAgenticConversations(): Promise<CleanupResult> {
  const db = getDbInstance();

  const retentionDays = getUserDatabaseSettings().retention?.callLogs ?? 30;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffISO = cutoffDate.toISOString();

  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    // The chunk loops are fully synchronous better-sqlite3 calls on the Node main
    // thread. Draining a 2.3M-row backlog in one pass would freeze the event loop
    // exactly like the VACUUM this replaces (2026-11-04 incident), so the work is
    // capped per tick and the remainder drains on later 6-hourly runs.
    // Shared budget for all three phases so one tick stays bounded.
    const deadline = Date.now() + CHUNK_TIME_BUDGET_MS;

    // Returns the rows deleted plus whether the table was drained. "Drained" is
    // tracked explicitly rather than inferred from the row count: a budget break
    // after a short partial chunk still leaves a backlog behind.
    const nogilChunk = async (sql: string, params: readonly unknown[] = [cutoffISO]) => {
      const stmt = db.prepare(sql);
      let deleted = 0;
      let drained = false;
      for (let chunks = 0; chunks < CHUNK_LOOP_CAP; chunks++) {
        if (Date.now() >= deadline) {
          // A deferral is expected behaviour, not a cleanup failure — warn only.
          console.warn(
            `[Cleanup] agentic cleanup hit the ${CHUNK_TIME_BUDGET_MS}ms budget; remaining rows drain next tick`
          );
          break;
        }
        const res = stmt.run(...params);
        deleted += res.changes;
        if (res.changes < CHUNK_SIZE) {
          drained = true;
          break;
        }
        // Yield so request handlers interleave with the deletes.
        await new Promise((resolve) => setImmediate(resolve));
      }
      return { deleted, drained };
    };

    // 1. Turn nodes past the cutoff, but NEVER from a still-active conversation.
    // conversation_turn_nodes.last_seen_at is written once at insert and never
    // updated, so in a long-running conversation every early turn is "old" by
    // that column even though the conversation is live. Without the NOT EXISTS
    // guard, lowering retention.callLogs to 30 would delete the chain HEAD of
    // active transcripts. The guard uses idx_turn_nodes_last_seen for the outer
    // predicate and the agentic_conversations primary key for the subquery.
    const turns = await nogilChunk(
      `DELETE FROM conversation_turn_nodes WHERE id IN (
         SELECT n.id FROM conversation_turn_nodes n
         WHERE n.last_seen_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM agentic_conversations c
             WHERE c.id = n.conversation_id AND c.last_seen_at >= ?
           )
         LIMIT ${CHUNK_SIZE}
       )`,
      [cutoffISO, cutoffISO]
    );

    // 2. Conversations past the cutoff
    const convs = await nogilChunk(
      `DELETE FROM agentic_conversations WHERE id IN (SELECT id FROM agentic_conversations WHERE last_seen_at < ? LIMIT ${CHUNK_SIZE})`,
      [cutoffISO]
    );

    // 3. Volume cap. Age-only retention cannot bound a table whose write rate
    // (~42k rows/day measured) outlives its window: nothing deletes until the
    // first rows cross 90 days on 2026-12-11.
    //
    // Ordering is by CONVERSATION recency, never by node insertion order.
    // conversation_turn_nodes.last_seen_at is written once at insert and never
    // updated (no UPDATE exists in the tree), so ordering by it would delete the
    // chain HEAD of long-running conversations first and fracture live
    // transcripts. agentic_conversations.last_seen_at IS refreshed on use.
    //
    // Loops within the shared deadline so the cap can outrun the write rate; a
    // single 5000-row delete per 6h tick would only remove 20k/day.
    let cappedDeleted = 0;
    if (Date.now() < deadline) {
      // Captured BEFORE the sweep: only conversations this sweep empties may be
      // pruned. A global NOT EXISTS would also delete every header-pinned
      // conversation, which never has turn nodes by construction
      // (touchOrCreateExternalConversation never writes them).
      const touchedIds = new Set<string>();
      // WHERE EXISTS, not JOIN + GROUP BY: grouping 2.6M node rows into a temp
      // B-tree is the expensive half of this query, and EXISTS short-circuits on
      // the first matching node per conversation.
      const victimsStmt = db.prepare(
        "SELECT c.id FROM agentic_conversations c " +
          "WHERE EXISTS (SELECT 1 FROM conversation_turn_nodes n WHERE n.conversation_id = c.id) " +
          "ORDER BY c.last_seen_at ASC LIMIT ?"
      );
      // Delete by ROW, not by whole conversation: one conversation-scoped DELETE
      // removed 435k rows (~1s) and up to 1M rows (1.6s) for large conversations
      // -- a single unbounded synchronous block the deadline cannot interrupt.
      const delRowsStmt = db.prepare(
        "DELETE FROM conversation_turn_nodes WHERE rowid IN (" +
          "SELECT rowid FROM conversation_turn_nodes WHERE conversation_id = ? LIMIT ?)"
      );
      const countStmt = db.prepare("SELECT COUNT(*) c FROM conversation_turn_nodes");
      // Computed ONCE and decremented per delete. Re-reading COUNT(*) each outer
      // pass was both an extra full scan and racy: the inner loop could delete
      // well past MAX_TURN_NODES_ROWS before the next count was taken.
      let excess = (countStmt.get() as { c: number }).c - MAX_TURN_NODES_ROWS;
      capLoop: for (let chunks = 0; chunks < CHUNK_LOOP_CAP; chunks++) {
        if (Date.now() >= deadline || excess <= 0) break;
        const victims = victimsStmt.all(MAX_CAP_CONVERSATIONS_PER_TICK) as Array<{ id: string }>;
        if (victims.length === 0) break;
        let chunkChanges = 0;
        for (const v of victims) {
          if (Date.now() >= deadline || excess <= 0) break capLoop;
          const changes = delRowsStmt.run(v.id, Math.min(excess, CHUNK_SIZE)).changes;
          cappedDeleted += changes;
          excess -= changes;
          chunkChanges += changes;
          touchedIds.add(v.id);
          await new Promise((resolve) => setImmediate(resolve));
        }
        // Every victim was already empty; further passes cannot make progress.
        if (chunkChanges === 0) break;
      }
      if (touchedIds.size > 0) {
        // Prune only conversations this sweep emptied. Batch the id set: SQLite
        // caps host parameters at 32766, and touchedIds can hold thousands.
        const ids = [...touchedIds];
        for (let i = 0; i < ids.length; i += 500) {
          const slice = ids.slice(i, i + 500);
          const marks = slice.map(() => "?").join(",");
          const emptied = db
            .prepare(
              `SELECT id FROM agentic_conversations WHERE id IN (${marks}) AND NOT EXISTS (` +
                "SELECT 1 FROM conversation_turn_nodes n WHERE n.conversation_id = agentic_conversations.id)"
            )
            .all(...slice) as Array<{ id: string }>;
          if (emptied.length === 0) continue;
          const delIds = emptied.map((r) => r.id);
          db.prepare(`DELETE FROM agentic_conversations WHERE id IN (${delIds.map(() => "?").join(",")})`).run(
            ...delIds
          );
        }
      }
    }

    result.deleted = turns.deleted + convs.deleted + cappedDeleted;
    console.log(
      `[Cleanup] Deleted ${turns.deleted} turn nodes and ${convs.deleted} conversations older than ${retentionDays} days` +
        (cappedDeleted > 0 ? `; volume cap removed ${cappedDeleted} more (max ${MAX_TURN_NODES_ROWS})` : "")
    );
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning agentic conversations:", err);
    result.errors++;
  }

  return result;
}

/**
 * Run all cleanup functions if auto-cleanup is enabled.
 */
export async function runAutoCleanup(): Promise<{
  totalDeleted: number;
  totalErrors: number;
  results: Record<string, CleanupResult>;
}> {
  const retention = getRetentionSettings();
  const autoCleanupEnabled = retention.autoCleanupEnabled;

  if (!autoCleanupEnabled) {
    console.log("[Cleanup] Auto-cleanup is disabled");
    return { totalDeleted: 0, totalErrors: 0, results: {} };
  }

  console.log("[Cleanup] Starting auto-cleanup...");

  const results: Record<string, CleanupResult> = {
    quotaSnapshots: await cleanupQuotaSnapshots(),
    callLogs: await cleanupCallLogs(),
    usageHistory: await cleanupUsageHistory(),
    compressionAnalytics: await cleanupCompressionAnalytics(),
    mcpAudit: await cleanupMcpAudit(),
    configAudit: await cleanupConfigAudit(),
    a2aEvents: await cleanupA2aEvents(),
    memoryEntries: await cleanupMemoryEntries(),
    domainCostHistory: await cleanupDomainCostHistory(),
    compressionCacheStats: await cleanupCompressionCacheStats(),
    xpAuditLog: await cleanupXpAuditLog(),
    compressionRunTelemetry: await cleanupCompressionRunTelemetry(),
    proxyLogs: await cleanupProxyLogs(),
    ccrBlocks: await cleanupCcrBlocks(),
    agenticConversations: await cleanupAgenticConversations(),
  };

  const totalDeleted = Object.values(results).reduce((sum, r) => sum + r.deleted, 0);
  const totalErrors = Object.values(results).reduce((sum, r) => sum + r.errors, 0);

  console.log(`[Cleanup] Auto-cleanup complete: ${totalDeleted} deleted, ${totalErrors} errors`);

  return { totalDeleted, totalErrors, results };
}

/**
 * Purge ALL quota_snapshots immediately (no retention check).
 */
export async function purgeQuotaSnapshots(): Promise<CleanupResult> {
  const db = getDbInstance();
  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const stmt = db.prepare("DELETE FROM quota_snapshots");
    const runResult = stmt.run();
    result.deleted = runResult.changes;

    console.log(`[Cleanup] Purged ${result.deleted} quota_snapshots`);
  } catch (err: unknown) {
    console.error("[Cleanup] Error purging quota_snapshots:", err);
    result.errors++;
  }

  return result;
}

/**
 * Purge ALL call_logs immediately (no retention check).
 */
export async function purgeCallLogs(): Promise<CleanupResult> {
  const db = getDbInstance();
  const result: CleanupResult = { deleted: 0, deletedArtifacts: 0, errors: 0 };

  try {
    const runResult = db.prepare("DELETE FROM call_logs").run();
    result.deleted = runResult.changes;

    console.log(`[Cleanup] Purged ${result.deleted} call_logs`);
  } catch (err: unknown) {
    console.error("[Cleanup] Error purging call_logs:", err);
    result.errors++;
  }

  const artifactResult = purgeCallLogArtifactDirectory();
  result.deletedArtifacts = artifactResult.deletedArtifacts;
  result.errors += artifactResult.errors;

  if (artifactResult.errors === 0) {
    console.log(`[Cleanup] Purged ${result.deletedArtifacts} call log artifact(s)`);
  }

  return result;
}

/**
 * Purge ALL request_detail_logs immediately (no retention check).
 */
export async function purgeDetailedLogs(): Promise<CleanupResult> {
  const db = getDbInstance();
  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const stmt = db.prepare("DELETE FROM request_detail_logs");
    const runResult = stmt.run();
    result.deleted = runResult.changes;

    console.log(`[Cleanup] Purged ${result.deleted} request_detail_logs`);
  } catch (err: unknown) {
    console.error("[Cleanup] Error purging request_detail_logs:", err);
    result.errors++;
  }

  return result;
}

/**
 * Whitelist of periods accepted by {@link resetUsageHistory}. `"all"` wipes
 * every row; any other value deletes rows strictly older than `now - period`.
 */
export const RESET_USAGE_HISTORY_PERIODS = [
  "5m",
  "1h",
  "3h",
  "6h",
  "12h",
  "1d",
  "7d",
  "30d",
  "all",
] as const;

export type ResetUsageHistoryPeriod = (typeof RESET_USAGE_HISTORY_PERIODS)[number];

type TimedResetUsageHistoryPeriod = Exclude<ResetUsageHistoryPeriod, "all">;

const RESET_USAGE_HISTORY_PERIOD_MS: Record<TimedResetUsageHistoryPeriod, number> = {
  "5m": 5 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "3h": 3 * 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export interface ResetUsageHistoryResult extends CleanupResult {
  deletedUsageHistory: number;
  deletedDailySummary: number;
  deletedHourlySummary: number;
  deletedCallLogs: number;
  deletedCallLogArtifacts: number;
  deletedRequestDetailLogs: number;
  deletedProxyLogs: number;
  deletedRelayLogs: number;
  deletedCompressionAnalytics: number;
  deletedCompressionRunTelemetry: number;
  deletedRoutingDecisions: number;
  deletedQuotaConsumption: number;
  deletedTokenLedger: number;
}

function isResetUsageHistoryPeriod(period: string): period is ResetUsageHistoryPeriod {
  return (RESET_USAGE_HISTORY_PERIODS as readonly string[]).includes(period);
}

/**
 * On-demand, period-scoped reset of usage analytics data (`usage_history`,
 * `daily_usage_summary`, `hourly_usage_summary`).
 *
 * Unlike {@link cleanupUsageHistory} (retention-based background cleanup,
 * which rolls up rows into `daily_usage_summary` before deleting them), this
 * is a destructive user-triggered reset — it intentionally does NOT roll up
 * first, since the whole point is to wipe the data the user selected.
 *
 * @param period - One of {@link RESET_USAGE_HISTORY_PERIODS}. `"all"` wipes
 *   every row in all three tables; any other value deletes rows strictly
 *   older than `now - period`. Throws on an invalid period.
 */
const RESET_TARGETS: Array<DeleteByPeriodTarget & { resultKey: keyof ResetUsageHistoryResult }> = [
  { table: "usage_history", column: "timestamp", cutoff: "iso", resultKey: "deletedUsageHistory" },
  { table: "daily_usage_summary", column: "date", cutoff: "date", resultKey: "deletedDailySummary" },
  { table: "hourly_usage_summary", column: "date_hour", cutoff: "dateHour", resultKey: "deletedHourlySummary" },
  { table: "call_logs", column: "timestamp", cutoff: "iso", resultKey: "deletedCallLogs" },
  { table: "request_detail_logs", column: "timestamp", cutoff: "iso", resultKey: "deletedRequestDetailLogs" },
  { table: "proxy_logs", column: "timestamp", cutoff: "iso", resultKey: "deletedProxyLogs" },
  { table: "relay_logs", column: "created_at", cutoff: "epochSeconds", resultKey: "deletedRelayLogs" },
  { table: "compression_analytics", column: "timestamp", cutoff: "iso", resultKey: "deletedCompressionAnalytics" },
  { table: "compression_run_telemetry", column: "timestamp", cutoff: "epochMs", resultKey: "deletedCompressionRunTelemetry" },
  { table: "routing_decisions", column: "created_at", cutoff: "iso", resultKey: "deletedRoutingDecisions" },
  { table: "quota_consumption", column: "updated_at", cutoff: "epochMs", resultKey: "deletedQuotaConsumption" },
  { table: "token_ledger", column: "created_at", cutoff: "iso", resultKey: "deletedTokenLedger" },
];

export async function resetUsageHistory(period: string): Promise<ResetUsageHistoryResult> {
  if (!isResetUsageHistoryPeriod(period)) {
    throw new Error(`Invalid reset period: ${period}`);
  }

  const db = getDbInstance();
  const result: ResetUsageHistoryResult = {
    deleted: 0,
    deletedUsageHistory: 0,
    deletedDailySummary: 0,
    deletedHourlySummary: 0,
    deletedCallLogs: 0,
    deletedCallLogArtifacts: 0,
    deletedRequestDetailLogs: 0,
    deletedProxyLogs: 0,
    deletedRelayLogs: 0,
    deletedCompressionAnalytics: 0,
    deletedCompressionRunTelemetry: 0,
    deletedRoutingDecisions: 0,
    deletedQuotaConsumption: 0,
    deletedTokenLedger: 0,
    deletedArtifacts: 0,
    errors: 0,
  };

  try {
    let artifactsToDelete: string[] = [];

    const runReset = db.transaction(() => {
      if (period === "all") {
        for (const target of RESET_TARGETS) {
          (result[target.resultKey] as number) = deleteAllFromTable(target.table);
        }
        return;
      }

      const cutoffIso = new Date(Date.now() - RESET_USAGE_HISTORY_PERIOD_MS[period]).toISOString();
      artifactsToDelete = collectCallLogArtifactsBefore(cutoffIso);
      for (const target of RESET_TARGETS) {
        (result[target.resultKey] as number) = deleteFromTableBefore(target, cutoffIso);
      }
    });

    runReset();

    let artifactResult: { deletedArtifacts: number; errors: number };
    if (period === "all") {
      artifactResult = purgeCallLogArtifactDirectory();
    } else {
      artifactResult = deleteCallLogArtifacts(artifactsToDelete);
    }
    result.deletedCallLogArtifacts = artifactResult.deletedArtifacts;
    result.deletedArtifacts = artifactResult.deletedArtifacts;
    result.errors += artifactResult.errors;

    result.deleted = RESET_TARGETS.reduce((sum, t) => sum + (result[t.resultKey] as number), 0);

    console.log(
      `[Cleanup] Reset usage/log data (period=${period}): ${result.deleted} row(s), ` +
        `${result.deletedCallLogArtifacts} call log artifact(s)`
    );
  } catch (err: unknown) {
    console.error("[Cleanup] Error resetting usage history:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up old proxy_logs based on retention settings.
 * Uses the same retention period as call_logs (30 days default).
 */
export async function cleanupProxyLogs(): Promise<CleanupResult> {
  const db = getDbInstance();
  const retention = getRetentionSettings();

  const retentionDays = retention.callLogs;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffISO = cutoffDate.toISOString();

  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const stmt = db.prepare("DELETE FROM proxy_logs WHERE timestamp < ?");
    const runResult = stmt.run(cutoffISO);
    result.deleted = runResult.changes;

    console.log(`[Cleanup] Deleted ${result.deleted} proxy_logs older than ${retentionDays} days`);
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning proxy_logs:", err);
    result.errors++;
  }

  return result;
}

// ──────────────── Background Cleanup Scheduler ────────────────

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
let _cleanupSchedulerTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the background cleanup scheduler. Runs cleanup on startup
 * and then every 6 hours. Runs VACUUM after deletes to reclaim disk space.
 *
 * Without this, tables grow unboundedly (compression_analytics 600K+ rows,
 * usage_history 250K+ rows) causing 1.4GB+ SQLite files and 3-8GB RSS
 * from better-sqlite3 memory mapping.
 */
export function startCleanupScheduler(): void {
  if (_cleanupSchedulerTimer) return;

  // Run cleanup 30s after startup (let the server initialize first).
  setTimeout(async () => {
    try {
      const result = await runAutoCleanup();
      const proxyResult = await cleanupProxyLogs();
      const totalDeleted = result.totalDeleted + proxyResult.deleted;
      if (totalDeleted > 0) {
        console.log(
          `[Cleanup] Startup cleanup freed ${totalDeleted} rows (in-process VACUUM disabled to prevent event loop freeze).`
        );
      }
    } catch (err) {
      console.error("[Cleanup] Startup cleanup failed:", err);
    }
  }, 30_000);

  // Schedule periodic cleanup every 6 hours.
  _cleanupSchedulerTimer = setInterval(async () => {
    try {
      const result = await runAutoCleanup();
      const proxyResult = await cleanupProxyLogs();
      const totalDeleted = result.totalDeleted + proxyResult.deleted;
      if (totalDeleted > 0) {
        console.log(
          `[Cleanup] Periodic cleanup freed ${totalDeleted} rows (in-process VACUUM disabled to prevent event loop freeze).`
        );
      }
    } catch (err) {
      console.error("[Cleanup] Periodic cleanup failed:", err);
    }
  }, CLEANUP_INTERVAL_MS);

  // Don't keep the process alive solely for cleanup.
  if (_cleanupSchedulerTimer && typeof _cleanupSchedulerTimer.unref === "function") {
    _cleanupSchedulerTimer.unref();
  }

  console.log("[Cleanup] Background cleanup scheduler started (every 6 hours).");
}

/**
 * Stop the background cleanup scheduler (for tests).
 */
export function stopCleanupScheduler(): void {
  if (_cleanupSchedulerTimer) {
    clearInterval(_cleanupSchedulerTimer);
    _cleanupSchedulerTimer = null;
  }
}
