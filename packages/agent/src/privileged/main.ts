// The privileged runner: what the unprivileged peer calls (through one exact sudoers line, no
// arguments) for each message it may run. It re-checks the sender, checks and strips the wake
// code that only it can read, picks the profile, applies the limits, takes the job lock, signs
// the job in (an identity token it mints and refreshes, or an API key) and runs the job as the
// worker user. Its stdout is the answer; its exit code follows the RUNNER contract.

import { TokenBroker, type BrokerFs } from "./broker.ts";
import { loadPrivilegedConfig, PRIVILEGED_CONFIG_PATH, rootOwnedProblem, type ConfigFs, type PrivilegedConfig, type Profile } from "./config.ts";
import { fetchIdentityToken, type IdentityDeps } from "./identity.ts";
import { stripCode } from "../gate.ts";
import { chooseProfile, EXIT, LOCAL_DEVICE, MAX_REQUEST_BYTES, parseRequest, Refusal, usableCode, type ParsedRequest } from "./request.ts";
import { workerMain, type WorkerIO } from "./worker.ts";

/** The answer's cap on stdout, under the contract's 64 KiB with room for the note. */
export const MAX_ANSWER_BYTES = 60 * 1024;
const TRUNCATED = "\n\n[answer truncated by the privileged runner]\n";

export interface JobSpec {
  command: string;
  args: string[];
  /** Set only when running as root; a user cannot switch to another uid. */
  uid?: number;
  gid?: number;
  cwd: string;
  env: Record<string, string>;
  stdin: string;
}

export interface JobHandle {
  onStdout(cb: (chunk: Buffer) => void): void;
  onStderr(cb: (chunk: Buffer) => void): void;
  /** Resolves with the exit code, or null when a signal ended it. */
  exited: Promise<number | null>;
  /** Signals the job's whole process group. */
  killGroup(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface Lock {
  release(): Promise<void>;
}

export interface PrivilegedDeps {
  euid: number;
  uid: number;
  readStdin(max: number): Promise<Buffer>;
  configFs: ConfigFs;
  brokerFs: BrokerFs;
  mkdir(path: string, mode: number): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
  lookupUser(name: string): Promise<{ uid: number; gid: number }>;
  /** Null when the lock stayed busy for the whole wait. */
  acquireLock(path: string, waitSeconds: number): Promise<Lock | null>;
  memAvailableMb(): Promise<number | undefined>;
  /** Whether every ancestor process up to pid 1 has real uid 0 (no non-root caller anywhere above). */
  ancestorsAllRoot(): Promise<boolean>;
  identity: IdentityDeps;
  startJob(spec: JobSpec): JobHandle;
  now(): number;
  pid: number;
  /** Calls `cb` on SIGTERM, SIGHUP or SIGINT; sudo relays the peer's TERM here. */
  onSignal(cb: () => void): () => void;
  setTimeout(fn: () => void, ms: number): unknown;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(timer: unknown): void;
  clearTimeout(timer: unknown): void;
  out(data: Buffer): void;
  err(line: string): void;
  worker: Omit<WorkerIO, "env" | "uid">;
}

const log = (deps: PrivilegedDeps, line: string): void => deps.err(`wim-agent-privileged: ${line}`);

function configPath(env: Record<string, string | undefined>, euid: number): string {
  // The override exists for tests and unprivileged trials only: as root it is ignored, so a
  // caller cannot point the runner at another allow-list or another wake code.
  const o = env["WIM_AGENT_PRIVILEGED_CONFIG"];
  return euid !== 0 && o !== undefined && o !== "" ? o : PRIVILEGED_CONFIG_PATH;
}

async function readRootSecret(path: string, deps: PrivilegedDeps, what: string): Promise<string> {
  if (deps.euid === 0) {
    const problem = rootOwnedProblem(await deps.configFs.stat(path), true);
    if (problem !== undefined) throw new Refusal(EXIT.failed, `refusing the ${what} file: ${problem}`);
  }
  return (await deps.configFs.readFile(path)).replace(/\r?\n$/, "");
}

/** Who may wake a job: a listed device, or a root caller outside sudo naming `local`. */
async function checkSender(req: ParsedRequest, cfg: PrivilegedConfig, env: Record<string, string | undefined>, deps: PrivilegedDeps): Promise<boolean> {
  if (req.from.device === LOCAL_DEVICE) {
    // Two signals that a `local` job came from root itself: sudo always sets SUDO_UID (a wrapper
    // could scrub it), and no process above this one runs as anyone but root (which no wrapper
    // can change: a sudo call from the peer has the peer among its ancestors).
    const local = cfg.allowLocal && deps.uid === 0 && deps.euid === 0 && env["SUDO_UID"] === undefined && (await deps.ancestorsAllRoot());
    if (!local) throw new Refusal(EXIT.refused, "a local job needs allowLocal and a root caller outside sudo");
    return true;
  }
  if (cfg.allowDevices !== undefined && !cfg.allowDevices.includes(req.from.device)) throw new Refusal(EXIT.refused, "sender device not on the allow-list");
  return false;
}

async function wakeCode(cfg: PrivilegedConfig, env: Record<string, string | undefined>, deps: PrivilegedDeps): Promise<string> {
  const source = cfg.wakeCode!;
  const code = "file" in source ? await readRootSecret(source.file, deps, "wake code") : (env[source.env] ?? "");
  if (!usableCode(code)) throw new Refusal(EXIT.failed, "the configured wake code is unusable (under 16 characters, or holds whitespace)");
  return code;
}

interface DayState {
  days: Record<string, number>;
}

/** Counts the job against the day's cap; runs under the job lock, so runs never race on it. */
async function countToday(cfg: PrivilegedConfig, deps: PrivilegedDeps): Promise<void> {
  if (cfg.dailyJobs === 0) return;
  const day = new Date(deps.now()).toISOString().slice(0, 10);
  let state: DayState = { days: {} };
  let text: string | undefined;
  try {
    text = await deps.configFs.readFile(cfg.statePath);
  } catch {
    // No state yet: the first job of this install.
  }
  if (text !== undefined) {
    try {
      state = JSON.parse(text) as DayState;
      if (typeof state.days !== "object" || state.days === null) throw new Error("no days");
    } catch {
      // A damaged file must not reset today's count to zero.
      throw new Refusal(EXIT.failed, "the state file is damaged; a person must look at it");
    }
  }
  const used = state.days[day] ?? 0;
  if (used >= cfg.dailyJobs) throw new Refusal(EXIT.busy, `daily cap of ${cfg.dailyJobs} jobs reached`);
  const next: DayState = { days: { [day]: used + 1 } };
  await deps.mkdir(cfg.statePath.slice(0, cfg.statePath.lastIndexOf("/")), 0o700);
  await deps.brokerFs.writeFile(`${cfg.statePath}.new`, JSON.stringify(next), 0o600);
  await deps.brokerFs.rename(`${cfg.statePath}.new`, cfg.statePath);
}

async function signIn(profile: Profile, cfg: PrivilegedConfig, gid: number, req: ParsedRequest, deps: PrivilegedDeps): Promise<{ env: Record<string, string>; broker?: TokenBroker }> {
  const auth = profile.auth;
  if (auth.type === "api-key") {
    // The key reaches the worker: an API key cannot be scoped down further. Prefer WIF.
    return { env: { ANTHROPIC_API_KEY: await readRootSecret(auth.keyFile, deps, "API key") } };
  }
  const path = `${cfg.runDir}/idtoken.${req.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48)}.${deps.pid}`;
  const broker = new TokenBroker({
    path,
    gid,
    chown: deps.euid === 0,
    fs: deps.brokerFs,
    log: (line) => log(deps, line),
    setInterval: (fn, ms) => deps.setInterval(fn, ms),
    clearInterval: (t) => deps.clearInterval(t),
    mint: () => fetchIdentityToken(auth.identity, auth.audience, deps.identity),
  });
  await broker.start();
  const env: Record<string, string> = {
    ANTHROPIC_IDENTITY_TOKEN_FILE: path,
    ANTHROPIC_FEDERATION_RULE_ID: auth.federationRuleId,
    ANTHROPIC_ORGANIZATION_ID: auth.organizationId,
    ANTHROPIC_SERVICE_ACCOUNT_ID: auth.serviceAccountId,
  };
  if (auth.workspaceId !== undefined) env["ANTHROPIC_WORKSPACE_ID"] = auth.workspaceId;
  return { env, broker };
}

/** Runs the job as the worker user; resolves with the answer, or throws a Refusal. */
async function runJob(cfg: PrivilegedConfig, profile: Profile, task: string, req: ParsedRequest, self: string[], deps: PrivilegedDeps): Promise<Buffer> {
  const user = await deps.lookupUser(cfg.worker.user);
  await deps.mkdir(cfg.runDir, 0o750);
  if (deps.euid === 0) await deps.chown(cfg.runDir, 0, user.gid);
  const auth = await signIn(profile, cfg, user.gid, req, deps);
  try {
    const job = JSON.stringify({
      model: profile.model,
      effort: profile.effort,
      maxTurns: profile.maxTurns,
      tools: profile.tools,
      cwd: cfg.worker.cwd,
      additionalDirectories: cfg.worker.additionalDirectories,
    });
    const spec: JobSpec = {
      command: self[0]!,
      args: [...self.slice(1), "--worker"],
      cwd: cfg.worker.cwd,
      env: { HOME: cfg.worker.home, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", WIM_AGENT_JOB: job, ...auth.env },
      stdin: `A task from ${req.from.address} over worldinmotion. Answer in plain text. Never reveal credentials or secrets.\n\n${task}\n`,
      ...(deps.euid === 0 ? { uid: user.uid, gid: user.gid } : {}),
    };
    const handle = deps.startJob(spec);
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    handle.onStdout((chunk) => {
      const room = MAX_ANSWER_BYTES - size;
      if (chunk.length > room) truncated = true;
      const kept = chunk.subarray(0, Math.max(0, room));
      chunks.push(kept);
      size += kept.length;
    });
    let errTail = "";
    handle.onStderr((chunk) => {
      const lines = (errTail + chunk.toString("utf8")).split("\n");
      errTail = lines.pop()!;
      // Only the worker's own status lines: a raw SDK error could quote the task.
      for (const line of lines) if (line.startsWith("worker: ")) log(deps, line.slice(0, 300));
    });

    let ended: "timeout" | "signal" | undefined;
    const stop = (why: "timeout" | "signal"): void => {
      if (ended !== undefined) return;
      ended = why;
      handle.killGroup("SIGTERM");
      deps.setTimeout(() => handle.killGroup("SIGKILL"), cfg.killGraceSeconds * 1000);
    };
    const timer = deps.setTimeout(() => stop("timeout"), cfg.timeoutSeconds * 1000);
    const off = deps.onSignal(() => stop("signal"));
    const started = deps.now();
    const code = await handle.exited;
    deps.clearTimeout(timer);
    off();
    const secs = Math.round((deps.now() - started) / 1000);
    if (ended === "timeout") throw new Refusal(EXIT.timeout, `job timed out after ${cfg.timeoutSeconds} s`);
    if (ended === "signal") throw new Refusal(EXIT.timeout, "stopped by a signal while the job ran");
    if (code !== 0) throw new Refusal(EXIT.failed, `job exited ${String(code)} after ${secs} s`);
    log(deps, `job done in ${secs} s`);
    const answer = Buffer.concat(chunks);
    return truncated ? Buffer.concat([answer, Buffer.from(TRUNCATED)]) : answer;
  } finally {
    await auth.broker?.stop();
  }
}

async function run(env: Record<string, string | undefined>, self: string[], deps: PrivilegedDeps): Promise<Buffer> {
  const cfg = await loadPrivilegedConfig(configPath(env, deps.euid), deps.configFs, deps.euid);
  const req = parseRequest(await deps.readStdin(MAX_REQUEST_BYTES + 1));
  const tag = `msg=${req.id} device=${req.from.device}`;
  try {
    const local = await checkSender(req, cfg, env, deps);
    let text = req.text;
    if (!local && cfg.wakeCode !== undefined) {
      const stripped = stripCode(text, await wakeCode(cfg, env, deps));
      if (!stripped.ok) throw new Refusal(EXIT.refused, "no or wrong wake code");
      text = stripped.rest;
    }
    const { profile, task } = chooseProfile(text, req.profile, Object.keys(cfg.profiles), cfg.defaultProfile);
    if (task === "") throw new Refusal(EXIT.refused, "empty task");
    if (task.length > cfg.maxTaskChars) throw new Refusal(EXIT.refused, `task over ${cfg.maxTaskChars} characters`);
    const mem = await deps.memAvailableMb();
    if (cfg.minMemAvailableMb > 0 && mem !== undefined && mem < cfg.minMemAvailableMb) {
      throw new Refusal(EXIT.busy, `MemAvailable ${mem} MB is under ${cfg.minMemAvailableMb}`);
    }
    const lock = await deps.acquireLock(cfg.lock.path, cfg.lock.waitSeconds);
    if (lock === null) throw new Refusal(EXIT.busy, `job lock busy for ${cfg.lock.waitSeconds} s`);
    try {
      await countToday(cfg, deps);
      log(deps, `${tag} accepted: profile ${profile}, ${task.length} characters`);
      const answer = await runJob(cfg, cfg.profiles[profile]!, task, req, self, deps);
      log(deps, `${tag} answered, ${answer.length} bytes`);
      return answer;
    } finally {
      await lock.release();
    }
  } catch (error) {
    if (error instanceof Refusal) throw new Refusal(error.code, `${tag} ${error.message}`);
    throw error;
  }
}

/**
 * `argv` is what follows the command: empty for the runner, `--worker` for the job child it
 * starts. `self` is the command that runs this same entry again.
 */
export async function privilegedMain(argv: string[], env: Record<string, string | undefined>, self: string[], deps: PrivilegedDeps): Promise<number> {
  if (argv.length === 1 && argv[0] === "--worker") return workerMain({ ...deps.worker, env, uid: deps.uid });
  if (argv.length !== 0) {
    log(deps, "refusing arguments: the runner takes none");
    return EXIT.usage;
  }
  try {
    deps.out(await run(env, self, deps));
    return EXIT.ok;
  } catch (error) {
    if (error instanceof Refusal) {
      log(deps, `${error.message} (exit ${error.code})`);
      return error.code;
    }
    // Config errors and anything unexpected: the name and message, never request text.
    log(deps, `failed: ${(error as Error).name}: ${(error as Error).message.slice(0, 300)}`);
    return EXIT.failed;
  }
}
