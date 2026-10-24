/** What a source learned about its rate limit from the most recent response. */
export interface RateInfo {
  remaining?: number;
  limit?: number;
  /** When the window resets, in epoch milliseconds. */
  resetAt?: number;
}

/**
 * A failed request. The message names the method, URL and status only: response bodies and
 * request headers (where the token lives) are never copied into it.
 */
export class CiHttpError extends Error {
  readonly status: number | undefined;
  /** How long the server asked us to wait, when it said. */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = "CiHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface HttpOptions {
  fetch: typeof fetch;
  /** Headers sent with every request, including the authorization header when there is a token. */
  headers: Record<string, string>;
  timeoutMs: number;
  now: () => number;
  /** Cancels requests in flight when the watcher stops. */
  signal?: AbortSignal;
  /** Send `If-None-Match` and serve a 304 from the cached body (GitHub does not count 304s). */
  etag?: boolean;
}

function header(res: Response, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = res.headers.get(name);
    if (value !== null && value !== "") return value;
  }
  return undefined;
}

function numberHeader(res: Response, ...names: string[]): number | undefined {
  const value = header(res, ...names);
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Releases a response body we will not read, so the connection can be reused. */
async function discard(res: Response): Promise<void> {
  if (res.body !== null) await res.body.cancel();
}

/** `Retry-After` is either a number of seconds or an HTTP date. */
export function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** A tiny JSON-over-HTTPS GET client with a timeout, conditional requests and rate-limit reading. */
export class HttpClient {
  rate: RateInfo = {};
  private readonly cache = new Map<string, { etag: string; body: unknown }>();
  private readonly options: HttpOptions;

  constructor(options: HttpOptions) {
    this.options = options;
  }

  async getJson(url: string): Promise<unknown> {
    const { timeoutMs } = this.options;
    const headers: Record<string, string> = { ...this.options.headers };
    const cached = this.options.etag === true ? this.cache.get(url) : undefined;
    if (cached !== undefined) headers["If-None-Match"] = cached.etag;
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (this.options.signal !== undefined) signals.push(this.options.signal);

    let res: Response;
    try {
      res = await this.options.fetch(url, { headers, signal: AbortSignal.any(signals) });
    } catch (err) {
      const e = err as Error;
      if (e.name === "TimeoutError") {
        throw new CiHttpError(`GET ${url} timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw new CiHttpError(`GET ${url} failed: ${e.message}`);
    }
    this.readRate(res);

    if (res.status === 304 && cached !== undefined) {
      await discard(res);
      return cached.body;
    }
    if (!res.ok) {
      await discard(res);
      throw new CiHttpError(`GET ${url} returned ${res.status}`, res.status, this.retryAfter(res));
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // The parser's own message quotes the body, which is not ours to repeat.
      throw new CiHttpError(`GET ${url} returned malformed JSON`, res.status);
    }
    const etag = header(res, "etag");
    if (this.options.etag === true && etag !== undefined) this.cache.set(url, { etag, body });
    return body;
  }

  private readRate(res: Response): void {
    const remaining = numberHeader(res, "x-ratelimit-remaining", "ratelimit-remaining");
    if (remaining === undefined) return;
    const limit = numberHeader(res, "x-ratelimit-limit", "ratelimit-limit");
    const reset = numberHeader(res, "x-ratelimit-reset", "ratelimit-reset");
    this.rate = {
      remaining,
      limit,
      resetAt: reset === undefined ? undefined : reset * 1000,
    };
  }

  /**
   * How long to hold off after an error response. A 429, or a 403 that GitHub uses for an
   * exhausted or secondary limit, waits for `Retry-After` or the reset time.
   */
  private retryAfter(res: Response): number | undefined {
    const now = this.options.now();
    const fromHeader = parseRetryAfter(header(res, "retry-after"), now);
    if (fromHeader !== undefined) return fromHeader;
    const limited = res.status === 429 || (res.status === 403 && this.rate.remaining === 0);
    if (limited && this.rate.resetAt !== undefined) return Math.max(0, this.rate.resetAt - now);
    return undefined;
  }
}
