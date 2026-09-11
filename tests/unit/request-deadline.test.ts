import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  runWithRequestDeadline,
  getRemainingBudgetMs,
  computeAttemptTimeoutMs,
} from "../../open-sse/utils/requestDeadline.ts";
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
