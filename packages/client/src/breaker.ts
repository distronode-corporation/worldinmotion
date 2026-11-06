// The loop and cost breaker (design.md): two agents that wake each other can loop forever, and
// every wake costs tokens. Automatic deliveries are counted per sender device in a sliding hour;
// past a limit, or in a fast ping-pong of short messages, that peer is paused. The limits are
// mesh.json's `breaker` (BreakerLimits), read again for every delivery, and depend on whether the
// person trusts the sender device: a trusted peer's pause is a cool-down that the client ends by
// itself, an untrusted peer's lasts the hour and what it held waits for the person
// (SECURITY-MODEL section 7.3).

import type { BreakerTier, TrustedTier } from "./mesh.ts";

const HOUR = 3600_000;
const MINUTE = 60_000;
const PING_WINDOW = 10 * MINUTE;
const SHORT = 200;

type Event = { at: number; dir: "in" | "out"; short: boolean };

export type TripRule = "peer" | "total" | "pingpong";

/** One pause, with what tripped it: the rule, what it counted, its limit and the window it counts over. */
export type Pause = {
  /** The sender device id. */
  peer: string;
  rule: TripRule;
  count: number;
  limit: number;
  /** The window the rule counts over: 60 minutes, or 10 for ping-pong. */
  minutes: number;
  /** Whether the person trusts the device: its tier's limits, and a cool-down. */
  trusted: boolean;
  at: number;
  /** When the pause ends. */
  until: number;
  /** True when the client releases the peer by itself at `until` (a trusted peer's cool-down). */
  auto: boolean;
};

export type Admission = { ok: true } | { ok: false; reason: "paused" | TripRule; newly: boolean; pause: Pause };

/** What the breaker reads: one tier, and optionally the trusted one (the CI bucket has no trust). */
export type Limits = BreakerTier & { trusted?: TrustedTier };

export class Breaker {
  private readonly deliveries = new Map<string, number[]>();
  /** Each counted peer's tier when it last delivered, so a total counts one tier. */
  private readonly tierOf = new Map<string, boolean>();
  private readonly talk = new Map<string, Event[]>();
  private readonly paused = new Map<string, Pause>();
  /** When the client last released each trusted peer by itself. */
  private readonly released = new Map<string, number>();

  private readonly limits: () => Limits;
  private readonly now: () => number;

  constructor(limits: () => Limits, now: () => number) {
    this.limits = limits;
    this.now = now;
  }

  private recent(list: number[] | undefined, since: number): number[] {
    return (list ?? []).filter((t) => t > since);
  }

  /** Notes a message this session sent to a session address, for the ping-pong detector. */
  noteSent(peer: string, length: number): void {
    this.push(peer, { at: this.now(), dir: "out", short: length < SHORT });
  }

  private push(peer: string, e: Event): void {
    const list = (this.talk.get(peer) ?? []).filter((x) => x.at > e.at - PING_WINDOW);
    list.push(e);
    this.talk.set(peer, list);
  }

  /** Alternating exchanges in the last 10 minutes, counted back from the newest, all short. */
  private exchanges(peer: string): number {
    // `admit` always records the newest event before asking.
    const list = this.talk.get(peer)!;
    let n = 0;
    for (let i = list.length - 1; i > 0; i--) {
      const a = list[i]!;
      const b = list[i - 1]!;
      if (!a.short || !b.short || a.dir === b.dir) break;
      n++;
    }
    return n;
  }

  /** Which rule a delivery from `peer` would trip, with what it counted, or undefined. */
  private trips(peer: string, tier: BreakerTier, trusted: boolean, now: number): { rule: TripRule; count: number; limit: number; minutes: number } | undefined {
    const since = now - HOUR;
    const mine = this.recent(this.deliveries.get(peer), since).length;
    if (mine >= tier.perPeerPerHour) return { rule: "peer", count: mine + 1, limit: tier.perPeerPerHour, minutes: 60 };
    let total = 0;
    for (const [p, list] of this.deliveries) if (this.tierOf.get(p) === trusted) total += this.recent(list, since).length;
    if (total >= tier.totalPerHour) return { rule: "total", count: total + 1, limit: tier.totalPerHour, minutes: 60 };
    const n = tier.pingPong ? this.exchanges(peer) : 0;
    if (n > tier.pingPongExchanges) return { rule: "pingpong", count: n, limit: tier.pingPongExchanges, minutes: 10 };
    return undefined;
  }

  /**
   * Decides one automatic delivery from `peer`, and counts it when it goes through. `trusted`:
   * the person trusts the sender device, so its tier's limits apply and a trip is a cool-down
   * the client ends by itself, unless the peer was already released that way in the last hour.
   */
  admit(peer: string, length: number, trusted = false): Admission {
    const now = this.now();
    const current = this.paused.get(peer);
    if (current !== undefined && current.until > now) return { ok: false, reason: "paused", newly: false, pause: current };
    if (current !== undefined) this.paused.delete(peer);

    this.push(peer, { at: now, dir: "in", short: length < SHORT });
    const limits = this.limits();
    const tier = trusted && limits.trusted !== undefined ? limits.trusted : limits;
    const isTrusted = tier !== limits;
    const tripped = this.trips(peer, tier, isTrusted, now);
    if (tripped !== undefined) {
      const last = this.released.get(peer);
      const auto = isTrusted && (last === undefined || now - last >= HOUR);
      const until = now + (auto ? limits.trusted!.cooldownMinutes * MINUTE : HOUR);
      const pause: Pause = { peer, ...tripped, trusted: isTrusted, at: now, until, auto };
      this.paused.set(peer, pause);
      return { ok: false, reason: tripped.rule, newly: true, pause };
    }
    const mine = this.recent(this.deliveries.get(peer), now - HOUR);
    mine.push(now);
    this.deliveries.set(peer, mine);
    this.tierOf.set(peer, isTrusted);
    return { ok: true };
  }

  /** Takes back a pause an earlier process of the session wrote (pauses.ts): its end and its release hold. */
  restore(p: Pause): void {
    this.paused.set(p.peer, p);
  }

  /** The pauses still running, oldest first. */
  pauses(): Pause[] {
    const now = this.now();
    return [...this.paused.values()].filter((p) => p.until > now).sort((a, b) => a.at - b.at);
  }

  /**
   * The trusted peers whose cool-down has ended, each lifted here (its counts start over) so two
   * callers never release one twice. The caller delivers what each one held.
   */
  takeDue(): Pause[] {
    const now = this.now();
    const due = [...this.paused.values()].filter((p) => p.auto && p.until <= now);
    for (const p of due) {
      this.clear(p.peer);
      this.released.set(p.peer, now);
    }
    return due;
  }

  private clear(peer: string): void {
    this.paused.delete(peer);
    this.deliveries.delete(peer);
    this.tierOf.delete(peer);
    this.talk.delete(peer);
  }

  /** The person resumed a peer: its pause and its counts start over, and so does its cool-down allowance. */
  resume(peer: string): void {
    this.clear(peer);
    this.released.delete(peer);
  }
}

/** A time as the person reads it: UTC, to the second. */
export function clock(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The rule that tripped, with its numbers ("the per-peer limit: 121 messages from a@x in 60 minutes, limit 120"). */
export function pauseRule(peer: string, p: Pick<Pause, "rule" | "count" | "limit" | "minutes"> & { trusted?: boolean }): string {
  if (p.rule === "peer") return `the per-peer limit: ${p.count} messages from ${peer} in ${p.minutes} minutes, limit ${p.limit}`;
  const tier = p.trusted === undefined ? "" : p.trusted ? "trusted " : "untrusted ";
  if (p.rule === "total") return `the total limit: ${p.count} messages from all ${tier}peers in ${p.minutes} minutes, limit ${p.limit}`;
  return `the ping-pong rule: ${p.count} alternating short messages with ${peer} in ${p.minutes} minutes, limit ${p.limit}`;
}

/** How the pause ends, for both notices and the held list. */
export function pauseEnd(p: Pick<Pause, "until" | "auto">): string {
  return p.auto
    ? `until ${clock(p.until)}, when the client releases it and delivers what it held (a trusted device's cool-down)`
    : `until ${clock(p.until)}; what it held waits for the person`;
}

/** The notice a pause raises, for the person (design.md wording). */
export function pauseNotice(peer: string, p: Pause): string {
  return `worldinmotion paused ${peer}: ${pauseRule(peer, p)}; ${pauseEnd(p)}. /wim to approve, or to approve and resume it now`;
}

/**
 * The notice a pause raises for the session itself, once per pause: without it the agent sees a
 * peer go quiet and draws the wrong conclusion (issue #40). It names what only the person can run;
 * no tool the agent can call releases a held message.
 */
export function pauseNoticeForAgent(peer: string, p: Pause): string {
  const after = p.auto
    ? `The client releases ${peer} by itself at ${clock(p.until)} and delivers what it held then; your person can release it earlier.`
    : `The pause lifts at ${clock(p.until)}; what was held stays held until the person decides.`;
  return (
    `this device's loop breaker paused ${peer} (${pauseRule(peer, p)}): its messages to this session are held from now on, not delivered to you, until ${p.auto ? "the cool-down ends or " : ""}your person releases them. ` +
    `Only the person can release them early: \`wim held resume ${peer}\` in a terminal they opened themselves, or Approve in /wim (Claude Code) or the Held view (VS Code). ` +
    `${after} If you are waiting on ${peer}, tell your person; it has not gone silent.`
  );
}

/** The notice for the session when a trusted peer's cool-down ends and the client released it. */
export function releasedNotice(peer: string, p: Pause, released: number, kept: number): string {
  const what =
    kept > 0
      ? `its device is no longer trusted here, so the ${kept} message${kept === 1 ? "" : "s"} it held stay${kept === 1 ? "s" : ""} held for the person`
      : `the ${released} message${released === 1 ? "" : "s"} it held ${released === 1 ? "is" : "are"} delivered now`;
  return `the loop breaker's cool-down for ${peer} ended at ${clock(p.until)} (it tripped on ${pauseRule(peer, p)}): its messages are delivered again, and ${what}. If it trips again within the hour, it waits for your person.`;
}
