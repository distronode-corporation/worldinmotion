// Messages held for the person: by inbound policy, or by the loop breaker. Each waits as
// `held/<id>.json` until the person approves or refuses it. A decision made while another
// process runs the session is left as a marker file that the live process applies.

import { isUlid, sanitizeForDisplay, type FileInfo } from "@worldinmotion/protocol";
import { join } from "node:path";
import { listDir, listFiles, readJson, removeFile, tryRemove, writeAtomic, writeJson, type FsEnv } from "./fsx.ts";
import type { HistoryEntry } from "./history.ts";
import type { SpoolKind } from "./spool.ts";

export type HeldItem = {
  id: string;
  from: string;
  device: string;
  kind: Exclude<SpoolKind, "notice">;
  at: number;
  /** A short, sanitized first line for the person. */
  preview: string;
  /** Unused for messages held here: the frame is rendered when the item is released. */
  rendered: string;
  reason: "policy" | "breaker";
  /** A held file's details; it is fetched only once the person approves (revision 4, M6). */
  fileInfo?: FileInfo;
  /** The message's own fields, for history (and in-process listeners) once it is delivered. */
  entry: HistoryEntry;
};

export type Verdict = "approve" | "refuse";

/** A one-line preview a person can read safely: controls and invisible characters made visible. */
export function preview(text: string, max = 120): string {
  const line = sanitizeForDisplay(text).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export class HeldBox {
  readonly dir: string;
  private readonly env: FsEnv;
  constructor(dir: string, env: FsEnv) {
    this.dir = dir;
    this.env = env;
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async add(item: HeldItem): Promise<void> {
    await writeJson(this.path(item.id), item, this.env);
  }

  async get(id: string): Promise<HeldItem | undefined> {
    if (!isUlid(id)) return undefined;
    const raw = (await readJson(this.path(id)).catch(() => undefined)) as HeldItem | undefined;
    return raw?.id === id ? raw : undefined;
  }

  /** Held items, oldest first. */
  async list(): Promise<HeldItem[]> {
    const out: HeldItem[] = [];
    for (const name of (await listDir(this.dir)).sort()) {
      const id = name.endsWith(".json") ? name.slice(0, -5) : "";
      const item = await this.get(id);
      if (item !== undefined) out.push(item);
    }
    return out.sort((a, b) => a.at - b.at);
  }

  async remove(id: string): Promise<void> {
    await removeFile(this.path(id));
  }

  /** Leaves a decision for the process that runs this session. */
  async mark(id: string, verdict: Verdict): Promise<void> {
    await writeAtomic(join(this.dir, `${id}.${verdict}`), "", this.env);
  }

  /** Decisions left by other processes (`wim held`, the plugin's pane), consumed as they are read. */
  async takeMarks(): Promise<Array<{ id: string; verdict: Verdict }>> {
    return (await takeMarks(this.dir, ["approve", "refuse"], this.env)).map(({ id, mark }) => ({ id, verdict: mark as Verdict }));
  }
}

/**
 * Mark files in `dir`: empty files named exactly `<ULID>.<mark>`, removed as they are read. A
 * mark carries no content, so nothing is read from it, and anything but a regular file (a link,
 * a directory) is not a mark. Taking one is removing it: a mark that cannot be removed yet is
 * left for the next pass, so it is acted on once.
 */
export async function takeMarks(dir: string, marks: readonly string[], env: FsEnv): Promise<Array<{ id: string; mark: string }>> {
  const out: Array<{ id: string; mark: string }> = [];
  for (const name of (await listFiles(dir)).sort()) {
    const m = /^([0-9A-Z]{26})\.([a-z]+)$/.exec(name);
    if (m === null || !marks.includes(m[2]!)) continue;
    if (!(await tryRemove(join(dir, name), env))) continue;
    out.push({ id: m[1]!, mark: m[2]! });
  }
  return out;
}
