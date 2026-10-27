# bb-plugin-sages

Sages for BB. A sage is a tuned chat, usually bound to one topic or project,
that you keep coming back to. Each sage has a name, a one-line topic, standing
instructions, and one chat that never ends.

- `optchat.ts` — the memory engine: the message log, the tree of summaries,
  the view, and the compactor. It knows nothing about BB.
- `prompts.ts` — the turn and compaction prompts.
- `server.ts` — the backend: sage records and their acolytes, turns, logging
  of what a turn's thread does, the `sage_zoom`, `sage_date`, `sage_handoff`,
  `sage_acolyte`, `sage_message_acolyte` and `sage_envoy` tools, the compaction model
  call, RPC for the page, and the `bb sages` CLI.
- `app.tsx` — the frontend: a **Sages** page in the left sidebar. Its root
  lists and creates sages; `/plugins/sages/sages/<sage-id>` is that sage's
  chat.
- `sidebar-section.ts` — the Sages and Envoys sections of the Sidebar Thread
  Details sidebar, and the Envoy badge hook (see "Sidebar and Envoy badges").
- `skills/sages/SKILL.md` — tells agents how to use `bb sages`.
- `PLUGIN_OVERVIEW.md` — the store listing text.

Run `npm test` for engine, Envoy lifecycle and frontend interaction tests and `npm run typecheck` for types.

## Envoys

An Envoy is a task with one stable, visible BB thread and a dedicated workspace.
Open **Sages → Envoys → New Envoy**, or use the **New Envoy** command palette action.
Describe the task; the name is optional and defaults to the first line of the directive.
A full https issue link from any tracker is optional (restrict its hosts with
`envoyIssueHosts`) and appears in the chat header and Sidebar Thread
Details row. Git projects default to a fresh BB worktree, including local repositories
without a remote. BB's composer controls the machine, base branch, model and permissions.
The details dialog shows project, workspace, branch and execution settings.

For dedicated base checkouts, set the Sages setting `envoyPreparedProjects` to
comma-separated BB project IDs. Select the project whose source is the intended base
repository (the allocator passes `--project`). On each new Envoy, preparation runs on
the source machine **before** BB creates the worktree: require a clean default branch,
fetch origin's current default branch, fast-forward without discarding local commits,
and run `envoyInstallCommand` (for example `npm ci` or `bun install --frozen-lockfile`)
in an interactive login shell, so the PATH and version managers your shell sets up apply. An empty command skips installing.
A sandboxed agent (for example Codex in `auto`) must be allowed to write the package
manager's cache too, or the worktree install fails; for Bun, add `~/.bun/install/cache`
to the provider's writable roots.
The worktree is pinned to the prepared commit. Configured projects require a new
worktree from the default branch; checkout reuse and explicit branch overrides are
rejected. Other projects keep native BB provisioning. The Worktree plugin must be enabled.

Preparation failures prevent spawn and can be retried with `recover` after correction.
A filesystem lock prevents concurrent preparations of the same repository. An interrupted
host process may leave `envoy-prepare.lock` in the Git common directory: inspect the
running processes before removing that empty lock directory. No reset or stash occurs.
Source installs warm shared caches; they do not populate a new worktree's dependencies.
The Envoy is instructed to follow repo worktree setup and run the install command in its
worktree before editing or validating. For a
provisioning-level worktree install, use BB's tracked `.bb-env-setup.sh` hook.

An ordinary BB agent leads by default. An optional specialist lead supplies execution defaults at launch;
changing the lead never resets the composer. Explicit execution selections take precedence. Each startup lists available specialists
and directs the Envoy to delegate appropriate work. Sages and Acolytes have no automatic
Envoy delegation or Send Envoy control: creating one from those chats requires the user's
explicit instruction.

PRs must be opened as drafts and attached with `envoy_attach_pr` or the details dialog.
The Envoy owns the PR end to end, including its handoff. When a **Ready-PR handoff
specialist** is chosen in the settings, attaching a PR also creates a watcher: a BB
script automation owned by the Envoy (created from its thread, named
`Envoy PR watcher: <url>`, visible in Automations). Every 2 minutes it checks the PR with
`gh` on the BB server's machine. Once the PR is marked ready, by the user on GitHub or by
the Envoy on request, the watcher messages the Envoy with `[PR ready] …` and deletes
itself; a closed or merged PR just deletes it. The Envoy then hands the PR off with
`specialist_handoff`, briefing the specialist with the PR, its head, what changed and the
checks it ran. The specialist keeps its own instructions for the follow-up; nothing about
that procedure lives in Sages. The plugin never polls GitHub itself. With no specialist
chosen, attached PRs are only listed.

Watchers never outlive their Envoy: parking, completing, cancelling, or archiving the
Envoy's thread deletes them, and detaching a PR deletes its watcher. Resuming creates them
again.

Park stops implementation threads while preserving the visible chat, workspace and the
Envoy's handoff worker (its child thread running the chosen specialist). **Complete**
closes the Envoy out: it stores the task's final output, then archives its thread, which
takes its child threads (including the handoff worker) and retires its worktree. The chat
stays readable, and Resume unarchives it and rebuilds the worktree when the provider can.
Cancel stops all of the Envoy's child threads. Automated notices cannot resume parked,
completed or cancelled tasks. A user message resumes parked or completed tasks. Cancelled
tasks require Resume.

A sage starts one with its `sage_envoy(task, project?, name?, issueUrl?,
specialist?, requestId?)` tool, which takes a project id or name and creates
through the same path as the CLI. Such an Envoy records the sage in `reportTo` and
gets an `envoy_report` tool. It reports to the sage, as `[Envoy <name>] needs a
decision …`, only when it is blocked or needs a decision while the user isn't in the
conversation; the sage answers with `bb thread tell` on its thread. The plugin enforces
that: its message hook notes whether the user started or joined the current turn
(the watcher's `[PR ready]` message, child-thread completions and the sage's replies
don't count), and the tool refuses during such turns, so a user working with the Envoy
is asked directly. Routine progress is never reported. A failed Envoy thread is
reported as `[Envoy <name>] failed …`, again only when the user wasn't in that turn.
`bb sages envoy --help` prints every command and flag.

```sh
bb sages envoy create --project <id> --task 'Fix login crash' --issue https://tracker.example.com/issue/ABC-123
bb sages envoy list --json
bb sages envoy show <id>
bb sages envoy park <id>
bb sages envoy resume <id>
bb sages envoy pr <id> https://github.com/owner/repo/pull/123
bb sages envoy complete <id>
bb sages envoy cancel <id>
bb sages envoy recover <id>
```

Creation is deduplicated by `--request-id` (the dialog generates one). Recovery adopts
an existing thread through its metadata. Definite BB validation/rejection responses mark a launch failed; relaunch checks
for an existing thread first, and the creation dialog retains the draft so you can
correct selections and resubmit the same task. An ambiguous spawn outcome is never
resent; `recover` searches again rather than risking duplicate agents. Unthreaded
tasks can be cancelled, including uncertain launches. Once a thread exists,
retry agent or provisioning failures through that native BB thread.

## How a sage's chat works

The design is UniiChat's
([optchat.md](https://gist.githubusercontent.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449/raw/3c190e06f34aba0c69f49042c526093269604935/optchat.md)):
the chat itself is the memory.

- Every message is logged word for word: the user's words (`user`), the
  sage's replies (`sage`), its tool calls (`tool`) and their results (`echo`).
  Thoughts are not logged.
- In the background a cheap model compresses the log into a binary tree of
  lines of at most 512 bytes. A message that fits is its own line.
- Each user message is a turn in a fresh, hidden BB thread. The thread's first
  input is the view: lines covering the whole chat, recent ones fine and old
  ones coarse, 64-128 KB in all. Nothing else carries over between turns.
- The sage opens a line with `sage_zoom(id, n)`, down to the message itself,
  and reads a message's date with `sage_date(id)`.
- The sage hands work to a specialist (from the Specialists plugin) with
  `sage_handoff(specialist, task)`. Each turn lists the specialists as they
  are at that moment, after the view. The specialist runs in its own thread in
  the turn's workspace. Its final message comes back to the chat as a `work`
  message, `[name] report ...`: sent into the running turn, or starting a new
  turn when the sage is idle. The handoff uses the Specialists plugin's
  `specialists_handoff` RPC with no parent thread, since a later message may
  have replaced the turn that asked.

## Acolytes

An acolyte is a sage under a lead sage, focused on one part of its work: a
parallel task, a side subject, or a lasting area such as one app inside a
project. It is a sage of its own (`parentId` names its lead, and its topic is
its focus), with its own chat and its own instructions. Its turns also get the
lead's instructions and, before its own view, the lead's view inside `<main>`
tags, so it keeps the lead's whole memory. It reads that view with
`sage_zoom(id, n, "main")` and `sage_date(id, "main")`. Acolytes cannot have
acolytes.

- **Opening.** The lead opens one with `sage_acolyte(name, focus, brief?)`,
  which its instructions allow only when the user asks for an acolyte, by that
  word or plainly. With a brief it starts working at once. The user can open
  one with the branch button on the lead's page, create one with a lead in the
  create form, or move an existing sage under a lead with the edit form or
  `bb sages lead <sage-id> <lead-id|none>`.
- **Messaging.** The lead sends an open acolyte work or a question with
  `sage_message_acolyte(acolyte, message)`. It runs in the acolyte's chat
  (joining its running turn, if any; an acolyte that has never run works where
  the lead's turn does), and the acolyte's last reply comes back to the lead
  like a specialist's report, starting `[acolyte <name>]`.
- **In the lead's chat.** Openings and moves are `acolyte` messages, shown as
  collapsible rows with the acolyte's status. Active acolytes also show as
  chips above the composer, are listed to the lead each turn, and appear under
  the lead in the Sages list and the sidebar.
- **Closing.** Acolytes can last forever. From an acolyte's page, Close
  either sends a summary or just archives it. A summary is written by the
  compaction model from the acolyte's chat and delivered like a specialist's
  report: into the running turn, or as a new turn. A closed acolyte stays
  readable and can be reopened. A specialist's report for a closed acolyte
  goes to the lead.

The page shows the logged chat. BB's `NewThreadComposer` sends the next
message, and BB's `ThreadChat` shows the turn while it runs, so messages sent
during a turn steer it as in any thread.

## Where this differs from the design

- **Storage.** The log, the tree, and the view are append-only tables in the
  plugin's SQLite database (`<dataDir>/plugins/sages/data.db`), not JSONL
  files.
- **System prompt.** BB and the provider own a thread's system prompt. The
  turn half of the prompt is sent as the `sage_zoom` tool's instructions and
  the sage's own instructions follow it; both are static. The view and the
  date go in the turn's first input, hidden from the chat (`agent-only`).
- **Prompt cache.** The plugin cannot place cache marks. The view still only
  grows at its end between batches, so a provider that caches by prefix can
  reuse it.
- **Compactions.** Pick the provider, model and reasoning level with bb's own
  picker under **Models and handoff** in the plugin's settings. Providers whose
  CLI has a print mode are called directly, tool-less, with your own CLI config
  (sign-in, gateways, custom providers), found on your interactive shell's PATH:
  `claude -p` for Claude Code, `codex exec` for Codex, `pi -p` for Pi (see
  `harness.ts`). Any other provider, a missing CLI, or no choice (bb's default)
  runs in a short-lived hidden bb thread that reuses the sage's latest turn
  workspace, gets no plugin tools, and is deleted when it answers. Compactions
  have their own system prompt, so they do not share the turns' cache. A retry
  resends the conversation in one prompt.
- **Not built.** `zoom("Name")` for a specialist's whole chat (the report
  names its thread instead), imported memories (`note`), and images in
  `sage_zoom`.

## Sidebar and Envoy badges

Sidebar Thread Details draws whatever section providers return, so this plugin
owns its sidebar sections. It publishes the discoverable RPC
`sidebar-section.v1.get`: a **Sages** section (root sages with their open
acolytes, reordered with `sidebar-section.v1.reorder`) and an **Envoys**
section claiming each Envoy's thread. Whatever changes a section (a sage
added, renamed, moved or removed, an acolyte opened or closed, an Envoy
updated, a badge source changed) calls the sidebar's `refreshSections` RPC, at
most once per 300 ms, so the sidebar updates without a manual refresh. Envoys
sort by latest activity: each turn that starts or ends in an Envoy's thread or
any thread under it is reported as the row's `activityAt`. Activity is
published at most once every 30 seconds for all Envoys together, so rows do
not jump around while tasks work.

Each Envoy row carries badges on the line under its title. The issue link is
built in and comes first; other plugins add
their own by publishing a discoverable `envoy-decorations.v1.get`:

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

A decorator gets 3 seconds; a failure, late answer or malformed row adds
nothing. When its data changes it calls this plugin's `envoys_badges_changed`
RPC (input `{}`), which refreshes every open sidebar. The Metro Control plugin
is one such decorator. **Envoy badges** in the settings turns each source,
the issue link included, on or off.

Plugins that publish a discoverable `envoy-lifecycle.v1.changed` hear each
time an Envoy is parked, resumed, completed or cancelled:

```ts
// input; the output is ignored
{ envoy: { id; threadId: string | null; projectId; environmentId: string | null; lifecycle } }
```

A completed Envoy is announced before its thread is archived and its worktree
retired, so its environment can still be read. A listener gets 3 seconds and
should do slow work in the background; a failure is only logged. The Metro
Control plugin listens to stop an Envoy's Metro and validation devices once
it is parked, completed or cancelled.

## Mentions

Type `@` in any composer to mention a sage. The picker lists each lead sage
followed by its open acolytes, whose rows read "Acolyte of <lead>". A mention
tells the agent which sage you mean, its topic, and that `bb sages send`
reaches it.

## Settings

The plugin's settings page has a **Models and handoff** section built from what
bb already has set up:

- **Summary model**: bb's provider/model/reasoning picker for compactions and
  acolyte summaries. Unset, they run on bb's default.
- **Ready-PR handoff specialist**: a list of your Specialists. An Envoy hands its
  PR to it once the PR is marked ready; with none, attached PRs get no watcher.
- **Envoy badges**: the badge sources shown on Envoy rows in the sidebar.

The remaining fields:

| Setting | Default | Meaning |
| --- | --- | --- |
| `envoyPreparedProjects` | empty | Project IDs whose base checkout is fast-forwarded before each new Envoy. |
| `envoyInstallCommand` | empty | Shell command run in a prepared checkout, and asked of each new worktree. |
| `envoyPermissionMode` | `full` | Permission level a new Envoy starts in (Full Access, Auto or Accept Edits), unless explicitly chosen in the New Envoy composer. |
| `envoyIssueHosts` | empty | Hostnames allowed for issue links; empty accepts any https link. |

## UI components

`components/ui/` is vendored source you own (the shadcn model): edit the
files freely — they never update out from under you. Add more from the BB
component registry (the full shadcn set, version-matched to your BB install
via the pinned ref in `components.json`):

```
npx shadcn add @bb/select @bb/table
```

Run `npm install` once before `bb plugin build` — the vendored components'
npm deps bundle into your dist. React, and BB-shimmed packages like the
radix portal primitives and `sonner` (`import { toast } from "sonner"`
reaches BB's own toaster), are provided by the BB app at runtime and never
bundled. Every shimmed package is declared in `devDependencies` at the
host's version so those imports typecheck; keep them there (never in
`dependencies`, which would bundle a second copy), and `bb plugin types`
repins declared packages alongside the SDK; unused packages may be removed. Ship `dist/` (npm tarball or committed for
git installs) so people installing your plugin never need npm.

## Manifest

`package.json` is the plugin manifest. Notable fields:

- `bb.server` — backend entry (required).
- `bb.app` — frontend entry. Delete it, `app.tsx`, `components/`,
  `hooks/`, and `lib/` for a headless plugin.
- `bb.skills` — skill roots; omitted here, so BB reads `skills/`. Each
  directory with a `SKILL.md` is one skill, named after the directory.
- `bb.name` and `bb.description` — required human-facing identity.
- `bb.branding` — required; declare `icon` as a BB icon name or a
  plugin-relative compact SVG, or declare `logo.light` (with optional
  `logo.dark`). Logo assets must be relative `.svg`, `.png`, or
  `.webp` files.
- `engines.bb` — supported bb app version range.
- `engines.bbPluginSdk` — the lowest plugin SDK you need (scaffold:
  `>=0.6.37`). BB reads this as a floor, not a ceiling: a later
  SDK in the same major still loads your plugin.
- `dependencies` — every package your source imports that BB does not provide.
  `bb plugin build` inlines them into `dist/`, and git installs resolve this
  list alone, so a build-required package here rather than in
  `devDependencies` is what keeps your plugin installable. `devDependencies`
  is for types and tooling only (BB shims React, the portal primitives, and
  `@get-bb/plugin-sdk` at runtime — never bundle them).

Run `bb plugin build` before publishing git/npm installs. It writes
`dist/server.js` + `server.meta.json` and `app.js` / `app.css` /
`app.meta.json`. Each `*.meta.json` stamps SDK major/version,
`artifactFormatVersion`, `pluginId`, `pluginVersion`, and
`builtWith` so managed installs can verify the artifacts.

## Store listing

Two texts describe the plugin in the store. `bb.description` in package.json
is the one-sentence hook on every browse card and the lead paragraph on the
detail page; keep it under about 140 characters. `PLUGIN_OVERVIEW.md` is the
same claim at length, shown in an Overview section under that paragraph.
Rewrite the scaffold's copy for your plugin, and update it whenever
`bb.description` changes, so the two never disagree.

The submission to the public BB Community marketplace requires the file. Keep
it under 4000 characters (aim for 700 to 1800) and use headings, paragraphs,
emphasis, code, blockquotes, lists, thematic breaks, and absolute https links
only — raw HTML, images, tables, footnotes, and task lists are rejected. Do
not open with a `#` title or repeat `bb.description` verbatim; the page
shows both directly above.

## Install

From this directory (`bb plugin new` already ran the install; a fresh clone
needs it):

```
npm install
bb plugin install .
```

After editing sources, reload:

```
bb plugin reload sages
```

Or let `bb plugin dev` rebuild and reload on every save.

## Configure

```
bb plugin config sages
bb plugin config sages set showDone false
bb plugin reload sages
```

## Types & API reference

The plugin API ships as the npm package `@get-bb/plugin-sdk`, pinned to an
exact version in `devDependencies` (`0.6.37` — the SDK of the BB
that scaffolded this plugin). After `npm install`, the full surface is on disk
at:

```
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts      # backend
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts  # frontend
```

Your editor and `tsc` resolve `@get-bb/plugin-sdk` there through ordinary node
resolution — no path mapping. These are readable declarations: open them for an
exact signature.

The SDK surface grows with every BB release, so the pin has to track the BB you
actually run:

```
bb plugin types          # sync this plugin's SDK surface to the running BB
bb plugin types --check  # CI: fail when it does not match
```

Ask BB to write plugins for you: the `bb-plugin-authoring` skill documents
the whole surface with examples.

Confused by the API, or need something the types don't explain? Clone the BB
repo and read the source: <https://github.com/get-bb/bb>.

## Icon

`icons/sage.svg` is 賢 ("wise"), outlined from Noto Serif JP Medium
(© Google, SIL Open Font License 1.1).
