import type { z } from "zod";
import { CiHttpError, type HttpClient } from "./http.ts";
import { KEEP_MS, type SourceState } from "./state.ts";

/** Anything updated within this window counts as recent on a first run. */
export const RECENT_MS = 3_600_000;

/**
 * How a first sighting is handled. `announce` posts lines and fetches the details they need;
 * `record` fetches what later polls compare against but posts nothing; `skip` stores the phase
 * alone, for things old enough to have settled.
 */
export type Mode = "announce" | "record" | "skip";

export interface WatcherContext {
  http: HttpClient;
  state: SourceState;
  /** Posts one line into the source's room. */
  post: (text: string) => Promise<void>;
  now: () => number;
  announceOnStart: boolean;
}

/** One watched project: a poll compares the provider's view with the state and posts the changes. */
export interface Watcher {
  /** `gitlab group/project` or `github owner/repo`, the prefix of every line. */
  readonly name: string;
  readonly http: HttpClient;
  poll(): Promise<void>;
}

/** Validates a response body, naming the URL (never the body) when it does not fit. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown, url: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new CiHttpError(`GET ${url} returned an unexpected shape`);
  return parsed.data;
}

/** Picks the mode for something seen in this poll. */
export function modeFor(ctx: WatcherContext, updatedAt: string): Mode {
  if (ctx.state.seeded) return "announce";
  if (ctx.now() - Date.parse(updatedAt) >= RECENT_MS) return "skip";
  return ctx.announceOnStart ? "announce" : "record";
}

/** Older than the state keeps, so it may already have been forgotten: never announce it. */
export function tooOld(ctx: WatcherContext, timestamp: string): boolean {
  return ctx.now() - Date.parse(timestamp) > KEEP_MS;
}
