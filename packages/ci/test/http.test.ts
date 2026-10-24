import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { CiHttpError, HttpClient, parseRetryAfter } from "../src/http.ts";
import { apiServer, clock } from "./helpers.ts";

const URL_ = "https://api.github.com/repos/octo/app/actions/runs";
const PATH = "/api.github.com/repos/octo/app/actions/runs";

async function setup(opts: { etag?: boolean; timeoutMs?: number; signal?: AbortSignal } = {}) {
  const server = await apiServer();
  const t = clock();
  const http = new HttpClient({
    fetch: server.fetch,
    headers: { Authorization: "Bearer s3cret-token" },
    timeoutMs: opts.timeoutMs ?? 2_000,
    now: t.now,
    etag: opts.etag,
    signal: opts.signal,
  });
  return { server, http, t };
}

async function failure(p: Promise<unknown>): Promise<CiHttpError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CiHttpError);
  return err as CiHttpError;
}

describe("HttpClient", () => {
  it("returns JSON, sends the headers and reads GitHub's rate headers", async () => {
    const { server, http } = await setup();
    server.set(PATH, {
      body: { ok: 1 },
      headers: { "x-ratelimit-remaining": "4999", "x-ratelimit-limit": "5000", "x-ratelimit-reset": "1793000000" },
    });
    expect(await http.getJson(URL_)).toEqual({ ok: 1 });
    expect(server.seen[0]?.headers.authorization).toBe("Bearer s3cret-token");
    expect(http.rate).toEqual({ remaining: 4999, limit: 5000, resetAt: 1_793_000_000_000 });
  });

  it("reads GitLab's RateLimit headers, skipping empty and unparseable values", async () => {
    const { server, http } = await setup();
    server.set(PATH, {
      body: [],
      headers: { "x-ratelimit-remaining": "", "ratelimit-remaining": "3", "ratelimit-limit": "lots" },
    });
    await http.getJson(URL_);
    expect(http.rate).toEqual({ remaining: 3, limit: undefined, resetAt: undefined });
    server.set(PATH, { body: [] });
    await http.getJson(URL_);
    // A response without rate headers leaves the last reading in place.
    expect(http.rate.remaining).toBe(3);
  });

  it("serves a 304 from the ETag cache", async () => {
    const { server, http } = await setup({ etag: true });
    server.set(PATH, (req) =>
      req.headers["if-none-match"] === 'W/"abc"' ? { status: 304 } : { body: { n: 1 }, headers: { etag: 'W/"abc"' } },
    );
    expect(await http.getJson(URL_)).toEqual({ n: 1 });
    expect(await http.getJson(URL_)).toEqual({ n: 1 });
    expect(server.seen.map((s) => s.headers["if-none-match"])).toEqual([undefined, 'W/"abc"']);
  });

  it("sends no If-None-Match without the etag option, and a stray 304 is an error", async () => {
    const { server, http } = await setup();
    server.set(PATH, { status: 304, headers: { etag: '"x"' } });
    const err = await failure(http.getJson(URL_));
    expect(err.message).toBe(`GET ${URL_} returned 304`);
    expect(server.seen[0]?.headers["if-none-match"]).toBeUndefined();
  });

  it("reports an error status without the body", async () => {
    const { server, http } = await setup();
    server.set(PATH, { status: 500, body: { message: "token s3cret-token is broken" } });
    const err = await failure(http.getJson(URL_));
    expect(err.message).toBe(`GET ${URL_} returned 500`);
    expect(err.status).toBe(500);
    expect(err.retryAfterMs).toBeUndefined();
  });

  it("honours Retry-After in seconds and as a date", async () => {
    const { server, http, t } = await setup();
    server.set(PATH, { status: 429, headers: { "retry-after": "7" } });
    expect((await failure(http.getJson(URL_))).retryAfterMs).toBe(7_000);
    server.set(PATH, { status: 503, headers: { "retry-after": new Date(t.now() + 90_000).toUTCString() } });
    expect((await failure(http.getJson(URL_))).retryAfterMs).toBe(90_000);
  });

  it("waits for the reset on an exhausted limit, and has no hint otherwise", async () => {
    const { server, http, t } = await setup();
    const reset = String(Math.floor(t.now() / 1000) + 120);
    server.set(PATH, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } });
    expect((await failure(http.getJson(URL_))).retryAfterMs).toBe(120_000);
    server.set(PATH, { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    expect((await failure(http.getJson(URL_))).retryAfterMs).toBeUndefined();
    server.set(PATH, { status: 403, headers: { "x-ratelimit-remaining": "10", "x-ratelimit-reset": reset } });
    expect((await failure(http.getJson(URL_))).retryAfterMs).toBeUndefined();
    server.set(PATH, { status: 429, headers: { "x-ratelimit-remaining": "10", "x-ratelimit-reset": reset } });
    expect((await failure(http.getJson(URL_))).retryAfterMs).toBe(120_000);
  });

  it("never repeats a malformed body, which may hold anything", async () => {
    const { server, http } = await setup();
    server.set(PATH, { raw: "s3cret-token <html>" });
    const err = await failure(http.getJson(URL_));
    expect(err.message).toBe(`GET ${URL_} returned malformed JSON`);
  });

  it("times out", async () => {
    const { server, http } = await setup({ timeoutMs: 50 });
    server.set(PATH, { body: {}, delayMs: 1_000 });
    expect((await failure(http.getJson(URL_))).message).toBe(`GET ${URL_} timed out after 0s`);
  });

  it("reports a network failure and a stop", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const http = new HttpClient({
      fetch: () => fetch(`http://127.0.0.1:${port}/`),
      headers: {},
      timeoutMs: 2_000,
      now: Date.now,
    });
    expect((await failure(http.getJson(URL_))).message).toBe(`GET ${URL_} failed: fetch failed`);

    const stop = new AbortController();
    stop.abort();
    const stopped = await setup({ signal: stop.signal });
    stopped.server.set(PATH, { body: {} });
    expect((await failure(stopped.http.getJson(URL_))).message).toMatch(/failed: .*abort/i);
  });
});

describe("parseRetryAfter", () => {
  it("handles missing, invalid and past values", () => {
    expect(parseRetryAfter(undefined, 0)).toBeUndefined();
    expect(parseRetryAfter("soon", 0)).toBeUndefined();
    expect(parseRetryAfter(" 3 ", 0)).toBe(3_000);
    expect(parseRetryAfter("Thu, 01 Jan 1970 00:00:00 GMT", 5_000)).toBe(0);
  });
});
