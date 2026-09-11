/**
 * chatCore non-streaming response parsing/classification (Quality Gate v2 / Fase 9 — chatCore
 * god-file decomposition, #3501 — response-handling slice of executeProviderRequest).
 *
 * Extracted from handleChatCore's `if (!stream)` block: reads the upstream non-streaming body,
 * detects whether it is an event stream (SSE / NDJSON) buffered for a non-streaming client, and
 * parses it into a JSON response body. Returns a discriminated union describing the outcome
 * (`ok` | `invalid_sse` | `invalid_json`) and leaves every persistence side-effect
 * (appendRequestLog / persistAttemptLogs / persistFailureUsage / trackPendingRequest /
 * createErrorResult) to the handler, so behaviour is observably identical to the previous inline
 * block. Pure with respect to handler state (only buffering debug/warn logs as a side effect).
 */

import { normalizePayloadForLog } from "@/lib/logPayloads";
import { extractSSEErrorMessage } from "../sseParser.ts";
import { readNonStreamingResponseBody } from "./nonStreamingResponseBody.ts";
import {
  normalizeNonStreamingEventPayload,
  parseNonStreamingSSEPayload,
  shouldTreatBufferedEventResponseAsExpected,
} from "./nonStreamingSse.ts";

type LoggerLike =
  | {
      debug?: (...args: unknown[]) => void;
      warn?: (...args: unknown[]) => void;
    }
  | null
  | undefined;

export type JsonRecord = Record<string, unknown>;

export function isJsonRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Scrub likely secrets from a free-text upstream snippet before persistence.
 * Key-based redaction (redactPayload) does not cover reflected tokens inside
 * HTML/text error pages. Bounded, non-overlapping patterns (no ReDoS risk).
 */
export function scrubRawSnippet(snippet: string): string {
  return snippet
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/=]{8,}/g, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9]{8,}/g, "sk-[REDACTED]")
    .replace(/([?&](?:token|api_key|apikey|access_token|secret|key)=)[^&\s"'<>]{4,}/gi, "$1[REDACTED]");
}

export type NonStreamingParseResult =
  | {
      kind: "ok";
      responseBody: JsonRecord;
      responsePayloadFormat: string;
      looksLikeSSE: boolean;
      normalizedProviderPayload: unknown;
    }
  | {
      kind: "invalid_sse";
      message: string;
      looksLikeSSE: true;
      normalizedProviderPayload: unknown;
    }
  | {
      kind: "invalid_json";
      message: string;
      detailedError: string;
      looksLikeSSE: false;
      normalizedProviderPayload: unknown;
      /**
       * Bounded raw upstream snippet (first 2000 chars of the raw body) so
       * operators can see what the upstream actually returned when it sends
       * a non-JSON error page (e.g. Cloudflare HTML). 2026-09-11 incident:
       * "Invalid error response format" swallowed this evidence.
       */
      rawSnippet: string;
    };

export async function parseNonStreamingResponseBody(opts: {
  providerResponse: Response;
  upstreamStream: boolean;
  providerHeaders: Record<string, unknown> | Headers | null | undefined;
  finalBody: unknown;
  targetFormat: string;
  model: string;
  log?: LoggerLike;
}): Promise<NonStreamingParseResult> {
  const { providerResponse, upstreamStream, providerHeaders, finalBody, targetFormat, model, log } =
    opts;

  const contentType = (providerResponse.headers.get("content-type") || "").toLowerCase();
  const rawBody = await readNonStreamingResponseBody(providerResponse, contentType, upstreamStream);
  const normalizedProviderPayload = normalizePayloadForLog(rawBody);
  const looksLikeSSE =
    contentType.includes("text/event-stream") ||
    contentType.includes("application/x-ndjson") ||
    /(^|\n)\s*(event|data):/m.test(rawBody);

  if (looksLikeSSE) {
    const streamPayload = normalizeNonStreamingEventPayload(rawBody, contentType);
    const streamKind = contentType.includes("application/x-ndjson") ? "NDJSON" : "SSE";
    if (shouldTreatBufferedEventResponseAsExpected(upstreamStream, providerHeaders, finalBody)) {
      log?.debug?.(
        "STREAM",
        `Buffering upstream ${streamKind} response for non-streaming client request`
      );
    } else {
      log?.warn?.(
        "STREAM",
        `Unexpected ${streamKind} response for non-streaming request — buffering`
      );
    }
    // Upstream returned an event stream for a non-streaming client; convert best-effort to JSON.
    const parsedFromSSE = parseNonStreamingSSEPayload(streamPayload, targetFormat, model);

    if (!parsedFromSSE) {
      // Some executors (e.g. the Devin/Windsurf CLI) always emit text/event-stream, signalling
      // failure with an error-only chunk (`data: {"error":{"message":"Devin CLI not found..."}}`)
      // that carries no `choices`. Surface that real, sanitized message instead of the generic 502
      // so the actionable error is not swallowed (#3324).
      const surfacedSseError = extractSSEErrorMessage(streamPayload);
      const invalidSseMessage =
        surfacedSseError || "Invalid SSE response for non-streaming request";
      return {
        kind: "invalid_sse",
        message: invalidSseMessage,
        looksLikeSSE: true,
        normalizedProviderPayload,
      };
    }

    return {
      kind: "ok",
      responseBody: parsedFromSSE.body,
      responsePayloadFormat: parsedFromSSE.format,
      looksLikeSSE: true,
      normalizedProviderPayload,
    };
  }

  try {
    const responseBody: unknown = rawBody ? JSON.parse(rawBody) : {};
    if (!isJsonRecord(responseBody)) {
      return {
        kind: "invalid_json",
        message: "Invalid JSON response from provider",
        detailedError: "Invalid JSON response from provider: expected an object payload",
        looksLikeSSE: false,
        normalizedProviderPayload,
      };
    }
    return {
      kind: "ok",
      responseBody,
      responsePayloadFormat: targetFormat,
      looksLikeSSE: false,
      normalizedProviderPayload,
    };
  } catch (err) {
    const detailedError = `Invalid JSON response from provider (error: ${err instanceof Error ? err.message : String(err)}): ${rawBody.substring(0, 1000)}`;
    const invalidJsonMessage = "Invalid JSON response from provider";
    return {
      kind: "invalid_json",
      message: invalidJsonMessage,
      detailedError,
      looksLikeSSE: false,
      normalizedProviderPayload,
      // Scrubbed: hostile error pages can reflect secrets (?token=, Bearer,
      // sk- keys). Key-based redaction does not cover free-text snippets.
      rawSnippet: scrubRawSnippet(rawBody.substring(0, 2000)),
    };
  }
}
