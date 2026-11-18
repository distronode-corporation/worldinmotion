import { promises as fs } from "node:fs";
import { join } from "node:path";
import { LIMITS, ulid } from "@worldinmotion/protocol";
import { describe, expect, it } from "vitest";
import { HeldBox, preview, type HeldItem } from "../src/held.ts";
import { MeshFiles } from "../src/mesh.ts";
import { receiverKey, SeenStore, SeqStore } from "../src/replay.ts";
import { listSessions, newSessionState, parseSessionState, SESSION_KEY_TTL_MS, SessionFiles, SessionKeys } from "../src/session.ts";
import { cursorNumber, itemName, Spool } from "../src/spool.ts";
import { FS, scratch } from "./helpers.ts";

const DEV = "A".repeat(22);

describe("SeenStore", () => {
  it("remembers ids per address until they expire", async () => {
    const dir = await scratch("seen");
    const s = new SeenStore(join(dir, "seen.json"), FS);
    expect(await s.has("id1", "a@x", 0)).toBe(false);
    await s.add("id1", "a@x", 100, 0);
    await s.add("id2", "a@x", 50, 0);
    expect(await s.has("id1", "a@x", 10)).toBe(true);
    expect(await s.has("id1", "b@x", 10)).toBe(false);
    expect(await s.has("id1", "a@x", 100)).toBe(false);
    await s.add("id3", "a@x", 300, 60);
    const raw = JSON.parse(await fs.readFile(join(dir, "seen.json"), "utf8")) as { seen: Record<string, number> };
    expect(Object.keys(raw.seen).sort()).toEqual(["id1 a@x", "id3 a@x"]);
    await fs.writeFile(join(dir, "seen.json"), '{"v":2}');
    expect(await s.has("id1", "a@x", 0)).toBe(false);
  });
});

describe("SeenStore.migrate", () => {
  it("carries an address's live entries over to the session key, and nothing else", async () => {
    const dir = await scratch("seen-migrate");
    const path = join(dir, "seen.json");
    const me = receiverKey("S1");
    await fs.writeFile(
      path,
      JSON.stringify({ v: 1, seen: { "id1 a@x": 100, "id2 a@x": 5, "id3 b@x": 100, "id4 a@x": 40, [`id4 ${me}`]: 90, [`id5 ${me}`]: 70, "id5 a@x": 80 } }),
    );
    const s = new SeenStore(path, FS);
    await s.migrate("a@x", me, 10);
    // Live, from this address: carried. Expired (id2), another address (id3): not. Already held
    // longer (id4): kept as it was. Held shorter (id5): lengthened.
    expect(await s.has("id1", me, 50)).toBe(true);
    expect(await s.has("id2", me, 0)).toBe(false);
    expect(await s.has("id3", me, 50)).toBe(false);
    const raw = JSON.parse(await fs.readFile(path, "utf8")) as { seen: Record<string, number> };
    expect(raw.seen[`id4 ${me}`]).toBe(90);
    expect(raw.seen[`id5 ${me}`]).toBe(80);
    // The old entries stay until they expire, for a sibling of an older version.
    expect(raw.seen["id1 a@x"]).toBe(100);
    // Nothing left to carry: the file is not written again (its spacing would change).
    const spaced = JSON.stringify(raw, null, 2);
    await fs.writeFile(path, spaced);
    await s.migrate("a@x", me, 10);
    expect(await fs.readFile(path, "utf8")).toBe(spaced);
    // An address this store never held: not even the lock is taken.
    await s.migrate("none@x", me, 10);
    expect(await fs.readFile(path, "utf8")).toBe(spaced);
  });
});

describe("SeqStore.migrate", () => {
  it("carries an address's highest seqs over to the session key, where they are higher", async () => {
    const dir = await scratch("seq-migrate");
    const path = join(dir, "seq.json");
    const me = receiverKey("S1");
    await fs.writeFile(
      path,
      JSON.stringify({ v: 1, byAddress: { "a@x": { v: 1, entries: [[DEV, "P1", 7], [DEV, "P2", 2]] }, [me]: { v: 1, entries: [[DEV, "P2", 5]] } } }),
    );
    const s = new SeqStore(path, FS);
    await s.migrate("a@x", me, Date.now());
    expect(await s.isNew(me, DEV, "P1", 7)).toBe(false);
    expect(await s.isNew(me, DEV, "P1", 8)).toBe(true);
    expect(await s.isNew(me, DEV, "P2", 5)).toBe(false);
    expect(await s.isNew(me, DEV, "P2", 6)).toBe(true);
    const raw = JSON.parse(await fs.readFile(path, "utf8")) as { byAddress: Record<string, unknown> };
    expect(raw.byAddress["a@x"]).toEqual({ v: 1, entries: [[DEV, "P1", 7], [DEV, "P2", 2]] });
    // An address with nothing recorded: nothing to carry, and nothing is written.
    const fresh = new SeqStore(join(dir, "none.json"), FS);
    await fresh.migrate("a@x", me, Date.now());
    await expect(fs.stat(join(dir, "none.json"))).rejects.toThrow();
  });
});

describe("SeqStore", () => {
  it("tracks the highest seq per sender session and address, merging with siblings", async () => {
    const dir = await scratch("seq");
    const path = join(dir, "seq.json");
    const a = new SeqStore(path, FS);
    const b = new SeqStore(path, FS);
    expect(await a.isNew("a@x", DEV, "S1", 1)).toBe(true);
    await a.record("a@x", DEV, "S1", 3, Date.now());
    expect(await a.isNew("a@x", DEV, "S1", 3)).toBe(false);
    expect(await a.isNew("a@x", DEV, "S1", 4)).toBe(true);
    await b.record("b@x", DEV, "S1", 9, Date.now());
    expect(await b.isNew("b@x", DEV, "S1", 9)).toBe(false);
    // A restarted session reads the file.
    const c = new SeqStore(path, FS);
    expect(await c.isNew("a@x", DEV, "S1", 3)).toBe(false);
    await a.record("a@x", DEV, "S1", 2, Date.now());
    expect(await c.isNew("a@x", DEV, "S1", 3)).toBe(false);
    await c.isNew("a@x", DEV, "S2", 1);
    await c.record("a@x", DEV, "S2", 1, Date.now());
    await fs.writeFile(path, JSON.stringify({ v: 1, byAddress: { "z@x": "junk" } }));
    expect(await new SeqStore(path, FS).isNew("z@x", DEV, "S1", 1)).toBe(true);
    await fs.writeFile(path, "{}");
    expect(await new SeqStore(path, FS).isNew("z@x", DEV, "S1", 1)).toBe(true);
  });
});

describe("SeqStore retirement", () => {
  it("retires a row once nothing accepted under it could still be fresh, and counts an older file's rows from its first write", async () => {
    const path = join(await scratch("seq-retire"), "seq.json");
    const me = receiverKey("S1");
    const T = 1_800_000_000_000;
    const W = LIMITS.dedupeRetentionMs;
    const raw = async (): Promise<{ byAddress: Record<string, unknown>; touched: Record<string, Record<string, number>> }> => JSON.parse(await fs.readFile(path, "utf8"));
    const s = new SeqStore(path, FS);
    await s.record(me, DEV, "OLD", 5, T);
    await s.record(receiverKey("S2"), DEV, "GONE", 2, T);
    // At the edge of the window both are kept.
    await s.record(me, DEV, "NEW", 1, T + W - 1);
    expect(Object.keys((await raw()).byAddress).sort()).toEqual([me, receiverKey("S2")].sort());
    expect(await s.isNew(me, DEV, "OLD", 5)).toBe(false);
    // Past it, the rows recorded at T go, and so does a receiving session left with none.
    await s.record(me, DEV, "NEW", 2, T + W);
    expect(await raw()).toEqual({ v: 1, byAddress: { [me]: { v: 1, entries: [[DEV, "NEW", 2]] } }, touched: { [me]: { [JSON.stringify([DEV, "NEW"])]: T + W } } });
    // In this process too: anything sent under the retired row is too old to be accepted now.
    expect(await s.isNew(me, DEV, "OLD", 1)).toBe(true);
    expect(await new SeqStore(path, FS).isNew(me, DEV, "OLD", 1)).toBe(true);
    // A file an older client wrote has no times (or junk ones): its rows count from now.
    const L = JSON.stringify([DEV, "L"]);
    await fs.writeFile(path, JSON.stringify({ v: 1, byAddress: { [me]: { v: 1, entries: [[DEV, "L", 4], [DEV, "K", 3]] }, [receiverKey("S3")]: { v: 1, entries: [[DEV, "J", 1]] } }, touched: { [me]: { [L]: "x" }, [receiverKey("S3")]: "junk" } }));
    const fresh = new SeqStore(path, FS);
    await fresh.record(me, DEV, "M", 1, T);
    expect((await raw()).touched[me]![L]).toBe(T);
    expect((await raw()).touched[receiverKey("S3")]).toEqual({ [JSON.stringify([DEV, "J"])]: T });
    await fresh.record(me, DEV, "M", 2, T + W - 1);
    expect(await new SeqStore(path, FS).isNew(me, DEV, "L", 4)).toBe(false);
    expect(await new SeqStore(path, FS).isNew(me, DEV, "K", 3)).toBe(false);
  });
});

describe("SeqStore retirement across sessions", () => {
  it("does not bring back a row a sibling retired, from what this process still holds", async () => {
    const path = join(await scratch("seq-retire-sibling"), "seq.json");
    const me = receiverKey("S1");
    const T = 1_800_000_000_000;
    const W = LIMITS.dedupeRetentionMs;
    const a = new SeqStore(path, FS);
    const b = new SeqStore(path, FS);
    await a.record(me, DEV, "OLD", 5, T);
    // b reads the row (with its time) and later retires it from the file.
    expect(await b.isNew(me, DEV, "OLD", 5)).toBe(false);
    await b.record(me, DEV, "B", 1, T + W);
    // a still holds OLD in memory; its next write keeps OLD's age, so it stays retired.
    await a.record(me, DEV, "NEW", 1, T + W + 1);
    const raw = JSON.parse(await fs.readFile(path, "utf8")) as { byAddress: Record<string, { entries: unknown[][] }> };
    expect(raw.byAddress[me]!.entries.map((e) => e[1]).sort()).toEqual(["B", "NEW"]);
    expect(await a.isNew(me, DEV, "OLD", 1)).toBe(true);
    // A row read from a file without times counts from this process's next write.
    await fs.writeFile(path, JSON.stringify({ v: 1, byAddress: { [me]: { v: 1, entries: [[DEV, "L", 4]] } } }));
    const c = new SeqStore(path, FS);
    expect(await c.isNew(me, DEV, "L", 4)).toBe(false);
    await c.record(me, DEV, "M", 1, T);
    await c.record(me, DEV, "M", 2, T + W - 1);
    expect(await c.isNew(me, DEV, "L", 4)).toBe(false);
    await c.record(me, DEV, "M", 3, T + W);
    expect(await c.isNew(me, DEV, "L", 4)).toBe(true);
  });

  it("keeps the time a sibling gave a row read without one", async () => {
    const path = join(await scratch("seq-legacy-sibling"), "seq.json");
    const me = receiverKey("S1");
    const T = 1_800_000_000_000;
    const W = LIMITS.dedupeRetentionMs;
    await fs.writeFile(path, JSON.stringify({ v: 1, byAddress: { [me]: { v: 1, entries: [[DEV, "L", 4]] } } }));
    const a = new SeqStore(path, FS);
    const b = new SeqStore(path, FS);
    // Both read L without a time; b's write gives it one (T), and a writes later, at T + W/2.
    expect(await a.isNew(me, DEV, "L", 4)).toBe(false);
    expect(await b.isNew(me, DEV, "L", 4)).toBe(false);
    await b.record(me, DEV, "B", 1, T);
    await a.record(me, DEV, "A", 1, T + W / 2);
    // L keeps T: it is retired with B's write at T + W, not counted from a's.
    await b.record(me, DEV, "B", 2, T + W);
    expect(await new SeqStore(path, FS).isNew(me, DEV, "L", 4)).toBe(true);
  });

  it("does not bring back a row read without a time that a sibling stamped and retired since", async () => {
    const path = join(await scratch("seq-legacy-retired"), "seq.json");
    const me = receiverKey("S1");
    const T = 1_800_000_000_000;
    const W = LIMITS.dedupeRetentionMs;
    await fs.writeFile(path, JSON.stringify({ v: 1, byAddress: { [me]: { v: 1, entries: [[DEV, "L", 4]] } } }));
    const a = new SeqStore(path, FS);
    const b = new SeqStore(path, FS);
    expect(await a.isNew(me, DEV, "L", 4)).toBe(false);
    // b gives L a time (T) and retires it at T + W; a, which has not written since it read L, then writes.
    await b.record(me, DEV, "B", 1, T);
    await b.record(me, DEV, "B", 2, T + W);
    await a.record(me, DEV, "A", 1, T + W + 1);
    expect(await new SeqStore(path, FS).isNew(me, DEV, "L", 4)).toBe(true);
  });
});

describe("session state", () => {
  it("parses only well-formed state", () => {
    const s = newSessionState("agent", "mcp");
    expect(parseSessionState(s)).toEqual(s);
    expect(parseSessionState({ ...s, cursor: -1, rooms: "x", leases: null, seq: 1.5, address: "a@b" })).toMatchObject({ cursor: 0, rooms: [], leases: {}, seq: 0, address: "a@b" });
    expect(parseSessionState({ ...s, rooms: ["#a", 3] })?.rooms).toEqual(["#a"]);
    expect(parseSessionState({ ...s, sid: "x" })).toBeUndefined();
    expect(parseSessionState(undefined)).toBeUndefined();
  });

  it("saves, claims and releases a session", async () => {
    const mesh = new MeshFiles(await scratch("sess"), FS);
    const state = newSessionState("agent", "mcp");
    const f = new SessionFiles(mesh, state.sid, FS);
    expect(await f.load()).toBeUndefined();
    await f.save(state);
    expect((await f.load())?.sid).toBe(state.sid);
    expect(await f.claim()).toBe(true);
    expect(await f.isLiveElsewhere()).toBe(false);
    await f.release();
    expect(await listSessions(mesh)).toEqual([state.sid]);
    for (const p of [f.spoolDir, f.cursorPath, f.presencePath, f.heldDir, f.filesDir, f.historyPath, f.tasksPath, f.sentTasksPath, f.behindDir, f.controlDir]) expect(p.startsWith(f.dir)).toBe(true);
  });

  it("maps outside keys to sessions and forgets them after 7 days", async () => {
    const mesh = new MeshFiles(await scratch("keys"), FS);
    let now = 1_000_000;
    const keys = new SessionKeys(mesh, FS, () => now);
    expect(await keys.lookup("claude:1")).toBeUndefined();
    await keys.remember("claude:1", "01J0000000000000000000000A", "r");
    expect(await keys.lookup("claude:1")).toEqual({ sid: "01J0000000000000000000000A", resume: "r" });
    await fs.writeFile(join(mesh.keysDir, "junk.json"), "{");
    now += SESSION_KEY_TTL_MS + 1;
    expect(await keys.lookup("claude:1")).toBeUndefined();
    expect(await fs.readdir(mesh.keysDir)).toEqual([]);
  });
});

describe("Spool", () => {
  it("numbers items after anything on disk, takes and sweeps", async () => {
    const dir = await scratch("spool");
    const spool = await Spool.open(join(dir, "spool"), FS, 0);
    expect(await spool.cursor()).toBe(0);
    const a = await spool.write({ kind: "msg", from: "a@x", device: DEV, id: "1", at: 1, rendered: "one" });
    const b = await spool.write({ kind: "notice", from: "a@x", device: "", id: "2", at: 2, rendered: "two", held: 1 });
    expect([a.cursor, b.cursor]).toEqual([1, 2]);
    await fs.writeFile(join(dir, "spool", "000000000099.json"), "not json");
    await fs.writeFile(join(dir, "spool", "other"), "x");
    expect((await spool.unread()).map((i) => i.cursor)).toEqual([1, 2]);
    await spool.take(1);
    // Taken but not yet swept: no longer unread.
    expect((await spool.unread()).map((i) => i.cursor)).toEqual([2]);
    await spool.take(1);
    expect((await spool.sweep()).map((i) => i.id)).toEqual(["1"]);
    expect((await spool.unread()).map((i) => i.id)).toEqual(["2"]);
    const again = await Spool.open(join(dir, "spool"), FS, 0);
    expect(again.highest).toBe(99);
    await again.take(99);
    expect((await again.sweep()).map((i) => i.id)).toEqual(["2"]);
    const fresh = await Spool.open(join(dir, "spool"), FS, 0);
    expect(fresh.highest).toBe(99);
  });

  it("keeps relayed items readable after the cursor passes them", async () => {
    const dir = await scratch("spool");
    const spool = await Spool.open(join(dir, "spool"), FS, 0);
    await spool.write({ kind: "msg", from: "a@x", device: DEV, id: "r1", at: 1, rendered: "relayed", relayed: true });
    await spool.write({ kind: "msg", from: "a@x", device: DEV, id: "r2", at: 1, rendered: "relayed", relayed: true });
    await spool.take(2);
    await spool.sweep();
    expect((await spool.relayed()).map((i) => i.id)).toEqual(["r1", "r2"]);
    await fs.writeFile(join(spool.relayedDir, "000000000077.json"), "{");
    expect(await spool.dismissRelayed(["r1"])).toEqual({ removed: 1, left: [] });
    expect(await spool.dismissRelayed()).toEqual({ removed: 1, left: [] });
    expect(await spool.relayed()).toEqual([]);
  });

  it("reads cursor files strictly", () => {
    expect(cursorNumber(undefined)).toBe(0);
    expect(cursorNumber(" 000000000042.json\n")).toBe(42);
    expect(cursorNumber("42")).toBe(0);
    expect(itemName(7)).toBe("000000000007.json");
  });
});

describe("HeldBox", () => {
  const item = (id: string, at: number): HeldItem => ({
    id,
    from: "a@x",
    device: DEV,
    kind: "msg",
    at,
    preview: "p",
    rendered: "",
    reason: "policy",
    entry: { dir: "in", peer: "a@x", device: DEV, id, kind: "msg", at, text: "t" },
  });

  it("adds, lists oldest first, removes, and passes decisions as markers", async () => {
    const box = new HeldBox(join(await scratch("held"), "held"), FS);
    const a = ulid(2);
    const b = ulid(1);
    await box.add(item(a, 2));
    await box.add(item(b, 1));
    await fs.writeFile(join(box.dir, "nonsense.json"), "{}");
    await fs.writeFile(join(box.dir, `${ulid()}.json`), "{");
    expect((await box.list()).map((i) => i.id)).toEqual([b, a]);
    expect(await box.get("../x")).toBeUndefined();
    await box.mark(a, "approve");
    await box.mark(b, "refuse");
    await fs.writeFile(join(box.dir, "x.approve"), "");
    expect((await box.takeMarks()).sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: b, verdict: "refuse" },
      { id: a, verdict: "approve" },
    ].sort((x, y) => x.id.localeCompare(y.id)));
    expect(await box.takeMarks()).toEqual([]);
    await box.remove(a);
    expect((await box.list()).map((i) => i.id)).toEqual([b]);
  });

  it("previews one safe line", () => {
    expect(preview("a\nb‮c")).toBe("a b<U+202E>c");
    expect(preview("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
