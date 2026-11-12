import { randomUUID } from "node:crypto";
import type {
  BbPluginApi,
  NewThreadRequest,
  PluginAgentConfigurationContext,
  PluginCliContext,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  createSchema,
  envoySchema,
  envoyRpcContract,
  envoyHostContract,
  specialistSchema,
  issueLink,
  githubPr,
  taskName,
  type Envoy,
  type Lane,
  type Specialist,
} from "./envoy-contract.ts";
import { nudgeSidebar } from "./sidebar-section.ts";
import { ENVOY_CHAT_PROMPT as LANE_PROMPT } from "./prompts.ts";

const PR_TOOL = "envoy_attach_pr";
export const REPORT_TOOL = "envoy_report";
export const LANE_TOOL = "envoy_open_lane";
export const LANE_MESSAGE_TOOL = "envoy_message_lane";
/** Heads every message an Envoy's chat sends a lane, so it isn't the user's. */
export const LANE_MARKER = "[From the Envoy]";
/** Whether a message is the Envoy chat's: the marker heads one of its lines. */
const fromEnvoy = (text: string) => text.split("\n").some((line) => line.startsWith(LANE_MARKER));
const WATCHER_PREFIX = "Envoy PR watcher: ";
/**
 * Plugins that publish this discoverable method hear each lifecycle change,
 * with input `{ envoy: { id, threadId, projectId, environmentId, lifecycle } }`.
 * A completed Envoy is announced before its thread is archived, so its
 * environment can still be read. Listeners should answer at once and do slow
 * work in the background.
 */
export const LIFECYCLE_METHOD = "envoy-lifecycle.v1.changed";
const LISTENER_TIMEOUT_MS = 3_000;
/** Starts the notice a watcher sends, so it reaches a completed Envoy. */
const READY_MARKER = "[PR ready]";
/**
 * The watcher automation's script. BB runs it with a bare PATH, so it takes
 * the user's shell PATH for gh, and BB's own variables for bb and its id.
 */
export const WATCHER_SCRIPT = `PATH="$("\${SHELL:-/bin/sh}" -ilc 'printf "\\n%s" "$PATH"' 2>/dev/null | tail -n 1):$PATH"
bb="\${BB_CLI:-bb}"
remove() { "$bb" automation delete "$BB_AUTOMATION_ID" --project "$BB_PROJECT_ID" --yes >/dev/null; }
state=$(gh pr view "$PR_URL" --json state,isDraft --jq 'if .state != "OPEN" then "closed" elif .isDraft then "draft" else "ready" end') || exit 1
case "$state" in
  draft) exit 0 ;;
  closed) remove ;;
  ready) "$bb" thread tell "$ENVOY_THREAD" "$NOTICE" && remove ;;
esac
`;
export const ENVOY_USAGE = [
  "Usage:",
  "  bb sages envoy list [--json]",
  "  bb sages envoy show <id> [--json]",
  "  bb sages envoy create --task <text> [--project <project-id>] [--name <name>] [--issue <url>] [--specialist <name>] [--request-id <key>] [--json]",
  "  bb sages envoy park|resume|complete|cancel <id> [--json]",
  "  bb sages envoy pr <id> <github-pr-url> [--json]",
  "  bb sages envoy tell <id> <message> [--json]",
  "  bb sages envoy recover <id> [--json]",
  "",
  "create starts the Envoy's chat, which opens lanes: visible threads, each in a",
  "fresh worktree from a project's default branch, one per repo or PR. --project",
  "is the default project for its lanes (the current project when left out; get",
  "ids from bb project list). --issue is a full https issue link. --specialist",
  "names a specialist to lead its lanes. Reuse --request-id to make a retried",
  "create a no-op. tell brings a message into the Envoy's chat as a new turn.",
].join("\n");

/** What an Envoy is created from outside its dialog: the CLI and sage turns. */
export type EnvoyTask = {
  task: string;
  projectId: string;
  name?: string;
  issueUrl?: string;
  specialist?: string;
  requestId?: string;
  /** The sage that started it, to report each turn's end to. */
  reportTo?: { sageId: string; name: string };
};
/**
 * The Envoy's chat, which server.ts runs on the sages' chat machinery: one
 * endless chat whose turns are short-lived hidden threads.
 */
export type EnvoyChat = {
  /** Creates the chat and starts its first turn on the directive; its id. */
  open(envoy: Envoy, launch: { request: NewThreadRequest; lead: Specialist | null }): Promise<string>;
  /** Brings a message in: as a new turn (or into the running one) when start, else only logged. */
  deliver(chatId: string, notice: string, report: string, start: boolean): void;
  /** Stops the chat's running turn, if any. */
  stop(chatId: string): Promise<void>;
  /** The chat's latest reply. */
  lastReply(chatId: string): string | null;
  /** The Envoy whose chat a turn's thread belongs to. */
  envoyOfTurn(threadId: string): Promise<string | null>;
  /** Whether the user started or joined that turn. */
  userTurn(threadId: string): boolean;
  /** Renames the chat with its Envoy. */
  rename(chatId: string, name: string): void;
};
/** What an Envoy tells the sage that started it. */
export type EnvoyReport = (
  envoy: Envoy,
  outcome: "needs a decision" | "failed",
  text: string,
) => void;
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
// Only structured validation/rejection responses establish that no spawn committed.
// A timeout, 5xx or an ordinary Error remains ambiguous.
export function definiteRejection(error: unknown): boolean {
  if (error instanceof z.ZodError) return true;
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: unknown; statusCode?: unknown };
  return [400, 401, 403, 404, 409, 422].includes(
    Number(value.status ?? value.statusCode),
  );
}
/** The user's Envoy settings; every external convention is opt-in. */
export type EnvoyConfig = {
  /** Projects whose base checkout is fast-forwarded before each new Envoy. */
  preparedProjects: string[];
  /** Run in a prepared base checkout, and asked of each new worktree. */
  installCommand: string;
  /** The specialist started when an attached PR is ready; "" for none. */
  handoffSpecialist: string;
  /** Hostnames allowed for issue links; empty allows any. */
  issueHosts: string[];
  /** The permission mode an Envoy starts in unless explicitly chosen. */
  permissionMode: "accept-edits" | "auto" | "full";
  /** Standing instructions for every Envoy; "" for none. */
  instructions: string;
  /** A sage's own Envoy instructions, which replace the global ones; "" for none. */
  sageInstructions: (sageId: string) => string;
  /** The model an Envoy runs on unless chosen or set by its lead; null for bb's default. */
  model: {
    providerId: string;
    model: string;
    reasoningLevel: string;
    serviceTier?: string;
  } | null;
};
export const defaultEnvoyConfig: EnvoyConfig = {
  preparedProjects: [],
  installCommand: "",
  handoffSpecialist: "",
  issueHosts: [],
  permissionMode: "full",
  instructions: "",
  sageInstructions: () => "",
  model: null,
};

function policy(handoff: string, role = "You are an Envoy: complete the user's bounded task in this workspace.") {
  return `${role} Delegate work to available specialists when their role fits; specialist_handoff creates a child in this workspace, so brief it with the goal, ownership, constraints and verification. Keep the user informed and report results and verification in this thread. Do not claim task completion from an idle agent or CI alone.
All pull requests you open must be DRAFT (gh pr create --draft). Immediately after opening a PR, call envoy_attach_pr with its exact GitHub URL; also attach an existing PR only when it belongs to this task. Never mark a PR ready unless the user explicitly asks. ${
    handoff
      ? `Attaching a PR also sets up a watcher automation you own, which checks it every few minutes. Once the PR is marked ready (by you on request, or by the user on GitHub), the watcher sends you a message starting "[PR ready]" and removes itself. Then hand the PR off with specialist_handoff to the ${handoff} specialist for review and CI follow-up: give it the PR URL and head commit, what the change does and why, the checks you ran and their results, and anything reviewers should know. It has its own instructions for the follow-up, so don't repeat or prescribe them. Hand off once per PR, only after that message.`
      : "No ready-PR handoff specialist is configured, so attached PRs are not watched; report when a PR is ready."
  } Envoy delegation is authorized within this task.`;
}

/** The standing instructions for an Envoy: its sage's own, else the global ones. */
function standingFor(config: EnvoyConfig, envoy: Envoy) {
  const own = envoy.reportTo ? config.sageInstructions(envoy.reportTo.sageId) : "";
  return { own, standing: own || config.instructions };
}
function laneRole(envoy: Envoy, lane: Lane) {
  return `You are the lane "${lane.name}" of the Envoy "${envoy.name}": one part of its task, in your own fresh worktree. The Envoy's chat coordinates its lanes: it briefed you, and its messages to you start with "${LANE_MARKER}". When a turn it started ends, your last message goes back to it, so end such a turn with where your part stands: done and how you verified it, blocked and why, or the decision you need. When the user talks to you directly, work with them. Stay within your part; say so when work belongs in another lane.`;
}
/** The policy plus the standing instructions that apply to this Envoy, or one of its lanes. */
function instructionsFor(config: EnvoyConfig, envoy: Envoy, lane?: Lane) {
  const { own, standing } = standingFor(config, envoy);
  return [
    lane ? policy(config.handoffSpecialist, laneRole(envoy, lane)) : policy(config.handoffSpecialist),
    ...(standing
      ? [
          `Standing instructions for Envoys${own ? ` from the sage "${envoy.reportTo!.name}"` : ""}; the task's directive overrides them where they conflict:\n${standing}`,
        ]
      : []),
  ].join("\n\n");
}

/** What an Envoy's chat is told each turn about itself: who it is and the rules it hands its lanes. */
function chatInstructionsFor(config: EnvoyConfig, envoy: Envoy) {
  const { own, standing } = standingFor(config, envoy);
  return [
    `# You are the Envoy "${envoy.name}"\nYou own this task end to end from this chat, and coordinate the lanes that do its work.${envoy.reportTo ? ` The sage "${envoy.reportTo.name}" started you. When you are blocked or need a decision and the user did not start this turn, report it with envoy_report: what you need and why, with the options you see; the sage answers in this chat. Never report routine progress.` : ""}`,
    ...(standing
      ? [
          `# Standing instructions for Envoys${own ? ` from the sage "${envoy.reportTo!.name}"` : ""}\nThe task's directive overrides them where they conflict. They bind your lanes' work: pass on the ones that matter to each lane's part.\n${standing}`,
        ]
      : []),
  ].join("\n\n");
}

/**
 * The workspaces an Envoy works in, as lifecycle listeners and badge
 * decorators see them: each lane of a chat Envoy, or an older Envoy's thread.
 */
export function workspaces(envoy: Envoy) {
  const { lifecycle } = envoy;
  return envoy.chatId
    ? envoy.lanes.map((lane) => ({
        id: `${envoy.id}:${lane.id}`,
        threadId: lane.threadId,
        projectId: lane.projectId,
        environmentId: lane.environmentId,
        lifecycle,
      }))
    : [
        {
          id: envoy.id,
          threadId: envoy.threadId,
          projectId: envoy.projectId,
          environmentId: envoy.environmentId,
          lifecycle,
        },
      ];
}

export async function registerEnvoys(
  bb: BbPluginApi,
  config: () => Promise<EnvoyConfig> = async () => defaultEnvoyConfig,
  report: EnvoyReport = () => {},
  /** Without a chat, Envoys are created the older way: one thread each. */
  chat: EnvoyChat | null = null,
) {
  // configure() is synchronous, so it uses the settings as last read.
  let lastConfig = defaultEnvoyConfig;
  const read = async () => (lastConfig = await config());
  await read();
  const db = bb.storage.database();
  db.exec(
    "CREATE TABLE IF NOT EXISTS envoys (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, launch TEXT NOT NULL)",
  );
  const records = new Map<string, Envoy>();
  for (const row of db.prepare("SELECT data FROM envoys").all() as {
    data: string;
  }[]) {
    const envoy = envoySchema.parse(JSON.parse(row.data));
    db.prepare("UPDATE envoys SET data=? WHERE id=?").run(
      JSON.stringify(envoy),
      envoy.id,
    );
    records.set(envoy.id, envoy);
  }
  const host = bb.hosts.experimental_client({ contract: envoyHostContract });
  const controller = new AbortController();
  const queues = new Map<string, Promise<unknown>>();
  /** Envoy threads whose current turn the user started or joined. */
  const userTurns = new Set<string>();
  function serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const next = (queues.get(id) ?? Promise.resolve()).then(work, work);
    queues.set(id, next);
    void next
      .finally(() => {
        if (queues.get(id) === next) queues.delete(id);
      })
      .catch(() => {});
    return next;
  }
  function get(id: string) {
    const envoy = records.get(id);
    if (!envoy) throw new Error(`No Envoy with id ${id}`);
    return envoy;
  }
  function update(id: string, patch: Partial<Envoy>) {
    const envoy = envoySchema.parse({
      ...get(id),
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    db.prepare("UPDATE envoys SET data = ? WHERE id = ?").run(
      JSON.stringify(envoy),
      id,
    );
    records.set(id, envoy);
    bb.realtime.publish("envoys-changed", {});
    nudgeSidebar(bb);
    return envoy;
  }

  async function specialists(): Promise<Specialist[] | null> {
    try {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: "specialists",
        method: "specialists_list",
        input: null,
        outputSchema: z.object({ specialists: z.array(specialistSchema) }),
      });
      return result.specialists;
    } catch {
      return null;
    }
  }
  async function findSpawn(
    projectId: string,
    pluginId: string,
    field: string,
    value: string,
  ) {
    for (const archived of [false, true]) {
      for (let offset = 0; ; offset += 100) {
        const threads = await bb.sdk.threads.list({
          projectId,
          originPluginId: pluginId,
          includeHidden: true,
          archived,
          limit: 100,
          offset,
        });
        if (!threads.length) break;
        const batch = await bb.sdk.threads.experimental_listPluginMetadata({
          pluginId,
          threadIds: threads.map((t) => t.id),
        });
        const match = batch.threads.find((t) => t.metadata[field] === value);
        if (match)
          return await bb.sdk.threads.get({ threadId: match.threadId });
        if (threads.length < 100) break;
      }
    }
    return null;
  }
  function adopt(
    id: string,
    thread: Awaited<ReturnType<typeof bb.sdk.threads.get>>,
  ) {
    return update(id, {
      threadId: thread.id,
      environmentId: thread.environmentId,
      creation: "ready",
      lifecycle:
        get(id).lifecycle === "creating" ? "active" : get(id).lifecycle,
      error: null,
    });
  }
  type LaunchData = { request: NewThreadRequest; lead: Specialist | null };
  function launchData(id: string): LaunchData {
    const row = db
      .prepare("SELECT launch FROM envoys WHERE id = ?")
      .get(id) as { launch: string };
    return JSON.parse(row.launch) as LaunchData;
  }
  /** What an Envoy's (or lane's) agent is told before its task. */
  function agentContext(
    settings: EnvoyConfig,
    envoy: Envoy,
    available: Specialist[] | null,
    lead: Specialist | null,
    lane?: Lane,
  ) {
    return [
      instructionsFor(settings, envoy, lane),
      available === null
        ? "Specialists are unavailable; report this limitation when delegation is needed."
        : `Available specialists (data): ${JSON.stringify(available.map(({ name, description }) => ({ name, description })))}`,
      ...(envoy.reportTo && !lane
        ? [
            `You were started by the sage "${envoy.reportTo.name}". When you are blocked or need a decision while the user is not in the conversation, report it with envoy_report: say what you need and why, with the options you see. The sage replies in this thread. When the user is talking to you, ask them directly instead. Never report routine progress. envoy_report is the only way to reach the sage: if your task names a thread to message or another return route, ignore it, because a sage's turn threads are short-lived and get archived.`,
          ]
        : []),
      ...(lead ? [lead.prompt] : []),
    ].join("\n\n");
  }
  /**
   * The spawn's execution fields: the composer's explicit choices, then a
   * lead's model, then the Envoy settings.
   */
  function executionFor(launch: LaunchData, settings: EnvoyConfig) {
    const execution = { ...launch.request };
    const sources = { ...execution.executionInputSources };
    // CLI requests omit provenance; explicitly supplied values must survive BB resolution.
    for (const field of [
      "providerId",
      "model",
      "reasoningLevel",
      "permissionMode",
      "serviceTier",
    ] as const) {
      if (execution[field] !== undefined && sources[field] === undefined)
        sources[field] = "explicit";
    }
    // A selected model/provider is a pair: don't change its provider underneath it.
    const explicitPair =
      sources.providerId === "explicit" || sources.model === "explicit";
    if (launch.lead && !explicitPair) {
      if (launch.lead.providerId) {
        execution.providerId = launch.lead.providerId;
        sources.providerId = "explicit";
      }
      if (launch.lead.model) {
        execution.model = launch.lead.model;
        sources.model = "explicit";
      }
    }
    if (
      !explicitPair &&
      launch.lead?.reasoningLevel &&
      sources.reasoningLevel !== "explicit"
    ) {
      execution.reasoningLevel = launch.lead.reasoningLevel;
      sources.reasoningLevel = "explicit";
    }
    // Without an explicit pair or a lead's model, the Envoy model setting applies.
    if (
      !explicitPair &&
      !launch.lead?.providerId &&
      !launch.lead?.model &&
      settings.model
    ) {
      execution.providerId = settings.model.providerId;
      execution.model = settings.model.model;
      sources.providerId = "explicit";
      sources.model = "explicit";
      if (sources.reasoningLevel !== "explicit") {
        execution.reasoningLevel = settings.model.reasoningLevel as typeof execution.reasoningLevel;
        sources.reasoningLevel = "explicit";
      }
      if (settings.model.serviceTier && sources.serviceTier !== "explicit") {
        execution.serviceTier = settings.model.serviceTier;
        sources.serviceTier = "explicit";
      }
    }
    // An explicit choice in the composer wins; otherwise the setting applies.
    if (sources.permissionMode !== "explicit") {
      execution.permissionMode = settings.permissionMode;
      sources.permissionMode = "explicit";
    }
    execution.executionInputSources = sources;
    return execution;
  }
  /**
   * For a prepared project, fast-forwards its base checkout and pins the new
   * worktree to that commit; returns what the agent is told about it. Throws
   * before any spawn, so a failure is safe to retry.
   */
  async function prepare(
    execution: NewThreadRequest,
    projectId: string,
    settings: EnvoyConfig,
    status: (text: string) => void,
  ): Promise<string> {
    if (!settings.preparedProjects.includes(projectId)) return "";
    const selection = execution.environment;
    let hostId: string | undefined;
    if (selection.type === "host" && selection.workspace.type === "managed-worktree" && selection.workspace.baseBranch.kind === "default") {
      hostId = selection.hostId;
    } else if (selection.type === "provider" && selection.environmentProviderId === "git-worktree") {
      z.object({ branch: z.object({ kind: z.literal("default") }).optional() }).strict().parse(selection.inputs ?? {});
      if (selection.machine?.type === "new") throw new Error("Prepared sources require an existing machine");
      hostId = selection.machine?.hostId;
    } else {
      throw new Error("Prepared projects require a new worktree from the default branch");
    }
    const project = await bb.sdk.projects.get({ projectId });
    const candidates = project.sources.filter((source) => !hostId || source.hostId === hostId);
    const source = candidates.find((source) => source.isDefault) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!source) throw new Error("Select a machine with an unambiguous project source");
    status(`Preparing source: ${source.path}`);
    const prepared = await host.call("prepareSource", { path: source.path, installCommand: settings.installCommand }, {
      hostId: source.hostId, signal: controller.signal, timeoutMs: 20 * 60_000,
    });
    execution.environment = {
      type: "host", hostId: source.hostId,
      workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: prepared.commit } },
    };
    return `\n\nSource prepared at ${prepared.commit} (${prepared.branch}).${
      settings.installCommand.trim()
        ? ` Dependencies were installed in the base checkout with \`${settings.installCommand}\`. The new worktree has its own dependency state: before editing or validating, follow the repository's worktree setup instructions and run \`${settings.installCommand}\` in this workspace. Stop and report installation failures; do not link the base checkout's dependencies.`
        : " Before editing or validating, follow the repository's worktree setup instructions."
    }`;
  }
  async function launch(id: string, recoveryOnly = false) {
    const envoy = get(id);
    if (envoy.lifecycle === "cancelled") return envoy;
    if (envoy.kind === "chat") return startChat(id);
    if (envoy.threadId) return envoy;
    if (envoy.creation !== "reserved") {
      const existing = await findSpawn(envoy.projectId, "sages", "envoyId", id);
      if (existing) return adopt(id, existing);
      if (
        (recoveryOnly && envoy.creation !== "failed") ||
        envoy.creation === "launching" ||
        envoy.creation === "uncertain"
      )
        return update(id, {
          creation: "uncertain",
          error:
            "Creation outcome is unconfirmed. Retry recovery to find the existing thread; no duplicate will be started.",
        });
    }
    const launch = launchData(id);
    const available = await specialists();
    const settings = await read();
    let context = agentContext(settings, envoy, available, launch.lead);
    const execution = executionFor(launch, settings);
    // Preparation failures cannot have spawned a thread and are safe to retry.
    // Keep this outside the ambiguous-spawn handling below.
    try {
      const env = execution.environment as { type: string; hostId?: string };
      if (env.type === "host" && !env.hostId && (env as any).workspace?.type === "managed-worktree")
        env.hostId = await hostFor(execution, envoy.projectId);
      context += await prepare(execution, envoy.projectId, settings, (text) =>
        update(id, { error: text }),
      );
    } catch (error) {
      return update(id, { creation: "failed", error: `Source preparation failed: ${errorText(error)}` });
    }
    update(id, { creation: "launching", error: null });
    try {
      const thread = await bb.sdk.threads.spawn({
        ...execution,
        title: envoy.name,
        visibility: "visible",
        pluginMetadata: { envoyId: id },
        input: [
          {
            type: "text",
            text: context,
            visibility: "agent-only",
            mentions: [],
          },
          ...(envoy.issue
            ? [
                {
                  type: "text" as const,
                  text: `Linked issue: ${envoy.issue.key}\n${envoy.issue.url}`,
                  mentions: [],
                },
              ]
            : []),
          ...launch.request.input,
        ],
      });
      return adopt(id, thread);
    } catch (error) {
      // Spawn can commit before its response is interrupted. Recovery never
      // resends an uncertain launch, even if the new thread is not visible yet.
      return update(id, {
        creation: definiteRejection(error) ? "failed" : "uncertain",
        error: definiteRejection(error)
          ? `Launch rejected: ${errorText(error)}. Adjust the selections or relaunch when available.`
          : `Needs attention: ${errorText(error)}. Recover the existing thread or cancel this task; an ambiguous launch is never resent.`,
      });
    }
  }
  /** Starts a chat Envoy: its chat, whose first turn works on the directive. */
  async function startChat(id: string) {
    const envoy = get(id);
    if (envoy.chatId) return envoy;
    if (!chat) return update(id, { creation: "failed", error: "Envoy chats are unavailable" });
    try {
      const chatId = await chat.open(envoy, launchData(id));
      return update(id, {
        chatId,
        creation: "ready",
        lifecycle: envoy.lifecycle === "creating" ? "active" : envoy.lifecycle,
        error: null,
      });
    } catch (error) {
      return update(id, {
        creation: "failed",
        error: `Could not start the Envoy's chat: ${errorText(error)}`,
      });
    }
  }
  /**
   * Opens a lane: a visible thread in a fresh worktree from the project's
   * default branch, working on one part of a chat Envoy's task.
   */
  async function openLane(
    id: string,
    { projectId, name, task }: { projectId: string; name: string; task: string },
  ) {
    return serial(id, async () => {
      const envoy = get(id);
      if (!envoy.chatId) throw new Error("Only an Envoy with a chat opens lanes");
      if (envoy.lifecycle !== "active")
        throw new Error(`This Envoy is ${envoy.lifecycle}; resume it to open lanes`);
      const key = name.trim().toLowerCase();
      if (envoy.lanes.some((lane) => lane.name.toLowerCase() === key && lane.creation !== "failed"))
        throw new Error(`A lane named "${name}" exists; message it, or give the new one another name`);
      const lane: Lane = {
        id: randomUUID().slice(0, 8),
        name: name.trim(),
        projectId,
        threadId: null,
        environmentId: null,
        creation: "launching",
        error: null,
        prs: [],
        createdAt: new Date().toISOString(),
      };
      const setLane = (patch: Partial<Lane>) =>
        update(id, {
          lanes: get(id).lanes.map((each) =>
            each.id === lane.id ? { ...each, ...patch } : each,
          ),
        });
      update(id, { lanes: [...get(id).lanes.filter((each) => !(each.name.toLowerCase() === key && each.creation === "failed")), lane] });
      const launch = launchData(id);
      const [available, settings] = await Promise.all([specialists(), read()]);
      let context = agentContext(settings, envoy, available, launch.lead, lane);
      let execution: NewThreadRequest;
      try {
        const hostId = await hostFor(launch.request, projectId);
        execution = executionFor(
          {
            ...launch,
            request: {
              ...launch.request,
              projectId,
              environment: {
                type: "host",
                hostId,
                workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
              },
            },
          },
          settings,
        );
        context += await prepare(execution, projectId, settings, (text) => setLane({ error: text }));
      } catch (error) {
        setLane({ creation: "failed", error: `Source preparation failed: ${errorText(error)}` });
        throw new Error(`Source preparation failed: ${errorText(error)}`);
      }
      try {
        const thread = await bb.sdk.threads.spawn({
          ...execution,
          title: lane.name,
          visibility: "visible",
          pluginMetadata: { envoyId: id, laneId: lane.id },
          input: [
            { type: "text", text: context, visibility: "agent-only", mentions: [] },
            ...(envoy.issue
              ? [{ type: "text" as const, text: `Linked issue: ${envoy.issue.key}\n${envoy.issue.url}`, mentions: [] }]
              : []),
            { type: "text", text: `${LANE_MARKER}\n${task}`, mentions: [] },
          ],
        });
        return { envoy: setLane({ threadId: thread.id, environmentId: thread.environmentId, creation: "ready", error: null }), lane: { ...lane, threadId: thread.id } };
      } catch (error) {
        const definite = definiteRejection(error);
        setLane({
          creation: definite ? "failed" : "uncertain",
          error: definite
            ? `Launch rejected: ${errorText(error)}`
            : `Launch unconfirmed: ${errorText(error)}. Its thread is adopted if it appears; it is never resent.`,
        });
        throw new Error(definite ? `Launch rejected: ${errorText(error)}` : `Launch unconfirmed: ${errorText(error)}; do not open it again yet`);
      }
    });
  }
  /**
   * The machine a new worktree goes on: the request's host when it names one,
   * else the project's default source. bb rejects a host workspace without
   * one, and neither an Envoy chat nor a sage's task carries one.
   */
  async function hostFor(request: NewThreadRequest, projectId: string): Promise<string> {
    const env = request.environment as { type?: string; hostId?: string; machine?: { hostId?: string } } | undefined;
    const preferred = env?.type === "host" ? env.hostId : env?.machine?.hostId;
    const { sources } = await bb.sdk.projects.get({ projectId });
    const onPreferred = preferred ? sources.filter((source) => source.hostId === preferred) : [];
    const pool = onPreferred.length ? onPreferred : sources;
    const source = pool.find((source) => source.isDefault) ?? (pool.length === 1 ? pool[0] : undefined);
    if (!source) throw new Error("The lane's project has no default source; set one in bb");
    return source.hostId;
  }
  function setLane(id: string, laneId: string, patch: Partial<Lane>) {
    return update(id, {
      lanes: get(id).lanes.map((each) =>
        each.id === laneId ? { ...each, ...patch } : each,
      ),
    });
  }
  /** The chat Envoy and lane a thread is, by lane thread id. */
  function laneOf(threadId: string): { envoy: Envoy; lane: Lane } | null {
    for (const envoy of records.values())
      for (const lane of envoy.lanes)
        if (lane.threadId === threadId) return { envoy, lane };
    return null;
  }
  /** The threads that own an Envoy's work and PRs: its lanes, or its one thread. */
  function owners(envoy: Envoy) {
    return envoy.chatId
      ? envoy.lanes.flatMap((lane) =>
          lane.threadId ? [{ threadId: lane.threadId, projectId: lane.projectId, prs: lane.prs }] : [],
        )
      : envoy.threadId
        ? [{ threadId: envoy.threadId, projectId: envoy.projectId, prs: envoy.prs }]
        : [];
  }
  async function create(input: z.infer<typeof createSchema>) {
    return serial(`create:${input.requestId}`, async () => {
      const existing = [...records.values()].find(
        (e) => e.requestId === input.requestId,
      );
      if (existing && existing.creation !== "failed") return existing;
      if (existing) {
        const recovered = await findSpawn(
          existing.projectId,
          "sages",
          "envoyId",
          existing.id,
        );
        if (recovered) return adopt(existing.id, recovered);
      }
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      if (!projects.some((p) => p.id === input.request.projectId))
        throw new Error("Select a project for this Envoy");
      const directive = input.request.input
        .filter((p) => p.type === "text" && p.visibility !== "agent-only")
        .map((p) => String(p.text ?? ""))
        .join("\n")
        .trim();
      if (!directive || directive.length > 100_000)
        throw new Error("Provide a task directive of 1–100,000 characters");
      if (JSON.stringify(input.request).length > 200_000)
        throw new Error("The task request is too large");
      const issue = issueLink(input.issueUrl, (await read()).issueHosts);
      const available = input.specialist ? await specialists() : null;
      const lead = input.specialist
        ? available?.find((s) => s.name === input.specialist)
        : null;
      if (input.specialist && !lead)
        throw new Error(`Specialist ${input.specialist} is unavailable`);
      const now = new Date().toISOString();
      const envoy = envoySchema.parse({
        id: existing?.id ?? randomUUID(),
        requestId: input.requestId,
        name: input.name || taskName(directive),
        nameSource: input.name ? "explicit" : "generated",
        directive,
        projectId: input.request.projectId,
        threadId: null,
        environmentId: null,
        lifecycle: "creating",
        creation: "reserved",
        error: null,
        issue,
        specialist: input.specialist,
        reportTo: input.reportTo,
        kind: chat ? "chat" : "thread",
        prs: [],
        result: null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      db.prepare(
        "INSERT INTO envoys (id, request_id, data, launch) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, launch=excluded.launch",
      ).run(
        envoy.id,
        envoy.requestId,
        JSON.stringify(envoy),
        JSON.stringify({ request: input.request, lead: lead ?? null }),
      );
      records.set(envoy.id, envoy);
      bb.realtime.publish("envoys-changed", {});
      // Provisioning/startup is owned by BB; creation does not wait for a turn.
      return serial(envoy.id, () => launch(envoy.id));
    });
  }
  /** Creates an Envoy in a fresh worktree from the default branch. */
  function createTask(task: EnvoyTask) {
    return create(
      createSchema.parse({
        requestId: task.requestId ?? randomUUID(),
        name: task.name,
        issueUrl: task.issueUrl,
        specialist: task.specialist,
        reportTo: task.reportTo ?? null,
        request: {
          projectId: task.projectId,
          input: [{ type: "text", text: task.task, mentions: [] }],
          environment: {
            type: "host",
            workspace: {
              type: "managed-worktree",
              baseBranch: { kind: "default" },
            },
          },
        },
      }),
    );
  }
  /** Stops an Envoy's work: its chat's turn, and each lane or its one thread with their children. */
  async function stopImplementation(envoy: Envoy, preserveHandoffs = true) {
    if (envoy.chatId && chat)
      await chat.stop(envoy.chatId).catch((error) =>
        bb.log.warn(`could not stop the Envoy's chat: ${errorText(error)}`),
      );
    for (const owner of owners(envoy))
      await stopTree(owner.projectId, owner.threadId, preserveHandoffs);
  }
  async function stopTree(projectId: string, rootId: string, preserveHandoffs: boolean) {
    const all = [] as Awaited<ReturnType<typeof bb.sdk.threads.list>>;
    for (let offset = 0; ; offset += 100) {
      const page = await bb.sdk.threads.list({
        projectId,
        includeHidden: true,
        archived: false,
        limit: 100,
        offset,
      });
      all.push(...page);
      if (page.length < 100) break;
    }
    // The ready-PR handoff worker, started by the Envoy, keeps following
    // up while the Envoy is parked or completed.
    const exempt = new Set<string>();
    const { handoffSpecialist } = await read();
    const workers = all.filter((t) => t.originPluginId === "specialists");
    if (preserveHandoffs && handoffSpecialist && workers.length > 0) {
      for (let at = 0; at < workers.length; at += 100) {
        const batch = await bb.sdk.threads.experimental_listPluginMetadata({
          pluginId: "specialists",
          threadIds: workers.slice(at, at + 100).map((t) => t.id),
        });
        for (const each of batch.threads)
          if (each.metadata.specialist === handoffSpecialist)
            exempt.add(each.threadId);
      }
    }
    const selected = new Set([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const thread of all) {
        if (
          thread.parentThreadId &&
          selected.has(thread.parentThreadId) &&
          !exempt.has(thread.id) &&
          !selected.has(thread.id)
        ) {
          selected.add(thread.id);
          changed = true;
        }
      }
    }
    for (const threadId of [...selected].reverse()) {
      const thread =
        all.find((t) => t.id === threadId) ??
        (await bb.sdk.threads.get({ threadId }));
      if (["active", "starting", "stopping"].includes(thread.status))
        await bb.sdk.threads.stop({ threadId });
    }
  }
  /** Tells lifecycle listeners about an Envoy; one that fails is only logged. */
  async function announce(envoy: Envoy) {
    const listeners = await bb.sdk.plugins
      .experimental_discoverRpc({ method: LIFECYCLE_METHOD })
      .catch(() => []);
    // A chat Envoy is announced once per lane: each lane is a workspace.
    const notices = workspaces(envoy);
    await Promise.all(
      [...new Set(listeners.map((each) => each.pluginId))].flatMap((pluginId) =>
        notices.map((notice) => bb.sdk.plugins
          .callRpc({
            pluginId,
            method: LIFECYCLE_METHOD,
            input: { envoy: notice },
            outputSchema: z.unknown(),
            signal: AbortSignal.timeout(LISTENER_TIMEOUT_MS),
          })
          .catch((error) =>
            bb.log.warn(
              `Envoy lifecycle listener ${pluginId} failed: ${errorText(error)}`,
            ),
          )),
      ),
    );
  }
  async function lifecycle(
    id: string,
    state: "active" | "parked" | "completed" | "cancelled",
    /** For a chat Envoy resumed by the user's own message: don't start a turn for it. */
    quiet = false,
  ) {
    return serial(id, async () => {
      let envoy = get(id);
      if (envoy.lifecycle === state && state !== "cancelled") return envoy;
      if (state === "cancelled") {
        if (!envoy.threadId && !envoy.chatId) {
          const existing = await findSpawn(
            envoy.projectId,
            "sages",
            "envoyId",
            id,
          );
          if (existing) envoy = adopt(id, existing);
        }
        // Commit cancellation first so delayed handoff completions cannot restart implementation.
        envoy = update(id, { lifecycle: "cancelled" });
        await stopImplementation(envoy, false);
        await unwatch(envoy).catch((error) =>
          bb.log.warn(`could not remove PR watchers: ${errorText(error)}`),
        );
        await announce(envoy);
        return envoy;
      }
      if (envoy.creation !== "ready" || (!envoy.threadId && !envoy.chatId))
        throw new Error(
          "Recover the task thread before changing its lifecycle",
        );
      if (state === "active") {
        // A completed Envoy was archived: bring back its threads and, when
        // the provider can, the worktrees they held.
        for (const owner of owners(envoy)) {
          const thread = await bb.sdk.threads.get({ threadId: owner.threadId });
          if (thread.archivedAt === null) continue;
          await bb.sdk.threads.unarchive({ threadId: owner.threadId });
          const restored = await bb.sdk.threads.get({ threadId: owner.threadId });
          if (restored.canRestoreEnvironment)
            await bb.sdk.threads
              .restoreEnvironment({ threadId: owner.threadId })
              .catch((error) =>
                bb.log.warn(`could not restore the workspace: ${errorText(error)}`),
              );
        }
        update(id, { lifecycle: "active" });
        if (envoy.chatId && chat) {
          if (!quiet)
            chat.deliver(
              envoy.chatId,
              "Envoy resumed",
              "[Envoy resumed] Resume this Envoy's task: check where each lane stands and continue toward the directive.",
              true,
            );
        } else {
          try {
            await bb.sdk.threads.send({
              threadId: envoy.threadId!,
              mode: "auto",
              input: [
                {
                  type: "text",
                  text: "Resume this Envoy's task. Inspect the current work and continue toward the original directive.",
                  mentions: [],
                },
              ],
            });
          } catch (error) {
            update(id, { lifecycle: envoy.lifecycle });
            throw error;
          }
        }
        if (envoy.lifecycle === "parked" || envoy.lifecycle === "completed")
          await rewatch(get(id));
        await announce(get(id));
      } else if (state === "parked") {
        update(id, { lifecycle: state });
        await stopImplementation(envoy);
        await unwatch(envoy).catch((error) =>
          bb.log.warn(`could not remove PR watchers: ${errorText(error)}`),
        );
        await announce(get(id));
      } else {
        // Completing closes the Envoy out: its output is kept, then its
        // threads are archived with their children and worktrees retired.
        // The chat stays readable, and Resume brings it all back.
        const output =
          envoy.chatId && chat
            ? chat.lastReply(envoy.chatId)
            : (await bb.sdk.threads.output({ threadId: envoy.threadId! })).output;
        update(id, { lifecycle: state, result: output });
        await unwatch(envoy).catch((error) =>
          bb.log.warn(`could not remove PR watchers: ${errorText(error)}`),
        );
        await announce(get(id));
        if (envoy.chatId && chat) await chat.stop(envoy.chatId).catch(() => {});
        for (const owner of owners(envoy))
          await bb.sdk.threads.archive({ threadId: owner.threadId });
        return get(id);
      }
      return update(id, { lifecycle: state });
    });
  }
  // --- PR watchers ---
  // An Envoy's PR is watched by a BB script automation the Envoy owns
  // (created from its thread, named for the PR). It tells the Envoy once the
  // PR is marked ready, so the Envoy hands it off, then deletes itself. The
  // plugin only creates watchers at attach and removes them when the Envoy
  // stops: parked, cancelled or archived, or the PR detached.

  type Owner = { threadId: string; projectId: string };
  /** Lists the watchers a thread owns, optionally for one PR. */
  async function watchersOf(owner: Owner, url?: string) {
    const list = await bb.sdk.plugins.callRpc({
      pluginId: "automations",
      method: "automations_list",
      input: { projectId: owner.projectId },
      outputSchema: z.array(
        z.looseObject({
          id: z.string(),
          name: z.string(),
          createdByThreadId: z.string().nullable().optional(),
        }),
      ),
    });
    return list.filter(
      (each) =>
        each.createdByThreadId === owner.threadId &&
        each.name.startsWith(WATCHER_PREFIX) &&
        (url === undefined || each.name === `${WATCHER_PREFIX}${url}`),
    );
  }
  /** Removes the watchers of an Envoy's threads (lanes), all or one PR's. */
  async function unwatch(envoy: Envoy, url?: string, only?: Owner[]) {
    for (const owner of only ?? owners(envoy))
      for (const each of await watchersOf(owner, url))
        await bb.sdk.plugins.callRpc({
          pluginId: "automations",
          method: "automations_delete",
          input: { projectId: owner.projectId, automationId: each.id },
          outputSchema: z.unknown(),
        });
  }
  /**
   * Makes sure a PR has a watcher owned by the thread that attached it, when
   * a ready-PR handoff specialist is configured. Returns whether it is watched.
   */
  async function watch(owner: Owner, url: string) {
    const { handoffSpecialist } = await read();
    if (!handoffSpecialist) return false;
    if ((await watchersOf(owner, url)).length > 0) return true;
    await bb.sdk.plugins.callRpc({
      pluginId: "automations",
      method: "automations_create",
      input: {
        projectId: owner.projectId,
        name: `${WATCHER_PREFIX}${url}`,
        enabled: true,
        trigger: { triggerType: "schedule", cron: "*/2 * * * *", timezone: "UTC" },
        execution: {
          mode: "script",
          script: WATCHER_SCRIPT,
          interpreter: "bash",
          timeoutMs: 60_000,
          env: {
            PR_URL: url,
            ENVOY_THREAD: owner.threadId,
            NOTICE: `${READY_MARKER} ${url} is marked ready for review. Hand it off to the ${handoffSpecialist} specialist now with specialist_handoff, as your instructions describe.`,
          },
          workingDirectory: { type: "automation-storage" },
        },
        origin: "agent",
        createdByThreadId: owner.threadId,
      },
      outputSchema: z.unknown(),
    });
    return true;
  }
  /** Starts watching every attached PR again, for a resumed Envoy. */
  async function rewatch(envoy: Envoy) {
    for (const owner of owners(envoy))
      for (const pr of owner.prs)
        await watch(owner, pr.url).catch((error) =>
          bb.log.warn(`could not watch ${pr.url}: ${errorText(error)}`),
        );
  }

  async function prAction(
    id: string,
    raw: string,
    action: "attach" | "detach",
    /** The lane attaching it, which owns its watcher. */
    laneId?: string,
  ) {
    return serial(id, async () => {
      const identity = githubPr(raw);
      const envoy = get(id);
      if (action === "detach") {
        await unwatch(envoy, identity.url);
        return update(id, {
          prs: envoy.prs.filter((pr) => pr.url !== identity.url),
          lanes: envoy.lanes.map((lane) => ({
            ...lane,
            prs: lane.prs.filter((pr) => pr.url !== identity.url),
          })),
        });
      }
      if (envoy.lifecycle === "cancelled")
        throw new Error("Resume this Envoy before attaching a PR");
      const lane = envoy.lanes.find((each) => each.id === laneId);
      const next = update(id, {
        prs: envoy.prs.some((pr) => pr.url === identity.url)
          ? envoy.prs
          : [...envoy.prs, identity],
        lanes: envoy.lanes.map((each) =>
          each.id === laneId && !each.prs.some((pr) => pr.url === identity.url)
            ? { ...each, prs: [...each.prs, identity] }
            : each,
        ),
      });
      const owner: Owner | null = lane?.threadId
        ? { threadId: lane.threadId, projectId: lane.projectId }
        : !next.chatId && next.threadId
          ? { threadId: next.threadId, projectId: next.projectId }
          : null;
      // Only a working Envoy is watched; resuming one watches its PRs again.
      if (owner && (next.lifecycle === "active" || next.lifecycle === "creating"))
        await watch(owner, identity.url);
      return next;
    });
  }
  /** The Envoy a thread is: an older Envoy's own thread, or a lane's. */
  function envoyOfThread(threadId: string) {
    const own = [...records.values()].find((e) => e.threadId === threadId);
    if (own) return { envoy: own, lane: null };
    return laneOf(threadId);
  }
  bb.rpc.register(envoyRpcContract, {
    envoys_list: () => ({
      envoys: [...records.values()].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    }),
    envoys_get: ({ threadId }) => {
      const found = envoyOfThread(threadId);
      return found ? { ...found.envoy, laneId: found.lane?.id ?? null } : null;
    },
    envoys_create: create,
    envoys_retry: ({ id }) => serial(id, () => launch(id)),
    envoys_update: ({ id, name, issueUrl }) =>
      serial(id, async () => {
        const envoy = get(id);
        const issue =
          issueUrl === undefined
            ? envoy.issue
            : issueLink(issueUrl, (await read()).issueHosts);
        if (name && envoy.chatId) chat?.rename(envoy.chatId, name);
        if (name && envoy.threadId && !envoy.chatId)
          await bb.sdk.threads.update({
            threadId: envoy.threadId,
            title: name,
          });
        return update(id, {
          issue,
          ...(name ? { name, nameSource: "explicit" as const } : {}),
        });
      }),
    envoys_lifecycle: ({ id, lifecycle: state }) => lifecycle(id, state),
    envoys_pr: ({ id, url, action }) => prAction(id, url, action),
    envoys_specialists: async () => {
      const list = await specialists();
      return { specialists: list ?? [], available: list !== null };
    },
  });
  bb.agents.registerTool({
    name: PR_TOOL,
    description:
      "Attach this Envoy's GitHub PR so Sages tracks it and, when a ready-PR handoff specialist is configured, tells you once it is marked ready so you can hand it off. Required immediately after opening a draft PR. It does not mark the PR ready.",
    parameters: z.object({ url: z.string().max(2000) }),
    execute: async ({ url }, { threadId }) => {
      const found = envoyOfThread(threadId);
      if (!found)
        throw new Error(
          "This tool is only available in an Envoy's lane or primary thread",
        );
      const updated = await prAction(found.envoy.id, url, "attach", found.lane?.id);
      const pr = updated.prs.find((p) => p.url === githubPr(url).url)!;
      const { handoffSpecialist } = await read();
      const watched = (await watchersOf({ threadId, projectId: found.lane?.projectId ?? found.envoy.projectId }, pr.url)).length > 0;
      return `Attached ${pr.url}. ${watched ? `A watcher automation you own checks it every 2 minutes: once you or the user marks it ready, you get a message starting "${READY_MARKER}" telling you to hand it off to ${handoffSpecialist}.` : handoffSpecialist ? "It is not watched until this Envoy is resumed." : "No ready-PR handoff specialist is configured, so it is not watched."}`;
    },
  });
  bb.agents.registerTool({
    name: REPORT_TOOL,
    description:
      "Tell the sage that started this Envoy that you are blocked or need a decision. Only while the user is not in the conversation; it refuses during turns the user started.",
    parameters: z.object({
      message: z
        .string()
        .trim()
        .min(1)
        .max(20_000)
        .describe("What you need and why, with the options you see"),
    }),
    execute: async ({ message }, { threadId }) => {
      // An older Envoy's own thread, or a turn of a chat Envoy's chat.
      const chatEnvoy = chat ? await chat.envoyOfTurn(threadId).catch(() => null) : null;
      const envoy = chatEnvoy
        ? records.get(chatEnvoy)
        : [...records.values()].find((e) => e.threadId === threadId);
      if (!envoy?.reportTo)
        throw new Error("This Envoy was not started by a sage; ask the user");
      if (chatEnvoy ? chat!.userTurn(threadId) : userTurns.has(threadId))
        return "Not sent: the user is in this conversation, so ask them directly.";
      report(envoy, "needs a decision", message);
      return `Sent to the sage "${envoy.reportTo.name}". Its reply arrives in this ${chatEnvoy ? "chat" : "thread"}; end your turn rather than waiting for it.`;
    },
  });
  /** The chat Envoy a turn of its chat belongs to. */
  async function envoyOfChatTurn(threadId: string) {
    const id = chat ? await chat.envoyOfTurn(threadId) : null;
    if (!id) throw new Error("Only an Envoy's chat can use this tool");
    return get(id);
  }
  bb.agents.registerTool({
    name: LANE_TOOL,
    description:
      "Open a lane: a visible thread in a fresh worktree from a project's default branch, whose agent does one part of this Envoy's task (usually one repo, or one PR) and owns its PRs and specialist handoffs. Returns its thread id; never wait for it.",
    instructions: LANE_PROMPT,
    presentation: { label: { pending: "Opening lane", completed: "Opened lane" } },
    parameters: z.object({
      project: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("The project's id or name, from the list after the view. Omit it to use the Envoy's default project"),
      name: z.string().trim().min(1).max(60).describe("A few words naming the lane's part, e.g. \"Share card UI\""),
      task: z
        .string()
        .trim()
        .min(1)
        .max(100_000)
        .describe("A self-contained brief: the lane sees none of this chat. Its part of the goal, relevant paths and facts, constraints, how to verify it, what done looks like, and what other lanes do that it depends on."),
    }),
    execute: async ({ project, name, task }, { threadId }) => {
      try {
        const envoy = await envoyOfChatTurn(threadId);
        const projects = await bb.sdk.projects.list({ includePersonal: false });
        if (project === undefined) project = envoy.projectId;
        const key = project.toLowerCase();
        const match =
          projects.find((each) => each.id === project) ??
          projects.find((each) => each.name.toLowerCase() === key);
        if (!match)
          throw new Error(`No project "${project}". Projects: ${projects.map((each) => `${each.name} (${each.id})`).join(", ")}`);
        const { lane } = await openLane(envoy.id, { projectId: match.id, name, task });
        return `Opened the lane "${lane.name}" in ${match.name}: @thread:${lane.threadId}. Its report reaches this chat as a message starting "[lane ${lane.name}]" when the turn you started ends. Don't wait for it or do its work meanwhile.`;
      } catch (error) {
        return { content: [{ type: "text" as const, text: errorText(error) }], isError: true };
      }
    },
  });
  bb.agents.registerTool({
    name: LANE_MESSAGE_TOOL,
    description:
      'Send one of this Envoy\'s lanes a message: an answer, a correction, or more work in its part. Its reply reaches this chat as a message starting "[lane <name>]"; never wait for it.',
    presentation: { label: { pending: "Messaging lane", completed: "Messaged lane" } },
    parameters: z.object({
      lane: z.string().trim().min(1).describe("The lane's name or id, as listed after the view"),
      message: z.string().trim().min(1).max(30_000).describe("What to do or answer; it sees none of this chat"),
    }),
    execute: async ({ lane: which, message }, { threadId }) => {
      try {
        const envoy = await envoyOfChatTurn(threadId);
        const key = which.toLowerCase();
        const lane = envoy.lanes.find(
          (each) => each.id === which || each.name.toLowerCase() === key,
        );
        if (!lane?.threadId)
          throw new Error(`No open lane "${which}"; the lanes are listed after the view`);
        if (envoy.lifecycle !== "active")
          throw new Error(`This Envoy is ${envoy.lifecycle}; resume it first`);
        await bb.sdk.threads.send({
          threadId: lane.threadId,
          mode: "auto",
          input: [{ type: "text", text: `${LANE_MARKER}\n${message}`, mentions: [] }],
        });
        return `Sent to the lane "${lane.name}" (@thread:${lane.threadId}). Its reply reaches this chat as a message starting "[lane ${lane.name}]".`;
      } catch (error) {
        return { content: [{ type: "text" as const, text: errorText(error) }], isError: true };
      }
    },
  });
  // Startup recovery and checking are dormant until actual records need work.
  bb.background.service("envoy-recovery", {
    async start(signal) {
      for (const envoy of [...records.values()]) {
        if (signal.aborted) return;
        if (envoy.lifecycle === "cancelled") {
          await serial(envoy.id, async () => {
            const thread = envoy.threadId
              ? null
              : await findSpawn(envoy.projectId, "sages", "envoyId", envoy.id);
            await stopImplementation(
              thread ? adopt(envoy.id, thread) : envoy,
              false,
            );
          }).catch((error) => bb.log.warn(errorText(error)));
        } else if (envoy.kind === "chat" && envoy.chatId) {
          // A chat Envoy's lanes: their workspaces, read again.
          for (const lane of envoy.lanes.filter((each) => each.threadId))
            await bb.sdk.threads.get({ threadId: lane.threadId! }).then(
              (thread) => setLane(envoy.id, lane.id, { environmentId: thread.environmentId }),
              () => {},
            );
        } else if (!envoy.threadId && envoy.creation !== "failed") {
          await serial(envoy.id, () =>
            launch(envoy.id, envoy.creation !== "reserved"),
          ).catch((error) => bb.log.warn(errorText(error)));
        } else if (envoy.threadId) {
          await bb.sdk.threads.get({ threadId: envoy.threadId }).then(
            (thread) =>
              update(envoy.id, { environmentId: thread.environmentId }),
            (error) => update(envoy.id, { error: errorText(error) }),
          );
        }
      }
    },
  });
  bb.experimental_hooks.on("message.dispatch", (context) => {
    const envoy = envoyOfThread(context.thread.id)?.envoy;
    if (envoy) {
      // The watcher's notice and the Envoy chat's messages to a lane arrive
      // as user messages but are automated.
      const text = context.input.text.trimStart();
      const fromUser =
        context.initiator === "user" &&
        !text.startsWith(READY_MARKER) &&
        !fromEnvoy(text);
      if (fromUser) userTurns.add(context.thread.id);
      else if (context.attempt === "start-turn")
        userTurns.delete(context.thread.id);
    }
    if (
      !envoy ||
      envoy.lifecycle === "active" ||
      envoy.lifecycle === "creating"
    )
      return { action: "proceed" };
    if (
      envoy.lifecycle !== "cancelled" &&
      context.initiator === "user" &&
      !fromEnvoy(context.input.text)
    ) {
      const resumed = update(envoy.id, { lifecycle: "active" });
      void rewatch(resumed);
      void announce(resumed);
      return { action: "proceed" };
    }
    return {
      action: "reject",
      message: `This Envoy is ${envoy.lifecycle}. Resume it to continue implementation; PR follow-up remains separate.`,
    };
  });
  bb.events.on("thread.active", async ({ thread }) => {
    try {
      const parent = thread.parentThreadId ? envoyOfThread(thread.parentThreadId) : null;
      if (parent?.envoy.lifecycle === "cancelled") {
        await bb.sdk.threads.stop({ threadId: thread.id });
        return;
      }
      const lane = laneOf(thread.id);
      if (lane) {
        setLane(lane.envoy.id, lane.lane.id, { environmentId: thread.environmentId });
        if (lane.envoy.lifecycle === "cancelled")
          await bb.sdk.threads.stop({ threadId: thread.id });
        return;
      }
      let envoy = [...records.values()].find((e) => e.threadId === thread.id);
      if (!envoy && thread.originPluginId === "sages") {
        const batch = await bb.sdk.threads.experimental_listPluginMetadata({
          pluginId: "sages",
          threadIds: [thread.id],
        });
        const found = batch.threads.find((t) => t.threadId === thread.id)?.metadata;
        const candidate = records.get(String(found?.envoyId ?? ""));
        const laneId = found?.laneId;
        if (candidate && typeof laneId === "string") {
          // A lane whose launch went unconfirmed shows up: adopt it.
          const pending = candidate.lanes.find((each) => each.id === laneId);
          if (pending && !pending.threadId)
            setLane(candidate.id, laneId, {
              threadId: thread.id,
              environmentId: thread.environmentId,
              creation: "ready",
              error: null,
            });
          if (candidate.lifecycle === "cancelled")
            await bb.sdk.threads.stop({ threadId: thread.id });
          return;
        }
        if (candidate && !candidate.threadId && candidate.kind === "thread")
          envoy = adopt(candidate.id, thread);
      }
      if (envoy) {
        update(envoy.id, { environmentId: thread.environmentId, error: null });
        if (envoy.lifecycle === "cancelled")
          await bb.sdk.threads.stop({ threadId: thread.id });
      }
    } catch (error) {
      bb.log.warn(errorText(error));
    }
  });
  // A lane's turn ends: what it says goes to its Envoy's chat. A turn the
  // chat started (or a watcher's notice) starts a chat turn; one the user
  // worked on with the lane is only logged, so the chat stays current.
  function laneEnded(threadId: string, text: string, failed: boolean) {
    const found = laneOf(threadId);
    const chatId = found?.envoy.chatId;
    if (!found || !chatId || !chat) return;
    const { envoy, lane } = found;
    const byUser = userTurns.has(threadId) && !failed;
    if (envoy.lifecycle !== "active" && !byUser) return;
    chat.deliver(
      chatId,
      `Lane ${lane.name} ${failed ? "failed" : byUser ? "worked with the user" : "reported"}`,
      `[lane ${lane.name}] ${failed ? "failed" : byUser ? "turn with the user ended" : "report"} (thread ${threadId}):\n${text}`,
      !byUser,
    );
  }
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    if (!laneOf(thread.id)) return;
    void (async () =>
      laneEnded(
        thread.id,
        lastAssistantText ??
          (await bb.sdk.threads.output({ threadId: thread.id })).output ??
          "(no reply)",
        false,
      ))().catch((error) => bb.log.warn(`could not report a lane: ${errorText(error)}`));
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    if (laneOf(thread.id)) {
      laneEnded(thread.id, error ?? "no error given", true);
      return;
    }
    const envoy = [...records.values()].find((e) => e.threadId === thread.id);
    if (envoy) {
      update(envoy.id, {
        error: error ?? "The task agent failed; retry from its BB thread.",
      });
      if (envoy.reportTo && !userTurns.has(thread.id))
        report(envoy, "failed", error ?? "no error given");
    }
  });
  // An archived (or deleted) Envoy thread leaves no watcher behind.
  bb.events.on("thread.archived", ({ thread }) => {
    const found = envoyOfThread(thread.id);
    if (found)
      void unwatch(
        found.envoy,
        undefined,
        found.lane ? [{ threadId: thread.id, projectId: found.lane.projectId }] : undefined,
      ).catch((error) =>
        bb.log.warn(`could not remove PR watchers: ${errorText(error)}`),
      );
  });
  bb.onDispose(() => {
    controller.abort();
  });

  return {
    createTask,
    list: () => records.values(),
    get: (id: string) => records.get(id) ?? null,
    lifecycle,
    /** The rules an Envoy's chat turns follow. */
    chatInstructions: (id: string) => chatInstructionsFor(lastConfig, get(id)),
    configure(context: PluginAgentConfigurationContext) {
      const envoy = records.get(String(context.pluginMetadata.envoyId ?? ""));
      const lane = envoy?.lanes.find((each) => each.id === context.pluginMetadata.laneId);
      if (envoy && lane)
        return lane.threadId === null || lane.threadId === context.thread.id
          ? { tools: [PR_TOOL], skills: [], instructions: instructionsFor(lastConfig, envoy, lane) }
          : { tools: [], skills: [] };
      return envoy && !envoy.chatId &&
        (envoy.threadId === null || envoy.threadId === context.thread.id)
        ? {
            tools: envoy.reportTo ? [PR_TOOL, REPORT_TOOL] : [PR_TOOL],
            skills: [],
            instructions: instructionsFor(lastConfig, envoy),
          }
        : { tools: [], skills: [] };
    },
    async runCli(argv: string[], ctx: PluginCliContext) {
      try {
        const [command, id, ...rest] = argv;
        if (
          command === undefined ||
          argv.includes("--help") ||
          argv.includes("-h")
        )
          return { exitCode: 0, stdout: ENVOY_USAGE };
        let value: unknown;
        if (command === "list") value = [...records.values()];
        else if (command === "show" && id) value = get(id);
        else if (command === "recover" && id)
          value = await serial(id, () => launch(id));
        else if (
          ["park", "resume", "complete", "cancel"].includes(command ?? "") &&
          id
        )
          value = await lifecycle(
            id,
            (
              {
                park: "parked",
                resume: "active",
                complete: "completed",
                cancel: "cancelled",
              } as const
            )[command as "park"],
          );
        else if (command === "pr" && id && rest[0])
          value = await prAction(id, rest[0], "attach");
        else if (command === "tell" && id && rest.length) {
          const envoy = get(id);
          if (!envoy.chatId || !chat)
            throw new Error(`This Envoy has no chat; message its thread with bb thread tell ${envoy.threadId}`);
          const message = rest.filter((each) => each !== "--json").join(" ").trim();
          if (!message) throw new Error("Give a message");
          if (envoy.lifecycle === "cancelled") throw new Error("This Envoy is cancelled");
          if (envoy.lifecycle !== "active") await lifecycle(id, "active", true);
          chat.deliver(envoy.chatId, "Message", `[message${ctx.threadId ? ` from thread ${ctx.threadId}` : ""}]\n${message}`, true);
          value = { ok: true, envoy: id };
        }
        else if (command === "create") {
          const flags: Record<string, string> = {};
          const args = argv.slice(1);
          for (let i = 0; i < args.length; i++) {
            if (args[i] === "--json") continue;
            if (!args[i]!.startsWith("--") || !args[i + 1])
              throw new Error(
                "Expected --task, --project, --name, --issue, --specialist or --request-id with a value",
              );
            flags[args[i]!.slice(2)] = args[++i]!;
          }
          value = await createTask({
            task: flags.task ?? "",
            projectId: flags.project ?? ctx.projectId ?? "",
            name: flags.name,
            issueUrl: flags.issue,
            specialist: flags.specialist,
            requestId: flags["request-id"],
          });
        } else
          return { exitCode: 1, stderr: ENVOY_USAGE };
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            value,
            null,
            argv.includes("--json") ? undefined : 2,
          ),
        };
      } catch (error) {
        return { exitCode: 1, stderr: errorText(error) };
      }
    },
  };
}
