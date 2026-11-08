import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { PROXY_PATHS, startProxy, type ProxyOptions, type RunningProxy, type UpstreamFetch } from "../../src/privileged/proxy.ts";

const running: RunningProxy[] = [];
afterEach(async () => {
  for (const p of running.splice(0)) await p.close();
});

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: string;
}

async function proxy(over: Partial<ProxyOptions> = {}, answer?: () => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const logs: string[] = [];
  const fetch: UpstreamFetch = async (url, init) => {
    seen.push({ url, headers: init.headers, body: init.body });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return answer ? answer() : new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json", "request-id": "req_1", "set-cookie": "a=b", "content-encoding": "gzip" } });
  };
  const p = await startProxy({
    upstream: "https://api.example.test",
    auth: async () => ({ authorization: "Bearer real-token", "anthropic-beta": "oauth-2025-04-20" }),
    models: ["claude-opus-5-5"],
    maxTokens: 128_000,
    maxRequests: 2,
    maxBodyBytes: 1000,
    requestTimeoutMs: 5000,
    fetch,
    log: (l) => logs.push(l),
    ...over,
  });
  running.push(p);
  return { p, seen, logs };
}

function call(p: RunningProxy, o: { path?: string; method?: string; key?: string | null; body?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${p.url}${o.path ?? "/v1/messages?beta=true"}`,
      { method: o.method ?? "POST", headers: { "content-type": "application/json", ...(o.key === null ? {} : { "x-api-key": o.key ?? p.key }), ...o.headers } },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(o.body ?? JSON.stringify({ model: "claude-opus-5-5", max_tokens: 128_000, messages: [] }));
  });
}

describe("the auth proxy", () => {
  it("listens on loopback only, and swaps the job's key for the real credential", async () => {
    const { p, seen, logs } = await proxy();
    expect(p.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(p.key).toMatch(/^wimjob-[A-Za-z0-9_-]{43}$/);
    const r = await call(p, { headers: { "anthropic-beta": "claude-code-20250219", authorization: "Bearer job-made-up", "accept-encoding": "gzip" } });
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"ok":true}');
    expect(r.headers["request-id"]).toBe("req_1");
    expect(r.headers["set-cookie"]).toBeUndefined();
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(seen[0]!.url).toBe("https://api.example.test/v1/messages?beta=true");
    expect(seen[0]!.headers["authorization"]).toBe("Bearer real-token");
    expect(seen[0]!.headers["anthropic-beta"]).toBe("claude-code-20250219,oauth-2025-04-20");
    expect(seen[0]!.headers["x-api-key"]).toBeUndefined();
    expect(seen[0]!.headers["accept-encoding"]).toBeUndefined();
    expect(seen[0]!.headers["host"]).toBeUndefined();
    expect(p.requests()).toBe(1);
    // Logs name the path, status and count only: never a key, a token or a body.
    expect(logs).toEqual(["proxy: /v1/messages 200 (request 1 of 2)"]);
  });

  it("sends the bearer's beta flag alone when the job asked for none, and an API key as it is", async () => {
    const a = await proxy();
    await call(a.p, {});
    expect(a.seen[0]!.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    const b = await proxy({ auth: async () => ({ "x-api-key": "sk-real" }) });
    await call(b.p, { headers: { "anthropic-beta": "x" } });
    expect(b.seen[0]!.headers["x-api-key"]).toBe("sk-real");
    expect(b.seen[0]!.headers["anthropic-beta"]).toBe("x");
  });

  it("refuses a missing or wrong key, in constant time, before anything else", async () => {
    const { p, seen } = await proxy();
    expect((await call(p, { key: null })).status).toBe(401);
    expect((await call(p, { key: `${p.key}x` })).status).toBe(401);
    expect((await call(p, { key: "", path: "/v1/oauth/token" })).status).toBe(401);
    expect(seen.length).toBe(0);
  });

  it("allows only the API paths the Agent SDK calls", async () => {
    const { p, seen } = await proxy();
    expect(PROXY_PATHS).toEqual(["/v1/messages", "/v1/messages/count_tokens"]);
    for (const path of ["/v1/oauth/token", "/v1/files", "/v1/messages/batches", "/v1/messages?beta=false", "/v1/messages?x=1", "/"]) {
      expect((await call(p, { path })).status).toBe(404);
    }
    expect((await call(p, { method: "PUT" })).status).toBe(404);
    expect((await call(p, { path: "/v1/messages" })).status).toBe(200);
    expect(seen.length).toBe(1);
  });

  it("caps the body, and checks the model and max_tokens", async () => {
    const { p } = await proxy();
    expect((await call(p, { body: "x".repeat(1001) })).status).toBe(413);
    expect((await call(p, { body: "{" })).status).toBe(400);
    expect((await call(p, { body: "null" })).status).toBe(400);
    expect((await call(p, { body: JSON.stringify({ model: "claude-other", max_tokens: 1 }) })).body).toMatch(/may not use that model/);
    expect((await call(p, { body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 128_001 }) })).body).toMatch(/at most 128000/);
    expect((await call(p, { body: JSON.stringify({ model: "claude-opus-5-5" }) })).status).toBe(400);
    expect(p.requests()).toBe(0);
  });

  it("counts token counts as free and refuses messages past the job's cap", async () => {
    const { p } = await proxy();
    expect((await call(p, { path: "/v1/messages/count_tokens", body: JSON.stringify({ model: "claude-opus-5-5", messages: [] }) })).status).toBe(200);
    expect((await call(p)).status).toBe(200);
    expect((await call(p)).status).toBe(200);
    const third = await call(p);
    expect(third.status).toBe(429);
    expect(third.body).toMatch(/rate_limit_error/);
  });

  it("passes an empty upstream body, and an upstream error status, through", async () => {
    const { p } = await proxy({}, () => new Response(null, { status: 529 }));
    expect(await call(p)).toMatchObject({ status: 529, body: "" });
  });

  it("answers 502, logging the error's name only, when the API cannot be reached or the sign-in fails", async () => {
    const a = await proxy({}, () => Promise.reject(new TypeError("fetch failed: secret detail")));
    expect((await call(a.p)).status).toBe(502);
    expect(a.logs).toEqual(["proxy: failed: TypeError"]);
    const b = await proxy({ auth: async () => Promise.reject(new Error("token exchange failed: eyJ...")) });
    expect((await call(b.p)).status).toBe(502);
    expect(b.logs.join("\n")).not.toContain("eyJ");
  });

  it("ends the response when the upstream stream breaks", async () => {
    const { p } = await proxy({}, () => {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("data: 1\n\n"));
          c.error(new Error("reset"));
        },
      });
      return new Response(body, { status: 200 });
    });
    await expect(call(p)).rejects.toThrow();
  });

  it("is gone once closed, and closing twice is fine", async () => {
    const { p } = await proxy();
    await p.close();
    await p.close();
    await expect(call(p)).rejects.toThrow(/ECONNREFUSED/);
  });
});
