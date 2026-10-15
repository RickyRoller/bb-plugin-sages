import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFakePluginHost,
  makeThreadResponse,
  makePluginAgentConfigurationContext,
  makeMessageDispatchHookContext,
} from "@get-bb/plugin-sdk/testing";
import { registerEnvoys } from "./envoys.ts";
import { githubPr, linearIssue } from "./envoy-contract.ts";

const specialist = {
  name: "pr-handoff",
  description: "CI and review reminders",
  prompt: "Monitor the PR",
  providerId: null,
  model: null,
  reasoningLevel: null,
};
const request = {
  requestId: "request-1",
  name: "",
  issueUrl: "https://linear.app/wallet/issue/WAL-123/fix",
  specialist: null,
  request: {
    projectId: "project-1",
    environment: {
      type: "host",
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    },
    input: [{ type: "text", text: "Fix saved-swap crash", mentions: [] }],
    permissionMode: "accept-edits",
  },
};
async function setup(
  options: {
    missingSpecialist?: boolean;
    interruptedHandoff?: boolean;
    spawnError?: unknown;
    handoffError?: unknown;
    oldSpecialists?: boolean;
    hostError?: boolean;
    uncertainHandoff?: boolean;
    lead?: boolean;
  } = {},
) {
  let state = "draft";
  let spawnCount = 0;
  let handoffCount = 0;
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const metadata = new Map<string, Record<string, unknown>>();
  const { bb, harness } = createFakePluginHost({
    pluginId: "sages",
    experimental_hostEntry: true,
    experimental_callHostRpc: async () => {
      if (options.hostError) throw new Error("Host temporarily offline");
      return { state, head: "head-1" };
    },
    sdk: {
      projects: {
        list: async () => [
          { id: "project-1", name: "Wallet", kind: "standard" },
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
        unarchive: async () => ({ ok: true }),
        update: async () => ({}),
        send: async () => ({}),
        output: async () => ({ output: "Fixed and verified" }),
      },
      plugins: {
        callRpc: async (args) => {
          const input = args.input as Record<string, unknown>;
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
          if (args.method === "specialists_handoff_capabilities") {
            if (options.oldSpecialists)
              throw new Error("unknown_method: update Specialists");
            return { keyedHandoffVersion: 1 };
          }
          if (args.method === "specialists_handoff_keyed") {
            if (options.uncertainHandoff && !input.relaunchUncertain)
              return {
                status: "uncertain",
                threadId: null,
                error: "Unknown launch outcome",
              };
            if (options.handoffError)
              return {
                status: "failed",
                threadId: null,
                error: String(options.handoffError),
              };
            handoffCount++;
            const thread = makeThreadResponse({
              id: `worker-${handoffCount}`,
              projectId: "project-1",
              environmentId: "environment-1",
              parentThreadId: String(input.parentThreadId),
              originPluginId: "specialists",
            });
            threads.set(thread.id, thread);
            metadata.set(thread.id, { handoffKey: input.handoffKey });
            if (options.interruptedHandoff)
              throw new Error("Response interrupted after commit");
            return { status: "started", threadId: thread.id, error: null };
          }
          return { ok: true };
        },
      },
    },
  });
  const helpers = await registerEnvoys(bb);
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
    setState: (next: string) => {
      state = next;
    },
    counts: () => ({ spawnCount, handoffCount }),
  };
}

test("URLs are explicit provider identities, not branch inference or arbitrary endpoints", () => {
  assert.equal(
    linearIssue("https://linear.app/wallet/issue/WAL-123/fix?x=1")?.key,
    "WAL-123",
  );
  assert.equal(linearIssue(""), null);
  assert.throws(() => linearIssue("https://evil.test/wallet/issue/WAL-123"));
  assert.throws(() =>
    linearIssue("https://linear.app@evil.test/wallet/issue/WAL-123"),
  );
  assert.throws(() =>
    githubPr("https://github.com/owner/repo/pull/1/../../issues/2"),
  );
  assert.equal(githubPr("https://github.com/owner/repo/pull/123").number, 123);
});

test("ordinary lead, generated name, stable visible thread, preserved permissions and double-submit dedup", async () => {
  const s = await setup();
  try {
    const [a, b] = await Promise.all([s.create(), s.create()]);
    assert.equal(a.id, b.id);
    assert.equal(s.counts().spawnCount, 1);
    assert.equal(a.name, "Fix saved-swap crash");
    assert.equal(a.specialist, null);
    const spawn = s.harness.inspection.sdk.callsTo(
      "threads.spawn",
    )[0]![0] as any;
    assert.equal(spawn.visibility, "visible");
    assert.equal(spawn.permissionMode, "accept-edits");
    assert.equal(spawn.environment.workspace.type, "managed-worktree");
    assert.match(spawn.input[0].text, /DRAFT.*gh pr create --draft/);
    assert.match(spawn.input[0].text, /pr-handoff/);
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

test("draft attachment activates reads, readiness triggers exactly one parented handoff, detaching stops reads", async () => {
  const s = await setup();
  try {
    const envoy = await s.create();
    const url = "https://github.com/owner/repo/pull/123";
    await s.harness.behavior.callRpc("envoys_pr", {
      id: envoy.id,
      url,
      action: "attach",
    });
    await s.sweep();
    assert.equal(s.harness.inspection.experimental_hostRpcCalls.length, 1);
    assert.equal(s.counts().handoffCount, 0);
    s.setState("ready");
    await s.sweep();
    await s.sweep();
    assert.equal(s.counts().handoffCount, 1);
    const handoff = s.harness.inspection.sdk
      .callsTo("plugins.callRpc")
      .find(
        (call) => (call[0] as any).method === "specialists_handoff_keyed",
      )![0] as any;
    assert.equal(handoff.input.parentThreadId, envoy.threadId);
    assert.equal(handoff.input.environmentId, "environment-1");
    assert.match(handoff.input.handoffKey, /envoy-pr:/);
    assert.match(handoff.input.task, /six-hour/);
    await s.harness.behavior.callRpc("envoys_pr", {
      id: envoy.id,
      url,
      action: "detach",
    });
    const reads = s.harness.inspection.experimental_hostRpcCalls.length;
    await s.sweep();
    assert.equal(s.harness.inspection.experimental_hostRpcCalls.length, reads);
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

test("parking stops implementation descendants and preserves the workspace and PR monitor", async () => {
  const s = await setup();
  try {
    const envoy = await s.create();
    s.threads.set(
      "coder",
      makeThreadResponse({
        id: "coder",
        status: "active",
        parentThreadId: envoy.threadId,
        projectId: "project-1",
      }),
    );
    await s.harness.behavior.callRpc("envoys_pr", {
      id: envoy.id,
      url: "https://github.com/owner/repo/pull/123",
      action: "attach",
    });
    s.setState("ready");
    await s.sweep();
    await s.harness.behavior.callRpc("envoys_lifecycle", {
      id: envoy.id,
      lifecycle: "parked",
    });
    const stopped = s.harness.inspection.sdk
      .callsTo("threads.stop")
      .map((c) => (c[0] as any).threadId);
    assert.deepEqual(stopped.sort(), ["coder", envoy.threadId].sort());
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

test("PR monitoring allocates no timer before attachment and stops after closure or merge", async (t) => {
  const s = await setup();
  const timer = t.mock.method(globalThis, "setTimeout");
  try {
    const envoy = await s.create();
    await s.sweep();
    assert.equal(timer.mock.calls.length, 0);
    for (const [number, state] of [
      [1, "closed"],
      [2, "merged"],
    ] as const) {
      const url = `https://github.com/owner/repo/pull/${number}`;
      await s.harness.behavior.callRpc("envoys_pr", {
        id: envoy.id,
        url,
        action: "attach",
      });
      s.setState(state);
      await s.sweep();
      const reads = s.harness.inspection.experimental_hostRpcCalls.length;
      await s.sweep();
      assert.equal(
        s.harness.inspection.experimental_hostRpcCalls.length,
        reads,
      );
      const stored = (await s.harness.behavior.callRpc("envoys_get", {
        threadId: envoy.threadId,
      })) as any;
      assert.equal(stored.prs.at(-1).watching, false);
    }
    assert.equal(s.counts().handoffCount, 0);
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

test("an already-ready PR recovers an interrupted handoff and detach/reattach retains one worker", async () => {
  const s = await setup({ interruptedHandoff: true });
  try {
    const envoy = await s.create();
    const url = "https://github.com/owner/repo/pull/123";
    s.setState("ready");
    await s.harness.behavior.callRpc("envoys_pr", {
      id: envoy.id,
      url,
      action: "attach",
    });
    await s.sweep();
    await s.sweep();
    assert.equal(s.counts().handoffCount, 1);
    let stored = (await s.harness.behavior.callRpc("envoys_get", {
      threadId: envoy.threadId,
    })) as any;
    assert.equal(stored.prs[0].handoffThreadId, "worker-1");
    assert.equal(stored.prs[0].error, null);
    await s.harness.behavior.callRpc("envoys_pr", {
      id: envoy.id,
      url,
      action: "detach",
    });
    await s.harness.behavior.callRpc("envoys_pr", {
      id: envoy.id,
      url: "https://github.com/OWNER/Repo/pull/123",
      action: "attach",
    });
    await s.sweep();
    assert.equal(s.counts().handoffCount, 1);
    stored = (await s.harness.behavior.callRpc("envoys_get", {
      threadId: envoy.threadId,
    })) as any;
    assert.equal(stored.prs[0].handoff, "started");
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

test("missing mandatory specialist is surfaced and a parked Envoy is not restarted by an alert", async () => {
  const s = await setup({ missingSpecialist: true });
  try {
    const envoy = await s.create();
    await s.harness.behavior.callRpc("envoys_lifecycle", {
      id: envoy.id,
      lifecycle: "parked",
    });
    await s.harness.behavior.callRpc("envoys_pr", {
      id: envoy.id,
      url: "https://github.com/owner/repo/pull/123",
      action: "attach",
    });
    s.setState("ready");
    await s.sweep();
    const stored = (await s.harness.behavior.callRpc("envoys_get", {
      threadId: envoy.threadId,
    })) as any;
    assert.match(stored.prs[0].error, /pr-handoff specialist is unavailable/);
    assert.equal(s.harness.inspection.sdk.callsTo("threads.send").length, 0);
    assert.equal(s.counts().handoffCount, 0);
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

test("cancel stops PR follow-up and monitors, completed tasks keep follow-up, parked completion notices cannot restart implementation", async () => {
  for (const lifecycle of ["completed", "cancelled"] as const) {
    const s = await setup();
    try {
      const envoy = await s.create();
      const url = "https://github.com/owner/repo/pull/123";
      await s.harness.behavior.callRpc("envoys_pr", {
        id: envoy.id,
        url,
        action: "attach",
      });
      await s.harness.behavior.callRpc("envoys_lifecycle", {
        id: envoy.id,
        lifecycle,
      });
      s.setState("ready");
      await s.sweep();
      assert.equal(s.counts().handoffCount, lifecycle === "completed" ? 1 : 0);
      if (lifecycle === "cancelled")
        assert.equal(s.harness.inspection.experimental_hostRpcCalls.length, 0);
    } finally {
      await s.harness.lifecycle.dispose();
    }
  }
  const s = await setup();
  try {
    const envoy = await s.create();
    await s.harness.behavior.callRpc("envoys_lifecycle", {
      id: envoy.id,
      lifecycle: "parked",
    });
    const hook = s.harness.inspection.registrations.hooks["message.dispatch"]!;
    const automated = await hook(
      makeMessageDispatchHookContext({
        thread: s.threads.get(envoy.threadId)!,
        initiator: "system",
      }),
    );
    assert.equal(automated.action, "reject");
    const user = await hook(
      makeMessageDispatchHookContext({
        thread: s.threads.get(envoy.threadId)!,
        initiator: "user",
      }),
    );
    assert.equal(user.action, "proceed");
    const task = (await s.harness.behavior.callRpc("envoys_get", {
      threadId: envoy.threadId,
    })) as any;
    assert.equal(task.lifecycle, "active");
    await s.harness.behavior.callRpc("envoys_lifecycle", {
      id: envoy.id,
      lifecycle: "active",
    });
    assert.equal(
      s.harness.inspection.sdk.callsTo("threads.unarchive").length,
      0,
    );
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

test("host errors back off and failed handoffs pause polling and Retry makes progress; older Specialists fail closed", async () => {
  for (const options of [
    { hostError: true },
    { handoffError: "Rejected before commit" },
    { oldSpecialists: true },
  ]) {
    const s = await setup(options);
    try {
      const envoy = await s.create();
      const url = "https://github.com/owner/repo/pull/123";
      s.setState("ready");
      await s.harness.behavior.callRpc("envoys_pr", {
        id: envoy.id,
        url,
        action: "attach",
      });
      await s.sweep();
      const reads = s.harness.inspection.experimental_hostRpcCalls.length;
      await s.sweep();
      assert.equal(
        s.harness.inspection.experimental_hostRpcCalls.length,
        reads,
      );
      assert.equal(s.counts().handoffCount, 0);
      const task = (await s.harness.behavior.callRpc("envoys_get", {
        threadId: envoy.threadId,
      })) as any;
      assert.equal(task.prs[0].watching, !!options.hostError);
      s.options.hostError = false;
      s.options.handoffError = undefined;
      s.options.oldSpecialists = false;
      await s.harness.behavior.callRpc("envoys_pr", {
        id: envoy.id,
        url,
        action: "retry",
      });
      await s.sweep();
      assert.equal(s.counts().handoffCount, 1);
    } finally {
      await s.harness.lifecycle.dispose();
    }
  }
});

test("lead defaults apply with provenance, while explicit selections and workspace/permissions survive", async () => {
  const s = await setup({ lead: true });
  try {
    for (const explicit of [false, true]) {
      await s.harness.behavior.callRpc("envoys_create", {
        ...request,
        requestId: `lead-${explicit}`,
        specialist: "pr-handoff",
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

test("unconfirmed PR handoff needs explicit relaunch and cancel stops an existing worker and late child", async () => {
  const s = await setup({ uncertainHandoff: true });
  try {
    const envoy = await s.create();
    const url = "https://github.com/owner/repo/pull/123";
    s.setState("ready");
    await s.harness.behavior.callRpc("envoys_pr", {
      id: envoy.id,
      url,
      action: "attach",
    });
    await s.sweep();
    await s.harness.behavior.callRpc("envoys_pr", {
      id: envoy.id,
      url,
      action: "retry",
    });
    await s.sweep();
    assert.equal(s.counts().handoffCount, 0);
    await s.harness.behavior.callRpc("envoys_pr", {
      id: envoy.id,
      url,
      action: "relaunch",
    });
    await s.sweep();
    assert.equal(s.counts().handoffCount, 1);
    const worker = s.threads.get("worker-1")!;
    s.threads.set(worker.id, { ...worker, status: "active" });
    await s.harness.behavior.callRpc("envoys_lifecycle", {
      id: envoy.id,
      lifecycle: "cancelled",
    });
    assert.ok(
      s.harness.inspection.sdk
        .callsTo("threads.stop")
        .some((args) => (args[0] as any).threadId === worker.id),
    );
    const hook = s.harness.inspection.registrations.hooks["message.dispatch"]!;
    assert.equal(
      (
        await hook(
          makeMessageDispatchHookContext({
            thread: s.threads.get(envoy.threadId)!,
            initiator: "user",
          }),
        )
      ).action,
      "reject",
    );
    await s.harness.behavior.emitThreadEvent("thread.active", {
      thread: worker,
    });
    assert.equal(
      (s.harness.inspection.sdk.callsTo("threads.stop").at(-1)![0] as any)
        .threadId,
      worker.id,
    );
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

test("read-only host failures recover automatically after backoff without a Retry click", async () => {
  const s = await setup({ hostError: true });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const envoy = await s.create();
    const url = "https://github.com/owner/repo/pull/123";
    await s.harness.behavior.callRpc("envoys_pr", {
      id: envoy.id,
      url,
      action: "attach",
    });
    await s.sweep();
    s.options.hostError = false;
    s.setState("ready");
    now += 60_001;
    await s.sweep();
    assert.equal(s.counts().handoffCount, 1);
  } finally {
    Date.now = realNow;
    await s.harness.lifecycle.dispose();
  }
});
