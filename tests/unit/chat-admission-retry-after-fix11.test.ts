// FIX-11: 503 Retry-After tracks OMNIROUTE_CHAT_ADMISSION_QUEUE_MS (not the
// per-call queueMs test override). Shed events report #activeHealthy.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ChatAdmissionController,
  admitChatStructure,
  admitChatRequest,
  CHAT_ADMISSION_QUEUE_MAX_MS,
  type ChatAdmissionShedEvent,
} from "../../src/shared/middleware/chatBodyAdmission.ts";
import { chatAdmissionRetryAfterSeconds } from "../../src/shared/middleware/chatAdmissionRetryAfter.ts";

function heavyBody() {
  return {
    messages: Array.from({ length: 200 }, () => ({ role: "user", content: "x".repeat(40) })),
    tools: [] as unknown[],
  };
}

function largeRequest(): Request {
  const body = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(64) }] });
  return new Request("http://x/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(body.length) },
    body,
  });
}

test("chatAdmissionRetryAfterSeconds ceils ms to seconds with a floor of 1", () => {
  assert.equal(chatAdmissionRetryAfterSeconds(0), 1);
  assert.equal(chatAdmissionRetryAfterSeconds(1), 1);
  assert.equal(chatAdmissionRetryAfterSeconds(1000), 1);
  assert.equal(chatAdmissionRetryAfterSeconds(1001), 2);
  assert.equal(chatAdmissionRetryAfterSeconds(2000), 2);
  assert.equal(chatAdmissionRetryAfterSeconds(2500), 3);
  assert.equal(chatAdmissionRetryAfterSeconds(5000), 5);
});

test("structural 503 Retry-After uses OMNIROUTE_CHAT_ADMISSION_QUEUE_MS, not options.queueMs", async () => {
  const expected = String(chatAdmissionRetryAfterSeconds(CHAT_ADMISSION_QUEUE_MAX_MS));
  const controller = new ChatAdmissionController(1, undefined, 0, () => {});
  const primary = controller.tryAcquireHeavy();
  assert.ok(primary);
  try {
    const result = await admitChatStructure(heavyBody(), null, {
      controller,
      heapPressureCheck: () => true,
      queueMs: 0,
    });
    assert.equal(result.admit, false);
    if (result.admit) return;
    assert.equal(result.response.headers.get("Retry-After"), expected);
  } finally {
    primary.release();
  }
});

test("byte-stage 503 Retry-After uses OMNIROUTE_CHAT_ADMISSION_QUEUE_MS", async () => {
  const expected = String(chatAdmissionRetryAfterSeconds(CHAT_ADMISSION_QUEUE_MAX_MS));
  const controller = new ChatAdmissionController(1, undefined, 0, () => {});
  const first = await admitChatRequest(largeRequest(), {
    controller,
    largeBodyBytes: 32,
    hardMaxBytes: 1024,
    queueMs: 0,
  });
  assert.equal(first.admit, true);
  try {
    const second = await admitChatRequest(largeRequest(), {
      controller,
      largeBodyBytes: 32,
      hardMaxBytes: 1024,
      queueMs: 0,
    });
    assert.equal(second.admit, false);
    if (second.admit) return;
    assert.equal(second.response.headers.get("Retry-After"), expected);
  } finally {
    if (first.admit) first.lease?.release();
  }
});

test("history 413 omits Retry-After", async () => {
  const result = await admitChatStructure(
    { messages: Array.from({ length: 3 }, () => ({ role: "user", content: "x" })) },
    null,
    { maxMessages: 2, heavyMessages: 1, queueMs: 0 }
  );
  assert.equal(result.admit, false);
  if (result.admit) return;
  assert.equal(result.response.status, 413);
  assert.equal(result.response.headers.get("Retry-After"), null);
});

test("shed activeHealthyHeadroom is the live #activeHealthy count, not the budget", async () => {
  const events: ChatAdmissionShedEvent[] = [];
  const pressured = new ChatAdmissionController(1, undefined, 2, (e) => events.push(e));
  const primary = pressured.tryAcquireHeavy();
  assert.ok(primary);
  try {
    const shed = await admitChatStructure(heavyBody(), null, {
      controller: pressured,
      heapPressureCheck: () => true,
      queueMs: 0,
    });
    assert.equal(shed.admit, false);
    assert.equal(events.at(-1)?.activeHeavy, 1);
    assert.equal(events.at(-1)?.activeHealthyHeadroom, 0);
  } finally {
    primary.release();
  }

  events.length = 0;
  const mixed = new ChatAdmissionController(1, undefined, 2, (e) => events.push(e));
  const first = await admitChatStructure(heavyBody(), null, {
    controller: mixed,
    heapPressureCheck: () => false,
    queueMs: 0,
  });
  const second = await admitChatStructure(heavyBody(), null, {
    controller: mixed,
    heapPressureCheck: () => false,
    queueMs: 0,
  });
  assert.equal(first.admit, true);
  assert.equal(second.admit, true);
  try {
    const third = await admitChatStructure(heavyBody(), null, {
      controller: mixed,
      heapPressureCheck: () => true,
      queueMs: 0,
    });
    assert.equal(third.admit, false);
    assert.equal(events.at(-1)?.activeHeavy, 1);
    assert.equal(events.at(-1)?.activeHealthyHeadroom, 1);
  } finally {
    if (first.admit) first.lease?.release();
    if (second.admit) second.lease?.release();
  }
});
