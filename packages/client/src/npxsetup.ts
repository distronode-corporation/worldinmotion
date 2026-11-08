// `npx worldinmotion setup` (README, Quick start). npx runs wim from its cache, which npm prunes, so
// an agent config pointing there would later stop working without a word. When `wim setup` finds
// it runs from that cache, it says so first and, on a typed y, installs this exact version at a
// stable path with `npm install --global`, run without a shell. When npm's global prefix is not
// writable it offers a prefix of the person's own instead and says how to put it on PATH: it never
// uses sudo. It then runs `wim setup` again from the installed copy, so every path that run writes
// into an agent's config is the stable one. On N it stops, prints the one install command and
// writes nothing. This runs inside `wim setup`, after `requirePerson`.

import { sanitizeForDisplay } from "@worldinmotion/protocol";
import { spawn as nodeSpawn } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import { pathFor, type Platform } from "./platform.ts";
import type { RunResult } from "./autostart.ts";
import type { ToolRun } from "./setup.ts";

/** Runs a program with this terminal as its own (stdin, stdout and stderr) and gives its exit code. */
export type Relaunch = (cmd: string, args: readonly string[]) => Promise<number>;

/** The exit code of a run a signal stopped, as cli.ts uses it. */
const STOPPED = 130;

/** Where a prefix of the person's own goes, under the home directory (npm's own advice for EACCES). */
export const USER_PREFIX = ".npm-global";

/**
 * Whether `path` is inside npx's cache, where `npx` and `npm exec` install what they run:
 * `<cache>/_npx/<hash>/node_modules/...` on every platform, `\` or `/`.
 */
export function inNpxCache(path: string): boolean {
  return /[\\/]_npx[\\/]/i.test(path);
}

/** Where `npm install --global` puts packages and their commands under `prefix` (npm's folders). */
export function npmLayout(prefix: string, platform: Platform): { modules: string; bin: string } {
  const path = pathFor(platform);
  return platform === "win32" ? { modules: path.join(prefix, "node_modules"), bin: prefix } : { modules: path.join(prefix, "lib", "node_modules"), bin: path.join(prefix, "bin") };
}

/**
 * Whether this user can make `dir`: it, or the nearest directory above it that exists, is
 * writable. `access` is `fs.access` (a parameter for tests: Windows has no mode bits to clear).
 */
export async function writable(dir: string, platform: Platform, access: (path: string, mode: number) => Promise<void> = (p, m) => fs.access(p, m)): Promise<boolean> {
  const path = pathFor(platform);
  for (let at = dir; ; at = path.dirname(at)) {
    try {
      await access(at, constants.W_OK);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(at) === at) return false;
    }
  }
}

/** A relaunch that hands this terminal to the child and waits for it. */
export function inheritRelaunch(spawn: typeof nodeSpawn = nodeSpawn): Relaunch {
  return (cmd, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: "inherit" });
      child.once("error", reject);
      // A child a signal stopped has no code: report it as Ctrl-C is reported.
      child.once("exit", (code) => resolve(code ?? STOPPED));
    });
}

/** What the step needs from `wim setup` (cli.ts). */
export type NpxSetupDeps = {
  io: { out: (line: string) => void; err: (line: string) => void; prompt: (question: string) => Promise<string> };
  env: Record<string, string | undefined>;
  platform: Platform;
  homedir: string;
  /** This wim's version: the one installed. */
  version: string;
  /** How this wim was started (node, its flags, the script); undefined: not known. */
  wim: readonly string[] | undefined;
  /** The words after `wim` to run again: `setup` and its flags and code. */
  argv: readonly string[];
  /** Runs npm with no shell (setup.ts `execRunner`). */
  run: ToolRun | undefined;
  relaunch: Relaunch | undefined;
  /** Seams for tests, which stand in for this machine's files: `writable` below and `fs.realpath`. */
  writable?: (dir: string) => Promise<boolean>;
  realpath?: (path: string) => Promise<string>;
};

const yes = (answer: string): boolean => /^y(es)?$/i.test(answer.trim());

/** A path as a person would type it in a command: quoted when it has spaces. */
const quoted = (path: string): string => (/\s/.test(path) ? `"${path}"` : path);

/** Why a run of npm did not work, or undefined when it exited 0. */
function whyNot(r: RunResult | string): string | undefined {
  if (typeof r === "string") return r;
  if (r.code === 0) return undefined;
  const lines = `${r.stderr}\n${r.stdout}`.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  return lines.length === 0 ? `exit code ${String(r.code)}` : sanitizeForDisplay(lines.slice(-3).join(" / "));
}

async function runText(run: ToolRun, args: readonly string[], env?: Record<string, string>): Promise<RunResult | string> {
  try {
    return await run("npm", args, env);
  } catch (error) {
    return sanitizeForDisplay((error as Error).message);
  }
}

/** Whether `dir` is one of the PATH directories (case aside on Windows). */
function onPathDir(dir: string, env: Record<string, string | undefined>, platform: Platform): boolean {
  const path = pathFor(platform);
  const norm = (d: string): string => {
    const n = path.resolve(d);
    return platform === "win32" ? n.toLowerCase() : n;
  };
  return (env["PATH"] ?? "").split(path.delimiter).some((d) => d !== "" && norm(d) === norm(dir));
}

/**
 * npm's global prefix. Under npx, npm hands it to what it runs as `npm_config_global_prefix`;
 * otherwise `npm prefix --global` prints it. The variable comes first because npm's output hides
 * anything that looks like a token, a UUID in a directory name included, and an install path read
 * from it would then name a directory that is not there.
 */
async function globalPrefix(run: ToolRun, env: Record<string, string | undefined>): Promise<string | { failed: string }> {
  const given = env["npm_config_global_prefix"] ?? "";
  if (given !== "") return given;
  const asked = await runText(run, ["prefix", "--global"]);
  const failed = whyNot(asked);
  return failed === undefined ? (asked as RunResult).stdout.trim() : { failed };
}

/**
 * The step: undefined when this wim does not run from npx's cache (setup goes on), otherwise the
 * exit code of the setup run from the installed copy, or 1 when it stopped with nothing written.
 */
export async function npxSetup(d: NpxSetupDeps): Promise<number | undefined> {
  if (d.wim === undefined || d.wim.length < 2) return undefined;
  const ran = d.wim.at(-1)!;
  const realpath = d.realpath ?? ((path: string) => fs.realpath(path));
  const script = await realpath(ran).catch(() => ran);
  if (!inNpxCache(script)) return undefined;
  const { io } = d;
  const spec = `worldinmotion@${d.version}`;
  const command = (prefix?: string): string => `npm install --global ${prefix === undefined ? "" : `--prefix ${quoted(prefix)} `}${spec}`;
  const stop = (shown: string): number => {
    io.err(`wim: nothing changed. To install wim at a stable path, run \`${shown}\`, then \`wim setup\`.`);
    return 1;
  };
  io.out(`This wim runs from npx's cache (${script}), which npm prunes: an agent's config that pointed there would stop working later, without a word.`);
  io.out("So setup first installs wim at a stable path, then runs from there.");
  if (d.run === undefined || d.relaunch === undefined) return stop(command());
  const global = await globalPrefix(d.run, d.env);
  if (typeof global !== "string") {
    io.out(`\`npm prefix --global\` did not work (${global.failed}).`);
    return stop(command());
  }
  const canWrite = d.writable ?? ((dir: string) => writable(dir, d.platform));
  const canInstall = async (prefix: string): Promise<boolean> => {
    const at = npmLayout(prefix, d.platform);
    return (await canWrite(at.modules)) && (await canWrite(at.bin));
  };
  let own: string | undefined;
  if (!(await canInstall(global))) {
    own = pathFor(d.platform).join(d.homedir, USER_PREFIX);
    io.out(`npm installs globally under ${global}, which you cannot write to. Setup never uses sudo.`);
    if (!(await canInstall(own))) {
      io.out(`${own}, the prefix it would offer instead, is not writable either.`);
      return stop(command());
    }
  }
  const shown = command(own);
  const question = own === undefined ? `Install ${spec} globally? It runs: ${shown} [y/N] ` : `Install it under ${own}, a prefix of your own, instead? It runs: ${shown} [y/N] `;
  if (!yes(await io.prompt(question))) return stop(shown);
  io.out(`Installing ${spec}...`);
  // The prefix goes in npm's environment, not its arguments: on Windows npm is a .cmd, run
  // through a shell, which would split a home directory with a space in it.
  const why = whyNot(await runText(d.run, ["install", "--global", spec], own === undefined ? undefined : { npm_config_prefix: own }));
  if (why !== undefined) {
    io.out(`The install did not work (${why}).`);
    return stop(shown);
  }
  const at = npmLayout(own ?? global, d.platform);
  const expected = pathFor(d.platform).join(at.modules, "worldinmotion", "wim.mjs");
  const installed = await realpath(expected).catch(() => undefined);
  // Asserted, not assumed: a copy that is not there, or is in a cache too, is never run from.
  if (installed === undefined || inNpxCache(installed)) {
    io.out(`npm said it installed ${spec}, but ${installed ?? expected} is ${installed === undefined ? "not there" : "in npx's cache too"}.`);
    return stop(shown);
  }
  io.out(`Installed: ${installed}.`);
  if (!onPathDir(at.bin, d.env, d.platform)) {
    io.out(`To type \`wim\` in a new terminal, put ${at.bin} on PATH:`);
    io.out(d.platform === "win32" ? `  add it to your user Path (Settings, System, About, Advanced system settings, Environment Variables), then open a new terminal` : `  add the line  export PATH=${quoted(at.bin)}:"$PATH"  to your shell's profile (~/.profile, ~/.bashrc or ~/.zshrc), then open a new terminal`);
  }
  if (own !== undefined) io.out(`For later \`npm install --global\` to use it too: npm config set prefix ${quoted(own)}`);
  io.out("Running `wim setup` again from the installed copy.");
  io.out("");
  try {
    return await d.relaunch(d.wim[0]!, [...d.wim.slice(1, -1), installed, ...d.argv]);
  } catch (error) {
    io.err(`wim: could not run ${installed} (${sanitizeForDisplay((error as Error).message)}). Run \`wim setup\` from it yourself.`);
    return 1;
  }
}
