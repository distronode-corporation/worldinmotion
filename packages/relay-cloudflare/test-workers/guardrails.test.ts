import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { LIMITS, sealBlob } from "@worldinmotion/protocol";
import { RELAY_VERSION } from "@worldinmotion/relay-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { MeshDurableObject, STALE_MS, type Attachment } from "../src/index.ts";
import { bindings, clock, createMesh, createWith, meshStub, ORIGIN, RELAY, registered, Session, Socket } from "./helpers.ts";

const DAY = 86_400_000;

beforeEach(() => clock.install());
afterEach(() => vi.restoreAllMocks());

async function idleRow(mesh: string): Promise<string | undefined> {
  return runInDurableObject(meshStub(mesh), (_o, state) => {
    const rows = state.storage.sql.exec<{ v: string }>("SELECT v FROM cf_host WHERE k = 'idle'").toArray();
    return rows[0]?.v;
  });
}

async function drained(mesh: string): Promise<void> {
  await vi.waitFor(async () => expect(await runInDurableObject(meshStub(mesh), (_o, st) => st.getWebSockets().length)).toBe(0));
}

describe("GET /v1/info", () => {
  const info = async (vars: Record<string, string>, path = "/v1/info", method = "GET") => {
    const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method }), { ...bindings, WIM_RELAY_URLS: RELAY, ...vars });
    return { status: res.status, type: res.headers.get("content-type"), body: await res.json() };
  };

  it("describes the relay with no secret and no live count, with or without a path prefix", async () => {
    const vars = { WIM_CREATE_KEY: "s3cret", WIM_MAX_MESHES: "2000", WIM_IDLE_MESH_DAYS: "90", WIM_BLOB_BYTES_PER_MESH_PER_DAY: "25MiB", WIM_OFFER: " Free during the preview " };
    const doc = {
      v: 1,
      software: "worldinmotion-relay",
      version: RELAY_VERSION,
      create: "key",
      limits: { max_meshes: 2000, idle_mesh_days: 90, blob_bytes_per_mesh_per_day: 25 * 1024 * 1024 },
      offer: "Free during the preview",
    };
    expect(await info(vars)).toEqual({ status: 200, type: "application/json", body: doc });
    expect((await info(vars, "/relay/v1/info")).body).toEqual(doc);
    expect(JSON.stringify(await info(vars))).not.toContain("s3cret");
    expect((await info(vars, "/v1/info", "POST")).status).toBe(404);
  });

  it("says closed, unlimited and no offer by default, and closed when misconfigured", async () => {
    expect((await info({})).body).toEqual({
      v: 1,
      software: "worldinmotion-relay",
      version: RELAY_VERSION,
      create: "closed",
      limits: { max_meshes: null, idle_mesh_days: null, blob_bytes_per_mesh_per_day: LIMITS.blobBytesPerMeshPerDay },
      offer: null,
    });
    expect((await info({ WIM_OPEN_CREATE: "1" })).body).toMatchObject({ create: "open" });
    expect((await info({ WIM_OPEN_CREATE: "1", WIM_OFFER: "x".repeat(281) })).body).toMatchObject({ create: "closed", offer: null });
  });
});

describe("the mesh cap", () => {
  it("counts each mesh created, refuses create with full at the cap, and gives back a reservation that did not create", async () => {
    await createMesh();
    const before = await registered();
    expect(before).toBeGreaterThan(0);
    const { answer } = await createWith({ WIM_OPEN_CREATE: "1", WIM_MAX_MESHES: String(before + 1) });
    expect(answer).toMatchObject({ t: "roster" });
    expect(await registered()).toBe(before + 1);
    const full = await createWith({ WIM_OPEN_CREATE: "1", WIM_MAX_MESHES: String(before + 1) });
    expect(full.answer).toEqual({ t: "error", code: "full", message: "this relay holds as many meshes as it accepts; try again later", ref: "create" });
    // A create that fails after the reservation (here an invalid roster) gives the place back.
    const invalid = await createWith({ WIM_OPEN_CREATE: "1" }, () => ({ t: "create", roster: { ...(answer["chain"] as unknown[])[0] as object, at: 1 } }));
    expect(invalid.answer).toMatchObject({ t: "error", ref: "create" });
    expect(await registered()).toBe(before + 1);
  });
});

describe("idle mesh expiry (30 days in the test config)", () => {
  it("starts when the last session leaves, is cancelled by the next one, and then deletes the mesh", async () => {
    const m = await createMesh();
    const root = new Session(m.mesh, m.admin, "root");
    await root.connect(m.genesis);
    expect(await idleRow(m.mesh)).toBeUndefined();
    root.sock.close();
    m.sock.close();
    await drained(m.mesh);
    const since = Number(await idleRow(m.mesh));
    expect(since).toBeGreaterThan(Date.now() - 5_000);
    // An alarm is armed no later than the expiry (earlier ones sweep the store on the way).
    expect(await runInDurableObject(meshStub(m.mesh), (_o, st) => st.storage.getAlarm())).toBeLessThanOrEqual(since + 30 * DAY);

    // A session coming back cancels it; leaving again starts it afresh.
    clock.advance(10 * DAY);
    const again = new Session(m.mesh, m.admin, "again");
    await again.connect(m.genesis);
    expect(await idleRow(m.mesh)).toBeUndefined();
    again.sock.close();
    await drained(m.mesh);
    const restart = Number(await idleRow(m.mesh));
    expect(restart).toBeGreaterThanOrEqual(since + 10 * DAY);

    // A new instance (after an eviction) reads the idle time back rather than starting it again.
    await evictDurableObject(meshStub(m.mesh));
    // A socket that never authenticates does not keep the mesh; it is closed with it.
    const waiting = await Socket.open(m.mesh);
    await waiting.next("hello");
    const count = await registered();
    clock.advance(30 * DAY + 1_000);
    expect(await runDurableObjectAlarm(meshStub(m.mesh))).toBe(true);
    expect(await waiting.closedWith()).toEqual({ code: 1001, reason: "mesh expired" });
    expect(await registered()).toBe(count - 1);
    const tables = await runInDurableObject(meshStub(m.mesh), (_o, st) =>
      st.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray(),
    );
    expect(tables).toEqual([]);
    // The mesh is gone: its devices must create a new one.
    const late = new Session(m.mesh, m.admin, "late");
    const sock = await Socket.open(m.mesh);
    sock.send(late.authFrame((await sock.next("hello"))["nonce"] as string, m.genesis));
    expect(await sock.next("error")).toMatchObject({ code: "unauthorized", message: "unknown mesh" });
  });

  it("does not expire a mesh while a session is online", async () => {
    const m = await createMesh();
    m.sock.close();
    const root = new Session(m.mesh, m.admin, "root");
    await root.connect(m.genesis);
    clock.advance(31 * DAY);
    // Keep the session from looking stale to the keepalive sweep.
    await root.sock.ask({ t: "peers" }, "peers");
    expect(await runDurableObjectAlarm(meshStub(m.mesh))).toBe(true);
    expect(await root.sock.ask({ t: "peers" }, "peers")).toMatchObject({ t: "peers" });
  });
});

describe("keepalives", () => {
  it("answers the client's exact ping bytes with the relay's exact pong without running the object", async () => {
    const m = await createMesh();
    const root = new Session(m.mesh, m.admin, "root");
    await root.connect(m.genesis);
    const raw: string[] = [];
    root.sock.ws.addEventListener("message", (e) => void raw.push(e.data as string));
    // packages/client/src/wire.ts sends JSON.stringify({ t: "ping" }).
    root.sock.send(JSON.stringify({ t: "ping" }));
    expect(await root.sock.next("pong")).toEqual({ t: "pong" });
    expect(raw.filter((r) => r.includes("pong"))).toEqual(['{"t":"pong"}']);
    const stamps = await runInDurableObject(meshStub(m.mesh), (_o, st) => st.getWebSockets().map((ws) => st.getWebSocketAutoResponseTimestamp(ws)));
    expect(stamps.filter((d) => d !== null)).toHaveLength(1);
  });

  it("closes an authenticated socket that has sent nothing, not even a ping, for STALE_MS", async () => {
    const m = await createMesh();
    m.sock.close();
    const quiet = new Session(m.mesh, m.admin, "quiet");
    await quiet.connect(m.genesis);
    const talker = new Session(m.mesh, m.admin, "talker");
    await talker.connect(m.genesis);
    const pinger = new Session(m.mesh, m.admin, "pinger");
    await pinger.connect(m.genesis);
    clock.advance(STALE_MS + 1_000);
    await talker.sock.ask({ t: "peers" }, "peers");
    await runInDurableObject(meshStub(m.mesh), (_o, st) => {
      // The pinger's pings were answered by the runtime just now.
      vi.spyOn(st, "getWebSocketAutoResponseTimestamp").mockImplementation((ws) =>
        (ws.deserializeAttachment() as Attachment).state.name === "pinger" ? new Date(Date.now()) : null,
      );
    });
    expect(await runDurableObjectAlarm(meshStub(m.mesh))).toBe(true);
    expect(await quiet.sock.closedWith()).toEqual({ code: 1001, reason: "no keepalive" });
    const offline = await talker.sock.next((f) => f["t"] === "peer" && f["peer"]["status"] === "offline");
    expect(offline["peer"]["address"]).toBe("quiet@admin");
    expect(await talker.sock.ask({ t: "peers" }, "peers")).toMatchObject({ t: "peers" });
    expect(await pinger.sock.ask({ t: "peers" }, "peers")).toMatchObject({ t: "peers" });
  });
});

describe("keepalives after a wake", () => {
  it("counts the wake as the last sign of life for a socket kept through an eviction", async () => {
    const m = await createMesh();
    m.sock.close();
    const root = new Session(m.mesh, m.admin, "root");
    await root.connect(m.genesis);
    clock.advance(STALE_MS + 1_000);
    await evictDurableObject(meshStub(m.mesh));
    expect(await runDurableObjectAlarm(meshStub(m.mesh))).toBe(true);
    expect(await root.sock.ask({ t: "peers" }, "peers")).toMatchObject({ t: "peers" });
  });
});

describe("with idle expiry off", () => {
  it("leaves no alarm once nothing is pending", async () => {
    const m = await createMesh();
    const root = new Session(m.mesh, m.admin, "root");
    await root.connect(m.genesis);
    root.sock.send({ t: "bye", ended: true });
    await root.sock.closedWith().catch(() => undefined);
    m.sock.close();
    await drained(m.mesh);
    clock.advance(2 * DAY);
    const alarm = await runInDurableObject(meshStub(m.mesh), async (_o, state) => {
      const plain = new MeshDurableObject(state, { ...bindings, WIM_RELAY_URLS: RELAY, WIM_OPEN_CREATE: "1" });
      await state.storage.deleteAlarm();
      await plain.alarm();
      return state.storage.getAlarm();
    });
    expect(alarm).toBeNull();
  });
});

describe("lower file limits", () => {
  it("refuses a chunk past WIM_BLOB_BYTES_PER_MESH_PER_DAY with blob_quota", async () => {
    const m = await createMesh();
    const root = new Session(m.mesh, m.admin, "root");
    await root.connect(m.genesis);
    const sealed = sealBlob(new Uint8Array([1, 2, 3]));
    const c = sealed.chunks[0]!;
    const put = JSON.stringify({ t: "blob.put", blob: sealed.blob, index: 0, last: c.last, n: c.n, data: c.data });
    await runInDurableObject(meshStub(m.mesh), async (_o, state) => {
      const { MeshDurableObject } = await import("../src/index.ts");
      const low = new MeshDurableObject(state, { ...env, WIM_BLOB_BYTES_PER_MESH_PER_DAY: "8" });
      const ws = state.getWebSockets().find((w) => (w.deserializeAttachment() as Attachment).state.name === "root")!;
      await low.webSocketMessage(ws, put);
    });
    expect(await root.sock.next("error")).toEqual({
      t: "error",
      code: "blob_quota",
      message: "this mesh's daily file allowance is used up; it refills over the day",
      ref: "blob.put",
    });
    // The relay's own instance, at the protocol limit, stores it.
    root.sock.send(put);
    expect(await root.sock.next("blob.stored")).toMatchObject({ blob: sealed.blob, index: 0 });
  });
});

describe("a hostile pre-auth frame", () => {
  it("is answered as malformed and the Durable Object keeps serving other sockets", async () => {
    const m = await createMesh();
    const root = new Session(m.mesh, m.admin, "root");
    await root.connect(m.genesis);
    const evil = await Socket.open(m.mesh);
    await evil.next("hello");
    // A value whose length cannot convert to a primitive once threw inside the frame parser and
    // escaped the object's webSocketMessage event, before any authentication or rate limit.
    evil.send({ t: "auth", mesh: { valueOf: 1, toString: 1 } });
    expect(await evil.next("error")).toMatchObject({ code: "malformed" });
    expect((await evil.closedWith()).code).toBe(4008);
    // The object is still up: the authenticated session still gets its peers answer.
    expect(await root.sock.ask({ t: "peers" }, "peers")).toMatchObject({ t: "peers" });
  });
});
