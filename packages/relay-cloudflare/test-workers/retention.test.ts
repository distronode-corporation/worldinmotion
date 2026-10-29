import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { LIMITS } from "@worldinmotion/protocol";
import { HISTORY_SWEEP_BATCH, migrate, RETENTION_MS, SqlStore } from "@worldinmotion/relay-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doSqlDb, MIN_ALARM_MS, nextStoreDue } from "../src/index.ts";
import { clock, createMesh, meshId, meshStub, Session } from "./helpers.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function alarmAt(mesh: string): Promise<number | null> {
  return runInDurableObject(meshStub(mesh), (_o, state) => state.storage.getAlarm());
}

async function historyRows(mesh: string): Promise<number> {
  return runInDurableObject(meshStub(mesh), (_o, state) => Number(state.storage.sql.exec("SELECT COUNT(*) AS n FROM room_history").one()["n"]));
}

beforeEach(() => clock.install());
afterEach(() => vi.restoreAllMocks());

describe("room history retention", () => {
  it("falls due exactly 72 hours after a row was stored", async () => {
    const mesh = meshId();
    const at = Date.now();
    const due = await runInDurableObject(meshStub(mesh), (_o, state) => {
      const db = doSqlDb(state.storage.sql);
      migrate(db);
      new SqlStore(db, mesh).addHistory({ room: "#log", cur: 1, at, msg: "{}" }, 100);
      const d = nextStoreDue(db, mesh, { ...LIMITS });
      state.storage.sql.exec("DELETE FROM room_history");
      return d;
    });
    expect(RETENTION_MS).toBe(72 * HOUR);
    expect(due).toBe(at + RETENTION_MS);
  });

  it("sweeps history an older version kept for 7 days in batches on the first alarms after the upgrade, and never serves it", async () => {
    const m = await createMesh();
    m.sock.close();
    const root = new Session(m.mesh, m.admin, "root");
    await root.connect(m.genesis);
    await root.sock.ask({ t: "room.join", room: "#log" }, "room.joined");
    await root.sock.ask(root.seal(m.genesis, ["#log"], [m.admin.id]), "sent");

    // What the previous version left: history up to 7 days old, more than one sweep deletes,
    // spread over rooms, and one expired row in the room a client reads.
    const old = Date.now() - 4 * DAY;
    const backlog = HISTORY_SWEEP_BATCH + 10;
    await runInDurableObject(meshStub(m.mesh), (_o, state) => {
      const store = new SqlStore(doSqlDb(state.storage.sql), m.mesh);
      for (let i = 0; i < backlog; i++) store.addHistory({ room: `#r${i % 4}`, cur: 1 + i, at: old + i, msg: "{}" }, 1000);
      store.addHistory({ room: "#log", cur: 0, at: old, msg: "{}" }, 1000);
    });
    expect(await historyRows(m.mesh)).toBe(backlog + 2);

    // Before any sweep runs, a reader gets only the live message, and is told nothing is older.
    expect(await root.sock.ask({ t: "room.history", room: "#log" }, "room.history")).toMatchObject({ msgs: [{ cursor: 1 }], more: false });

    // The first alarm deletes one batch, the oldest first, and comes back at once for the rest.
    expect(await runDurableObjectAlarm(meshStub(m.mesh))).toBe(true);
    expect(await historyRows(m.mesh)).toBe(backlog + 2 - HISTORY_SWEEP_BATCH);
    expect((await alarmAt(m.mesh))! - Date.now()).toBeLessThanOrEqual(MIN_ALARM_MS + 50);
    clock.advance(MIN_ALARM_MS);
    expect(await runDurableObjectAlarm(meshStub(m.mesh))).toBe(true);
    expect(await historyRows(m.mesh)).toBe(1);

    // The live message goes 72 hours after it was sent.
    clock.advance(RETENTION_MS - MIN_ALARM_MS - 1_000);
    expect(await runDurableObjectAlarm(meshStub(m.mesh))).toBe(true);
    expect(await historyRows(m.mesh)).toBe(1);
    clock.advance(1_000);
    expect(await runDurableObjectAlarm(meshStub(m.mesh))).toBe(true);
    expect(await historyRows(m.mesh)).toBe(0);
  });
});
