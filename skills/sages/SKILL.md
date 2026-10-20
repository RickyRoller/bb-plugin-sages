---
name: sages
description: List, inspect, create, and remove sages (lasting chats), acolytes (sages under a lead sage), and Envoys (task workspaces) with the `bb sages` CLI. Use when the user asks about their sages, acolytes, or Envoys, wants to create one, or refers to one by name. Sages are not specialists; do not use `bb specialists` for them.
---

# Sages

A sage is a tuned chat with a name, a one-line topic, standing instructions,
and one chat that never ends: each message the user sends runs in a fresh
thread that sees summaries of the whole chat. The Sages page in the BB sidebar
and the `bb sages` command read and write the same records.

An acolyte is a sage under a lead sage, focused on one part of the lead's
work. It inherits the lead's instructions and memory, so give it only
instructions about its focus. Acolytes cannot have acolytes.

Sages are not specialists. A specialist (`bb specialists`) is a one-shot agent
preset; when the user asks for a sage or an acolyte, use `bb sages`.

## Commands

| Command | Effect |
| --- | --- |
| `bb sages list` | Show every sage with its id and topic. |
| `bb sages show <sage-id>` | Show one sage, its instructions, and the size of its chat. |
| `bb sages create <name> [--topic <text>] [--instructions <text>] [--project <project-id>] [--lead <sage-id>]` | Create a sage. Quote values that have spaces. `--project` assigns the project its turns start in; get ids from `bb project list`. `--lead` makes it an acolyte of that sage. |
| `bb sages lead <sage-id> <lead-id\|none>` | Make a sage an acolyte of a lead, or its own lead again. |
| `bb sages remove <sage-id>` | Delete a sage and its whole chat. This cannot be undone. |

Add `--json` to any command when the output drives code.

## Rules

- Run `bb sages list` first and use the ids it prints; never guess an id.
- Limits: name 80 characters, topic 200, instructions 3500.
- The CLI does not send messages to a sage or edit an existing sage; the user
  does those on the Sages page.
- `bb sages list` shows active acolytes (sages under a lead sage) indented
  under their lead, marked `↳`. To create a lead with acolytes, create the
  lead first, then create each acolyte with `--lead <lead-id>` from the
  output. `bb sages lead <sage-id> <lead-id|none>` moves a sage under a lead
  or back out. Removing a lead removes its acolytes too.
- Remove a sage only when the user asks for that sage by name: removal deletes
  its chat for good.


## Envoys

Envoys are standalone task workspaces, each with one stable visible BB thread.
Create one only when the user asks for an Envoy or explicitly chooses that workflow.
Sages and Acolytes already delegate to specialists; do not automatically replace that
with Envoy creation.

- `bb sages envoy list [--json]` and `show <id>` inspect tasks. Use returned ids.
- `bb sages envoy create --project <project-id> --task <directive>` starts work in
  a fresh worktree. Optional: `--name`, `--issue` (full https issue URL),
  `--specialist` (lead preset), `--request-id` (reuse for deduplication).
  Prefer the New Envoy UI when machine/model/permissions need selection.
- `bb sages envoy park|resume|complete|cancel <id>` manages task lifecycle. Park
  preserves workspace/chat and PR follow-up. Complete preserves PR follow-up;
  cancel stops attached readiness checks and handoff agents. These commands do not
  delete files.
- `bb sages envoy pr <id> <full-github-pr-url>` attaches an existing task PR.
  The primary Envoy agent can instead call `envoy_attach_pr` immediately after
  opening its draft PR. The details dialog can detach or retry the handoff.
- `bb sages envoy recover <id>` finds an existing thread after an interrupted
  creation response; it does not resend ambiguous spawns. A definite rejected
  launch can be relaunched; an unthreaded task can also be cancelled. Retry known agent or
  workspace failures in the native task thread.

For a project listed in Sages' `envoyPreparedProjects` setting, use its dedicated
base-checkout project ID in `--project`. Creation first fast-forwards the clean default
branch and runs the configured `envoyInstallCommand`, if any, then creates a worktree
at that exact commit. Preparation failures block launch; correct the
cause and `recover`. Do not reset/stash the source or bypass preparation. New worktrees
still need their own dependencies: follow repository setup instructions and the
Envoy's launch instructions before editing or validating. Other projects use native BB setup.

Use specialists for appropriate work; a specialist lead is optional. All new PRs
must open as drafts. Never mark ready without the user's explicit request. Only
attached Envoy PRs are polled, and only when a Ready-PR handoff specialist is
chosen in the Sages settings: readiness then starts it automatically. Do not start
another handoff worker manually. If that specialist is unavailable, report the
error so the user can restore it or change the setting, then retry. Read-only host failures retry with backoff; handoff
errors pause polling until Retry. Specialists must support keyed handoff version 1;
older versions are rejected before dispatch. `gh` must be
installed and authenticated on the task workspace's machine.

Automated notices cannot resume parked/completed tasks; a user message resumes
those tasks. Cancelled tasks require Resume. Resume a cancelled handoff worker
from its own BB thread. Read-only readiness errors retry with backoff; handoff
errors pause until Retry. For an unconfirmed handoff, ordinary Retry only
recovers its original worker. The Envoy details UI offers a confirmed Relaunch
handoff that searches again before permitting another spawn.
