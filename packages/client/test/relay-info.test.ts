// A relay's `GET /v1/info`: read by `wim doctor`, and once when a relay refuses `create`, to say
// why in words the person can act on. No other command makes a network call for it.

import { certPin, selfSignedCert } from "@worldinmotion/relay-node";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { describeInfo, fetchRelayInfo, INFO_MAX_BYTES, infoUrl, type RelayInfo } from "../src/relayinfo.ts";
import { makeMesh, newDevice, RELAY, RelayHarness, run, term } from "./helpers.ts";

const INFO: RelayInfo = {
  v: 1,
  software: "worldinmotion-relay",
  version: "0.1.0",
  create: "open",
  limits: { max_meshes: 2000, idle_mesh_days: 30, blob_bytes_per_mesh_per_day: 25 * 1024 * 1024 },
  offer: "Free open mesh creation until v1.0.\u001b]0;x\u0007",
};

/** A fetch that answers `/v1/info` with `body` (and `status`), and counts its calls. */
function fakeFetch(body: unknown, status = 200) {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetcher, calls };
}

describe("fetchRelayInfo", () => {
  it("reads the info document over https, or http to loopback only", async () => {
    expect(infoUrl("wss://relay.example/base")).toBe("https://relay.example/base/v1/info");
    expect(infoUrl("ws://127.0.0.1:4444")).toBe("http://127.0.0.1:4444/v1/info");
    const ok = fakeFetch(INFO);
    expect(await fetchRelayInfo("wss://relay.example", ok.fetcher)).toEqual(INFO);
    expect(ok.calls).toEqual(["https://relay.example/v1/info"]);
    // ws:// off loopback is not a relay URL: nothing is fetched.
    expect(await fetchRelayInfo("ws://relay.example", ok.fetcher)).toBeUndefined();
    expect(ok.calls.length).toBe(1);
  });

  it("treats a missing, failing, oversized or other-shaped answer as no info", async () => {
    expect(await fetchRelayInfo(RELAY, fakeFetch(INFO, 404).fetcher)).toBeUndefined();
    expect(await fetchRelayInfo(RELAY, fakeFetch("not json").fetcher)).toBeUndefined();
    expect(await fetchRelayInfo(RELAY, fakeFetch({ ...INFO, create: "maybe" }).fetcher)).toBeUndefined();
    expect(await fetchRelayInfo(RELAY, fakeFetch({ ...INFO, offer: "x".repeat(INFO_MAX_BYTES) }).fetcher)).toBeUndefined();
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    expect(await fetchRelayInfo(RELAY, down)).toBeUndefined();
    // A relay that never answers is cut off by the timeout.
    const silent = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
    expect(await fetchRelayInfo(RELAY, silent, { timeoutMs: 20 })).toBeUndefined();
  });

  describe("from a relay with a pinned self-signed certificate", () => {
    const servers: Server[] = [];
    afterEach(async () => {
      for (const s of servers.splice(0)) await new Promise((resolve) => s.close(resolve));
    });

    /** An https server on loopback that answers every request with `body`; its URL and pin. */
    async function pinnedRelay(body: string): Promise<{ port: number; pin: string; paths: string[] }> {
      const { key, cert } = selfSignedCert(["127.0.0.1", "localhost"], new Date());
      const paths: string[] = [];
      const server = createServer({ key, cert }, (req, res) => {
        paths.push(`${req.headers.host} ${req.url} ${req.headers.accept}`);
        res.writeHead(200, { "content-type": "application/json" }).end(body);
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return { port: (server.address() as AddressInfo).port, pin: certPin(cert), paths };
    }

    it("reads it through the pin, by address or by name", async () => {
      const r = await pinnedRelay(JSON.stringify(INFO));
      const unused = fakeFetch(INFO);
      expect(await fetchRelayInfo(`wss://127.0.0.1:${r.port}`, unused.fetcher, { tlsPin: r.pin })).toEqual(INFO);
      expect(await fetchRelayInfo(`wss://localhost:${r.port}`, unused.fetcher, { tlsPin: r.pin })).toEqual(INFO);
      expect(r.paths).toEqual([`127.0.0.1:${r.port} /v1/info application/json`, `localhost:${r.port} /v1/info application/json`]);
      expect(unused.calls).toEqual([]);
    });

    it("refuses it under another pin, an oversized answer, and without a pin (no CA signed it)", async () => {
      const r = await pinnedRelay(JSON.stringify(INFO));
      const url = `wss://127.0.0.1:${r.port}`;
      expect(await fetchRelayInfo(url, fetch, { tlsPin: "A".repeat(43) })).toBeUndefined();
      expect(await fetchRelayInfo(url, fetch)).toBeUndefined();
      expect(r.paths).toEqual([]);
      const big = await pinnedRelay("x".repeat(4 * INFO_MAX_BYTES));
      expect(await fetchRelayInfo(`wss://127.0.0.1:${big.port}`, fetch, { tlsPin: big.pin })).toBeUndefined();
      expect(big.paths.length).toBe(1);
    });
  });

  it("describes the create mode, the limits in words and the offer as the relay's own text", () => {
    expect(describeInfo(INFO)).toEqual([
      "the relay creates meshes for anyone",
      "relay limits: at most 2000 meshes; a mesh idle for 30 days may be removed; 25 MiB of files per mesh per day",
      'relay offer (the relay\'s own words, not checked): "Free open mesh creation until v1.0.<U+001B>]0;x<U+0007>"',
    ]);
    const bare = { ...INFO, create: "key" as const, offer: null, limits: { max_meshes: null, idle_mesh_days: null, blob_bytes_per_mesh_per_day: 1000 } };
    expect(describeInfo(bare)).toEqual(["the relay creates meshes only with an operator key", "relay limits: no cap on the number of meshes; idle meshes are kept; 1000 bytes of files per mesh per day"]);
    expect(describeInfo({ ...bare, create: "closed" })[0]).toBe("the relay is not accepting new meshes");
  });
});

describe("wim doctor", () => {
  it("prints what the relay publishes at /v1/info, and says so when it publishes nothing", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const published = fakeFetch(INFO);
    const t = term(devices[0]!.root, relay, { fetch: published.fetcher });
    expect(await run(t, "doctor")).toBe(0);
    expect(published.calls).toEqual([`${RELAY.replace("ws", "http")}/v1/info`]);
    expect(t.out).toContain(`info     mesh ${mesh}: the relay creates meshes for anyone`);
    expect(t.out).toContain(`info     mesh ${mesh}: relay limits: at most 2000 meshes; a mesh idle for 30 days may be removed; 25 MiB of files per mesh per day`);
    expect(t.out.join("\n")).not.toContain("\u001b");
    const none = term(devices[0]!.root, relay, { fetch: fakeFetch("", 404).fetcher });
    expect(await run(none, "doctor")).toBe(0);
    expect(none.out).toContain(`info     mesh ${mesh}: this relay does not publish /v1/info`);
  });
});

describe("a refused create", () => {
  const refuse = "the relay refused to create the mesh";

  it("for lack of a key: says the relay is closed, wants a key, or either, from /v1/info, asked once", async () => {
    const relay = new RelayHarness({ createKey: "right" });
    const d = await newDevice("op");
    const cases: Array<[unknown, number, string[], string]> = [
      [{ ...INFO, create: "closed" }, 200, [], `wim: ${refuse}: this relay is not accepting new meshes`],
      [{ ...INFO, create: "key" }, 200, [], `wim: ${refuse}: it needs an operator key: pass it with --key-env NAME, naming the environment variable that holds the key`],
      [{ ...INFO, create: "key" }, 200, ["--key-env", "K"], `wim: ${refuse}: the key in $K was not accepted`],
      ["", 404, [], `wim: ${refuse}: it is not accepting new meshes, or it needs an operator key: pass it with --key-env NAME, naming the environment variable that holds the key`],
      [{ ...INFO, create: "open" }, 200, ["--key-env", "K"], `wim: ${refuse}: it is not accepting new meshes, or the key in $K was not accepted`],
    ];
    for (const [body, status, extra, line] of cases) {
      const f = fakeFetch(body, status);
      const t = term(d.root, relay, { fetch: f.fetcher }, { K: "wrong" });
      expect(await run(t, "mesh", "create", "--relay", RELAY, "--no-recovery", ...extra)).toBe(1);
      expect(t.err.at(-1)).toBe(line);
      expect(f.calls.length).toBe(1);
    }
  });

  it("because the relay is full: says so and suggests running a relay, in init too", async () => {
    const relay = new RelayHarness();
    // The relay answers `create` with `full` (its mesh cap is reached).
    relay.toRelay = (text, id) => {
      if (!text.startsWith('{"t":"create"')) return text;
      for (const m of relay.relays.values()) {
        const c = m.conns.get(id) as unknown as { socket: { deliver(t: string): void } } | undefined;
        if (c !== undefined) setImmediate(() => c.socket.deliver(JSON.stringify({ t: "error", code: "full", message: "free text", ref: "create" })));
      }
      return undefined;
    };
    const root = (await newDevice("tmp")).root;
    const f = fakeFetch(INFO);
    const t = term(`${root}-init`, relay, { fetch: f.fetcher });
    expect(await run(t, "init", "--name", "fresh", "--relay", RELAY, "--no-recovery")).toBe(1);
    expect(t.err.at(-1)).toBe(`wim: ${refuse}: this relay has reached its limit of new meshes; run your own relay (packages/relay-node) or try another`);
    expect(f.calls).toEqual([]);
  });

  it("makes no info request when create succeeds, nor in other commands", async () => {
    const relay = new RelayHarness();
    const d = await newDevice("plain");
    const f = fakeFetch(INFO);
    const t = term(d.root, relay, { fetch: f.fetcher });
    expect(await run(t, "mesh", "create", "--relay", RELAY, "--no-recovery")).toBe(0);
    expect(await run(t, "peers")).toBe(0);
    expect(f.calls).toEqual([]);
  });
});
