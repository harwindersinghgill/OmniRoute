/**
 * Edge-deadline budget constants and error taxonomy.
 *
 * Derived from the Sep-11 incident RCA: Cloudflare's Proxy Read Timeout
 * defaults to 125s. Queue wait + upstream execution must fit under the
 * edge cap or Cloudflare returns 524 before OmniRoute finishes.
 */

/** Cloudflare Proxy Read Timeout default (125s). All budgets derive from this. */
export const EDGE_PROXY_READ_TIMEOUT_MS = 125000;

/** End-to-end target budget, safely under the 125s edge cap. */
export const EDGE_SAFE_BUDGET_MS = 110000;

/** Max time a request may sit in the Bottleneck queue. */
export const EDGE_QUEUE_WAIT_MAX_MS = 90000;

/** Max wall-clock time for a single upstream attempt. */
export const EDGE_UPSTREAM_ATTEMPT_MAX_MS = 90000;

export type EdgeErrorCode = "QUEUE_TIMEOUT" | "UPSTREAM_TIMEOUT" | "UPSTREAM_BAD_BODY" | "CLIENT_ABORT";

/** Shape of the error fields the classifier inspects. */
export interface EdgeErrorShape {
  name?: string;
  code?: string;
  status?: number;
}

/**
 * Pure classifier: map known deadline/abort error shapes to a taxonomy code.
 * Returns undefined for anything unrecognized.
 */
export function classifyEdgeError(error: EdgeErrorShape): EdgeErrorCode | undefined {
  if (error.code === "RATE_LIMIT_QUEUE_TIMEOUT") return "QUEUE_TIMEOUT";
  if (error.name === "TimeoutError" || error.name === "BodyTimeoutError") return "UPSTREAM_TIMEOUT";
  if (error.name === "AbortError") return "CLIENT_ABORT";
  return undefined;
}
