// @-mentions of sages and acolytes in any composer. The picker lists each
// lead sage followed by its open acolytes, which name their lead. A mention
// tells the agent which sage the user means and how to reach it.

export interface MentionableSage {
  id: string;
  name: string;
  topic: string;
  parentId: string | null;
  archivedAt: string | null;
}

const MAX_ITEMS = 50;

export function mentionItems(sages: readonly MentionableSage[], query: string) {
  const needle = query.trim().toLowerCase();
  const open = sages.filter((sage) => sage.archivedAt === null);
  const byId = new Map(open.map((sage) => [sage.id, sage]));
  const matches = (sage: MentionableSage) =>
    !needle ||
    sage.name.toLowerCase().includes(needle) ||
    sage.topic.toLowerCase().includes(needle);
  const items = [];
  for (const lead of open.filter((sage) => sage.parentId === null)) {
    const acolytes = open.filter((sage) => sage.parentId === lead.id);
    // A lead that matches brings its acolytes along.
    const leadMatches = matches(lead);
    if (leadMatches)
      items.push({
        id: lead.id,
        title: lead.name,
        ...(lead.topic ? { subtitle: lead.topic } : {}),
        icon: "sages/sage",
      });
    for (const acolyte of acolytes)
      if (leadMatches || matches(acolyte))
        items.push({
          id: acolyte.id,
          title: acolyte.name,
          subtitle: [`Acolyte of ${lead.name}`, acolyte.topic]
            .filter(Boolean)
            .join(" · "),
          icon: "GitBranch",
        });
  }
  // An acolyte whose lead is gone still shows, without a lead to name.
  for (const orphan of open)
    if (orphan.parentId !== null && !byId.has(orphan.parentId) && matches(orphan))
      items.push({
        id: orphan.id,
        title: orphan.name,
        ...(orphan.topic ? { subtitle: orphan.topic } : {}),
        icon: "GitBranch",
      });
  return items.slice(0, MAX_ITEMS);
}

export function mentionContext(
  sage: MentionableSage,
  lead: MentionableSage | undefined,
): string {
  const who = lead
    ? `the acolyte sage "${sage.name}" (id ${sage.id}), which works under the lead sage "${lead.name}" (id ${lead.id})`
    : `the sage "${sage.name}" (id ${sage.id})`;
  return [
    `The user mentioned ${who}.`,
    sage.topic ? `Its topic: ${sage.topic}` : "",
    `A sage is a lasting chat with its own memory. To ask it something or pass it information, run \`bb sages send ${sage.id} --message-file -\` with the message on stdin; it answers in its own chat, not here. \`bb sages show ${sage.id}\` shows its instructions.`,
  ]
    .filter(Boolean)
    .join("\n");
}
