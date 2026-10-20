import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFakePluginHost,
  makeThreadResponse,
  makePluginAgentConfigurationContext,
  makeMessageDispatchHookContext,
} from "@get-bb/plugin-sdk/testing";
import { registerEnvoys, WATCHER_SCRIPT } from "./envoys.ts";
import { githubPr, issueLink } from "./envoy-contract.ts";

const specialist = {
  name: "ready-pr",
  description: "Follows up on ready PRs",
  prompt: "Monitor the PR",
  providerId: null,
  model: null,
  reasoningLevel: null,
};
const request = {
  requestId: "request-1",
  name: "",
  issueUrl: "https://tracker.example.com/team/issue/ABC-123/fix",
  specialist: null,
  request: {
    projectId: "project-1",
    environment: {
      type: "host",
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    },
    input: [{ type: "text", text: "Fix login crash", mentions: [] }],
    permissionMode: "accept-edits",
  },
};
async function setup(
  options: {
    missingSpecialist?: boolean;
    spawnError?: unknown;
    hostError?: boolean;
    lead?: boolean;
    prepare?: boolean;
    noHandoff?: boolean;
    issueHosts?: string[];
  } = {},
) {
  /** The Automations plugin's records, as its RPCs see them. */
  const automations: {
    id: string;
    projectId: string;
    name: string;
    createdByThreadId: string | null;
    input: any;
  }[] = [];
  const reports: { name: string; outcome: string; text: string }[] = [];
  let spawnCount = 0;
  let handoffCount = 0;
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const metadata = new Map<string, Record<string, unknown>>();
  const { bb, harness } = createFakePluginHost({
    pluginId: "sages",
    experimental_hostEntry: true,
    experimental_callHostRpc: async ({ method }) => {
      if (options.hostError) throw new Error("Host temporarily offline");
      if (method === "prepareSource") return { commit: "a".repeat(40), branch: "main" };
      throw new Error(`unexpected host call ${method}`);
    },
    sdk: {
      projects: {
        get: async () => ({ id: "project-1", sources: [{ hostId: "host-1", path: "/repo/base", isDefault: true }] }),
        list: async () => [
          { id: "project-1", name: "Example", kind: "standard" },
        ],
      },
      environments: {
        get: async () => ({ id: "environment-1", hostId: "host-1" }),
      },
      threads: {
        spawn: async (args) => {
          spawnCount++;
          if (options.spawnError) throw options.spawnError;
          const thread = makeThreadResponse({
            id: `thread-${spawnCount}`,
            environmentId: "environment-1",
            projectId: "project-1",
            title: String(args.title),
            originPluginId: "sages",
            status: "active",
          });
          threads.set(thread.id, thread);
          metadata.set(
            thread.id,
            args.pluginMetadata as Record<string, unknown>,
          );
          return thread;
        },
        list: async (args) =>
          args?.archived
            ? []
            : [...threads.values()].filter(
                (t) =>
                  !args?.originPluginId ||
                  t.originPluginId === args.originPluginId,
              ),
        get: async ({ threadId }: { threadId: string }) =>
          threads.get(threadId) ??
          makeThreadResponse({
            id: threadId,
            environmentId: "environment-1",
            projectId: "project-1",
          }),
        experimental_listPluginMetadata: async ({
          threadIds,
        }: {
          threadIds: readonly string[];
        }) => ({
          threads: threadIds.map((threadId) => ({
            threadId,
            metadata: metadata.get(threadId) ?? {},
          })),
        }),
        stop: async () => ({ ok: true }),
        archive: async ({ threadId }: { threadId: string }) => {
          const thread = threads.get(threadId);
          if (thread)
            threads.set(threadId, { ...thread, archivedAt: Date.now() });
          return {};
        },
        unarchive: async ({ threadId }: { threadId: string }) => {
          const thread = threads.get(threadId);
          if (thread)
            threads.set(threadId, { ...thread, archivedAt: null, canRestoreEnvironment: true });
          return { ok: true };
        },
        restoreEnvironment: async () => ({}),
        update: async () => ({}),
        send: async () => ({}),
        output: async () => ({ output: "Fixed and verified" }),
      },
      plugins: {
        callRpc: async (args) => {
          if (args.method === "specialists_list")
            return {
              specialists: options.missingSpecialist
                ? []
                : [
                    options.lead
                      ? {
                          ...specialist,
                          providerId: "claude-code",
                          model: "lead-model",
                          reasoningLevel: "high",
                        }
                      : specialist,
                  ],
            };
          if (args.pluginId === "automations") {
            const input = args.input as any;
            if (args.method === "automations_list")
              return automations.filter((a) => a.projectId === input.projectId);
            if (args.method === "automations_create") {
              const record = {
                id: `auto-${automations.length + 1}`,
                projectId: input.projectId,
                name: input.name,
                createdByThreadId: input.createdByThreadId ?? null,
                input,
              };
              automations.push(record);
              return record;
            }
            if (args.method === "automations_delete") {
              const at = automations.findIndex((a) => a.id === input.automationId);
              if (at >= 0) automations.splice(at, 1);
              return { ok: true };
            }
          }
          // Envoys hand off themselves; the plugin must never start one.
          if (String(args.method).startsWith("specialists_handoff"))
            handoffCount++;
          return { ok: true };
        },
      },
    },
  });
  const helpers = await registerEnvoys(bb, async () => ({
    preparedProjects: options.prepare ? ["project-1"] : [],
    installCommand: "npm ci",
    handoffSpecialist: options.noHandoff ? "" : "ready-pr",
    issueHosts: options.issueHosts ?? [],
    permissionMode: "full",
  }), (envoy, outcome, text) => reports.push({ name: envoy.name, outcome, text }));
  async function sweep() {
    const service = harness.behavior.runService("envoy-recovery");
    await service.done;
  }
  const create = () =>
    harness.behavior.callRpc("envoys_create", request) as Promise<any>;
  return {
    bb,
    harness,
    helpers,
    create,
    sweep,
    threads,
    metadata,
    options,
    counts: () => ({ spawnCount, handoffCount }),
    automations,
    reports,
  };
}

test("URLs are explicit provider identities, not branch inference or arbitrary endpoints", () => {
  assert.equal(
    issueLink("https://tracker.example.com/team/issue/ABC-123/fix?x=1")?.key,
    "ABC-123",
  );
  assert.equal(
    issueLink("https://github.com/owner/repo/issues/42")?.key,
    "#42",
  );
  assert.equal(issueLink(""), null);
  assert.throws(() => issueLink("http://tracker.example.com/issue/ABC-123"));
  assert.throws(() =>
    issueLink("https://evil.test/team/issue/ABC-123", ["tracker.example.com"]),
  );
  assert.throws(() =>
    issueLink("https://tracker.example.com@evil.test/issue/ABC-123", [
      "tracker.example.com",
    ]),
  );
  assert.throws(() =>
    githubPr("https://github.com/owner/repo/pull/1/../../issues/2"),
  );
  assert.equal(githubPr("https://github.com/owner/repo/pull/123").number, 123);
});

test("without a ready-PR handoff, attached PRs are recorded but never watched", async () => {
  const s = await setup({ noHandoff: true, issueHosts: ["tracker.example.com"] });
  try {
    const envoy = await s.create();
    assert.equal(envoy.issue.key, "ABC-123");
    const spawn = s.harness.inspection.sdk.callsTo("threads.spawn")[0]![0] as any;
    assert.match(spawn.input[0].text, /attached PRs are not watched/);
    assert.doesNotMatch(spawn.input[0].text, /hand the PR off/);
    const attached = (await s.harness.behavior.callRpc("envoys_pr", {
      id: envoy.id,
      url: "https://github.com/owner/repo/pull/123",
      action: "attach",
    })) as any;
    assert.equal(attached.prs.length, 1);
    assert.equal(s.automations.length, 0);
    assert.equal(s.harness.inspection.experimental_hostRpcCalls.length, 0);
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

test("ordinary lead, generated name, stable visible thread, preserved permissions and double-submit dedup", async () => {
  const s = await setup();
  try {
    const [a, b] = await Promise.all([s.create(), s.create()]);
    assert.equal(a.id, b.id);
    assert.equal(s.counts().spawnCount, 1);
    assert.equal(a.name, "Fix login crash");
    assert.equal(a.specialist, null);
    const spawn = s.harness.inspection.sdk.callsTo(
      "threads.spawn",
    )[0]![0] as any;
    assert.equal(spawn.visibility, "visible");
    assert.equal(spawn.permissionMode, "accept-edits");
    assert.equal(spawn.environment.workspace.type, "managed-worktree");
    assert.match(spawn.input[0].text, /DRAFT.*gh pr create --draft/);
    assert.match(spawn.input[0].text, /hand the PR off with specialist_handoff to the ready-pr specialist/);
    const plain = s.helpers.configure(makePluginAgentConfigurationContext());
    assert.deepEqual(plain.tools, []);
    const envoy = s.helpers.configure(
      makePluginAgentConfigurationContext({
        thread: { id: a.threadId },
        pluginMetadata: { envoyId: a.id },
      }),
    );
    assert.deepEqual(envoy.tools, ["envoy_attach_pr"]);
    await s.sweep();
    assert.equal(s.harness.inspection.experimental_hostRpcCalls.length, 0);
    assert.equal(s.counts().handoffCount, 0);
    await s.harness.behavior.callRpc("envoys_update", {
      id: a.id,
      name: "My explicit name",
      issueUrl: "",
    });
    const updated = (await s.harness.behavior.callRpc("envoys_get", {
      threadId: a.threadId,
    })) as any;
    assert.equal(updated.name, "My explicit name");
    assert.equal(updated.issue, null);
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

test("attaching a PR creates one watcher the Envoy owns, and detaching removes it", async () => {
  const s = await setup();
  try {
    const envoy = await s.create();
    const url = "https://github.com/owner/repo/pull/123";
    for (let i = 0; i < 2; i++)
      await s.harness.behavior.callRpc("envoys_pr", { id: envoy.id, url, action: "attach" });
    assert.equal(s.automations.length, 1);
    const watcher = s.automations[0]!;
    assert.equal(watcher.name, `Envoy PR watcher: ${url}`);
    assert.equal(watcher.createdByThreadId, envoy.threadId);
    assert.equal(watcher.input.origin, "agent");
    assert.equal(watcher.input.trigger.triggerType, "schedule");
    assert.equal(watcher.input.execution.mode, "script");
    assert.equal(watcher.input.execution.env.PR_URL, url);
    assert.equal(watcher.input.execution.env.ENVOY_THREAD, envoy.threadId);
    assert.match(watcher.input.execution.env.NOTICE, /^\[PR ready\] .* Hand it off to the ready-pr specialist/);
    // The plugin never polls or starts the specialist itself.
    assert.equal(s.harness.inspection.experimental_hostRpcCalls.length, 0);
    assert.equal(s.counts().handoffCount, 0);
    await s.harness.behavior.callRpc("envoys_pr", { id: envoy.id, url, action: "detach" });
    assert.equal(s.automations.length, 0);
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

test("parking stops implementation descendants but spares the Envoy's own handoff worker", async () => {
  const s = await setup();
  try {
    const envoy = await s.create();
    for (const [id, originPluginId, specialistName] of [
      ["coder", "specialists", "coder"],
      ["handoff", "specialists", "ready-pr"],
      ["helper", null, null],
    ] as const) {
      s.threads.set(
        id,
        makeThreadResponse({
          id,
          status: "active",
          parentThreadId: envoy.threadId,
          projectId: "project-1",
          ...(originPluginId ? { originPluginId } : {}),
        }),
      );
      if (specialistName) s.metadata.set(id, { specialist: specialistName });
    }
    await s.harness.behavior.callRpc("envoys_lifecycle", {
      id: envoy.id,
      lifecycle: "parked",
    });
    const stopped = s.harness.inspection.sdk
      .callsTo("threads.stop")
      .map((c) => (c[0] as any).threadId);
    assert.deepEqual(stopped.sort(), ["coder", "helper", envoy.threadId].sort());
    assert.equal(s.harness.inspection.sdk.callsTo("threads.archive").length, 0);
    assert.equal(
      s.harness.inspection.sdk.callsTo("environments.delete").length,
      0,
    );
    await s.harness.behavior.callRpc("envoys_lifecycle", {
      id: envoy.id,
      lifecycle: "active",
    });
    assert.equal(s.harness.inspection.sdk.callsTo("threads.send").length, 1);
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

test("reload recovers a committed spawn without starting a duplicate", async () => {
  const s = await setup();
  try {
    const envoy = await s.create();
    const db = s.bb.storage.database();
    const stored = {
      ...envoy,
      threadId: null,
      environmentId: null,
      creation: "launching",
      lifecycle: "creating",
    };
    db.prepare("UPDATE envoys SET data=? WHERE id=?").run(
      JSON.stringify(stored),
      envoy.id,
    );
    const fresh = await s.harness.lifecycle.reload(async (bb) => {
      await registerEnvoys(bb);
    });
    try {
      await fresh.harness.behavior.runService("envoy-recovery").done;
      const result = (await fresh.harness.behavior.callRpc("envoys_get", {
        threadId: envoy.threadId,
      })) as any;
      assert.equal(result.id, envoy.id);
      assert.equal(s.counts().spawnCount, 1);
    } finally {
      await fresh.harness.lifecycle.dispose();
    }
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

test("definite rejection retries the same task with corrected selections; uncertainty can be cancelled without relaunching", async () => {
  const s = await setup({
    spawnError: Object.assign(new Error("Invalid model"), { status: 400 }),
  });
  try {
    const failed = await s.create();
    assert.equal(failed.creation, "failed");
    s.options.spawnError = undefined;
    const retried = (await s.harness.behavior.callRpc("envoys_create", {
      ...request,
      name: "Corrected task",
      request: { ...request.request, model: "valid-model" },
    })) as any;
    assert.equal(retried.id, failed.id);
    assert.equal(retried.creation, "ready");
    assert.equal(s.counts().spawnCount, 2);
    const spawn = s.harness.inspection.sdk
      .callsTo("threads.spawn")
      .at(-1)![0] as any;
    assert.equal(spawn.model, "valid-model");
    assert.equal(spawn.executionInputSources.model, "explicit");
  } finally {
    await s.harness.lifecycle.dispose();
  }
  const u = await setup({ spawnError: new Error("Response lost") });
  try {
    const uncertain = await u.create();
    assert.equal(uncertain.creation, "uncertain");
    await u.harness.behavior.callRpc("envoys_retry", { id: uncertain.id });
    assert.equal(u.counts().spawnCount, 1);
    const cancelled = (await u.harness.behavior.callRpc("envoys_lifecycle", {
      id: uncertain.id,
      lifecycle: "cancelled",
    })) as any;
    assert.equal(cancelled.lifecycle, "cancelled");
    await u.sweep();
    assert.equal(u.counts().spawnCount, 1);
  } finally {
    await u.harness.lifecycle.dispose();
  }
});

test("parking, completing and cancelling remove watchers; resuming restores them", async () => {
  const s = await setup();
  try {
    const envoy = await s.create();
    const url = "https://github.com/owner/repo/pull/123";
    await s.harness.behavior.callRpc("envoys_pr", { id: envoy.id, url, action: "attach" });
    assert.equal(s.automations.length, 1);
    await s.harness.behavior.callRpc("envoys_lifecycle", { id: envoy.id, lifecycle: "parked" });
    assert.equal(s.automations.length, 0);
    // Attaching while parked records the PR but leaves nothing running.
    await s.harness.behavior.callRpc("envoys_pr", {
      id: envoy.id,
      url: "https://github.com/owner/repo/pull/124",
      action: "attach",
    });
    assert.equal(s.automations.length, 0);
    await s.harness.behavior.callRpc("envoys_lifecycle", { id: envoy.id, lifecycle: "active" });
    assert.equal(s.automations.length, 2);
    await s.harness.behavior.callRpc("envoys_lifecycle", { id: envoy.id, lifecycle: "cancelled" });
    assert.equal(s.automations.length, 0);
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

test("completing saves the output and archives the thread; resuming unarchives, restores and watches again", async () => {
  const s = await setup();
  try {
    const envoy = await s.create();
    const url = "https://github.com/owner/repo/pull/123";
    await s.harness.behavior.callRpc("envoys_pr", { id: envoy.id, url, action: "attach" });
    const done = (await s.harness.behavior.callRpc("envoys_lifecycle", {
      id: envoy.id,
      lifecycle: "completed",
    })) as any;
    assert.equal(done.lifecycle, "completed");
    assert.equal(done.result, "Fixed and verified");
    assert.equal(s.automations.length, 0);
    const archived = s.harness.inspection.sdk.callsTo("threads.archive").map((c) => (c[0] as any).threadId);
    assert.deepEqual(archived, [envoy.threadId]);
    // A completed Envoy is not watched again on attach.
    await s.harness.behavior.callRpc("envoys_pr", { id: envoy.id, url, action: "attach" });
    assert.equal(s.automations.length, 0);
    // Resuming brings the archived thread and its workspace back.
    await s.harness.behavior.callRpc("envoys_lifecycle", { id: envoy.id, lifecycle: "active" });
    assert.equal(s.harness.inspection.sdk.callsTo("threads.unarchive").length, 1);
    assert.equal(s.harness.inspection.sdk.callsTo("threads.restoreEnvironment").length, 1);
    assert.equal(s.automations.length, 1);
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

test("an archived Envoy thread loses its watchers, and other automations are left alone", async () => {
  const s = await setup();
  try {
    const envoy = await s.create();
    s.automations.push({
      id: "mine",
      projectId: "project-1",
      name: "Nightly report",
      createdByThreadId: envoy.threadId,
      input: {},
    });
    await s.harness.behavior.callRpc("envoys_pr", {
      id: envoy.id,
      url: "https://github.com/owner/repo/pull/123",
      action: "attach",
    });
    await s.harness.behavior.emitThreadEvent("thread.archived", {
      thread: s.threads.get(envoy.threadId)!,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(s.automations.map((a) => a.id), ["mine"]);
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

test("parked and completed Envoys refuse automated messages; a user message resumes them", async () => {
  const s = await setup();
  try {
    const envoy = await s.create();
    const hook = s.harness.inspection.registrations.hooks["message.dispatch"]!;
    const send = (text: string, initiator: "system" | "user") =>
      hook(
        makeMessageDispatchHookContext({
          thread: s.threads.get(envoy.threadId)!,
          initiator,
          input: { text, blocks: [{ type: "text", text, mentions: [] }] },
        } as any),
      );
    for (const lifecycle of ["completed", "parked"] as const) {
      await s.harness.behavior.callRpc("envoys_lifecycle", { id: envoy.id, lifecycle });
      assert.equal((await send("[PR ready] https://github.com/owner/repo/pull/123 is marked ready", "system")).action, "reject");
      assert.equal((await send("Please continue", "user")).action, "proceed");
      const task = (await s.harness.behavior.callRpc("envoys_get", { threadId: envoy.threadId })) as any;
      assert.equal(task.lifecycle, "active");
    }
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

test("lead defaults apply with provenance, while explicit selections and workspace/permissions survive", async () => {
  const s = await setup({ lead: true });
  try {
    for (const explicit of [false, true]) {
      await s.harness.behavior.callRpc("envoys_create", {
        ...request,
        requestId: `lead-${explicit}`,
        specialist: "ready-pr",
        request: {
          ...request.request,
          providerId: "codex",
          model: "user-model",
          reasoningLevel: "low",
          permissionMode: "full",
          executionInputSources: {
            providerId: explicit ? "explicit" : "client-preference",
            model: explicit ? "explicit" : "client-preference",
            reasoningLevel: "client-preference",
            permissionMode: "explicit",
          },
          environment: {
            type: "host",
            hostId: "my-host",
            workspace: { type: "unmanaged", path: "/chosen/workspace" },
          },
        },
      });
      const args = s.harness.inspection.sdk
        .callsTo("threads.spawn")
        .at(-1)![0] as any;
      assert.equal(args.model, explicit ? "user-model" : "lead-model");
      assert.equal(args.providerId, explicit ? "codex" : "claude-code");
      assert.equal(args.reasoningLevel, explicit ? "low" : "high");
      assert.equal(args.permissionMode, "full");
      assert.deepEqual(args.environment, {
        type: "host",
        hostId: "my-host",
        workspace: { type: "unmanaged", path: "/chosen/workspace" },
      });
      assert.equal(args.executionInputSources.model, "explicit");
    }
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

test("prepared projects pin a fresh worktree and never spawn when preparation fails", async () => {
  const s = await setup({ prepare: true, hostError: true });
  try {
    const failed = await s.create();
    assert.equal(failed.creation, "failed");
    assert.match(failed.error, /Source preparation failed/);
    assert.equal(s.counts().spawnCount, 0);
    s.options.hostError = false;
    const ready = await s.create();
    assert.equal(ready.id, failed.id);
    assert.equal(ready.creation, "ready");
    const spawn = s.harness.inspection.sdk.callsTo("threads.spawn")[0]![0] as any;
    assert.deepEqual(spawn.environment, {
      type: "host", hostId: "host-1",
      workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "a".repeat(40) } },
    });
    assert.match(spawn.input[0].text, /run `npm ci` in this workspace/);
    assert.equal((s.harness.inspection.experimental_hostRpcCalls.at(-1) as any).input.installCommand, "npm ci");
    await s.create();
    assert.equal(s.counts().spawnCount, 1);
  } finally { await s.harness.lifecycle.dispose(); }
});

test("prepared projects accept the native worktree picker but reject checkout reuse and branch overrides", async () => {
  const s = await setup({ prepare: true });
  try {
    for (const environment of [
      { type: "reuse", environmentId: "env-base" },
      { type: "host", workspace: { type: "unmanaged", path: "/repo/base" } },
      { type: "provider", environmentProviderId: "git-worktree", inputs: { kind: "existing", path: "/repo/base" } },
      { type: "provider", environmentProviderId: "git-worktree", inputs: { branch: { kind: "named", name: "feature" } } },
    ]) {
      const failed = await s.harness.behavior.callRpc("envoys_create", {
        ...request, request: { ...request.request, environment },
      }) as any;
      assert.equal(failed.creation, "failed");
    }
    assert.equal(s.counts().spawnCount, 0);
    assert.equal(s.harness.inspection.experimental_hostRpcCalls.length, 0);
    const ready = await s.harness.behavior.callRpc("envoys_create", {
      ...request, request: { ...request.request, environment: {
        type: "provider", environmentProviderId: "git-worktree", inputs: {},
        machine: { type: "existing", hostId: "host-1" },
      } },
    }) as any;
    assert.equal(ready.creation, "ready");
    assert.equal(s.counts().spawnCount, 1);
  } finally { await s.harness.lifecycle.dispose(); }
});

test("the CLI documents create's flags and creates through the shared task path", async () => {
  const s = await setup();
  try {
    const ctx = { projectId: "project-1" } as any;
    for (const argv of [[], ["--help"], ["create", "--help"]]) {
      const help = await s.helpers.runCli(argv, ctx);
      assert.equal(help.exitCode, 0);
      assert.match(help.stdout!, /create --task <text> \[--project <project-id>\]/);
    }
    const created = await s.helpers.runCli(
      ["create", "--task", "Fix login crash", "--request-id", "cli-1", "--json"],
      ctx,
    );
    assert.equal(created.exitCode, 0);
    const envoy = JSON.parse(created.stdout!);
    assert.equal(envoy.projectId, "project-1");
    assert.equal(envoy.name, "Fix login crash");
    const again = await s.helpers.createTask({
      task: "Fix login crash",
      projectId: "project-1",
      requestId: "cli-1",
    });
    assert.equal(again.id, envoy.id);
    assert.equal(s.counts().spawnCount, 1);
    const spawn = s.harness.inspection.sdk.callsTo("threads.spawn")[0]![0] as any;
    assert.equal(spawn.environment.workspace.type, "managed-worktree");
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

test("an Envoy reports to its sage only when it needs a decision and the user isn't in the turn", async () => {
  const s = await setup();
  try {
    const quiet = await s.create();
    const envoy = await s.helpers.createTask({
      task: "Fix the search filter",
      projectId: "project-1",
      reportTo: { sageId: "sage-1", name: "Work Allocator" },
    });
    assert.deepEqual(envoy.reportTo, { sageId: "sage-1", name: "Work Allocator" });
    const spawn = s.harness.inspection.sdk.callsTo("threads.spawn").at(-1)![0] as any;
    assert.match(spawn.input[0].text, /started by the sage "Work Allocator"\. When you are blocked or need a decision while the user is not in the conversation/);
    const tools = (threadId: string, envoyId: string) =>
      s.helpers.configure(
        makePluginAgentConfigurationContext({
          thread: { id: threadId },
          pluginMetadata: { envoyId },
        }),
      ).tools;
    assert.deepEqual(tools(envoy.threadId!, envoy.id), ["envoy_attach_pr", "envoy_report"]);
    assert.deepEqual(tools(quiet.threadId!, quiet.id), ["envoy_attach_pr"]);

    // Ending a turn reports nothing on its own.
    await s.harness.behavior.emitThreadEvent("thread.idle", {
      thread: s.threads.get(envoy.threadId!)!,
      lastAssistantText: "Updated the PR",
    } as any);
    assert.equal(s.reports.length, 0);

    const hook = s.harness.inspection.registrations.hooks["message.dispatch"]!;
    const dispatch = (text: string, initiator: "user" | "system" | "agent", attempt = "start-turn") =>
      hook(
        makeMessageDispatchHookContext({
          thread: s.threads.get(envoy.threadId!)!,
          initiator,
          attempt,
          input: { text, blocks: [{ type: "text", text, mentions: [] }] },
        } as any),
      );
    const ask = () =>
      s.harness.behavior.callAgentTool(
        "envoy_report",
        { message: "Should invisible actors count toward the limit?" },
        { threadId: envoy.threadId! },
      );

    // A turn the user started: ask them, not the sage.
    await dispatch("Make the recommended update", "user");
    assert.match(String(await ask()), /Not sent: the user is in this conversation/);
    assert.equal(s.reports.length, 0);

    // A child thread finishing starts an automated turn: the sage hears it.
    await dispatch("[bb system] @thread:child completed", "system");
    assert.match(String(await ask()), /Sent to the sage "Work Allocator"/);
    // The user joining that running turn brings them into it.
    await dispatch("Wait, one more thing", "user", "join-turn");
    assert.match(String(await ask()), /Not sent/);

    // The watcher's notice arrives as a user message but is automated.
    await dispatch("[PR ready] https://github.com/owner/repo/pull/1 is marked ready", "user");
    assert.match(String(await ask()), /Sent to the sage/);
    assert.deepEqual(
      s.reports.map((r) => r.outcome),
      ["needs a decision", "needs a decision"],
    );

    // A failure is reported only when the user wasn't in the turn.
    await s.harness.behavior.emitThreadEvent("thread.failed", {
      thread: s.threads.get(envoy.threadId!)!,
      error: "provider crashed",
    } as any);
    await dispatch("Try again", "user");
    await s.harness.behavior.emitThreadEvent("thread.failed", {
      thread: s.threads.get(envoy.threadId!)!,
      error: "crashed again",
    } as any);
    assert.deepEqual(
      s.reports.map((r) => [r.outcome, r.text]).slice(2),
      [["failed", "provider crashed"]],
    );
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

test("the permission setting applies unless the composer chose one explicitly", async () => {
  const s = await setup();
  try {
    await s.helpers.createTask({ task: "From a sage", projectId: "project-1" });
    await s.harness.behavior.callRpc("envoys_create", {
      ...request,
      requestId: "preference",
      request: {
        ...request.request,
        permissionMode: "auto",
        executionInputSources: { permissionMode: "client-preference" },
      },
    });
    await s.harness.behavior.callRpc("envoys_create", {
      ...request,
      requestId: "explicit",
      request: {
        ...request.request,
        permissionMode: "accept-edits",
        executionInputSources: { permissionMode: "explicit" },
      },
    });
    const modes = s.harness.inspection.sdk
      .callsTo("threads.spawn")
      .map((call) => (call[0] as any).permissionMode);
    assert.deepEqual(modes, ["full", "full", "accept-edits"]);
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

test("the watcher script tells the Envoy once its PR is ready, then removes itself", async () => {
  const { mkdtemp, writeFile, chmod, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "envoy-watcher-"));
  try {
    const log = join(dir, "bb.log");
    // A shell whose PATH holds the fake gh, as the user's shell would.
    await writeFile(join(dir, "shell"), `#!/bin/sh\nprintf '\\n%s' "${dir}:/usr/bin:/bin"\n`);
    await writeFile(
      join(dir, "gh"),
      `#!/bin/sh\ncase "$PR_STATE" in draft) echo draft;; ready) echo ready;; *) echo closed;; esac\n`,
    );
    await writeFile(join(dir, "bb"), `#!/bin/sh\necho "$*" >> "${log}"\n`);
    for (const file of ["shell", "gh", "bb"]) await chmod(join(dir, file), 0o755);
    const run = (state: string) =>
      new Promise<void>((resolve, reject) =>
        execFile(
          "/bin/bash",
          ["-c", WATCHER_SCRIPT],
          {
            env: {
              PATH: "/usr/bin:/bin",
              SHELL: join(dir, "shell"),
              BB_CLI: join(dir, "bb"),
              BB_AUTOMATION_ID: "auto-1",
              BB_PROJECT_ID: "project-1",
              PR_URL: "https://github.com/owner/repo/pull/123",
              ENVOY_THREAD: "thread-1",
              NOTICE: "[PR ready] go",
              PR_STATE: state,
            },
          },
          (error) => (error ? reject(error) : resolve()),
        ),
      );
    const calls = async () =>
      (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
    await run("draft");
    assert.deepEqual(await calls(), []);
    await run("ready");
    assert.deepEqual(await calls(), [
      "thread tell thread-1 [PR ready] go",
      "automation delete auto-1 --project project-1 --yes",
    ]);
    await rm(log);
    await run("closed");
    assert.deepEqual(await calls(), ["automation delete auto-1 --project project-1 --yes"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
