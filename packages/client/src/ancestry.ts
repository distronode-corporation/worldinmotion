// Which processes started this one, for `wim hook` (docs/peers.md, waking at turn end): the chain
// of parent processes, nearest first, each named by its pid and its start time, so a pid the
// system later hands to another process never reads as the same process.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import type { Platform } from "./platform.ts";
import { agentEnv } from "./secretout.ts";

/** One process: its pid, and when it started, as the system reports it (empty where it reports nothing). */
export type Ancestor = { pid: number; start: string };

/** How many levels `wim mcp` records above itself. */
export const POINTER_LEVELS = 8;

/** What reading the chain needs from the machine, so tests can pass a stand-in. */
export type AncestryDeps = {
  platform: Platform;
  pid: number;
  ppid: number;
  readFile: (path: string) => Promise<string>;
  /** Runs a program directly (never through a shell) and resolves with its stdout. */
  execFile: (file: string, args: readonly string[], env: Record<string, string>) => Promise<string>;
};

type Facts = { ppid: number; start: string };

/** A `/proc/<pid>/stat` line: the parent and the start time (clock ticks after boot), or undefined. */
export function procStat(text: string): Facts | undefined {
  // The command name is in parentheses and may hold spaces or `)`: the fields start after the last one.
  const close = text.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = text.slice(close + 2).split(" ");
  // After the name: state, ppid, ... and starttime, the 22nd field of the line.
  const ppid = Number(fields[1]);
  const start = fields[19] ?? "";
  return Number.isSafeInteger(ppid) && ppid >= 0 && /^\d+$/.test(start) ? { ppid, start } : undefined;
}

/** `ps -A -o pid=,ppid=,lstart=` output, by pid. Lines that are not one process are skipped. */
export function psTable(text: string): Map<number, Facts> {
  const out = new Map<number, Facts>();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S(?:.*\S)?)\s*$/.exec(line);
    if (m !== null) out.set(Number(m[1]), { ppid: Number(m[2]), start: m[3]! });
  }
  return out;
}

/** Walks up from `pid` through `look`, at most `levels` parents. */
async function walk(pid: number, levels: number, look: (pid: number) => Promise<Facts | undefined>): Promise<Ancestor[]> {
  const chain: Ancestor[] = [];
  let self = await look(pid);
  while (self !== undefined && self.ppid > 0 && chain.length < levels) {
    const parent = await look(self.ppid);
    if (parent === undefined) break;
    chain.push({ pid: self.ppid, start: parent.start });
    self = parent;
  }
  return chain;
}

/**
 * The parents of this process, nearest first, at most `levels`. Linux reads `/proc`; macOS runs
 * `/bin/ps` once (directly, by its absolute path, with a fixed locale and time zone, so two
 * processes read the same start times). Elsewhere (Windows) only the direct parent is known, with
 * no start time. Anything that cannot be read ends the chain there.
 */
export async function ancestry(d: AncestryDeps, levels: number): Promise<Ancestor[]> {
  if (d.platform === "linux") {
    return walk(d.pid, levels, async (pid) => procStat(await d.readFile(`/proc/${pid}/stat`).catch(() => "")));
  }
  if (d.platform === "darwin") {
    const table = psTable(await d.execFile("/bin/ps", ["-A", "-o", "pid=,ppid=,lstart="], { LC_ALL: "C", TZ: "UTC" }).catch(() => ""));
    return walk(d.pid, levels, async (pid) => table.get(pid));
  }
  return d.ppid > 0 && levels > 0 ? [{ pid: d.ppid, start: "" }] : [];
}

/** The machine's own reading, for this process. */
export function realAncestryDeps(platform: Platform): AncestryDeps {
  return {
    platform,
    pid: process.pid,
    ppid: process.ppid,
    readFile: (path) => fs.readFile(path, "utf8"),
    execFile: (file, args, env) =>
      new Promise((resolve, reject) => {
        execFile(file, [...args], { env, timeout: 3000, maxBuffer: 8 << 20, windowsHide: true }, (error, stdout) => (error === null ? resolve(stdout) : reject(error)));
      }),
  };
}

/** Whether two records name the same process: the same pid that started at the same time. */
export function sameProcess(a: Ancestor, b: Ancestor): boolean {
  return a.pid === b.pid && a.start === b.start;
}

/** A chain read back from a file: well formed, or undefined. */
export function parseChain(raw: unknown): Ancestor[] | undefined {
  if (!Array.isArray(raw) || raw.length > POINTER_LEVELS) return undefined;
  const ok = raw.every((a: Partial<Ancestor> | null) => typeof a === "object" && a !== null && Number.isSafeInteger(a.pid) && (a.pid as number) > 0 && typeof a.start === "string" && a.start.length <= 64);
  return ok ? (raw as Ancestor[]).map((a) => ({ pid: a.pid, start: a.start })) : undefined;
}

// ---- what the signer checks about the processes above it (SECURITY-MODEL 5.8) ----

/** Program names of AI agents: a parent running one is an agent's, whatever its variables say. */
export const AGENT_PROGRAMS: readonly string[] = ["claude", "codex", "cursor-agent", "gemini", "aider", "opencode", "antigravity"];

/** A process's command line and its environment as it started, or undefined where neither can be read. */
export type ProcessFacts = { argv: string[]; env: Record<string, string> };

/** `KEY=value` strings as a record; anything else is skipped. */
function envOf(items: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(item);
    if (m !== null) out[m[1]!] = m[2]!;
  }
  return out;
}

/**
 * The command line and starting environment of `pid`. Linux reads `/proc/<pid>/cmdline` and
 * `environ` (another user's environ is not readable: none then); macOS runs `/bin/ps -E`, which
 * prints the environment after the command line. Elsewhere (Windows) nothing is known.
 */
export async function processFacts(d: AncestryDeps, pid: number): Promise<ProcessFacts | undefined> {
  if (d.platform === "linux") {
    const cmdline = await d.readFile(`/proc/${pid}/cmdline`).catch(() => undefined);
    if (cmdline === undefined) return undefined;
    const environ = await d.readFile(`/proc/${pid}/environ`).catch(() => "");
    return { argv: cmdline.split("\0").filter((a) => a !== ""), env: envOf(environ.split("\0")) };
  }
  if (d.platform !== "darwin") return undefined;
  const out = (await d.execFile("/bin/ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { LC_ALL: "C" }).catch(() => "")).trim();
  if (out === "") return undefined;
  const words = out.split(/\s+/);
  return { argv: words.filter((w) => !w.includes("=")), env: envOf(words) };
}

/** A program's name without its directory or extension (`/usr/bin/claude`, `C:\\x\\codex.exe`). */
function programName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1).replace(/\.(exe|cmd|js|mjs|cjs)$/i, "");
}

/**
 * Why an AI agent is among the processes above this one (at most `levels`): one started with an
 * agent's variables, or one running an agent's program. Undefined when none is, or where the
 * parents cannot be read (Windows). An agent that detaches its process from itself first (a new
 * session whose parent is init) is not seen: SECURITY-MODEL 5.8 says so.
 */
export async function agentAncestor(d: AncestryDeps, levels = 32): Promise<string | undefined> {
  for (const a of await ancestry(d, levels)) {
    const f = await processFacts(d, a.pid);
    if (f === undefined) continue;
    const variable = agentEnv(f.env);
    const program = f.argv.slice(0, 2).map(programName).find((n) => AGENT_PROGRAMS.includes(n));
    if (variable === undefined && program === undefined) continue;
    const line = f.argv.join(" ").replace(/\s+/g, " ").slice(0, 80);
    return `process ${a.pid} above this signer (${line}) ${variable === undefined ? `runs ${program}` : `has ${variable} set`}`;
  }
  return undefined;
}

/**
 * Whether standard input is this process's controlling terminal (Linux: `tty_nr` of
 * `/proc/self/stat` against the device of fd 0); undefined when it is, or elsewhere, why not.
 */
export function controllingTerminal(stat: string, rdev: number): string | undefined {
  const close = stat.lastIndexOf(")");
  const tty = Number(stat.slice(close + 2).split(" ")[4]);
  if (close < 0 || !Number.isSafeInteger(tty) || tty === 0) return "this signer has no controlling terminal";
  return tty === rdev ? undefined : "this signer's input is not its controlling terminal";
}

/** What the signer checks before it asks the person, so tests can pass a stand-in. */
export type SignerChecks = {
  /** Why an agent is among the processes above it, if one is (agentAncestor). */
  agentAncestor: () => Promise<string | undefined>;
  /** Why its input is not its own terminal, if it is not (Linux; controllingTerminal). */
  terminal: () => Promise<string | undefined>;
  /** The command line of the process that started it, for the passphrase dialog to name. */
  askedBy: () => Promise<string | undefined>;
};

/** The machine's own checks for this process. */
export function realSignerChecks(d: AncestryDeps, rdev0: () => number): SignerChecks {
  return {
    agentAncestor: () => agentAncestor(d),
    terminal: async () => (d.platform === "linux" ? controllingTerminal(await d.readFile("/proc/self/stat").catch(() => ""), rdev0()) : undefined),
    askedBy: async () => (await processFacts(d, d.ppid))?.argv.join(" ").replace(/\s+/g, " ").slice(0, 200),
  };
}
