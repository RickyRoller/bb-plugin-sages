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

Start an Envoy for a bug, issue or feature, even one across repos. It gets an
endless chat of its own, with an optional name, issue link and specialist lead.
The chat coordinates lanes: visible threads, each in a fresh worktree from a
project's default branch, one per repo or PR. Each lane opens draft PRs and owns
them end to end, with its specialists as child threads. If you name a ready-PR
handoff specialist in the settings, each attached PR gets a watcher automation
owned by its lane; marking the PR ready tells the lane, which hands it to that
specialist for follow-up. Parking or cancelling the Envoy stops its chat and
lanes and removes its watchers.
Open the Envoys tab or use the New Envoy command palette action.
