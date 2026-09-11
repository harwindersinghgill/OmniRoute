import { EDGE_UPSTREAM_ATTEMPT_MAX_MS } from "../../utils/edgeDeadline.ts";
import { computeAttemptTimeoutMs, getRemainingBudgetMs } from "../../utils/requestDeadline.ts";
import { createAbortError } from "./upstreamTimeouts.ts";

export function createUpstreamAttemptTimeoutError(
  timeoutMs: number,
  provider: string,
  model: string
): Error & { code: string } {
  const err = new Error(
    `Upstream attempt did not complete after ${timeoutMs}ms (${provider}/${model})`
  ) as Error & { code: string };
  err.name = "TimeoutError";
  err.code = "UPSTREAM_TIMEOUT";
  return err;
}

export interface UpstreamAttemptTimeoutDeps {
  provider: string;
  model: string;
  signal: AbortSignal;
  /** Defaults to min(EDGE_UPSTREAM_ATTEMPT_MAX_MS, remaining request deadline) —
   * 90s static cap outside a deadline context (deployed behavior). */
  timeoutMs?: number;
  log?: { warn?: (tag: string, message: string) => void } | null;
  execute: (signal: AbortSignal) => Promise<unknown>;
}

/**
 * Race a single upstream attempt against the edge-deadline attempt ceiling.
 *
 * Mirrors `executeWithUpstreamStartTimeout` (upstreamTimeouts.ts), but the timer
 * covers the WHOLE attempt (not just time-to-headers) and the timeout error
 * carries code `UPSTREAM_TIMEOUT` — the cross-provider fallback signal that
 * combo.ts uses to skip same-model retries and advance to the next target.
 */
export async function executeWithUpstreamAttemptTimeout<T>({
  provider,
  model,
  signal,
  timeoutMs = computeAttemptTimeoutMs(),
  log,
  execute,
}: UpstreamAttemptTimeoutDeps): Promise<T> {
  if (signal.aborted) throw createAbortError(signal);
  // Distinguish "timeout disabled" (no deadline context — static cap fallback)
  // from "deadline exhausted" (ALS context exists, budget fully consumed by
  // pre-attempt stages). The latter must NOT pass through unbounded — that
  // silently reopens the 524 window in exactly the overloaded-queue scenario
  // this ceiling exists to prevent. Reject immediately with UPSTREAM_TIMEOUT so
  // combo advances to the next target (Loop 1 finding #1).
  if (timeoutMs <= 0) {
    if (getRemainingBudgetMs() === null) return execute(signal);
    throw createUpstreamAttemptTimeoutError(0, provider, model);
  }

  const timeoutError = createUpstreamAttemptTimeoutError(timeoutMs, provider, model);
  const timeoutController = new AbortController();

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const onOuterAbort = () => timeoutController.abort(signal.reason);

  signal.addEventListener("abort", onOuterAbort, { once: true });

  try {
    return (await Promise.race([
      execute(timeoutController.signal),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          log?.warn?.("TIMEOUT", timeoutError.message);
          timeoutController.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
      }),
    ])) as T;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    signal.removeEventListener("abort", onOuterAbort);
  }
}
