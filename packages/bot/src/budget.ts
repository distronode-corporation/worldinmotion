import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { ChatUsage } from "./model.ts";

export interface Price {
  /** USD per million input tokens. */
  inputPerMillion: number;
  /** USD per million output tokens. */
  outputPerMillion: number;
}

export interface BudgetOptions {
  /** Where the ledger lives; written atomically (temp file, then rename). */
  path: string;
  /** The model this bot calls; its price-table key. */
  modelId: string;
  dailyTokens?: number;
  dailyUsd?: number;
  prices: Record<string, Price>;
  now: () => number;
}

export interface DayTotals {
  inputTokens: number;
  outputTokens: number;
  usd: number;
  /** Senders already told "budget exhausted" today, so each is told once. */
  notified: string[];
}

/** An amount held back while a call is in flight, so concurrent calls cannot overspend together. */
export interface Reservation {
  readonly usage: ChatUsage;
}

const Ledger = z.object({
  v: z.literal(1),
  days: z.record(
    z.string(),
    z.object({
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
      usd: z.number().nonnegative(),
      notified: z.array(z.string()),
    }),
  ),
});
type Ledger = z.infer<typeof Ledger>;

/** Days older than this are dropped when the ledger is written, so the file stays small. */
const KEEP_DAYS = 31;
const DAY_MS = 86_400_000;

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A rough input estimate before the provider's real count is known: 4 ASCII characters per
 * token, and a token for every other code point. Dividing all text by 4 under-reserves CJK
 * and emoji, which tokenizers split into about one token (or more) per character; erring high
 * is the safe side, because the ledger is corrected to the real count on success.
 */
export function estimateTokens(...texts: string[]): number {
  let ascii = 0;
  let other = 0;
  for (const text of texts) {
    for (const ch of text) {
      if (ch.charCodeAt(0) < 0x80) ascii += 1;
      else other += 1;
    }
  }
  return Math.ceil(ascii / 4) + other;
}

export class Budget {
  private readonly options: BudgetOptions;
  private readonly price: Price | undefined;
  private readonly ledger: Ledger;
  private readonly pending = new Set<Reservation>();
  private writing: Promise<void> = Promise.resolve();

  private constructor(options: BudgetOptions, ledger: Ledger) {
    this.options = options;
    this.price = options.prices[options.modelId];
    this.ledger = ledger;
  }

  /**
   * Loads the ledger. A missing file is a fresh ledger; an unreadable or invalid one stops the
   * bot, because silently starting from zero would reset today's spend.
   */
  static async open(options: BudgetOptions): Promise<Budget> {
    if (options.dailyUsd !== undefined && options.prices[options.modelId] === undefined) {
      throw new Error(`no price for ${options.modelId}, but a daily USD cap is set`);
    }
    let raw: string | undefined;
    try {
      raw = await readFile(options.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (raw === undefined) return new Budget(options, { v: 1, days: {} });
    let parsed: ReturnType<typeof Ledger.safeParse>;
    try {
      parsed = Ledger.safeParse(JSON.parse(raw));
    } catch {
      throw new Error(`ledger ${options.path} is not JSON; refusing to start`);
    }
    if (!parsed.success) throw new Error(`ledger ${options.path} is not valid; refusing to start`);
    return new Budget(options, parsed.data);
  }

  /** Today's totals (UTC), not counting calls still in flight. */
  today(): DayTotals {
    const day = this.ledger.days[utcDay(this.options.now())];
    return day ?? { inputTokens: 0, outputTokens: 0, usd: 0, notified: [] };
  }

  cost(usage: ChatUsage): number {
    if (this.price === undefined) return 0;
    return (
      (usage.inputTokens * this.price.inputPerMillion +
        usage.outputTokens * this.price.outputPerMillion) /
      1_000_000
    );
  }

  /** True when today's spend, the calls in flight and this estimate all fit under both caps. */
  canSpend(estimate: ChatUsage): boolean {
    const t = this.today();
    let tokens = t.inputTokens + t.outputTokens + estimate.inputTokens + estimate.outputTokens;
    let usd = t.usd + this.cost(estimate);
    for (const r of this.pending) {
      tokens += r.usage.inputTokens + r.usage.outputTokens;
      usd += this.cost(r.usage);
    }
    const { dailyTokens, dailyUsd } = this.options;
    if (dailyTokens !== undefined && tokens > dailyTokens) return false;
    if (dailyUsd !== undefined && usd > dailyUsd) return false;
    return true;
  }

  reserve(estimate: ChatUsage): Reservation | null {
    if (!this.canSpend(estimate)) return null;
    const r: Reservation = { usage: estimate };
    this.pending.add(r);
    return r;
  }

  /** Releases the hold and charges what the call really used. */
  settle(reservation: Reservation, usage: ChatUsage): Promise<void> {
    this.pending.delete(reservation);
    return this.record(usage);
  }

  record(usage: ChatUsage): Promise<void> {
    const day = this.day();
    day.inputTokens += usage.inputTokens;
    day.outputTokens += usage.outputTokens;
    day.usd += this.cost(usage);
    return this.persist();
  }

  /** True the first time a sender is told today; the bot stays silent after that. */
  async markNotified(sender: string): Promise<boolean> {
    const day = this.day();
    if (day.notified.includes(sender)) return false;
    day.notified.push(sender);
    await this.persist();
    return true;
  }

  private day(): DayTotals {
    const key = utcDay(this.options.now());
    let day = this.ledger.days[key];
    if (day === undefined) {
      day = { inputTokens: 0, outputTokens: 0, usd: 0, notified: [] };
      this.ledger.days[key] = day;
    }
    return day;
  }

  /** Writes are chained so an older snapshot can never be renamed over a newer one. */
  private persist(): Promise<void> {
    const next = this.writing.then(() => this.write());
    this.writing = next.catch(() => undefined);
    return next;
  }

  private async write(): Promise<void> {
    const oldest = utcDay(this.options.now() - KEEP_DAYS * DAY_MS);
    for (const key of Object.keys(this.ledger.days)) {
      if (key < oldest) delete this.ledger.days[key];
    }
    const path = this.options.path;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.ledger, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
  }
}
