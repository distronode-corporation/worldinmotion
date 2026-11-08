// The privileged runner's real dependencies: files, users, the job lock, memory, the job
// process and signals. Kept apart from main.ts, which takes them as an interface.

import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { awsWebIdentityToken } from "./identity.ts";
import { defaultScope, startScopedJob, type ScopeOptions } from "./jobscope.ts";
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
  const file = await fs.open(path, "a", 0o640);
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

export function systemDeps(): PrivilegedDeps {
  return {
    euid: process.geteuid!(),
    uid: process.getuid!(),
    readStdin: (max) => readAll(process.stdin, max),
    configFs: {
      readFile: (p) => fs.readFile(p, "utf8"),
      stat: async (p) => {
        const s = await fs.lstat(p);
        return { uid: s.uid, mode: s.isFile() ? s.mode : 0o777 };
      },
    },
    brokerFs: {
      writeFile: (p, d, mode) => fs.writeFile(p, d, { mode, flag: "w" }),
      chown: (p, u, g) => fs.chown(p, u, g),
      rename: (a, b) => fs.rename(a, b),
      rm: (p) => fs.rm(p, { force: true }),
    },
    mkdir: async (p, mode) => void (await fs.mkdir(p, { recursive: true, mode })),
    chown: (p, u, g) => fs.chown(p, u, g),
    lookupUser: (name) => lookupUser(name),
    acquireLock: (p, w) => acquireLock(p, w),
    memAvailableMb: () => memAvailableMb(),
    ancestorsAllRoot: () => ancestorsAllRoot(process.pid),
    identity: {
      awsWebIdentityToken,
      fetch: (url, init) => fetch(url, init),
      readFile: (p) => fs.readFile(p, "utf8"),
    },
    startJob: (spec) => startScopedJob(spec, defaultScope(process.geteuid!(), process.pid)),
    now: Date.now,
    pid: process.pid,
    onSignal(cb) {
      const sigs = ["SIGTERM", "SIGHUP", "SIGINT"] as const;
      for (const s of sigs) process.on(s, cb);
      return () => {
        for (const s of sigs) process.off(s, cb);
      };
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
    clearTimeout: (t) => clearTimeout(t as NodeJS.Timeout),
    setInterval: (fn, ms) => setInterval(fn, ms).unref(),
    clearInterval: (t) => clearInterval(t as NodeJS.Timeout),
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
