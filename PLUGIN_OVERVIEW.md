Keep a tuned chat for each topic or project you return to. A sage's chat never
ends and never needs compacting.

## What you get

- A **Sages** page in the left sidebar that creates, edits, and removes sages.
- One endless chat per sage, with BB's own composer, models, attachments, and
  permissions.
- A `bb sages` command that lists, shows, creates, and removes sages from a
  terminal.

## How it works

A sage has a name, a one-line topic, and standing instructions. Every message
of its chat is logged, and a cheap model compresses the log into a tree of
one-line summaries in the background. Each message you send starts a fresh
agent session that sees summaries of the whole chat, recent ones in detail and
old ones in brief, and opens any line down to the original message when it
needs more. The context stays the same size however long the chat gets.

The chat is stored in this plugin's own database on the BB server. Summaries
are written by Claude Haiku through the `claude` command, so Claude Code must
be installed and signed in.
