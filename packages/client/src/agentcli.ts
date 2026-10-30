// `wim agent`: start, stop, lock and unlock the signer, show its status, start it at each log in,
// and move the key file between plaintext and encrypted. The passphrase is asked for at the
// person's own interactive terminal, or comes from stdin (--passphrase-stdin, for a service manager
// or CI), a native dialog (--ask-gui) or the OS keyring (--keyring); none of those three is taken
// from a command an agent runs unless the person says so (--allow-agent-passphrase).

import { b64u, encodeKeys, prekeySchema, randomBytes, type Prekey } from "@worldinmotion/protocol";
import { spawn as nodeSpawn } from "node:child_process";
import { join } from "node:path";
import { AgentLog, AgentServer, answers, Signer } from "./agent.ts";
import { agentDir, agentEndpoint, agentLogPath, endpointFiles, readAgentSettings, retireEndpoint, startLockPath, writeAgentSettings } from "./agentpath.ts";
import type { CliIO } from "./cli.ts";
import { SetupError } from "./errors.ts";
import { ensureDir, readJson, withLock, writeAtomic, writeJson } from "./fsx.ts";
import type { Home } from "./home.ts";
import { agentEnv, canShowSecret } from "./secretout.ts";
import { askGui, autostartStatus, disableAutostart, enableAutostart, GUI_AGAIN, GUI_ASK, KEYRING_WARNING, keyringAccount, keyringClear, keyringKind, keyringRead, keyringStore, NO_KEYRING, type AutostartOptions, type Programs } from "./autostart.ts";
import { SignerClient } from "./signer.ts";
import { BadPassphrase, openKeyFile, openPrekeySecret, sealKeyFile, sealPrekeySecret, type SealedKeyFile } from "./vault.ts";

export const AGENT_USAGE = `wim agent start [--foreground] [--passphrase-stdin | --ask-gui | --keyring] [--allow-agent-passphrase]
  wim agent status | wim agent lock | wim agent unlock [--foreground] [--passphrase-stdin | --ask-gui | --keyring] | wim agent stop
  wim agent encrypt [--passphrase-stdin] | wim agent decrypt [--passphrase-stdin]
  wim agent autostart enable [--keyring] | wim agent autostart disable | wim agent autostart status`;

/** What `wim agent` needs from the CLI. */
export type AgentCtx = {
  home: Home;
  io: CliIO;
  env: Record<string, string | undefined>;
  args: string[];
  flags: ReadonlyMap<string, string | true>;
  /** scrypt cost for `encrypt` (tests pass a small one). */
  kdfN?: number;
};

const MIN_PASSPHRASE = 8;
const PROMPT = "Passphrase for this device's keys: ";

/** The command line of `wim` itself, to start the signer as a detached child. */
export function wimCommand(): string[] {
  return [process.execPath, ...process.execArgv, process.argv[1]!];
}

/**
 * Starts `command` detached from this terminal and this process (its own session on POSIX, no
 * console window on Windows), writes `input` to its stdin, and resolves with the first line it
 * prints. The child keeps running after this process exits.
 */
export function spawnDetached(command: string[], input: string, spawn: typeof nodeSpawn = nodeSpawn): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let out = "";
    child.once("error", reject);
    // `close`, not `exit`: it comes after the child's stdout is drained, so a line the child wrote
    // just before exiting (`error <why>`) is read first rather than lost to a race.
    child.once("close", (code) => reject(new Error(`the signer exited before it was ready (code ${code})`)));
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      out += chunk;
      const nl = out.indexOf("\n");
      if (nl === -1) return;
      child.removeAllListeners("close");
      child.stdout!.destroy();
      child.unref();
      resolve(out.slice(0, nl));
    });
    // A child that exits before reading its stdin makes the write fail (EPIPE).
    child.stdin!.on("error", reject);
    child.stdin!.end(`${input}\n`);
  });
}

/** The passphrase sources other than the person's terminal, and the commands each is for. */
const SOURCES = { "passphrase-stdin": ["start", "unlock", "encrypt", "decrypt"], "ask-gui": ["start", "unlock"], keyring: ["start", "unlock", "autostart"] } as const;
type Source = keyof typeof SOURCES;

/** How many times the dialog asks again when what was typed does not open the keys. */
const GUI_TRIES = 3;

/**
 * The passphrase source a command was given other than the terminal, if any. Under an agent's
 * variables each is refused unless the person opted in with --allow-agent-passphrase: whatever
 * the agent can run can read that source too (SECURITY-MODEL 5.8). Service managers and login
 * items set no agent variable.
 */
function otherSource(ctx: AgentCtx): Source | undefined {
  const given = (Object.keys(SOURCES) as Source[]).filter((s) => ctx.flags.get(s) === true);
  if (given.length > 1) throw new SetupError(`use one of --${given.join(", --")}, not several`);
  const from = given[0];
  const agent = agentEnv(ctx.env);
  if (from === undefined || agent === undefined) return from;
  if (ctx.flags.get("allow-agent-passphrase") !== true) {
    throw new SetupError(
      `${agent} is set, so an agent is running this command, and --${from} is refused there: an agent that can reach the passphrase's source can read it and decrypt the keys, which defeats the signer. Start the signer in your own terminal, or, if you mean the agent to, add --allow-agent-passphrase (SECURITY-MODEL 5.8)`,
    );
  }
  ctx.io.err(`wim: warning: --allow-agent-passphrase: ${agent} is set, so an agent runs this command; whatever can read the passphrase's source can decrypt this device's keys, which defeats the signer's protection against agents (SECURITY-MODEL 5.8)`);
  return from;
}

function programs(ctx: AgentCtx): Programs {
  if (ctx.io.programs === undefined) throw new SetupError("this program cannot run a passphrase dialog, a keyring or a login item");
  return ctx.io.programs;
}

/** Asks in the native dialog, again (up to GUI_TRIES) while what was typed does not pass `opens`. */
async function askUntilOpens(ctx: AgentCtx, opens: ((passphrase: string) => Promise<boolean>) | undefined): Promise<string> {
  const { platform, run } = programs(ctx);
  for (let i = 0; i < GUI_TRIES; i++) {
    const passphrase = await askGui(platform, run, i === 0 ? GUI_ASK : GUI_AGAIN);
    if (opens === undefined || (await opens(passphrase))) return passphrase;
  }
  throw new SetupError(`the passphrase did not open this device's keys in ${GUI_TRIES} tries`);
}

function fromSource(ctx: AgentCtx, from: Source, opens: ((passphrase: string) => Promise<boolean>) | undefined): Promise<string> {
  if (from === "passphrase-stdin") return ctx.io.prompt("");
  if (from === "ask-gui") return askUntilOpens(ctx, opens);
  const p = programs(ctx);
  return keyringRead(p.platform, p.run, keyringAccount(ctx.home.root));
}

/** Whether `passphrase` opens the key file (the copies made to check are wiped). */
function opensFile(file: SealedKeyFile): (passphrase: string) => Promise<boolean> {
  return (passphrase) =>
    openKeyFile(file, passphrase).then(
      (u) => {
        for (const b of [u.keys.signSec, u.keys.boxSec, u.data]) b.fill(0);
        return true;
      },
      () => false,
    );
}

async function readPassphrase(ctx: AgentCtx, question: string, opens?: (passphrase: string) => Promise<boolean>): Promise<string> {
  let passphrase: string;
  const from = otherSource(ctx);
  if (from !== undefined) passphrase = await fromSource(ctx, from, opens);
  else {
    if (!canShowSecret(ctx.env, ctx.io.isTTY) || ctx.io.promptSecret === undefined) {
      throw new SetupError("the passphrase is asked for only in your own interactive terminal, not through an agent or a pipe (a service manager can pass --passphrase-stdin)");
    }
    passphrase = await ctx.io.promptSecret(question);
  }
  if (passphrase === "") throw new SetupError("no passphrase given");
  return passphrase;
}

async function sealedFile(ctx: AgentCtx): Promise<SealedKeyFile> {
  const file = await ctx.home.readKeyFile();
  if (file === undefined) throw new SetupError(`no device keys at ${ctx.home.devicePath}: run \`wim init\` first`);
  if ("plain" in file) throw new SetupError(`${ctx.home.devicePath} is not encrypted: run \`wim agent encrypt\` first`);
  return file.sealed;
}

async function endpoint(ctx: AgentCtx, create: boolean): Promise<string | undefined> {
  return agentEndpoint(ctx.home.root, ctx.home.env, create);
}

/** A client for the running signer, or undefined when none answers. */
async function running(ctx: AgentCtx): Promise<SignerClient | undefined> {
  const at = await endpoint(ctx, false);
  if (at === undefined || !(await answers(at))) return undefined;
  const file = await ctx.home.readKeyFile();
  const expect = file !== undefined && "sealed" in file ? b64u.decode(file.sealed.signPub) : undefined;
  return new SignerClient({ endpoint: at, ...(expect === undefined ? {} : { expect }) });
}

export async function agentCommand(ctx: AgentCtx): Promise<number> {
  const [action] = ctx.args;
  for (const s of Object.keys(SOURCES) as Source[]) {
    if (ctx.flags.get(s) === true && !(SOURCES[s] as readonly string[]).includes(action ?? "")) throw new SetupError(`--${s} is for wim agent ${SOURCES[s].join(", ")}`);
  }
  switch (action) {
    case "start":
      return start(ctx);
    case "serve":
      return serve(ctx);
    case "status":
      return status(ctx);
    case "lock":
    case "stop":
      return simple(ctx, action);
    case "unlock":
      return unlock(ctx);
    case "encrypt":
      return encrypt(ctx);
    case "decrypt":
      return decrypt(ctx);
    case "autostart":
      return autostart(ctx);
    default:
      throw new SetupError(`usage: ${AGENT_USAGE}`);
  }
}

/**
 * Runs the signer in this process until `stop`, Ctrl-C, a kill or its endpoint being taken. `ready`
 * is told once it listens (`ready <pid> <endpoint>`) or why it could not start. Checking for a
 * running signer and binding happen under the start lock, so two starts never both bind (the
 * second would remove the first's socket and leave it unreachable).
 */
async function runSigner(ctx: AgentCtx, passphrase: string, ready: (line: string) => void): Promise<number> {
  const file = await sealedFile(ctx);
  let unlocked;
  try {
    unlocked = await openKeyFile(file, passphrase);
  } catch (error) {
    ready(`error ${(error as Error).message}`);
    return 1;
  }
  const { root, env } = ctx.home;
  const log = new AgentLog(agentLogPath(root));
  const signer = new Signer({ file, unlocked, now: ctx.io.now, pid: ctx.io.pid, log: (e) => log.write(e) });
  let bound: { server: AgentServer; at: string };
  try {
    await ensureDir(agentDir(root));
    bound = await withLock(
      startLockPath(root),
      async () => {
        const before = await agentEndpoint(root, env, false);
        if (before !== undefined && (await answers(before))) {
          if ((await proven(before, b64u.decode(file.signPub))) !== undefined) throw new SetupError(`a signer is already running at ${before}`);
          // Not this device's signer (a squatter on a name left by a crash, or a process of the
          // user): it does not block the start. A POSIX socket file is replaced; on Windows the
          // signer takes a fresh pipe name below.
          await endpointFiles(env.platform).clear(before);
        }
        const at = (await agentEndpoint(root, env, true))!;
        const server = new AgentServer({ signer, endpoint: at, files: endpointFiles(env.platform) });
        await server.listen();
        return { server, at };
      },
      env,
    );
  } catch (error) {
    signer.lock();
    ready(`error ${(error as Error).message}`);
    return 1;
  }
  log.write({ at: ctx.io.now(), op: "start", ok: true });
  ready(`ready ${ctx.io.pid} ${bound.at}`);
  const onAbort = (): void => void bound.server.close();
  ctx.io.signal.addEventListener("abort", onAbort, { once: true });
  // Ctrl-C or a kill that came while it was starting: the event has passed, so it stops now.
  if (ctx.io.signal.aborted) onAbort();
  await bound.server.stopped;
  ctx.io.signal.removeEventListener("abort", onAbort);
  await retireEndpoint(root, env, bound.at);
  log.write({ at: ctx.io.now(), op: "exit", ok: true });
  await log.flushed();
  return 0;
}

/**
 * Whether what answers at `at` proves it is this device's signer (by its run key, which the device
 * key certified), and if so whether it is locked; undefined for anything that cannot.
 */
async function proven(at: string, expect: Uint8Array): Promise<{ locked: boolean } | undefined> {
  const client = new SignerClient({ endpoint: at, expect });
  try {
    return { locked: (await client.hello()).locked };
  } catch {
    return undefined;
  } finally {
    client.close();
  }
}

async function start(ctx: AgentCtx): Promise<number> {
  const file = await sealedFile(ctx);
  const at = await endpoint(ctx, false);
  if (at !== undefined && (await answers(at))) {
    const found = await proven(at, b64u.decode(file.signPub));
    if (found !== undefined) {
      ctx.io.out(found.locked ? `A signer is already running at ${at}, locked (verified): \`wim agent unlock\` restarts it.` : `A signer is already running at ${at} (verified: it proved it is this device's signer).`);
      return 0;
    }
    ctx.io.err(`wim: something answers at ${at} but cannot prove it is this device's signer; starting a signer in its place`);
  }
  return launch(ctx, await readPassphrase(ctx, PROMPT, opensFile(file)));
}

/** Starts the signer: in this process with --foreground, else detached. */
async function launch(ctx: AgentCtx, passphrase: string): Promise<number> {
  if (ctx.flags.get("foreground") === true) {
    let failed: string | undefined;
    const code = await runSigner(ctx, passphrase, (line) => {
      if (line.startsWith("error ")) failed = line.slice(6);
      else ctx.io.out(`Signer running in the foreground (pid ${ctx.io.pid}) at ${line.split(" ").slice(2).join(" ")}. Ctrl-C or \`wim agent stop\` stops it.`);
    });
    if (failed !== undefined) throw new SetupError(failed);
    ctx.io.out("Signer stopped.");
    return code;
  }
  if (ctx.io.startAgent === undefined) throw new SetupError("this program cannot start a background signer: use --foreground");
  const line = await ctx.io.startAgent(passphrase);
  if (!line.startsWith("ready ")) throw new SetupError(line.replace(/^error /, ""));
  const [, pid, ...at] = line.split(" ");
  ctx.io.out(`Signer started (pid ${pid}) at ${at.join(" ")}. Sessions now sign and open through it.`);
  ctx.io.out("It keeps running after you close this terminal or VS Code; it stops at log out, restart or `wim agent stop`.");
  ctx.io.out("`wim agent lock` wipes the keys from its memory. `wim agent autostart enable` starts it at each log in.");
  return 0;
}

/** The detached child of `wim agent start`: the passphrase comes on stdin, the first stdout line says how it went. */
async function serve(ctx: AgentCtx): Promise<number> {
  const passphrase = await ctx.io.prompt("");
  return runSigner(ctx, passphrase, (line) => ctx.io.out(line));
}

async function status(ctx: AgentCtx): Promise<number> {
  const file = await ctx.home.readKeyFile();
  const settings = await readAgentSettings(ctx.home.root);
  const kind = file === undefined ? "no key file" : "plain" in file ? "plaintext" : "encrypted";
  ctx.io.out(`key file: ${ctx.home.devicePath} (${kind})${settings.require_signer === true ? "; the signer is required" : ""}`);
  const client = await running(ctx);
  if (client === undefined) {
    ctx.io.out(`signer: not running. Start it with \`wim agent start\` in a terminal you opened yourself (not one an agent runs), or have it start at each log in: \`wim agent autostart enable\`.`);
    return 3;
  }
  try {
    // The answer comes sealed on the channel of a signer that proved itself; anything else fails here.
    const s = await client.call("status");
    const ops = Object.entries(s["ops"] as Record<string, number>).map(([op, n]) => `${op} ${n}`);
    ctx.io.out(`signer: running (pid ${String(s["pid"])}), ${s["locked"] === true ? "locked" : "unlocked"} (verified), device ${String(s["name"])} (${String(s["id"])})`);
    ctx.io.out(`since ${new Date(s["started"] as number).toISOString()}: ${ops.length === 0 ? "no operations" : ops.join(", ")}; refused ${String(s["refused"])}, rate limited ${String(s["limited"])}`);
    ctx.io.out(`log: ${agentLogPath(ctx.home.root)}`);
    return 0;
  } finally {
    client.close();
  }
}

/**
 * `lock` and `stop` go only to a signer that proved itself, over its channel; anything else fails
 * the command (the hello throws). `stop` is checked afterwards: the endpoint must have stopped
 * answering.
 */
async function simple(ctx: AgentCtx, action: "lock" | "stop"): Promise<number> {
  const client = await running(ctx);
  if (client === undefined) {
    ctx.io.out("No signer is running.");
    return action === "stop" ? 0 : 3;
  }
  let answer: Record<string, unknown>;
  try {
    // Always sent: the hello's own `locked` is not what this command reports.
    answer = await client.call(action);
  } finally {
    client.close();
  }
  if (action === "stop" && (await answers(client.endpoint))) {
    throw new SetupError(`something at ${client.endpoint} still answers after it was asked to stop, so it is not a signer this command trusts. End that process`);
  }
  if (action === "stop") ctx.io.out("Signer stopped.");
  else ctx.io.out(answer["was"] === true ? "The signer was locked already (verified)." : "Signer locked: the keys are wiped from its memory. `wim agent unlock` starts it again with the passphrase.");
  return 0;
}

/**
 * Unlocking is a restart. The passphrase is read here and checked against the key file in this
 * process; then the locked signer is asked to stop, and a new one is started from this command,
 * which hands the passphrase only to the signer it starts. The passphrase never goes over the
 * socket, so nothing posing as a locked signer at the endpoint can collect it, and something that
 * still answers there after `stop` is sent nothing more.
 */
async function unlock(ctx: AgentCtx): Promise<number> {
  const client = await running(ctx);
  if (client === undefined) throw new SetupError("no signer is running: `wim agent start` starts one");
  let passphrase: string;
  try {
    if (!(await client.hello()).locked) {
      ctx.io.out("The signer is not locked.");
      return 0;
    }
    const file = await sealedFile(ctx);
    passphrase = await readPassphrase(ctx, PROMPT);
    const checked = await openKeyFile(file, passphrase).catch((error: unknown) => {
      throw new SetupError((error as Error).message);
    });
    for (const b of [checked.keys.signSec, checked.keys.boxSec, checked.data]) b.fill(0);
    await client.call("stop");
  } finally {
    client.close();
  }
  // A signer stops listening before it answers `stop`.
  if (await answers(client.endpoint)) {
    throw new SetupError(`something at ${client.endpoint} still answers after it was asked to stop, so it is not a signer this command trusts; nothing was sent to it. End that process, then run \`wim agent start\``);
  }
  return launch(ctx, passphrase);
}

/** Each mesh's `prekeys.json`, rewritten entry by entry under its lock. */
async function eachPrekeyFile(home: Home, rewrite: (entry: Record<string, unknown>) => Record<string, unknown> | undefined): Promise<void> {
  for (const mesh of await home.meshIds()) {
    const path = join(home.meshDir(mesh), "prekeys.json");
    await withLock(`${path}.lock`, async () => {
      const raw = (await readJson(path).catch(() => undefined)) as { v?: unknown; keys?: unknown } | undefined;
      if (raw?.v !== 1 || !Array.isArray(raw.keys)) return;
      const keys = (raw.keys as unknown[]).flatMap((e) => {
        // An entry that is not a prekey with its secret is dropped, as the prekey store would.
        try {
          const next = rewrite({ ...(e as Record<string, unknown>), prekey: prekeySchema.parse((e as Record<string, unknown>)["prekey"]) });
          return next === undefined ? [] : [next];
        } catch {
          return [];
        }
      });
      await writeJson(path, { v: 1, keys }, home.env);
    }, home.env);
  }
}

/**
 * Encrypts the key file under a passphrase, and seals every prekey secret this device holds. The
 * key file is replaced in one atomic rename, so the device keeps its identity whatever happens; a
 * prekey left in the clear by an interruption is sealed by the signer on its next rotation.
 */
export async function encryptDevice(home: Home, passphrase: string, kdf?: { N: number; r: number; p: number }): Promise<SealedKeyFile> {
  const file = await home.readKeyFile();
  if (file === undefined) throw new SetupError(`no device keys at ${home.devicePath}: run \`wim init\` first`);
  if (!("plain" in file)) throw new SetupError(`${home.devicePath} is already encrypted`);
  const { name, keys } = file.plain;
  const data = randomBytes(32);
  const sealed = await sealKeyFile({ name, keys, passphrase, data, ...(kdf === undefined ? {} : { kdf }) });
  await writeAtomic(home.devicePath, `${JSON.stringify(sealed, null, 1)}\n`, home.env);
  await writeAgentSettings(home.root, { require_signer: true }, home.env);
  await eachPrekeyFile(home, (e) => {
    if (typeof e["secret"] !== "string") return e;
    return { prekey: e["prekey"], sealed: sealPrekeySecret(data, e["prekey"] as Prekey, b64u.decode(e["secret"])) };
  });
  keys.signSec.fill(0);
  keys.boxSec.fill(0);
  data.fill(0);
  return sealed;
}

/**
 * The way back: the key file in the clear again (version 1), with the same keys, and every sealed
 * prekey secret opened. Refused while a signer is running: stop it first.
 */
export async function decryptDevice(home: Home, passphrase: string): Promise<void> {
  const file = await home.readKeyFile();
  if (file === undefined) throw new SetupError(`no device keys at ${home.devicePath}: run \`wim init\` first`);
  if ("plain" in file) throw new SetupError(`${home.devicePath} is not encrypted`);
  const at = await agentEndpoint(home.root, home.env, false);
  if (at !== undefined && (await answers(at))) throw new SetupError("a signer is running: `wim agent stop` first");
  let unlocked;
  try {
    unlocked = await openKeyFile(file.sealed, passphrase);
  } catch (error) {
    throw error instanceof BadPassphrase ? new SetupError(error.message) : error;
  }
  const { keys, data } = unlocked;
  await eachPrekeyFile(home, (e) => {
    if (typeof e["sealed"] !== "string") return e;
    // A sealed secret that does not open is of no use to anyone: it is dropped.
    const secret = openPrekeySecret(data, e["prekey"] as Prekey, e["sealed"]);
    return secret === undefined ? undefined : { prekey: e["prekey"], secret: b64u.encode(secret) };
  });
  const encoded = JSON.parse(encodeKeys(keys)) as Record<string, unknown>;
  await writeAtomic(home.devicePath, `${JSON.stringify({ ...encoded, name: file.sealed.name })}\n`, home.env);
  await writeAgentSettings(home.root, { require_signer: false }, home.env);
  keys.signSec.fill(0);
  keys.boxSec.fill(0);
  data.fill(0);
}

async function encrypt(ctx: AgentCtx): Promise<number> {
  const file = await ctx.home.readKeyFile();
  if (file !== undefined && !("plain" in file)) throw new SetupError(`${ctx.home.devicePath} is already encrypted`);
  const passphrase = await readPassphrase(ctx, "New passphrase for this device's keys: ");
  if (passphrase.length < MIN_PASSPHRASE) throw new SetupError(`use a passphrase of at least ${MIN_PASSPHRASE} characters`);
  if (ctx.flags.get("passphrase-stdin") !== true && (await readPassphrase(ctx, "Again: ")) !== passphrase) throw new SetupError("the two passphrases differ; nothing was changed");
  await encryptDevice(ctx.home, passphrase, ctx.kdfN === undefined ? undefined : { N: ctx.kdfN, r: 8, p: 1 });
  ctx.io.out(`Encrypted ${ctx.home.devicePath}. Sessions now need the signer: run \`wim agent start\`.`);
  ctx.io.out("Without the passphrase this device's keys are gone: it would have to join its meshes again as a new device.");
  ctx.io.out("Restart running sessions so they use the signer. `wim agent decrypt` undoes this.");
  return 0;
}

async function decrypt(ctx: AgentCtx): Promise<number> {
  await sealedFile(ctx);
  const passphrase = await readPassphrase(ctx, PROMPT);
  await decryptDevice(ctx.home, passphrase);
  ctx.io.out(`Decrypted ${ctx.home.devicePath}: the keys are in the clear again, and sessions read them without a signer.`);
  return 0;
}

/** `wim agent autostart enable | disable | status`: the login item that starts the signer at each log in. */
async function autostart(ctx: AgentCtx): Promise<number> {
  const what = ctx.args[1];
  const p = programs(ctx);
  const o: AutostartOptions = { platform: p.platform, homedir: ctx.io.homedir, env: ctx.env, root: ctx.home.root, programs: p, fsEnv: { platform: ctx.io.platform, pid: ctx.io.pid } };
  if (what === "enable") return autostartEnable(ctx, o);
  if (what === "disable") {
    const removed = await disableAutostart(o);
    await keyringClear(o.platform, o.programs.run, keyringAccount(o.root));
    ctx.io.out(removed ? "Removed the login item, and any passphrase it kept in the keyring. A signer running now keeps running until `wim agent stop`." : "No login item starts the signer here.");
    return 0;
  }
  if (what !== "status") throw new SetupError("usage: wim agent autostart enable [--keyring] | wim agent autostart disable | wim agent autostart status");
  const found = await autostartStatus(o);
  if (found === undefined) {
    ctx.io.out("autostart: off. `wim agent autostart enable` starts the signer at each log in.");
    return 3;
  }
  ctx.io.out(`autostart: on (${found.source === "keyring" ? "the passphrase comes from the keyring" : "it asks for the passphrase in a dialog"}): ${found.where}`);
  return 0;
}

/**
 * Installs the login item. By default it asks for the passphrase in a native dialog at each log
 * in: the person types it into a process the login session started, not an agent's descendant.
 * With --keyring the passphrase is stored now, typed at this terminal, after the warning for the
 * platform's keyring; libsecret's needs a typed "yes".
 */
async function autostartEnable(ctx: AgentCtx, o: AutostartOptions): Promise<number> {
  const file = await sealedFile(ctx);
  const keyring = ctx.flags.get("keyring") === true;
  // Without --keyring, a passphrase an earlier `enable --keyring` stored is removed: the login
  // item no longer reads it, and kept there it would stay readable (by any process, in libsecret).
  if (keyring) await storeInKeyring(ctx, o, file);
  else await keyringClear(o.platform, o.programs.run, keyringAccount(o.root));
  const item = await enableAutostart(o, keyring ? "keyring" : "ask-gui");
  ctx.io.out(`Installed a login item: ${item.where}`);
  ctx.io.out(
    keyring
      ? "At each log in it starts the signer with the passphrase from the keyring."
      : "At each log in it starts the signer, which asks for the passphrase in a dialog of its own: typed there, it never passes through a terminal or an agent. Any passphrase kept in the keyring for it before is removed.",
  );
  ctx.io.out("It does not start a signer now (`wim agent start` does). `wim agent autostart disable` removes it.");
  return 0;
}

async function storeInKeyring(ctx: AgentCtx, o: AutostartOptions, file: SealedKeyFile): Promise<void> {
  const kind = keyringKind(o.platform);
  if (kind === undefined) throw new SetupError(NO_KEYRING);
  if (!canShowSecret(ctx.env, ctx.io.isTTY) || ctx.io.promptSecret === undefined) {
    throw new SetupError("the passphrase goes into the keyring only from your own interactive terminal, not through an agent or a pipe");
  }
  for (const line of KEYRING_WARNING[kind]) ctx.io.out(line);
  if (kind === "libsecret" && (await ctx.io.prompt("Type yes to store it anyway: ")).trim() !== "yes") throw new SetupError("nothing was stored or installed");
  const passphrase = await ctx.io.promptSecret(PROMPT);
  if (!(await opensFile(file)(passphrase))) throw new SetupError("that passphrase does not open this device's keys; nothing was stored or installed");
  await keyringStore(o.platform, o.programs.run, keyringAccount(o.root), passphrase);
  ctx.io.out("Stored the passphrase in the keyring.");
}
