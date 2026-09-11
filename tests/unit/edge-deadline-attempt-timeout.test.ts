import test from "node:test";
import assert from "node:assert/strict";

import { executeWithUpstreamAttemptTimeout } from "../../open-sse/handlers/chatCore/upstreamAttemptTimeout.ts";
import { getUpstreamErrorIdentifier } from "../../open-sse/handlers/chatCore/streamErrorResult.ts";
import { isUpstreamTimeoutErrorBody } from "../../open-sse/services/combo/comboPredicates.ts";
import { classifyEdgeError } from "../../open-sse/utils/edgeDeadline.ts";

test("rejects a hung upstream attempt with TimeoutError + UPSTREAM_TIMEOUT", async () => {
  const started = Date.now();
  await assert.rejects(
    executeWithUpstreamAttemptTimeout({
      provider: "glm",
      model: "glm-5.3",
      signal: new AbortController().signal,
      timeoutMs: 50,
      execute: () => new Promise<Response>(() => {}),
    }),
    (err: unknown) => {
      const e = err as Error & { code?: string };
      assert.equal(e.name, "TimeoutError");
      assert.equal(e.code, "UPSTREAM_TIMEOUT");
      assert.match(e.message, /glm\/glm-5\.3/);
      assert.match(e.message, /50ms/);
      // Cross-provider fallback contract: combo.ts keys on this classification
      assert.equal(classifyEdgeError({ name: e.name, code: e.code }), "UPSTREAM_TIMEOUT");
      return true;
    }
  );
  assert.ok(Date.now() - started < 500, "must reject promptly, not leak the hung attempt");
});

test("passes a fast executor result through untouched", async () => {
  const response = new Response("ok");
  const out = await executeWithUpstreamAttemptTimeout({
    provider: "glm",
    model: "glm-5.3",
    signal: new AbortController().signal,
    timeoutMs: 5000,
    execute: async () => response,
  });
  assert.equal(out, response);
});

test("client abort propagates as AbortError", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    executeWithUpstreamAttemptTimeout({
      provider: "glm",
      model: "glm-5.3",
      signal: ctrl.signal,
      timeoutMs: 5000,
      execute: () => new Promise<Response>(() => {}),
    }),
    (err: unknown) => (err as Error).name === "AbortError"
  );
});

// Signal path: thrown TimeoutError → chatCore catch (chatCore.ts) extracts err.code
// via getUpstreamErrorIdentifier → createErrorResult writes body.error.code →
// combo parses errorBody.error.code into structuredError.code → predicate gates
// the same-model retry skip (cross-provider fallback).
test("signal path: chatCore preserves the thrown code into the error body", () => {
  const err = new Error("Upstream attempt did not complete after 90000ms (glm/glm-5.3)");
  err.name = "TimeoutError";
  (err as Error & { code?: string }).code = "UPSTREAM_TIMEOUT";
  assert.equal(getUpstreamErrorIdentifier(err), "UPSTREAM_TIMEOUT");
  assert.equal(getUpstreamErrorIdentifier(new Error("plain")), undefined);
});

test("combo decision: UPSTREAM_TIMEOUT error body is classified for fallback", () => {
  const attemptTimeout = JSON.parse(
    JSON.stringify({ error: { code: "UPSTREAM_TIMEOUT", message: "x" } })
  );
  assert.equal(isUpstreamTimeoutErrorBody(attemptTimeout), true);
  // A plain provider 502/504 without the code must NOT trigger the same-model skip
  const generic = JSON.parse(JSON.stringify({ error: { code: "bad_gateway" } }));
  assert.equal(isUpstreamTimeoutErrorBody(generic), false);
  assert.equal(isUpstreamTimeoutErrorBody(null), false);
  assert.equal(isUpstreamTimeoutErrorBody("string"), false);
});
