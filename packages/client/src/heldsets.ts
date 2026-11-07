// Held messages are decided a set at a time (SECURITY-MODEL section 7.2): every item held from one
// sending device, or under one CI rule, is shown together, in order, with its count and time span,
// before the person decides. A request split across several harmless-looking messages is then read
// as one. The grouping uses only what the client authenticated (the sender's device id, the rule a
// notice matched), never text a sender wrote, so no message can move itself into another set or
// change the count shown.

import { sanitizeForDisplay } from "@worldinmotion/protocol";
import { ruleLine, type CiRule } from "./cirules.ts";
import type { HeldItem } from "./held.ts";

/** What grouping reads of a held item. */
export type SetMember = Pick<HeldItem, "id" | "device" | "at" | "ci">;

/** One set: its rows oldest first (a room message held by two sessions is two rows, one id). */
export type HeldSet<T extends SetMember> = { key: string; rows: T[]; ids: string[]; first: number; last: number };

/**
 * The set an item belongs to. A peer's message: its sending device's id. A CI notice: its rule's
 * id, which `wim ci remove` never renumbers. A notice whose rule was removed while it was held is
 * a set of its own, so it is never decided along with notices a rule still allows.
 */
export function setKey(item: SetMember, rules: readonly CiRule[]): string {
  if (item.ci === undefined) return `device:${item.device}`;
  return rules.some((r) => r.id === item.ci!.rule) ? `ci:${item.ci.rule}` : `ci-removed:${item.id}`;
}

/** Held rows grouped into sets, each oldest first, the sets in the order their first item arrived. */
export function groupHeld<T extends SetMember>(rows: readonly T[], rules: readonly CiRule[]): Array<HeldSet<T>> {
  const sets = new Map<string, HeldSet<T>>();
  for (const row of [...rows].sort(byArrival)) {
    const key = setKey(row, rules);
    const set = sets.get(key) ?? { key, rows: [], ids: [], first: row.at, last: row.at };
    set.rows.push(row);
    if (!set.ids.includes(row.id)) set.ids.push(row.id);
    set.last = row.at;
    sets.set(key, set);
  }
  return [...sets.values()];
}

/** Oldest first; the id (a ULID) orders items that arrived in the same millisecond. */
function byArrival(a: SetMember, b: SetMember): number {
  return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The set holding `id`, or undefined when nothing by that id is held. */
export function setOf<T extends SetMember>(rows: readonly T[], rules: readonly CiRule[], id: string): HeldSet<T> | undefined {
  return groupHeld(rows, rules).find((s) => s.ids.includes(id));
}

/** Whether approving this item pins its rule's ids: it is approved only on its own (SPEC section 18). */
export function pinsIds(item: Pick<HeldItem, "ci">): boolean {
  return item.ci?.pins !== undefined;
}

/** The ids "approve all" covers: every id of the set but the notices that pin ids. */
export function approvableIds<T extends SetMember>(set: HeldSet<T>): string[] {
  return set.ids.filter((id) => !pinsIds(set.rows.find((r) => r.id === id)!));
}

/** What a set holds, on one line: "3 messages" or "1 CI notice". */
export function countText(set: HeldSet<SetMember>): string {
  const ci = set.rows[0]!.ci !== undefined;
  const n = set.ids.length;
  return `${n} ${ci ? "CI notice" : "message"}${n === 1 ? "" : "s"}`;
}

/** When a set's items arrived: one time, or the first and the last. */
export function spanText(set: HeldSet<SetMember>): string {
  const first = new Date(set.first).toISOString();
  return set.first === set.last ? `at ${first}` : `from ${first} to ${new Date(set.last).toISOString()}`;
}

/**
 * Who a set is from, for its heading. `from` is the address the client built from the roster
 * (session and device name); for a CI set the rule as `wim ci list` shows it.
 */
export function setTitle(row: SetMember & Pick<HeldItem, "from">, rules: readonly CiRule[]): string {
  if (row.ci === undefined) {
    const name = sanitizeForDisplay(row.from.slice(row.from.lastIndexOf("@") + 1));
    return `device ${name} (device id ${row.device})`;
  }
  const rule = rules.find((r) => r.id === row.ci!.rule);
  return rule === undefined ? "a CI rule removed while this notice was held" : `CI rule ${ruleLine(rule)}`;
}

/** A CI notice's provider, repository, ref, workflow, event and environment, as its job claimed them. */
export function ciText(entry: HeldItem["entry"]): string {
  const c = entry.ci!;
  const parts = [c.via, c.repo, c.ref];
  if (c.workflow !== undefined) parts.push(`workflow ${c.workflow}`);
  if (c.event !== undefined) parts.push(`event ${c.event}`);
  if (c.environment !== undefined) parts.push(`environment ${c.environment}`);
  return sanitizeForDisplay(parts.join(", ")).replace(/\s+/g, " ");
}

/**
 * The ids a pin-carrying notice would pin, as `key=value` pairs. They come from the CI job's claims,
 * so they are escaped like its other claims and kept to one line.
 */
export function pinText(pins: Record<string, string>): string {
  const text = Object.entries(pins)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return sanitizeForDisplay(text).replace(/\s+/g, " ");
}

/**
 * What a UI needs to draw an item inside its set: the set's key and who it is from, and for a CI
 * notice what its job claimed and, when approving it pins its rule's ids, those ids.
 */
export function setFields(item: SetMember & Pick<HeldItem, "from" | "entry">, rules: readonly CiRule[]): { set: string; set_title: string; ci?: string; pins?: string } {
  return {
    set: setKey(item, rules),
    set_title: setTitle(item, rules),
    ...(item.ci === undefined ? {} : { ci: ciText(item.entry) }),
    ...(item.ci?.pins === undefined ? {} : { pins: pinText(item.ci.pins) }),
  };
}
