// The worker's own limits: attempts per sender device per hour, and jobs per UTC day.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const HOUR_MS = 3_600_000;

/** Attempts per key in any rolling hour. */
export class RateLimit {
  private readonly seen = new Map<string, number[]>();
  private readonly perHour: number;
  private readonly now: () => number;

  constructor(perHour: number, now: () => number) {
    this.perHour = perHour;
    this.now = now;
  }

  /** Counts an attempt and says whether it is within the limit. */
  take(key: string): boolean {
    const now = this.now();
    for (const [k, times] of this.seen) {
      if (times.every((t) => now - t >= HOUR_MS)) this.seen.delete(k);
    }
    const times = (this.seen.get(key) ?? []).filter((t) => now - t < HOUR_MS);
    if (times.length >= this.perHour) {
      this.seen.set(key, times);
      return false;
    }
    times.push(now);
    this.seen.set(key, times);
    return true;
  }
}

/** `YYYY-MM-DD` in UTC. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Jobs started per UTC day, on disk so a restart does not reset the cap. A job is counted before
 * it starts: one that fails or times out still used the allowance, and one the runner refused or
 * was busy for (so no job ran) is given back. A file that cannot be read as a ledger counts as the
 * cap reached for today, so a corrupt file never lifts the limit.
 */
export class DailyLedger {
  private readonly path: string;
  private readonly cap: number;
  private readonly now: () => number;
  private day: string;
  private jobs: number;

  private constructor(path: string, cap: number, now: () => number, day: string, jobs: number) {
    this.path = path;
    this.cap = cap;
    this.now = now;
    this.day = day;
    this.jobs = jobs;
  }

  static async open(path: string, cap: number, now: () => number): Promise<DailyLedger> {
    let raw: string | undefined;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const today = utcDay(now());
    if (raw === undefined) return new DailyLedger(path, cap, now, today, 0);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
    const v = value as { day?: unknown; jobs?: unknown } | undefined;
    if (typeof v?.day !== "string" || typeof v.jobs !== "number" || !Number.isInteger(v.jobs) || v.jobs < 0) {
      return new DailyLedger(path, cap, now, today, cap);
    }
    return new DailyLedger(path, cap, now, v.day, v.jobs);
  }

  /** Today's count so far. */
  get used(): number {
    return this.day === utcDay(this.now()) ? this.jobs : 0;
  }

  /** Counts one job if today's cap allows it, and writes the ledger before saying yes. */
  async take(): Promise<boolean> {
    const today = utcDay(this.now());
    if (this.day !== today) {
      this.day = today;
      this.jobs = 0;
    }
    if (this.jobs >= this.cap) return false;
    this.jobs++;
    await this.save();
    return true;
  }

  /**
   * Gives back the job the last `take` counted, when the runner ran none: it refused the request
   * (a wrong wake code, a profile or sender it does not take) or was busy (#134). A job is taken
   * and given back within one run, and one runs at a time, so this is that job's day.
   */
  async giveBack(): Promise<void> {
    this.jobs--;
    await this.save();
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ day: this.day, jobs: this.jobs })}\n`, { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
