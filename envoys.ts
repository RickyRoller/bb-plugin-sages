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
  type EnvoyPr,
  type Specialist,
} from "./envoy-contract.ts";

const PR_TOOL = "envoy_attach_pr";
export const ENVOY_USAGE = [
  "Usage:",
  "  bb sages envoy list [--json]",
  "  bb sages envoy show <id> [--json]",
  "  bb sages envoy create --task <text> [--project <project-id>] [--name <name>] [--issue <url>] [--specialist <name>] [--request-id <key>] [--json]",
  "  bb sages envoy park|resume|complete|cancel <id> [--json]",
  "  bb sages envoy pr <id> <github-pr-url> [--json]",
  "  bb sages envoy recover <id> [--json]",
  "",
  "create starts the task in a fresh worktree from the project's default branch,",
  "with one visible bb thread. --project defaults to the current project; get ids",
  "from bb project list. --issue is a full https issue link. --specialist names a",
  "specialist to lead it. Reuse --request-id to make a retried create a no-op.",
].join("\n");

/** What an Envoy is created from outside its dialog: the CLI and sage turns. */
export type EnvoyTask = {
  task: string;
  projectId: string;
  name?: string;
  issueUrl?: string;
  specialist?: string;
  requestId?: string;
};
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
  /** Extra instructions sent to that specialist with the PR. */
  handoffInstructions: string;
  /** Hostnames allowed for issue links; empty allows any. */
  issueHosts: string[];
};
export const defaultEnvoyConfig: EnvoyConfig = {
  preparedProjects: [],
  installCommand: "",
  handoffSpecialist: "",
  handoffInstructions: "",
  issueHosts: [],
};

function policy(handoff: string) {
  return `You are an Envoy: complete the user's bounded task in this workspace. Delegate work to available specialists when their role fits; specialist_handoff creates a child in this workspace, so brief it with the goal, ownership, constraints and verification. Keep the user informed and report results and verification in this thread. Do not claim task completion from an idle agent or CI alone.
All pull requests you open must be DRAFT (gh pr create --draft). Immediately after opening a PR, call envoy_attach_pr with its exact GitHub URL; also attach an existing PR only when it belongs to this task. Never mark a PR ready unless the user explicitly asks. ${
    handoff
      ? `Sages watches only attached PRs: once one is marked ready (by you on request, or by the user on GitHub), it starts the ${handoff} specialist for follow-up; do not start ${handoff} for that PR yourself.`
      : "No ready-for-review follow-up is configured, so Sages does not poll PRs."
  } Envoy delegation is authorized within this task.`;
}

export async function registerEnvoys(
  bb: BbPluginApi,
  config: () => Promise<EnvoyConfig> = async () => defaultEnvoyConfig,
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
    envoy.prs = envoy.prs.map((pr) =>
      envoy.lifecycle === "cancelled" || pr.handoff === "error"
        ? { ...pr, watching: false }
        : pr,
    );
    db.prepare("UPDATE envoys SET data=? WHERE id=?").run(
      JSON.stringify(envoy),
      envoy.id,
    );
    records.set(envoy.id, envoy);
  }
  const host = bb.hosts.experimental_client({ contract: envoyHostContract });
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watching = false;
  const controller = new AbortController();
  const queues = new Map<string, Promise<unknown>>();
  const readRetries = new Map<string, { failures: number; after: number }>();
  const relaunchKeys = new Set<string>();
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
    void bb.sdk.plugins
      .callRpc({
        pluginId: "sidebar-thread-details",
        method: "refreshEnvoys",
        input: {},
        outputSchema: z.unknown(),
      })
      .catch(() => {});
    schedule();
    return envoy;
  }
  function updatePr(id: string, url: string, patch: Partial<EnvoyPr>) {
    const current = get(id).prs.find((pr) => pr.url === url);
    if (
      current &&
      Object.entries(patch).every(
        ([key, value]) => current[key as keyof EnvoyPr] === value,
      )
    )
      return get(id);
    return update(id, {
      prs: get(id).prs.map((pr) => (pr.url === url ? { ...pr, ...patch } : pr)),
    });
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
  async function launch(id: string, recoveryOnly = false) {
    const envoy = get(id);
    if (envoy.lifecycle === "cancelled") return envoy;
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
    const row = db
      .prepare("SELECT launch FROM envoys WHERE id = ?")
      .get(id) as { launch: string };
    const launch = JSON.parse(row.launch) as {
      request: NewThreadRequest;
      lead: Specialist | null;
    };
    const available = await specialists();
    const settings = await read();
    let context = [
      policy(settings.handoffSpecialist),
      available === null
        ? "Specialists are unavailable; report this limitation when delegation is needed."
        : `Available specialists (data): ${JSON.stringify(available.map(({ name, description }) => ({ name, description })))}`,
      ...(launch.lead ? [launch.lead.prompt] : []),
    ].join("\n\n");
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
    execution.executionInputSources = sources;
    // Preparation failures cannot have spawned a thread and are safe to retry.
    // Keep this outside the ambiguous-spawn handling below.
    try {
      if (settings.preparedProjects.includes(envoy.projectId)) {
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
        const project = await bb.sdk.projects.get({ projectId: envoy.projectId });
        const candidates = project.sources.filter((source) => !hostId || source.hostId === hostId);
        const source = candidates.find((source) => source.isDefault) ?? (candidates.length === 1 ? candidates[0] : undefined);
        if (!source) throw new Error("Select a machine with an unambiguous project source");
        update(id, { error: `Preparing source: ${source.path}` });
        const prepared = await host.call("prepareSource", { path: source.path, installCommand: settings.installCommand }, {
          hostId: source.hostId, signal: controller.signal, timeoutMs: 20 * 60_000,
        });
        execution.environment = {
          type: "host", hostId: source.hostId,
          workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: prepared.commit } },
        };
        context += `\n\nSource prepared at ${prepared.commit} (${prepared.branch}).${
          settings.installCommand.trim()
            ? ` Dependencies were installed in the base checkout with \`${settings.installCommand}\`. The new worktree has its own dependency state: before editing or validating, follow the repository's worktree setup instructions and run \`${settings.installCommand}\` in this workspace. Stop and report installation failures; do not link the base checkout's dependencies.`
            : " Before editing or validating, follow the repository's worktree setup instructions."
        }`;
      }
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
  async function stopImplementation(envoy: Envoy, preserveHandoffs = true) {
    if (!envoy.threadId) return;
    const all = [] as Awaited<ReturnType<typeof bb.sdk.threads.list>>;
    for (let offset = 0; ; offset += 100) {
      const page = await bb.sdk.threads.list({
        projectId: envoy.projectId,
        includeHidden: true,
        archived: false,
        limit: 100,
        offset,
      });
      all.push(...page);
      if (page.length < 100) break;
    }
    const exempt = new Set(
      preserveHandoffs
        ? envoy.prs.map((pr) => pr.handoffThreadId).filter(Boolean)
        : [],
    );
    if (preserveHandoffs) {
      for (const pr of envoy.prs.filter(
        (p) => p.handoff === "dispatching" && !p.handoffThreadId,
      )) {
        const worker = await findSpawn(
          envoy.projectId,
          "specialists",
          "handoffKey",
          pr.handoffKey,
        );
        if (worker) {
          exempt.add(worker.id);
          updatePr(envoy.id, pr.url, {
            handoff: "started",
            handoffThreadId: worker.id,
            watching: false,
            error: null,
          });
        }
      }
    }
    const selected = new Set([envoy.threadId]);
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
  async function lifecycle(
    id: string,
    state: "active" | "parked" | "completed" | "cancelled",
  ) {
    return serial(id, async () => {
      let envoy = get(id);
      if (envoy.lifecycle === state && state !== "cancelled") return envoy;
      if (state === "cancelled") {
        if (!envoy.threadId) {
          const existing = await findSpawn(
            envoy.projectId,
            "sages",
            "envoyId",
            id,
          );
          if (existing) envoy = adopt(id, existing);
        }
        // Commit cancellation first so delayed handoff completions cannot restart implementation.
        envoy = update(id, {
          lifecycle: "cancelled",
          prs: envoy.prs.map((pr) => ({ ...pr, watching: false })),
        });
        await stopImplementation(envoy, false);
        return envoy;
      }
      if (envoy.creation !== "ready" || !envoy.threadId)
        throw new Error(
          "Recover the task thread before changing its lifecycle",
        );
      if (state === "active") {
        const thread = await bb.sdk.threads.get({ threadId: envoy.threadId });
        if (thread.archivedAt !== null)
          await bb.sdk.threads.unarchive({ threadId: envoy.threadId });
        update(id, { lifecycle: "active" });
        try {
          await bb.sdk.threads.send({
            threadId: envoy.threadId,
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
      } else {
        update(id, { lifecycle: state });
        await stopImplementation(envoy);
      }
      const result =
        state === "completed"
          ? (await bb.sdk.threads.output({ threadId: envoy.threadId })).output
          : envoy.result;
      return update(id, { lifecycle: state, result });
    });
  }
  async function prAction(
    id: string,
    raw: string,
    action: "attach" | "detach" | "retry" | "relaunch" | "stop",
  ) {
    return serial(id, async () => {
      const identity = githubPr(raw);
      const envoy = get(id);
      const current = envoy.prs.find((pr) => pr.url === identity.url);
      if (
        envoy.lifecycle === "cancelled" &&
        ["attach", "retry", "relaunch"].includes(action)
      )
        throw new Error(
          "Resume this Envoy before attaching or retrying PR follow-up",
        );
      if (action === "detach")
        return update(id, {
          prs: envoy.prs.filter((pr) => pr.url !== identity.url),
        });
      if (!current && action !== "attach")
        throw new Error("That PR is not attached to this Envoy");
      if (action === "stop")
        return updatePr(id, identity.url, { watching: false });
      if (current) {
        readRetries.delete(current.handoffKey);
        if (action === "relaunch") {
          if (current.handoff !== "dispatching" || current.handoffThreadId)
            throw new Error("Only an unconfirmed handoff can be relaunched");
          relaunchKeys.add(current.handoffKey);
        }
        if (
          action === "attach" &&
          (current.error || current.handoff === "error")
        )
          return envoy;
        // Retry preserves the recovery key and searches for an already-created
        // worker before starting another. Reattaching doesn't duplicate it.
        return updatePr(id, identity.url, {
          watching: current.handoff !== "started",
          ...(["retry", "relaunch"].includes(action)
            ? {
                error: null,
                handoff:
                  current.handoff === "started"
                    ? "started"
                    : current.handoff === "dispatching"
                      ? "dispatching"
                      : "pending",
              }
            : {}),
        });
      }
      return update(id, {
        prs: [
          ...envoy.prs,
          {
            ...identity,
            state: "unknown",
            watching: (await read()).handoffSpecialist !== "",
            handoffKey: `envoy-pr:${id}:${identity.owner}/${identity.repo}:${identity.number}`,
            handoff: "pending",
            handoffThreadId: null,
            error: null,
          },
        ],
      });
    });
  }
  async function alert(envoy: Envoy, pr: EnvoyPr, message: string) {
    if (pr.error === message) return;
    updatePr(envoy.id, pr.url, { error: message });
    if (envoy.threadId && envoy.lifecycle === "active")
      await bb.sdk.threads
        .send({
          threadId: envoy.threadId,
          mode: "auto",
          input: [
            {
              type: "text",
              text: `Needs attention: PR handoff for ${pr.url}: ${message}`,
              mentions: [],
            },
          ],
        })
        .catch((error) => {
          if (!disposed) bb.log.warn(errorText(error));
        });
  }
  function eligible() {
    return [...records.values()].some(
      (e) =>
        e.lifecycle !== "cancelled" &&
        e.threadId &&
        e.prs.some(
          (pr) =>
            pr.watching &&
            pr.handoff !== "error" &&
            !["closed", "merged"].includes(pr.state),
        ),
    );
  }
  function schedule() {
    if (disposed || watching) return;
    if (!eligible()) {
      if (timer) clearTimeout(timer);
      timer = null;
      return;
    }
    if (!timer)
      timer = setTimeout(() => {
        timer = null;
        void checkPrs().catch((error) => bb.log.warn(errorText(error)));
      }, 60_000);
  }
  async function checkPrs() {
    if (watching || disposed || !eligible()) return;
    watching = true;
    try {
      const settings = await read();
      for (const envoy of [...records.values()]) {
        if (!envoy.threadId || envoy.lifecycle === "cancelled") continue;
        for (const candidate of envoy.prs.filter(
          (pr) =>
            pr.watching &&
            pr.handoff !== "error" &&
            !["closed", "merged"].includes(pr.state),
        )) {
          await serial(envoy.id, async () => {
            const current = get(envoy.id);
            const pr = current.prs.find((p) => p.url === candidate.url);
            if (
              !pr?.watching ||
              current.lifecycle === "cancelled" ||
              disposed ||
              (readRetries.get(pr.handoffKey)?.after ?? 0) > Date.now()
            )
              return;
            // Without a ready-PR handoff there is nothing to watch for.
            if (!settings.handoffSpecialist) {
              updatePr(current.id, pr.url, { watching: false });
              return;
            }
            let readCompleted = false;
            try {
              const thread = await bb.sdk.threads.get({
                threadId: current.threadId!,
              });
              if (!thread.environmentId)
                throw new Error("The Envoy workspace is not ready");
              const env = await bb.sdk.environments.get({
                environmentId: thread.environmentId,
              });
              const state = await host.call(
                "prState",
                { owner: pr.owner, repo: pr.repo, number: pr.number },
                { hostId: env.hostId, signal: controller.signal },
              );
              if (disposed) return;
              readCompleted = true;
              readRetries.delete(pr.handoffKey);
              updatePr(current.id, pr.url, {
                state: state.state,
                ...(pr.handoff === "pending" ? { error: null } : {}),
                ...(state.state === "closed" || state.state === "merged"
                  ? { watching: false }
                  : {}),
              });
              if (
                state.state !== "ready" ||
                pr.handoff === "started" ||
                pr.handoff === "error"
              )
                return;
              // Detach/reattach and repeated registrations keep the same key.
              const previous = await findSpawn(
                current.projectId,
                "specialists",
                "handoffKey",
                pr.handoffKey,
              );
              if (previous) {
                relaunchKeys.delete(pr.handoffKey);
                updatePr(current.id, pr.url, {
                  handoff: "started",
                  handoffThreadId: previous.id,
                  watching: false,
                  error: null,
                });
                return;
              }
              const handoff = settings.handoffSpecialist;
              if (!(await specialists())?.some((s) => s.name === handoff))
                throw new Error(
                  `The ${handoff} specialist is unavailable; restore it or change the ready-PR handoff setting, then retry the handoff`,
                );
              updatePr(current.id, pr.url, {
                handoff: "dispatching",
                error: null,
              });
              if (pr.handoffThreadId) {
                updatePr(current.id, pr.url, { watching: false });
                await alert(
                  current,
                  pr,
                  "A handoff worker already exists but its recovery metadata is unavailable; restore its key before retrying.",
                );
                return;
              }
              // A distinct versioned RPC fails closed against older Specialists installs.
              try {
                await bb.sdk.plugins.callRpc({
                  pluginId: "specialists",
                  method: "specialists_handoff_capabilities",
                  input: null,
                  outputSchema: z.object({ keyedHandoffVersion: z.literal(1) }),
                });
              } catch (error) {
                throw new Error(
                  `Update or enable Specialists with keyed handoff version 1, then Retry: ${errorText(error)}`,
                );
              }
              const response = await bb.sdk.plugins.callRpc({
                pluginId: "specialists",
                method: "specialists_handoff_keyed",
                input: {
                  specialist: handoff,
                  task: [
                    `This Envoy PR is ready for review: ${pr.url}\nObserved head: ${state.head}\nOrigin thread: ${current.threadId}\nFollow your procedure for a PR that is ready for review and report the outcome. Do not create another readiness watcher.`,
                    settings.handoffInstructions.trim(),
                  ]
                    .filter(Boolean)
                    .join("\n\n"),
                  projectId: current.projectId,
                  environmentId: thread.environmentId,
                  requestedBy: `Envoy ${current.name}`,
                  parentThreadId: current.threadId,
                  handoffKey: pr.handoffKey,
                  relaunchUncertain: relaunchKeys.delete(pr.handoffKey),
                },
                outputSchema: z.object({
                  status: z.enum(["started", "failed", "uncertain"]),
                  threadId: z.string().nullable(),
                  error: z.string().nullable(),
                }),
              });
              if (disposed) return;
              if (response.status !== "started" || !response.threadId) {
                updatePr(current.id, pr.url, {
                  handoff:
                    response.status === "failed" ? "error" : "dispatching",
                  watching: false,
                });
                await alert(
                  current,
                  pr,
                  response.error ??
                    "The handoff launch outcome is unconfirmed; retry recovery.",
                );
                return;
              }
              const batch =
                await bb.sdk.threads.experimental_listPluginMetadata({
                  pluginId: "specialists",
                  threadIds: [response.threadId],
                });
              if (
                !batch.threads.some(
                  (t) =>
                    t.threadId === response.threadId &&
                    t.metadata.handoffKey === pr.handoffKey,
                )
              ) {
                updatePr(current.id, pr.url, {
                  handoffThreadId: response.threadId,
                  watching: false,
                });
                await alert(
                  current,
                  pr,
                  "The Specialists worker has no recovery key. Update Specialists before retrying; the existing worker must not be duplicated.",
                );
                return;
              }
              updatePr(current.id, pr.url, {
                handoff: "started",
                handoffThreadId: response.threadId,
                watching: false,
                error: null,
              });
            } catch (error) {
              if (disposed) return;
              const latest = get(envoy.id).prs.find((p) => p.url === pr.url)!;
              // Lost replies may have committed a worker. Recover once, then pause
              // instead of making endless GitHub requests while waiting for Retry.
              if (latest.handoff === "dispatching") {
                try {
                  const worker = await findSpawn(
                    current.projectId,
                    "specialists",
                    "handoffKey",
                    pr.handoffKey,
                  );
                  if (worker) {
                    updatePr(current.id, pr.url, {
                      handoff: "started",
                      handoffThreadId: worker.id,
                      watching: false,
                      error: null,
                    });
                    return;
                  }
                } catch {
                  /* Leave the durable keyed launch for explicit recovery. */
                }
              }
              updatePr(envoy.id, pr.url, {
                watching: !readCompleted && latest.handoff === "pending",
                ...(readCompleted && latest.handoff !== "dispatching"
                  ? { handoff: "error" as const }
                  : {}),
              });
              if (!readCompleted && latest.handoff === "pending") {
                const failures =
                  (readRetries.get(pr.handoffKey)?.failures ?? 0) + 1;
                readRetries.set(pr.handoffKey, {
                  failures,
                  after:
                    Date.now() +
                    Math.min(60_000 * 2 ** Math.min(failures - 1, 4), 900_000),
                });
              }
              await alert(get(envoy.id), latest, errorText(error));
            }
          });
        }
      }
    } finally {
      watching = false;
      schedule();
    }
  }
  bb.rpc.register(envoyRpcContract, {
    envoys_list: () => ({
      envoys: [...records.values()].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    }),
    envoys_get: ({ threadId }) =>
      [...records.values()].find((e) => e.threadId === threadId) ?? null,
    envoys_create: create,
    envoys_retry: ({ id }) => serial(id, () => launch(id)),
    envoys_update: ({ id, name, issueUrl }) =>
      serial(id, async () => {
        const envoy = get(id);
        const issue =
          issueUrl === undefined
            ? envoy.issue
            : issueLink(issueUrl, (await read()).issueHosts);
        if (name && envoy.threadId)
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
    envoys_summaries: ({ threadIds }) => {
      const ids = new Set(threadIds);
      return {
        envoys: [...records.values()]
          .filter((e) => e.threadId && ids.has(e.threadId))
          .map(({ id, threadId, lifecycle, issue }) => ({
            id,
            threadId,
            lifecycle,
            issue,
          })),
      };
    },
  });
  bb.agents.registerTool({
    name: PR_TOOL,
    description:
      "Attach this Envoy's GitHub PR so Sages tracks it, and watches for it to be marked ready when a ready-PR handoff is configured. Required immediately after opening a draft PR. It does not mark the PR ready.",
    parameters: z.object({ url: z.string().max(2000) }),
    execute: async ({ url }, { threadId }) => {
      const envoy = [...records.values()].find((e) => e.threadId === threadId);
      if (!envoy)
        throw new Error(
          "This tool is only available in an Envoy's primary thread",
        );
      const updated = await prAction(envoy.id, url, "attach");
      const pr = updated.prs.find((p) => p.url === githubPr(url).url)!;
      const { handoffSpecialist } = await read();
      return `Attached ${pr.url}. ${pr.watching ? `Ready-for-review monitoring is active; ${handoffSpecialist} starts when you or the user marks it ready.` : pr.handoff === "started" ? "PR handoff has already started." : handoffSpecialist ? "PR follow-up is paused; use Retry in Envoy details." : "No ready-PR handoff is configured, so it is not watched."}`;
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
      await checkPrs();
    },
  });
  bb.experimental_hooks.on("message.dispatch", (context) => {
    const envoy = [...records.values()].find(
      (e) => e.threadId === context.thread.id,
    );
    if (
      !envoy ||
      envoy.lifecycle === "active" ||
      envoy.lifecycle === "creating"
    )
      return { action: "proceed" };
    if (envoy.lifecycle !== "cancelled" && context.initiator === "user") {
      update(envoy.id, { lifecycle: "active" });
      return { action: "proceed" };
    }
    return {
      action: "reject",
      message: `This Envoy is ${envoy.lifecycle}. Resume it to continue implementation; PR follow-up remains separate.`,
    };
  });
  bb.events.on("thread.active", async ({ thread }) => {
    try {
      const cancelledParent = [...records.values()].find(
        (e) =>
          e.threadId === thread.parentThreadId && e.lifecycle === "cancelled",
      );
      if (cancelledParent) {
        await bb.sdk.threads.stop({ threadId: thread.id });
        return;
      }
      let envoy = [...records.values()].find((e) => e.threadId === thread.id);
      if (!envoy && thread.originPluginId === "sages") {
        const batch = await bb.sdk.threads.experimental_listPluginMetadata({
          pluginId: "sages",
          threadIds: [thread.id],
        });
        const identity = batch.threads.find((t) => t.threadId === thread.id)
          ?.metadata.envoyId;
        const candidate = records.get(String(identity ?? ""));
        if (candidate && !candidate.threadId)
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
  bb.events.on("thread.failed", ({ thread, error }) => {
    const envoy = [...records.values()].find((e) => e.threadId === thread.id);
    if (envoy)
      update(envoy.id, {
        error: error ?? "The task agent failed; retry from its BB thread.",
      });
  });
  bb.onDispose(() => {
    disposed = true;
    controller.abort();
    if (timer) clearTimeout(timer);
  });

  return {
    createTask,
    configure(context: PluginAgentConfigurationContext) {
      const envoy = records.get(String(context.pluginMetadata.envoyId ?? ""));
      return envoy &&
        (envoy.threadId === null || envoy.threadId === context.thread.id)
        ? { tools: [PR_TOOL], skills: [], instructions: policy(lastConfig.handoffSpecialist) }
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
