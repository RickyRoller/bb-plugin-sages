Keep a tuned chat for each topic or project you return to. A sage's chat never
ends and never needs compacting.

## What you get

- A **Sages** page in the left sidebar that creates, edits, and removes sages.
- One endless chat per sage, with BB's own composer, models, attachments, and
  permissions.
- Acolytes: sages under a lead sage, each focused on one part of its work, with
  the lead's memory and a chat of their own. Keep one for good, or close it and
  send its summary back to the lead.
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
are written on whichever provider, model and reasoning level you pick in the
plugin settings: Claude Code, Codex and Pi are called directly through their
CLIs; other providers, and BB's default, run in short-lived hidden BB threads.


## Envoys for bounded tasks

Start an Envoy for a bug, issue or small feature. It gets a fresh workspace and
one visible BB chat, with an optional name, issue link and specialist lead.
An ordinary agent leads by default and delegates appropriate work to specialists.
Git projects start in a new worktree; the native composer controls models and permissions.

Attached PRs start as drafts. If you name a ready-PR handoff specialist in the
settings, marking a PR ready hands it to that specialist for follow-up, with any
instructions you set. Without one, or without an attached PR, nothing polls GitHub.
Park a task to stop implementation while keeping its workspace and PR follow-up.
Open the Envoys tab or use the New Envoy command palette action.
