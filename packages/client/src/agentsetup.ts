// `wim setup`'s step for the agents other than Claude Code and VS Code (docs/peers.md, "What
// `wim setup` writes"). For each agent it finds (Codex CLI, Gemini CLI, Antigravity CLI, Cursor,
// Copilot CLI, Claude Desktop) it adds the worldinmotion MCP server, offering only the read-only
// tools where the agent has a tool list, and the agent's `wim hook` entries where it has hooks.
//
// The launch is direct, node and the absolute path to wim.mjs, so `wim mcp` is the agent's own
// child (the hook's session match needs that) and no npx, npm or shell sits in between. Each file
// change is shown as a diff and written only on a typed y, with the original kept beside it. Only
// the worldinmotion server entry and the `wim hook` entries are touched: every other entry stays,
// JSON keeps its key order and indentation, and TOML changes only the worldinmotion lines. A file
// that is a symbolic link, is not a regular file, is larger than 1 MiB, or does not parse is left
// as it is. This runs inside `wim setup`, after `requirePerson`.

import { sanitizeForDisplay } from "@worldinmotion/protocol";
import { constants, promises as fs } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import { noFollow, openNoFollow, realFsEnv, writeAtomic, writeNew } from "./fsx.ts";
import { inNpxCache } from "./npxsetup.ts";
import { pathFor, type Platform } from "./platform.ts";

/** The MCP server's name in every agent's config. */
export const SERVER = "worldinmotion";

/** The tools an agent's tool list offers by default: none of them sends, uploads or changes anything. */
export const READ_ONLY_TOOLS = ["peers", "inbox", "wait", "history"] as const;

/** A config file larger than this is not read. */
export const CONFIG_MAX = 1 << 20;

/** The per-call limit written where an agent has one: above the longest `wait` (300 s). */
const CALL_LIMIT_S = 330;

/** How long a hook may take. */
const HOOK_LIMIT_S = 10;

/** node and the wim.mjs it runs, both absolute. */
export type Launch = { node: string; script: string };

/** What the step needs from `wim setup`. */
export type AgentSetupDeps = {
  io: { out: (line: string) => void; prompt: (question: string) => Promise<string>; signal: AbortSignal };
  env: Record<string, string | undefined>;
  platform: Platform;
  homedir: string;
  /** This device's state directory, which each server entry names as `WIM_HOME`. */
  wimHome: string;
  /** How the agents start `wim`, or why there is no direct launch here. */
  launch: Launch | string;
  /** Whether a command is on PATH (`onPath` in this file). */
  onPath: (command: string) => Promise<boolean>;
  now: () => number;
};

type Ctx = AgentSetupDeps & { launch: Launch; path: ReturnType<typeof pathFor> };

type Json = Record<string, unknown>;

/** How an agent lays out its hook entries. */
type HookShape =
  /** `hooks.<event>` is a list of groups, each with its own `hooks` list (Gemini CLI, Codex). */
  | "grouped"
  /** `hooks.<event>` is the list of entries (Cursor, Copilot CLI). */
  | "flat"
  /** Each top-level key names a hook, which holds `<event>` lists (Antigravity). */
  | "named";

type HookPlan = { shape: HookShape; agent: string; event: string; start: boolean; entry: Json; field: string };

/** One file to change: its path, its format, and the edit (JSON) or the plan (TOML). */
type FilePlan = { path: string } & ({ format: "json"; server?: Json; hooks: HookPlan[]; version?: boolean } | { format: "toml"; server: CodexServer });

type CodexServer = { command: string; args: string[]; home: string; kind: string };

/**
 * How `wim run <name>` starts an agent as an Agent Client Protocol server over stdio (run.ts): the
 * name it takes and the vendor's documented command.
 */
export type AcpCommand = { name: string; command: readonly string[] };

type Agent = {
  title: string;
  /** The `WIM_KIND` its `wim mcp` runs as: a label peers see. */
  kind: string;
  /** Commands whose presence on PATH means it is installed. */
  commands: readonly string[];
  /** Paths whose presence means it is installed. */
  markers: (c: Ctx) => string[];
  files: (c: Ctx, kind: string) => FilePlan[];
  /** Hosted sessions (`wim run`), for an agent that serves ACP. */
  acp?: AcpCommand;
  /** What "read-only" means for this agent. */
  readOnly: string;
  /** What the person still does after a write. */
  after: string;
};

const env = (c: Ctx, kind: string, extra: Json = {}): Json => ({ WIM_HOME: c.wimHome, WIM_KIND: kind, ...extra });

const base = (c: Ctx): { command: string; args: string[] } => ({ command: c.launch.node, args: [c.launch.script, "mcp"] });

/** One argument in a hook's command line, quoted for the shell the agent runs it with. */
function quote(c: Ctx, s: string, powershell = false): string {
  if (powershell) return `'${s.replaceAll("'", "''")}'`;
  if (c.platform === "win32") return `"${s}"`;
  return /^[A-Za-z0-9_/.,:+@%=-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}

/** The hook's command line: node and wim.mjs, then `hook <agent>` (and `start`). */
function hookCommand(c: Ctx, agent: string, start: boolean, powershell = false): string {
  const line = `${quote(c, c.launch.node, powershell)} ${quote(c, c.launch.script, powershell)} hook ${agent}${start ? " start" : ""}`;
  return powershell ? `& ${line}` : line;
}

/** Whether a hook command line runs `wim hook <agent>` (or its `start`): an entry wim owns. */
export function ownsHook(command: unknown, agent: string, start: boolean): boolean {
  return typeof command === "string" && new RegExp(`(?:^|[\\s"'/\\\\])wim(?:\\.mjs)?["']?\\s+hook\\s+${agent}${start ? "\\s+start" : ""}\\s*$`).test(command);
}

const home = (c: Ctx, variable: string, ...parts: string[]): string => c.path.join(c.env[variable] || c.homedir, ...parts);

/** Each agent setup knows, in the order it asks. */
export const AGENTS: readonly Agent[] = [
  {
    title: "Codex CLI",
    kind: "codex",
    commands: ["codex"],
    markers: (c) => [codexHome(c)],
    // The ACP adapter in the ACP organisation, which starts the Codex app server itself.
    acp: { name: "codex", command: ["codex-acp"] },
    files: (c, kind) => {
      const hook = (event: string, start: boolean): HookPlan => ({ shape: "grouped", agent: "codex", event, start, field: "command", entry: { type: "command", command: hookCommand(c, "codex", start), timeout: HOOK_LIMIT_S } });
      return [
        { path: c.path.join(codexHome(c), "config.toml"), format: "toml", server: { ...base(c), home: c.wimHome, kind } },
        { path: c.path.join(codexHome(c), "hooks.json"), format: "json", hooks: [hook("Stop", false), hook("UserPromptSubmit", true)] },
      ];
    },
    readOnly: "`enabled_tools` offers only peers, inbox, wait and history; add send (and reply) to let it message peers",
    after: "Codex runs a new hook only once you trust it: start Codex and review it with /hooks.",
  },
  {
    title: "Gemini CLI",
    kind: "gemini-cli",
    commands: ["gemini"],
    markers: (c) => [home(c, "GEMINI_CLI_HOME", ".gemini", "settings.json")],
    acp: { name: "gemini", command: ["gemini", "--acp"] },
    files: (c, kind) => {
      const hook = (event: string, start: boolean): HookPlan => ({ shape: "grouped", agent: "gemini", event, start, field: "command", entry: { type: "command", command: hookCommand(c, "gemini", start), timeout: HOOK_LIMIT_S * 1000 } });
      return [
        {
          path: home(c, "GEMINI_CLI_HOME", ".gemini", "settings.json"),
          format: "json",
          server: { ...base(c), env: env(c, kind), trust: true, includeTools: [...READ_ONLY_TOOLS], timeout: CALL_LIMIT_S * 1000 },
          hooks: [hook("AfterAgent", false), hook("BeforeAgent", true)],
        },
      ];
    },
    readOnly: "`includeTools` offers only peers, inbox, wait and history, and `trust: true` runs those four without asking; add send (and reply) to let it message peers",
    after: "Start a new Gemini CLI session to load it.",
  },
  {
    title: "Antigravity CLI",
    kind: "antigravity",
    commands: ["agy"],
    markers: (c) => [c.path.join(c.homedir, ".gemini", "antigravity-cli"), c.path.join(c.homedir, ".gemini", "config")],
    // From Antigravity CLI 1.5.0.
    acp: { name: "antigravity", command: ["agy", "acp"] },
    files: (c, kind) => [
      { path: c.path.join(c.homedir, ".gemini", "config", "mcp_config.json"), format: "json", server: { ...base(c), env: env(c, kind), enabledTools: [...READ_ONLY_TOOLS], timeoutSeconds: CALL_LIMIT_S }, hooks: [] },
      // No turn-start entry: `PreInvocation` runs before every model call, not once per turn.
      { path: c.path.join(c.homedir, ".gemini", "config", "hooks.json"), format: "json", hooks: [{ shape: "named", agent: "antigravity", event: "Stop", start: false, field: "command", entry: { type: "command", command: hookCommand(c, "antigravity", false), timeout: HOOK_LIMIT_S } }] },
    ],
    readOnly: "`enabledTools` offers only peers, inbox, wait and history, and Antigravity still asks before each call unless a permission rule allows it (docs/peers.md)",
    after: "Start a new Antigravity session to load it.",
  },
  {
    title: "Cursor",
    kind: "cursor",
    commands: ["cursor-agent", "cursor"],
    markers: (c) => [c.path.join(c.homedir, ".cursor")],
    // The Cursor CLI's own command.
    acp: { name: "cursor", command: ["agent", "acp"] },
    files: (c, kind) => {
      const hook = (event: string, start: boolean): HookPlan => ({ shape: "flat", agent: "cursor", event, start, field: "command", entry: { command: hookCommand(c, "cursor", start), timeout: HOOK_LIMIT_S } });
      return [
        { path: c.path.join(c.homedir, ".cursor", "mcp.json"), format: "json", server: { type: "stdio", ...base(c), env: env(c, kind) }, hooks: [] },
        { path: c.path.join(c.homedir, ".cursor", "hooks.json"), format: "json", hooks: [hook("stop", false), hook("beforeSubmitPrompt", true)], version: true },
      ];
    },
    readOnly: "Cursor has no per-server tool list, so every tool is offered, and Cursor asks before each call unless your run mode allows it",
    after: "Reload Cursor to load it.",
  },
  {
    title: "Copilot CLI",
    kind: "copilot-cli",
    commands: ["copilot"],
    markers: (c) => [copilotHome(c)],
    acp: { name: "copilot", command: ["copilot", "--acp", "--stdio"] },
    files: (c, kind) => {
      const win = c.platform === "win32";
      const field = win ? "powershell" : "bash";
      const hook = (event: string, start: boolean): HookPlan => ({ shape: "flat", agent: "copilot", event, start, field, entry: { type: "command", [field]: hookCommand(c, "copilot", start, win), timeoutSec: HOOK_LIMIT_S } });
      return [
        { path: c.path.join(copilotHome(c), "mcp-config.json"), format: "json", server: { type: "local", ...base(c), env: env(c, kind), tools: [...READ_ONLY_TOOLS], timeout: CALL_LIMIT_S * 1000 }, hooks: [] },
        { path: c.path.join(copilotHome(c), "hooks", "wim.json"), format: "json", hooks: [hook("agentStop", false), hook("userPromptSubmitted", true)], version: true },
      ];
    },
    readOnly: "`tools` offers only peers, inbox, wait and history; add send (and reply) to let it message peers",
    after: "Start a new Copilot CLI session to load it.",
  },
  {
    title: "Claude Desktop",
    kind: "claude-desktop",
    commands: [],
    markers: (c) => [desktopDir(c)],
    // No hooks: Claude Desktop has none, so only the server entry.
    files: (c, kind) => [{ path: c.path.join(desktopDir(c), "claude_desktop_config.json"), format: "json", server: { ...base(c), env: env(c, kind, { WIM_NAME: "desktop" }) }, hooks: [] }],
    readOnly: "Claude Desktop's file has no tool list, so every tool is offered, and it asks before each call unless you choose to always allow one",
    after: "Quit Claude Desktop completely and start it again to load it.",
  },
];

function codexHome(c: Ctx): string {
  return c.env["CODEX_HOME"] || c.path.join(c.homedir, ".codex");
}

function copilotHome(c: Ctx): string {
  return c.env["COPILOT_HOME"] || c.path.join(c.homedir, ".copilot");
}

function desktopDir(c: Ctx): string {
  if (c.platform === "darwin") return c.path.join(c.homedir, "Library", "Application Support", "Claude");
  if (c.platform === "win32") return c.path.join(c.env["APPDATA"] || c.path.join(c.homedir, "AppData", "Roaming"), "Claude");
  return c.path.join(c.env["XDG_CONFIG_HOME"] || c.path.join(c.homedir, ".config"), "Claude");
}

/** A config file setup leaves as it is, and why. */
class Refused extends Error {}

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** `parent[key]` as an object, made when missing; refused when it is something else. */
function objectAt(parent: Json, key: string, where: string): Json {
  if (parent[key] === undefined) parent[key] = {};
  const value = parent[key];
  if (!isObject(value)) throw new Refused(`${where} is not an object`);
  return value;
}

/** `parent[key]` as a list, made when missing; refused when it is something else. */
function listAt(parent: Json, key: string, where: string): unknown[] {
  if (parent[key] === undefined) parent[key] = [];
  const value = parent[key];
  if (!Array.isArray(value)) throw new Refused(`${where} is not a list`);
  return value;
}

/**
 * Adds the server entry, or brings an existing one's launch and `WIM_HOME` up to date. Everything
 * else in an existing entry (a tool the person added, a timeout) stays. Returns what it did.
 */
function editServer(doc: Json, want: Json): string | undefined {
  const servers = objectAt(doc, "mcpServers", "mcpServers");
  const have = servers[SERVER];
  if (have === undefined) {
    servers[SERVER] = want;
    return "adds the worldinmotion MCP server";
  }
  if (!isObject(have)) throw new Refused(`mcpServers.${SERVER} is not an object`);
  const before = structuredClone(have);
  have["command"] = want["command"];
  have["args"] = want["args"];
  objectAt(have, "env", `mcpServers.${SERVER}.env`)["WIM_HOME"] = (want["env"] as Json)["WIM_HOME"];
  return isDeepStrictEqual(before, have) ? undefined : "updates the worldinmotion MCP server's launch";
}

/** The entries in one event's lists (each one an object), and where a new one goes. */
function hookLists(doc: Json, plan: HookPlan): { entries: Json[]; add: () => void } {
  const entries: Json[] = [];
  const objects = (list: unknown[]): Json[] => list.filter(isObject);
  if (plan.shape === "named") {
    for (const value of Object.values(doc)) if (isObject(value) && Array.isArray(value[plan.event])) entries.push(...objects(value[plan.event] as unknown[]));
    return { entries, add: () => void listAt(objectAt(doc, SERVER, SERVER), plan.event, `${SERVER}.${plan.event}`).push(plan.entry) };
  }
  const list = listAt(objectAt(doc, "hooks", "hooks"), plan.event, `hooks.${plan.event}`);
  if (plan.shape === "flat") {
    entries.push(...objects(list));
    return { entries, add: () => void list.push(plan.entry) };
  }
  for (const group of objects(list)) if (Array.isArray(group["hooks"])) entries.push(...objects(group["hooks"]));
  return { entries, add: () => void list.push({ hooks: [plan.entry] }) };
}

/** The command fields a hook entry can carry. */
const COMMAND_FIELDS = ["command", "bash", "powershell"];

/** Adds one `wim hook` entry, or updates the command of each one wim owns. Returns what it did. */
function editHook(doc: Json, plan: HookPlan): string | undefined {
  const { entries, add } = hookLists(doc, plan);
  const want = plan.entry[plan.field];
  const owns = (e: Json, f: string): boolean => ownsHook(e[f], plan.agent, plan.start);
  const mine = entries.filter((e) => COMMAND_FIELDS.some((f) => owns(e, f)));
  if (mine.length === 0) {
    add();
    return `adds the ${plan.event} hook`;
  }
  // Only this machine's field and the cross-platform `command` are updated: a command for the other
  // shell (Copilot CLI's `bash` beside `powershell`) stays, and this shell's field is added beside it.
  let changed = false;
  for (const e of mine) {
    const fields = [...new Set([plan.field, "command"])].filter((f) => owns(e, f));
    for (const f of fields.length === 0 ? [plan.field] : fields) {
      changed ||= e[f] !== want;
      e[f] = want;
    }
  }
  return changed ? `updates the ${plan.event} hook` : undefined;
}

/** The calls that can fail in ways tests need to provoke on every platform; swapped in tests, never in production. */
export const configOps = { lstat: (path: string) => fs.lstat(path), open: openNoFollow, writeNew, writeAtomic };

/** A file as setup read it: its text, its mode, and whether it was there. */
type Read = { text: string; mode: number; exists: boolean };

/**
 * Reads a config file, never through a link. Missing is an empty file that does not exist yet; a
 * link, something other than a regular file, or a file over the cap is refused.
 */
async function readConfig(path: string): Promise<Read> {
  const facts = await configOps.lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw new Refused(`it cannot be read (${error.code})`);
  });
  if (facts === undefined) return { text: "", mode: 0o600, exists: false };
  if (facts.isSymbolicLink()) throw new Refused("it is a symbolic link");
  if (!facts.isFile()) throw new Refused("it is not a regular file");
  if (facts.size > CONFIG_MAX) throw new Refused(`it is larger than ${CONFIG_MAX} bytes`);
  const handle = await configOps.open(path, constants.O_RDONLY | noFollow(constants));
  if (handle === undefined) throw new Refused("it cannot be opened, or it changed while it was read");
  try {
    return { text: await handle.readFile("utf8"), mode: facts.mode & 0o777, exists: true };
  } finally {
    await handle.close();
  }
}

/** The file's indentation: what its first indented line uses, two spaces by default, none for a one-line file. */
function indentOf(text: string): string | number {
  const body = text.trim();
  if (body !== "" && !body.includes("\n")) return 0;
  return /\n([ \t]+)\S/.exec(text)?.[1] ?? 2;
}

/** The new text of a JSON file, and what changed in it; undefined when nothing does. */
function editJson(read: Read, plan: FilePlan & { format: "json" }): { text: string; what: string[] } | undefined {
  const bom = read.text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = read.text.slice(bom.length);
  let doc: unknown;
  try {
    doc = body.trim() === "" ? {} : JSON.parse(body);
  } catch (error) {
    throw new Refused(`it is not valid JSON (${(error as Error).message}); a file with comments is edited by hand`);
  }
  if (!isObject(doc)) throw new Refused("it does not hold a JSON object");
  const what: string[] = [];
  if (plan.version === true && doc["version"] === undefined) doc["version"] = 1;
  if (plan.server !== undefined) what.push(editServer(doc, plan.server) ?? "");
  for (const h of plan.hooks) what.push(editHook(doc, h) ?? "");
  const changed = what.filter((w) => w !== "");
  if (changed.length === 0) return undefined;
  const ending = read.exists && !body.endsWith("\n") ? "" : "\n";
  return { text: `${bom}${JSON.stringify(doc, null, indentOf(body))}${ending}`, what: changed };
}

/** A JSON value with its keys sorted, to compare two parses. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, value: unknown) => (isObject(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))) : value));
}

const tomlLine = (key: string, value: unknown): string => `${key} = ${JSON.stringify(value)}`;
const HEADER = /^\s*\[/;
const header = (suffix: string): RegExp => new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${SERVER}|"${SERVER}"|'${SERVER}')\\s*${suffix}\\]\\s*(?:#.*)?$`);

/**
 * Sets `key` in the table under the header `at`: replaces its line, or adds one after the header.
 * A value over several lines leaves the text wrong, which the check after the edit refuses.
 */
function setKey(lines: string[], at: number, key: string, value: unknown): void {
  let end = lines.findIndex((l, i) => i > at && HEADER.test(l));
  if (end < 0) end = lines.length;
  const i = lines.findIndex((l, j) => j > at && j < end && new RegExp(`^\\s*${key}\\s*=`).test(l));
  if (i >= 0) lines[i] = tomlLine(key, value);
  else lines.splice(at + 1, 0, tomlLine(key, value));
}

/**
 * Codex's config.toml: appends the worldinmotion tables, or rewrites the launch and `WIM_HOME`
 * lines of the ones there. The result must parse to what was meant, the rest of the file
 * unchanged, or the file is refused.
 */
function editToml(read: Read, s: CodexServer): { text: string; what: string[] } | undefined {
  let doc: Json;
  try {
    doc = parseToml(read.text) as Json;
  } catch (error) {
    throw new Refused(`it is not valid TOML (${(error as Error).message.split("\n")[0]!})`);
  }
  const have = objectAt(structuredClone(doc), "mcp_servers", "mcp_servers")[SERVER];
  const want = JSON.parse(canon(doc)) as Json;
  const servers = objectAt(want, "mcp_servers", "mcp_servers");
  let text: string;
  let what: string;
  if (have === undefined) {
    servers[SERVER] = { command: s.command, args: s.args, enabled_tools: [...READ_ONLY_TOOLS], tool_timeout_sec: CALL_LIMIT_S, env: { WIM_HOME: s.home, WIM_KIND: s.kind } };
    const block = [`[mcp_servers.${SERVER}]`, tomlLine("command", s.command), tomlLine("args", s.args), tomlLine("enabled_tools", READ_ONLY_TOOLS), `tool_timeout_sec = ${CALL_LIMIT_S}`, "", `[mcp_servers.${SERVER}.env]`, tomlLine("WIM_HOME", s.home), tomlLine("WIM_KIND", s.kind), ""].join("\n");
    const gap = read.text === "" ? "" : read.text.endsWith("\n\n") ? "" : read.text.endsWith("\n") ? "\n" : "\n\n";
    text = `${read.text}${gap}${block}`;
    what = "adds the worldinmotion MCP server";
  } else {
    if (!isObject(have)) throw new Refused(`mcp_servers.${SERVER} is not a table`);
    const entry = servers[SERVER] as Json;
    entry["command"] = s.command;
    entry["args"] = s.args;
    objectAt(entry, "env", `mcp_servers.${SERVER}.env`)["WIM_HOME"] = s.home;
    if (canon(want) === canon(doc)) return undefined;
    const lines = read.text.split("\n");
    const at = lines.findIndex((l) => header("").test(l));
    if (at < 0) throw new Refused(`mcp_servers.${SERVER} is not written as a [mcp_servers.${SERVER}] table`);
    setKey(lines, at, "command", s.command);
    setKey(lines, at, "args", s.args);
    const envAt = lines.findIndex((l) => header("\\.\\s*env\\s*").test(l));
    if (envAt >= 0) setKey(lines, envAt, "WIM_HOME", s.home);
    else lines.push(`[mcp_servers.${SERVER}.env]`, tomlLine("WIM_HOME", s.home), "");
    text = lines.join("\n");
    what = "updates the worldinmotion MCP server's launch";
  }
  let after: unknown;
  try {
    after = parseToml(text);
  } catch {
    after = undefined;
  }
  if (canon(after) !== canon(want)) throw new Refused(`setup cannot change mcp_servers.${SERVER} in the form it is written in`);
  return { text, what: [what] };
}

/** The changed lines between two texts, with up to two lines of context on each side. */
export function lineDiff(before: string, after: string): string[] {
  const split = (t: string): string[] => (t === "" ? [] : t.replace(/\n$/, "").split("\n"));
  const a = split(before);
  const b = split(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const x = a.slice(start, a.length - end);
  const y = b.slice(start, b.length - end);
  const body: string[] = [];
  if (x.length * y.length > 4_000_000) {
    body.push(...x.map((l) => `- ${l}`), ...y.map((l) => `+ ${l}`));
  } else {
    // The longest common subsequence of the middle, from the end, then walked from the start.
    const n = x.length;
    const m = y.length;
    const t = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i]![j] = x[i] === y[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && x[i] === y[j]) {
        body.push(`  ${x[i++]!}`);
        j++;
      } else if (i < n && (j === m || t[i + 1]![j]! >= t[i]![j + 1]!)) body.push(`- ${x[i++]!}`);
      else body.push(`+ ${y[j++]!}`);
    }
  }
  const context = (lines: string[]): string[] => lines.map((l) => `  ${l}`);
  return [...context(a.slice(Math.max(0, start - 2), start)), ...body, ...context(a.slice(a.length - end, a.length - end + 2))].map((l) => `    ${sanitizeForDisplay(l)}`);
}

/** The path of the copy of the original, beside it. */
function backupPath(path: string, now: number): string {
  return `${path}.wim-backup-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
}

const yes = (answer: string): boolean => /^y(es)?$/i.test(answer.trim());

/**
 * Copies the original to `backup` (when there is one), then writes the new text in its place. A
 * write that fails (a read-only or full disk, no permission) leaves the file as it was, removes a
 * copy made for it, and is refused like a file setup cannot read, so the other agents still run.
 */
async function write(path: string, text: string, read: Read, backup: string | undefined): Promise<void> {
  let copied = false;
  try {
    if (backup !== undefined) {
      await configOps.writeNew(backup, read.text, realFsEnv, read.mode);
      copied = true;
    }
    await configOps.writeAtomic(path, text, realFsEnv, read.mode);
  } catch (error) {
    if (copied) await fs.rm(backup!, { force: true });
    throw new Refused(`it could not be written (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`);
  }
}

type Outcome = "configured" | "written" | "skipped" | "refused";

/** One file: read, edit, show the diff, and on a typed y keep the original beside it and write. */
async function oneFile(c: Ctx, title: string, plan: FilePlan): Promise<Outcome> {
  const { io } = c;
  try {
    const read = await readConfig(plan.path);
    const edit = plan.format === "json" ? editJson(read, plan) : editToml(read, plan.server);
    if (edit === undefined) {
      io.out(`${title}: configured (${plan.path}).`);
      return "configured";
    }
    io.out(`${title}: setup ${edit.what.join(", ")} in ${read.exists ? plan.path : `a new file, ${plan.path}`}:`);
    for (const line of lineDiff(read.text, edit.text)) io.out(line);
    if (!yes(await io.prompt(`Write this change to ${plan.path}? [y/N] `))) {
      io.out(`Skipped: ${plan.path} is unchanged.`);
      return "skipped";
    }
    // The person read the diff of what was there: a file that changed meanwhile is not written.
    if ((await readConfig(plan.path)).text !== read.text) throw new Refused("it changed while the diff was shown; run `wim setup` again");
    const backup = read.exists ? backupPath(plan.path, c.now()) : undefined;
    await write(plan.path, edit.text, read, backup);
    io.out(`Written.${backup === undefined ? "" : ` The original is kept at ${backup}.`}`);
    return "written";
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    io.out(`${title}: ${plan.path} is left as it is: ${sanitizeForDisplay(error.message)}. docs/peers.md shows the entries to add by hand.`);
    return "refused";
  }
}

const present = (path: string): Promise<boolean> => fs.lstat(path).then(() => true, () => false);

/** Whether an agent is installed here: one of its commands on PATH, or one of its files. */
async function found(c: Ctx, agent: Agent): Promise<boolean> {
  for (const command of agent.commands) if (await c.onPath(command)) return true;
  for (const marker of agent.markers(c)) if (await present(marker)) return true;
  return false;
}

/** The step: each agent found, each of its files, in order. */
export async function setupAgents(d: AgentSetupDeps): Promise<void> {
  const { io } = d;
  const c = { ...d, path: pathFor(d.platform) } as Ctx;
  const here: Agent[] = [];
  for (const agent of AGENTS) if (await found(c, agent)) here.push(agent);
  const names = AGENTS.map((a) => a.title).join(", ");
  if (here.length === 0) {
    io.out(`Other agents (${names}): none found here. docs/peers.md shows how to add one by hand.`);
    return;
  }
  if (typeof d.launch === "string") {
    io.out(`Other agents found (${here.map((a) => a.title).join(", ")}), but setup cannot write a direct launch for them: ${d.launch}. docs/peers.md shows the entries to add by hand.`);
    return;
  }
  let hooks = false;
  for (const agent of here) {
    const outcomes: Outcome[] = [];
    for (const plan of agent.files(c, agent.kind)) {
      if (io.signal.aborted) return;
      const outcome = await oneFile(c, agent.title, plan);
      outcomes.push(outcome);
      hooks ||= plan.format === "json" && plan.hooks.length > 0 && (outcome === "written" || outcome === "configured");
    }
    if (outcomes.includes("written") || outcomes.includes("configured")) io.out(`  Read-only by default: ${agent.readOnly}.`);
    if (outcomes.includes("written")) io.out(`  ${agent.after}`);
  }
  // The hooks find the device with the agent's own environment, not the server entry's `env`.
  const moved = ["WIM_HOME", "CLAUDE_CONFIG_DIR"].filter((v) => (d.env[v] ?? "") !== "");
  if (hooks && moved.length > 0) {
    io.out(`Note: ${moved.join(" and ")} ${moved.length === 1 ? "is" : "are"} set in this terminal. The hooks run with each agent's own environment: start the agents with WIM_HOME=${d.wimHome} set, or their hooks look for this device elsewhere and never wake.`);
  }
}

/**
 * How this `wim` starts as an agent's MCP server: this node and the real path of wim.mjs, or why
 * it cannot say (it runs from source, or from a path that is gone).
 */
export async function findLaunch(wim: readonly string[] | undefined): Promise<Launch | string> {
  if (wim === undefined || wim.length < 2) return "this wim cannot tell where it runs from";
  const script = await fs.realpath(wim.at(-1)!).catch(() => undefined);
  if (script === undefined) return `${wim.at(-1)!} cannot be found`;
  if (!/[\\/]wim\.mjs$/.test(script)) return `it runs from ${script}, not from wim.mjs (a source checkout?)`;
  // npx runs from a cache it prunes: an agent config pointing there breaks later, with no word.
  if (inNpxCache(script)) return `it runs from npx's cache (${script}), which npx prunes: install it with \`npm install --global worldinmotion\` and run \`wim setup\` again`;
  return { node: await stableBrewPath(wim[0]!), script: await stableBrewPath(script) };
}

/** A path in Homebrew's Cellar: the prefix, the separator, the formula, and what is under its version's directory. */
const CELLAR = /^(.+)([\\/])Cellar\2([^\\/]+)\2[^\\/]+\2(.+)$/;

/**
 * The form of `path` that lasts across `brew upgrade`. Homebrew keeps each version of a formula
 * under `<prefix>/Cellar/<formula>/<version>/` and removes an old one at cleanup, while
 * `<prefix>/opt/<formula>` always links to the version installed: node and wim under Homebrew both
 * run from the Cellar, so an agent config written with those paths would break at the next upgrade.
 * A Cellar path is given as its `opt` form only when that exists and is the very same file; any
 * other path (npm, nvm, a package manager, a Cellar without its link) is kept as it is.
 */
export async function stableBrewPath(path: string): Promise<string> {
  const m = CELLAR.exec(path);
  if (m === null) return path;
  const [, prefix, sep, formula, rest] = m;
  const opt = [prefix, "opt", formula, rest].join(sep);
  const [here, there] = await Promise.all([fs.realpath(path).catch(() => undefined), fs.realpath(opt).catch(() => undefined)]);
  return here !== undefined && here === there ? opt : path;
}

/** Whether a file with this mode can be run: any execute bit on POSIX; Windows has none, so any file. */
export function runnable(mode: number, platform: Platform): boolean {
  return platform === "win32" || (mode & 0o111) !== 0;
}

/**
 * Whether `command` is an executable file on `PATH` (with `PATHEXT` on Windows). The directories
 * are this machine's, so they are joined with its own separator.
 */
export async function onPath(command: string, env: Record<string, string | undefined>, platform: Platform): Promise<boolean> {
  return (await whichPath(command, env, platform)) !== undefined;
}

/** The file on PATH that runs `command` (with a PATHEXT extension on Windows), or undefined. */
export async function whichPath(command: string, env: Record<string, string | undefined>, platform: Platform): Promise<string | undefined> {
  const win = platform === "win32";
  const exts = win ? ["", ...(env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e !== "")] : [""];
  for (const dir of (env["PATH"] ?? "").split(pathFor(platform).delimiter)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const path = join(dir, command + ext);
      const facts = await fs.stat(path).catch(() => undefined);
      if (facts?.isFile() === true && runnable(facts.mode, platform)) return path;
    }
  }
  return undefined;
}

/** The agents `wim run` can host, in the table's order, with their title and kind. */
export const ACP_AGENTS: ReadonlyArray<AcpCommand & { title: string; kind: string }> = AGENTS.flatMap((a) => (a.acp === undefined ? [] : [{ ...a.acp, title: a.title, kind: a.kind }]));

/** The agent `wim run <name>` names, or undefined. */
export function acpAgent(name: string): (typeof ACP_AGENTS)[number] | undefined {
  return ACP_AGENTS.find((a) => a.name === name);
}
