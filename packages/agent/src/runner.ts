// The RUNNER contract (README, "The runner contract"): one job per process. The request goes on
// stdin as one JSON object, the answer comes back on stdout, and the exit code says what happened.
// Nothing from a message is ever put on the command line.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/** The request a runner reads from stdin: version 1. */
export interface RunnerRequest {
  v: 1;
  /** The wim message id. */
  id: string;
  from: { device: string; address: string };
  /** The profile prefix the worker parsed, or "" when it parsed none. */
  profile: string;
  /** The task. Raw text, including any wake code, when the worker holds no code (wake.mode `runner`). */
  text: string;
}

/** What each runner exit code means. Any other code is a failure. */
export const RUNNER_EXIT = { ok: 0, refused: 3, busy: 4, timeout: 5 } as const;

/** The most a request or an answer may be, in bytes of UTF-8. */
export const RUNNER_MAX_BYTES = 64 * 1024;

export type RunnerOutcome =
  | { kind: "answered"; answer: string; truncated: boolean }
  | { kind: "refused" }
  | { kind: "busy" }
  | { kind: "timeout" }
  | { kind: "failed"; code: number | null; signal: string | null };

export interface RunnerSpec {
  command: string;
  args: readonly string[];
  timeoutMs: number;
  killGraceMs: number;
  /** The whole environment the runner gets. */
  env: Record<string, string>;
}

export interface RunDeps {
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** Sends a signal to a process group (negative pid); tests replace it. */
  killGroup?: (pgid: number, signal: NodeJS.Signals) => void;
  log?: (line: string) => void;
  /** Each stderr line the runner writes (already capped), when the config copies stderr. */
  stderr?: (line: string) => void;
}

const MAX_STDERR_LINE = 500;

/** Encodes a request, refusing one over the contract's limit. */
export function encodeRequest(req: RunnerRequest): Buffer {
  const body = Buffer.from(JSON.stringify(req), "utf8");
  if (body.length > RUNNER_MAX_BYTES) throw new RangeError(`runner request is ${body.length} bytes, over ${RUNNER_MAX_BYTES}`);
  return body;
}

/** Cuts UTF-8 bytes to at most `max`, never inside a character. */
export function truncateUtf8(buf: Buffer, max: number): { text: string; truncated: boolean } {
  if (buf.length <= max) return { text: buf.toString("utf8"), truncated: false };
  let end = max;
  // Step back over continuation bytes (10xxxxxx) so the cut lands on a character boundary.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * Signals a process group. ESRCH (already gone) is quiet; EPERM is logged and not fatal: a runner
 * started through `sudo` leaves root-owned processes in the group that an unprivileged worker
 * cannot signal, and sudo itself relays only the signals it can catch.
 */
export function signalGroup(pgid: number, signal: NodeJS.Signals, kill: (pgid: number, signal: NodeJS.Signals) => void, log: (line: string) => void): void {
  try {
    kill(-pgid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") log(`worker: ${signal} to the runner's process group failed: ${code ?? String(err)}`);
  }
}

/** Runs one job through the runner and maps its exit code. Never rejects. */
export function runJob(spec: RunnerSpec, req: RunnerRequest, deps: RunDeps = {}): Promise<RunnerOutcome> {
  const spawn = deps.spawn ?? nodeSpawn;
  const kill = deps.killGroup ?? ((pgid: number, signal: NodeJS.Signals) => void process.kill(pgid, signal));
  const log = deps.log ?? (() => undefined);
  let body: Buffer;
  try {
    body = encodeRequest(req);
  } catch (err) {
    log(`worker: ${(err as Error).message}`);
    return Promise.resolve({ kind: "failed", code: null, signal: null });
  }

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      // Its own process group (detached), so the timeout reaches everything it started.
      child = spawn(spec.command, [...spec.args], { detached: true, stdio: ["pipe", "pipe", "pipe"], env: spec.env, windowsHide: true });
    } catch (err) {
      log(`worker: the runner did not start: ${(err as Error).message}`);
      resolve({ kind: "failed", code: null, signal: null });
      return;
    }

    const chunks: Buffer[] = [];
    let kept = 0;
    let timedOut = false;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    let pending = "";

    const finish = (outcome: RunnerOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // After a timeout the SIGKILL still goes: the group may outlive its leader.
      if (!timedOut) clearTimeout(grace);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      log(`worker: job ${req.id} passed ${spec.timeoutMs / 1000} s; stopping the runner`);
      const pid = child.pid;
      if (pid === undefined) return;
      signalGroup(pid, "SIGTERM", kill, log);
      grace = setTimeout(() => signalGroup(pid, "SIGKILL", kill, log), spec.killGraceMs);
    }, spec.timeoutMs);

    child.stdout!.on("data", (chunk: Buffer) => {
      // Read past the limit (so the runner never blocks on a full pipe), keeping one byte more
      // than the limit to know it was cut.
      if (kept > RUNNER_MAX_BYTES) return;
      chunks.push(chunk);
      kept += chunk.length;
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) deps.stderr?.(line.slice(0, MAX_STDERR_LINE));
      if (pending.length > MAX_STDERR_LINE) {
        deps.stderr?.(pending.slice(0, MAX_STDERR_LINE));
        pending = "";
      }
    });
    child.stdin!.on("error", () => undefined);
    child.stdin!.end(body);

    child.once("error", (err) => {
      log(`worker: the runner did not start: ${err.message}`);
      finish({ kind: "failed", code: null, signal: null });
    });
    child.once("close", (code, signal) => {
      if (pending !== "") deps.stderr?.(pending.slice(0, MAX_STDERR_LINE));
      if (timedOut) return finish({ kind: "timeout" });
      switch (code) {
        case RUNNER_EXIT.ok: {
          const { text, truncated } = truncateUtf8(Buffer.concat(chunks), RUNNER_MAX_BYTES);
          return finish({ kind: "answered", answer: text, truncated });
        }
        case RUNNER_EXIT.refused:
          return finish({ kind: "refused" });
        case RUNNER_EXIT.busy:
          return finish({ kind: "busy" });
        case RUNNER_EXIT.timeout:
          return finish({ kind: "timeout" });
        default:
          return finish({ kind: "failed", code, signal });
      }
    });
  });
}

/** The runner's environment: only the named variables, and only those that are set. */
export function runnerEnv(env: Readonly<Record<string, string | undefined>>, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}
