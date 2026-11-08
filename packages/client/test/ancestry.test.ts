import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { agentAncestor, ancestry, controllingTerminal, parseChain, POINTER_LEVELS, processFacts, procStat, psTable, realAncestryDeps, realSignerChecks, sameProcess, type AncestryDeps } from "../src/ancestry.ts";
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
    expect(calls).toEqual([["/bin/ps", ["-A", "-o", "pid=,ppid=,lstart="], { LC_ALL: "C", TZ: "UTC" }]]);
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

/** A Linux machine of `procs`: each pid's parent, command line and environment; `unreadable` environs fail. */
function procs(table: Record<number, { ppid: number; argv?: string[]; env?: string[] }>, unreadable: number[] = []): AncestryDeps {
  return {
    platform: "linux",
    pid: 10,
    ppid: 9,
    readFile: async (path) => {
      const m = /^\/proc\/(\d+|self)\/(stat|cmdline|environ)$/.exec(path)!;
      const pid = m[1] === "self" ? 10 : Number(m[1]);
      const p = table[pid];
      if (p === undefined || (m[2] === "environ" && unreadable.includes(pid)) || (m[2] === "cmdline" && p.argv === undefined)) throw new Error("EACCES");
      if (m[2] === "stat") return stat(pid, "x", p.ppid, pid);
      return `${(m[2] === "cmdline" ? p.argv! : (p.env ?? [])).join("\0")}\0`;
    },
    execFile: async () => {
      throw new Error("not on linux");
    },
  };
}

describe("an agent above the signer", () => {
  it("is one started with an agent's variables, or running an agent's program, anywhere up the chain", async () => {
    const shell = { ppid: 8, argv: ["bash"], env: ["HOME=/h", "CLAUDECODE=1", "junk"] };
    expect(await agentAncestor(procs({ 10: { ppid: 9 }, 9: { ppid: 8, argv: ["script", "-qc", "wim  agent\tstart"], env: [] }, 8: shell, 7: { ppid: 0 } }))).toBe("process 8 above this signer (bash) has CLAUDECODE set");
    expect(await agentAncestor(procs({ 10: { ppid: 9 }, 9: { ppid: 8, argv: ["/usr/bin/node", "/opt/lib/codex.js"] }, 8: { ppid: 0 } }))).toBe("process 9 above this signer (/usr/bin/node /opt/lib/codex.js) runs codex");
    expect(await agentAncestor(procs({ 10: { ppid: 9 }, 9: { ppid: 8, argv: ["C:\\bin\\claude.exe"] }, 8: { ppid: 0 } }))).toMatch(/runs claude$/);
    // A parent whose command line cannot be read is passed over; an environment that cannot be read is none.
    expect(await agentAncestor(procs({ 10: { ppid: 9 }, 9: { ppid: 8 }, 8: { ppid: 7, argv: ["sshd"], env: ["CLAUDECODE=1"] }, 7: { ppid: 0 } }, [8]))).toBeUndefined();
    expect(await agentAncestor(procs({ 10: { ppid: 9 }, 9: { ppid: 8, argv: ["bash"], env: ["TERM=xterm"] }, 8: { ppid: 0, argv: ["systemd"] } }))).toBeUndefined();
  });

  it("is read from ps on macOS, and not at all elsewhere", async () => {
    const calls: Array<readonly string[]> = [];
    const mac: AncestryDeps = {
      platform: "darwin",
      pid: 10,
      ppid: 9,
      readFile: async () => "",
      execFile: async (_f, args) => {
        calls.push(args);
        if (args[0] === "-A") return "10 9 Mon Jan 1 00:00:00 2026\n9 1 Mon Jan 1 00:00:00 2026\n";
        return args.at(-1) === "9" ? "/bin/zsh -l TERM=xterm GEMINI_CLI=1\n" : "";
      },
    };
    expect(await processFacts(mac, 9)).toEqual({ argv: ["/bin/zsh", "-l"], env: { TERM: "xterm", GEMINI_CLI: "1" } });
    expect(await processFacts(mac, 5)).toBeUndefined();
    expect(await processFacts({ ...mac, execFile: async () => Promise.reject(new Error("no ps")) }, 9)).toBeUndefined();
    expect(calls).toContainEqual(["-E", "-ww", "-o", "command=", "-p", "9"]);
    expect(await agentAncestor(mac)).toBe("process 9 above this signer (/bin/zsh -l) has GEMINI_CLI set");
    expect(await processFacts({ ...mac, platform: "win32" }, 9)).toBeUndefined();
    expect(await agentAncestor({ ...mac, platform: "win32" })).toBeUndefined();
  });

  it("checks the signer's input is its controlling terminal, and names its parent", async () => {
    const line = (tty: number): string => `10 (wim) S 9 10 10 ${tty} 10 0\n`;
    expect(controllingTerminal(line(34816), 34816)).toBeUndefined();
    expect(controllingTerminal(line(34816), 34817)).toBe("this signer's input is not its controlling terminal");
    expect(controllingTerminal(line(0), 0)).toBe("this signer has no controlling terminal");
    expect(controllingTerminal("garbage", 0)).toBe("this signer has no controlling terminal");
    const d = procs({ 10: { ppid: 9 }, 9: { ppid: 0, argv: ["gnome-terminal", "--", "wim"] } });
    const checks = realSignerChecks({ ...d, readFile: async (p) => (p === "/proc/self/stat" ? line(5) : d.readFile(p)) }, () => 5);
    expect(await checks.terminal()).toBeUndefined();
    expect(await checks.askedBy()).toBe("gnome-terminal -- wim");
    expect(await checks.agentAncestor()).toBeUndefined();
    expect(await realSignerChecks({ ...d, readFile: async () => Promise.reject(new Error("no proc")) }, () => 5).terminal()).toBe("this signer has no controlling terminal");
    const mac = realSignerChecks({ ...d, platform: "darwin", execFile: async () => "" }, () => 5);
    expect(await mac.terminal()).toBeUndefined();
    expect(await mac.askedBy()).toBeUndefined();
  });

  it("is checked for this process by the CLI", async () => {
    const proc = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), platform: "win32", pid: 7, ppid: 50, cwd: () => "/", once: () => undefined, on: () => undefined } as unknown as Proc;
    const io = processIo(proc, { homedir: () => "/h", hostname: () => "h", kill: () => undefined, wim: () => [] });
    expect(await io.signerChecks!.agentAncestor()).toBeUndefined();
    expect(await io.signerChecks!.terminal()).toBeUndefined();
    expect(await io.signerChecks!.askedBy()).toBeUndefined();
    // On Linux it reads this process's own stat and standard input.
    const linuxIo = processIo({ ...proc, platform: "linux" } as Proc, { homedir: () => "/h", hostname: () => "h", kill: () => undefined, wim: () => [] });
    expect(["string", "undefined"]).toContain(typeof (await linuxIo.signerChecks!.terminal()));
  });
});
