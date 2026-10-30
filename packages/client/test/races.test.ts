// Races between concurrent callers in one process or across processes of one device: sends
// that overlap, a wait while two items arrive, lock takeover, and two first runs at once.

import { existsSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimLock, EMPTY_LOCK_MS, fsOps, listFiles, readText, withLock, writeNew } from "../src/fsx.ts";
import { takeMarks } from "../src/held.ts";
import { Home } from "../src/home.ts";
import { busyRetries } from "../src/platform.ts";
import { Spool } from "../src/spool.ts";
import { FS, POSIX, makeMesh, openSession, RelayHarness, scratch, sleep, until } from "./helpers.ts";

const cleanup: Array<() => Promise<unknown>> = [];
const real = { ...fsOps };
afterEach(async () => {
  Object.assign(fsOps, real);
  for (const f of cleanup.splice(0).reverse()) await f().catch(() => undefined);
});

const gone = (): never => {
  throw Object.assign(new Error("gone"), { code: "ESRCH" });
};

describe("overlapping sends", () => {
  it("give each frame its own seq and put them on the wire in seq order, so the receiver keeps both", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await openSession(devices[0]!, mesh, relay, { name: "a" });
    const b = await openSession(devices[1]!, mesh, relay, { name: "b" });
    cleanup.push(() => a.stop(), () => b.stop());
    const before = relay.sentByClients.length;
    // A task first: it records its addressees before it goes out, the slowest path.
    const [task, msg] = await Promise.all([a.send("b@two", "do x", { kind: "task" }), a.send("b@two", "fyi")]);
    expect([task.results[0]!.status, msg.results[0]!.status]).toEqual(["routed", "routed"]);
    const seqs = relay.sentByClients
      .slice(before)
      .filter((t) => t.startsWith('{"t":"send"'))
      .map((t) => (JSON.parse(t) as { seq: number }).seq);
    expect(seqs.length).toBe(2);
    expect(seqs[1]).toBe(seqs[0]! + 1);
    expect(a.state.seq).toBe(seqs[1]);
    await until(async () => (await b.spool.unread()).filter((i) => i.kind !== "notice").length === 2, 3000, "both items");
  });
});

describe("wait", () => {
  it("returns one item and leaves a second one, delivered at the same moment, unread", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const b = await openSession(devices[0]!, mesh, relay, { name: "b" });
    cleanup.push(() => b.stop());
    const waiting = b.next(3000);
    await Promise.all([b.notice("x@one", "first"), b.notice("x@one", "second")]);
    const got = await waiting;
    expect(got?.rendered).toContain("first");
    await sleep(50);
    const unread = await b.spool.unread();
    expect(unread.map((i) => i.rendered.includes("second"))).toEqual([true]);
  });

  it("finds an item written after its first look listed the spool, whose event came before that look ended", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const b = await openSession(devices[0]!, mesh, relay, { name: "b" });
    cleanup.push(() => b.stop());
    // Every look lists the spool, then waits here: the first one lists it empty.
    const list = b.spool.unread.bind(b.spool);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    b.spool.unread = async () => {
      const items = await list();
      await held;
      return items;
    };
    const waiting = b.next(3000);
    await b.notice("x@one", "late");
    release();
    expect((await waiting)?.rendered).toContain("late");
  });

  it("returns an item already unread however long the first look takes, even past a short wait", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const b = await openSession(devices[0]!, mesh, relay, { name: "b" });
    cleanup.push(() => b.stop());
    await b.notice("x@one", "already here");
    const list = b.spool.unread.bind(b.spool);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    b.spool.unread = async () => {
      const items = await list();
      await held;
      return items;
    };
    const waiting = b.next(10);
    // Longer than the wait itself, as a slow Windows look was.
    await sleep(50);
    release();
    expect((await waiting)?.rendered).toContain("already here");
  });

  it("fails when the spool cannot be read, and stops listening", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const b = await openSession(devices[0]!, mesh, relay, { name: "b" });
    cleanup.push(() => b.stop());
    const listening = b.listenerCount("item");
    b.spool.unread = () => Promise.reject(new Error("the spool is gone"));
    await expect(b.next(3000)).rejects.toThrow("the spool is gone");
    expect(b.listenerCount("item")).toBe(listening);
  });
});

describe("overlapping takes", () => {
  it("never move the spool cursor back, whichever finishes first", async () => {
    const dir = join(await scratch("take"), "spool");
    for (let round = 0; round < 5; round++) {
      const spool = await Spool.open(join(dir, String(round)), FS, 0);
      for (let i = 0; i < 3; i++) await spool.write({ kind: "msg", from: "x@two", device: "d", id: `0${i}`, at: 1, rendered: `item ${i}` });
      await Promise.all([spool.take(1), spool.take(3), spool.take(2)]);
      expect(await spool.cursor()).toBe(3);
    }
    // A take that fails does not hold up the next one.
    const spool = await Spool.open(join(dir, "f"), FS, 0);
    await spool.write({ kind: "msg", from: "x@two", device: "d", id: "0f", at: 1, rendered: "f" });
    await fs.rm(spool.dir, { recursive: true });
    await fs.writeFile(spool.dir, "");
    await expect(spool.take(1)).rejects.toThrow();
    await fs.rm(spool.dir);
    await spool.take(1);
    expect(await spool.cursor()).toBe(1);
  });
});

describe("busy files on Windows", () => {
  const win = { platform: "win32", pid: 1 } as const;
  const busy = (): never => {
    throw Object.assign(new Error("delete pending"), { code: "EPERM" });
  };
  const item = (i: number, relayed = false) => ({ kind: "msg" as const, from: "x@two", device: "d", id: `0${i}`, at: 1, rendered: `item ${i}`, ...(relayed ? { relayed } : {}) });

  it("the spool cursor never reads older than this process wrote, and waits out a busy read", async () => {
    const spool = await Spool.open(join(await scratch("cur"), "spool"), win, 0);
    for (let i = 0; i < 3; i++) await spool.write(item(i));
    await spool.take(3);
    // A file system that has not shown the rename yet: the file still reads as before it.
    fsOps.readFile = async (path) => (path === spool.cursorPath ? "000000000001.json" : real.readFile(path));
    expect(await spool.cursor()).toBe(3);
    expect((await spool.unread()).length).toBe(0);
    // A cursor busy for a moment is read again, not taken for no cursor.
    let fails = 2;
    fsOps.sleep = async () => undefined;
    fsOps.readFile = async (path) => (path === spool.cursorPath && fails-- > 0 ? busy() : real.readFile(path));
    expect(await spool.cursor()).toBe(3);
  });

  it("a sweep skips an item it cannot delete yet, sends its receipt on a later pass, and boxes a relayed one once", async () => {
    const spool = await Spool.open(join(await scratch("sw"), "spool"), win, 0);
    await spool.write(item(1, true));
    await spool.write(item(2));
    await spool.take(2);
    const first = join(spool.dir, "000000000001.json");
    let stuck = true;
    fsOps.rm = async (path) => (stuck && path === first ? busy() : real.rm(path));
    expect((await spool.sweep()).map((i) => i.id)).toEqual(["02"]);
    expect((await spool.relayed()).map((i) => i.id)).toEqual(["01"]);
    // Dismissed meanwhile: the next pass, still unable to delete it, does not box it again.
    expect(await spool.dismissRelayed()).toEqual({ removed: 1, left: [] });
    expect(await spool.sweep()).toEqual([]);
    expect(await spool.relayed()).toEqual([]);
    stuck = false;
    expect((await spool.sweep()).map((i) => i.id)).toEqual(["01"]);
    // A boxed item that cannot be removed yet is not counted as dismissed.
    await spool.write(item(3, true));
    await spool.take(3);
    await spool.sweep();
    fsOps.rm = async () => busy();
    expect(await spool.dismissRelayed(["03"])).toEqual({ removed: 0, left: ["03"] });
    fsOps.rm = real.rm;
    expect(await spool.dismissRelayed()).toEqual({ removed: 1, left: [] });
  });

  it("a session leaves a control request it cannot remove yet for a later pass", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const s = await openSession(devices[0]!, mesh, relay, { name: "a", env: { ...FS, platform: "win32" } });
    cleanup.push(() => s.stop());
    await fs.mkdir(s.files.controlDir, { recursive: true });
    const request = join(s.files.controlDir, "resume-x@one");
    let tries = 0;
    fsOps.rm = async (path) => (path === request && ++tries < 4 ? busy() : real.rm(path));
    await fs.writeFile(request, "");
    await until(async () => (await readText(request)) === undefined);
    expect(tries).toBe(4);
  });

  it("unread stops before an item still busy after the wait, and skips only a corrupt one", async () => {
    const spool = await Spool.open(join(await scratch("unread"), "spool"), win, 0);
    for (let i = 1; i <= 3; i++) await spool.write(item(i));
    const second = join(spool.dir, "000000000002.json");
    fsOps.sleep = async () => undefined;
    fsOps.readFile = async (path) => (path === second ? busy() : real.readFile(path));
    // Handing out item 3 would let a take move the cursor past item 2, which is never delivered.
    expect((await spool.unread()).map((i) => i.id)).toEqual(["01"]);
    fsOps.readFile = real.readFile;
    expect((await spool.unread()).map((i) => i.id)).toEqual(["01", "02", "03"]);
    // Gone between the listing and the read, or corrupt: skipped, as before.
    fsOps.readFile = async (path) => (path === second ? Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" })) : real.readFile(path));
    expect((await spool.unread()).map((i) => i.id)).toEqual(["01", "03"]);
    fsOps.readFile = real.readFile;
    await fs.writeFile(second, "{");
    expect((await spool.unread()).map((i) => i.id)).toEqual(["01", "03"]);
  });

  it("a sweep neither boxes nor removes an item still busy, and deals with it on a later pass", async () => {
    const spool = await Spool.open(join(await scratch("busysweep"), "spool"), win, 0);
    await spool.write(item(1, true));
    await spool.write(item(2));
    await spool.take(2);
    const first = join(spool.dir, "000000000001.json");
    fsOps.sleep = async () => undefined;
    fsOps.readFile = async (path) => (path === first ? busy() : real.readFile(path));
    expect((await spool.sweep()).map((i) => i.id)).toEqual(["02"]);
    expect(existsSync(first)).toBe(true);
    fsOps.readFile = real.readFile;
    expect(await spool.relayed()).toEqual([]);
    expect((await spool.sweep()).map((i) => i.id)).toEqual(["01"]);
    expect((await spool.relayed()).map((i) => i.id)).toEqual(["01"]);
  });

  it("a box item still busy is reported, not lost: its dismissal is left to ask again", async () => {
    const spool = await Spool.open(join(await scratch("busybox"), "spool"), win, 0);
    await spool.write(item(1, true));
    await spool.write(item(2, true));
    await spool.take(2);
    await spool.sweep();
    const boxed = join(spool.relayedDir, "000000000001.json");
    fsOps.sleep = async () => undefined;
    fsOps.readFile = async (path) => (path === boxed ? busy() : real.readFile(path));
    expect((await spool.relayed()).map((i) => i.id)).toEqual(["02"]);
    expect(await spool.dismissRelayed(["01", "02"])).toEqual({ removed: 1, left: ["01"] });
    expect(await spool.dismissRelayed()).toEqual({ removed: 0, left: [] });
    fsOps.readFile = real.readFile;
    expect(await spool.dismissRelayed(["01"])).toEqual({ removed: 1, left: [] });
    expect(await spool.relayed()).toEqual([]);
  });

  it("a session keeps a dismiss mark whose box item could not be read yet, and dismisses it on a later pass", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const s = await openSession(devices[0]!, mesh, relay, { name: "a", env: { ...FS, platform: "win32" } });
    cleanup.push(() => s.stop());
    const id = "01J00000000000000000000009";
    const boxed = join(s.spool.relayedDir, "000000000099.json");
    await fs.mkdir(s.spool.relayedDir, { recursive: true });
    await fs.writeFile(boxed, JSON.stringify({ cursor: 99, kind: "msg", from: "x@two", device: "d", id, at: 1, rendered: "r", relayed: true }));
    // Busy through one whole pass's wait, then readable.
    let tries = 0;
    fsOps.sleep = async () => undefined;
    fsOps.readFile = async (path) => (path === boxed && tries++ <= busyRetries("win32") ? busy() : real.readFile(path));
    await fs.mkdir(s.files.dismissDir, { recursive: true });
    await fs.writeFile(join(s.files.dismissDir, `${id}.dismiss`), "");
    await until(() => !existsSync(boxed));
    expect(tries).toBeGreaterThan(busyRetries("win32") + 1);
    await until(async () => (await fs.readdir(s.files.dismissDir)).length === 0);
  });

  it("a mark that cannot be removed yet is left for the next pass, so it is taken once", async () => {
    const dir = await scratch("marks");
    const id = "01J00000000000000000000001";
    await fs.writeFile(join(dir, `${id}.approve`), "");
    fsOps.rm = async () => busy();
    expect(await takeMarks(dir, ["approve"], win)).toEqual([]);
    fsOps.rm = real.rm;
    expect(await takeMarks(dir, ["approve"], win)).toEqual([{ id, mark: "approve" }]);
    expect(await takeMarks(dir, ["approve"], win)).toEqual([]);
  });
});

describe("lock takeover", () => {
  it("claimLock leaves alone a lock file that another process is still writing", async () => {
    const dir = await scratch();
    const lock = join(dir, "live.lock");
    await fs.writeFile(lock, "");
    let slept = 0;
    fsOps.sleep = async () => {
      // The other process finishes writing its pid.
      if (slept++ === 0) writeFileSync(lock, String(process.pid));
    };
    expect(await claimLock(lock, { platform: "linux", pid: 4242 })).toBe(false);
    expect(await readText(lock)).toBe(String(process.pid));
  });

  it("claimLock does not remove a lock that a contender took over a moment earlier", async () => {
    const dir = await scratch();
    const lock = join(dir, "live.lock");
    await fs.writeFile(lock, "999999");
    let raced = false;
    fsOps.kill = (pid) => {
      if (pid === 999999) {
        // While this caller decides the holder is dead, a contender replaces the stale lock.
        if (!raced) {
          raced = true;
          unlinkSync(lock);
          writeFileSync(lock, "222");
        }
        gone();
      }
    };
    expect(await claimLock(lock, { platform: "linux", pid: 111 })).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe("222");
  });

  it("withLock waits for a contender that took over a stale lock a moment earlier", async () => {
    const dir = await scratch();
    const lock = join(dir, "l.lock");
    await fs.writeFile(lock, "999999");
    const order: string[] = [];
    let raced = false;
    fsOps.kill = (pid) => {
      if (pid === 999999) {
        if (!raced) {
          raced = true;
          unlinkSync(lock);
          writeFileSync(lock, "222");
        }
        gone();
      }
    };
    fsOps.sleep = async () => {
      // The contender is still inside its lock when this caller first waits; then it leaves.
      order.push(`wait ${readFileSync(lock, "utf8")}`);
      unlinkSync(lock);
    };
    await withLock(lock, async () => void order.push("inside"), { platform: "linux", pid: 111 });
    expect(order).toEqual(["wait 222", "inside"]);
  });
});

describe("lock edge cases", () => {
  const me = { platform: "linux", pid: 111 } as const;
  const errno = (code: string) => Object.assign(new Error(code), { code });

  it("an empty lock older than EMPTY_LOCK_MS, a link and garbage are taken over", async () => {
    const dir = await scratch();
    const lock = join(dir, "live.lock");
    await fs.writeFile(lock, "");
    const old = (Date.now() - EMPTY_LOCK_MS - 1000) / 1000;
    utimesSync(lock, old, old);
    expect(await claimLock(lock, me)).toBe(true);
    expect(await readText(lock)).toBe("111");
    await fs.rm(lock);
    // A link at the lock path is taken over and replaced, never written through: on this
    // machine's platform, and as on Windows, where an exclusive create would follow it.
    for (const platform of new Set([process.platform, "win32"])) {
      await fs.symlink(join(dir, "nowhere"), lock);
      expect(await claimLock(lock, { platform, pid: 111 })).toBe(true);
      expect((await fs.lstat(lock)).isFile()).toBe(true);
      expect(existsSync(join(dir, "nowhere"))).toBe(false);
      await fs.rm(lock);
    }
    await fs.writeFile(lock, "12abc");
    expect(await withLock(lock, async () => "in", me)).toBe("in");
  });

  it("a lock that vanishes while it is looked at, or is moved by a contender first, is tried again", async () => {
    const dir = await scratch();
    const lock = join(dir, "live.lock");
    await fs.writeFile(lock, "999999");
    fsOps.kill = (pid) => (pid === 999999 ? gone() : undefined);
    let looks = 0;
    fsOps.lstat = async (p) => {
      if (looks++ === 0) throw errno("ENOENT");
      return real.lstat(p);
    };
    let renames = 0;
    fsOps.rename = async (a, b) => {
      // A contender moves the stale lock away just before this one does.
      if (renames++ === 0) {
        await real.rename(a, `${a}.theirs`);
        throw errno("ENOENT");
      }
      return real.rename(a, b);
    };
    expect(await claimLock(lock, me)).toBe(true);
    expect(looks).toBeGreaterThan(1);
  });

  it("does not put a contender's lock back over a third one, and surfaces other file errors", async () => {
    const dir = await scratch();
    const lock = join(dir, "live.lock");
    await fs.writeFile(lock, "999999");
    let raced = false;
    fsOps.kill = (pid) => {
      if (pid === 999999) {
        if (!raced) {
          raced = true;
          unlinkSync(lock);
          writeFileSync(lock, "222");
        }
        gone();
      }
    };
    fsOps.copyNew = async (_from, to) => {
      // A third process took the free name in between.
      writeFileSync(to, "333");
      throw errno("EEXIST");
    };
    expect(await claimLock(lock, me)).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe("333");
    expect((await fs.readdir(dir)).filter((n) => n.endsWith(".stale"))).toEqual([]);
    Object.assign(fsOps, real);
    raced = false;
    fsOps.kill = (pid) => {
      if (pid === 999999) {
        unlinkSync(lock);
        writeFileSync(lock, "222");
        gone();
      }
    };
    writeFileSync(lock, "999999");
    fsOps.copyNew = async () => {
      throw errno("EIO");
    };
    await expect(claimLock(lock, me)).rejects.toThrow("EIO");
    Object.assign(fsOps, real);
    writeFileSync(lock, "999999");
    fsOps.kill = gone;
    fsOps.rename = async () => {
      throw errno("EACCES");
    };
    await expect(claimLock(lock, me)).rejects.toThrow("EACCES");
    Object.assign(fsOps, real);
    fsOps.lstat = async () => {
      throw errno("EIO");
    };
    await expect(claimLock(lock, me)).rejects.toThrow("EIO");
  });
});

describe("writeNew and listFiles", () => {
  it("writeNew creates a file whole and refuses an existing one, also without hard links", async () => {
    const dir = await scratch();
    const p = join(dir, "sub", "k.json");
    await writeNew(p, "one", { platform: "linux", pid: 5 });
    expect(await readText(p)).toBe("one");
    // Windows has no POSIX mode bits to check.
    if (POSIX) expect((await fs.stat(p)).mode & 0o777).toBe(0o600);
    await expect(writeNew(p, "two")).rejects.toMatchObject({ code: "EEXIST" });
    fsOps.link = async () => {
      throw Object.assign(new Error("no links here"), { code: "EPERM" });
    };
    const q = join(dir, "q.json");
    await writeNew(q, "three");
    expect(await readText(q)).toBe("three");
    await expect(writeNew(q, "four")).rejects.toMatchObject({ code: "EEXIST" });
    expect((await fs.readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("listFiles names regular files only, none for a missing directory, and rethrows other errors", async () => {
    const dir = await scratch();
    await fs.writeFile(join(dir, "a"), "");
    await fs.mkdir(join(dir, "d"));
    await fs.symlink(join(dir, "a"), join(dir, "l"));
    expect(await listFiles(dir)).toEqual(["a"]);
    expect(await listFiles(join(dir, "none"))).toEqual([]);
    await expect(listFiles(join(dir, "a"))).rejects.toThrow();
  });
});

describe("first run", () => {
  it("two concurrent createDevice calls: one creates the key file, the other is refused", async () => {
    const h = new Home(await scratch("home"), { ...FS, uid: process.getuid?.() });
    const results = await Promise.allSettled([h.createDevice("alpha"), h.createDevice("beta")]);
    const made = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ id: string }>).value);
    expect(made.length).toBe(1);
    expect((await h.loadDevice())!.id).toBe(made[0]!.id);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(refused.reason)).toMatch(/already exists/);
  });

  it("createDevice passes on a file error that is not a lost race", async () => {
    const h = new Home(await scratch("home"), { ...FS, uid: process.getuid?.() });
    fsOps.link = async () => {
      // The directory goes away, so the fallback write cannot create the file either.
      await fs.rm(h.root, { recursive: true, force: true, maxRetries: 5 });
      throw Object.assign(new Error("disk on fire"), { code: "EIO" });
    };
    await expect(h.createDevice("x")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
