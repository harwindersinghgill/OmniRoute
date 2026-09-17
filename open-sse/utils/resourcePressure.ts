import { checkHeapPressureGuard, HEAP_PRESSURE_THRESHOLD_MB } from "./heapPressure.ts";
import { buildErrorBody } from "./error.ts";
import {
  createResourcePressureTracker,
  resolveResourcePressureThresholds,
  workingSetBytes,
  type PressureReason,
  type ResourcePressureState,
  type ResourcePressureThresholds,
  type ResourceSignals,
} from "./resourcePressurePolicy.ts";
import {
  sampleResourceSignals,
  type SampleResourceSignalsDeps,
} from "./resourcePressureSampler.ts";

const MB = 1024 * 1024;
const RETRY_AFTER_SECONDS = "5";
const PRESSURE_MESSAGE = "Service temporarily unavailable due to resource pressure. Retry shortly.";

export type ResourcePressureGuardResult = {
  success: false;
  status: 503;
  error: string;
  response: Response;
};

export type ResourcePressureObservation = {
  signals: ResourceSignals | null;
  state: ResourcePressureState;
};

export type ResourcePressureRuntimeOptions = {
  thresholds?: Partial<ResourcePressureThresholds>;
  heapThresholdMb?: number | null;
  immediateHeapUsedMb?: () => number;
  sample?: () => Promise<ResourceSignals>;
  nowMs?: () => number;
  schedule?: (refresh: () => void) => void;
  staleAfterMs?: number;
  maxStaleMs?: number;
  retryAfterMs?: number;
  samplerDeps?: SampleResourceSignalsDeps;
};

export type ResourcePressureRuntime = {
  check: () => ResourcePressureGuardResult | null;
  getObservation: () => ResourcePressureObservation;
  whenRefreshSettled: () => Promise<void>;
  dispose: () => void;
};

function emptyState(): ResourcePressureState {
  return {
    severity: "normal",
    reason: "none",
    elevatedStreak: 0,
    recoveryStreak: 0,
    lastTransitionAtMs: 0,
    observedAtMs: 0,
  };
}

function requireDuration(name: string, value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 3_600_000) {
    throw new RangeError(`${name} must be an integer between 0 and 3600000`);
  }
  return value;
}

function formatSignalDetail(signals: ResourceSignals | null): string {
  if (!signals) return "";
  const { cgroup } = signals;
  return ` cgroup(current=${cgroup.currentBytes}, file=${cgroup.fileBytes}, shmem=${cgroup.shmemBytes ?? null}, workingSet=${workingSetBytes(cgroup)}, max=${cgroup.maxBytes}, high=${cgroup.highBytes})`;
}

function buildCriticalGuard(
  reason: PressureReason,
  signals: ResourceSignals | null = null
): ResourcePressureGuardResult {
  console.warn(
    `[resourcePressure] critical pressure guard tripped (reason=${reason})${formatSignalDetail(signals)}; returning 503`
  );
  return {
    success: false,
    status: 503,
    error: PRESSURE_MESSAGE,
    response: new Response(
      JSON.stringify(
        buildErrorBody(503, PRESSURE_MESSAGE, undefined, {
          type: "server_error",
          code: "resource_pressure",
        })
      ),
      {
        status: 503,
        headers: { "Content-Type": "application/json", "Retry-After": RETRY_AFTER_SECONDS },
      }
    ),
  };
}

function immediateHeapGuard(
  heapUsedMb: number,
  thresholdMb: number | null
): ResourcePressureGuardResult | null {
  if (thresholdMb == null) return null;
  const guard = checkHeapPressureGuard(heapUsedMb, thresholdMb);
  if (!guard) return null;
  return buildCriticalGuard("v8_heap_absolute");
}

export function createResourcePressureRuntime(
  options: ResourcePressureRuntimeOptions = {}
): ResourcePressureRuntime {
  const heapThresholdMb =
    options.heapThresholdMb === undefined ? HEAP_PRESSURE_THRESHOLD_MB : options.heapThresholdMb;
  if (heapThresholdMb !== null && (!Number.isFinite(heapThresholdMb) || heapThresholdMb <= 0)) {
    throw new RangeError("heapThresholdMb must be positive and finite or null");
  }
  const thresholds = resolveResourcePressureThresholds({
    ...options.thresholds,
    heapAbsoluteThresholdMb:
      options.thresholds?.heapAbsoluteThresholdMb === undefined
        ? null
        : options.thresholds.heapAbsoluteThresholdMb,
  });
  const staleAfterMs = requireDuration("staleAfterMs", options.staleAfterMs ?? 1_000);
  const maxStaleMs = requireDuration("maxStaleMs", options.maxStaleMs ?? 30_000);
  const retryAfterMs = requireDuration("retryAfterMs", options.retryAfterMs ?? 1_000);
  if (maxStaleMs < staleAfterMs) {
    throw new RangeError("maxStaleMs must be greater than or equal to staleAfterMs");
  }

  const nowMs = options.nowMs ?? Date.now;
  const immediateHeapUsedMb =
    options.immediateHeapUsedMb ?? (() => process.memoryUsage().heapUsed / MB);
  const sample = options.sample ?? (() => sampleResourceSignals(options.samplerDeps));
  const schedule =
    options.schedule ??
    ((refresh) => {
      const handle = setImmediate(refresh);
      handle.unref();
    });
  const tracker = createResourcePressureTracker(thresholds);

  let lastSignals: ResourceSignals | null = null;
  let state = emptyState();
  let lastRefreshAtMs = Number.NEGATIVE_INFINITY;
  let nextRefreshAtMs = Number.NEGATIVE_INFINITY;
  let scheduled = false;
  let inFlight: Promise<void> | null = null;
  let disposed = false;
  let lastStatDegraded = false;
  let lastStatSkewed = false;

  const refresh = (): void => {
    if (disposed || inFlight) return;
    scheduled = false;
    inFlight = Promise.resolve()
      .then(sample)
      .then((signals) => {
        if (disposed) return;
        const settledAtMs = nowMs();
        lastSignals = signals;
        // memory.stat unavailable while memory.current is readable: the working-set
        // ratio silently degrades to raw memory.current (page cache included), which
        // is the pre-fix false-positive latch hazard. Warn once on entering the
        // degraded state so the fallback cannot be mistaken for the fix working.
        const statDegraded =
          signals.cgroup.currentBytes != null && signals.cgroup.fileBytes == null;
        if (statDegraded && !lastStatDegraded) {
          console.warn(
            "[resourcePressure] cgroup memory.stat unavailable (fileBytes=null); cgroup_ratio degraded to raw memory.current (page cache included) — false-positive latch possible"
          );
        }
        lastStatDegraded = statDegraded;
        // Transient read skew (file > current) also forces the raw-ratio
        // fallback for that sample. It is expected under churn, so warn once
        // per entry into the skewed state rather than on every sample.
        const statSkewed =
          signals.cgroup.currentBytes != null &&
          signals.cgroup.fileBytes != null &&
          signals.cgroup.fileBytes > signals.cgroup.currentBytes;
        if (statSkewed && !lastStatSkewed) {
          console.warn(
            "[resourcePressure] cgroup memory.stat file exceeded memory.current (read skew); sample fell back to the raw memory.current ratio"
          );
        }
        lastStatSkewed = statSkewed;
        state = tracker.observe(signals);
        lastRefreshAtMs = settledAtMs;
        nextRefreshAtMs = settledAtMs + staleAfterMs;
      })
      .catch(() => {
        if (!disposed) nextRefreshAtMs = nowMs() + retryAfterMs;
      })
      .finally(() => {
        inFlight = null;
      });
  };

  const scheduleRefresh = (): void => {
    if (disposed || scheduled || inFlight) return;
    scheduled = true;
    schedule(refresh);
  };

  return {
    check() {
      let heapUsedMb = 0;
      try {
        heapUsedMb = immediateHeapUsedMb();
      } catch {
        heapUsedMb = 0;
      }
      const immediate = immediateHeapGuard(heapUsedMb, heapThresholdMb);
      const now = nowMs();
      if (now >= nextRefreshAtMs) scheduleRefresh();
      if (immediate) {
        state = {
          severity: "critical",
          reason: "v8_heap_absolute",
          elevatedStreak: 0,
          recoveryStreak: 0,
          lastTransitionAtMs: now,
          observedAtMs: now,
        };
        return immediate;
      }
      const cacheAge = lastSignals ? Math.max(0, now - lastRefreshAtMs) : Number.POSITIVE_INFINITY;
      return cacheAge <= maxStaleMs && state.severity === "critical"
        ? buildCriticalGuard(state.reason, lastSignals)
        : null;
    },
    getObservation: () => ({ signals: lastSignals, state }),
    whenRefreshSettled: async () => {
      if (scheduled) await new Promise<void>((resolve) => setImmediate(resolve));
      if (inFlight) await inFlight;
    },
    dispose() {
      disposed = true;
      scheduled = false;
    },
  };
}

let defaultRuntime = createResourcePressureRuntime();

export function checkResourcePressureGuard(): ResourcePressureGuardResult | null {
  return defaultRuntime.check();
}

export function getResourcePressureObservation(): ResourcePressureObservation {
  return defaultRuntime.getObservation();
}

/** Replaces and disposes the process singleton when configuration is reloaded. */
export function reloadResourcePressureRuntime(
  options: ResourcePressureRuntimeOptions = {}
): ResourcePressureRuntime {
  defaultRuntime.dispose();
  defaultRuntime = createResourcePressureRuntime(options);
  return defaultRuntime;
}

export type {
  PressureReason,
  PressureSeverity,
  ResourceMetricBytes,
  ResourcePressureState,
  ResourcePressureThresholds,
  ResourcePressureTracker,
  ResourceSignals,
} from "./resourcePressurePolicy.ts";
export {
  classifyAdaptiveResourcePressure as classifyResourcePressure,
  createResourcePressureTracker,
  resolveResourcePressureThresholds,
} from "./resourcePressurePolicy.ts";
export {
  sampleResourceSignals,
  sanitizeMemoryBytes,
  type ResourcePressureFs,
  type SampleResourceSignalsDeps,
} from "./resourcePressureSampler.ts";
