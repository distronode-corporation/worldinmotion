import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { dropMesh, meshCount, migrate, SCHEMA_VERSION, SqlStore, type SessionRow } from "../src/index.ts";
import { positional } from "../src/sql-store.ts";
import { KINDS, makeStore, MESH, sqlDb } from "./helpers.ts";

const session = (sid: string, device = "dev"): SessionRow => ({
  sid,
  device,
  name: sid.toLowerCase(),
  kind: "cli",
  status: "idle",
  since: 0,
  conn: null,
  ended: null,
  resume: "r",
  acked: 0,
  delivered: 0,
  nextCursor: 1,
});

describe.each(KINDS)("store contract (%s)", (kind) => {
  it("deletes a session with everything keyed by it, and nothing else", () => {
    const s = makeStore(kind);
    s.putSession(session("A"));
    s.putSession(session("B"));
    s.putIdle({ sub: "A", target: "B", exp: 9 });
    s.putIdle({ sub: "B", target: "A", exp: 9 });
    s.putIdle({ sub: "B", target: "B", exp: 9 });
    s.putRoom({ room: "#r", created: 0, nextCursor: 1 });
    s.addMember("#r", "A");
    s.addMember("#r", "B");
    s.putLease({ key: "k1", holder: "A", token: 1, until: 9, granted: 0 });
    s.putLease({ key: "k2", holder: "B", token: 2, until: 9, granted: 0 });
    s.addWaiter({ key: "k2", sid: "A", ttl: 1, exp: 9 });
    s.addWaiter({ key: "k1", sid: "B", ttl: 1, exp: 9 });
    s.putWatch({ key: "k2", sid: "A", exp: 9 });
    s.putWatch({ key: "k1", sid: "B", exp: 9 });
    s.deleteSession("A");
    expect(s.getSession("A")).toBeUndefined();
    expect(s.idleFor("B")).toEqual([{ sub: "B", target: "B", exp: 9 }]);
    expect(s.members("#r")).toEqual(["B"]);
    expect(s.leases().map((l) => l.key)).toEqual(["k2"]);
    expect(s.waiters("k2")).toEqual([]);
    expect(s.waiters("k1").map((w) => w.sid)).toEqual(["B"]);
    expect(s.watchesFor("k2")).toEqual([]);
    expect(s.watchesBy("B")).toBe(1);
  });

  it("rekeys a session everywhere it appears", () => {
    const s = makeStore(kind);
    s.putSession(session("A"));
    s.putSession(session("B"));
    s.putIdle({ sub: "A", target: "B", exp: 9 });
    s.putIdle({ sub: "B", target: "A", exp: 9 });
    s.putMessage({ id: "m", sender: "A", at: 1, rcpts: ["A", "B"] });
    s.putRoom({ room: "#r", created: 0, nextCursor: 1 });
    s.addMember("#r", "A");
    s.putLease({ key: "k", holder: "A", token: 1, until: 9, granted: 0 });
    s.addWaiter({ key: "k", sid: "A", ttl: 1, exp: 9 });
    s.addWaiter({ key: "k", sid: "B", ttl: 1, exp: 9 });
    s.putWatch({ key: "k", sid: "A", exp: 9 });
    s.putWatch({ key: "k", sid: "B", exp: 9 });
    s.enqueue({ sid: "A", cur: 1, id: "m", fromDevice: "d", queuedAt: 1, bytes: 1, msg: "{}" });
    s.rekeySession("A", "Z");
    expect(s.getSession("Z")!.sid).toBe("Z");
    expect(s.queue("Z", 0)).toHaveLength(1);
    expect(s.getMessage("m")).toEqual({ id: "m", sender: "Z", at: 1, rcpts: ["Z", "B"] });
    expect(s.idleFor("B")).toEqual([{ sub: "Z", target: "B", exp: 9 }]);
    expect(s.idleFor("Z")).toEqual([{ sub: "B", target: "Z", exp: 9 }]);
    expect(s.roomsOf("Z")).toEqual(["#r"]);
    expect(s.getLease("k")!.holder).toBe("Z");
    expect(s.waiters("k").map((w) => w.sid)).toEqual(["Z", "B"]);
    expect(s.watchesFor("k").map((w) => w.sid).sort()).toEqual(["B", "Z"]);
  });

  it("keeps one wait per session and key, in arrival order", () => {
    const s = makeStore(kind);
    s.addWaiter({ key: "k", sid: "A", ttl: 1, exp: 5 });
    s.addWaiter({ key: "k", sid: "B", ttl: 1, exp: 9 });
    s.addWaiter({ key: "k", sid: "A", ttl: 2, exp: 9 });
    const ws = s.waiters("k");
    expect(ws.map((w) => [w.sid, w.ttl])).toEqual([
      ["A", 1],
      ["B", 1],
    ]);
    expect(ws[0]!.seq).toBeLessThan(ws[1]!.seq);
    expect(s.waitsBy("A")).toBe(1);
    expect(s.expiredWaiters(5).map((w) => w.sid)).toEqual(["A"]);
  });

  it("prunes rooms only when they have neither members nor history", () => {
    const s = makeStore(kind);
    for (const room of ["#members", "#history", "#empty"]) s.putRoom({ room, created: 0, nextCursor: 1 });
    s.addMember("#members", "A");
    s.addMember("#members", "A");
    s.addHistory({ room: "#history", cur: 1, at: 5, msg: "{}" }, 10);
    s.pruneRooms();
    expect(["#members", "#history", "#empty"].map((r) => s.getRoom(r) !== undefined)).toEqual([true, true, false]);
    expect(s.roomCount()).toBe(2);
    expect(s.members("#members")).toEqual(["A"]);
    s.pruneHistory(5);
    s.pruneRooms();
    expect(s.getRoom("#history")).toBeUndefined();
  });

  it("prunes watches, idle subscriptions, buckets and messages by time", () => {
    const s = makeStore(kind);
    s.putWatch({ key: "k", sid: "A", exp: 5 });
    s.putWatch({ key: "k", sid: "B", exp: 6 });
    s.pruneWatches(5);
    s.putIdle({ sub: "A", target: "B", exp: 5 });
    s.putIdle({ sub: "A", target: "C", exp: 6 });
    s.pruneIdle(5);
    expect(s.idleCount("A")).toBe(1);
    expect(s.watchesFor("k").map((w) => w.sid)).toEqual(["B"]);
    s.putBucket({ bkey: "x", tokens: 1.5, at: 5 });
    expect(s.getBucket("x")).toEqual({ bkey: "x", tokens: 1.5, at: 5 });
    s.pruneBuckets(5);
    expect(s.getBucket("x")).toBeUndefined();
    s.putMessage({ id: "m", sender: "A", at: 5, rcpts: ["B"] });
    s.pruneMessages(5);
    expect(s.getMessage("m")).toBeUndefined();
  });

  it("stores chunks with their last flag, and totals their bytes", () => {
    const s = makeStore(kind);
    s.putChunk({ blob: "b", idx: 0, last: false, n: "n", data: "d", bytes: 10, device: "x", at: 1 });
    s.putChunk({ blob: "b", idx: 1, last: true, n: "n", data: "d", bytes: 5, device: "y", at: 2 });
    expect(s.getChunk("b", 0)!.last).toBe(false);
    expect(s.getChunk("b", 1)!.last).toBe(true);
    expect(s.blobBytes()).toBe(15);
    s.dropChunksFrom("x");
    s.pruneChunks(1);
    expect(s.blobBytes()).toBe(5);
  });
});

describe("sql schema", () => {
  it("migrates once, keeps meshes apart, and refuses a newer schema", () => {
    const raw = new DatabaseSync(":memory:");
    const db = sqlDb(raw);
    migrate(db);
    migrate(db);
    const a = new SqlStore(db, MESH);
    const b = new SqlStore(db, "other");
    a.putSession({ ...session("A") });
    expect(b.sessions()).toEqual([]);
    expect(b.nextToken()).toBe(1);
    expect(a.nextToken()).toBe(1);
    expect(a.nextToken()).toBe(2);
    raw.prepare("UPDATE wim_meta SET v = ? WHERE k = 'schema'").run(SCHEMA_VERSION + 1);
    expect(() => migrate(db)).toThrow(/newer than this relay/);
  });

  it("counts meshes by their genesis roster, and deletes one mesh's rows from every table that has a mesh column", () => {
    const raw = new DatabaseSync(":memory:");
    const db = sqlDb(raw);
    migrate(db);
    // A host's own table keyed by mesh goes too.
    db.exec("CREATE TABLE host_extra (mesh TEXT NOT NULL, v TEXT)");
    expect(meshCount(db)).toBe(0);
    for (const mesh of [MESH, "other"]) {
      const st = new SqlStore(db, mesh);
      st.insertRoster({ seq: 1, hash: "h1", json: "{}" });
      st.insertRoster({ seq: 2, hash: "h2", json: "{}" });
      st.putSession(session("A"));
      st.putBucket({ bkey: "k", tokens: 1, at: 0 });
      st.nextToken();
      db.exec("INSERT INTO host_extra (mesh, v) VALUES (?, 'x')", mesh);
    }
    expect(meshCount(db)).toBe(2);
    dropMesh(db, MESH);
    expect(meshCount(db)).toBe(1);
    const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'wim_meta'").map((r) => String(r["name"]));
    expect(tables.length).toBeGreaterThan(15);
    for (const t of tables) expect(db.one(`SELECT COUNT(*) AS n FROM ${t} WHERE mesh = ?`, MESH)!["n"], t).toBe(0);
    const other = new SqlStore(db, "other");
    expect(other.rosterHead()).toBe(2);
    expect(other.sessions()).toHaveLength(1);
    expect(db.one("SELECT COUNT(*) AS n FROM host_extra WHERE mesh = 'other'")!["n"]).toBe(1);
    // The schema itself is kept.
    expect(db.one("SELECT v FROM wim_meta WHERE k = 'schema'")!["v"]).toBe(SCHEMA_VERSION);
  });
});

describe("positional", () => {
  it("rewrites numbered parameters as plain ones, repeating values where a number repeats", () => {
    expect(positional("DELETE FROM t WHERE mesh = ?1 AND id IN (SELECT id FROM u WHERE mesh = ?1 AND at <= ?2)", ["m", 5])).toEqual([
      "DELETE FROM t WHERE mesh = ? AND id IN (SELECT id FROM u WHERE mesh = ? AND at <= ?)",
      "m",
      "m",
      5,
    ]);
    expect(positional("UPDATE t SET sid = ?2 WHERE mesh = ?1 AND sid = ?3", ["m", "new", "old"])).toEqual(["UPDATE t SET sid = ? WHERE mesh = ? AND sid = ?", "new", "m", "old"]);
    // A plain ? after ?3 is parameter 4, as in SQLite.
    expect(positional("SELECT ?3, ?, ?1", ["a", "b", "c", "d"])).toEqual(["SELECT ?, ?, ?", "c", "d", "a"]);
    expect(positional("SELECT * FROM t WHERE mesh = ? AND seq = ?", ["m", 2])).toEqual(["SELECT * FROM t WHERE mesh = ? AND seq = ?", "m", 2]);
  });
});
