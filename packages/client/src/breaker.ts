// The loop and cost breaker (design.md): two agents that wake each other can loop forever, and
// every wake costs tokens. Automatic deliveries are counted per sender device in a sliding hour;
// past a limit, or in a fast ping-pong of short messages, that peer is paused. The limits are
// mesh.json's `breaker` (BreakerLimits), read again for every delivery. Only devices the person
// trusts reach it (any other is held by policy first), and a trusted peer's pause is a cool-down
// that the client ends by itself, releasing at most the per-peer limit of what it held; a second
// trip within the hour of that release waits for the person (SECURITY-MODEL section 7.3).

import type { BreakerTier } from "./mesh.ts";

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
  at: number;
  /** When the pause ends. */
  until: number;
  /** True when the client releases the peer by itself at `until` (a trusted device's cool-down). */
  auto: boolean;
};

export type Admission = { ok: true } | { ok: false; reason: "paused" | TripRule; newly: boolean; pause: Pause };

/** What the breaker reads: the counting limits, and the cool-down when trips may end by themselves (the CI bucket has none). */
export type Limits = BreakerTier & { cooldownMinutes?: number };

/**
 * A pause bounded by the clock: one that ends more than an hour from now (a clock set back, a
 * damaged file) runs its own length from now, at most an hour. `at` is kept: it is what the items
 * held under the pause name it by.
 */
function bounded(p: Pause, now: number): Pause {
  if (p.until - now <= HOUR) return p;
  return { ...p, until: now + Math.min(Math.max(p.until - p.at, 0), HOUR) };
}

export class Breaker {
  private readonly deliveries = new Map<string, number[]>();
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
  private trips(peer: string, limits: Limits, now: number): { rule: TripRule; count: number; limit: number; minutes: number } | undefined {
    const since = now - HOUR;
    const mine = this.recent(this.deliveries.get(peer), since).length;
    if (mine >= limits.perPeerPerHour) return { rule: "peer", count: mine + 1, limit: limits.perPeerPerHour, minutes: 60 };
    let total = 0;
    for (const list of this.deliveries.values()) total += this.recent(list, since).length;
    if (total >= limits.totalPerHour) return { rule: "total", count: total + 1, limit: limits.totalPerHour, minutes: 60 };
    const n = limits.pingPong ? this.exchanges(peer) : 0;
    if (n > limits.pingPongExchanges) return { rule: "pingpong", count: n, limit: limits.pingPongExchanges, minutes: 10 };
    return undefined;
  }

  /**
   * Decides one automatic delivery from `peer`, and counts it when it goes through. `trusted`:
   * the person trusts the sender device, so a trip is a cool-down the client ends by itself
   * (when the limits have one), unless the peer was already released that way in the last hour.
   * A cool-down that ended but was not taken yet (takeDue) still holds: what comes meanwhile joins
   * what its release decides on.
   */
  admit(peer: string, length: number, trusted = false): Admission {
    const now = this.now();
    const held = this.paused.get(peer);
    const current = held === undefined ? undefined : bounded(held, now);
    if (current !== undefined && (current.until > now || current.auto)) {
      this.paused.set(peer, current);
      return { ok: false, reason: "paused", newly: false, pause: current };
    }
    if (current !== undefined) this.paused.delete(peer);

    this.push(peer, { at: now, dir: "in", short: length < SHORT });
    const limits = this.limits();
    const tripped = this.trips(peer, limits, now);
    if (tripped !== undefined) {
      const last = this.released.get(peer);
      const auto = trusted && limits.cooldownMinutes !== undefined && (last === undefined || now - last >= HOUR);
      const until = now + (auto ? limits.cooldownMinutes! * MINUTE : HOUR);
      const pause: Pause = { peer, ...tripped, at: now, until, auto };
      this.paused.set(peer, pause);
      return { ok: false, reason: tripped.rule, newly: true, pause };
    }
    this.count(peer, 1);
    return { ok: true };
  }

  /** Counts `n` deliveries from `peer` now: what a cool-down's release delivers counts as delivered. */
  count(peer: string, n: number): void {
    const now = this.now();
    const mine = this.recent(this.deliveries.get(peer), now - HOUR);
    for (let i = 0; i < n; i++) mine.push(now);
    this.deliveries.set(peer, mine);
  }

  /** Takes back a pause an earlier process of the session wrote (pauses.ts), bounded by the clock. */
  restore(p: Pause): void {
    this.paused.set(p.peer, bounded(p, this.now()));
  }

  /** Takes back when an earlier process released `peer` by itself, so a second trip within the hour still waits for the person. */
  restoreRelease(peer: string, at: number): void {
    if (this.now() - at < HOUR) this.released.set(peer, Math.min(at, this.now()));
  }

  /** The automatic releases of the last hour, by peer, for a later process of the session. */
  releases(): Record<string, number> {
    const now = this.now();
    return Object.fromEntries([...this.released].filter(([, at]) => now - at < HOUR));
  }

  /** The pauses still running, oldest first. */
  pauses(): Pause[] {
    const now = this.now();
    return [...this.paused.values()].filter((p) => p.until > now).sort((a, b) => a.at - b.at);
  }

  /**
   * The pauses a later process of the session must take back, oldest first: the running ones, and
   * a trusted peer's whose cool-down ended but whose release has not run yet (takeDue).
   */
  kept(): Pause[] {
    const now = this.now();
    return [...this.paused.values()].filter((p) => p.until > now || p.auto).sort((a, b) => a.at - b.at);
  }

  /**
   * The trusted peers whose cool-down has ended, each lifted here (its counts start over) so two
   * callers never release one twice. The caller delivers what each one held, and counts it.
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
export function pauseRule(peer: string, p: Pick<Pause, "rule" | "count" | "limit" | "minutes">): string {
  if (p.rule === "peer") return `the per-peer limit: ${p.count} messages from ${peer} in ${p.minutes} minutes, limit ${p.limit}`;
  if (p.rule === "total") return `the total limit: ${p.count} messages from all peers in ${p.minutes} minutes, limit ${p.limit}`;
  return `the ping-pong rule: ${p.count} alternating short messages with ${peer} in ${p.minutes} minutes, limit ${p.limit}`;
}

/** How the pause ends, for both notices and the held list. */
export function pauseEnd(p: Pick<Pause, "until" | "auto">): string {
  return p.auto
    ? `until ${clock(p.until)}, when the client releases it and delivers up to its per-peer limit of what it held (a trusted device's cool-down)`
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
    ? `The client releases ${peer} by itself at ${clock(p.until)} and delivers up to its per-peer limit of what it held then; the rest waits for your person, who can release it earlier.`
    : `The pause lifts at ${clock(p.until)}; what was held stays held until the person decides.`;
  return (
    `this device's loop breaker paused ${peer} (${pauseRule(peer, p)}): its messages to this session are held from now on, not delivered to you, until ${p.auto ? "the cool-down ends or " : ""}your person releases them. ` +
    `Only the person can release them early: \`wim held resume ${peer}\` in a terminal they opened themselves, or Approve in /wim (Claude Code) or the Held view (VS Code). ` +
    `${after} If you are waiting on ${peer}, tell your person; it has not gone silent.`
  );
}

/** Why a release left some of what it held for the person. */
export type KeptWhy = "limit" | "untrusted";

/** The notice for the session when a trusted peer's cool-down ends and the client released it. */
export function releasedNotice(peer: string, p: Pause, released: number, kept: number, why: KeptWhy): string {
  const n = (k: number): string => `${k} message${k === 1 ? "" : "s"}`;
  const delivered = released === 0 ? "nothing it held is delivered" : `${n(released)} it held ${released === 1 ? "is" : "are"} delivered now`;
  const rest =
    kept === 0
      ? ""
      : why === "untrusted"
        ? `; its device is no longer trusted here or no longer in the mesh, so the ${n(kept)} it held ${kept === 1 ? "stays" : "stay"} held for the person`
        : `; ${n(kept)} more ${kept === 1 ? "stays" : "stay"} held for the person (a release delivers at most the per-peer limit)`;
  return `the loop breaker's cool-down for ${peer} ended at ${clock(p.until)} (it tripped on ${pauseRule(peer, p)}): its messages are delivered again, and ${delivered}${rest}. If it trips again within the hour, it waits for your person.`;
}
