// File helpers for state on disk: atomic writes, private directories, strict JSON reads and a
// lock file shared by every process of one device. No native addons: locks are `O_EXCL` files.

import { parseJson, randomBytes, b64u } from "@worldinmotion/protocol";
import { constants, promises as fs, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { createFollowsLinks, pidAlive, renameRetries, type Platform } from "./platform.ts";

/** The `open` flag that refuses a symbolic link, where the platform has one (not on Windows). */
export function noFollow(c: { O_NOFOLLOW?: number }): number {
  return c.O_NOFOLLOW ?? 0;
}

/**
 * Opens a file, never through a link; undefined when it is missing, a link, or cannot be opened.
 * `flags` with O_NOFOLLOW refuse a link at the open, where the platform has it. Windows has none,
 * so on every platform the path must also still name the very file that was opened.
 */
export async function openNoFollow(path: string, flags: number): Promise<FileHandle | undefined> {
  const handle = await fs.open(path, flags).catch(() => undefined);
  if (handle === undefined) return undefined;
  let keep = false;
  try {
    const opened = await handle.stat({ bigint: true });
    const named = await fs.lstat(path, { bigint: true });
    keep = !named.isSymbolicLink() && named.ino === opened.ino;
    return keep ? handle : undefined;
  } finally {
    if (!keep) await handle.close();
  }
}

/** The calls that can fail in ways tests need to provoke; swapped in tests, never in production. */
export const fsOps = {
  rename: (from: string, to: string): Promise<void> => fs.rename(from, to),
  link: (existing: string, path: string): Promise<void> => fs.link(existing, path),
  copyNew: (from: string, to: string): Promise<void> => fs.copyFile(from, to, constants.COPYFILE_EXCL),
  lstat: (path: string): Promise<BigIntStats> => fs.lstat(path, { bigint: true }),
  readFile: (path: string): Promise<string> => fs.readFile(path, "utf8"),
  kill: (pid: number, signal: 0): void => void process.kill(pid, signal),
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type FsEnv = { platform: Platform; pid: number };

export const realFsEnv: FsEnv = { platform: process.platform, pid: process.pid };

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Creates a directory (and parents) readable only by this user. */
export async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
}

/**
 * Writes a file atomically: a temp file in the same directory, flushed to disk, then renamed
 * over the target, so a reader sees the old or the new content and never half of it.
 */
export async function writeAtomic(path: string, data: string | Uint8Array, env: FsEnv = realFsEnv, mode = 0o600): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${env.pid}.${b64u.encode(randomBytes(6))}.tmp`;
  const handle = await fs.open(tmp, "wx", mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await fsOps.rename(tmp, path);
      return;
    } catch (error) {
      const busy = code(error) === "EPERM" || code(error) === "EBUSY";
      if (!busy || attempt >= renameRetries(env.platform)) {
        await fs.rm(tmp, { force: true });
        throw error;
      }
      await fsOps.sleep(20);
    }
  }
}

/**
 * Writes a file that must not exist yet, whole or not at all: a flushed temp file hard-linked to
 * the target, which fails with EEXIST when the target is there. Where the file system has no hard
 * links, the target is created exclusively and written in place.
 */
export async function writeNew(path: string, data: string, env: FsEnv = realFsEnv, mode = 0o600): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${env.pid}.${b64u.encode(randomBytes(6))}.tmp`;
  await fs.writeFile(tmp, data, { mode, flag: "wx", flush: true });
  try {
    await fsOps.link(tmp, path);
  } catch (error) {
    if (code(error) === "EEXIST") throw error;
    await fs.writeFile(path, data, { mode, flag: "wx", flush: true });
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/** A file's text, or undefined when it does not exist. */
export async function readText(path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path, "utf8");
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** A JSON file, parsed strictly (duplicate keys refused), or undefined when it does not exist. */
export async function readJson(path: string): Promise<unknown> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  const parsed = parseJson(text);
  if (!parsed.ok) throw new Error(`${path}: ${parsed.reason === "duplicate_key" ? "duplicate key" : "not valid JSON"}`);
  return parsed.value;
}

export async function writeJson(path: string, value: unknown, env: FsEnv = realFsEnv): Promise<void> {
  await writeAtomic(path, `${JSON.stringify(value, null, 1)}\n`, env);
}

/** Names in a directory, or none when it does not exist. */
export async function listDir(path: string): Promise<string[]> {
  try {
    return await fs.readdir(path);
  } catch (error) {
    if (code(error) === "ENOENT") return [];
    throw error;
  }
}

/** Names of the regular files in a directory (links and directories left out), or none when it does not exist. */
export async function listFiles(path: string): Promise<string[]> {
  try {
    return (await fs.readdir(path, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch (error) {
    if (code(error) === "ENOENT") return [];
    throw error;
  }
}

export async function removeFile(path: string): Promise<void> {
  await fs.rm(path, { force: true });
}

/** How long an empty lock file counts as one being written; after that its writer is taken to be dead. */
export const EMPTY_LOCK_MS = 5_000;

/** A lock file's holder and an identity that changes whenever the file is replaced; undefined when it is gone. */
async function lookAt(path: string): Promise<{ holder: number | undefined; text: string; id: string; age: number } | undefined> {
  try {
    const st = await fsOps.lstat(path);
    // A link (or anything else) at a lock path is not a lock: it is taken over at once.
    const text = st.isFile() ? await fsOps.readFile(path) : "(not a file)";
    const holder = /^[1-9]\d{0,15}$/.test(text) ? Number(text) : undefined;
    return { holder, text, id: `${st.ino}:${st.mtimeNs}:${text}`, age: Date.now() - Number(st.mtimeMs) };
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Removes a stale lock without ever removing a fresh one: the file is renamed aside first (only
 * one contender can move a given file), and removed only if it is still the stale file that was
 * looked at. A fresh lock that a contender put in place meanwhile is put back, never over a newer
 * one.
 */
async function takeOver(path: string, seen: string, env: FsEnv): Promise<void> {
  const aside = `${path}.${env.pid}.${b64u.encode(randomBytes(6))}.stale`;
  try {
    await fsOps.rename(path, aside);
  } catch (error) {
    // Another contender moved it first.
    if (code(error) === "ENOENT") return;
    throw error;
  }
  try {
    // Nothing else knows the aside name, so the file is there.
    if ((await lookAt(aside))!.id !== seen) {
      await fsOps.copyNew(aside, path).catch((error: unknown) => {
        // A third process took the free name: the lock is held either way.
        if (code(error) !== "EEXIST") throw error;
      });
    }
  } finally {
    await removeFile(aside);
  }
}

/**
 * One look at a lock that exists: held by a live process (`held`), being written (`busy`), gone
 * or taken over just now (`retry`). An empty file is a lock being written, until it is older than
 * EMPTY_LOCK_MS.
 */
async function contend(path: string, env: FsEnv, mine: boolean): Promise<"mine" | "held" | "busy" | "retry"> {
  const seen = await lookAt(path);
  if (seen === undefined) return "retry";
  if (mine && seen.holder === env.pid) return "mine";
  if (seen.holder !== undefined && pidAlive(seen.holder, fsOps.kill)) return "held";
  if (seen.text === "" && seen.age < EMPTY_LOCK_MS) return "busy";
  await takeOver(path, seen.id, env);
  return "retry";
}

/** Creates the lock file with this process's pid; false when it already exists. */
async function create(path: string, env: FsEnv): Promise<boolean> {
  // Where the create would follow a link, anything at the path (a dangling link too) counts as
  // an existing lock, so a link is taken over like any other stale lock and never written through.
  if (createFollowsLinks(env.platform) && (await lookAt(path)) !== undefined) return false;
  try {
    const handle = await fs.open(path, "wx", 0o600);
    await handle.writeFile(String(env.pid));
    await handle.close();
    return true;
  } catch (error) {
    if (code(error) !== "EEXIST") throw error;
    return false;
  }
}

/**
 * Runs `fn` while holding `lockPath`. The lock file holds the holder's pid, so a lock left by a
 * process that died is taken over instead of blocking forever. Waits up to `timeoutMs`.
 */
export async function withLock<T>(lockPath: string, fn: () => Promise<T>, env: FsEnv = realFsEnv, timeoutMs = 10_000): Promise<T> {
  await ensureDir(dirname(lockPath));
  const started = Date.now();
  while (!(await create(lockPath, env))) {
    // Another holder in this same process waits like any other: the lock is not reentrant.
    if ((await contend(lockPath, env, false)) === "retry") continue;
    if (Date.now() - started > timeoutMs) throw new Error(`${lockPath} is held by another process`);
    await fsOps.sleep(15);
  }
  try {
    return await fn();
  } finally {
    await removeFile(lockPath);
  }
}

/**
 * Claims a long-lived lock for this process (a session's liveness marker). Returns false when a
 * live process holds it. The caller removes it on exit; a crash leaves it stale, and the next
 * claim takes it over.
 */
export async function claimLock(lockPath: string, env: FsEnv = realFsEnv): Promise<boolean> {
  await ensureDir(dirname(lockPath));
  while (!(await create(lockPath, env))) {
    const state = await contend(lockPath, env, true);
    if (state === "mine") return true;
    if (state === "held") return false;
    if (state === "busy") await fsOps.sleep(15);
  }
  return true;
}

/** True when a live process other than this one holds `lockPath`. */
export async function lockHeld(lockPath: string, env: FsEnv = realFsEnv): Promise<boolean> {
  const holder = Number(await readText(lockPath));
  return Number.isSafeInteger(holder) && holder > 0 && holder !== env.pid && pidAlive(holder, fsOps.kill);
}
