// `wim hook <agent>`: an agent's turn-end hook (docs/peers.md, waking at turn end). When messages
// from trusted peers wait in this agent session's spool and were not announced yet, it asks the
// agent for one more turn with a fixed line: how many, and to call `inbox`. Nothing a peer wrote or
// chose (text, names, addresses, file names) ever reaches that line (SECURITY-MODEL section 7.1).
// Anything unclear lets the agent stop, and the command always exits 0. The turn it asks for is a
// mesh turn: the session's presence reads `busy-mesh` before the line is printed, so what the agent
// sends in it is marked derived (SPEC 6a), and a turn end that lets the agent stop writes `idle`.

import { b64u, sha256, utf8 } from "@worldinmotion/protocol";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { parseChain, sameProcess, type Ancestor } from "./ancestry.ts";
import { fsOps, readJson, readText, tryRemove, whileBusy, withLock, writeAtomic, writeJson, type FsEnv } from "./fsx.ts";
import { Home } from "./home.ts";
import { MeshFiles, type MeshConfig } from "./mesh.ts";
import { readPauses } from "./pauses.ts";
import { homeChoice, pidAlive, type Platform } from "./platform.ts";
import { isTrusted } from "./render.ts";
import { listSessions, SessionFiles } from "./session.ts";
import { Spool, type SpoolItem } from "./spool.ts";

/** The file `wim mcp` keeps in its session directory while it runs: its pid and the processes above it. */
export const POINTER_FILE = "ancestry.json";
/** The file only the hook writes, in the session directory: the newest item announced, per agent session. */
export const ANNOUNCED_FILE = "hook-announced.json";
/** The nearest process the hook shares with `wim mcp` must be at most this many levels above the hook. */
export const HOOK_LEVELS = 3;
/** A payload larger than this is not read: no wake. */
export const HOOK_INPUT_MAX = 1 << 20;
/** How long the hook waits for the agent to finish writing its payload. */
export const HOOK_INPUT_MS = 5000;
/** How long an announced entry is kept without use, and how many are kept at most. */
const ANNOUNCED_TTL_MS = 7 * 24 * 3600 * 1000;
const ANNOUNCED_MAX = 64;

/**
 * One turn end, as the hook reads it: the agent's own session key, and whether this stop already
 * follows a continuation. `ends` says why a turn end may not wake (a turn the person aborted or that
 * failed): it still ends a mesh turn.
 */
type Stop = { key: string; continued: boolean; ends?: string };

type Payload = Record<string, unknown>;

type AgentHook = {
  /** The stop, or undefined when the payload is not one this agent sends at turn end. */
  read(p: Payload): Stop | undefined;
  /** What asks this agent for one more turn with `text`. */
  wake(text: string): string;
  /** What lets it stop: nothing, or the JSON the agent requires. */
  allow: string;
};

const key = (v: unknown): string | undefined => (typeof v === "string" && v !== "" && v.length <= 256 ? v : undefined);

/** A stop whose session key and continuation flag are both what the agent documents, or undefined. */
function flagged(id: unknown, active: unknown): Stop | undefined {
  const k = key(id);
  return k === undefined || typeof active !== "boolean" ? undefined : { key: k, continued: active };
}

/**
 * Each agent's turn-end hook (docs/spikes.md, the wake spikes): the event, its session key, its
 * per-cycle flag, and its output. Gemini CLI and Antigravity are read from captured payloads, the
 * others from their documentation.
 */
export const HOOK_AGENTS: Readonly<Record<string, AgentHook>> = {
  gemini: {
    read: (p) => (p.hook_event_name === "AfterAgent" ? flagged(p.session_id, p.stop_hook_active) : undefined),
    wake: (text) => JSON.stringify({ decision: "deny", reason: text }),
    allow: "",
  },
  // No per-cycle flag: `executionNum` counts the calls in one prompt, and nothing captured shows when
  // it starts again, so only the announced record bounds it. A stop that carries an error is not woken.
  antigravity: {
    read: (p) => {
      const k = key(p.conversationId);
      if (k === undefined) return undefined;
      return p.error !== undefined && p.error !== "" ? { key: k, continued: false, ends: "the turn ended with an error" } : { key: k, continued: false };
    },
    wake: (text) => JSON.stringify({ decision: "continue", reason: text }),
    allow: "",
  },
  // Stop expects JSON on stdout when it exits 0.
  codex: {
    read: (p) => (p.hook_event_name === "Stop" ? flagged(p.session_id, p.stop_hook_active) : undefined),
    wake: (text) => JSON.stringify({ decision: "block", reason: text }),
    allow: "{}",
  },
  // `loop_count` counts follow-ups over the whole conversation, so it is no per-cycle flag. A turn
  // the person aborted, or one that failed, is not woken.
  cursor: {
    read: (p) => {
      const k = key(p.conversation_id);
      if (k === undefined || p.hook_event_name !== "stop") return undefined;
      return p.status === "completed" ? { key: k, continued: false } : { key: k, continued: false, ends: "the turn was aborted or failed" };
    },
    wake: (text) => JSON.stringify({ followup_message: text }),
    allow: "",
  },
  // The `agentStop` event's camelCase payload; its loop flag keeps the snake_case name.
  copilot: {
    read: (p) => flagged(p.sessionId, p.stop_hook_active),
    wake: (text) => JSON.stringify({ decision: "block", reason: text }),
    allow: "",
  },
};

/** The line the agent is given: a count and the instruction, nothing else. */
export function wakeText(n: number): string {
  return n === 1
    ? "1 message from another AI session is waiting in worldinmotion. Call the worldinmotion inbox tool to read it."
    : `${n} messages from other AI sessions are waiting in worldinmotion. Call the worldinmotion inbox tool to read them.`;
}

/** What the hook reads: its payload and where the device's state lives. */
export type HookOptions = {
  agent: string;
  /** The payload as text; undefined when it was too large or never finished. */
  input: string | undefined;
  env: Record<string, string | undefined>;
  platform: Platform;
  homedir: string;
  uid: number | undefined;
  pid: number;
  now: () => number;
  /** The processes above the hook, nearest first; undefined when they cannot be read here. */
  ancestry?: (levels: number) => Promise<Ancestor[]>;
};

/** What to print, and why, for `WIM_DEBUG=1`. */
export type HookAnswer = { out: string; why: string };

/** Decides one turn end. Never rejects. */
export async function hookAnswer(o: HookOptions): Promise<HookAnswer> {
  const agent = Object.hasOwn(HOOK_AGENTS, o.agent) ? HOOK_AGENTS[o.agent]! : undefined;
  if (agent === undefined) return { out: "", why: "not an agent the hook knows" };
  const stop = readStop(agent, o.input);
  if (stop === undefined) return { out: agent.allow, why: "not a turn-end payload this agent sends" };
  if (stop.continued) return { out: agent.allow, why: await ended(o, "this stop already follows a continuation") };
  if (stop.ends !== undefined) return { out: agent.allow, why: await ended(o, stop.ends) };
  const found = await waiting(o, `${o.agent}\0${stop.key}`).catch(cannotTell);
  if (typeof found === "string") return { out: agent.allow, why: found };
  return { out: agent.wake(wakeText(found)), why: `${found} waiting` };
}

const cannotTell = (error: unknown): string => `cannot tell: ${(error as Error).message}`;

/**
 * A turn end that may not wake (it follows a continuation, or the turn was aborted or failed): a
 * mesh turn the hook asked for ends, so the one session reads `idle`.
 */
async function ended(o: HookOptions, why: string): Promise<string> {
  const found = await locate(o).catch(cannotTell);
  return typeof found === "string" ? `${why}; nothing written: ${found}` : settle(found, why);
}

function readStop(agent: AgentHook, input: string | undefined): Stop | undefined {
  if (input === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return undefined;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) ? agent.read(value as Payload) : undefined;
}

/** How many items wait for this agent session and announce something new, or why there is no wake. */
async function waiting(o: HookOptions, sessionKey: string): Promise<number | string> {
  const found = await locate(o);
  if (typeof found === "string") return found;
  const { mesh, files, env } = found;
  const config = await mesh.loadConfig();
  const now = o.now();
  const paused = new Set((await readPauses(files.breakerPath, now)).map((p) => p.peer));
  const items = (await new Spool(files.spoolDir, env, 0).unread()).filter((i) => counts(i, config, paused));
  if (items.length === 0) return settle(found, "nothing waiting");
  const newest = Math.max(...items.map((i) => i.cursor));
  const why = await announce(files, sessionKey, newest, now, env);
  return why === undefined ? items.length : why === NOTHING_NEW ? settle(found, why) : why;
}

type Located = { mesh: MeshFiles; files: SessionFiles; env: FsEnv };

/** The device's mesh and the one session the hook runs beside, or why there is none. */
async function locate(o: HookOptions): Promise<Located | string> {
  if (o.ancestry === undefined) return "the processes above the hook cannot be read here";
  const env: FsEnv = { platform: o.platform, pid: o.pid };
  const home = new Home(homeChoice(o.env, o.platform, o.homedir).root, { ...env, uid: o.uid });
  const mesh = new MeshFiles(home.meshDir(await home.pickMesh(o.env["WIM_MESH"])), env);
  const files = await sessionFor(mesh, (await o.ancestry(HOOK_LEVELS)).slice(0, HOOK_LEVELS), env);
  return typeof files === "string" ? files : { mesh, files, env };
}

/**
 * A turn end that lets the agent stop: the session's presence reads `idle`, which ends a mesh turn
 * the hook asked for. One that cannot be written is left as it was: a session still marked
 * `busy-mesh` only marks more of what it sends as derived.
 */
async function settle(at: Located, why: string): Promise<string> {
  return writeAtomic(at.files.presencePath, "idle", at.env).then(
    () => why,
    (error: unknown) => `${why}; idle not written: ${(error as Error).message}`,
  );
}

/**
 * What counts: an unread message, task, result or file from a device the person trusts now, sent
 * by that peer itself, whose device the loop breaker does not hold. Notices (held counts, CI
 * notices, pauses), relayed items and notices for the person never count.
 */
function counts(i: SpoolItem, config: MeshConfig, paused: ReadonlySet<string>): boolean {
  return (
    ["msg", "task", "result", "file"].includes(i.kind) &&
    Number.isSafeInteger(i.cursor) &&
    typeof i.device === "string" &&
    i.device !== "" &&
    i.relayed !== true &&
    i.forPerson !== true &&
    isTrusted(config, i.device) &&
    !paused.has(i.device)
  );
}

type Pointer = { pid: number; chain: Ancestor[] };

/** Records, for the hook, which processes run above this `wim mcp`. */
export async function writePointer(dir: string, pid: number, chain: readonly Ancestor[], env: FsEnv): Promise<void> {
  await writeJson(join(dir, POINTER_FILE), { v: 1, pid, chain }, env);
}

/** Removes the pointer; one that cannot be removed is left (the liveness lock already tells it is stale). */
export async function removePointer(dir: string, env: FsEnv): Promise<void> {
  await tryRemove(join(dir, POINTER_FILE), env).catch(() => undefined);
}

async function readPointer(dir: string): Promise<Pointer | undefined> {
  const raw = (await readJson(join(dir, POINTER_FILE)).catch(() => undefined)) as Partial<{ v: number; pid: number; chain: unknown }> | undefined;
  const chain = parseChain(raw?.chain);
  return raw?.v === 1 && Number.isSafeInteger(raw.pid) && chain !== undefined && chain.length > 0 ? { pid: raw.pid!, chain } : undefined;
}

/** Whether the `wim mcp` that wrote a pointer still runs the session: it holds the liveness lock. */
async function runs(files: SessionFiles, pid: number, env: FsEnv): Promise<boolean> {
  const holder = (await whileBusy(() => readText(files.liveLock), env.platform))?.trim();
  return holder === String(pid) && pidAlive(pid, fsOps.kill);
}

/**
 * The one session that runs inside the same agent session as the hook. For each live session, the
 * nearest process above the hook that it shares; the nearest of those wins, held by exactly one
 * session, and it must be the process that started that `wim mcp`, so a shared terminal or IDE
 * window never counts. Anything else is a reason not to wake.
 */
async function sessionFor(mesh: MeshFiles, mine: readonly Ancestor[], env: FsEnv): Promise<SessionFiles | string> {
  const found: Array<{ files: SessionFiles; level: number; direct: boolean }> = [];
  for (const sid of await listSessions(mesh)) {
    const files = new SessionFiles(mesh, sid, env);
    const pointer = await readPointer(files.dir);
    if (pointer === undefined || !(await runs(files, pointer.pid, env))) continue;
    const level = mine.findIndex((a) => pointer.chain.some((b) => sameProcess(a, b)));
    if (level >= 0) found.push({ files, level, direct: sameProcess(pointer.chain[0]!, mine[level]!) });
  }
  if (found.length === 0) return "no running session shares a process with the hook";
  const nearest = Math.min(...found.map((f) => f.level));
  const at = found.filter((f) => f.level === nearest);
  if (at.length > 1) return `${at.length} sessions share the nearest process: not one session`;
  return at[0]!.direct ? at[0]!.files : "the nearest shared process did not start a session's `wim mcp`";
}

type Announced = Record<string, { cursor: number; at: number }>;

const NOTHING_NEW = "nothing new since the last announcement";

/**
 * Records `newest` as announced for this agent session, under a lock, written atomically, and
 * undefined then: the hook may wake. An announced item the agent did not read is not announced
 * again. Before the record, the session's presence is written `busy-mesh` (SECURITY-MODEL section
 * 7.1): the turn the hook asks for is a mesh turn, so what the agent sends in it is derived. When
 * that write fails, nothing is recorded and the reason comes back: no wake.
 */
async function announce(files: SessionFiles, sessionKey: string, newest: number, now: number, env: FsEnv): Promise<string | undefined> {
  const path = join(files.dir, ANNOUNCED_FILE);
  const id = b64u.encode(sha256(utf8(sessionKey))).slice(0, 22);
  return withLock(`${path}.lock`, async () => {
    const raw = (await readJson(path).catch(() => undefined)) as { v?: number; sessions?: unknown } | undefined;
    const kept: Announced = {};
    const rows = raw?.v === 1 && typeof raw.sessions === "object" && raw.sessions !== null ? Object.entries(raw.sessions as Record<string, Partial<{ cursor: number; at: number }>>) : [];
    for (const [k, e] of rows) if (Number.isSafeInteger(e?.cursor) && Number.isSafeInteger(e?.at) && now - e.at! < ANNOUNCED_TTL_MS) kept[k] = { cursor: e.cursor!, at: e.at! };
    if (newest <= (kept[id]?.cursor ?? 0)) return NOTHING_NEW;
    const unmarked = await writeAtomic(files.presencePath, "busy-mesh", env).then(
      () => undefined,
      (error: unknown) => `cannot mark the turn a mesh turn: ${(error as Error).message}`,
    );
    if (unmarked !== undefined) return unmarked;
    kept[id] = { cursor: newest, at: now };
    const newestFirst = Object.entries(kept).sort((a, b) => b[1].at - a[1].at).slice(0, ANNOUNCED_MAX);
    await writeJson(path, { v: 1, sessions: Object.fromEntries(newestFirst) }, env);
    return undefined;
  }, env, 2000);
}

/**
 * The payload on stdin: at most `max` bytes, within `ms`. Undefined when it is larger, never
 * ends, or the stream fails.
 */
export function readInput(stream: Readable, max = HOOK_INPUT_MAX, ms = HOOK_INPUT_MS): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (value: string | undefined): void => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += b.length;
      if (size > max) return done(undefined);
      chunks.push(b);
    };
    const onEnd = (): void => done(Buffer.concat(chunks).toString("utf8"));
    const onError = (): void => done(undefined);
    const timer = setTimeout(() => done(undefined), ms);
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}
