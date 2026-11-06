// Stable addresses: a session takes over an offline session's name on the same device (a claim:
// `--take`, `WIM_TAKE=1`, the `rename` tool's `take`), and the same-project rule takes back a
// `name-N` under the name it asked for (design.md, taking a session back).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { promises as fs } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { claimLine, ClientError, MeshSession, reclaimedLine } from "../src/client.ts";
import { TAKE_HINT, WimMcp } from "../src/mcp.ts";
import { parseSessionState, SessionKeys } from "../src/session.ts";
import { FS, LIVE_PID, makeMesh, openSession, RelayHarness, run, said, scratch, sessionOpts, sleep, spooled, term, until, type TestDevice } from "./helpers.ts";

const open: Array<{ stop(): Promise<unknown> }> = [];
afterEach(async () => {
  for (const s of open.splice(0).reverse()) await s.stop().catch(() => undefined);
});

/** Opens, starts and connects a session, stopped after the test. */
async function live(d: TestDevice, mesh: string, relay: RelayHarness, extra: Parameters<typeof sessionOpts>[3] = {}): Promise<MeshSession> {
  const s = await openSession(d, mesh, relay, extra);
  open.push(s);
  return s;
}

/** A claim that was expected to be refused. */
async function notRefused(s: MeshSession): Promise<ClientError> {
  await s.stop();
  throw new Error("the claim was not refused");
}
const refusal = (e: unknown): ClientError => e as ClientError;

/** The text of a tool result. */
type Text = { content: Array<{ type: string; text: string }>; isError?: boolean };
const textOf = (r: Text): string => r.content.map((c) => c.text).join("\n");

/** An MCP server around a session of `d`, with a client to call its tools. */
async function mcp(d: TestDevice, mesh: string, relay: RelayHarness, extra: Parameters<typeof sessionOpts>[3] = {}) {
  const server = new WimMcp({ session: sessionOpts(d, mesh, relay, { kind: "claude-code", ...extra }), channel: false, internalTools: true, version: "t" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await server.server.connect(b);
  await client.connect(a);
  open.push({ stop: async () => (await client.close(), await server.close()) });
  let token: string | undefined;
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Text> => {
    const internal = name.startsWith("_");
    const wire = internal ? { name: "_internal", arguments: { op: name.slice(1), args, ...(token === undefined ? {} : { token }) } } : { name, arguments: args };
    const r = (await client.callTool(wire, CallToolResultSchema)) as Text & { structuredContent?: Record<string, unknown> };
    if (name === "_hello") token = r.structuredContent?.["token"] as string;
    return r;
  };
  const s = (await server.start())!;
  await s.ready(3000);
  return { server, call, first: s };
}

describe("a claim takes over an offline name on this device", () => {
  it("from another directory: same sid, queue, rooms, lease token, and one notice that counts what came", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const old = await openSession(devices[0]!, mesh, relay, { name: "release", cwd: await scratch("old") });
    await old.joinRoom("#release");
    const lease = await old.acquireLease("role:release", 600_000, false);
    await old.stop();
    const peer = await live(devices[1]!, mesh, relay, { name: "peer" });
    await until(async () => (await peer.listPeers()).some((p) => p.address === "release@one" && p.status === "offline"));
    expect((await peer.send("release@one", "while the role was vacant")).results).toEqual([{ to: "release@one", status: "queued" }]);

    const here = await scratch("new");
    const taker = await live(devices[0]!, mesh, relay, { name: "release", cwd: here, take: true });
    expect(taker.sid).toBe(old.sid);
    expect(taker.takenOver).toBe(true);
    expect(taker.address).toBe("release@one");
    expect(taker.state.cwd).toBe(here);
    expect(taker.state.leases).toEqual(old.state.leases);
    expect(Object.values(taker.state.leases)).toEqual([lease.token]);
    const notice = await spooled(taker, (i) => i.kind === "notice" && i.rendered.includes("took over"));
    expect(notice.rendered).toContain(claimLine("release@one", { unread: 1, held: 0, leases: 1 }));
    expect((await taker.spool.unread()).some((i) => i.rendered.includes("while the role was vacant"))).toBe(true);
    expect((await peer.listPeers()).find((p) => p.address === "release@one")).toMatchObject({ sid: old.sid, rooms: ["#release"] });
    // The lease keeps its fencing token: a renewal with it is accepted.
    expect((await taker.renewLease("role:release", 600_000)).status).toBe("renewed");
    // One notice only, even after a reconnect.
    relay.dropAll();
    await until(() => taker.link?.isOpen === true);
    await sleep(50);
    expect((await taker.spool.unread()).filter((i) => i.rendered.includes("took over"))).toHaveLength(1);
  });

  it("a receipt for a message the old session sent reaches the claimer", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const bob = await openSession(devices[1]!, mesh, relay, { name: "bob" });
    await bob.stop();
    const old = await openSession(devices[0]!, mesh, relay, { name: "hub", cwd: await scratch("a") });
    const sent = await old.send("bob@two", "please review");
    expect(sent.results[0]!.status).toBe("queued");
    await old.stop();
    const taker = await live(devices[0]!, mesh, relay, { name: "hub", cwd: await scratch("b"), take: true });
    const back = await live(devices[1]!, mesh, relay, { name: "bob", take: true });
    await until(async () => (await back.spool.unread()).some((i) => i.rendered.includes("please review")));
    await back.inbox(false);
    await until(() => (taker.receipts.get(sent.id) ?? []).some((r) => r.status === "delivered"), 5000, "the receipt");
  });

  it("a held item comes with it, counted for the person and shown in `wim held list`", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"], { trust: false });
    const old = await openSession(devices[0]!, mesh, relay, { name: "triage", cwd: await scratch("a") });
    const peer = await live(devices[1]!, mesh, relay, { name: "peer" });
    await peer.send("triage@one", "from a device that is not trusted");
    await until(async () => (await old.held.list()).length === 1);
    await old.stop();
    const taker = await live(devices[0]!, mesh, relay, { name: "triage", cwd: await scratch("b"), take: true });
    const notice = await spooled(taker, (i) => i.kind === "notice" && i.rendered.includes("took over"));
    expect(notice.rendered).toContain(claimLine("triage@one", { unread: 0, held: 1, leases: 0 }));
    expect(await taker.held.list()).toHaveLength(1);
    const t = term(devices[0]!.root, relay);
    expect(await run(t, "held", "list")).toBe(0);
    expect(said(t)).toContain("from a device that is not trusted");
  });

  it("is refused out loud while a live process holds the name, never a name-N", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const holder = await MeshSession.open(sessionOpts(devices[0]!, mesh, relay, { name: "hub", env: { ...FS, pid: LIVE_PID } }));
    open.push(holder);
    const refused = await MeshSession.open(sessionOpts(devices[0]!, mesh, relay, { name: "hub", take: true })).then(notRefused, refusal);
    expect(refused).toBeInstanceOf(ClientError);
    expect(refused.code).toBe("name_live");
    expect(refused.message).toMatch(/cannot take hub@one: a live session on this device holds it now/);
  });

  it("is refused when only a session of another kind has the name, or when another session of any kind holds it live", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const tab = await openSession(devices[0]!, mesh, relay, { name: "desk", kind: "claude-code" });
    await tab.stop();
    const kind = await MeshSession.open(sessionOpts(devices[0]!, mesh, relay, { name: "desk", kind: "cli", take: true })).then(notRefused, refusal);
    expect([kind.code, kind.message]).toEqual(["name_kind", "cannot take desk@one: it belongs to a session of another kind on this device (claude-code), so messages for that name are its own"]);
    // A same-kind offline session, but a live one of another kind holds the name now.
    const watch = await MeshSession.open(sessionOpts(devices[0]!, mesh, relay, { name: "desk", kind: "cli", env: { ...FS, pid: LIVE_PID } }));
    open.push(watch);
    const busy = await MeshSession.open(sessionOpts(devices[0]!, mesh, relay, { name: "desk", kind: "claude-code", take: true })).then(notRefused, refusal);
    expect(busy.code).toBe("name_live");
  });

  it("does not take an ended session: the name is free, and a new session gets it", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const ended = await openSession(devices[0]!, mesh, relay, { name: "hub" });
    await ended.stop({ ended: true });
    const fresh = await live(devices[0]!, mesh, relay, { name: "hub", take: true });
    expect(fresh.sid).not.toBe(ended.sid);
    expect(fresh.takenOver).toBe(false);
    expect(fresh.address).toBe("hub@one");
  });

  it("two processes race for one name: exactly one gets it, the other is refused", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const old = await openSession(devices[0]!, mesh, relay, { name: "hub" });
    await old.stop();
    const tries = await Promise.allSettled([
      MeshSession.open(sessionOpts(devices[0]!, mesh, relay, { name: "hub", take: true })),
      MeshSession.open(sessionOpts(devices[0]!, mesh, relay, { name: "hub", take: true, env: { ...FS, pid: LIVE_PID } })),
    ]);
    const won = tries.flatMap((t) => (t.status === "fulfilled" ? [t.value] : []));
    for (const s of won) open.push(s);
    expect(won.map((s) => s.sid)).toEqual([old.sid]);
    const lost = tries.flatMap((t) => (t.status === "rejected" ? [(t.reason as ClientError).code] : []));
    expect(lost).toEqual(["name_live"]);
  });

  it("comes before a session key, which is moved to the session taken over", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const keyed = await openSession(devices[0]!, mesh, relay, { name: "mine", sessionKey: "key:k" });
    await keyed.stop();
    const role = await openSession(devices[0]!, mesh, relay, { name: "role" });
    await role.stop();
    const taker = await live(devices[0]!, mesh, relay, { name: "role", sessionKey: "key:k", take: true });
    expect(taker.sid).toBe(role.sid);
    expect((await new SessionKeys(taker.mesh, FS, Date.now).lookup("key:k"))!.sid).toBe(role.sid);
  });

  it("logs, and writes no notice, when the lease list does not come", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const old = await openSession(devices[0]!, mesh, relay, { name: "hub" });
    await old.stop();
    relay.toRelay = (t) => (t.includes('"t":"lease.list"') ? undefined : t);
    const logs: string[] = [];
    const taker = await live(devices[0]!, mesh, relay, { name: "hub", take: true, answerMs: 50, log: (l) => void logs.push(l) });
    await until(() => logs.some((l) => l.startsWith("wim: claim notice not written:")));
    expect((await taker.spool.unread()).some((i) => i.rendered.includes("took over"))).toBe(false);
  });

  it("the claim line counts in the singular and the plural", () => {
    expect(claimLine("a@b", { unread: 2, held: 1, leases: 0 })).toContain("With it came 2 unread messages, 1 held item and 0 leases.");
    expect(claimLine("a@b", { unread: 1, held: 2, leases: 1 })).toContain("With it came 1 unread message, 2 held items and 1 lease.");
  });
});

describe("the requested name is saved beside the assigned one", () => {
  it("lets the same-project rule take back a name-N under its base name, preferring the base name's own session", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const work = await scratch("proj");
    const first = await openSession(devices[0]!, mesh, relay, { name: "agent", cwd: work, env: { ...FS, pid: LIVE_PID } });
    const second = await openSession(devices[0]!, mesh, relay, { name: "agent", cwd: work });
    expect(second.address).toBe("agent-2@one");
    expect(second.state.asked).toBe("agent");
    await second.stop();
    await first.stop();
    // Both offline: the session that holds `agent` itself comes first.
    const third = await live(devices[0]!, mesh, relay, { name: "agent", cwd: work });
    expect(third.sid).toBe(first.sid);
    expect(third.address).toBe("agent@one");
    await third.stop({ ended: true });
    // `agent` is free now: the `agent-2` session is taken back as `agent`, and told so.
    const fourth = await live(devices[0]!, mesh, relay, { name: "agent", cwd: work });
    expect(fourth.sid).toBe(second.sid);
    expect(fourth.address).toBe("agent@one");
    const told = await spooled(fourth, (i) => i.kind === "notice" && i.rendered.includes("again"));
    expect(told.rendered).toContain(reclaimedLine("agent-2@one", "agent@one"));
  });

  it("parses `asked` only when it is a name, and a rename sets it", async () => {
    const base = { v: 1, sid: "01J0000000000000000000000A", name: "a-2", kind: "mcp", resume: "x" };
    expect(parseSessionState({ ...base, asked: "a" })?.asked).toBe("a");
    expect(parseSessionState({ ...base, asked: "Not A Name" })?.asked).toBeUndefined();
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const s = await live(devices[0]!, mesh, relay, { name: "x" });
    await s.rename("y");
    expect(JSON.parse(await fs.readFile(s.files.statePath, "utf8")).asked).toBe("y");
  });
});

describe("holdsNothing", () => {
  it("is false for a session that sent, joined, leased, has unread or held items; notices do not count", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"], { trust: false });
    const s = await live(devices[0]!, mesh, relay, { name: "fresh" });
    await s.notice(s.address, "a line of the client's own");
    expect(await s.holdsNothing()).toBe(true);
    const roomed = await live(devices[0]!, mesh, relay, { name: "roomed" });
    await roomed.joinRoom("#r");
    expect(await roomed.holdsNothing()).toBe(false);
    const leased = await live(devices[0]!, mesh, relay, { name: "leased" });
    await leased.acquireLease("l", 60_000, false);
    expect(await leased.holdsNothing()).toBe(false);
    const peer = await live(devices[1]!, mesh, relay, { name: "peer" });
    const sender = await live(devices[0]!, mesh, relay, { name: "sender" });
    await sender.send("peer@two", "hi");
    expect(await sender.holdsNothing()).toBe(false);
    // Held: the peer's device is not trusted here.
    await peer.send("fresh@one", "held here");
    await until(async () => (await s.held.list()).length === 1);
    expect(await s.holdsNothing()).toBe(false);
    // Unread: delivered from a device it trusts.
    await s.mesh.updateConfig((c) => ({ ...c, policy: { ...c.policy, [devices[1]!.device.id]: "deliver" } }));
    const other = await live(devices[0]!, mesh, relay, { name: "other" });
    await peer.send("other@one", "unread");
    await until(async () => (await other.spool.unread()).some((i) => i.kind !== "notice"));
    expect(await other.holdsNothing()).toBe(false);
  });
});

describe("the rename tool", () => {
  it("without take, refuses an offline name with the hint; with take, swaps to that session and moves the keys", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const role = await openSession(devices[0]!, mesh, relay, { name: "release", kind: "claude-code", cwd: await scratch("old") });
    await role.stop();
    const { server, call, first } = await mcp(devices[0]!, mesh, relay, { name: "tab" });
    await call("_hello", { claudeSessionId: "conv-1" });
    const plain = await call("rename", { name: "release" });
    expect(plain.isError).toBe(true);
    expect(textOf(plain)).toBe(`rename refused; relay said (not the person): "a session on this device holds that name". ${TAKE_HINT}`);
    expect(textOf(await call("rename", { name: "Bad Name", take: true }))).toMatch(/a name is 1 to 32/);

    const taken = await call("rename", { name: "release", take: true });
    expect(textOf(taken)).toBe("This session is now release@one: it took over that offline session. A notice follows with what came with it.");
    expect(server.current!.sid).toBe(role.sid);
    // The fresh tab held nothing: ended, so `tab` is free again.
    expect(JSON.parse(await fs.readFile(first.files.statePath, "utf8")).ended).toBe(true);
    // The plugin's next handshake links to the session taken over.
    const linked = await call("_hello", { claudeSessionId: "conv-1" });
    expect(textOf(linked)).toContain(`"sid":"${role.sid}"`);
    await server.current!.ready(3000);
    await spooled(server.current!, (i) => i.kind === "notice" && i.rendered.includes("took over release@one"));
  });

  it("with take, a free name is a plain rename; a live holder or no record is refused; a fresh session that holds something stays offline", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const { call, server } = await mcp(devices[0]!, mesh, relay, { name: "tab" });
    expect(textOf(await call("rename", { name: "free", take: true }))).toBe("This session is now free@one.");
    // A live holder.
    const holder = await MeshSession.open(sessionOpts(devices[0]!, mesh, relay, { name: "busy", kind: "claude-code", env: { ...FS, pid: LIVE_PID } }));
    holder.start();
    open.push(holder);
    await holder.ready(3000);
    const busy = await call("rename", { name: "busy", take: true });
    expect([busy.isError, textOf(busy)]).toEqual([true, expect.stringMatching(/^cannot take busy@one: a live session/)]);
    // A relay row this device's state has no record of.
    const gone = await openSession(devices[0]!, mesh, relay, { name: "gone", kind: "claude-code" });
    await gone.stop();
    await fs.rm(gone.files.dir, { recursive: true });
    const none = await call("rename", { name: "gone", take: true });
    expect(textOf(none)).toMatch(/^cannot take gone: a session holds it that this device's state directory has no record of/);
    // A session given up that holds something (a room) goes offline, not ended.
    await call("rooms", { action: "join", room: "#keep" });
    const before = server.current!;
    const role = await openSession(devices[0]!, mesh, relay, { name: "role", kind: "claude-code" });
    await role.stop();
    expect(textOf(await call("rename", { name: "role", take: true }))).toMatch(/^This session is now role@one: it took over/);
    expect(JSON.parse(await fs.readFile(before.files.statePath, "utf8")).ended).toBeUndefined();
    // Any other refusal is passed on as it is, with no claim and no hint.
    relay.toClient = (t) => t.replace('"code":"name_taken"', '"code":"limited"');
    const other = await call("rename", { name: "free", take: true });
    expect([other.isError, textOf(other)]).toEqual([true, 'rename refused; relay said (not the person): "a session on this device holds that name"']);
    const plain = await call("rename", { name: "free" });
    expect([plain.isError, textOf(plain)]).toEqual([true, 'rename refused; relay said (not the person): "a session on this device holds that name"']);
  });

  it("the hello op keeps a session a start-time claim opened, and leaves a given-up session that holds something offline", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    // The conversation had a session of its own before.
    const mine = await openSession(devices[0]!, mesh, relay, { name: "mine", kind: "claude-code" });
    await mine.stop();
    await new SessionKeys(mine.mesh, FS, Date.now).remember("claude:conv", mine.sid, mine.state.resume);
    const role = await openSession(devices[0]!, mesh, relay, { name: "role", kind: "claude-code" });
    await role.stop();
    const claimed = await mcp(devices[0]!, mesh, relay, { name: "role", take: true });
    await claimed.call("_hello", { claudeSessionId: "conv" });
    expect(claimed.server.current!.sid).toBe(role.sid);
    expect((await new SessionKeys(mine.mesh, FS, Date.now).lookup("claude:conv"))!.sid).toBe(role.sid);
    // Without a claim, the conversation's own session is taken back; the one opened first keeps
    // what it holds (a room), offline.
    await new SessionKeys(mine.mesh, FS, Date.now).remember("claude:conv2", mine.sid, mine.state.resume);
    const plain = await mcp(devices[0]!, mesh, relay, { name: "tab2" });
    await plain.first.joinRoom("#r");
    await plain.call("_hello", { claudeSessionId: "conv2" });
    expect(plain.server.current!.sid).toBe(mine.sid);
    expect(JSON.parse(await fs.readFile(plain.first.files.statePath, "utf8")).ended).toBeUndefined();
  });
});

describe("the CLI", () => {
  it("--take and WIM_TAKE=1 with WIM_NAME ask for a claim; a live holder is refused out loud", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const holder = await MeshSession.open(sessionOpts(devices[0]!, mesh, relay, { name: "ops", kind: "cli", env: { ...FS, pid: LIVE_PID } }));
    open.push(holder);
    const t = term(devices[0]!.root, relay);
    expect(await run(t, "peers", "--as", "ops", "--take")).not.toBe(0);
    expect(said(t)).toMatch(/cannot take ops@one: a live session on this device holds it now/);
    const e = term(devices[0]!.root, relay, {}, { WIM_NAME: "ops", WIM_TAKE: "1" });
    expect(await run(e, "peers")).not.toBe(0);
    expect(said(e)).toMatch(/cannot take ops@one/);
    // WIM_TAKE applies to the WIM_NAME name only: `--as` another name is not a claim.
    const other = term(devices[0]!.root, relay, {}, { WIM_NAME: "ops", WIM_TAKE: "1" });
    expect(await run(other, "peers", "--as", "elsewhere")).toBe(0);
    // `wim mcp` with WIM_NAME and WIM_TAKE=1 opens the session it claims.
    const old = await openSession(devices[0]!, mesh, relay, { name: "role", kind: "mcp", cwd: await scratch("x") });
    await old.stop();
    const stdin = new PassThrough();
    const m = term(devices[0]!.root, relay, { stdin, closeMs: 2000 }, { WIM_NAME: "role", WIM_TAKE: "1" });
    const serving = run(m, "mcp");
    await until(() => relay.sentByClients.some((x) => x.startsWith('{"t":"auth"') && x.includes(old.sid)), 5000);
    stdin.end();
    expect(await serving).toBe(0);
  });
});
