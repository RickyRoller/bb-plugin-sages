// bb-plugin-sages — frontend entry.
//
// One sidebar page. Its root lists sages and creates them; `/<sage-id>` is
// that sage's chat, and an acolyte's chat too: an acolyte is a sage of its own
// whose `parentId` names the sage it branched off. A sage's chat never ends,
// and each message is a turn in a fresh thread: the page shows the logged
// chat, bb's NewThreadComposer sends the next message, and bb's ThreadChat
// shows the turn while it runs.
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
import { z } from "zod";
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
  if (match === null) return <Markdown content={text} />;
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
        <Markdown content={body} />
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
        <Markdown content={body} />
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
      <Markdown content={markerBody(text)} />
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
  if (messages.length === 0) return null;
  return (
    // Wide tables and code scroll sideways in place, as in bb's chats,
    // rather than running off a phone's screen.
    <div className="flex min-w-0 flex-col gap-4 py-4 break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto">
      {more ? (
        <Button variant="ghost" className="self-center" onClick={onLoadEarlier}>
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
          <Markdown key={message.i} content={message.text} />
        ),
      )}
    </div>
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
  onReady,
}: {
  turn: Turn;
  visible: boolean;
  leading: ReactNode;
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

  const sendMessage = async (request: NewThreadRequest) => {
    // The request crosses RPC as plain JSON; bb validates it at spawn.
    await rpc.call("sages_send", {
      id: sage.id,
      request: JSON.parse(JSON.stringify(request)),
    });
  };
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
                <div className="px-2 pb-3 pt-3">{transcript(null)}</div>
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

// --- Dev services ---
// bb offers thread side-panel tools only on thread pages, and a sage page
// has no thread. This tab drives the Dev Services plugin for the sage's
// project instead, over that plugin's RPC.

const devStatusSchema = z
  .object({
    projectName: z.string(),
    commands: z.array(
      z.object({
        name: z.string(),
        status: z.string(),
        exitCode: z.number().nullable(),
        output: z.string(),
      }),
    ),
    services: z.array(
      z.object({
        name: z.string(),
        port: z.number(),
        running: z.boolean(),
        url: z.string().nullable(),
      }),
    ),
  })
  .nullable();
type DevStatus = z.infer<typeof devStatusSchema>;
const DEV_POLL_MS = 3000;
// CSI/OSC escape sequences and carriage returns from the PTY stream.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\r/g;

function StatusDot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`size-2 shrink-0 rounded-full ${on ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
    />
  );
}

function SageDevServices({ subPath }: PluginNavPanelProps) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const { sages } = useSages();
  const sage = sages?.find((each) => each.id === subPath.split("/")[0]);
  const projectId =
    sage?.projectId ??
    (typeof sage?.defaults?.projectId === "string"
      ? sage.defaults.projectId
      : null);
  // undefined while loading; null when the project registers no services.
  const [status, setStatus] = useState<DevStatus | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"start" | "stop" | null>(null);

  const call = useCallback(
    (method: "status" | "start" | "stop") =>
      sdk.plugins.callRpc({
        pluginId: "dev-services",
        method,
        input: { projectId },
        outputSchema: devStatusSchema,
      }),
    [sdk, projectId],
  );
  const refresh = useCallback(() => {
    if (projectId === null) return;
    call("status").then(
      (next) => {
        setStatus(next);
        setError(null);
      },
      (cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [call, projectId]);
  useEffect(() => {
    setStatus(undefined);
    refresh();
    const timer = window.setInterval(refresh, DEV_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  if (sage === undefined) {
    return (
      <p className="text-sm text-muted-foreground">
        Open a sage to see its project's dev services.
      </p>
    );
  }
  if (projectId === null) {
    return (
      <p className="text-sm text-muted-foreground">
        {sage.name} has no project. Assign one with the pencil button, or send a
        message in a project, to use its dev services.
      </p>
    );
  }
  if (status === null) {
    return (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>This project hasn't registered any dev services.</p>
        <p className="text-xs">
          Add a <code>.bb-dev-services.json</code> file at the repository root
          to register commands.
        </p>
      </div>
    );
  }

  const run = async (action: "start" | "stop") => {
    setPending(action);
    try {
      setStatus(await call(action));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };
  const active = (state: string) => state === "running" || state === "starting";
  const allActive =
    status !== undefined &&
    status.commands.every((command) => active(command.status));

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Dev services</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {status?.projectName ?? "Loading…"}
          </p>
        </div>
        <Button
          aria-label="Refresh status"
          disabled={pending !== null}
          onClick={refresh}
          size="icon"
          variant="ghost"
        >
          <Icon name="ArrowReloadHorizontal" className="size-4" />
        </Button>
      </div>
      {error === null ? null : (
        <p
          role="alert"
          className="whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
        >
          {error}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button
          disabled={pending !== null || status === undefined || allActive}
          onClick={() => void run("start")}
        >
          {pending === "start" ? "Starting…" : "Start"}
        </Button>
        <Button
          disabled={pending !== null || status === undefined}
          onClick={() => void run("stop")}
          variant="outline"
        >
          {pending === "stop" ? "Stopping…" : "Stop"}
        </Button>
      </div>
      {status === undefined || status.services.length === 0 ? null : (
        <section className="space-y-2 rounded-lg border border-border bg-card p-3 text-card-foreground">
          <h3 className="text-xs font-semibold">Services</h3>
          {status.services.map((service) => (
            <div
              key={service.port}
              className="flex items-center justify-between gap-2 text-sm"
            >
              <span className="flex min-w-0 items-center gap-2">
                <StatusDot on={service.running} />
                <span className="truncate">{service.name}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  :{service.port}
                </span>
              </span>
              {service.url === null ? null : (
                <Button
                  disabled={!service.running}
                  onClick={() =>
                    service.url !== null && navigate.openUrl(service.url)
                  }
                  size="sm"
                  variant="secondary"
                >
                  Open ↗
                </Button>
              )}
            </div>
          ))}
        </section>
      )}
      {status?.commands.map((command) => (
        <details
          key={command.name}
          className="rounded-lg border border-border bg-card text-card-foreground"
        >
          <summary className="flex cursor-pointer items-center justify-between gap-2 p-3 text-sm">
            <span className="flex items-center gap-2">
              <StatusDot on={command.status === "running"} />
              {command.name}
            </span>
            <span className="text-xs text-muted-foreground">
              {command.status === "exited"
                ? `exited (${command.exitCode ?? "?"})`
                : command.status}
            </span>
          </summary>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-b-lg bg-muted p-3 font-mono text-[11px] leading-snug text-muted-foreground">
            {command.output
              .replace(ANSI, "")
              .split("\n")
              .slice(-60)
              .join("\n") || "No output yet."}
          </pre>
        </details>
      ))}
    </div>
  );
}

function SagesPage({ subPath }: PluginNavPanelProps) {
  const sageId = subPath.split("/")[0] ?? "";
  return sageId === "" ? (
    <SageList />
  ) : (
    <SageChat key={sageId} sageId={sageId} />
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "sages",
    title: "Sages",
    icon: "sages/sage",
    path: PANEL_PATH,
    component: SagesPage,
    fixedTabs: [
      {
        panelId: "sages",
        id: "dev-services",
        title: "Dev services",
        icon: "ComputerTerminal01",
        component: SageDevServices,
      },
    ],
  });
});
