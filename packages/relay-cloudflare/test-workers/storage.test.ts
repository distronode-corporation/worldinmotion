import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { createGenesisRoster, generateDeviceKeys, hash, signRecoverAuth } from "@worldinmotion/protocol";
import { migrate } from "@worldinmotion/relay-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doSqlDb } from "../src/index.ts";
import { clock, createMesh, dev, meshId, meshStub, RELAY, Session, Socket } from "./helpers.ts";

/** The object's own SQLite tables (the runtime's `_cf_` tables are not the relay's). */
async function tables(mesh: string): Promise<string[]> {
  return runInDurableObject(meshStub(mesh), (_o, state) =>
    state.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name")
      .toArray()
      .map((r) => r.name),
  );
}

async function alarmAt(mesh: string): Promise<number | null> {
  return runInDurableObject(meshStub(mesh), (_o, state) => state.storage.getAlarm());
}

/** Waits until the object has no socket left (the runtime delivers the close a little later). */
async function drained(mesh: string): Promise<void> {
  await vi.waitFor(async () => expect(await runInDurableObject(meshStub(mesh), (_o, st) => st.getWebSockets().length)).toBe(0));
}

beforeEach(() => clock.install());
afterEach(() => vi.restoreAllMocks());

describe("a mesh id that was only dialled", () => {
  it("writes no SQLite state while its socket is open, and keeps nothing once it closes", async () => {
    const mesh = meshId();
    const s = await Socket.open(mesh);
    await s.next("hello");
    expect(await tables(mesh)).toEqual([]);
    s.close();
    await drained(mesh);
    expect(await tables(mesh)).toEqual([]);
    expect(await alarmAt(mesh)).toBeNull();
  });

  it("stores nothing for frames that do not create the mesh: a failed create, join, auth or recovery", async () => {
    const mesh = meshId();
    const s = await Socket.open(mesh);
    const nonce = (await s.next("hello"))["nonce"] as string;
    const other = createGenesisRoster({ name: "admin", keys: generateDeviceKeys(), now: Date.now(), meshId: meshId() });
    expect(await s.ask({ t: "create", roster: other }, "error")).toMatchObject({ code: "malformed", ref: "create" });
    const keys = generateDeviceKeys();
    const genesis = createGenesisRoster({ name: "admin", keys, now: Date.now(), meshId: mesh });
    s.send(signRecoverAuth({ relay: RELAY, mesh, nonce, at: Date.now(), genesis: hash(genesis) }, keys));
    expect(await s.next("error")).toMatchObject({ code: "unauthorized", message: "unknown mesh" });
    expect(await tables(mesh)).toEqual([]);
    const late = new Session(mesh, dev("admin", "admin"), "root");
    const sock = await Socket.open(mesh);
    sock.send(late.authFrame((await sock.next("hello"))["nonce"] as string, genesis));
    expect(await sock.next("error")).toMatchObject({ code: "unauthorized", message: "unknown mesh" });
    expect(await tables(mesh)).toEqual([]);
  });

  it("is cleaned up by the alarm that closes its unauthenticated socket, after an eviction too", async () => {
    const mesh = meshId();
    const s = await Socket.open(mesh);
    await s.next("hello");
    expect(await alarmAt(mesh)).not.toBeNull();
    await evictDurableObject(meshStub(mesh));
    clock.advance(11_000);
    expect(await runDurableObjectAlarm(meshStub(mesh))).toBe(true);
    expect(await s.closedWith()).toEqual({ code: 4001, reason: "auth timeout" });
    expect(await tables(mesh)).toEqual([]);
    expect(await alarmAt(mesh)).toBeNull();
  });

  it("clears an alarm left on an object with no mesh and no socket", async () => {
    const mesh = meshId();
    await runInDurableObject(meshStub(mesh), (_o, state) => state.storage.setAlarm(Date.now() + 1_000));
    expect(await runDurableObjectAlarm(meshStub(mesh))).toBe(true);
    expect(await alarmAt(mesh)).toBeNull();
    expect(await tables(mesh)).toEqual([]);
  });

  it("deletes the tables and cf_host row an earlier version wrote on every dial", async () => {
    const mesh = meshId();
    await runInDurableObject(meshStub(mesh), (_o, state) => {
      const db = doSqlDb(state.storage.sql);
      migrate(db);
      db.exec("CREATE TABLE IF NOT EXISTS cf_host (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
      db.exec("INSERT INTO cf_host (k, v) VALUES ('mesh', ?)", mesh);
    });
    expect(await tables(mesh)).toContain("cf_host");
    const s = await Socket.open(mesh);
    await s.next("hello");
    s.close();
    await drained(mesh);
    expect(await tables(mesh)).toEqual([]);
  });
});

describe("a mesh that is created", () => {
  it("moves into SQLite on create, with the mesh id from the path, and keeps it after every socket closes", async () => {
    const m = await createMesh();
    expect(await tables(m.mesh)).toEqual(expect.arrayContaining(["cf_host", "rosters", "sessions"]));
    const stored = await runInDurableObject(meshStub(m.mesh), (_o, state) => state.storage.sql.exec("SELECT v FROM cf_host WHERE k = 'mesh'").one()["v"]);
    expect(stored).toBe(m.mesh);
    // The socket that created it authenticates on the relay now built over SQLite.
    const root = new Session(m.mesh, m.admin, "root");
    expect(await root.connect(m.genesis)).toMatchObject({ t: "ready", name: "root" });
    m.sock.close();
    root.sock.close();
    await drained(m.mesh);
    expect(await tables(m.mesh)).toContain("rosters");
    const again = new Session(m.mesh, m.admin, "again");
    expect(await again.connect(m.genesis)).toMatchObject({ t: "ready" });
  });

  it("can be created on a socket that waited through an eviction before the mesh existed", async () => {
    const mesh = meshId();
    const admin = dev("admin", "admin");
    const genesis = createGenesisRoster({ name: "admin", keys: admin.keys, now: Date.now(), meshId: mesh });
    const s = await Socket.open(mesh);
    const nonce = (await s.next("hello"))["nonce"] as string;
    await evictDurableObject(meshStub(mesh));
    expect(await s.ask({ t: "create", roster: genesis }, "roster")).toEqual({ t: "roster", chain: [genesis], more: false });
    const root = new Session(mesh, admin, "root");
    expect(await root.connect(genesis, { sock: s, nonce })).toMatchObject({ t: "ready", name: "root" });
  });
});
