/** Seconds for 503 Retry-After. Independent of a call's queueMs=0 test injection. */
export function chatAdmissionRetryAfterSeconds(queueMs: number): number {
  return Math.max(1, Math.ceil(Math.max(0, queueMs) / 1000));
}
