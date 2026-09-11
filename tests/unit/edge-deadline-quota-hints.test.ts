import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseDailyQuotaReset, buildDailyQuotaResetFallback } from "../../open-sse/services/quotaTextCooldowns.ts";
import { diffResilience } from "../../src/lib/resilience/settings/diff.ts";
import { DEFAULT_RESILIENCE_SETTINGS } from "../../src/lib/resilience/settings.ts";
import type { ResilienceSettings } from "../../src/lib/resilience/settings/types.ts";

describe("parseDailyQuotaReset (LongCat free-tier daily quota)", () => {
  it("parses the Sep-11 LongCat 429 message ISO reset", () => {
    assert.equal(
      parseDailyQuotaReset(
        "You've used all 100 free LongCat 2.0 requests for today. Your quota resets at 2026-09-11T00:00:00.000Z."
      ),
      "2026-09-11T00:00:00.000Z"
    );
  });

  it("parses without trailing period and with offset timezone", () => {
    assert.equal(
      parseDailyQuotaReset("Your quota resets at 2026-10-01T08:30:00+02:00"),
      "2026-10-01T08:30:00+02:00"
    );
  });

  it("returns undefined for non-quota messages", () => {
    assert.equal(parseDailyQuotaReset("Rate limit exceeded, retry after 30s"), undefined);
    assert.equal(parseDailyQuotaReset(""), undefined);
    assert.equal(parseDailyQuotaReset(undefined), undefined);
    assert.equal(parseDailyQuotaReset("daily quota exceeded"), undefined);
  });

  it("buildDailyQuotaResetFallback cools until the stated reset (CF-125s pre-emption)", () => {
    const resetIso = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const msg = `You've used all 100 free LongCat 2.0 requests for today. Your quota resets at ${resetIso}.`;
    const fb = buildDailyQuotaResetFallback(msg, Date.now());
    assert.ok(fb, "expected fallback for future reset");
    // ~6h window (allow 1s clock skew between Date.now() calls)
    assert.ok(fb!.cooldownMs > 5 * 60 * 60 * 1000 && fb!.cooldownMs <= 6 * 60 * 60 * 1000 + 1000);
    assert.equal(fb!.reason, "quota_exhausted");
    assert.equal(fb!.quotaResetHintMs, fb!.cooldownMs);
  });

  it("buildDailyQuotaResetFallback returns null for past reset and non-quota text", () => {
    const pastMsg = "used all 100 free requests for today. Your quota resets at 2020-01-01T00:00:00.000Z.";
    assert.equal(buildDailyQuotaResetFallback(pastMsg, Date.now()), null);
    assert.equal(buildDailyQuotaResetFallback("Your quota resets at 2099-01-01T00:00:00.000Z.", Date.now()), null);
  });
});

describe("opencode-go 401 validation message (CF-125s hygiene)", () => {
  it("surfaces the upstream Missing-API-key wording instead of generic Invalid API key", async () => {
    const { validateProviderApiKey } = await import("../../src/lib/providers/validation.ts");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "Missing API key" } }), { status: 401 })) as
      typeof fetch;
    try {
      const result = await validateProviderApiKey({ provider: "opencode-go", apiKey: "some-key" });
      assert.equal(result.valid, false);
      assert.match(String(result.error), /missing api key/i);
      assert.notEqual(result.error, "Invalid API key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps generic Invalid API key for a wrong-key 401", async () => {
    const { validateProviderApiKey } = await import("../../src/lib/providers/validation.ts");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "Unauthorized" } }), { status: 401 })) as
      typeof fetch;
    try {
      const result = await validateProviderApiKey({ provider: "opencode-go", apiKey: "bad-key" });
      assert.equal(result.valid, false);
      assert.equal(result.error, "Invalid API key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("diffResilience", () => {
  it("returns only changed sections with before/after", () => {
    const before: ResilienceSettings = DEFAULT_RESILIENCE_SETTINGS;
    // v3.8.50: waitForCooldown.maxRetries defaults to 5, so mutate a different
    // field to guarantee a real delta regardless of upstream default drift.
    const after: ResilienceSettings = {
      ...DEFAULT_RESILIENCE_SETTINGS,
      requestQueue: { ...DEFAULT_RESILIENCE_SETTINGS.requestQueue, maxWaitMs: 90000 },
      waitForCooldown: {
        ...DEFAULT_RESILIENCE_SETTINGS.waitForCooldown,
        maxRetries: DEFAULT_RESILIENCE_SETTINGS.waitForCooldown.maxRetries === 5 ? 4 : 5,
      },
    };
    const diff = diffResilience(before, after);
    assert.deepEqual(Object.keys(diff).sort(), ["requestQueue", "waitForCooldown"]);
    // v3.8.50 default is 15000 (was 120000 at v3.8.48) — assert against the
    // live default so the fixture survives upstream default drift.
    assert.equal(
      diff.requestQueue.before.maxWaitMs,
      DEFAULT_RESILIENCE_SETTINGS.requestQueue.maxWaitMs
    );
    assert.equal(diff.requestQueue.after.maxWaitMs, 90000);
  });

  it("returns empty object when nothing changed", () => {
    assert.deepEqual(diffResilience(DEFAULT_RESILIENCE_SETTINGS, DEFAULT_RESILIENCE_SETTINGS), {});
  });

  it("detects nested connectionCooldown profile change", () => {
    const before: ResilienceSettings = DEFAULT_RESILIENCE_SETTINGS;
    const after: ResilienceSettings = {
      ...DEFAULT_RESILIENCE_SETTINGS,
      connectionCooldown: {
        ...DEFAULT_RESILIENCE_SETTINGS.connectionCooldown,
        apikey: { ...DEFAULT_RESILIENCE_SETTINGS.connectionCooldown.apikey, baseCooldownMs: 7000 },
      },
    };
    const diff = diffResilience(before, after);
    assert.deepEqual(Object.keys(diff), ["connectionCooldown"]);
    assert.equal(diff.connectionCooldown.after.apikey.baseCooldownMs, 7000);
  });
});
