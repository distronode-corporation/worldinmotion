import { setTimeout as delay } from "node:timers/promises";
import { sourceKey, type CiConfig, type SourceConfig } from "./config.ts";
import { formatDuration } from "./format.ts";
import { GitHubWatcher } from "./github.ts";
import { GitLabWatcher } from "./gitlab.ts";
import { CiHttpError, HttpClient, type RateInfo } from "./http.ts";
import { StateStore } from "./state.ts";
import type { Watcher } from "./watcher.ts";

/** Where `wim ci` writes: the mesh connection in production, a recorder in tests. */
export interface CiIO {
  post(room: string, text: string): Promise<void>;
  log(line: string): void;
}

export interface CiDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** Waits between polls; must return early when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** For backoff jitter, in [0, 1). */
  random?: () => number;
  /** Where token variables are read from. */
  env?: Record<string, string | undefined>;
  /** Stops the watcher; `runCi` resolves once every source has stopped. */
  signal?: AbortSignal;
  requestTimeoutMs?: number;
}

export const REQUEST_TIMEOUT_MS = 20_000;
/** The longest a source backs off after repeated errors. */
export const MAX_BACKOFF_MS = 15 * 60_000;
/** The longest any single wait may be, whatever a server asks for. */
export const MAX_WAIT_MS = 60 * 60_000;

/** An abortable sleep that resolves (rather than rejects) when stopped. */
export async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  await delay(ms, undefined, { signal }).catch(() => undefined);
}

/** Replaces every occurrence of each secret, so no token can reach a room or a log. */
export function redactor(secrets: string[]): (text: string) => string {
  const live = secrets.filter((s) => s !== "");
  return (text) => live.reduce((t, s) => t.split(s).join("[redacted]"), text);
}

/** The wait after a good poll: the interval, stretched when the rate limit runs low. */
export function pace(intervalMs: number, rate: RateInfo, now: number): number {
  if (rate.remaining === undefined) return intervalMs;
  if (rate.remaining === 0 && rate.resetAt !== undefined) {
    return Math.min(MAX_WAIT_MS, Math.max(intervalMs, rate.resetAt - now));
  }
  const low = rate.limit === undefined ? 10 : rate.limit * 0.1;
  return rate.remaining < low ? intervalMs * 4 : intervalMs;
}

/** Exponential backoff with jitter, never shorter than what the server asked for. */
export function backoff(intervalMs: number, failures: number, retryAfterMs: number | undefined, random: () => number): number {
  const exp = Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** failures);
  const jittered = exp / 2 + random() * (exp / 2);
  return Math.min(MAX_WAIT_MS, Math.max(jittered, retryAfterMs ?? 0));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function authHeaders(source: SourceConfig, token: string | undefined): Record<string, string> {
  if (source.type === "gitlab") return token === undefined ? {} : { "PRIVATE-TOKEN": token };
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "worldinmotion-ci",
  };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Watches every configured source until `deps.signal` aborts, posting state changes into each
 * source's room. Each source polls on its own schedule and backs off on its own errors.
 */
export async function runCi(config: CiConfig, io: CiIO, deps: CiDeps = {}): Promise<void> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const env = deps.env ?? process.env;
  const signal = deps.signal ?? new AbortController().signal;
  const intervalMs = config.intervalSeconds * 1000;

  const tokens = config.sources.map((s) => env[s.tokenEnv] || undefined);
  const redact = redactor(tokens.filter((t) => t !== undefined));
  const log = (line: string): void => io.log(redact(line));
  const state = await StateStore.open(config.statePath, now, log);

  const watchers: Watcher[] = config.sources.map((source, i) => {
    const token = tokens[i];
    const http = new HttpClient({
      fetch: deps.fetch ?? fetch,
      headers: authHeaders(source, token),
      timeoutMs: deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      now,
      signal,
      etag: source.type === "github",
    });
    const ctx = {
      http,
      state: state.source(sourceKey(source)),
      post: (text: string) => io.post(source.room, redact(text)),
      now,
      announceOnStart: config.announceOnStart,
    };
    const watcher = source.type === "gitlab" ? new GitLabWatcher(source, ctx) : new GitHubWatcher(source, ctx);
    if (token === undefined) {
      log(`ci: ${watcher.name}: ${source.tokenEnv} is not set; polling without a token (public projects only)`);
    }
    return watcher;
  });

  const loop = async (w: Watcher): Promise<void> => {
    let failures = 0;
    while (!signal.aborted) {
      let wait = intervalMs;
      try {
        await w.poll();
        failures = 0;
        wait = pace(intervalMs, w.http.rate, now());
      } catch (err) {
        // A request cut short by a stop is not an error worth a line.
        if (!signal.aborted) {
          failures += 1;
          const retryAfter = err instanceof CiHttpError ? err.retryAfterMs : undefined;
          wait = backoff(intervalMs, failures, retryAfter, random);
          log(`ci: ${w.name}: ${message(err)}; retrying in ${formatDuration(wait)}`);
        }
      }
      // Saved even after a failed or stopped poll: whatever it did post is already recorded.
      try {
        await state.save();
      } catch (err) {
        log(`ci: cannot save state: ${message(err)}`);
      }
      await sleep(wait, signal);
    }
  };
  await Promise.all(watchers.map(loop));
}
