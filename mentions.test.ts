import assert from "node:assert/strict";
import { test } from "node:test";
import { mentionContext, mentionItems, type MentionableSage } from "./mentions.ts";

const sage = (id: string, name: string, parentId: string | null = null, extra: Partial<MentionableSage> = {}) =>
  ({ id, name, topic: "", parentId, archivedAt: null, ...extra }) as MentionableSage;
const sages = [
  sage("wallet", "Wallet", null, { topic: "Mobile wallet" }),
  sage("swaps", "Swaps", "wallet", { topic: "Swap flow" }),
  sage("old", "Old acolyte", "wallet", { archivedAt: "2026-01-01" }),
  sage("infra", "Infra"),
  sage("ci", "CI", "infra"),
];

test("the picker lists each lead then its open acolytes, which name their lead", () => {
  assert.deepEqual(
    mentionItems(sages, "").map((i) => [i.title, i.subtitle ?? ""]),
    [
      ["Wallet", "Mobile wallet"],
      ["Swaps", "Acolyte of Wallet · Swap flow"],
      ["Infra", ""],
      ["CI", "Acolyte of Infra"],
    ],
  );
});

test("a matching lead brings its acolytes; a matching acolyte comes alone", () => {
  assert.deepEqual(mentionItems(sages, "wallet").map((i) => i.id), ["wallet", "swaps"]);
  assert.deepEqual(mentionItems(sages, "ci").map((i) => i.id), ["ci"]);
  assert.deepEqual(mentionItems(sages, "swap flow").map((i) => i.id), ["swaps"]);
});

test("an acolyte's mention names its lead and how to reach it", () => {
  const text = mentionContext(sages[1]!, sages[0]);
  assert.match(text, /acolyte sage "Swaps" \(id swaps\), which works under the lead sage "Wallet" \(id wallet\)/);
  assert.match(text, /bb sages send swaps --message-file -/);
  assert.doesNotMatch(mentionContext(sages[3]!, undefined), /lead/);
});
