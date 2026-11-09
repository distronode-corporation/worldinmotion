// Where a job's processes live, and how all of them end.
//
// A process group is not enough: a job (with tools that run commands) can call setsid() and
// leave its group, and such a process keeps the job's stdout open, so waiting for the pipes
// to close would wait on it for as long as it likes, with the job lock held. With systemd the
// job runs in its own transient scope (`systemd-run --scope`), a cgroup no process can leave,
// and ending the job kills the whole scope. Without systemd it falls back to the process
// group: an escaped process then survives the job, but the runner still returns, because the
// job's end is its leader's exit, never the pipes closing.

import { execFile, execFileSync, spawn as nodeSpawn } from "node:child_process";
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
  /**
   * Whether systemd-run expands `$` in a scope's command line (see scopeExpands); when it does,
   * every `$` is doubled so the job gets it literally. Unset means it does.
   */
  expands?: boolean;
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

/** The first systemd release whose systemd-run expands `$NAME` and `${NAME}` in a scope's command line. */
export const SCOPE_EXPANSION_SINCE = 254;

/**
 * Whether systemd-run expands `$` in a `--scope` command line, from what `systemd-run --version`
 * printed (`systemd 255 (255.4-1)` and so on). Releases from v254 expand it, with `$$` as the
 * escape for a literal `$`; earlier ones pass a scope's command line through as given, so there a
 * doubled `$` would reach the job doubled. Output that names no release (or none at all) counts as
 * expanding: a `$` doubled by mistake is a job that fails, one expanded by mistake is a job that
 * runs with another argument.
 */
export function scopeExpands(version: string | undefined): boolean {
  const m = /^systemd (\d{1,6})\b/.exec(version ?? "");
  return m === null || Number(m[1]) >= SCOPE_EXPANSION_SINCE;
}

/** What `systemd-run --version` prints, or undefined when it cannot be run. */
export function systemdRunVersion(): string | undefined {
  try {
    return execFileSync("systemd-run", ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

/** The options the real runner uses: a system scope as root under systemd, in the runner's own slice. */
export function defaultScope(
  euid: number,
  pid: number,
  booted?: boolean,
  cgroup = (): string => readFileSync("/proc/self/cgroup", "utf8"),
  version: () => string | undefined = systemdRunVersion,
): ScopeOptions {
  const mode = detectScopeMode(euid, booted);
  if (mode === "none") return { mode, unit: "", drainMs: 2000 };
  const slice = ownSlice(mode, cgroup());
  return { mode, unit: scopeUnit(pid), drainMs: 2000, expands: scopeExpands(version()), ...(slice === undefined ? {} : { slice }) };
}

/** A unit name the runner gives systemd: letters, digits, `_`, `.` and `-`, not starting with `-` (an option). */
const UNIT_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/;
/** A slice to join, by the same rule, ending in `.slice` (the root slice `-.slice` is never one). */
const SLICE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,193}\.slice$/;
/** C0 controls and DEL: nothing in a command line the runner builds has one. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Checks every value that reaches systemd-run's or systemctl's argv before anything runs, and
 * refuses the job on any other: the unit and slice names against an allow-list (they come from
 * the runner's pid and its own cgroup file), the ids as whole numbers, the command as an absolute
 * path, and no control character in the command or its arguments. None of them reaches a shell:
 * systemd-run execs the command itself, and its own `$` expansion (from v254) is escaped below.
 */
export function checkScoped(spec: JobSpec, o: ScopeOptions): void {
  const bad = (what: string): never => {
    throw new Error(`refusing to start the job: ${what}`);
  };
  if (!UNIT_NAME.test(o.unit)) bad("the scope's unit name is not one the runner makes");
  if (o.slice !== undefined && !SLICE_NAME.test(o.slice)) bad("the slice name is not one the runner can join");
  for (const id of [spec.uid, spec.gid]) if (id !== undefined && !(Number.isSafeInteger(id) && id >= 0)) bad("a user or group id is not a whole number");
  if (!spec.command.startsWith("/")) bad("the command is not an absolute path");
  if ([spec.command, ...spec.args].some((a) => CONTROL.test(a))) bad("the command line holds a control character");
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
  if (scoped) checkScoped(spec, o);
  const manager = o.mode === "user" ? ["--user"] : [];
  const ids = spec.uid === undefined ? [] : [`--uid=${spec.uid}`, `--gid=${spec.gid}`];
  // From v254 systemd-run expands `$NAME` and `${NAME}` in the command it runs (from its own
  // environment), and `$$` is its escape for a literal `$`, so there every `$` of the job's command
  // line is doubled. Earlier releases pass it through as given, so it is left alone.
  const literal = (a: string): string => (o.expands === false ? a : a.replaceAll("$", () => "$$"));
  const [command, args] = scoped
    ? ["systemd-run", [...manager, "--scope", "--quiet", "--collect", `--unit=${o.unit}`, ...(o.slice === undefined ? [] : [`--slice=${o.slice}`]), ...ids, "--", literal(spec.command), ...spec.args.map(literal)]]
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
