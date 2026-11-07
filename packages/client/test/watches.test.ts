import { LIMITS } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeshSession } from "../src/client.ts";
import { Watches } from "../src/watches.ts";
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

describe("idle-notice watches on disk", () => {
  it("takes an armed address once, renews a re-arm, and lets a watch lapse after 12 hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const path = join(await scratch("watches"), "watches.json");
    const w = new Watches(path, FS, Date.now);
    expect(await w.list()).toEqual([]);
    expect(await w.arm(["b@two", "b@two", "c@two"])).toEqual({ armed: ["b@two", "c@two"], refused: [] });
    expect(await w.list()).toEqual([
      { of: "b@two", at: 1_000_000, until: 1_000_000 + LIMITS.idleNoticeLifetimeMs },
      { of: "c@two", at: 1_000_000, until: 1_000_000 + LIMITS.idleNoticeLifetimeMs },
    ]);
    // Only once: the first take closes the watch. Two at once cannot both take it.
    expect(await Promise.all([w.take("b@two"), w.take("b@two")])).toEqual([true, false]);
    expect(await w.take("x@two")).toBe(false);
    // A re-arm an hour before c lapses renews it for another 12 hours.
    vi.setSystemTime(1_000_000 + LIMITS.idleNoticeLifetimeMs - 3600_000);
    expect(await w.arm(["c@two"])).toEqual({ armed: ["c@two"], refused: [] });
    vi.setSystemTime(1_000_000 + LIMITS.idleNoticeLifetimeMs + 1);
    expect(await w.take("c@two")).toBe(true);
    // One that was not renewed lapses.
    await w.arm(["d@two"]);
    vi.setSystemTime(Date.now() + LIMITS.idleNoticeLifetimeMs);
    expect(await w.list()).toEqual([]);
    expect(await w.take("d@two")).toBe(false);
  });

  it("refuses a 17th address, but renews one already armed", async () => {
    const w = new Watches(join(await scratch("watches"), "watches.json"), FS, Date.now);
    const sixteen = Array.from({ length: LIMITS.notifyIdlePerSession }, (_, n) => `s${n}@two`);
    expect((await w.arm(sixteen)).armed).toHaveLength(16);
    expect(await w.arm(["s17@two", "s3@two"])).toEqual({ armed: ["s3@two"], refused: ["s17@two"] });
    expect(await w.list()).toHaveLength(16);
    // A notice frees a place.
    expect(await w.take("s0@two")).toBe(true);
    expect(await w.arm(["s17@two"])).toEqual({ armed: ["s17@two"], refused: [] });
  });

  it("reads a damaged, foreign or unreadable file as no watches", async () => {
    const dir = await scratch("watches");
    const path = join(dir, "watches.json");
    const w = new Watches(path, FS, Date.now);
    for (const text of ["{not json", "null", "7", '{"watches":"all"}', '{"watches":[null,{"of":1,"at":1,"until":1},{"of":"b@two","at":1.5,"until":2}]}']) {
      await fs.writeFile(path, text);
      expect(await w.list()).toEqual([]);
      expect(await w.take("b@two")).toBe(false);
    }
    // A directory where the file should be: it cannot be read (none), nor written (the arm rejects).
    await fs.rm(path);
    await fs.mkdir(path);
    expect(await w.list()).toEqual([]);
    await expect(w.arm(["b@two"])).rejects.toThrow();
    // A failed change does not stop the next one.
    await fs.rm(path, { recursive: true });
    expect((await w.arm(["b@two"])).armed).toEqual(["b@two"]);
  });
});

describe("relay idle notices", () => {
  it("drops a notice nobody asked for, and a second one for the same arm", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const logs: string[] = [];
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

  it("refuses a 17th arm locally, and says so when the watch cannot be recorded", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const logs: string[] = [];
    const a = await session(devices[0]!, mesh, relay, { name: "a", log: (l) => logs.push(l) });
    const sixteen = Array.from({ length: LIMITS.notifyIdlePerSession }, (_, n) => `s${n}@two`);
    expect(await a.notifyWhenIdle(sixteen)).toBeUndefined();
    expect(await a.notifyWhenIdle(["s16@two", "#room", "*"])).toBe(
      "no idle notice armed for s16@two: a session holds at most 16 at once (each lasts until it fires or lapses after 12 hours)",
    );
    // A refused arm takes no notice.
    relay.inject(mesh, idle("s16@two"));
    await until(() => logs.includes("wim: dropped a notice for s16@two: not asked for"));
    await fs.rm(a.files.watchesPath);
    await fs.mkdir(a.files.watchesPath);
    expect(await a.notifyWhenIdle(["b@two"])).toMatch(/^no idle notice armed: this session could not record the watch \(.+\)$/);
    expect(logs.some((l) => l.startsWith("wim: watches: "))).toBe(true);
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
