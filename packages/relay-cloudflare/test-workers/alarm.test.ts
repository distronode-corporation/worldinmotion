import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { leaseKey, nextRoster, type Roster } from "@worldinmotion/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_MS, MIN_ALARM_MS } from "../src/index.ts";
import { clock, createMesh, dev, meshId, meshStub, Session, Socket } from "./helpers.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function alarmAt(mesh: string): Promise<number | null> {
  return runInDurableObject(meshStub(mesh), (_o, state) => state.storage.getAlarm());
}

async function count(mesh: string, table: string): Promise<number> {
  return runInDurableObject(meshStub(mesh), (_o, state) => Number(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one()["n"]));
}

beforeEach(() => clock.install());
afterEach(() => vi.restoreAllMocks());

describe("the alarm", () => {
  it("is armed for a pre-auth deadline and closes a socket that never authenticates", async () => {
    const mesh = meshId();
    const s = await Socket.open(mesh);
    const hello = await s.next("hello");
    const due = await alarmAt(mesh);
    // The deadline is 10 seconds after hello, well before the heartbeat.
    expect(due).toBeGreaterThanOrEqual((hello["at"] as number) + 10_000 - 5);
    expect(due).toBeLessThanOrEqual((hello["at"] as number) + 10_000 + 50);
    clock.advance(11_000);
    expect(await runDurableObjectAlarm(meshStub(mesh))).toBe(true);
    expect(await s.closedWith()).toEqual({ code: 4001, reason: "auth timeout" });
  });

  it("beats every minute while sockets are open, and leaves no alarm once nothing is pending", async () => {
    const m = await createMesh();
    m.sock.close();
    const root = new Session(m.mesh, m.admin, "root");
    await root.connect(m.genesis);
    expect(await runDurableObjectAlarm(meshStub(m.mesh))).toBe(true);
    const now = Date.now();
    const beat = (await alarmAt(m.mesh))!;
    expect(beat).toBeGreaterThan(now);
    expect(beat).toBeLessThanOrEqual(now + HEARTBEAT_MS + 50);

    // An event never pushes an armed alarm later.
    await root.sock.ask({ t: "peers" }, "peers");
    expect(await alarmAt(m.mesh)).toBe(beat);

    // The session says bye: its tombstone is the only thing left, due a queue lifetime later.
    root.sock.send({ t: "bye", ended: true });
    await root.sock.closedWith().catch(() => undefined);
    root.sock.close();
    await vi.waitFor(async () => expect(await runInDurableObject(meshStub(m.mesh), (_o, st) => st.getWebSockets().length)).toBe(0));
    expect(await runDurableObjectAlarm(meshStub(m.mesh))).toBe(true);
    const tomb = (await alarmAt(m.mesh))!;
    expect(tomb).toBeGreaterThan(Date.now() + DAY - 5_000);
    clock.advance(DAY + 1_000);
    expect(await runDurableObjectAlarm(meshStub(m.mesh))).toBe(true);
    expect(await count(m.mesh, "sessions")).toBe(0);
    // All that is left is the idle expiry (30 days in the test config), counted from the bye.
    const idle = (await alarmAt(m.mesh))!;
    expect(idle).toBeGreaterThan(Date.now() + 28 * DAY);
    expect(idle).toBeLessThanOrEqual(Date.now() + 29 * DAY);
  });

  it("expires a lease and hands it to the next waiter", async () => {
    const m = await createMesh();
    m.sock.close();
    const root = new Session(m.mesh, m.admin, "root");
    await root.connect(m.genesis);
    const other = new Session(m.mesh, m.admin, "other");
    await other.connect(m.genesis);
    const key = leaseKey(m.mesh, "deploy");
    // Long enough that the runtime's own alarm does not fire during the test; the clock jumps instead.
    const granted = await root.sock.ask({ t: "lease.acquire", key, ttl: 30_000 }, "lease");
    expect(granted).toMatchObject({ key, status: "granted" });
    // A waiting acquire gets no answer until the lease frees.
    other.sock.send({ t: "lease.acquire", key, ttl: 60_000, wait: true });
    await other.sock.ask({ t: "peers" }, "peers");
    expect(other.sock.frames.filter((f) => f["t"] === "lease")).toEqual([]);
    // Events only move the alarm earlier, so the one armed for the create socket's deadline is
    // still set; it is early, which is harmless. Once it runs, it re-arms exactly for the lease.
    expect((await alarmAt(m.mesh))!).toBeLessThanOrEqual(granted["until"] as number);
    expect(await runDurableObjectAlarm(meshStub(m.mesh))).toBe(true);
    expect(await alarmAt(m.mesh)).toBe(granted["until"]);

    clock.advance(31_000);
    expect(await runDurableObjectAlarm(meshStub(m.mesh))).toBe(true);
    expect(await root.sock.next("lease")).toMatchObject({ key, status: "expired" });
    expect(await other.sock.next("lease")).toMatchObject({ key, status: "granted", holder: "other@admin" });
  });

  it("sweeps a queued message's expiry while no socket is open, then the abandoned sessions", async () => {
    const m = await createMesh();
    m.sock.close();
    const laptop = dev("laptop");
    const root = new Session(m.mesh, m.admin, "root");
    await root.connect(m.genesis);
    const r2: Roster = nextRoster(m.genesis, { add: [laptop.record] }, m.admin, Date.now());
    await root.sock.ask({ t: "roster.publish", roster: r2 }, "roster");
    const writer = new Session(m.mesh, laptop, "writer");
    await writer.connect(r2);
    writer.sock.close();
    await root.sock.next((f) => f["t"] === "peer" && f["peer"]["status"] === "offline");
    const f = root.seal(r2, [writer.address], [laptop.id]);
    expect(await root.sock.ask(f, "sent")).toMatchObject({ results: [{ status: "queued" }] });
    root.sock.close();
    await vi.waitFor(async () => expect(await runInDurableObject(meshStub(m.mesh), (_o, st) => st.getWebSockets().length)).toBe(0));
    expect(await count(m.mesh, "queue")).toBe(1);

    // With no socket open the alarm runs only for what the store holds: about a day out.
    expect(await runDurableObjectAlarm(meshStub(m.mesh))).toBe(true);
    const due = (await alarmAt(m.mesh))!;
    expect(due).toBeGreaterThan(Date.now() + DAY - 10_000);
    expect(due).toBeLessThanOrEqual(Date.now() + DAY);

    clock.advance(DAY + 1_000);
    expect(await runDurableObjectAlarm(meshStub(m.mesh))).toBe(true);
    expect(await count(m.mesh, "queue")).toBe(0);
    expect(await count(m.mesh, "messages")).toBe(0);
    // The writer's session outlived its queue by one sweep; the minimum step brings it soon.
    const soon = (await alarmAt(m.mesh))!;
    expect(soon - Date.now()).toBeLessThanOrEqual(MIN_ALARM_MS + 50);
    clock.advance(MIN_ALARM_MS);
    expect(await runDurableObjectAlarm(meshStub(m.mesh))).toBe(true);
    expect(await count(m.mesh, "sessions")).toBe(0);
  });
});

describe("socket events", () => {
  it("closes a socket that sends a binary frame and takes its session offline", async () => {
    const m = await createMesh();
    const root = new Session(m.mesh, m.admin, "root");
    await root.connect(m.genesis);
    const other = new Session(m.mesh, m.admin, "other");
    await other.connect(m.genesis);
    other.sock.ws.send(new Uint8Array([1, 2, 3]));
    expect(await other.sock.closedWith()).toEqual({ code: 1003, reason: "text frames only" });
    const peer = await root.sock.next((f) => f["t"] === "peer" && f["peer"]["status"] === "offline");
    expect(peer["peer"]["address"]).toBe("other@admin");
  });

  it("treats a socket error like a close", async () => {
    const m = await createMesh();
    const root = new Session(m.mesh, m.admin, "root");
    await root.connect(m.genesis);
    const other = new Session(m.mesh, m.admin, "other");
    await other.connect(m.genesis);
    await runInDurableObject(meshStub(m.mesh), async (o, state) => {
      const ws = state.getWebSockets().find((w) => (w.deserializeAttachment() as { state: { name: string | null } }).state.name === "other")!;
      await o.webSocketError(ws, new Error("reset"));
    });
    const peer = await root.sock.next((f) => f["t"] === "peer" && f["peer"]["status"] === "offline");
    expect(peer["peer"]["address"]).toBe("other@admin");
  });
});
