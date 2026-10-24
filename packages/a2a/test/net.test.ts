import { describe, expect, it } from "vitest";
import {
  checkAgentUrl,
  fetchJson,
  hostHeaderName,
  isLoopbackHost,
  MAX_RESPONSE_BYTES,
  normalizeHostName,
} from "../src/net.ts";
import { json, serve } from "./helpers.ts";

const GET = { method: "GET" as const, headers: {} };

describe("isLoopbackHost", () => {
  it("knows loopback names and addresses", () => {
    for (const h of ["localhost", "127.0.0.1", "127.8.9.10", "::1", "[::1]"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "10.0.0.1", "127.example", "example.com", "::", "[::2]", "128.0.0.1"]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe("host names", () => {
  it("normalizes configured names to the Host header form", () => {
    expect(normalizeHostName("GW.Example")).toBe("gw.example");
    expect(normalizeHostName("::1")).toBe("[::1]");
    expect(normalizeHostName("[::1]")).toBe("[::1]");
  });

  it("reads the name from a Host header, and refuses anything odd", () => {
    expect(hostHeaderName("127.0.0.1:8080")).toBe("127.0.0.1");
    expect(hostHeaderName("GW.example")).toBe("gw.example");
    expect(hostHeaderName("[::1]:443")).toBe("[::1]");
    for (const h of [undefined, "", "a b", "evil.example@127.0.0.1", "127.0.0.1:80/x", "host:port", "::1"]) {
      expect(hostHeaderName(h)).toBeUndefined();
    }
  });
});

describe("checkAgentUrl", () => {
  it("accepts https anywhere and http to loopback", () => {
    expect(checkAgentUrl("https://agent.example/card").host).toBe("agent.example");
    expect(checkAgentUrl("http://127.0.0.1:9/card").port).toBe("9");
    expect(checkAgentUrl("http://[::1]/card").hostname).toBe("[::1]");
  });

  it("refuses everything else", () => {
    expect(() => checkAgentUrl("not a url")).toThrow("not a valid URL");
    expect(() => checkAgentUrl("https://user:pw@agent.example/")).toThrow("credentials");
    expect(() => checkAgentUrl("https://user@agent.example/")).toThrow("credentials");
    expect(() => checkAgentUrl("http://agent.example/")).toThrow("https, or http to a loopback host");
    expect(() => checkAgentUrl("ftp://127.0.0.1/")).toThrow("https, or http to a loopback host");
  });
});

describe("fetchJson", () => {
  it("returns the status and parsed body, sending method, headers and body", async () => {
    const srv = await serve((_req, res) => json(res, 201, { ok: true }));
    const got = await fetchJson(
      new URL(`${srv.base}/rpc`),
      { method: "POST", headers: { "x-test": "1" }, body: "{}" },
      { timeoutMs: 1000 },
    );
    expect(got).toEqual({ status: 201, body: { ok: true } });
    expect(srv.seen[0]).toMatchObject({ method: "POST", path: "/rpc", body: "{}" });
    expect(srv.seen[0]!.headers["x-test"]).toBe("1");
  });

  it("follows a same-origin redirect for a GET", async () => {
    const srv = await serve((req, res) => {
      if (req.path === "/old") {
        res.writeHead(302, { location: "/new" });
        res.end();
      } else json(res, 200, { at: req.path });
    });
    expect((await fetchJson(new URL(`${srv.base}/old`), GET, { timeoutMs: 1000 })).body).toEqual({ at: "/new" });
  });

  it("refuses a redirect to another host", async () => {
    const other = await serve((_req, res) => json(res, 200, { leaked: true }));
    const srv = await serve((_req, res) => {
      res.writeHead(301, { location: `http://localhost:${other.port}/` });
      res.end();
    });
    await expect(fetchJson(new URL(srv.base), GET, { timeoutMs: 1000 })).rejects.toThrow(
      `redirect to another host refused (localhost:${other.port})`,
    );
    expect(other.seen).toHaveLength(0);
  });

  it("never redirects a POST", async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(307, { location: "/elsewhere" });
      res.end();
    });
    await expect(fetchJson(new URL(srv.base), { method: "POST", headers: {}, body: "{}" }, { timeoutMs: 1000 })).rejects.toThrow(
      "redirect refused for a POST",
    );
    expect(srv.seen).toHaveLength(1);
  });

  it("stops after three redirects", async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(302, { location: "/again" });
      res.end();
    });
    await expect(fetchJson(new URL(srv.base), GET, { timeoutMs: 1000 })).rejects.toThrow("too many redirects");
    expect(srv.seen).toHaveLength(4);
  });

  it("refuses a redirect with no location, and one with no body", async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(302);
      res.end();
    });
    await expect(fetchJson(new URL(srv.base), GET, { timeoutMs: 1000 })).rejects.toThrow("redirect without a location");
    const bodiless = async () => new Response(null, { status: 304 });
    await expect(
      fetchJson(new URL("https://agent.example/"), GET, { timeoutMs: 1000, fetch: bodiless as typeof fetch }),
    ).rejects.toThrow("redirect without a location");
  });

  it("refuses a body over the cap, declared or streamed", async () => {
    const declared = await serve((_req, res) => {
      res.writeHead(200, { "content-length": String(MAX_RESPONSE_BYTES + 1) });
      res.write("{");
      // The client gives up on the header alone; never finish the body.
    });
    await expect(fetchJson(new URL(declared.base), GET, { timeoutMs: 1000 })).rejects.toThrow(
      `response larger than ${MAX_RESPONSE_BYTES} bytes`,
    );
    const streamed = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = "x".repeat(64 * 1024);
      for (let i = 0; i < 17; i++) res.write(chunk);
      res.end();
    });
    await expect(fetchJson(new URL(streamed.base), GET, { timeoutMs: 1000 })).rejects.toThrow("response larger than");
    const small = await serve((_req, res) => json(res, 200, { big: "y".repeat(200) }));
    await expect(fetchJson(new URL(small.base), GET, { timeoutMs: 1000, maxBytes: 100 })).rejects.toThrow(
      "response larger than 100 bytes",
    );
  });

  it("refuses a body that is not JSON, or is empty", async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(502);
      res.end("<html>bad gateway</html>");
    });
    await expect(fetchJson(new URL(srv.base), GET, { timeoutMs: 1000 })).rejects.toThrow("response is not JSON (HTTP 502)");
    const empty = async () => new Response(null, { status: 204 });
    await expect(
      fetchJson(new URL("https://agent.example/"), GET, { timeoutMs: 1000, fetch: empty as typeof fetch }),
    ).rejects.toThrow("response is not JSON (HTTP 204)");
  });

  it("times out on slow headers and on a slow body", async () => {
    const slowHead = await serve(() => {
      // Never answers.
    });
    await expect(fetchJson(new URL(slowHead.base), GET, { timeoutMs: 50 })).rejects.toThrow("timed out after 50 ms");
    const slowBody = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
    });
    await expect(fetchJson(new URL(slowBody.base), GET, { timeoutMs: 50 })).rejects.toThrow("timed out after 50 ms");
  });

  it("passes through a connection error", async () => {
    const srv = await serve((_req, res) => {
      res.destroy();
    });
    await expect(fetchJson(new URL(srv.base), GET, { timeoutMs: 1000 })).rejects.toThrow("fetch failed");
  });
});
