// Local history of what a session sent and received (design.md, history): one JSON object a
// line, rotated at 10 MiB, rotated files kept 30 days. It never leaves the machine.

import { frameForAgent, isUlid, sanitizeForDisplay, ulid, ulidTime, type ResultStatus } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ensureDir, listDir, readText, removeFile } from "./fsx.ts";

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
};

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

  async append(entry: HistoryEntry): Promise<void> {
    await ensureDir(dirname(this.path));
    const size = await fs.stat(this.path).then((s) => s.size, () => 0);
    if (size >= this.rotateBytes) await this.rotate();
    await fs.appendFile(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
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
   * to or from `peer`, and only those before `before` (ms).
   */
  async query(opts: { peer?: string; limit?: number; before?: number; max?: number } = {}): Promise<HistoryEntry[]> {
    const limit = Math.min(opts.max ?? HISTORY_MAX, Math.max(1, opts.limit ?? 20));
    const out: HistoryEntry[] = [];
    await this.scan((entry) => {
      if (opts.before !== undefined && !(entry.at < opts.before)) return false;
      if (opts.peer !== undefined && !entry.peer.split(",").includes(opts.peer)) return false;
      out.push(entry);
      return out.length >= limit;
    });
    return out.reverse();
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

  /** Visits entries newest first, damaged lines skipped, until `visit` returns true. */
  private async scan(visit: (entry: HistoryEntry) => boolean): Promise<void> {
    const files = [...(await this.rotated()).map((n) => join(dirname(this.path), n)), this.path];
    for (const file of files.reverse()) {
      const lines = ((await readText(file)) ?? "").split("\n").filter((l) => l !== "").reverse();
      for (const line of lines) {
        const entry = parseEntry(line);
        if (entry !== undefined && visit(entry)) return;
      }
    }
  }
}

/**
 * A received item in the agent frame (SPEC section 6a). `assign` is for a device the person
 * trusts to assign work; anything else, history included, only informs.
 */
export function frameEntry(e: HistoryEntry, trust: "assign" | "inform" = "inform"): string {
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
  return `(history: you sent a ${what} to ${e.peer} at ${new Date(e.at).toISOString()}, id ${e.id})\n${sanitizeForDisplay(e.text)}`;
}

/** One history entry for a person at a terminal. */
export function renderForPerson(e: HistoryEntry): string {
  const arrow = e.dir === "in" ? "<-" : "->";
  const extra = e.file === undefined ? "" : ` [file ${sanitizeForDisplay(e.file.name)} ${e.file.size} bytes]`;
  return `${new Date(e.at).toISOString()} ${arrow} ${sanitizeForDisplay(e.peer)} ${e.kind}${extra}: ${sanitizeForDisplay(e.text)}`;
}
