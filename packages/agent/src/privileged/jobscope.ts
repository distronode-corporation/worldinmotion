// Where a job's processes live, and how all of them end.
//
// A process group is not enough: a job (with tools that run commands) can call setsid() and
// leave its group, and such a process keeps the job's stdout open, so waiting for the pipes
// to close would wait on it for as long as it likes, with the job lock held. With systemd the
// job runs in its own transient scope (`systemd-run --scope`), a cgroup no process can leave,
// and ending the job kills the whole scope. Without systemd it falls back to the process
// group: an escaped process then survives the job, but the runner still returns, because the
// job's end is its leader's exit, never the pipes closing.

import { execFile, spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { JobHandle, JobSpec } from "./main.ts";

/** `system`: a scope of the system manager (the runner is root); `user`: the caller's own user manager (tests, trials); `none`: the process group only. */
export type ScopeMode = "system" | "user" | "none";

export interface ScopeOptions {
  mode: ScopeMode;
  /** The scope's unit name, without `.scope`. */
  unit: string;
  /** The slice the scope joins, so a job stays under the same caps as the runner. */
  slice?: string;
  /** How long the pipes may stay open once the leader exited and the scope was killed. */
  drainMs: number;
  /** Extra environment for systemd-run itself (a user manager's XDG_RUNTIME_DIR). */
  scopeEnv?: Record<string, string>;
  spawn?: typeof nodeSpawn;
  /** Runs systemctl with these arguments; failures are ignored (the scope may be gone). */
  systemctl?: (args: string[]) => Promise<void>;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
}

/** systemd is the init system: the same test as sd_booted(3). Scopes are used only as root. */
export function detectScopeMode(euid: number, booted = existsSync("/run/systemd/system")): ScopeMode {
  return euid === 0 && booted ? "system" : "none";
}

/**
 * The slice this process runs in, from its cgroup path, for the manager that `mode` names: the
 * system manager owns the path up to a `user@<uid>.service`, a user manager the path below it.
 */
export function ownSlice(mode: ScopeMode, cgroup: string): string | undefined {
  const line = cgroup.split("\n").find((l) => l.startsWith("0::"));
  if (line === undefined) return undefined;
  const parts = line.slice(3).split("/").filter((p) => p !== "");
  const at = parts.findIndex((p) => /^user@\d+\.service$/.test(p));
  const mine = at === -1 ? (mode === "system" ? parts : []) : mode === "system" ? parts.slice(0, at) : parts.slice(at + 1);
  return mine.filter((p) => p.endsWith(".slice")).pop();
}

let counter = 0;
/** A unit name unique to this runner process and job. */
export function scopeUnit(pid: number): string {
  counter += 1;
  return `wim-agent-job-${pid}-${counter}`;
}

/** The options the real runner uses: a system scope as root under systemd, in the runner's own slice. */
export function defaultScope(euid: number, pid: number, booted?: boolean, cgroup = (): string => readFileSync("/proc/self/cgroup", "utf8")): ScopeOptions {
  const mode = detectScopeMode(euid, booted);
  if (mode === "none") return { mode, unit: "", drainMs: 2000 };
  const slice = ownSlice(mode, cgroup());
  return { mode, unit: scopeUnit(pid), drainMs: 2000, ...(slice === undefined ? {} : { slice }) };
}

function runSystemctl(args: string[]): Promise<void> {
  return new Promise((resolve) => execFile("systemctl", args, () => resolve()));
}

/**
 * Starts the job. In a scope, systemd-run registers the scope, switches to the worker's uid and
 * gid itself (it would lose the right to create a system scope if it were switched first) and
 * execs the command, so the child's pid is the job's leader either way.
 */
export function startScopedJob(spec: JobSpec, o: ScopeOptions): JobHandle {
  const spawn = o.spawn ?? nodeSpawn;
  const systemctl = o.systemctl ?? runSystemctl;
  const later = o.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref());
  const cancel = o.clearTimeout ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout));
  const scoped = o.mode !== "none";
  const manager = o.mode === "user" ? ["--user"] : [];
  const ids = spec.uid === undefined ? [] : [`--uid=${spec.uid}`, `--gid=${spec.gid}`];
  const [command, args] = scoped
    ? ["systemd-run", [...manager, "--scope", "--quiet", "--collect", `--unit=${o.unit}`, ...(o.slice === undefined ? [] : [`--slice=${o.slice}`]), ...ids, "--", spec.command, ...spec.args]]
    : [spec.command, spec.args];
  const child = spawn(command, args, {
    cwd: spec.cwd,
    env: scoped ? { ...spec.env, ...o.scopeEnv } : spec.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    ...(scoped || spec.uid === undefined ? {} : { uid: spec.uid, gid: spec.gid }),
  });
  // The job's end is its leader's exit. `close` would also wait for every process that still
  // holds a pipe, which is exactly what an escaped process does.
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(127));
    child.once("exit", (code) => resolve(code));
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  // A job that never reads its input must not fail the write.
  child.stdin!.on("error", () => undefined);
  child.stdin!.end(spec.stdin);

  const killGroup = (signal: "SIGTERM" | "SIGKILL"): void => {
    if (scoped) void systemctl([...manager, "kill", `--signal=${signal}`, "--kill-whom=all", `${o.unit}.scope`]);
    try {
      process.kill(-child.pid!, signal);
    } catch {
      // Already gone, or never started.
    }
  };
  return {
    onStdout: (cb) => void child.stdout!.on("data", cb),
    onStderr: (cb) => void child.stderr!.on("data", cb),
    exited,
    killGroup,
    async cleanup() {
      // Whatever the leader left behind dies with the scope (or the group); then the pipes get
      // a moment to deliver what was already written, and are closed either way.
      killGroup("SIGKILL");
      let timer: unknown;
      await Promise.race([closed, new Promise<void>((resolve) => (timer = later(resolve, o.drainMs)))]);
      cancel(timer);
      child.stdout!.destroy();
      child.stderr!.destroy();
      child.stdin!.destroy();
    },
  };
}
