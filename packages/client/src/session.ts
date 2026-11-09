// One session's files: session.json (name, resume secret, cursor, rooms, seq), its liveness
// lock, and the map that lets a restarted agent take its session back.

import { b64u, isName, isUlid, randomBytes, sanitizeForDisplay, sha256, ulid, utf8 } from "@worldinmotion/protocol";
import { join } from "node:path";
import { claimLock, listDir, lockHeld, lockMine, readJson, readText, releaseLock, removeFile, whileBusy, writeAtomic, writeJson, type FsEnv } from "./fsx.ts";
import type { MeshFiles } from "./mesh.ts";

export type SessionState = {
  v: 1;
  sid: string;
  name: string;
  kind: string;
  /** b64u of 32 random bytes; its hash at the relay proves a later claim on this session. */
  resume: string;
  /** The last relay cursor this session acknowledged. */
  cursor: number;
  rooms: string[];
  /** The last seq this session sent (SPEC section 6: per sid, from 1). */
  seq: number;
  /** The last spool item number handed out. */
  spool: number;
  /** Lease key to fencing token, for leases this session holds. */
  leases: Record<string, number>;
  /**
   * Lease key to the `until` the relay last gave it (relay clock), for leases this session holds:
   * a token whose lease ran out is dropped (absent for a lease held before this was kept).
   */
  leaseUntil?: Record<string, number>;
  /** The address the relay assigned at the last `ready`. */
  address?: string;
  /**
   * The name this session asked for, kept beside the one the relay assigned: a session that got
   * `name-N` is still taken back under `name` (design.md, taking a session back).
   */
  asked?: string;
  /** Claims that took this session over (`--take`, `WIM_TAKE=1`, `rename` with `take`), for `wim status`. */
  claims?: ClaimRecord[];
  /** The working directory of the process that ran it, for same-project takeover. */
  cwd?: string;
  /** Set once the session said `bye { ended: true }`: the relay keeps it only as a tombstone. */
  ended?: true;
};

/** One claim of a session: when, the address taken over, and the claiming process's working directory. */
export type ClaimRecord = { at: number; address: string; cwd?: string };

/** How long `wim status` lists a takeover, and how long a session keeps its claim records. */
export const CLAIM_SHOWN_MS = 24 * 3600 * 1000;

function parseClaims(raw: unknown[]): ClaimRecord[] {
  return (raw as Array<Partial<ClaimRecord> | null>).flatMap((c) =>
    typeof c?.at === "number" && Number.isFinite(c.at) && typeof c.address === "string" ? [{ at: c.at, address: c.address, ...(typeof c.cwd === "string" ? { cwd: c.cwd } : {}) }] : [],
  );
}

/**
 * The takeovers of the last 24 hours among this mesh's sessions on this device, newest first, as
 * `wim status` and `wim doctor` show them: a peer's text can prompt an agent to claim a name, so
 * the person sees each one.
 */
export async function recentTakeovers(mesh: MeshFiles, env: FsEnv, now: number): Promise<string[]> {
  const found: ClaimRecord[] = [];
  for (const sid of await listSessions(mesh)) {
    const state = await new SessionFiles(mesh, sid, env).load();
    for (const c of state?.claims ?? []) if (now - c.at < CLAIM_SHOWN_MS) found.push(c);
  }
  return found.sort((a, b) => b.at - a.at).map((c) => `${shown(c.address)} was taken over ${ago(now - c.at)} ago by a session ${c.cwd === undefined ? "with no working directory" : `in ${shown(c.cwd)}`}`);
}

/** A field of a claim record as a terminal line shows it: controls and invisible characters escaped visibly, on one line. */
function shown(text: string): string {
  return sanitizeForDisplay(text).replace(/\n/g, "<U+000A>").replace(/\t/g, " ");
}

function ago(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h`;
}

export function newSessionState(name: string, kind: string): SessionState {
  return { v: 1, sid: ulid(), name, kind, resume: b64u.encode(randomBytes(32)), cursor: 0, rooms: [], seq: 0, spool: 0, leases: {} };
}

export function parseSessionState(raw: unknown): SessionState | undefined {
  const s = raw as Partial<SessionState> | undefined;
  if (s?.v !== 1 || !isUlid(s.sid) || !isName(s.name) || !isName(s.kind) || typeof s.resume !== "string") return undefined;
  const int = (n: unknown): number => (Number.isSafeInteger(n) && (n as number) >= 0 ? (n as number) : 0);
  return {
    v: 1,
    sid: s.sid,
    name: s.name,
    kind: s.kind,
    resume: s.resume,
    cursor: int(s.cursor),
    rooms: Array.isArray(s.rooms) ? s.rooms.filter((r) => typeof r === "string") : [],
    seq: int(s.seq),
    spool: int(s.spool),
    leases: typeof s.leases === "object" && s.leases !== null ? s.leases : {},
    ...(typeof s.leaseUntil === "object" && s.leaseUntil !== null ? { leaseUntil: s.leaseUntil } : {}),
    ...(typeof s.address === "string" ? { address: s.address } : {}),
    ...(isName(s.asked) ? { asked: s.asked } : {}),
    ...(Array.isArray(s.claims) ? { claims: parseClaims(s.claims) } : {}),
    ...(typeof s.cwd === "string" ? { cwd: s.cwd } : {}),
    ...(s.ended === true ? { ended: true as const } : {}),
  };
}

/**
 * A turn mark in the presence file, `idle <n>`, which `wim hook` writes at each turn end that lets
 * the agent stop: idle, and a new turn end whenever `n` changes. The plugin writes plain words.
 */
export const IDLE_MARK = /^idle ([0-9]{1,15})$/;

/** The directory tree of one session (design.md, state on disk). */
export class SessionFiles {
  readonly dir: string;

  readonly sid: string;
  readonly env: FsEnv;

  constructor(mesh: MeshFiles, sid: string, env: FsEnv) {
    this.sid = sid;
    this.env = env;
    this.dir = mesh.sessionDir(sid);
  }

  get statePath(): string {
    return join(this.dir, "session.json");
  }
  get spoolDir(): string {
    return join(this.dir, "spool");
  }
  get cursorPath(): string {
    return join(this.dir, "spool", "cursor");
  }
  get presencePath(): string {
    return join(this.dir, "presence");
  }
  get heldDir(): string {
    return join(this.dir, "held");
  }
  /** The loop breaker's running pauses in this session, for `wim held list` (pauses.ts). */
  get breakerPath(): string {
    return join(this.dir, "breaker.json");
  }
  /** Dismiss marks for relayed items (`<id>.dismiss`), left by the plugin's pane. */
  get dismissDir(): string {
    return join(this.dir, "dismiss");
  }
  get filesDir(): string {
    return join(this.dir, "files");
  }
  get historyPath(): string {
    return join(this.dir, "history.jsonl");
  }
  /** CI notices acknowledged while their provider's keys could not be fetched, to be checked again. */
  get ciParkedPath(): string {
    return join(this.dir, "ci-parked.json");
  }
  /** The idle notices this session armed, so a notice nobody asked for is dropped (watches.ts). */
  get watchesPath(): string {
    return join(this.dir, "watches.json");
  }
  get tasksPath(): string {
    return join(this.dir, "tasks.json");
  }
  get sentTasksPath(): string {
    return join(this.dir, "sent-tasks.json");
  }
  get behindDir(): string {
    return join(this.dir, "behind");
  }
  get controlDir(): string {
    return join(this.dir, "control");
  }
  get liveLock(): string {
    return join(this.dir, "live.lock");
  }
  /** Written by a session that takes handed-over sends (`wim watch`): the pid of its process. */
  get handoverPath(): string {
    return join(this.dir, "handover");
  }

  async load(): Promise<SessionState | undefined> {
    return parseSessionState(await readJson(this.statePath));
  }

  async save(state: SessionState): Promise<void> {
    await writeJson(this.statePath, state, this.env);
  }

  /** Marks this process as the session's live holder. False when another live process holds it. */
  claim(): Promise<boolean> {
    return claimLock(this.liveLock, this.env);
  }

  /** Gives up the liveness lock, while this process still holds it: one another process holds is left alone. */
  release(): Promise<void> {
    return releaseLock(this.liveLock, this.env);
  }

  /** Whether this process holds the liveness lock (a UI's events process that runs the session itself). */
  holds(): Promise<boolean> {
    return lockMine(this.liveLock, this.env);
  }

  isLiveElsewhere(): Promise<boolean> {
    return lockHeld(this.liveLock, this.env);
  }

  /**
   * Says whether this process's session takes handed-over sends (`wim watch`): the handover file
   * names this pid, or is removed. Written after the liveness claim, by its holder.
   */
  async markHandover(takes: boolean): Promise<void> {
    if (takes) await writeAtomic(this.handoverPath, String(this.env.pid), this.env);
    else await removeFile(this.handoverPath);
  }

  /**
   * Whether another live process runs this session and takes handed-over sends: it holds the
   * liveness lock and the handover file names the same pid. Any other holder (a `wim send --wait`,
   * a `wim inbox`) holds the name without taking sends, and a file left by a watch that died names
   * a pid that no longer holds the lock.
   */
  async takesHandoverElsewhere(): Promise<boolean> {
    // As lockHeld reads the lock: a file being replaced just then is busy for a moment on Windows.
    const read = (path: string): Promise<string | undefined> => whileBusy(() => readText(path), this.env.platform);
    const [live, marker, lock] = await Promise.all([this.isLiveElsewhere(), read(this.handoverPath), read(this.liveLock)]);
    return takesSends(live, marker, lock);
  }
}

/** Kept apart from the awaits above (see AgentServer.answerLine): a live holder whose pid the handover file names. */
export function takesSends(live: boolean, marker: string | undefined, lock: string | undefined): boolean {
  return live && marker !== undefined && marker.trim() === (lock ?? "").trim();
}

/** All session ids that have state on disk. */
export async function listSessions(mesh: MeshFiles): Promise<string[]> {
  return (await listDir(mesh.sessionsDir)).filter(isUlid).sort();
}

/** How long an unused session key mapping is kept. */
export const SESSION_KEY_TTL_MS = 7 * 24 * 3600 * 1000;

type KeyEntry = { v: 1; sid: string; resume: string; used: number };

/**
 * Maps a stable outside key (a Claude Code session id, or `WIM_SESSION_KEY`) to a wim session,
 * so an agent that restarts or resumes takes back its sid and resume secret, and with them its
 * name, queue, rooms, leases and history. Files are named by a hash of the key, never the key.
 */
export class SessionKeys {
  private readonly mesh: MeshFiles;
  private readonly env: FsEnv;
  private readonly now: () => number;

  constructor(mesh: MeshFiles, env: FsEnv, now: () => number) {
    this.mesh = mesh;
    this.env = env;
    this.now = now;
  }

  private path(key: string): string {
    return join(this.mesh.keysDir, `${b64u.encode(sha256(utf8(key))).slice(0, 22)}.json`);
  }

  /** The session a key names, if its mapping is still fresh. Expired mappings are deleted. */
  async lookup(key: string): Promise<{ sid: string; resume: string } | undefined> {
    await this.prune();
    const raw = (await readJson(this.path(key))) as Partial<KeyEntry> | undefined;
    return raw?.v === 1 && isUlid(raw.sid) && typeof raw.resume === "string" ? { sid: raw.sid, resume: raw.resume } : undefined;
  }

  /** Records (or refreshes) a mapping; 0600 like every state file, since it holds the resume secret. */
  async remember(key: string, sid: string, resume: string): Promise<void> {
    await writeJson(this.path(key), { v: 1, sid, resume, used: this.now() } satisfies KeyEntry, this.env);
  }

  private async prune(): Promise<void> {
    const cutoff = this.now() - SESSION_KEY_TTL_MS;
    for (const name of await listDir(this.mesh.keysDir)) {
      const path = join(this.mesh.keysDir, name);
      const raw = (await readJson(path).catch(() => undefined)) as Partial<KeyEntry> | undefined;
      if (raw === undefined || typeof raw.used !== "number" || raw.used < cutoff) await removeFile(path);
    }
  }
}
