// The session side of the signer (`wim agent`): a client for its local socket, and the device
// keyring that asks it for every operation that needs a secret key. Sessions never read the key
// file while the signer holds it; they ask, and the signer answers or refuses.
//
// Wire: one JSON object per line. A request is `{ "i": n, "op": "...", "a": { ... } }`, the
// answer `{ "i": n, "r": { ... } }` or `{ "i": n, "e": { "code": "...", "message": "..." } }`.
// Bytes travel as b64u. After an unlocked signer's `hello`, each line is `{ "x": "..." }`, the
// same JSON sealed on the connection's channel (channel.ts).

import { b64u, randomBytes, type Box, type OpenRequest, type Opened, type Prekey, type SealRequest, type SignType } from "@worldinmotion/protocol";
import { verify } from "node:crypto";
import { certBytes, channelFor, ed25519Public, ephemeral, helloTranscript, type CertBody, type Channel, type HelloInfo } from "./channel.ts";
import { createConnection, type Socket } from "node:net";
import { openWithClearPrekey, type DeviceKeyring, type PrekeyEntry } from "./keyring.ts";

/** The longest line either side accepts: a send frame (1 MiB) to sign, in JSON, with room to spare. */
export const MAX_LINE = 4 * 1024 * 1024;

/** Why the signer could not do what was asked. `unavailable`: no signer answers at the endpoint. */
export type SignerCode = "unavailable" | "locked" | "rate_limited" | "refused" | "bad_request" | "bad_passphrase" | "timeout" | "mismatch";

export class SignerError extends Error {
  override readonly name = "SignerError";
  readonly code: SignerCode;
  constructor(code: SignerCode, message: string) {
    super(message);
    this.code = code;
  }

  /** The signer could not answer now (locked, gone, slow or busy); the same request may work later. */
  get transient(): boolean {
    return ["locked", "unavailable", "timeout", "rate_limited"].includes(this.code);
  }
}

/**
 * What `hello` tells: the device the signer holds, whether it is locked, and its process; its
 * X25519 key for the channel; its key for this run (`cert.pub`) with the device key's signature
 * over it (`cert.sig`, made at unlock); and `proof`, that run key's signature over helloTranscript.
 */
export type Hello = HelloInfo & { epub: string; cert: CertBody & { sig: string }; proof: string };

/** What a connection to a signer that proved itself locked may still carry. */
const LOCKED_OPS: ReadonlySet<string> = new Set(["status", "lock", "stop"]);

/** How far ahead of this clock a run key's certificate may say it was issued. */
const CERT_SKEW_MS = 5 * 60_000;


/** Encodes a seal request for the wire. */
export function encodeSeal(req: SealRequest): Record<string, unknown> {
  return {
    mesh: req.mesh,
    sender: req.sender,
    recipient: req.recipient,
    aad: b64u.encode(req.aad),
    recipientBox: b64u.encode(req.recipientBox),
    plaintext: b64u.encode(req.plaintext),
    ...(req.prekey === undefined ? {} : { prekey: { id: req.prekey.id, pub: b64u.encode(req.prekey.pub) } }),
  };
}

/** Encodes an open request for the wire. */
export function encodeOpen(req: OpenRequest): Record<string, unknown> {
  return { mesh: req.mesh, sender: req.sender, recipient: req.recipient, aad: b64u.encode(req.aad), senderBox: b64u.encode(req.senderBox), box: req.box };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Answer = { i: unknown; r: Record<string, unknown> } | { i: unknown; e: { code: SignerCode; message: string } };

/** The text of a sealed line `{ "x": "..." }`, or undefined for anything else. */
export function unseal(channel: Channel, line: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  return isObject(value) ? channel.open(value["x"]) : undefined;
}

/**
 * One line from the signer, or undefined when it is not an answer: a JSON object with either `e`,
 * an object whose `code` and `message` are strings, or (without `e`) `r`, an object.
 */
export function parseAnswer(line: string): Answer | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObject(value)) return undefined;
  const { i, r, e } = value;
  if (e !== undefined) return isObject(e) && typeof e["code"] === "string" && typeof e["message"] === "string" ? { i, e: { code: e["code"] as SignerCode, message: e["message"] } } : undefined;
  return isObject(r) ? { i, r } : undefined;
}

type Pending = { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * One connection's own state: its calls in flight, its unread bytes, and whether the signer at
 * the other end proved it holds the device's signing key. A connection keeps all of it to itself:
 * one that closes late (a Windows pipe reports its close later than a Unix socket) fails only its
 * own calls, never those of the connection that replaced it.
 */
type Conn = { socket: Socket; pending: Map<number, Pending>; buffered: string; channel?: Channel; hello?: Hello };

/**
 * One connection to the signer, made on first use and again after it drops. Each new connection
 * starts with `hello`, and the signer must prove, locked or not, that it is the signer `expect`
 * (the device's signing key, from the key file's public part) certified when it was unlocked: its
 * run key signs the client's fresh nonce and both sides' channel keys. Nothing else is sent to
 * anything that cannot, and everything after the hello goes over the connection's sealed channel,
 * so a proof relayed by a process in the middle gets that process nothing. (The passphrase never
 * crosses this socket: `wim agent unlock` restarts the signer.)
 */
export class SignerClient {
  /** The endpoint last connected to (or given). */
  endpoint: string;
  private readonly where: () => Promise<string | undefined>;
  private readonly expect: Uint8Array | undefined;
  private readonly timeoutMs: number;
  private readonly connect: (endpoint: string) => Socket;
  private readonly now: () => number;
  private conn: Conn | undefined;
  private opening: Promise<Conn> | undefined;
  private next = 0;

  /**
   * `endpoint` is the signer's address, or a function that finds it again for each new connection
   * (a session outlives a signer restart, and on Windows each start has a new pipe name).
   */
  constructor(o: { endpoint: string | (() => Promise<string | undefined>); expect?: Uint8Array; timeoutMs?: number; connect?: (endpoint: string) => Socket; now?: () => number }) {
    this.now = o.now ?? Date.now;
    const at = o.endpoint;
    this.endpoint = typeof at === "string" ? at : "";
    this.where = typeof at === "string" ? async () => at : at;
    this.expect = o.expect;
    this.timeoutMs = o.timeoutMs ?? 30_000;
    this.connect = o.connect ?? ((endpoint) => createConnection(endpoint));
  }

  /** Asks the signer; rejects with a SignerError when it refuses, is not there, or does not answer. */
  async call(op: string, a: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const conn = await this.connected();
    // A signer that proved it is locked is sent nothing a locked signer could not answer.
    if (conn.hello!.locked && !LOCKED_OPS.has(op)) throw new SignerError("locked", "the signer is locked: run `wim agent unlock` in a terminal you opened yourself");
    return this.send(conn, op, a);
  }

  /** The `hello` of the current connection (made now if there is none), checked against `expect`. */
  async hello(): Promise<Hello> {
    return (await this.connected()).hello!;
  }

  /** Drops the connection; its pending calls fail as `unavailable`. */
  close(): void {
    this.conn?.socket.destroy();
  }

  private send(conn: Conn, op: string, a: Record<string, unknown>): Promise<Record<string, unknown>> {
    const i = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(i);
        this.idle(conn);
        reject(new SignerError("timeout", `the signer did not answer ${op} in ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      conn.pending.set(i, { resolve, reject, timer });
      // A connection with calls in flight keeps the process alive; an idle one does not.
      conn.socket.ref();
      const text = JSON.stringify({ i, op, a });
      conn.socket.write(`${conn.channel === undefined ? text : JSON.stringify({ x: conn.channel.seal(text) })}\n`);
    });
  }

  private idle(conn: Conn): void {
    if (conn.pending.size === 0) conn.socket.unref();
  }

  private connected(): Promise<Conn> {
    if (this.conn !== undefined) return Promise.resolve(this.conn);
    this.opening ??= this.open().finally(() => (this.opening = undefined));
    return this.opening;
  }

  private async open(): Promise<Conn> {
    return this.connectTo(await this.where());
  }

  private connectTo(at: string | undefined): Promise<Conn> {
    if (at === undefined) return Promise.reject(new SignerError("unavailable", "no signer is running: run `wim agent start` in a terminal you opened yourself"));
    this.endpoint = at;
    return new Promise<Conn>((resolve, reject) => {
      const socket = this.connect(at);
      const conn: Conn = { socket, pending: new Map(), buffered: "" };
      socket.setEncoding("utf8");
      // Before the connection: no signer there. After it: the close that follows fails what is pending.
      socket.on("error", (error: NodeJS.ErrnoException) => {
        reject(new SignerError("unavailable", `no signer answers at ${this.endpoint} (${error.code ?? error.message}): run \`wim agent start\` in a terminal you opened yourself`));
      });
      socket.once("connect", () => {
        socket.on("data", (chunk: string) => this.take(conn, chunk));
        socket.once("close", () => this.dropped(conn));
        this.greet(conn).then(
          () => {
            this.conn = conn;
            resolve(conn);
          },
          (error: unknown) => {
            socket.destroy();
            reject(error as Error);
          },
        );
      });
    });
  }

  private async greet(conn: Conn): Promise<Hello> {
    const nonce = randomBytes(32);
    const mine = ephemeral();
    const hello = (await this.send(conn, "hello", { nonce: b64u.encode(nonce), epub: b64u.encode(mine.pub) })) as Hello;
    this.check(conn, hello, nonce, mine);
    return hello;
  }

  /**
   * Checks a hello and opens the channel: the run key certified by the device key, and the run
   * key's signature over this connection's transcript. Any missing or malformed field is a mismatch.
   */
  private check(conn: Conn, hello: Hello, nonce: Uint8Array, mine: ReturnType<typeof ephemeral>): void {
    if (this.expect !== undefined && hello.signPub !== b64u.encode(this.expect)) {
      throw new SignerError("mismatch", `the signer at ${this.endpoint} holds another device's keys (${hello.id})`);
    }
    try {
      // Everything the client acts on is signed: the certificate (by the device key) and the
      // HelloInfo (by the run key, in the transcript). A certificate holds only while it is
      // current and for the lock state and process it names.
      const { sig, ...body } = hello.cert;
      const info: HelloInfo = { id: hello.id, name: hello.name, signPub: hello.signPub, boxPub: hello.boxPub, locked: hello.locked, pid: hello.pid };
      const theirs = b64u.decode(hello.epub);
      const transcript = helloTranscript(nonce, mine.pub, theirs, info);
      const now = this.now();
      const certified = verify(null, certBytes(body), ed25519Public(b64u.decode(hello.signPub)), b64u.decode(sig));
      const current = body.locked === hello.locked && body.pid === hello.pid && body.issued <= now + CERT_SKEW_MS && now < body.expires;
      if (!certified || !current || !verify(null, transcript, ed25519Public(b64u.decode(body.pub)), b64u.decode(hello.proof))) throw new Error("bad proof");
      conn.channel = channelFor("client", mine.privateKey, theirs, transcript);
    } catch {
      throw new SignerError("mismatch", `the signer at ${this.endpoint} could not prove it is this device's signer`);
    }
    conn.hello = hello;
  }

  private take(conn: Conn, chunk: string): void {
    conn.buffered += chunk;
    if (conn.buffered.length > MAX_LINE) {
      conn.socket.destroy();
      return;
    }
    for (let nl = conn.buffered.indexOf("\n"); nl !== -1; nl = conn.buffered.indexOf("\n")) {
      const line = conn.buffered.slice(0, nl);
      conn.buffered = conn.buffered.slice(nl + 1);
      const answer = parseAnswer(conn.channel === undefined ? line : (unseal(conn.channel, line) ?? ""));
      if (answer === undefined) {
        // A protocol error ends this connection only: what it had pending fails, the next call connects again.
        conn.socket.destroy();
        return;
      }
      const waiting = conn.pending.get(answer.i as number);
      if (waiting === undefined) continue;
      conn.pending.delete(answer.i as number);
      clearTimeout(waiting.timer);
      this.idle(conn);
      if ("e" in answer) waiting.reject(new SignerError(answer.e.code, answer.e.message));
      else waiting.resolve(answer.r);
    }
  }

  private dropped(conn: Conn): void {
    if (this.conn === conn) this.conn = undefined;
    for (const [i, waiting] of conn.pending) {
      conn.pending.delete(i);
      clearTimeout(waiting.timer);
      waiting.reject(new SignerError("unavailable", "the signer closed the connection"));
    }
  }
}

/**
 * The keyring of a device whose key file is encrypted: every operation is a call to the signer.
 * A scheme 2 box opens in the signer when its prekey's secret is sealed (the usual case), and here
 * when a process holding the plaintext keys left it in the clear.
 */
export function signerKeyring(client: SignerClient, pub: { signPub: Uint8Array; boxPub: Uint8Array }): DeviceKeyring {
  const opened = (r: Record<string, unknown>): Opened => (typeof r["opened"] === "string" ? b64u.decode(r["opened"]) : (r["reason"] as "key_expired" | "decrypt_failed"));
  return {
    kind: "signer",
    signPub: pub.signPub,
    boxPub: pub.boxPub,
    sign: async (type: SignType, obj: object) => (await client.call("sign", { type, obj: obj as Record<string, unknown> }))["sig"] as string,
    seal: async (req) => (await client.call("seal", encodeSeal(req)))["box"] as Box,
    // Only scheme 1 opens with the device key; a scheme 2 box needs its prekey's entry (openPrekey).
    open: async (req) => ("s" in req.box ? "key_expired" : opened(await client.call("open", encodeOpen(req)))),
    openPrekey: async (entry, req) => ("secret" in entry ? openWithClearPrekey(entry, req) : opened(await client.call("open2", { ...encodeOpen(req), entry }))),
    newPrekey: async (mesh, at) => {
      const r = await client.call("prekey", { mesh, at });
      return { prekey: r["prekey"] as Prekey, sealed: r["sealed"] as string };
    },
    adopt: async (entry): Promise<PrekeyEntry> => {
      if ("sealed" in entry) return entry;
      const r = await client.call("adopt", { prekey: entry.prekey, secret: b64u.encode(entry.secret) });
      return { prekey: entry.prekey, sealed: r["sealed"] as string };
    },
  };
}
