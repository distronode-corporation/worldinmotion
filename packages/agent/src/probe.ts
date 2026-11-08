// Read-only probes `wim agent doctor` runs as another user: can that user open a TCP connection,
// read a file, or write to a path? Each probe is a tiny Node child started with the user's uid and
// gid (which needs root), or as this process when the user is the one running doctor. A probe
// never writes anything: `write` asks the kernel with access(2), it does not create a file.

import { execFile as nodeExecFile, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFile as fsReadFile } from "node:fs/promises";

export type ProbeOp =
  | { op: "connect"; host: string; port: number; timeoutMs: number }
  | { op: "read"; path: string }
  | { op: "write"; path: string };

/** `yes`: the user can; `no`: it cannot; `missing`: no such path; `error`: the probe itself failed. */
export type ProbeAnswer = "yes" | "no" | "missing" | "error";

/** A user as the system knows it. */
export interface UserId {
  name: string;
  uid: number;
  gid: number;
}

/**
 * The child's whole program. It reads its one argument as the operation and prints one word.
 * Kept to built-ins and plain JavaScript, because it runs with `node -e` and an empty environment.
 */
export const PROBE_SCRIPT = `
const op = JSON.parse(process.argv[1]);
const say = (w) => { process.stdout.write(w); process.exit(0); };
const denied = (e) => e && (e.code === "EACCES" || e.code === "EPERM" || e.code === "EROFS");
if (op.op === "connect") {
  const s = require("node:net").connect({ host: op.host, port: op.port });
  s.setTimeout(op.timeoutMs, () => say("no"));
  s.on("connect", () => say("yes"));
  s.on("error", () => say("no"));
} else {
  const fs = require("node:fs");
  try {
    if (op.op === "read") fs.closeSync(fs.openSync(op.path, "r"));
    else fs.accessSync(op.path, fs.constants.W_OK);
    say("yes");
  } catch (e) {
    say(denied(e) ? "no" : e && e.code === "ENOENT" ? "missing" : "error");
  }
}
`;

const ANSWERS: readonly string[] = ["yes", "no", "missing", "error"];

export type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/**
 * Runs one probe as `as` (by uid and gid) or, when `as` is undefined, as this process. Never
 * rejects: anything unexpected (the child did not start, printed something else, or ran past
 * `limitMs`) is `error`.
 */
export function probe(as: UserId | undefined, op: ProbeOp, deps: { spawn?: Spawn; node?: string; limitMs?: number } = {}): Promise<ProbeAnswer> {
  const spawn = deps.spawn ?? nodeSpawn;
  const limitMs = deps.limitMs ?? 10_000;
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (a: ProbeAnswer): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(a);
    };
    let child: ChildProcess;
    try {
      // An empty environment: nothing of this process's variables reaches the other user.
      child = spawn(deps.node ?? process.execPath, ["-e", PROBE_SCRIPT, JSON.stringify(op)], {
        env: {},
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        ...(as === undefined ? {} : { uid: as.uid, gid: as.gid }),
      });
    } catch {
      // Switching to another uid without root throws here (EPERM).
      resolve("error");
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish("error");
    }, limitMs);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => (out += chunk));
    child.once("error", () => finish("error"));
    child.once("close", () => finish(ANSWERS.includes(out) ? (out as ProbeAnswer) : "error"));
  });
}

export type ExecFile = (file: string, args: readonly string[], cb: (err: Error | null, stdout: string) => void) => void;

const defaultExec: ExecFile = (file, args, cb) => void nodeExecFile(file, [...args], { encoding: "utf8", timeout: 10_000 }, (err, stdout) => cb(err, stdout));

/** A user's uid and gid by name, from `id` (which reads every source the system has: files, LDAP, ...). */
export function lookupUser(name: string, exec: ExecFile = defaultExec): Promise<UserId | undefined> {
  // Only names a POSIX user can have, so nothing odd ever reaches `id`'s arguments.
  if (!/^[a-z_][a-z0-9_-]{0,31}\$?$/.test(name)) return Promise.resolve(undefined);
  const num = (flag: string) =>
    new Promise<number | undefined>((resolve) =>
      exec("id", [flag, "--", name], (err, stdout) => {
        const n = err === null ? Number(stdout.trim()) : Number.NaN;
        resolve(Number.isInteger(n) && n >= 0 ? n : undefined);
      }),
    );
  return Promise.all([num("-u"), num("-g")]).then(([uid, gid]) => (uid === undefined || gid === undefined ? undefined : { name, uid, gid }));
}

/** A service's NoNewPrivs flag, read from its main process, or why it cannot be read here. */
export type NoNewPrivs = { pid: number; value: "0" | "1" } | { skip: string };

/**
 * Whether the main process of a systemd unit runs with no_new_privs, which stops sudo from
 * raising privileges. A unit sets it with NoNewPrivileges=, and silently with several hardening
 * settings (LockPersonality=, RestrictRealtime=, ProtectKernelTunables= and others, for a User= unit).
 */
export async function serviceNoNewPrivs(service: string, exec: ExecFile = defaultExec, read: (path: string) => Promise<string> = (p) => fsReadFile(p, "utf8")): Promise<NoNewPrivs> {
  // A unit name only, so nothing odd reaches systemctl's arguments.
  if (!/^[A-Za-z0-9@._:-]{1,128}$/.test(service)) return { skip: `${JSON.stringify(service)} is not a unit name` };
  const out = await new Promise<string | undefined>((resolve) => exec("systemctl", ["show", "--property", "MainPID", "--value", "--", service], (err, stdout) => resolve(err === null ? stdout.trim() : undefined)));
  if (out === undefined) return { skip: "systemctl did not answer (no systemd here?)" };
  const pid = Number(out);
  if (!Number.isInteger(pid) || pid <= 0) return { skip: `${service} is not running` };
  const status = await read(`/proc/${pid}/status`).catch(() => undefined);
  const value = status === undefined ? undefined : /^NoNewPrivs:\s*([01])$/m.exec(status)?.[1];
  return value === undefined ? { skip: `the status of ${service}'s process ${pid} cannot be read here` } : { pid, value: value as "0" | "1" };
}
