import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimLock, ensureDir, fsOps, listDir, lockHeld, readJson, readText, removeFile, withLock, writeAtomic, writeJson } from "../src/fsx.ts";
import { FS, POSIX, scratch } from "./helpers.ts";

const realRename = fsOps.rename;
const realKill = fsOps.kill;
const realSleep = fsOps.sleep;
afterEach(() => {
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
