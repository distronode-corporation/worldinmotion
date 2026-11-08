// The privileged runner: what the unprivileged peer calls (through one exact sudoers line, no
// arguments) for each message it may run. It authenticates the sender itself from the signed
// frame, checks and strips the wake code that only it can read, picks the profile, applies the
// limits, takes the job lock, and runs the job as the worker user. The job reaches the API only
// through a loopback proxy this process owns, which adds the credential: the job holds none. Its
// stdout is the answer; its exit code follows the RUNNER contract.

import { z } from "zod";
import { stripCode } from "../gate.ts";
import { upstreamAuth, type AnthropicCredentials } from "./auth.ts";
import { ConfigError, loadPrivilegedConfig, PRIVILEGED_CONFIG_PATH, type PrivilegedConfig, type Profile, type SecureRead } from "./config.ts";
import { FrameError, parseRecipient, SEEN_WINDOW_MS, verifyFrame } from "./frame.ts";
import type { IdentityDeps } from "./identity.ts";
import type { ProxyOptions, RunningProxy } from "./proxy.ts";
import { chooseProfile, EXIT, LOCAL_DEVICE, MAX_REQUEST_BYTES, parseRequest, Refusal, usableCode, type ParsedRequest } from "./request.ts";
import { workerMain, type WorkerIO } from "./worker.ts";

/** The answer's cap on stdout, under the contract's 64 KiB with room for the note. */
export const MAX_ANSWER_BYTES = 60 * 1024;
const TRUNCATED = "\n\n[answer truncated by the privileged runner]\n";
/** The largest request body the job may send the API (a long conversation with tool results). */
export const MAX_API_BODY_BYTES = 32 * 1024 * 1024;
/** Requests beyond the profile's turns a job may make (retries, token counts). */
const EXTRA_REQUESTS = 5;

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
  /** Resolves when the job's leader exits, with its exit code, or null when a signal ended it. */
  exited: Promise<number | null>;
  /** Signals every process of the job: its scope (cgroup) when it has one, and its process group. */
  killGroup(signal: "SIGTERM" | "SIGKILL"): void;
  /** After the leader exited: kills whatever it left behind, drains the pipes briefly, closes them. */
  cleanup(): Promise<void>;
}

export interface Lock {
  release(): Promise<void>;
}

export interface PrivilegedDeps {
  euid: number;
  uid: number;
  readStdin(max: number): Promise<Buffer>;
  /** Reads a file without following a symlink, checking the opened file's owner and mode. */
  readFile: SecureRead;
  /** Writes a root-owned file through a fresh O_EXCL|O_NOFOLLOW temporary file, then renames it. */
  writeFile(path: string, data: string, mode: number): Promise<void>;
  /** Makes (or checks) a directory: not a symlink, root-owned when root, no group or other write. */
  ensureDir(path: string, mode: number, gid?: number): Promise<void>;
  /**
   * Makes a directory if it is missing, else only checks it (a directory, not a symlink, root's,
   * no group or other write) without changing its owner or mode: for one another system shares.
   */
  checkDir(path: string): Promise<void>;
  /** Why the code this process runs could be changed by someone other than root, if it could. */
  codeProblem(): Promise<string | undefined>;
  lookupUser(name: string): Promise<{ uid: number; gid: number }>;
  /** Null when the lock stayed busy for the whole wait. */
  acquireLock(path: string, waitSeconds: number): Promise<Lock | null>;
  memAvailableMb(): Promise<number | undefined>;
  /** Whether every ancestor process up to pid 1 has real uid 0. */
  ancestorsAllRoot(): Promise<boolean>;
  identity: IdentityDeps;
  credentials(): Promise<AnthropicCredentials>;
  fetch: typeof fetch;
  startProxy(options: ProxyOptions): Promise<RunningProxy>;
  startJob(spec: JobSpec): JobHandle;
  now(): number;
  /** Calls `cb` on SIGTERM, SIGHUP or SIGINT; sudo relays the peer's TERM here. */
  onSignal(cb: () => void): () => void;
  setTimeout(fn: () => void, ms: number): unknown;
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

const rootRule = (deps: PrivilegedDeps, secret: boolean) => ({ owner: deps.euid === 0 ? 0 : undefined, secret });

async function readRootSecret(path: string, deps: PrivilegedDeps): Promise<string> {
  return (await deps.readFile(path, rootRule(deps, true))).replace(/\r?\n$/, "");
}

interface Sender {
  local: boolean;
  text: string;
  /** The verified frame's id, kept against replay; absent for a local job. */
  frameId?: string;
  at?: number;
}

/** Reads the recipient's keys from the peer's files: owned by the peer user, mode 0600, no symlink. */
async function recipientKeys(cfg: PrivilegedConfig, deps: PrivilegedDeps) {
  const r = cfg.recipient!;
  const peer = await deps.lookupUser(r.user);
  const rule = { owner: deps.euid === 0 ? peer.uid : undefined, secret: true };
  const device = await deps.readFile(`${r.home}/device.json`, rule);
  const prekeys = await deps.readFile(`${r.home}/meshes/${r.mesh}/prekeys.json`, rule).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  return parseRecipient(device, prekeys, deps.now());
}

/**
 * Who sent this, decided here and not by the peer. A job from a pinned sender is accepted only
 * with a frame whose signature verifies; the request's own fields are hints that must agree. A
 * local job (a scheduled one) comes from root itself: sudo always sets SUDO_UID, and the launcher
 * keeps it, so that is the guard; every ancestor being root is a second check, not a sufficient
 * one (a process can be re-parented to init).
 */
async function authenticate(req: ParsedRequest, cfg: PrivilegedConfig, env: Record<string, string | undefined>, deps: PrivilegedDeps): Promise<Sender> {
  if (req.from.device === LOCAL_DEVICE) {
    const refused = new Refusal(EXIT.refused, "a local job needs allowLocal and a root caller outside sudo");
    if (!(cfg.allowLocal && deps.uid === 0 && deps.euid === 0 && env["SUDO_UID"] === undefined && req.frame === undefined)) throw refused;
    const allRoot = await deps.ancestorsAllRoot();
    if (!allRoot) throw refused;
    return { local: true, text: req.text };
  }
  if (cfg.senders === undefined) throw new Refusal(EXIT.refused, "no senders are pinned");
  if (req.frame === undefined) throw new Refusal(EXIT.refused, "no signed frame");
  let v;
  try {
    v = verifyFrame(req.frame, { senders: cfg.senders, mesh: cfg.recipient!.mesh, address: cfg.recipient!.address, recipient: await recipientKeys(cfg, deps), now: deps.now() });
  } catch (error) {
    if (error instanceof FrameError) throw new Refusal(EXIT.refused, error.message);
    throw error;
  }
  if (v.device !== req.from.device || v.id !== req.id || v.text !== req.text) throw new Refusal(EXIT.refused, "the request disagrees with its signed frame");
  return { local: false, text: v.text, frameId: v.id, at: v.at };
}

async function wakeCode(cfg: PrivilegedConfig, env: Record<string, string | undefined>, deps: PrivilegedDeps): Promise<string> {
  const source = cfg.wakeCode!;
  const code = "file" in source ? await readRootSecret(source.file, deps) : (env[source.env] ?? "");
  if (!usableCode(code)) throw new Refusal(EXIT.failed, "the configured wake code is unusable (under 16 characters, or holds whitespace)");
  return code;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const State = z.strictObject({
  days: z.record(z.string().regex(DAY), z.number().int().min(0)),
  seen: z.record(z.string().regex(/^[A-Za-z0-9]{1,64}$/), z.number().int().min(0)).default({}),
});
type State = z.infer<typeof State>;

/**
 * The day's count and the frames already run, under the job lock so runs never race on them. A
 * frame seen before is refused (a peer replaying it); one older than the window is refused by
 * the freshness check before it gets here. A damaged file fails the run rather than reset counts.
 */
async function admit(cfg: PrivilegedConfig, sender: Sender, deps: PrivilegedDeps): Promise<void> {
  const now = deps.now();
  const day = new Date(now).toISOString().slice(0, 10);
  let state: State = { days: {}, seen: {} };
  const text = await deps.readFile(cfg.statePath, rootRule(deps, true)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (text !== undefined) {
    let parsed;
    try {
      parsed = State.safeParse(JSON.parse(text));
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined || !parsed.success) throw new Refusal(EXIT.failed, "the state file is damaged; a person must look at it");
    state = parsed.data;
  }
  if (sender.frameId !== undefined && Object.hasOwn(state.seen, sender.frameId)) throw new Refusal(EXIT.refused, "this frame was run before");
  const used = state.days[day] ?? 0;
  if (cfg.dailyJobs > 0 && used >= cfg.dailyJobs) throw new Refusal(EXIT.busy, `daily cap of ${cfg.dailyJobs} jobs reached`);
  const seen = Object.fromEntries(Object.entries(state.seen).filter(([, at]) => at > now - SEEN_WINDOW_MS));
  if (sender.frameId !== undefined) seen[sender.frameId] = sender.at!;
  const next: State = { days: { [day]: used + 1 }, seen };
  await deps.ensureDir(cfg.statePath.slice(0, cfg.statePath.lastIndexOf("/")), 0o700);
  await deps.writeFile(cfg.statePath, JSON.stringify(next), 0o600);
}

/**
 * Paths the job's file tools are denied, on top of reads outside its working directories: the
 * runner's directories, and each secret file by its own path (its directory could be `/`).
 */
function deniedPaths(cfg: PrivilegedConfig): string[] {
  const paths = ["/proc", "/sys", "/etc/wim-agent", cfg.runDir, cfg.lock.path, cfg.statePath];
  if (cfg.recipient !== undefined) paths.push(cfg.recipient.home);
  if (cfg.wakeCode !== undefined && "file" in cfg.wakeCode) paths.push(cfg.wakeCode.file);
  for (const p of Object.values(cfg.profiles)) {
    if (p.auth.type === "api-key") paths.push(p.auth.keyFile);
    else if (p.auth.identity.type === "file") paths.push(p.auth.identity.path);
  }
  return [...new Set(paths)];
}

/** The job's way to the API: a loopback proxy with this job's key. Nothing the job holds outlives it. */
async function signIn(profile: Profile, cfg: PrivilegedConfig, deps: PrivilegedDeps): Promise<{ env: Record<string, string>; stop(): Promise<void> }> {
  const apiKey = profile.auth.type === "api-key" ? await readRootSecret(profile.auth.keyFile, deps) : undefined;
  const identity: IdentityDeps = {
    ...deps.identity,
    // A token file is read as root: it must be root's, and not writable by anyone else.
    readFile: (path) => deps.readFile(path, rootRule(deps, false)),
  };
  const auth = await upstreamAuth(profile.auth, apiKey, cfg.apiUrl, { identity, credentials: () => deps.credentials(), fetch: deps.fetch, log: (l) => log(deps, l) });
  const proxy = await deps.startProxy({
    upstream: cfg.apiUrl,
    auth,
    models: [profile.model],
    maxTokens: profile.maxTokens,
    maxRequests: profile.maxTurns + EXTRA_REQUESTS,
    maxBodyBytes: MAX_API_BODY_BYTES,
    requestTimeoutMs: cfg.timeoutSeconds * 1000,
    fetch: deps.fetch as never,
    log: (l) => log(deps, l),
  });
  return { env: { ANTHROPIC_BASE_URL: proxy.url, ANTHROPIC_API_KEY: proxy.key }, stop: () => proxy.close() };
}

/**
 * The worker user, and the directories the job lock and the job need, made before the lock is
 * taken: on a fresh /run tmpfs neither exists yet, and opening the lock file would fail.
 */
async function prepareRunDir(cfg: PrivilegedConfig, deps: PrivilegedDeps): Promise<{ uid: number; gid: number }> {
  const user = await deps.lookupUser(cfg.worker.user);
  // Each directory is checked as it is made: a directory, not a symlink, root's alone.
  await deps.ensureDir(cfg.runDir, 0o750);
  const lockDir = cfg.lock.path.slice(0, cfg.lock.path.lastIndexOf("/"));
  // The lock may live in a directory the scheduled jobs own (another group, its own mode): check it, never re-own it.
  if (lockDir !== "" && lockDir !== cfg.runDir) await deps.checkDir(lockDir);
  return user;
}

/** Runs the job as the worker user; resolves with the answer, or throws a Refusal. */
async function runJob(cfg: PrivilegedConfig, profile: Profile, task: string, req: ParsedRequest, self: string[], user: { uid: number; gid: number }, deps: PrivilegedDeps): Promise<Buffer> {
  const auth = await signIn(profile, cfg, deps);
  try {
    const job = JSON.stringify({
      model: profile.model,
      effort: profile.effort,
      maxTurns: profile.maxTurns,
      tools: profile.tools,
      cwd: cfg.worker.cwd,
      additionalDirectories: cfg.worker.additionalDirectories,
      denyRead: deniedPaths(cfg),
      sandbox: profile.unsafeTools,
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
    let grace: unknown;
    const stop = (why: "timeout" | "signal"): void => {
      if (ended !== undefined) return;
      ended = why;
      handle.killGroup("SIGTERM");
      grace = deps.setTimeout(() => handle.killGroup("SIGKILL"), cfg.killGraceSeconds * 1000);
    };
    const timer = deps.setTimeout(() => stop("timeout"), cfg.timeoutSeconds * 1000);
    const off = deps.onSignal(() => stop("signal"));
    const started = deps.now();
    // The leader's exit ends the job: the credential stops at once, then anything the leader
    // left running (a setsid child holding the pipes) is killed with the job's scope.
    const code = await handle.exited;
    deps.clearTimeout(timer);
    deps.clearTimeout(grace);
    off();
    // The proxy closes the moment the leader exits, before anything else is waited for.
    await auth.stop();
    await handle.cleanup();
    const secs = Math.round((deps.now() - started) / 1000);
    if (ended === "timeout") throw new Refusal(EXIT.timeout, `job timed out after ${cfg.timeoutSeconds} s`);
    if (ended === "signal") throw new Refusal(EXIT.timeout, "stopped by a signal while the job ran");
    if (code !== 0) throw new Refusal(EXIT.failed, `job exited ${String(code)} after ${secs} s`);
    log(deps, `job done in ${secs} s`);
    const answer = Buffer.concat(chunks);
    return truncated ? Buffer.concat([answer, Buffer.from(TRUNCATED)]) : answer;
  } finally {
    await auth.stop();
  }
}

async function run(env: Record<string, string | undefined>, self: string[], deps: PrivilegedDeps): Promise<Buffer> {
  if (deps.euid === 0) {
    const problem = await deps.codeProblem();
    if (problem !== undefined) throw new Refusal(EXIT.failed, `refusing to run code others could change: ${problem}`);
  }
  const cfg = await loadPrivilegedConfig(configPath(env, deps.euid), deps.readFile, deps.euid);
  const req = parseRequest(await deps.readStdin(MAX_REQUEST_BYTES + 1));
  const tag = `msg=${req.id} device=${req.from.device}`;
  try {
    const sender = await authenticate(req, cfg, env, deps);
    let text = sender.text;
    if (!sender.local && cfg.wakeCode !== undefined) {
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
    const user = await prepareRunDir(cfg, deps);
    const lock = await deps.acquireLock(cfg.lock.path, cfg.lock.waitSeconds);
    if (lock === null) throw new Refusal(EXIT.busy, `job lock busy for ${cfg.lock.waitSeconds} s`);
    try {
      await admit(cfg, sender, deps);
      log(deps, `${tag} accepted: profile ${profile}, ${task.length} characters`);
      const answer = await runJob(cfg, cfg.profiles[profile]!, task, req, self, user, deps);
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
    // Our own config errors say what is wrong; anything else by name only, because a parser's or
    // a library's message can quote what it read (a token, a key, the task).
    const e = error as Error;
    log(deps, e instanceof ConfigError ? `failed: ${e.message.slice(0, 500)}` : `failed: ${e.name}${typeof (e as NodeJS.ErrnoException).code === "string" ? ` (${(e as NodeJS.ErrnoException).code})` : ""}`);
    return EXIT.failed;
  }
}
