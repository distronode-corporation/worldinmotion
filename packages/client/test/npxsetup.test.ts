// `npx worldinmotion setup` (npxsetup.ts): finding npx's cache on POSIX and Windows paths, npm's
// global layout, the writable check, the install offer (y and N, the global prefix and one of the
// person's own), every way the install can fail, the run again from the installed copy, and, end to
// end through `wim setup`, that no path into the cache reaches an agent's config.

import { EventEmitter } from "node:events";
import { constants, promises as fs } from "node:fs";
import { join, posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { main, VERSION } from "../src/cli.ts";
import type { RunResult } from "../src/autostart.ts";
import { inheritRelaunch, inNpxCache, npmLayout, npxSetup, USER_PREFIX, writable, type NpxSetupDeps, type Relaunch } from "../src/npxsetup.ts";
import { execRunner, type ToolRun } from "../src/setup.ts";
import { makeMesh, RelayHarness, run, said, scratch, term } from "./helpers.ts";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const SPEC = `worldinmotion@${VERSION}`;

const POSIX_CACHE = "/home/ada/.npm/_npx/6e1b2c/node_modules/worldinmotion/wim.mjs";
const WIN_CACHE = "C:\\Users\\Ada\\AppData\\Local\\npm-cache\\_npx\\6e1b2c\\node_modules\\worldinmotion\\wim.mjs";

describe("inNpxCache", () => {
  it("finds npx's cache in POSIX and Windows paths", () => {
    expect(inNpxCache(POSIX_CACHE)).toBe(true);
    expect(inNpxCache(WIN_CACHE)).toBe(true);
    expect(inNpxCache("C:/Users/Ada/AppData/Local/npm-cache/_NPX/1/node_modules/worldinmotion/wim.mjs")).toBe(true);
  });

  it("does not take a global install, or a name that only contains _npx, for it", () => {
    for (const path of [
      "/usr/local/lib/node_modules/worldinmotion/wim.mjs",
      "/home/ada/.npm-global/lib/node_modules/worldinmotion/wim.mjs",
      "C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\worldinmotion\\wim.mjs",
      "/home/ada/my_npx/wim.mjs",
      "/home/ada/_npx-notes/wim.mjs",
    ]) {
      expect(inNpxCache(path)).toBe(false);
    }
  });
});

describe("npmLayout", () => {
  it("is lib/node_modules and bin on POSIX, node_modules and the prefix itself on Windows", () => {
    expect(npmLayout("/usr/local", "linux")).toEqual({ modules: "/usr/local/lib/node_modules", bin: "/usr/local/bin" });
    expect(npmLayout("/opt/homebrew", "darwin")).toEqual({ modules: "/opt/homebrew/lib/node_modules", bin: "/opt/homebrew/bin" });
    expect(npmLayout("C:\\Users\\Ada\\AppData\\Roaming\\npm", "win32")).toEqual({ modules: "C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules", bin: "C:\\Users\\Ada\\AppData\\Roaming\\npm" });
  });
});

describe("writable", () => {
  const errno = (code: string): Error => Object.assign(new Error(code), { code });

  it("asks about the nearest directory that exists, for write access", async () => {
    const asked: Array<[string, number]> = [];
    const access = async (path: string, mode: number): Promise<void> => {
      asked.push([path, mode]);
      if (path !== "/usr") throw errno("ENOENT");
    };
    expect(await writable("/usr/local/lib/node_modules", "linux", access)).toBe(true);
    expect(asked).toEqual([
      ["/usr/local/lib/node_modules", constants.W_OK],
      ["/usr/local/lib", constants.W_OK],
      ["/usr/local", constants.W_OK],
      ["/usr", constants.W_OK],
    ]);
  });

  it("is false when that directory refuses, and when nothing up to the root exists", async () => {
    expect(await writable("/usr/local/bin", "linux", async () => Promise.reject(errno("EACCES")))).toBe(false);
    const seen: string[] = [];
    const none = async (path: string): Promise<void> => {
      seen.push(path);
      throw errno("ENOENT");
    };
    expect(await writable("C:\\npm\\node_modules", "win32", none)).toBe(false);
    expect(seen).toEqual(["C:\\npm\\node_modules", "C:\\npm", "C:\\"]);
  });

  it("reads this machine's directories by default", async () => {
    const dir = await scratch("npx-writable");
    expect(await writable(join(dir, "not", "yet"), process.platform)).toBe(true);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("is false for a POSIX directory without write permission", async () => {
    const dir = await scratch("npx-readonly");
    await fs.chmod(dir, 0o555);
    try {
      expect(await writable(join(dir, "lib", "node_modules"), process.platform)).toBe(false);
    } finally {
      await fs.chmod(dir, 0o755);
    }
  });
});

describe("inheritRelaunch", () => {
  it("gives the child's exit code", async () => {
    expect(await inheritRelaunch()(process.execPath, ["-e", "process.exit(3)"])).toBe(3);
  });

  it("gives 130 for a child a signal stopped, and rejects when it cannot start", async () => {
    const seen: Array<{ cmd: string; args: readonly string[]; stdio: unknown }> = [];
    const spawn = ((cmd: string, args: readonly string[], options: { stdio: unknown }) => {
      seen.push({ cmd, args, stdio: options.stdio });
      const child = new EventEmitter();
      setImmediate(() => child.emit("exit", null, "SIGINT"));
      return child;
    }) as unknown as Parameters<typeof inheritRelaunch>[0];
    expect(await inheritRelaunch(spawn)("node", ["wim.mjs", "setup"])).toBe(130);
    expect(seen).toEqual([{ cmd: "node", args: ["wim.mjs", "setup"], stdio: "inherit" }]);
    await expect(inheritRelaunch()(join(await scratch("npx-missing"), "no-such-program"), [])).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("execRunner's env", () => {
  it("adds env to this process's environment, and passes none without it", async () => {
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    const execFile = ((_file: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }, callback: (e: null, out: string, err: string) => void) => {
      seen.push(options.env);
      setImmediate(() => callback(null, "", ""));
      return { stdin: null };
    }) as unknown as Parameters<typeof execRunner>[1];
    for (const platform of ["linux", "win32"]) {
      seen.length = 0;
      const r = execRunner(platform, execFile);
      await r("npm", ["prefix", "--global"]);
      await r("npm", ["install"], { npm_config_prefix: "/home/ada/.npm-global" });
      expect(seen.at(-1)).toEqual({ ...process.env, npm_config_prefix: "/home/ada/.npm-global" });
      expect(seen.filter((e) => e === undefined).length).toBe(platform === "win32" ? 3 : 1);
    }
  });
});

type Scene = {
  platform: string;
  homedir: string;
  /** What `npm prefix --global` prints, or how it fails. */
  prefix?: RunResult | Error;
  /** What `npm install` answers, or how it fails. */
  install?: RunResult | Error;
  /** Directories that cannot be written. */
  locked?: string[];
  /** The files that exist, as realpath sees them: path -> real path. */
  files?: Record<string, string>;
  answers?: string[];
  path?: string;
  env?: Record<string, string>;
  relaunch?: Relaunch | "none";
  run?: "none";
  wim?: readonly string[] | undefined;
};

/** A run of the step with fakes for npm, the file system and the relaunch. */
async function scene(s: Scene) {
  const out: string[] = [];
  const err: string[] = [];
  const questions: string[] = [];
  const npm: Array<{ args: string; env: Record<string, string> | undefined }> = [];
  const relaunched: Array<{ cmd: string; args: readonly string[] }> = [];
  const answers = [...(s.answers ?? [])];
  const run: ToolRun = async (cmd, args, env) => {
    expect(cmd).toBe("npm");
    npm.push({ args: args.join(" "), env });
    const answer = args[0] === "prefix" ? s.prefix : s.install;
    if (answer instanceof Error) throw answer;
    return answer!;
  };
  const relaunch: Relaunch =
    s.relaunch === undefined || s.relaunch === "none"
      ? async (cmd, args) => {
          relaunched.push({ cmd, args });
          return 0;
        }
      : s.relaunch;
  const d: NpxSetupDeps = {
    io: { out: (l) => void out.push(l), err: (l) => void err.push(l), prompt: async (q) => (questions.push(q), answers.shift() ?? "") },
    env: { ...(s.path === undefined ? {} : { PATH: s.path }), ...s.env },
    platform: s.platform,
    homedir: s.homedir,
    version: VERSION,
    wim: "wim" in s ? s.wim : ["/usr/bin/node", "--no-warnings", s.platform === "win32" ? WIN_CACHE : POSIX_CACHE],
    argv: ["setup", "--name=desk", "--"],
    run: s.run === "none" ? undefined : run,
    relaunch: s.relaunch === "none" ? undefined : relaunch,
    writable: async (dir) => !(s.locked ?? []).some((l) => dir.startsWith(l)),
  };
  d.realpath = async (p) => {
    const f = s.files?.[p];
    if (f === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return f;
  };
  const code = await npxSetup(d);
  return { code, out, err, questions, npm, relaunched, said: [...out, ...err].join("\n") };
}

const POSIX_GLOBAL = "/usr/local";
const POSIX_INSTALLED = "/usr/local/lib/node_modules/worldinmotion/wim.mjs";
const WIN_GLOBAL = "C:\\Users\\Ada\\AppData\\Roaming\\npm";
const WIN_INSTALLED = "C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\worldinmotion\\wim.mjs";

describe("npxSetup", () => {
  it("does nothing outside npx's cache, or when it cannot tell where wim runs from", async () => {
    for (const wim of [undefined, ["/usr/bin/node"], ["/usr/bin/node", POSIX_INSTALLED]]) {
      const r = await scene({ platform: "linux", homedir: "/home/ada", wim });
      expect(r.code).toBeUndefined();
      expect(r.said).toBe("");
      expect(r.npm).toEqual([]);
    }
    // The real path decides: a link into the cache is the cache.
    const linked = await scene({ platform: "linux", homedir: "/home/ada", wim: ["/usr/bin/node", "/home/ada/bin/wim"], files: { "/home/ada/bin/wim": POSIX_CACHE }, prefix: ok(POSIX_GLOBAL) });
    expect(linked.said).toContain(`This wim runs from npx's cache (${POSIX_CACHE})`);
  });

  for (const c of [
    { platform: "linux", global: POSIX_GLOBAL, installed: POSIX_INSTALLED, bin: "/usr/local/bin" },
    { platform: "win32", global: WIN_GLOBAL, installed: WIN_INSTALLED, bin: WIN_GLOBAL },
  ]) {
    it(`on ${c.platform}: says so first, installs this exact version globally on y, then runs setup again from the installed copy`, async () => {
      const r = await scene({ platform: c.platform, homedir: "/home/ada", prefix: ok(`${c.global}\n`), install: ok("added 1 package"), files: { [c.installed]: c.installed }, answers: ["y"], path: c.bin });
      expect(r.out[0]).toMatch(/^This wim runs from npx's cache \(.*_npx.*\), which npm prunes/);
      expect(r.questions).toEqual([`Install ${SPEC} globally? It runs: npm install --global ${SPEC} [y/N] `]);
      expect(r.npm).toEqual([
        { args: "prefix --global", env: undefined },
        { args: `install --global ${SPEC}`, env: undefined },
      ]);
      // node and its flags as they were, the installed script, the same setup command line.
      expect(r.relaunched).toEqual([{ cmd: "/usr/bin/node", args: ["--no-warnings", c.installed, "setup", "--name=desk", "--"] }]);
      for (const { args } of r.relaunched) for (const a of args) expect(inNpxCache(a)).toBe(false);
      expect(r.code).toBe(0);
      // Its bin directory is on PATH already: no PATH advice.
      expect(r.said).not.toContain("on PATH");
      expect(r.err).toEqual([]);
    });
  }

  it("takes the global prefix npm hands to what npx runs, before asking npm (whose output hides UUIDs)", async () => {
    const r = await scene({ platform: "linux", homedir: "/home/ada", env: { npm_config_global_prefix: POSIX_GLOBAL }, prefix: ok("/home/***/wrong"), install: ok(), files: { [POSIX_INSTALLED]: POSIX_INSTALLED }, answers: ["y"] });
    expect(r.code).toBe(0);
    expect(r.npm.map((n) => n.args)).toEqual([`install --global ${SPEC}`]);
    expect(r.relaunched[0]!.args).toContain(POSIX_INSTALLED);
    // An empty one is not a prefix: npm is asked.
    const empty = await scene({ platform: "linux", homedir: "/home/ada", env: { npm_config_global_prefix: "" }, prefix: ok(POSIX_GLOBAL), answers: ["n"] });
    expect(empty.npm.map((n) => n.args)).toEqual(["prefix --global"]);
  });

  it("gives back the exit code of the setup it ran again", async () => {
    const r = await scene({ platform: "linux", homedir: "/home/ada", prefix: ok(POSIX_GLOBAL), install: ok(), files: { [POSIX_INSTALLED]: POSIX_INSTALLED }, answers: ["yes"], relaunch: async () => 7, path: "/usr/bin::/usr/local/bin" });
    expect(r.code).toBe(7);
    // An empty PATH entry is no directory: /usr/local/bin is still found.
    expect(r.said).not.toContain("on PATH");
  });

  it("on N, stops with the one install command, installs nothing and runs nothing", async () => {
    const r = await scene({ platform: "linux", homedir: "/home/ada", prefix: ok(POSIX_GLOBAL), answers: ["n"] });
    expect(r.code).toBe(1);
    expect(r.npm.map((n) => n.args)).toEqual(["prefix --global"]);
    expect(r.relaunched).toEqual([]);
    expect(r.err).toEqual([`wim: nothing changed. To install wim at a stable path, run \`npm install --global ${SPEC}\`, then \`wim setup\`.`]);
  });

  for (const c of [
    { platform: "linux", global: "/usr/local", home: "/home/ada", own: "/home/ada/.npm-global", modules: "/home/ada/.npm-global/lib/node_modules", bin: "/home/ada/.npm-global/bin", hint: /add the line {2}export PATH=\/home\/ada\/\.npm-global\/bin:"\$PATH" {2}to your shell's profile/ },
    { platform: "win32", global: "C:\\Program Files\\nodejs", home: "C:\\Users\\Ada Lovelace", own: "C:\\Users\\Ada Lovelace\\.npm-global", modules: "C:\\Users\\Ada Lovelace\\.npm-global\\node_modules", bin: "C:\\Users\\Ada Lovelace\\.npm-global", hint: /add it to your user Path \(Settings/ },
  ]) {
    it(`on ${c.platform}: a global prefix it cannot write gets a prefix of the person's own, never sudo, and the PATH advice`, async () => {
      const installed = (c.platform === "win32" ? win32 : posix).join(c.modules, "worldinmotion", "wim.mjs");
      const r = await scene({ platform: c.platform, homedir: c.home, prefix: ok(c.global), install: ok(), locked: [c.global], files: { [installed]: installed }, answers: ["y"], path: "/usr/bin" });
      const shown = `npm install --global --prefix ${c.own.includes(" ") ? `"${c.own}"` : c.own} ${SPEC}`;
      expect(r.said).toContain(`npm installs globally under ${c.global}, which you cannot write to. Setup never uses sudo.`);
      expect(r.questions).toEqual([`Install it under ${c.own}, a prefix of your own, instead? It runs: ${shown} [y/N] `]);
      expect(c.own.endsWith(USER_PREFIX)).toBe(true);
      // The prefix goes to npm in its environment, never as a shell word.
      expect(r.npm[1]).toEqual({ args: `install --global ${SPEC}`, env: { npm_config_prefix: c.own } });
      expect(r.said).toMatch(c.hint);
      expect(r.said).toContain(`To type \`wim\` in a new terminal, put ${c.bin} on PATH:`);
      expect(r.said).toContain("For later `npm install --global` to use it too: npm config set prefix");
      expect(r.said).not.toMatch(/sudo [a-z]/);
      expect(r.relaunched[0]!.args).toContain(installed);
      expect(r.code).toBe(0);
    });
  }

  it("on N to a prefix of the person's own, prints that install command", async () => {
    const r = await scene({ platform: "linux", homedir: "/home/ada", prefix: ok(POSIX_GLOBAL), locked: [POSIX_GLOBAL], answers: [""] });
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain(`run \`npm install --global --prefix /home/ada/.npm-global ${SPEC}\``);
  });

  it("stops with the command when neither prefix is writable, asking nothing", async () => {
    // The bin directory alone being locked is enough.
    const r = await scene({ platform: "linux", homedir: "/home/ada", prefix: ok(POSIX_GLOBAL), locked: ["/usr/local/bin", "/home/ada"] });
    expect(r.code).toBe(1);
    expect(r.questions).toEqual([]);
    expect(r.said).toContain("/home/ada/.npm-global, the prefix it would offer instead, is not writable either.");
    expect(r.err).toEqual([`wim: nothing changed. To install wim at a stable path, run \`npm install --global ${SPEC}\`, then \`wim setup\`.`]);
  });

  it("stops with the command when it cannot run npm or run setup again", async () => {
    for (const s of [{ run: "none" as const }, { relaunch: "none" as const }]) {
      const r = await scene({ platform: "linux", homedir: "/home/ada", ...s });
      expect(r.code).toBe(1);
      expect(r.questions).toEqual([]);
      expect(r.err[0]).toContain(`\`npm install --global ${SPEC}\``);
    }
  });

  it("stops when npm cannot say where it installs", async () => {
    const failed = await scene({ platform: "linux", homedir: "/home/ada", prefix: { code: 1, stdout: "", stderr: "npm error config\nnpm error bad prefix\n" } });
    expect(failed.code).toBe(1);
    expect(failed.said).toContain("`npm prefix --global` did not work (npm error config / npm error bad prefix).");
    const missing = await scene({ platform: "linux", homedir: "/home/ada", prefix: Object.assign(new Error("npm is not installed"), { code: "ENOENT" }) });
    expect(missing.said).toContain("`npm prefix --global` did not work (npm is not installed).");
    expect(missing.questions).toEqual([]);
  });

  it("stops when the install fails, with npm's last lines or its exit code", async () => {
    const quiet = await scene({ platform: "linux", homedir: "/home/ada", prefix: ok(POSIX_GLOBAL), install: { code: 243, stdout: "", stderr: "" }, answers: ["y"] });
    expect(quiet.code).toBe(1);
    expect(quiet.said).toContain("The install did not work (exit code 243).");
    expect(quiet.relaunched).toEqual([]);
    const thrown = await scene({ platform: "linux", homedir: "/home/ada", prefix: ok(POSIX_GLOBAL), install: new Error("spawn npm ETIMEDOUT"), answers: ["y"] });
    expect(thrown.said).toContain("The install did not work (spawn npm ETIMEDOUT).");
    expect(thrown.err[0]).toContain(`\`npm install --global ${SPEC}\``);
  });

  it("never runs a copy that is not there, or that is in npx's cache too", async () => {
    const gone = await scene({ platform: "linux", homedir: "/home/ada", prefix: ok(POSIX_GLOBAL), install: ok(), answers: ["y"] });
    expect(gone.code).toBe(1);
    expect(gone.said).toContain(`npm said it installed ${SPEC}, but ${POSIX_INSTALLED} is not there.`);
    expect(gone.relaunched).toEqual([]);
    const cached = await scene({ platform: "linux", homedir: "/home/ada", prefix: ok(POSIX_GLOBAL), install: ok(), files: { [POSIX_INSTALLED]: POSIX_CACHE }, answers: ["y"] });
    expect(cached.code).toBe(1);
    expect(cached.said).toContain(`but ${POSIX_CACHE} is in npx's cache too.`);
    expect(cached.relaunched).toEqual([]);
  });

  it("says so when the installed copy cannot be started", async () => {
    const r = await scene({ platform: "linux", homedir: "/home/ada", prefix: ok(POSIX_GLOBAL), install: ok(), files: { [POSIX_INSTALLED]: POSIX_INSTALLED }, answers: ["y"], relaunch: async () => Promise.reject(new Error("spawn EACCES")) });
    expect(r.code).toBe(1);
    expect(r.err).toEqual([`wim: could not run ${POSIX_INSTALLED} (spawn EACCES). Run \`wim setup\` from it yourself.`]);
  });
});

// Through `wim setup` itself, on this machine's real files: a wim in npx's cache, a global prefix
// in the test's home, and an agent (Gemini CLI) on PATH whose config setup would write.
describe("wim setup from npx's cache", () => {
  async function machine() {
    const relay = new RelayHarness();
    const { devices } = await makeMesh(relay, ["solo"]);
    const root = devices[0]!.root;
    const cached = join(root, "npm-cache", "_npx", "6e1b2c", "node_modules", "worldinmotion", "wim.mjs");
    await fs.mkdir(join(cached, ".."), { recursive: true });
    await fs.writeFile(cached, "// wim, in the cache\n");
    const prefix = join(root, "prefix");
    await fs.mkdir(prefix);
    const bin = join(root, "bin");
    await fs.mkdir(bin);
    await fs.writeFile(join(bin, "gemini"), "", { mode: 0o755 });
    const modules = npmLayout(prefix, process.platform).modules;
    const npm: string[] = [];
    const tools: ToolRun = async (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      npm.push(key);
      if (key === "npm prefix --global") return ok(`${prefix}\n`);
      if (key === `npm install --global ${SPEC}`) {
        await fs.mkdir(join(modules, "worldinmotion"), { recursive: true });
        await fs.writeFile(join(modules, "worldinmotion", "wim.mjs"), "// wim, installed\n");
        return ok();
      }
      throw Object.assign(new Error(`${cmd} is not installed`), { code: "ENOENT" });
    };
    const programs = { platform: process.platform, run: async () => ok(), wim: [process.execPath, cached], trust: async () => "ok" };
    const settings = join(root, ".gemini", "settings.json");
    return { relay, root, cached, prefix, bin, modules, npm, tools, programs, settings };
  }

  it("on N, writes no agent config and makes nothing", async () => {
    const m = await machine();
    const relaunched: string[][] = [];
    const t = term(m.root, m.relay, { tools: m.tools, programs: m.programs, relaunch: async (_c, a) => (relaunched.push([...a]), 0) }, { PATH: m.bin });
    t.answers.push("n");
    expect(await run(t, "setup")).toBe(1);
    expect(said(t)).toContain("This wim runs from npx's cache");
    expect(said(t)).toContain(`run \`npm install --global ${SPEC}\`, then \`wim setup\``);
    expect(relaunched).toEqual([]);
    await expect(fs.stat(m.settings)).rejects.toMatchObject({ code: "ENOENT" });
    // It stopped before the other steps, the status included.
    expect(said(t)).not.toContain("Claude Code");
    expect(said(t)).not.toContain("Other agents");
  }, 20_000);

  it("on y, installs, and the setup run from the installed copy writes only the stable path", async () => {
    const m = await machine();
    const children: string[] = [];
    const argvs: string[][] = [];
    // The installed copy's run, in this process: wim as it would start from that path.
    const relaunch: Relaunch = async (cmd, args) => {
      const [script, ...argv] = args;
      argvs.push(argv);
      const child = term(m.root, m.relay, { tools: m.tools, programs: { ...m.programs, wim: [cmd, script!] } }, { PATH: m.bin });
      child.answers.push("y");
      const code = await main(argv, child.env, child.io);
      children.push(said(child));
      return code;
    };
    const t = term(m.root, m.relay, { tools: m.tools, programs: m.programs, relaunch }, { PATH: m.bin });
    t.answers.push("y");
    expect(await run(t, "setup", "--name", "desk")).toBe(0);
    // The same command line, every flag with its value and the code (none here) after `--`.
    expect(argvs).toEqual([["setup", "--name=desk", "--"]]);
    expect(m.npm.slice(0, 2)).toEqual(["npm prefix --global", `npm install --global ${SPEC}`]);
    const installed = await fs.realpath(join(m.modules, "worldinmotion", "wim.mjs"));
    expect(children).toHaveLength(1);
    expect(children[0]).not.toContain("npx's cache");
    const text = await fs.readFile(m.settings, "utf8");
    const server = (JSON.parse(text) as { mcpServers: Record<string, { command: string; args: string[] }> }).mcpServers["worldinmotion"]!;
    expect(server).toMatchObject({ command: process.execPath, args: [installed, "mcp"] });
    // Asserted on the bytes written: no path into the cache, in any form.
    expect(inNpxCache(text)).toBe(false);
    expect(text).not.toContain(JSON.stringify(m.cached).slice(1, -1));
  }, 30_000);
});
