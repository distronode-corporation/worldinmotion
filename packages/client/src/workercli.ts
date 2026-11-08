// `wim agent`: a peer that sleeps until an allowed device messages it, then runs one agent job
// through a runner command and replies (@worldinmotion/agent). `init` writes a starting config,
// `doctor` checks an install without changing it, `run --once` sends one runner request from stdin
// through the configured runner, `serve` is the peer, and `runner` and `privileged` are the two
// built-in runners (the plain Agent SDK runner, and the one a root launcher starts through sudo).

import { allowProblem, initNotes, loadConfig, lookupUser, placeholders, privilegedTemplate, probe, runDoctor, runOnce, runWorker, serviceNoNewPrivs, SUDOERS_PATH, workerTemplate, type AuthMode, type Check, type DoctorDeps, type FileStat, type InitMode, type InitOptions, type PrivilegedView } from "@worldinmotion/agent";
import { loadPrivilegedConfig, privilegedMain, PRIVILEGED_CONFIG_PATH, PRIVILEGED_RUNNER_PATH, codeProblem, secureRead, sudoersLine, systemDeps } from "@worldinmotion/agent/privileged";
import { runnerMain } from "@worldinmotion/agent/sdk-runner";
import { copyKit, findKit } from "@worldinmotion/agent/kit";
import { fileURLToPath } from "node:url";
import { constants, promises as fs, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { workerIO } from "./adapters.ts";
import type { MeshSession } from "./client.ts";
import { SetupError } from "./errors.ts";
import { writeAtomic, type FsEnv } from "./fsx.ts";
import { parseJson } from "@worldinmotion/protocol";
import type { Device } from "./home.ts";
import { RosterBook, type MeshFiles } from "./mesh.ts";
import { isTrusted } from "./render.ts";

export const WORKER_USAGE = `wim agent init <config> [--mode direct|privileged] [--allow <device id>,...] [--profiles <name>,...] [--room <#room>] [--auth api-key|wif] [--wake-file <path>] [--kit <dir>] | wim agent init --kit <dir>
  wim agent doctor <config> [--peer-user <name>] [--privileged-config <path>] [--sudoers <path>] [--service <unit>]
  wim agent run --once <config> (one runner request, as JSON, on stdin)
  wim agent serve <config> [--as <name>] [--take]
  wim agent runner [--config <runner.json>] | wim agent privileged (the built-in runners; a runner request on stdin)`;

export const WORKER_ACTIONS: readonly string[] = ["init", "doctor", "run", "serve", "runner", "privileged"];

/** The signer's words, which `wim agent` kept for one release after the signer became `wim signer`. */
export const SIGNER_ACTIONS: readonly string[] = ["start", "serve", "status", "lock", "unlock", "stop", "encrypt", "decrypt", "autostart"];

/** Flags only the signer takes. */
const SIGNER_FLAGS: readonly string[] = ["foreground", "passphrase-stdin", "ask-gui", "keyring", "allow-agent-passphrase"];

/**
 * Who answers `wim agent <words>`: the worker, or the signer under its old name. Only `serve` is
 * both. Login items and scripts from before the rename run the signer's `wim agent serve` with no
 * config path (and an older signer start with its flags), so those stay the signer; the worker
 * always names its config. Anything else is the worker's, which prints the usage.
 */
export function agentRoute(positional: readonly string[], flags: ReadonlyMap<string, string | true>): "worker" | "signer" {
  const [action, config] = positional;
  if (action === "serve") return config === undefined || [...flags.keys()].some((f) => SIGNER_FLAGS.includes(f)) ? "signer" : "worker";
  return SIGNER_ACTIONS.includes(action ?? "") ? "signer" : "worker";
}

/** The note on stderr when the signer is reached by its old name. */
export function signerRenamed(action: string): string {
  return `wim: \`wim agent ${action}\` is now \`wim signer ${action}\`; the old spelling works until the next release (\`wim agent\` is the worker from now on: \`wim help agent\`).`;
}

/** What `wim agent` needs from the CLI. */
export type WorkerCli = {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  stdin: Readable;
  stdout: Writable;
  cwd: string;
  now: () => number;
  uid: number | undefined;
  signal: AbortSignal;
  fsEnv: FsEnv;
  positional: readonly string[];
  flags: ReadonlyMap<string, string | true>;
  /** The command line that runs this same wim: [node, wim.mjs] from the bundle. */
  wim: readonly string[];
  mesh: () => Promise<{ device: Device; files: MeshFiles }>;
  /** The worker's session (not started), opened under `name` with no message text kept on disk. */
  session: (name: string) => Promise<MeshSession>;
  /** This device's state directory (WIM_HOME). */
  home: string;
  /** The session name: `--as`, `WIM_NAME`, else `worker`. */
  name: string;
  untilStopped: () => Promise<void>;
  /** Where to look for the deployment kit (tests); default kitCandidates(this module). */
  kitFrom?: readonly string[];
  /** Replaces the doctor's view of this machine (tests). */
  doctor?: Partial<DoctorDeps>;
};

const value = (c: WorkerCli, name: string): string | undefined => {
  const v = c.flags.get(name);
  return typeof v === "string" ? v : undefined;
};
const list = (c: WorkerCli, name: string): string[] =>
  (value(c, name) ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");

/** Runs `wim agent <action>`. */
export async function workerCommand(c: WorkerCli): Promise<number> {
  const [action, path] = c.positional;
  const write = (text: string): void => void c.stdout.write(text);
  switch (action) {
    case "init": {
      // The kit alone (`init --kit <dir>`), or the kit and then the config.
      const kitDir = value(c, "kit");
      if (kitDir !== undefined) await kit(c, kitDir);
      return kitDir !== undefined && path === undefined ? 0 : init(c, needPath(path));
    }
    case "doctor":
      return doctor(c, needPath(path));
    case "run":
      if (c.flags.get("once") !== true) throw new SetupError("usage: wim agent run --once <config> (one runner request on stdin)");
      return once(c, needPath(path), write);
    case "serve":
      return serve(c, needPath(path));
    case "runner": {
      // The CLI took `--config <path>` as a flag; the runner reads it from its own argv.
      const config = value(c, "config");
      return runnerMain(config === undefined ? [] : ["--config", config], { stdin: c.stdin, stdout: write, stderr: c.err, env: c.env, cwd: c.cwd, signal: c.signal });
    }
    case "privileged":
      // Started with no arguments by the root launcher; `--worker` is the job child it starts itself.
      if (c.positional.length > 1 || [...c.flags.keys()].some((f) => f !== "worker")) {
        c.err("wim agent privileged: refusing arguments: the runner takes none");
        return 2;
      }
      return privilegedMain(c.flags.get("worker") === true ? ["--worker"] : [], c.env, [...c.wim, "agent", "privileged"], systemDeps());
    default:
      throw new SetupError(`usage:\n  ${WORKER_USAGE}`);
  }
}

function needPath(path: string | undefined): string {
  if (path === undefined) throw new SetupError("a worker config path is required");
  return path;
}

async function readConfigFile(path: string): Promise<ReturnType<typeof loadConfig>> {
  const parsed = parseJson(await fs.readFile(path, "utf8"));
  if (!parsed.ok) throw new SetupError(`${path}: not valid JSON (${parsed.reason})`);
  const left = placeholders(parsed.value);
  if (left.length > 0) throw new SetupError(`${path}: still to fill in: ${left.join(", ")}`);
  return loadConfig(parsed.value);
}

async function readAll(stdin: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  // Buffers, or strings if an encoding was set on the stream: Buffer.from takes either.
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

async function exists(path: string): Promise<boolean> {
  return fs.lstat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Where the deployment kit is: agent-kit/ beside the published wim.mjs, or packages/agent when
 * this wim runs from the repository (its source, or its bundle in packages/client/dist).
 */
export function kitCandidates(moduleUrl: string): string[] {
  return [fileURLToPath(new URL("./agent-kit/", moduleUrl)), fileURLToPath(new URL("../../agent/", moduleUrl))];
}

/** `wim agent init --kit <dir>`: writes the deployment kit into a new or empty directory. */
async function kit(c: WorkerCli, dir: string): Promise<void> {
  const from = await findKit(c.kitFrom ?? kitCandidates(import.meta.url));
  if (from === undefined) throw new SetupError("this wim carries no deployment kit (agent-kit/ beside wim.mjs): install worldinmotion from npm, or use a clone of the repository");
  const to = resolve(c.cwd, dir);
  const files = await copyKit(from, to).catch((err: unknown) => {
    throw new SetupError((err as Error).message);
  });
  c.out(`Wrote the deployment kit to ${to} (${files.length} files). Its guide is ${join(to, "docs", "deploy.md")}.`);
}

async function init(c: WorkerCli, path: string): Promise<number> {
  const mode = (value(c, "mode") ?? "direct") as InitMode;
  if (mode !== "direct" && mode !== "privileged") throw new SetupError("--mode is direct or privileged");
  const auth = (value(c, "auth") ?? "api-key") as AuthMode;
  if (auth !== "api-key" && auth !== "wif") throw new SetupError("--auth is api-key or wif");
  if (await exists(path)) throw new SetupError(`${path} exists: edit it, or remove it first`);
  const { device, files } = await c.mesh();
  const roster = (await RosterBook.open(files)).current.devices.map((d) => ({ id: d.id, name: d.name, sign: d.sign, box: d.box }));
  const dir = dirname(resolve(c.cwd, path));
  const room = value(c, "room");
  const wakeFile = value(c, "wake-file");
  const o: InitOptions = {
    mode,
    allow: list(c, "allow"),
    roster,
    self: device.id,
    profiles: list(c, "profiles"),
    auth,
    wim: c.wim,
    ledgerPath: join(dir, "worker-ledger.json"),
    launcher: PRIVILEGED_RUNNER_PATH,
    // The worker's own session, as `wim agent serve` will run it, under the peer user.
    recipient: { home: c.home, mesh: (await files.loadConfig()).mesh, address: `${c.name}@${device.name}`, user: value(c, "peer-user") ?? "wim-agent" },
    ...(room === undefined ? {} : { room }),
    ...(wakeFile === undefined ? {} : { wakeFile: resolve(c.cwd, wakeFile) }),
  };
  const bad = allowProblem(o);
  if (bad !== undefined) throw new SetupError(bad);
  const worker = workerTemplate(o);
  const written: string[] = [];
  if (mode === "direct" && o.profiles.length > 0) {
    // The SDK runner refuses a profile it does not list, so it gets the same names.
    const runnerPath = join(dir, "runner.json");
    if (await exists(runnerPath)) throw new SetupError(`${runnerPath} exists: edit it, or remove it first`);
    await writeAtomic(runnerPath, `${JSON.stringify({ profiles: Object.fromEntries(o.profiles.map((p) => [p, {}])) }, null, 2)}\n`, c.fsEnv);
    (worker["runner"] as { args: string[] }).args.push("--config", runnerPath);
    written.push(runnerPath);
  }
  if (mode === "privileged") {
    const privPath = join(dir, "privileged.json");
    if (await exists(privPath)) throw new SetupError(`${privPath} exists: edit it, or remove it first`);
    await writeAtomic(privPath, `${JSON.stringify(privilegedTemplate(o), null, 2)}\n`, c.fsEnv);
    written.push(privPath);
  }
  await writeAtomic(path, `${JSON.stringify(worker, null, 2)}\n`, c.fsEnv);
  const left = placeholders(worker);
  for (const line of initNotes(o, path, left)) c.out(line);
  for (const w of written) c.out(`Also wrote ${w}.${w.endsWith("privileged.json") ? ` As root, install it as ${PRIVILEGED_CONFIG_PATH} (owner root, mode 600) once its REPLACE-ME values are filled in.` : ""}`);
  // A config with nothing left to fill in must already be valid: check it now, not at serve.
  if (left.length === 0) loadConfig(worker);
  return 0;
}

async function once(c: WorkerCli, path: string, write: (text: string) => void): Promise<number> {
  const config = await readConfigFile(path);
  return runOnce(config, await readAll(c.stdin), { out: write, err: c.err, env: c.env });
}

async function serve(c: WorkerCli, path: string): Promise<number> {
  // Checked before connecting: a config with a typo must not announce a peer that never runs.
  const config = await readConfigFile(path);
  const { files } = await c.mesh();
  const s = await c.session(c.name);
  s.start();
  try {
    await s.ready(15_000);
    await runWorker(config, workerIO(s, async (device) => isTrusted(await files.loadConfig(), device)), { log: c.err, now: c.now, env: c.env });
    c.out(`worker running as ${s.address} (Ctrl-C to stop).`);
    await c.untilStopped();
    return 0;
  } finally {
    await s.stop();
  }
}

/** A file's owner, group, mode and kind, as doctor reads it. */
export async function statOf(path: string): Promise<FileStat> {
  const st = await fs.stat(path);
  return { uid: st.uid, gid: st.gid, mode: st.mode, kind: kindOf(st) };
}

/** What kind of file a stat describes. */
export function kindOf(st: { isFile(): boolean; isDirectory(): boolean; isSocket(): boolean }): FileStat["kind"] {
  return st.isFile() ? "file" : st.isDirectory() ? "dir" : st.isSocket() ? "socket" : "other";
}

/** A command's path: itself when absolute and executable, else the first executable match on PATH. */
export async function which(command: string, path: string | undefined): Promise<string | undefined> {
  const exec = (p: string) =>
    fs.access(p, constants.X_OK).then(
      () => p,
      () => undefined,
    );
  if (isAbsolute(command)) return exec(command);
  if (command.includes("/")) return undefined;
  for (const dir of (path ?? "").split(delimiter).filter((d) => d !== "")) {
    const found = await exec(join(dir, command));
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The Agent SDK as this wim loads it: resolved from this module's own location, which in the
 * bundle is wim.mjs, the same place the runner's dynamic import resolves from.
 */
export function sdkFrom(from: string): { version: string } | undefined {
  try {
    const entry = createRequire(from).resolve("@anthropic-ai/claude-agent-sdk");
    // The SDK's entry sits at its package root; its exports do not list package.json.
    const pkg = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as { version?: unknown };
    return { version: typeof pkg.version === "string" ? pkg.version : "(unknown version)" };
  } catch {
    return undefined;
  }
}

async function doctor(c: WorkerCli, path: string): Promise<number> {
  let text: string | undefined;
  let readError: string | undefined;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (err) {
    // Every node:fs error carries a code (ENOENT, EACCES, EISDIR, ...).
    readError = (err as NodeJS.ErrnoException).code!;
  }
  let mesh: Parameters<typeof runDoctor>[0]["mesh"];
  try {
    const { device, files } = await c.mesh();
    const config = await files.loadConfig();
    const book = await RosterBook.open(files);
    mesh = { self: { id: device.id, name: device.name }, devices: book.current.devices.map((d) => ({ id: d.id, name: d.name })), trusted: (id) => isTrusted(config, id) };
  } catch (err) {
    mesh = { error: (err as Error).message };
  }
  const peerUser = value(c, "peer-user");
  // No uid (Windows): nobody's view can be probed, and nothing is read as root.
  const uid = c.uid ?? -1;
  const deps: DoctorDeps = {
    uid,
    userName: userInfo().username,
    nodeVersion: process.versions.node,
    env: c.env,
    loadConfig,
    stat: statOf,
    readText: (p) => fs.readFile(p, "utf8"),
    lookupUser: (name) => lookupUser(name),
    probe,
    which: (command) => which(command, c.env["PATH"]),
    sdk: () => sdkFrom(import.meta.url),
    // As root it also refuses a config another user could have written, as the runner does.
    loadPrivileged: (p) => loadPrivilegedConfig(p, secureRead, uid),
    sudoersLine,
    noNewPrivs: (service) => serviceNoNewPrivs(service),
    codeProblem: codeProblem.bind(undefined, [process.execPath, c.wim.at(-1)!]),
    ...c.doctor,
  };
  const input = {
    configPath: path,
    configText: text,
    ...(readError === undefined ? {} : { readError }),
    ...(peerUser === undefined ? {} : { peerUser }),
    privilegedPath: value(c, "privileged-config") ?? PRIVILEGED_CONFIG_PATH,
    launcherPath: PRIVILEGED_RUNNER_PATH,
    sudoersPath: value(c, "sudoers") ?? SUDOERS_PATH,
    service: value(c, "service") ?? "wim-agent.service",
    mesh,
  };
  const problems = await runDoctor(input, deps, (check: Check) => c.out(`${check.level.padEnd(8)} ${check.line}`));
  c.out(problems === 0 ? "No problems found." : `Problems: ${problems}.`);
  return problems === 0 ? 0 : 1;
}
