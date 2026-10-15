# bb-plugin-sages

Sages for BB. A sage is a tuned chat, usually bound to one topic or project,
that you keep coming back to. Each sage has a name, a one-line topic, standing
instructions, and one chat that never ends.

- `optchat.ts` — the memory engine: the message log, the tree of summaries,
  the view, and the compactor. It knows nothing about BB.
- `prompts.ts` — the turn and compaction prompts.
- `server.ts` — the backend: sage records and their acolytes, turns, logging
  of what a turn's thread does, the `sage_zoom`, `sage_date`, `sage_handoff`
  and `sage_acolyte` tools, the compaction model
  call, RPC for the page, and the `bb sages` CLI.
- `app.tsx` — the frontend: a **Sages** page in the left sidebar. Its root
  lists and creates sages; `/plugins/sages/sages/<sage-id>` is that sage's
  chat.
- `skills/sages/SKILL.md` — tells agents how to use `bb sages`.
- `PLUGIN_OVERVIEW.md` — the store listing text.

Run `npm test` for engine, Envoy lifecycle and frontend interaction tests and `npm run typecheck` for types.

## Envoys

An Envoy is a task with one stable, visible BB thread and a dedicated workspace.
Open **Sages → Envoys → New Envoy**, or use the **New Envoy** command palette action.
Describe the task; the name is optional and defaults to the first line of the directive.
A full Linear issue URL is optional and appears in the chat header and Sidebar Thread
Details row. Git projects default to a fresh BB worktree, including local repositories
without a remote. BB's composer controls the machine, base branch, model and permissions.
The details dialog shows project, workspace, branch and execution settings.

An ordinary BB agent leads by default. An optional specialist lead supplies execution defaults at launch;
changing the lead never resets the composer. Explicit execution selections take precedence. Each startup lists available specialists
and directs the Envoy to delegate appropriate work. Sages and Acolytes have no automatic
Envoy delegation or Send Envoy control: creating one from those chats requires the user's
explicit instruction.

PRs must be opened as drafts and attached with `envoy_attach_pr` or the details dialog.
Only Envoys with attached PRs allocate a polling timer or make GitHub requests. Readiness
is checked once per minute on the workspace's machine through authenticated `gh`; the
plugin never discovers PRs by branch and never marks them ready. Once the user marks a
PR ready (or explicitly asks the Envoy to), the plugin starts the mandatory `pr-handoff`
specialist for the existing required-CI and six-hour review-reminder procedure. Its worker
is parented to the Envoy and recovered by a persisted key across reloads or interrupted
responses. Readiness polling stops after handoff, detachment, closure or merge. Missing
specialists and GitHub failures appear in task details with a retry action.
Read-only readiness failures retry automatically with a capped backoff; handoff
errors pause until Retry. Sages requires Specialists' keyed handoff
protocol v1 and verifies worker metadata, so an older plugin cannot silently
launch an unkeyed monitor.

An unconfirmed handoff only searches for its original worker. **Relaunch handoff**
requires explicit confirmation, searches again, and permits a new attempt only
when no worker is found. An earlier delayed request may still create a duplicate,
so use this only after ordinary recovery fails.

Park stops implementation threads while preserving the visible chat, workspace, attached
PR watcher and registered handoff workers. Resume continues the directive; complete stores
the task's final output. Complete keeps attached PR follow-up. Cancel stops readiness watchers and
handoff agents as well as implementation; resume the task before restarting PR
follow-up. Automated notices cannot resume parked, completed or cancelled tasks.
A user message resumes parked or completed tasks. Cancelled tasks require Resume.
After resuming a cancelled task, open its pr-handoff thread to resume a stopped worker.
Already-scheduled review reminders are independent Automations and can be managed
there. These actions do not delete the workspace; cleanup remains a separate native BB action.

```sh
bb sages envoy create --project <id> --task 'Fix saved-swap crash' --issue https://linear.app/wallet/issue/WAL-123
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
- **Compactions.** They run through the `claude` CLI in print mode with no
  tools (`claude -p --model haiku --effort xhigh`), on your Claude Code login.
  They have their own system prompt, so they do not share the turns' cache. A
  retry resends the conversation in one prompt.
- **Not built.** `zoom("Name")` for a specialist's whole chat (the report
  names its thread instead), imported memories (`note`), and images in
  `sage_zoom`.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `compactionModel` | `haiku` | The model that writes summaries. |
| `compactionEffort` | `xhigh` | Its effort level. |
| `claudePath` | `claude` | The `claude` CLI; looked up in your shell when not on the server's PATH. |

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
