// Locks across pid namespaces (#141): a holder in another pid namespace (a Flatpak app, a container
// sharing the home folder, a sandboxed shell) is alive, whatever `kill` answers here; the lock file
// stays the bare pid earlier clients read, with the namespace in a record beside it; a session's
// stop removes only a lock it still holds; and spool numbers survive another process's entries.

import { ulid } from "@worldinmotion/protocol";
import { promises as fs, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MeshSession } from "../src/client.ts";
import { claimLock, fsOps, lockHeld, lockHeldBy, lockMine, namespacePath, ownPidNamespace, readText, releaseLock, withLock, type FsEnv } from "../src/fsx.ts";
import { MeshFiles } from "../src/mesh.ts";
import { resumeEverywhere } from "../src/offline.ts";
import { SessionFiles } from "../src/session.ts";
import { itemName, Spool } from "../src/spool.ts";
import { FS, LIVE_PID, makeMesh, openSession, RelayHarness, scratch } from "./helpers.ts";

const real = { ...fsOps };
const open: MeshSession[] = [];
afterEach(async () => {
  Object.assign(fsOps, real);
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

const LINUX: FsEnv = { platform: "linux", pid: 111 };
const MINE = "pid:[4026531836]";
const THEIRS = "pid:[4026532999]";
const errno = (code: string) => Object.assign(new Error(code), { code });

/** This process runs in namespace `ns`; every pid but the ones in `alive` is gone (ESRCH). */
function world(ns: string | undefined, alive: readonly number[] = []): void {
  fsOps.readlink = async (path) => {
    expect(path).toBe("/proc/self/ns/pid");
    if (ns === undefined) throw errno("ENOENT");
    return ns;
  };
  fsOps.kill = (pid) => {
    if (!alive.includes(pid)) throw errno("ESRCH");
  };
}

/** A lock file naming `pid`, and the record a holder in `ns` wrote beside it (for `ino`, default the lock's own). */
async function lockOf(pid: number, ns?: string, record?: { pid?: number; ino?: string }): Promise<string> {
  const lock = join(await scratch("ns"), "live.lock");
  await fs.writeFile(lock, String(pid));
  if (ns !== undefined) {
    const ino = record?.ino ?? String(statSync(lock, { bigint: true }).ino);
    await fs.writeFile(namespacePath(lock), `${record?.pid ?? pid} ${ino} ${ns}\n`);
  }
  return lock;
}

describe("a lock held from another pid namespace", () => {
  it("is never taken over, whatever kill answers here", async () => {
    world(MINE);
    const lock = await lockOf(4242, THEIRS);
    expect(await claimLock(lock, LINUX)).toBe(false);
    expect(await readText(lock)).toBe("4242");
    expect(await lockHeld(lock, LINUX)).toBe(true);
    expect(await lockHeldBy(lock, 4242, LINUX)).toBe(true);
    expect(await lockMine(lock, LINUX)).toBe(false);
    await expect(withLock(lock, async () => "in", LINUX, 50)).rejects.toThrow("is held by another process");
    // Releasing what is not this process's leaves it.
    await releaseLock(lock, LINUX);
    expect(await readText(lock)).toBe("4242");
  });

  it("is not this process's when the pid is the same but the namespace is not", async () => {
    world(MINE);
    const lock = await lockOf(LINUX.pid, THEIRS);
    expect(await lockMine(lock, LINUX)).toBe(false);
    expect(await lockHeld(lock, LINUX)).toBe(true);
    expect(await claimLock(lock, LINUX)).toBe(false);
    await releaseLock(lock, LINUX);
    expect(await readText(lock)).toBe(String(LINUX.pid));
  });

  it("counts as another namespace when this process cannot read its own", async () => {
    world(undefined);
    expect(await ownPidNamespace()).toBeUndefined();
    expect(await claimLock(await lockOf(4242, MINE), LINUX)).toBe(false);
    // With no record at all, the pid alone decides, as before.
    expect(await claimLock(await lockOf(4242), LINUX)).toBe(true);
  });

  it("is judged by its pid in this namespace, or with no record (an older client's lock, another platform)", async () => {
    world(MINE, [4343]);
    // The same namespace: kill tells, so a dead holder's lock is taken over and a live one's is not.
    const dead = await lockOf(4242, MINE);
    expect(await lockHeld(dead, LINUX)).toBe(false);
    expect(await lockHeldBy(dead, 4242, LINUX)).toBe(false);
    expect(await claimLock(dead, LINUX)).toBe(true);
    expect(await readText(dead)).toBe("111");
    expect(await claimLock(await lockOf(4343, MINE), LINUX)).toBe(false);
    // A record for another holder or an earlier lock file counts for nothing.
    expect(await claimLock(await lockOf(4242, THEIRS, { pid: 4343 }), LINUX)).toBe(true);
    expect(await claimLock(await lockOf(4242, THEIRS, { ino: "1" }), LINUX)).toBe(true);
    // An older client's lock is the bare pid with no record: judged by kill alone.
    expect(await claimLock(await lockOf(4242), LINUX)).toBe(true);
    // Off Linux there are no pid namespaces to read: a record is not even looked at.
    expect(await claimLock(await lockOf(4242, THEIRS), { platform: "darwin", pid: 111 })).toBe(true);
    // A record that cannot be read is no record.
    const unreadable = await lockOf(4242);
    await fs.mkdir(namespacePath(unreadable));
    expect(await claimLock(unreadable, LINUX)).toBe(true);
    // A lock that is not one names nobody.
    expect(await lockHeldBy(join(await scratch("ns"), "none.lock"), 4242, LINUX)).toBe(false);
  });
});

describe("the namespace record", () => {
  it("is written beside the lock, for its file, before its pid; the lock file is the bare pid as in 0.2.0", async () => {
    world(MINE);
    const lock = join(await scratch("ns"), "live.lock");
    let seen: string | undefined;
    // Each record is renamed into place while the lock is still empty.
    fsOps.rename = async (from, to) => {
      seen = readFileSync(lock, "utf8");
      return real.rename(from, to);
    };
    expect(await claimLock(lock, LINUX)).toBe(true);
    expect(seen).toBe("");
    expect(readFileSync(lock, "utf8")).toBe("111");
    expect(/^[1-9]\d{0,15}$/.test(readFileSync(lock, "utf8"))).toBe(true);
    expect(readFileSync(namespacePath(lock), "utf8")).toBe(`111 ${statSync(lock, { bigint: true }).ino} ${MINE}\n`);
    expect(await lockMine(lock, LINUX)).toBe(true);
    await releaseLock(lock, LINUX);
    expect(await readText(lock)).toBeUndefined();
    // The record stays and counts for nothing once the lock it was for is gone.
    expect(await readText(namespacePath(lock))).toContain(MINE);
    expect((await fs.readdir(join(lock, ".."))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("is real on this machine: this process's own namespace, read from /proc", async () => {
    const ns = await ownPidNamespace();
    if (process.platform === "linux") expect(ns).toMatch(/^pid:\[\d+\]$/);
    const lock = join(await scratch("ns"), "live.lock");
    expect(await claimLock(lock, FS)).toBe(true);
    expect(await lockMine(lock, FS)).toBe(true);
    if (process.platform === "linux") expect(await readText(namespacePath(lock))).toBe(`${process.pid} ${statSync(lock, { bigint: true }).ino} ${ns}\n`);
    else expect(await readText(namespacePath(lock))).toBeUndefined();
  });

  it("is best effort: none where the namespace cannot be read or the record cannot be written, and the lock is still taken", async () => {
    world(undefined);
    const lock = join(await scratch("ns"), "live.lock");
    expect(await claimLock(lock, LINUX)).toBe(true);
    expect(await readText(namespacePath(lock))).toBeUndefined();
    world(MINE);
    fsOps.rename = async () => {
      throw errno("EIO");
    };
    const other = join(await scratch("ns"), "live.lock");
    expect(await claimLock(other, LINUX)).toBe(true);
    expect(await readText(namespacePath(other))).toBeUndefined();
    expect((await fs.readdir(join(other, ".."))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    // A temp file that cannot be removed either is left; nothing reads it.
    fsOps.rm = async () => {
      throw errno("EIO");
    };
    expect(await claimLock(join(await scratch("ns"), "live.lock"), LINUX)).toBe(true);
  });

  it("still matches a fresh lock a takeover put back, which keeps its file (a hard link)", async () => {
    world(MINE);
    const lock = await lockOf(999999);
    let raced = false;
    let fresh = "";
    fsOps.kill = (pid) => {
      // While this caller decides the holder is dead, a contender in another namespace takes the
      // stale lock over: a new lock file, and its record.
      if (pid === 999999 && !raced) {
        raced = true;
        unlinkSync(lock);
        writeFileSync(lock, "222");
        fresh = String(statSync(lock, { bigint: true }).ino);
        writeFileSync(namespacePath(lock), `222 ${fresh} ${THEIRS}\n`);
      }
      throw errno("ESRCH");
    };
    expect(await claimLock(lock, LINUX)).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe("222");
    expect(String(statSync(lock, { bigint: true }).ino)).toBe(fresh);
    // Its holder is still another namespace's, so still alive here.
    expect(await lockHeld(lock, LINUX)).toBe(true);
    expect((await fs.readdir(join(lock, ".."))).filter((n) => n.endsWith(".stale"))).toEqual([]);
  });
});

describe("the readers that act on a session's lock", () => {
  it("resumeEverywhere leaves a session a foreign namespace runs a marker, takes nothing over, and releases nothing", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const files = new MeshFiles(devices[0]!.home.meshDir(mesh), FS);
    const session = new SessionFiles(files, ulid(), FS);
    await fs.mkdir(session.dir, { recursive: true });
    await fs.writeFile(session.liveLock, "4242");
    await fs.writeFile(namespacePath(session.liveLock), `4242 ${statSync(session.liveLock, { bigint: true }).ino} ${THEIRS}\n`);
    world(MINE);
    expect(await resumeEverywhere(files, "a@one", { platform: "linux", pid: process.pid }, Date.now)).toBe(0);
    expect(await fs.readdir(session.controlDir)).toEqual(["resume-a@one"]);
    expect(await readText(session.liveLock)).toBe("4242");
  });

  it("MeshSession.stop removes the lock only while it still holds it", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const s = await openSession(devices[0]!, mesh, relay, { name: "short" });
    open.push(s);
    expect(await s.files.holds()).toBe(true);
    // Another live process holds it now (a takeover this one did not see).
    await fs.writeFile(s.files.liveLock, String(LIVE_PID));
    expect(await s.files.holds()).toBe(false);
    await s.stop();
    expect(await readText(s.files.liveLock)).toBe(String(LIVE_PID));
    // A session that still holds its lock removes it.
    const t = await openSession(devices[0]!, mesh, relay, { name: "other" });
    await t.stop();
    expect(await readText(t.files.liveLock)).toBeUndefined();
  });
});

describe("spool numbering with another writer", () => {
  it("numbers past every item on disk and the cursor, and never writes over one another process wrote", async () => {
    const dir = join(await scratch("spool"), "spool");
    const ours = await Spool.open(dir, FS, 0);
    // Another process opened the same spool before anything was in it.
    const theirs = await Spool.open(dir, FS, 0);
    const a = await theirs.write({ kind: "msg", from: "x@y", device: "d", id: "A", at: 1, rendered: "a" });
    const b = await ours.write({ kind: "msg", from: "x@y", device: "d", id: "B", at: 1, rendered: "b" });
    expect([a.cursor, b.cursor]).toEqual([1, 2]);
    expect((await ours.unread()).map((i) => i.id)).toEqual(["A", "B"]);
    // Past the cursor too, when the items before it were taken and swept.
    await ours.take(2);
    await ours.sweep();
    expect((await theirs.write({ kind: "msg", from: "x@y", device: "d", id: "C", at: 1, rendered: "c" })).cursor).toBe(3);
    expect((await ours.unread()).map((i) => i.id)).toEqual(["C"]);
  });

  it("takes the next number when another process takes the same name at the same moment", async () => {
    const dir = join(await scratch("spool"), "spool");
    const spool = await Spool.open(dir, FS, 0);
    let raced = false;
    fsOps.link = async (from, to) => {
      if (!raced && to.endsWith(itemName(1))) {
        raced = true;
        writeFileSync(to, JSON.stringify({ cursor: 1, kind: "msg", from: "x@y", device: "d", id: "THEIRS", at: 1, rendered: "t" }));
      }
      return real.link(from, to);
    };
    expect((await spool.write({ kind: "msg", from: "x@y", device: "d", id: "OURS", at: 1, rendered: "o" })).cursor).toBe(2);
    expect((await spool.unread()).map((i) => i.id)).toEqual(["THEIRS", "OURS"]);
    // Any other failure is the caller's: here the directory goes away under the write.
    fsOps.link = async () => {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
      throw errno("EIO");
    };
    await expect(spool.write({ kind: "msg", from: "x@y", device: "d", id: "X", at: 1, rendered: "x" })).rejects.toMatchObject({ code: "ENOENT" });
  });
});
