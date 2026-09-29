import assert from "node:assert/strict";
import { test } from "node:test";
import { createAutoCompactHandler } from "../plugins/auto-compact.ts";

function fixture({
  tokens = 70_000,
  turns = 10,
  agent = "game-context",
  parentID,
} = {}) {
  const messages = Array.from({ length: turns }, (_, i) => ({
    id: `msg_user_${i}`,
    type: "user",
    time: { created: i + 2 },
  }));
  messages.push({
    id: "msg_last",
    type: "assistant",
    time: { created: turns + 3, completed: turns + 4 },
    tokens: { input: 1_000, cache: { read: tokens - 1_000 } },
  });

  const calls = [];
  const context = {
    options: { thresholdTokens: 70_000, minUserTurns: 10 },
    session: {
      get: async () => ({ agent, parentID }),
      context: async () => messages,
    },
  };
  const handler = createAutoCompactHandler(context, async (...args) => {
    calls.push(args);
  });
  return { messages, calls, run: () => handler({ sessionID: "ses_test" }) };
}

test("requests once per compaction boundary at the exact threshold", async () => {
  const { messages, calls, run } = fixture();
  await run();
  await run();
  assert.deepEqual(calls, [["ses_test", "msg_auto_compact_msg_last"]]);
  messages.unshift({
    id: "msg_compacted",
    type: "compaction",
    status: "completed",
    time: { created: 1 },
  });
  await run();
  assert.equal(calls.length, 2);
});

for (const [reason, options] of [
  ["small context", { tokens: 69_999 }],
  ["short history", { turns: 9 }],
  ["child session", { parentID: "ses_parent" }],
  ["other agent", { agent: "other" }],
]) {
  test(`skips ${reason}`, async () => {
    const { calls, run } = fixture(options);
    await run();
    assert.equal(calls.length, 0);
  });
}

test("counts only turns after completed compaction", async () => {
  const { messages, calls, run } = fixture();
  messages.unshift({
    type: "compaction",
    status: "completed",
    time: { created: 6 },
  });
  await run();
  assert.equal(calls.length, 0);
});
