// The `wim` command line. Every person-facing decision lives here: confirming a joiner's SAS,
// trusting devices, approving held messages, and the one-send `--allow-secret` override.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runGateway } from "./run-a2a.ts";
import { loadConfig as loadGatewayConfig } from "@worldinmotion/a2a";
import { loadConfig as loadBotConfig, runBot } from "@worldinmotion/bot";
import { loadConfig as loadCiConfig, runCi } from "@worldinmotion/ci";
import { isName, parseJson, sanitizeForDisplay, sessionAddressSchema, ulid, type Roster } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { basename, join as pathJoin } from "node:path";
import type { Readable, Writable } from "node:stream";
import { createMesh, decideJoin, issueInvite, joinMesh, promoteDevice, recoverMesh, revokeDevice, rotateRecovery } from "./admin.ts";
import { botIO, ciIO } from "./adapters.ts";
import { accepted, ClientError, MeshSession, unprotectedNote, type Inbound, type SessionOptions } from "./client.ts";
import { readJson, readText, tryRemove, whileBusy, writeAtomic, type FsEnv } from "./fsx.ts";
import { Home, SetupError, type Device } from "./home.ts";
import { History, renderForPerson } from "./history.ts";
import { runEvents } from "./events.ts";
import { WimMcp } from "./mcp.ts";
import { MeshFiles, RosterBook, setDevicePolicy, trustLevel } from "./mesh.ts";
import { loadNotifier, quiet, type Notifier } from "./notify.ts";
import { decideHeld, listAllHeld, resumeEverywhere } from "./offline.ts";
import { defaultHome, type Platform } from "./platform.ts";
import { isStalePeer, peerLine } from "./render.ts";
import { listSessions, SessionFiles, SessionKeys } from "./session.ts";
import type { SpoolItem } from "./spool.ts";
import { LIMITS } from "@worldinmotion/protocol";
import { agentEnv, canShowSecret, fetchHeldCode, holdForShow, showSocketPath, SHOW_WINDOW_MINUTES } from "./secretout.ts";
import { checkDialable, Link, WireError, wsDialer, type Dialer } from "./wire.ts";
import { describeInfo, fetchRelayInfo } from "./relayinfo.ts";
import { AGENT_USAGE, agentCommand } from "./agentcli.ts";

export const VERSION = "0.1.4";

/** Everything the CLI touches outside itself, so tests can run every command in-process. */
export type CliIO = {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Asks the person a question and returns the answer line. */
  prompt: (question: string) => Promise<string>;
  /** Aborted when the person stops a long-running command (Ctrl-C). */
  signal: AbortSignal;
  cwd: string;
  homedir: string;
  hostname: string;
  platform: Platform;
  uid: number | undefined;
  pid: number;
  now: () => number;
  dialer?: Dialer;
  stdin: Readable;
  stdout: Writable;
  /** Whether stdout is an interactive terminal (recovery codes are shown only there). */
  isTTY: boolean;
  /** How long `wim send` waits for a running `wim watch` to take a handed-over send (15 s). */
  handoverMs?: number;
  /** How long a command waits to be connected to the relay (15 s). */
  connectMs?: number;
  /** Asks for a passphrase without echoing it (an interactive terminal only). */
  promptSecret?: (question: string) => Promise<string>;
  /** Starts `wim agent serve` detached, hands it the passphrase, and returns its first line. */
  startAgent?: (passphrase: string) => Promise<string>;
  /** scrypt cost for `wim agent encrypt` (tests pass a small one; default 2^17). */
  agentKdfN?: number;
  /** HTTP for `wim ci` and `wim a2a`. */
  fetch: typeof fetch;
  /** True once the process that started this one is gone (`wim mcp` then ends its session). */
  parentGone: () => boolean;
  /** How often `wim mcp` checks its parent (default 5 s) and how long a clean end may take (3 s). */
  parentPollMs?: number;
  closeMs?: number;
};

type Args = { positional: string[]; flags: Map<string, string | true> };

const BOOLEAN_FLAGS = new Set(["auto", "allow-secret", "no-recovery", "relayed", "help", "version", "all", "json", "foreground", "passphrase-stdin"]);
const VALUE_FLAGS = new Set(["as", "exp", "key-env", "limit", "mesh", "name", "peer", "relay", "revoke", "session", "tls"]);

/** Flags every command takes. */
const COMMON_FLAGS = ["mesh", "help"];

/** The flags each command takes (USAGE lists them); any other flag is refused. */
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  init: ["name", "relay", "key-env", "tls", "no-recovery"],
  mesh: ["relay", "key-env", "tls", "no-recovery"],
  invite: ["exp", "auto"],
  join: ["name"],
  devices: ["relayed"],
  peers: ["all", "as"],
  send: ["allow-secret", "as"],
  watch: ["as"],
  inbox: ["as"],
  events: ["json", "as"],
  history: ["session", "peer", "limit"],
  bot: ["as"],
  ci: ["as"],
  a2a: ["as"],
  recover: ["relay", "tls", "revoke", "name"],
  agent: ["foreground", "passphrase-stdin"],
};

/**
 * `--name value`, `--name=value` and boolean `--flag` (`-h` is `--help`); everything else is
 * positional. A flag this CLI does not know takes no value, so it never swallows the next word;
 * `main` then refuses it.
 */
export function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h") {
      flags.set("help", true);
      continue;
    }
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq === -1 ? undefined : eq);
    if (eq !== -1 && BOOLEAN_FLAGS.has(name)) throw new SetupError(`--${name} takes no value`);
    if (eq !== -1) flags.set(name, a.slice(eq + 1));
    else if (!VALUE_FLAGS.has(name)) flags.set(name, true);
    else if (i + 1 < argv.length) flags.set(name, argv[++i]!);
    else throw new SetupError(`--${name} needs a value`);
  }
  return { positional, flags };
}

/** The first flag `command` does not take, as an error line with the closest one it does take. */
function unknownFlag(command: string | undefined, flags: ReadonlyMap<string, string | true>): string | undefined {
  const allowed = [...COMMON_FLAGS, ...(command === undefined ? [] : (COMMAND_FLAGS[command] ?? []))];
  const bad = [...flags.keys()].find((f) => !allowed.includes(f));
  if (bad === undefined) return undefined;
  const near = allowed.filter((f) => distance(f, bad) <= 2).sort((x, y) => distance(x, bad) - distance(y, bad))[0];
  const where = command === undefined ? "" : ` for wim ${command}`;
  return `unknown flag --${sanitizeForDisplay(bad)}${where}${near === undefined ? "" : ` (did you mean --${near}?)`}`;
}

const flag = (a: Args, name: string): string | undefined => {
  const v = a.flags.get(name);
  return typeof v === "string" ? v : undefined;
};

/** A name in the protocol's alphabet made from free text (a host name, a directory name). */
export function toName(text: string, fallback: string): string {
  const name = text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return isName(name) ? name : fallback;
}

/** `30m`, `1h`, `2d` or plain milliseconds. */
export function parseDuration(text: string): number {
  const m = /^(\d+)(ms|s|m|h|d)?$/.exec(text.trim());
  if (m === null) throw new SetupError(`not a duration: ${text} (use 30m, 1h, 2d)`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? "ms"]!;
  return Number(m[1]) * unit;
}

export const USAGE = `wim ${VERSION}: end-to-end encrypted messages between AI agent sessions

  wim init [--name <device>] [--relay <url> [--key-env NAME] [--tls <pin>] [--no-recovery]]
  wim mesh create --relay <url> [--key-env NAME] [--tls <pin>] [--no-recovery]
  wim invite [--exp 1h] [--auto]
  wim join <code> [--name <device>]
  wim devices [list | trust <name> [--relayed] | untrust <name> | revoke <name> | promote <name>]
  wim peers [--all]
  wim send <to> <text...> [--allow-secret] [--as <name>]
  wim watch [--as <name>]
  wim inbox [--as <name>]
  wim events --json [--as <name>]
  wim held [list | approve <id> | refuse <id> | resume <peer>]
  wim history [--session <name>] [--peer <address>] [--limit N]
  wim mcp
  wim bot <config.json> | wim ci <config.json> | wim a2a <config.json>
  wim recover <code> --relay <url> [--tls <pin>] [--revoke <name,...>]
  wim recovery show | wim recovery rotate
  wim doctor
  wim notify-test
  ${AGENT_USAGE}

Common: --mesh <id> (or WIM_MESH) when this device is in more than one mesh.`;

export const SHORT_USAGE = `wim ${VERSION}: end-to-end encrypted messages between AI agent sessions

Commands: init, mesh create, invite, join, devices, peers, send, watch, held, history, mcp,
bot, ci, a2a, recover, recovery show, recovery rotate, doctor, notify-test, agent.
Run \`wim help\` for all of them, or \`wim help <command>\` for one.`;

/** The usage lines for one command, or undefined when there is no such command. */
export function commandUsage(command: string): string | undefined {
  if (!/^[a-z-]+$/.test(command)) return undefined;
  // A usage line names the command at its start or after "| " (an alternative form). Plain string
  // tests, so the command is never compiled into a regular expression.
  const needle = `wim ${command}`;
  const names = (form: string) => form === needle || form.startsWith(`${needle} `);
  const lines = USAGE.split("\n").filter((l) => l.trim().split("| ").some(names));
  return lines.length === 0 ? undefined : lines.map((l) => l.trim()).join("\n");
}

/** Shared context for the commands. */
class Ctx {
  readonly home: Home;
  readonly env: Record<string, string | undefined>;
  readonly io: CliIO;
  readonly args: Args;
  readonly fsEnv: FsEnv;

  constructor(env: Record<string, string | undefined>, io: CliIO, args: Args) {
    this.env = env;
    this.io = io;
    this.args = args;
    this.fsEnv = { platform: io.platform, pid: io.pid };
    this.home = new Home(defaultHome(env, io.platform, io.homedir), { ...this.fsEnv, uid: io.uid, requireSigner: env["WIM_REQUIRE_SIGNER"] === "1" });
  }

  get dialer(): Dialer {
    return this.io.dialer ?? wsDialer;
  }

  /** The device and a mesh: `meshId` when given, else the one `--mesh`, `WIM_MESH` or the only mesh names. */
  async mesh(meshId?: string): Promise<{ device: Device; files: MeshFiles }> {
    const device = await this.home.requireDevice();
    const id = meshId ?? (await this.home.pickMesh(flag(this.args, "mesh") ?? this.env["WIM_MESH"]));
    return { device, files: new MeshFiles(this.home.meshDir(id), this.fsEnv) };
  }

  async notifier(): Promise<Notifier | undefined> {
    const n = await loadNotifier(this.home.root, this.io.now);
    return n === undefined ? undefined : quiet(n, this.io.err);
  }

  /** `verbose` sends every log line to stderr (for `wim mcp`, whose stderr is the host's MCP log). */
  async sessionOptions(name: string, kind: string, verbose = false, meshId?: string): Promise<Omit<SessionOptions, "sessionKey">> {
    const { device, files } = await this.mesh(meshId);
    const notifier = await this.notifier();
    return {
      device,
      mesh: files,
      name,
      kind,
      dialer: this.dialer,
      env: this.fsEnv,
      now: this.io.now,
      log: (line) => (verbose || this.env["WIM_DEBUG"] === "1" ? this.io.err(line) : undefined),
      debug: this.env["WIM_DEBUG"] === "1",
      cwd: this.io.cwd,
      ...(notifier === undefined ? {} : { notifier }),
    };
  }

  /**
   * A session for one command. CLI sessions keep their queue under `cli:<name>`, so the next
   * command with that name (or one taking over an earlier one's name) reads what arrived. Only
   * `wim watch` publishes a card and takes handed-over sends.
   */
  async session(name: string, opts: { keyed?: boolean; card?: boolean; handover?: boolean; mesh?: string } = {}): Promise<MeshSession> {
    const base = await this.sessionOptions(name, "cli", false, opts.mesh);
    // While another live command holds this name (a `wim watch`), a short command takes a
    // throwaway session instead of a `cli-N` that would linger: it ends for good when done.
    const ephemeral = opts.keyed !== false && (await liveWatcher(base.mesh, name, this.fsEnv)) !== undefined;
    const keyed = opts.keyed !== false && !ephemeral;
    if (keyed) await adoptByName(base.mesh, name, this.fsEnv, this.io.now);
    let last: string | undefined;
    const o: SessionOptions = {
      ...base,
      ...(opts.card === true ? {} : { cwd: undefined }),
      ...(opts.handover === true ? { handover: true } : {}),
      log: (line) => {
        if (/^wim: (connection|not reconnecting|connecting)/.test(line)) last = line.slice(5);
        base.log!(line);
      },
    };
    if (opts.card !== true) delete o.cwd;
    const s = await MeshSession.open({ ...o, ...(keyed ? { sessionKey: `cli:${name}` } : {}) });
    if (ephemeral) this.ephemeral.add(s);
    s.start();
    try {
      await s.ready(this.io.connectMs ?? 15_000);
    } catch (error) {
      await s.stop();
      // A refusal for good already says why, once.
      if (error instanceof WireError && error.code === "fatal") throw new SetupError(error.message);
      // Otherwise say what the connection last reported (a close code, a failure).
      // The connection logs "connecting" before anything else, so `last` is always set here.
      throw new SetupError(`${(error as Error).message} (${last!})`);
    }
    // Later, while a long command runs.
    s.on("fatal", (reason: string) => this.io.err(`wim: ${reason}`));
    return s;
  }

  private readonly ephemeral = new WeakSet<MeshSession>();

  /** Ends a command's session: a throwaway one for good (`bye { ended: true }`), else offline. */
  finish(s: MeshSession): Promise<void> {
    return s.stop({ ended: this.ephemeral.has(s) });
  }

  /** Waits until the person stops the command. */
  untilStopped(): Promise<void> {
    if (this.io.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => this.io.signal.addEventListener("abort", () => resolve(), { once: true }));
  }
}

/** The name for this command's session: `--as`, else `WIM_NAME`, else the command's default. */
function nameFor(ctx: Ctx, fallback: string): string {
  const as = flag(ctx.args, "as");
  if (as !== undefined && !isName(as)) throw new SetupError(`invalid name ${JSON.stringify(as)}: use 1 to 32 of a-z, 0-9 and -`);
  const env = ctx.env["WIM_NAME"];
  return as ?? (isName(env) ? env : fallback);
}

/**
 * Points `cli:<name>` at the local CLI session that holds that name, when the map does not
 * already: a later command can then take over a name an earlier one-off got (`cli-2`).
 */
async function adoptByName(mesh: MeshFiles, name: string, env: FsEnv, now: () => number): Promise<void> {
  const keys = new SessionKeys(mesh, env, now);
  const known = await keys.lookup(`cli:${name}`);
  if (known !== undefined && (await new SessionFiles(mesh, known.sid, env).load())?.name === name) return;
  for (const sid of await listSessions(mesh)) {
    const state = await new SessionFiles(mesh, sid, env).load();
    if (state?.name !== name || state.kind !== "cli" || state.ended === true) continue;
    await keys.remember(`cli:${name}`, sid, state.resume);
    return;
  }
}

/** A `wim watch` running now on this device under `name`, if any. */
async function liveWatcher(mesh: MeshFiles, name: string, env: FsEnv): Promise<SessionFiles | undefined> {
  for (const sid of await listSessions(mesh)) {
    const files = new SessionFiles(mesh, sid, env);
    const state = await files.load();
    if (state?.name === name && state.kind === "cli" && (await files.isLiveElsewhere())) return files;
  }
  return undefined;
}

/** Edit distance, for suggesting an address that exists. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** The closest live address on the same device as `to`, if there is one. */
export function closestAddress(to: string, live: readonly string[]): string | undefined {
  const at = to.indexOf("@");
  if (at < 0) return undefined;
  const same = live.filter((a) => a.slice(a.indexOf("@")) === to.slice(at));
  return same.sort((x, y) => distance(x, to) - distance(y, to))[0];
}

/** Runs one `wim` command. Returns the process exit code. */
export async function main(argv: readonly string[], env: Record<string, string | undefined>, io: CliIO): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.err((error as Error).message);
    return 2;
  }
  const [command, ...rest] = args.positional;
  if (command === undefined && args.flags.get("version") === true) {
    io.out(VERSION);
    return 0;
  }
  if (command === "help" || args.flags.get("help") === true) {
    const topic = command === "help" ? rest[0] : command;
    if (topic === undefined) {
      io.out(USAGE);
      return 0;
    }
    const usage = commandUsage(topic);
    if (usage === undefined) {
      io.err(`no command ${JSON.stringify(topic)}\n\n${SHORT_USAGE}`);
      return 2;
    }
    io.out(usage);
    return 0;
  }
  const badFlag = unknownFlag(command, args.flags);
  if (badFlag !== undefined) {
    io.err(`wim: ${badFlag}\n\n${(command === undefined ? undefined : commandUsage(command)) ?? SHORT_USAGE}`);
    return 2;
  }
  const ctx = new Ctx(env, io, { positional: rest, flags: args.flags });
  try {
    switch (command) {
      case undefined:
        io.out(SHORT_USAGE);
        return 2;
      case "version":
        io.out(VERSION);
        return 0;
      case "init":
        return await init(ctx);
      case "mesh":
        if (rest[0] !== "create") throw new SetupError("usage: wim mesh create --relay <url>");
        return await meshCreate(ctx);
      case "invite":
        return await invite(ctx);
      case "join":
        return await join(ctx);
      case "devices":
        return await devices(ctx);
      case "peers":
        return await peers(ctx);
      case "send":
        return await send(ctx);
      case "watch":
        return await watch(ctx);
      case "inbox":
        return await inbox(ctx);
      case "events":
        return await events(ctx);
      case "held":
        return await held(ctx);
      case "history":
        return await history(ctx);
      case "mcp":
        return await mcp(ctx);
      case "bot":
      case "ci":
      case "a2a":
        return await service(ctx, command);
      case "recover":
        return await recover(ctx);
      case "recovery":
        return await recovery(ctx);
      case "doctor":
        return await doctor(ctx);
      case "notify-test":
        return await notifyTest(ctx);
      case "agent":
        return await agentCommand({ home: ctx.home, io, env, args: rest, flags: args.flags, ...(io.agentKdfN === undefined ? {} : { kdfN: io.agentKdfN }) });
      default:
        io.err(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    // Errors can quote files and the relay: shown with controls made visible.
    io.err(`wim: ${sanitizeForDisplay((error as Error).message)}`);
    return 1;
  }
}

async function init(ctx: Ctx): Promise<number> {
  const name = flag(ctx.args, "name") ?? toName(ctx.io.hostname, "device");
  const device = await ctx.home.createDevice(name);
  ctx.io.out(`This device is ${device.name} (id ${device.id}). Keys are in ${ctx.home.devicePath}.`);
  if (flag(ctx.args, "relay") !== undefined) return meshCreate(ctx);
  ctx.io.out("Next: `wim mesh create --relay <url>` for a new mesh, or `wim join <code>` with an invite.");
  return 0;
}

async function meshCreate(ctx: Ctx): Promise<number> {
  const relay = flag(ctx.args, "relay");
  if (relay === undefined) throw new SetupError("--relay <url> is required");
  const keyEnv = flag(ctx.args, "key-env");
  const key = keyEnv === undefined ? undefined : ctx.env[keyEnv];
  if (keyEnv !== undefined && (key === undefined || key === "")) throw new SetupError(`${keyEnv} is not set`);
  const tls = flag(ctx.args, "tls");
  const device = await ctx.home.requireDevice();
  const made = await createMesh({
    home: ctx.home,
    device,
    relay,
    dialer: ctx.dialer,
    now: ctx.io.now,
    ...(key === undefined ? {} : { key }),
    ...(tls === undefined ? {} : { tls }),
    recovery: ctx.args.flags.get("no-recovery") !== true,
  }).catch(async (error: unknown) => {
    if (!(error instanceof ClientError)) throw error;
    // In this client's words; the relay's own text is not repeated.
    if (error.code === "full") throw new ClientError(`${CREATE_REFUSED}: this relay has reached its limit of new meshes; run your own relay (packages/relay-node) or try another`, "full");
    if (error.code !== "unauthorized") throw error;
    throw new ClientError(`${CREATE_REFUSED}: ${await withoutKey(ctx, relay, keyEnv, tls)}`, "unauthorized");
  });
  ctx.io.out(`Created mesh ${made.mesh} on ${relay}. This device is its admin.`);
  ctx.io.out("Next: `wim invite` to add another device.");
  if (made.recoveryCode !== undefined) await showRecoveryCode(ctx, made.recoveryCode);
  // After the recovery code, which exists only in memory: a slow relay here must not delay it.
  await registerCli(ctx, made.mesh);
  return 0;
}

const CREATE_REFUSED = "the relay refused to create the mesh";

/**
 * Why a relay refused `create` for lack of an accepted key, from what its `/v1/info` says: it may
 * not be accepting new meshes at all, or it wants an operator key. Without info, both.
 */
async function withoutKey(ctx: Ctx, relay: string, keyEnv: string | undefined, tlsPin: string | undefined): Promise<string> {
  const info = await fetchRelayInfo(relay, ctx.io.fetch, { tlsPin });
  if (info?.create === "closed") return "this relay is not accepting new meshes";
  const keyHint = keyEnv === undefined ? "it needs an operator key: pass it with --key-env NAME, naming the environment variable that holds the key" : `the key in $${keyEnv} was not accepted`;
  if (info?.create === "key") return keyHint;
  return `it is not accepting new meshes, or ${keyHint}`;
}

/**
 * Shows a recovery code once, only to a person at an interactive terminal (revision 4, H2).
 * Otherwise it waits in memory for `wim recovery show`, for at most LIMITS.recoveryShowWindowMs.
 */
async function showRecoveryCode(ctx: Ctx, code: string): Promise<void> {
  if (canShowSecret(ctx.env, ctx.io.isTTY)) {
    ctx.io.out("");
    ctx.io.out("Recovery code (shown once; keep it offline, it is as powerful as an admin device):");
    ctx.io.out(`  ${code}`);
    ctx.io.out("");
    return;
  }
  const why = agentEnv(ctx.env) === undefined ? "this output is not a terminal" : "an agent is running this command";
  const handed = await holdForShow(showSocketPath(ctx.home.root, ctx.io.platform), code, LIMITS.recoveryShowWindowMs, ctx.io.signal, ctx.io.platform, () => {
    ctx.io.out(`The recovery code is not shown here because ${why}.`);
    ctx.io.out(`Run \`wim recovery show\` in your own terminal within ${SHOW_WINDOW_MINUTES} minutes to see it once. It is kept in memory only.`);
    ctx.io.out("(A scripted `wim mesh create` that needs no recovery code can pass --no-recovery.)");
  });
  ctx.io.out(handed ? "The recovery code was shown." : "The recovery code was not collected and is gone; make a new one from an admin device with `wim recovery rotate`.");
}

async function recovery(ctx: Ctx): Promise<number> {
  const action = ctx.args.positional[0];
  if (action === "rotate") return recoveryRotate(ctx);
  if (action !== "show") throw new SetupError("usage: wim recovery show | wim recovery rotate");
  if (!canShowSecret(ctx.env, ctx.io.isTTY)) throw new SetupError("run this in your own interactive terminal, not through an agent or a pipe");
  const code = await fetchHeldCode(showSocketPath(ctx.home.root, ctx.io.platform));
  ctx.io.out("Recovery code (shown once; keep it offline, it is as powerful as an admin device):");
  ctx.io.out(`  ${code}`);
  return 0;
}

/** `wim recovery rotate`: an admin device replaces the recovery code; the old one stops working. */
async function recoveryRotate(ctx: Ctx): Promise<number> {
  const s = await ctx.session("admin", { keyed: false });
  try {
    const done = await rotateRecovery(s, ctx.io.now);
    ctx.io.out(`Replaced the recovery code (roster seq ${done.roster.seq}). The old code no longer works.`);
    await showRecoveryCode(ctx, done.recoveryCode);
    return 0;
  } finally {
    await s.stop({ ended: true });
  }
}

async function invite(ctx: Ctx): Promise<number> {
  const ttl = parseDuration(flag(ctx.args, "exp") ?? "1h");
  const auto = ctx.args.flags.get("auto") === true;
  const s = await ctx.session("invite", { keyed: false });
  try {
    const joins: unknown[] = [];
    let wake: (() => void) | undefined;
    s.on("join", (body: unknown) => {
      joins.push(body);
      wake?.();
    });
    const made = await issueInvite(s, { ttlMs: ttl, auto, now: ctx.io.now });
    ctx.io.out("Invite code (single use; give it to the other device over a channel you trust):");
    ctx.io.out(`  ${made.code}`);
    ctx.io.out(`It expires at ${new Date(made.exp).toISOString()}. Waiting for the device to join (Ctrl-C to stop)...`);
    for (;;) {
      if (ctx.io.signal.aborted || ctx.io.now() >= made.exp) {
        ctx.io.err("wim: the invite was not used.");
        return 1;
      }
      const body = joins.shift();
      if (body === undefined) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(done, Math.max(0, Math.min(1000, made.exp - ctx.io.now())));
          function done(): void {
            clearTimeout(t);
            wake = undefined;
            ctx.io.signal.removeEventListener("abort", done);
            resolve();
          }
          wake = done;
          ctx.io.signal.addEventListener("abort", done, { once: true });
        });
        continue;
      }
      const decision = await decideJoin(
        s,
        body as Parameters<typeof decideJoin>[1],
        async (p) => {
          ctx.io.out(`Join request: device ${p.name} (id ${p.id}), code ${p.sas}.`);
          const answer = await ctx.io.prompt("Does the joining device show the same code? [y/N] ");
          return /^y(es)?$/i.test(answer.trim());
        },
        ctx.io.now,
      );
      if (decision.outcome === "ignored") continue;
      if (decision.outcome === "admitted") {
        ctx.io.out(`Admitted ${decision.name}. To deliver its messages without holding them: wim devices trust ${decision.name}`);
        return 0;
      }
      ctx.io.err(`wim: refused the join: ${decision.reason}.`);
      if (decision.reason === "the person did not confirm") return 1;
    }
  } finally {
    await s.stop({ ended: true });
  }
}

async function join(ctx: Ctx): Promise<number> {
  const code = ctx.args.positional[0];
  if (code === undefined) throw new SetupError("usage: wim join <code>");
  const device = (await ctx.home.loadDevice()) ?? (await ctx.home.createDevice(flag(ctx.args, "name") ?? toName(ctx.io.hostname, "device")));
  const joined = await joinMesh({
    home: ctx.home,
    device,
    code,
    dialer: ctx.dialer,
    now: ctx.io.now,
    showSas: (sas) => {
      ctx.io.out(`This device is ${device.name} (id ${device.id}).`);
      ctx.io.out(`Its code is ${sas}. Check that the admin device shows the same code, then confirm there.`);
      ctx.io.out("Waiting for an admin to admit this device...");
    },
  });
  ctx.io.out(`Joined mesh ${joined.mesh}. Peers' messages are held for approval until you trust their devices: wim devices trust <name>`);
  await registerCli(ctx, joined.mesh);
  return 0;
}

/**
 * Connects this device's default CLI session (`cli`, or `WIM_NAME`) to a mesh it just created or
 * joined, then leaves it offline, not ended. A relay knows a session only once it has connected,
 * so without this a first `wim send cli@<this device>` from another device answers `unknown`
 * until this device runs `wim inbox` or `wim watch`. Now it answers `queued`, and the next
 * `wim inbox` here reads it. Like any offline session, the relay forgets it after 24 hours with
 * an empty queue. The mesh is already set up when this runs, so a failure only warns.
 */
async function registerCli(ctx: Ctx, mesh: string): Promise<void> {
  const name = nameFor(ctx, "cli");
  try {
    await ctx.finish(await ctx.session(name, { mesh }));
  } catch (error) {
    ctx.io.err(`wim: could not register ${name} with the relay (${(error as Error).message}). Until \`wim inbox\` or \`wim watch\` runs on this device, sends to ${name} here answer \`unknown\`.`);
  }
}

function deviceRows(r: Roster, config: { device: string; policy: Record<string, string> }): string[] {
  return r.devices.map((d) => {
    const policy = d.id === config.device ? "this device" : (config.policy[d.id] ?? "hold");
    return `${d.name}  ${d.role}  ${d.id}  ${policy}`;
  });
}

const DEVICE_ACTIONS = ["list", "trust", "untrust", "revoke", "promote"];

async function devices(ctx: Ctx): Promise<number> {
  const [action = "list", name] = ctx.args.positional;
  if (!DEVICE_ACTIONS.includes(action)) throw new SetupError(`unknown devices action ${JSON.stringify(action)}\n${commandUsage("devices")!}`);
  const { files } = await ctx.mesh();
  const book = await RosterBook.open(files);
  const config = await files.loadConfig();
  if (action === "list") {
    for (const line of deviceRows(book.current, config)) ctx.io.out(line);
    return 0;
  }
  if (name === undefined) throw new SetupError(`usage: wim devices ${action} <name>`);
  const target = book.current.devices.find((d) => d.name === name);
  if (target === undefined) throw new SetupError(`no device named ${name}`);
  if (action === "trust" || action === "untrust") {
    const relayed = ctx.args.flags.get("relayed") === true;
    const level = await setDevicePolicy(files, target.id, trustLevel(action, relayed));
    ctx.io.out(
      level === "hold"
        ? `Messages from ${name} are held for approval.`
        : relayed
          ? `Messages from ${name} are delivered, including text it relays from others (bots, CI, external agents).`
          : `Messages from ${name} are delivered; text it relays from others is still held.`,
    );
    return 0;
  }
  const s = await ctx.session("admin", { keyed: false });
  try {
    if (action === "revoke") {
      const r = await revokeDevice(s, name, ctx.io.now);
      ctx.io.out(`Revoked ${name}. The roster is now at seq ${r.seq}.`);
    } else {
      const r = await promoteDevice(s, name, ctx.io.now);
      ctx.io.out(`Promoted ${name} to admin. The roster is now at seq ${r.seq}.`);
    }
    return 0;
  } finally {
    await s.stop({ ended: true });
  }
}

async function peers(ctx: Ctx): Promise<number> {
  const s = await ctx.session(nameFor(ctx, "cli"));
  try {
    const all = await s.listPeers();
    const rows = ctx.args.flags.get("all") === true ? all : all.filter((p) => !isStalePeer(p, ctx.io.now()));
    if (rows.length === 0) ctx.io.out("No other sessions.");
    for (const p of rows) ctx.io.out(peerLine(p));
    const hidden = all.length - rows.length;
    if (hidden > 0) ctx.io.out(`(${hidden} long-offline session(s) without a card hidden; --all shows them)`);
    return 0;
  } finally {
    await ctx.finish(s);
  }
}

async function send(ctx: Ctx): Promise<number> {
  const [to, ...words] = ctx.args.positional;
  if (to === undefined || words.length === 0) throw new SetupError("usage: wim send <to> <text...>");
  const name = nameFor(ctx, "cli");
  const text = words.join(" ");
  // The one place the secrets check can be skipped: a person, at this command line, for one send.
  // Not an agent, and not a pipe: the same rule as showing a recovery code (SECURITY-MODEL 7.4).
  const allowSecrets = ctx.args.flags.get("allow-secret") === true;
  if (allowSecrets && !canShowSecret(ctx.env, ctx.io.isTTY)) {
    throw new SetupError("--allow-secret is only for a person at an interactive terminal, not for an agent or a pipe");
  }
  const { files } = await ctx.mesh();
  // The override is never handed over: it would travel in a file any process of this user can write.
  const watcher = allowSecrets ? undefined : await liveWatcher(files, name, ctx.fsEnv);
  let out: { id: string; results: Array<{ to: string; status: string }>; live: string[]; unprotected?: string[]; no_prekey?: string[] };
  if (watcher !== undefined) {
    // A `wim watch` holds this name: it sends, so replies come back to where the person reads.
    const answered = await handOver(ctx, watcher, { to, text });
    if (answered === undefined) {
      // Not a failure: the message may have gone out. Saying so keeps the person from resending it.
      ctx.io.out(`The running \`wim watch\` took the send but did not report back in time, so whether it went out is unknown. Check \`wim history --session ${name}\` before sending it again.`);
      return 3;
    }
    out = answered;
  } else {
    const s = await ctx.session(name);
    try {
      const sent = await s.send(to, text, allowSecrets ? { allowSecrets: true } : {});
      out = { ...sent, live: [...s.peers.values()].filter((p) => p.status !== "offline").map((p) => p.address) };
    } finally {
      // Offline, not ended: replies queue for the next `wim watch` or `wim inbox` with this name.
      await ctx.finish(s);
    }
  }
  for (const r of out.results) {
    const hint = r.status === "unknown" ? closestAddress(r.to, out.live) : undefined;
    ctx.io.out(`${r.to}: ${r.status}${hint === undefined ? "" : ` (did you mean ${hint}?)`}`);
  }
  // The migration window (SPEC section 6b): a device with no current prekey made the whole send
  // v0.1. A watch from before `no_prekey` existed reports only `unprotected`.
  if (out.unprotected !== undefined) ctx.io.out(unprotectedNote(out.unprotected, out.no_prekey ?? out.unprotected));
  ctx.io.out(`id ${out.id}`);
  return out.results.every((r) => accepted(r.status)) ? 0 : 1;
}

/**
 * Hands a send to the live watcher through its control directory and waits for its answer.
 * Undefined when the watch took the request but did not answer in time: the outcome is unknown.
 */
async function handOver(
  ctx: Ctx,
  watcher: SessionFiles,
  request: { to: string; text: string },
): Promise<{ id: string; results: Array<{ to: string; status: string }>; live: string[]; unprotected?: string[]; no_prekey?: string[] } | undefined> {
  const id = ulid(ctx.io.now());
  await writeAtomic(pathJoin(watcher.controlDir, `send-${id}.json`), JSON.stringify(request), ctx.fsEnv);
  const answerPath = pathJoin(watcher.controlDir, `send-${id}.done.json`);
  const until = Date.now() + (ctx.io.handoverMs ?? 15_000);
  for (;;) {
    const answer = (await whileBusy(() => readJson(answerPath), ctx.fsEnv.platform)) as
      | { ok: boolean; error?: string; id: string; results: Array<{ to: string; status: string }>; live?: string[]; unprotected?: string[]; no_prekey?: string[] }
      | undefined;
    if (answer !== undefined) {
      // Left for the watch to clear later if it cannot go now.
      await tryRemove(answerPath, ctx.fsEnv);
      if (!answer.ok) throw new ClientError(answer.error!, "refused");
      return { id: answer.id, results: answer.results, live: answer.live!, unprotected: answer.unprotected, no_prekey: answer.no_prekey };
    }
    if (Date.now() > until) {
      const requestPath = pathJoin(watcher.controlDir, `send-${id}.json`);
      // The watch removes the request as it takes it, so a request still there was never taken.
      // Withdrawn by removing it; one that cannot be removed is being taken just now.
      if ((await whileBusy(() => readText(requestPath), ctx.fsEnv.platform)) !== undefined && (await tryRemove(requestPath, ctx.fsEnv))) {
        throw new SetupError(
          "the running `wim watch` did not take the send. Is it still connected? A `wim watch` started before this version of wim does not take sends: restart it.",
        );
      }
      return undefined;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function watch(ctx: Ctx): Promise<number> {
  const name = nameFor(ctx, "cli");
  const { files } = await ctx.mesh();
  if ((await liveWatcher(files, name, ctx.fsEnv)) !== undefined) {
    throw new SetupError(`a \`wim watch\` is already reading as ${name} on this device; use --as <name> for another`);
  }
  const s = await ctx.session(name, { card: true, handover: true });
  const show = (item: SpoolItem): void => {
    if (item.kind === "notice") ctx.io.out(sanitizeForDisplay(item.rendered));
  };
  s.on("message", (m: Inbound) => {
    ctx.io.out(renderForPerson(m));
    void s.take(m.cursor);
  });
  s.on("item", (item: SpoolItem) => {
    show(item);
    if (item.kind === "notice") void s.take(item.cursor);
  });
  try {
    for (const item of await s.spool.unread()) ctx.io.out(sanitizeForDisplay(item.rendered));
    await s.inbox(false);
    ctx.io.out(`Watching as ${s.address} (Ctrl-C to stop).`);
    await ctx.untilStopped();
    return 0;
  } finally {
    await s.stop();
  }
}

/**
 * `wim events --json`: JSON lines for a local UI (docs/events.md). The process is a session of
 * its own, like `wim watch`: a card and its name back on restart. It takes no handed-over sends:
 * those are for `wim watch`, and the UI sends through its own requests.
 */
async function events(ctx: Ctx): Promise<number> {
  if (ctx.args.flags.get("json") !== true) throw new SetupError("usage: wim events --json [--as <name>]");
  const name = nameFor(ctx, "vscode");
  const envKind = ctx.env["WIM_KIND"];
  const o = await ctx.sessionOptions(name, isName(envKind) ? envKind : "vscode", true);
  const s = await MeshSession.open({ ...o, sessionKey: `events:${name}` });
  try {
    await runEvents({ session: s, mesh: o.mesh, env: ctx.fsEnv, device: o.device, version: VERSION, write: ctx.io.out, input: ctx.io.stdin, signal: ctx.io.signal, now: ctx.io.now });
    return 0;
  } finally {
    await s.stop();
  }
}

/** `wim inbox`: what arrived for this CLI session while nothing was watching, then marked read. */
async function inbox(ctx: Ctx): Promise<number> {
  const name = nameFor(ctx, "cli");
  const { files } = await ctx.mesh();
  if ((await liveWatcher(files, name, ctx.fsEnv)) !== undefined) {
    ctx.io.out(`A \`wim watch\` is reading as ${name} on this device: its output shows what arrives.`);
    return 0;
  }
  const s = await ctx.session(name);
  try {
    // A round trip makes the relay hand over its queue first; then let it be processed.
    await s.listPeers();
    await s.settled();
    const items = await s.inbox(false);
    if (items.length === 0) ctx.io.out(`Nothing new for ${s.address}.`);
    for (const item of items) ctx.io.out(sanitizeForDisplay(item.rendered));
    return 0;
  } finally {
    await ctx.finish(s);
  }
}

async function held(ctx: Ctx): Promise<number> {
  const [action = "list", arg] = ctx.args.positional;
  const { files } = await ctx.mesh();
  if (action === "list") {
    const rows = await listAllHeld(files, ctx.fsEnv);
    if (rows.length === 0) ctx.io.out("Nothing is held.");
    for (const r of rows) ctx.io.out(`${r.id}  ${sanitizeForDisplay(r.from)} -> ${r.session}  ${r.kind}  ${r.reason}  ${new Date(r.at).toISOString()}: ${r.preview}`);
    return 0;
  }
  if (arg === undefined) throw new SetupError(`usage: wim held ${action} <${action === "resume" ? "peer" : "id"}>`);
  if (action === "approve" || action === "refuse") {
    const n = await decideHeld(files, arg, action, ctx.fsEnv, ctx.io.now);
    if (n === 0) throw new SetupError(`no held message ${arg}`);
    ctx.io.out(`${action === "approve" ? "Approved" : "Refused"} ${arg}.`);
    return 0;
  }
  if (action === "resume") {
    if (!sessionAddressSchema.safeParse(arg).success) throw new SetupError("usage: wim held resume <name@device>");
    const n = await resumeEverywhere(files, arg, ctx.fsEnv, ctx.io.now);
    ctx.io.out(`Resumed ${arg}; released ${n} held by the breaker.`);
    return 0;
  }
  throw new SetupError(`unknown held action ${action}`);
}

async function history(ctx: Ctx): Promise<number> {
  const { files } = await ctx.mesh();
  const wanted = flag(ctx.args, "session");
  const peer = flag(ctx.args, "peer");
  const limitText = flag(ctx.args, "limit") ?? "20";
  if (!/^[1-9]\d{0,5}$/.test(limitText)) throw new SetupError("--limit must be a positive whole number");
  const limit = Number(limitText);
  let shown = 0;
  for (const sid of await listSessions(files)) {
    const sf = new SessionFiles(files, sid, ctx.fsEnv);
    const state = await sf.load();
    if (state === undefined || (wanted !== undefined && state.name !== wanted)) continue;
    const entries = await new History(sf.historyPath, ctx.io.now).query({ limit, ...(peer === undefined ? {} : { peer }) });
    if (entries.length === 0) continue;
    ctx.io.out(`== ${state.address ?? state.name} (${sid})`);
    for (const e of entries) ctx.io.out(renderForPerson(e));
    shown += entries.length;
  }
  if (shown === 0) ctx.io.out("No history.");
  return 0;
}

/** `wim mcp`: the stdio MCP server. Starts even when the device is not set up, to say so. */
async function mcp(ctx: Ctx): Promise<number> {
  const envKind = ctx.env["WIM_KIND"];
  const envName = ctx.env["WIM_NAME"];
  const kind = isName(envKind) ? envKind : "mcp";
  const name = isName(envName) ? envName : toName(basename(ctx.io.cwd), "agent");
  let session: Omit<SessionOptions, "sessionKey"> | undefined;
  let setupProblem: string | undefined;
  try {
    session = await ctx.sessionOptions(name, kind, true);
  } catch (error) {
    setupProblem = (error as Error).message;
  }
  const key = ctx.env["WIM_SESSION_KEY"];
  const server = new WimMcp({
    ...(session === undefined ? {} : { session }),
    ...(setupProblem === undefined ? {} : { setupProblem }),
    ...(key === undefined || key === "" ? {} : { sessionKey: key }),
    channel: ctx.env["WIM_CHANNEL"] === "1",
    internalTools: kind === "claude-code",
    version: VERSION,
  });
  const stdin = ctx.io.stdin;
  // The agent closing its end of stdin is how an MCP client says it is gone.
  const closed = new Promise<void>((resolve) => stdin.once("end", resolve));
  // An agent killed outright closes nothing; its child notices the parent is gone.
  let poll: NodeJS.Timeout | undefined;
  const orphaned = new Promise<void>((resolve) => {
    poll = setInterval(() => (ctx.io.parentGone() ? resolve() : undefined), ctx.io.parentPollMs ?? 5000);
  });
  await server.server.connect(new StdioServerTransport(stdin, ctx.io.stdout));
  await server.start()?.catch((error: unknown) => ctx.io.err(`wim: ${(error as Error).message}`));
  await Promise.race([closed, orphaned, ctx.untilStopped()]);
  clearInterval(poll);
  // A clean end: `bye { ended: true }` frees the name and the queue for the next session. It
  // gets a few seconds; the process exits either way.
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([server.close({ ended: true }), new Promise<void>((resolve) => (timer = setTimeout(resolve, ctx.io.closeMs ?? 3000)))]);
  clearTimeout(timer);
  return 0;
}

async function readConfig(path: string | undefined): Promise<unknown> {
  if (path === undefined) throw new SetupError("a config file path is required");
  const parsed = parseJson(await fs.readFile(path, "utf8"));
  if (!parsed.ok) throw new SetupError(`${path}: not valid JSON (${parsed.reason})`);
  return parsed.value;
}

/** `wim bot`, `wim ci` and `wim a2a`: a long-running peer on its own session. */
async function service(ctx: Ctx, which: "bot" | "ci" | "a2a"): Promise<number> {
  const raw = await readConfig(ctx.args.positional[0]);
  // Checked before connecting: a config with a typo must not announce a peer that never runs.
  const config = which === "bot" ? loadBotConfig(raw) : which === "ci" ? loadCiConfig(raw) : loadGatewayConfig(raw);
  const name = nameFor(ctx, which);
  const o = await ctx.sessionOptions(name, which === "a2a" ? "a2a" : which);
  const s = await MeshSession.open({ ...o, sessionKey: `${which}:${name}` });
  s.start();
  try {
    await s.ready(15_000);
    ctx.io.out(`${which} running as ${s.address} (Ctrl-C to stop).`);
    if (which === "bot") {
      await runBot(config as ReturnType<typeof loadBotConfig>, botIO(s), { log: ctx.io.err });
      await ctx.untilStopped();
    } else if (which === "ci") {
      await runCi(config as ReturnType<typeof loadCiConfig>, ciIO(s, ctx.io.err), { signal: ctx.io.signal, env: ctx.env, fetch: ctx.io.fetch });
    } else {
      const gw = await runGateway(config as ReturnType<typeof loadGatewayConfig>, s, ctx.env, ctx.io.err, ctx.io.fetch);
      ctx.io.out(gw.url === undefined ? "a2a outbound bridge running." : `a2a gateway listening on ${gw.url}`);
      await ctx.untilStopped();
      await gw.close();
    }
    return 0;
  } finally {
    await s.stop();
  }
}

async function recover(ctx: Ctx): Promise<number> {
  const code = ctx.args.positional[0];
  const relay = flag(ctx.args, "relay");
  if (code === undefined || relay === undefined) throw new SetupError("usage: wim recover <code> --relay <url>");
  const device = (await ctx.home.loadDevice()) ?? (await ctx.home.createDevice(flag(ctx.args, "name") ?? toName(ctx.io.hostname, "device")));
  const tls = flag(ctx.args, "tls");
  const revoke = (flag(ctx.args, "revoke") ?? "").split(",").map((x) => x.trim()).filter((x) => x !== "");
  const done = await recoverMesh({
    home: ctx.home,
    device,
    code,
    relay,
    revoke,
    dialer: ctx.dialer,
    now: ctx.io.now,
    ...(tls === undefined ? {} : { tls }),
    confirm: async (newest) => {
      ctx.io.out(`The mesh's newest roster is seq ${newest.seq}, signed ${new Date(newest.at).toISOString()}, with these devices:`);
      for (const d of newest.devices) ctx.io.out(`  ${d.name}  ${d.role}  ${d.id}`);
      ctx.io.out(newest.revoked.length === 0 ? "No device was revoked since genesis." : "Revoked since genesis:");
      // The chain runs from genesis, so every revoked id has a name in it.
      for (const d of newest.revoked) ctx.io.out(`  ${d.name}  ${d.id}`);
      ctx.io.out("If another member of the mesh is reachable, check this list with them before you sign.");
      ctx.io.out(`This will add ${device.name} as an admin${revoke.length > 0 ? `, revoke ${revoke.join(", ")}` : ""}, and replace the recovery code.`);
      return /^y(es)?$/i.test((await ctx.io.prompt("Sign this recovery roster? [y/N] ")).trim());
    },
  });
  ctx.io.out(`Recovered mesh ${done.mesh}: ${device.name} is now an admin (roster seq ${done.roster.seq}). The old recovery code no longer works.`);
  await showRecoveryCode(ctx, done.recoveryCode);
  return 0;
}

async function doctor(ctx: Ctx): Promise<number> {
  let problems = 0;
  const ok = (line: string): void => ctx.io.out(`ok       ${line}`);
  const info = (line: string): void => ctx.io.out(`info     ${line}`);
  const bad = (line: string): void => {
    problems++;
    ctx.io.out(`problem  ${line}`);
  };
  let device: Device | undefined;
  try {
    device = await ctx.home.loadDevice();
    if (device === undefined) bad(`no device keys at ${ctx.home.devicePath}: run wim init`);
    else ok(`device ${device.name} (${device.id}); ${device.keyring.kind === "signer" ? "keys held by the signer (wim agent)" : "key file permissions are private"}`);
  } catch (error) {
    bad((error as Error).message);
  }
  // The key file loaded, so the directory holding it exists.
  const rootProblem = await ctx.home.rootProblem();
  if (rootProblem === undefined) ok(`state directory ${ctx.home.root}`);
  else bad(`state directory ${ctx.home.root}: ${rootProblem}`);
  if (device === undefined) return 1;
  for (const id of await ctx.home.meshIds()) {
    const files = new MeshFiles(ctx.home.meshDir(id), ctx.fsEnv);
    const config = await files.loadConfig();
    try {
      checkDialable(config.relay, config.tls);
      const { link, hello } = await Link.open(ctx.dialer, `${config.relay}/v1/${id}`, config.tls === undefined ? {} : { tlsPin: config.tls });
      link.close();
      const skew = hello.at - ctx.io.now();
      ok(`mesh ${id}: relay ${config.relay} answers`);
      const published = await fetchRelayInfo(config.relay, ctx.io.fetch, { tlsPin: config.tls });
      for (const line of published === undefined ? ["this relay does not publish /v1/info"] : describeInfo(published)) info(`mesh ${id}: ${line}`);
      if (Math.abs(skew) > 60_000) bad(`mesh ${id}: this clock is ${Math.round(skew / 1000)} s off the relay's (auth allows 300 s; messages 600 s ahead)`);
      else ok(`mesh ${id}: clock within ${Math.round(Math.abs(skew) / 1000)} s of the relay`);
    } catch (error) {
      bad(`mesh ${id}: relay ${config.relay}: ${(error as Error).message}`);
      continue;
    }
    const before = config.pin.seq;
    try {
      const s = await MeshSession.open({ ...(await ctx.sessionOptions("doctor", "cli")), mesh: files });
      s.start();
      try {
        await s.ready(15_000);
        ok(`mesh ${id}: authenticated; roster seq ${s.roster.seq}${s.roster.seq > before ? ` (caught up from ${before})` : ""}`);
        if (s.book.fork !== undefined) bad(`mesh ${id}: the roster forked at seq ${s.book.fork.seq}`);
      } finally {
        await s.stop({ ended: true });
      }
    } catch (error) {
      bad(`mesh ${id}: ${(error as Error).message}`);
    }
  }
  return problems === 0 ? 0 : 1;
}

async function notifyTest(ctx: Ctx): Promise<number> {
  const n = await loadNotifier(ctx.home.root, ctx.io.now);
  if (n === undefined) throw new SetupError(`no notifier: write ${ctx.home.root}/notify.json as {"provider":"command","command":["<program>","<args>..."]}`);
  await n.notify("worldinmotion: test notification", true);
  ctx.io.out("Sent a test notification.");
  return 0;
}
