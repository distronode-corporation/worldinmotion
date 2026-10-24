// The loop and cost breaker (design.md): two agents that wake each other can loop forever, and
// every wake costs tokens. Automatic deliveries are counted per sender address in a sliding hour;
// past a limit, or in a fast ping-pong of short messages, that peer is paused for the person.

import type { BreakerLimits } from "./mesh.ts";

const HOUR = 3600_000;
const PING_WINDOW = 10 * 60_000;
const PING_EXCHANGES = 8;
const SHORT = 200;

type Event = { at: number; dir: "in" | "out"; short: boolean };

export type Admission = { ok: true } | { ok: false; reason: "paused" | "peer" | "total" | "pingpong"; newly: boolean };

export class Breaker {
  private readonly deliveries = new Map<string, number[]>();
  private readonly talk = new Map<string, Event[]>();
  private readonly pausedUntil = new Map<string, number>();

  private readonly limits: () => BreakerLimits;
  private readonly now: () => number;

  constructor(limits: () => BreakerLimits, now: () => number) {
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

  /** Decides one automatic delivery from `peer`, and counts it when it goes through. */
  admit(peer: string, length: number): Admission {
    const now = this.now();
    const until = this.pausedUntil.get(peer);
    if (until !== undefined && until > now) return { ok: false, reason: "paused", newly: false };
    if (until !== undefined) this.pausedUntil.delete(peer);

    this.push(peer, { at: now, dir: "in", short: length < SHORT });
    const limits = this.limits();
    const since = now - HOUR;
    const mine = this.recent(this.deliveries.get(peer), since);
    let total = 0;
    for (const list of this.deliveries.values()) total += this.recent(list, since).length;
    let reason: "peer" | "total" | "pingpong" | undefined;
    if (mine.length >= limits.perPeerPerHour) reason = "peer";
    else if (total >= limits.totalPerHour) reason = "total";
    else if (limits.pingPong && this.exchanges(peer) > PING_EXCHANGES) reason = "pingpong";
    if (reason !== undefined) {
      this.pausedUntil.set(peer, now + HOUR);
      return { ok: false, reason, newly: true };
    }
    mine.push(now);
    this.deliveries.set(peer, mine);
    return { ok: true };
  }

  /** The person resumed a peer: its pause and its counts start over. */
  resume(peer: string): void {
    this.pausedUntil.delete(peer);
    this.deliveries.delete(peer);
    this.talk.delete(peer);
  }
}

/** The notice a pause raises, for the person (design.md wording). */
export function pauseNotice(peer: string, reason: "peer" | "total" | "pingpong", limits: BreakerLimits): string {
  const why =
    reason === "peer"
      ? `${limits.perPeerPerHour} messages in an hour`
      : reason === "total"
        ? `${limits.totalPerHour} messages in an hour from all peers`
        : "a fast exchange of short messages";
  return `worldinmotion paused ${peer}: ${why}; /wim to resume`;
}
