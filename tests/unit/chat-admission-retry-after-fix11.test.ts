// FIX-11: Retry-After must track OMNIROUTE_CHAT_ADMISSION_QUEUE_MS, and shed
// events must include activeHealthyHeadroom so operators can see stacked leases.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ChatAdmissionController,
  admitChatStructure,
  CHAT_ADMISSION_QUEUE_MAX_MS,
} from "../../src/shared/middleware/chatBodyAdmission.ts";

function heavyBody() {
  return {
    messages: Array.from({ length: 200 }, () => ({ role: "user", content: "x".repeat(40) })),
    tools: [] as unknown[],
  };
}

test("FIX-11: structural 503 Retry-After is ceil(queueMs/1000)", async () => {
  const expected = String(Math.max(1, Math.ceil(CHAT_ADMISSION_QUEUE_MAX_MS / 1000)));
  const controller = new ChatAdmissionController(1, undefined, 0, () => {});
  const primary = controller.tryAcquireHeavy();
  assert.ok(primary);
  const result = await admitChatStructure(heavyBody(), null, {
    controller,
    heapPressureCheck: () => true,
    queueMs: 0,
  });
  assert.equal(result.admit, false);
  if (result.admit) return;
  assert.equal(result.response.headers.get("Retry-After"), expected);
  primary.release();
});

test("FIX-11: shed event includes activeHealthyHeadroom", async () => {
  const events: Array<{ activeHealthyHeadroom?: number; activeHeavy: number }> = [];
  const controller = new ChatAdmissionController(1, undefined, 1, (e) => events.push(e));
  const first = await admitChatStructure(heavyBody(), null, {
    controller,
    heapPressureCheck: () => false,
    queueMs: 0,
  });
  const second = await admitChatStructure(heavyBody(), null, {
    controller,
    heapPressureCheck: () => false,
    queueMs: 0,
  });
  assert.equal(first.admit, true);
  assert.equal(second.admit, true);
  const third = await admitChatStructure(heavyBody(), null, {
    controller,
    heapPressureCheck: () => false,
    queueMs: 0,
  });
  assert.equal(third.admit, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].activeHeavy, 1);
  assert.equal(events[0].activeHealthyHeadroom, 1);
  if (first.admit) first.lease?.release();
  if (second.admit) second.lease?.release();
});
