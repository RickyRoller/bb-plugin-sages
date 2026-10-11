// bb-plugin-sages — frontend entry.
//
// One sidebar page. Its root lists sages and creates them; `/<sage-id>` is
// that sage's chat. A sage's chat never ends, and each message is a turn in a
// fresh thread: the page shows the logged chat, bb's NewThreadComposer sends
// the next message, and bb's ThreadChat shows the turn while it runs.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { FormEvent, ReactNode } from "react";
import {
  definePluginApp,
  experimental_NewThreadComposer as NewThreadComposer,
  Markdown,
  ThreadChat,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSdk,
  type NewThreadComposerProps,
  type NewThreadRequest,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { ListedSage as Sage, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";

const PANEL_PATH = "sages";

/** The sage list, kept current by the server's "sages-changed" signal. */
function useSages() {
  const rpc = useRpc<typeof rpcContract>();
  const [sages, setSages] = useState<Sage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refetch = useCallback(() => {
    rpc.call("sages_list").then((result) => {
      setSages(result.sages);
      setError(null);
    }, report);
  }, [rpc, report]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("sages-changed", refetch);
  return { rpc, sages, error, report, refetch };
}

type SageFields = Pick<Sage, "name" | "topic" | "instructions" | "projectId">;

/** The user's projects by id, for the picker and for naming a sage's project. */
function useProjects(): Map<string, string> {
  const sdk = useSdk();
  const [projects, setProjects] = useState(new Map<string, string>());
  useEffect(() => {
    sdk.projects.list().then(
      (list) => setProjects(new Map(list.map((p) => [p.id, p.name]))),
      () => {},
    );
  }, [sdk]);
  return projects;
}

function SageForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: SageFields;
  submitLabel: string;
  onSubmit: (fields: SageFields) => Promise<void>;
  onCancel?: () => void;
}) {
  const [fields, setFields] = useState(initial);
  const projects = useProjects();
  const [pending, setPending] = useState(false);
  const set = (patch: Partial<SageFields>) =>
    setFields((current) => ({ ...current, ...patch }));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (fields.name.trim() === "" || pending) return;
    setPending(true);
    try {
      await onSubmit(fields);
    } finally {
      setPending(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Input
        value={fields.name}
        onChange={(event) => set({ name: event.target.value })}
        placeholder="Name"
        aria-label="Sage name"
        maxLength={80}
      />
      <Input
        value={fields.topic}
        onChange={(event) => set({ topic: event.target.value })}
        placeholder="Topic or project (one line)"
        aria-label="Sage topic"
        maxLength={200}
      />
      <select
        value={fields.projectId ?? ""}
        onChange={(event) => set({ projectId: event.target.value || null })}
        aria-label="Sage project"
        className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <option value="">No project</option>
        {/* Keeps a project that no longer exists selectable until changed. */}
        {fields.projectId !== null && !projects.has(fields.projectId) ? (
          <option value={fields.projectId}>{fields.projectId}</option>
        ) : null}
        {[...projects].map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
      <textarea
        value={fields.instructions}
        onChange={(event) => set({ instructions: event.target.value })}
        placeholder="Instructions: how this sage should think, what it knows, how it answers"
        aria-label="Sage instructions"
        maxLength={3500}
        rows={5}
        className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="flex justify-end gap-2">
        {onCancel === undefined ? null : (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={pending || fields.name.trim() === ""}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  return error === null ? null : (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  );
}

function SageList() {
  const { rpc, sages, error, report } = useSages();
  const projects = useProjects();
  const navigate = useBbNavigate();
  // Remounts the form to clear it after a create.
  const [formKey, setFormKey] = useState(0);
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border flex w-full max-w-3xl flex-col gap-4 px-4 pb-4 pt-3 md:px-5 md:pt-4">
        <p className="text-sm text-muted-foreground">
          A sage is a tuned chat you keep coming back to for one topic or
          project.
        </p>
        <SageForm
          key={formKey}
          initial={{ name: "", topic: "", instructions: "", projectId: null }}
          submitLabel="Create sage"
          onSubmit={async (fields) => {
            try {
              const sage = await rpc.call("sages_create", fields);
              setFormKey((key) => key + 1);
              navigate.toPluginPanel(PANEL_PATH, { subPath: sage.id });
            } catch (cause) {
              report(cause);
            }
          }}
        />
        <ErrorLine error={error} />
        {sages === null ? (
          <Notice>Loading sages…</Notice>
        ) : sages.length === 0 ? (
          <Notice>No sages yet. Create one above.</Notice>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {sages.map((sage) => (
              <li key={sage.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-accent"
                  onClick={() =>
                    navigate.toPluginPanel(PANEL_PATH, { subPath: sage.id })
                  }
                >
                  <Icon name="Sparkles" className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {sage.name}
                    </span>
                    {subtitle(sage, projects) === "" ? null : (
                      <span className="block truncate text-muted-foreground">
                        {subtitle(sage, projects)}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {sage.running ? "Working…" : memoryLine(sage)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A sage's project and topic, as one line. */
function subtitle(sage: Sage, projects: Map<string, string>): string {
  const project =
    sage.projectId === null ? null : (projects.get(sage.projectId) ?? null);
  return [project, sage.topic].filter(Boolean).join(" · ");
}

/** One line on the size of a sage's memory. */
function memoryLine(sage: Sage): string {
  const { messages, viewBytes, pending } = sage.stats;
  if (messages === 0) return "Not started";
  return [
    `${messages.toLocaleString()} messages`,
    `${Math.round(viewBytes / 1000)} KB view`,
    pending === 0 ? null : `summarizing ${pending}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

interface ChatMessage {
  i: number;
  kind: string;
  text: string;
  date: string;
}
const PAGE = 40;

/**
 * The logged chat: the user's and the sage's messages, newest page first,
 * refetched as the chat grows. It lives above the views that show it, so
 * switching between them never blanks it.
 */
function useHistory(sageId: string, total: number) {
  const rpc = useRpc<typeof rpcContract>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [more, setMore] = useState(false);
  useEffect(() => {
    let stale = false;
    rpc
      .call("sages_history", { id: sageId, before: null, limit: PAGE })
      .then((result) => {
        if (stale) return;
        // Keeps earlier pages the reader loaded.
        setMessages((current) => {
          const first = result.messages[0]?.i ?? Infinity;
          return [...current.filter((m) => m.i < first), ...result.messages];
        });
        setMore((current) => current || result.messages.length === PAGE);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [rpc, sageId, total]);
  const loadEarlier = () => {
    const first = messages[0];
    if (first === undefined) return;
    rpc
      .call("sages_history", { id: sageId, before: first.i, limit: PAGE })
      .then((result) => {
        setMessages((current) => [...result.messages, ...current]);
        setMore(result.messages.length === PAGE);
      })
      .catch(() => {});
  };
  return { messages, more, loadEarlier };
}

/** A specialist's report: one quiet line that opens the specialist's thread. */
function WorkLine({ text }: { text: string }) {
  const navigate = useBbNavigate();
  const match = /^\[([^\]]+)\] (report|failed) \(thread (\S+)\)/u.exec(text);
  const name = match?.[1] ?? "A specialist";
  const threadId = match?.[3] ?? null;
  const label = match?.[2] === "failed" ? "failed" : "reported back";
  return (
    <button
      type="button"
      disabled={threadId === null}
      onClick={() => threadId !== null && navigate.toThread(threadId)}
      className="flex items-center gap-1.5 self-start text-xs text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground"
    >
      <Icon name="CornerDownRight" className="size-3.5" />
      <span className="font-medium">{name}</span> {label}
    </button>
  );
}

function Transcript({
  messages,
  more,
  onLoadEarlier,
}: {
  messages: ChatMessage[];
  more: boolean;
  onLoadEarlier: () => void;
}) {
  if (messages.length === 0) return null;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-4">
      {more ? (
        <Button variant="ghost" className="self-center" onClick={onLoadEarlier}>
          Load earlier messages
        </Button>
      ) : null}
      {messages.map((message) =>
        message.kind === "work" ? (
          <WorkLine key={message.i} text={message.text} />
        ) : message.kind === "user" ? (
          <div
            key={message.i}
            className="max-w-[85%] self-end whitespace-pre-wrap rounded-2xl bg-muted px-4 py-2 text-sm"
          >
            {message.text}
          </div>
        ) : (
          <Markdown key={message.i} content={message.text} />
        ),
      )}
    </div>
  );
}

/**
 * The id of the running turn's thread once it has loaded. bb's ThreadChat
 * shows only skeletons until its thread loads, so the page keeps showing the
 * logged chat until then and mounts the live chat out of sight meanwhile.
 */
function useLoadedThread(threadId: string | null): string | null {
  const sdk = useSdk();
  const [loaded, setLoaded] = useState<string | null>(null);
  useEffect(() => {
    if (threadId === null) return;
    let stale = false;
    const done = () => {
      // A beat for ThreadChat's own fetch of the same data to land.
      setTimeout(() => {
        if (!stale) setLoaded(threadId);
      }, 250);
    };
    Promise.all([
      sdk.threads.get({ threadId }),
      sdk.threads.timeline({ threadId }),
    ]).then(done, done);
    return () => {
      stale = true;
    };
  }, [sdk, threadId]);
  return loaded === threadId ? loaded : null;
}

/** A scroll area that stays at its end as `watch` changes. */
function ScrollToEnd({
  watch,
  children,
}: {
  watch: unknown;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const area = ref.current;
    if (area === null) return;
    // Content arrives after the fetch; follow it while the reader is at the end.
    const observer = new ResizeObserver(() => {
      if (atEnd.current) area.scrollTop = area.scrollHeight;
    });
    if (area.firstElementChild !== null)
      observer.observe(area.firstElementChild);
    area.scrollTop = area.scrollHeight;
    return () => observer.disconnect();
  }, [watch]);
  return (
    <div
      ref={ref}
      className="min-h-0 flex-1 overflow-y-auto"
      onScroll={(event) => {
        const area = event.currentTarget;
        atEnd.current =
          area.scrollHeight - area.scrollTop - area.clientHeight < 40;
      }}
    >
      <div>{children}</div>
    </div>
  );
}

function SageChat({ sageId }: { sageId: string }) {
  const { rpc, sages, error, report } = useSages();
  const projects = useProjects();
  const navigate = useBbNavigate();
  const [editing, setEditing] = useState(false);
  const toList = () => navigate.toPluginPanel(PANEL_PATH);
  const sage = sages?.find((candidate) => candidate.id === sageId);
  const history = useHistory(sageId, sage?.stats.messages ?? 0);
  const liveThread = sage?.running === true ? (sage.threadId ?? null) : null;
  const loadedThread = useLoadedThread(liveThread);

  if (sages === null) {
    return (
      <div className="p-4">
        <ErrorLine error={error} />
        {error === null ? <Notice>Loading sage…</Notice> : null}
      </div>
    );
  }
  if (sage === undefined) {
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <Notice>This sage no longer exists.</Notice>
        <Button variant="ghost" onClick={toList}>
          <Icon name="ArrowLeft" className="size-4" />
          All sages
        </Button>
      </div>
    );
  }

  const sendMessage = async (request: NewThreadRequest) => {
    // The request crosses RPC as plain JSON; bb validates it at spawn.
    await rpc.call("sages_send", {
      id: sage.id,
      request: JSON.parse(JSON.stringify(request)),
    });
  };
  const remove = () => {
    if (
      !window.confirm(
        `Delete "${sage.name}" and its whole chat? This cannot be undone.`,
      )
    ) {
      return;
    }
    rpc.call("sages_remove", { id: sage.id }).then(toList, report);
  };
  const transcript = (live: boolean) => (
    <Transcript
      // While the live thread shows, it shows the running turn's messages.
      messages={
        live && sage.turnStart !== null
          ? history.messages.filter((message) => message.i < sage.turnStart!)
          : history.messages
      }
      more={history.more}
      onLoadEarlier={history.loadEarlier}
    />
  );
  const seeds = (sage.defaults ?? {}) as Partial<NewThreadRequest>;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="All sages"
          onClick={toList}
        >
          <Icon name="ArrowLeft" className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{sage.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {[subtitle(sage, projects), memoryLine(sage)]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Edit sage"
          onClick={() => setEditing((current) => !current)}
        >
          <Icon name="Pencil" className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Delete sage"
          onClick={remove}
        >
          <Icon name="Trash2" className="size-4" />
        </Button>
      </header>
      {error === null ? null : (
        <div className="px-4 pt-2">
          <ErrorLine error={error} />
        </div>
      )}
      {editing ? (
        <div className="mx-auto min-h-0 w-full max-w-3xl flex-1 overflow-y-auto p-4">
          <SageForm
            initial={sage}
            submitLabel="Save"
            onCancel={() => setEditing(false)}
            onSubmit={async ({ name, topic, instructions, projectId }) => {
              try {
                await rpc.call("sages_update", {
                  id: sage.id,
                  name,
                  topic,
                  projectId,
                  instructions,
                });
                setEditing(false);
              } catch (cause) {
                report(cause);
              }
            }}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            Changes apply from the next message.
          </p>
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          {liveThread === null ? null : (
            <div
              className={
                loadedThread === null
                  ? "invisible absolute inset-0"
                  : "min-h-0 flex-1"
              }
            >
              <ThreadChat
                key={liveThread}
                threadId={liveThread}
                // Transcript only: the page's one composer stays put.
                variant="timeline"
                leadingContent={transcript(true)}
              />
            </div>
          )}
          {loadedThread !== null ? null : (
            <ScrollToEnd watch={sage.stats.messages}>
              {transcript(false)}
            </ScrollToEnd>
          )}
        </div>
      )}
      {/* One composer for the life of the page, in the same place whatever
          the chat shows, so a draft survives turns starting and ending. */}
      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        {sage.error === null ? null : (
          <p role="alert" className="pb-2 text-sm text-destructive">
            The last turn failed: {sage.error}
          </p>
        )}
        {sage.running ? (
          <div className="flex items-center justify-between pb-2 text-xs text-muted-foreground">
            <span>
              {sage.name} is working. A message now reaches it between steps.
            </span>
            <Button
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => {
                rpc.call("sages_stop", { id: sage.id }).catch(report);
              }}
            >
              <Icon name="Square" className="size-3.5" />
              Stop
            </Button>
          </div>
        ) : null}
        <NewThreadComposer
          draftKey={`sage:${sage.id}`}
          placeholder={`Ask ${sage.name}…`}
          onSubmit={sendMessage}
          defaultProjectId={sage.projectId ?? seeds.projectId}
          defaultProviderId={seeds.providerId}
          defaultModel={seeds.model}
          defaultReasoningLevel={seeds.reasoningLevel}
          defaultServiceTier={seeds.serviceTier}
          defaultPermissionMode="full"
          defaultEnvironment={
            // The last turn's environment, unless the sage has since been
            // assigned another project.
            sage.projectId === null || sage.projectId === seeds.projectId
              ? (seeds.environment as NewThreadComposerProps["defaultEnvironment"])
              : undefined
          }
        />
      </div>
    </div>
  );
}

function SagesPage({ subPath }: PluginNavPanelProps) {
  const sageId = subPath.split("/")[0] ?? "";
  return sageId === "" ? <SageList /> : <SageChat sageId={sageId} />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "sages",
    title: "Sages",
    icon: "Sparkles",
    path: PANEL_PATH,
    component: SagesPage,
  });
});
