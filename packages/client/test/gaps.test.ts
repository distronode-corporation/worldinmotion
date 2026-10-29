import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  b64u,
  createInvite,
  generateDeviceKeys,
  makeDeviceRecord,
  nextRoster,
  rosterRef,
  ulid,
  type Roster,
} from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { botIO, meshPort } from "../src/adapters.ts";
import { joinMesh, publishRoster, recoverMesh } from "../src/admin.ts";
import { cardLabel, readBranch } from "../src/cards.ts";
import { MeshSession } from "../src/client.ts";
import { fsOps, withLock, claimLock } from "../src/fsx.ts";
import { WimMcp } from "../src/mcp.ts";
import { MeshFiles, parseMeshConfig, DEFAULT_BREAKER } from "../src/mesh.ts";
import { listAllHeld } from "../src/offline.ts";
import { SeqStore } from "../src/replay.ts";
import { fetchHeldCode, showSocketPath } from "../src/secretout.ts";
import { SessionFiles, newSessionState } from "../src/session.ts";
import { Connection, Link, type Dialer, type WireSocket } from "../src/wire.ts";
import { FS, makeMesh, newDevice, openSession, RELAY, RelayHarness, scratch, sessionOpts, sleep, until, rosterSeqs, keysOf } from "./helpers.ts";

const open: Array<{ stop(): Promise<unknown> }> = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

async function session(...args: Parameters<typeof openSession>): Promise<MeshSession> {
  const s = await openSession(...args);
  open.push(s);
  return s;
}

/** A relay played by the test: `on` answers each client frame. */
function scripted(on: (f: Record<string, unknown>, push: (frame: unknown) => void) => void): Dialer {
  return async () => {
    let msg: (t: string) => void = () => undefined;
    let shut: (c: number, r: string) => void = () => undefined;
    const push = (f: unknown): void => void setImmediate(() => msg(JSON.stringify(f)));
    setImmediate(() => push({ t: "hello", v: 1, nonce: b64u.encode(new Uint8Array(32).fill(2)), at: Date.now() }));
    const sock: WireSocket = {
      send: (text) => on(JSON.parse(text) as Record<string, unknown>, push),
      close: () => setImmediate(() => shut(1000, "")),
      onMessage: (cb) => void (msg = cb),
      onClose: (cb) => void (shut = cb),
    };
    return sock;
  };
}

async function chainOf(d: { home: { meshDir(m: string): string } }, mesh: string): Promise<Roster[]> {
  const files = new MeshFiles(d.home.meshDir(mesh), FS);
  const out: Roster[] = [];
  for (const seq of await rosterSeqs(files)) out.push((await files.loadRoster(seq))!);
  return out;
}

describe("admin edges", () => {
  it("refuses to trust its own published roster when this device's book is forked", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const admin = await session(devices[0]!, mesh, relay, { name: "a" });
    await new MeshFiles(devices[0]!.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, fork: { seq: 9, a: "a", b: "b", base: [], at: 1 } }));
    const d = await newDevice("x");
    await expect(publishRoster(admin, (cur) => nextRoster(cur, { add: [makeDeviceRecord("x", keysOf(d.device), "member", 1)] }, { keys: keysOf(admin.device) }, Date.now()))).rejects.toThrow(/did not verify here: forked/);
  });

  it("joins through a pinned relay and walks a paged chain, refusing bad answers on the way", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const admin = await session(devices[0]!, mesh, relay, { name: "a" });
    const joiner = await newDevice("j");
    for (let i = 0; i < 3; i++) {
      const d = await newDevice(`m${i}`);
      await publishRoster(admin, (cur) => nextRoster(cur, { add: [makeDeviceRecord(d.device.name, keysOf(d.device), "member", 1)] }, { keys: keysOf(admin.device) }, Date.now()));
    }
    const chain = await chainOf(devices[0]!, mesh);
    const withMe = nextRoster(chain.at(-1)!, { add: [makeDeviceRecord("j", keysOf(joiner.device), "member", 1)] }, { keys: keysOf(admin.device) }, Date.now());
    const full = [...chain, withMe];
    const pin = chain[0]!;
    const inv = createInvite({ relay: RELAY, mesh, pin: rosterRef(pin), now: Date.now(), tls: "U".repeat(43) });
    const pins: Array<string | undefined> = [];
    const dial = (mode: "ok" | "auth" | "page" | "bad"): Dialer => {
      const inner = scripted((f, push) => {
        if (f["t"] === "join") push({ t: "joined", chain: full.slice(0, 2), more: true });
        if (f["t"] === "auth") push(mode === "auth" ? { t: "error", code: "unauthorized", message: "no", ref: "auth" } : { t: "ready", sid: ulid(), name: "join", cursor: 0, roster: withMe, more: false, peers: [] });
        if (f["t"] === "roster.get") {
          const from = f["from"] as number;
          if (mode === "page") return push({ t: "error", code: "m", message: "no", ref: "roster.get" });
          const page = full.slice(from - 1, from + 1);
          push({ t: "roster", chain: mode === "bad" ? [page[0], { ...page[1], at: 1 }] : page, more: from + 1 < full.length });
        }
      });
      return async (url, o) => {
        pins.push(o.tlsPin);
        return inner(url, o);
      };
    };
    const go = (mode: "ok" | "auth" | "page" | "bad") => joinMesh({ home: joiner.home, device: joiner.device, code: inv.code, dialer: dial(mode), now: Date.now, showSas: () => undefined });
    await expect(go("auth")).rejects.toThrow(/refused this device after admitting it/);
    await expect(go("page")).rejects.toThrow(/would not serve the roster chain/);
    await expect(go("bad")).rejects.toThrow(/does not verify/);
    const joined = await go("ok");
    expect(joined.roster.seq).toBe(withMe.seq);
    expect(pins.every((p) => p === "U".repeat(43))).toBe(true);
  });

  it("recovers through a paged chain, picking a free recovery name, with a pin", async () => {
    const relay = new RelayHarness();
    const { mesh, devices, recoveryCode } = await makeMesh(relay, ["lost"]);
    const admin = await session(devices[0]!, mesh, relay, { name: "a" });
    const spare = generateDeviceKeys();
    await publishRoster(admin, (cur) => nextRoster(cur, { add: [makeDeviceRecord("recovery-2", spare, "admin", 1)] }, { keys: keysOf(admin.device) }, Date.now()));
    const chain = await chainOf(devices[0]!, mesh);
    let published: Roster | undefined;
    const pins: Array<string | undefined> = [];
    const pageError = { on: false };
    const inner = scripted((f, push) => {
      if (f["t"] === "auth") push({ t: "recover.ready", roster: chain.at(-1) });
      if (f["t"] === "roster.get") {
        const from = f["from"] as number;
        if (pageError.on) return push({ t: "error", code: "m", message: "no", ref: "roster.get" });
        push({ t: "roster", chain: chain.slice(from - 1, from), more: from < chain.length });
      }
      if (f["t"] === "roster.publish") {
        published = f["roster"] as Roster;
        push({ t: "roster", chain: [published], more: false });
      }
    });
    const dialer: Dialer = async (url, o) => {
      pins.push(o.tlsPin);
      return inner(url, o);
    };
    const fresh = await newDevice("new");
    pageError.on = true;
    await expect(recoverMesh({ home: fresh.home, device: fresh.device, code: recoveryCode!, relay: RELAY, tls: "V".repeat(43), revoke: [], dialer, now: Date.now, confirm: async () => true })).rejects.toThrow(/would not serve the roster chain/);
    pageError.on = false;
    await recoverMesh({ home: fresh.home, device: fresh.device, code: recoveryCode!, relay: RELAY, tls: "V".repeat(43), revoke: [], dialer, now: Date.now, confirm: async () => true });
    expect(published!.devices.some((d) => d.name === "recovery-3")).toBe(true);
    expect(pins.every((p) => p === "V".repeat(43))).toBe(true);
  });
});

describe("session edges", () => {
  it("catches up across several roster pages after a long absence", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const admin = await session(devices[0]!, mesh, relay, { name: "a" });
    for (let i = 0; i < 66; i++) {
      const keys = generateDeviceKeys();
      await publishRoster(admin, (cur) => nextRoster(cur, { add: [makeDeviceRecord(`d${i}`, keys, "member", 1)] }, { keys: keysOf(admin.device) }, Date.now()));
    }
    const b = await MeshSession.open(sessionOpts(devices[1]!, mesh, relay, { name: "b" }));
    open.push(b);
    b.start();
    await b.ready(30_000);
    expect(b.roster.seq).toBe(admin.roster.seq);
  }, 60_000);

  it("gives up probing for a fork when the relay does not answer", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b", answerMs: 100 });
    relay.toClient = (text) => (text.startsWith('{"t":"roster"') ? undefined : text);
    const frame = (await import("@worldinmotion/protocol")).sealMessage({ roster: { ...a.roster, at: a.roster.at + 1 }, sender: { deviceId: a.device.id, keys: keysOf(a.device) }, session: "a", sid: ulid(), to: ["b@two"], seq: 1, at: Date.now(), text: "x", recipients: [b.device.id] });
    expect(await b.receive(frame)).toBe("dropped");
  });

  it("skips room history it cannot verify a newer roster for", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b", answerMs: 300 });
    await a.joinRoom("#h");
    await b.joinRoom("#h");
    await a.send("#h", "hello");
    relay.toClient = (text) => {
      if (!text.startsWith('{"t":"room.history"')) return text.startsWith('{"t":"roster"') ? JSON.stringify({ t: "error", code: "x", message: "no", ref: "roster.get" }) : text;
      const f = JSON.parse(text) as { msgs: Array<{ msg: { roster: { seq: number } } }> };
      return JSON.stringify({ ...f, more: true, msgs: f.msgs.map((m) => ({ ...m, msg: { ...m.msg, roster: { ...m.msg.roster, seq: 50 } } })) });
    };
    const h = await b.roomHistory("#h");
    expect(h).toEqual({ items: [], more: true });
  });

  it("applies a decision marker for an id it no longer holds without failing, and sends presence once", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    await a.held.mark(ulid(), "approve");
    await until(async () => (await fs.readdir(a.held.dir)).length === 0);
    // A marker still being written is left alone; two passes at once run as one.
    await fs.mkdir(a.files.controlDir, { recursive: true });
    await fs.writeFile(join(a.files.controlDir, "resume-x@y.123.tmp"), "");
    await Promise.all([a.tick(), a.tick()]);
    expect(await fs.readdir(a.files.controlDir)).toEqual(["resume-x@y.123.tmp"]);
    await fs.writeFile(a.files.presencePath, "busy");
    await sleep(80);
    const sent = () => relay.sentByClients.filter((t) => t === '{"t":"presence","status":"busy"}').length;
    expect(sent()).toBe(1);
  });

  it("resends its card only when it changes, at most once a minute", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    let now = Date.now();
    const work = await scratch("card-time");
    // The timer never fires, and the card step is called directly: a housekeeping pass can skip it
    // (a reconnect, or a file the OS holds on Windows), which left the "a minute on, same card"
    // return unreached on Windows CI while the test still passed.
    const a = await session(devices[0]!, mesh, relay, { name: "a", cwd: work, now: () => now, tickMs: 3_600_000 });
    type CardState = { cardAt: number; sendCard(link: Awaited<ReturnType<typeof a.ready>>, force: boolean): Promise<void> };
    const inner = a as unknown as CardState;
    // Session a's cards only: the device's setup session publishes one too, empty, for its prekey.
    const cards = () => relay.sentByClients.filter((t) => t.startsWith('{"t":"card.set"') && t.includes('"session":"a"')).length;
    await until(() => cards() === 1);
    const sentAt = inner.cardAt;
    now += 61_000;
    // A minute on with the same card: past the rate limit, then the "same card" return.
    expect(now - inner.cardAt).toBeGreaterThanOrEqual(60_000);
    await inner.sendCard(await a.ready(5000), false);
    expect(cards()).toBe(1);
    expect(inner.cardAt).toBe(sentAt);
    await fs.mkdir(join(work, ".git"));
    await fs.writeFile(join(work, ".git", "HEAD"), "ref: refs/heads/dev\n");
    now += 61_000;
    await inner.sendCard(await a.ready(5000), false);
    await until(() => cards() === 2);
    expect(inner.cardAt).toBe(now);
  });

  it("reports results without status or reply_to defensively, and unknown peer kinds", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const s = await session(devices[0]!, mesh, relay, { name: "a" });
    const items: Array<{ fromKind: string }> = [];
    botIO(s).onItem((i) => items.push(i));
    const results: Array<{ status: string }> = [];
    meshPort(s).onResult((r) => results.push(r));
    s.emit("message", { kind: "msg", peer: "ghost@nowhere", id: "1", at: 1, dir: "in", text: "t", cursor: 0 });
    s.emit("message", { kind: "result", peer: "ghost@nowhere", id: "2", at: 1, dir: "in", text: "t", cursor: 0, reply_to: "T" });
    expect(items[0]!.fromKind).toBe("unknown");
    expect(results[0]!.status).toBe("done");
  });
});

describe("mcp edges", () => {
  async function connect(server: WimMcp) {
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await server.server.connect(y);
    await client.connect(x);
    open.push({ stop: async () => (await client.close(), await server.close()) });
    return client;
  }

  it("handles calls without arguments, root input errors, transport errors, defaults and progress", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const work = await scratch("mcp-card");
    await fs.mkdir(join(work, ".git"));
    await fs.writeFile(join(work, ".git", "HEAD"), "ref: refs/heads/feat\n");
    const peer = await session(devices[1]!, mesh, relay, { name: "peer", cwd: work });
    const server = new WimMcp({ session: sessionOpts(devices[0]!, mesh, relay, { name: "me" }), channel: false, internalTools: true, version: "t", progressMs: 10 });
    const client = await connect(server);
    const call = async (name: string, args?: Record<string, unknown>, onprogress?: () => void) =>
      (await client.callTool({ name, ...(args === undefined ? {} : { arguments: args }) }, CallToolResultSchema, onprogress === undefined ? {} : { onprogress })) as { content: Array<{ text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };
    await server.start();
    await server.current!.ready(3000);
    expect((await call("rooms", { action: "list" })).content[0]!.text).toBe("This session is in: no rooms. Rooms peers are in: none.");
    const token = (await call("_internal", { op: "hello", args: { claudeSessionId: "g" } })).structuredContent!["token"];
    await until(async () => ((await call("_internal", { op: "peers", args: {}, token })).structuredContent!["peers"] as Array<{ branch?: string }>)[0]?.branch === "feat");
    expect((await call("peers")).content[0]!.text).toMatch(/branch=feat/);
    expect((await server.call("send", "not an object", undefined, async () => undefined)).content[0]).toMatchObject({ text: expect.stringMatching(/invalid input: input:/) });
    // ask and wait with their defaults, answered quickly
    peer.on("message", (m: { kind: string; id: string }) => {
      if (m.kind === "task") void peer.reply(m.id, "done", "ok");
    });
    expect((await call("ask", { to: "peer@two", task: "q" })).structuredContent).toMatchObject({ status: "answered" });
    peer.removeAllListeners("message");
    await peer.send("me@one", "waiting already");
    await until(async () => (await server.current!.spool.unread()).length > 0);
    expect((await call("wait", {})).content[0]!.text).toContain("waiting already");
    let ticks = 0;
    const waiting = call("wait", { timeout_s: 1 }, () => ticks++);
    expect((await waiting).content[0]!.text).toBe("No new items in 1 s.");
    expect(ticks).toBeGreaterThan(0);
    expect((await call("wait", { timeout_s: 1 })).content[0]!.text).toBe("No new items in 1 s.");
    await call("send", { to: "peer@two", text: "re", reply_to: ulid(), notify_when_idle: false });
    await peer.joinRoom("#m");
    await peer.send("#m", "one");
    await peer.send("#m", "two");
    await call("rooms", { action: "join", room: "#m" });
    expect((await call("rooms", { action: "history", room: "#m", limit: 1 })).content[0]!.text).toMatch(/older messages exist/);
    relay.down = true;
    relay.dropAll();
    const down = await call("peers");
    expect(down.isError).toBe(true);
    // The close reason is the relay's text, so the model reads it labelled as such.
    expect(down.content[0]!.text).toBe('the relay closed the connection (1006); relay said (not the person): "dropped"');
  }, 20_000);
});

describe("last corners", () => {
  it("keeps a parked message that is still behind, and reports wait progress", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const { sealMessage } = await import("@worldinmotion/protocol");
    const ahead = sealMessage({ roster: { ...a.roster, seq: 77 }, sender: { deviceId: a.device.id, keys: keysOf(a.device) }, session: "a", sid: ulid(), to: ["b@two"], seq: 1, at: Date.now(), text: "x", recipients: [b.device.id] });
    await fs.mkdir(b.files.behindDir, { recursive: true });
    await fs.writeFile(join(b.files.behindDir, `${ahead.id}.json`), JSON.stringify(ahead));
    const holder = b as unknown as { conn: unknown; retryParked(): Promise<void> };
    const conn = holder.conn;
    holder.conn = { current: undefined };
    await holder.retryParked();
    holder.conn = conn;
    expect(await fs.readdir(b.files.behindDir)).toEqual([`${ahead.id}.json`]);
    const server = new WimMcp({ session: sessionOpts(devices[0]!, mesh, relay, { name: "w" }), channel: false, internalTools: false, version: "t", progressMs: 10 });
    await server.start();
    open.push({ stop: () => server.close() });
    const notes: unknown[] = [];
    const r = await server.call("wait", { timeout_s: 1 }, "tok", (async (n: unknown) => void notes.push(n)) as never);
    expect(r.content[0]).toMatchObject({ text: "No new items in 1 s." });
    expect(notes[0]).toMatchObject({ method: "notifications/progress", params: { progressToken: "tok", total: 1 } });
    await server.call("wait", { timeout_s: 1 }, "tok", (async () => {
      throw new Error("gone");
    }) as never);
  });

  it("keeps a busy link alive without pinging", async () => {
    const b64 = b64u.encode(new Uint8Array(32));
    let timer: NodeJS.Timeout | undefined;
    const sent: string[] = [];
    const d: Dialer = async () => {
      let m: (t: string) => void = () => undefined;
      setImmediate(() => m(JSON.stringify({ t: "hello", v: 1, nonce: b64, at: 1 })));
      return {
        send: (text) => {
          sent.push(text);
          if (text.includes('"t":"auth"')) {
            setImmediate(() => m(JSON.stringify({ t: "ready", sid: ulid(), name: "a", cursor: 0, roster: { mesh: b64u.encode(new Uint8Array(16)), seq: 1, prev: null, devices: [], revoked: [], by: "A".repeat(22), at: 1, sig: b64u.encode(new Uint8Array(64)) }, more: false, peers: [] })));
            timer = setInterval(() => m(JSON.stringify({ t: "pong" })), 5);
          }
        },
        close: () => clearInterval(timer),
        onMessage: (cb) => void (m = cb),
        onClose: () => undefined,
      };
    };
    const conn = new Connection({ dialer: d, url: "ws://x", auth: () => ({ t: "auth" }) as never, onReady: async () => undefined, onFrame: () => undefined, onFatal: () => undefined, log: () => undefined, heartbeatMs: 30 });
    conn.start();
    await conn.ready(1000);
    await sleep(120);
    expect(sent.filter((t) => t.includes('"ping"'))).toEqual([]);
    conn.stop();
    clearInterval(timer);
  });
});

describe("small module edges", () => {
  it("covers card, config, lock, seq and wire corners", async () => {
    const root = await scratch("corner");
    await fs.writeFile(join(root, "file"), "x");
    await fs.writeFile(join(root, ".git"), `gitdir: ${join(root, "file")}\n`);
    expect(await readBranch(root)).toBeUndefined();
    expect(cardLabel({ branch: "b" })).toBe("branch=b");
    const raw = { v: 1, mesh: "m", relay: RELAY, device: "d", pin: { seq: 1, hash: "h" } };
    expect(parseMeshConfig({ ...raw, breaker: { perPeerPerHour: 3, totalPerHour: -1 } }, "p").breaker).toEqual({ perPeerPerHour: 3, totalPerHour: DEFAULT_BREAKER.totalPerHour, pingPong: true });
    // Locks whose file cannot be created, for a reason other than being there already: a name
    // that no file system accepts, which fails the same way on every platform. Windows looks at
    // the path before it creates; the others find out from the create itself.
    for (const platform of ["linux", "win32"]) {
      const env = { platform, pid: process.pid };
      await expect(withLock(join(root, "l\0.lock"), async () => 1, env)).rejects.toThrow();
      await expect(claimLock(join(root, "c\0.lock"), env)).rejects.toThrow();
    }
    // A sibling's higher seq in memory survives a file rewritten from elsewhere.
    const path = join(root, "seq.json");
    const s = new SeqStore(path, FS);
    await s.isNew("a@x", "D".repeat(22), "S", 1);
    await s.record("a@x", "D".repeat(22), "S", 9);
    await fs.writeFile(path, JSON.stringify({ v: 1, byAddress: {} }));
    await s.record("a@x", "D".repeat(22), "T", 1);
    expect(await new SeqStore(path, FS).isNew("a@x", "D".repeat(22), "S", 9)).toBe(false);
    // A server that hangs up without a code (a Unix socket, or a named pipe on Windows).
    const sock = showSocketPath(root, process.platform);
    const srv = createServer((c) => c.end());
    await new Promise<void>((r) => srv.listen(sock, r));
    await expect(fetchHeldCode(sock)).rejects.toThrow(/no recovery code is waiting/);
    srv.close();
    void fsOps;
  });

  it("reads held items of sessions without state", async () => {
    const root = await scratch("nostate");
    const mesh = new MeshFiles(root, FS);
    const st = newSessionState("x", "mcp");
    const files = new SessionFiles(mesh, st.sid, FS);
    await fs.mkdir(files.heldDir, { recursive: true });
    await fs.writeFile(join(files.heldDir, `${ulid()}.json`), "{}");
    expect(await listAllHeld(mesh, FS)).toEqual([]);
    const id = ulid();
    await fs.writeFile(join(files.heldDir, `${id}.json`), JSON.stringify({ id, from: "a@b", device: "d", kind: "msg", at: 1, preview: "", rendered: "", reason: "policy", entry: { dir: "in", peer: "a@b", device: "D".repeat(22), id, kind: "msg", at: 1, text: "t" } }));
    expect((await listAllHeld(mesh, FS))[0]!.session).toBe("?");
    const { decideHeld } = await import("../src/offline.ts");
    expect(await decideHeld(mesh, id, "approve", FS, Date.now)).toBe(1);
  });

  it("covers Link and Connection corners", async () => {
    let shut: (c: number, r: string) => void = () => undefined;
    let msg: (t: string) => void = () => undefined;
    const sock: WireSocket = { send: () => undefined, close: () => undefined, onMessage: (cb) => void (msg = cb), onClose: (cb) => void (shut = cb) };
    const opening = Link.open(async () => sock, "ws://x");
    await sleep(5);
    msg(JSON.stringify({ t: "hello", v: 1, nonce: b64u.encode(new Uint8Array(32)), at: 1 }));
    const { link } = await opening;
    const waiting = link.wait(() => false, 5000);
    shut(1006, "");
    await expect(waiting).rejects.toThrow(/closed the connection \(1006\)$/);
    const conn = new Connection({ dialer: async () => sock, url: "ws://x", auth: () => ({}) as never, onReady: async () => undefined, onFrame: () => undefined, onFatal: () => undefined, log: () => undefined });
    expect(conn.backoff(0)).toBeGreaterThanOrEqual(250);
    // A fatal close without a reason.
    const fatal: string[] = [];
    const d2: Dialer = async () => {
      let m2: (t: string) => void = () => undefined;
      let s2: (c: number, r: string) => void = () => undefined;
      setImmediate(() => m2(JSON.stringify({ t: "hello", v: 1, nonce: b64u.encode(new Uint8Array(32)), at: 1 })));
      return { send: () => setImmediate(() => s2(4004, "")), close: () => undefined, onMessage: (cb) => void (m2 = cb), onClose: (cb) => void (s2 = cb) };
    };
    const c2 = new Connection({ dialer: d2, url: "ws://x", auth: () => ({}) as never, onReady: async () => undefined, onFrame: () => undefined, onFatal: (r) => fatal.push(r), log: () => undefined });
    const ready = c2.ready(2000).catch((e: Error) => e.message);
    c2.start();
    await until(() => fatal.length === 1);
    expect(fatal[0]).toBe("this device was revoked from the mesh");
    expect(await ready).toBe("this device was revoked from the mesh");
  });
});
