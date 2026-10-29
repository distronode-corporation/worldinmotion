// The signer over its socket: the line protocol, the client's checks of who answers, timeouts and
// drops, and the device keyring that sessions use. Real sockets (a named pipe on Windows); every
// timeout is driven by fake timers, never waited out.

import {
  b64u,
  createPrekey,
  deviceIdFromSignPub,
  generateDeviceKeys,
  randomBytes,
  sealBox,
  signObject,
  utf8,
  type DeviceKeys,
  type OpenRequest,
} from "@worldinmotion/protocol";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentServer, answers, RUN_LIFETIME_MS, Signer, type LogEntry } from "../src/agent.ts";
import { agentEndpoint, endpointFiles, type EndpointFiles } from "../src/agentpath.ts";
import { parseAnswer, SignerClient, signerKeyring, SignerError, unseal } from "../src/signer.ts";
import { ephemeral, type Channel } from "../src/channel.ts";
import { sealKeyFile } from "../src/vault.ts";
import { FS, handHello, scratch } from "./helpers.ts";

const KDF = { N: 1024, r: 8, p: 1 };
const MESH = b64u.encode(randomBytes(16));
const ENV = { ...FS, uid: process.getuid?.() };

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of cleanup.splice(0).reverse()) await c();
});

/** A free endpoint in a fresh private directory: a Unix socket, or a named pipe on Windows. */
async function endpoint(): Promise<string> {
  return (await agentEndpoint(await scratch("ag"), ENV, true))!;
}

type Running = { server: AgentServer; signer: Signer; keys: DeviceKeys; at: string; id: string; client: SignerClient };

async function running(log: LogEntry[] = [], files: EndpointFiles = endpointFiles(process.platform), watchMs?: number): Promise<Running> {
  const keys = generateDeviceKeys();
  const data = randomBytes(32);
  const file = await sealKeyFile({ name: "laptop", keys, passphrase: "pass phrase", data, kdf: KDF });
  const unlocked = { keys: { ...keys, signSec: keys.signSec.slice(), boxSec: keys.boxSec.slice() }, data };
  const signer = new Signer({ file, unlocked, now: Date.now, pid: process.pid, log: (e) => log.push(e) });
  const at = await endpoint();
  const server = new AgentServer({ signer, endpoint: at, files, ...(watchMs === undefined ? {} : { watchMs }) });
  await server.listen();
  cleanup.push(() => server.close());
  const client = new SignerClient({ endpoint: at, expect: keys.signPub });
  cleanup.push(() => client.close());
  return { server, signer, keys, at, id: file.id, client };
}

type Answerer = { sealed(text: string): void; raw(text: string): void };

/**
 * A signer stand-in that holds a real device key and does the real handshake, so the client's
 * own checks pass; after the hello, `reply` answers each request, sealed or (to test the client)
 * in the clear.
 */
async function trustedFake(reply: (req: { i: number; op: string }, answer: Answerer) => void, o: Parameters<typeof handHello>[2] = {}): Promise<{ at: string; signPub: Uint8Array }> {
  const keys = generateDeviceKeys();
  const { at } = await fake((line, socket, state) => {
    if (state.channel === undefined) {
      const { i, a } = JSON.parse(line) as { i: number; a: { nonce: string; epub: string } };
      const { hello, channel } = handHello(keys, a, o);
      socket.write(`${JSON.stringify({ i, r: hello })}\n`);
      state.channel = channel;
      return;
    }
    const channel = state.channel;
    const req = JSON.parse(unseal(channel, line)!) as { i: number; op: string };
    reply(req, { sealed: (text) => socket.write(`${JSON.stringify({ x: channel.seal(text) })}\n`), raw: (text) => socket.write(`${text}\n`) });
  });
  return { at, signPub: keys.signPub };
}

/** A stand-in signer that answers with `reply` (or not at all). */
async function fake(reply: (line: string, socket: Socket, state: { channel?: Channel }) => void): Promise<{ at: string; server: Server }> {
  const at = await endpoint();
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buf = "";
    const state: { channel?: Channel } = {};
    socket.on("error", () => undefined);
    socket.on("data", (d: string) => {
      buf += d;
      for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        reply(line, socket, state);
      }
    });
  });
  await new Promise<void>((r) => server.listen(at, () => r()));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  return { at, server };
}

const failure = async (p: Promise<unknown>): Promise<SignerError> => {
  try {
    await p;
  } catch (error) {
    return error as SignerError;
  }
  throw new Error("expected a failure");
};

describe("the signer's socket", () => {
  it("answers a session's calls, and checks it holds the device key on every new connection", async () => {
    const r = await running();
    const hello = await r.client.hello();
    expect(hello).toMatchObject({ id: r.id, locked: false, signPub: b64u.encode(r.keys.signPub) });
    const obj = { device: r.id, mesh: MESH, at: Date.now() };
    expect((await r.client.call("sign", { type: "auth", obj }))["sig"]).toBe(signObject("auth", obj, r.keys.signSec).sig);
    // A second client with the wrong expectation is refused before it asks anything.
    const wrong = new SignerClient({ endpoint: r.at, expect: generateDeviceKeys().signPub });
    expect((await failure(wrong.call("status"))).code).toBe("mismatch");
    // One without an expectation (`wim agent status` on a plaintext key file) talks to it.
    const any = new SignerClient({ endpoint: r.at });
    expect((await any.call("status"))["id"]).toBe(r.id);
    any.close();
    expect(await answers(r.at)).toBe(true);
  });

  it("passes refusals on with their codes, and answers requests in order", async () => {
    const r = await running();
    expect((await failure(r.client.call("sign", { type: "prekey", obj: {} }))).code).toBe("refused");
    const [a, b] = await Promise.all([r.client.call("status"), r.client.call("prekey", { mesh: MESH, at: Date.now() })]);
    expect(a["ops"]).not.toHaveProperty("prekey");
    expect(b["sealed"]).toBeTypeOf("string");
  });

  it("a locked signer still proves itself with its run key, and refuses key operations itself", async () => {
    const log: LogEntry[] = [];
    const r = await running(log);
    await r.client.call("lock");
    const fresh = new SignerClient({ endpoint: r.at, expect: r.keys.signPub });
    cleanup.push(() => fresh.close());
    expect(await fresh.hello()).toMatchObject({ locked: true });
    expect(await fresh.call("status")).toMatchObject({ locked: true });
    const before = log.length;
    for (const [op, a] of [["prekey", { mesh: MESH, at: 1 }], ["sign", { type: "auth", obj: { device: r.id, at: Date.now() } }]] as const) {
      expect((await failure(fresh.call(op, a))).code).toBe("locked");
    }
    // Refused here: a signer that proved it is locked is not asked.
    expect(log.length).toBe(before);
    // One connected while it was unlocked still asks, and the signer refuses.
    expect((await failure(r.client.call("prekey", { mesh: MESH, at: Date.now() }))).code).toBe("locked");
    expect(log.at(-1)).toMatchObject({ op: "prekey", code: "locked" });
    // `lock` says what it found, sealed on the channel.
    expect(await fresh.call("lock")).toEqual({ was: true });
    await fresh.call("stop");
    await r.server.stopped;
  });

  it("an impostor that claims to be a locked signer is refused at the hello, and sent nothing more", async () => {
    const keys = generateDeviceKeys();
    const pub = b64u.encode(keys.signPub);
    const lines: string[] = [];
    // It knows the device's public key (the key file's public part says it), but no key to prove with.
    const { at } = await fake((line, socket) => {
      lines.push(line);
      const { i } = JSON.parse(line) as { i: number };
      socket.write(`${JSON.stringify({ i, r: { id: "x", name: "x", signPub: pub, boxPub: pub, locked: true, pid: 1 } })}\n`);
    });
    const client = new SignerClient({ endpoint: at, expect: keys.signPub });
    cleanup.push(() => client.close());
    const ring = signerKeyring(client, { signPub: keys.signPub, boxPub: keys.boxPub });
    const peer = generateDeviceKeys();
    await expect(ring.seal({ mesh: MESH, sender: "a".repeat(22), recipient: "b".repeat(22), aad: randomBytes(32), recipientBox: peer.boxPub, plaintext: utf8("the plan") })).rejects.toThrow(/could not prove/);
    expect((await failure(client.call("lock"))).code).toBe("mismatch");
    expect((await failure(client.call("stop"))).code).toBe("mismatch");
    expect(lines.map((l) => (JSON.parse(l) as { op: string }).op)).toEqual(["hello", "hello", "hello"]);
    expect(lines.join("\n")).not.toContain(b64u.encode(utf8("the plan")));
  });

  it("stop answers, then closes every connection and stops listening", async () => {
    const r = await running();
    const other = new SignerClient({ endpoint: r.at, expect: r.keys.signPub });
    await other.hello();
    await r.client.call("stop");
    await r.server.stopped;
    expect(r.signer.locked).toBe(true);
    expect(await answers(r.at)).toBe(false);
    expect((await failure(other.call("status"))).code).toBe("unavailable");
    // Closing again is a no-op.
    await r.server.close();
  });

  it("stops without waiting for a client that keeps its end of a connection open", async () => {
    // On Windows the client of `wim agent unlock` was still connected when the old signer
    // stopped, and the old signer waited for it. Here a client that never closes its end.
    const r = await running();
    const { createConnection } = await import("node:net");
    const stubborn = createConnection({ path: r.at, allowHalfOpen: true });
    stubborn.on("error", () => undefined);
    cleanup.push(() => void stubborn.destroy());
    await new Promise<void>((done) => stubborn.once("connect", () => done()));
    await r.client.call("stop");
    await r.server.stopped;
    expect(r.signer.locked).toBe(true);
  });

  it("a clock set back makes an unlocked signer issue a new run key, so clients still accept it (F1)", async () => {
    let now = Date.now();
    const keys = generateDeviceKeys();
    const file = await sealKeyFile({ name: "laptop", keys, passphrase: "pass phrase", kdf: KDF });
    const signer = new Signer({ file, unlocked: { keys, data: randomBytes(32) }, now: () => now, pid: 1, log: () => undefined });
    const at = await endpoint();
    const server = new AgentServer({ signer, endpoint: at, files: endpointFiles(process.platform) });
    await server.listen();
    cleanup.push(() => server.close());
    const connect = async () => {
      const client = new SignerClient({ endpoint: at, expect: keys.signPub, now: () => now });
      cleanup.push(() => client.close());
      return client.hello();
    };
    const first = await connect();
    // The clock steps back an hour (NTP, a resumed VM): the certificate is from the client's future.
    now -= 60 * 60_000;
    const after = await connect();
    expect(after.cert.issued).toBe(now);
    expect(after.cert.pub).not.toBe(first.cert.pub);
    // The watch does the same without waiting for a hello.
    now -= 60 * 60_000;
    await server.watch();
    expect((signer as unknown as { run: { body: { issued: number } } }).run.body.issued).toBe(now);
    expect((await connect()).cert.issued).toBe(now);
  });

  it("a locked signer whose run key's certificate ran out stops by itself (round 3)", async () => {
    let now = Date.now();
    const keys = generateDeviceKeys();
    const file = await sealKeyFile({ name: "laptop", keys, passphrase: "pass phrase", kdf: KDF });
    const signer = new Signer({ file, unlocked: { keys, data: randomBytes(32) }, now: () => now, pid: 1, log: () => undefined });
    const server = new AgentServer({ signer, endpoint: await endpoint(), files: endpointFiles(process.platform) });
    await server.listen();
    cleanup.push(() => server.close());
    // Unlocked, a run key is renewed at half its life and never runs out.
    now += RUN_LIFETIME_MS;
    await server.watch();
    signer.lock();
    now += RUN_LIFETIME_MS - 1;
    await server.watch();
    expect(signer.spent).toBe(false);
    now += 1;
    await server.watch();
    await server.stopped;
  });

  it("a request that comes before the endpoint's identity is recorded waits for it (re-review, N4)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = endpointFiles(process.platform);
    // The listener is up, but the step before the identity is recorded is held.
    const files: EndpointFiles = { ...real, secure: async (e) => gate.then(() => real.secure(e)) };
    const keys = generateDeviceKeys();
    const file = await sealKeyFile({ name: "laptop", keys, passphrase: "pass phrase", kdf: KDF });
    const signer = new Signer({ file, unlocked: { keys, data: randomBytes(32) }, now: Date.now, pid: 1, log: () => undefined });
    const at = await endpoint();
    const server = new AgentServer({ signer, endpoint: at, files });
    cleanup.push(() => server.close());
    const listening = server.listen();
    let up = false;
    for (let n = 0; n < 1000 && !up; n++) up = await answers(at);
    expect(up).toBe(true);
    const raw = await rawConnection(at);
    raw.send(JSON.stringify({ i: 1, op: "hello", a: { nonce: b64u.encode(randomBytes(32)), epub: b64u.encode(ephemeral().pub) } }));
    let answered = false;
    const answer = raw.next().then((a) => ((answered = true), a));
    for (let n = 0; n < 50; n++) await new Promise((r) => setImmediate(r));
    // Not answered yet, and not taken for a replaced endpoint either.
    expect(answered).toBe(false);
    expect(signer.locked).toBe(false);
    release();
    await listening;
    expect(await answer).toMatchObject({ i: 1, r: { locked: false } });
    expect(signer.locked).toBe(false);
  });

  it("refuses to start where a signer already answers; close before listening is fine", async () => {
    const r = await running();
    const second = new AgentServer({ signer: r.signer, endpoint: r.at, files: endpointFiles(process.platform) });
    await expect(second.listen()).rejects.toThrow(/already running/);
    await second.close();
  });

  it("answers malformed lines as bad requests, and drops a connection that sends too much", async () => {
    const r = await running();
    const raw = await rawConnection(r.at);
    raw.send("not json");
    raw.send(JSON.stringify({ i: 5, op: "status" }));
    raw.send("null");
    expect(await raw.next()).toMatchObject({ i: 0, e: { code: "bad_request" } });
    expect(await raw.next()).toMatchObject({ i: 5, r: { id: r.id } });
    expect(await raw.next()).toMatchObject({ e: { code: "bad_request" } });
    // A connection error (a reset, a broken pipe) is the close's business, never a crash.
    const sockets = (r.server as unknown as { sockets: Set<Socket> }).sockets;
    for (const socket of sockets) socket.emit("error", new Error("reset"));
    raw.send(JSON.stringify({ i: 6, op: "status" }));
    expect(await raw.next()).toMatchObject({ i: 6 });
    raw.socket.write("x".repeat(4 * 1024 * 1024 + 10));
    await raw.closed;
  });

  it("after an unlocked hello, a line that is not sealed on the channel ends the connection", async () => {
    const r = await running();
    const raw = await rawConnection(r.at);
    raw.send(JSON.stringify({ i: 1, op: "hello", a: { nonce: b64u.encode(randomBytes(32)), epub: b64u.encode(ephemeral().pub) } }));
    expect(await raw.next()).toMatchObject({ i: 1, r: { locked: false } });
    raw.send(JSON.stringify({ i: 2, op: "status" }));
    await raw.closed;
    expect(r.signer.locked).toBe(false);
  });

  it("drops the answer to a connection that went away before it", async () => {
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const r = await running();
    const handle = r.signer.handle.bind(r.signer);
    // A request that is still being answered when its connection goes away.
    r.signer.handle = async (op, a) => {
      if (op === "lock") {
        entered = true;
        await gate;
      }
      return handle(op, a);
    };
    const raw = await rawConnection(r.at);
    raw.send(JSON.stringify({ i: 1, op: "lock", a: {} }));
    await turns(() => entered);
    raw.socket.destroy();
    await raw.closed;
    release();
    expect(await r.client.call("status")).toMatchObject({ locked: true });
  });
});

/** Event loop turns (no timers) until `done`, for socket work that has no event to wait on. */
async function turns(done: () => boolean): Promise<void> {
  for (let i = 0; i < 10_000 && !done(); i++) await new Promise((r) => setImmediate(r));
  if (!done()) throw new Error("never happened");
}

/**
 * A process in the middle: listens at its own endpoint and passes every line on to `to`, after
 * `edit` (which may change a line, answer it itself, or keep it). What it saw is in `seen`.
 */
async function proxy(to: string, edit: (line: string, fromClient: boolean, answer: (text: string) => void) => string | undefined = (l) => l) {
  const at = await endpoint();
  const seen: string[] = [];
  const { createConnection } = await import("node:net");
  const server = createServer((client) => {
    const upstream = createConnection(to);
    const relay = (from: Socket, into: Socket, fromClient: boolean): void => {
      from.setEncoding("utf8");
      let buf = "";
      from.on("error", () => undefined);
      from.on("close", () => into.destroy());
      from.on("data", (d: string) => {
        buf += d;
        for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          seen.push(line);
          const out = edit(line, fromClient, (text) => from.write(`${text}\n`));
          if (out !== undefined) into.write(`${out}\n`);
        }
      });
    };
    relay(client, upstream, true);
    relay(upstream, client, false);
  });
  await new Promise<void>((r) => server.listen(at, () => r()));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  return { at, seen };
}

describe("a process in the middle (independent review, finding 1)", () => {
  it("relaying the hello gets it nothing: every later line is sealed, and one it forges ends the connection", async () => {
    const r = await running();
    let forge = false;
    const p = await proxy(r.at, (line, fromClient, answer) => {
      if (!(fromClient && forge)) return line;
      // It cannot read the request, so it answers it blind, in the clear, as if it were a `lock`.
      answer(JSON.stringify({ i: 2, r: {} }));
      return undefined;
    });
    const client = new SignerClient({ endpoint: p.at, expect: r.keys.signPub });
    cleanup.push(() => client.close());
    const ring = signerKeyring(client, { signPub: r.keys.signPub, boxPub: r.keys.boxPub });
    const peer = generateDeviceKeys();
    const box = await ring.seal({ mesh: MESH, sender: r.id, recipient: deviceIdFromSignPub(peer.signPub), aad: randomBytes(32), recipientBox: peer.boxPub, plaintext: utf8("the plan") });
    expect("c" in box).toBe(true);
    const wire = p.seen.join("\n");
    expect(wire).not.toContain(b64u.encode(utf8("the plan")));
    expect(p.seen.slice(2).every((l) => Object.keys(JSON.parse(l) as object).join() === "x")).toBe(true);
    forge = true;
    expect((await failure(client.call("lock"))).code).toBe("unavailable");
    expect(r.signer.locked).toBe(false);
  });

  it("swapping in its own channel key breaks the proof", async () => {
    const r = await running();
    const mine = ephemeral();
    const p = await proxy(r.at, (line, fromClient) => {
      const msg = JSON.parse(line) as { op?: string; a?: Record<string, unknown> };
      if (fromClient && msg.op === "hello") return JSON.stringify({ ...msg, a: { ...msg.a, epub: b64u.encode(mine.pub) } });
      return line;
    });
    const client = new SignerClient({ endpoint: p.at, expect: r.keys.signPub });
    cleanup.push(() => client.close());
    expect((await failure(client.call("status"))).code).toBe("mismatch");
  });

  it("a signer whose endpoint names something else locks and stops, before answering anything", async () => {
    let id: string | undefined = "mine";
    const files: EndpointFiles = { ...endpointFiles(process.platform), id: async () => id };
    const log: LogEntry[] = [];
    const r = await running(log, files);
    // A connection the agent opened while the endpoint was the signer's own.
    await r.client.call("status");
    id = "a proxy's socket";
    expect((await failure(r.client.call("sign", { type: "auth", obj: { device: r.id, at: Date.now() } }))).code).toBe("unavailable");
    await r.server.stopped;
    expect(r.signer.locked).toBe(true);
    expect(log.map((e) => e.op)).toContain("replaced");
  });

  it("checks its endpoint on its own as well, every watchMs", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let id: string | undefined = "mine";
    const r = await running([], { ...endpointFiles(process.platform), id: async () => id }, 1000);
    await r.server.watch();
    expect(r.signer.locked).toBe(false);
    id = undefined;
    vi.advanceTimersByTime(1000);
    await r.server.stopped;
    expect(r.signer.locked).toBe(true);
  });

  it.skipIf(process.platform === "win32")("the reported attack: the socket renamed away, a proxy at its path; `wim agent lock` cannot be faked", async () => {
    const r = await running();
    const { promises: fsp } = await import("node:fs");
    const real = `${r.at}.real`;
    await fsp.rename(r.at, real);
    // The proxy listens at the signer's old path and forwards to the renamed socket.
    const { createConnection } = await import("node:net");
    const forwarded: string[] = [];
    const server = createServer((c) => {
      const up = createConnection(real);
      c.on("error", () => undefined);
      up.on("error", () => undefined);
      c.on("data", (d) => {
        forwarded.push(String(d));
        up.write(d);
      });
      up.on("data", (d) => c.write(d));
      up.on("close", () => c.destroy());
    });
    await new Promise<void>((done) => server.listen(r.at, () => done()));
    cleanup.push(() => new Promise<void>((done) => server.close(() => done())));
    const victim = new SignerClient({ endpoint: r.at, expect: r.keys.signPub });
    cleanup.push(() => victim.close());
    // The first request through the proxy reaches a signer that no longer owns its path.
    expect((await failure(victim.call("lock"))).code).toBe("unavailable");
    await r.server.stopped;
    expect(r.signer.locked).toBe(true);
    expect(forwarded.length).toBeGreaterThan(0);
  });
});

/** A connection that speaks the line protocol by hand. */
async function rawConnection(at: string) {
  const { createConnection } = await import("node:net");
  const socket = createConnection(at);
  socket.setEncoding("utf8");
  await new Promise<void>((r) => socket.once("connect", () => r()));
  const lines: string[] = [];
  const waiters: Array<(l: string) => void> = [];
  let buf = "";
  socket.on("data", (d: string) => {
    buf += d;
    for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const w = waiters.shift();
      if (w === undefined) lines.push(line);
      else w(line);
    }
  });
  socket.on("error", () => undefined);
  const closed = new Promise<void>((r) => socket.once("close", () => r()));
  cleanup.push(() => void socket.destroy());
  return {
    socket,
    closed,
    send: (line: string) => socket.write(`${line}\n`),
    next: async () => JSON.parse(lines.shift() ?? (await new Promise<string>((r) => waiters.push(r)))) as Record<string, unknown>,
  };
}

describe("parseAnswer", () => {
  it("takes an object with an error of string code and message, or else a result object", () => {
    expect(parseAnswer('{"i":1,"r":{"a":1}}')).toEqual({ i: 1, r: { a: 1 } });
    expect(parseAnswer('{"i":2,"e":{"code":"locked","message":"no"}}')).toEqual({ i: 2, e: { code: "locked", message: "no" } });
    for (const bad of ["{", "null", '{"e":null,"r":{}}', '{"e":{"code":"x","message":2}}', '{"r":null}']) expect(parseAnswer(bad), bad).toBeUndefined();
  });
});

describe("SignerClient", () => {
  it("says no signer answers when nothing listens, with the error's code or message", async () => {
    const at = await endpoint();
    const e = await failure(new SignerClient({ endpoint: at }).call("status"));
    expect(e).toBeInstanceOf(SignerError);
    expect(e.code).toBe("unavailable");
    expect(e.message).toMatch(/wim agent start/);
    const { Socket: NetSocket } = await import("node:net");
    const odd = new SignerClient({
      endpoint: "nowhere",
      connect: () => {
        const s = new NetSocket();
        setImmediate(() => s.emit("error", new Error("odd failure")));
        return s;
      },
    });
    expect((await failure(odd.call("status"))).message).toMatch(/odd failure/);
  });

  it("refuses a certificate that does not match the hello or is not current, and a hello changed on the way (round 3)", async () => {
    const now = Date.now();
    for (const o of [
      { locked: true, cert: { locked: false } },
      { cert: { pid: 2 } },
      { cert: { issued: now + 10 * 60_000, expires: now + 20 * 60_000 } },
      { cert: { expires: now - 1 } },
    ]) {
      const f = await trustedFake((req, answer) => answer.sealed(JSON.stringify({ i: req.i, r: {} })), { now, ...o });
      const client = new SignerClient({ endpoint: f.at, expect: f.signPub, now: () => now });
      cleanup.push(() => client.close());
      expect((await failure(client.call("status"))).code, JSON.stringify(o)).toBe("mismatch");
    }
    // A process in the middle that flips `locked` in a relayed hello breaks the proof.
    const r = await running();
    const p = await proxy(r.at, (line, fromClient) => (fromClient ? line : line.replace('"locked":false', '"locked":true')));
    const client = new SignerClient({ endpoint: p.at, expect: r.keys.signPub });
    cleanup.push(() => client.close());
    expect((await failure(client.call("lock"))).code).toBe("mismatch");
    expect(r.signer.locked).toBe(false);
  });

  it("refuses a stand-in that cannot prove it holds the key", async () => {
    const keys = generateDeviceKeys();
    const pub = b64u.encode(keys.signPub);
    const { at } = await fake((line, socket) => {
      const { i } = JSON.parse(line) as { i: number };
      socket.write(`${JSON.stringify({ i, r: { id: "x", name: "x", signPub: pub, boxPub: pub, locked: false, pid: 1, ...(i === 1 ? {} : { proof: b64u.encode(randomBytes(64)) }) } })}\n`);
    });
    const client = new SignerClient({ endpoint: at, expect: keys.signPub });
    cleanup.push(() => client.close());
    expect((await failure(client.call("status"))).code).toBe("mismatch");
    expect((await failure(client.call("status"))).code).toBe("mismatch");
  });

  it("a connection that closes late fails only its own calls, not those of the next connection", async () => {
    // On Windows a destroyed pipe reports its close later than a Unix socket does: by then the
    // next connection's hello is in flight. Here the first connection's close is held back.
    const keys = generateDeviceKeys();
    const pub = b64u.encode(keys.signPub);
    let hellos = 0;
    const { at } = await fake((line, socket) => {
      const { i } = JSON.parse(line) as { i: number };
      hellos++;
      socket.write(`${JSON.stringify({ i, r: { id: "x", name: "x", signPub: pub, boxPub: pub, locked: false, pid: 1, ...(hellos === 1 ? {} : { proof: b64u.encode(randomBytes(64)) }) } })}\n`);
    });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let first = true;
    const { createConnection } = await import("node:net");
    const client = new SignerClient({
      endpoint: at,
      expect: keys.signPub,
      connect: (endpoint) => {
        const socket = createConnection(endpoint);
        if (first) {
          first = false;
          const once = socket.once.bind(socket);
          socket.once = ((event: string, fn: (...args: unknown[]) => void) => once(event, event === "close" ? (...args: unknown[]) => void held.then(() => fn(...args)) : fn)) as typeof socket.once;
        }
        return socket;
      },
    });
    cleanup.push(() => client.close());
    expect((await failure(client.call("status"))).code).toBe("mismatch");
    const second = failure(client.call("status"));
    await turns(() => hellos === 2);
    release();
    // The second connection's own answer decides: a proof that does not verify.
    expect((await second).code).toBe("mismatch");
  });

  it("times out on a signer that does not answer, and ignores an answer that comes too late", async () => {
    const held: Array<{ i: number; answer: Answerer }> = [];
    const f = await trustedFake((req, answer) => void held.push({ i: req.i, answer }));
    const client = new SignerClient({ endpoint: f.at, expect: f.signPub, timeoutMs: 1000 });
    cleanup.push(() => client.close());
    await client.hello();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = failure(client.call("status"));
    await turns(() => held.length === 1);
    vi.advanceTimersByTime(1000);
    const e = await pending;
    expect(e.code).toBe("timeout");
    vi.useRealTimers();
    // The late answer matches nothing pending; the next call is answered as usual.
    held[0]!.answer.sealed(JSON.stringify({ i: held[0]!.i, r: {} }));
    const next = client.call("status");
    await turns(() => held.length === 2);
    held[1]!.answer.sealed(JSON.stringify({ i: held[1]!.i, e: { code: "refused", message: "no" } }));
    expect((await failure(next)).code).toBe("refused");
  });

  it("takes an answer that is not an object with r or e as a protocol error on that connection only", async () => {
    const hostile = [
      "null",
      "5",
      "[]",
      '"text"',
      '{"i":ID}',
      '{"i":ID,"r":"x"}',
      '{"i":ID,"r":[]}',
      '{"i":ID,"e":null}',
      '{"i":ID,"r":{},"e":null}',
      '{"i":ID,"e":5}',
      '{"i":ID,"e":{}}',
      '{"i":ID,"e":{"code":1,"message":"m"}}',
      '{"i":ID,"e":{"code":"refused"}}',
    ];
    let mode = 0;
    // Sealed on the channel, so each one reaches the answer's own checks.
    const f = await trustedFake((req, answer) => {
      const next = hostile[mode++];
      answer.sealed(next === undefined ? JSON.stringify({ i: req.i, r: { fine: true } }) : next.replace("ID", String(req.i)));
    });
    const client = new SignerClient({ endpoint: f.at, expect: f.signPub });
    cleanup.push(() => client.close());
    for (const h of hostile) expect((await failure(client.call("status"))).code, h).toBe("unavailable");
    expect(await client.call("status")).toEqual({ fine: true });
  });

  it("drops a connection that sends garbage, a line not sealed, or too much, failing what was pending, and reconnects", async () => {
    let mode: "garbage" | "clear" | "flood" | "ok" = "garbage";
    const f = await trustedFake((req, answer) => {
      if (mode === "garbage") answer.raw("{not json");
      else if (mode === "clear") answer.raw(JSON.stringify({ i: req.i, r: { forged: true } }));
      else if (mode === "flood") answer.raw("x".repeat(4 * 1024 * 1024 + 10));
      else answer.sealed(JSON.stringify({ i: req.i, r: { fine: true } }));
    });
    const client = new SignerClient({ endpoint: f.at, expect: f.signPub });
    cleanup.push(() => client.close());
    expect((await failure(client.call("status"))).code).toBe("unavailable");
    mode = "clear";
    expect((await failure(client.call("status"))).code).toBe("unavailable");
    mode = "flood";
    expect((await failure(client.call("status"))).code).toBe("unavailable");
    mode = "ok";
    expect(await client.call("status")).toEqual({ fine: true });
  });
});

describe("signerKeyring", () => {
  it("does every key operation in the signer, and opens a clear prekey itself", async () => {
    const r = await running();
    const ring = signerKeyring(r.client, { signPub: r.keys.signPub, boxPub: r.keys.boxPub });
    expect(ring.kind).toBe("signer");
    const obj = { device: r.id, mesh: MESH, at: Date.now() };
    expect(await ring.sign("auth", obj)).toBe(signObject("auth", obj, r.keys.signSec).sig);
    const peer = generateDeviceKeys();
    const peerId = deviceIdFromSignPub(peer.signPub);
    const aad = randomBytes(32);
    const box = await ring.seal({ mesh: MESH, sender: r.id, recipient: peerId, aad, recipientBox: peer.boxPub, plaintext: utf8("to peer") });
    expect("s" in box).toBe(false);
    const peerPk = createPrekey({ mesh: MESH, deviceId: peerId, signSec: peer.signSec, at: Date.now() });
    const box2 = await ring.seal({ mesh: MESH, sender: r.id, recipient: peerId, aad, recipientBox: peer.boxPub, prekey: { id: peerPk.prekey.id, pub: b64u.decode(peerPk.prekey.pub) }, plaintext: utf8("to peer") });
    expect(box2).toMatchObject({ s: 2, p: peerPk.prekey.id });
    // Boxes to this device: scheme 1, scheme 2 to a sealed prekey, scheme 2 to a clear one.
    const sealed = await ring.newPrekey(MESH, Date.now());
    expect("sealed" in sealed).toBe(true);
    const clear = createPrekey({ mesh: MESH, deviceId: r.id, signSec: r.keys.signSec, at: Date.now() });
    const seal = { mesh: MESH, sender: peerId, recipient: r.id, aad, recipientBox: r.keys.boxPub, plaintext: utf8("to me") };
    const req = (b: OpenRequest["box"]): OpenRequest => ({ mesh: MESH, sender: peerId, recipient: r.id, aad, senderBox: peer.boxPub, box: b });
    const one = sealBox(peer.boxSec, seal);
    const toSealed = sealBox(peer.boxSec, { ...seal, prekey: { id: sealed.prekey.id, pub: b64u.decode(sealed.prekey.pub) } });
    const toClear = sealBox(peer.boxSec, { ...seal, prekey: { id: clear.prekey.id, pub: b64u.decode(clear.prekey.pub) } });
    expect(await ring.open(req(one))).toEqual(utf8("to me"));
    expect(await ring.open(req(toSealed))).toBe("key_expired");
    expect(await ring.openPrekey(sealed, req(toSealed))).toEqual(utf8("to me"));
    expect(await ring.openPrekey(clear, req(toClear))).toEqual(utf8("to me"));
    expect(await ring.open(req({ ...one, c: b64u.encode(randomBytes(40)) }))).toBe("decrypt_failed");
    // adopt: a clear secret is sealed in the signer; a sealed one is kept as it is.
    const adopted = await ring.adopt(clear);
    expect("sealed" in adopted && adopted.prekey).toEqual(clear.prekey);
    expect(await ring.adopt(sealed)).toBe(sealed);
    expect(await ring.openPrekey(adopted, req(toClear))).toEqual(utf8("to me"));
  });
});
