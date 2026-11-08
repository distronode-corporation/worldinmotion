import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { LIMITS } from "@worldinmotion/protocol";
import { migrate, SqlStore, type SessionRow } from "@worldinmotion/relay-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doSqlDb, nextStoreDue } from "../src/index.ts";
import { clock, createMesh, meshId, meshStub, Session } from "./helpers.ts";

const GRACE = LIMITS.idleOfflineGraceMs;

async function alarmAt(mesh: string): Promise<number | null> {
  return runInDurableObject(meshStub(mesh), (_o, state) => state.storage.getAlarm());
}

const row = (sid: string, since: number, extra: Partial<SessionRow> = {}): SessionRow => ({
  sid,
  device: "d",
  name: sid.toLowerCase(),
  kind: "cli",
  status: "idle",
  since,
  conn: null,
  ended: null,
  resume: "",
  acked: 0,
  delivered: 0,
  nextCursor: 1,
  ci: false,
  ...extra,
});

beforeEach(() => clock.install());
afterEach(() => vi.restoreAllMocks());

describe("idle notices on the Workers relay (SPEC section 8)", () => {
  it("falls due the grace period after an offline session with an armed notice went offline, and only then", async () => {
    const mesh = meshId();
    const at = Date.now();
    const due = await runInDurableObject(meshStub(mesh), (_o, state) => {
      const db = doSqlDb(state.storage);
      migrate(db);
      const store = new SqlStore(db, mesh);
      const L = { ...LIMITS, idleNoticeLifetimeMs: 100 * GRACE };
      // Online, ended, unwatched or watched by a fired row only: none of these is due for the grace.
      store.putSession(row("A", at, { conn: "c1" }));
      store.putSession(row("B", at - 5, { ended: at - 5 }));
      store.putSession(row("C", at - 10));
      store.putSession(row("D", at - 20));
      store.putIdle({ sub: "A", target: "A", exp: at + L.idleNoticeLifetimeMs, fired: null });
      store.putIdle({ sub: "A", target: "D", exp: at + L.idleNoticeLifetimeMs, fired: "idle" });
      const before = nextStoreDue(db, mesh, L);
      store.putIdle({ sub: "A", target: "C", exp: at + L.idleNoticeLifetimeMs, fired: null });
      const after = nextStoreDue(db, mesh, L);
      state.storage.deleteAll();
      return { before, after };
    });
    // Without the grace row, the next thing due is a session's abandonment or a tombstone.
    expect(due.before).toBeGreaterThan(at + GRACE);
    expect(due.after).toBe(at - 10 + GRACE);
  });

  it("fires for a session gone offline while nobody is connected, and hands the notice over at the watcher's next ready", async () => {
    const m = await createMesh();
    m.sock.close();
    const root = new Session(m.mesh, m.admin, "root");
    await root.connect(m.genesis);
    const worker = new Session(m.mesh, m.admin, "worker");
    await worker.connect(m.genesis);
    expect(await root.sock.ask({ t: "notify_idle", of: worker.address }, "idle.armed")).toMatchObject({ of: worker.address });
    // The worker reports a turn: its row is marked for everyone else.
    worker.sock.send({ t: "presence", status: "busy" });
    expect((await root.sock.next((f) => f["t"] === "peer" && f["peer"]["presence"] === true))["peer"]).toMatchObject({ address: worker.address, status: "busy" });
    worker.sock.close();
    await root.sock.next((f) => f["t"] === "peer" && f["peer"]["status"] === "offline");
    const gone = Date.now();
    root.sock.close();
    await vi.waitFor(async () => expect(await runInDurableObject(meshStub(m.mesh), (_o, st) => st.getWebSockets().length)).toBe(0));
    // With no socket open there is no heartbeat: the alarm is set for the end of the grace.
    expect(await runDurableObjectAlarm(meshStub(m.mesh))).toBe(true);
    const due = (await alarmAt(m.mesh))!;
    expect(due).toBeGreaterThanOrEqual(gone + GRACE - 50);
    expect(due).toBeLessThanOrEqual(gone + GRACE + 50);
    clock.advance(GRACE + 1_000);
    expect(await runDurableObjectAlarm(meshStub(m.mesh))).toBe(true);
    const kept = await runInDurableObject(meshStub(m.mesh), (_o, st) => st.storage.sql.exec("SELECT fired FROM idle").toArray());
    expect(kept).toEqual([{ fired: "offline" }]);
    await root.connect(m.genesis);
    expect(await root.sock.next("notice")).toEqual({ t: "notice", kind: "idle", of: worker.address, why: "offline" });
  });
});
