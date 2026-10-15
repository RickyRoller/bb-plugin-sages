import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
  pretendToBeVisual: true,
});
for (const name of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "NodeFilter",
  "MutationObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "DocumentFragment",
  "HTMLInputElement",
]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: dom.window[name],
  });
}
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(
  dom.window,
);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(
  dom.window,
);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, fireEvent, waitFor } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } =
  await import("@get-bb/plugin-sdk/testing/app");
const { definePluginApp } = await import("@get-bb/plugin-sdk/app");
const { registerEnvoyApp, openNewEnvoy, EnvoyList } =
  await import("./envoys-app.tsx");
const app = await loadPluginApp(definePluginApp(registerEnvoyApp));
const envoy = {
  id: "envoy-1",
  requestId: "r1",
  name: "Fix crash",
  nameSource: "generated",
  directive: "Fix crash",
  projectId: "project-1",
  threadId: "thread-1",
  environmentId: "environment-1",
  lifecycle: "active",
  creation: "ready",
  error: null,
  issue: { key: "WAL-123", url: "https://linear.app/wallet/issue/WAL-123" },
  specialist: null,
  prs: [],
  result: null,
  createdAt: "2026-10-14",
  updatedAt: "2026-10-14",
};
const sdk = {
  threads: {
    get: async () => ({
      id: "thread-1",
      providerId: "codex",
      environmentId: "environment-1",
    }),
    defaultExecutionOptions: async () => ({
      model: "gpt-6.1-sol",
      reasoningLevel: "low",
      permissionMode: "accept-edits",
    }),
  },
  environments: {
    get: async () => ({
      isWorktree: true,
      branchName: "bb/fix-crash",
      path: "/test/worktrees/fix-crash",
    }),
  },
  projects: {
    get: async () => ({ name: "Wallet" }),
    branches: async () => ({
      checkout: { kind: "branch" },
      branches: ["main"],
    }),
    list: async () => [
      {
        id: "project-1",
        name: "Wallet",
        gitRemoteUrl: null,
        sources: [{ hostId: "host-1", isDefault: true }],
      },
    ],
  },
};

test("creation dialog defaults to an ordinary agent, worktree, optional name/issue and navigates to stable task thread", async () => {
  let submitted;
  const slot = renderSlot(
    app.appOverlays[0],
    {},
    {
      sdk,
      rpc: {
        envoys_specialists: () => ({ specialists: [], available: true }),
        envoys_create: (input) => {
          submitted = input;
          return envoy;
        },
      },
    },
  );
  try {
    await act(async () => {
      openNewEnvoy("project-1");
    });
    await waitFor(() =>
      assert.ok(
        document.querySelector('[data-testid="bb-new-thread-composer-input"]'),
      ),
    );
    const composer = document.querySelector(
      '[data-testid="bb-new-thread-composer"]',
    );
    assert.equal(
      JSON.parse(composer.dataset.defaultEnvironment).workspace.type,
      "managed-worktree",
    );
    assert.equal(document.querySelector("select").value, "");
    const task = document.querySelector(
      '[data-testid="bb-new-thread-composer-input"]',
    );
    fireEvent.change(task, { target: { value: "Fix saved-swap crash" } });
    fireEvent.change(
      document.querySelector('input[placeholder^="https://linear"]'),
      { target: { value: envoy.issue.url } },
    );
    fireEvent.click(
      document.querySelector('[data-testid="bb-new-thread-composer-submit"]'),
    );
    await waitFor(() => assert.equal(submitted?.specialist, null));
    assert.equal(submitted.name, "");
    assert.equal(submitted.issueUrl, envoy.issue.url);
    await waitFor(() =>
      assert.ok(
        slot.inspection.navigateCalls.some(
          (call) => call.method === "toThread",
        ),
      ),
    );
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("task list opens the primary thread and renders Linear as a separate link", async () => {
  const slot = renderSlot(
    { component: EnvoyList },
    {},
    { sdk, rpc: { envoys_list: () => ({ envoys: [envoy] }) } },
  );
  try {
    await waitFor(() => assert.ok(slot.queryByText("Fix crash")));
    assert.equal(
      slot.getByText("WAL-123").getAttribute("href"),
      envoy.issue.url,
    );
    fireEvent.click(slot.getByText("Fix crash"));
    assert.ok(
      slot.inspection.navigateCalls.some((call) => call.method === "toThread"),
    );
  } finally {
    slot.lifecycle.unmount();
  }
});

test("chat header exposes task details and attaches a PR without making it ready", async () => {
  let attached;
  const slot = renderSlot(
    app.threadHeaderActions[0],
    { threadId: "thread-1", projectId: "project-1", isCompactViewport: false },
    {
      sdk,
      rpc: {
        envoys_get: () => envoy,
        envoys_pr: (input) => {
          attached = input;
          return envoy;
        },
      },
    },
  );
  try {
    await waitFor(() => assert.ok(slot.queryByText("Envoy · active")));
    fireEvent.click(slot.getByText("Envoy · active"));
    await waitFor(() =>
      assert.ok(slot.queryByText("BB worktree · bb/fix-crash")),
    );
    assert.ok(slot.queryByText("codex · gpt-6.1-sol · low · accept-edits"));
    const input = document.querySelector(
      'input[placeholder^="https://github.com"]',
    );
    fireEvent.change(input, {
      target: { value: "https://github.com/owner/repo/pull/123" },
    });
    fireEvent.click(slot.getByText("Attach PR"));
    await waitFor(() => assert.equal(attached?.action, "attach"));
    assert.equal(attached.id, envoy.id);
    assert.equal(attached.url, "https://github.com/owner/repo/pull/123");
    assert.ok(
      !slot.inspection.rpcCalls.some((call) => call.method.includes("ready")),
    );
  } finally {
    slot.lifecycle.unmount();
  }
});

test("changing a specialist lead never changes the mounted composer's seeds or task draft", async () => {
  const slot = renderSlot(
    app.appOverlays[0],
    {},
    {
      sdk,
      rpc: {
        envoys_specialists: () => ({
          specialists: [
            {
              name: "reviewer",
              description: "Review",
              prompt: "Review",
              providerId: "claude-code",
              model: "lead-model",
              reasoningLevel: "high",
            },
          ],
          available: true,
        }),
      },
    },
  );
  try {
    await act(async () => openNewEnvoy("project-1"));
    await waitFor(() =>
      assert.ok(
        document.querySelector('[data-testid="bb-new-thread-composer"]'),
      ),
    );
    const composer = document.querySelector(
      '[data-testid="bb-new-thread-composer"]',
    );
    const before = { ...composer.dataset };
    const task = document.querySelector(
      '[data-testid="bb-new-thread-composer-input"]',
    );
    fireEvent.change(task, { target: { value: "Keep this task" } });
    fireEvent.change(document.querySelector("select"), {
      target: { value: "reviewer" },
    });
    assert.deepEqual({ ...composer.dataset }, before);
    assert.equal(task.value, "Keep this task");
    fireEvent.change(document.querySelector("select"), {
      target: { value: "" },
    });
    assert.deepEqual({ ...composer.dataset }, before);
  } finally {
    slot.lifecycle.unmount();
  }
});

// SDK 0.6.37's test composer discards onSubmit's promise. Await the
// callback directly here, matching the native composer's rejection contract.
function composerSubmit() {
  const element = document.querySelector(
    '[data-testid="bb-new-thread-composer"]',
  );
  let fiber =
    element[
      Object.keys(element).find((key) => key.startsWith("__reactFiber$"))
    ];
  while (fiber && !fiber.memoizedProps?.onSubmit) fiber = fiber.return;
  assert.ok(fiber?.memoizedProps?.onSubmit);
  return fiber.memoizedProps.onSubmit;
}
test("a rejected launch retains the creation dialog and draft so corrected resubmission uses the same request id", async () => {
  const requests = [];
  const slot = renderSlot(
    app.appOverlays[0],
    {},
    {
      sdk,
      rpc: {
        envoys_specialists: () => ({ specialists: [], available: true }),
        envoys_create: (input) => {
          requests.push(input);
          return requests.length === 1
            ? {
                ...envoy,
                creation: "failed",
                threadId: null,
                error: "Invalid model; correct your selection",
              }
            : envoy;
        },
      },
    },
  );
  try {
    await act(async () => openNewEnvoy("project-1"));
    await waitFor(() =>
      assert.ok(
        document.querySelector('[data-testid="bb-new-thread-composer-input"]'),
      ),
    );
    const task = document.querySelector(
      '[data-testid="bb-new-thread-composer-input"]',
    );
    fireEvent.change(task, { target: { value: "Keep my task directive" } });
    const request = {
      projectId: "project-1",
      environment: { type: "project-default" },
      input: [{ type: "text", text: task.value, mentions: [] }],
    };
    await act(async () =>
      assert.rejects(composerSubmit()(request), /Invalid model/),
    );
    assert.ok(slot.queryByText("Invalid model; correct your selection"));
    assert.ok(document.querySelector('[role="dialog"]'));
    assert.equal(task.value, "Keep my task directive");
    await act(async () => composerSubmit()(request));
    assert.equal(requests.length, 2);
    assert.equal(requests[0].requestId, requests[1].requestId);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("unconfirmed PR handoff relaunch requires the user's confirmation", async () => {
  const task = {
    ...envoy,
    prs: [
      {
        url: "https://github.com/owner/repo/pull/123",
        owner: "owner",
        repo: "repo",
        number: 123,
        state: "ready",
        handoff: "dispatching",
        handoffKey: "key-1",
        handoffThreadId: null,
        watching: false,
        error: "Unknown outcome",
      },
    ],
  };
  const slot = renderSlot(
    app.threadHeaderActions[0],
    { threadId: "thread-1", projectId: "project-1", isCompactViewport: false },
    { sdk, rpc: { envoys_get: () => task, envoys_pr: () => task } },
  );
  try {
    await waitFor(() => assert.ok(slot.queryByText("Envoy · active")));
    fireEvent.click(slot.getByText("Envoy · active"));
    await waitFor(() => assert.ok(slot.queryByText("Relaunch handoff")));
    fireEvent.click(slot.getByText("Relaunch handoff"));
    assert.ok(slot.queryByText("Confirm relaunch"));
    assert.ok(
      !slot.inspection.rpcCalls.some((call) => call.method === "envoys_pr"),
    );
    fireEvent.click(slot.getByText("Confirm relaunch"));
    await waitFor(() =>
      assert.ok(
        slot.inspection.rpcCalls.some(
          (call) =>
            call.method === "envoys_pr" && call.input.action === "relaunch",
        ),
      ),
    );
  } finally {
    slot.lifecycle.unmount();
  }
});
