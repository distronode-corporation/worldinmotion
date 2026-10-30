// A `wim mcp` that started before this device's signer was up (or while it was locked) reaches
// the mesh once the signer answers, without the agent restarting it; and the `status` op says
// what a tab is, or why it cannot link.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentServer, Signer } from "../src/agent.ts";
import { agentEndpoint, endpointFiles } from "../src/agentpath.ts";
import { encryptDevice } from "../src/agentcli.ts";
import { main } from "../src/cli.ts";
import { WimMcp, type McpOptions, type Retried } from "../src/mcp.ts";
import { openKeyFile } from "../src/vault.ts";
import { MeshFiles } from "../src/mesh.ts";
import { SessionKeys } from "../src/session.ts";
import { FS, makeMesh, newDevice, RelayHarness, sessionOpts, term, until, type TestDevice } from "./helpers.ts";

const KDF = { N: 1024, r: 8, p: 1 };
const PASS = "pass phrase";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of cleanup.splice(0).reverse()) await c();
});

type Text = { content: Array<{ type: string; text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };
const text = (r: Text): string => r.content.map((c) => c.text).join("\n");

/** Runs a signer in this process for a test device whose key file is encrypted. */
async function serve(d: TestDevice): Promise<{ signer: Signer; server: AgentServer }> {
  const file = await d.home.readKeyFile();
  if (file === undefined || !("sealed" in file)) throw new Error("not encrypted");
  const signer = new Signer({ file: file.sealed, unlocked: await openKeyFile(file.sealed, PASS), now: Date.now, pid: process.pid, log: () => undefined });
  const server = new AgentServer({ signer, endpoint: (await agentEndpoint(d.home.root, d.home.env, true))!, files: endpointFiles(process.platform) });
  await server.listen();
  cleanup.push(() => server.close());
  return { signer, server };
}

/** A WimMcp on an in-memory transport; `call` plays the plugin (it keeps and sends the token). */
async function connect(o: Partial<McpOptions>) {
  const server = new WimMcp({ channel: false, internalTools: true, version: "test", ...o });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await server.server.connect(b);
  await client.connect(a);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  let token: string | undefined;
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Text> => {
    const internal = name.startsWith("_");
    const wire = internal ? { name: "_internal", arguments: { op: name.slice(1), args, ...(token === undefined ? {} : { token }) } } : { name, arguments: args };
    const r = (await client.callTool(wire, CallToolResultSchema)) as Text;
    if (name === "_hello" && typeof r.structuredContent?.["token"] === "string") token = r.structuredContent["token"] as string;
    return r;
  };
  return { server, call };
}

describe("wim mcp and a signer that is not up yet", () => {
  it("answers the signer's problem, then links once the signer is up, with no restart", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const one = devices[0]!;
    await encryptDevice(one.home, PASS, KDF);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const t = term(one.root, relay, { stdin, stdout, retryMs: 50 });
    const answers = new Map<number, Record<string, unknown>>();
    let rest = "";
    stdout.on("data", (d: Buffer) => {
      rest += d.toString();
      for (let nl = rest.indexOf("\n"); nl !== -1; nl = rest.indexOf("\n")) {
        const msg = JSON.parse(rest.slice(0, nl)) as { id?: number; result?: Record<string, unknown> };
        rest = rest.slice(nl + 1);
        if (msg.id !== undefined) answers.set(msg.id, msg.result!);
      }
    });
    let id = 0;
    const rpc = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const n = ++id;
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
      await until(() => answers.has(n), 10_000, `the answer to ${method}`);
      return answers.get(n)!;
    };
    const internal = (op: string, args: Record<string, unknown>, token?: string) =>
      rpc("tools/call", { name: "_internal", arguments: { op, args, ...(token === undefined ? {} : { token }) } }) as Promise<Text>;
    const serving = main(["mcp"], { ...t.env, WIM_KIND: "claude-code", WIM_NAME: "agent" }, t.io);
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });

    // The handshake is kept: a token now, and a link file written once a session can open.
    const before = await internal("hello", { claudeSessionId: "cc-1" });
    expect(before.isError).toBeUndefined();
    const pending = before.structuredContent as { pending: boolean; problem: string; link: string; token: string };
    expect(pending.pending).toBe(true);
    expect(pending.problem).toMatch(/encrypted and no signer is running: run `wim agent start` in a terminal you opened yourself/);
    expect(pending.link.startsWith(join(one.root, "links"))).toBe(true);
    // `status` answers without the token: it is how a tab that cannot link learns why.
    const down = await internal("status", {});
    expect(down.structuredContent).toEqual({ problem: expect.stringMatching(/no signer is running/), state_dir: one.root, state_dir_why: "WIM_HOME is set" });
    // A second handshake while it waits: the same link file.
    expect((await internal("hello", { claudeSessionId: "cc-1" }, pending.token)).structuredContent).toMatchObject({ pending: true, link: pending.link });

    // The signer comes up: the server opens the session by itself and writes the link.
    await serve(one);
    await until(async () => (await fs.readFile(pending.link, "utf8").catch(() => "")) !== "", 10_000, "the link file");
    const link = JSON.parse(await fs.readFile(pending.link, "utf8")) as Record<string, unknown>;
    expect(link).toMatchObject({ address: "agent@one", token: pending.token });
    expect(String(link["spool"])).toMatch(/sessions[\\/][0-9A-Z]{26}[\\/]spool$/);
    // The Claude session is mapped to it, so a restarted server takes it back.
    expect(await new SessionKeys(new MeshFiles(one.home.meshDir(mesh), FS), FS, Date.now).lookup("claude:cc-1")).toMatchObject({ sid: link["sid"] });
    await until(async () => (await internal("status", {}, pending.token)).structuredContent!["relay"] === "connected", 10_000, "connected");
    const up = await internal("status", {}, pending.token);
    expect(up.structuredContent).toMatchObject({
      address: "agent@one",
      device: `one (${one.device.id})`,
      mesh,
      signer: "in use: the keys are in the signer (wim agent)",
      held: 0,
      state_dir: one.root,
    });
    // A handshake now links at once, to the same session.
    expect((await internal("hello", { claudeSessionId: "cc-1" }, pending.token)).structuredContent).toMatchObject({ sid: link["sid"], token: pending.token });
    stdin.end();
    expect(await serving).toBe(0);
    // A clean end removes the link file.
    await expect(fs.access(pending.link)).rejects.toThrow();
  });

  it("answers a problem that stands (a plaintext key file where the signer is required) without asking again", async () => {
    const d = await newDevice("standing");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const lines: string[] = [];
    stdout.on("data", (b: Buffer) => lines.push(...b.toString().split("\n").filter((l) => l !== "")));
    const t = term(d.root, new RelayHarness(), { stdin, stdout, retryMs: 10 });
    const serving = main(["mcp"], { ...t.env, WIM_KIND: "claude-code", WIM_REQUIRE_SIGNER: "1" }, t.io);
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`);
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "_internal", arguments: { op: "hello", args: { claudeSessionId: "cc-3" } } } })}\n`);
    await until(() => lines.some((l) => l.includes('"id":2')), 10_000, "the hello answer");
    const answer = JSON.parse(lines.find((l) => l.includes('"id":2'))!) as { result: Text };
    expect(answer.result.isError).toBe(true);
    expect(text(answer.result)).toMatch(/is not encrypted, and this device requires the signer/);
    stdin.end();
    expect(await serving).toBe(0);
  });

  it("asks again on each call, stops when the problem is one that stands, and keeps asking in the background", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const answers: Retried[] = [
      { problem: "no signer is running", again: true },
      { problem: "the signer is locked", again: true },
      { session: sessionOpts(devices[0]!, mesh, relay, { name: "agent", kind: "claude-code" }) },
    ];
    const retry = vi.fn(async () => answers.shift()!);
    const { call, server } = await connect({ setupProblem: "no signer is running", retry });
    // With no state directory to put a link file in, a handshake cannot wait: it answers the problem.
    const hello = await call("_hello", { claudeSessionId: "cc-2" });
    expect(hello.isError).toBe(true);
    expect(text(hello)).toBe("no signer is running");
    expect(text(await call("peers"))).toBe("the signer is locked");
    // The status op opens the session it can now open; the relay is not connected yet.
    expect((await call("_status")).structuredContent).toMatchObject({ address: "agent@one", relay: "connecting", signer: "not used: the key file is plaintext" });
    expect(retry).toHaveBeenCalledTimes(3);
    await server.current!.ready(5000);
    expect(text(await call("peers"))).toBe("");
    expect(retry).toHaveBeenCalledTimes(3);

    // A problem that stands (the device is not set up) ends the asking.
    const stands = vi.fn(async (): Promise<Retried> => ({ problem: "this device is not set up", again: false }));
    const once = await connect({ setupProblem: "no signer is running", retry: stands });
    expect(text(await once.call("peers"))).toBe("this device is not set up");
    expect(text(await once.call("peers"))).toBe("this device is not set up");
    expect(stands).toHaveBeenCalledTimes(1);
    expect((await once.call("_status")).structuredContent).toEqual({ problem: "this device is not set up" });
  });

  it("opens the session in the background once the problem clears, and stops asking", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    let up = false;
    const retry = vi.fn(async (): Promise<Retried> => (up ? { session: sessionOpts(devices[0]!, mesh, relay, { name: "agent" }) } : { problem: "no signer is running", again: true }));
    const { server } = await connect({ setupProblem: "no signer is running", retry, retryMs: 5000 });
    expect(server.start()).toBeUndefined();
    // Started twice, it still asks on one clock.
    expect(server.start()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(server.current).toBeUndefined();
    up = true;
    await vi.advanceTimersByTimeAsync(5000);
    await until(() => server.current !== undefined, 5000, "the session");
    expect(retry).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("stops asking in the background when the problem turns into one that stands", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const retry = vi.fn(async (): Promise<Retried> => ({ problem: "this device is not set up", again: false }));
    const { server } = await connect({ setupProblem: "no signer is running", retry, retryMs: 5000 });
    server.start();
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
