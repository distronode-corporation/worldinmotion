// Loop breaker pauses on disk, on both sides (SECURITY-MODEL section 7.3).
//
// The receiving side: each live session writes the pauses its breaker holds to its own
// `breaker.json`, so `wim held list` (another process) shows them with the rule and when they end.
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

/** A pause as a session writes it: the breaker's, and the address of the message that tripped it. */
export type PauseRow = Pause & { from: string };

/** Writes a session's running pauses (an empty list once none runs). */
export async function savePauses(path: string, rows: readonly PauseRow[], env: FsEnv): Promise<void> {
  await writeJson(path, { pauses: rows }, env);
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
    typeof r.trusted === "boolean"
  );
}

/** A session's pauses that are still running at `now`; a damaged or missing file reads as none. */
export async function readPauses(path: string, now: number): Promise<PauseRow[]> {
  const raw = (await readJson(path).catch(() => undefined)) as { pauses?: unknown } | undefined;
  const rows = Array.isArray(raw?.pauses) ? raw.pauses : [];
  return rows.filter(isPauseRow).filter((r) => r.until > now);
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

  /**
   * A `delivered` receipt from the session `pair` for a message sent at `sentAt`: a message sent
   * after this device heard of the pause got through, so the pause is over there (its session may
   * have restarted, or its person resumed it while it was not running). An older message's receipt
   * says nothing, since a message taken from the inbox late is receipted late. Writes only then.
   */
  async deliveredSince(pair: string, sentAt: number): Promise<void> {
    const e = (await this.read())[pair];
    // Strictly after: a message sent in the same millisecond may have gone before the pause.
    if (e !== undefined && sentAt > e.at) await this.note(pair, "", { state: "lifted" }, 0);
  }
}
