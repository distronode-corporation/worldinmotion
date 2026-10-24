import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimLock, ensureDir, fsOps, listDir, lockHeld, readJson, readText, releaseLock, removeFile, tryRemove, whileBusy, withLock, writeAtomic, writeJson } from "../src/fsx.ts";
import { FS, POSIX, scratch } from "./helpers.ts";

const realRename = fsOps.rename;
const realKill = fsOps.kill;
const realSleep = fsOps.sleep;
const realReadFile = fsOps.readFile;
const realRm = fsOps.rm;
afterEach(() => {
  fsOps.readFile = realReadFile;
  fsOps.rm = realRm;
  fsOps.rename = realRename;
  fsOps.kill = realKill;
  fsOps.sleep = realSleep;
});

describe("writeAtomic", () => {
  it("writes a private file and replaces it whole", async () => {
    const dir = await scratch();
    const p = join(dir, "a", "b.json");
    await writeAtomic(p, "one");
    await writeAtomic(p, new TextEncoder().encode("two"));
    expect(await readText(p)).toBe("two");
    // Windows has no POSIX mode bits to check.
    if (POSIX) {
      expect((await fs.stat(p)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(join(dir, "a"))).mode & 0o777).toBe(0o700);
    }
    expect((await listDir(join(dir, "a"))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("retries a busy rename on Windows and gives up after the retries", async () => {
    const dir = await scratch();
    let calls = 0;
    fsOps.sleep = async () => undefined;
    fsOps.rename = async (a, b) => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      await realRename(a, b);
    };
    await writeAtomic(join(dir, "w"), "x", { platform: "win32", pid: 1 });
    expect(calls).toBe(3);
    fsOps.rename = async () => {
      throw Object.assign(new Error("perm"), { code: "EPERM" });
    };
    await expect(writeAtomic(join(dir, "w2"), "x", { platform: "win32", pid: 1 })).rejects.toThrow("perm");
    await expect(writeAtomic(join(dir, "w3"), "x", FS)).rejects.toThrow("perm");
    fsOps.rename = async () => {
      throw Object.assign(new Error("other"), { code: "EIO" });
    };
    await expect(writeAtomic(join(dir, "w4"), "x", { platform: "win32", pid: 1 })).rejects.toThrow("other");
    expect((await listDir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("closes the temp file when the write fails", async () => {
    const dir = await scratch();
    await expect(writeAtomic(join(dir, "x"), 5 as unknown as string)).rejects.toThrow();
  });
});

describe("reads", () => {
  it("returns undefined for missing files and rethrows other errors", async () => {
    const dir = await scratch();
    expect(await readText(join(dir, "none"))).toBeUndefined();
    expect(await readJson(join(dir, "none"))).toBeUndefined();
    expect(await listDir(join(dir, "none"))).toEqual([]);
    await expect(readText(dir)).rejects.toThrow();
    await fs.writeFile(join(dir, "f"), "x");
    await expect(listDir(join(dir, "f"))).rejects.toThrow();
  });

  it("waits out a busy moment for one named file, on Windows only, and nowhere else", async () => {
    const dir = await scratch();
    const p = join(dir, "f");
    await fs.writeFile(p, "12");
    fsOps.sleep = async () => undefined;
    // A file another handle is deleting answers EPERM until that handle closes.
    let fails = 0;
    fsOps.readFile = async (path) => {
      if (fails-- > 0) throw Object.assign(new Error("delete pending"), { code: "EPERM" });
      return realReadFile(path);
    };
    const win = { platform: "win32", pid: 1 } as const;
    const posix = { platform: "linux", pid: 1 } as const;
    fails = 2;
    expect(await whileBusy(() => readText(p), win.platform)).toBe("12");
    fails = 1;
    await expect(whileBusy(() => readText(p), posix.platform)).rejects.toThrow("delete pending");
    // A plain read never waits: a pass over many entries skips a busy one at once.
    fails = 1;
    await expect(readText(p)).rejects.toThrow("delete pending");
    // A lock being removed by its holder is looked at again, not an error. ("left over" names
    // no holder, so it is taken over.)
    const lock = join(dir, "l.lock");
    await fs.writeFile(lock, "left over");
    fails = 2;
    expect(await withLock(lock, async () => "in", win)).toBe("in");
    await fs.writeFile(lock, "left over");
    fails = 1;
    await expect(withLock(lock, async () => "in", posix)).rejects.toThrow("delete pending");
    // Whether a live process holds a lock is read through a busy moment too.
    await fs.writeFile(lock, String(process.pid));
    fails = 2;
    expect(await lockHeld(lock, { ...win, pid: process.pid + 1 })).toBe(true);
    fsOps.readFile = realReadFile;
    // Releasing a lock waits out a busy moment; removing a directory entry does not.
    let rmFails = 0;
    fsOps.rm = async (path) => {
      if (rmFails-- > 0) throw Object.assign(new Error("in use"), { code: "EBUSY" });
      return realRm(path);
    };
    rmFails = 2;
    await releaseLock(lock, win);
    expect(await readText(lock)).toBeUndefined();
    await fs.writeFile(p, "x");
    rmFails = 1;
    expect(await tryRemove(p, win)).toBe(false);
    expect(await readText(p)).toBe("x");
    expect(await tryRemove(p, win)).toBe(true);
    expect(await readText(p)).toBeUndefined();
    await fs.writeFile(p, "x");
    rmFails = 1;
    await expect(tryRemove(p, posix)).rejects.toThrow("in use");
  });

  it("parses JSON strictly", async () => {
    const dir = await scratch();
    await writeJson(join(dir, "ok.json"), { a: 1 });
    expect(await readJson(join(dir, "ok.json"))).toEqual({ a: 1 });
    await fs.writeFile(join(dir, "dup.json"), '{"a":1,"a":2}');
    await expect(readJson(join(dir, "dup.json"))).rejects.toThrow(/duplicate key/);
    await fs.writeFile(join(dir, "bad.json"), "{");
    await expect(readJson(join(dir, "bad.json"))).rejects.toThrow(/not valid JSON/);
    await removeFile(join(dir, "bad.json"));
    await ensureDir(join(dir, "d"));
  });
});

describe("withLock", () => {
  it("serialises holders and removes the lock", async () => {
    const dir = await scratch();
    const lock = join(dir, "l.lock");
    const order: string[] = [];
    await Promise.all([
      withLock(lock, async () => {
        order.push("a1");
        await new Promise((r) => setTimeout(r, 30));
        order.push("a2");
      }),
      withLock(lock, async () => {
        order.push("b");
      }),
    ]);
    expect(order.join(",")).toMatch(/^(a1,a2,b|b,a1,a2)$/);
    expect(await readText(lock)).toBeUndefined();
  });

  it("takes over a lock left by a dead process and times out on a live one", async () => {
    const dir = await scratch();
    const lock = join(dir, "l.lock");
    await fs.writeFile(lock, "999999");
    fsOps.kill = () => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    };
    expect(await withLock(lock, async () => 7)).toBe(7);
    await fs.writeFile(lock, "999999");
    fsOps.kill = () => undefined;
    await expect(withLock(lock, async () => 1, FS, 30)).rejects.toThrow(/held by another process/);
    await fs.writeFile(lock, "");
    await expect(withLock(lock, async () => 1, FS, 30)).rejects.toThrow(/held/);
  });

  it("rethrows unexpected errors", async () => {
    const dir = await scratch();
    await fs.writeFile(join(dir, "file"), "x");
    await expect(withLock(join(dir, "file", "sub.lock"), async () => 1)).rejects.toThrow();
  });
});

describe("claimLock", () => {
  it("claims, re-claims for the same pid, refuses a live holder, takes over a dead one", async () => {
    const dir = await scratch();
    const lock = join(dir, "live.lock");
    expect(await claimLock(lock, { platform: "linux", pid: 11 })).toBe(true);
    expect(await claimLock(lock, { platform: "linux", pid: 11 })).toBe(true);
    fsOps.kill = () => undefined;
    expect(await claimLock(lock, { platform: "linux", pid: 12 })).toBe(false);
    expect(await lockHeld(lock, { platform: "linux", pid: 12 })).toBe(true);
    expect(await lockHeld(lock, { platform: "linux", pid: 11 })).toBe(false);
    fsOps.kill = () => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    };
    expect(await lockHeld(lock, { platform: "linux", pid: 12 })).toBe(false);
    expect(await claimLock(lock, { platform: "linux", pid: 12 })).toBe(true);
    await fs.writeFile(lock, "garbage");
    expect(await claimLock(lock, { platform: "linux", pid: 13 })).toBe(true);
    expect(await lockHeld(join(dir, "none"), FS)).toBe(false);
    await fs.writeFile(join(dir, "file"), "x");
    await expect(claimLock(join(dir, "file", "x.lock"))).rejects.toThrow();
  });
});
