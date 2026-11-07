import { LIMITS } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeshSession } from "../src/client.ts";
import { Watches, WATCHES_KEPT } from "../src/watches.ts";
import { FS, makeMesh, openSession, RelayHarness, scratch, sleep, until } from "./helpers.ts";

const open: MeshSession[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

async function session(...args: Parameters<typeof openSession>): Promise<MeshSession> {
  const s = await openSession(...args);
  open.push(s);
  return s;
}

const notices = async (s: MeshSession): Promise<string[]> => (await s.spool.unread()).filter((i) => i.kind === "notice").map((i) => i.rendered);
const idle = (of: string): string => JSON.stringify({ t: "notice", kind: "idle", of });
const watched = (s: MeshSession) => (s as unknown as { watches: Watches }).watches.list();

describe("idle-notice watches on disk", () => {
  it("takes an armed address once, renews a re-arm, and lets a watch lapse after 12 hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const path = join(await scratch("watches"), "watches.json");
    const w = new Watches(path, FS, Date.now);
    expect(await w.list()).toEqual([]);
    await w.arm([{ of: "b@two" }, { of: "b@two" }, { of: "c@two", sid: "sid-c" }]);
    expect(await w.list()).toEqual([
      { of: "b@two", at: 1_000_000, until: 1_000_000 + LIMITS.idleNoticeLifetimeMs },
      { of: "c@two", sid: "sid-c", at: 1_000_000, until: 1_000_000 + LIMITS.idleNoticeLifetimeMs },
    ]);
    // Only once: the first take closes the watch. Two at once cannot both take it.
    expect(await Promise.all([w.take("b@two"), w.take("b@two")])).toEqual([true, false]);
    expect(await w.take("x@two")).toBe(false);
    // A re-arm an hour before c lapses renews it for another 12 hours.
    vi.setSystemTime(1_000_000 + LIMITS.idleNoticeLifetimeMs - 3600_000);
    await w.arm([{ of: "c@two", sid: "sid-c" }]);
    vi.setSystemTime(1_000_000 + LIMITS.idleNoticeLifetimeMs + 1);
    expect(await w.take("c@two")).toBe(true);
    // One that was not renewed lapses.
    await w.arm([{ of: "d@two" }]);
    vi.setSystemTime(Date.now() + LIMITS.idleNoticeLifetimeMs);
    expect(await w.list()).toEqual([]);
    expect(await w.take("d@two")).toBe(false);
  });

  it("takes a watch by the session's id after a rename, drops a refused arm, and keeps the newest past its bound", async () => {
    const w = new Watches(join(await scratch("watches"), "watches.json"), FS, Date.now);
    await w.arm([{ of: "old@two", sid: "sid-1" }, { of: "bare@two" }]);
    // The session renamed itself: the notice names its new address, and the relay's id for it.
    expect(await w.take("new@two", "sid-2")).toBe(false);
    expect(await w.take("new@two", "sid-1")).toBe(true);
    expect(await w.take("old@two")).toBe(false);
    // An address armed with no id is taken only by its address.
    expect(await w.take("other@two")).toBe(false);
    await w.drop("bare@two");
    expect(await w.list()).toEqual([]);
    // Past WATCHES_KEPT the oldest go; a re-arm makes one the newest.
    const many = Array.from({ length: WATCHES_KEPT }, (_, n) => ({ of: `s${n}@two` }));
    await w.arm(many);
    await w.arm([{ of: "s0@two" }, { of: "late@two" }]);
    expect((await w.list()).map((x) => x.of)).toEqual([...many.slice(2).map((x) => x.of), "s0@two", "late@two"]);
  });

  it("reads a damaged, foreign or unreadable file as no watches", async () => {
    const dir = await scratch("watches");
    const path = join(dir, "watches.json");
    const w = new Watches(path, FS, Date.now);
    for (const text of ["{not json", "null", "7", '{"watches":"all"}', '{"watches":[null,{"of":1,"at":1,"until":1},{"of":"b@two","at":1.5,"until":2},{"of":"b@two","sid":3,"at":1,"until":9007199254740991}]}']) {
      await fs.writeFile(path, text);
      expect(await w.list()).toEqual([]);
      expect(await w.take("b@two")).toBe(false);
    }
    // A directory where the file should be: it cannot be read (none), nor written (the arm rejects).
    await fs.rm(path);
    await fs.mkdir(path);
    expect(await w.list()).toEqual([]);
    await expect(w.arm([{ of: "b@two" }])).rejects.toThrow();
    // A failed change does not stop the next one.
    await fs.rm(path, { recursive: true });
    await w.arm([{ of: "b@two" }]);
    expect((await w.list()).map((x) => x.of)).toEqual(["b@two"]);
  });
});

describe("relay idle notices", () => {
  it("drops a notice nobody asked for, and a second one for the same arm", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const logs: string[] = [];
    await session(devices[1]!, mesh, relay, { name: "b" });
    const a = await session(devices[0]!, mesh, relay, { name: "a", log: (l) => logs.push(l) });
    relay.inject(mesh, idle("c@two"));
    relay.inject(mesh, idle("b@two"));
    await until(() => logs.filter((l) => l.startsWith("wim: dropped a notice")).length === 2);
    expect(logs).toContain("wim: dropped a notice for c@two: not asked for");
    expect(logs).toContain("wim: dropped a notice for b@two: not asked for");
    expect(await notices(a)).toEqual([]);
    expect(await a.notifyWhenIdle(["b@two"])).toBeUndefined();
    relay.inject(mesh, idle("b@two"));
    relay.inject(mesh, idle("b@two"));
    await until(async () => (await notices(a)).length === 1);
    await until(() => logs.filter((l) => l === "wim: dropped a notice for b@two: not asked for").length === 2);
    await sleep(30);
    expect(await notices(a)).toEqual(["worldinmotion notice (from the local client, not from a peer or the person): b@two is now idle (or has ended)."]);
  });

  it("arms at the relay, drops the watch of an arm the relay refuses or that cannot be sent, and says why", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const logs: string[] = [];
    await session(devices[1]!, mesh, relay, { name: "b" });
    const a = await session(devices[0]!, mesh, relay, { name: "a", log: (l) => logs.push(l), answerMs: 300 });
    expect(await a.notifyWhenIdle(["b@two", "#room", "*"])).toBeUndefined();
    expect((await watched(a)).map((w) => w.of)).toEqual(["b@two"]);
    // The relay refuses an arm for a session it does not know: the watch goes, and its notice is dropped.
    expect(await a.notifyWhenIdle(["nobody@two", "b@two"])).toBe("no idle notice armed for nobody@two (no such session)");
    relay.inject(mesh, idle("nobody@two"));
    await until(() => logs.includes("wim: dropped a notice for nobody@two: not asked for"));
    // Its limit, and a code this client does not know (read only as a code, never as text).
    for (const [code, why] of [
      ["limited", "a session holds at most 16 at once, each until it fires or lapses after 12 hours"],
      ["Not A Code", "the relay refused it: relay_error"],
    ] as const) {
      relay.toClient = (text) => (text.includes('"ref":"notify_idle"') ? text.replace('"not_found"', JSON.stringify(code)) : text);
      expect(await a.notifyWhenIdle(["full@two"])).toBe(`no idle notice armed for full@two (${why})`);
    }
    // No answer at all: the arm may stand, so the watch is kept.
    relay.toClient = (text) => (text.includes('"ref":"notify_idle"') || text.startsWith('{"t":"pong"') ? undefined : text);
    expect(await a.notifyWhenIdle(["quiet@two"])).toBeUndefined();
    relay.toClient = undefined;
    expect((await watched(a)).map((w) => w.of)).toEqual(["b@two", "quiet@two"]);
    // A watch that cannot be dropped again is logged; the note still says the arm was refused.
    const watches = (a as unknown as { watches: { drop: (of: string) => Promise<void> } }).watches;
    const drop = watches.drop.bind(watches);
    watches.drop = () => Promise.reject(new Error("EIO"));
    expect(await a.notifyWhenIdle(["ghost@two"])).toBe("no idle notice armed for ghost@two (no such session)");
    expect(logs).toContain("wim: watches: EIO");
    watches.drop = drop;
    // The watch cannot be recorded at all.
    await fs.rm(a.files.watchesPath);
    await fs.mkdir(a.files.watchesPath);
    expect(await a.notifyWhenIdle(["b@two"])).toMatch(/^no idle notice armed: this session could not record the watch \(.+\)$/);
    expect(logs.some((l) => l.startsWith("wim: watches: ") && l !== "wim: watches: EIO")).toBe(true);
    await fs.rm(a.files.watchesPath, { recursive: true });
    // Offline, nothing reaches the relay, so nothing is armed.
    await a.stop();
    expect(await a.notifyWhenIdle(["b@two"])).toBe("no idle notice armed for b@two (this session is not connected to the relay)");
    expect(await watched(a)).toEqual([]);
  });

  it("takes the notice of a session that renamed itself after the arm", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    await until(() => a.peers.has("b@two"));
    expect(await a.notifyWhenIdle(["b@two"])).toBeUndefined();
    expect(await b.rename("c")).toBe("c@two");
    await until(() => a.peers.has("c@two"));
    await fs.writeFile(b.files.presencePath, "busy");
    await until(() => a.peers.get("c@two")?.status === "busy");
    await fs.writeFile(b.files.presencePath, "idle");
    await until(async () => (await notices(a)).length === 1);
    expect((await notices(a))[0]).toContain("c@two is now idle");
    expect(await watched(a)).toEqual([]);
  });

  it("keeps a watch across a restart that resumes the session, and the relay's row with it", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const first = await openSession(devices[0]!, mesh, relay, { name: "a", sessionKey: "key:a" });
    expect(await first.notifyWhenIdle(["b@two"])).toBeUndefined();
    await sleep(30);
    await first.stop();
    const again = await session(devices[0]!, mesh, relay, { name: "a", sessionKey: "key:a" });
    expect(again.sid).toBe(first.sid);
    await fs.writeFile(b.files.presencePath, "busy");
    await until(() => again.peers.get("b@two")?.status === "busy");
    await fs.writeFile(b.files.presencePath, "idle");
    await until(async () => (await notices(again)).length === 1);
    expect((await notices(again))[0]).toContain("b@two is now idle");
  });
});
