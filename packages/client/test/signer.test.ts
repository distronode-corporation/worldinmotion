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
import { AgentServer, answers, Signer, type LogEntry } from "../src/agent.ts";
import { agentEndpoint, endpointFiles } from "../src/agentpath.ts";
import { parseAnswer, SignerClient, signerKeyring, SignerError } from "../src/signer.ts";
import { sealKeyFile } from "../src/vault.ts";
import { FS, scratch } from "./helpers.ts";

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

async function running(log: LogEntry[] = []): Promise<Running> {
  const keys = generateDeviceKeys();
  const data = randomBytes(32);
  const file = await sealKeyFile({ name: "laptop", keys, passphrase: "pass phrase", data, kdf: KDF });
  const unlocked = { keys: { ...keys, signSec: keys.signSec.slice(), boxSec: keys.boxSec.slice() }, data };
  const signer = new Signer({ file, unlocked, now: Date.now, pid: process.pid, log: (e) => log.push(e) });
  const at = await endpoint();
  const server = new AgentServer({ signer, endpoint: at, files: endpointFiles(process.platform) });
  await server.listen();
  cleanup.push(() => server.close());
  const client = new SignerClient({ endpoint: at, expect: keys.signPub });
  cleanup.push(() => client.close());
  return { server, signer, keys, at, id: file.id, client };
}

/** A stand-in signer that answers with `reply` (or not at all). */
async function fake(reply: (line: string, socket: Socket) => void): Promise<{ at: string; server: Server }> {
  const at = await endpoint();
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buf = "";
    socket.on("error", () => undefined);
    socket.on("data", (d: string) => {
      buf += d;
      for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        reply(line, socket);
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
    const obj = { device: r.id, mesh: MESH };
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

  it("a locked signer proves nothing, and is sent nothing but hello, status, lock and stop", async () => {
    const log: LogEntry[] = [];
    const r = await running(log);
    await r.client.call("lock");
    const fresh = new SignerClient({ endpoint: r.at, expect: r.keys.signPub });
    cleanup.push(() => fresh.close());
    expect(await fresh.hello()).toMatchObject({ locked: true });
    expect(await fresh.call("status")).toMatchObject({ locked: true });
    const seen = log.length;
    for (const [op, a] of [["prekey", { mesh: MESH, at: 1 }], ["sign", { type: "auth", obj: { device: r.id } }], ["seal", { plaintext: "cGxhaW50ZXh0" }]] as const) {
      expect((await failure(fresh.call(op, a))).code).toBe("locked");
    }
    // Refused here, before anything was written to the socket.
    expect(log.length).toBe(seen);
    await fresh.call("stop");
    await r.server.stopped;
  });

  it("an impostor that claims to be a locked signer gets no plaintext and no request to sign", async () => {
    const keys = generateDeviceKeys();
    const pub = b64u.encode(keys.signPub);
    const lines: string[] = [];
    // It knows the device's public key (the key file's public part says it), but not the secret.
    const { at } = await fake((line, socket) => {
      lines.push(line);
      const { i } = JSON.parse(line) as { i: number };
      socket.write(`${JSON.stringify({ i, r: { id: "x", name: "x", signPub: pub, boxPub: pub, locked: true, pid: 1 } })}\n`);
    });
    const client = new SignerClient({ endpoint: at, expect: keys.signPub });
    cleanup.push(() => client.close());
    const ring = signerKeyring(client, { signPub: keys.signPub, boxPub: keys.boxPub });
    const peer = generateDeviceKeys();
    await expect(ring.seal({ mesh: MESH, sender: "a".repeat(22), recipient: "b".repeat(22), aad: randomBytes(32), recipientBox: peer.boxPub, plaintext: utf8("the plan") })).rejects.toThrow(/locked/);
    await expect(ring.sign("send", { mesh: MESH })).rejects.toThrow(/locked/);
    expect(lines.map((l) => (JSON.parse(l) as { op: string }).op)).toEqual(["hello"]);
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
    const held: Array<{ line: string; socket: Socket }> = [];
    const { at } = await fake((line, socket) => {
      const { i, op } = JSON.parse(line) as { i: number; op: string };
      if (op === "hello") socket.write(`${JSON.stringify({ i, r: { locked: true, signPub: "", id: "x", name: "x", boxPub: "", pid: 1 } })}\n`);
      else held.push({ line, socket });
    });
    const client = new SignerClient({ endpoint: at, timeoutMs: 1000 });
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
    const late = held[0]!;
    late.socket.write(`${JSON.stringify({ i: (JSON.parse(late.line) as { i: number }).i, r: {} })}\n`);
    const next = client.call("status");
    await turns(() => held.length === 2);
    held[1]!.socket.write(`${JSON.stringify({ i: (JSON.parse(held[1]!.line) as { i: number }).i, e: { code: "refused", message: "no" } })}\n`);
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
    const { at } = await fake((line, socket) => {
      const { i, op } = JSON.parse(line) as { i: number; op: string };
      if (op === "hello") return void socket.write(`${JSON.stringify({ i, r: { locked: true, signPub: "", id: "x", name: "x", boxPub: "", pid: 1 } })}\n`);
      const next = hostile[mode++];
      socket.write(`${next === undefined ? JSON.stringify({ i, r: { fine: true } }) : next.replace("ID", String(i))}\n`);
    });
    const client = new SignerClient({ endpoint: at });
    cleanup.push(() => client.close());
    for (const h of hostile) expect((await failure(client.call("status"))).code, h).toBe("unavailable");
    expect(await client.call("status")).toEqual({ fine: true });
  });

  it("drops a connection that sends garbage or too much, failing what was pending, and reconnects", async () => {
    let mode: "garbage" | "flood" | "ok" = "garbage";
    const { at } = await fake((line, socket) => {
      const { i, op } = JSON.parse(line) as { i: number; op: string };
      if (op === "hello") return void socket.write(`${JSON.stringify({ i, r: { locked: true, signPub: "", id: "x", name: "x", boxPub: "", pid: 1 } })}\n`);
      if (mode === "garbage") socket.write("{not json\n");
      else if (mode === "flood") socket.write("x".repeat(4 * 1024 * 1024 + 10));
      else socket.write(`${JSON.stringify({ i, r: { fine: true } })}\n`);
    });
    const client = new SignerClient({ endpoint: at });
    cleanup.push(() => client.close());
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
    const obj = { device: r.id, mesh: MESH };
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
