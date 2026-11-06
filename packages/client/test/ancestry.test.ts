import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ancestry, parseChain, POINTER_LEVELS, procStat, psTable, realAncestryDeps, sameProcess, type AncestryDeps } from "../src/ancestry.ts";
import { processIo, type Proc } from "../src/io.ts";

/** `/proc/<pid>/stat` for a process: the name in parentheses, then the fields, starttime 22nd. */
const stat = (pid: number, name: string, ppid: number, start: number): string =>
  `${pid} (${name}) S ${ppid} ${Array.from({ length: 17 }, () => "0").join(" ")} ${start} 0 0\n`;

function linux(table: Record<number, string>): AncestryDeps {
  return {
    platform: "linux",
    pid: 10,
    ppid: 9,
    readFile: async (path) => {
      const pid = Number(/^\/proc\/(\d+)\/stat$/.exec(path)![1]);
      if (table[pid] === undefined) throw new Error("ENOENT");
      return table[pid]!;
    },
    execFile: async () => {
      throw new Error("not on linux");
    },
  };
}

describe("ancestry", () => {
  it("reads a /proc stat line, whatever the command name holds", () => {
    expect(procStat(stat(5, "node", 4, 123))).toEqual({ ppid: 4, start: "123" });
    expect(procStat(stat(5, "a ) b (", 4, 77))).toEqual({ ppid: 4, start: "77" });
    expect(procStat("garbage")).toBeUndefined();
    expect(procStat("5 (x) S notanumber")).toBeUndefined();
    expect(procStat("5 (x) S 4 0")).toBeUndefined();
  });

  it("walks /proc on Linux, nearest first, up to the level asked for", async () => {
    const d = linux({ 10: stat(10, "hook", 9, 100), 9: stat(9, "sh", 8, 90), 8: stat(8, "agent", 1, 80), 1: stat(1, "init", 0, 1) });
    expect(await ancestry(d, 8)).toEqual([
      { pid: 9, start: "90" },
      { pid: 8, start: "80" },
      { pid: 1, start: "1" },
    ]);
    expect(await ancestry(d, 2)).toEqual([
      { pid: 9, start: "90" },
      { pid: 8, start: "80" },
    ]);
    // A parent that cannot be read ends the chain there; so does this process itself.
    expect(await ancestry(linux({ 10: stat(10, "hook", 9, 100) }), 8)).toEqual([]);
    expect(await ancestry(linux({}), 8)).toEqual([]);
  });

  it("asks ps once on macOS, with a fixed locale and time zone", async () => {
    const calls: Array<[string, readonly string[], Record<string, string>]> = [];
    const out = ["   10     9 Thu Nov  6 21:00:03 2026", "    9     8 Thu Nov  6 21:00:02 2026", "    8     1 Thu Nov  6 21:00:01 2026", "not a row", "    1     0 Thu Nov  6 08:00:00 2026", ""].join("\n");
    const d: AncestryDeps = {
      platform: "darwin",
      pid: 10,
      ppid: 9,
      readFile: async () => "",
      execFile: async (file, args, env) => {
        calls.push([file, args, env]);
        return out;
      },
    };
    expect(await ancestry(d, 3)).toEqual([
      { pid: 9, start: "Thu Nov  6 21:00:02 2026" },
      { pid: 8, start: "Thu Nov  6 21:00:01 2026" },
      { pid: 1, start: "Thu Nov  6 08:00:00 2026" },
    ]);
    expect(calls).toEqual([["ps", ["-A", "-o", "pid=,ppid=,lstart="], { LC_ALL: "C", TZ: "UTC" }]]);
    // ps that fails gives no chain.
    expect(await ancestry({ ...d, execFile: async () => Promise.reject(new Error("no ps")) }, 3)).toEqual([]);
    expect(psTable("  5  4 x")).toEqual(new Map([[5, { ppid: 4, start: "x" }]]));
  });

  it("knows only the direct parent elsewhere, with no start time", async () => {
    const d: AncestryDeps = { platform: "win32", pid: 10, ppid: 9, readFile: async () => "", execFile: async () => "" };
    expect(await ancestry(d, 3)).toEqual([{ pid: 9, start: "" }]);
    expect(await ancestry({ ...d, ppid: 0 }, 3)).toEqual([]);
    expect(await ancestry(d, 0)).toEqual([]);
  });

  it("reads this machine for real", async () => {
    const d = realAncestryDeps(process.platform);
    expect(d.pid).toBe(process.pid);
    expect(d.ppid).toBe(process.ppid);
    expect(await d.readFile(import.meta.filename)).toContain("reads this machine for real");
    expect(await d.execFile(process.execPath, ["-e", "process.stdout.write(process.env.W1_ANC ?? '')"], { W1_ANC: "seen" })).toBe("seen");
    await expect(d.execFile(process.execPath, ["-e", "process.exit(3)"], {})).rejects.toThrow();
    const chain = await ancestry(d, 2);
    // On Linux and macOS the real parent comes first; elsewhere it is the parent alone.
    expect(chain[0]?.pid).toBe(process.ppid);
  });

  it("gives the CLI its own process's chain", async () => {
    const proc = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), platform: "win32", pid: 7, ppid: 50, cwd: () => "/", once: () => undefined, on: () => undefined } as unknown as Proc;
    const io = processIo(proc, { homedir: () => "/h", hostname: () => "h", kill: () => undefined, wim: () => [] });
    expect(await io.ancestry!(3)).toEqual([{ pid: 50, start: "" }]);
  });

  it("compares processes by pid and start time, and reads a chain back strictly", () => {
    expect(sameProcess({ pid: 1, start: "a" }, { pid: 1, start: "a" })).toBe(true);
    expect(sameProcess({ pid: 1, start: "a" }, { pid: 1, start: "b" })).toBe(false);
    expect(sameProcess({ pid: 1, start: "a" }, { pid: 2, start: "a" })).toBe(false);
    expect(parseChain([{ pid: 3, start: "x", extra: 1 }])).toEqual([{ pid: 3, start: "x" }]);
    expect(parseChain([])).toEqual([]);
    expect(parseChain("no")).toBeUndefined();
    expect(parseChain(Array.from({ length: POINTER_LEVELS + 1 }, (_, i) => ({ pid: i + 1, start: "" })))).toBeUndefined();
    for (const bad of [null, 5, { pid: 0, start: "" }, { pid: 1.5, start: "" }, { pid: 1 }, { pid: 1, start: "x".repeat(65) }]) expect(parseChain([bad])).toBeUndefined();
  });
});
