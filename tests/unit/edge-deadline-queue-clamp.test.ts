import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeRequestQueueSettings } from "../../src/lib/resilience/settings/normalize.ts";
import { DEFAULT_RESILIENCE_SETTINGS } from "../../src/lib/resilience/settings.ts";
import { EDGE_QUEUE_WAIT_MAX_MS } from "../../open-sse/utils/edgeDeadline.ts";

describe("queue-wait edge clamp", () => {
  it("clamps maxWaitMs above 90s down to the edge-safe ceiling", () => {
    const out = normalizeRequestQueueSettings({ maxWaitMs: 300000 }, DEFAULT_RESILIENCE_SETTINGS.requestQueue);
    assert.equal(out.maxWaitMs, EDGE_QUEUE_WAIT_MAX_MS);
  });
  it("leaves values under the ceiling untouched", () => {
    const out = normalizeRequestQueueSettings({ maxWaitMs: 60000 }, DEFAULT_RESILIENCE_SETTINGS.requestQueue);
    assert.equal(out.maxWaitMs, 60000);
  });
});
