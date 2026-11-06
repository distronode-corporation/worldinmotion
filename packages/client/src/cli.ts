// The `wim` command line. Every person-facing decision lives here: confirming a joiner's SAS,
// trusting devices, approving held messages, and the one-send `--allow-secret` override. Each one
// is taken only from a person at an interactive terminal with no agent's variables (canConfirm).

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runGateway } from "./run-a2a.ts";
import { loadConfig as loadGatewayConfig } from "@worldinmotion/a2a";
import { loadConfig as loadBotConfig, runBot } from "@worldinmotion/bot";
import { loadConfig as loadCiConfig, runCi } from "@worldinmotion/ci";
import { isName, isRecoveryName, parseJson, sanitizeForDisplay, sessionAddressSchema, ulid, type Roster } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { basename, join as pathJoin } from "node:path";
import type { Readable, Writable } from "node:stream";
import { admitPending, createMesh, decideJoin, deleteMesh, forgetMesh, issueInvite, joinMesh, promoteDevice, recoverMesh, revokeDevice, rotateRecovery, type JoinPrompt } from "./admin.ts";
import { Invites, PendingJoins, sameCode } from "./joins.ts";
import { botIO, ciIO } from "./adapters.ts";
import { accepted, ClientError, heldSendLine, MeshSession, pauseFrom, prekeyNote, type HeldBreaker, type Inbound, type SendRow, type SessionOptions } from "./client.ts";
import { readJson, readText, tryRemove, whileBusy, writeAtomic, type FsEnv } from "./fsx.ts";
import { deviceDirs, Home, SetupError, NotReadyYet, type Device } from "./home.ts";
import { History, renderForPerson } from "./history.ts";
import { runEvents, runSetupEvents } from "./events.ts";
import { WimMcp, type Retried } from "./mcp.ts";
import { MeshFiles, RosterBook, setDevicePolicy, trustLevel, type MeshConfig, type Policy } from "./mesh.ts";
import { loadNotifier, quiet, type Notifier } from "./notify.ts";
import { decideHeld, listAllHeld, resumeEverywhere } from "./offline.ts";
import { pauseEnd, pauseRule } from "./breaker.ts";
import { listAllPauses, PausedBy } from "./pauses.ts";
import { homeChoice, type Platform } from "./platform.ts";
import { isStalePeer, peerLine, policyLevel } from "./render.ts";
import { PING, pingReport } from "./ping.ts";
import { listSessions, SessionFiles, SessionKeys } from "./session.ts";
import type { SpoolItem } from "./spool.ts";
import { LIMITS } from "@worldinmotion/protocol";
import { agentEnv, canConfirm, canShowSecret, confirmTyped, fetchHeldCode, holdForShow, notAPerson, personOnly, requirePerson, showPaths, SHOW_WINDOW_MINUTES, type ShowKind } from "./secretout.ts";
import { checkDialable, Link, UNKNOWN_MESH, WireError, wsDialer, type Dialer } from "./wire.ts";
import { describeInfo, fetchRelayInfo } from "./relayinfo.ts";
import { resolveInvite } from "./shortcode.ts";
import { AGENT_USAGE, agentCommand } from "./agentcli.ts";
import type { Programs } from "./autostart.ts";
import { CI_ACTIONS, ciCommand } from "./cicli.ts";
import { loadCiRules, pinRule, updateCiRules, type CiPins, type CiRule } from "./cirules.ts";
import { bakedDsn, CRASH_REPORTS_FILE, CrashReporter, forcedOff, readConsent } from "./crash.ts";
import { LEGACY_BOXES_FILE, legacyBoxesLine, refusesLegacy, setLegacyBoxes } from "./legacyboxes.ts";

export const VERSION = "0.1.9";

/** Everything the CLI touches outside itself, so tests can run every command in-process. */
export type CliIO = {
  out: (line: string) => void;
  /**
   * Writes one line to stdout and resolves once stdout took it: false when it could not (the
   * reader went away, as `| head` does, or stdout is closed). `out` where this is not given.
   */
  print?: (line: string) => Promise<boolean>;
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
  /** Whether stdin is one too: a confirmation is taken only from a person typing (canConfirm). */
  inputIsTTY: boolean;
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
  /** Runs another program (the login item and passphrase prompts of `wim agent`), and wim's own command line. */
  programs?: Programs;
  /** HTTP for `wim ci`, `wim a2a` and crash reports. */
  fetch: typeof fetch;
  /**
   * Hands `listener` every rejection no code was waiting for (processIo's `unhandledRejection`),
   * which a crash report may then send.
   */
  onUnexpected?: (listener: (reason: unknown) => void) => void;
  /** True once the process that started this one is gone (`wim mcp` then ends its session). */
  parentGone: () => boolean;
  /** How often `wim mcp` checks its parent (default 5 s) and how long a clean end may take (3 s). */
  parentPollMs?: number;
  /** How often `wim mcp` asks again while the device is not ready yet (default 5 s). */
  retryMs?: number;
  closeMs?: number;
};

type Args = { positional: string[]; flags: Map<string, string | true> };

const BOOLEAN_FLAGS = new Set(["auto", "full", "allow-secret", "no-recovery", "relayed", "help", "version", "all", "json", "foreground", "passphrase-stdin", "ask-gui", "keyring", "allow-agent-passphrase", "peek", "mark-read", "tag", "hold", "unprotected", "take"]);
const VALUE_FLAGS = new Set(["as", "exp", "key-env", "limit", "mesh", "name", "peer", "relay", "revoke", "session", "timeout", "tls", "wait", "ref", "workflow", "event", "environment", "recipient", "to", "text", "via"]);

/** Flags every command takes. */
const COMMON_FLAGS = ["mesh", "help"];

/** The flags each command takes (USAGE lists them); any other flag is refused. */
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  init: ["name", "relay", "key-env", "tls", "no-recovery"],
  mesh: ["relay", "key-env", "tls", "no-recovery"],
  invite: ["exp", "auto", "full"],
  join: ["name"],
  devices: ["relayed", "all"],
  peers: ["all", "as", "take"],
  send: ["allow-secret", "as", "take", "wait"],
  ping: ["all", "timeout"],
  watch: ["as", "take"],
  inbox: ["peek", "mark-read", "as", "take"],
  events: ["json", "as", "take"],
  history: ["session", "peer", "limit"],
  bot: ["as", "take"],
  ci: ["as", "take", "ref", "tag", "workflow", "event", "environment", "hold", "unprotected", "recipient", "to", "text", "via"],
  a2a: ["as", "take"],
  recover: ["relay", "tls", "revoke", "name"],
  agent: ["foreground", "passphrase-stdin", "ask-gui", "keyring", "allow-agent-passphrase"],
  "crash-reports": [],
  "legacy-boxes": [],
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
  wim mesh create --relay <url> [--key-env NAME] [--tls <pin>] [--no-recovery] | wim mesh delete
  wim invite [--exp 1h] [--auto] [--full] | wim invite show
  wim join <code> [--name <device>]
  wim devices [list | trust <name>|--all [--relayed] | untrust <name>|--all | revoke <name> | promote <name>]
  wim devices pending | wim devices admit <name> <code>
  wim peers [--all]
  wim send <to> <text...> [--allow-secret] [--as <name> [--take]] [--wait <30s>]
  wim ping <address,...> | --all [--timeout 5s]
  wim watch [--as <name> [--take]]
  wim inbox [--peek | --mark-read] [--as <name> [--take]]
  wim events --json [--as <name> [--take]]
  wim held [list | approve <id> | refuse <id> | resume <peer>]
  wim history [--session <name>] [--peer <address>] [--limit N]
  wim mcp
  wim bot <config.json> | wim ci <config.json> | wim a2a <config.json>
  wim ci allow github <owner/repo> --ref <branch> --workflow <file.yml> [--tag] [--event <name,...>] [--environment <name>] [--hold]
  wim ci allow gitlab <group/project> --ref <branch> [--tag] [--unprotected] [--environment <name>] [--hold]
  wim ci list | wim ci remove <n>
  wim ci notify --to <session> --text <text> [--recipient <wimci1_...>] [--via github|gitlab]
  wim recover <code> --relay <url> [--tls <pin>] [--revoke <name,...>]
  wim recovery show | wim recovery rotate
  wim status | wim doctor
  wim notify-test
  wim crash-reports [status | on | off]
  wim legacy-boxes [status | refuse | accept]
  ${AGENT_USAGE}

Common: --mesh <id> (or WIM_MESH) when this device is in more than one mesh.`;

export const SHORT_USAGE = `wim ${VERSION}: end-to-end encrypted messages between AI agent sessions

Commands: init, mesh create, mesh delete, invite, join, devices, peers, send, ping, watch, held,
history, mcp, bot, ci, a2a, recover, recovery show, recovery rotate, status, doctor, notify-test,
crash-reports, legacy-boxes, agent.
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
  /** Why this state directory, and the config directory whose default and profiles hold devices. */
  readonly homeWhy: string;
  readonly homeBase: string;

  constructor(env: Record<string, string | undefined>, io: CliIO, args: Args) {
    this.env = env;
    this.io = io;
    this.args = args;
    this.fsEnv = { platform: io.platform, pid: io.pid };
    const choice = homeChoice(env, io.platform, io.homedir);
    this.homeWhy = choice.why;
    this.homeBase = choice.base;
    this.home = new Home(choice.root, { ...this.fsEnv, uid: io.uid, requireSigner: env["WIM_REQUIRE_SIGNER"] === "1" });
  }

  get dialer(): Dialer {
    return this.io.dialer ?? wsDialer;
  }

  /** The device and a mesh: `meshId` when given, else the one `--mesh`, `WIM_MESH` or the only mesh names. */
  async mesh(meshId?: string): Promise<{ device: Device; files: MeshFiles }> {
    const device = await this.home.requireDevice();
    let id: string;
    try {
      id = meshId ?? (await this.home.pickMesh(flag(this.args, "mesh") ?? this.env["WIM_MESH"]));
    } catch (error) {
      // No mesh to use the device in: let go of its signer connection, which `wim mcp` would
      // otherwise open again on every retry.
      device.keyring.close();
      throw error;
    }
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
      legacyBoxesPath: pathJoin(this.home.root, LEGACY_BOXES_FILE),
      // A claim of an offline session's name is only ever asked for (design.md, taking a session back).
      ...(this.args.flags.get("take") === true || (this.env["WIM_TAKE"] === "1" && this.env["WIM_NAME"] === name) ? { take: true } : {}),
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
    const ephemeral = opts.keyed !== false && (await liveHolder(base.mesh, name, this.fsEnv)) !== undefined;
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
    if (keyed) await refuseHeldName(s, name);
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

/**
 * A CLI session under `name` that another live process runs now (a `wim watch`, a `wim send
 * --wait`, any command while it lasts) and, with `watch`, only one that takes handed-over sends:
 * a `wim watch`.
 */
async function liveHolder(mesh: MeshFiles, name: string, env: FsEnv, watch = false): Promise<SessionFiles | undefined> {
  for (const sid of await listSessions(mesh)) {
    const files = new SessionFiles(mesh, sid, env);
    const state = await files.load();
    if (state?.name === name && state.kind === "cli" && (await (watch ? files.takesHandoverElsewhere() : files.isLiveElsewhere()))) return files;
  }
  return undefined;
}

/**
 * A terminal command asked for a name that a session of another kind holds on this device (a
 * Claude Code tab, say), so the relay gave it `<name>-2`. Its messages go to that session, and a
 * `<name>-2` would only linger in peers: the throwaway registration ends at once and the command
 * is refused. A name another terminal session holds keeps today's behaviour.
 */
async function refuseHeldName(s: MeshSession, name: string): Promise<void> {
  const wanted = `${name}@${s.address.slice(s.address.indexOf("@") + 1)}`;
  const holder = s.knownPeers().find((p) => p.address === wanted && p.kind !== "cli");
  if (holder === undefined) return;
  await s.stop({ ended: true });
  throw new SetupError(
    `${wanted} is a ${holder.kind} session on this device (${holder.status}): its messages go to that session, not to a terminal. \`wim history --session ${name}\` shows what it received; for a terminal session of your own, pick another name with --as <name>.`,
  );
}

/** A `wim watch` running now on this device under `name`, if any. */
function liveWatcher(mesh: MeshFiles, name: string, env: FsEnv): Promise<SessionFiles | undefined> {
  return liveHolder(mesh, name, env, true);
}

/** Said when another command, not a watch, holds the name. */
const busyName = (name: string): string => `${name} is busy with another wim command on this device (a \`wim send --wait\`, say): try again when it ends, or use --as <name>`;

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

/** `wim ci notify`'s answer to a command line it cannot read: one line, and exit 0. */
function notifyRefused(io: CliIO, why: string): number {
  io.err(`wim ci notify: not sent: ${sanitizeForDisplay(why)}.`);
  return 0;
}

/** Runs one `wim` command. Returns the process exit code. */
export async function main(argv: readonly string[], env: Record<string, string | undefined>, io: CliIO): Promise<number> {
  // `wim ci notify` never fails the CI job it runs in, not even on a bad flag (SPEC section 18).
  const notifying = argv[0] === "ci" && argv[1] === "notify";
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (notifying) return notifyRefused(io, (error as Error).message);
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
  if (badFlag !== undefined && notifying) return notifyRefused(io, badFlag);
  if (badFlag !== undefined) {
    io.err(`wim: ${badFlag}\n\n${(command === undefined ? undefined : commandUsage(command)) ?? SHORT_USAGE}`);
    return 2;
  }
  const ctx = new Ctx(env, io, { positional: rest, flags: args.flags });
  const crash = new CrashReporter({
    dsn: bakedDsn(globalThis.__WIM_SENTRY_DSN__),
    file: pathJoin(ctx.home.root, CRASH_REPORTS_FILE),
    env,
    release: `worldinmotion@${VERSION}`,
    command: command ?? "",
    platform: io.platform,
    known: { homedir: io.homedir, hostname: io.hostname },
    fetch: io.fetch,
  });
  io.onUnexpected?.((reason) => void crash.report(reason, "unhandledRejection"));
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
        if (rest[0] === "delete") return await meshDelete(ctx);
        if (rest[0] !== "create") throw new SetupError("usage: wim mesh create --relay <url> | wim mesh delete");
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
      case "ping":
        return await ping(ctx);
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
      case "ci":
        if (CI_ACTIONS.includes(rest[0] ?? "")) return await ciCommand({ env, io, positional: rest, flags: args.flags, mesh: () => ctx.mesh() });
        return await service(ctx, command);
      case "bot":
      case "a2a":
        return await service(ctx, command);
      case "recover":
        return await recover(ctx);
      case "recovery":
        return await recovery(ctx);
      case "status":
        return await status(ctx);
      case "doctor":
        return await doctor(ctx);
      case "notify-test":
        return await notifyTest(ctx);
      case "crash-reports":
        return await crashReports(ctx, crash);
      case "legacy-boxes":
        return await legacyBoxes(ctx);
      case "agent":
        return await agentCommand({ home: ctx.home, io, env, args: rest, flags: args.flags, ...(io.agentKdfN === undefined ? {} : { kdfN: io.agentKdfN }) });
      default:
        io.err(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    // Errors can quote files and the relay: shown with controls made visible.
    io.err(`wim: ${sanitizeForDisplay((error as Error).message)}`);
    if (await crash.report(error, "command")) io.err(CRASH_SENT);
    return 1;
  }
}

/** Said after a report went out, so a person reading the error knows. */
export const CRASH_SENT = "wim: sent a crash report (the error's type, the stack and the message with paths, ids, quoted text and capitalised words removed). `wim crash-reports off` stops them.";

/** What a person turning crash reports on is told before saying yes. */
export const CRASH_REPORT_TERMS = [
  "Crash reports go to Distronode's Sentry organisation in the European Union (de.sentry.io), from",
  "any bundled wim (npm, the GitHub release, the VS Code extension, the Claude Code plugin) that uses",
  "this state directory, and only when a bug ends a command or goes uncaught, at most 5 a process. A",
  "report holds the error's type, its message with quoted text, paths, URLs, addresses, ids, keys,",
  "long numbers and capitalised words removed (lowercase words the code wrote into it stay), the",
  "stack's function and file names and line numbers, the wim version, the command name, the OS family",
  "and the Node version. It is never given your messages, files, keys, the mesh, device or session",
  "ids, or the working directory, and your user and host name are removed from it. `wim crash-reports",
  "off` stops them at once.",
];

/** `wim crash-reports`: shows, turns on (a person only, asked first) or turns off crash reports. */
async function crashReports(ctx: Ctx, crash: CrashReporter): Promise<number> {
  const action = ctx.args.positional[0] ?? "status";
  const file = pathJoin(ctx.home.root, CRASH_REPORTS_FILE);
  if (action === "off") {
    await writeAtomic(file, "off\n", ctx.fsEnv);
    ctx.io.out("Crash reports are off.");
    return 0;
  }
  if (action === "on") {
    requirePerson(ctx.env, ctx.io, "wim crash-reports on");
    if (!(await confirmTyped(ctx.io, CRASH_REPORT_TERMS, "Send crash reports?"))) return 1;
    await writeAtomic(file, "on\n", ctx.fsEnv);
    ctx.io.out("Crash reports are on. `wim crash-reports off` turns them off.");
  } else if (action !== "status") {
    throw new SetupError("usage: wim crash-reports [status | on | off]");
  } else {
    ctx.io.out(`Crash reports are ${(await readConsent(file)) === "on" ? "on" : "off"}.`);
  }
  const allowed = await crash.allowed();
  if (!allowed.ok && allowed.why === "no-address") ctx.io.out("This build of wim sends none: it runs from source, and only the bundled builds (npm, the GitHub release, the VS Code extension, the Claude Code plugin) carry the address reports go to.");
  // Named whatever else holds, so a person who set it sees that it is read.
  const off = forcedOff(ctx.env);
  if (off !== undefined) ctx.io.out(`${off} is set, so none are sent from here.`);
  return 0;
}

/** What a person turning v0.1 boxes back on is told before saying yes. */
export const LEGACY_ACCEPT_TERMS = [
  "This reopens the migration window on this device (SPEC section 6b). Until 1.0, a relay that",
  "withholds a device's prekey can then make your sends to it go without forward secrecy, and this",
  "device again reads messages sent without it. Messages to and from v0.1 clients reach them again.",
  "`wim legacy-boxes refuse` closes it again at any time.",
];

/**
 * `wim legacy-boxes`: shows the setting, refuses v0.1 boxes (anyone: it only makes the device
 * stricter), or accepts them again (a person only, asked first, since it weakens the device).
 */
async function legacyBoxes(ctx: Ctx): Promise<number> {
  const action = ctx.args.positional[0] ?? "status";
  const file = pathJoin(ctx.home.root, LEGACY_BOXES_FILE);
  if (action === "refuse") {
    await setLegacyBoxes(file, true, ctx.fsEnv);
  } else if (action === "accept") {
    requirePerson(ctx.env, ctx.io, "wim legacy-boxes accept");
    if (!(await confirmTyped(ctx.io, LEGACY_ACCEPT_TERMS, "Accept v0.1 boxes again?"))) return 1;
    await setLegacyBoxes(file, false, ctx.fsEnv);
  } else if (action !== "status") {
    throw new SetupError("usage: wim legacy-boxes [status | refuse | accept]");
  }
  const now = await refusesLegacy(file);
  ctx.io.out(`${legacyBoxesLine(now.refuse)}.`);
  if (now.problem !== undefined) ctx.io.out(`${now.problem}.`);
  return 0;
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
  // A person who stopped the command (Ctrl-C while the code waited) gets no new connection.
  if (!ctx.io.signal.aborted) await registerCli(ctx, made.mesh);
  ctx.io.out(STATUS_LINE);
  return ctx.io.signal.aborted ? STOPPED : 0;
}

/** The exit code of a command a signal stopped (Ctrl-C, a kill, the terminal closing): 128 + SIGINT, what a shell reports for Ctrl-C. */
const STOPPED = 130;

const CREATE_REFUSED = "the relay refused to create the mesh";

/** The last line of `wim init`, `wim mesh create` and `wim join`. */
const STATUS_LINE = "Check this device and its mesh at any time with `wim status`.";

/**
 * `wim mesh delete`: an admin deletes the mesh at the relay, for every device in it, and then this
 * device's copy. Only the person, at their own terminal, after reading what goes and typing yes
 * (the rule of `wim devices trust`): no MCP tool, events request or message reaches this. When the
 * relay no longer holds the mesh (an admin deleted it, or it went unused for the relay's idle
 * time), any device removes its own copy the same way.
 */
async function meshDelete(ctx: Ctx): Promise<number> {
  const extra = ["relay", "key-env", "tls", "no-recovery"].some((f) => ctx.args.flags.has(f));
  if (ctx.args.positional.length > 1 || extra) throw new SetupError("usage: wim mesh delete [--mesh <id>]");
  personHere(ctx, "wim mesh delete");
  const { files } = await ctx.mesh();
  const config = await files.loadConfig();
  const copy = `This device's copy goes too: its rosters, sessions and message history in ${files.dir}. The device keys stay.`;
  let s: MeshSession;
  try {
    s = await ctx.session("admin", { keyed: false, mesh: config.mesh });
  } catch (error) {
    if (!(error instanceof SetupError) || !error.message.includes(UNKNOWN_MESH)) throw error;
    const lines = [`The relay ${config.relay} does not hold mesh ${config.mesh}: an admin deleted it, or it went unused for the relay's idle time, or this device has the wrong relay URL.`, copy];
    if (!(await confirmed(ctx, lines, `Remove this device's copy of mesh ${config.mesh}?`))) return 1;
    await forgetMesh(ctx.home, config.mesh);
    ctx.io.out(`Removed this device's copy of mesh ${config.mesh}.`);
    return 0;
  }
  try {
    const roster = s.roster;
    if (roster.devices.find((d) => d.id === s.device.id)!.role !== "admin") throw new SetupError("only an admin device can delete the mesh, and this device is a member: ask an admin, or wait for the relay to remove the mesh once it goes unused");
    const lines = [
      `Deleting mesh ${config.mesh} on ${config.relay}, for every device in it:`,
      ...roster.devices.filter((d) => !isRecoveryName(d.name)).map((d) => `  ${d.name}  ${d.role}  ${d.id}${d.id === s.device.id ? "  this device" : ""}`),
      "The relay deletes the roster, every queued message, room history, file and lease, and closes every session. Every other device is told the mesh is gone when it next connects. There is no undo: the devices would need a new mesh and new invites.",
      copy,
    ];
    if (!(await confirmed(ctx, lines, `Delete mesh ${config.mesh}?`))) return 1;
    await deleteMesh(s);
    // Stopped at once, before the relay's close arrives, so this command does not report it.
    await s.stop();
  } finally {
    await s.stop({ ended: true });
  }
  await forgetMesh(ctx.home, config.mesh);
  ctx.io.out(`Deleted mesh ${config.mesh} at the relay, and this device's copy. On each other device, \`wim mesh delete\` removes its copy.`);
  return 0;
}

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
  // Not undefined: canShowSecret said no.
  const why = notAPerson(ctx.env, ctx.io.isTTY)!;
  const handed = await holdForShow(showPaths(ctx.home.root, ctx.io.platform), code, {
    ms: LIMITS.recoveryShowWindowMs,
    signal: ctx.io.signal,
    platform: ctx.io.platform,
    onListening: () => {
      ctx.io.out(`The recovery code is not shown here: ${why}.`);
      ctx.io.out(`Open a terminal yourself (VS Code: Terminal > New Terminal) and run \`wim recovery show\` there within ${SHOW_WINDOW_MINUTES} minutes to see it once. It is kept in memory only; keep it out of any agent's chat.`);
      ctx.io.out(`This command keeps running, for up to ${SHOW_WINDOW_MINUTES} minutes, until the code is collected: only this process holds it. If it is stopped before then, the code is gone; run \`wim recovery rotate\` on this device, in your own terminal, for a new one.`);
      ctx.io.out("(A scripted `wim mesh create` that needs no recovery code can pass --no-recovery.)");
    },
  });
  ctx.io.out(handed ? "The recovery code was shown." : "The recovery code was not collected and is gone; make a new one from an admin device with `wim recovery rotate`.");
}

async function recovery(ctx: Ctx): Promise<number> {
  const action = ctx.args.positional[0];
  if (action === "rotate") return recoveryRotate(ctx);
  if (action !== "show") throw new SetupError("usage: wim recovery show | wim recovery rotate");
  return showHeld(ctx, "recovery", ["Recovery code (shown once; keep it offline, it is as powerful as an admin device):"]);
}

/**
 * `wim recovery show` and `wim invite show`: the person, in a terminal of their own, collects a
 * code that a command run elsewhere (by an agent, or with its output piped) holds for them.
 */
async function showHeld(ctx: Ctx, kind: ShowKind, before: string[], after: string[] = []): Promise<number> {
  const notHere = notAPerson(ctx.env, ctx.io.isTTY);
  if (notHere !== undefined) throw new SetupError(personOnly(notHere, `wim ${kind} show`));
  const code = await fetchHeldCode(showPaths(ctx.home.root, ctx.io.platform, kind));
  for (const line of [...before, `  ${code}`, ...after]) ctx.io.out(line);
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

/** The person guard (`requirePerson`), shared with `wim ci allow|list|remove`. */
function personHere(ctx: Ctx, command: string): void {
  requirePerson(ctx.env, ctx.io, command);
}

/** Shows the person what they are deciding, then asks; only a typed yes is a yes (`confirmTyped`). */
function confirmed(ctx: Ctx, lines: readonly string[], question: string): Promise<boolean> {
  return confirmTyped(ctx.io, lines, question);
}

/** Why a confirmation cannot be taken here, for the error that refuses it. */
function noPerson(ctx: Ctx): string {
  return agentEnv(ctx.env) === undefined ? "this is not an interactive terminal" : "an agent is running this command";
}

/**
 * Asks the person for the comparison code the new device shows (SPEC section 5) and compares it
 * with this request's, so a person cannot confirm without reading the other screen. Three tries;
 * an empty answer refuses.
 */
async function typedCode(ctx: Ctx, p: JoinPrompt): Promise<boolean> {
  ctx.io.out(`A device named ${p.name} (id ${p.id}) asks to join.`);
  for (let tries = 0; tries < 3; tries++) {
    const typed = (await ctx.io.prompt("Type the comparison code the new device shows (Enter to refuse): ")).trim();
    if (typed === "") return false;
    if (sameCode(typed, p.sas)) return true;
    ctx.io.err("wim: that is not this request's code. Read it again on the new device.");
  }
  return false;
}

/** What a person reads above an invite code, wherever it is shown. */
const INVITE_CODE_TITLE = "Invite code (single use; give it to the other device over a channel you trust, never through an agent):";
const INVITE_JOIN_LINE = "On the new device, in a terminal: `wim join <code>`";

async function invite(ctx: Ctx): Promise<number> {
  if (ctx.args.positional[0] === "show") return showHeld(ctx, "invite", [INVITE_CODE_TITLE], [INVITE_JOIN_LINE]);
  if (ctx.args.positional.length > 0) throw new SetupError(`usage: ${commandUsage("invite")!}`);
  const ttl = parseDuration(flag(ctx.args, "exp") ?? "1h");
  const auto = ctx.args.flags.get("auto") === true;
  // Refused before an invite exists: its code would otherwise land where no person can admit with it.
  if (!auto && !canConfirm(ctx.env, ctx.io)) {
    throw new SetupError(`run \`wim invite\` in your own terminal: it asks you to type the code the new device shows, and ${noPerson(ctx)}. For an unattended device you control, \`wim invite --auto\` admits the first device that uses the code, and shows that code only in a terminal of your own`);
  }
  const s = await ctx.session("invite", { keyed: false });
  // Ends the offer of a held code when this command ends, however it ends.
  const offerEnds = new AbortController();
  let offering: Promise<void> | undefined;
  try {
    const joins: unknown[] = [];
    let wake: (() => void) | undefined;
    s.on("join", (body: unknown) => {
      joins.push(body);
      wake?.();
    });
    const full = ctx.args.flags.get("full") === true;
    const made = await issueInvite(s, { ttlMs: ttl, auto, now: ctx.io.now, short: !full });
    const until = new Date(made.exp).toISOString();
    // Why the invite cannot be used any more, once the person can no longer collect its code.
    let unusable: string | undefined;
    const code = made.short?.code ?? made.code;
    if (canShowSecret(ctx.env, ctx.io.isTTY)) {
      ctx.io.out(INVITE_CODE_TITLE);
      ctx.io.out(`  ${code}`);
      ctx.io.out(INVITE_JOIN_LINE);
    } else {
      // Only `--auto` gets here (the confirming invite needs a person): the code is a bearer
      // credential that admits a device with nobody asked, so it never goes to an agent's output.
      // It is held for the person, as a recovery code is, while the invite waits.
      const why = notAPerson(ctx.env, ctx.io.isTTY)!;
      const ms = Math.min(LIMITS.recoveryShowWindowMs, made.exp - ctx.io.now());
      offering = holdForShow(showPaths(ctx.home.root, ctx.io.platform, "invite"), code, {
        ms,
        signal: AbortSignal.any([ctx.io.signal, offerEnds.signal]),
        platform: ctx.io.platform,
        onListening: () => {
          ctx.io.out(`The invite code is not shown here: ${why}.`);
          ctx.io.out(`Open a terminal yourself (VS Code: Terminal > New Terminal) and run \`wim invite show\` there before ${new Date(ctx.io.now() + ms).toISOString()} to see it once. It is kept in memory only; give it to the new device over a channel you trust, never through an agent.`);
        },
      }).then(
        (handed) => {
          if (handed) ctx.io.out("The invite code was shown.");
          else unusable = "the invite code was not collected and is gone, so the invite cannot be used: make a new one";
        },
        (error: unknown) => {
          unusable = `the invite code could not be offered for \`wim invite show\` (${(error as Error).message}): make a new invite`;
        },
      ).then(() => wake?.());
    }
    // A short code lives at most an hour at the relay; the invite itself may live longer.
    if (made.short !== undefined && made.short.exp < made.exp) ctx.io.out(`The short code works until ${new Date(made.short.exp).toISOString()}.`);
    if (made.short !== undefined) ctx.io.out("A device on wim 0.1.4 or older needs a full code: `wim invite --full`.");
    if (made.shortRefused !== undefined) ctx.io.out(`This is the full code: no short code, because ${made.shortRefused}.`);
    ctx.io.out(`It expires at ${until}. Waiting for the device to join (Ctrl-C to stop)...`);
    for (;;) {
      if (ctx.io.signal.aborted || ctx.io.now() >= made.exp) {
        ctx.io.err(
          ctx.io.signal.aborted
            ? `wim: stopped waiting. The invite stays valid until ${until}: \`wim devices pending\` lists a device that asks to join, and \`wim devices admit <name> <code>\` admits it.`
            : "wim: the invite expired unused.",
        );
        return 1;
      }
      if (unusable !== undefined) {
        ctx.io.err(`wim: ${unusable}.`);
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
      const decision = await decideJoin(s, body as Parameters<typeof decideJoin>[1], (p) => typedCode(ctx, p), ctx.io.now);
      if (decision.outcome === "ignored") continue;
      if (decision.outcome === "admitted") {
        ctx.io.out(`Admitted ${decision.name}.`);
        // `--auto` is the unattended path: nobody is asked anything.
        await askTrust(ctx, s.mesh, s.roster.devices.filter((d) => d.name === decision.name), !auto);
        return 0;
      }
      ctx.io.err(`wim: refused the join: ${decision.reason}.`);
      if (decision.reason === "the person did not confirm") {
        // Kept nowhere: a request whose code the person would not confirm is never admitted later.
        // This session keeps requests too, after the frames before them: those go first.
        const refused = body as { invite: string; device: { id: string } };
        await s.settled();
        await new PendingJoins(s.mesh, ctx.fsEnv).remove(refused.invite, refused.device.id);
        ctx.io.err("wim: if the new device showed another code, someone else used the invite: make a new one.");
        return 1;
      }
    }
  } finally {
    offerEnds.abort();
    await offering;
    await s.stop({ ended: true });
  }
}

/**
 * "Is X your own device?" after an admit or a join: a yes trusts it (policy `deliver`), as
 * `wim devices trust` would. Asked only of a person at the terminal (canConfirm); everyone else is
 * told the command.
 */
async function askTrust(ctx: Ctx, files: MeshFiles, devices: ReadonlyArray<{ name: string; id: string }>, ask = true): Promise<void> {
  // Never empty: the device just admitted, or every device of the mesh just joined (an admin at least).
  const names = devices.map((d) => d.name);
  const one = names.length === 1;
  const list = one ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
  if (ask && canConfirm(ctx.env, ctx.io)) {
    const question = one ? `Is ${list} your own device? Trust its messages here? [y/N] ` : `Are ${list} your own devices? Trust their messages here? [y/N] `;
    if (/^y(es)?$/i.test((await ctx.io.prompt(question)).trim())) {
      for (const d of devices) await setDevicePolicy(files, d.id, "deliver");
      ctx.io.out(`Messages from ${list} are delivered here; text ${one ? "it relays" : "they relay"} from others is still held.`);
      return;
    }
  }
  ctx.io.out(`Messages from ${list} are held for your approval. If ${one ? "it is" : "they are"} your own: wim devices trust ${one ? list : "--all"}`);
}

async function join(ctx: Ctx): Promise<number> {
  const typed = ctx.args.positional[0];
  if (typed === undefined) throw new SetupError("usage: wim join <code>");
  // A short code is resolved through its relay first, so a mistyped one leaves no device behind.
  const code = await resolveInvite(typed, ctx.io.fetch);
  const device = (await ctx.home.loadDevice()) ?? (await ctx.home.createDevice(flag(ctx.args, "name") ?? toName(ctx.io.hostname, "device")));
  const joined = await joinMesh({
    home: ctx.home,
    device,
    code,
    dialer: ctx.dialer,
    now: ctx.io.now,
    showSas: (sas) => {
      ctx.io.out(`This device is ${device.name} (id ${device.id}).`);
      ctx.io.out(`Its comparison code is ${sas}. Type it on the admin device, where \`wim invite\` asks for it, or run \`wim devices admit ${device.name} ${sas}\` there.`);
      ctx.io.out("Waiting for an admin to admit this device...");
    },
  });
  ctx.io.out(`Joined mesh ${joined.mesh}.`);
  const others = joined.roster.devices.filter((d) => d.id !== device.id && !isRecoveryName(d.name));
  await askTrust(ctx, new MeshFiles(ctx.home.meshDir(joined.mesh), ctx.fsEnv), others);
  await registerCli(ctx, joined.mesh);
  ctx.io.out(STATUS_LINE);
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

const DEVICE_ACTIONS = ["list", "trust", "untrust", "revoke", "promote", "pending", "admit"];

async function devices(ctx: Ctx): Promise<number> {
  const [action = "list", name, code] = ctx.args.positional;
  if (!DEVICE_ACTIONS.includes(action)) throw new SetupError(`unknown devices action ${JSON.stringify(action)}\n${commandUsage("devices")!}`);
  if (action === "pending") return pending(ctx);
  if (action === "admit") return admit(ctx, name, code);
  const { files } = await ctx.mesh();
  const book = await RosterBook.open(files);
  const config = await files.loadConfig();
  if (action === "list") {
    for (const line of deviceRows(book.current, config)) ctx.io.out(line);
    const recovery = book.current.devices.filter((d) => isRecoveryName(d.name)).map((d) => d.name);
    if (recovery.length > 0) ctx.io.out(`(${recovery.join(", ")}: not a machine. It is the mesh's recovery code, an admin record that never connects, so nothing ever comes from it and its policy reads hold. Keep the code offline; \`wim recovery rotate\` replaces it.)`);
    return 0;
  }
  const trusting = action === "trust" || action === "untrust";
  const all = ctx.args.flags.get("all") === true;
  if (all && trusting && name === undefined) return trustAll(ctx, files, book.current, config, action);
  if (name === undefined || all) throw new SetupError(`usage: wim devices ${action} <name>${trusting ? " | --all" : ""}`);
  const target = book.current.devices.find((d) => d.name === name);
  if (target === undefined) throw new SetupError(`no device named ${name}`);
  if (trusting) {
    const relayed = ctx.args.flags.get("relayed") === true;
    const level = trustLevel(action, relayed);
    personHere(ctx, `wim devices ${action} ${name}${relayed ? " --relayed" : ""}`);
    if (!(await confirmed(ctx, trustChange([target], config, level), `${action === "trust" ? "Trust" : "Untrust"} ${name}?`))) return 1;
    ctx.io.out(trustLine(name, await setDevicePolicy(files, target.id, level), relayed));
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

function trustLine(name: string, level: string, relayed: boolean): string {
  if (level === "hold") return `Messages from ${name} are held for approval.`;
  return relayed ? `Messages from ${name} are delivered, including text it relays from others (bots, CI, external agents).` : `Messages from ${name} are delivered; text it relays from others is still held.`;
}

/** What a policy level means for the agents here, for the person deciding it. */
const LEVEL_MEANS: Readonly<Record<string, string>> = {
  deliver: "delivered to your agents as work from a device you trust; text it relays from others is still held",
  "deliver-relayed": "delivered to your agents as work from a device you trust, including text it relays from others (bots, CI, external agents)",
  hold: "held until you approve each one",
};

/**
 * The lines a person reads before a trust change: each device's name, id and role, and its policy
 * now and after. The id is the one the device itself prints as `this device` in `wim devices list`
 * (and when it joined), so the person can check it on that device's own screen.
 */
function trustChange(targets: ReadonlyArray<Roster["devices"][number]>, config: MeshConfig, level: Policy): string[] {
  const lines = targets.map((d) => `  ${d.name}  ${d.role}  id ${d.id}  policy ${policyLevel(config, d.id)} -> ${level}`);
  return [
    `Changing the inbound policy of ${targets.length === 1 ? "this device" : `these ${targets.length} devices`}:`,
    ...lines,
    `Its messages are then ${LEVEL_MEANS[level]!}.`,
    "Check each id against `wim devices list` on that device (its line says `this device`).",
    ...(level === "hold" ? [] : ["Trust only devices you would let type into your own terminal; another person's device stays at hold."]),
  ];
}

/** `wim devices trust --all` and `untrust --all`: every device but this one (recovery records never act). */
async function trustAll(ctx: Ctx, files: MeshFiles, roster: Roster, config: MeshConfig, action: "trust" | "untrust"): Promise<number> {
  const relayed = ctx.args.flags.get("relayed") === true;
  const others = roster.devices.filter((d) => d.id !== config.device && !isRecoveryName(d.name));
  if (others.length === 0) {
    ctx.io.out("No other devices in the mesh.");
    return 0;
  }
  const level = trustLevel(action, relayed);
  personHere(ctx, `wim devices ${action} --all${relayed ? " --relayed" : ""}`);
  if (!(await confirmed(ctx, trustChange(others, config, level), `${action === "trust" ? "Trust" : "Untrust"} all ${others.length}?`))) return 1;
  for (const d of others) ctx.io.out(trustLine(d.name, await setDevicePolicy(files, d.id, level), relayed));
  return 0;
}

/**
 * A short session as this device, so the relay hands over the join requests it queued while no
 * admin session was online; once the frames before an answer are handled, they are on disk.
 */
async function joinsSession(ctx: Ctx): Promise<MeshSession> {
  const s = await ctx.session("admin", { keyed: false });
  await s.listPeers();
  await s.settled();
  return s;
}

/** `wim devices pending`: the devices waiting to join, without their codes (the person types those). */
async function pending(ctx: Ctx): Promise<number> {
  const s = await joinsSession(ctx);
  try {
    const rows = await new PendingJoins(s.mesh, ctx.fsEnv).list(s.roster, new Invites(s.mesh, ctx.fsEnv, ctx.io.now), ctx.io.now());
    if (s.roster.devices.find((d) => d.id === s.device.id)!.role !== "admin") ctx.io.out("This device is not an admin, so no join requests come here.");
    else if (rows.length === 0) ctx.io.out("No device is waiting to join.");
    for (const r of rows) ctx.io.out(`${r.name}  ${r.id}  asked ${new Date(r.at).toISOString()}  invite expires ${new Date(r.exp).toISOString()}`);
    if (rows.length > 0) ctx.io.out("In your own terminal, admit one with the comparison code it shows: wim devices admit <name> <code>");
    return 0;
  } finally {
    await s.stop({ ended: true });
  }
}

/** `wim devices admit <name> <code>`: the person admits a waiting device by the code it shows. */
async function admit(ctx: Ctx, name: string | undefined, code: string | undefined): Promise<number> {
  if (name === undefined || code === undefined) throw new SetupError("usage: wim devices admit <name> <code>");
  if (!canConfirm(ctx.env, ctx.io)) throw new SetupError(`run \`wim devices admit\` in your own terminal: admitting a device is the person's decision, and ${noPerson(ctx)}`);
  const s = await joinsSession(ctx);
  try {
    const decision = await admitPending(s, name, code, ctx.io.now);
    if (decision.outcome !== "admitted") throw new SetupError(`could not admit ${name}: ${decision.reason!}`);
    ctx.io.out(`Admitted ${name}. The new device finishes joining when \`wim join\` runs there (it may be waiting already).`);
    await askTrust(ctx, s.mesh, s.roster.devices.filter((d) => d.name === name));
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

/** What `routed` and `queued` mean, said where a send's statuses are shown. Neither means read. */
export const SENT_MEANING: Readonly<Record<string, string>> = {
  routed: "handed to a live session; not yet taken or read",
  queued: "that session is offline; the relay keeps it 24 h",
  held: "that session's loop breaker holds this device's messages for now; the line below says until when",
};

/** The longest `wim send --wait`. */
export const WAIT_MAX_MS = 3_600_000;

/** One recipient's receipt for a person: what its client did with the message, never whether anyone read it. */
export function receiptLine(to: string, status: string, id: string): string {
  switch (status) {
    case "delivered":
      return `${to}: delivered (the session took it; that does not mean anyone read it)`;
    case "held":
      return `${to}: held for the approval of that device's person. It is not delivered until they approve it there: ${approveThere(id)}`;
    case "refused":
      return `${to}: refused by that device's inbound policy`;
    case "expired":
      return `${to}: expired (no session took it within 24 hours)`;
    default:
      return `${to}: ${sanitizeForDisplay(status)}`;
  }
}

/** Where the person on the receiving device approves a held message. */
const approveThere = (id: string): string => `/wim in Claude Code, the Held view in VS Code, or \`wim held approve ${id}\``;

/**
 * A `held` receipt in `wim send --wait`. With a running `pause` from that session, the hold is its
 * loop breaker's, and the line is the one a `held` send row prints (heldSendLine): a trusted
 * device's cool-down delivers by itself at its end, any other pause waits for the person. With
 * none, the message waits for the person there (an inbound policy hold).
 */
export function heldWaitLine(to: string, id: string, b: HeldBreaker | undefined): string {
  if (b === undefined) return receiptLine(to, "held", id);
  return `${heldSendLine(to, b)} Its person can approve it sooner: ${approveThere(id)}`;
}

/**
 * How long `--wait` gives a `pause` to follow a `held` receipt before it reads the hold as one
 * that waits for the person: the receiving client sends the receipt as it holds the message, and
 * the `pause` after it.
 */
export const PAUSE_GRACE_MS = 2000;

/** The receipt each address has, its last one counting (a `held` one can be followed by `delivered`). */
function lastReceipts(receipts: ReadonlyArray<{ to: string; status: string }>): Map<string, string> {
  return new Map(receipts.map((r) => [r.to, r.status]));
}

/** A receipt nothing follows. `held` is not one: the person there may approve it, and `delivered` comes then. */
const isFinal = (status: string | undefined): boolean => status !== undefined && status !== "held";

/**
 * Waits until every address in `wanted` has a final receipt, `ms` passes or the person stops the
 * command; returns the last receipt of each address that has one. `onHeld` hears of each address
 * once, the first time it is held, so the person sees why the wait goes on.
 */
async function waitForReceipts(
  ctx: Ctx,
  read: () => Promise<ReadonlyArray<{ to: string; status: string }>>,
  wanted: readonly string[],
  ms: number,
  pause: (to: string) => Promise<HeldBreaker | undefined>,
  onHeld: (to: string, b: HeldBreaker | undefined) => void,
): Promise<Map<string, string>> {
  const until = Date.now() + ms;
  const told = new Set<string>();
  const heldAt = new Map<string, number>();
  for (;;) {
    const got = lastReceipts(await read());
    for (const to of wanted.filter((a) => got.get(a) === "held" && !told.has(a))) {
      if (!heldAt.has(to)) heldAt.set(to, Date.now());
      const b = await pause(to);
      // Said once the pause is known, or once it has had time to come.
      if (b === undefined && Date.now() - heldAt.get(to)! < PAUSE_GRACE_MS) continue;
      told.add(to);
      onHeld(to, b);
    }
    if (waitedEnough(got, wanted, until, ctx.io.signal)) return got;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function waitedEnough(got: ReadonlyMap<string, string>, wanted: readonly string[], until: number, signal: AbortSignal): boolean {
  return wanted.every((to) => isFinal(got.get(to))) || Date.now() > until || signal.aborted;
}

async function send(ctx: Ctx): Promise<number> {
  const [to, ...words] = ctx.args.positional;
  if (to === undefined || words.length === 0) throw new SetupError("usage: wim send <to> <text...>");
  const name = nameFor(ctx, "cli");
  const text = words.join(" ");
  const waitText = flag(ctx.args, "wait");
  const waitMs = waitText === undefined ? undefined : parseDuration(waitText);
  if (waitMs !== undefined && (waitMs === 0 || waitMs > WAIT_MAX_MS)) throw new SetupError("--wait takes a duration from 1ms to 1h, such as 30s");
  // The one place the secrets check can be skipped: a person, at this command line, for one send.
  // Not an agent, and not a pipe: the same rule as showing a recovery code (SECURITY-MODEL 7.4).
  const allowSecrets = ctx.args.flags.get("allow-secret") === true;
  const notHere = allowSecrets ? notAPerson(ctx.env, ctx.io.isTTY) : undefined;
  if (notHere !== undefined) {
    throw new SetupError(`--allow-secret is only for a person at their own terminal: ${personOnly(notHere, `wim send ${to} <text> --allow-secret`)}`);
  }
  const { files } = await ctx.mesh();
  // The override is never handed over: it would travel in a file any process of this user can write.
  const watcher = allowSecrets ? undefined : await liveWatcher(files, name, ctx.fsEnv);
  // Offline after the command, not ended: replies queue for the next `wim watch` or `wim inbox` with this name.
  const s = watcher === undefined ? await ctx.session(name) : undefined;
  try {
    let out: SendAnswer;
    let receipts: () => Promise<ReadonlyArray<{ to: string; status: string }>>;
    if (watcher !== undefined) {
      // A `wim watch` holds this name: it sends, so replies come back to where the person reads.
      // Its receipts are recorded in its history: only what is written there after this point is read.
      const h = new History(watcher.historyPath, ctx.io.now);
      const from = await h.size();
      const answered = await handOver(ctx, watcher, { to, text });
      if (answered === undefined) {
        // Not a failure: the message may have gone out. Saying so keeps the person from resending it.
        ctx.io.out(`The running \`wim watch\` took the send but did not report back in time, so whether it went out is unknown. Check \`wim history --session ${name}\` before sending it again.`);
        return 3;
      }
      out = answered;
      receipts = () => h.receiptsFrom(answered.id, from);
    } else {
      const sent = await s!.send(to, text, allowSecrets ? { allowSecrets: true } : {});
      const live = [...s!.peers.values()].filter((p) => p.status !== "offline");
      out = { ...sent, live: live.map((p) => p.address), claude: live.filter((p) => p.kind === "claude-code").map((p) => p.address) };
      receipts = async () => s!.receipts.get(sent.id) ?? [];
    }
    for (const r of out.results) {
      const hint = r.status === "unknown" ? closestAddress(r.to, out.live) : undefined;
      const meaning = SENT_MEANING[r.status];
      ctx.io.out(`${r.to}: ${r.status}${meaning === undefined ? "" : ` (${meaning})`}${hint === undefined ? "" : ` (did you mean ${hint}?)`}`);
      if (r.status === "held") ctx.io.out(`  ${heldSendLine(r.to, r.breaker)}`);
      // Queued for a terminal inbox (cli@X) that nobody reads now, while a Claude tab on X is live:
      // the person most likely meant the tab, whose address is <folder>@X.
      if (r.status === "queued") {
        const device = r.to.slice(r.to.indexOf("@") + 1);
        const tabs = (out.claude ?? []).filter((a) => a !== r.to && a.endsWith(`@${device}`));
        if (tabs.length > 0) ctx.io.out(`  live on ${device} now: ${tabs.map((a) => `${a} (claude-code)`).join(", ")}`);
      }
    }
    // A device with no current prekey (SPEC section 6b) made the whole send v0.1 (the window), or
    // was skipped (this device refuses v0.1 boxes).
    const note = prekeyNote(out);
    if (note !== undefined) ctx.io.out(note);
    ctx.io.out(`id ${out.id}`);
    const took = out.results.filter((r) => accepted(r.status)).map((r) => r.to);
    const code = took.length === out.results.length ? 0 : 1;
    if (took.length === 0) return code;
    if (waitMs === undefined) {
      ctx.io.out("Neither routed nor queued means it was read. `wim send --wait 30s` waits for each recipient's receipt.");
      return code;
    }
    ctx.io.out(`Waiting up to ${waitText!} for receipts (Ctrl-C stops waiting; the message stays sent)...`);
    // The pauses this device was told of, by any of its sessions (a watch's included).
    const paused = new PausedBy(files.pausedByPath, ctx.fsEnv, ctx.io.now);
    const pause = async (a: string): Promise<HeldBreaker | undefined> => pauseFrom(await paused.active(), a);
    const got = await waitForReceipts(ctx, receipts, took, waitMs, pause, (a, b) => ctx.io.out(`${heldWaitLine(a, out.id, b)}. Still waiting for it to be delivered...`));
    return reportReceipts(ctx, out, took, got, code, await pausesOf(took, got, pause));
  } finally {
    if (s !== undefined) await ctx.finish(s);
  }
}

/** The running pause of each waited-for recipient still held. */
async function pausesOf(took: readonly string[], got: ReadonlyMap<string, string>, pause: (to: string) => Promise<HeldBreaker | undefined>): Promise<Map<string, HeldBreaker>> {
  const out = new Map<string, HeldBreaker>();
  for (const to of took.filter((a) => got.get(a) === "held")) {
    const b = await pause(to);
    if (b !== undefined) out.set(to, b);
  }
  return out;
}

/**
 * Prints each waited-for recipient's receipt, or what is known without one. The exit code is the
 * send's (0 when every recipient was routed or queued), or 1 when a receipt says refused or
 * expired. Still held when the wait ends is not a failure: the message waits for a person there.
 */
function reportReceipts(ctx: Ctx, out: SendAnswer, took: readonly string[], got: ReadonlyMap<string, string>, code: number, pauses: ReadonlyMap<string, HeldBreaker>): number {
  const statusOf = new Map(out.results.map((r) => [r.to, r.status]));
  for (const to of took) {
    const status = got.get(to);
    const b = pauses.get(to);
    if (status === "held" && b !== undefined) ctx.io.out(`${heldSendLine(to, b)} The wait ended first, so it is not delivered yet.`);
    else if (status === "held") ctx.io.out(`${to}: still held for the approval of that device's person when the wait ended, so not delivered yet`);
    else if (status !== undefined) ctx.io.out(receiptLine(to, status, out.id));
    else ctx.io.out(`${to}: no receipt yet (still ${statusOf.get(to)}: ${SENT_MEANING[statusOf.get(to)!]})`);
  }
  return [...got.values()].some((st) => st === "refused" || st === "expired") ? 1 : code;
}

/**
 * `wim ping`: pings sessions, each answered by the client on the other end with a pong (SPEC
 * section 12), and prints one row per session and one per device. A pong proves both directions,
 * encryption included. `--all` pings every live session on the mesh; offline sessions are not
 * pinged, so no ping waits in a queue for them.
 */
async function ping(ctx: Ctx): Promise<number> {
  const all = ctx.args.flags.get("all") === true;
  const named = ctx.args.positional[0];
  if (all === (named !== undefined)) throw new SetupError("usage: wim ping <address,...> | --all");
  const waitMs = parseDuration(flag(ctx.args, "timeout") ?? `${PING.waitMs}`);
  const s = await ctx.session("ping", { keyed: false });
  try {
    const live = (await s.listPeers()).filter((p) => p.address !== s.address);
    const offline = new Set(live.filter((p) => p.status === "offline").map((p) => p.address));
    const targets = all ? live.map((p) => p.address).filter((a) => !offline.has(a)) : MeshSession.parseTo(named!);
    if (targets.length === 0) {
      ctx.io.out("No other live sessions to ping.");
      return 0;
    }
    const asked = targets.filter((a) => !offline.has(a));
    const rows = asked.length === 0 ? [] : await s.ping(asked, waitMs);
    const report = targets.map((a) => rows.find((r) => r.to === a) ?? { to: a, status: "offline" });
    for (const line of pingReport(report, s.address, waitMs)) ctx.io.out(line);
    return report.every((r) => r.ms !== undefined) ? 0 : 1;
  } finally {
    await s.stop({ ended: true });
  }
}

/** What a send reports: `live` addresses suggest one for an unknown address; `claude` are the live Claude Code tabs. */
type SendAnswer = { id: string; results: SendRow[]; live: string[]; claude?: string[]; unprotected?: string[]; no_prekey?: string[] };

/**
 * Hands a send to the live watcher through its control directory and waits for its answer.
 * Undefined when the watch took the request but did not answer in time: the outcome is unknown.
 */
async function handOver(
  ctx: Ctx,
  watcher: SessionFiles,
  request: { to: string; text: string },
): Promise<SendAnswer | undefined> {
  const id = ulid(ctx.io.now());
  await writeAtomic(pathJoin(watcher.controlDir, `send-${id}.json`), JSON.stringify(request), ctx.fsEnv);
  const answerPath = pathJoin(watcher.controlDir, `send-${id}.done.json`);
  const until = Date.now() + (ctx.io.handoverMs ?? 15_000);
  for (;;) {
    const answer = (await whileBusy(() => readJson(answerPath), ctx.fsEnv.platform)) as
      | (SendAnswer & { ok: boolean; error?: string })
      | undefined;
    if (answer !== undefined) {
      // Left for the watch to clear later if it cannot go now.
      await tryRemove(answerPath, ctx.fsEnv);
      if (!answer.ok) throw new ClientError(answer.error!, "refused");
      // A watch from before `claude` existed names no live tabs.
      return { id: answer.id, results: answer.results, live: answer.live, claude: answer.claude, unprotected: answer.unprotected, no_prekey: answer.no_prekey };
    }
    if (Date.now() > until) {
      const requestPath = pathJoin(watcher.controlDir, `send-${id}.json`);
      // The watch removes the request as it takes it, so a request still there was never taken.
      // Withdrawn by removing it; one that cannot be removed is being taken just now.
      if ((await whileBusy(() => readText(requestPath), ctx.fsEnv.platform)) !== undefined && (await tryRemove(requestPath, ctx.fsEnv))) {
        throw new SetupError(
          "the running `wim watch` did not take the send. Is it still connected? Restart it if it is stuck.",
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
  if ((await liveHolder(files, name, ctx.fsEnv)) !== undefined) throw new SetupError(busyName(name));
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
  const agent = agentEnv(ctx.env);
  // A device in no mesh yet: the UI can join one (setup mode); any other problem is said as usual.
  if ((await ctx.home.loadDevice()) === undefined || (await ctx.home.meshIds()).length === 0) {
    const io = ctx.io;
    await runSetupEvents({ home: ctx.home, defaultName: toName(io.hostname, "device"), dialer: ctx.dialer, version: VERSION, write: io.out, input: io.stdin, signal: io.signal, now: io.now, fetch: io.fetch, ...(agent === undefined ? {} : { agent }) });
    return 0;
  }
  const o = await ctx.sessionOptions(name, isName(envKind) ? envKind : "vscode", true);
  const s = await MeshSession.open({ ...o, sessionKey: `events:${name}` });
  try {
    await runEvents({ session: s, mesh: o.mesh, env: ctx.fsEnv, device: o.device, version: VERSION, write: ctx.io.out, input: ctx.io.stdin, signal: ctx.io.signal, now: ctx.io.now, ...(agent === undefined ? {} : { agent }) });
    return 0;
  } finally {
    await s.stop();
  }
}

/**
 * `wim inbox`: what arrived for this CLI session while nothing was watching. At a terminal each
 * item is marked read once stdout took it, so what a closed output cut off stays unread. When
 * stdout is not a terminal (a pipe or a file) nothing is marked, as with `--peek`: a pipe's buffer
 * hides how much the reader took, so `wim inbox | head` could cut an item part-way and still have
 * it count as read (issue #33). `--mark-read` marks what was printed anyway.
 */
async function inbox(ctx: Ctx): Promise<number> {
  if (ctx.args.flags.get("peek") === true && ctx.args.flags.get("mark-read") === true) {
    throw new SetupError("--peek marks nothing and --mark-read marks what is printed: use one");
  }
  const name = nameFor(ctx, "cli");
  const { files } = await ctx.mesh();
  if ((await liveWatcher(files, name, ctx.fsEnv)) !== undefined) {
    ctx.io.out(`A \`wim watch\` is reading as ${name} on this device: its output shows what arrives.`);
    return 0;
  }
  if ((await liveHolder(files, name, ctx.fsEnv)) !== undefined) {
    ctx.io.out(`${busyName(name)}.`);
    return 3;
  }
  const s = await ctx.session(name);
  try {
    // A round trip makes the relay hand over its queue first; then let it be processed.
    await s.listPeers();
    await s.settled();
    return await showInbox(ctx, s, await s.inbox(true));
  } finally {
    await ctx.finish(s);
  }
}

/** The part of `wim inbox` after its awaits, kept synchronous (see printEach). */
function showInbox(ctx: Ctx, s: MeshSession, items: readonly SpoolItem[]): Promise<number> {
  if (items.length === 0) ctx.io.out(`Nothing new for ${s.address}.`);
  const print = ctx.io.print ?? ((line: string) => (ctx.io.out(line), Promise.resolve(true)));
  const peek = ctx.args.flags.get("peek") === true;
  // Not a terminal and not asked to mark: the reader's take is unknowable, so nothing is marked.
  const unmarked = !peek && !ctx.io.isTTY && ctx.args.flags.get("mark-read") !== true;
  const mark = peek || unmarked ? () => Promise.resolve() : (item: SpoolItem) => s.markRead([item]);
  return printEach(items, print, mark).then((shown) => {
    if (unmarked && items.length > 0) ctx.io.err(unmarkedLine(items.length));
    else if (shown < items.length) ctx.io.err(`wim: the output closed after ${shown} of ${items.length} items; the other ${items.length - shown} stay unread.`);
    return 0;
  });
}

/** Said when `wim inbox` wrote to something other than a terminal and so marked nothing. */
function unmarkedLine(n: number): string {
  const [items, them] = n === 1 ? ["this item stays", "it"] : [`these ${n} items stay`, "them"];
  return `wim: stdout is not a terminal, so ${items} unread (a pipe such as \`| head\` can cut one off part-way). Run \`wim inbox\` in a terminal to read and mark ${them}, or add --mark-read to mark what this run printed.`;
}

/**
 * Prints items in order, each handed to `mark` once stdout took it, and stops at the first that
 * stdout refused. Resolves to how many were printed. Kept synchronous, the branches in callbacks:
 * V8 counts a branch that follows an await in an async function by subtraction (see
 * MeshSession.publishCard).
 */
function printEach(items: readonly SpoolItem[], print: (line: string) => Promise<boolean>, mark: (item: SpoolItem) => Promise<void>): Promise<number> {
  const [first, ...rest] = items;
  if (first === undefined) return Promise.resolve(0);
  return print(sanitizeForDisplay(first.rendered)).then((took) =>
    took
      ? mark(first)
          .then(() => printEach(rest, print, mark))
          .then((n) => n + 1)
      : 0,
  );
}

async function held(ctx: Ctx): Promise<number> {
  const [action = "list", arg] = ctx.args.positional;
  const { files } = await ctx.mesh();
  if (action === "list") {
    const rows = await listAllHeld(files, ctx.fsEnv);
    // The breaker's running pauses come first: a pause holds what comes next, even when nothing is held yet.
    const pauses = await listAllPauses(files, ctx.fsEnv, ctx.io.now());
    if (rows.length === 0 && pauses.length === 0) ctx.io.out("Nothing is held.");
    for (const p of pauses) ctx.io.out(`paused  ${sanitizeForDisplay(p.from)}'s device -> ${p.session}  breaker: ${pauseRule(sanitizeForDisplay(p.from), p)}; ${pauseEnd(p)}`);
    for (const r of rows) ctx.io.out(heldLine(r));
    return 0;
  }
  if (arg === undefined) throw new SetupError(`usage: wim held ${action} <${action === "resume" ? "peer" : "id"}>`);
  if (action === "approve" || action === "refuse") {
    personHere(ctx, `wim held ${action} ${arg}`);
    const all = await listAllHeld(files, ctx.fsEnv);
    const rows = all.filter((r) => r.id === arg);
    if (rows.length === 0) throw new SetupError(`no held message ${arg}`);
    const question = action === "approve" ? `Approve it, delivering it to ${heldFor(rows)}?` : "Refuse it? It is dropped, never delivered.";
    // A CI notice held because its rule had no ids yet: approving it pins them (SPEC section 18).
    const pins = action === "approve" ? rows[0]!.ci?.pins : undefined;
    // Refused before the prompt when it cannot pin, and pinned after it on the rules as they are
    // then (another terminal may have removed or pinned the rule meanwhile).
    const rules = pins === undefined ? undefined : await loadCiRules(files.ciRulesPath);
    const refusal = rules === undefined ? undefined : pinRefusal(rules, rows[0]!.ci!.rule, pins!);
    if (refusal !== undefined) throw refusal;
    const details = heldDetails(rows, await files.loadConfig(), all, rules);
    // A peer's breaker hold also offers to resume its device: approving one item leaves the pause on.
    const resumable = action === "approve" && rows[0]!.reason === "breaker" && rows[0]!.ci === undefined;
    if (resumable) return approveOrResume(ctx, files, rows, all, details, question);
    if (!(await confirmed(ctx, details, question))) return 1;
    if (pins !== undefined) await updateCiRules(files.ciRulesPath, files.env, (now) => pinRule(now, rows[0]!.ci!.rule, pins));
    const n = await decideHeld(files, arg, action, ctx.fsEnv, ctx.io.now);
    if (n === 0) throw new SetupError(`no held message ${arg}`);
    ctx.io.out(`${action === "approve" ? "Approved" : "Refused"} ${arg}.`);
    return 0;
  }
  if (action === "resume") {
    if (!sessionAddressSchema.safeParse(arg).success) throw new SetupError("usage: wim held resume <name@device>");
    personHere(ctx, `wim held resume ${arg}`);
    const device = arg.split("@")[1];
    const paused = (await listAllHeld(files, ctx.fsEnv)).filter((r) => r.reason === "breaker" && r.from.split("@")[1] === device);
    const lines = [`Resuming ${arg} lifts the loop breaker's pause on device ${device} and releases what it held from there (${paused.length} now on disk):`, ...paused.map((r) => `  ${heldLine(r)}`)];
    if (!(await confirmed(ctx, lines, `Resume ${arg}?`))) return 1;
    const n = await resumeEverywhere(files, arg, ctx.fsEnv, ctx.io.now);
    ctx.io.out(`Resumed ${arg}; released ${n} held by the breaker.`);
    return 0;
  }
  throw new SetupError(`unknown held action ${action}`);
}

type HeldRows = Awaited<ReturnType<typeof listAllHeld>>;

/**
 * The prompt for an item the loop breaker held: approve it alone (`y`), or approve it and resume
 * its device (`resume`), which lifts the pause and releases everything else it held from there.
 * Only a typed answer acts, as for every decision here.
 */
async function approveOrResume(ctx: Ctx, files: MeshFiles, rows: HeldRows, all: HeldRows, details: readonly string[], question: string): Promise<number> {
  const r = rows[0]!;
  const device = r.from.split("@")[1]!;
  const others = all.filter((o) => o.reason === "breaker" && o.id !== r.id && o.from.split("@")[1] === device).length;
  for (const line of details) ctx.io.out(line);
  const typed = (await ctx.io.prompt(`${question} Type y to approve it, or resume to approve it and resume ${sanitizeForDisplay(r.from)} (lifting the pause on device ${device} and releasing the ${others} other${others === 1 ? "" : "s"} held from it) [y/resume/N] `)).trim();
  if (/^resume$/i.test(typed)) {
    const n = await resumeEverywhere(files, r.from, ctx.fsEnv, ctx.io.now);
    ctx.io.out(`Approved ${r.id} and resumed ${sanitizeForDisplay(r.from)}; released ${n} held by the breaker.`);
    return 0;
  }
  if (!/^y(es)?$/i.test(typed)) {
    ctx.io.err("wim: nothing changed.");
    return 1;
  }
  if ((await decideHeld(files, r.id, "approve", ctx.fsEnv, ctx.io.now)) === 0) throw new SetupError(`no held message ${r.id}`);
  ctx.io.out(`Approved ${r.id}. The breaker still pauses ${sanitizeForDisplay(r.from)}: \`wim held resume ${r.from}\` lifts it.`);
  return 0;
}

/** One held item on one line, as `wim held list` shows it. */
function heldLine(r: HeldRows[number]): string {
  const why = r.pause === undefined ? r.reason : `${r.reason} (${pauseRule(sanitizeForDisplay(r.from), r.pause)})`;
  return `${r.id}  ${sanitizeForDisplay(r.from)} -> ${r.session}  ${r.kind}  ${why}  ${new Date(r.at).toISOString()}: ${r.preview}`;
}

/** The sessions on this device that hold one item (a room message can be held by several). */
function heldFor(rows: HeldRows): string {
  return rows.map((r) => r.session).join(", ");
}

/**
 * Why `pinRule` refuses to pin, or undefined when it can. Thrown by the caller as its own
 * statement: a call that throws inside an expression leaves the coverage counter unable to
 * count the branch that follows it.
 */
function pinRefusal(rules: readonly CiRule[], ruleId: string, pins: CiPins): unknown {
  try {
    pinRule(rules, ruleId, pins);
    return undefined;
  } catch (error) {
    return error;
  }
}

/** What the person reads before approving or refusing a held item: who sent it, why it waits, its text. */
function heldDetails(rows: HeldRows, config: MeshConfig, all: HeldRows, rules: readonly CiRule[] | undefined): string[] {
  const r = rows[0]!;
  const why =
    r.reason === "breaker"
      ? `the loop breaker paused that peer${r.pause === undefined ? "" : ` on ${pauseRule(sanitizeForDisplay(r.from), r.pause)}; the pause runs ${pauseEnd(r.pause)}`}`
      : r.ci === undefined
        ? `its device's policy here is ${policyLevel(config, r.device)}`
        : r.ci.pins === undefined
          ? "its CI rule holds every notice"
          : `its CI rule has no repository ids yet; approving it pins ${Object.entries(r.ci.pins).map(([k, v]) => `${k}=${v}`).join(" ")}, and only that repository can send under the rule from then on`;
  return [
    `Held message ${r.id}:`,
    r.ci === undefined ? `  from     ${sanitizeForDisplay(r.from)} (device id ${r.device})` : `  from     ${sanitizeForDisplay(r.from)} (a CI job, information only)`,
    `  for      ${heldFor(rows)} on this device`,
    `  kind     ${r.kind}, sent ${new Date(r.at).toISOString()}`,
    `  held     because ${why}`,
    `  text     ${r.preview}`,
    ...(r.fileInfo === undefined ? [] : [`  file     ${sanitizeForDisplay(r.fileInfo.name)} (${r.fileInfo.size} bytes, fetched once approved)`]),
    ...pinCheck(r, all, rules),
  ];
}

const pinText = (pins: Record<string, string>): string => Object.entries(pins).map(([k, v]) => `${k}=${v}`).join(" ");

/**
 * For a CI notice whose approval pins its rule: every other held notice under the same rule with
 * the ids it carries, a warning when they differ (one of them is another repository that had the
 * same name), and how to read the real repository's ids from the provider.
 */
function pinCheck(r: HeldRows[number], all: HeldRows, rules: readonly CiRule[] | undefined): string[] {
  // `rules` is read only for an approval that pins, which pinRule has checked the rule exists for.
  if (rules === undefined) return [];
  const mine = pinText(r.ci!.pins!);
  // A CI notice is for one session, so each is held once.
  const others = all.filter((o) => o.id !== r.id && o.ci?.rule === r.ci!.rule && o.ci.pins !== undefined);
  const lines = others.map((o) => `  also     ${o.id} under this rule carries ${pinText(o.ci!.pins!)}`);
  const rule = rules.find((x) => x.id === r.ci!.rule)!;
  const check =
    rule.via === "github"
      ? `gh api repos/${rule.repo} --jq '.id, .owner.id'`
      : `glab api projects/${encodeURIComponent(rule.repo)} (its id and namespace.id)`;
  const differ = others.some((o) => pinText(o.ci!.pins!) !== mine);
  return [
    ...lines,
    ...(differ ? ["  WARNING  held notices under this rule carry different ids: at most one is the repository you meant, and approving pins this one's for good."] : []),
    `  check    the repository's real ids before you approve: ${check}`,
  ];
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
    const entries = await new History(sf.historyPath, ctx.io.now).query({ limit, receipts: true, ...(peer === undefined ? {} : { peer }) });
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
  // A signer that is not running or is locked, or a device the person is still setting up, clears
  // without a new session: the server asks again (every tool call, and every 5 s) instead of
  // answering "no signer is running" until the agent restarts. Any other problem stands.
  const attempt = async (): Promise<Retried> => {
    try {
      return { session: await ctx.sessionOptions(name, kind, true) };
    } catch (error) {
      return { problem: (error as Error).message, again: error instanceof NotReadyYet };
    }
  };
  const first = await attempt();
  const key = ctx.env["WIM_SESSION_KEY"];
  const server = new WimMcp({
    ...("session" in first ? { session: first.session } : { setupProblem: first.problem, ...(first.again ? { retry: attempt } : {}) }),
    stateDir: { path: ctx.home.root, why: ctx.homeWhy },
    ...(ctx.io.retryMs === undefined ? {} : { retryMs: ctx.io.retryMs }),
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
  // Offline, not ended (issue #37): a closed tab can be resumed (`claude --continue`), so the
  // relay keeps queueing for its name for 24 hours, as for any offline session, and the resumed
  // conversation takes the session back by its key with what arrived meanwhile. It gets a few
  // seconds; the process exits either way.
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([server.close(), new Promise<void>((resolve) => (timer = setTimeout(resolve, ctx.io.closeMs ?? 3000)))]);
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

/** One line of `wim doctor`: a check that passed, a fact, or a problem to fix. */
type Check = { level: "ok" | "info" | "problem"; line: string };

/** What `wim status` sums up for one mesh, from the checks `wim doctor` runs. */
type MeshSummary = { id: string; relay: string; seq?: number; devices?: number; admin?: boolean; online?: number; idleDays?: number | null };

/**
 * The checks of `wim doctor`, in order, each handed to `emit` as it is made: the state directory,
 * the device keys, and for each mesh the relay, its published limits, the clock and the roster.
 * `meshes` holds what `wim status` reports of each mesh.
 */
async function checkup(ctx: Ctx, emit: (c: Check) => void): Promise<{ device?: Device; meshes: MeshSummary[] }> {
  const meshes: MeshSummary[] = [];
  const ok = (line: string): void => emit({ level: "ok", line });
  const info = (line: string): void => emit({ level: "info", line });
  const bad = (line: string): void => emit({ level: "problem", line });
  // A terminal and an agent are the same device only when they resolve the same directory.
  info(`state directory ${ctx.home.root}: ${ctx.homeWhy}`);
  for (const dir of await deviceDirs(ctx.homeBase)) {
    if (dir !== ctx.home.root) info(`another device on this machine: ${dir} (its own keys and signer; a shell or agent that resolves it is not this device)`);
  }
  let device: Device | undefined;
  try {
    device = await ctx.home.loadDevice();
    if (device === undefined) bad(`not set up yet, no device keys at ${ctx.home.devicePath}: run \`wim init\`, or \`wim join <code>\` with an invite`);
    else ok(`device ${device.name} (${device.id}); ${device.keyring.kind === "signer" ? "keys held by the signer (wim agent)" : "key file permissions are private"}`);
  } catch (error) {
    bad((error as Error).message);
  }
  // A directory that does not exist yet is the device not set up, the problem above.
  const rootProblem = await ctx.home.rootProblem();
  if (rootProblem === undefined) ok(`state directory ${ctx.home.root}`);
  else if (rootProblem !== null) bad(`state directory ${ctx.home.root}: ${rootProblem}`);
  if (device === undefined) return { meshes };
  const legacy = await refusesLegacy(pathJoin(ctx.home.root, LEGACY_BOXES_FILE));
  info(legacyBoxesLine(legacy.refuse));
  if (legacy.problem !== undefined) bad(legacy.problem);
  const me = device.id;
  for (const id of await ctx.home.meshIds()) {
    const files = new MeshFiles(ctx.home.meshDir(id), ctx.fsEnv);
    const config = await files.loadConfig();
    const summary: MeshSummary = { id, relay: config.relay };
    meshes.push(summary);
    try {
      checkDialable(config.relay, config.tls);
      const { link, hello } = await Link.open(ctx.dialer, `${config.relay}/v1/${id}`, config.tls === undefined ? {} : { tlsPin: config.tls });
      link.close();
      const skew = hello.at - ctx.io.now();
      ok(`mesh ${id}: relay ${config.relay} answers`);
      const published = await fetchRelayInfo(config.relay, ctx.io.fetch, { tlsPin: config.tls });
      if (published !== undefined) summary.idleDays = published.limits.idle_mesh_days;
      for (const line of published === undefined ? ["this relay does not publish /v1/info"] : describeInfo(published)) info(`mesh ${id}: ${line}`);
      if (Math.abs(skew) > 60_000) bad(`mesh ${id}: this clock is ${Math.round(skew / 1000)} s off the relay's (auth allows 300 s; messages 600 s ahead)`);
      else ok(`mesh ${id}: clock within ${Math.round(Math.abs(skew) / 1000)} s of the relay`);
    } catch (error) {
      bad(`mesh ${id}: relay ${config.relay}: ${(error as Error).message}`);
      continue;
    }
    const before = config.pin.seq;
    try {
      // This mesh's id: with no id the session needs WIM_MESH or the only mesh, and a device in
      // several would have every one refused.
      const s = await MeshSession.open({ ...(await ctx.sessionOptions("doctor", "cli", false, id)), mesh: files });
      s.start();
      try {
        await s.ready(15_000);
        ok(`mesh ${id}: authenticated; roster seq ${s.roster.seq}${s.roster.seq > before ? ` (caught up from ${before})` : ""}`);
        if (s.book.fork !== undefined) bad(`mesh ${id}: the roster forked at seq ${s.book.fork.seq}`);
        summary.seq = s.roster.seq;
        summary.devices = s.roster.devices.filter((d) => !isRecoveryName(d.name)).length;
        summary.admin = s.roster.devices.some((d) => d.id === me && d.role === "admin");
        summary.online = s.knownPeers().filter((p) => p.status !== "offline").length;
      } finally {
        await s.stop({ ended: true });
      }
    } catch (error) {
      bad(`mesh ${id}: ${(error as Error).message}`);
    }
  }
  return { device, meshes };
}

async function doctor(ctx: Ctx): Promise<number> {
  let problems = 0;
  // Each line as it is checked, so what was found before a check that throws is still shown.
  await checkup(ctx, (c) => {
    if (c.level === "problem") problems++;
    ctx.io.out(`${c.level.padEnd(8)} ${c.line}`);
  });
  // No device keys is always one of the problems.
  return problems === 0 ? 0 : 1;
}

/**
 * `wim status`: the summary of `wim doctor`, for a person checking a new setup. Problems first, in
 * full, then the device and each mesh in a few lines, with the next step where there is one.
 */
async function status(ctx: Ctx): Promise<number> {
  const problems: Check[] = [];
  const { device, meshes } = await checkup(ctx, (c) => void (c.level === "problem" && problems.push(c)));
  for (const c of problems) ctx.io.out(`problem  ${c.line}`);
  if (device !== undefined) {
    ctx.io.out(`This device is ${device.name} (id ${device.id}).`);
    ctx.io.out(`${legacyBoxesLine((await refusesLegacy(pathJoin(ctx.home.root, LEGACY_BOXES_FILE))).refuse)}.`);
    if (meshes.length === 0) ctx.io.out("It is in no mesh yet: `wim mesh create --relay <url>` makes one, or `wim join <code>` joins one with an invite.");
    for (const m of meshes) for (const line of meshStatus(m)) ctx.io.out(line);
  }
  ctx.io.out(problems.length === 0 ? "Everything checks out. `wim doctor` shows each check." : `Problems: ${problems.length}, above. \`wim doctor\` shows each check.`);
  return problems.length === 0 ? 0 : 1;
}

/** The lines `wim status` prints for one mesh. */
function meshStatus(m: MeshSummary): string[] {
  const head = `Mesh ${m.id} on ${m.relay}:`;
  if (m.seq === undefined) return [head, "  not connected: the problem above says why."];
  const others = m.devices! - 1;
  return [
    head,
    `  connected as ${m.admin! ? "an admin" : "a member"}; roster seq ${m.seq}; other devices: ${others}; other sessions online now: ${m.online!}.`,
    ...(others === 0 ? ["  Next: `wim invite` adds another device. Until one joins, `wim peers` shows no other sessions, which is expected."] : []),
    `  ${idleLine(m.idleDays)} An admin can delete it sooner: \`wim mesh delete\`.`,
  ];
}

/** What the relay's `/v1/info` says about meshes nobody uses. */
function idleLine(days: number | null | undefined): string {
  if (days === undefined) return "The relay does not say how long it keeps a mesh nobody uses.";
  return days === null ? "The relay keeps a mesh nobody uses." : `The relay deletes it after ${days} days with no device connected.`;
}

async function notifyTest(ctx: Ctx): Promise<number> {
  const n = await loadNotifier(ctx.home.root, ctx.io.now);
  if (n === undefined) throw new SetupError(`no notifier: write ${ctx.home.root}/notify.json as {"provider":"command","command":["<program>","<args>..."]}`);
  await n.notify("worldinmotion: test notification", true);
  ctx.io.out("Sent a test notification.");
  return 0;
}
