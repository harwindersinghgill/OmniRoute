/**
 * resilience/settings/diff — pure diff for resilience settings (CF-125s Task 6).
 *
 * Produces per-section `{ before, after }` for the audit_log `settings.update`
 * row written by `src/app/api/resilience/route.ts`. Pure — no imports.
 *
 * @module lib/resilience/settings/diff
 */

import type { ResilienceSettings } from "./types";

type ResilienceSection = NonNullable<keyof ResilienceSettings>;

export type ResilienceSettingsDiff = Partial<
  Record<ResilienceSection, { before: unknown; after: unknown }>
>;

/** JSON round-trip deep equality — mirrors computeSettingsDiff in settings/route.ts. */
function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Diff two ResilienceSettings objects per top-level section.
 * Returns `{}` when nothing changed — callers skip the audit row.
 */
export function diffResilience(
  before: ResilienceSettings,
  after: ResilienceSettings
): ResilienceSettingsDiff {
  const diff: ResilienceSettingsDiff = {};
  for (const section of Object.keys(before) as ResilienceSection[]) {
    if (!isDeepEqual(before[section], after[section])) {
      diff[section] = { before: before[section], after: after[section] };
    }
  }
  return diff;
}
