// A mesh mixing upgraded devices with v0.1 ones (SPEC section 6b, the migration window). A v0.1
// client parses every relay frame strictly and drops, silently, any whole frame holding a message
// with a `pk` or a scheme 2 box. The fake below does exactly that to one device's connections, and
// publishes no prekey for it, as 0.1.2 does.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { legacyBoxSchema, LIMITS, sendFrameSchema, ulid, type SendFrame } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { MeshSession } from "../src/client.ts";
import { writeJson } from "../src/fsx.ts";
import { WimMcp } from "../src/mcp.ts";
import { MeshFiles } from "../src/mesh.ts";
import { FS, LIVE_PID, makeMesh, openSession, RelayHarness, run, said, sessionOpts, term, until, type TestDevice } from "./helpers.ts";

const LONG = 30_000;
/** Housekeeping only when a test calls tick(): nothing runs on a timer behind the test's back. */
const HAND = { tickMs: 3_600_000 };

const open: Array<{ stop(): Promise<unknown> }> = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

async function session(...args: Parameters<typeof openSession>): Promise<MeshSession> {
  const s = await openSession(...args);
  open.push(s);
  return s;
}

/** 0.1.2's send frame: strict, no `pk`, and every box a scheme 1 box (`n` and `c` only). */
const v01SendFrame = sendFrameSchema.omit({ pk: true }).extend({
  boxes: z.record(z.string(), legacyBoxSchema).refine((b) => Object.keys(b).length > 0),
});

/** Whether 0.1.2's parser takes a relay frame: every message it carries must parse, or all of it is dropped. */
function v01Accepts(text: string): boolean {
  const f = JSON.parse(text) as { t: string; msg?: unknown; cards?: unknown[]; msgs?: Array<{ msg: unknown }> };
  const msgs = f.t === "deliver" || f.t === "card" ? [f.msg] : f.t === "cards" ? f.cards! : f.t === "room.history" ? f.msgs!.map((m) => m.msg) : [];
  return msgs.every((m) => v01SendFrame.safeParse(m).success);
}

/**
 * Makes `device` behave as a 0.1.2 client on the wire: frames to it pass 0.1.2's parser or are
 * dropped, and it publishes no prekey (its cards never reach the relay). Its own sends are kept
 * for the test to check against 0.1.2's format.
 */
function asV01(relay: RelayHarness, device: TestDevice): { dropped: string[]; sent: string[] } {
  const conns = new Set<string>();
  const dropped: string[] = [];
  const sent: string[] = [];
  relay.toRelay = (text, conn) => {
    const f = JSON.parse(text) as { t: string; device?: string };
    if (f.t === "auth" && f.device === device.device.id) conns.add(conn);
    if (!conns.has(conn)) return text;
    if (f.t === "card.set") return undefined;
    if (f.t === "send") sent.push(text);
    return text;
  };
  relay.toClient = (text, conn) => {
    if (!conns.has(conn) || v01Accepts(text)) return text;
    dropped.push(text);
    return undefined;
  };
  return { dropped, sent };
}

/** Starts from no learned prekeys anywhere, so every device learns them in the test. */
async function forgetPrekeys(mesh: string, devices: TestDevice[]): Promise<void> {
  for (const d of devices) await fs.rm(new MeshFiles(d.home.meshDir(mesh), FS).peerPrekeysPath, { force: true });
}

const lastSend = (relay: RelayHarness, sid: string): SendFrame =>
  relay.sentByClients
    .map((t) => JSON.parse(t) as SendFrame | { t: string })
    .filter((f): f is SendFrame => f.t === "send" && (f as SendFrame).from.sid === sid)
    .at(-1)!;

const has = async (s: MeshSession, re: RegExp): Promise<boolean> => (await s.spool.unread()).some((i) => re.test(i.rendered));

/** Upgraded devices one and two, and old, a v0.1 device; one session each, all in #ops. */
async function mixed(): Promise<{ relay: RelayHarness; mesh: string; devices: TestDevice[]; old: MeshSession; b: MeshSession; a: MeshSession; v01: ReturnType<typeof asV01> }> {
  const relay = new RelayHarness();
  const { mesh, devices } = await makeMesh(relay, ["one", "two", "old"]);
  await forgetPrekeys(mesh, devices);
  const v01 = asV01(relay, devices[2]!);
  const old = await session(devices[2]!, mesh, relay, { name: "o", ...HAND });
  const b = await session(devices[1]!, mesh, relay, { name: "b", ...HAND });
  const a = await session(devices[0]!, mesh, relay, { name: "a", ...HAND });
  for (const s of [old, b, a]) await s.joinRoom("#ops");
  return { relay, mesh, devices, old, b, a, v01 };
}

describe("the fake v0.1 parser", () => {
  it("takes a 0.1.2-shaped frame and refuses a pk or any scheme 2 box, even beside a v0.1 box", async () => {
    const { relay, devices, a, b } = await mixed();
    await a.send("b@two", "upgraded only");
    const fs2 = lastSend(relay, a.sid);
    expect(fs2.pk).toBeDefined();
    expect(v01SendFrame.safeParse(fs2).success).toBe(false);
    const { pk: _pk, ...noPk } = fs2;
    expect(v01SendFrame.safeParse(noPk).success).toBe(false);
    await a.send("o@old", "old only");
    const v1 = lastSend(relay, a.sid);
    expect(v01SendFrame.safeParse(v1).success).toBe(true);
    // One scheme 2 box beside the v0.1 one is enough for 0.1.2 to drop the whole frame.
    const mixedBoxes = { ...v1, boxes: { ...v1.boxes, [devices[1]!.device.id]: fs2.boxes[devices[1]!.device.id]! } };
    expect(v01SendFrame.safeParse(mixedBoxes).success).toBe(false);
    expect(v01Accepts(JSON.stringify({ t: "cards", cards: [v1, fs2] }))).toBe(false);
    expect(v01Accepts(JSON.stringify({ t: "room.history", room: "#ops", msgs: [{ cursor: 1, msg: v1 }], more: false }))).toBe(true);
    expect(v01Accepts(JSON.stringify({ t: "peers", peers: [] }))).toBe(true);
    void b;
  }, LONG);
});

describe("an upgraded sender in a mesh with a v0.1 device", () => {
  it("reaches the v0.1 device directly and in a room, in 0.1.2's format, and says there is no forward secrecy", async () => {
    const { relay, devices, old, b, a, v01 } = await mixed();
    // Upgraded devices still learn each other's prekeys from cards: one to two is forward secret.
    const fsOut = await a.send("b@two", "between upgraded devices");
    expect(fsOut.unprotected).toBeUndefined();
    expect(fsOut.no_prekey).toBeUndefined();
    const fsFrame = lastSend(relay, a.sid);
    expect(fsFrame.pk?.device).toBe(devices[0]!.device.id);
    expect(fsFrame.boxes[devices[1]!.device.id]).toMatchObject({ s: 2 });
    await until(() => has(b, /between upgraded devices/), undefined, "b reads the forward secret message");
    // And two learned one's prekey, so the reply is forward secret too.
    const back = await b.send("a@one", "and back");
    expect(back.unprotected).toBeUndefined();
    expect(lastSend(relay, b.sid).boxes[devices[0]!.device.id]).toMatchObject({ s: 2 });
    await until(() => has(a, /and back/), undefined, "a reads the reply");

    const direct = await a.send("o@old", "hello old client");
    expect(direct).toMatchObject({ unprotected: ["old"], no_prekey: ["old"] });
    expect(v01SendFrame.safeParse(lastSend(relay, a.sid)).success).toBe(true);
    await until(() => has(old, /hello old client/), undefined, "the v0.1 device reads the direct message");

    const room = await a.send("#ops", "room hello");
    // Every device in the room went without forward secrecy, the sender's own siblings included.
    expect([...room.unprotected!].sort()).toEqual(["old", "one", "two"]);
    expect(room.no_prekey).toEqual(["old"]);
    expect(v01SendFrame.safeParse(lastSend(relay, a.sid)).success).toBe(true);
    await until(async () => (await has(old, /room hello/)) && (await has(b, /room hello/)), undefined, "both read the room message");

    // A send naming an upgraded and a v0.1 device: one frame, in 0.1.2's format, read by both.
    const both = await a.send(["b@two", "o@old"], "to you both");
    expect([...both.unprotected!].sort()).toEqual(["old", "two"]);
    expect(both.no_prekey).toEqual(["old"]);
    const bothFrame = lastSend(relay, a.sid);
    expect(bothFrame.pk).toBeUndefined();
    expect(v01SendFrame.safeParse(bothFrame).success).toBe(true);
    await until(async () => (await has(old, /to you both/)) && (await has(b, /to you both/)), undefined, "both read the mixed send");

    // A task and its result in the same mesh: the v0.1 device answers, and is answered, in v0.1.
    const tasked = await a.send("o@old", "a task for old", { kind: "task" });
    expect(tasked.no_prekey).toEqual(["old"]);
    await until(() => has(old, /a task for old/), undefined, "the v0.1 device reads the task");

    // What the v0.1 device dropped: only frames carrying prekeys (the upgraded sessions' cards),
    // never a message meant for it.
    expect(v01.dropped.length).toBeGreaterThan(0);
    for (const t of v01.dropped) expect(t).not.toMatch(/hello old client|room hello|to you both|a task for old/);
  }, LONG);

  it("all-upgraded sends keep forward secrecy once the v0.1 device is not a recipient", async () => {
    const { relay, devices, b, a } = await mixed();
    await a.tick();
    const out = await a.send(["b@two", "a@one"], "upgraded pair");
    expect(out.unprotected).toBeUndefined();
    const frame = lastSend(relay, a.sid);
    expect(frame.pk?.id).toBeDefined();
    for (const id of [devices[0]!.device.id, devices[1]!.device.id]) expect(frame.boxes[id]).toMatchObject({ s: 2 });
    await until(() => has(b, /upgraded pair/), undefined, "b reads it");
  }, LONG);
});

describe("a sender past its own prekey's validity", () => {
  it("still seals to a peer's prekey (no pk to send), and a send to its own device goes in v0.1", async () => {
    const relay = new RelayHarness();
    let now = Date.now();
    const clock = () => now;
    relay.now = clock;
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await forgetPrekeys(mesh, devices);
    const a = await session(devices[0]!, mesh, relay, { name: "a", now: clock, ...HAND });
    now += LIMITS.prekeyLifetimeMs;
    // two comes online now, with a fresh prekey; one has not rotated (no housekeeping ran).
    const b = await session(devices[1]!, mesh, relay, { name: "b", now: clock, ...HAND });
    await until(async () => (await a.send("b@two", `probe ${ulid()}`)).unprotected === undefined, undefined, "a learns two's prekey");
    const frame = lastSend(relay, a.sid);
    expect(frame.pk).toBeUndefined();
    expect(frame.boxes[devices[1]!.device.id]).toMatchObject({ s: 2 });
    await until(() => has(b, /probe/), undefined, "b reads it");
    const own = await a.send("*", "everyone");
    expect(own.no_prekey).toEqual(["one"]);
    expect(Object.values(lastSend(relay, a.sid).boxes).every((box) => !("s" in box))).toBe(true);
  }, LONG);
});

describe("a v0.1 sender to upgraded devices", () => {
  it("is read directly and in a room; what it sends is 0.1.2's format", async () => {
    const { relay, old, b, a, v01 } = await mixed();
    const direct = await old.send("b@two", "from the old client");
    expect(direct.no_prekey).toEqual(["two"]);
    await until(() => has(b, /from the old client/), undefined, "b reads the v0.1 message");
    await old.send("#ops", "old in the room");
    await until(async () => (await has(a, /old in the room/)) && (await has(b, /old in the room/)), undefined, "both read the v0.1 room message");
    expect(v01.sent.length).toBe(2);
    for (const t of v01.sent) expect(v01SendFrame.safeParse(JSON.parse(t)).success).toBe(true);
    // The upgraded side never learns a prekey for old, so its sends to old stay in v0.1.
    const reply = await b.send("o@old", "reply to old");
    expect(reply.no_prekey).toEqual(["old"]);
    expect(lastSend(relay, b.sid).pk).toBeUndefined();
    await until(() => has(old, /reply to old/), undefined, "old reads the reply");
  }, LONG);
});

describe("the downgrade is visible to the sender", () => {
  it("wim send, MCP send and a watch that predates no_prekey all say so", async () => {
    const { relay, mesh, devices } = await mixed();
    const t = term(devices[0]!.root, relay);
    expect(await run(t, "send", "o@old", "via the cli")).toBe(0);
    expect(said(t)).toContain(
      "Sent without forward secrecy to old: no current prekey for old (a v0.1 client, or offline for over 48 hours), so the whole send went in the v0.1 format.",
    );

    // MCP: the outcome carries both lists and the same sentence as a note.
    const server = new WimMcp({ channel: false, internalTools: false, version: "test", session: sessionOpts(devices[0]!, mesh, relay, { name: "agent", kind: "claude-code", ...HAND }) });
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await server.server.connect(y);
    await client.connect(x);
    open.push({ stop: async () => (await client.close(), await server.close()) });
    const call = async (args: Record<string, unknown>) => ((await client.callTool({ name: "send", arguments: args }, CallToolResultSchema)) as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(await call({ to: "#ops", text: "via mcp" })).toMatchObject({
      no_prekey: ["old"],
      note: expect.stringMatching(/^Sent without forward secrecy to .*: no current prekey for old \(a v0\.1 client, or offline for over 48 hours\), so the whole send went in the v0\.1 format\.$/),
    });
    expect(await call({ to: "b@two", text: "forward secret via mcp" })).not.toHaveProperty("note");

    // A `wim watch` from before `no_prekey` answers with `unprotected` only: the CLI still says so.
    const w = await MeshSession.open({ ...sessionOpts(devices[0]!, mesh, relay, { name: "cli", kind: "cli", handover: false, env: { ...FS, pid: LIVE_PID }, ...HAND }), sessionKey: "cli:cli" });
    open.push(w);
    w.start();
    await w.ready(3000);
    const t2 = term(devices[0]!.root, relay);
    const sending = run(t2, "send", "o@old", "through an older watch");
    let request: string | undefined;
    await until(async () => (request = (await fs.readdir(w.files.controlDir).catch(() => [] as string[])).find((n) => /^send-[0-9A-Z]{26}\.json$/.test(n))) !== undefined, undefined, "the handed-over request");
    const id = ulid();
    // Written whole (as a watch writes it): `wim send` polls for this file and must never read half of it.
    await writeJson(join(w.files.controlDir, request!.replace(".json", ".done.json")), { ok: true, id, results: [{ to: "o@old", status: "routed" }], live: [], unprotected: ["old"] }, FS);
    expect(await sending).toBe(0);
    expect(said(t2)).toContain("Sent without forward secrecy to old: no current prekey for old (a v0.1 client, or offline for over 48 hours), so the whole send went in the v0.1 format.");
  }, LONG);
});
