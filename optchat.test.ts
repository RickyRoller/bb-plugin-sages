// Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import {
  Chat,
  LINE_BYTES,
  MIGRATIONS,
  shrink,
  type Ref,
  type Summarize,
} from "./optchat.ts";

// Taelin's rollback push (rollback_state_list.js), the reference for which
// lines merge.
type States = { keep: number; state: number; older: States } | null;
function push(state: number, states: States): States {
  if (states === null) return { keep: 0, state, older: null };
  if (states.keep === 0) return { ...states, keep: 1 };
  return { keep: 0, state, older: push(states.state, states.older) };
}
function starts(states: States): number[] {
  const list: number[] = [];
  for (let at = states; at !== null; at = at.older) list.unshift(at.state);
  return list;
}

test("shrink makes exactly the merges of the rollback push", () => {
  let states: States = null;
  const view: Ref[] = [];
  for (let t = 0; t <= 20_000; t += 1) {
    states = push(t, states);
    const expected = starts(states);
    view.push([0, t]);
    shrink(
      view,
      t + 1,
      expected.length,
      () => 1,
      () => true,
    );
    assert.deepEqual(
      view.map(([l, i]) => i * 2 ** l),
      expected,
      `at t=${t}`,
    );
  }
});

function open(summarize: Summarize = async () => "sage: summary") {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  return { db, chat: new Chat(db, "s1", summarize) };
}

test("short messages are their own lines and merge without a call", async () => {
  let calls = 0;
  const { chat } = open(async () => {
    calls += 1;
    return "x";
  });
  chat.append("user", "hello");
  chat.append("sage", "hi there");
  await chat.settled();
  assert.equal(calls, 0);
  assert.equal(
    chat.render(),
    "<chat>\n0+1|user: hello\n1+1|sage: hi there\n</chat>",
  );
  assert.equal(chat.zoom(0, 2), "0+1|user: hello\n1+1|sage: hi there");
  assert.equal(chat.zoom(1, 1), "sage: hi there");
  assert.throws(() => chat.zoom(1, 2), /multiple/);
});

test("a long message is compacted with the chat as context, and retried when too long", async () => {
  const conversations: string[][] = [];
  const { chat } = open(async (conversation) => {
    conversations.push([...conversation]);
    return conversation.length === 1
      ? "y".repeat(LINE_BYTES + 1)
      : "user: long";
  });
  chat.append("user", "first");
  chat.append("user", "z".repeat(2000));
  assert.match(chat.render(), /1\+1\|\(not summarized yet: zoom it\)/);
  await chat.settled();
  assert.match(chat.render(), /1\+1\|user: long/);
  assert.equal(conversations.length, 2);
  assert.match(
    conversations[0]![0]!,
    /^<chat>\n0\+1\|user: first\n<\/chat>\nCompaction: compress message 1 /,
  );
  assert.match(conversations[1]![2]!, /^Too long: your line is 513 bytes/);
});

test("the view survives a reload and stays within its budget", async () => {
  const { db, chat } = open();
  const text = "word ".repeat(200);
  for (let n = 0; n < 12_000; n += 1) {
    chat.append("user", n % 30 === 0 ? `${n} ${text}` : `short ${n}`);
    // Let the compactions run, as they do between real messages.
    if (n % 30 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const { viewBytes, messages } = chat.stats();
  assert.equal(messages, 12_000);
  assert.ok(
    viewBytes <= 128_000 + LINE_BYTES + 20,
    `view is ${viewBytes} bytes`,
  );
  const rendered = chat.render();
  chat.dispose();
  assert.equal(new Chat(db, "s1", async () => "x").render(), rendered);
});
