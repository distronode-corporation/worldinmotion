// `wim run <agent>` from the command line: the person-only start, its refusals, and one hosted
// session end to end with a fake agent.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACP_AGENTS, acpAgent } from "../src/agentsetup.ts";
import { OPEN_TRIES, POLL_MS } from "../src/run.ts";
import { Clock, FakeAgent } from "./acp-fake.ts";
import { RelayHarness, run, scratch, term } from "./helpers.ts";

/** A state directory in one mesh, and a bin directory with a `gemini` program in it. */
async function machine(): Promise<{ home: string; bin: string }> {
  const home = await scratch("w2a-cli");
  await fs.mkdir(join(home, "meshes", "m1"), { recursive: true });
  await fs.writeFile(join(home, "meshes", "m1", "mesh.json"), JSON.stringify({ v: 1, mesh: "m1", relay: "ws://127.0.0.1:4444", device: "d1", pin: { seq: 1, hash: "h" }, policy: {} }));
  const bin = join(home, "bin");
  await fs.mkdir(bin);
  await fs.writeFile(join(bin, "gemini"), "#!/bin/sh\n", { mode: 0o755 });
  return { home, bin };
}

const said = (t: { out: string[]; err: string[] }): string => [...t.out, ...t.err].join("\n");

describe("wim run: the command", () => {
  it("knows the five ACP agents, each with its documented command", () => {
    expect(ACP_AGENTS.map((a) => [a.name, a.command.join(" "), a.kind])).toEqual([
      ["codex", "codex-acp", "codex"],
      ["gemini", "gemini --acp", "gemini-cli"],
      ["antigravity", "agy acp", "antigravity"],
      ["cursor", "agent acp", "cursor"],
      ["copilot", "copilot --acp --stdio", "copilot-cli"],
    ]);
    expect(acpAgent("claude")).toBeUndefined();
  });

  it("says its usage for no agent, an agent it does not host, or a word too many", async () => {
    const { home, bin } = await machine();
    for (const argv of [["run"], ["run", "claude"], ["run", "gemini", "now"]]) {
      const t = term(home, new RelayHarness(), {}, { PATH: bin });
      expect(await run(t, ...argv)).toBe(1);
      expect(t.err).toEqual(["wim: usage: wim run codex|gemini|antigravity|cursor|copilot [--prompt <text>]"]);
    }
    const help = term(home, new RelayHarness());
    expect(await run(help, "help", "run")).toBe(0);
    expect(help.out).toEqual(["wim run codex|gemini|antigravity|cursor|copilot [--prompt <text>]"]);
  });

  it("is for a person only: refused under an agent's variables or without an interactive terminal, before anything starts", async () => {
    const { home, bin } = await machine();
    const cases: Array<[Record<string, string>, Record<string, boolean>, string]> = [
      [{ CLAUDECODE: "1" }, {}, "wim: CLAUDECODE is set: this shell belongs to Claude Code. Open a terminal yourself (VS Code: Terminal > New Terminal) and run `wim run gemini` there"],
      [{ GEMINI_CLI: "1" }, {}, "wim: GEMINI_CLI is set: this shell belongs to Gemini CLI. Open a terminal yourself (VS Code: Terminal > New Terminal) and run `wim run gemini` there"],
      [{ WIM_AGENT: "1" }, {}, "wim: WIM_AGENT is set: this shell belongs to an AI agent. Open a terminal yourself (VS Code: Terminal > New Terminal) and run `wim run gemini` there"],
      [{ CODEX_SANDBOX: "seatbelt" }, {}, "wim: CODEX_SANDBOX is set: this shell belongs to Codex. Open a terminal yourself (VS Code: Terminal > New Terminal) and run `wim run gemini` there"],
      [{}, { isTTY: false }, "wim: this command's output is not an interactive terminal (it is piped or redirected). Open a terminal yourself (VS Code: Terminal > New Terminal) and run `wim run gemini` there"],
      [{}, { inputIsTTY: false }, "wim: this command's input is not an interactive terminal (it is piped or redirected). Open a terminal yourself (VS Code: Terminal > New Terminal) and run `wim run gemini` there"],
    ];
    for (const [env, io, line] of cases) {
      let started = 0;
      const t = term(home, new RelayHarness(), { ...io, spawnAcp: () => (started++, new FakeAgent()) }, { PATH: bin, ...env });
      expect(await run(t, "run", "gemini", "--prompt", "go")).toBe(1);
      expect(t.err).toEqual([line]);
      expect(started).toBe(0);
    }
  });

  it("refuses an empty first prompt, a device in no mesh, and an agent that is not installed", async () => {
    const { home, bin } = await machine();
    const empty = term(home, new RelayHarness(), {}, { PATH: bin });
    expect(await run(empty, "run", "gemini", "--prompt= ")).toBe(1);
    expect(empty.err).toEqual(["wim: --prompt needs the text of the first turn"]);
    const valueless = term(home, new RelayHarness(), {}, { PATH: bin });
    expect(await run(valueless, "run", "gemini", "--prompt")).toBe(2);
    const bare = await scratch("w2a-bare");
    const noMesh = term(bare, new RelayHarness(), {}, { PATH: bin });
    expect(await run(noMesh, "run", "gemini")).toBe(1);
    expect(said(noMesh)).toContain("this device is in no mesh");
    const missing = term(home, new RelayHarness(), {}, { PATH: bin });
    expect(await run(missing, "run", "copilot")).toBe(1);
    expect(missing.err).toEqual(["wim: `copilot` is not on PATH: install Copilot CLI, or check that `copilot --acp --stdio` runs in this terminal"]);
  });

  it("starts the agent found on PATH with its ACP words, hands it this state directory and mesh, runs the person's first turn, and stops on Ctrl-C", async () => {
    const { home, bin } = await machine();
    const fake = new FakeAgent();
    const clock = new Clock();
    let how: unknown[] = [];
    const t = term(home, new RelayHarness(), { spawnAcp: (...a) => ((how = a), fake), delay: clock.delay, wim: () => ["/usr/bin/node", "/opt/wim/wim.mjs"] }, { PATH: bin });
    const done = run(t, "run", "gemini", "--prompt", "Say hello.");
    const played = fake.play([
      { from: "client", method: "initialize" },
      { from: "agent", reply: "initialize", result: { protocolVersion: 1 } },
      { from: "client", method: "session/new" },
      { from: "agent", reply: "session/new", result: { sessionId: "s1" } },
      { from: "client", method: "session/prompt" },
      { from: "agent", reply: "session/prompt", result: { stopReason: "end_turn" } },
    ]);
    // No `wim mcp` opens a session here, so the first turn waits its checks out, then runs.
    for (let i = 0; i < OPEN_TRIES; i++) await clock.tick(POLL_MS);
    await played;
    await clock.waiting(POLL_MS);
    expect(how).toEqual([join(bin, "gemini"), ["--acp"], { env: t.env, cwd: home, platform: process.platform }]);
    const server = (fake.sent("session/new").params!["mcpServers"] as Array<{ command: string; args: string[]; env: Array<{ name: string; value: string }> }>)[0]!;
    expect([server.command, server.args]).toEqual(["/usr/bin/node", ["/opt/wim/wim.mjs", "mcp"]]);
    expect(server.env.slice(0, 3)).toEqual([
      { name: "WIM_HOME", value: home },
      { name: "WIM_MESH", value: "m1" },
      { name: "WIM_KIND", value: "gemini-cli" },
    ]);
    expect(server.env[3]!.value).toMatch(/^run:[A-Za-z0-9_-]{22}$/);
    expect(fake.sent("session/prompt").params!["prompt"]).toEqual([{ type: "text", text: "Say hello." }]);
    t.stop.abort();
    expect(await done).toBe(0);
    expect(t.out[0]).toMatch(/^wim run: Gemini CLI runs as a hosted session/);
  });

  it("with nothing injected starts the real program and says when it ends at once", async () => {
    const { home, bin } = await machine();
    const t = term(home, new RelayHarness(), {}, { PATH: bin });
    // The `gemini` on PATH here is an empty script (POSIX), or no program at all (Windows).
    expect(await run(t, "run", "gemini", "--mesh", "m1")).toBe(1);
    expect(t.err.at(-1)).toMatch(/^wim run: Gemini CLI ended its ACP connection \((exit code 0|it could not be started: .+)\)\.$/);
  });
});
