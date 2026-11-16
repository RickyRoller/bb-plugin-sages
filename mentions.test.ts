import assert from "node:assert/strict";
import { test } from "node:test";
import { mentionContext, mentionItems, type MentionableSage } from "./mentions.ts";

const sage = (id: string, name: string, parentId: string | null = null, extra: Partial<MentionableSage> = {}) =>
  ({ id, name, topic: "", parentId, archivedAt: null, ...extra }) as MentionableSage;
const sages = [
  sage("web", "Web", null, { topic: "Web app" }),
  sage("search", "Search", "web", { topic: "Search page" }),
  sage("old", "Old acolyte", "web", { archivedAt: "2026-01-01" }),
  sage("infra", "Infra"),
  sage("ci", "CI", "infra"),
];

test("the picker lists each lead then its open acolytes, which name their lead", () => {
  assert.deepEqual(
    mentionItems(sages, "").map((i) => [i.title, i.subtitle ?? ""]),
    [
      ["Web", "Web app"],
      ["Search", "Acolyte of Web · Search page"],
      ["Infra", ""],
      ["CI", "Acolyte of Infra"],
    ],
  );
});

test("a matching lead brings its acolytes; a matching acolyte comes alone", () => {
  assert.deepEqual(mentionItems(sages, "web").map((i) => i.id), ["web", "search"]);
  assert.deepEqual(mentionItems(sages, "ci").map((i) => i.id), ["ci"]);
  assert.deepEqual(mentionItems(sages, "search page").map((i) => i.id), ["search"]);
});

test("an acolyte's mention names its lead and how to reach it", () => {
  const text = mentionContext(sages[1]!, sages[0]);
  assert.match(text, /acolyte sage "Search" \(id search\), which works under the lead sage "Web" \(id web\)/);
  assert.match(text, /bb sages send search --message-file <path>/);
  assert.doesNotMatch(mentionContext(sages[3]!, undefined), /lead/);
});
