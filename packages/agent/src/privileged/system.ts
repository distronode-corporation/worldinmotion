// The privileged runner's real dependencies: files, users, the job lock, memory, the job
// process and signals. Kept apart from main.ts, which takes them as an interface.

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { dirname } from "node:path";
import { loadAnthropicCredentials } from "./auth.ts";
import { ownerProblem, type ReadRule } from "./config.ts";
import { awsWebIdentityToken } from "./identity.ts";
import { defaultScope, startScopedJob, type ScopeOptions } from "./jobscope.ts";
import { startProxy } from "./proxy.ts";
import type { JobHandle, JobSpec, Lock, PrivilegedDeps } from "./main.ts";
import { loadSdkQuery } from "./worker.ts";

export const FLOCK_BUSY = 75;

/** The uid and primary gid of a user, from `id`, which reads every name service the host uses. */
export function lookupUser(name: string, run = execFile): Promise<{ uid: number; gid: number }> {
  const one = (flag: string) =>
    new Promise<number>((resolve, reject) => {
      run("id", [flag, "--", name], { encoding: "utf8" }, (error, stdout) => {
        const n = Number(String(stdout).trim());
        if (error !== null || !Number.isInteger(n)) reject(new Error(`no such user ${name}`));
        else resolve(n);
      });
    });
  return Promise.all([one("-u"), one("-g")]).then(([uid, gid]) => ({ uid, gid }));
}

/**
 * The job lock, as flock(1) takes it: the same BSD lock a shell takes with `flock 9` on fd 9.
 * flock(1) locks the open file it is handed as fd 3; the lock belongs to that open file, which
 * this process keeps, so it stays held after flock(1) exits and ends when the file is closed.
 */
export async function acquireLock(path: string, waitSeconds: number, flock = "flock"): Promise<Lock | null> {
  // Never through a symlink: root opening a path the peer could have pointed elsewhere.
  const file = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o640);
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(flock, ["-w", String(waitSeconds), "-E", String(FLOCK_BUSY), "3"], { stdio: ["ignore", "ignore", "ignore", file.fd] });
    child.once("error", reject);
    child.once("exit", resolve);
  }).catch(async (error: unknown) => {
    await file.close();
    throw error;
  });
  if (code !== 0) {
    await file.close();
    if (code === FLOCK_BUSY) return null;
    throw new Error(`flock exited ${String(code)}`);
  }
  return { release: () => file.close() };
}

export async function memAvailableMb(path = "/proc/meminfo"): Promise<number | undefined> {
  const text = await fs.readFile(path, "utf8").catch(() => "");
  const m = /^MemAvailable:\s+(\d+) kB$/m.exec(text);
  return m === null ? undefined : Math.floor(Number(m[1]) / 1024);
}

/**
 * Starts the job: in its own transient systemd scope when `scope` says so (the runner's default
 * as root under systemd), else in its own process group. jobscope.ts says why.
 */
export function startJob(spec: JobSpec, scope: ScopeOptions = { mode: "none", unit: "", drainMs: 2000 }): JobHandle {
  return startScopedJob(spec, scope);
}

/**
 * Whether every process from `pid`'s parent up to pid 1 runs with real uid 0. A sudo call from
 * the peer always has the peer (a non-root real uid) among its ancestors, whatever a wrapper
 * does to the environment; a scheduled job started by systemd as root has only root above it.
 */
export async function ancestorsAllRoot(pid: number, proc = "/proc"): Promise<boolean> {
  let at = pid;
  for (let hops = 0; hops < 64; hops++) {
    const status = await fs.readFile(`${proc}/${at}/status`, "utf8").catch(() => "");
    const ppid = /^PPid:\s+(\d+)$/m.exec(status);
    const uid = /^Uid:\s+(\d+)\s/m.exec(status);
    if (ppid === null || uid === null) return false;
    if (at !== pid && uid[1] !== "0") return false;
    const parent = Number(ppid[1]);
    if (at === 1 || parent === 0) return true;
    at = parent;
  }
  return false;
}

export function readAll(stream: NodeJS.ReadableStream, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (c: Buffer) => {
      if (size <= max) chunks.push(c);
      size += c.length;
    });
    stream.once("end", () => resolve(Buffer.concat(chunks).subarray(0, max)));
    stream.once("error", reject);
  });
}

/** Reads a file without following a symlink, checking the owner and mode of the file it opened. */
export async function secureRead(path: string, rule: ReadRule): Promise<string> {
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await file.stat();
    const problem = ownerProblem({ uid: st.uid, mode: st.mode, isFile: st.isFile() }, rule);
    if (problem !== undefined) throw Object.assign(new Error(`refusing ${path}: ${problem}`), { code: "EUNSAFE" });
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

/**
 * Writes `path` through a new temporary file next to it, created with O_EXCL and O_NOFOLLOW (so
 * a planted name or symlink fails the write instead of redirecting it), owned through the handle,
 * then renamed over the target.
 */
export async function secureWrite(path: string, data: string, mode: number, owner: { uid: number; gid: number } | undefined): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.new`;
  const file = await fs.open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    if (owner !== undefined) await file.chown(owner.uid, owner.gid);
    await file.chmod(mode);
    await file.writeFile(data);
    await file.sync();
  } catch (error) {
    await file.close();
    await fs.rm(tmp, { force: true });
    throw error;
  }
  await file.close();
  await fs.rename(tmp, path);
}

/**
 * Makes `path` if it is missing, then checks what is there: a directory, not a symlink, and,
 * with an `owner` (root, in production), owned by it with no group or other write bit; then set
 * to that owner and `mode` through a handle on the directory itself.
 */
export async function secureDir(path: string, mode: number, owner: { uid: number; gid: number } | undefined, adopt = true): Promise<void> {
  await fs.mkdir(path, { recursive: true, mode });
  const st = await fs.lstat(path);
  if (!st.isDirectory()) throw Object.assign(new Error(`refusing ${path}: it is not a directory`), { code: "EUNSAFE" });
  if (owner === undefined) return;
  if (st.uid !== owner.uid || (st.mode & 0o022) !== 0) throw Object.assign(new Error(`refusing ${path}: it is not its owner's alone`), { code: "EUNSAFE" });
  // A directory another system shares (a lock's) is checked, never re-owned or re-moded.
  if (!adopt) return;
  const dir = await fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await dir.chown(owner.uid, owner.gid);
    await dir.chmod(mode);
  } finally {
    await dir.close();
  }
}

/**
 * Why the code this process runs could be changed by someone other than root, or undefined: each
 * file and every directory above it (after resolving symlinks) must be root's, with no group or
 * other write bit. A package tree the peer could write would let it change what root runs.
 */
export async function codeProblem(paths: readonly string[]): Promise<string | undefined> {
  for (const p of paths) {
    let at = await fs.realpath(p);
    for (;;) {
      const st = await fs.lstat(at);
      if (st.uid !== 0 || (st.mode & 0o022) !== 0) return `${at} is not root's alone`;
      const up = dirname(at);
      if (up === at) break;
      at = up;
    }
  }
  return undefined;
}

/** `euid` is this process's own, except in tests of the root branches. */
export function systemDeps(euid = process.geteuid!()): PrivilegedDeps {
  return {
    euid,
    uid: process.getuid!(),
    readStdin: (max) => readAll(process.stdin, max),
    readFile: secureRead,
    writeFile: (p, d, mode) => secureWrite(p, d, mode, euid === 0 ? { uid: 0, gid: 0 } : undefined),
    ensureDir: (p, mode, gid) => secureDir(p, mode, euid === 0 ? { uid: 0, gid: gid ?? 0 } : undefined),
    checkDir: (p) => secureDir(p, 0o755, euid === 0 ? { uid: 0, gid: 0 } : undefined, false),
    codeProblem: () => codeProblem([process.execPath, process.argv[1]!]),
    lookupUser: (name) => lookupUser(name),
    acquireLock: (p, w) => acquireLock(p, w),
    memAvailableMb: () => memAvailableMb(),
    ancestorsAllRoot: () => ancestorsAllRoot(process.pid),
    identity: {
      awsWebIdentityToken,
      fetch: (url, init) => fetch(url, init),
      readFile: (p) => fs.readFile(p, "utf8"),
    },
    credentials: loadAnthropicCredentials,
    fetch: (url, init) => fetch(url, init),
    startProxy,
    startJob: (spec) => startScopedJob(spec, defaultScope(euid, process.pid)),
    now: Date.now,
    onSignal(cb) {
      const sigs = ["SIGTERM", "SIGHUP", "SIGINT"] as const;
      for (const s of sigs) process.on(s, cb);
      return () => {
        for (const s of sigs) process.off(s, cb);
      };
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
    clearTimeout: (t) => clearTimeout(t as NodeJS.Timeout),
    out: (d) => void process.stdout.write(d),
    err: (line) => void process.stderr.write(`${line}\n`),
    worker: {
      readStdin: async () => (await readAll(process.stdin, 1024 * 1024)).toString("utf8"),
      out: (t) => void process.stdout.write(`${t}\n`),
      err: (line) => void process.stderr.write(`${line}\n`),
      loadQuery: loadSdkQuery,
    },
  };
}
