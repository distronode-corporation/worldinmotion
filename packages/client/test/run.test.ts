import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ulid } from "@worldinmotion/protocol";
import { describe, expect, it } from "vitest";
import { acpAgent } from "../src/agentsetup.ts";
import { MeshFiles } from "../src/mesh.ts";
import { CANCEL_MS, EXIT_MS, OPEN_TRIES, POLL_MS, runHosted, type RunOptions } from "../src/run.ts";
import { SessionKeys } from "../src/session.ts";
import { itemName, type SpoolItem } from "../src/spool.ts";
import { wakeText } from "../src/wake.ts";
import { Clock, FakeAgent, transcript, type Msg, type Step } from "./acp-fake.ts";
import { FS, LIVE_PID, scratch } from "./helpers.ts";

const SELF = "dev-self";
const TRUSTED = "dev-trusted";
const HELD = "dev-held";
const KEY = "k1";
/** A turn mark: what a turn end writes. */
const MARK = /^idle [0-9]+$/;

type World = { root: string; mesh: MeshFiles; meshDir: string };

/** A state directory with one mesh, by hand: the runner reads files only. */
async function world(): Promise<World> {
  const root = await scratch("w2a-run");
  const meshDir = join(root, "meshes", "m1");
  await fs.mkdir(join(meshDir, "sessions"), { recursive: true });
  const config = { v: 1, mesh: "m1", relay: "ws://127.0.0.1:4444", device: SELF, pin: { seq: 1, hash: "h" }, policy: { [TRUSTED]: "deliver", [HELD]: "hold" } };
  await fs.writeFile(join(meshDir, "mesh.json"), JSON.stringify(config));
  return { root, mesh: new MeshFiles(meshDir, FS), meshDir };
}

/** The session the agent's `wim mcp` opened under the run's key, held by a live process. */
async function opened(w: World, holder = LIVE_PID, key = KEY): Promise<string> {
  const sid = ulid();
  const dir = join(w.meshDir, "sessions", sid);
  await fs.mkdir(join(dir, "spool"), { recursive: true });
  await fs.writeFile(join(dir, "live.lock"), String(holder));
  await new SessionKeys(w.mesh, FS, Date.now).remember(`key:run:${key}`, sid, "resume");
  return dir;
}

let cursorSeq = 0;
async function item(dir: string, fields: Partial<SpoolItem> = {}): Promise<void> {
  const cursor = ++cursorSeq;
  const full = { cursor, kind: "msg", from: "peer@laptop", device: TRUSTED, id: ulid(), at: 1, rendered: "framed text", ...fields };
  await fs.writeFile(join(dir, "spool", itemName(cursor)), JSON.stringify(full));
}

const presence = (dir: string): Promise<string> => fs.readFile(join(dir, "presence"), "utf8").catch(() => "(none)");

/** A pid that no process holds now: one that ran and exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid!;
}

type Run = { done: Promise<number>; clock: Clock; stop: AbortController; out: string[]; err: string[] };

function start(w: World, fake: FakeAgent, extra: Partial<RunOptions> = {}): Run {
  const clock = new Clock();
  const stop = new AbortController();
  const out: string[] = [];
  const err: string[] = [];
  const done = runHosted({
    agent: acpAgent("gemini")!,
    start: () => fake,
    mesh: w.mesh,
    meshId: "m1",
    home: w.root,
    wim: ["/usr/bin/node", "/opt/wim/wim.mjs"],
    fsEnv: FS,
    cwd: "/home/user/project",
    now: Date.now,
    delay: clock.delay,
    signal: stop.signal,
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
    debug: false,
    version: "0.0.0-test",
    key: KEY,
    ...extra,
  });
  return { done, clock, stop, out, err };
}

const INIT_RESULT = { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };

/** initialize and session/new, answered. */
const SETUP: Step[] = [
  { from: "client", method: "initialize" },
  { from: "agent", reply: "initialize", result: INIT_RESULT },
  { from: "client", method: "session/new" },
  { from: "agent", reply: "session/new", result: { sessionId: "s1" } },
];

const prompt = (label?: string): Step[] => [...(label === undefined ? [] : [{ from: "test", wait: label } as Step]), { from: "client", method: "session/prompt" }];
const stopWith = (stopReason: string): Step => ({ from: "agent", reply: "session/prompt", result: { stopReason } });
const update = (u: Record<string, unknown>): Step => ({ from: "agent", message: { method: "session/update", params: { sessionId: "s1", update: u } } });
const permission = (id: number | string, params: unknown): Step => ({ from: "agent", message: { id, method: "session/request_permission", params } });
const option = (optionId: string, kind: string) => ({ optionId, name: optionId, kind });

/** A request wim answers: everything the agent sent before it has been read once its answer arrives. */
const SYNC: Step[] = [permission("sync", { toolCall: { toolCallId: "none" }, options: [] }), { from: "client", response: "sync" }];

/** The text of a session/prompt wim sent. */
const promptText = (m: Msg): string => ((m.params!["prompt"] as Array<{ text: string }>)[0]!).text;

/** Lets one idle check pass with a new trusted message waiting, then the transcript go on at `label`. */
async function wakeAt(r: Run, fake: FakeAgent, dir: string, label: string, fields: Partial<SpoolItem> = {}): Promise<void> {
  await fake.reached(label);
  await r.clock.waiting(POLL_MS);
  await item(dir, fields);
  r.clock.fire(POLL_MS);
  fake.go(label);
}

/** Gives the runner every chance to send something it should not, without a timer. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("wim run: each agent's documented ACP session", () => {
  const AGENTS = [
    ["gemini-cli", "gemini", "run_shell_command"],
    ["antigravity", "antigravity", "run_command"],
    ["cursor", "cursor", "shell"],
    ["copilot", "copilot", "bash"],
    ["codex", "codex", "exec_command"],
  ] as const;

  for (const [fixture, name, tool] of AGENTS) {
    it(`${name}: no capability offered, the worldinmotion server with the run's key, one wake with the fixed line, the permission refused with reject_once`, async () => {
      const w = await world();
      const dir = await opened(w);
      const fake = new FakeAgent();
      const agent = acpAgent(name)!;
      const r = start(w, fake, { agent });
      const played = fake.play(transcript(fixture, "wake.documented.json").steps);
      await wakeAt(r, fake, dir, "idle");
      await played;
      await r.clock.waiting(POLL_MS);

      const init = fake.sent("initialize").params!;
      expect(init["protocolVersion"]).toBe(1);
      expect(init["clientCapabilities"]).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
      expect(fake.sent("session/new").params).toEqual({
        cwd: "/home/user/project",
        mcpServers: [
          {
            name: "worldinmotion",
            command: "/usr/bin/node",
            args: ["/opt/wim/wim.mjs", "mcp"],
            env: [
              { name: "WIM_HOME", value: w.root },
              { name: "WIM_MESH", value: "m1" },
              { name: "WIM_KIND", value: agent.kind },
              { name: "WIM_SESSION_KEY", value: `run:${KEY}` },
            ],
          },
        ],
      });
      // No session mode, no other method: only what the transcript expects was sent.
      expect(fake.received.map((m) => m.method ?? `response ${String(m.id)}`)).toEqual(["initialize", "session/new", "session/prompt", "response perm-1"]);
      expect(fake.sent("session/prompt").params).toEqual({ sessionId: `${fixture}-session-1`, prompt: [{ type: "text", text: wakeText(1) }] });
      expect(fake.received[3]!.result).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } });
      // The person is told which tool, by its name only: never its title or input.
      expect(r.err.join("\n")).toContain(`refused ${agent.title}'s request to use \`${tool}\``);
      expect(r.err.join("\n")).not.toContain("rm -rf");
      expect(r.out).toContain("Reading the inbox.");
      expect(r.out).toContain("One message: a peer asked for a build.");
      expect(await presence(dir)).toMatch(MARK);

      r.stop.abort();
      expect(await r.done).toBe(0);
      expect(fake.kills).toBe(0);
      expect(fake.unread()).toEqual([]);
    });
  }
});

describe("wim run: waking", () => {
  it("one prompt at a time: busy-mesh before every wake, items during a turn announced at its end, nothing new is not announced again", async () => {
    const w = await world();
    const dir = await opened(w);
    const fake = new FakeAgent();
    const r = start(w, fake);
    const played = fake.play([...SETUP, ...prompt("idle"), { from: "test", wait: "turn1" }, stopWith("end_turn"), ...prompt(), { from: "test", wait: "turn2" }, stopWith("end_turn")]);
    await wakeAt(r, fake, dir, "idle");
    await fake.reached("turn1");
    expect(await presence(dir)).toBe("busy-mesh");
    expect(promptText(fake.sent("session/prompt"))).toBe(wakeText(1));
    await item(dir);
    await item(dir, { kind: "notice", device: "", watched: TRUSTED });
    await item(dir, { device: HELD });
    await settle();
    expect(fake.unread()).toEqual([]);
    expect(fake.received.filter((m) => m.method === "session/prompt")).toHaveLength(1);
    // The turn ends; the next prompt follows at once, with no idle wait in between.
    fake.go("turn1");
    await fake.reached("turn2");
    expect(await presence(dir)).toBe("busy-mesh");
    expect(promptText(fake.sent("session/prompt", 1))).toBe(wakeText(2, 1));
    fake.go("turn2");
    await played;
    await r.clock.waiting(POLL_MS);
    expect(await presence(dir)).toMatch(MARK);
    // The same unread items: announced already, so no third prompt.
    await r.clock.tick(POLL_MS);
    await r.clock.waiting(POLL_MS);
    expect(fake.unread()).toEqual([]);
    r.stop.abort();
    expect(await r.done).toBe(0);
  });

  it("asks for no turn when the busy-mesh mark cannot be written, and does once it can", async () => {
    const w = await world();
    const dir = await opened(w);
    const fake = new FakeAgent();
    const r = start(w, fake, { debug: true });
    const played = fake.play([...SETUP, ...prompt(), stopWith("end_turn")]);
    await r.clock.waiting(POLL_MS);
    await fs.mkdir(join(dir, "presence"));
    await item(dir);
    await r.clock.tick(POLL_MS);
    await r.clock.waiting(POLL_MS);
    expect(r.err.some((l) => l.startsWith("wim run: no wake: cannot mark the turn a mesh turn"))).toBe(true);
    expect(fake.received.map((m) => m.method)).toEqual(["initialize", "session/new"]);
    await fs.rmdir(join(dir, "presence"));
    r.clock.fire(POLL_MS);
    await played;
    expect(promptText(fake.sent("session/prompt"))).toBe(wakeText(1));
    r.stop.abort();
    expect(await r.done).toBe(0);
  });

  it("wakes for nothing until the agent's wim mcp has opened its session under the key, and only while it runs", async () => {
    const w = await world();
    const fake = new FakeAgent();
    const r = start(w, fake, { debug: true });
    const played = fake.play([...SETUP, ...prompt(), stopWith("end_turn")]);
    await r.clock.waiting(POLL_MS);
    expect(r.err).toContain("wim run: no wake: the agent's wim mcp has not opened its session yet");
    const dir = await opened(w, await deadPid());
    await item(dir);
    await r.clock.tick(POLL_MS);
    await r.clock.waiting(POLL_MS);
    expect(r.err).toContain("wim run: no wake: the session's wim mcp is not running");
    expect(r.err).not.toContain("wim run: no wake: nothing waiting");
    await fs.writeFile(join(dir, "live.lock"), String(LIVE_PID));
    r.clock.fire(POLL_MS);
    await played;
    r.stop.abort();
    expect(await r.done).toBe(0);
  });

  it("any doubt means no wake: a mesh config that cannot be read", async () => {
    const w = await world();
    const dir = await opened(w);
    await fs.rm(join(w.meshDir, "mesh.json"));
    await item(dir);
    const fake = new FakeAgent();
    const r = start(w, fake, { debug: true });
    await fake.play(SETUP);
    await r.clock.waiting(POLL_MS);
    expect(r.err.some((l) => l.startsWith("wim run: no wake: cannot tell:"))).toBe(true);
    expect(await presence(dir)).toBe("(none)");
    r.stop.abort();
    expect(await r.done).toBe(0);
  });

  it("the person's --prompt is the first turn, marked busy, not busy-mesh", async () => {
    const w = await world();
    const dir = await opened(w);
    const fake = new FakeAgent();
    const r = start(w, fake, { prompt: "Say hello." });
    const played = fake.play([...SETUP, ...prompt(), { from: "test", wait: "person" }, stopWith("end_turn")]);
    await fake.reached("person");
    expect(await presence(dir)).toBe("busy");
    expect(promptText(fake.sent("session/prompt"))).toBe("Say hello.");
    fake.go("person");
    await played;
    await r.clock.waiting(POLL_MS);
    expect(await presence(dir)).toMatch(MARK);
    r.stop.abort();
    expect(await r.done).toBe(0);
  });

  it("the person's first turn waits for the session to open, and is marked busy once it has", async () => {
    const w = await world();
    const fake = new FakeAgent();
    const r = start(w, fake, { prompt: "Say hello." });
    const played = fake.play([...SETUP, ...prompt(), { from: "test", wait: "person" }, stopWith("end_turn")]);
    await r.clock.tick(POLL_MS);
    await r.clock.waiting(POLL_MS);
    const dir = await opened(w);
    r.clock.fire(POLL_MS);
    await fake.reached("person");
    expect(await presence(dir)).toBe("busy");
    fake.go("person");
    await played;
    r.stop.abort();
    expect(await r.done).toBe(0);
  });

  it("Ctrl-C while the first turn waits for the session: no prompt", async () => {
    const w = await world();
    const fake = new FakeAgent();
    const r = start(w, fake, { prompt: "Say hello." });
    await fake.play(SETUP);
    await r.clock.waiting(POLL_MS);
    r.stop.abort();
    expect(await r.done).toBe(0);
    expect(fake.received.map((m) => m.method)).toEqual(["initialize", "session/new"]);
  });

  it("the person's first turn runs unmarked when the session never opens", async () => {
    const w = await world();
    const fake = new FakeAgent();
    const r = start(w, fake, { prompt: "Say hello.", debug: true });
    const played = fake.play([...SETUP, ...prompt(), stopWith("end_turn")]);
    for (let i = 0; i < OPEN_TRIES; i++) await r.clock.tick(POLL_MS);
    await played;
    await r.clock.waiting(POLL_MS);
    expect(r.err.filter((l) => l === "wim run: presence not written: the agent's wim mcp has not opened its session yet")).toHaveLength(2);
    r.stop.abort();
    expect(await r.done).toBe(0);
  });

  it("the person's first turn when the session map cannot be read writes no presence, and wakes for nothing", async () => {
    const w = await world();
    await fs.writeFile(w.mesh.keysDir, "not a directory");
    const fake = new FakeAgent();
    const r = start(w, fake, { prompt: "Say hello.", debug: true });
    const played = fake.play([...SETUP, ...prompt(), stopWith("end_turn")]);
    for (let i = 0; i < OPEN_TRIES; i++) await r.clock.tick(POLL_MS);
    await played;
    await r.clock.waiting(POLL_MS);
    expect(r.err.filter((l) => l.startsWith("wim run: presence not written: cannot tell:"))).toHaveLength(2);
    expect(r.err.some((l) => l.startsWith("wim run: no wake: cannot tell:"))).toBe(true);
    r.stop.abort();
    expect(await r.done).toBe(0);
  });

  it("a turn mark that cannot be written is only reported", async () => {
    const w = await world();
    const dir = await opened(w);
    const fake = new FakeAgent();
    const r = start(w, fake, { debug: true });
    const played = fake.play([...SETUP, ...prompt("idle"), { from: "test", wait: "turn" }, stopWith("end_turn")]);
    await wakeAt(r, fake, dir, "idle");
    await fake.reached("turn");
    await fs.rm(join(dir, "presence"));
    await fs.mkdir(join(dir, "presence"));
    fake.go("turn");
    await played;
    await r.clock.waiting(POLL_MS);
    expect(r.err.some((l) => l.startsWith("wim run: presence not written:"))).toBe(true);
    r.stop.abort();
    expect(await r.done).toBe(0);
  });

  it("each stop reason ends the turn with a turn mark; any but end_turn is reported", async () => {
    const w = await world();
    const dir = await opened(w);
    const fake = new FakeAgent();
    const r = start(w, fake);
    const ends: Step[] = [
      stopWith("max_tokens"),
      stopWith("max_turn_requests"),
      stopWith("refusal"),
      stopWith("_vendor_reason"),
      { from: "agent", reply: "session/prompt", error: { code: -32603, message: "boom\u001b[31m" } },
      { from: "agent", reply: "session/prompt", result: { stop: true } },
      stopWith("end_turn"),
    ];
    const played = fake.play([...SETUP, ...ends.flatMap((end, i) => [...prompt(`t${i}`), end])]);
    for (let i = 0; i < ends.length; i++) {
      await wakeAt(r, fake, dir, `t${i}`);
      await r.clock.waiting(POLL_MS);
      expect(await presence(dir)).toMatch(MARK);
    }
    await played;
    expect(r.err).toEqual([
      "wim run: the turn ended: max_tokens",
      "wim run: the turn ended: max_turn_requests",
      "wim run: the turn ended: refusal",
      "wim run: the turn ended: with a stop reason ACP does not define",
      "wim run: the turn ended with an error: Gemini CLI answered with error -32603: boom<U+001B>[31m",
      "wim run: the turn ended with an error: the agent's session/prompt answer is not what ACP describes",
    ]);
    r.stop.abort();
    expect(await r.done).toBe(0);
  });

  it("a Ctrl-C between the busy-mesh mark and the prompt ends the mesh turn without asking for it", async () => {
    const w = await world();
    const dir = await opened(w);
    await item(dir);
    const fake = new FakeAgent();
    const stop = new AbortController();
    let calls = 0;
    // The wake check reads the clock once, before it marks the session: Ctrl-C lands there.
    const r = start(w, fake, { signal: stop.signal, now: () => (++calls === 1 ? (stop.abort(), Date.now()) : Date.now()) });
    await fake.play(SETUP);
    expect(await r.done).toBe(0);
    expect(await presence(dir)).toMatch(MARK);
    expect(fake.unread()).toEqual([]);
  });
});

describe("wim run: permission requests", () => {
  it("with no reject_once option: the turn is cancelled, then the request answered cancelled; never an allow", async () => {
    const w = await world();
    const dir = await opened(w);
    const fake = new FakeAgent();
    const r = start(w, fake);
    const played = fake.play([
      ...SETUP,
      ...prompt("idle"),
      permission(7, { sessionId: "s1", toolCall: { toolCallId: "c1", kind: "edit", title: "Edit /etc/hosts" }, options: [option("yes", "allow_once"), option("always", "allow_always"), option("never", "reject_always")] }),
      { from: "client", method: "session/cancel" },
      { from: "client", response: 7 },
      stopWith("cancelled"),
    ]);
    await wakeAt(r, fake, dir, "idle");
    await played;
    await r.clock.waiting(POLL_MS);
    expect(fake.sent("session/cancel").params).toEqual({ sessionId: "s1" });
    expect(fake.matched.at(-1)!.result).toEqual({ outcome: { outcome: "cancelled" } });
    expect(r.err).toEqual([expect.stringContaining("refused Gemini CLI's request to use a tool of kind edit."), "wim run: the turn ended: cancelled"]);
    expect(await presence(dir)).toMatch(MARK);
    r.stop.abort();
    expect(await r.done).toBe(0);
  });

  it("outside a turn, or unreadable: answered cancelled with no session/cancel; the tool named from its earlier tool call, else not at all", async () => {
    const w = await world();
    const fake = new FakeAgent();
    const r = start(w, fake);
    await fake.play([
      ...SETUP,
      update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Read", name: "read_file", kind: "read" }),
      update({ sessionUpdate: "tool_call", toolCallId: "c2", title: "x", name: "has spaces\u001b" }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "c3", kind: "fetch" }),
      update({ sessionUpdate: "tool_call", title: "no id" }),
      permission("a", "garbage"),
      { from: "client", response: "a" },
      permission("b", { sessionId: "s1", toolCall: { toolCallId: "c1" }, options: [option("ok", "allow_once")] }),
      { from: "client", response: "b" },
      permission("c", { sessionId: "s1", toolCall: { toolCallId: "c2" }, options: [] }),
      { from: "client", response: "c" },
      permission("d", { sessionId: "s1", toolCall: { toolCallId: "c3" }, options: [option("no", "reject_once")] }),
      { from: "client", response: "d" },
    ]);
    expect(fake.matched.slice(-4).map((m) => m.result)).toEqual([
      { outcome: { outcome: "cancelled" } },
      { outcome: { outcome: "cancelled" } },
      { outcome: { outcome: "cancelled" } },
      { outcome: { outcome: "selected", optionId: "no" } },
    ]);
    expect(r.err.map((l) => /request to use (.*?)\. A hosted/.exec(l)![1])).toEqual(["a tool", "`read_file`", "a tool", "a tool of kind fetch"]);
    r.stop.abort();
    expect(await r.done).toBe(0);
  });

  it("keeps the names of at most 1024 tool calls", async () => {
    const w = await world();
    const fake = new FakeAgent();
    const r = start(w, fake);
    const calls = Array.from({ length: 1025 }, (_, i) => update({ sessionUpdate: "tool_call", toolCallId: `c${i}`, name: `tool_${i}` }));
    await fake.play([
      ...SETUP,
      ...calls,
      permission("first", { toolCall: { toolCallId: "c0" }, options: [] }),
      { from: "client", response: "first" },
      permission("last", { toolCall: { toolCallId: "c1024" }, options: [] }),
      { from: "client", response: "last" },
    ]);
    expect(r.err.map((l) => /request to use (.*?)\. A hosted/.exec(l)![1])).toEqual(["a tool", "`tool_1024`"]);
    r.stop.abort();
    expect(await r.done).toBe(0);
  });

  it("offers no client method: a file system or terminal request is answered method not found", async () => {
    const w = await world();
    const fake = new FakeAgent();
    const r = start(w, fake, { debug: true });
    await fake.play([
      ...SETUP,
      { from: "agent", message: { id: 9, method: "fs/read_text_file", params: { sessionId: "s1", path: "/etc/passwd" } } },
      { from: "client", response: 9 },
      { from: "agent", message: { id: 10, method: "terminal/create", params: { sessionId: "s1", command: "sh" } } },
      { from: "client", response: 10 },
    ]);
    expect(fake.matched.slice(-2).map((m) => m.error?.code)).toEqual([-32601, -32601]);
    // A line that is not JSON-RPC is skipped, and said with WIM_DEBUG=1.
    fake.stdout.write("Loaded cached credentials.\n");
    await fake.play(SYNC);
    expect(r.err).toContain("wim run: the agent wrote a line that is not JSON; skipped");
    expect(r.err).toContain('wim run: answered the agent\'s fs/read_text_file request with "method not found": a hosted session offers no client methods');
    r.stop.abort();
    expect(await r.done).toBe(0);
  });
});

describe("wim run: what the agent shows", () => {
  it("shows reply text line by line, escaped; ignores other updates and notifications", async () => {
    const w = await world();
    const fake = new FakeAgent();
    const r = start(w, fake);
    const chunk = (text: unknown): Step => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    await fake.play([
      ...SETUP,
      chunk("one\ntwo \u001b[2J"),
      chunk("still two\nthree"),
      update({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "x" } }),
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "secret thought" } }),
      update({ sessionUpdate: "plan", entries: [] }),
      { from: "agent", message: { method: "session/update", params: "nonsense" } },
      { from: "agent", message: { method: "something/else", params: {} } },
      chunk("x".repeat(64 * 1024 + 1)),
      ...SYNC,
    ]);
    const shown = r.out.filter((l) => !l.startsWith("wim run:"));
    expect(shown).toEqual(["one", "two <U+001B>[2Jstill two", `three${"x".repeat(64 * 1024 + 1)}`]);
    expect(r.out.join("\n")).not.toContain("secret thought");
    r.stop.abort();
    expect(await r.done).toBe(0);
  });

  it("a reply left without its line end is shown when the run ends", async () => {
    const w = await world();
    const fake = new FakeAgent();
    const r = start(w, fake);
    await fake.play([...SETUP, update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "half a line" } }), ...SYNC]);
    r.stop.abort();
    expect(await r.done).toBe(0);
    expect(r.out.at(-1)).toBe("half a line");
  });
});

describe("wim run: stopping", () => {
  it("Ctrl-C during a turn sends session/cancel; the cancelled turn ends quietly with a turn mark, and the agent is closed", async () => {
    const w = await world();
    const dir = await opened(w);
    const fake = new FakeAgent();
    const r = start(w, fake);
    const played = fake.play([...SETUP, ...prompt("idle"), { from: "test", wait: "abort" }, { from: "client", method: "session/cancel" }, stopWith("cancelled")]);
    await wakeAt(r, fake, dir, "idle");
    await fake.reached("abort");
    r.stop.abort();
    fake.go("abort");
    await played;
    expect(await r.done).toBe(0);
    expect(r.err).toEqual([]);
    expect(await presence(dir)).toMatch(MARK);
    expect(fake.stdin.writableEnded).toBe(true);
    expect(fake.kills).toBe(0);
    expect(await fake.exited).toBe("exit code 0");
  });

  it("an agent that does not end a cancelled turn in time is killed", async () => {
    const w = await world();
    const dir = await opened(w);
    const fake = new FakeAgent();
    const r = start(w, fake);
    const played = fake.play([...SETUP, ...prompt("idle"), { from: "test", wait: "abort" }, { from: "client", method: "session/cancel" }]);
    await wakeAt(r, fake, dir, "idle");
    await fake.reached("abort");
    r.stop.abort();
    fake.go("abort");
    await played;
    await r.clock.tick(CANCEL_MS);
    expect(await r.done).toBe(0);
    expect(fake.kills).toBe(1);
    expect(r.err).toEqual(["wim run: Gemini CLI did not end the cancelled turn within 5 seconds, so wim stopped it"]);
    expect(await presence(dir)).toMatch(MARK);
  });

  it("a cancelled turn that ends in time is not killed when the cancel timer fires later", async () => {
    const w = await world();
    const dir = await opened(w);
    const fake = new FakeAgent();
    const r = start(w, fake);
    const played = fake.play([...SETUP, ...prompt("idle"), { from: "test", wait: "abort" }, { from: "client", method: "session/cancel" }, stopWith("cancelled")]);
    await wakeAt(r, fake, dir, "idle");
    await fake.reached("abort");
    r.stop.abort();
    fake.go("abort");
    await played;
    expect(await r.done).toBe(0);
    r.clock.fire(CANCEL_MS);
    await settle();
    expect(fake.kills).toBe(0);
  });

  it("Ctrl-C while it starts: an agent that ignores its closed input is killed, and waited for at most twice", async () => {
    const w = await world();
    const fake = new FakeAgent();
    fake.exitOnEof = false;
    fake.exitOnKill = false;
    const r = start(w, fake);
    await fake.play([{ from: "client", method: "initialize" }]);
    r.stop.abort();
    await r.clock.tick(EXIT_MS);
    await r.clock.tick(EXIT_MS);
    expect(await r.done).toBe(0);
    expect(fake.kills).toBe(1);
  });

  it("an agent that exits when killed is not waited for again", async () => {
    const w = await world();
    const fake = new FakeAgent();
    fake.exitOnEof = false;
    const r = start(w, fake);
    await fake.play([{ from: "client", method: "initialize" }]);
    r.stop.abort();
    await r.clock.tick(EXIT_MS);
    expect(await r.done).toBe(0);
    expect(fake.kills).toBe(1);
  });

  it("Ctrl-C before it started sends nothing", async () => {
    const w = await world();
    const fake = new FakeAgent();
    const stop = new AbortController();
    stop.abort();
    const r = start(w, fake, { signal: stop.signal });
    expect(await r.done).toBe(0);
    expect(fake.received).toEqual([]);
  });
});

describe("wim run: the agent ends or refuses", () => {
  it("an agent that exits by itself: exit 1, how, and its last 20 lines on stderr, escaped", async () => {
    const w = await world();
    const fake = new FakeAgent();
    const r = start(w, fake, { debug: true });
    await fake.play(SETUP);
    await r.clock.waiting(POLL_MS);
    const lines = Array.from({ length: 21 }, (_, i) => `line ${i}`);
    fake.stderr.write(`${lines.join("\n")}\r\n`);
    fake.stderr.write("last \u001b[31m");
    await settle();
    fake.quit("exit code 3");
    expect(await r.done).toBe(1);
    const at = r.err.indexOf("wim run: Gemini CLI ended its ACP connection (exit code 3). Its last lines on stderr:");
    expect(at).toBeGreaterThan(-1);
    expect(r.err.slice(at + 1)).toEqual([...lines.slice(2).map((l) => `  ${l}`), "  last <U+001B>[31m"]);
    // With WIM_DEBUG=1 each line is shown as it comes.
    expect(r.err).toContain("gemini: line 0");
  });

  it("an agent that exits with nothing on stderr", async () => {
    const w = await world();
    const fake = new FakeAgent();
    const r = start(w, fake);
    await fake.play(SETUP);
    await r.clock.waiting(POLL_MS);
    fake.quit("exit code 0");
    expect(await r.done).toBe(1);
    expect(r.err).toEqual(["wim run: Gemini CLI ended its ACP connection (exit code 0)."]);
  });

  it("an agent that exits while it starts", async () => {
    const w = await world();
    const fake = new FakeAgent();
    const r = start(w, fake);
    await fake.play([{ from: "client", method: "initialize" }]);
    fake.quit("signal SIGKILL");
    expect(await r.done).toBe(1);
    expect(r.err).toEqual(["wim run: Gemini CLI ended its ACP connection (signal SIGKILL)."]);
  });

  it("an agent that closes its output but keeps running is said to, then killed", async () => {
    const w = await world();
    const fake = new FakeAgent();
    fake.exitOnEof = false;
    const r = start(w, fake);
    await fake.play(SETUP);
    await r.clock.waiting(POLL_MS);
    fake.stdout.end();
    await r.clock.tick(EXIT_MS);
    await r.clock.tick(EXIT_MS);
    expect(await r.done).toBe(1);
    expect(r.err).toEqual(["wim run: Gemini CLI ended its ACP connection (it is still running)."]);
    expect(fake.kills).toBe(1);
  });

  it("an agent that dies during a turn ends the run", async () => {
    const w = await world();
    const dir = await opened(w);
    const fake = new FakeAgent();
    const r = start(w, fake);
    const setup = fake.play([...SETUP, { from: "test", wait: "idle" }]);
    await wakeAt(r, fake, dir, "idle");
    await setup;
    await fake.play([{ from: "client", method: "session/prompt" }]);
    fake.quit("exit code 1");
    expect(await r.done).toBe(1);
    expect(r.err).toEqual(["wim run: Gemini CLI ended its ACP connection (exit code 1)."]);
    expect(await presence(dir)).toMatch(MARK);
  });

  const refusals: Array<[string, Step[], string]> = [
    ["another ACP version", [{ from: "client", method: "initialize" }, { from: "agent", reply: "initialize", result: { protocolVersion: 2 } }], "wim run: Gemini CLI speaks ACP version 2; wim run speaks version 1"],
    ["a malformed initialize answer", [{ from: "client", method: "initialize" }, { from: "agent", reply: "initialize", result: "ok" }], "wim run: the agent's initialize answer is not what ACP describes"],
    ["a sign-in first", [...SETUP.slice(0, 3), { from: "agent", reply: "session/new", error: { code: -32000, message: "Authentication required" } }], "wim run: Gemini CLI asks you to sign in first: run `gemini` yourself, sign in, then run wim run again"],
    ["any other error", [...SETUP.slice(0, 3), { from: "agent", reply: "session/new", error: { code: -32602, message: "bad cwd" } }], "wim run: Gemini CLI answered with error -32602: bad cwd"],
    ["no session id", [...SETUP.slice(0, 3), { from: "agent", reply: "session/new", result: { sessionId: "" } }], "wim run: the agent's session/new answer is not what ACP describes"],
  ];
  for (const [what, steps, line] of refusals) {
    it(`stops with exit 1 on ${what}`, async () => {
      const w = await world();
      const fake = new FakeAgent();
      const r = start(w, fake);
      await fake.play(steps);
      expect(await r.done).toBe(1);
      expect(r.err).toEqual([line]);
      expect(fake.received.map((m) => m.method)).not.toContain("session/prompt");
    });
  }
});
