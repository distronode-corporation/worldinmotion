// What a session does with what it holds when nobody decides (SECURITY-MODEL section 7.2): a held
// item the person's policy now delivers is delivered, one it now refuses is dropped, and a held
// feed line expires once it is too old or superseded. Every input here is what the client
// authenticated or the person set: the sender's device id and session, the relayed flag, the
// policy in mesh.json. No text a sender wrote decides anything.

import type { HeldItem } from "./held.ts";
import type { HeldFeedLimits, MeshConfig } from "./mesh.ts";
import { policyFor } from "./render.ts";

/** What a review reads of a held item. */
export type Reviewed = Pick<HeldItem, "id" | "from" | "device" | "kind" | "at" | "reason" | "ci"> & { entry: Pick<HeldItem["entry"], "relayed" | "reply_to" | "redacted"> };

/**
 * A held feed line: a plain `msg` its sender marked relayed (text it forwards, such as a `wim ci`
 * pipeline line, a bot's or a worker's room post), that answers nothing (no `reply_to`), held by
 * policy or by the loop breaker. Relayed text never starts a turn, so a busy CI hour that trips
 * the breaker leaves a backlog of lines nobody needs; they expire as policy-held ones do, while
 * the breaker counts and pauses as before. A task, a result, a file, a reply, a CI notice (SPEC
 * section 18) and a message that is not relayed are never feed lines: they wait for the person,
 * as before, whoever held them.
 */
export function isFeedLine(item: Reviewed): boolean {
  return (item.reason === "policy" || item.reason === "breaker") && item.ci === undefined && item.kind === "msg" && item.entry.relayed === true && item.entry.reply_to === undefined;
}

/**
 * The feed a line belongs to: its sending device's id and session name. Both are authenticated
 * (the device signed the message), so a sender can only ever supersede its own lines.
 */
export function feedOf(item: Pick<HeldItem, "device" | "from">): string {
  return `${item.device} ${sessionOf(item.from)}`;
}

/** The session part of an address the client built from the roster (`session@device`). */
export function sessionOf(address: string): string {
  return address.slice(0, address.lastIndexOf("@"));
}

/**
 * The held feed lines that expire now: every one sent more than `maxAgeHours` ago, and every one
 * superseded, which is a line with at least `keep` newer held lines in its feed. Oldest first.
 */
export function expiredFeedLines<T extends Reviewed>(items: readonly T[], limits: HeldFeedLimits, now: number): T[] {
  // Newest first; the id (a ULID) orders lines sent in the same millisecond.
  const lines = items.filter(isFeedLine).sort((a, b) => b.at - a.at || Number(a.id < b.id) - Number(a.id > b.id));
  const seen = new Map<string, number>();
  const out: T[] = [];
  for (const line of lines) {
    const feed = feedOf(line);
    const newer = seen.get(feed) ?? 0;
    seen.set(feed, newer + 1);
    if (newer >= limits.keep || now - line.at > limits.maxAgeHours * 3_600_000) out.push(line);
  }
  return out.reverse();
}

/** Why a feed line expired, for the session's log and `wim held list`. */
export function expiryText(limits: HeldFeedLimits): string {
  return `older than ${limits.maxAgeHours} hour${limits.maxAgeHours === 1 ? "" : "s"}, or more than ${limits.keep} newer held from the same feed`;
}

/**
 * What the person's policy does now with an item it held: `deliver` (the device is trusted now,
 * with `--relayed` for a relayed item), `refuse`, or `hold` (unchanged). Only a policy hold of a
 * peer's message, from a device still in the roster, is looked at again: the loop breaker's holds
 * and CI notices are decided as before. An item held by a session that keeps no message text
 * (`redactStoredText`) holds none to deliver, so the policy never delivers it by itself: it waits
 * for the person, though a policy of `refuse` still drops it.
 */
export function policyNow(item: Reviewed, config: MeshConfig, inRoster: (device: string) => boolean): "deliver" | "hold" | "refuse" {
  if (item.reason !== "policy" || item.ci !== undefined || !inRoster(item.device)) return "hold";
  const now = policyFor(config, item.device, item.entry.relayed === true);
  return now === "deliver" && item.entry.redacted === true ? "hold" : now;
}
