// Messages held for the person: by inbound policy, or by the loop breaker. Each waits as
// `held/<id>.json` until the person approves or refuses it. A decision made while another
// process runs the session is left as a marker file that the live process applies.

import { isUlid, sanitizeForDisplay, type FileInfo } from "@worldinmotion/protocol";
import { join } from "node:path";
import { listDir, listFiles, readJson, readText, removeFile, tryRemove, writeAtomic, writeJson, type FsEnv } from "./fsx.ts";
import type { Pause } from "./breaker.ts";
import type { Decision } from "./decisions.ts";
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
  /** For a breaker hold: the pause it was held under (the rule, its numbers, when it ends). */
  pause?: Pick<Pause, "rule" | "count" | "limit" | "minutes" | "at" | "until" | "auto">;
  /** A held file's details; it is fetched only once the person approves (revision 4, M6). */
  fileInfo?: FileInfo;
  /** The message's own fields, for history (and in-process listeners) once it is delivered. */
  entry: HistoryEntry;
  /**
   * A CI notice (SPEC section 18): framed when it arrived (`rendered`), never receipted. `pins`:
   * its rule had no ids yet, and approving it at the person's terminal pins these.
   */
  ci?: { rule: string; pins?: Record<string, string> };
};

export type Verdict = "approve" | "refuse";

/** A decision the pane leaves as a mark: a verdict, or `resume` (approve, and resume the item's device). */
export type Mark = Verdict | "resume";

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

  /**
   * Records that `id` is in the spool now, before its held entry goes. A process that stops between
   * the two leaves this mark, and the next takes the entry out instead of delivering it again
   * (`settle`); one that stops before the mark leaves the item in the spool, which the next reads.
   */
  async markDelivered(id: string): Promise<void> {
    await writeAtomic(join(this.dir, `${id}.delivered`), "", this.env);
  }

  /** Whether `id` was written to the spool already (markDelivered). */
  async wasDelivered(id: string): Promise<boolean> {
    return (await readText(join(this.dir, `${id}.delivered`))) !== undefined;
  }

  /** Takes a delivered item out of held/: its entry first, then its mark. */
  async settle(id: string): Promise<void> {
    await this.remove(id);
    await removeFile(join(this.dir, `${id}.delivered`));
  }

  /** The ids with a delivered mark, entry or not. */
  async deliveredMarks(): Promise<string[]> {
    return (await listFiles(this.dir)).flatMap((name) => {
      const m = /^([0-9A-Z]{26})\.delivered$/.exec(name);
      return m === null ? [] : [m[1]!];
    });
  }

  /** Leaves a decision for the process that runs this session. */
  async mark(id: string, verdict: Mark): Promise<void> {
    await writeAtomic(join(this.dir, `${id}.${verdict}`), "", this.env);
  }

  /** Leaves a signed decision for the process that runs this session (a device whose keys are in the signer). */
  async leaveDecision(d: Decision): Promise<void> {
    await writeJson(join(this.dir, `${d.n}.decision`), d, this.env);
  }

  /**
   * Signed decisions left by other processes, consumed as they are read: what each file holds,
   * unchecked (the session checks the signature). One that cannot be removed yet waits for the next pass.
   */
  async takeDecisions(): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const name of (await listFiles(this.dir)).sort()) {
      if (!/^[0-9A-Z]{26}\.decision$/.test(name)) continue;
      const path = join(this.dir, name);
      const raw = await readJson(path).catch(() => undefined);
      if (await tryRemove(path, this.env)) out.push(raw);
    }
    return out;
  }

  /**
   * Records that the signed decision `n` was acted on here, until `until` (when it is too old to
   * be taken anyway); false when it was already. A copy of a decision file written again (a
   * replay) then does nothing, a resume included. Entries past their time are dropped.
   */
  async useDecision(n: string, until: number, now: number): Promise<boolean> {
    // Not a `.json` name: the plugin counts those as held items.
    const path = join(this.dir, "decisions.used");
    const raw = (await readJson(path).catch(() => undefined)) as Record<string, unknown> | undefined;
    const kept = Object.fromEntries(Object.entries(raw ?? {}).filter(([, t]) => typeof t === "number" && t > now));
    if (kept[n] !== undefined) return false;
    await writeJson(path, { ...kept, [n]: until }, this.env);
    return true;
  }

  /** Decisions left by other processes (`wim held`, the plugin's pane), consumed as they are read. */
  async takeMarks(): Promise<Array<{ id: string; verdict: Mark }>> {
    return (await takeMarks(this.dir, ["approve", "refuse", "resume"], this.env)).map(({ id, mark }) => ({ id, verdict: mark as Mark }));
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
