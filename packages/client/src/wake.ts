// The wake predicate (docs/peers.md, waking at turn end): what in a session's spool may give an
// agent another turn, the fixed line it is given, the record of what was announced, and the turn
// mark a turn end writes. Shared by `wim hook` and `wim run` (hosted sessions), so both wake for
// exactly the same items. Nothing a peer or the relay wrote or chose (text, names, addresses, file
// names) ever reaches the line (SECURITY-MODEL section 7.1).

import { b64u, sha256, utf8 } from "@worldinmotion/protocol";
import { join } from "node:path";
import { readJson, readText, withLock, writeAtomic, writeJson, type FsEnv } from "./fsx.ts";
import type { MeshConfig, MeshFiles } from "./mesh.ts";
import { readPauses } from "./pauses.ts";
import { isTrusted } from "./render.ts";
import { IDLE_MARK, type SessionFiles } from "./session.ts";
import { Spool, type SpoolItem } from "./spool.ts";

/** The file only a wake writes, in the session directory: the newest item announced, per agent session. */
export const ANNOUNCED_FILE = "hook-announced.json";
/** How long an announced entry is kept without use, and how many are kept at most. */
const ANNOUNCED_TTL_MS = 7 * 24 * 3600 * 1000;
const ANNOUNCED_MAX = 64;
/** The largest turn mark the client reads (`IDLE_MARK`: at most 15 digits). */
const MARK_MAX = 999_999_999_999_999;

/** What one unread item counts as for a wake: a message, a notice this session asked for, or nothing. */
export type WakeKind = "message" | "notice" | undefined;

/**
 * What counts: an unread message, task, result or file from a device the person trusts now, sent
 * by that peer itself, whose device the loop breaker does not hold; and an idle notice this
 * session armed (`watched` set, not `quiet`) about a device the person still trusts and the
 * breaker does not hold. Other notices (held counts, CI notices, pauses, lapses), relayed items
 * and notices for the person never count.
 */
export function wakeKind(i: SpoolItem, config: MeshConfig, paused: ReadonlySet<string>): WakeKind {
  if (!Number.isSafeInteger(i.cursor) || i.relayed === true || i.forPerson === true) return undefined;
  const device = i.kind === "notice" ? (i.quiet === true ? undefined : i.watched) : ["msg", "task", "result", "file"].includes(i.kind) ? i.device : undefined;
  if (typeof device !== "string" || device === "" || !isTrusted(config, device) || paused.has(device)) return undefined;
  return i.kind === "notice" ? "notice" : "message";
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The line the agent is given: the counts and the instruction, nothing else. */
export function wakeText(messages: number, notices = 0): string {
  const m = plural(messages, "message from another AI session", "messages from other AI sessions");
  const n = plural(notices, "notice this session asked for", "notices this session asked for");
  const what = notices === 0 ? m : messages === 0 ? n : `${m} and ${n}`;
  const one = messages + notices === 1;
  return `${what} ${one ? "is" : "are"} waiting in worldinmotion. Call the worldinmotion inbox tool to read ${one ? "it" : "them"}.`;
}

/** What waits in a session that may wake: how many messages and notices, and the newest item's number. */
export type Waiting = { messages: number; notices: number; newest: number };

/** The unread items in `files`' spool that may wake (wakeKind), counted; undefined when there are none. */
export async function waitingIn(mesh: MeshFiles, files: SessionFiles, env: FsEnv, now: number): Promise<Waiting | undefined> {
  const config = await mesh.loadConfig();
  const paused = new Set((await readPauses(files.breakerPath, now)).map((p) => p.peer));
  const items = (await new Spool(files.spoolDir, env, 0).unread()).map((i) => ({ cursor: i.cursor, kind: wakeKind(i, config, paused) })).filter((i) => i.kind !== undefined);
  if (items.length === 0) return undefined;
  const notices = items.filter((i) => i.kind === "notice").length;
  return { messages: items.length - notices, notices, newest: Math.max(...items.map((i) => i.cursor)) };
}

type Announced = Record<string, { cursor: number; at: number }>;

/** Why `announce` did not record a wake when every item it would count was announced already. */
export const NOTHING_NEW = "nothing new since the last announcement";

/**
 * Records `newest` as announced for one agent session (`sessionKey`), under a lock, written
 * atomically, and undefined then: a wake may go ahead. An announced item the agent did not read is
 * not announced again. Before the record, the session's presence is written `busy-mesh`
 * (SECURITY-MODEL section 7.1): the turn the wake asks for is a mesh turn, so what the agent sends
 * in it is derived. When that write fails, nothing is recorded and the reason comes back: no wake.
 */
export async function announce(files: SessionFiles, sessionKey: string, newest: number, now: number, env: FsEnv): Promise<string | undefined> {
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
 * A turn end that lets the agent stop: the session's presence reads a new turn mark, `idle <n>`,
 * which ends a mesh turn, and which the client reports as idle even when the session was idle
 * already. `n` is the time, or one above the mark it replaces when the clock has not passed it,
 * and never longer than the client reads. Rejects when the mark cannot be written.
 */
export async function markIdle(files: SessionFiles, now: number, env: FsEnv): Promise<void> {
  const before = IDLE_MARK.exec((await readText(files.presencePath).catch(() => undefined))?.trim() ?? "");
  const prev = before === null ? -1 : Number(before[1]);
  const mark = prev >= now && prev < MARK_MAX ? prev + 1 : now;
  await writeAtomic(files.presencePath, `idle ${mark}`, env);
}
