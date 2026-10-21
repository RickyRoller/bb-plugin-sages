// bb-plugin-sages — frontend entry.
//
// One sidebar page. Its root lists sages and creates them; `/<sage-id>` is
// that sage's chat, and an acolyte's chat too: an acolyte is a sage of its own
// whose `parentId` names the sage it branched off. A sage's chat never ends,
// and each message is a turn in a fresh thread: the page shows the logged
// chat, bb's NewThreadComposer sends the next message, and bb's ThreadChat
// shows the turn while it runs.
import {
  createContext,
  useCallback,
  useContext,
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
import { EnvoyList, registerEnvoyApp } from "./envoys-app";
import { registerSettingsApp } from "./settings-app";

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

type SageFields = Pick<
  Sage,
  "name" | "topic" | "instructions" | "projectId" | "parentId"
>;

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

const SELECT =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function SageForm({
  initial,
  leads,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: SageFields;
  /** The sages this one can serve as an acolyte; none hides the choice. */
  leads: Sage[];
  submitLabel: string;
  onSubmit: (fields: SageFields) => Promise<void>;
  onCancel?: () => void;
}) {
  const [fields, setFields] = useState(initial);
  const projects = useProjects();
  const [pending, setPending] = useState(false);
  const set = (patch: Partial<SageFields>) =>
    setFields((current) => ({ ...current, ...patch }));
  const lead = leads.find((each) => each.id === fields.parentId);
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
      {leads.length === 0 ? null : (
        <select
          value={fields.parentId ?? ""}
          onChange={(event) => set({ parentId: event.target.value || null })}
          aria-label="Lead sage"
          className={SELECT}
        >
          <option value="">Its own lead</option>
          {leads.map((each) => (
            <option key={each.id} value={each.id}>
              Acolyte of {each.name}
            </option>
          ))}
        </select>
      )}
      <Input
        value={fields.topic}
        onChange={(event) => set({ topic: event.target.value })}
        placeholder={
          lead === undefined
            ? "Topic or project (one line)"
            : `Focus within ${lead.name}'s work (one line)`
        }
        aria-label={lead === undefined ? "Sage topic" : "Acolyte focus"}
        maxLength={200}
      />
      <select
        value={fields.projectId ?? ""}
        onChange={(event) => set({ projectId: event.target.value || null })}
        aria-label="Sage project"
        className={SELECT}
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
        placeholder={
          lead === undefined
            ? "Instructions: how this sage should think, what it knows, how it answers"
            : `Its own instructions, on top of ${lead.name}'s`
        }
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
          initial={{
            name: "",
            topic: "",
            instructions: "",
            projectId: null,
            parentId: null,
          }}
          leads={(sages ?? []).filter((sage) => sage.parentId === null)}
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
        ) : sages.every((sage) => sage.parentId !== null) ? (
          <Notice>No sages yet. Create one above.</Notice>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {sages
              .filter((sage) => sage.parentId === null)
              .map((sage) => (
                <li key={sage.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-accent"
                    onClick={() =>
                      navigate.toPluginPanel(PANEL_PATH, { subPath: sage.id })
                    }
                  >
                    <Icon name="sages/sage" className="size-4 shrink-0" />
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
                  {sages
                    .filter(
                      (acolyte) =>
                        acolyte.parentId === sage.id &&
                        acolyte.archivedAt === null,
                    )
                    .map((acolyte) => (
                      <button
                        key={acolyte.id}
                        type="button"
                        className="flex w-full items-center gap-2 py-2 pl-11 pr-4 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                        onClick={() => toSage(navigate, acolyte.id)}
                      >
                        <Icon name="GitBranch" className="size-3.5 shrink-0" />
                        <span className="truncate">{acolyte.name}</span>
                        {acolyte.topic === "" ? null : (
                          <span className="min-w-0 flex-1 truncate text-xs">
                            {acolyte.topic}
                          </span>
                        )}
                      </button>
                    ))}
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
/** The reading column bb's own chats use. */
const CHAT_COLUMN = "mx-auto w-full max-w-[760px] px-4";

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

// --- Acolytes ---
// An acolyte's markers in the chats: in its sage's main chat, where it was
// opened, closed with a summary, archived or reopened; in its own chat, the
// brief it opened with.

const ACOLYTE_MARK =
  /^\[acolyte (\S+)\] (opened|closed|archived|reopened|joined|left): (.*)/u;
const ACOLYTE_OPENING = /^\[acolyte of ([^\]]+)\] opened: (.*)/u;

/** The words after a marker's head line. */
const markerBody = (text: string) => {
  const at = text.indexOf("\n\n");
  return at === -1 ? "" : text.slice(at + 2);
};

function toSage(navigate: ReturnType<typeof useBbNavigate>, id: string) {
  navigate.toPluginPanel(PANEL_PATH, { subPath: id });
}

/** An acolyte's state, as a dot and a word. */
function AcolyteStatus({ acolyte }: { acolyte: Sage | undefined }) {
  const [label, dot] =
    acolyte === undefined
      ? ["Deleted", "bg-muted-foreground/40"]
      : acolyte.closing
        ? ["Closing…", "animate-pulse bg-amber-500"]
        : acolyte.archivedAt !== null
          ? ["Closed", "bg-muted-foreground/40"]
          : acolyte.running
            ? ["Working…", "animate-pulse bg-amber-500"]
            : ["Active", "bg-emerald-500"];
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden="true" className={`size-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

/** A collapsed row that opens onto its details, like bb's child threads. */
function Disclosure({
  icon,
  title,
  trailing,
  initiallyOpen = false,
  children,
}: {
  icon: string;
  title: ReactNode;
  trailing?: ReactNode;
  initiallyOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <div className="min-w-0 self-stretch overflow-hidden rounded-lg border border-border/70 text-sm">
      <div className="flex items-center gap-2 py-1.5 pl-2 pr-1.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Icon
            name={open ? "ChevronDown" : "ChevronRight"}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <Icon
            name={icon}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 truncate">{title}</span>
        </button>
        {trailing}
      </div>
      {open ? (
        <div className="border-t border-border/70 px-3 py-2 text-muted-foreground">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** An acolyte's marker in its sage's main chat. */
function AcolyteMarker({
  text,
  acolytes,
}: {
  text: string;
  acolytes: Map<string, Sage>;
}) {
  const navigate = useBbNavigate();
  const match = ACOLYTE_MARK.exec(text);
  if (match === null) return <ChatMarkdown content={text} />;
  const [, id = "", event, title] = match;
  const acolyte = acolytes.get(id);
  const body = markerBody(text);
  const name = acolyte?.name ?? title;
  if (event === "opened") {
    return (
      <Disclosure
        icon="GitBranch"
        title={
          <>
            <span className="text-muted-foreground">Acolyte </span>
            <span className="font-medium">{name}</span>
          </>
        }
        trailing={
          <>
            <AcolyteStatus acolyte={acolyte} />
            {acolyte === undefined ? null : (
              <Button
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() => toSage(navigate, id)}
              >
                Open
              </Button>
            )}
          </>
        }
      >
        <ChatMarkdown content={body} />
      </Disclosure>
    );
  }
  if (event === "closed") {
    return (
      <Disclosure
        icon="CornerDownRight"
        title={
          <span className="text-muted-foreground">
            Summary from acolyte{" "}
            <span className="font-medium text-foreground">{name}</span>
          </span>
        }
      >
        <ChatMarkdown content={body} />
      </Disclosure>
    );
  }
  return (
    <div className="flex items-center gap-1.5 self-start text-xs text-muted-foreground">
      <Icon
        name={event === "archived" ? "Archive" : "GitBranch"}
        className="size-3.5"
      />
      Acolyte <span className="font-medium">{name}</span>{" "}
      {event === "archived"
        ? "archived"
        : event === "joined"
          ? "joined"
          : event === "left"
            ? "left"
            : "reopened"}
    </div>
  );
}

/** What an acolyte opened with, at the top of its own chat. */
function AcolyteOpening({ text }: { text: string }) {
  const match = ACOLYTE_OPENING.exec(text);
  return (
    <Disclosure
      icon="GitBranch"
      initiallyOpen
      title={
        <span className="text-muted-foreground">
          Acolyte of{" "}
          <span className="font-medium text-foreground">
            {match?.[1] ?? "its lead"}
          </span>
        </span>
      }
    >
      <ChatMarkdown content={markerBody(text)} />
    </Disclosure>
  );
}

/**
 * An acolyte's closing, in the composer's place: the choice of how to close
 * it, the summary being written, or a closed acolyte's way back.
 */
function AcolyteClosing({
  acolyte,
  parent,
  asking,
  onAsked,
  onError,
}: {
  acolyte: Sage;
  parent: Sage | undefined;
  asking: boolean;
  onAsked: () => void;
  onError: (cause: unknown) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const close = (summary: boolean) => {
    onAsked();
    rpc.call("sages_close_acolyte", { id: acolyte.id, summary }).catch(onError);
  };
  const parentName = parent?.name ?? "its lead";
  if (acolyte.closing) {
    return (
      <p className="animate-pulse pb-2 text-sm text-muted-foreground">
        Writing a summary for {parentName}…
      </p>
    );
  }
  if (acolyte.archivedAt !== null) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border/70 px-3 py-2 text-sm text-muted-foreground">
        <Icon name="Archive" className="size-4 shrink-0" />
        <span className="flex-1">This acolyte is closed.</span>
        <Button
          variant="outline"
          className="h-7 px-2 text-xs"
          onClick={() => {
            rpc.call("sages_reopen_acolyte", { id: acolyte.id }).catch(onError);
          }}
        >
          Reopen
        </Button>
      </div>
    );
  }
  if (!asking) return null;
  return (
    <div className="mb-2 flex flex-col gap-2 rounded-lg border border-border/70 p-3 text-sm">
      <span>Close {acolyte.name}?</span>
      <div className="flex flex-wrap gap-2">
        <Button className="h-8 px-3 text-xs" onClick={() => close(true)}>
          Send summary to {parentName}
        </Button>
        <Button
          variant="outline"
          className="h-8 px-3 text-xs"
          onClick={() => close(false)}
        >
          Just archive
        </Button>
        <Button variant="ghost" className="h-8 px-3 text-xs" onClick={onAsked}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The main chat's open acolytes, one chip each, above its composer. */
function OpenAcolytes({ acolytes }: { acolytes: Sage[] }) {
  const navigate = useBbNavigate();
  if (acolytes.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 pb-2 text-xs text-muted-foreground">
      <Icon name="GitBranch" className="size-3.5" />
      {acolytes.map((acolyte) => (
        <button
          key={acolyte.id}
          type="button"
          onClick={() => toSage(navigate, acolyte.id)}
          className="flex max-w-56 items-center gap-1.5 rounded-full border border-border/70 px-2 py-0.5 hover:bg-accent hover:text-foreground"
        >
          <span
            aria-hidden="true"
            className={`size-1.5 shrink-0 rounded-full ${acolyte.running || acolyte.closing ? "animate-pulse bg-amber-500" : "bg-emerald-500"}`}
          />
          <span className="truncate">{acolyte.name}</span>
        </button>
      ))}
    </div>
  );
}

/** Names a new acolyte and its focus, opened empty for the user to start. */
function NewAcolyteForm({
  sage,
  onDone,
  onError,
}: {
  sage: Sage;
  onDone: () => void;
  onError: (cause: unknown) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [name, setName] = useState("");
  const [focus, setFocus] = useState("");
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (name.trim() === "" || pending) return;
    setPending(true);
    try {
      const acolyte = await rpc.call("sages_open_acolyte", {
        id: sage.id,
        name,
        focus,
      });
      onDone();
      toSage(navigate, acolyte.id);
    } catch (cause) {
      onError(cause);
    } finally {
      setPending(false);
    }
  };
  return (
    <form
      onSubmit={submit}
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2"
    >
      <Icon
        name="GitBranch"
        className="size-4 shrink-0 text-muted-foreground"
      />
      <Input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Acolyte name"
        aria-label="Acolyte name"
        maxLength={80}
        className="h-8 w-48"
      />
      <Input
        value={focus}
        onChange={(event) => setFocus(event.target.value)}
        placeholder={`Its focus within ${sage.name}'s work`}
        aria-label="Acolyte focus"
        maxLength={200}
        className="h-8 min-w-48 flex-1"
      />
      <Button
        type="submit"
        className="h-8"
        disabled={pending || name.trim() === ""}
      >
        Open
      </Button>
      <Button type="button" variant="ghost" className="h-8" onClick={onDone}>
        Cancel
      </Button>
    </form>
  );
}

// --- Thread mentions ---
// bb's chats show "@thread:<id>" as a pill with the thread's title; its
// Markdown component, which draws the logged chat, does not. So the logged
// chat resolves the mentions itself and writes each one as a link to the
// thread, which the chat's styles draw as a pill.

const THREAD_MENTION = /(^|[^\p{L}\p{N}_.+-])@thread:([A-Za-z0-9_-]+)/gu;
/** Code spans and blocks, where a mention stays as written. */
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/u;

interface Mention {
  label: string;
  projectId: string;
}
/** Resolved threads by id; null for one that no longer resolves. */
const mentionCache = new Map<string, Mention | null>();
const ThreadMentions =
  createContext<ReadonlyMap<string, Mention | null>>(mentionCache);

/** The threads the messages mention, resolved once each per page load. */
function useThreadMentions(messages: ChatMessage[]) {
  const sdk = useSdk();
  const [resolved, setResolved] = useState(() => new Map(mentionCache));
  useEffect(() => {
    const ids = new Set<string>();
    for (const { text } of messages) {
      for (const [, , id] of text.matchAll(THREAD_MENTION)) {
        if (!mentionCache.has(id!)) ids.add(id!);
      }
    }
    if (ids.size === 0) return;
    let stale = false;
    sdk.threads.resolveMentions({ threadIds: [...ids] }).then(
      (found) => {
        for (const id of ids) mentionCache.set(id, null);
        for (const { threadId, label, projectId } of found) {
          mentionCache.set(threadId, { label, projectId });
        }
        if (!stale) setResolved(new Map(mentionCache));
      },
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [sdk, messages]);
  return resolved;
}

/** bb's Markdown, with thread mentions written as links to their threads. */
function ChatMarkdown({ content }: { content: string }) {
  const mentions = useContext(ThreadMentions);
  const linked = content
    .split(CODE)
    .map((part, index) =>
      // Odd parts are code.
      index % 2 === 1
        ? part
        : part.replace(THREAD_MENTION, (whole, before: string, id: string) => {
            const mention = mentions.get(id);
            if (mention == null) return whole;
            const label = mention.label.replace(/[[\]\\]/gu, "\\$&");
            const url = `${window.location.origin}/projects/${mention.projectId}/threads/${id}`;
            return `${before}[${label}](${url})`;
          }),
    )
    .join("");
  return <Markdown content={linked} />;
}

function Transcript({
  messages,
  more,
  onLoadEarlier,
  acolytes,
}: {
  messages: ChatMessage[];
  more: boolean;
  onLoadEarlier: () => void;
  acolytes: Map<string, Sage>;
}) {
  const mentions = useThreadMentions(messages);
  if (messages.length === 0) return null;
  return (
    <ThreadMentions.Provider value={mentions}>
      {/* Wide tables and code scroll sideways in place, as in bb's chats,
        rather than running off a phone's screen. */}
      <div className="flex min-w-0 flex-col gap-4 py-4 break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_a[href*='/threads/']]:inline-block [&_a[href*='/threads/']]:max-w-full [&_a[href*='/threads/']]:truncate [&_a[href*='/threads/']]:align-bottom [&_a[href*='/threads/']]:rounded-md [&_a[href*='/threads/']]:bg-muted [&_a[href*='/threads/']]:px-1.5 [&_a[href*='/threads/']]:py-0.5 [&_a[href*='/threads/']]:text-[0.9em] [&_a[href*='/threads/']]:font-medium [&_a[href*='/threads/']]:text-foreground [&_a[href*='/threads/']]:no-underline [&_a[href*='/threads/']]:hover:bg-accent">
        {more ? (
          <Button
            variant="ghost"
            className="self-center"
            onClick={onLoadEarlier}
          >
            Load earlier messages
          </Button>
        ) : null}
        {messages.map((message) =>
          message.kind === "work" ? (
            <WorkLine key={message.i} text={message.text} />
          ) : message.kind === "acolyte" ? (
            ACOLYTE_OPENING.test(message.text) ? (
              <AcolyteOpening key={message.i} text={message.text} />
            ) : (
              <AcolyteMarker
                key={message.i}
                text={message.text}
                acolytes={acolytes}
              />
            )
          ) : message.kind === "user" ? (
            <div
              key={message.i}
              className="max-w-[85%] self-end whitespace-pre-wrap rounded-2xl bg-muted px-4 py-2 text-sm break-words"
            >
              {message.text}
            </div>
          ) : (
            <ChatMarkdown key={message.i} content={message.text} />
          ),
        )}
      </div>
    </ThreadMentions.Provider>
  );
}

/** bb's ThreadChat draws these bars until its thread's timeline has loaded. */
const SKELETON = ".animate-pulse.bg-surface-selected";
/** Marks the logged chat inside a ThreadChat, apart from the turn's own. */
const LEADING = "data-sage-transcript";

/** A turn's thread on the page, and the first message of the chat it shows. */
interface Turn {
  threadId: string;
  turnStart: number | null;
}

/**
 * A turn's thread, as bb's ThreadChat shows it, after the logged chat before
 * it. Mounted out of sight first: it reports ready once bb has drawn the
 * turn itself and no skeleton is left, so it is never shown half loaded.
 */
function TurnView({
  turn,
  visible,
  leading,
  trailing,
  onReady,
}: {
  turn: Turn;
  visible: boolean;
  leading: ReactNode;
  /** Shown after the turn once it is visible: messages still being sent. */
  trailing: ReactNode;
  onReady: () => void;
}) {
  const area = useRef<HTMLDivElement>(null);
  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    const root = area.current;
    if (visible || root === null) return;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearTimeout(timer);
      // One frame for the layout to settle before it is shown.
      requestAnimationFrame(() => ready.current());
    };
    const check = () => {
      if (root.querySelector(SKELETON) !== null) return;
      const leadingText =
        root.querySelector(`[${LEADING}]`)?.textContent?.length ?? 0;
      // The turn's own messages are drawn: text beyond the logged chat.
      if ((root.textContent?.length ?? 0) > leadingText) finish();
    };
    const observer = new MutationObserver(check);
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    // However the load goes, the turn shows in the end.
    const timer = setTimeout(finish, 8000);
    check();
    return () => {
      done = true;
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [visible]);
  return (
    <ScrollToEnd
      areaRef={area}
      watch={visible}
      className={
        visible
          ? "min-h-0 flex-1 overflow-y-auto"
          : "invisible absolute inset-0 overflow-y-auto"
      }
    >
      <div className={CHAT_COLUMN}>
        <ThreadChat
          threadId={turn.threadId}
          // Transcript only: the page's one composer stays put.
          variant="timeline"
          layout="document"
          leadingContent={<div {...{ [LEADING]: "" }}>{leading}</div>}
        />
        {visible ? <div className="px-2 pb-3">{trailing}</div> : null}
      </div>
    </ScrollToEnd>
  );
}

/**
 * A scroll area that stays at its end while the reader is there, as content
 * loads, streams in or animates open, and when `watch` changes.
 */
function ScrollToEnd({
  watch,
  className,
  areaRef,
  children,
}: {
  watch: unknown;
  className: string;
  areaRef?: React.RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const own = useRef<HTMLDivElement>(null);
  const ref = areaRef ?? own;
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const area = ref.current;
    if (area !== null) area.scrollTop = area.scrollHeight;
  }, [ref, watch]);
  useEffect(() => {
    // Checked every frame: bb's timeline grows in ways a ResizeObserver on
    // this area's content does not always see.
    let frame = 0;
    let height = -1;
    const follow = () => {
      const area = ref.current;
      if (area !== null && area.scrollHeight !== height) {
        height = area.scrollHeight;
        if (atEnd.current) area.scrollTop = height;
      }
      frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, [ref]);
  return (
    <div
      ref={ref}
      className={className}
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

/** A message the user sent that the chat has not logged yet. */
interface Outgoing {
  requestId: string;
  request: Record<string, unknown> & {
    projectId: string;
    input: ({ type: string } & Record<string, unknown>)[];
  };
  /** What the user sees of it. */
  text: string;
  /** The chat's size when it was sent. */
  after: number;
  /** Why it could not be sent, once it could not. */
  error: string | null;
}

const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** The words of a prompt input the user sees, and a mark per attachment. */
function visibleText(input: readonly unknown[]): string {
  return input
    .map((part) => {
      const each = part as Record<string, unknown>;
      if (each.visibility === "agent-only") return "";
      if (each.type === "text") return String(each.text ?? "");
      return `[${String(each.type)}]`;
    })
    .filter((text) => text !== "")
    .join("\n");
}

/** Messages on their way: sending, or unsent with a way to try again. */
function Outbox({
  items,
  onRetry,
  onDismiss,
}: {
  items: Outgoing[];
  onRetry: (item: Outgoing) => void;
  onDismiss: (item: Outgoing) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 pt-4">
      {items.map((item) => (
        <div key={item.requestId} className="flex flex-col items-end gap-1">
          <div
            className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-muted px-4 py-2 text-sm ${item.error === null ? "opacity-60" : ""}`}
          >
            {item.text}
          </div>
          {item.error === null ? (
            <span className="text-xs text-muted-foreground">Sending…</span>
          ) : (
            <span className="flex items-center gap-2 text-xs text-destructive">
              Not sent: {item.error}
              <Button
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() => onRetry(item)}
              >
                Retry
              </Button>
              <Button
                variant="ghost"
                className="h-6 px-2 text-xs text-muted-foreground"
                onClick={() => onDismiss(item)}
              >
                Dismiss
              </Button>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function SageChat({ sageId }: { sageId: string }) {
  const { rpc, sages, error, report } = useSages();
  const navigate = useBbNavigate();
  const [editing, setEditing] = useState(false);
  const [branching, setBranching] = useState(false);
  const [askingClose, setAskingClose] = useState(false);
  const sage = sages?.find((candidate) => candidate.id === sageId);
  const parent =
    sage?.parentId == null
      ? undefined
      : sages?.find((candidate) => candidate.id === sage.parentId);
  // An acolyte's way back is its lead.
  const toList = () =>
    sage?.parentId == null
      ? navigate.toPluginPanel(PANEL_PATH)
      : toSage(navigate, sage.parentId);
  const history = useHistory(sageId, sage?.stats.messages ?? 0);
  // The turn on screen, kept after it ends: swapping back to the logged chat
  // would reflow the page for nothing. A new turn replaces it once loaded.
  const [shown, setShown] = useState<Turn | null>(null);
  const [outgoing, setOutgoing] = useState<Outgoing[]>([]);
  // A message leaves the outbox once the chat has logged it: one logged
  // user message from when it was sent on clears the oldest one waiting.
  useEffect(() => {
    if (outgoing.length === 0) return;
    const from = Math.min(...outgoing.map((item) => item.after));
    const logged = history.messages.filter(
      (message) => message.kind === "user" && message.i >= from,
    ).length;
    if (logged > 0) setOutgoing((current) => current.slice(logged));
  }, [history.messages]); // eslint-disable-line react-hooks/exhaustive-deps
  const pending: Turn | null =
    sage?.running === true &&
    sage.threadId !== null &&
    sage.threadId !== shown?.threadId
      ? { threadId: sage.threadId, turnStart: sage.turnStart }
      : null;

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

  const post = (item: Outgoing) => {
    rpc
      .call("sages_send", {
        id: sage.id,
        request: item.request,
        requestId: item.requestId,
      })
      .catch((cause: unknown) => {
        // The server may have it all the same: a retry carries the same
        // id, so it is never sent twice.
        setOutgoing((current) =>
          current.map((each) =>
            each.requestId === item.requestId
              ? { ...each, error: errorText(cause) }
              : each,
          ),
        );
      });
  };
  // Never throws: the message stays on the page as sending or unsent, and
  // the composer clears, so a slow send is never mistaken for a lost one.
  const sendMessage = async (request: NewThreadRequest) => {
    const item: Outgoing = {
      requestId: crypto.randomUUID(),
      // The request crosses RPC as plain JSON; bb validates it at spawn.
      request: JSON.parse(JSON.stringify(request)),
      text: visibleText(request.input),
      after: sage.stats.messages,
      error: null,
    };
    setOutgoing((current) => [...current, item]);
    post(item);
  };
  const retry = (item: Outgoing) => {
    setOutgoing((current) =>
      current.map((each) =>
        each.requestId === item.requestId ? { ...each, error: null } : each,
      ),
    );
    post(item);
  };
  const outbox = (
    <Outbox
      items={outgoing.map((item) =>
        item.error === null && sage.unsent?.requestId === item.requestId
          ? { ...item, error: sage.unsent.error }
          : item,
      )}
      onRetry={retry}
      onDismiss={(item) =>
        setOutgoing((current) =>
          current.filter((each) => each.requestId !== item.requestId),
        )
      }
    />
  );
  const isAcolyte = sage.parentId !== null;
  const acolytes = new Map(
    sages
      .filter((candidate) => candidate.parentId === sage.id)
      .map((acolyte) => [acolyte.id, acolyte]),
  );
  const openAcolytes = [...acolytes.values()].filter(
    (acolyte) => acolyte.archivedAt === null,
  );
  const remove = () => {
    if (
      !window.confirm(
        isAcolyte
          ? `Delete the acolyte "${sage.name}" and its chat? Nothing goes back to ${parent?.name ?? "its lead"}. This cannot be undone.`
          : `Delete "${sage.name}", its whole chat and its acolytes? This cannot be undone.`,
      )
    ) {
      return;
    }
    rpc.call("sages_remove", { id: sage.id }).then(toList, report);
  };
  /** The logged chat; before a turn, up to where the turn's thread starts. */
  const transcript = (turn: Turn | null) => (
    <Transcript
      messages={
        turn?.turnStart == null
          ? history.messages
          : history.messages.filter((message) => message.i < turn.turnStart!)
      }
      more={history.more}
      onLoadEarlier={history.loadEarlier}
      acolytes={acolytes}
    />
  );
  const seeds = (sage.defaults ?? {}) as Partial<NewThreadRequest>;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border py-2 pl-4 pr-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{sage.name}</div>
        </div>
        {sage.running ? (
          // In the header, so the chat never shifts as turns start and end.
          <Button
            variant="ghost"
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
            aria-label={`Stop ${sage.name}`}
            onClick={() => {
              rpc.call("sages_stop", { id: sage.id }).catch(report);
            }}
          >
            <span
              aria-hidden="true"
              className="size-1.5 animate-pulse rounded-full bg-amber-500"
            />
            Stop
          </Button>
        ) : null}
        {isAcolyte && sage.archivedAt === null && !sage.closing ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Close acolyte"
            onClick={() => setAskingClose((current) => !current)}
          >
            <Icon name="Archive" className="size-4" />
          </Button>
        ) : null}
        {isAcolyte ? null : (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="New acolyte"
            onClick={() => setBranching((current) => !current)}
          >
            <Icon name="GitBranch" className="size-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Edit sage"
          onClick={() => setEditing((current) => !current)}
        >
          <Icon name="Edit" className="size-4" />
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
      {branching && !isAcolyte ? (
        <NewAcolyteForm
          sage={sage}
          onDone={() => setBranching(false)}
          onError={report}
        />
      ) : null}
      {error === null ? null : (
        <div className="px-4 pt-2">
          <ErrorLine error={error} />
        </div>
      )}
      {editing ? (
        <div className="min-h-0 flex-1 overflow-y-auto py-4">
          <div className={CHAT_COLUMN}>
            <SageForm
              initial={sage}
              // A sage with acolytes of its own leads; it cannot serve one.
              leads={
                acolytes.size > 0
                  ? []
                  : sages.filter(
                      (each) => each.parentId === null && each.id !== sage.id,
                    )
              }
              submitLabel="Save"
              onCancel={() => setEditing(false)}
              onSubmit={async ({
                name,
                topic,
                instructions,
                projectId,
                parentId,
              }) => {
                try {
                  await rpc.call("sages_update", {
                    id: sage.id,
                    name,
                    topic,
                    projectId,
                    instructions,
                    parentId,
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
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          {shown === null ? (
            <ScrollToEnd
              watch={sage.stats.messages}
              className="min-h-0 flex-1 overflow-y-auto"
            >
              <div className={CHAT_COLUMN}>
                {/* ThreadChat's own padding, so nothing shifts when it
                    takes over. */}
                <div className="px-2 pb-3 pt-3">
                  {transcript(null)}
                  {outbox}
                </div>
              </div>
            </ScrollToEnd>
          ) : null}
          {[shown, pending].map((turn) =>
            turn === null ? null : (
              <TurnView
                // Keyed by thread, so the loaded view is shown in place.
                key={turn.threadId}
                turn={turn}
                visible={turn === shown}
                leading={transcript(turn)}
                trailing={outbox}
                onReady={() => setShown(turn)}
              />
            ),
          )}
        </div>
      )}
      {/* One composer for the life of the page, in the same place whatever
          the chat shows, so a draft survives turns starting and ending. */}
      <div className={`${CHAT_COLUMN} shrink-0 pb-4`}>
        {isAcolyte ? (
          <AcolyteClosing
            acolyte={sage}
            parent={parent}
            asking={askingClose}
            onAsked={() => setAskingClose(false)}
            onError={report}
          />
        ) : null}
        {sage.error === null ? null : (
          <p role="alert" className="pb-2 text-sm text-destructive">
            {sage.error.startsWith("Clos")
              ? sage.error
              : `The last turn failed: ${sage.error}`}
          </p>
        )}
        <OpenAcolytes acolytes={openAcolytes} />

        {sage.archivedAt !== null || sage.closing ? null : (
          // Its own box: the composer fills its parent's height, so lines
          // above it in a shared box would push its controls out of sight.
          <div>
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
        )}
      </div>
    </div>
  );
}

function SagesPage({ subPath }: PluginNavPanelProps) {
  const sageId = subPath.split("/")[0] ?? "";
  const navigate = useBbNavigate();
  if (sageId !== "" && sageId !== "envoys") return <SageChat key={sageId} sageId={sageId} />;
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex gap-2 border-b border-border px-4 py-2" role="tablist" aria-label="Workstreams">
      <Button role="tab" aria-selected={sageId === ""} variant={sageId === "" ? "secondary" : "ghost"} onClick={() => navigate.toPluginPanel(PANEL_PATH)}>Sages</Button>
      <Button role="tab" aria-selected={sageId === "envoys"} variant={sageId === "envoys" ? "secondary" : "ghost"} onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "envoys" })}>Envoys</Button>
    </div>
    {sageId === "envoys" ? <EnvoyList /> : <SageList />}
  </div>;
}

export default definePluginApp((app) => {
  registerEnvoyApp(app);
  registerSettingsApp(app);
  app.slots.navPanel({
    id: "sages",
    title: "Sages",
    icon: "sages/sage",
    path: PANEL_PATH,
    component: SagesPage,
  });
});
