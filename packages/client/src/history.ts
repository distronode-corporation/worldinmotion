// Local history of what a session sent and received (design.md, history): one JSON object a
// line, rotated at 10 MiB, rotated files kept 30 days. It never leaves the machine. Receipts for
// what the session sent are lines of their own (`t: "receipt"`), which readers that predate them
// skip as damaged.

import { frameForAgent, isUlid, sanitizeForDisplay, ulid, ulidTime, type ResultStatus } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ensureDir, listDir, readText, removeFile } from "./fsx.ts";
import type { MeshConfig } from "./mesh.ts";
import { policyLevel } from "./render.ts";
import type { SpoolItem } from "./spool.ts";

export type HistoryEntry = {
  dir: "in" | "out";
  /** The sender's address for `in`; the recipients for `out`. */
  peer: string;
  /** The sender's device id, for `in`. */
  device?: string;
  id: string;
  kind: "msg" | "task" | "result" | "file";
  at: number;
  text: string;
  reply_to?: string;
  status?: ResultStatus;
  deadline?: number;
  file?: { name: string; size: number; mime: string };
  savedTo?: string;
  /** The sender did not write the text itself (revision 4, H1). */
  relayed?: true;
  /** A result whose sender was not asked the task it names (revision 4, M3). */
  unsolicited?: true;
  /** Written while its sender handled another agent's message (revision 8): information only. */
  derived?: true;
  /** For `out`, the receipts recorded for it, oldest first, when a query asks for them. Never stored in the entry's own line. */
  receipts?: Receipt[];
};

/** A recipient's receipt for a message a session sent (SPEC section 7): what its client did with it, never whether anyone read it. */
export type Receipt = { to: string; status: string; at: number };

/** A receipt line in a history file. */
type ReceiptLine = Receipt & { t: "receipt"; id: string };

/** A history line as a receipt, or undefined when it is not one. */
export function parseReceipt(line: string): ReceiptLine | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const r = value as Partial<ReceiptLine> | null;
  if (typeof r !== "object" || r === null || r.t !== "receipt") return undefined;
  return typeof r.id === "string" && typeof r.to === "string" && typeof r.status === "string" && typeof r.at === "number" ? (r as ReceiptLine) : undefined;
}

/** A history line as an entry, or undefined when it is damaged or not an entry. */
export function parseEntry(line: string): HistoryEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const e = value as Partial<HistoryEntry> | null;
  if (typeof e !== "object" || e === null || (e.dir !== "in" && e.dir !== "out")) return undefined;
  if (typeof e.peer !== "string" || typeof e.id !== "string") return undefined;
  return typeof e.at === "number" && typeof e.text === "string" ? (e as HistoryEntry) : undefined;
}

export const ROTATE_BYTES = 10 * 1024 * 1024;
/** The most entries one history query returns, unless the caller raises it. */
export const HISTORY_MAX = 200;
export const KEEP_MS = 30 * 24 * 3600 * 1000;

export class History {
  readonly path: string;
  private readonly now: () => number;
  private readonly rotateBytes: number;
  constructor(path: string, now: () => number, rotateBytes = ROTATE_BYTES) {
    this.path = path;
    this.now = now;
    this.rotateBytes = rotateBytes;
  }

  append(entry: HistoryEntry): Promise<void> {
    return this.appendLine(entry);
  }

  /** Records a receipt for message `id`, which this session sent. */
  appendReceipt(id: string, r: Receipt): Promise<void> {
    return this.appendLine({ t: "receipt", id, to: r.to, status: r.status, at: r.at } satisfies ReceiptLine);
  }

  private async appendLine(value: object): Promise<void> {
    await ensureDir(dirname(this.path));
    const size = await fs.stat(this.path).then((s) => s.size, () => 0);
    if (size >= this.rotateBytes) await this.rotate();
    await fs.appendFile(this.path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }

  private rotated(): Promise<string[]> {
    const stem = basename(this.path, ".jsonl");
    return listDir(dirname(this.path)).then((names) =>
      names.filter((n) => n.startsWith(`${stem}-`) && n.endsWith(".jsonl")).sort(),
    );
  }

  private async rotate(): Promise<void> {
    const now = this.now();
    const stem = basename(this.path, ".jsonl");
    // A ULID sorts by time and never repeats, so rotated names stay in order.
    await fs.rename(this.path, join(dirname(this.path), `${stem}-${ulid(now)}.jsonl`));
    for (const name of await this.rotated()) {
      const id = name.slice(stem.length + 1, -6);
      if (!isUlid(id) || ulidTime(id) < now - KEEP_MS) await removeFile(join(dirname(this.path), name));
    }
  }

  /**
   * Past items, newest last: at most `limit` (default 20, at most 200), optionally only those
   * to or from `peer`, and only those before `before` (ms). With `receipts`, each sent item
   * carries the receipts recorded for it.
   */
  async query(opts: { peer?: string; limit?: number; before?: number; max?: number; receipts?: boolean } = {}): Promise<HistoryEntry[]> {
    const limit = Math.min(opts.max ?? HISTORY_MAX, Math.max(1, opts.limit ?? 20));
    const out: HistoryEntry[] = [];
    const receipts = new Receipts();
    await this.scan(
      (entry) => {
        if (opts.before !== undefined && !(entry.at < opts.before)) return false;
        if (opts.peer !== undefined && !entry.peer.split(",").includes(opts.peer)) return false;
        out.push(opts.receipts === true && entry.dir === "out" ? receipts.attach(entry) : entry);
        return out.length >= limit;
      },
      (r) => receipts.add(r),
    );
    return out.reverse();
  }

  /** The current file's size: where a reader that wants only what is written later starts (receiptsFrom). */
  size(): Promise<number> {
    return fs.stat(this.path).then((s) => s.size, () => 0);
  }

  /**
   * The receipts for message `id` written to the current file from byte `from` on, oldest first.
   * Only those bytes are read, so a caller polling for a receipt (`wim send --wait`) costs little
   * however long the history is. A file now shorter than `from` was rotated meanwhile: it is read
   * from its start, and receipts written to the rotated file in between are not seen. A line still
   * being written does not parse yet, and is read whole by the next call from the same `from`.
   */
  async receiptsFrom(id: string, from: number): Promise<Receipt[]> {
    const handle = await fs.open(this.path, "r").catch(() => undefined);
    if (handle === undefined) return [];
    try {
      const { size } = await handle.stat();
      const start = readStart(size, from);
      const buf = Buffer.alloc(size - start);
      await handle.read(buf, 0, buf.length, start);
      return receiptsIn(buf.toString("utf8"), id);
    } finally {
      await handle.close();
    }
  }

  /** The entry with message id `id`, searching from the newest; undefined when there is none. */
  async find(id: string): Promise<HistoryEntry | undefined> {
    let found: HistoryEntry | undefined;
    await this.scan((entry) => {
      if (entry.id === id) found = entry;
      return found !== undefined;
    });
    return found;
  }

  /** Visits entries (and receipts, to `receipt`) newest first, damaged lines skipped, until `visit` returns true. */
  private async scan(visit: (entry: HistoryEntry) => boolean, receipt: (r: ReceiptLine) => void = () => undefined): Promise<void> {
    const files = [...(await this.rotated()).map((n) => join(dirname(this.path), n)), this.path];
    for (const file of files.reverse()) {
      const lines = ((await readText(file)) ?? "").split("\n").filter((l) => l !== "").reverse();
      if (visitLines(lines, visit, receipt)) return;
    }
  }
}

function readStart(size: number, from: number): number {
  return size < from ? 0 : from;
}

function receiptsIn(text: string, id: string): Receipt[] {
  return text
    .split("\n")
    .map(parseReceipt)
    .filter((r) => r?.id === id)
    .map((r) => ({ to: r!.to, status: r!.status, at: r!.at }));
}

/** Visits one file's lines, newest first; true once `visit` says to stop. */
function visitLines(lines: string[], visit: (entry: HistoryEntry) => boolean, receipt: (r: ReceiptLine) => void): boolean {
  for (const line of lines) {
    const entry = parseEntry(line);
    if (entry !== undefined && visit(entry)) return true;
    const r = entry === undefined ? parseReceipt(line) : undefined;
    if (r !== undefined) receipt(r);
  }
  return false;
}

/**
 * Receipts met while scanning newest first, matched to the sent entries they name. A receipt is
 * normally written after its entry, so it is met first; one written before it (it came while the
 * send was still being recorded) is added to the entry already returned.
 */
class Receipts {
  private readonly waiting = new Map<string, Receipt[]>();
  private readonly entries = new Map<string, HistoryEntry>();

  add(r: ReceiptLine): void {
    const one = { to: r.to, status: r.status, at: r.at };
    const entry = this.entries.get(r.id);
    if (entry !== undefined) entry.receipts!.unshift(one);
    else this.waiting.set(r.id, [one, ...(this.waiting.get(r.id) ?? [])]);
  }

  attach(entry: HistoryEntry): HistoryEntry {
    const withReceipts = { ...entry, receipts: this.waiting.get(entry.id) ?? [] };
    this.entries.set(entry.id, withReceipts);
    return withReceipts;
  }
}

/**
 * A received item in the agent frame (SPEC section 6a). `self` (another session on this device)
 * and `assign` (a device the person trusts) may assign work; anything else, history included,
 * only informs.
 */
export function frameEntry(e: HistoryEntry, trust: "self" | "assign" | "inform" = "inform"): string {
  return frameForAgent({
    from: e.peer,
    deviceId: e.device ?? "",
    at: e.at,
    id: e.id,
    kind: e.kind,
    text: e.text,
    ...(e.reply_to === undefined ? {} : { reply_to: e.reply_to }),
    ...(e.status === undefined ? {} : { status: e.status }),
    ...(e.deadline === undefined ? {} : { deadline: e.deadline }),
    ...(e.file === undefined ? {} : { file: e.file, savedTo: e.savedTo ?? "(not saved)" }),
    ...(e.relayed === true ? { relayed: true } : {}),
    ...(e.unsolicited === true ? { unsolicited: true } : {}),
    ...(e.derived === true ? { derived: true } : {}),
    trust,
  });
}

/**
 * How a received item is handed to the agent once it is released, by the live session or by a
 * decision applied on disk to a session nobody runs (offline.ts): one rule for both. This device,
 * or a device the person delivers from, may assign work; relayed text, derived text and held
 * senders only inform. The frame says which, never that a trusted device is the person's own, and
 * an item that only informs carries `informs`, so reading it starts the `derived` window.
 */
export function releasedFrame(config: MeshConfig, device: string, entry: HistoryEntry): Pick<SpoolItem, "rendered" | "relayed" | "informs"> {
  const level = policyLevel(config, device);
  const works = (level === "deliver" || level === "deliver-relayed") && entry.relayed !== true && entry.derived !== true;
  const trust = !works ? "inform" : device === config.device ? "self" : "assign";
  return { rendered: frameEntry(entry, trust), ...(entry.relayed === true ? { relayed: true as const } : {}), ...(trust === "inform" ? { informs: true as const } : {}) };
}

/** One history entry for the agent: received items in the agent frame, sent ones as a plain line. */
export function renderForAgent(e: HistoryEntry): string {
  if (e.dir === "in") {
    try {
      return `(history: received earlier, not a new message)\n${frameEntry(e)}`;
    } catch {
      return `(history: an unreadable entry ${sanitizeForDisplay(String(e.id))})`;
    }
  }
  const what = e.kind === "result" ? `result (${e.status ?? "done"}) for ${e.reply_to ?? "?"}` : e.kind;
  const receipts = e.receipts === undefined ? "" : `; ${receiptNote(e.receipts)}`;
  return `(history: you sent a ${what} to ${e.peer} at ${new Date(e.at).toISOString()}, id ${e.id}${receipts})\n${sanitizeForDisplay(e.text)}`;
}

/**
 * The receipts of a sent item in plain words. None recorded means only that no receipt came while
 * the sending session was connected: the relay drops a receipt for a session that is offline.
 */
export function receiptNote(receipts: readonly Receipt[]): string {
  if (receipts.length === 0) return "no receipt recorded";
  return `receipts: ${receipts.map((r) => `${sanitizeForDisplay(r.to)} ${sanitizeForDisplay(r.status)}`).join(", ")}`;
}

/** One history entry for a person at a terminal. */
export function renderForPerson(e: HistoryEntry): string {
  const arrow = e.dir === "in" ? "<-" : "->";
  const extra = e.file === undefined ? "" : ` [file ${sanitizeForDisplay(e.file.name)} ${e.file.size} bytes]`;
  const receipts = e.receipts === undefined ? "" : ` [${receiptNote(e.receipts)}]`;
  return `${new Date(e.at).toISOString()} ${arrow} ${sanitizeForDisplay(e.peer)} ${e.kind}${extra}${receipts}: ${sanitizeForDisplay(e.text)}`;
}
