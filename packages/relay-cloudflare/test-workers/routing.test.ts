import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Attachment } from "../src/index.ts";
import { MESH_HEADER, SOURCE_HEADER } from "../src/mesh.ts";
import * as entry from "../src/worker.ts";
import { b64u } from "@worldinmotion/protocol";
import { REGISTRY_NAME, sourceSecret } from "../src/index.ts";
import { meshId, meshStub, ORIGIN, Socket, sourceKeyOf } from "./helpers.ts";

async function attachments(mesh: string): Promise<Attachment[]> {
  return runInDurableObject(meshStub(mesh), (_o, state) => state.getWebSockets().map((ws) => ws.deserializeAttachment() as Attachment));
}

describe("routing", () => {
  it("answers GET /healthz with 200 and anything unknown with 404, as relay-node does", async () => {
    const health = await SELF.fetch(`${ORIGIN}/healthz`);
    expect(health.status).toBe(200);
    expect(health.headers.get("content-type")).toBe("application/json");
    expect(await health.json()).toEqual({ ok: true });
    for (const [method, path] of [
      ["POST", "/healthz"],
      ["GET", "/"],
      ["GET", "/v2/abc"],
      ["POST", `/v1/${meshId()}`],
    ] as const) {
      const res = await SELF.fetch(`${ORIGIN}${path}`, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
    }
  });

  it("refuses a mesh id that is not 16 bytes of canonical base64url with 400", async () => {
    for (const id of ["", "short", "A".repeat(23), "AAAAAAAAAAAAAAAAAAAAA!", "AAAAAAAAAAAAAAAAAAAAAB"]) {
      const res = await SELF.fetch(`${ORIGIN}/v1/${id}`, { headers: { upgrade: "websocket" } });
      expect(res.status, id).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid mesh id" });
    }
  });

  it("asks for a WebSocket upgrade on a mesh path with 426", async () => {
    const mesh = meshId();
    expect((await SELF.fetch(`${ORIGIN}/v1/${mesh}`)).status).toBe(426);
    expect((await SELF.fetch(`${ORIGIN}/v1/${mesh}`, { headers: { upgrade: "h2c" } })).status).toBe(426);
  });

  it("accepts a path prefix in front of /v1/<mesh id> and a mixed-case upgrade header", async () => {
    const mesh = meshId();
    const res = await SELF.fetch(`${ORIGIN}/relay/v1/${mesh}`, { headers: { upgrade: "WebSocket" } });
    expect(res.status).toBe(101);
    res.webSocket!.accept();
    res.webSocket!.close(1000, "done");
  });

  it("routes each mesh to its own Durable Object, which greets with hello", async () => {
    const a = meshId();
    const b = meshId();
    const sa = await Socket.open(a);
    const sb = await Socket.open(b);
    expect(await sa.next("hello")).toMatchObject({ t: "hello", v: 1 });
    expect(await sb.next("hello")).toMatchObject({ t: "hello", v: 1 });
    expect(await attachments(a)).toHaveLength(1);
    expect(await attachments(b)).toHaveLength(1);
  });
});

describe("source keys", () => {
  it("replaces a client's own source and mesh headers with the Worker's", async () => {
    const mesh = meshId();
    const s = await Socket.open(mesh, { "cf-connecting-ip": "203.0.113.7", [SOURCE_HEADER]: "forged", [MESH_HEADER]: "forged" });
    await s.next("hello");
    const [att] = await attachments(mesh);
    // The relay-core keyed hash of CF-Connecting-IP, as relay-node keys a socket address; never the raw address.
    expect(att!.state.source).toBe(await sourceKeyOf("203.0.113.7"));
    // The object serves the mesh id from the path, not the forged header.
    expect(att!.mesh).toBe(mesh);
  });

  it("uses the keyed hash of the empty string when the runtime gives no client address", async () => {
    const mesh = meshId();
    const res = await SELF.fetch(`${ORIGIN}/v1/${mesh}`, { headers: { upgrade: "websocket" } });
    res.webSocket!.accept();
    const [att] = await attachments(mesh);
    expect(att!.state.source).toBe(await sourceKeyOf(""));
    res.webSocket!.close(1000, "done");
  });

  it("keys sources with one random secret the registry keeps, read once per isolate", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName(REGISTRY_NAME));
    const secret = await registry.sourceSecret();
    expect(b64u.decode(secret)).toHaveLength(32);
    expect(await registry.sourceSecret()).toBe(secret);
    expect(await sourceSecret(env)).toBe(await sourceSecret(env));
  });

  it("refuses a request to the object that did not come through the Worker", async () => {
    const stub = meshStub(meshId());
    const cases: Record<string, string>[] = [
      {},
      { upgrade: "h2c", [SOURCE_HEADER]: "s", [MESH_HEADER]: "m" },
      { upgrade: "websocket", [MESH_HEADER]: "m" },
      { upgrade: "websocket", [SOURCE_HEADER]: "s" },
    ];
    for (const headers of cases) {
      const res = await stub.fetch(`${ORIGIN}/v1/x`, { headers });
      expect(res.status, JSON.stringify(headers)).toBe(400);
    }
  });
});

describe("the entry module", () => {
  it("exports only the handler and the Durable Object classes (the runtime refuses anything else)", () => {
    expect(Object.keys(entry).sort()).toEqual(["MeshDurableObject", "MeshRegistry", "RendezvousStore", "SourceLimiter", "default"]);
  });
});

describe("bindings", () => {
  it("has the relay URL placeholder from wrangler.jsonc, no create key, and open creation from the test config only", () => {
    expect(env.WIM_RELAY_URLS).toBe("wss://relay.example.com");
    expect(env.WIM_CREATE_KEY).toBeUndefined();
    expect(env.WIM_OPEN_CREATE).toBe("1");
  });
});
