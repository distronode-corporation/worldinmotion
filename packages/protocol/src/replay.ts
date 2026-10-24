import { fail, LIMITS, ok, type Result } from "./limits.ts";

/**
 * A receiver's clock check on a message's `at` (SPEC section 6). Reasons: `too_old` (more than 47
 * hours before `now`) and `too_new` (more than 10 minutes after it).
 */
export function checkFreshness(at: number, now: number): Result {
  if (at < now - LIMITS.messageMaxAgeMs) return fail("too_old");
  if (at > now + LIMITS.messageMaxFutureMs) return fail("too_new");
  return ok(true);
}

/** When a receiver may forget an accepted message id: `at` + 48 hours + 10 minutes. */
export function dedupeExpiry(at: number): number {
  return at + LIMITS.dedupeRetentionMs;
}

export type SeqObservation = "ok" | "dup";

/** Persisted form of a `SeqTracker`: `[deviceId, sid, highest seq]` rows. */
export type SeqTrackerJSON = { v: 1; entries: Array<[string, string, number]> };

/**
 * Tracks the highest `seq` seen per sender (device id, session sid) for one receiving address.
 * A message at or below the highest is a duplicate or replay. A jump is not reported: one
 * session's seq counts its messages to every recipient, so a jump is normal. Pure and synchronous;
 * persist it with `toJSON` and `fromJSON`.
 */
export class SeqTracker {
  #highest = new Map<string, { device: string; sid: string; seq: number }>();

  #key(device: string, sid: string): string {
    if (typeof device !== "string" || typeof sid !== "string") throw new TypeError("SeqTracker: device and sid are strings");
    return JSON.stringify([device, sid]);
  }

  observe(device: string, sid: string, seq: number): SeqObservation {
    const key = this.#key(device, sid);
    if (!Number.isSafeInteger(seq) || seq < 1) throw new RangeError("SeqTracker: seq must be a positive integer");
    const last = this.#highest.get(key)?.seq ?? 0;
    if (seq <= last) return "dup";
    this.#highest.set(key, { device, sid, seq });
    return "ok";
  }

  /** The highest seq seen for a sender session, or 0. */
  highest(device: string, sid: string): number {
    return this.#highest.get(this.#key(device, sid))?.seq ?? 0;
  }

  toJSON(): SeqTrackerJSON {
    return { v: 1, entries: [...this.#highest.values()].map((e) => [e.device, e.sid, e.seq]) };
  }

  static fromJSON(json: unknown): SeqTracker {
    const data = json as Partial<SeqTrackerJSON> | null;
    if (typeof data !== "object" || data === null || data.v !== 1 || !Array.isArray(data.entries)) {
      throw new TypeError("SeqTracker.fromJSON: not a tracker");
    }
    const tracker = new SeqTracker();
    for (const row of data.entries) {
      if (!Array.isArray(row) || row.length !== 3) throw new TypeError("SeqTracker.fromJSON: bad row");
      const [device, sid, seq] = row;
      tracker.observe(device, sid, seq);
    }
    return tracker;
  }
}
