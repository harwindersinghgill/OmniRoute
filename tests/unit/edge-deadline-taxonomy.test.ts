import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyEdgeError, EDGE_PROXY_READ_TIMEOUT_MS, EDGE_SAFE_BUDGET_MS, EDGE_QUEUE_WAIT_MAX_MS, EDGE_UPSTREAM_ATTEMPT_MAX_MS } from "../../open-sse/utils/edgeDeadline.ts";

describe("edgeDeadline taxonomy", () => {
  it("pins the Cloudflare Proxy Read Timeout default at 125s", () => {
    assert.equal(EDGE_PROXY_READ_TIMEOUT_MS, 125000);
    assert.equal(EDGE_SAFE_BUDGET_MS, 110000);
  });
  it("classifies Bottleneck queue expiry as QUEUE_TIMEOUT", () => {
    assert.equal(classifyEdgeError({ code: "RATE_LIMIT_QUEUE_TIMEOUT" }), "QUEUE_TIMEOUT");
  });
  it("classifies own deadline TimeoutError/BodyTimeoutError as UPSTREAM_TIMEOUT", () => {
    assert.equal(classifyEdgeError({ name: "TimeoutError" }), "UPSTREAM_TIMEOUT");
    assert.equal(classifyEdgeError({ name: "BodyTimeoutError" }), "UPSTREAM_TIMEOUT");
  });
  it("classifies client AbortError as CLIENT_ABORT", () => {
    assert.equal(classifyEdgeError({ name: "AbortError" }), "CLIENT_ABORT");
  });
  it("returns undefined for unknown errors", () => {
    assert.equal(classifyEdgeError({ name: "TypeError" }), undefined);
  });
});
