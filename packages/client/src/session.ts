// One session's files: session.json (name, resume secret, cursor, rooms, seq), its liveness
// lock, and the map that lets a restarted agent take its session back.

import { b64u, isName, isUlid, randomBytes, sha256, ulid, utf8 } from "@worldinmotion/protocol";
import { join } from "node:path";
import { claimLock, listDir, lockHeld, readJson, readText, releaseLock, removeFile, writeAtomic, writeJson, type FsEnv } from "./fsx.ts";
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
  /** The address the relay assigned at the last `ready`. */
  address?: string;
  /** The working directory of the process that ran it, for same-project takeover. */
  cwd?: string;
  /** Set once the session said `bye { ended: true }`: the relay keeps it only as a tombstone. */
  ended?: true;
};

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
    ...(typeof s.address === "string" ? { address: s.address } : {}),
    ...(typeof s.cwd === "string" ? { cwd: s.cwd } : {}),
    ...(s.ended === true ? { ended: true as const } : {}),
  };
}

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

  release(): Promise<void> {
    return releaseLock(this.liveLock, this.env);
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
    const [live, marker, lock] = await Promise.all([this.isLiveElsewhere(), readText(this.handoverPath), readText(this.liveLock)]);
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
