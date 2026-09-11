import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  runWithRequestDeadline,
  getRemainingBudgetMs,
  computeAttemptTimeoutMs,
} from "../../open-sse/utils/requestDeadline.ts";
import { executeWithUpstreamAttemptTimeout } from "../../open-sse/handlers/chatCore/upstreamAttemptTimeout.ts";
import { EDGE_SAFE_BUDGET_MS, EDGE_UPSTREAM_ATTEMPT_MAX_MS } from "../../open-sse/utils/edgeDeadline.ts";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

test("attempt timeout is min(cap, remaining)", () => {
  assert.equal(computeAttemptTimeoutMs(90000, 20000), 20000);
  assert.equal(computeAttemptTimeoutMs(90000, 120000), 90000);
  assert.equal(computeAttemptTimeoutMs(90000, 110000), 90000);
});

test("no deadline context falls back to static cap", () => {
  assert.equal(computeAttemptTimeoutMs(90000, null), 90000);
  assert.equal(computeAttemptTimeoutMs(), 90000);
});

test("runWithRequestDeadline stamps deadline and getRemainingBudgetMs decreases", async () => {
  await runWithRequestDeadline(async () => {
    const a = getRemainingBudgetMs();
    assert.ok(a !== null && a <= EDGE_SAFE_BUDGET_MS && a > EDGE_SAFE_BUDGET_MS - 2000);
    await sleep(30);
    const b = getRemainingBudgetMs();
    assert.ok(b !== null && b < (a as number));
  });
});

test("outside runWithRequestDeadline, getRemainingBudgetMs is null", () => {
  assert.equal(getRemainingBudgetMs(), null);
});

test("worst-case arithmetic pin: 90s queue + min(90, 110-90) attempt = 110s", () => {
  // Queue consumed 90s of the 110s clock; attempt gets the remaining 20s.
  const remaining = EDGE_SAFE_BUDGET_MS - 90000; // 20000
  assert.equal(90000 + computeAttemptTimeoutMs(EDGE_UPSTREAM_ATTEMPT_MAX_MS, remaining), 110000);
});

test("nested runWithRequestDeadline does not extend an outer deadline", async () => {
  await runWithRequestDeadline(async () => {
    const outer = getRemainingBudgetMs();
    await sleep(25);
    await runWithRequestDeadline(async () => {
      // Inner context sees the SAME deadline (outer wins) — no budget reset.
      const inner = getRemainingBudgetMs();
      assert.ok(
        inner !== null && outer !== null && inner <= outer && inner > outer - 100
      );
    });
  });
});

test("integration: attempt wrapper resolves default timeout inside deadline context", async () => {
  await runWithRequestDeadline(async () => {
    // Fresh context: remaining ≈ 110s > 90s cap → default resolves to 90000
    // (computeAttemptTimeoutMs), and a fast execute completes without error.
    const start = Date.now();
    const result = await executeWithUpstreamAttemptTimeout({
      provider: "test",
      model: "m",
      signal: new AbortController().signal,
      execute: async () => "ok",
    });
    assert.equal(result, "ok");
    assert.ok(Date.now() - start < 5000);
    // And the default the wrapper uses equals the capped value:
    assert.equal(computeAttemptTimeoutMs(), EDGE_UPSTREAM_ATTEMPT_MAX_MS);
  });
});

test("integration: attempt wrapper outside deadline context keeps static cap", async () => {
  // No runWithRequestDeadline wrapper — graceful degradation to 90s cap.
  const result = await executeWithUpstreamAttemptTimeout({
    provider: "test",
    model: "m",
    signal: new AbortController().signal,
    execute: async () => 42,
  });
  assert.equal(result, 42);
  assert.equal(computeAttemptTimeoutMs(), EDGE_UPSTREAM_ATTEMPT_MAX_MS);
});

test("expired deadline rejects with UPSTREAM_TIMEOUT, never unbounded passthrough", async () => {
  await runWithRequestDeadline(async () => {
    // Exhaust the 110s clock without waiting: timeoutMs=0 + active context.
    await assert.rejects(
      () =>
        executeWithUpstreamAttemptTimeout({
          provider: "test",
          model: "m",
          signal: new AbortController().signal,
          timeoutMs: 0,
          execute: async () => {
            // Must never run — an expired budget must not launch a request.
            throw new Error("EXECUTE-MUST-NOT-RUN");
          },
        }),
      (err: NodeJS.ErrnoException) => {
        const e = err as unknown as { code?: string; name?: string };
        return e.code === "UPSTREAM_TIMEOUT" && e.name === "TimeoutError";
      }
    );
  });
});

test("timeoutMs=0 with NO deadline context still passes through (disabled)", async () => {
  const result = await executeWithUpstreamAttemptTimeout({
    provider: "test",
    model: "m",
    signal: new AbortController().signal,
    timeoutMs: 0,
    execute: async () => "passthrough-ok",
  });
  assert.equal(result, "passthrough-ok");
});

