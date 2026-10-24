import { env, runInDurableObject } from "cloudflare:test";
import { CREATE_CLOSED, CREATE_MISCONFIGURED } from "@worldinmotion/relay-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { configProblem, MeshDurableObject, relayConfig, type Env } from "../src/index.ts";
import { MESH_HEADER, SOURCE_HEADER } from "../src/mesh.ts";
import { createWith, meshId, meshStub, ORIGIN, RELAY, Socket } from "./helpers.ts";

const base = { MESH: env.MESH, SOURCES: env.SOURCES, REGISTRY: env.REGISTRY } satisfies Partial<Env>;

afterEach(() => vi.restoreAllMocks());

describe("relayConfig", () => {
  it("reads a comma list of exact relay URLs and the create rule", () => {
    expect(relayConfig({ ...base, WIM_RELAY_URLS: " wss://relay.example.com , wss://relay.example.org/wim ," })).toEqual({
      relayUrls: ["wss://relay.example.com", "wss://relay.example.org/wim"],
      createRefused: CREATE_CLOSED,
      limits: {},
    });
    expect(relayConfig({ ...base, WIM_RELAY_URLS: "ws://localhost:8787", WIM_CREATE_KEY: "k" }).createKey).toBe("k");
    expect(relayConfig({ ...base, WIM_RELAY_URLS: RELAY, WIM_OPEN_CREATE: "1" })).toEqual({ relayUrls: [RELAY], limits: {} });
  });

  it("treats an empty secret as a misconfiguration that refuses creation, never as no key", () => {
    expect(relayConfig({ ...base, WIM_RELAY_URLS: RELAY, WIM_CREATE_KEY: "" })).toEqual({
      relayUrls: [RELAY],
      createRefused: CREATE_MISCONFIGURED,
      problem: "WIM_CREATE_KEY is set but empty",
      limits: {},
    });
    // Not even with open creation asked for as well.
    expect(relayConfig({ ...base, WIM_RELAY_URLS: RELAY, WIM_CREATE_KEY: "", WIM_OPEN_CREATE: "1" }).createRefused).toBe(CREATE_MISCONFIGURED);
  });

  it("refuses a missing, empty or invalid WIM_RELAY_URLS", () => {
    expect(() => relayConfig(base)).toThrow(/WIM_RELAY_URLS is not set/);
    expect(() => relayConfig({ ...base, WIM_RELAY_URLS: " , " })).toThrow(/WIM_RELAY_URLS is not set/);
    for (const bad of ["https://relay.example.com", "wss://relay.example.com/", "ws://relay.example.com"]) {
      expect(() => relayConfig({ ...base, WIM_RELAY_URLS: bad }), bad).toThrow(/entry 1 is not a relay URL/);
    }
  });
});

describe("/healthz", () => {
  const health = async (vars: Partial<Env>) => {
    const res = await worker.fetch(new Request(`${ORIGIN}/healthz`), { ...base, ...vars });
    return { status: res.status, body: await res.json() };
  };

  it("is 200 ok for a relay that can run, with creation keyed, open or closed", async () => {
    for (const vars of [{ WIM_CREATE_KEY: "k" }, { WIM_OPEN_CREATE: "1" }, {}]) {
      expect(await health({ WIM_RELAY_URLS: RELAY, ...vars }), JSON.stringify(vars)).toEqual({ status: 200, body: { ok: true } });
    }
  });

  it("is 503 with a short reason, and no secret, for a relay that is misconfigured", async () => {
    const cases: [Partial<Env>, string][] = [
      [{}, "WIM_RELAY_URLS is not set"],
      [{ WIM_RELAY_URLS: "wss://user:secret@relay.example.com" }, "WIM_RELAY_URLS entry 1 is not a relay URL (wss://, or ws:// to loopback, with no trailing slash)"],
      [{ WIM_RELAY_URLS: RELAY, WIM_CREATE_KEY: "" }, "WIM_CREATE_KEY is set but empty"],
      [{ WIM_RELAY_URLS: RELAY, WIM_CREATE_KEY: "s3cret-value", WIM_OPEN_CREATE: "1" }, "set WIM_CREATE_KEY or WIM_OPEN_CREATE=1, not both"],
      [{ WIM_RELAY_URLS: RELAY, WIM_OPEN_CREATE: "1", WIM_MAX_MESHES: "many" }, "WIM_MAX_MESHES must be a whole number of 1 or more"],
    ];
    for (const [vars, error] of cases) {
      const answer = await health(vars);
      expect(answer, JSON.stringify(vars)).toEqual({ status: 503, body: { ok: false, error } });
      expect(JSON.stringify(answer)).not.toContain("secret");
    }
    expect(configProblem({ ...base, WIM_RELAY_URLS: RELAY })).toBeUndefined();
  });
});

describe("a mesh object's create rule", () => {
  it("refuses create by default: creation is never open by accident", async () => {
    expect((await createWith({})).answer).toEqual({ t: "error", code: "unauthorized", message: CREATE_CLOSED, ref: "create" });
  });

  it("refuses create with an empty WIM_CREATE_KEY, and logs the problem without the value", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await createWith({ WIM_CREATE_KEY: "" })).answer).toEqual({ t: "error", code: "unauthorized", message: CREATE_MISCONFIGURED, ref: "create" });
    expect(errors).toHaveBeenCalledWith(JSON.stringify({ event: "config", error: "WIM_CREATE_KEY is set but empty", create: "refused" }));
  });

  it("needs the key when WIM_CREATE_KEY is set", async () => {
    expect((await createWith({ WIM_CREATE_KEY: "k" })).answer).toMatchObject({ t: "error", code: "unauthorized", ref: "create" });
  });
});

describe("a mesh object without a relay URL", () => {
  it("refuses to accept connections", async () => {
    const mesh = meshId();
    const res = await runInDurableObject(meshStub(mesh), async (_o, state) => {
      const bare = new MeshDurableObject(state, base);
      return bare.fetch(new Request(`${ORIGIN}/v1/${mesh}`, { headers: { upgrade: "websocket", [SOURCE_HEADER]: "s", [MESH_HEADER]: mesh } }));
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "relay not configured" });
  });

  it("fails each socket event on its own, without blocking the ones after it", async () => {
    const mesh = meshId();
    const s = await Socket.open(mesh);
    await s.next("hello");
    const results = await runInDurableObject(meshStub(mesh), async (_o, state) => {
      const bare = new MeshDurableObject(state, base);
      const [ws] = state.getWebSockets();
      const out: string[] = [];
      for (const p of [bare.webSocketMessage(ws!, "{}"), bare.webSocketClose(ws!)]) {
        out.push(await p.then(() => "ok", (e: Error) => e.message));
      }
      return out;
    });
    expect(results).toEqual([expect.stringMatching(/WIM_RELAY_URLS/), expect.stringMatching(/WIM_RELAY_URLS/)]);
    s.close();
  });
});
