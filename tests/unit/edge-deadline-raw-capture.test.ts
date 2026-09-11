// tests/unit/edge-deadline-raw-capture.test.ts
// CF-125s Task 4 (Phase 4b): raw upstream capture. When an upstream returns a non-JSON body
// (e.g. a Cloudflare-style HTML error page on a 524/502), the invalid_json result must carry a
// redacted rawSnippet (first 2000 chars) so operators can see WHY the payload was invalid.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseNonStreamingResponseBody } from "@omniroute/open-sse/handlers/chatCore/nonStreamingResponseParse.ts";

// Minimal Response stub: only the surface parseNonStreamingResponseBody touches
// (headers.get + text()). Same shape as chatcore-non-streaming-response-parse.test.ts.
function makeResponse(body: string, contentType: string): Response {
  return {
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null),
    },
    text: async () => body,
    body: null,
  } as unknown as Response;
}

const baseOpts = {
  upstreamStream: false,
  providerHeaders: null,
  finalBody: null,
  targetFormat: "openai",
  model: "gpt-4o-mini",
};

test("Cloudflare-style HTML error body → invalid_json with rawSnippet", async () => {
  const html =
    "<html>\n<head><title>524 A timeout occurred</title></head>\n" +
    "<body>Ray ID: abc123 &middot; Error 524 &middot; cloudflare</body>\n</html>";
  const res = await parseNonStreamingResponseBody({
    ...baseOpts,
    providerResponse: makeResponse(html, "text/html"),
  });
  assert.equal(res.kind, "invalid_json");
  if (res.kind !== "invalid_json") return;
  assert.ok(typeof res.rawSnippet === "string", "rawSnippet must be a string");
  assert.ok(res.rawSnippet.startsWith("<html>"));
  assert.ok(res.rawSnippet.includes("524"));
  assert.ok(res.rawSnippet.length <= 2000);
});

test("rawSnippet truncates to 2000 chars on long bodies", async () => {
  const longBody = "<html>" + "x".repeat(5000) + "</html>";
  const res = await parseNonStreamingResponseBody({
    ...baseOpts,
    providerResponse: makeResponse(longBody, "text/html"),
  });
  assert.equal(res.kind, "invalid_json");
  if (res.kind !== "invalid_json") return;
  assert.equal(res.rawSnippet.length, 2000);
});

test("short bodies pass through intact with normalized payload present", async () => {
  const res = await parseNonStreamingResponseBody({
    ...baseOpts,
    providerResponse: makeResponse("{not json", "application/json"),
  });
  assert.equal(res.kind, "invalid_json");
  if (res.kind !== "invalid_json") return;
  assert.equal(res.rawSnippet, "{not json");
  assert.ok("normalizedProviderPayload" in res);
});

test("reflected secrets in error pages are scrubbed", async () => {
  const { scrubRawSnippet } = await import(
    "../../open-sse/handlers/chatCore/nonStreamingResponseParse.ts"
  );
  const dirty =
    '<html>Error <a href="https://x/?token=abc123secret">retry</a> Bearer tokengoeshere123 key=sk-abcdef1234567890</html>';
  const clean = scrubRawSnippet(dirty);
  assert.ok(!clean.includes("abc123secret"), "query token scrubbed");
  assert.ok(!clean.includes("tokengoeshere123"), "bearer scrubbed");
  assert.ok(!clean.includes("sk-abcdef1234567890"), "sk- scrubbed");
  assert.ok(clean.includes("[REDACTED]"), "redaction marker present");
});
