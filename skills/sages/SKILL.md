---
name: sages
description: List, inspect, create, and remove sages (tuned chats bound to a topic or project) with the `bb sages` CLI. Use when the user asks about their sages, wants a new sage, or refers to a sage by name.
---

# Sages

A sage is a tuned chat with a name, a one-line topic, standing instructions,
and one chat that never ends: each message the user sends runs in a fresh
thread that sees summaries of the whole chat. The Sages page in the BB sidebar
and the `bb sages` command read and write the same records.

## Commands

| Command | Effect |
| --- | --- |
| `bb sages list` | Show every sage with its id and topic. |
| `bb sages show <sage-id>` | Show one sage, its instructions, and the size of its chat. |
| `bb sages create <name> [--topic <text>] [--instructions <text>] [--project <project-id>]` | Create a sage. Quote values that have spaces. `--project` assigns the project its turns start in; get ids from `bb project list`. |
| `bb sages lead <sage-id> <lead-id\|none>` | Make a sage an acolyte of a lead, or its own lead again. |
| `bb sages remove <sage-id>` | Delete a sage and its whole chat. This cannot be undone. |

Add `--json` to any command when the output drives code.

## Rules

- Run `bb sages list` first and use the ids it prints; never guess an id.
- Limits: name 80 characters, topic 200, instructions 3500.
- The CLI does not send messages to a sage or edit an existing sage; the user
  does those on the Sages page.
- `bb sages list` shows active acolytes (sages under a lead sage) indented
  under their lead, marked `↳`. `bb sages create --lead <sage-id>` creates one;
  `bb sages lead <sage-id> <lead-id|none>` moves a sage under a lead or back
  out. Removing a lead removes its acolytes too.
- Remove a sage only when the user asks for that sage by name: removal deletes
  its chat for good.
