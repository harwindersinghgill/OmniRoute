import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  it("env-derived default is clamped to the edge-safe ceiling (audit LOW #2)", () => {
    // Import in a child process with an abusive env value — the module-level
    // IIFE runs at import time, so the clamp must fire there.
    const stdout = execFileSync(
      process.execPath,
      [
        "--import", "tsx/esm",
        "-e",
        `const m = await import("./src/lib/resilience/settings.ts");
         console.log(m.DEFAULT_REQUEST_QUEUE_MAX_WAIT_MS);`,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, RATE_LIMIT_MAX_WAIT_MS: "86400000" },
        encoding: "utf8",
      }
    );
    // Child stdout may carry ANSI color codes — strip before parsing.
    const plain = stdout.replace(/\x1B\[[0-9;]*m/g, "").trim().split("\n").pop() ?? "";
    const value = Number(plain);
    assert.ok(Number.isFinite(value), `expected numeric default, got: ${stdout.trim()}`);
    assert.ok(value <= EDGE_QUEUE_WAIT_MAX_MS, `expected <= ${EDGE_QUEUE_WAIT_MAX_MS}, got ${value}`);
  });
});
