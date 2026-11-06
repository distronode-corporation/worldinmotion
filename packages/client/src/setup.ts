// `wim setup`: the guided first run on one machine (README, Quick start). It makes the device and
// a mesh with this device as its admin, shows the recovery code, offers the Claude Code plugin and
// the VS Code extension when their command lines are installed, and ends with `wim status`. On a
// device that is set up already it skips what is done and repeats the rest.
//
// Only a person runs it: `requirePerson` comes before anything else, on every path, and every step
// that changes something waits for a typed y. It never asks about crash reports (README, Crash
// reports: nothing asks you to) and never starts the signer.

import { HOSTED_RELAY, isName, sanitizeForDisplay } from "@worldinmotion/protocol";
import { execFile as nodeExecFile } from "node:child_process";
import type { RunResult } from "./autostart.ts";
import { SetupError, type Home } from "./home.ts";
import { MeshFiles, RosterBook } from "./mesh.ts";
import type { Platform } from "./platform.ts";
import { describeInfo, fetchRelayInfo, type InfoFetcher } from "./relayinfo.ts";
import { requirePerson } from "./secretout.ts";
import { checkDialable } from "./wire.ts";

/** Asked after a recovery code is shown, by `wim setup` and `wim recovery show --wait`. */
export const STORED_PROMPT = "Press Enter once you have stored it. ";

/** The title above a recovery code, wherever it is shown. */
export const RECOVERY_TITLE = "Recovery code (shown once; keep it offline, it is as powerful as an admin device):";

/** Where the hosted relay's terms are. */
export const HOSTED_TERMS = "https://github.com/distronode-corporation/worldinmotion/blob/main/docs/hosted-relay.md";

/** The plugin's id and the commands that install it, in a terminal and in a Claude chat. */
const PLUGIN = "worldinmotion@worldinmotion";
const MARKETPLACE = "distronode-corporation/worldinmotion";
const MARKETPLACE_ADD = ["plugin", "marketplace", "add", MARKETPLACE];
const PLUGIN_INSTALL = ["plugin", "install", PLUGIN];

/** The VS Code extension and the command that installs it (a pre-release only until 1.0). */
const EXTENSION = "distronode.worldinmotion";
const EXTENSION_INSTALL = ["--install-extension", EXTENSION, "--pre-release"];

/** The commands `wim setup` runs once the person says y, as the README gives them. */
export const SETUP_COMMANDS = [`claude ${MARKETPLACE_ADD.join(" ")}`, `claude ${PLUGIN_INSTALL.join(" ")}`, `code ${EXTENSION_INSTALL.join(" ")}`];

/**
 * Runs another program with fixed arguments, without a shell, and gives its exit code and output.
 * It rejects with an `ENOENT` error when the program is not installed.
 */
export type ToolRun = (cmd: string, args: readonly string[]) => Promise<RunResult>;

/** The part of `child_process.execFile` the runner uses. */
type ExecFile = (
  file: string,
  args: readonly string[],
  options: { shell: boolean; windowsHide: boolean; timeout: number; maxBuffer: number },
  callback: (error: (Error & { code?: unknown }) | null, stdout: string, stderr: string) => void,
) => { stdin: { end(): void } | null };

/** How long one install may take. */
const TOOL_TIMEOUT_MS = 5 * 60_000;

/**
 * The real runner: `execFile`, with no shell. On Windows `claude` and `code` are usually `.cmd`
 * files, which Node runs only through a shell, so there the program is looked up with `where`
 * first (a missing one is ENOENT, as elsewhere) and then run with `shell: true`. Every argument
 * is one of the constants in this file, never text from a person or a peer.
 */
export function execRunner(platform: Platform, execFile: ExecFile = nodeExecFile as unknown as ExecFile): ToolRun {
  const exec = (file: string, args: readonly string[], shell: boolean): Promise<RunResult> =>
    new Promise((resolve, reject) => {
      const child = execFile(file, args, { shell, windowsHide: true, timeout: TOOL_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") reject(error);
        else resolve({ code: error === null ? 0 : (error.code as number), stdout, stderr });
      });
      // Nothing is typed into a tool: one that asks a question reads end of input.
      child.stdin?.end();
    });
  if (platform !== "win32") return (cmd, args) => exec(cmd, args, false);
  return async (cmd, args) => {
    if ((await exec("where", [cmd], false)).code !== 0) throw Object.assign(new Error(`${cmd} is not installed`), { code: "ENOENT" });
    return exec(cmd, args, true);
  };
}

/** What `wim setup` needs from the command line around it (cli.ts). */
export type SetupDeps = {
  io: {
    out: (line: string) => void;
    err: (line: string) => void;
    prompt: (question: string) => Promise<string>;
    signal: AbortSignal;
    hostname: string;
    isTTY: boolean;
    inputIsTTY: boolean;
    fetch: InfoFetcher;
  };
  env: Record<string, string | undefined>;
  home: Home;
  /** Why this state directory (platform.ts `homeChoice`). */
  homeWhy: string;
  positional: readonly string[];
  /** `--name` and `--relay`: the defaults the prompts offer. */
  name?: string;
  relay?: string;
  /** Runs `claude` and `code`; without one, neither is found. */
  run?: ToolRun;
  /** The default device name for a host name (cli.ts `toName`). */
  toName: (text: string) => string;
  /** Makes the device when there is none, then the mesh (cli.ts, as `wim mesh create`). */
  create: (relay: string, name: string) => Promise<{ mesh: string; recoveryCode?: string }>;
  /** Registers the CLI session with the relay (cli.ts `registerCli`). */
  register: (mesh: string) => Promise<void>;
  /** `wim status`; its exit code is the command's. */
  status: () => Promise<number>;
};

/** The exit code of a command a signal stopped, as cli.ts uses it. */
const STOPPED = 130;

const yes = (answer: string): boolean => /^y(es)?$/i.test(answer.trim());

/** `wim setup`. */
export async function runSetup(d: SetupDeps): Promise<number> {
  requirePerson(d.env, d.io, "wim setup");
  if (d.positional.length > 0) {
    throw new SetupError("`wim setup <invite code>` is not in this version yet: join with an invite code by `wim join <code>`");
  }
  const { io } = d;
  const device = await d.home.loadDevice();
  const meshes = device === undefined ? [] : await d.home.meshIds();
  if (meshes.length === 0) {
    const stopped = await firstMesh(d, device?.name);
    if (stopped !== undefined) return stopped;
  } else {
    io.out(`This device is ${device!.name} (id ${device!.id}), in ${meshes.length === 1 ? "a mesh" : `${meshes.length} meshes`} already: skipping to the steps that can be repeated.`);
  }
  io.out("");
  await integrations(d);
  // Ctrl-C at one of its questions (io.ts hands it to the signal): stop before the status checks.
  if (io.signal.aborted) return STOPPED;
  io.out("");
  io.out("Optional: `wim agent encrypt` keeps this device's keys under a passphrase, in a signer process instead of a file agents can read (README, step 5).");
  if (await isAdminAnywhere(d)) {
    io.out("To add another machine: run `wim invite` here, then `wim join <code>` on it. Adding a machine from `wim setup` on it comes in a later version.");
  }
  io.out("");
  return d.status();
}

/**
 * The create path: the device name (unless the device exists), the relay, what the relay says it
 * offers, a typed y, then the mesh and its recovery code. Returns an exit code when it stops
 * there, and undefined once the mesh is made.
 */
async function firstMesh(d: SetupDeps, existing: string | undefined): Promise<number | undefined> {
  const { io } = d;
  io.out(existing === undefined ? "This machine is not set up yet." : `This device is ${existing}, in no mesh yet.`);
  io.out("  1. Create a new mesh here (the first of your devices)");
  io.out("  2. Add this machine to a mesh you already have");
  const choice = (await io.prompt("Choose 1 or 2: ")).trim();
  if (choice === "2") {
    io.out("Adding this machine from `wim setup` is not in this version yet. For now: on a device already in the mesh, run `wim invite` in a terminal; then here, `wim join <code>` with the code it shows.");
    return 1;
  }
  if (choice !== "1") {
    io.err("wim: choose 1 or 2. Nothing changed.");
    return 1;
  }
  const name = existing ?? (await ask(io, "Device name", d.name ?? d.toName(io.hostname)));
  if (!isName(name)) throw new SetupError(`invalid device name ${JSON.stringify(name)}: use 1 to 32 of a-z, 0-9 and -`);
  const relay = await ask(io, "Relay", d.relay ?? HOSTED_RELAY);
  checkDialable(relay, undefined);
  const info = await fetchRelayInfo(relay, io.fetch);
  // The relay's claims, shown as data: the person decides on them, nothing else does.
  for (const line of info === undefined ? ["this relay does not publish /v1/info, so what it offers is not known"] : describeInfo(info)) io.out(`  ${line}`);
  if (relay === HOSTED_RELAY) io.out(`  The hosted relay's terms: ${HOSTED_TERMS}`);
  if (!yes(await io.prompt(`Create a mesh on ${relay} with ${name} as its admin? [y/N] `))) {
    io.err("wim: nothing changed.");
    return 1;
  }
  const made = await d.create(relay, name);
  io.out(`Created mesh ${made.mesh} on ${relay}. This device is its admin.`);
  // `wim setup` always makes one: `--no-recovery` is for scripts, which use `wim init`.
  io.out("");
  io.out(RECOVERY_TITLE);
  io.out(`  ${made.recoveryCode!}`);
  io.out("");
  await io.prompt(STORED_PROMPT);
  // A person who stopped the command here gets no new connection, as with `wim mesh create`.
  if (io.signal.aborted) return STOPPED;
  await d.register(made.mesh);
  return undefined;
}

/** Asks with a default in brackets; Enter takes the default. */
async function ask(io: SetupDeps["io"], what: string, fallback: string): Promise<string> {
  const typed = (await io.prompt(`${what} [${fallback}]: `)).trim();
  return typed === "" ? fallback : typed;
}

/** The output of a tool that failed, as at most the last three lines, controls made visible. */
function failure(r: RunResult): string {
  const lines = `${r.stderr}\n${r.stdout}`.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  return lines.length === 0 ? `exit code ${String(r.code)}` : sanitizeForDisplay(lines.slice(-3).join(" / "));
}

/** Runs a tool: its result, or a line saying why it could not start. */
async function runText(run: ToolRun, cmd: string, args: readonly string[]): Promise<RunResult | string> {
  try {
    return await run(cmd, args);
  } catch (error) {
    return sanitizeForDisplay((error as Error).message);
  }
}

/** Runs a tool to see whether it is here: undefined when it is not installed (or nothing runs tools). */
async function probe(run: ToolRun | undefined, cmd: string, args: readonly string[]): Promise<RunResult | string | undefined> {
  if (run === undefined) return undefined;
  try {
    return await run(cmd, args);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return sanitizeForDisplay((error as Error).message);
  }
}

/** Why a run did not work, or undefined when it exited 0. */
function whyNot(r: RunResult | string): string | undefined {
  if (typeof r === "string") return r;
  return r.code === 0 ? undefined : failure(r);
}

/** Whether a JSON list from `claude plugin ... --json` has an entry whose `key` is `value`. */
function listed(r: RunResult, key: string, value: string): boolean {
  try {
    const rows: unknown = JSON.parse(r.stdout);
    return Array.isArray(rows) && rows.some((row) => typeof row === "object" && row !== null && (row as Record<string, unknown>)[key] === value);
  } catch {
    return false;
  }
}

/** The Claude Code plugin and the VS Code extension, each offered only when its CLI is found. */
async function integrations(d: SetupDeps): Promise<void> {
  const { io, run } = d;
  const slash = [`  /plugin marketplace add ${MARKETPLACE}`, `  /plugin install ${PLUGIN}`];
  const plugins = await probe(run, "claude", ["plugin", "list", "--json"]);
  const listFailed = plugins === undefined ? undefined : whyNot(plugins);
  if (plugins === undefined) {
    io.out("Claude Code: the `claude` command was not found here. To install the plugin, type these in a Claude Code chat, then open a new tab:");
    for (const l of slash) io.out(l);
  } else if (listFailed !== undefined) {
    io.out(`Claude Code: \`claude plugin list\` did not work (${listFailed}). To install the plugin, type these in a Claude Code chat:`);
    for (const l of slash) io.out(l);
  } else if (listed(plugins as RunResult, "id", PLUGIN)) {
    io.out("Claude Code plugin: installed. Open a new Claude Code tab; it links by itself.");
  } else {
    io.out("Claude Code found. Installing the worldinmotion plugin runs:");
    io.out(`  claude ${MARKETPLACE_ADD.join(" ")}`);
    io.out(`  claude ${PLUGIN_INSTALL.join(" ")}`);
    if (yes(await io.prompt("Install the worldinmotion plugin? [y/N] "))) await installPlugin(io, run!, slash);
    else for (const l of ["Skipped. Later, type these in a Claude Code chat:", ...slash]) io.out(l);
  }
  // The link step: a Claude Code tab is this device only when it resolves this state directory.
  io.out(`State directory: ${d.home.root} (${d.homeWhy}).`);
  if ((d.env["CLAUDE_CONFIG_DIR"] ?? "") !== "" && (d.env["WIM_HOME"] ?? "") === "") {
    io.out("Warning: CLAUDE_CONFIG_DIR is set in this terminal. A Claude Code tab started without the same CLAUDE_CONFIG_DIR is another device, with its own keys: start Claude Code with it set, or set WIM_HOME to this directory in both.");
  }
  const extensions = await probe(run, "code", ["--list-extensions"]);
  const extFailed = extensions === undefined ? undefined : whyNot(extensions);
  if (extensions === undefined) {
    io.out(`VS Code: the \`code\` command was not found here. The extension is ${EXTENSION}, a pre-release: search for worldinmotion in the Extensions view.`);
  } else if (extFailed !== undefined) {
    io.out(`VS Code: \`code --list-extensions\` did not work (${extFailed}).`);
  } else if ((extensions as RunResult).stdout.split(/\r?\n/).some((l) => l.trim().toLowerCase() === EXTENSION)) {
    io.out("VS Code extension: installed.");
  } else if (yes(await io.prompt(`VS Code found. Install the extension? It runs: code ${EXTENSION_INSTALL.join(" ")} [y/N] `))) {
    const why = whyNot(await runText(run!, "code", EXTENSION_INSTALL));
    io.out(why === undefined ? "VS Code extension: installed. Reload any open VS Code window." : `VS Code: the install did not work (${why}).`);
  } else {
    io.out(`Skipped. Later: code ${EXTENSION_INSTALL.join(" ")}`);
  }
}

/** Adds the marketplace unless Claude Code has it, then installs the plugin. */
async function installPlugin(io: SetupDeps["io"], run: ToolRun, slash: readonly string[]): Promise<void> {
  const markets = await runText(run, "claude", ["plugin", "marketplace", "list", "--json"]);
  const known = whyNot(markets) === undefined && listed(markets as RunResult, "name", "worldinmotion");
  for (const args of known ? [PLUGIN_INSTALL] : [MARKETPLACE_ADD, PLUGIN_INSTALL]) {
    const why = whyNot(await runText(run, "claude", args));
    if (why !== undefined) {
      io.out(`Claude Code: \`claude ${args.join(" ")}\` did not work (${why}). In a Claude Code chat instead:`);
      for (const l of slash) io.out(l);
      return;
    }
  }
  io.out("Claude Code plugin: installed. Open a new Claude Code tab; it links by itself.");
}

/** Whether this device is an admin of any of its meshes, by the roster it last verified. */
async function isAdminAnywhere(d: SetupDeps): Promise<boolean> {
  const device = (await d.home.loadDevice())!;
  for (const id of await d.home.meshIds()) {
    const book = await RosterBook.open(new MeshFiles(d.home.meshDir(id), d.home.env));
    if (book.current.devices.some((x) => x.id === device.id && x.role === "admin")) return true;
  }
  return false;
}
