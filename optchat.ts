// The memory engine behind a sage's chat: one chat that never ends.
//
// Every message is logged word for word. In the background a cheap model
// compresses the log into a binary tree of lines of at most 512 bytes, and
// each turn sees the "view": lines covering the whole chat, fine for recent
// messages and coarse for old ones, 64-128 KB in all. The design is
// UniiChat's (see README.md); sizes are UTF-8 bytes, never tokens.
//
// This file knows nothing about bb. It needs a SQLite handle and a function
// that calls a model.
import type Database from "better-sqlite3";

export const LINE_BYTES = 512;
const VIEW_MAX = 128_000;
const VIEW_MIN = 64_000;
const COMPACTION_VIEW_MAX = 32_000;
const COMPACTION_VIEW_MIN = 16_000;
/** A message never holds more characters than this; longer text is split. */
const MESSAGE_CHARS = 30_000;
const PARALLEL = 8;
/** A message's node waits until fewer than this many before it are unbuilt. */
const WINDOW = 8;
const TRIES = 5;
/** How long a failed call waits before it is tried again. */
const RETRY_MS = 60_000;
const UNBUILT = "(not summarized yet: zoom it)";

export type Kind = "user" | "sage" | "tool" | "echo" | "work" | "acolyte";
/** Tree node (l, i): the 2^l messages from i·2^l on. */
export type Ref = [l: number, i: number];
export interface Message {
  i: number;
  kind: Kind;
  text: string;
  date: string;
}
/**
 * Calls the compaction model with one conversation: user and assistant
 * messages alternating, starting and ending with the user.
 */
export type Summarize = (
  conversation: string[],
  signal: AbortSignal,
) => Promise<string>;

/** Statements for bb.storage.migrate: append-only, never edit one. */
export const MIGRATIONS = [
  `CREATE TABLE messages (
     sage TEXT NOT NULL, i INTEGER NOT NULL, kind TEXT NOT NULL,
     text TEXT NOT NULL, date TEXT NOT NULL, PRIMARY KEY (sage, i)
   ) WITHOUT ROWID`,
  `CREATE TABLE nodes (
     sage TEXT NOT NULL, l INTEGER NOT NULL, i INTEGER NOT NULL,
     text TEXT NOT NULL, PRIMARY KEY (sage, l, i)
   ) WITHOUT ROWID`,
  `CREATE TABLE views (sage TEXT PRIMARY KEY, state TEXT NOT NULL) WITHOUT ROWID`,
];

const bytes = (text: string) => Buffer.byteLength(text);

/**
 * Shrinks a view by merging its most due sibling pairs, each into its built
 * parent, until it fits `target` or nothing more can merge. A pair's due is
 * how long ago it ended, measured in its own line size; equal pairs merge
 * oldest first. This is the order of Taelin's rollback push at any budget.
 * Returns whether anything merged.
 */
export function shrink(
  view: Ref[],
  total: number,
  target: number,
  size: (ref: Ref) => number,
  built: (ref: Ref) => boolean,
): boolean {
  let current = view.reduce((sum, ref) => sum + size(ref), 0);
  let merged = false;
  while (current > target) {
    let best = -1;
    let bestDue = -Infinity;
    for (let k = 0; k + 1 < view.length; k += 1) {
      const [l, i] = view[k]!;
      const [nextL, nextI] = view[k + 1]!;
      if (l !== nextL || i % 2 !== 0 || nextI !== i + 1) continue;
      const due = (total + 1) / 2 ** l - i;
      if (due > bestDue && built([l + 1, i / 2])) {
        best = k;
        bestDue = due;
      }
    }
    if (best < 0) break;
    const [l, i] = view[best]!;
    const parent: Ref = [l + 1, i / 2];
    current += size(parent) - size(view[best]!) - size(view[best + 1]!);
    view.splice(best, 2, parent);
    merged = true;
  }
  return merged;
}

function split(kind: Kind, text: string): string[] {
  if (text.length <= MESSAGE_CHARS) return text === "" ? [] : [text];
  if (kind === "echo") {
    // Tool output is clipped to its head and tail.
    const half = MESSAGE_CHARS / 2;
    const cut = text.length - MESSAGE_CHARS;
    return [
      `${text.slice(0, half)}\n[... ${cut} characters clipped ...]\n${text.slice(-half)}`,
    ];
  }
  // Any other long text is never cut: it becomes several messages in a row.
  const parts: string[] = [];
  for (let at = 0; at < text.length; at += MESSAGE_CHARS) {
    parts.push(text.slice(at, at + MESSAGE_CHARS));
  }
  return parts;
}

const RULER = "-".repeat(LINE_BYTES);

function tooLong(line: string): string {
  const head = Buffer.from(line).subarray(0, LINE_BYTES).toString();
  return [
    `Too long: your line is ${bytes(line)} bytes, over the ${LINE_BYTES}-byte limit. Write`,
    "the whole line again for the same <input>, cutting just enough of the",
    "least valuable items to fit before this cut:",
    `${head}| ← LIMIT`,
  ].join("\n");
}

interface ViewState {
  view: Ref[];
  /** A batch that could not reach VIEW_MIN yet and continues at each message. */
  shrinking: boolean;
  compactionView: Ref[];
  compactionShrinking: boolean;
}

export interface ChatStats {
  messages: number;
  viewBytes: number;
  /** Nodes whose inputs exist but which are not built yet. */
  pending: number;
}

export class Chat {
  private count: number;
  private state: ViewState;
  /** Messages without a node yet, ascending. */
  private unbuilt: number[];
  /** Merges whose two halves are built, waiting for a call. */
  private merges: Ref[];
  private failedMessages = new Set<number>();
  private failedMerges: Ref[] = [];
  /** Tries failed calls again after a pause, so a quiet chat still heals. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight = new Set<number>();
  private running = 0;
  private sizes = new Map<number, number>();
  private waiters: (() => void)[] = [];
  private abort = new AbortController();
  private sql: Record<
    "message" | "addMessage" | "node" | "addNode" | "saveView" | "history",
    Database.Statement
  >;

  private db: Database.Database;
  private sage: string;
  private summarize: Summarize;
  private onChange: (error?: unknown) => void;

  constructor(
    db: Database.Database,
    sage: string,
    summarize: Summarize,
    /** Called after the tree changes, and with the error of a failed call. */
    onChange: (error?: unknown) => void = () => {},
  ) {
    this.db = db;
    this.sage = sage;
    this.summarize = summarize;
    this.onChange = onChange;
    this.sql = {
      message: db.prepare(
        "SELECT i, kind, text, date FROM messages WHERE sage = ? AND i = ?",
      ),
      addMessage: db.prepare(
        "INSERT INTO messages (sage, i, kind, text, date) VALUES (?, ?, ?, ?, ?)",
      ),
      node: db.prepare(
        "SELECT text FROM nodes WHERE sage = ? AND l = ? AND i = ?",
      ),
      addNode: db.prepare(
        "INSERT INTO nodes (sage, l, i, text) VALUES (?, ?, ?, ?)",
      ),
      saveView: db.prepare(
        "INSERT INTO views (sage, state) VALUES (?, ?) ON CONFLICT (sage) DO UPDATE SET state = excluded.state",
      ),
      history: db.prepare(
        "SELECT i, kind, text, date FROM messages WHERE sage = ? AND kind IN ('user', 'sage', 'work', 'acolyte') AND i < ? ORDER BY i DESC LIMIT ?",
      ),
    };
    const { count } = db
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE sage = ?")
      .get(sage) as { count: number };
    this.count = count;
    // The view is loaded, never rebuilt from the log: a rebuilt view differs
    // from the live one and every cached prefix of it dies.
    const saved = db
      .prepare("SELECT state FROM views WHERE sage = ?")
      .get(sage) as { state: string } | undefined;
    this.state =
      saved === undefined
        ? {
            view: [],
            shrinking: false,
            compactionView: [],
            compactionShrinking: false,
          }
        : (JSON.parse(saved.state) as ViewState);
    // The one scan for work, at load. After it, ready nodes are queued as
    // their inputs get built.
    this.unbuilt = (
      db
        .prepare(
          "SELECT i FROM messages m WHERE sage = ? AND NOT EXISTS (SELECT 1 FROM nodes WHERE sage = m.sage AND l = 0 AND i = m.i) ORDER BY i",
        )
        .all(sage) as { i: number }[]
    ).map((row) => row.i);
    this.merges = (
      db
        .prepare(
          `SELECT a.l + 1 AS l, a.i / 2 AS i FROM nodes a
           JOIN nodes b ON b.sage = a.sage AND b.l = a.l AND b.i = a.i + 1
           WHERE a.sage = ? AND a.i % 2 = 0 AND NOT EXISTS
             (SELECT 1 FROM nodes WHERE sage = a.sage AND l = a.l + 1 AND i = a.i / 2)
           ORDER BY a.l, a.i`,
        )
        .all(sage) as { l: number; i: number }[]
    ).map((row): Ref => [row.l, row.i]);
    this.pump();
  }

  /** Logs one message, split in several when long. Returns their ids. */
  append(kind: Kind, text: string, date = new Date().toISOString()): number[] {
    const ids: number[] = [];
    this.db.transaction(() => {
      for (const part of split(kind, text)) {
        const i = this.count;
        this.sql.addMessage.run(this.sage, i, kind, part, date);
        this.count += 1;
        ids.push(i);
        this.unbuilt.push(i);
        this.state.view.push([0, i]);
        this.state.compactionView.push([0, i]);
        // A message that fits is its own node, word for word, with no call.
        const line = `${kind}: ${part}`;
        if (bytes(line) <= LINE_BYTES) this.built([0, i], line);
        this.fit();
      }
      this.sql.saveView.run(this.sage, JSON.stringify(this.state));
    })();
    if (ids.length > 0) {
      // A failed call is tried again at the next message.
      this.retryFailed();
      this.onChange();
    }
    return ids;
  }

  /** Queues the failed calls again. */
  private retryFailed(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.failedMessages.clear();
    this.merges.push(...this.failedMerges.splice(0));
    this.pump();
  }

  /** The view every turn starts from. Render it before logging the turn's message. */
  render(): string {
    return this.renderLines(this.state.view);
  }

  /** Resolves once every logged message is summarized or its call failed. */
  settled(): Promise<void> {
    if (this.isSettled()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Opens line id+n into the two lines under it; n = 1 gives the message whole. */
  zoom(id: number, n: number): string {
    const l = Math.log2(n);
    if (!Number.isInteger(l) || l < 0 || !Number.isInteger(id) || id < 0) {
      throw new Error("n must be a power of 2 and id a message id");
    }
    if (id % n !== 0) throw new Error(`id must be a multiple of n (${n})`);
    if (id >= this.count) {
      throw new Error(`No message ${id}: the chat has ${this.count} messages`);
    }
    if (n === 1) {
      const message = this.message(id);
      return `${message.kind}: ${message.text}`;
    }
    const i = id / n;
    return [2 * i, 2 * i + 1]
      .filter((child) => child * (n / 2) < this.count)
      .map((child) => this.line([l - 1, child]))
      .join("\n");
  }

  date(id: number): string {
    return this.message(id).date;
  }

  /** The user's, the sage's and the specialists' messages before `before`, oldest first. */
  history(before: number | null, limit: number): Message[] {
    const rows = this.sql.history.all(
      this.sage,
      before ?? this.count,
      limit,
    ) as Message[];
    return rows.reverse();
  }

  stats(): ChatStats {
    return {
      messages: this.count,
      viewBytes: this.size(this.state.view),
      pending:
        this.unbuilt.length + this.merges.length + this.failedMerges.length,
    };
  }

  /** Stops background calls. The chat must not be used afterwards. */
  dispose(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.abort.abort();
    this.waiters.splice(0).forEach((resolve) => resolve());
  }

  /** Deletes the chat for good. */
  destroy(): void {
    this.dispose();
    this.db.transaction(() => {
      for (const table of ["messages", "nodes", "views"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE sage = ?`).run(this.sage);
      }
    })();
  }

  private message(i: number): Message {
    const message = this.sql.message.get(this.sage, i) as Message | undefined;
    if (message === undefined) throw new Error(`No message ${i}`);
    return message;
  }

  private node([l, i]: Ref): string | null {
    const row = this.sql.node.get(this.sage, l, i) as
      { text: string } | undefined;
    return row?.text ?? null;
  }

  private line(ref: Ref): string {
    const [l, i] = ref;
    const text = this.node(ref) ?? UNBUILT;
    return `${i * 2 ** l}+${2 ** l}|${text.replace(/\s*\n\s*/g, " ")}`;
  }

  private renderLines(view: Ref[]): string {
    return ["<chat>", ...view.map((ref) => this.line(ref)), "</chat>"].join(
      "\n",
    );
  }

  /** A line's bytes in a view. A built line never changes, so its size is kept. */
  private lineSize(ref: Ref): number {
    const key = ref[0] * 2 ** 40 + ref[1];
    let size = this.sizes.get(key);
    if (size === undefined) {
      size = bytes(this.line(ref)) + 1;
      if (this.node(ref) !== null) this.sizes.set(key, size);
    }
    return size;
  }

  private size(view: Ref[]): number {
    return view.reduce((sum, ref) => sum + this.lineSize(ref), 0);
  }

  /** The sawtooth: each view grows a line per message, then merges in one batch. */
  private fit(): void {
    const { state } = this;
    const lineSize = (ref: Ref) => this.lineSize(ref);
    const isBuilt = (ref: Ref) => this.node(ref) !== null;
    let merged = false;
    if (state.shrinking || this.size(state.view) > VIEW_MAX) {
      merged = shrink(state.view, this.count, VIEW_MIN, lineSize, isBuilt);
      state.shrinking = this.size(state.view) > VIEW_MIN;
    }
    if (
      merged ||
      state.compactionShrinking ||
      this.size(state.compactionView) > COMPACTION_VIEW_MAX
    ) {
      shrink(
        state.compactionView,
        this.count,
        COMPACTION_VIEW_MIN,
        lineSize,
        isBuilt,
      );
      state.compactionShrinking =
        this.size(state.compactionView) > COMPACTION_VIEW_MIN;
    }
  }

  /** Records a built node and queues the merge it completes, if any. */
  private built(ref: Ref, text: string): void {
    const [l, i] = ref;
    this.sql.addNode.run(this.sage, l, i, text);
    if (l === 0) this.unbuilt.splice(this.unbuilt.indexOf(i), 1);
    const sibling = this.node([l, i ^ 1]);
    if (sibling === null) return;
    const parent: Ref = [l + 1, Math.floor(i / 2)];
    // Two short lines are joined by a newline, with no call.
    const joined = i % 2 === 0 ? `${text}\n${sibling}` : `${sibling}\n${text}`;
    if (bytes(joined) <= LINE_BYTES) this.built(parent, joined);
    else this.merges.push(parent);
  }

  private isSettled(): boolean {
    return (
      this.abort.signal.aborted ||
      this.unbuilt.every((i) => this.failedMessages.has(i))
    );
  }

  private pump(): void {
    while (this.running < PARALLEL && !this.abort.signal.aborted) {
      const message = this.unbuilt
        .slice(0, WINDOW)
        .find((i) => !this.inflight.has(i) && !this.failedMessages.has(i));
      const ref: Ref | undefined =
        message === undefined ? this.merges.shift() : [0, message];
      if (ref === undefined) break;
      this.running += 1;
      if (ref[0] === 0) this.inflight.add(ref[1]);
      this.compact(ref)
        .then(
          (text) => {
            if (this.abort.signal.aborted) return;
            this.inflight.delete(ref[1]);
            this.db.transaction(() => this.built(ref, text))();
            this.onChange();
          },
          (error: unknown) => {
            if (this.abort.signal.aborted) return;
            if (ref[0] === 0) {
              this.inflight.delete(ref[1]);
              this.failedMessages.add(ref[1]);
            } else this.failedMerges.push(ref);
            this.retryTimer ??= setTimeout(() => {
              this.retryTimer = null;
              this.retryFailed();
            }, RETRY_MS);
            this.onChange(error);
          },
        )
        .finally(() => {
          this.running -= 1;
          this.pump();
          if (this.isSettled()) {
            this.waiters.splice(0).forEach((resolve) => resolve());
          }
        });
    }
  }

  /** One compaction: builds a node's line with the model. */
  private async compact(ref: Ref): Promise<string> {
    const [l, i] = ref;
    const first = i * 2 ** l;
    const end = first + 2 ** l;
    // The view ends at the node and stops at the first unbuilt line, so no
    // call ever sees a placeholder or half a message.
    const context: Ref[] = [];
    for (const line of this.state.compactionView) {
      const lineEnd = (line[1] + 1) * 2 ** line[0];
      if (lineEnd > (l === 0 ? first : end) || this.node(line) === null) break;
      context.push(line);
    }
    let task: string;
    if (l === 0) {
      const message = this.message(i);
      task = [
        `Compaction: compress message ${i} into one line of at most ${LINE_BYTES} bytes`,
        "(about 70 words), the length of this ruler:",
        RULER,
        "<input>",
        `${message.kind}: ${message.text}`,
        "</input>",
      ].join("\n");
    } else {
      const a: Ref = [l - 1, 2 * i];
      const b: Ref = [l - 1, 2 * i + 1];
      const name = (half: Ref) => this.line(half).split("|", 1)[0];
      task = [
        `Compaction: merge lines ${name(a)} and ${name(b)}, adjacent, into one line of at most`,
        `${LINE_BYTES} bytes (about 70 words), the length of this ruler:`,
        RULER,
        `<chat> may hold their messages, ${first} to ${end - 1}, in more detail: take details`,
        "of them from there too.",
        "<input>",
        this.line(a),
        this.line(b),
        "</input>",
      ].join("\n");
    }
    // Models can't count bytes: the ruler shows the length, and a line that
    // is too long is sent back with the cut marked.
    const conversation = [`${this.renderLines(context)}\n${task}`];
    let best: string | null = null;
    for (let attempt = 0; attempt < TRIES; attempt += 1) {
      const reply = await this.summarize(conversation, this.abort.signal);
      const line = reply.trim().replace(/\s*\n\s*/g, " ");
      if (line === "") throw new Error("The compaction model returned nothing");
      if (best === null || bytes(line) < bytes(best)) best = line;
      if (bytes(line) <= LINE_BYTES) break;
      conversation.push(line, tooLong(line));
    }
    // A few bytes over is fine: the view measures real sizes.
    return best!;
  }
}
