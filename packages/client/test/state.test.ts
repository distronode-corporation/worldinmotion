import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ulid } from "@worldinmotion/protocol";
import { describe, expect, it } from "vitest";
import { HeldBox, preview, type HeldItem } from "../src/held.ts";
import { MeshFiles } from "../src/mesh.ts";
import { SeenStore, SeqStore } from "../src/replay.ts";
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

describe("SeqStore", () => {
  it("tracks the highest seq per sender session and address, merging with siblings", async () => {
    const dir = await scratch("seq");
    const path = join(dir, "seq.json");
    const a = new SeqStore(path, FS);
    const b = new SeqStore(path, FS);
    expect(await a.isNew("a@x", DEV, "S1", 1)).toBe(true);
    await a.record("a@x", DEV, "S1", 3);
    expect(await a.isNew("a@x", DEV, "S1", 3)).toBe(false);
    expect(await a.isNew("a@x", DEV, "S1", 4)).toBe(true);
    await b.record("b@x", DEV, "S1", 9);
    expect(await b.isNew("b@x", DEV, "S1", 9)).toBe(false);
    // A restarted session reads the file.
    const c = new SeqStore(path, FS);
    expect(await c.isNew("a@x", DEV, "S1", 3)).toBe(false);
    await a.record("a@x", DEV, "S1", 2);
    expect(await c.isNew("a@x", DEV, "S1", 3)).toBe(false);
    await c.isNew("a@x", DEV, "S2", 1);
    await c.record("a@x", DEV, "S2", 1);
    await fs.writeFile(path, JSON.stringify({ v: 1, byAddress: { "z@x": "junk" } }));
    expect(await new SeqStore(path, FS).isNew("z@x", DEV, "S1", 1)).toBe(true);
    await fs.writeFile(path, "{}");
    expect(await new SeqStore(path, FS).isNew("z@x", DEV, "S1", 1)).toBe(true);
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
