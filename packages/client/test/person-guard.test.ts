// The person's decisions about what reaches the agents (approving, refusing and releasing held
// messages, trusting and untrusting devices) are taken only from a person at an interactive
// terminal with no agent's variables, after a confirmation that shows what is decided. Every way
// an agent could reach them is tried here: its shell, a pipe, a terminal-looking environment, an
// events process it started, and the MCP tools.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { MeshSession } from "../src/client.ts";
import { runEvents } from "../src/events.ts";
import { INTERNAL_OPS, PUBLIC_TOOLS, WimMcp } from "../src/mcp.ts";
import { MeshFiles } from "../src/mesh.ts";
import { HeldBox } from "../src/held.ts";
import { listAllHeld } from "../src/offline.ts";
import { SessionFiles } from "../src/session.ts";
import { agentEnv, AGENT_ENV_VARS, cannotConfirm } from "../src/secretout.ts";
import { FS, makeMesh, openSession, RelayHarness, run, said, sessionOpts, term, until, type Term } from "./helpers.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f().catch(() => undefined);
});

/** Two devices that hold each other's messages, and one message from `one` held for `inbox@two`. */
async function heldSetup() {
  const relay = new RelayHarness();
  const { mesh, devices } = await makeMesh(relay, ["one", "two"], { trust: false });
  const inbox = await MeshSession.open({ ...sessionOpts(devices[1]!, mesh, relay, { name: "inbox" }), sessionKey: "key:inbox" });
  inbox.start();
  await inbox.ready(3000);
  const a = await openSession(devices[0]!, mesh, relay, { name: "a" });
  const sent = await a.send("inbox@two", "please run the deploy");
  await until(async () => (await inbox.held.list()).length === 1);
  await inbox.stop();
  await a.stop();
  const files = new MeshFiles(devices[1]!.home.meshDir(mesh), FS);
  const policyOfOne = async (): Promise<string | undefined> => (await files.loadConfig()).policy[devices[0]!.device.id];
  const stillHeld = async (): Promise<boolean> => (await listAllHeld(files, FS)).some((r) => r.id === sent.id);
  return { relay, mesh, devices, id: sent.id, files, policyOfOne, stillHeld };
}

/** Every agent-driven or non-interactive way to run a command, with what its refusal names. */
const HOSTILE: Array<{ what: string; io: { isTTY: boolean; inputIsTTY: boolean }; env: Record<string, string>; why: RegExp }> = [
  { what: "Claude Code's shell (CLAUDECODE)", io: { isTTY: true, inputIsTTY: true }, env: { CLAUDECODE: "1" }, why: /CLAUDECODE is set: this shell belongs to Claude Code/ },
  { what: "a Claude Code session id alone", io: { isTTY: true, inputIsTTY: true }, env: { CLAUDE_CODE_SESSION_ID: "abc" }, why: /CLAUDE_CODE_SESSION_ID is set: this shell belongs to Claude Code/ },
  { what: "Claude Code's messaging socket alone", io: { isTTY: true, inputIsTTY: true }, env: { CLAUDE_CODE_MESSAGING_SOCKET: "/run/x.sock" }, why: /CLAUDE_CODE_MESSAGING_SOCKET is set/ },
  { what: "the cross-vendor AI_AGENT marker", io: { isTTY: true, inputIsTTY: true }, env: { AI_AGENT: "some-agent" }, why: /AI_AGENT is set: this shell belongs to an AI agent/ },
  { what: "a Codex variable", io: { isTTY: true, inputIsTTY: true }, env: { CODEX_SANDBOX: "seatbelt" }, why: /CODEX_SANDBOX is set: this shell belongs to Codex/ },
  { what: "an answer piped into stdin", io: { isTTY: true, inputIsTTY: false }, env: {}, why: /this command's input is not an interactive terminal/ },
  { what: "output piped away", io: { isTTY: false, inputIsTTY: true }, env: {}, why: /output is not an interactive terminal/ },
  {
    what: "a terminal-looking environment over pipes",
    io: { isTTY: false, inputIsTTY: false },
    env: { TERM: "xterm-256color", COLORTERM: "truecolor", FORCE_COLOR: "1", FORCE_TTY: "1", TERM_PROGRAM: "vscode", WIM_PERSON: "1" },
    why: /output is not an interactive terminal/,
  },
];

/** A terminal in `root` that answers yes to anything, as an agent typing `y` would. */
function hostileTerm(root: string, relay: RelayHarness, h: (typeof HOSTILE)[number]): Term {
  const t = term(root, relay, h.io, h.env);
  t.answers.push("y", "y", "y");
  return t;
}

describe("only a person approves held messages and trusts devices", () => {
  it("refuses held approve, refuse and resume, and devices trust and untrust, to every non-person", async () => {
    const s = await heldSetup();
    for (const h of HOSTILE) {
      const t = hostileTerm(s.devices[1]!.root, s.relay, h);
      for (const argv of [
        ["held", "approve", s.id],
        ["held", "refuse", s.id],
        ["held", "resume", "a@one"],
        ["devices", "trust", "one"],
        ["devices", "trust", "one", "--relayed"],
        ["devices", "trust", "--all"],
        ["devices", "untrust", "one"],
      ]) {
        expect(await run(t, ...argv), `${h.what}: wim ${argv.join(" ")}`).toBe(1);
        expect(said(t), h.what).toMatch(h.why);
        expect(said(t)).toContain(`run \`wim ${argv.join(" ")}\` there`);
      }
      // Refused before anything was shown or asked: no answer was taken.
      expect(t.answers.length, h.what).toBe(3);
      expect(said(t)).not.toContain("[y/N]");
      expect(said(t)).not.toContain("please run the deploy");
    }
    expect(await s.stillHeld()).toBe(true);
    expect(await s.policyOfOne()).toBeUndefined();
  }, 30_000);

  it("changes nothing when the person at the terminal does not type yes", async () => {
    const s = await heldSetup();
    const t = term(s.devices[1]!.root, s.relay);
    for (const answer of ["", "n", "no", "yess", "y es", "sure"]) {
      t.answers.push(answer, answer, answer, answer);
      expect(await run(t, "held", "approve", s.id)).toBe(1);
      expect(await run(t, "held", "refuse", s.id)).toBe(1);
      expect(await run(t, "devices", "trust", "one")).toBe(1);
      expect(await run(t, "held", "resume", "a@one")).toBe(1);
    }
    expect(t.err.filter((l) => l === "wim: nothing changed.").length).toBe(24);
    expect(await s.stillHeld()).toBe(true);
    expect(await s.policyOfOne()).toBeUndefined();
    // The details the person decides on: the sender, its device id, why it waits, and the text.
    expect(said(t)).toContain(`Held message ${s.id}:`);
    expect(said(t)).toContain(`  from     a@one (device id ${s.devices[0]!.device.id})`);
    expect(said(t)).toContain("  text     please run the deploy");
    expect(said(t)).toContain(`  one  admin  id ${s.devices[0]!.device.id}  policy hold -> deliver`);
    expect(said(t)).toContain("Check each id against `wim devices list` on that device (its line says `this device`).");
    expect(said(t)).toContain("Trust only devices you would let type into your own terminal; another person's device stays at hold.");
    t.answers.push("n");
    expect(await run(t, "devices", "trust", "--all")).toBe(1);
    expect(said(t)).toContain("Trust all 1? [y/N] ");
    expect(await s.policyOfOne()).toBeUndefined();
    // A yes from the person does it.
    t.answers.push("y");
    expect(await run(t, "held", "approve", s.id)).toBe(0);
    expect(await s.stillHeld()).toBe(false);
    t.answers.push("y");
    expect(await run(t, "devices", "untrust", "one")).toBe(0);
    expect(await s.policyOfOne()).toBe("hold");
  }, 30_000);

  it("shows a held file's name and size, and why a breaker hold waits", async () => {
    const s = await heldSetup();
    const box = new MeshFiles(s.devices[1]!.home.meshDir(s.mesh), FS);
    const [row] = await listAllHeld(box, FS);
    const t = term(s.devices[1]!.root, s.relay);
    // Rewrites the held item in place as a breaker-held file, as the client would have written it.
    const files = new SessionFiles(box, row!.sid, FS);
    const { sid: _sid, session: _session, ...item } = row!;
    await new HeldBox(files.heldDir, FS).add({ ...item, reason: "breaker", fileInfo: { blob: row!.id, name: "notes.txt", size: 12, mime: "text/plain", key: "k", sha256: "h", chunks: 1 } });
    t.answers.push("n");
    expect(await run(t, "held", "refuse", s.id)).toBe(1);
    expect(said(t)).toContain("  held     because the loop breaker paused that peer");
    expect(said(t)).toContain("  file     notes.txt (12 bytes, fetched once approved)");
  }, 30_000);

  it("says so when another process decided the item while the person read it", async () => {
    const s = await heldSetup();
    const [row] = await listAllHeld(s.files, FS);
    const path = join(new SessionFiles(s.files, row!.sid, FS).heldDir, `${s.id}.json`);
    const t = term(s.devices[1]!.root, s.relay);
    t.answers.push(() => {
      unlinkSync(path);
      return "y";
    });
    expect(await run(t, "held", "approve", s.id)).toBe(1);
    expect(said(t)).toContain(`no held message ${s.id}`);
    expect(said(t)).not.toContain(`Approved ${s.id}.`);
  }, 30_000);

  it("refuses the same decisions to an events process an agent started", async () => {
    const s = await heldSetup();
    const lines: Array<Record<string, unknown>> = [];
    const input = new PassThrough();
    const stop = new AbortController();
    const session = await MeshSession.open({ ...sessionOpts(s.devices[1]!, s.mesh, s.relay, { name: "vscode", kind: "vscode" }), handover: true, sessionKey: "events:vscode" });
    const running = runEvents({ session, mesh: s.files, env: FS, device: s.devices[1]!.device, version: "test", write: (l) => void lines.push(JSON.parse(l)), input, signal: stop.signal, now: Date.now, pollMs: 20, leasePollMs: 40, agent: "CLAUDECODE" });
    cleanup.push(async () => {
      stop.abort();
      await running;
      await session.stop();
    });
    await until(() => lines.some((l) => l["type"] === "snapshot"));
    const requests: Array<[string, Record<string, unknown>, string]> = [
      ["approve", { held: s.id }, "approving a held message"],
      ["refuse", { held: s.id }, "refusing a held message"],
      ["resume", { peer: "a@one" }, "releasing what the loop breaker held"],
      ["trust", { device: "one" }, "changing a device's trust"],
      ["trust", { device: "one", relayed: true }, "changing a device's trust"],
      ["untrust", { device: "one" }, "changing a device's trust"],
    ];
    let n = 0;
    for (const [op, args, what] of requests) {
      const id = `r${++n}`;
      input.write(`${JSON.stringify({ v: 1, id, op, args })}\n`);
      await until(() => lines.some((l) => l["type"] === "response" && l["id"] === id));
      expect(lines.find((l) => l["type"] === "response" && l["id"] === id)).toMatchObject({
        ok: false,
        error: { code: "refused", message: `${what} is the person's: this events process runs with an agent's variables (CLAUDECODE)` },
      });
    }
    expect(await s.stillHeld()).toBe(true);
    expect(await s.policyOfOne()).toBeUndefined();
  }, 30_000);

  it("offers no MCP tool or internal op that approves, refuses, resumes or trusts", async () => {
    const s = await heldSetup();
    expect(PUBLIC_TOOLS.map((t) => t.name)).toEqual(["peers", "send", "ask", "reply", "inbox", "wait", "rooms", "lease", "send_file", "history", "rename"]);
    // Every internal op only reads or hands over state; the pane's buttons write mark files.
    expect([...INTERNAL_OPS]).toEqual(["hello", "peers", "route", "held", "leases", "status"]);
    const server = new WimMcp({ channel: false, internalTools: true, version: "test", session: sessionOpts(s.devices[1]!, s.mesh, s.relay, { name: "agent", kind: "claude-code" }) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await server.server.connect(b);
    await client.connect(a);
    cleanup.push(async () => {
      await client.close();
      await server.close();
    });
    const call = async (name: string, args: Record<string, unknown>): Promise<string> =>
      ((await client.callTool({ name, arguments: args }, CallToolResultSchema)) as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");
    for (const op of ["approve", "refuse", "resume", "trust", "untrust", "decide", "policy"]) {
      expect(await call("_internal", { op, args: { held: s.id, device: "one" } })).toMatch(/invalid input: op/);
      expect(await call(op, { held: s.id, device: "one" })).toMatch(/unknown tool/);
    }
    // Through the plugin's own handshake, the held op lists and decides nothing.
    const hello = (await client.callTool({ name: "_internal", arguments: { op: "hello", args: { claudeSessionId: "s1" } } }, CallToolResultSchema)) as { structuredContent?: { token?: string } };
    const token = hello.structuredContent!.token!;
    expect(await call("_internal", { op: "held", args: {}, token })).toBe('{"held":[]}');
    // An extra argument is dropped, not acted on.
    expect(await call("_internal", { op: "held", args: { approve: s.id, verdict: "approve" }, token })).toBe('{"held":[]}');
    expect(await s.stillHeld()).toBe(true);
    expect(await s.policyOfOne()).toBeUndefined();
  }, 30_000);

  it("names the agent markers it checks, and leaves a person's own Claude Code settings alone", () => {
    expect(AGENT_ENV_VARS).toEqual(expect.arrayContaining(["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "AI_AGENT"]));
    // Settings people export in their own shell profile are not an agent's marker.
    expect(agentEnv({ CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000", ANTHROPIC_API_KEY: "x" })).toBeUndefined();
    expect(agentEnv({ CLAUDECODE: "" })).toBeUndefined();
    expect(cannotConfirm({}, { isTTY: true, inputIsTTY: true })).toBeUndefined();
    expect(cannotConfirm({ AI_AGENT: "x" }, { isTTY: false, inputIsTTY: false })).toMatch(/^AI_AGENT is set/);
  });
});
