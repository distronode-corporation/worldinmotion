// `wim agent doctor`: read-only checks of a worker's install, one pass or fail line each. Run as
// root it checks every user's view (each probe is a child with that user's uid); run as the peer
// user it checks what that user can see and says which checks need root. Nothing is written,
// nothing is sent, and no file's content (a key, a code, a token) is ever printed.

// The privileged runner and the files it reads are POSIX: their paths are joined as POSIX paths.
import { posix } from "node:path";
import type { WorkerConfig } from "./config.ts";
import type { NoNewPrivs, ProbeAnswer, ProbeOp, UserId } from "./probe.ts";

/** One line: a check that passed, a problem, a check that could not run here, or a fact. */
export interface Check {
  level: "ok" | "problem" | "skip" | "info";
  line: string;
}

/** The Node versions the package supports (package.json `engines`). */
export const MIN_NODE = [22, 18, 0] as const;

/** Where clouds answer instance metadata (and hand out the machine's credentials): IPv4 and IPv6. */
export const METADATA_ADDRESSES: readonly { host: string; port: number }[] = [
  { host: "169.254.169.254", port: 80 },
  { host: "fd00:ec2::254", port: 80 },
];

/** The default sudoers drop-in the deployment guide installs. */
export const SUDOERS_PATH = "/etc/sudoers.d/wim-agent";

/** What doctor reads of the privileged runner's config: only these fields. */
export interface PrivilegedView {
  profiles: Record<string, { auth: { type: "api-key"; keyFile: string } | { type: "wif"; identity: { type: string } } }>;
  defaultProfile: string;
  lock: { path: string; waitSeconds: number };
  timeoutSeconds: number;
  killGraceSeconds: number;
  wakeCode?: { file: string } | { env: string };
  worker: { user: string };
  runDir: string;
  statePath: string;
  /** The receiving session whose key files the runner reads to check each frame itself. */
  recipient?: { home: string; mesh: string; address: string; user: string };
}

export interface FileStat {
  uid: number;
  gid: number;
  mode: number;
  kind: "file" | "dir" | "socket" | "other";
}

export interface DoctorInput {
  /** The worker config's path, and its text (undefined: it could not be read; `readError` says why). */
  configPath: string;
  configText: string | undefined;
  readError?: string;
  /** The user the peer (`wim agent serve`) runs as; default: the user running doctor. */
  peerUser?: string;
  privilegedPath: string;
  launcherPath: string;
  sudoersPath: string;
  /** The peer's systemd unit, whose main process must be free to use sudo. */
  service: string;
  /** This device and its mesh's roster, or why they could not be read. */
  mesh: { self: { id: string; name: string }; devices: readonly { id: string; name: string }[]; trusted: (id: string) => boolean } | { error: string };
}

export interface DoctorDeps {
  uid: number;
  userName: string;
  nodeVersion: string;
  env: Readonly<Record<string, string | undefined>>;
  loadConfig: (raw: unknown) => WorkerConfig;
  /** Throws an error with `code` (ENOENT, EACCES, ...) like node:fs. */
  stat: (path: string) => Promise<FileStat>;
  readText: (path: string) => Promise<string>;
  lookupUser: (name: string) => Promise<UserId | undefined>;
  probe: (as: UserId | undefined, op: ProbeOp) => Promise<ProbeAnswer>;
  /** A command's absolute path when it is on PATH (or is an absolute path to a file). */
  which: (command: string) => Promise<string | undefined>;
  /** The Agent SDK as this install would load it, or undefined when it is not installed. */
  sdk: () => { version: string } | undefined;
  loadPrivileged: (path: string) => Promise<PrivilegedView>;
  sudoersLine: (peerUser: string) => string;
  noNewPrivs: (service: string) => Promise<NoNewPrivs>;
  /** Why node or this wim's file could be changed by someone other than root (the runner refuses then), or undefined. */
  codeProblem: () => Promise<string | undefined>;
}

const ok = (line: string): Check => ({ level: "ok", line });
const problem = (line: string): Check => ({ level: "problem", line });
const skip = (line: string): Check => ({ level: "skip", line });
const info = (line: string): Check => ({ level: "info", line });

const codeOf = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? (err as Error).message;

/** Whether `have` (`22.18.0`, `v24.1.0`) is at least MIN_NODE. */
export function nodeSupported(have: string): boolean {
  const parts = have.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < MIN_NODE.length; i++) {
    const p = parts[i] ?? 0;
    if (p !== MIN_NODE[i]) return p > MIN_NODE[i]!;
  }
  return true;
}

/** Whether the config's runner is the privileged runner (the launcher itself, or through sudo). */
export function privilegedRunner(config: WorkerConfig, launcher: string): boolean {
  const { command, args } = config.runner;
  return command === launcher || ((command === "sudo" || command.endsWith("/sudo")) && args.includes(launcher));
}

/** Whether the runner is one of this package's own, which load the Agent SDK. */
export function builtInRunner(config: WorkerConfig, launcher: string): boolean {
  const { command, args } = config.runner;
  // `wim agent runner`, from the bundle (node wim.mjs agent runner) or an installed wim.
  const at = args.lastIndexOf("agent");
  return privilegedRunner(config, launcher) || command.endsWith("wim-agent-runner") || (at >= 0 && args[at + 1] === "runner");
}

/** Anything a person still has to fill in, as the JSON paths that hold an init placeholder. */
export function placeholders(value: unknown, at = ""): string[] {
  if (typeof value === "string") return value.includes(PLACEHOLDER) ? [at === "" ? "config" : at] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => placeholders(v, `${at}[${i}]`));
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([k, v]) => placeholders(v, at === "" ? k : `${at}.${k}`));
  return [];
}

/** What `wim agent init` writes where only the person knows the value. */
export const PLACEHOLDER = "REPLACE-ME";

/** Runs every check, handing each line to `emit` as it is found. Returns the number of problems. */
export async function runDoctor(input: DoctorInput, deps: DoctorDeps, emit: (c: Check) => void): Promise<number> {
  let problems = 0;
  const say = (c: Check): void => {
    if (c.level === "problem") problems++;
    emit(c);
  };

  say(nodeSupported(deps.nodeVersion) ? ok(`Node ${deps.nodeVersion} is supported (needs ${MIN_NODE.join(".")} or later)`) : problem(`Node ${deps.nodeVersion} is too old: the worker needs ${MIN_NODE.join(".")} or later`));

  const config = readConfig(input, deps, say);
  if (config === undefined) return problems;

  senders(config, input, say);
  const l = config.limits;
  say(info(`limits: tasks up to ${l.maxTaskChars} characters, ${l.perSenderPerHour} attempts per device per hour, ${l.dailyJobs} jobs a day, ${config.runner.timeoutSeconds} s a job, one job at a time`));

  // The peer: the user `wim agent serve` runs as.
  const peerName = input.peerUser ?? deps.userName;
  const peer = await deps.lookupUser(peerName);
  if (peer === undefined) say(problem(`peer user ${peerName}: no such user`));
  else if (peer.uid === 0) say(problem(`peer user ${peerName} is root: run the worker as its own unprivileged user (README, "Running it as its own user")`));
  else say(ok(`peer user ${peerName} is not root (uid ${peer.uid})`));

  /** Runs `op` as `user`, or says why it cannot from here. */
  const as: As = async (user, op) => {
    if (deps.uid === 0) return deps.probe(user, op);
    if (user.uid === deps.uid) return deps.probe(undefined, op);
    return "skip";
  };
  const asRoot = `run \`sudo wim agent doctor\` to check it`;

  /** The metadata endpoint must be out of `user`'s reach: it hands out the machine's own credentials. */
  const noMetadata = async (role: string, user: UserId): Promise<void> => {
    for (const m of METADATA_ADDRESSES) {
      const a = await as(user, { op: "connect", host: m.host, port: m.port, timeoutMs: 2000 });
      const where = `${m.host.includes(":") ? `[${m.host}]` : m.host}:${m.port}`;
      if (a === "skip") say(skip(`${role} ${user.name} reaching the metadata endpoint ${where}: ${asRoot}`));
      else if (a === "yes") say(problem(`${role} ${user.name} can reach the cloud metadata endpoint ${where}: block it for this user (README, "Running it as its own user")`));
      else if (a === "no") say(ok(`${role} ${user.name} cannot reach the metadata endpoint ${where}`));
      else say(problem(`${role} ${user.name}: the metadata probe of ${where} failed to run`));
    }
  };

  if (privilegedRunner(config, input.launcherPath)) {
    await privileged(config, input, deps, peer, as, noMetadata, asRoot, say);
  } else {
    await direct(config, deps, peer, as, noMetadata, asRoot, say);
  }

  if (builtInRunner(config, input.launcherPath)) sdk(deps, say);
  else say(info(`runner ${config.runner.command} is your own: the Agent SDK check is skipped`));
  return problems;
}

function readConfig(input: DoctorInput, deps: DoctorDeps, say: (c: Check) => void): WorkerConfig | undefined {
  if (input.configText === undefined) {
    say(problem(`${input.configPath}: cannot be read (${input.readError ?? "unknown"}); \`wim agent init ${input.configPath}\` writes one`));
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(input.configText);
  } catch (err) {
    say(problem(`${input.configPath}: not valid JSON (${(err as Error).message})`));
    return undefined;
  }
  const left = placeholders(raw);
  if (left.length > 0) {
    say(problem(`${input.configPath}: still to fill in: ${left.join(", ")}`));
    return undefined;
  }
  try {
    const config = deps.loadConfig(raw);
    say(ok(`${input.configPath} is a valid worker config`));
    return config;
  } catch (err) {
    for (const line of (err as Error).message.split("\n").slice(1)) say(problem(`${input.configPath}: ${line}`));
    return undefined;
  }
}

/** The allowed devices against this mesh's roster, and the reply trust each sender must give. */
function senders(config: WorkerConfig, input: DoctorInput, say: (c: Check) => void): void {
  if ("error" in input.mesh) {
    say(skip(`allowed senders against the roster: ${input.mesh.error}`));
    return;
  }
  const { self, devices, trusted } = input.mesh;
  for (const id of config.senders.devices) {
    const d = devices.find((x) => x.id === id);
    if (d === undefined) say(problem(`allowed sender ${id} is not in this mesh's roster (\`wim devices\` lists the ids)`));
    else if (id === self.id) say(problem(`allowed sender ${id} is this worker's own device: list the devices that send it work`));
    else if (config.senders.requireTrusted && !trusted(id)) say(problem(`allowed sender ${d.name} (${id}) is not trusted here, and senders.requireTrusted is on: \`wim devices trust ${d.name}\``));
    else say(ok(`allowed sender ${d.name} (${id}) is in the roster${config.senders.requireTrusted ? " and trusted here" : ""}`));
  }
  // Checked on the sender, so it can only be said here: replies are marked relayed (a model
  // wrote them), and a sender's client holds relayed text from a device it trusts without --relayed.
  say(info(`on each sender device, \`wim devices trust ${self.name} --relayed\` lets this worker's answers (marked relayed) through; without it they wait in \`wim held\``));
}

/** A runner this user runs directly: the peer is the worker, so it is the one kept from metadata. */
async function direct(
  config: WorkerConfig,
  deps: DoctorDeps,
  peer: UserId | undefined,
  as: As,
  noMetadata: (role: string, user: UserId) => Promise<void>,
  asRoot: string,
  say: (c: Check) => void,
): Promise<void> {
  const { command } = config.runner;
  const found = await deps.which(command);
  say(found === undefined ? problem(`runner ${command} is not found (an absolute path, or a command on PATH)`) : ok(`runner ${command} is ${found}`));
  say(info("the runner runs as the peer user, so the job user is the peer user; a sudo runner with its own job user keeps credentials further away (README, \"Security model\")"));
  if (peer !== undefined) await noMetadata("job user", peer);
  if (config.wake.mode === "local" && config.wake.codeFile !== undefined) await peerSecret("wake code file", config.wake.codeFile, deps, peer, as, asRoot, say);
  await directProfiles(config, deps, peer, as, asRoot, say);
  say(deps.env["ANTHROPIC_API_KEY"] ? ok("ANTHROPIC_API_KEY is set (not shown)") : info("ANTHROPIC_API_KEY is not set here: the built-in runner needs it in the service's environment"));
  if (!config.runner.passEnv.includes("ANTHROPIC_API_KEY")) say(info("runner.passEnv does not pass ANTHROPIC_API_KEY: the runner must find its key another way"));
}

/**
 * The built-in runner's own config (`--config`): it refuses a profile it does not list, so each
 * profile the worker accepts must be there, and any key file must be the peer user's alone.
 */
async function directProfiles(config: WorkerConfig, deps: DoctorDeps, peer: UserId | undefined, as: As, asRoot: string, say: (c: Check) => void): Promise<void> {
  if (!builtInRunner(config, "")) {
    if (config.profiles !== undefined) say(info(`profiles ${config.profiles.allowed.join(", ")} go to your runner as \`profile\`; it decides what each means`));
    return;
  }
  const args = config.runner.args;
  const at = args.indexOf("--config");
  const path = at === -1 ? undefined : args[at + 1];
  if (path === undefined) {
    if (config.profiles !== undefined) say(problem(`the built-in runner refuses a profile its config does not list: give it \`--config <runner.json>\` listing ${config.profiles.allowed.join(", ")}`));
    return;
  }
  let rc: { keyFile?: unknown; profiles?: Record<string, { keyFile?: unknown }> };
  try {
    rc = JSON.parse(await deps.readText(path)) as typeof rc;
  } catch (err) {
    say(problem(`runner config ${path}: ${codeOf(err)}`));
    return;
  }
  const listed = rc.profiles ?? {};
  for (const name of config.profiles?.allowed ?? []) {
    say(Object.hasOwn(listed, name) ? ok(`profile ${name} is in the runner config ${path}`) : problem(`profile ${name}: the worker accepts it, but the runner config ${path} does not list it`));
  }
  const keys = [rc.keyFile, ...Object.values(listed).map((p) => p.keyFile)].filter((k): k is string => typeof k === "string");
  for (const file of keys) await peerSecret("key file", file, deps, peer, as, asRoot, say);
}

/** Runs a probe as a user, or says it cannot from here. */
type As = (user: UserId, op: ProbeOp) => Promise<ProbeAnswer | "skip">;

/**
 * A secret the peer user reads itself (a direct runner's key, a local wake code): nobody else
 * may read it, nobody but its owner may change it, and the peer user must be able to read it
 * (as its owner with 600, or through its group with 640).
 */
async function peerSecret(what: string, file: string, deps: DoctorDeps, peer: UserId | undefined, as: As, asRoot: string, say: (c: Check) => void): Promise<void> {
  let st: FileStat;
  try {
    st = await deps.stat(file);
  } catch (err) {
    say(problem(`${what} ${file}: ${codeOf(err)}`));
    return;
  }
  if ((st.mode & 0o027) !== 0) {
    say(problem(`${what} ${file} is open to others or writable by its group (mode ${(st.mode & 0o777).toString(8)}): chmod 600, or 640 with the peer user's group`));
    return;
  }
  if (peer === undefined) {
    say(ok(`${what} ${file} is closed to others (not shown)`));
    return;
  }
  const a = await as(peer, { op: "read", path: file });
  if (a === "yes") say(ok(`${what} ${file} is closed to others and readable by the peer user ${peer.name} (not shown)`));
  else if (a === "skip") say(skip(`${what} ${file} readable by ${peer.name}: ${asRoot}`));
  else say(problem(`${what} ${file}: the peer user ${peer.name} cannot read it, and the worker needs to`));
}

/** The sudo runner: the line that allows it, its config, its users, its lock and its wake code. */
async function privileged(
  config: WorkerConfig,
  input: DoctorInput,
  deps: DoctorDeps,
  peer: UserId | undefined,
  as: As,
  noMetadata: (role: string, user: UserId) => Promise<void>,
  asRoot: string,
  say: (c: Check) => void,
): Promise<void> {
  const peerName = input.peerUser ?? deps.userName;
  await rootFile(input.launcherPath, "privileged runner", deps, say);

  // The one sudoers line: exactly the runner, with no arguments allowed.
  if (deps.uid !== 0) say(skip(`sudoers line in ${input.sudoersPath}: ${asRoot}`));
  else {
    try {
      const want = deps.sudoersLine(peerName);
      const lines = (await deps.readText(input.sudoersPath)).split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
      if (lines.length === 1 && lines[0] === want) say(ok(`${input.sudoersPath} holds exactly: ${want}`));
      else say(problem(`${input.sudoersPath} must hold exactly one rule, \`${want}\` (found ${lines.length} rule line(s) that differ)`));
    } catch (err) {
      say(problem(`${input.sudoersPath}: ${codeOf(err)}`));
    }
  }

  // sudo cannot raise privileges from a process with no_new_privs: every job would fail.
  const nnp = await deps.noNewPrivs(input.service);
  if ("skip" in nnp) say(skip(`NoNewPrivs of ${input.service}: ${nnp.skip}`));
  else if (nnp.value === "1") say(problem(`${input.service} (pid ${nnp.pid}) runs with NoNewPrivs, so its sudo cannot start the privileged runner: drop NoNewPrivileges= and the settings that imply it for a User= unit (LockPersonality=, RestrictRealtime=, ProtectKernelTunables=, ...)`));
  else say(ok(`${input.service} (pid ${nnp.pid}) may use sudo (NoNewPrivs 0)`));

  // The runner compares the task with the signed message, so the worker must hand it over
  // untouched: no code stripped and no prefix parsed on this side.
  if (config.wake.mode !== "runner") say(problem(`wake.mode is ${config.wake.mode}, but the privileged runner checks the task against the signed message: set wake.mode to "runner" and leave the code and any profile prefix to the runner`));
  else say(ok("the worker hands the privileged runner the signed text untouched (wake.mode runner)"));

  let p: PrivilegedView;
  try {
    p = await deps.loadPrivileged(input.privilegedPath);
    say(ok(`${input.privilegedPath} is a valid privileged runner config`));
  } catch (err) {
    const c = codeOf(err);
    if (c === "EACCES") say(skip(`${input.privilegedPath}: ${asRoot}`));
    else say(problem(`${input.privilegedPath}: ${(err as Error).message}`));
    return;
  }

  // The runner answers its own timeout (exit 5), after waiting for its lock and its job's kill
  // grace: the peer must wait longer.
  const needs = p.lock.waitSeconds + p.timeoutSeconds + p.killGraceSeconds;
  if (config.runner.timeoutSeconds <= needs) say(problem(`runner.timeoutSeconds is ${config.runner.timeoutSeconds}, but the privileged runner may take ${needs} s (lock wait ${p.lock.waitSeconds} + job ${p.timeoutSeconds} + kill grace ${p.killGraceSeconds}): set it above ${needs}`));
  else say(ok(`runner.timeoutSeconds ${config.runner.timeoutSeconds} s covers the privileged runner's lock wait, job and kill grace (${needs} s)`));

  // Profiles: each one the worker accepts must exist in the runner, with its auth in place.
  // With wake.mode runner the runner parses the prefix, so every profile it has can be named.
  const named = config.profiles?.allowed ?? Object.keys(p.profiles);
  for (const name of named) {
    const prof = p.profiles[name];
    if (prof === undefined) {
      say(problem(`profile ${name}: the worker accepts it but ${input.privilegedPath} has no such profile`));
      continue;
    }
    if (prof.auth.type === "wif") {
      say(ok(`profile ${name}: keyless (workload identity, ${prof.auth.identity.type})`));
      continue;
    }
    const file = prof.auth.keyFile;
    try {
      const st = await deps.stat(file);
      if (st.uid !== 0 || (st.mode & 0o077) !== 0) say(problem(`profile ${name}: key file ${file} must be owned by root with mode 600`));
      else say(ok(`profile ${name}: key file ${file} is root's alone (not shown)`));
    } catch (err) {
      const c = codeOf(err);
      say(c === "EACCES" ? skip(`profile ${name}: key file ${file}: ${asRoot}`) : problem(`profile ${name}: key file ${file}: ${c}`));
    }
  }

  // The worker never holds the code here: the runner does.
  if (config.wake.mode === "local") say(problem(`wake.mode is local, but the privileged runner keeps the code from the peer user: use wake.mode runner`));
  if (p.wakeCode === undefined) say(info("the privileged runner checks no wake code: the device allow-list is the only key"));
  else if ("env" in p.wakeCode) say(info(`the wake code comes from the runner's ${p.wakeCode.env}; sudo resets the environment, so a file is the form that works under sudo`));
  else if (peer !== undefined) {
    const file = p.wakeCode.file;
    const a = await as(peer, { op: "read", path: file });
    if (a === "skip") say(skip(`wake code ${file} unreadable by ${peer.name}: ${asRoot}`));
    else if (a === "no") say(ok(`wake code ${file} is unreadable by the peer user ${peer.name}`));
    else if (a === "yes") say(problem(`the peer user ${peer.name} can read the wake code ${file}: chown root:root and chmod 600`));
    else if (a === "missing") say(problem(`wake code ${file} does not exist`));
    else say(problem(`wake code ${file}: the read probe failed to run`));
  }

  // The job user and the peer user both stay away from the metadata endpoint.
  const job = await deps.lookupUser(p.worker.user);
  if (job === undefined) say(problem(`job user ${p.worker.user}: no such user`));
  else if (job.uid === 0) say(problem(`job user ${p.worker.user} is root`));
  else if (peer !== undefined && job.uid === peer.uid) say(problem(`job user ${p.worker.user} is the peer user: give jobs their own user`));
  else await noMetadata("job user", job);
  if (peer !== undefined) await noMetadata("peer user", peer);

  // The runner runs this same node and wim.mjs as root: nobody else may be able to change them.
  const code = await deps.codeProblem().catch((err: unknown) => `it could not be checked (${codeOf(err)})`);
  say(code === undefined ? ok("node and this wim, and every directory above them, are root's alone") : problem(`the privileged runner refuses code others can change: ${code}`));

  await rootDir(posix.dirname(p.statePath), "the runner's state directory", deps, say);
  if (p.recipient !== undefined) await recipientFiles(p.recipient, deps, say);

  // The lock: only root (the runner) takes it, so neither user may write where it lives.
  try {
    const st = await deps.stat(p.runDir);
    if (st.kind !== "dir" || st.uid !== 0 || (st.mode & 0o022) !== 0) say(problem(`${p.runDir} must be a directory owned by root, not group or other writable`));
    else say(ok(`${p.runDir} (the lock ${p.lock.path}) is root's to write`));
  } catch (err) {
    say(problem(`${p.runDir}: ${codeOf(err)} (the privileged runner creates it, or the deployment guide's tmpfiles line does)`));
  }
  for (const [role, user] of [["peer user", peer], ["job user", job]] as const) {
    if (user === undefined || user.uid === 0) continue;
    const a = await as(user, { op: "write", path: p.runDir });
    if (a === "skip") say(skip(`${role} ${user.name} writing ${p.runDir}: ${asRoot}`));
    else if (a === "yes") say(problem(`${role} ${user.name} can write ${p.runDir}, where the runner keeps its lock`));
    else if (a === "no" || a === "missing") say(ok(`${role} ${user.name} cannot write ${p.runDir}`));
    else say(problem(`${role} ${user.name}: the write probe of ${p.runDir} failed to run`));
  }
  // The job user reads its short-lived token files there; the peer user must not (nor be in its group).
  if (peer !== undefined && peer.uid !== 0) {
    const a = await as(peer, { op: "read", path: p.runDir });
    if (a === "skip") say(skip(`peer user ${peer.name} reading ${p.runDir}: ${asRoot}`));
    else if (a === "yes") say(problem(`peer user ${peer.name} can read ${p.runDir}, where the job's credentials are: keep it out of the directory's group`));
    else if (a === "no" || a === "missing") say(ok(`peer user ${peer.name} cannot read ${p.runDir}`));
    else say(problem(`peer user ${peer.name}: the read probe of ${p.runDir} failed to run`));
  }
}

/** A directory only root can read or write. */
async function rootDir(path: string, what: string, deps: DoctorDeps, say: (c: Check) => void): Promise<void> {
  try {
    const st = await deps.stat(path);
    if (st.kind !== "dir" || st.uid !== 0 || (st.mode & 0o077) !== 0) say(problem(`${what} ${path} must be a directory of root's alone (mode 700)`));
    else say(ok(`${what} ${path} is root's alone`));
  } catch (err) {
    const c = codeOf(err);
    say(c === "ENOENT" ? info(`${what} ${path} does not exist yet: the runner creates it`) : problem(`${what} ${path}: ${c}`));
  }
}

/**
 * The receiving session's key files, which the runner reads as root to check each frame: owned
 * by the peer user, mode 600, and the device keys in the clear (an encrypted key file, which only
 * the signer opens, makes the runner refuse every job).
 */
async function recipientFiles(r: NonNullable<PrivilegedView["recipient"]>, deps: DoctorDeps, say: (c: Check) => void): Promise<void> {
  const owner = await deps.lookupUser(r.user);
  if (owner === undefined) {
    say(problem(`recipient.user ${r.user}: no such user`));
    return;
  }
  for (const [file, optional] of [[posix.join(r.home, "device.json"), false], [posix.join(r.home, "meshes", r.mesh, "prekeys.json"), true]] as const) {
    let st: FileStat;
    try {
      st = await deps.stat(file);
    } catch (err) {
      const c = codeOf(err);
      say(c === "ENOENT" && optional ? info(`${file} does not exist yet: the session writes it when it first connects`) : problem(`${file}: ${c}`));
      continue;
    }
    if (st.kind !== "file" || st.uid !== owner.uid || (st.mode & 0o077) !== 0) {
      say(problem(`${file} must be a file of ${r.user}'s alone (mode 600)`));
      continue;
    }
    if (optional) {
      say(ok(`${file} is ${r.user}'s alone`));
      continue;
    }
    const text = await deps.readText(file).catch(() => undefined);
    let v: unknown;
    try {
      v = text === undefined ? undefined : (JSON.parse(text) as { v?: unknown }).v;
    } catch {
      v = "not JSON";
    }
    if (text === undefined) say(skip(`${file}: run \`sudo wim agent doctor\` to check it is in the clear`));
    else if (v === 1) say(ok(`${file} is ${r.user}'s alone, and in the clear as the runner needs`));
    else if (v === "not JSON") say(problem(`${file} is not valid JSON`));
    else say(problem(`${file} is encrypted (wim signer encrypt), so the runner cannot open frames: the worker's device keeps a plaintext key file (\`wim signer decrypt\`)`));
  }
}

/** A root-owned file nobody else can change. */
async function rootFile(path: string, what: string, deps: DoctorDeps, say: (c: Check) => void): Promise<void> {
  try {
    const st = await deps.stat(path);
    if (st.uid !== 0 || (st.mode & 0o022) !== 0) say(problem(`${what} ${path} must be owned by root and not group or other writable`));
    else say(ok(`${what} ${path} is root's`));
  } catch (err) {
    say(problem(`${what} ${path}: ${codeOf(err)}`));
  }
}

function sdk(deps: DoctorDeps, say: (c: Check) => void): void {
  const found = deps.sdk();
  say(found === undefined ? problem("the Claude Agent SDK is not installed where this wim can load it: `npm i -g @anthropic-ai/claude-agent-sdk` (or next to wim)") : ok(`Claude Agent SDK ${found.version} is installed`));
}
