import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  experimental_NewThreadComposer as NewThreadComposer,
  Markdown,
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
          Issue link <span className="text-muted-foreground">(optional)</span>
          <Input
            value={issueUrl}
            maxLength={2000}
            disabled={pending}
            onChange={(e) => setIssueUrl(e.target.value)}
            placeholder="https://tracker.example.com/issue/ABC-123"
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
const LIFECYCLE_STYLE: Record<Envoy["lifecycle"], string> = {
  creating: "bg-muted text-muted-foreground",
  active: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  parked: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  completed: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  cancelled: "bg-destructive/15 text-destructive",
};
/** What each lifecycle action does, shown on hover instead of a paragraph. */
const ACTIONS = {
  active: {
    label: "Resume",
    hint: "Continue the task and restore its PR watchers.",
  },
  parked: {
    label: "Park",
    hint: "Pause work and remove PR watchers. The workspace, chat and handoff worker stay.",
  },
  completed: {
    label: "Mark completed",
    hint: "Save its final output and archive its thread, with its child threads, PR watchers and worktree. Resume brings it back.",
  },
  cancelled: {
    label: "Cancel task",
    hint: "Stop all work, including child threads, and remove PR watchers.",
  },
} as const;

/** Shows what an action does on hover. */
function Hint({ text, children }: { text: string; children: ReactNode }) {
  return (
    <span className="inline-flex" title={text}>
      {children}
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

type Overview = {
  project?: string;
  agent?: string;
  workspace?: string;
  path?: string;
};

function EnvoyDetails({
  envoy,
  onClose,
}: {
  envoy: Envoy;
  onClose: () => void;
}) {
  const rpc = useRpc<typeof envoyRpcContract>();
  const sdk = useSdk();
  const [overview, setOverview] = useState<Overview>({});
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
      const next: Overview = {};
      if (project.status === "fulfilled") next.project = project.value.name;
      if (thread.status === "fulfilled" && thread.value) {
        const options =
          execution.status === "fulfilled" ? execution.value : null;
        next.agent = [
          thread.value.providerId,
          options?.model,
          options?.reasoningLevel,
          options?.permissionMode,
        ]
          .filter(Boolean)
          .join(" · ");
        if (thread.value.environmentId) {
          try {
            const workspace = await sdk.environments.get({
              environmentId: thread.value.environmentId,
            });
            next.workspace = [
              workspace.isWorktree ? "BB worktree" : "Workspace",
              workspace.branchName,
            ]
              .filter(Boolean)
              .join(" · ");
            next.path = workspace.path ?? undefined;
          } catch {
            next.workspace = "Unavailable";
          }
        } else next.workspace = "Preparing";
      }
      if (!stale) setOverview(next);
    })().catch(() => {});
    return () => {
      stale = true;
    };
  }, [sdk, envoy.projectId, envoy.threadId, envoy.environmentId]);
  const [name, setName] = useState(envoy.name);
  const [issue, setIssue] = useState(envoy.issue?.url ?? "");
  const [prUrl, setPrUrl] = useState("");
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
  const edited =
    name.trim() !== envoy.name || issue.trim() !== (envoy.issue?.url ?? "");
  const setLifecycle = (lifecycle: keyof typeof ACTIONS) =>
    void run(() => rpc.call("envoys_lifecycle", { id: envoy.id, lifecycle }));
  const rows: [string, string | undefined, string?][] = [
    ["Project", overview.project],
    ["Agent", overview.agent],
    ["Workspace", overview.workspace, overview.path],
  ];
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      {/* Header and actions stay put; everything between them scrolls. */}
      <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col gap-5 overflow-hidden">
        <DialogHeader className="space-y-2 pr-6">
          <DialogTitle className="text-lg leading-snug">
            {envoy.name}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span
                className={`rounded-full px-2 py-0.5 font-medium capitalize ${LIFECYCLE_STYLE[envoy.lifecycle]}`}
              >
                {envoy.lifecycle}
              </span>
              <span>Led by {envoy.specialist ?? "a BB agent"}</span>
              {envoy.issue ? (
                <>
                  <span aria-hidden="true">·</span>
                  <UrlLink href={envoy.issue.url}>{envoy.issue.key}</UrlLink>
                </>
              ) : null}
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-1 min-h-0 flex-1 space-y-6 overflow-y-auto px-1">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
            {rows.map(([label, value, title]) =>
              value ? (
                <div className="contents" key={label}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="truncate" title={title}>
                    {value}
                  </dd>
                </div>
              ) : null,
            )}
          </dl>

          <Section title="Task">
            <div className="max-h-56 overflow-y-auto rounded-md bg-muted/40 px-3 py-2 text-sm">
              <Markdown content={envoy.directive} />
            </div>
          </Section>

          <Section title="Pull requests">
            {envoy.prs.length ? (
              <ul className="divide-y divide-border rounded-md border border-border">
                {envoy.prs.map((pr) => (
                  <li
                    className="flex items-center justify-between gap-2 py-1 pl-3 pr-1 text-sm"
                    key={pr.url}
                  >
                    <UrlLink href={pr.url}>
                      {pr.owner}/{pr.repo} #{pr.number}
                    </UrlLink>
                    <Button
                      aria-label={`Detach ${pr.owner}/${pr.repo} #${pr.number}`}
                      className="h-7 w-7 text-muted-foreground"
                      disabled={pending}
                      size="icon"
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
                      ×
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">None attached.</p>
            )}
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!prUrl.trim()) return;
                void run(async () => {
                  await rpc.call("envoys_pr", {
                    id: envoy.id,
                    url: prUrl,
                    action: "attach",
                  });
                  setPrUrl("");
                });
              }}
            >
              <Input
                aria-label="Pull request URL"
                className="h-8 text-sm"
                placeholder="https://github.com/owner/repo/pull/123"
                value={prUrl}
                maxLength={2000}
                onChange={(e) => setPrUrl(e.target.value)}
              />
              <Button
                disabled={pending || !prUrl.trim()}
                size="sm"
                type="submit"
                variant="outline"
              >
                Attach PR
              </Button>
            </form>
          </Section>

          <Section title="Edit">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">Name</span>
                <Input
                  className="h-8 text-sm"
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">
                  Issue link
                </span>
                <Input
                  className="h-8 text-sm"
                  placeholder="https://…"
                  value={issue}
                  maxLength={2000}
                  onChange={(e) => setIssue(e.target.value)}
                />
              </label>
            </div>
            <div className="flex justify-end">
              <Button
                disabled={pending || !edited || !name.trim()}
                size="sm"
                variant="secondary"
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
                Save
              </Button>
            </div>
          </Section>
        </div>

        <div className="shrink-0 space-y-2 border-t border-border pt-4">
          <ErrorLine error={error ?? envoy.error} />
          <div className="flex flex-wrap items-center gap-2">
            {envoy.lifecycle !== "cancelled" ? (
              <Hint text={ACTIONS.cancelled.hint}>
                <Button
                  className="text-destructive hover:text-destructive"
                  disabled={pending}
                  size="sm"
                  variant="ghost"
                  onClick={() => setLifecycle("cancelled")}
                >
                  {ACTIONS.cancelled.label}
                </Button>
              </Hint>
            ) : null}
            <div className="ml-auto flex gap-2">
              {(() => {
                const toggle =
                  envoy.lifecycle === "active" ? "parked" : "active";
                return (
                  <Hint text={ACTIONS[toggle].hint}>
                    <Button
                      disabled={pending}
                      size="sm"
                      variant="outline"
                      onClick={() => setLifecycle(toggle)}
                    >
                      {ACTIONS[toggle].label}
                    </Button>
                  </Hint>
                );
              })()}
              {envoy.lifecycle !== "completed" ? (
                <Hint text={ACTIONS.completed.hint}>
                  <Button
                    disabled={pending}
                    size="sm"
                    onClick={() => setLifecycle("completed")}
                  >
                    {ACTIONS.completed.label}
                  </Button>
                </Hint>
              ) : null}
            </div>
          </div>
        </div>
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
