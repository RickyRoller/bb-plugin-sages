// bb-plugin-sages — backend entry.
//
// A sage is a tuned chat bound to a topic or project. Its chat never ends:
// every message is logged in the plugin's database and compressed into a tree
// of summaries (optchat.ts), and each user message runs as one turn in a
// fresh, hidden bb thread whose first input is the view of that tree. This
// file owns the sage records, the turns, the logging of what a turn's thread
// does, the zoom/date tools, the compaction model call, and the CLI.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { Chat, MIGRATIONS, type Kind, type Summarize } from "./optchat";
import { registerEnvoys } from "./envoys.ts";
import {
  COMPACTION_PROMPT,
  HANDOFF_PROMPT,
  ACOLYTE_PROMPT,
  ACOLYTE_SUMMARY_PROMPT,
  TURN_PROMPT,
} from "./prompts";

const sageSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** One line on what the sage is for; shown in lists. */
  topic: z.string(),
  /** Standing instructions given to the sage's agent. */
  instructions: z.string(),
  /** The project the sage's turns start in by default, if one is assigned. */
  projectId: z.string().nullable().default(null),
  /** The thread of the sage's latest turn. */
  threadId: z.string().nullable().default(null),
  /** Whether that turn is still going. */
  running: z.boolean().default(false),
  /** The id of the user message that turn started with. */
  turnStart: z.number().nullable().default(null),
  /** Why the latest turn failed, if it did. */
  error: z.string().nullable().default(null),
  /** The latest turn's selections, to seed the next composer. */
  defaults: z.record(z.string(), z.unknown()).nullable().default(null),
  /**
   * For an acolyte: its lead sage, whose chat it reads as memory. An
   * acolyte's topic is its focus within the lead's work.
   */
  parentId: z.string().nullable().default(null),
  /** When the acolyte was closed; it is kept, read-only, until reopened. */
  archivedAt: z.string().nullable().default(null),
  /** Whether the acolyte's closing summary is being written. */
  closing: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Sage = z.infer<typeof sageSchema>;

const statsSchema = z.object({
  messages: z.number(),
  viewBytes: z.number(),
  pending: z.number(),
});
const listedSageSchema = sageSchema.extend({ stats: statsSchema });
export type ListedSage = z.infer<typeof listedSageSchema>;

const nameInput = z.string().trim().min(1).max(80);
const topicInput = z.string().trim().max(200);
// bb truncates dynamic thread instructions at 4096 characters; the cap leaves
// room for the name and topic lines that are sent with them.
const instructionsInput = z.string().trim().max(3500);

// The composer's NewThreadRequest. bb validates it in full at spawn; this
// checks only what the plugin reads.
const promptPartSchema = z.looseObject({ type: z.string() });
const turnRequestSchema = z.looseObject({
  projectId: z.string(),
  input: z.array(promptPartSchema).min(1),
});

export const rpcContract = defineRpcContract({
  sages_list: {
    input: z.null(),
    output: z.object({ sages: z.array(listedSageSchema) }),
  },
  sages_create: {
    input: z.object({
      name: nameInput,
      /** Creates it as an acolyte of this sage. */
      parentId: z.string().nullable().default(null),
      topic: topicInput.default(""),
      instructions: instructionsInput.default(""),
      projectId: z.string().nullable().default(null),
    }),
    output: sageSchema,
  },
  sages_update: {
    input: z.object({
      id: z.string(),
      /** Makes the sage an acolyte of this sage, or with null, its own lead. */
      parentId: z.string().nullable().optional(),
      name: nameInput.optional(),
      topic: topicInput.optional(),
      instructions: instructionsInput.optional(),
      projectId: z.string().nullable().optional(),
    }),
    output: sageSchema,
  },
  /** Deletes the sage and its whole chat. */
  sages_remove: {
    input: z.object({ id: z.string() }),
    output: z.object({ removed: z.boolean() }),
  },
  /** Starts a turn: one user message, answered in a fresh thread. */
  sages_send: {
    input: z.object({ id: z.string(), request: turnRequestSchema }),
    output: sageSchema,
  },
  /** Puts sages in this order; ids left out keep their place after these. */
  sages_reorder: {
    input: z.object({ ids: z.array(z.string()).max(1000) }),
    output: z.object({ ids: z.array(z.string()) }),
  },
  /** Stops the running turn. */
  sages_stop: {
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  /** The user's and the sage's messages before `before`, oldest first. */
  sages_history: {
    input: z.object({
      id: z.string(),
      before: z.number().int().nullable(),
      limit: z.number().int().min(1).max(200),
    }),
    output: z.object({
      messages: z.array(
        z.object({
          i: z.number(),
          kind: z.enum(["user", "sage", "tool", "echo", "work", "acolyte"]),
          text: z.string(),
          date: z.string(),
        }),
      ),
    }),
  },
  /** Opens an acolyte of a sage from the UI, empty, for the user to start. */
  sages_open_acolyte: {
    input: z.object({ id: z.string(), name: nameInput, focus: topicInput }),
    output: sageSchema,
  },
  /**
   * Closes an acolyte: archived as is, or after a summary of it is sent to
   * its sage's main chat.
   */
  sages_close_acolyte: {
    input: z.object({ id: z.string(), summary: z.boolean() }),
    output: sageSchema,
  },
  sages_reopen_acolyte: {
    input: z.object({ id: z.string() }),
    output: sageSchema,
  },
});

/** Realtime channel app.tsx listens on. */
const SAGES_CHANGED = "sages-changed";
const ZOOM_TOOL = "sage_zoom";
const DATE_TOOL = "sage_date";
const HANDOFF_TOOL = "sage_handoff";
const ACOLYTE_TOOL = "sage_acolyte";

/** A specialist, as the Specialists plugin lists it. */
const specialistSchema = z.looseObject({
  name: z.string(),
  description: z.string(),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  reasoningLevel: z.string().nullable(),
});
type Specialist = z.infer<typeof specialistSchema>;

function specialistsText(specialists: Specialist[] | null): string {
  if (specialists === null) {
    return "Specialists: unavailable right now (the Specialists plugin did not answer).";
  }
  if (specialists.length === 0) return "Specialists: none are set up.";
  return [
    "Specialists you can hand work to with sage_handoff:",
    ...specialists.map((each) => {
      const model =
        each.model === null
          ? "project default model"
          : `${each.providerId === null ? "" : `${each.providerId}/`}${each.model}${each.reasoningLevel === null ? "" : ` (${each.reasoningLevel})`}`;
      return `- ${each.name} [${model}]: ${each.description || "no description"}`;
    }),
  ].join("\n");
}
/** bb's cap on one page of thread events. */
const EVENT_PAGE = 100;
/** The thread events a turn is logged from. */
const LOGGED_EVENTS = [
  "client/turn/requested",
  "item/completed",
  "turn/started",
  "turn/completed",
] as const;

function sageInstructions(sage: Sage): string {
  return [
    `# Your sage instructions`,
    `Your name is "${sage.name}".`,
    sage.topic === "" ? null : `Your subject: ${sage.topic}`,
    sage.instructions === "" ? null : `\n${sage.instructions}`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** A prompt input as the chat logs it: the words, and a mark per attachment. */
function inputText(input: unknown): string {
  if (!Array.isArray(input)) return "";
  return input
    .map((part: Record<string, unknown>) => {
      if (part.visibility === "agent-only") return null;
      if (part.type === "text") return String(part.text ?? "");
      return `[${String(part.type)}${typeof part.path === "string" ? `: ${part.path}` : ""}]`;
    })
    .filter((text) => text !== null && text !== "")
    .join("\n");
}

/** A completed timeline item as a tool call and its result. */
function toolTexts(item: Record<string, unknown>): {
  tool: string;
  echo: string | null;
} {
  const {
    type,
    tool,
    id: _id,
    status: _status,
    presentation: _presentation,
    approvalStatus: _approvalStatus,
    result,
    aggregatedOutput,
    output,
    ...input
  } = item;
  const out = result ?? aggregatedOutput ?? output ?? null;
  return {
    tool: `${String(type === "toolCall" ? tool : type)} ${JSON.stringify(input.arguments ?? input)}`,
    echo:
      out === null ? null : typeof out === "string" ? out : JSON.stringify(out),
  };
}

/** The head of an acolyte's marker in its sage's main chat. */
const acolyteHead = (
  acolyte: Sage,
  event: "opened" | "closed" | "archived" | "reopened" | "joined" | "left",
) => `[acolyte ${acolyte.id}] ${event}: ${acolyte.name}`;

/** The main chat's view as an acolyte's turn sees it, apart from its own. */
const mainView = (view: string) =>
  view.replace(/^<chat>/u, "<main>").replace(/<\/chat>$/u, "</main>");

const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    compactionModel: {
      type: "string",
      label: "Compaction model",
      description:
        "The cheap model that summarizes the chat in the background, as a Claude Code model name.",
      default: "haiku",
    },
    compactionEffort: {
      type: "select",
      label: "Compaction effort",
      options: ["low", "medium", "high", "xhigh", "max"],
      default: "xhigh",
    },
    claudePath: {
      type: "string",
      label: "Claude Code command",
      description:
        "The claude CLI that runs compactions. Leave as is to find it on your shell's PATH.",
      default: "claude",
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const envoys = await registerEnvoys(bb);

  // bb.agents.configure is synchronous, so sages are served from memory and
  // written through to storage.
  let sages = z
    .array(sageSchema)
    .catch([])
    .parse(await bb.storage.kv.get("sages"));

  // Compactions land in bursts; one refetch signal per burst is enough.
  let publishTimer: NodeJS.Timeout | null = null;
  function publish(): void {
    publishTimer ??= setTimeout(() => {
      publishTimer = null;
      bb.realtime.publish(SAGES_CHANGED, { count: sages.length });
    }, 300);
  }
  async function writeSages(next: Sage[]): Promise<void> {
    await bb.storage.kv.set("sages", next);
    sages = next;
    publish();
  }
  function findSage(id: string): Sage {
    const sage = sages.find((candidate) => candidate.id === id);
    if (sage === undefined) throw new Error(`No sage with id ${id}`);
    return sage;
  }
  async function updateSage(id: string, patch: Partial<Sage>): Promise<Sage> {
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    const sage: Sage = {
      ...findSage(id),
      ...defined,
      updatedAt: new Date().toISOString(),
    };
    await writeSages(
      sages.map((candidate) => (candidate.id === id ? sage : candidate)),
    );
    return sage;
  }
  /** Creates a sage, as an acolyte of its lead if one is given. */
  async function createUnder({
    parentId,
    ...fields
  }: Pick<
    Sage,
    "name" | "topic" | "instructions" | "projectId" | "parentId"
  >): Promise<Sage> {
    if (parentId !== null) findSage(parentId);
    const sage = await createSage(fields);
    if (parentId === null) return sage;
    try {
      await moveSage(sage.id, parentId);
    } catch (cause) {
      await removeSage(sage.id);
      throw cause;
    }
    return findSage(sage.id);
  }
  async function createSage(
    fields: Pick<Sage, "name" | "topic" | "instructions" | "projectId">,
  ): Promise<Sage> {
    const now = new Date().toISOString();
    const sage = sageSchema.parse({
      id: randomUUID().slice(0, 8),
      ...fields,
      createdAt: now,
      updatedAt: now,
    });
    await writeSages([...sages, sage]);
    return sage;
  }

  // --- Compaction calls: the claude CLI, headless, with no tools. ---

  let claude: Promise<string> | null = null;
  /** The claude binary: the setting as given, or looked up in the user's shell. */
  function findClaude(command: string): Promise<string> {
    claude ??= promisify(execFile)(command, ["--version"]).then(
      () => command,
      async () => {
        const { stdout } = await promisify(execFile)(
          process.env.SHELL ?? "/bin/sh",
          ["-ilc", `command -v ${JSON.stringify(command)}`],
        );
        const found = stdout.trim().split("\n").pop() ?? "";
        if (found === "") throw new Error(`"${command}" was not found`);
        return found;
      },
    );
    claude.catch(() => {
      claude = null;
    });
    return claude;
  }
  const summarize: Summarize = (conversation, signal) =>
    // A retry is the same conversation, resent whole in one prompt.
    runClaude(
      COMPACTION_PROMPT,
      conversation
        .map((message, index) =>
          index % 2 === 0 ? message : `Your line was:\n${message}`,
        )
        .join("\n\n"),
      signal,
    );
  async function runClaude(
    system: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string> {
    const { compactionModel, compactionEffort, claudePath } =
      await settings.get();
    const command = await findClaude(claudePath);
    return new Promise((resolve, reject) => {
      const child = spawn(
        command,
        [
          "-p",
          ...["--model", compactionModel],
          ...["--effort", compactionEffort],
          ...["--system-prompt", system],
          ...["--tools", ""],
          ...["--setting-sources", ""],
          "--strict-mcp-config",
          "--disable-slash-commands",
          "--no-session-persistence",
        ],
        {
          cwd: tmpdir(),
          signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else {
          reject(
            new Error(
              `claude exited with ${code}: ${(stderr || stdout).trim().slice(0, 300)}`,
            ),
          );
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
  }

  // --- Chats ---

  const chats = new Map<string, Chat>();
  function chatOf(sageId: string): Chat {
    let chat = chats.get(sageId);
    if (chat === undefined) {
      chat = new Chat(db, sageId, summarize, (error) => {
        // An abort is a reload or shutdown, not a failure.
        if (
          error !== undefined &&
          !(error instanceof Error && error.name === "AbortError")
        ) {
          bb.log.warn(`compaction failed: ${errorText(error)}`);
        }
        publish();
      });
      chats.set(sageId, chat);
    }
    return chat;
  }
  /**
   * Deletes the sage and its chat, and its acolytes; their turn threads stay
   * in bb, archived.
   */
  async function removeSage(id: string): Promise<boolean> {
    if (!sages.some((sage) => sage.id === id)) return false;
    for (const acolyte of sages.filter((sage) => sage.parentId === id)) {
      await removeSage(acolyte.id);
    }
    const { threadId } = findSage(id);
    if (threadId !== null) bb.sdk.threads.archive({ threadId }).catch(() => {});
    chatOf(id).destroy();
    chats.delete(id);
    await bb.storage.kv.delete(`cursor:${id}`);
    await writeSages(sages.filter((sage) => sage.id !== id));
    nudgeSidebar();
    return true;
  }

  // One writer per chat: a sage's sends and its thread's events are handled
  // one at a time, in order.
  const queues = new Map<string, Promise<unknown>>();
  function serial<T>(sageId: string, work: () => Promise<T>): Promise<T> {
    const next = (queues.get(sageId) ?? Promise.resolve()).then(work, work);
    queues.set(
      sageId,
      next.catch(() => {}),
    );
    return next;
  }

  // --- Turns ---

  interface Cursor {
    threadId: string;
    /** The last event of the thread that was logged. */
    seq: number;
  }

  /** Logs what the sage's thread did since the last call. */
  async function drain(sageId: string): Promise<void> {
    const sage = findSage(sageId);
    const cursor = await bb.storage.kv.get<Cursor>(`cursor:${sageId}`);
    if (cursor == null || cursor.threadId !== sage.threadId) return;
    const chat = chatOf(sageId);
    let running = sage.running;
    for (;;) {
      const events = await bb.sdk.threads.events.list({
        threadId: cursor.threadId,
        afterSeq: String(cursor.seq),
        limit: String(EVENT_PAGE),
        types: [...LOGGED_EVENTS],
      });
      for (const event of events) {
        const date = new Date(event.createdAt).toISOString();
        const data = event.data as Record<string, unknown>;
        const item = (data.item ?? {}) as Record<string, unknown>;
        if (event.type === "turn/started") running = true;
        else if (event.type === "turn/completed") running = false;
        else if (event.type === "client/turn/requested") {
          // The spawn's own message is logged by send(); these are the
          // messages the user sends while the sage works.
          if (data.source !== "spawn") {
            const text = inputText(data.input);
            // bb heads a message sent on another thread's behalf with this.
            const notice = text.replace(
              /^\[bb message from thread:\S+\]\s*/u,
              "",
            );
            const report = reports.get(notice)?.shift();
            if (report === undefined) chat.append("user", text, date);
            else chat.append(report.kind, report.text, date);
          }
        } else if (item.type === "agentMessage") {
          chat.append("sage", String(item.text ?? ""), date);
        } else if (item.type !== "reasoning") {
          // Thoughts are shown but never logged.
          const { tool, echo } = toolTexts(item);
          chat.append("tool", tool, date);
          if (echo !== null) chat.append("echo", echo, date);
        }
        cursor.seq = event.seq;
      }
      if (events.length < EVENT_PAGE) break;
    }
    await bb.storage.kv.set(`cursor:${sageId}`, cursor);
    if (running !== sage.running) await updateSage(sageId, { running });
  }

  async function send(
    sageId: string,
    request: z.infer<typeof turnRequestSchema>,
    /** For a turn that starts with a specialist's report. */
    from?: { kind: Kind; log: string },
  ): Promise<Sage> {
    let sage = findSage(sageId);
    if (sage.archivedAt !== null) {
      throw new Error(`The acolyte "${sage.name}" is closed; reopen it first`);
    }
    if (sage.running && sage.threadId !== null) {
      // The flag follows the thread's events; ask the thread before refusing.
      await drain(sageId);
      const thread = await bb.sdk.threads.get({ threadId: sage.threadId });
      if (thread.status === "idle" || thread.status === "error") {
        await updateSage(sageId, { running: false });
      }
      sage = findSage(sageId);
      if (sage.running && from === undefined) {
        // A message sent while the sage works joins the running turn
        // between its steps; its log records it as the user's.
        await bb.sdk.threads.send({
          threadId: sage.threadId!,
          mode: "auto",
          input: request.input,
        } as unknown as Parameters<typeof bb.sdk.threads.send>[0]);
        return sage;
      }
      if (sage.running) {
        throw new Error(`${sage.name} is still working on the last message`);
      }
    }
    const chat = chatOf(sageId);
    // Every message before this one is summarized first, so the view holds
    // no placeholder for work the compactor is about to finish.
    await chat.settled();
    // The view is rendered before the new message is logged: the message
    // goes whole after it. Per-turn state follows the view, so the view
    // stays a stable prefix from one turn to the next.
    const view = chat.render();
    const thread = await bb.sdk.threads.spawn({
      ...(request as Record<string, unknown>),
      projectId: request.projectId,
      input: [
        ...(await turnContext(sage, view)).map((text) => ({
          type: "text",
          text,
          visibility: "agent-only",
          mentions: [],
        })),
        ...request.input,
      ],
      title: sage.name,
      // Sages always run with full access, whatever the composer sent.
      permissionMode: "full",
      // A turn's thread is plumbing: the sage's page is where the chat lives.
      visibility: "hidden",
      pluginMetadata: { sageId },
    } as unknown as Parameters<typeof bb.sdk.threads.spawn>[0]);
    const [turnStart = null] = chat.append(
      from?.kind ?? "user",
      from?.log ?? inputText(request.input),
    );
    await bb.storage.kv.set(`cursor:${sageId}`, {
      threadId: thread.id,
      seq: 0,
    } satisfies Cursor);
    if (sage.threadId !== null) {
      bb.sdk.threads.archive({ threadId: sage.threadId }).catch(() => {});
    }
    const { input: _input, ...selection } = request;
    return updateSage(sageId, {
      threadId: thread.id,
      running: true,
      turnStart,
      error: null,
      defaults: selection,
    });
  }

  /**
   * What a turn sees before the user's message: the views, then the state of
   * the world, which is read now so every turn sees it as it is.
   */
  async function turnContext(sage: Sage, view: string): Promise<string[]> {
    const specialists = specialistsText(await listSpecialists());
    const date = `Date: ${new Date().toString()}`;
    if (sage.parentId === null) {
      const open = sages.filter(
        (acolyte) =>
          acolyte.parentId === sage.id && acolyte.archivedAt === null,
      );
      const acolytes =
        open.length === 0
          ? "Your acolytes: none."
          : [
              "Your acolytes:",
              ...open.map(
                (acolyte) =>
                  `- "${acolyte.name}" (acolyte ${acolyte.id}, since ${acolyte.createdAt}${acolyte.running ? ", working" : ""}): ${acolyte.topic || "no focus given"}`,
              ),
            ].join("\n");
      return [view, [date, acolytes, specialists].join("\n\n")];
    }
    const parent = findSage(sage.parentId);
    const acolyte = [
      `You are ${sage.name}, an acolyte of ${parent.name}: a sage under it, focused on ${sage.topic === "" ? "one part of its work" : sage.topic}. ${parent.name}'s chat comes first, inside <main> tags, then your own view.`,
      `Both are your memory: zoom ${parent.name}'s with "main". Keep to your focus, and you cannot open acolytes. When a piece of work is done, say so: the user may go on here, or close this chat and send its summary to ${parent.name}.`,
      parent.instructions === ""
        ? null
        : `\n# ${parent.name}'s instructions, which you follow too\n${parent.instructions}`,
    ]
      .filter((line) => line !== null)
      .join(" ");
    return [
      mainView(chatOf(parent.id).render()),
      view,
      [date, acolyte, specialists].join("\n\n"),
    ];
  }

  // --- Acolytes ---

  /**
   * Tells the sidebar's Sages section, which loads only on demand, that the
   * acolytes changed. Without that plugin there is nothing to tell.
   */
  function nudgeSidebar(): void {
    bb.sdk.plugins
      .callRpc({
        pluginId: "sidebar-thread-details",
        method: "refreshSages",
        input: {},
        outputSchema: z.unknown(),
      })
      .catch(() => {});
  }

  async function openAcolyte(
    parentId: string,
    name: string,
    focus: string,
    /** The sage's brief, which the acolyte starts working on at once. */
    brief: string | null,
    /** Where the opening turn works: the main chat's running turn's place. */
    place?: { projectId: string; environmentId: string | null },
  ): Promise<Sage> {
    const parent = findSage(parentId);
    if (parent.parentId !== null) {
      throw new Error("An acolyte cannot open acolytes of its own");
    }
    const now = new Date().toISOString();
    const acolyte = sageSchema.parse({
      id: randomUUID().slice(0, 8),
      name,
      topic: focus,
      // The lead's instructions reach it with every turn; these are its own.
      instructions: "",
      projectId: parent.projectId,
      parentId,
      defaults:
        place === undefined
          ? parent.defaults
          : {
              ...parent.defaults,
              projectId: place.projectId,
              ...(place.environmentId === null
                ? {}
                : {
                    environment: {
                      type: "reuse",
                      environmentId: place.environmentId,
                    },
                  }),
            },
      createdAt: now,
      updatedAt: now,
    });
    await writeSages([...sages, acolyte]);
    nudgeSidebar();
    const about = [
      focus === "" ? null : `Focus: ${focus}`,
      brief ??
        (place === undefined
          ? "Opened by the user."
          : `Opened by ${parent.name}, for the user to start.`),
    ]
      .filter((line) => line !== null)
      .join("\n\n");
    chatOf(parentId).append(
      "acolyte",
      `${acolyteHead(acolyte, "opened")}\n\n${about}`,
    );
    const opening = `[acolyte of ${parent.name}] opened: ${name}\n\n${about}`;
    if (brief === null || acolyte.defaults === null) {
      chatOf(acolyte.id).append("acolyte", opening);
      return acolyte;
    }
    return serial(acolyte.id, () =>
      send(
        acolyte.id,
        turnRequestSchema.parse({
          ...acolyte.defaults,
          input: [
            { type: "text", text: `Opened by ${parent.name}`, mentions: [] },
            {
              type: "text",
              text: brief,
              visibility: "agent-only",
              mentions: [],
            },
          ],
        }),
        { kind: "acolyte", log: opening },
      ),
    );
  }

  /**
   * Puts a sage under a lead as its acolyte, or with null makes it its own
   * lead again. Its chat stays its own; the leads' chats record the move.
   */
  async function moveSage(id: string, parentId: string | null): Promise<void> {
    const sage = findSage(id);
    if (sage.parentId === parentId) return;
    if (parentId !== null) {
      const lead = findSage(parentId);
      if (lead.id === id) throw new Error("A sage cannot be its own acolyte");
      if (lead.parentId !== null) {
        throw new Error(`${lead.name} is itself an acolyte`);
      }
      if (sages.some((each) => each.parentId === id)) {
        throw new Error(`${sage.name} has acolytes of its own`);
      }
    }
    if (sage.parentId !== null) {
      chatOf(sage.parentId).append("acolyte", acolyteHead(sage, "left"));
    }
    if (parentId !== null) {
      chatOf(parentId).append(
        "acolyte",
        `${acolyteHead(sage, "joined")}\n\nFocus: ${sage.topic || "none given"}`,
      );
    }
    await updateSage(id, { parentId, archivedAt: null, closing: false });
    nudgeSidebar();
  }

  /** The acolyte's chat, written down for its main chat by the cheap model. */
  async function acolyteSummary(acolyte: Sage): Promise<string> {
    const chat = chatOf(acolyte.id);
    let log = chat
      .history(null, 100_000)
      .map((message) => `${message.kind}: ${message.text}`)
      .join("\n\n");
    // A long acolyte is read as its view, as the sage would.
    if (Buffer.byteLength(log) > 150_000) {
      await chat.settled();
      log = chat.render();
    }
    const summary = (
      await runClaude(
        ACOLYTE_SUMMARY_PROMPT,
        `<acolyte>\n${log}\n</acolyte>\nName: ${acolyte.name}\nFocus: ${acolyte.topic || "none given"}`,
        AbortSignal.timeout(300_000),
      )
    ).trim();
    if (summary === "") throw new Error("The summary came back empty");
    return summary;
  }

  async function archiveAcolyte(id: string): Promise<Sage> {
    const { threadId } = findSage(id);
    if (threadId !== null) bb.sdk.threads.archive({ threadId }).catch(() => {});
    const archived = await updateSage(id, {
      archivedAt: new Date().toISOString(),
      closing: false,
      running: false,
    });
    nudgeSidebar();
    return archived;
  }

  async function closeAcolyte(id: string, summary: boolean): Promise<Sage> {
    const acolyte = findSage(id);
    if (acolyte.parentId === null)
      throw new Error(`${acolyte.name} is not an acolyte`);
    if (acolyte.archivedAt !== null || acolyte.closing) return acolyte;
    const parentId = acolyte.parentId;
    if (acolyte.running && acolyte.threadId !== null) {
      await bb.sdk.threads.stop({ threadId: acolyte.threadId }).catch(() => {});
    }
    if (!summary) {
      chatOf(parentId).append(
        "acolyte",
        `${acolyteHead(acolyte, "archived")}\n\nClosed without a summary.`,
      );
      return archiveAcolyte(id);
    }
    const closing = await updateSage(id, { closing: true, error: null });
    // The summary takes a model call: the acolyte shows as closing meanwhile.
    serial(id, async () => {
      await drain(id).catch(() => {});
      const text = `${acolyteHead(acolyte, "closed")}\n\n${await acolyteSummary(acolyte)}`;
      await serial(parentId, async () => {
        try {
          await deliver(
            parentId,
            acolyte.threadId,
            `Acolyte "${acolyte.name}" closed with a summary`,
            text,
            "acolyte",
          );
        } catch (cause) {
          chatOf(parentId).append("acolyte", text);
          bb.log.warn(
            `could not deliver an acolyte summary: ${errorText(cause)}`,
          );
        }
      });
      await archiveAcolyte(id);
    }).catch(async (cause) => {
      bb.log.warn(`could not close an acolyte: ${errorText(cause)}`);
      await updateSage(id, {
        closing: false,
        error: `Closing failed: ${errorText(cause)}`,
      }).catch(() => {});
    });
    return closing;
  }

  async function reopenAcolyte(id: string): Promise<Sage> {
    const acolyte = findSage(id);
    if (acolyte.parentId === null || acolyte.archivedAt === null)
      return acolyte;
    chatOf(acolyte.parentId).append(
      "acolyte",
      acolyteHead(acolyte, "reopened"),
    );
    const reopened = await updateSage(id, { archivedAt: null });
    nudgeSidebar();
    return reopened;
  }

  // --- Specialists ---

  async function listSpecialists(): Promise<Specialist[] | null> {
    try {
      const { specialists } = await bb.sdk.plugins.callRpc({
        pluginId: "specialists",
        method: "specialists_list",
        input: null,
        outputSchema: z.object({ specialists: z.array(specialistSchema) }),
      });
      return specialists;
    } catch (cause) {
      bb.log.warn(`could not list specialists: ${errorText(cause)}`);
      return null;
    }
  }

  /** Specialist threads a sage handed work to, until they report back. */
  interface Worker {
    sageId: string;
    specialist: string;
  }
  const workers = new Map(
    Object.entries(
      (await bb.storage.kv.get<Record<string, Worker>>("workers")) ?? {},
    ),
  );
  const saveWorkers = () =>
    bb.storage.kv.set("workers", Object.fromEntries(workers));
  /**
   * Reports sent into a running turn by their one-line notice, so its log
   * records the whole report as work.
   */
  const reports = new Map<string, { kind: Kind; text: string }[]>();

  /**
   * Brings a specialist's report into the sage's chat: between the tool
   * calls of the running turn, or as a new turn when the sage is idle.
   */
  async function deliver(
    sageId: string,
    senderId: string | null,
    notice: string,
    report: string,
    kind: Kind = "work",
  ): Promise<void> {
    // The user sees one line from the specialist's thread; the agent gets
    // the whole report, and so does the chat's log.
    const input = [
      { type: "text", text: notice, mentions: [] },
      { type: "text", text: report, visibility: "agent-only", mentions: [] },
    ];
    await drain(sageId);
    const sage = findSage(sageId);
    if (sage.running && sage.threadId !== null) {
      reports.set(notice, [
        ...(reports.get(notice) ?? []),
        { kind, text: report },
      ]);
      await bb.sdk.threads.send({
        threadId: sage.threadId,
        mode: "auto",
        input,
        ...(senderId === null ? {} : { senderThreadId: senderId }),
      } as unknown as Parameters<typeof bb.sdk.threads.send>[0]);
      return;
    }
    if (sage.defaults === null) {
      throw new Error(`${sage.name} has no turn to report to`);
    }
    await send(sageId, turnRequestSchema.parse({ ...sage.defaults, input }), {
      kind,
      log: report,
    });
  }
  function workerDone(
    threadId: string,
    outcome: string,
    report: (name: string) => Promise<string>,
  ) {
    const worker = workers.get(threadId);
    if (worker === undefined) return;
    workers.delete(threadId);
    saveWorkers().catch(() => {});
    // A report for a closed acolyte goes to its main chat instead.
    let sage = sages.find((candidate) => candidate.id === worker.sageId);
    if (sage?.archivedAt != null && sage.parentId !== null) {
      sage = sages.find((candidate) => candidate.id === sage!.parentId);
    }
    if (sage === undefined) return;
    const sageId = sage.id;
    serial(sageId, async () => {
      const text = await report(worker.specialist);
      try {
        await deliver(
          sageId,
          threadId,
          `${worker.specialist} ${outcome}`,
          text,
        );
      } catch (cause) {
        // Undelivered, the report still joins the chat, so the sage sees it
        // in the view at its next turn.
        chatOf(sageId).append("work", text);
        throw cause;
      }
    }).catch((cause) =>
      bb.log.warn(`could not deliver a specialist report: ${errorText(cause)}`),
    );
  }
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) =>
    workerDone(thread.id, "finished", async (name) => {
      const text =
        lastAssistantText ??
        JSON.stringify(await bb.sdk.threads.output({ threadId: thread.id }));
      return `[${name}] report (thread ${thread.id}):\n${text}`;
    }),
  );
  bb.events.on("thread.failed", ({ thread, error }) =>
    workerDone(
      thread.id,
      "failed",
      async (name) =>
        `[${name}] failed (thread ${thread.id}): ${error ?? "no error given"}`,
    ),
  );

  function sageOfThread(threadId: string): Sage | undefined {
    return sages.find((sage) => sage.threadId === threadId);
  }
  function follow(threadId: string, after?: (sage: Sage) => Promise<unknown>) {
    const sage = sageOfThread(threadId);
    if (sage === undefined) return;
    serial(sage.id, async () => {
      await drain(sage.id);
      await after?.(sage);
    }).catch((cause) => bb.log.warn(`logging failed: ${errorText(cause)}`));
  }
  bb.events.on("experimental_thread.events", ({ thread }) => follow(thread.id));
  bb.events.on("thread.idle", ({ thread }) =>
    follow(thread.id, async (sage) => {
      await updateSage(sage.id, {
        running: false,
        // The next turn works where this one did. The environment exists
        // only once the thread has started, so it is read here.
        ...(thread.environmentId == null
          ? {}
          : {
              defaults: {
                ...findSage(sage.id).defaults,
                environment: {
                  type: "reuse",
                  environmentId: thread.environmentId,
                },
              },
            }),
      });
      // A hidden thread's runtime is released by hand; the thread is kept.
      await bb.sdk.threads.stop({ threadId: thread.id }).catch(() => {});
    }),
  );
  bb.events.on("thread.failed", ({ thread, error }) =>
    follow(thread.id, (sage) =>
      updateSage(sage.id, {
        running: false,
        error: error ?? "The turn failed",
      }),
    ),
  );
  // Catch up on what happened while the plugin was not loaded.
  for (const sage of sages) {
    if (sage.closing) {
      updateSage(sage.id, {
        closing: false,
        error: "Closing was interrupted; close it again",
      }).catch(() => {});
    }
    if (sage.threadId === null) continue;
    const { threadId } = sage;
    follow(threadId, async () => {
      const thread = await bb.sdk.threads.get({ threadId });
      if (sage.running && thread.status !== "active") {
        await updateSage(sage.id, { running: false });
      }
    });
  }

  bb.rpc.register(rpcContract, {
    sages_list: () => ({
      sages: sages.map((sage) => ({ ...sage, stats: chatOf(sage.id).stats() })),
    }),
    sages_create: (input) => createUnder(input),
    sages_update: async ({ id, parentId, ...patch }) => {
      if (parentId !== undefined) await moveSage(id, parentId);
      return updateSage(id, patch);
    },
    sages_remove: async ({ id }) => ({ removed: await removeSage(id) }),
    sages_send: ({ id, request }) => serial(id, () => send(id, request)),
    sages_reorder: async ({ ids }) => {
      const rank = new Map(ids.map((id, index) => [id, index]));
      const ordered = [...sages].sort(
        (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity),
      );
      await writeSages(ordered);
      return { ids: ordered.map((sage) => sage.id) };
    },
    sages_stop: async ({ id }) => {
      const { threadId, running } = findSage(id);
      if (!running || threadId === null) return { ok: false };
      await bb.sdk.threads.stop({ threadId });
      return { ok: true };
    },
    sages_history: ({ id, before, limit }) => {
      findSage(id);
      return { messages: chatOf(id).history(before, limit) };
    },
    sages_open_acolyte: ({ id, name, focus }) =>
      serial(id, () => openAcolyte(id, name, focus, null)),
    sages_close_acolyte: ({ id, summary }) => closeAcolyte(id, summary),
    sages_reopen_acolyte: ({ id }) => reopenAcolyte(id),
  });

  // --- The sage's agent: instructions and memory tools ---

  /** The sage a thread is a turn of, by the thread's metadata. */
  async function sageOfTurn(threadId: string): Promise<Sage> {
    const { sageId } = (await bb.sdk.threads.getPluginMetadata({
      threadId,
    })) as { sageId?: unknown };
    if (typeof sageId !== "string") throw new Error("Not a sage's thread");
    return findSage(sageId);
  }
  /** The chat a turn reads: its own, or in an acolyte the main one. */
  async function chatOfThread(
    threadId: string,
    which: "main" | undefined,
  ): Promise<Chat> {
    const sage = await sageOfTurn(threadId);
    if (which === undefined) return chatOf(sage.id);
    if (sage.parentId === null) {
      throw new Error('This is the main chat: leave out "main"');
    }
    return chatOf(sage.parentId);
  }
  const chatParameter = z
    .enum(["main"])
    .optional()
    .describe('In an acolyte, "main" reads the lead sage\'s view instead');
  const toolResult = async (work: () => Promise<string>) => {
    try {
      return await work();
    } catch (cause) {
      return {
        content: [{ type: "text" as const, text: errorText(cause) }],
        isError: true,
      };
    }
  };
  bb.agents.registerTool({
    name: ZOOM_TOOL,
    description:
      "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.",
    instructions: TURN_PROMPT,
    presentation: {
      label: { pending: "Remembering", completed: "Remembered" },
    },
    parameters: z.object({
      id: z.number().int().min(0).describe("The line's first message"),
      n: z
        .number()
        .int()
        .min(1)
        .describe("How many messages the line covers: a power of 2"),
      chat: chatParameter,
    }),
    execute: ({ id, n, chat }, { threadId }) =>
      toolResult(async () => (await chatOfThread(threadId, chat)).zoom(id, n)),
  });
  bb.agents.registerTool({
    name: DATE_TOOL,
    description: "The date and time of message id.",
    parameters: z.object({
      id: z.number().int().min(0),
      chat: chatParameter,
    }),
    execute: ({ id, chat }, { threadId }) =>
      toolResult(async () => (await chatOfThread(threadId, chat)).date(id)),
  });
  bb.agents.registerTool({
    name: HANDOFF_TOOL,
    description:
      'Hand work to a specialist. It runs in its own thread in your workspace and its report reaches this chat as a message starting "[name]". Returns the thread\'s id; never wait for it.',
    instructions: HANDOFF_PROMPT,
    presentation: {
      label: {
        pending: "Handing off to specialist",
        completed: "Handed off to specialist",
      },
    },
    parameters: z.object({
      specialist: z.string().min(1).describe("The specialist's name"),
      task: z
        .string()
        .trim()
        .min(1)
        .max(100_000)
        .describe(
          "A self-contained brief: the specialist sees your workspace but none of this chat.",
        ),
    }),
    execute: ({ specialist, task }, { threadId }) =>
      toolResult(async () => {
        const sage = await sageOfTurn(threadId);
        const sageId = sage.id;
        const turn = await bb.sdk.threads.get({ threadId });
        // No parent thread: bb would report the result to this turn's
        // thread, which a later message may have replaced. The report is
        // delivered to the sage's chat instead.
        const { threadId: workerId } = await bb.sdk.plugins.callRpc({
          pluginId: "specialists",
          method: "specialists_handoff",
          input: {
            specialist,
            task,
            projectId: turn.projectId,
            environmentId: turn.environmentId ?? null,
            requestedBy: `The sage "${sage.name}" (a long-running chat agent)`,
          },
          outputSchema: z.object({ threadId: z.string() }),
        });
        workers.set(workerId, { sageId, specialist });
        await saveWorkers();
        return [
          `Handed off to ${specialist} in thread ${workerId} (reference it to the user as @thread:${workerId}).`,
          `Its report reaches this chat as a message starting "[${specialist}]". Do not wait for it or do its work meanwhile.`,
        ].join("\n");
      }),
  });
  bb.agents.registerTool({
    name: ACOLYTE_TOOL,
    description:
      "Open an acolyte: a sage under you, with your memory, focused on one part of your work. Only when the user asks for one.",
    instructions: ACOLYTE_PROMPT,
    presentation: {
      label: { pending: "Opening acolyte", completed: "Opened acolyte" },
    },
    parameters: z.object({
      name: nameInput.describe("A few words naming the acolyte"),
      focus: topicInput.describe("One line on the part of your work it covers"),
      brief: z
        .string()
        .trim()
        .min(1)
        .max(30_000)
        .optional()
        .describe(
          "Its first message, which it works on at once: the goal, what to leave out, and what to bring back. Leave out to let the user start it",
        ),
    }),
    execute: ({ name, focus, brief }, { threadId }) =>
      toolResult(async () => {
        const sage = await sageOfTurn(threadId);
        const turn = await bb.sdk.threads.get({ threadId });
        const acolyte = await openAcolyte(sage.id, name, focus, brief ?? null, {
          projectId: turn.projectId,
          environmentId: turn.environmentId ?? null,
        });
        return [
          `Opened the acolyte "${acolyte.name}" (acolyte ${acolyte.id})${brief === undefined ? "" : "; it is working on the brief"}.`,
          "The user reaches it from this chat. Leave its work to it; its summary may come back here if the user closes it.",
        ].join("\n");
      }),
  });
  // A thread is a sage's turn when its metadata names a sage. The metadata
  // is writable by any client; all it unlocks is reading that sage's chat.
  bb.agents.configure((context) => {
    const { sageId } = context.pluginMetadata;
    const sage = sages.find((candidate) => candidate.id === sageId);
    return sage === undefined
      ? envoys.configure(context)
      : {
          tools:
            sage.parentId === null
              ? [ZOOM_TOOL, DATE_TOOL, HANDOFF_TOOL, ACOLYTE_TOOL]
              : [ZOOM_TOOL, DATE_TOOL, HANDOFF_TOOL],
          skills: [],
          instructions: sageInstructions(sage),
        };
  });

  bb.onDispose(() => {
    if (publishTimer !== null) clearTimeout(publishTimer);
    for (const chat of chats.values()) chat.dispose();
  });

  // --- CLI ---

  const usage = [
    "Usage:",
    "  bb sages list [--json]",
    "  bb sages show <sage-id> [--json]",
    "  bb sages create <name> [--topic <text>] [--instructions <text>] [--project <project-id>] [--lead <sage-id>] [--json]",
    "  bb sages lead <sage-id> <lead-sage-id|none> [--json]",
    "  bb sages remove <sage-id> [--json]",
    "  bb sages envoy list|show|create|recover|park|resume|complete|cancel|pr [--json]",
  ].join("\n");
  function formatSage(sage: Sage): string {
    const topic = sage.topic === "" ? "" : `  — ${sage.topic}`;
    return `${sage.id}  ${sage.name}${topic}`;
  }
  bb.cli.register({
    name: "sages",
    summary: "Manage sages: tuned chats bound to a topic or project",
    commands: [
      { name: "envoy", summary: "Create and manage task workspaces (Envoys)", usage: "bb sages envoy list|show|create|recover|park|resume|complete|cancel|pr [--json]" },
      { name: "list", summary: "List sages", usage: "bb sages list [--json]" },
      {
        name: "show",
        summary: "Show one sage, its instructions, and the size of its chat",
        usage: "bb sages show <sage-id> [--json]",
      },
      {
        name: "create",
        summary: "Create a sage",
        usage:
          "bb sages create <name> [--topic <text>] [--instructions <text>] [--project <project-id>] [--lead <sage-id>] [--json]",
      },
      {
        name: "lead",
        summary:
          "Make a sage an acolyte of a lead sage, or with none, its own lead",
        usage: "bb sages lead <sage-id> <lead-sage-id|none> [--json]",
      },
      {
        name: "remove",
        summary: "Delete a sage and its whole chat",
        usage: "bb sages remove <sage-id> [--json]",
      },
    ],
    async run(argv, ctx) {
      if (argv[0] === "envoy") return envoys.runCli(argv.slice(1), ctx);
      const flags: Record<string, string> = {};
      const args: string[] = [];
      let json = false;
      for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]!;
        if (arg === "--json") json = true;
        else if (
          arg === "--topic" ||
          arg === "--instructions" ||
          arg === "--project" ||
          arg === "--lead"
        ) {
          const value = argv[(index += 1)];
          if (value === undefined) return { exitCode: 1, stderr: usage };
          flags[arg.slice(2)] = value;
        } else args.push(arg);
      }
      const [command, ...rest] = args;
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });
      const sageId = rest[0];
      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage };
          case "list": {
            const open = sages.filter((sage) => sage.archivedAt === null);
            return reply(
              open,
              open.length === 0
                ? "No sages."
                : open
                    .filter((sage) => sage.parentId === null)
                    .flatMap((sage) => [
                      formatSage(sage),
                      ...open
                        .filter((acolyte) => acolyte.parentId === sage.id)
                        .map((acolyte) => `  ↳ ${formatSage(acolyte)}`),
                    ])
                    .join("\n"),
            );
          }
          case "show": {
            if (sageId === undefined || rest.length !== 1) break;
            const sage = findSage(sageId);
            const stats = chatOf(sageId).stats();
            return reply(
              { ...sage, stats },
              [
                formatSage(sage),
                sage.projectId === null ? null : `project: ${sage.projectId}`,
                sage.parentId === null
                  ? null
                  : `acolyte of: ${findSage(sage.parentId).name} (${sage.parentId})`,
                `chat: ${stats.messages} messages, view ${stats.viewBytes} bytes, ${stats.pending} to summarize${sage.running ? ", working" : ""}`,
                sage.instructions === "" ? null : `\n${sage.instructions}`,
              ]
                .filter((line) => line !== null)
                .join("\n"),
            );
          }
          case "create": {
            const input = rpcContract.sages_create.input.safeParse({
              name: rest.join(" "),
              topic: flags.topic,
              projectId: flags.project ?? null,
              parentId: flags.lead ?? null,
              instructions: flags.instructions,
            });
            if (!input.success) {
              return {
                exitCode: 1,
                stderr: `${z.prettifyError(input.error)}\n${usage}`,
              };
            }
            const { projectId } = input.data;
            if (projectId !== null) {
              const projects = await bb.sdk.projects.list();
              if (!projects.some((project) => project.id === projectId)) {
                return {
                  exitCode: 1,
                  stderr: `No project with id ${projectId}. Run "bb project list" to see ids.`,
                };
              }
            }
            const sage = await createUnder(input.data);
            return reply(sage, `Created ${formatSage(sage)}`);
          }
          case "lead": {
            const [, lead] = rest;
            if (sageId === undefined || lead === undefined || rest.length !== 2)
              break;
            await moveSage(sageId, lead === "none" ? null : lead);
            const sage = findSage(sageId);
            return reply(
              sage,
              lead === "none"
                ? `${sage.name} is its own lead`
                : `${sage.name} is now an acolyte of ${findSage(lead).name}`,
            );
          }
          case "remove": {
            if (sageId === undefined || rest.length !== 1) break;
            findSage(sageId);
            await removeSage(sageId);
            return reply({ removed: true, id: sageId }, `Removed ${sageId}`);
          }
        }
      } catch (cause) {
        return {
          exitCode: 1,
          stderr: `${errorText(cause)}. Run "bb sages list" to see ids.`,
        };
      }
      return { exitCode: 1, stderr: usage };
    },
  });
}
