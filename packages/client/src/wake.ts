// The wake predicate (docs/peers.md, waking at turn end): what in a session's spool may give an
// agent another turn, and the fixed line it is given. Shared by `wim hook` and anything else that
// starts a turn for mesh items. Nothing a peer or the relay wrote or chose (text, names,
// addresses, file names) ever reaches the line (SECURITY-MODEL section 7.1).

import type { MeshConfig } from "./mesh.ts";
import { isTrusted } from "./render.ts";
import type { SpoolItem } from "./spool.ts";

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
