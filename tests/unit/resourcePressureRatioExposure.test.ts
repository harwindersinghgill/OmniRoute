import test from "node:test";
import assert from "node:assert/strict";

import { projectAdaptiveAdmissionSummary } from "../../src/lib/monitoring/observability.ts";

const { createAdaptiveAdmissionRuntime } = await import(
  "../../open-sse/services/admission/runtime.ts"
);

const PRESSURE_STATE = {
  severity: "high" as const,
  reason: "cgroup_ratio" as const,
  elevatedStreak: 0,
  recoveryStreak: 0,
  lastTransitionAtMs: 0,
  observedAtMs: 0,
};

function buildSignals(cgroup: {
  currentBytes: number | null;
  fileBytes: number | null;
  shmemBytes?: number | null;
  maxBytes: number | null;
}) {
  return {
    observedAtMs: 0,
    v8: { heapUsedBytes: 1, heapLimitBytes: 10 },
    process: {
      rssBytes: 1,
      externalBytes: 0,
      arrayBuffersBytes: 0,
      availableBytes: null,
      constrainedBytes: null,
    },
    cgroup: {
      currentBytes: cgroup.currentBytes,
      maxBytes: cgroup.maxBytes,
      highBytes: null,
      fileBytes: cgroup.fileBytes,
      shmemBytes: cgroup.shmemBytes,
      events: null,
    },
    psi: null,
  };
}

test("snapshot exposes the cgroup working-set ratio", () => {
  const runtime = createAdaptiveAdmissionRuntime({
    getResourcePressureObservation: () => ({
      signals: buildSignals({
        currentBytes: 2_953_000_000,
        fileBytes: 98_000_000,
        shmemBytes: 0,
        maxBytes: 3_221_225_472,
      }),
      state: PRESSURE_STATE,
    }),
  });

  const ratio = runtime.snapshot().resourceWorkingSetRatio;
  assert.ok(ratio !== null, "ratio must be a number when cgroup signals are present");
  assert.ok(Math.abs(ratio - 0.886) < 0.001, `expected ~0.886, got ${ratio}`);

  // The authenticated health projection must carry the same value.
  const projected = projectAdaptiveAdmissionSummary(runtime.snapshot());
  assert.equal(projected?.resourceWorkingSetRatio, ratio);
  runtime.dispose();
});

test("snapshot reports a null ratio when no pressure sample exists yet", () => {
  const runtime = createAdaptiveAdmissionRuntime({
    getResourcePressureObservation: () => ({ signals: null, state: PRESSURE_STATE }),
  });

  assert.equal(runtime.snapshot().resourceWorkingSetRatio, null);
  runtime.dispose();
});
