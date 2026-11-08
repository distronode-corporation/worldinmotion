// `wim agent run --once`: one runner request from stdin, through the configured runner, with the
// same spec (timeout, kill grace, environment) `wim agent serve` uses. For testing a runner or a
// deployment by hand: no mesh, no sender check, no limits beyond the runner's own.

import type { WorkerConfig } from "./config.ts";
import { RUNNER_EXIT, RUNNER_MAX_BYTES, RUNNER_MAX_REQUEST_BYTES, runJob, runnerEnv, type RunDeps, type RunnerOutcome, type RunnerRequest } from "./runner.ts";

/** Parses a runner request (the contract's stdin), or says what is wrong with it. */
export function parseRequest(text: string): RunnerRequest | string {
  if (Buffer.byteLength(text, "utf8") > RUNNER_MAX_REQUEST_BYTES) return `the request is over ${RUNNER_MAX_REQUEST_BYTES} bytes`;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return `not valid JSON (${(err as Error).message})`;
  }
  const r = raw as Record<string, unknown> | null;
  const from = (typeof r === "object" && r !== null ? r["from"] : undefined) as Record<string, unknown> | undefined;
  const str = (v: unknown) => typeof v === "string";
  if (typeof r !== "object" || r === null || r["v"] !== 2) return 'expected {"v":2, ...}';
  if (!str(r["id"]) || !str(r["profile"]) || !str(r["text"]) || typeof from !== "object" || from === null || !str(from["device"]) || !str(from["address"])) {
    return 'expected {"v":2,"id":"...","from":{"device":"...","address":"..."},"profile":"...","text":"..."} (and an optional "frame")';
  }
  // A local job has no frame; one copied from a real request keeps it, for a runner that checks it.
  return {
    v: 2,
    id: r["id"] as string,
    from: { device: from["device"] as string, address: from["address"] as string },
    profile: r["profile"] as string,
    text: r["text"] as string,
    ...(r["frame"] === undefined ? {} : { frame: r["frame"] }),
  };
}

/** The exit code `run --once` ends with: the runner contract's, with 1 for any failure. */
export function exitFor(o: RunnerOutcome): number {
  switch (o.kind) {
    case "answered":
      return RUNNER_EXIT.ok;
    case "refused":
      return RUNNER_EXIT.refused;
    case "busy":
      return RUNNER_EXIT.busy;
    case "timeout":
      return RUNNER_EXIT.timeout;
    default:
      return 1;
  }
}

export interface OnceIO {
  out: (text: string) => void;
  err: (line: string) => void;
  env: Readonly<Record<string, string | undefined>>;
}

/** Runs the request through the config's runner; prints the answer, or what happened, and returns the exit code. */
export async function runOnce(config: WorkerConfig, stdin: string, io: OnceIO, deps: Omit<RunDeps, "log" | "stderr"> = {}): Promise<number> {
  const req = parseRequest(stdin);
  if (typeof req === "string") {
    io.err(`wim agent run: ${req}`);
    return 2;
  }
  const spec = {
    command: config.runner.command,
    args: config.runner.args,
    timeoutMs: config.runner.timeoutSeconds * 1000,
    killGraceMs: config.runner.killGraceSeconds * 1000,
    env: runnerEnv(io.env, config.runner.passEnv),
  };
  const outcome = await runJob(spec, req, { ...deps, log: io.err, ...(config.runner.logStderr ? { stderr: (line: string) => io.err(`runner: ${line}`) } : {}) });
  if (outcome.kind === "answered") {
    io.out(outcome.answer);
    if (outcome.truncated) io.err(`wim agent run: the answer was cut at ${RUNNER_MAX_BYTES} bytes`);
  } else if (outcome.kind === "failed") {
    io.err(`wim agent run: the runner failed (${outcome.signal !== null ? `signal ${outcome.signal}` : outcome.code !== null ? `exit ${outcome.code}` : "it did not start"})`);
  } else {
    io.err(`wim agent run: ${outcome.kind}`);
  }
  return exitFor(outcome);
}
