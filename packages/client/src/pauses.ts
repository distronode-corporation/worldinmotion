// Loop breaker pauses on disk, on both sides (SECURITY-MODEL section 7.3).
//
// The receiving side: each live session writes the pauses its breaker holds to its own
// `breaker.json`, so `wim held list` (another process) shows them with the rule and when they end,
// and a later process of the session takes them back: with the sessions told, the automatic
// releases of the last hour, and the `lifted` an offline resume left for it to send.
//
// The sending side: a `pause` from a peer session (SPEC section 12) says its breaker holds this
// device's messages. It is kept in the mesh's `paused-by.json`, device-wide because the breaker
// counts per sender device, so every session of this device reports a send there as `held`. It
// is a label, like a receipt: it changes what a send reports, never what is sent or delivered.

import type { PauseInfo } from "@worldinmotion/protocol";
import type { Pause } from "./breaker.ts";
import { readJson, withLock, writeJson, type FsEnv } from "./fsx.ts";
import type { MeshFiles } from "./mesh.ts";
import { listSessions, SessionFiles } from "./session.ts";

/**
 * A pause as a session writes it: the breaker's, the address of the message that tripped it, and
 * the sending sessions told about it, so a later process of the session carries it on.
 */
export type PauseRow = Pause & { from: string; told: string[] };

/** What `breaker.json` holds. `released`: when each peer was last released by itself; `lifts`: sessions still to hear `lifted`. */
export type BreakerFile = { pauses: PauseRow[]; released: Record<string, number>; lifts: string[] };

/** Writes a session's pauses (an empty list once none runs). */
export async function savePauses(path: string, file: BreakerFile, env: FsEnv): Promise<void> {
  await writeJson(path, file, env);
}

function isPauseRow(x: unknown): x is PauseRow {
  const r = x as Partial<PauseRow> | null;
  return (
    typeof r === "object" &&
    r !== null &&
    typeof r.from === "string" &&
    typeof r.peer === "string" &&
    (r.rule === "peer" || r.rule === "total" || r.rule === "pingpong") &&
    [r.count, r.limit, r.minutes, r.at, r.until].every((n) => Number.isSafeInteger(n)) &&
    typeof r.auto === "boolean" &&
    Array.isArray(r.told) &&
    r.told.every((t) => typeof t === "string")
  );
}

/**
 * A session's pauses that are still running at `now` (pass -Infinity for all of them, ended ones
 * too); a damaged or missing file reads as none.
 */
export async function readPauses(path: string, now: number): Promise<PauseRow[]> {
  return (await readBreakerFile(path)).pauses.filter((r) => r.until > now);
}

/** All of `breaker.json`, what is well formed in it: ended pauses too. A damaged or missing file reads as empty. */
export async function readBreakerFile(path: string): Promise<BreakerFile> {
  const raw = (await readJson(path).catch(() => undefined)) as Partial<Record<keyof BreakerFile, unknown>> | undefined;
  const pauses = Array.isArray(raw?.pauses) ? raw.pauses.filter(isPauseRow) : [];
  const released = Object.fromEntries(
    Object.entries(typeof raw?.released === "object" && raw.released !== null ? raw.released : {}).filter(([, at]) => Number.isSafeInteger(at)),
  ) as Record<string, number>;
  const lifts = Array.isArray(raw?.lifts) ? raw.lifts.filter((t): t is string => typeof t === "string") : [];
  return { pauses, released, lifts };
}

/** Every running pause of every session of a mesh on this device, oldest first. */
export async function listAllPauses(mesh: MeshFiles, env: FsEnv, now: number): Promise<Array<PauseRow & { sid: string; session: string }>> {
  const out: Array<PauseRow & { sid: string; session: string }> = [];
  for (const sid of await listSessions(mesh)) {
    const files = new SessionFiles(mesh, sid, env);
    const name = (await files.load())?.name ?? "?";
    for (const r of await readPauses(files.breakerPath, now)) out.push({ ...r, sid, session: name });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** What a peer's `pause` said about this device's messages to one of its sessions. */
export type PausedByEntry = Extract<PauseInfo, { state: "paused" }> & { to: string; at: number };

type PausedByFile = Record<string, PausedByEntry>;

/** The peer sessions (by `deviceId/session`) whose breaker holds this device's messages. */
export class PausedBy {
  private readonly path: string;
  private readonly env: FsEnv;
  private readonly now: () => number;

  constructor(path: string, env: FsEnv, now: () => number) {
    this.path = path;
    this.env = env;
    this.now = now;
  }

  private async read(): Promise<PausedByFile> {
    const raw = (await readJson(this.path).catch(() => undefined)) as PausedByFile | undefined;
    const now = this.now();
    const out: PausedByFile = {};
    if (typeof raw !== "object" || raw === null) return out;
    for (const [pair, e] of Object.entries(raw)) if (typeof e?.until === "number" && e.until > now && typeof e.to === "string") out[pair] = e;
    return out;
  }

  /** The running entries, by pair. */
  async active(): Promise<PausedByFile> {
    return this.read();
  }

  /** Records a `pause` from the session `pair` (`to` is its address), or forgets one on `lifted`. */
  async note(pair: string, to: string, info: PauseInfo, at: number): Promise<void> {
    await withLock(`${this.path}.lock`, async () => {
      const file = await this.read();
      if (info.state === "lifted") delete file[pair];
      else file[pair] = { ...info, to, at };
      await writeJson(this.path, file, this.env);
    }, this.env);
  }
}

/** How long a session's own record of a pair stays fresh before it is written again. */
const SENT_TO_REFRESH_MS = 5 * 60_000;
/** A `pause` counts only from a pair sent to within this long. */
export const SENT_TO_LISTEN_MS = 3_600_000;
/** The most pairs the device-wide record keeps, newest first: as many as a mesh holds sessions. */
const SENT_TO_MAX = 256;

/**
 * The peer sessions (by `deviceId/session`) this device's sessions sent to in the last hour, kept
 * in the mesh's `sent-to.json` so a session that restarted still takes a `pause` meant for it.
 * Each session writes a pair again at most every 5 minutes.
 */
export class SentTo {
  private readonly path: string;
  private readonly env: FsEnv;
  private readonly now: () => number;
  /** What this process wrote last, by pair. */
  private readonly written = new Map<string, number>();

  constructor(path: string, env: FsEnv, now: () => number) {
    this.path = path;
    this.env = env;
    this.now = now;
  }

  private async read(): Promise<Record<string, number>> {
    const raw = (await readJson(this.path).catch(() => undefined)) as Record<string, unknown> | undefined;
    const now = this.now();
    const fresh = Object.entries(typeof raw === "object" && raw !== null ? raw : {}).filter(
      (e): e is [string, number] => Number.isSafeInteger(e[1]) && now - (e[1] as number) <= SENT_TO_LISTEN_MS,
    );
    return Object.fromEntries(fresh.sort((a, b) => b[1] - a[1]).slice(0, SENT_TO_MAX));
  }

  /** Notes messages sent to `pairs` now. */
  async note(pairs: readonly string[]): Promise<void> {
    const now = this.now();
    const due = pairs.filter((p) => now - (this.written.get(p) ?? Number.NEGATIVE_INFINITY) >= SENT_TO_REFRESH_MS);
    if (due.length === 0) return;
    for (const p of due) this.written.set(p, now);
    await withLock(`${this.path}.lock`, async () => {
      const file = await this.read();
      for (const p of due) file[p] = now;
      await writeJson(this.path, file, this.env);
    }, this.env);
  }

  /** Whether a session of this device sent to `pair` in the last hour. */
  async has(pair: string): Promise<boolean> {
    return Object.hasOwn(await this.read(), pair);
  }
}
