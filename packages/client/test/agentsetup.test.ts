// `wim setup`'s step for the other agents (agentsetup.ts), against real files in a temporary home:
// per agent, found or not, a fresh write, other entries kept, a rerun, a stale path, the backup, and
// N; the direct-launch rule; hostile files (a link, bad JSON or TOML, a huge file); the diff; and
// the PATH lookup and launch helpers.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { AGENTS, CONFIG_MAX, findLaunch, lineDiff, onPath, ownsHook, READ_ONLY_TOOLS, setupAgents, type AgentSetupDeps } from "../src/agentsetup.ts";
import { scratch } from "./helpers.ts";

type Json = Record<string, unknown>;

/** One agent as the tests see it: how it is found, its files, its hook events. */
type Spec = {
  title: string;
  hook: string;
  command?: string;
  /** Its files, relative to the home directory. */
  files: string[];
  /** The file with the server entry. */
  server: string;
  /** The hook events, turn end first. */
  events: string[];
};

const SPECS: Spec[] = [
  { title: "Codex CLI", hook: "codex", command: "codex", files: [".codex/config.toml", ".codex/hooks.json"], server: ".codex/config.toml", events: ["Stop", "UserPromptSubmit"] },
  { title: "Gemini CLI", hook: "gemini", command: "gemini", files: [".gemini/settings.json"], server: ".gemini/settings.json", events: ["AfterAgent", "BeforeAgent"] },
  { title: "Antigravity CLI", hook: "antigravity", command: "agy", files: [".gemini/config/mcp_config.json", ".gemini/config/hooks.json"], server: ".gemini/config/mcp_config.json", events: ["Stop"] },
  { title: "Cursor", hook: "cursor", command: "cursor-agent", files: [".cursor/mcp.json", ".cursor/hooks.json"], server: ".cursor/mcp.json", events: ["stop", "beforeSubmitPrompt"] },
  { title: "Copilot CLI", hook: "copilot", command: "copilot", files: [".copilot/mcp-config.json", ".copilot/hooks/wim.json"], server: ".copilot/mcp-config.json", events: ["agentStop", "userPromptSubmitted"] },
  { title: "Claude Desktop", hook: "", files: [".config/Claude/claude_desktop_config.json"], server: ".config/Claude/claude_desktop_config.json", events: [] },
];

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const BACKUP_SUFFIX = ".wim-backup-2026-11-07T12-00-00-000Z";

type Run = { out: string[]; questions: string[] };

/** A home directory with wim.mjs in it, and the deps for one run. */
async function homeDir(): Promise<{ home: string; script: string }> {
  const home = await scratch("agents");
  const script = join(home, "lib", "worldinmotion", "wim.mjs");
  await fs.mkdir(join(home, "lib", "worldinmotion"), { recursive: true });
  await fs.writeFile(script, "// wim\n");
  return { home, script };
}

function deps(home: string, script: string, answers: string[], extra: Partial<AgentSetupDeps> & { path?: readonly string[] } = {}): { d: AgentSetupDeps; r: Run } {
  const r: Run = { out: [], questions: [] };
  const onPathSet = new Set(extra.path ?? []);
  const d: AgentSetupDeps = {
    io: {
      out: (l) => void r.out.push(l),
      prompt: async (q) => {
        r.questions.push(q);
        return answers.shift() ?? "";
      },
      signal: new AbortController().signal,
    },
    env: {},
    platform: "linux",
    homedir: home,
    wimHome: join(home, "wim-state"),
    launch: { node: process.execPath, script },
    onPath: async (c) => onPathSet.has(c),
    now: () => NOW,
    ...extra,
  };
  return { d, r };
}

const readJsonFile = async (path: string): Promise<Json> => JSON.parse(await fs.readFile(path, "utf8")) as Json;
const exists = (path: string): Promise<boolean> => fs.lstat(path).then(() => true, () => false);

/** The worldinmotion server entry an agent's file holds. */
async function serverOf(home: string, spec: Spec): Promise<Json> {
  const path = join(home, spec.server);
  const text = await fs.readFile(path, "utf8");
  const doc = (spec.server.endsWith(".toml") ? parseToml(text) : JSON.parse(text)) as Json;
  return ((doc["mcpServers"] ?? doc["mcp_servers"]) as Json)["worldinmotion"] as Json;
}

/** Every string under one of `events` anywhere in the agent's files, by event. */
async function hooksOf(home: string, spec: Spec): Promise<Record<string, string[]>> {
  const found: Record<string, string[]> = {};
  const walk = (v: unknown, event: string | undefined): void => {
    if (typeof v === "string" && event !== undefined && / hook /.test(v)) (found[event] ??= []).push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x, event);
    else if (typeof v === "object" && v !== null) for (const [k, x] of Object.entries(v)) walk(x, spec.events.includes(k) ? k : event);
  };
  for (const f of spec.files.filter((x) => x.endsWith(".json") && x !== spec.server)) if (await exists(join(home, f))) walk(await readJsonFile(join(home, f)), undefined);
  if (spec.server.endsWith(".json") && (await exists(join(home, spec.server)))) walk(await readJsonFile(join(home, spec.server)), undefined);
  return found;
}

const q = (s: string): string => (/^[A-Za-z0-9_/.,:+@%=-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);
const hookLine = (script: string, agent: string, start: boolean): string => `${q(process.execPath)} ${q(script)} hook ${agent}${start ? " start" : ""}`;

/** Marks an agent as installed by its command, or by its directory for Claude Desktop. */
async function install(home: string, spec: Spec): Promise<string[]> {
  if (spec.command !== undefined) return [spec.command];
  await fs.mkdir(join(home, ".config", "Claude"), { recursive: true });
  return [];
}

describe("wim setup: other agents, per agent", () => {
  for (const spec of SPECS) {
    describe(spec.title, () => {
      it("is not found without its command or files, and found with either", async () => {
        const { home, script } = await homeDir();
        const none = deps(home, script, []);
        await setupAgents(none.d);
        expect(none.r.out).toEqual([`Other agents (${AGENTS.map((a) => a.title).join(", ")}): none found here. docs/peers.md shows how to add one by hand.`]);
        const path = await install(home, spec);
        const one = deps(home, script, [], { path });
        await setupAgents(one.d);
        expect(one.r.out.every((l) => !l.includes(":") || l.startsWith(`${spec.title}:`) || l.startsWith("    ") || l.startsWith("Skipped"))).toBe(true);
        expect(one.r.questions).toEqual(spec.files.map((f) => `Write this change to ${join(home, f)}? [y/N] `));
        for (const f of spec.files) expect(await exists(join(home, f))).toBe(false);
      });

      it("writes fresh files on y: a direct launch, the read-only tools, and both hook entries", async () => {
        const { home, script } = await homeDir();
        const path = await install(home, spec);
        const { d, r } = deps(home, script, spec.files.map(() => "y"), { path });
        await setupAgents(d);
        expect(r.out.filter((l) => l === "Written.")).toHaveLength(spec.files.length);
        expect(r.out.some((l) => l.startsWith("  Read-only by default: "))).toBe(true);
        const server = await serverOf(home, spec);
        // The direct-launch rule: this node and the absolute wim.mjs, never npx, npm, a shell or wim.cmd.
        expect(server["command"]).toBe(process.execPath);
        expect(server["args"]).toEqual([script, "mcp"]);
        expect(JSON.stringify(server)).not.toMatch(/npx|npm exec|wim\.cmd|\/bin\/sh|bash -c/);
        expect((server["env"] as Json)["WIM_HOME"]).toBe(join(home, "wim-state"));
        const tools = server["includeTools"] ?? server["enabledTools"] ?? server["enabled_tools"] ?? server["tools"];
        if (spec.title === "Cursor" || spec.title === "Claude Desktop") expect(tools).toBeUndefined();
        else expect(tools).toEqual([...READ_ONLY_TOOLS]);
        const hooks = await hooksOf(home, spec);
        expect(Object.keys(hooks).sort()).toEqual([...spec.events].sort());
        spec.events.forEach((e, i) => expect(hooks[e]).toEqual([hookLine(script, spec.hook, i === 1)]));
        for (const f of spec.files) expect(await exists(`${join(home, f)}${BACKUP_SUFFIX}`)).toBe(false);
        for (const f of spec.files) expect(((await fs.stat(join(home, f))).mode & 0o777).toString(8)).toBe("600");
      });

      it("keeps other entries and the file's indentation, backs up the original, and a rerun is configured", async () => {
        const { home, script } = await homeDir();
        const path = await install(home, spec);
        const originals = new Map<string, string>();
        for (const f of spec.files) {
          const text = f.endsWith(".toml")
            ? '# my settings\nmodel = "o5"\n\n[mcp_servers.other]\ncommand = "other-server"\n'
            : JSON.stringify({ theme: "dark", mcpServers: { other: { command: "other-server" } }, hooks: Object.fromEntries(spec.events.map((e) => [e, [{ command: "my-own-hook" }]])), mine: { Stop: [{ command: "x" }] } }, null, 4) + "\n";
          await fs.mkdir(join(home, f, ".."), { recursive: true });
          await fs.writeFile(join(home, f), text, { mode: 0o640 });
          originals.set(f, text);
        }
        const first = deps(home, script, spec.files.map(() => "y"), { path });
        await setupAgents(first.d);
        for (const f of spec.files) {
          const text = await fs.readFile(join(home, f), "utf8");
          expect(await fs.readFile(`${join(home, f)}${BACKUP_SUFFIX}`, "utf8")).toBe(originals.get(f));
          expect(((await fs.stat(join(home, f))).mode & 0o777).toString(8)).toBe("640");
          expect(first.r.out).toContain(`Written. The original is kept at ${join(home, f)}${BACKUP_SUFFIX}.`);
          if (f.endsWith(".toml")) {
            expect(text.startsWith(originals.get(f)!)).toBe(true);
            continue;
          }
          expect(text).toMatch(/^\{\n {4}"theme": "dark",\n/);
          const doc = JSON.parse(text) as Json;
          expect((doc["mcpServers"] as Json)["other"]).toEqual({ command: "other-server" });
          expect(doc["mine"]).toEqual({ Stop: [{ command: "x" }] });
          for (const e of spec.events.filter(() => f !== spec.server || spec.title === "Gemini CLI")) expect(JSON.stringify((doc["hooks"] as Json)[e])).toContain("my-own-hook");
        }
        const again = deps(home, script, [], { path });
        await setupAgents(again.d);
        expect(again.r.questions).toEqual([]);
        expect(again.r.out.filter((l) => l.endsWith(").") && l.includes(": configured ("))).toHaveLength(spec.files.length);
      });

      it("offers a stale path as an update, keeping what the person added to the entry", async () => {
        const { home, script } = await homeDir();
        const path = await install(home, spec);
        const old = "/opt/old/wim.mjs";
        for (const f of spec.files) {
          await fs.mkdir(join(home, f, ".."), { recursive: true });
          if (f.endsWith(".toml")) {
            await fs.writeFile(join(home, f), `[mcp_servers.worldinmotion]\ncommand = "node"\nargs = ["${old}", "mcp"]\nenabled_tools = ["peers", "send"]\n\n[mcp_servers.worldinmotion.env]\nWIM_KIND = "codex"\n`);
            continue;
          }
          const server = f === spec.server ? { mcpServers: { worldinmotion: { command: "npx", args: ["worldinmotion", "mcp"], env: { WIM_NAME: "mine" }, extra: true } } } : {};
          const commands = spec.events.map((e, i) => [e, `node ${old} hook ${spec.hook}${i === 1 ? " start" : ""}`] as const);
          const hooks =
            f === spec.server && spec.title !== "Gemini CLI"
              ? {}
              : spec.title === "Antigravity CLI"
                ? { mine: { Stop: [{ type: "command", command: commands[0]![1], timeout: 3 }] } }
                : spec.title === "Cursor" || spec.title === "Copilot CLI"
                  ? { version: 1, hooks: Object.fromEntries(commands.map(([e, c]) => [e, [{ [spec.title === "Cursor" ? "command" : "bash"]: c, timeout: 3 }]])) }
                  : { hooks: Object.fromEntries(commands.map(([e, c]) => [e, [{ hooks: [{ type: "command", command: c, timeout: 3 }] }]])) };
          await fs.writeFile(join(home, f), JSON.stringify({ ...server, ...hooks }, null, 2) + "\n");
        }
        const { d, r } = deps(home, script, spec.files.map(() => "y"), { path });
        await setupAgents(d);
        expect(r.out.some((l) => / updates the /.test(l))).toBe(true);
        const server = await serverOf(home, spec);
        expect(server["command"]).toBe(process.execPath);
        expect(server["args"]).toEqual([script, "mcp"]);
        expect((server["env"] as Json)["WIM_HOME"]).toBe(join(home, "wim-state"));
        if (spec.server.endsWith(".toml")) expect(server["enabled_tools"]).toEqual(["peers", "send"]);
        else expect(server["extra"]).toBe(true);
        const hooks = await hooksOf(home, spec);
        spec.events.forEach((e, i) => expect(hooks[e]).toEqual([hookLine(script, spec.hook, i === 1)]));
        if (spec.title === "Antigravity CLI") expect(Object.keys(await readJsonFile(join(home, spec.files[1]!)))).toEqual(["mine"]);
        // Updated in place: the timeout the person chose stays.
        if (spec.events.length > 0) expect(await fs.readFile(join(home, spec.files.at(-1)!), "utf8")).toContain('"timeout": 3');
      });

      it("changes nothing on N", async () => {
        const { home, script } = await homeDir();
        const path = await install(home, spec);
        const f = spec.files[0]!;
        await fs.mkdir(join(home, f, ".."), { recursive: true });
        const text = f.endsWith(".toml") ? 'model = "o5"\n' : '{ "theme": "dark" }\n';
        await fs.writeFile(join(home, f), text);
        const { d, r } = deps(home, script, ["n", "no"], { path });
        await setupAgents(d);
        expect(r.out).toContain(`Skipped: ${join(home, f)} is unchanged.`);
        expect(await fs.readFile(join(home, f), "utf8")).toBe(text);
        expect((await fs.readdir(join(home, f, ".."))).filter((n) => n.includes("wim-backup"))).toEqual([]);
        for (const other of spec.files.slice(1)) expect(await exists(join(home, other))).toBe(false);
        expect(r.out.some((l) => l.startsWith("  Read-only"))).toBe(false);
      });
    });
  }
});

describe("wim setup: other agents, hostile and odd files", () => {
  /** One run against Gemini CLI's settings.json (or Codex's config.toml), written as `text`. */
  async function against(text: string | undefined, file = ".gemini/settings.json", answers = ["y"], more: (path: string) => Promise<void> = async () => undefined): Promise<{ out: string[]; path: string; home: string; script: string }> {
    const { home, script } = await homeDir();
    const path = join(home, file);
    await fs.mkdir(join(path, ".."), { recursive: true });
    if (text !== undefined) await fs.writeFile(path, text);
    await more(path);
    const { d, r } = deps(home, script, answers, { path: [file.startsWith(".codex") ? "codex" : "gemini"] });
    // Codex's hooks.json is answered no: only config.toml matters here.
    await setupAgents(d);
    return { out: r.out, path, home, script };
  }
  const refusedFor = (out: string[], path: string): string | undefined => out.find((l) => l.includes(`${path} is left as it is: `))?.split(" is left as it is: ")[1];

  it("refuses a symbolic link, a directory, a huge file and one it cannot open", async () => {
    const link = await against(undefined, ".gemini/settings.json", ["y"], async (path) => {
      await fs.writeFile(`${path}.real`, "{}");
      await fs.symlink(`${path}.real`, path);
    });
    expect(refusedFor(link.out, link.path)).toBe("it is a symbolic link. docs/peers.md shows the entries to add by hand.");
    expect(await fs.readFile(`${link.path}.real`, "utf8")).toBe("{}");
    const dir = await against(undefined, ".gemini/settings.json", ["y"], (path) => fs.mkdir(path));
    expect(refusedFor(dir.out, dir.path)).toMatch(/^it is not a regular file\./);
    const huge = await against(`{"a":"${"x".repeat(CONFIG_MAX)}"}`);
    expect(refusedFor(huge.out, huge.path)).toMatch(/^it is larger than 1048576 bytes\./);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const locked = await against("{}", ".gemini/settings.json", ["y"], (path) => fs.chmod(path, 0));
      expect(refusedFor(locked.out, locked.path)).toMatch(/^it cannot be opened/);
    }
  });

  it("refuses a parent directory it cannot read", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const { home, script } = await homeDir();
    await fs.mkdir(join(home, ".gemini"));
    await fs.chmod(join(home, ".gemini"), 0);
    const { d, r } = deps(home, script, ["y"], { path: ["gemini"] });
    await setupAgents(d);
    await fs.chmod(join(home, ".gemini"), 0o700);
    expect(refusedFor(r.out, join(home, ".gemini", "settings.json"))).toMatch(/^it cannot be read \(EACCES\)\./);
  });

  it("refuses JSON that does not parse or has the wrong shape", async () => {
    const cases: Array<[string, RegExp]> = [
      ['{ // a comment\n "a": 1 }', /^it is not valid JSON \(.*\); a file with comments is edited by hand\./],
      ["[1, 2]", /^it does not hold a JSON object\./],
      ['{"mcpServers": []}', /^mcpServers is not an object\./],
      ['{"mcpServers": {"worldinmotion": "x"}}', /^mcpServers\.worldinmotion is not an object\./],
      ['{"mcpServers": {"worldinmotion": {"env": 5}}}', /^mcpServers\.worldinmotion\.env is not an object\./],
      ['{"hooks": 5}', /^hooks is not an object\./],
      ['{"hooks": {"AfterAgent": {}}}', /^hooks\.AfterAgent is not a list\./],
    ];
    for (const [text, why] of cases) {
      const r = await against(text);
      expect(refusedFor(r.out, r.path), text).toMatch(why);
      expect(await fs.readFile(r.path, "utf8")).toBe(text);
    }
    const named = await (async () => {
      const { home, script } = await homeDir();
      const path = join(home, ".gemini", "config", "hooks.json");
      await fs.mkdir(join(path, ".."), { recursive: true });
      await fs.writeFile(path, '{"worldinmotion": 5}');
      const { d, r } = deps(home, script, ["n", "y"], { path: ["agy"] });
      await setupAgents(d);
      return refusedFor(r.out, path);
    })();
    expect(named).toMatch(/^worldinmotion is not an object\./);
  });

  it("refuses TOML that does not parse, and forms of the entry it does not edit", async () => {
    const cases: Array<[string, RegExp]> = [
      ["model = \n", /^it is not valid TOML \(/],
      ["mcp_servers = 5\n", /^mcp_servers is not an object\./],
      ["[mcp_servers]\nworldinmotion = 5\n", /^mcp_servers\.worldinmotion is not a table\./],
      // An inline table cannot take a new table, nor be edited line by line.
      ['mcp_servers = { other = { command = "x" } }\n', /^setup cannot change mcp_servers\.worldinmotion in the form it is written in\./],
      ['[mcp_servers]\nworldinmotion = { command = "node", args = ["/old/wim.mjs", "mcp"] }\n', /^mcp_servers\.worldinmotion is not written as a \[mcp_servers\.worldinmotion\] table\./],
      // An args list over several lines.
      ['[mcp_servers.worldinmotion]\ncommand = "node"\nargs = [\n  "/old/wim.mjs",\n  "mcp",\n]\n', /^setup cannot change mcp_servers\.worldinmotion in the form it is written in\./],
    ];
    for (const [text, why] of cases) {
      const r = await against(text, ".codex/config.toml", ["y", "n"]);
      expect(refusedFor(r.out, r.path), text).toMatch(why);
      expect(await fs.readFile(r.path, "utf8")).toBe(text);
    }
  });

  it("edits TOML line by line: a quoted header, missing keys, an env table with or without WIM_HOME, and any file ending", async () => {
    const run = async (text: string): Promise<{ text: string; server: Json; script: string }> => {
      const r = await against(text, ".codex/config.toml", ["y", "n"]);
      const after = await fs.readFile(r.path, "utf8");
      return { text: after, server: ((parseToml(after) as Json)["mcp_servers"] as Json)["worldinmotion"] as Json, script: r.script };
    };
    const quoted = await run('[mcp_servers."worldinmotion"] # mine\nstartup_timeout_sec = 20\n\n[mcp_servers.worldinmotion.env]\nWIM_KIND = "codex"\n\n[other]\na = 1\n');
    expect(quoted.server).toEqual({ command: process.execPath, args: [quoted.script, "mcp"], startup_timeout_sec: 20, env: { WIM_KIND: "codex", WIM_HOME: expect.any(String) as unknown } });
    expect(quoted.text).toContain("\n[other]\na = 1\n");
    const withHome = await run('[mcp_servers.worldinmotion]\ncommand = "node"\nargs = ["/old/wim.mjs", "mcp"]\n[mcp_servers.worldinmotion.env]\nWIM_HOME = "/old/state"\n');
    expect((withHome.server["env"] as Json)["WIM_HOME"]).not.toBe("/old/state");
    expect(withHome.text.match(/WIM_HOME/g)).toHaveLength(1);
    for (const ending of ["", "model = 1", "model = 1\n", "model = 1\n\n"]) {
      const fresh = await run(ending);
      expect(fresh.text.startsWith(ending)).toBe(true);
      expect(fresh.text).toMatch(/(^|[^\n]\n\n)\[mcp_servers\.worldinmotion\]\n/);
      expect(fresh.server["tool_timeout_sec"]).toBe(330);
    }
  });

  it("keeps a byte order mark, a one-line file, tabs, a missing final newline, and an empty file", async () => {
    const bom = await against('\uFEFF{"a": 1}');
    expect((await fs.readFile(bom.path, "utf8")).startsWith('\uFEFF{"a":1,"mcpServers":{')).toBe(true);
    const tabs = await against('{\n\t"a": 1\n}');
    const text = await fs.readFile(tabs.path, "utf8");
    expect(text.startsWith('{\n\t"a": 1,\n\t"mcpServers"')).toBe(true);
    expect(text.endsWith("}")).toBe(true);
    const empty = await against("");
    expect(Object.keys(await readJsonFile(empty.path))).toEqual(["mcpServers", "hooks"]);
    expect(empty.out).toContain(`Written. The original is kept at ${empty.path}${BACKUP_SUFFIX}.`);
  });

  it("updates every stale copy of a hook entry it owns, skips entries it cannot read, and leaves others alone", async () => {
    const stale = (start: boolean): Json => ({ type: "command", command: `node /old/wim.mjs hook gemini${start ? " start" : ""}` });
    const doc = { hooks: { AfterAgent: [5, { matcher: "x" }, { hooks: [7, stale(false), { command: "other" }] }, { hooks: [stale(false)] }], BeforeAgent: [{ hooks: [stale(true)] }] } };
    const r = await against(JSON.stringify(doc));
    const after = (await readJsonFile(r.path))["hooks"] as Record<string, unknown[]>;
    const line = hookLine(r.script, "gemini", false);
    expect(after["AfterAgent"]).toEqual([5, { matcher: "x" }, { hooks: [7, { type: "command", command: line }, { command: "other" }] }, { hooks: [{ type: "command", command: line }] }]);
    // Copilot CLI: an entry with only the cross-platform `command` field is owned too.
    const { home, script } = await homeDir();
    const hooks = join(home, ".copilot", "hooks", "wim.json");
    await fs.mkdir(join(hooks, ".."), { recursive: true });
    await fs.writeFile(hooks, JSON.stringify({ version: 2, hooks: { agentStop: [{ command: "node /old/wim.mjs hook copilot" }] } }));
    const { d } = deps(home, script, ["n", "y"], { path: ["copilot"] });
    await setupAgents(d);
    const copilot = await readJsonFile(hooks);
    expect(copilot["version"]).toBe(2);
    expect((copilot["hooks"] as Record<string, Json[]>)["agentStop"]).toEqual([{ command: hookLine(script, "copilot", false) }]);
  });

  it("writes nothing when the file changed while the diff was shown", async () => {
    const { home, script } = await homeDir();
    const path = join(home, ".gemini", "settings.json");
    await fs.mkdir(join(path, ".."), { recursive: true });
    await fs.writeFile(path, "{}");
    const { d, r } = deps(home, script, []);
    d.onPath = async (c) => c === "gemini";
    d.io.prompt = async () => {
      await fs.writeFile(path, '{"changed": true}');
      return "y";
    };
    await setupAgents(d);
    expect(refusedFor(r.out, path)).toBe("it changed while the diff was shown; run `wim setup` again. docs/peers.md shows the entries to add by hand.");
    expect(await fs.readFile(path, "utf8")).toBe('{"changed": true}');
  });

  it("passes on an error that is not about the file", async () => {
    const { home, script } = await homeDir();
    const { d } = deps(home, script, ["y"], { path: ["gemini"] });
    // The clock fails when the backup is named: not a reason about the file, so it is not caught.
    d.now = () => {
      throw new Error("clock broke");
    };
    const path = join(home, ".gemini", "settings.json");
    await fs.mkdir(join(path, ".."), { recursive: true });
    await fs.writeFile(path, "{}");
    await expect(setupAgents(d)).rejects.toThrow("clock broke");
  });
});

describe("wim setup: other agents, the step around the files", () => {
  it("names the agents it found when it cannot write a direct launch", async () => {
    const { home, script } = await homeDir();
    const { d, r } = deps(home, script, [], { path: ["gemini", "copilot"], launch: "it runs from /src/bin.ts, not from wim.mjs (a source checkout?)" });
    await setupAgents(d);
    expect(r.out).toEqual(["Other agents found (Gemini CLI, Copilot CLI), but setup cannot write a direct launch for them: it runs from /src/bin.ts, not from wim.mjs (a source checkout?). docs/peers.md shows the entries to add by hand."]);
  });

  it("stops at Ctrl-C, before the next file", async () => {
    const { home, script } = await homeDir();
    const stop = new AbortController();
    const { d, r } = deps(home, script, [], { path: ["codex", "gemini"] });
    d.io = { ...d.io, signal: stop.signal, prompt: async (question) => (r.questions.push(question), stop.abort(), "") };
    await setupAgents(d);
    expect(r.questions).toHaveLength(1);
  });

  it("says when the hooks may look for the device elsewhere", async () => {
    for (const [env, said] of [
      [{ WIM_HOME: "/x" }, "Note: WIM_HOME is set in this terminal."],
      [{ WIM_HOME: "/x", CLAUDE_CONFIG_DIR: "/c" }, "Note: WIM_HOME and CLAUDE_CONFIG_DIR are set in this terminal."],
    ] as const) {
      const { home, script } = await homeDir();
      const { d, r } = deps(home, script, ["y"], { path: ["gemini"], env });
      await setupAgents(d);
      expect(r.out.at(-1)!.startsWith(said)).toBe(true);
      expect(r.out.at(-1)).toContain(`start the agents with WIM_HOME=${join(home, "wim-state")} set`);
    }
    // Claude Desktop has no hooks: no note.
    const { home, script } = await homeDir();
    await fs.mkdir(join(home, ".config", "Claude"), { recursive: true });
    const { d, r } = deps(home, script, ["y"], { env: { WIM_HOME: "/x" } });
    await setupAgents(d);
    expect(r.out.some((l) => l.startsWith("Note:"))).toBe(false);
  });

  it("uses each agent's home variables, and the macOS and Windows places", async () => {
    const { home, script } = await homeDir();
    const env = { GEMINI_CLI_HOME: join(home, "g"), CODEX_HOME: join(home, "cx"), COPILOT_HOME: join(home, "cp"), XDG_CONFIG_HOME: join(home, "xdg") };
    await fs.mkdir(join(home, "xdg", "Claude"), { recursive: true });
    const { d, r } = deps(home, script, [], { path: ["codex", "gemini", "copilot"], env });
    await setupAgents(d);
    expect(r.questions).toEqual([
      `Write this change to ${join(home, "cx", "config.toml")}? [y/N] `,
      `Write this change to ${join(home, "cx", "hooks.json")}? [y/N] `,
      `Write this change to ${join(home, "g", ".gemini", "settings.json")}? [y/N] `,
      `Write this change to ${join(home, "cp", "mcp-config.json")}? [y/N] `,
      `Write this change to ${join(home, "cp", "hooks", "wim.json")}? [y/N] `,
      `Write this change to ${join(home, "xdg", "Claude", "claude_desktop_config.json")}? [y/N] `,
    ]);
    const mac = await homeDir();
    await fs.mkdir(join(mac.home, "Library", "Application Support", "Claude"), { recursive: true });
    const m = deps(mac.home, mac.script, ["y"], { platform: "darwin" });
    await setupAgents(m.d);
    expect(m.r.questions).toEqual([`Write this change to ${join(mac.home, "Library", "Application Support", "Claude", "claude_desktop_config.json")}? [y/N] `]);
    // Windows: node and wim.mjs in double quotes, PowerShell's call operator for Copilot CLI. Only
    // the diffs are read (every answer is no), since these paths do not exist here.
    for (const appdata of ["C:\\Users\\me\\AppData\\Roaming", undefined]) {
      const w = deps("C:\\Users\\me", "C:\\Program Files\\wim\\wim.mjs", [], { platform: "win32", path: ["gemini", "copilot"], launch: { node: "C:\\Program Files\\nodejs\\node.exe", script: "C:\\Program Files\\wim\\wim.mjs" }, env: appdata === undefined ? {} : { APPDATA: appdata } });
      await setupAgents(w.d);
      const said = w.r.out.join("\n");
      expect(said).toContain(`"command": ${JSON.stringify('"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\wim\\wim.mjs" hook gemini')},`);
      expect(said).toContain(`"powershell": ${JSON.stringify("& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Program Files\\wim\\wim.mjs' hook copilot")},`);
      expect(w.r.questions[0]).toBe("Write this change to C:\\Users\\me\\.gemini\\settings.json? [y/N] ");
    }
  });

  it("quotes a path with spaces or quotes for the POSIX shell", async () => {
    const { home } = await homeDir();
    const script = join(home, "it's here", "wim.mjs");
    await fs.mkdir(join(script, ".."), { recursive: true });
    await fs.writeFile(script, "");
    const { d } = deps(home, script, ["y"], { path: ["gemini"] });
    await setupAgents(d);
    const hooks = (await readJsonFile(join(home, ".gemini", "settings.json")))["hooks"] as Record<string, Array<{ hooks: Json[] }>>;
    expect(hooks["AfterAgent"]![0]!.hooks[0]!["command"]).toBe(`${q(process.execPath)} '${join(home, "it'\\''s here", "wim.mjs")}' hook gemini`);
    expect(ownsHook(hooks["AfterAgent"]![0]!.hooks[0]!["command"], "gemini", false)).toBe(true);
  });
});

describe("wim setup: other agents, helpers", () => {
  it("owns only `wim hook <agent>` lines, start and end apart", () => {
    expect(ownsHook("node /p/wim.mjs hook gemini", "gemini", false)).toBe(true);
    expect(ownsHook("wim hook gemini start", "gemini", true)).toBe(true);
    expect(ownsHook('"C:\\x\\wim.mjs" hook codex', "codex", false)).toBe(true);
    expect(ownsHook("node /p/wim.mjs hook gemini start", "gemini", false)).toBe(false);
    expect(ownsHook("node /p/wim.mjs hook gemini", "gemini", true)).toBe(false);
    expect(ownsHook("node /p/notwim.mjs hook gemini", "gemini", false)).toBe(false);
    expect(ownsHook("node /p/wim.mjs hook gemini; rm -rf ~", "gemini", false)).toBe(false);
    expect(ownsHook(5, "gemini", false)).toBe(false);
  });

  it("shows the change with two lines of context, and a whole change when it is too large to compare", () => {
    expect(lineDiff("a\nb\nc\nd\ne\nf\n", "a\nb\nc\nX\ne\nf\n")).toEqual(["      b", "      c", "    - d", "    + X", "      e", "      f"]);
    expect(lineDiff("", "x\n")).toEqual(["    + x"]);
    expect(lineDiff("a\nb\nc", "a\nc\nd")).toEqual(["      a", "    - b", "      c", "    + d"]);
    expect(lineDiff("p\n\u001b[2J\n", "p\n")).toEqual(["      p", "    - <U+001B>[2J"]);
    const big = Array.from({ length: 2001 }, (_, i) => `l${i}`);
    const diff = lineDiff(big.join("\n"), big.map((l) => `${l}!`).join("\n"));
    expect(diff).toHaveLength(4002);
    expect(diff[0]).toBe("    - l0");
    expect(diff[2001]).toBe("    + l0!");
  });

  it("finds a command on PATH: executable files only, with PATHEXT on Windows", async () => {
    const dir = await scratch("onpath");
    await fs.writeFile(join(dir, "tool"), "", { mode: 0o755 });
    await fs.writeFile(join(dir, "plain"), "", { mode: 0o644 });
    await fs.mkdir(join(dir, "folder"));
    await fs.writeFile(join(dir, "win.CMD"), "");
    const env = { PATH: `:${join(dir, "none")}:${dir}` };
    expect(await onPath("tool", env, "linux")).toBe(true);
    expect(await onPath("plain", env, "linux")).toBe(false);
    expect(await onPath("folder", env, "linux")).toBe(false);
    expect(await onPath("tool", {}, "linux")).toBe(false);
    expect(await onPath("win", { PATH: dir }, "win32")).toBe(true);
    expect(await onPath("win", { PATH: dir, PATHEXT: ".EXE" }, "win32")).toBe(false);
    expect(await onPath("plain", { PATH: `${dir};`, PATHEXT: ";.EXE" }, "win32")).toBe(true);
  });

  it("finds the launch: this node and the real wim.mjs behind a link", async () => {
    const { home, script } = await homeDir();
    await fs.mkdir(join(home, "bin"));
    await fs.symlink(script, join(home, "bin", "wim"));
    expect(await findLaunch(["/usr/bin/node", join(home, "bin", "wim")])).toEqual({ node: "/usr/bin/node", script: await fs.realpath(script) });
    expect(await findLaunch(undefined)).toBe("this wim cannot tell where it runs from");
    expect(await findLaunch(["/usr/bin/node"])).toBe("this wim cannot tell where it runs from");
    expect(await findLaunch(["/usr/bin/node", join(home, "gone.mjs")])).toBe(`${join(home, "gone.mjs")} cannot be found`);
    await fs.writeFile(join(home, "bin.ts"), "");
    expect(await findLaunch(["/usr/bin/node", join(home, "bin.ts")])).toBe(`it runs from ${await fs.realpath(join(home, "bin.ts"))}, not from wim.mjs (a source checkout?)`);
  });
});
