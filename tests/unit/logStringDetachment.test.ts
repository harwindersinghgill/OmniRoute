import test from "node:test";
import assert from "node:assert/strict";

const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const { truncatePendingPreview } = await import("../../src/lib/usage/usageHistory/helpers.ts");
const { createRequestLogger } = await import("../../open-sse/utils/requestLogger.ts");

test.after(() => {
  usageHistory.clearPendingRequests();
});

test("a truncated preview does not retain its parent string", (t) => {
  // The default suite runs without --expose-gc, so the parent is never collected and the
  // assertion would fail for the wrong reason. Run via `npm run test:leak`.
  if (typeof global.gc !== "function") {
    t.skip("requires --expose-gc (run: npm run test:leak)");
    return;
  }
  global.gc();
  const before = process.memoryUsage().heapUsed;
  let preview: unknown;
  {
    let parent = "x".repeat(8 * 1024 * 1024);
    preview = truncatePendingPreview(parent);
    parent = "";
  }
  global.gc();
  const retained = process.memoryUsage().heapUsed - before;
  assert.equal((preview as string).length, 1203);
  assert.ok(retained < 2 * 1024 * 1024, `retained ${retained} bytes — parent is still pinned`);
});

test("a pending detail keeps a snapshot of stream chunks, not the live arrays", async () => {
  usageHistory.trackPendingRequest("snapshot-model", "snapshot-provider", "conn-snapshot", true);
  const detailId = [...usageHistory.getPendingById().keys()][0];
  assert.ok(detailId, "pending detail must be tracked before the logger snapshots it");

  const logger = await createRequestLogger("openai", "openai", "snapshot-model", {
    requestId: detailId,
    connectionId: "conn-snapshot",
    model: "snapshot-model",
    provider: "snapshot-provider",
  });

  logger.appendProviderChunk("first");
  const entry = usageHistory.getPendingById().get(detailId);
  const firstSnapshot = entry?.streamChunks?.provider;
  assert.equal(firstSnapshot?.length, 1);

  logger.appendProviderChunk("second");
  logger.appendProviderChunk("third");

  // Progressive view stays fresh...
  assert.equal(entry?.streamChunks?.provider?.length, 3);
  // ...but the earlier snapshot is an independent array, so it never absorbs later chunks.
  assert.equal(firstSnapshot?.length, 1);
});
