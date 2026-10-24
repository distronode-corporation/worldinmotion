import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MeshSession } from "../src/client.ts";
import { INTERNAL_TOOLS, PUBLIC_TOOLS, WimMcp, type McpOptions } from "../src/mcp.ts";
import { MeshFiles } from "../src/mesh.ts";
import { SessionKeys } from "../src/session.ts";
import { FS, LIVE_PID, makeMesh, openSession, RelayHarness, scratch, sessionOpts, sleep, until, type TestDevice } from "./helpers.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f().catch(() => undefined);
});

type Text = { content: Array<{ type: string; text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };

async function connect(o: Partial<McpOptions> & { device?: TestDevice; mesh?: string; relay?: RelayHarness; name?: string }) {
  const server = new WimMcp({
    channel: false,
    internalTools: true,
    version: "test",
    ...(o.device === undefined ? {} : { session: sessionOpts(o.device, o.mesh!, o.relay!, { name: o.name ?? "agent", kind: "claude-code" }) }),
    ...o,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const notes: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const client = new Client({ name: "test", version: "1" });
  client.fallbackNotificationHandler = async (n) => void notes.push(n as never);
  await server.server.connect(b);
  await client.connect(a);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  // Plays the plugin: keeps the token `_hello` hands out and sends it on every internal call.
  let token: string | undefined;
  const call = async (name: string, args: Record<string, unknown> = {}, onprogress?: (p: unknown) => void): Promise<Text> => {
    // Internal operations go through the one `_internal` tool, as the plugin calls them.
    const internal = name.startsWith("_");
    const { token: given, ...rest } = args as { token?: string };
    const useToken = "token" in args ? given : token;
    const wire = internal ? { name: "_internal", arguments: { op: name.slice(1), args: rest, ...(useToken === undefined ? {} : { token: useToken }) } } : { name, arguments: args };
    const r = (await client.callTool(wire, CallToolResultSchema, onprogress === undefined ? {} : { onprogress })) as Text;
    if (name === "_hello" && typeof r.structuredContent?.["token"] === "string") token = r.structuredContent["token"] as string;
    return r;
  };
  return { server, client, call, notes };
}

const text = (r: Text): string => r.content.map((c) => c.text).join("\n");

describe("wim mcp", () => {
  it("lists public tools, and internal ones only for the plugin", async () => {
    const { client } = await connect({ setupProblem: "not set up" });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual([...PUBLIC_TOOLS, ...INTERNAL_TOOLS].map((t) => t.name));
    expect(INTERNAL_TOOLS.map((t) => [t.name, t.description])).toEqual([["_internal", "Internal to the worldinmotion plugin. Do not call."]]);
    // The old names are gone, and an unknown op is refused.
    expect(text((await client.callTool({ name: "_held", arguments: {} }, CallToolResultSchema)) as Text)).toMatch(/unknown tool _held/);
    expect(text((await client.callTool({ name: "_internal", arguments: { op: "nope" } }, CallToolResultSchema)) as Text)).toMatch(/invalid input: op/);
    const direct = new WimMcp({ channel: false, internalTools: true, version: "t" });
    expect((await direct.call("_internal", "not an object", undefined, async () => undefined)).content[0]).toMatchObject({ text: expect.stringMatching(/invalid input: input:/) });
    const plain = await connect({ internalTools: false });
    expect((await plain.client.listTools()).tools.map((t) => t.name)).toEqual(PUBLIC_TOOLS.map((t) => t.name));
    expect(text(await plain.call("_held"))).toMatch(/unknown tool/);
    expect(text(await plain.call("nope"))).toMatch(/unknown tool/);
  });

  it("advertises schemas derived from the zod inputs, with the protocol's bounds", async () => {
    const byName = Object.fromEntries(PUBLIC_TOOLS.map((t) => [t.name, t]));
    const props = (name: string): Record<string, Record<string, unknown>> => byName[name]!.inputSchema["properties"] as Record<string, Record<string, unknown>>;
    expect(props("lease")["ttl_s"]).toEqual({ type: "integer", minimum: 1, maximum: 3600 });
    expect(props("lease")["name"]).toEqual({ type: "string", minLength: 1, maxLength: 256 });
    expect(props("ask")["to"]).toEqual({ type: "string", minLength: 1 });
    expect(props("rooms")["limit"]).toEqual({ type: "integer", minimum: 1, maximum: 50 });
    expect(props("send")["to"]!["description"]).toBe("name@device, #room, *, or a list");
    expect(byName["send"]!.inputSchema["required"]).toEqual(["to", "text"]);
    expect(byName["wait"]!.description).toBe("Block until the next item arrives (default 110 s, max 300).");
    expect(byName["send_file"]!.description).toContain("at most 25 MiB");
    for (const t of [...PUBLIC_TOOLS, ...INTERNAL_TOOLS]) expect(t.inputSchema["$schema"]).toBeUndefined();
    expect((INTERNAL_TOOLS[0]!.inputSchema["properties"] as Record<string, { enum?: string[] }>)["op"]!.enum).toEqual(["hello", "peers", "route", "held", "leases"]);
  });

  it("reports a failure that is neither a refusal nor the relay's as the client's own", async () => {
    const relay = new RelayHarness();
    const root = await scratch("nomesh");
    const { devices } = await makeMesh(relay, ["one"]);
    const { call } = await connect({ session: { ...sessionOpts(devices[0]!, "x", relay), mesh: new MeshFiles(join(root, "missing"), FS) } });
    expect(text(await call("peers"))).toMatch(/^worldinmotion: .*mesh\.json does not exist$/);
  });

  it("says why when the device is not set up, and validates input", async () => {
    const { call } = await connect({ setupProblem: "this device is not set up: run `wim init` first" });
    const r = await call("_hello", { claudeSessionId: "abc" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not set up/);
    expect(text(await call("peers"))).toMatch(/not set up/);
    expect(text(await call("send", { to: 3 }))).toMatch(/invalid input: to/);
    const bare = await connect({});
    expect(text(await bare.call("peers"))).toMatch(/is not set up on this device/);
  });

  it("runs the public tools against a mesh", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const peer = await openSession(devices[1]!, mesh, relay, { name: "peer" });
    cleanup.push(() => peer.stop());
    const { call, server } = await connect({ device: devices[0]!, mesh, relay, name: "writer" });
    await server.start();
    await server.current!.ready(3000);
    expect(text(await call("peers"))).toMatch(/^peer@two {2}mcp {2}idle {2}-$/m);
    const sent = await call("send", { to: "peer@two", text: "hi", notify_when_idle: true });
    expect(sent.structuredContent).toMatchObject({ results: [{ to: "peer@two", status: "routed" }] });
    expect(text(await call("send", { to: "peer@two", text: `sk-ant-${"x".repeat(40)}` }))).toMatch(/refused: text appears to contain a secret \(anthropic_api_key\)/);
    expect((await call("send", { to: "Bad", text: "x" })).isError).toBe(true);
    // ask, answered by the peer
    peer.on("message", (m: { kind: string; id: string }) => {
      if (m.kind === "task") void peer.reply(m.id, "done", "answer");
    });
    const asked = await call("ask", { to: "peer@two", task: "q", timeout_s: 3 });
    expect(asked.structuredContent).toMatchObject({ status: "answered", result_status: "done", from: "peer@two" });
    expect(String(asked.structuredContent!["rendered"])).toContain("answer");
    peer.removeAllListeners("message");
    expect((await call("ask", { to: "peer@two", task: "q2", timeout_s: 1 })).structuredContent).toMatchObject({ status: "pending" });
    expect(text(await call("reply", { task_id: "01J00000000000000000000000", status: "done", text: "x" }))).toMatch(/no task/);
    // inbox and wait
    expect(text(await call("inbox"))).toBe("No unread items.");
    await peer.send("writer@one", "for you");
    await until(async () => (await server.current!.spool.unread()).length > 0);
    expect(text(await call("inbox", { peek: true }))).toContain("for you");
    expect(text(await call("inbox"))).toContain("for you");
    const progress: unknown[] = [];
    const waited = call("wait", { timeout_s: 2 }, (p) => progress.push(p));
    await sleep(50);
    await peer.send("writer@one", "while waiting");
    // An idle notice armed earlier may come first; the message follows it.
    let got = text(await waited);
    for (let i = 0; i < 3 && !got.includes("while waiting"); i++) got = text(await call("wait", { timeout_s: 2 }));
    expect(got).toContain("while waiting");
    expect(text(await call("wait", { timeout_s: 1 }))).toBe("No new items in 1 s.");
    // rooms
    expect(text(await call("rooms", { action: "join", room: "#ops" }))).toBe("Joined #ops. Members: writer@one.");
    expect(text(await call("rooms", { action: "list" }))).toMatch(/This session is in: #ops\. Rooms peers are in: none\./);
    await peer.joinRoom("#ci");
    await until(() => server.current!.peers.get("peer@two")?.rooms.includes("#ci") === true);
    expect(text(await call("rooms", { action: "list" }))).toMatch(/Rooms peers are in: #ci/);
    expect(text(await call("rooms", { action: "history", room: "#ops" }))).toBe("No history in #ops.");
    await peer.joinRoom("#ops");
    await peer.send("#ops", "note");
    expect(text(await call("rooms", { action: "history", room: "#ops", limit: 1 }))).toMatch(/room history/);
    expect(text(await call("rooms", { action: "leave", room: "#ops" }))).toBe("Left #ops.");
    expect(text(await call("rooms", { action: "join" }))).toMatch(/needs a room/);
    expect((await call("rooms", { action: "join", room: "nope" })).isError).toBe(true);
    // leases
    expect((await call("lease", { action: "acquire", name: "deploy", ttl_s: 30 })).structuredContent).toMatchObject({ name: "deploy", status: "granted" });
    expect((await call("lease", { action: "renew", name: "deploy" })).structuredContent).toMatchObject({ status: "renewed" });
    expect((await call("lease", { action: "list" })).structuredContent).toMatchObject({ leases: [{ name: "deploy", holder: "writer@one" }] });
    await call("_hello", { claudeSessionId: "pub" });
    expect((await call("_leases")).structuredContent).toMatchObject({ leases: [{ name: "deploy", holder: "writer@one" }] });
    expect((await call("lease", { action: "release", name: "deploy" })).structuredContent).toMatchObject({ status: "released" });
    expect(text(await call("lease", { action: "acquire" }))).toMatch(/needs a name/);
    // files
    const dir = await scratch("mcp-file");
    await fs.writeFile(join(dir, "n.txt"), "notes");
    expect((await call("send_file", { to: "peer@two", path: join(dir, "n.txt"), caption: "c" })).structuredContent).toMatchObject({ results: [{ status: "routed" }] });
    // history and rename
    expect(text(await call("history", { limit: 2 }))).toMatch(/history:/);
    expect(text(await call("history", { peer: "nobody@x" }))).toBe("No history.");
    expect(text(await call("history", { before: 1 }))).toBe("No history.");
    expect(text(await call("rename", { name: "Bad Name" }))).toMatch(/a name is 1 to 32/);
    expect(text(await call("rename", { name: "editor" }))).toBe("This session is now editor@one.");
    void progress;
  }, 30_000);

  it("serves the plugin's internal tools", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"], { trust: false });
    const peer = await openSession(devices[1]!, mesh, relay, { name: "peer", cwd: "/srv/project" });
    cleanup.push(() => peer.stop());
    const { call, server } = await connect({ device: devices[0]!, mesh, relay, name: "me" });
    const hello = await call("_hello", { claudeSessionId: "claude-1" });
    expect(hello.structuredContent).toMatchObject({ address: "me@one" });
    expect(String(hello.structuredContent!["spool"])).toMatch(/sessions[\\/][0-9A-Z]{26}[\\/]spool$/);
    const s = server.current!;
    await s.ready(3000);
    // Internal tools need the handshake token; a second handshake needs it too.
    expect(text(await call("_held", { token: "wrong" }))).toMatch(/need the token/);
    expect(text(await call("_held", { token: undefined as unknown as string }))).toMatch(/invalid input|need the token/);
    expect(text(await call("_hello", { claudeSessionId: "other", token: "nope" }))).toMatch(/already completed its handshake/);
    expect((await call("_hello", { claudeSessionId: "claude-1" })).structuredContent!["token"]).toBe(hello.structuredContent!["token"]);
    await until(async () => ((await call("_peers", { forPane: true })).structuredContent!["peers"] as Array<{ cwd?: string }>)[0]?.cwd === "project");
    const forModel = (await call("_peers")).structuredContent!["peers"] as Array<Record<string, unknown>>;
    expect(forModel).toEqual([{ address: "peer@two", kind: "mcp", status: "idle", rooms: [] }]);
    expect((await call("_route", { to: "peer@two" })).structuredContent).toEqual({ mesh: true, policy: "hold" });
    const sent = await peer.send("me@one", "held for you");
    await until(async () => ((await call("_held")).structuredContent!["held"] as unknown[]).length === 1);
    expect((await call("_held")).structuredContent).toMatchObject({ held: [{ id: sent.id, from: "peer@two", kind: "msg", preview: "held for you" }] });
    // The person's decisions are mark files that the plugin's pane writes; no op makes them.
    const { held: heldDir, dismiss } = hello.structuredContent as { held: string; dismiss: string };
    expect([heldDir, dismiss]).toEqual([s.files.heldDir, s.files.dismissDir]);
    for (const op of ["_approve", "_refuse", "_dismiss", "_relayed"]) expect(text(await call(op, { id: sent.id }))).toMatch(/invalid input: op/);
    await fs.writeFile(join(heldDir, `${sent.id}.approve`), "");
    await until(async () => (await s.spool.unread()).some((i) => i.id === sent.id));
    const second = await peer.send("me@one", "no thanks");
    await until(async () => ((await call("_held")).structuredContent!["held"] as unknown[]).length === 1);
    await fs.writeFile(join(heldDir, `${second.id}.refuse`), "");
    await until(async () => ((await call("_held")).structuredContent!["held"] as unknown[]).length === 0);
    // Relayed items stay readable through inbox until the person dismisses them.
    await new MeshFiles(devices[0]!.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, policy: { [devices[1]!.device.id]: "deliver-relayed" } }));
    await peer.send("me@one", "relayed text", { relayed: true });
    await until(async () => (await s.spool.unread()).some((i) => i.relayed === true));
    const r = (await s.spool.unread()).find((i) => i.relayed === true)!;
    await s.take(r.cursor);
    expect((await s.spool.relayed()).map((i) => i.id)).toEqual([r.id]);
    expect(text(await call("inbox", { peek: true }))).toMatch(/^\(relayed: the sender passed on text it did not write itself\)/);
    await fs.writeFile(join(dismiss, `${r.id}.dismiss`), "");
    await until(async () => (await s.spool.relayed()).length === 0);
  }, 20_000);

  it("takes back the session a Claude Code session had before", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    // The first life of a Claude Code session.
    const first = await connect({ device: devices[0]!, mesh, relay, name: "agent" });
    const h1 = await first.call("_hello", { claudeSessionId: "cc-7" });
    const sid = h1.structuredContent!["sid"];
    await first.server.current!.joinRoom("#kept");
    await first.server.close();
    // A restart: a new process starts fresh, then the handshake names the old session.
    const second = await connect({ device: devices[0]!, mesh, relay, name: "agent" });
    await second.server.start();
    const freshSid = second.server.current!.sid;
    expect(freshSid).not.toBe(sid);
    const h2 = await second.call("_hello", { claudeSessionId: "cc-7" });
    expect(h2.structuredContent!["sid"]).toBe(sid);
    await second.server.current!.ready(3000);
    expect(second.server.current!.state.rooms).toEqual(["#kept"]);
    expect(second.server.current!.address).toBe("agent@one");
    // The same id again is a no-op.
    expect((await second.call("_hello", { claudeSessionId: "cc-7" })).structuredContent!["sid"]).toBe(sid);
    // WIM_SESSION_KEY does the same for agents without a plugin.
    const keyed = await connect({ device: devices[0]!, mesh, relay, name: "gem", sessionKey: "gemini-1" });
    const k1 = (await keyed.server.start())!.sid;
    await keyed.server.close();
    const keyed2 = await connect({ device: devices[0]!, mesh, relay, name: "gem", sessionKey: "gemini-1" });
    expect((await keyed2.server.start())!.sid).toBe(k1);
    expect(await new SessionKeys(new MeshFiles(devices[0]!.home.meshDir(mesh), FS), FS, Date.now).lookup("key:gemini-1")).toMatchObject({ sid: k1 });
  }, 20_000);

  it("pushes items as Claude Code channel notifications with WIM_CHANNEL", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    // Something already waiting is pushed when the server starts.
    const pre = await MeshSession.open({ ...sessionOpts(devices[0]!, mesh, relay, { name: "agent" }), sessionKey: "key:chan" });
    await pre.spool.write({ kind: "msg", from: "x@two", device: devices[1]!.device.id, id: "01J00000000000000000000001", at: 1, rendered: "waiting already" });
    await pre.stop();
    const { server, notes, client } = await connect({ device: devices[0]!, mesh, relay, name: "agent", channel: true, sessionKey: "chan" });
    expect(client.getServerCapabilities()?.experimental).toEqual({ "claude/channel": {} });
    expect(client.getInstructions()).toMatch(/<channel source="worldinmotion"/);
    await server.start();
    const peer = await openSession(devices[1]!, mesh, relay, { name: "peer" });
    cleanup.push(() => peer.stop());
    await server.current!.ready(3000);
    await peer.send("agent@one", "pushed");
    await until(() => notes.filter((n) => n.method === "notifications/claude/channel").length === 2);
    const pushed = notes.filter((n) => n.method === "notifications/claude/channel");
    expect(pushed[0]!.params).toMatchObject({ content: "waiting already" });
    expect(pushed[1]!.params).toMatchObject({ meta: { from: "peer@two", kind: "msg" } });
    expect(String(pushed[1]!.params!["content"])).toContain("pushed");
    await until(async () => (await server.current!.spool.unread()).length === 0);
  }, 20_000);

  it("keeps a fresh session when the remembered one is live in another process", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const other = await MeshSession.open({ ...sessionOpts(devices[0]!, mesh, relay, { name: "agent", env: { ...FS, pid: LIVE_PID } }), sessionKey: "claude:cc-9" });
    const { call, server } = await connect({ device: devices[0]!, mesh, relay, name: "agent" });
    const h = await call("_hello", { claudeSessionId: "cc-9" });
    expect(h.structuredContent!["sid"]).toBe(server.current!.sid);
    expect(h.structuredContent!["sid"]).not.toBe(other.sid);
    await other.stop();
  });
});
