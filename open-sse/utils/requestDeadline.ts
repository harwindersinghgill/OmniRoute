import { AsyncLocalStorage } from "node:async_hooks";
import {
  EDGE_SAFE_BUDGET_MS,
  EDGE_UPSTREAM_ATTEMPT_MAX_MS,
} from "./edgeDeadline.ts";

/**
 * requestDeadline — shared per-request deadline clock (CF-125s "true 110s" phase).
 *
 * Stamps ONE deadline per chat request (entry + EDGE_SAFE_BUDGET_MS = 110s).
 * Queue wait consumes the clock; each upstream attempt gets
 * min(EDGE_UPSTREAM_ATTEMPT_MAX_MS, remaining). Worst case = 90s queue + 20s
 * attempt = 110s — under Cloudflare's 125s Proxy Read Timeout with 15s edge
 * headroom (tunnel + nginx + CF ingress).
 *
 * Replaces the deployed independent-timer worst case (90s queue + 90s attempt
 * = 180s, which could still 524). Static per-timer caps (queue clamp 90s,
 * attempt cap 90s) stay as defense-in-depth.
 *
 * AsyncLocalStorage keeps the diff minimal: one wrap at chatCore entry, reads
 * at the attempt-timeout call sites. ponytail: ALS is implicit context — if
 * more deadline consumers appear, thread it explicitly instead.
 */

interface RequestDeadlineStore {
  deadlineAt: number;
}

const requestDeadlineALS = new AsyncLocalStorage<RequestDeadlineStore>();

/**
 * Run `fn` inside a request-deadline context stamped `now + EDGE_SAFE_BUDGET_MS`.
 * Nested calls reuse the OUTERMOST deadline — an inner wrap never extends the
 * budget (worst case stays 110s regardless of wrap depth).
 */
export function runWithRequestDeadline<T>(fn: () => Promise<T>): Promise<T> {
  const existing = requestDeadlineALS.getStore();
  if (existing) return fn();
  return requestDeadlineALS.run({ deadlineAt: Date.now() + EDGE_SAFE_BUDGET_MS }, fn);
}

/** Remaining budget in ms, or null when no deadline context is active. */
export function getRemainingBudgetMs(): number | null {
  const store = requestDeadlineALS.getStore();
  if (!store) return null;
  return store.deadlineAt - Date.now();
}

/**
 * Per-attempt timeout: min(cap, remaining deadline budget).
 * Falls back to the static `cap` (deployed behavior) when no context exists —
 * graceful degradation, never a crash. Never returns a negative value.
 */
export function computeAttemptTimeoutMs(
  cap: number = EDGE_UPSTREAM_ATTEMPT_MAX_MS,
  remainingMs?: number | null
): number {
  const remaining = remainingMs !== undefined && remainingMs !== null
    ? remainingMs
    : getRemainingBudgetMs();
  if (remaining === null) return cap;
  return Math.max(0, Math.min(cap, remaining));
}
