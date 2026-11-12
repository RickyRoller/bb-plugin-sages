# bb-plugin-sages

Sages for lasting chats, Acolytes for focused child chats, and Envoys for task workspaces.

A BB plugin with three parts:

- A **sage** is a chat you keep coming back to, usually about one topic or
  project. Its chat never ends and never needs compacting.
- An **acolyte** is a sage under a lead sage. It focuses on one part of the
  lead's work and shares the lead's memory.
- An **Envoy** is one bounded task, such as a bug, an issue or a feature. It
  gets its own endless chat, which coordinates the work, and a clear lifecycle
  from start to done.
- A **lane** is one part of an Envoy's work: a visible BB thread in its own
  fresh worktree, usually one per repo or PR. It owns its PRs, and the
  specialists it hands work to run as its **child threads**.

## Table of Contents

- [Background](#background)
- [Install](#install)
- [Usage](#usage)
  - [Sages](#sages)
  - [Acolytes](#acolytes)
  - [Envoys](#envoys)
  - [CLI](#cli)
- [How a sage remembers](#how-a-sage-remembers)
- [Settings](#settings)
- [For plugin authors](#for-plugin-authors)
- [Acknowledgements](#acknowledgements)
- [Contributing](#contributing)
- [License](#license)

## Background

Agent chats get long and then get compacted, and compaction loses detail. A
sage avoids that: every message is kept word for word. In the background, a
cheap model folds the log into a tree of short summaries. Each turn starts
fresh with a view of the whole chat. Recent lines are detailed, old ones are
brief, and the sage can open any line back up to the original message. The
context stays the same size however long the chat runs.

Sages are good for lasting conversations, but not for doing scoped work in a
repository. Envoys fill that gap. Each task gets a chat that opens a worktree
and thread (a lane) for each part of the work, tracks their PRs, and lets you
park or close it all cleanly.

The memory design comes from Victor Taelin's
[optchat](https://gist.githubusercontent.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449/raw/3c190e06f34aba0c69f49042c526093269604935/optchat.md).

## Install

```sh
git clone git@github.com:RickyRoller/bb-plugin-sages.git
cd bb-plugin-sages
npm install
bb plugin build .
bb plugin install .
```

After you change the source, rebuild and reload it, or run `bb plugin dev .`
to do that on every save:

```sh
bb plugin build . && bb plugin reload sages
```

### Dependencies

Sages works on its own. These other plugins and tools add features:

| Needs | For |
| --- | --- |
| Specialists plugin | `sage_handoff`, Envoy specialist leads, and the ready-PR handoff |
| Sidebar Thread Details plugin | The Sages and Envoys sections in the sidebar |
| Automations plugin and `gh` | PR watchers for Envoys |
| Worktree plugin | Envoys in prepared projects |
| `claude`, `codex` or `pi` on your shell's PATH | Running summaries directly through that CLI (optional) |

## Usage

Open **Sages** in the left sidebar. The page has two tabs: **Sages** and
**Envoys**.

### Sages

Create a sage with a name, a one-line topic, standing instructions and an
optional project. The project is where the composer starts. Each message you
send starts a fresh, hidden BB thread that runs with full access. BB's own
composer and chat view are used, so messages you send during a turn steer it
like in any thread.

A sage has these tools:

- `sage_zoom(id, n)` opens a line of its view, down to the original message.
- `sage_date(id)` reads when a message was sent.
- `sage_handoff(specialist, task)` hands work to a specialist. The
  specialist runs in its own thread, and its last message comes back to the
  chat as `[name] report …`.
- `sage_acolyte(name, focus, brief?)` opens an acolyte. A sage only uses it
  when you ask for one.
- `sage_message_acolyte(acolyte, message, round?)` sends an acolyte work or a
  question.
- `sage_envoy(task, project?, name?, issueUrl?, specialist?, requestId?)`
  starts an Envoy. A sage only uses it when you ask it to.

Type `@` in any composer to mention a sage. The agent then knows which sage
you mean, its topic, and that `bb sages send` reaches it.

### Acolytes

An acolyte is its own sage, with its own chat and instructions. Its focus is
one part of the lead's work: a parallel task, a side subject, or a lasting
area like one app in a project. Each turn it also sees the lead's
instructions and the lead's whole view, so it knows everything the lead
knows. Acolytes cannot have acolytes.

- **Open** one from the lead's chat (the branch button), from the create
  form, or by asking the lead. You can also move an existing sage under a
  lead with the edit form or `bb sages lead`.
- **Message** it from the lead with `sage_message_acolyte`. Its reply comes
  back to the lead as `[acolyte <name>] …`. When the lead sends the same
  question to several acolytes, it gives them one `round`. Each reply says
  who the round is still waiting on. When all have replied, the lead is told
  to weigh the answers together. A round closes after 30 minutes and names
  anyone who hasn't replied.
- **See** open acolytes as chips above the lead's composer, as rows in the
  lead's chat, and under the lead in the Sages list and sidebar.
- **Close** it from its page. You can send a summary to the lead or just
  archive it. A closed acolyte stays readable and can be reopened.

### Envoys

Start one from **Sages → Envoys → New Envoy**, from the **New Envoy** command
palette action, from the CLI, or by asking a sage. Describe the task. You can
also give a name, an issue link and a specialist lead. BB's composer picks the
default project, model and permissions.

**Three levels.** In the sidebar's Envoys section:

```
✈ Takes share cards            ← the Envoy: opens its chat
│ [LANE] wallet: share card     ← a lane: a thread in its own worktree
│   └ device-validator run      ← a child thread the lane started
│ [LANE] backend: take kind
```

**The chat.** The Envoy's chat works like a sage's: it never ends, and each
message runs as a fresh turn that reads a summary of the whole chat. It does
not edit code. It opens lanes with `envoy_open_lane(project, name, task)`, one
per repo or per PR you want reviewed apart, and as many as the work turns out
to need. It messages a lane with `envoy_message_lane`. When a turn it started
in a lane ends, the lane's last message comes back to the chat as a new turn.
If you work in a lane directly, that turn only shows up in the chat's log.

**Lanes.** By default an ordinary BB agent leads each lane (or the specialist
lead, if you picked one), and it hands work to specialists when their role
fits. A lane opens PRs as drafts and attaches them with `envoy_attach_pr` (or
you attach them in the details dialog). The lane owns each PR to the end.

Envoys started before lanes existed are one thread each and keep working as
before.

**Ready-PR handoff.** If you pick a handoff specialist in the settings, each
attached PR gets a watcher. A watcher is a script automation the lane owns,
named `Envoy PR watcher: <url>`. Every 2 minutes it checks the PR with `gh`.
Once the PR is marked ready, it tells the lane, which hands the PR to the
specialist and then deletes the watcher. A closed or merged PR also deletes
its watcher.

**Reporting to a sage.** An Envoy that a sage started gets an `envoy_report`
tool in its chat. The sage answers with `bb sages envoy tell <id> "<message>"`. It reports to that sage only when it is blocked or needs a decision
while you aren't in the conversation. A failed turn is reported the same way.
Routine progress is never reported.

**Lifecycle.**

| Action | What happens |
| --- | --- |
| **Park** | Stops the chat's turn and each lane with its children, and removes its watchers. The chat, the worktrees and the handoff workers stay. |
| **Resume** | Restores its watchers and tells the chat to carry on. If the Envoy was completed, its lanes are unarchived and their worktrees rebuilt first. |
| **Complete** | Saves the chat's last reply, then archives each lane with its children and retires the worktrees. The chat stays readable. |
| **Cancel** | Stops the chat and every thread under each lane, and removes its watchers. Only Resume brings it back. |

Automated messages cannot wake a parked, completed or cancelled Envoy. A
message from you resumes a parked or completed one.

**Prepared projects.** For projects listed in `envoyPreparedProjects`, the base
checkout is updated before each new Envoy. Sages checks that the default
branch is clean, fetches it from origin, and fast-forwards it without dropping
local commits. It then runs `envoyInstallCommand` in a login shell, and the
worktree is pinned to that commit. It never resets or stashes. If preparation
fails, nothing is spawned; fix the problem and run `recover`. If an
interrupted run leaves an empty `envoy-prepare.lock` directory in the Git
common directory, check that no preparation is running before you remove it.
A sandboxed agent needs write access to the package manager's cache, for
example `~/.bun/install/cache`.

**Safe retries.** `--request-id` makes a repeated create a no-op (the dialog
sets one for you). If BB clearly rejects a launch, the draft is kept so you
can fix it and send again. If the result is unclear, Sages never resends:
`recover` searches for the thread instead of risking a second agent.

### CLI

`bb sages --help` and `bb sages envoy --help` list every command and flag.

```sh
bb sages list
bb sages create 'Wallet' --topic 'Phantom wallet app' --project <project-id>
bb sages show <sage-id>
bb sages edit <sage-id> --instructions-file notes.md
bb sages edit <sage-id> --envoy-instructions 'Run the iOS tests before a PR'
bb sages send <sage-id> 'What did we decide about retries?'
bb sages lead <sage-id> <lead-sage-id|none>
bb sages remove <sage-id>

bb sages envoy create --project <id> --task 'Fix login crash' --issue https://tracker.example.com/issue/ABC-123
bb sages envoy list --json
bb sages envoy show <id>
bb sages envoy pr <id> https://github.com/owner/repo/pull/123
bb sages envoy park|resume|complete|cancel <id>
bb sages envoy recover <id>
```

Every command accepts `--json`.

## How a sage remembers

- **The log.** Every user message, reply, tool call and tool result is stored
  word for word. Thinking is not stored.
- **The tree.** In the background, the summary model folds the log into a
  binary tree of lines, each at most 512 bytes. A message short enough is its
  own line.
- **The view.** Each turn's first input is a 64-128 KB view of the whole
  chat, hidden from the page. Recent lines are fine-grained and old ones are
  coarse. Nothing else carries over between turns. The view only grows at its
  end, so providers that cache by prefix can reuse it.
- **Acolytes** also get the lead's view inside `<main>` tags. They read it
  with `sage_zoom(id, n, "main")` and `sage_date(id, "main")`.
- **Storage.** Everything lives in append-only tables in the plugin's SQLite
  database at `<dataDir>/plugins/sages/data.db`.
- **The summary model.** Pick it under **Models and handoff** in the settings.
  Claude Code, Codex and Pi are called directly with `claude -p`,
  `codex exec` or `pi -p`, using your own CLI sign-in and config. Any other
  provider, a missing CLI, or no choice runs in a short-lived hidden BB thread
  that is deleted when it answers.

## Settings

Open the plugin's settings page. The **Models and handoff** section has:

- **Summary model**: the provider, model and reasoning level used for
  summaries and acolyte summaries. If unset, BB's default is used.
- **Ready-PR handoff specialist**: who an Envoy hands a ready PR to. If none
  is set, attached PRs are only listed.
- **Envoy badges**: which badge sources show on Envoy rows in the sidebar.

The other settings:

| Setting | Default | Meaning |
| --- | --- | --- |
| `envoyPreparedProjects` | empty | Comma-separated project IDs whose base checkout is prepared before each new Envoy. |
| `envoyInstallCommand` | empty | Installs dependencies in a prepared checkout, such as `npm ci`. Envoys are asked to run it in their worktree too. |
| `envoyPermissionMode` | `full` | The permission level a new Envoy starts in, unless the composer picks one: `full`, `auto` or `accept-edits`. |
| `envoyInstructions` | empty | Standing instructions for every Envoy, up to 2800 characters. A sage's own Envoy instructions replace them for Envoys it starts. |
| `envoyIssueHosts` | empty | Comma-separated hostnames allowed for issue links. Empty accepts any https link. |

## For plugin authors

Other plugins can add to Envoys by publishing these discoverable RPC methods.

### `envoy-decorations.v1.get`: badges on Envoy rows

```ts
// input
{ envoys: { id; threadId: string | null; projectId; environmentId: string | null; lifecycle }[] }
// output: up to 4 badges per Envoy
{ decorations: { envoyId: string; badges: {
  label: string;                // ≤ 40 chars
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  placement?: "title" | "meta"; // default "meta", the line under the title
  href?: string | null;         // https only
  title?: string | null;        // tooltip
}[] }[] }
```

A source gets 3 seconds to answer. A failure, a late answer or a malformed
row adds nothing. When its data changes, a source calls this plugin's
`envoys_badges_changed` RPC with `{}` to refresh the sidebar.

### `envoy-lifecycle.v1.changed`: lifecycle events

```ts
// input; the output is ignored
{ envoy: { id; threadId: string | null; projectId; environmentId: string | null; lifecycle } }
```

For an Envoy with lanes, each lane is its own workspace: decorators and
listeners get one entry per lane, with the id `<envoy id>:<lane id>` and the
lane's thread and environment, and badges for that id go on the lane's row.

This is called on each park, resume, complete and cancel. A completed Envoy
is announced before its thread is archived, so its environment can still be
read. A listener gets 3 seconds, so it should do slow work in the background.
A failure is only logged.

The Metro Control plugin uses both. It shows
each Envoy's Metro server and simulators as badges, and stops them when the
Envoy is parked, completed or cancelled.

The plugin also publishes `sidebar-section.v1.get`, which Sidebar Thread
Details uses to draw the Sages and Envoys sections.

## Acknowledgements

- The memory design comes from Victor Taelin's optchat (see
  [Background](#background)).
- `icons/sage.svg` is 賢 ("wise"), outlined from Noto Serif JP Medium
  (© Google, SIL Open Font License 1.1).

## Contributing

This is a personal plugin. Before you commit a change, run:

```sh
npm test
npm run typecheck
```

Where things live:

| File | Holds |
| --- | --- |
| `optchat.ts` | The memory engine: log, summary tree, view and compactor. It knows nothing about BB. |
| `prompts.ts` | The turn and compaction prompts. |
| `server.ts` | Sages and acolytes: records, turns, tools, settings, RPC and the `bb sages` CLI. |
| `harness.ts` | Calling the summary model through provider CLIs. |
| `envoys.ts`, `envoy-contract.ts` | Envoys: creation, lanes, lifecycle, PR watchers, reports and their RPC. The Envoy's chat runs on the sage chat in `server.ts`. |
| `source-preparation.ts`, `host.ts` | Preparing a project's base checkout on its machine. |
| `sidebar-section.ts` | The sidebar sections and Envoy badges. |
| `mentions.ts` | `@` mentions of sages. |
| `app.tsx`, `envoys-app.tsx`, `settings-app.tsx` | The Sages page, the Envoys tab and the settings page. |
| `skills/sages/SKILL.md` | Tells agents how to use `bb sages`. |
| `PLUGIN_OVERVIEW.md` | The store listing. |

## License

[MIT](LICENSE) © RickyRoller
