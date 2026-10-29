import {
  b64u,
  generateDeviceKeys,
  makeDeviceRecord,
  nextRoster,
  sealBlob,
  sealMessage,
  ulid,
  type Roster,
  type SendFrame,
} from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishRoster } from "../src/admin.ts";
import { MeshSession, PARKED_MAX } from "../src/client.ts";
import { MeshFiles } from "../src/mesh.ts";
import { SessionKeys } from "../src/session.ts";
import type { SpoolItem } from "../src/spool.ts";
import { FS, makeMesh, newDevice, openSession, RelayHarness, scratch, sessionOpts, sleep, until, type TestDevice, rosterSeqs, keysOf } from "./helpers.ts";

const open: MeshSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

async function session(...args: Parameters<typeof openSession>): Promise<MeshSession> {
  const s = await openSession(...args);
  open.push(s);
  return s;
}

const unread = (s: MeshSession): Promise<SpoolItem[]> => s.spool.unread();

function seal(from: MeshSession, to: MeshSession, extra: Partial<Parameters<typeof sealMessage>[0]> = {}): SendFrame {
  return sealMessage({
    roster: from.roster,
    sender: { deviceId: from.device.id, keys: keysOf(from.device) },
    session: from.state.name,
    // Its own sender session, so crafted frames never move the real session's seq.
    sid: ulid(),
    to: [to.address],
    seq: 1000 + Math.floor(Math.random() * 1000),
    at: Date.now(),
    text: "crafted",
    recipients: [to.device.id],
    ...extra,
  });
}

/** Rewrites the first relay frame that `match` accepts, then stops rewriting. */
function rewriteOnce(relay: RelayHarness, match: (f: Record<string, unknown>) => boolean, to: (f: Record<string, unknown>) => unknown): void {
  let done = false;
  relay.toClient = (text) => {
    if (done) return text;
    const f = JSON.parse(text) as Record<string, unknown>;
    if (!match(f)) return text;
    done = true;
    return JSON.stringify(to(f));
  };
}

async function pair(trust = true) {
  const relay = new RelayHarness();
  const { mesh, devices } = await makeMesh(relay, ["one", "two"], { trust });
  const a = await session(devices[0]!, mesh, relay, { name: "a", userHome: "/none" });
  const b = await session(devices[1]!, mesh, relay, { name: "b" });
  return { relay, mesh, devices, a, b };
}

describe("session opening", () => {
  it("rebuilds a keyed session whose state file is gone, and knows its address before ready", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const files = new MeshFiles(devices[0]!.home.meshDir(mesh), FS);
    await new SessionKeys(files, FS, Date.now).remember("key:x", "01J0000000000000000000000Z", b64u.encode(new Uint8Array(32)));
    const s = await MeshSession.open({ ...sessionOpts(devices[0]!, mesh, relay, { name: "x" }), sessionKey: "key:x" });
    expect(s.sid).toBe("01J0000000000000000000000Z");
    expect(s.address).toBe("x@one");
    await s.stop();
  });

  it("dials with the mesh's certificate pin", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    await new MeshFiles(devices[0]!.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, tls: "P".repeat(43) }));
    await session(devices[0]!, mesh, relay);
    expect(relay.dials.at(-1)!.tlsPin).toBe("P".repeat(43));
  });
});

describe("rosters from the relay", () => {
  it("treats a ready roster at its own seq with another hash as a fork", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const files = new MeshFiles(devices[1]!.home.meshDir(mesh), FS);
    const pin = (await files.loadConfig()).pin;
    const prev = (await files.loadRoster(pin.seq - 1))!;
    const rival = nextRoster(prev, { add: [makeDeviceRecord("rival", generateDeviceKeys(), "member", 1)] }, { keys: keysOf(devices[0]!.device) }, Date.now());
    rewriteOnce(relay, (f) => f["t"] === "ready", (f) => ({ ...f, roster: rival }));
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    await until(() => b.book.fork !== undefined);
  });

  it("refuses a relay that serves an error, a bad chain or a fork while walking", async () => {
    for (const mode of ["error", "bad", "fork", "stall"] as const) {
      const relay = new RelayHarness();
      const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
      const admin = await session(devices[0]!, mesh, relay, { name: "admin" });
      // Roster 3 on top, while the member is offline.
      const extra = await newDevice("three");
      await publishRoster(admin, (cur) => nextRoster(cur, { add: [makeDeviceRecord("three", keysOf(extra.device), "member", Date.now())] }, { keys: keysOf(admin.device) }, Date.now()));
      const files = new MeshFiles(devices[1]!.home.meshDir(mesh), FS);
      const pin = (await files.loadConfig()).pin;
      const pinned = (await files.loadRoster(pin.seq))!;
      const prev = (await files.loadRoster(pin.seq - 1))!;
      rewriteOnce(relay, (f) => f["t"] === "roster" && Array.isArray(f["chain"]) && (f["chain"] as unknown[]).length > 1, (f) => {
        if (mode === "error") return { t: "error", code: "malformed", message: "no roster at that seq", ref: "roster.get" };
        const chain = f["chain"] as Roster[];
        if (mode === "bad") return { ...f, chain: [chain[0], { ...chain[1]!, at: 1 }] };
        if (mode === "stall") return { ...f, chain: [pinned], more: true };
        return { ...f, chain: [nextRoster(prev, { add: [makeDeviceRecord("rival", generateDeviceKeys(), "member", 1)] }, { keys: keysOf(devices[0]!.device) }, 5)] };
      });
      const logs: string[] = [];
      const b = await MeshSession.open(sessionOpts(devices[1]!, mesh, relay, { name: "b", log: (l) => logs.push(l) }));
      open.push(b);
      b.start();
      if (mode === "stall") {
        await b.ready(3000);
        expect(b.roster.seq).toBe(pin.seq);
      } else if (mode === "fork") {
        await until(() => b.book.fork !== undefined);
      } else {
        await until(() => logs.some((l) => l.includes(mode === "error" ? "would not serve" : "does not verify")));
      }
      await b.stop();
      open.splice(open.indexOf(b), 1);
    }
  }, 30_000);

  it("walks forward on a pushed roster that skips ahead, and logs one that cannot be walked", async () => {
    const { relay, mesh, devices, a } = await pair();
    const admin = a;
    const logs: string[] = [];
    const b = await session(devices[1]!, mesh, relay, { name: "b2", log: (l) => logs.push(l) });
    // b misses two pushes, then sees a page that starts past its head.
    relay.toClient = (text, conn) => (conn === connOf(relay, mesh, b.sid) && text.startsWith('{"t":"roster","chain":[') ? undefined : text);
    const added: TestDevice[] = [];
    for (const n of ["x1", "x2"]) {
      const d = await newDevice(n);
      added.push(d);
      await publishRoster(admin, (cur) => nextRoster(cur, { add: [makeDeviceRecord(n, keysOf(d.device), "member", Date.now())] }, { keys: keysOf(admin.device) }, Date.now()));
    }
    relay.toClient = undefined;
    const files = new MeshFiles(devices[0]!.home.meshDir(mesh), FS);
    const newest = (await files.loadRoster(admin.roster.seq))!;
    relay.inject(mesh, JSON.stringify({ t: "roster", chain: [newest], more: false }));
    await until(() => b.roster.seq === admin.roster.seq);
    // A gap the relay then refuses to fill is logged.
    const far = { ...newest, seq: newest.seq + 5 };
    relay.toClient = (text, conn) => (conn === connOf(relay, mesh, b.sid) && text.startsWith('{"t":"roster","chain":[') && !text.includes(`"seq":${newest.seq + 5}`) ? JSON.stringify({ t: "error", code: "malformed", message: "nope", ref: "roster.get" }) : text);
    relay.inject(mesh, JSON.stringify({ t: "roster", chain: [far], more: false }));
    await until(() => logs.some((l) => l.includes("wim: roster:")));
  });

  it("probes a same-seq mismatch and finds no fork when the relay's roster is its own", async () => {
    const { a, b, relay } = await pair();
    rewriteOnce(relay, (f) => f["t"] === "roster", () => ({ t: "error", code: "x", message: "y", ref: "roster.get" }));
    const frame = seal(a, b, { roster: { ...a.roster, at: a.roster.at + 1 } });
    expect(await b.receive(frame)).toBe("dropped");
    const frame2 = seal(a, b, { roster: { ...a.roster, at: a.roster.at + 2 } });
    relay.toClient = undefined;
    expect(await b.receive(frame2)).toBe("dropped");
    expect(b.book.fork).toBeUndefined();
  });

  it("pages through cards", async () => {
    const { a, b, relay, mesh } = await pair();
    const card = sealMessage({ roster: a.roster, sender: { deviceId: a.device.id, keys: keysOf(a.device) }, session: "a", sid: a.sid, to: ["*"], seq: 0, at: Date.now(), kind: "card", card: { cwd: "w" }, recipients: a.roster.devices.map((d) => d.id) });
    const unknownCard = sealMessage({ roster: a.roster, sender: { deviceId: a.device.id, keys: keysOf(a.device) }, session: "ghost", sid: ulid(), to: ["*"], seq: 0, at: Date.now(), kind: "card", card: { cwd: "g" }, recipients: a.roster.devices.map((d) => d.id) });
    relay.inject(mesh, JSON.stringify({ t: "cards", cards: [card, unknownCard], more: true }));
    relay.inject(mesh, JSON.stringify({ t: "cards", cards: [], more: true }));
    relay.inject(mesh, JSON.stringify({ t: "card", msg: { ...card, sig: b64u.encode(new Uint8Array(64)) } }));
    relay.inject(mesh, JSON.stringify({ t: "card", msg: seal(a, b) }));
    await until(() => relay.sentByClients.some((t) => t.startsWith('{"t":"cards.get"')));
    await until(async () => (await b.listPeers()).find((p) => p.address === "a@one")?.card?.cwd === "w");
  });
});

describe("receiving edge cases", () => {
  it("drops a card or a seq replay delivered as a message, and parks at most 64", async () => {
    const { a, b } = await pair();
    const card = sealMessage({ roster: a.roster, sender: { deviceId: a.device.id, keys: keysOf(a.device) }, session: "a", sid: a.sid, to: ["*"], seq: 0, at: Date.now(), kind: "card", card: {}, recipients: a.roster.devices.map((d) => d.id) });
    expect(await b.receive(card)).toBe("dropped");
    const sid = ulid();
    const one = seal(a, b, { seq: 5, sid });
    expect(await b.receive(one)).toBe("accepted");
    expect(await b.receive(seal(a, b, { seq: 5, sid, id: ulid() }))).toBe("dropped");
    // Parking: a message from a newer roster the relay will not serve.
    await fs.mkdir(b.files.behindDir, { recursive: true });
    for (let i = 0; i < PARKED_MAX + 2; i++) await fs.writeFile(join(b.files.behindDir, `${ulid(i + 1)}.json`), "{}");
    const ahead = seal(a, b, { roster: { ...a.roster, seq: 99 } });
    // Offline, so the chain cannot be fetched and the message is parked.
    const holder = b as unknown as { conn: unknown };
    const conn = holder.conn;
    holder.conn = { current: undefined };
    expect(await b.receive(ahead)).toBe("behind");
    expect((await fs.readdir(b.files.behindDir)).length).toBe(PARKED_MAX);
    holder.conn = conn;
  });

  it("retries parked messages, dropping unreadable ones, keeping those still behind", async () => {
    const { a, b, relay, mesh } = await pair();
    await fs.mkdir(b.files.behindDir, { recursive: true });
    await fs.writeFile(join(b.files.behindDir, "bad.json"), "{");
    const stillAhead = seal(a, b, { roster: { ...a.roster, seq: 99 } });
    await fs.writeFile(join(b.files.behindDir, `${stillAhead.id}.json`), JSON.stringify(stillAhead));
    relay.toClient = (text) => (text.startsWith('{"t":"roster"') ? JSON.stringify({ t: "error", code: "m", message: "no", ref: "roster.get" }) : text);
    relay.dropAll();
    await sleep(80);
    await b.ready(3000);
    await until(async () => !(await fs.readdir(b.files.behindDir)).includes("bad.json"));
    expect(await fs.readdir(b.files.behindDir)).toEqual([`${stillAhead.id}.json`]);
    void mesh;
  });

  it("notes a file it could not fetch, and refuses a tampered or missing blob", { timeout: 20_000 }, async () => {
    const { a, b, relay } = await pair();
    const fake = sealBlob(new TextEncoder().encode("never uploaded"));
    const file = { blob: fake.blob, name: "x.txt", size: fake.size, mime: "text/plain", key: fake.key, sha256: fake.sha256, chunks: 1 };
    await b.receive(seal(a, b, { kind: "file", text: undefined, file }));
    await until(async () => (await unread(b)).some((i) => i.kind === "file"));
    expect((await unread(b)).find((i) => i.kind === "file")!.rendered).toMatch(/not saved: /);
    // A stored chunk whose ciphertext was changed in transit.
    const dir = await scratch("tamper");
    await fs.writeFile(join(dir, "t.txt"), "tamper me");
    relay.toClient = (text) => (text.startsWith('{"t":"blob.chunk"') ? text.replace(/"data":"(.)/, (_m, c: string) => `"data":"${c === "A" ? "B" : "A"}`) : text);
    await a.sendFile("b@two", join(dir, "t.txt"));
    await until(async () => (await unread(b)).filter((i) => i.kind === "file").length === 2, 10_000, "second file");
    expect((await unread(b)).filter((i) => i.kind === "file")[1]!.rendered).toMatch(/not saved: blob_decrypt_failed/);
    relay.toClient = (text) => (text.startsWith('{"t":"blob.stored"') ? JSON.stringify({ t: "error", code: "blob_quota", message: "full", ref: "blob.put" }) : text);
    await expect(a.sendFile("b@two", join(dir, "t.txt"))).rejects.toThrow(/did not store the file: full/);
  });

  it("logs inbound failures and housekeeping failures without stopping", async () => {
    const { a, b } = await pair();
    const logs: string[] = [];
    (b as unknown as { log: (l: string) => void }).log = (l) => logs.push(l);
    await fs.mkdir(b.files.presencePath, { recursive: true });
    await until(() => logs.some((l) => l.startsWith("wim: housekeeping:")));
    await fs.rm(b.files.presencePath, { recursive: true });
    // A file where the spool directory should be: nothing can be written into it, on any platform.
    await fs.rm(b.files.spoolDir, { recursive: true, force: true });
    await fs.writeFile(b.files.spoolDir, "");
    await a.send("b@two", "cannot be written");
    await until(() => logs.some((l) => l.startsWith("wim: inbound:")));
    await expect(b.receive(seal(a, b))).rejects.toThrow();
    await fs.rm(b.files.spoolDir);
    expect(await b.receive(seal(a, b))).toBe("accepted");
  });

  it("reads corrupt task, sent-task and lease files as empty", async () => {
    const { a, b } = await pair();
    await fs.writeFile(b.files.tasksPath, "{");
    await fs.writeFile(a.files.sentTasksPath, "{");
    await fs.writeFile(a.mesh.leaseNamesPath, "{");
    await expect(b.reply(ulid(), "done", "x")).rejects.toThrow(/no task/);
    await a.send("b@two", "t", { kind: "task" });
    expect((await a.acquireLease("l", 5000, false)).status).toBe("granted");
  });

  it("tells the person through the notifier when something is held", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"], { trust: false });
    const notes: string[] = [];
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    await session(devices[1]!, mesh, relay, { name: "b", notifier: { notify: async (t) => void notes.push(t) } });
    await a.send("b@two", "1");
    await a.send("b@two", "2");
    await until(() => notes.length === 2);
    expect(notes).toEqual(["worldinmotion: 1 message held for approval", "worldinmotion: 2 messages held for approval"]);
  });

  it("resumes only the paused device's breaker items", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"]);
    await new MeshFiles(devices[1]!.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, breaker: { perPeerPerHour: 1, totalPerHour: 50, pingPong: false }, policy: { ...c.policy, [devices[2]!.device.id]: "hold" } }));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const c = await session(devices[2]!, mesh, relay, { name: "c" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    await a.send("b@two", "1");
    await a.send("b@two", "2");
    await c.send("b@two", "held by policy");
    await until(async () => (await b.held.list()).length === 2);
    expect(await b.resumePeer("a@one")).toBe(1);
    expect((await b.held.list()).map((h) => h.reason)).toEqual(["policy"]);
  });
});

describe("relay refusals and other answers", () => {
  it("surfaces a refused send, a refused room join and a refused room history", async () => {
    const { a, relay } = await pair();
    relay.toRelay = (text) => (text.startsWith('{"t":"send"') ? text.replace(/"session":"a"/, '"session":"zz"') : text);
    await expect(a.send("b@two", "x")).rejects.toThrow(/relay refused the send: from does not match/);
    relay.toRelay = undefined;
    rewriteOnce(relay, (f) => f["t"] === "room.joined", () => ({ t: "error", code: "room_limit", message: "too many rooms", ref: "room.join" }));
    await expect(a.joinRoom("#r")).rejects.toThrow(/could not join #r: too many rooms/);
    rewriteOnce(relay, (f) => f["t"] === "room.history", () => ({ t: "error", code: "x", message: "no", ref: "room.history" }));
    await expect(a.roomHistory("#r", { before: 5 })).rejects.toThrow(/no history for #r/);
  });

  it("reads room history of files, tasks and results, skipping what does not open, and walks for newer senders", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a", userHome: "/none" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    await a.joinRoom("#r");
    await b.joinRoom("#r");
    const dir = await scratch("rh");
    await fs.writeFile(join(dir, "f.txt"), "f");
    await b.sendFile("#r", join(dir, "f.txt")).catch(() => undefined);
    await a.sendFile("#r", join(dir, "f.txt"));
    const t = await a.send("#r", "a task", { kind: "task", deadline: Date.now() + 60_000 });
    await a.send("#r", "a result", { kind: "result", reply_to: t.id, status: "done" });
    await a.send("#r", "a reply", { reply_to: t.id });
    // A new device posts after b stopped hearing roster pushes.
    let block = true;
    relay.toClient = (text, conn) => (block && text.startsWith('{"t":"roster","chain":[') && conn === connOf(relay, mesh, b.sid) ? undefined : text);
    const d = await newDevice("three");
    await publishRoster(a, (cur) => nextRoster(cur, { add: [makeDeviceRecord("three", keysOf(d.device), "member", Date.now())] }, { keys: keysOf(a.device) }, Date.now()));
    const filesD = new MeshFiles(d.home.meshDir(mesh), FS);
    const filesA = new MeshFiles(devices[0]!.home.meshDir(mesh), FS);
    const chain: Roster[] = [];
    for (const seq of await rosterSeqs(filesA)) chain.push((await filesA.loadRoster(seq))!);
    await filesD.createConfig({ ...(await filesA.loadConfig()), device: d.device.id, policy: {} }, chain);
    const ds = await session(d, mesh, relay, { name: "d" });
    await ds.joinRoom("#r");
    await ds.send("#r", "from the new device");
    await sleep(30);
    block = false;
    expect(b.roster.seq).toBeLessThan(a.roster.seq);
    const h = await b.roomHistory("#r", { limit: 50 });
    expect(h.items.some((i) => i.includes("an earlier file from room history"))).toBe(true);
    expect(h.items.some((i) => i.includes("a task"))).toBe(true);
    expect(h.items.some((i) => i.includes("a result"))).toBe(true);
    expect(h.items.some((i) => i.includes("from the new device"))).toBe(true);
    // Something that does not open is skipped.
    rewriteOnce(relay, (f) => f["t"] === "room.history", (f) => ({ ...f, msgs: (f["msgs"] as Array<{ cursor: number; msg: SendFrame }>).map((m) => ({ ...m, msg: { ...m.msg, sig: b64u.encode(new Uint8Array(64)) } })) }));
    expect((await b.roomHistory("#r")).items).toEqual([]);
  }, 20_000);

  it("lists leases it knows only by key", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    await a.acquireLease("secret-name", 10_000, false);
    expect((await b.listLeases())[0]!.name).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("returns relayed items read through the inbox, and waits without push in channel mode", async () => {
    const { a, b, devices, mesh } = await pair();
    await new MeshFiles(devices[1]!.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, policy: { [a.device.id]: "deliver-relayed" } }));
    await a.send("b@two", "relayed", { relayed: true });
    await until(async () => (await unread(b)).length === 1);
    expect((await b.inbox(false))[0]!.relayed).toBe(true);
    expect(await b.spool.relayed()).toEqual([]);
    b.push = async () => undefined;
    const listening = b.listenerCount("item");
    const waiting = b.next(1000);
    // An item while push is set goes to the channel, not to the wait. It is emitted once the wait
    // listens, so the check does not depend on how fast a send arrives.
    await until(() => b.listenerCount("item") > listening);
    b.emit("item", { cursor: 1 });
    expect(await waiting).toBeUndefined();
    expect(b.listenerCount("item")).toBe(listening);
  });

  it("never hands out an item twice when its event arrives after the scan took it", async () => {
    const { a, b } = await pair();
    await a.send("b@two", "once");
    await until(async () => (await unread(b)).length === 1);
    const first = await b.next(10);
    expect(first?.rendered).toContain("once");
    // That item's own event, arriving late while a new wait listens (seen on a slow macOS
    // runner): it is not new, so the wait ignores it and takes the next real one.
    const listening = b.listenerCount("item");
    const waiting = b.next(3000);
    await until(() => b.listenerCount("item") > listening);
    b.emit("item", first!);
    await a.send("b@two", "the next one");
    expect((await waiting)?.rendered).toContain("the next one");
  });

  it("records room addressees, skipping peers of unknown devices", async () => {
    const { a, b } = await pair();
    await b.joinRoom("#t");
    await until(() => a.peers.get("b@two")?.rooms.includes("#t") === true);
    a.peers.set("ghost@gone", { address: "ghost@gone", kind: "mcp", status: "idle", since: 0, rooms: ["#t"] });
    const out = await a.send("#t", "who", { kind: "task" });
    const sent = JSON.parse(await fs.readFile(a.files.sentTasksPath, "utf8")) as Record<string, { addressees: string[] }>;
    expect(sent[out.id]!.addressees).toEqual([`${b.device.id}/b`, "?/ghost"]);
  });
});

function connOf(relay: RelayHarness, mesh: string, sid: string): string {
  return [...relay.relays.get(mesh)!.states.entries()].find(([, st]) => st.sid === sid)?.[0] ?? "";
}
