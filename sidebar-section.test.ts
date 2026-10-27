import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { envoySchema, type Envoy } from "./envoy-contract.ts";
import { registerSidebarSection } from "./sidebar-section.ts";

const envoy = (id: string, threadId: string | null, issue = true): Envoy =>
  envoySchema.parse({
    id,
    requestId: `request-${id}`,
    name: id,
    nameSource: "explicit",
    directive: "Fix it",
    projectId: "project-1",
    threadId,
    environmentId: `environment-${id}`,
    lifecycle: "active",
    creation: "ready",
    error: null,
    issue: issue
      ? { key: "WAL-1", url: "https://linear.app/wallet/issue/WAL-1" }
      : null,
    specialist: null,
    prs: [],
    result: null,
    createdAt: "2026-10-26T00:00:00Z",
    updatedAt: "2026-10-26T00:00:00Z",
  });

function setup(
  decorators: Record<string, (input: any) => unknown>,
  hidden: string[] = [],
) {
  const calls: { pluginId: string; input: any }[] = [];
  const order: string[][] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "sages",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({
            id: threadId,
            parentThreadId: threadId === "worker" ? "thread-a" : null,
          }),
      },
      plugins: {
        experimental_discoverRpc: async ({ method }: { method: string }) =>
          Object.keys(decorators).map((pluginId) => ({
            pluginId,
            method,
            displayName: `${pluginId} plugin`,
          })),
        callRpc: async (args: any) => {
          calls.push(args);
          if (args.pluginId === "sidebar-thread-details") return { ok: true };
          return decorators[args.pluginId]!(args.input);
        },
      },
    } as any,
  });
  registerSidebarSection(bb, {
    sages: () => [
      { id: "lead", name: "Wallet", parentId: null },
      { id: "open", name: "Swaps", parentId: "lead", archivedAt: null },
      { id: "closed", name: "Old", parentId: "lead", archivedAt: "2026-01-01" },
    ],
    reorderSages: async (ids) => {
      order.push(ids);
      return ids;
    },
    envoys: () => [envoy("a", "thread-a"), envoy("b", "thread-b", false), envoy("c", null)],
    hiddenBadges: () => hidden,
    activityThrottleMs: 500,
  });
  const get = (threadIds: string[]) =>
    harness.behavior.callRpc("sidebar-section.v1.get", { threadIds }) as Promise<any>;
  return { harness, calls, order, get };
}

test("sections list sages with open acolytes and claim only the asked Envoy threads", async () => {
  const s = setup({});
  const { sections } = await s.get(["thread-a", "unrelated"]);
  const [sages, envoys] = sections;
  assert.deepEqual(
    sages.links.map((l: any) => [l.label, l.children.map((c: any) => c.label)]),
    [["Wallet", ["Swaps"]]],
  );
  assert.deepEqual(envoys.threads.map((t: any) => t.threadId), ["thread-a"]);
  assert.deepEqual(envoys.threads[0].badges[0], {
    label: "[WAL-1]",
    tone: "neutral",
    placement: "meta",
    href: "https://linear.app/wallet/issue/WAL-1",
    title: "https://linear.app/wallet/issue/WAL-1",
  });
  await s.harness.behavior.callRpc("sidebar-section.v1.reorder", {
    sectionId: "sages",
    ids: ["lead"],
  });
  assert.deepEqual(s.order, [["lead"]]);
});

test("decorator badges follow the issue badge; malformed rows and failing decorators add nothing", async () => {
  const s = setup({
    "metro-control": ({ envoys }) => ({
      decorations: [
        { envoyId: "a", badges: [{ label: "Metro :8099", tone: "success" }] },
        { envoyId: "b", badges: [{ label: "" }] },
        ...envoys.map((e: any) => ({ envoyId: e.id, badges: [{ label: "iOS sim", tone: "info" }] })),
      ],
    }),
    broken: () => {
      throw new Error("down");
    },
  });
  const { sections } = await s.get(["thread-a", "thread-b"]);
  const labels = sections[1].threads.map((t: any) => t.badges.map((b: any) => b.label));
  assert.deepEqual(labels, [["[WAL-1]", "Metro :8099", "iOS sim"], ["iOS sim"]]);
  const metroCall = s.calls.find((c) => c.pluginId === "metro-control")!;
  assert.deepEqual(metroCall.input.envoys[0], {
    id: "a",
    threadId: "thread-a",
    projectId: "project-1",
    environmentId: "environment-a",
    lifecycle: "active",
  });
});

test("hidden sources are not asked and the issue badge can be hidden", async () => {
  const s = setup(
    { "metro-control": () => ({ decorations: [] }) },
    ["issue", "metro-control"],
  );
  const { sections } = await s.get(["thread-a"]);
  assert.deepEqual(sections[1].threads[0].badges, []);
  assert.equal(s.calls.length, 0);
  assert.deepEqual(
    await s.harness.behavior.callRpc("envoys_badge_sources", null),
    {
      sources: [
        { id: "issue", label: "Issue link" },
        { id: "metro-control", label: "metro-control plugin" },
      ],
    },
  );
});

test("Envoy activity publishes at once, then at most once per throttle window", async () => {
  const s = setup({});
  const before = Date.now();
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const emit = (event: "thread.active" | "thread.idle", id: string, parentThreadId: string | null) =>
    s.harness.behavior.emitThreadEvent(event, {
      thread: makeThreadResponse({ id, parentThreadId }),
      lastAssistantText: null,
    } as any);
  const activityAt = async () =>
    (await s.get(["thread-a", "thread-b"])).sections[1].threads.map((t: any) => t.activityAt);
  const refreshes = () =>
    s.calls.filter((c: any) => c.pluginId === "sidebar-thread-details").length;

  // A turn nested under Envoy a publishes right away.
  await emit("thread.active", "deep", "worker");
  await emit("thread.idle", "unrelated", null);
  await wait(20);
  const [a] = await activityAt();
  assert.ok(a >= before);

  // Envoy b's turn inside the window waits for the window to end.
  await emit("thread.idle", "thread-b", null);
  await wait(20);
  assert.deepEqual(await activityAt(), [a, null]);
  await wait(900);
  const [, b] = await activityAt();
  assert.ok(b >= a);
  assert.equal(refreshes(), 2);
});
