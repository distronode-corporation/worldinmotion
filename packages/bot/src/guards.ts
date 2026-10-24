import { createHash } from "node:crypto";

export interface GuardOptions {
  /** Bots answering bots is how a mesh burns a budget overnight; off unless chosen. */
  replyToBots: boolean;
  perPeerPerHour: number;
  now: () => number;
}

export type Verdict =
  | { ok: true }
  | { ok: false; reason: "bot" | "too_long" | "duplicate" | "rate" };

/** Texts above this are refused before any model call. */
export const MAX_TEXT_BYTES = 32 * 1024;
const DUPLICATE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Loop and abuse checks run on every inbound `msg` and `task` before it can cost anything. */
export class Guards {
  private readonly options: GuardOptions;
  private readonly replies = new Map<string, number[]>();
  private readonly recent = new Map<string, number>();

  constructor(options: GuardOptions) {
    this.options = options;
  }

  /** Decides whether to answer, and counts an answer against the sender's hourly allowance. */
  admit(item: { from: string; fromKind: string; text: string }): Verdict {
    const now = this.options.now();
    if (item.fromKind === "bot" && !this.options.replyToBots) return { ok: false, reason: "bot" };
    if (Buffer.byteLength(item.text, "utf8") > MAX_TEXT_BYTES) {
      return { ok: false, reason: "too_long" };
    }

    for (const [key, at] of this.recent) {
      if (now - at >= DUPLICATE_MS) this.recent.delete(key);
    }
    const key = `${item.from}\n${createHash("sha256").update(item.text).digest("hex")}`;
    if (this.recent.has(key)) return { ok: false, reason: "duplicate" };
    this.recent.set(key, now);

    const times = (this.replies.get(item.from) ?? []).filter((t) => now - t < HOUR_MS);
    if (times.length >= this.options.perPeerPerHour) {
      this.replies.set(item.from, times);
      return { ok: false, reason: "rate" };
    }
    times.push(now);
    this.replies.set(item.from, times);
    return { ok: true };
  }
}

/** A counting semaphore with a bounded queue: `maxConcurrent` model calls, the rest wait. */
export class Gate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;

  constructor(maxConcurrent: number, maxQueue: number) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueue = maxQueue;
  }

  /** Resolves when a slot is free, or returns null when the queue is already full. */
  enter(): Promise<void> | null {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.maxQueue) return null;
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** Hands the slot straight to the next waiter, so `active` only drops when nobody waits. */
  leave(): void {
    const next = this.waiting.shift();
    if (next === undefined) this.active--;
    else next();
  }

  get queued(): number {
    return this.waiting.length;
  }

  get running(): number {
    return this.active;
  }
}
