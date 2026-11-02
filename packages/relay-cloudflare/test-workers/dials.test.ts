import { env, SELF } from "cloudflare:test";
import { b64u, LIMITS, randomBytes } from "@worldinmotion/protocol";
import { sourceKey } from "@worldinmotion/relay-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import wranglerText from "../wrangler.jsonc?raw";
import worker, { type Env } from "../src/index.ts";
import { bindings, meshId, ORIGIN, RELAY } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());

/**
 * Spends the address's whole dial allowance in the rate limiter, as many dials would, until it
 * refuses (the test configuration lowers the limit, so this is quick).
 */
async function exhaust(ip: string): Promise<void> {
  for (let i = 0; i < 3 * LIMITS.dialsPerSourcePerMinute; i++) {
    if (!(await env.DIALS!.limit({ key: sourceKey(ip) })).success) return;
  }
  throw new Error("the rate limiter never refused");
}

function dial(ip: string, mesh = meshId()): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/v1/${mesh}`, { headers: { upgrade: "websocket", "cf-connecting-ip": ip } });
}

/** Closes the client end of an accepted dial. */
function hangUp(res: Response): void {
  res.webSocket!.accept();
  res.webSocket!.close(1000, "done");
}

/** A Durable Object namespace that fails the test if the Worker touches it. */
const untouchable = new Proxy({}, {
  get(_t, key) {
    throw new Error(`the Worker reached a Durable Object (${String(key)})`);
  },
}) as Env["MESH"];

describe("the dial limit per source address", () => {
  it("answers a dial past the limit with 429 and Retry-After, and another address still dials", async () => {
    const ip = "198.51.100.50";
    await exhaust(ip);
    const refused = await dial(ip);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(refused.headers.get("content-type")).toBe("application/json");
    expect(await refused.json()).toEqual({ error: "too many connections from this address; try again later" });
    const other = await dial("198.51.100.51");
    expect(other.status).toBe(101);
    hangUp(other);
  });

  it("refuses before any Durable Object is reached", async () => {
    const limited = { limit: () => Promise.resolve({ success: false }) };
    const e = { ...bindings, MESH: untouchable, RDV: untouchable as unknown as Env["RDV"], WIM_RELAY_URLS: RELAY, DIALS: limited } as Env;
    const res = await worker.fetch(new Request(`${ORIGIN}/v1/${meshId()}`, { headers: { upgrade: "websocket" } }), e);
    expect(res.status).toBe(429);
    const box = await worker.fetch(new Request(`${ORIGIN}/v1/rdv/${b64u.encode(randomBytes(16))}`), e);
    expect(box.status).toBe(429);
    expect(box.headers.get("cache-control")).toBe("no-store");
    expect(box.headers.get("retry-after")).toBe("60");
  });

  it("counts short invite code fetches from the same allowance", async () => {
    const ip = "198.51.100.52";
    await exhaust(ip);
    const res = await SELF.fetch(`${ORIGIN}/v1/rdv/${b64u.encode(randomBytes(16))}`, { headers: { "cf-connecting-ip": ip } });
    expect(res.status).toBe(429);
  });

  it("still serves dials without the rate-limit binding, and logs that once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { DIALS: _none, ...rest } = bindings;
    const e = { ...rest, WIM_RELAY_URLS: RELAY } as Env;
    for (let i = 0; i < 2; i++) {
      const res = await worker.fetch(new Request(`${ORIGIN}/v1/${meshId()}`, { headers: { upgrade: "websocket" } }), e);
      expect(res.status).toBe(101);
      hangUp(res);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toMatchObject({ event: "config", binding: "DIALS" });
  });

  it("is configured in wrangler.jsonc at the protocol's number, a minute at a time", () => {
    const config = JSON.parse(wranglerText.replace(/^\s*\/\/.*$/gm, "")) as { ratelimits: { name: string; simple: { limit: number; period: number } }[] };
    expect(config.ratelimits).toEqual([expect.objectContaining({ name: "DIALS", simple: { limit: LIMITS.dialsPerSourcePerMinute, period: 60 } })]);
  });
});
