// Which processes started this one, for `wim hook` (docs/peers.md, waking at turn end): the chain
// of parent processes, nearest first, each named by its pid and its start time, so a pid the
// system later hands to another process never reads as the same process.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import type { Platform } from "./platform.ts";

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
 * The parents of this process, nearest first, at most `levels`. Linux reads `/proc`; macOS asks
 * `ps` once (run directly, with a fixed locale and time zone, so two processes read the same start
 * times). Elsewhere (Windows) only the direct parent is known, with no start time. Anything that
 * cannot be read ends the chain there.
 */
export async function ancestry(d: AncestryDeps, levels: number): Promise<Ancestor[]> {
  if (d.platform === "linux") {
    return walk(d.pid, levels, async (pid) => procStat(await d.readFile(`/proc/${pid}/stat`).catch(() => "")));
  }
  if (d.platform === "darwin") {
    const table = psTable(await d.execFile("ps", ["-A", "-o", "pid=,ppid=,lstart="], { LC_ALL: "C", TZ: "UTC" }).catch(() => ""));
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
