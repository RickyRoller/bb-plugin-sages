import { useCallback, useEffect, useRef, useState } from "react";
import {
  experimental_NewThreadComposer as NewThreadComposer,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSdk,
  UrlLink,
  type PluginAppBuilder,
  type PluginThreadHeaderActionProps,
  type NewThreadRequest,
} from "@get-bb/plugin-sdk/app";
import {
  envoyRpcContract,
  type Envoy,
  type Specialist,
} from "./envoy-contract";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog";

const OPEN_EVENT = "sages:new-envoy";
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const SELECT = "h-9 rounded-md border border-input bg-transparent px-3 text-sm";
export function openNewEnvoy(projectId?: string) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { projectId } }));
}
function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  ) : null;
}

function NewEnvoyDialog({
  onClose,
  initialProject,
}: {
  onClose: () => void;
  initialProject?: string;
}) {
  const rpc = useRpc<typeof envoyRpcContract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const [name, setName] = useState("");
  const [issueUrl, setIssueUrl] = useState("");
  const [specialist, setSpecialist] = useState("");
  const [available, setAvailable] = useState<Specialist[]>([]);
  const [project, setProject] = useState<{ id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  useEffect(() => {
    let stale = false;
    sdk.projects.list().then(
      async (projects) => {
        const selected =
          projects.find((p) => p.id === initialProject) ?? projects[0];
        if (!selected) return;
        if (!stale) setProject({ id: selected.id });
      },
      (cause) => {
        if (!stale) setError(errorText(cause));
      },
    );
    rpc.call("envoys_specialists").then(
      (result) => {
        if (!stale) setAvailable(result.specialists);
      },
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [rpc, sdk, initialProject]);
  const submit = async (request: NewThreadRequest) => {
    if (pending) throw new Error("This task is already being created");
    setPending(true);
    setError(null);
    try {
      const envoy = await rpc.call("envoys_create", {
        requestId: requestId.current,
        name,
        issueUrl,
        specialist: specialist || null,
        request: JSON.parse(JSON.stringify(request)),
      });
      if (envoy.creation === "failed")
        throw new Error(
          envoy.error ??
            "Task launch was rejected; adjust your selections and try again.",
        );
      onClose();
      if (envoy.threadId) navigate.toThread(envoy.threadId);
      else navigate.toPluginPanel("sages", { subPath: "envoys" });
    } catch (cause) {
      setError(errorText(cause));
      throw cause;
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value && !pending) onClose();
      }}
    >
      <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Envoy</DialogTitle>
          <DialogDescription>
            A workspace and chat for one task. Specialists can help when
            appropriate.
          </DialogDescription>
        </DialogHeader>
        <label className="space-y-1 text-sm">
          Name <span className="text-muted-foreground">(optional)</span>
          <Input
            value={name}
            maxLength={80}
            disabled={pending}
            onChange={(e) => setName(e.target.value)}
            placeholder="Generated from the task if left blank"
          />
        </label>
        <label className="space-y-1 text-sm">
          Linear issue <span className="text-muted-foreground">(optional)</span>
          <Input
            value={issueUrl}
            maxLength={2000}
            disabled={pending}
            onChange={(e) => setIssueUrl(e.target.value)}
            placeholder="https://linear.app/workspace/issue/WAL-123"
          />
        </label>
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">
            Optional specialist lead
          </summary>
          <label className="mt-2 flex flex-col gap-1 text-sm">
            Lead
            <select
              className={SELECT}
              value={specialist}
              disabled={pending}
              onChange={(e) => setSpecialist(e.target.value)}
            >
              <option value="">Ordinary BB agent</option>
              {available.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name} — {s.description}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-2 text-xs text-muted-foreground">
            The lead's saved execution defaults apply at launch unless you
            explicitly select your own provider, model or reasoning level.
            Changing the lead preserves your composer selections.
          </p>
        </details>
        <ErrorLine error={error} />
        {project ? (
          <div className="min-h-64 shrink-0">
            <NewThreadComposer
              draftKey="envoy:new"
              defaultProjectId={project.id}
              defaultEnvironment={{
                type: "host",
                workspace: {
                  type: "managed-worktree",
                  baseBranch: { kind: "default" },
                },
              }}
              placeholder="Describe the task and what done should look like…"
              onSubmit={submit}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Select or create a BB project to start an Envoy.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Use the workspace controls to choose the machine and base branch. Git
          projects start in a new worktree. Pull requests open as drafts;
          marking one ready starts the PR handoff.
        </p>
      </DialogContent>
    </Dialog>
  );
}
function EnvoyOverlay() {
  const [creation, setCreation] = useState<{ projectId?: string } | null>(null);
  useEffect(() => {
    const open = (event: Event) =>
      setCreation((event as CustomEvent<{ projectId?: string }>).detail ?? {});
    window.addEventListener(OPEN_EVENT, open);
    return () => window.removeEventListener(OPEN_EVENT, open);
  }, []);
  return creation ? (
    <NewEnvoyDialog
      initialProject={creation.projectId}
      onClose={() => setCreation(null)}
    />
  ) : null;
}
function useEnvoys() {
  const rpc = useRpc<typeof envoyRpcContract>();
  const [envoys, setEnvoys] = useState<Envoy[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    rpc.call("envoys_list").then(
      (result) => {
        setEnvoys(result.envoys);
        setError(null);
      },
      (cause) => setError(errorText(cause)),
    );
  }, [rpc]);
  useEffect(refresh, [refresh]);
  useRealtime("envoys-changed", refresh);
  return { rpc, envoys, error, setError };
}
export function EnvoyList() {
  const { rpc, envoys, error, setError } = useEnvoys();
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const [projects, setProjects] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("active");
  const [projectFilter, setProjectFilter] = useState("");
  useEffect(() => {
    sdk.projects.list().then(
      (list) =>
        setProjects(Object.fromEntries(list.map((p) => [p.id, p.name]))),
      () => {},
    );
  }, [sdk]);
  const visible = envoys.filter(
    (e) =>
      (!projectFilter || e.projectId === projectFilter) &&
      (filter === "all" ||
        (filter === "active"
          ? e.lifecycle === "active" || e.lifecycle === "creating"
          : e.lifecycle === filter)),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          A workspace and chat for one task.
        </p>
        <Button onClick={() => openNewEnvoy(projectFilter || undefined)}>
          New Envoy
        </Button>
      </div>
      <div className="flex gap-2">
        <select
          className={SELECT}
          aria-label="Filter task state"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          {["active", "parked", "completed", "cancelled", "all"].map(
            (state) => (
              <option key={state} value={state}>
                {state === "active"
                  ? "Active tasks"
                  : state[0]!.toUpperCase() + state.slice(1)}
              </option>
            ),
          )}
        </select>
        <select
          className={SELECT}
          aria-label="Filter project"
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
        >
          <option value="">All projects</option>
          {Object.entries(projects).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <ErrorLine error={error} />
      <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto rounded-lg border border-border">
        {visible.map((envoy) => (
          <li className="space-y-1 px-4 py-3 text-sm" key={envoy.id}>
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                className="min-w-0 truncate text-left font-medium hover:underline"
                disabled={!envoy.threadId}
                onClick={() => navigate.toThread(envoy.threadId!)}
              >
                {envoy.name}
              </button>
              {envoy.issue ? (
                <UrlLink
                  href={envoy.issue.url}
                  className="shrink-0 text-xs text-muted-foreground"
                >
                  {envoy.issue.key}
                </UrlLink>
              ) : null}
              <span className="ml-auto text-xs text-muted-foreground">
                {envoy.lifecycle}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {projects[envoy.projectId] ?? envoy.projectId}
              {envoy.specialist ? ` · ${envoy.specialist}` : ""}
            </p>
            <ErrorLine error={envoy.error} />
            {!envoy.threadId && envoy.lifecycle !== "cancelled" ? (
              <div className="flex gap-3">
                <Button
                  variant="ghost"
                  className="h-7 px-0 text-xs"
                  onClick={() =>
                    void rpc
                      .call("envoys_retry", { id: envoy.id })
                      .catch((cause) => setError(errorText(cause)))
                  }
                >
                  {envoy.creation === "failed"
                    ? "Relaunch task"
                    : "Recover task thread"}
                </Button>
                <Button
                  variant="ghost"
                  className="h-7 px-0 text-xs"
                  onClick={() =>
                    void rpc
                      .call("envoys_lifecycle", {
                        id: envoy.id,
                        lifecycle: "cancelled",
                      })
                      .catch((cause) => setError(errorText(cause)))
                  }
                >
                  Cancel task
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {!visible.length ? (
        <p className="text-sm text-muted-foreground">No tasks in this view.</p>
      ) : null}
    </div>
  );
}
function EnvoyHeader({ threadId }: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof envoyRpcContract>();
  const [envoy, setEnvoy] = useState<Envoy | null>(null);
  const [open, setOpen] = useState(false);
  const refresh = useCallback(() => {
    rpc.call("envoys_get", { threadId }).then(setEnvoy, () => setEnvoy(null));
  }, [rpc, threadId]);
  useEffect(refresh, [refresh]);
  useRealtime("envoys-changed", refresh);
  return envoy ? (
    <div className="flex items-center gap-2">
      {envoy.issue ? (
        <UrlLink href={envoy.issue.url} className="text-xs">
          {envoy.issue.key}
        </UrlLink>
      ) : null}
      <Button
        variant="ghost"
        className="h-7 px-2 text-xs"
        onClick={() => setOpen(true)}
      >
        Envoy · {envoy.lifecycle}
      </Button>
      {open ? (
        <EnvoyDetails envoy={envoy} onClose={() => setOpen(false)} />
      ) : null}
    </div>
  ) : null;
}
function EnvoyDetails({
  envoy,
  onClose,
}: {
  envoy: Envoy;
  onClose: () => void;
}) {
  const rpc = useRpc<typeof envoyRpcContract>();
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const [context, setContext] = useState<string[]>([]);
  useEffect(() => {
    let stale = false;
    void (async () => {
      const [project, thread, execution] = await Promise.allSettled([
        sdk.projects.get({ projectId: envoy.projectId }),
        envoy.threadId
          ? sdk.threads.get({ threadId: envoy.threadId })
          : Promise.resolve(null),
        envoy.threadId
          ? sdk.threads.defaultExecutionOptions({ threadId: envoy.threadId })
          : Promise.resolve(null),
      ]);
      const lines: string[] = [];
      if (project.status === "fulfilled") lines.push(project.value.name);
      if (thread.status === "fulfilled" && thread.value) {
        const options =
          execution.status === "fulfilled" ? execution.value : null;
        lines.push(
          [
            thread.value.providerId,
            options?.model,
            options?.reasoningLevel,
            options?.permissionMode,
          ]
            .filter(Boolean)
            .join(" · "),
        );
        if (thread.value.environmentId) {
          try {
            const workspace = await sdk.environments.get({
              environmentId: thread.value.environmentId,
            });
            lines.push(
              [
                workspace.isWorktree ? "BB worktree" : "Workspace",
                workspace.branchName,
              ]
                .filter(Boolean)
                .join(" · "),
            );
            if (workspace.path) lines.push(workspace.path);
          } catch {
            lines.push("Workspace details unavailable");
          }
        } else lines.push("Preparing workspace");
      }
      if (!stale) setContext(lines);
    })().catch(() => {});
    return () => {
      stale = true;
    };
  }, [sdk, envoy.projectId, envoy.threadId, envoy.environmentId]);
  const [name, setName] = useState(envoy.name);
  const [issue, setIssue] = useState(envoy.issue?.url ?? "");
  const [prUrl, setPrUrl] = useState("");
  const [relaunchPr, setRelaunchPr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(work: () => Promise<unknown>) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Envoy details</DialogTitle>
          <DialogDescription>
            {envoy.lifecycle} · {envoy.specialist ?? "BB agent"}
          </DialogDescription>
        </DialogHeader>
        {context.length ? (
          <div className="space-y-1 text-xs text-muted-foreground">
            {context.map((line, index) => (
              <p className="break-all" key={index}>
                {line}
              </p>
            ))}
          </div>
        ) : null}
        <p className="whitespace-pre-wrap text-sm">{envoy.directive}</p>
        <label className="space-y-1 text-sm">
          Name
          <Input
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="space-y-1 text-sm">
          Linear issue
          <Input
            value={issue}
            maxLength={2000}
            onChange={(e) => setIssue(e.target.value)}
          />
        </label>
        <Button
          disabled={pending || !name.trim()}
          onClick={() =>
            void run(() =>
              rpc.call("envoys_update", {
                id: envoy.id,
                name,
                issueUrl: issue,
              }),
            )
          }
        >
          Save details
        </Button>
        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-sm font-medium">Pull requests</p>
          <p className="text-xs text-muted-foreground">
            Only attached PRs are checked. Open drafts; mark ready yourself or
            ask this Envoy. Readiness starts pr-handoff.
          </p>
          {envoy.prs.map((pr) => (
            <div
              className="space-y-1 rounded-md border border-border p-2 text-sm"
              key={pr.url}
            >
              <UrlLink href={pr.url}>
                {pr.owner}/{pr.repo} #{pr.number}
              </UrlLink>
              <p className="text-xs text-muted-foreground">
                {pr.state} ·{" "}
                {pr.handoff === "started"
                  ? "PR handoff started"
                  : pr.watching
                    ? "Watching readiness"
                    : "Monitoring stopped"}
              </p>
              <ErrorLine error={pr.error} />
              {pr.handoffThreadId ? (
                <button
                  className="text-xs underline"
                  type="button"
                  onClick={() => navigate.toThread(pr.handoffThreadId!)}
                >
                  Open pr-handoff
                </button>
              ) : null}
              <div className="flex gap-2">
                {pr.error ||
                (!pr.watching &&
                  pr.handoff !== "started" &&
                  !["closed", "merged"].includes(pr.state)) ? (
                  <Button
                    className="h-7 text-xs"
                    disabled={pending || envoy.lifecycle === "cancelled"}
                    variant="ghost"
                    onClick={() =>
                      void run(() =>
                        rpc.call("envoys_pr", {
                          id: envoy.id,
                          url: pr.url,
                          action: "retry",
                        }),
                      )
                    }
                  >
                    {pr.handoff === "pending"
                      ? "Resume monitoring"
                      : "Retry handoff"}
                  </Button>
                ) : null}
                {pr.handoff === "dispatching" &&
                !pr.handoffThreadId &&
                !pr.watching ? (
                  <Button
                    className="h-7 text-xs"
                    disabled={pending || envoy.lifecycle === "cancelled"}
                    variant="ghost"
                    onClick={() => setRelaunchPr(pr.url)}
                  >
                    Relaunch handoff
                  </Button>
                ) : null}
                <Button
                  className="h-7 text-xs"
                  disabled={pending}
                  variant="ghost"
                  onClick={() =>
                    void run(() =>
                      rpc.call("envoys_pr", {
                        id: envoy.id,
                        url: pr.url,
                        action: "detach",
                      }),
                    )
                  }
                >
                  Detach
                </Button>
              </div>
            </div>
          ))}
          <label className="space-y-1 text-sm">
            Attach a PR
            <Input
              placeholder="https://github.com/owner/repo/pull/123"
              value={prUrl}
              maxLength={2000}
              onChange={(e) => setPrUrl(e.target.value)}
            />
          </label>
          <Button
            disabled={pending || !prUrl.trim()}
            variant="outline"
            onClick={() =>
              void run(async () => {
                await rpc.call("envoys_pr", {
                  id: envoy.id,
                  url: prUrl,
                  action: "attach",
                });
                setPrUrl("");
              })
            }
          >
            Attach PR
          </Button>
        </div>
        {relaunchPr ? (
          <div
            role="alertdialog"
            aria-label="Confirm handoff relaunch"
            className="space-y-2 rounded-md border border-border p-3"
          >
            <p className="text-sm">
              Recovery will search again for the original worker. If none is
              found, launch another? An earlier request may still finish and
              create a duplicate worker.
            </p>
            <div className="flex gap-2">
              <Button
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    await rpc.call("envoys_pr", {
                      id: envoy.id,
                      url: relaunchPr,
                      action: "relaunch",
                    });
                    setRelaunchPr(null);
                  })
                }
              >
                Confirm relaunch
              </Button>
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => setRelaunchPr(null)}
              >
                Keep recovering
              </Button>
            </div>
          </div>
        ) : null}
        <ErrorLine error={error ?? envoy.error} />
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          {(
            [
              envoy.lifecycle === "active" ? "parked" : "active",
              "completed",
              "cancelled",
            ] as const
          )
            .filter((state) => state !== envoy.lifecycle)
            .map((state) => (
              <Button
                key={state}
                disabled={pending}
                variant="outline"
                onClick={() =>
                  void run(() =>
                    rpc.call("envoys_lifecycle", {
                      id: envoy.id,
                      lifecycle: state,
                    }),
                  )
                }
              >
                {state === "active"
                  ? "Resume task"
                  : state === "parked"
                    ? "Park task"
                    : state === "completed"
                      ? "Mark completed"
                      : "Cancel task"}
              </Button>
            ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Parking preserves the workspace and chat. Attached PR monitoring and
          scheduled review reminders continue. Completing a task also preserves
          PR follow-up. Cancelling stops readiness monitoring and handoff
          agents; any already-scheduled reminder is managed separately in
          Automations. After resuming a cancelled task, open its pr-handoff
          thread to resume a stopped worker. Sending a user message to a parked
          or completed task resumes the task; automated notices do not.
        </p>
      </DialogContent>
    </Dialog>
  );
}
export function registerEnvoyApp(app: PluginAppBuilder) {
  app.slots.experimental_appOverlay({
    id: "envoy-create",
    component: EnvoyOverlay,
  });
  app.commands.register({
    id: "new-envoy",
    title: "New Envoy",
    run: ({ projectId }) => openNewEnvoy(projectId ?? undefined),
  });
  app.slots.experimental_threadHeaderAction({
    id: "envoy",
    title: "Envoy task",
    component: EnvoyHeader,
  });
}
