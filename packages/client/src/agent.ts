// The signer (`wim agent`), the ssh-agent model: one long-running process per device holds the
// device's secret keys and the data key that seals its prekey secrets, and answers sessions over a
// local socket. It signs, seals and opens; it never hands out a key. Locking wipes the keys from
// its memory for good: `wim agent unlock` starts a new signer, so the passphrase is never sent
// over the socket, where something posing as a locked signer could collect it.
//
// What it stops and what it does not is in SECURITY-MODEL section 5.8.

import {
  b64u,
  boxSchema,
  canonBytes,
  createPrekey,
  isMeshId,
  openBox,
  prekeyDeleteAt,
  prekeySchema,
  sealBox,
  verifyObject,
  type Opened,
  type Prekey,
  type SignType,
} from "@worldinmotion/protocol";
import { createPrivateKey, sign as edSign, type KeyObject } from "node:crypto";
import { promises as fs } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { z } from "zod";
import type { EndpointFiles } from "./agentpath.ts";
import { certBytes, channelFor, ephemeral, helloTranscript, runKey, type CertBody, type Channel, type HelloInfo } from "./channel.ts";
import { MAX_LINE, unseal } from "./signer.ts";
import { openPrekeySecret, sealPrekeySecret, type SealedKeyFile, type Unlocked } from "./vault.ts";

/** A refusal with a code the client maps to a SignerError. */
export class AgentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Key operations per second, with a burst: a room history page or a broadcast fits, a loop does not. */
export const AGENT_RATE = { perSecond: 100, burst: 1000 };

/** A token bucket on an injected clock: `take` is false while the bucket is empty. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly perSecond: number;
  private readonly burst: number;
  private readonly now: () => number;
  constructor(perSecond: number, burst: number, now: () => number) {
    this.perSecond = perSecond;
    this.burst = burst;
    this.now = now;
    this.tokens = burst;
    this.last = now();
  }

  take(): boolean {
    const now = this.now();
    // A clock set back gives no time: never a negative refill, which would starve the bucket.
    const elapsed = Math.max(0, now - this.last);
    this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.perSecond) / 1000);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** One line of the signer's log: what was asked and the answer, never a key or a plaintext. */
export type LogEntry = { at: number; op: string; ok: boolean; code?: string; type?: string; mesh?: string; peer?: string };

/** The log as JSON lines (mode 0600), moved to `.1` past `maxBytes`. A failed write never stops the signer. */
export class AgentLog {
  private chain: Promise<void> = Promise.resolve();
  private readonly path: string;
  private readonly maxBytes: number;
  constructor(path: string, maxBytes = 1024 * 1024) {
    this.path = path;
    this.maxBytes = maxBytes;
  }

  write(entry: LogEntry): void {
    this.chain = this.chain
      .then(async () => {
        await fs.appendFile(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
        if ((await fs.stat(this.path)).size > this.maxBytes) await fs.rename(this.path, `${this.path}.1`);
      })
      .catch(() => undefined);
  }

  /** Resolves once every write so far is on disk (or failed). */
  flushed(): Promise<void> {
    return this.chain;
  }
}

const bytes = (n?: number) =>
  z.string().refine((s) => {
    try {
      return n === undefined || b64u.decode(s).length === n;
    } catch {
      return false;
    }
  }, "expected b64u bytes");
const id22 = z.string().length(22);
const boxArgs = { mesh: z.string().refine(isMeshId, "expected a mesh id"), sender: id22, recipient: id22, aad: bytes(32) };
const sealArgs = z.strictObject({ ...boxArgs, recipientBox: bytes(32), plaintext: bytes(), prekey: z.strictObject({ id: id22, pub: bytes(32) }).optional() });
const openArgs = z.strictObject({ ...boxArgs, senderBox: bytes(32), box: boxSchema });
const open2Args = openArgs.extend({ entry: z.strictObject({ prekey: prekeySchema, sealed: z.string() }) });
const signArgs = z.strictObject({ type: z.string(), obj: z.record(z.string(), z.unknown()) });
const ARGS = {
  hello: z.strictObject({ nonce: bytes(32), epub: bytes(32) }),
  status: z.strictObject({}),
  sign: signArgs,
  seal: sealArgs,
  open: openArgs,
  open2: open2Args,
  prekey: z.strictObject({ mesh: boxArgs.mesh, at: z.int().min(0) }),
  adopt: z.strictObject({ prekey: prekeySchema, secret: bytes(32) }),
  lock: z.strictObject({}),
  stop: z.strictObject({}),
};
type Op = keyof typeof ARGS;

/**
 * Whose a signed object says it is, per signature type. The signer signs only what names this
 * device, and never a prekey: those it makes itself (`prekey`), so no caller can get a prekey
 * signed for a secret it holds and read the device's traffic after the signer is locked.
 */
const OWNER: Record<string, (o: Record<string, unknown>) => unknown> = {
  auth: (o) => o["device"],
  roster: (o) => o["by"],
  send: (o) => (o["from"] as { device?: unknown } | undefined)?.device,
  join: (o) => (o["device"] as { id?: unknown } | undefined)?.id,
};

/**
 * An Ed25519 private key as Node's crypto takes it, made once per unlock. The PKCS#8 DER around the
 * seed is built in a buffer of its own (Buffer.concat would copy the seed into Node's shared pool,
 * where nothing zeroes it) and zeroed once the key object holds it.
 */
function ed25519Private(seed: Uint8Array): KeyObject {
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const der = Buffer.alloc(prefix.length + seed.length);
  prefix.copy(der);
  der.set(seed, prefix.length);
  try {
    return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } finally {
    der.fill(0);
  }
}

/**
 * How far an `auth` or `send` object's `at`, or a new prekey's, may be from the signer's clock. Receivers take a
 * message up to its freshness window old, so what the signer signs while unlocked stays usable
 * after a lock for that long (SECURITY-MODEL 5.8); it does not sign for later than this.
 */
export const SIGN_SKEW_MS = 5 * 60_000;

/** How long a run key's certificate holds (see Signer.run). */
export const RUN_LIFETIME_MS = 24 * 60 * 60_000;

/** Present on a `hello` answer whose signer opened a channel; JSON.stringify leaves symbol keys out. */
export const CHANNEL: unique symbol = Symbol("channel");

export type SignerOptions = {
  file: SealedKeyFile;
  unlocked: Unlocked;
  now: () => number;
  pid: number;
  log: (entry: LogEntry) => void;
  rate?: { perSecond: number; burst: number };
};

/**
 * The signer's state and its answer to each request, apart from any socket. Locked, it holds no
 * key and answers only `hello`, `status`, `lock` and `stop`. There is no unlock over the socket.
 */
export class Signer {
  readonly file: SealedKeyFile;
  readonly started: number;
  private keys: Unlocked | undefined;
  private signKey: KeyObject | undefined;
  /**
   * This run's own key and its certificate from the device key, so the signer proves it is this
   * device's signer, locked or not (`lock` and `stop` need that proof). It signs nothing but
   * hellos. The certificate says whether the signer is locked and holds for RUN_LIFETIME_MS: an
   * unlocked signer issues a new one at half of that, and `lock` issues a locked one (whose key can
   * only ever pose as a locked signer) before the device key goes; a locked signer stops when its
   * certificate runs out.
   */
  private run!: { privateKey: KeyObject; body: CertBody; sig: string };
  private readonly bucket: TokenBucket;
  private readonly counts: Record<string, number> = {};
  private refused = 0;
  private limited = 0;
  private readonly o: SignerOptions;

  constructor(o: SignerOptions) {
    this.o = o;
    this.file = o.file;
    this.keys = o.unlocked;
    this.signKey = ed25519Private(o.unlocked.keys.signSec);
    this.issue(false, this.signKey);
    this.started = o.now();
    const rate = o.rate ?? AGENT_RATE;
    this.bucket = new TokenBucket(rate.perSecond, rate.burst, o.now);
  }

  get locked(): boolean {
    return this.keys === undefined;
  }

  /**
   * Wipes the keys from memory as far as JavaScript can: the byte arrays are zeroed, and the key
   * object is dropped (OpenSSL frees its copy when it is collected; JavaScript cannot zero it).
   */
  lock(): void {
    const k = this.keys;
    if (k === undefined) return;
    // The last thing the device key signs: a run key that can only say "locked".
    this.issue(true, this.signKey!);
    this.keys = undefined;
    this.signKey = undefined;
    for (const b of [k.keys.signSec, k.keys.boxSec, k.data]) b.fill(0);
  }

  /** A new run key and its certificate, signed with the device key. */
  private issue(locked: boolean, signKey: KeyObject): void {
    const key = runKey();
    const now = this.o.now();
    const body: CertBody = { pub: b64u.encode(key.pub), locked, issued: now, expires: now + RUN_LIFETIME_MS, pid: this.o.pid };
    this.run = { privateKey: key.privateKey, body, sig: b64u.encode(edSign(null, certBytes(body), signKey)) };
  }

  /**
   * An unlocked signer issues a new run key when its certificate is half spent, or was issued
   * after the clock's now: a clock set back (NTP, a resumed VM) would otherwise leave clients
   * refusing a certificate from their future until the clock caught up. Run at every hello and on
   * the server's watch. A locked signer has no device key to issue with (SECURITY-MODEL 5.8).
   */
  refresh(): void {
    const age = this.o.now() - this.run.body.issued;
    if (this.signKey !== undefined && (age < 0 || age >= RUN_LIFETIME_MS / 2)) this.issue(false, this.signKey);
  }

  /** A locked signer whose certificate ran out: it can no longer prove itself, and stops. */
  get spent(): boolean {
    return this.locked && this.o.now() >= this.run.body.expires;
  }

  /** Its endpoint now names another socket (renamed or replaced): locked, and logged. */
  replaced(): void {
    this.lock();
    this.o.log({ at: this.o.now(), op: "replaced", ok: false, code: "replaced" });
  }

  /** Answers one request, or throws an AgentError. Every answer is logged. */
  async handle(op: string, raw: unknown): Promise<Record<string, unknown>> {
    const entry: LogEntry = { at: this.o.now(), op, ok: false };
    try {
      const result = await this.answer(op, raw, entry);
      entry.ok = true;
      // `hello` and `status` only ask about the signer; the counts are of what it was asked to do.
      if (op !== "hello" && op !== "status") this.counts[op] = (this.counts[op] ?? 0) + 1;
      return result;
    } catch (error) {
      const code = error instanceof AgentError ? error.code : "bad_request";
      entry.code = code;
      if (code === "refused") this.refused++;
      throw error instanceof AgentError ? error : new AgentError("bad_request", (error as Error).message);
    } finally {
      this.o.log(entry);
    }
  }

  private async answer(op: string, raw: unknown, entry: LogEntry): Promise<Record<string, unknown>> {
    if (!Object.hasOwn(ARGS, op)) throw new AgentError("bad_request", `no operation ${JSON.stringify(op)}`);
    const parsed = ARGS[op as Op].safeParse(raw);
    if (!parsed.success) throw new AgentError("bad_request", `${op}: ${parsed.error.issues[0]!.message}`);
    const a = parsed.data as Record<string, unknown>;
    switch (op as Op) {
      case "hello":
        return this.hello(b64u.decode(a["nonce"] as string), b64u.decode(a["epub"] as string));
      case "status":
        return { id: this.file.id, name: this.file.name, locked: this.locked, pid: this.o.pid, started: this.started, ops: { ...this.counts }, refused: this.refused, limited: this.limited };
      case "lock": {
        // The answer, sealed on the channel, says whether it was locked already: never the hello's flag.
        const was = this.locked;
        this.lock();
        return { was };
      }
      case "stop":
        return {};
    }
    const keys = this.keys;
    if (keys === undefined) throw new AgentError("locked", "the signer is locked: run `wim agent unlock` in a terminal you opened yourself");
    if (!this.bucket.take()) {
      this.limited++;
      throw new AgentError("rate_limited", "too many signer operations; slow down");
    }
    return this.keyOp(op as Exclude<Op, "hello" | "status" | "lock" | "stop">, a, keys, this.signKey!, entry);
  }

  /**
   * Who it is and whether it is locked (HelloInfo), its own channel key, its run key's certificate,
   * and the run key's signature over the client's nonce, both channel keys and the HelloInfo; with
   * the channel (CHANNEL) for the server to use. The same locked or unlocked. An unlocked signer
   * whose certificate is half spent issues a new run key first.
   */
  private hello(nonce: Uint8Array, clientPub: Uint8Array): Record<string | symbol, unknown> {
    this.refresh();
    const f = this.file;
    const info: HelloInfo = { id: f.id, name: f.name, signPub: f.signPub, boxPub: f.boxPub, locked: this.locked, pid: this.o.pid };
    const mine = ephemeral();
    const transcript = helloTranscript(nonce, clientPub, mine.pub, info);
    const channel = channelFor("signer", mine.privateKey, clientPub, transcript);
    return { ...info, epub: b64u.encode(mine.pub), cert: { ...this.run.body, sig: this.run.sig }, proof: b64u.encode(edSign(null, transcript, this.run.privateKey)), [CHANNEL]: channel };
  }

  private keyOp(op: "sign" | "seal" | "open" | "open2" | "prekey" | "adopt", a: Record<string, unknown>, k: Unlocked, signKey: KeyObject, entry: LogEntry): Record<string, unknown> {
    const me = this.file.id;
    const refuse = (why: string): never => {
      throw new AgentError("refused", why);
    };
    switch (op) {
      case "sign": {
        const type = a["type"] as string;
        const obj = a["obj"] as Record<string, unknown>;
        entry.type = type;
        if (type === "prekey") refuse("prekeys are made by the signer itself (the prekey operation)");
        const owner = OWNER[type];
        if (owner === undefined) throw new AgentError("bad_request", `no signature type ${JSON.stringify(type)}`);
        if (owner(obj) !== me) refuse(`this ${type} object is not this device's`);
        if ((type === "auth" || type === "send") && !(typeof obj["at"] === "number" && Math.abs(obj["at"] - this.o.now()) <= SIGN_SKEW_MS)) {
          refuse(`this ${type} object's time is not within ${SIGN_SKEW_MS / 60_000} minutes of the signer's clock`);
        }
        entry.mesh = typeof obj["mesh"] === "string" ? obj["mesh"] : undefined;
        // The same bytes signObject signs: the type label, then the canonical object without sig.
        const { sig: _sig, ...rest } = obj;
        const message = Buffer.concat([Buffer.from(`wim/1 ${type}\n`, "utf8"), canonBytes(rest)]);
        return { sig: b64u.encode(edSign(null, message, signKey)) };
      }
      case "seal": {
        const req = a as z.infer<typeof sealArgs>;
        Object.assign(entry, { mesh: req.mesh, peer: req.recipient });
        if (req.sender !== me) refuse("a box from another device");
        const box = sealBox(k.keys.boxSec, {
          mesh: req.mesh,
          sender: req.sender,
          recipient: req.recipient,
          aad: b64u.decode(req.aad),
          recipientBox: b64u.decode(req.recipientBox),
          plaintext: b64u.decode(req.plaintext),
          ...(req.prekey === undefined ? {} : { prekey: { id: req.prekey.id, pub: b64u.decode(req.prekey.pub) } }),
        });
        return { box };
      }
      case "open":
      case "open2": {
        const req = a as z.infer<typeof open2Args>;
        Object.assign(entry, { mesh: req.mesh, peer: req.sender });
        if (req.recipient !== me) refuse("a box to another device");
        const open = { mesh: req.mesh, sender: req.sender, recipient: req.recipient, aad: b64u.decode(req.aad), senderBox: b64u.decode(req.senderBox), box: req.box };
        if (op === "open") return opened(openBox(k.keys.boxSec, () => undefined, open));
        return opened(this.openPrekeyBox(req.entry, open, k));
      }
      case "prekey": {
        const mesh = a["mesh"] as string;
        entry.mesh = mesh;
        const at = a["at"] as number;
        // A prekey dated far ahead would sort first in the device's store and push current ones out.
        if (Math.abs(at - this.o.now()) > SIGN_SKEW_MS) refuse(`a prekey's time must be within ${SIGN_SKEW_MS / 60_000} minutes of the signer's clock`);
        const made = createPrekey({ mesh, deviceId: me, signSec: k.keys.signSec, at });
        const sealed = sealPrekeySecret(k.data, made.prekey, made.secret);
        made.secret.fill(0);
        return { prekey: made.prekey, sealed };
      }
      case "adopt": {
        const prekey = a["prekey"] as Prekey;
        entry.mesh = prekey.mesh;
        if (prekey.device !== me || !verifyObject("prekey", prekey, b64u.decode(this.file.signPub))) refuse("not one of this device's prekeys");
        return { sealed: sealPrekeySecret(k.data, prekey, b64u.decode(a["secret"] as string)) };
      }
    }
  }

  /**
   * A scheme 2 box, opened with a sealed prekey secret from `prekeys.json`. The signer keeps the
   * deletion schedule itself: past `until` + 72 hours a prekey is gone, even in a copy of the file.
   */
  private openPrekeyBox(e: { prekey: Prekey; sealed: string }, req: Parameters<typeof openBox>[2], k: Unlocked): Opened {
    if (e.prekey.device !== this.file.id || prekeyDeleteAt(e.prekey) <= this.o.now()) return "key_expired";
    if (!("s" in req.box) || req.box.p !== e.prekey.id) return "decrypt_failed";
    const secret = openPrekeySecret(k.data, e.prekey, e.sealed);
    if (secret === undefined) return "decrypt_failed";
    try {
      return openBox(undefined, () => secret, req);
    } finally {
      secret.fill(0);
    }
  }
}

function opened(o: Opened): Record<string, unknown> {
  return typeof o === "string" ? { reason: o } : { opened: b64u.encode(o) };
}

/** Whether a signer answers at `endpoint` now (a connect that succeeds). */
export function answers(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(endpoint);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/**
 * The signer's socket. Each connection's requests are answered in order, one at a time; separate
 * connections run side by side. After an unlocked signer's `hello`, a connection's lines are
 * sealed on its channel. `stop` answers, then closes everything.
 *
 * The signer holds its endpoint's identity (POSIX: the socket file's inode) from the moment it
 * listens. If the path comes to name anything else (renamed away, or a process put its own socket
 * there), the signer locks and stops: checked before every request, and every `watchMs`.
 */
export class AgentServer {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private stopping = false;
  private identity: string | undefined;
  private watcher: NodeJS.Timeout | undefined;
  readonly stopped: Promise<void>;
  private resolveStopped!: () => void;
  private readonly o: { signer: Signer; endpoint: string; files: EndpointFiles; watchMs?: number };

  constructor(o: { signer: Signer; endpoint: string; files: EndpointFiles; watchMs?: number }) {
    this.o = o;
    this.stopped = new Promise((r) => (this.resolveStopped = r));
  }

  /**
   * Listens. Refuses when a signer already answers there; a stale socket file is replaced. A
   * request that comes in before the endpoint's identity is recorded waits for it (`bound`), and
   * the listener is this server's from the start, so a close at any point closes it.
   */
  async listen(): Promise<void> {
    if (await answers(this.o.endpoint)) throw new AgentError("running", `a signer is already running at ${this.o.endpoint}`);
    await this.o.files.clear(this.o.endpoint);
    let markBound!: () => void;
    this.bound = new Promise<void>((resolve) => (markBound = resolve));
    const server = createServer((socket) => this.serve(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.o.endpoint, () => resolve());
    });
    await this.o.files.secure(this.o.endpoint);
    this.identity = await this.o.files.id(this.o.endpoint);
    markBound();
    this.watcher = setInterval(() => void this.watch(), this.o.watchMs ?? 2000);
    this.watcher.unref();
  }

  /** Resolves once listen() has recorded the endpoint's identity. */
  private bound: Promise<void> = Promise.resolve();

  /** Whether the endpoint still names this signer's own socket. */
  private async owned(): Promise<boolean> {
    return (await this.o.files.id(this.o.endpoint)) === this.identity;
  }

  /** Locks and stops when the endpoint is no longer this signer's own; stops when it is locked and its certificate ran out. */
  async watch(): Promise<void> {
    this.afterWatch(await this.owned());
  }

  private afterWatch(owned: boolean): void {
    if (!owned) this.replacedNow();
    else if (this.o.signer.spent) void this.close();
    else this.o.signer.refresh();
  }

  private replacedNow(): void {
    this.o.signer.replaced();
    void this.close();
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    let buffered = "";
    let queue: Promise<void> = Promise.resolve();
    const state: { channel?: Channel } = {};
    socket.on("error", () => undefined);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      // A request past the limit ends the connection.
      if (buffered.length > MAX_LINE) {
        socket.destroy();
        return;
      }
      for (let nl = buffered.indexOf("\n"); nl !== -1; nl = buffered.indexOf("\n")) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        queue = queue.then(() => this.request(socket, line, state));
      }
    });
  }

  private async request(socket: Socket, line: string, state: { channel?: Channel }): Promise<void> {
    await this.bound;
    return this.dispatch(socket, line, state, await this.owned());
  }

  /** Someone else's socket at the path: nothing is answered, and the signer locks and stops. */
  private dispatch(socket: Socket, line: string, state: { channel?: Channel }, owned: boolean): Promise<void> {
    if (!owned) {
      socket.destroy();
      this.replacedNow();
      return Promise.resolve();
    }
    return this.handleLine(line, state).then((handled) => this.answerLine(socket, state, handled));
  }

  /** The answer to one line, or undefined for a sealed line that does not open (the connection then ends). */
  private async handleLine(line: string, state: { channel?: Channel }): Promise<{ op: string; answer: Answer } | undefined> {
    const text = state.channel === undefined ? line : unseal(state.channel, line);
    if (text === undefined) return undefined;
    let i: unknown = 0;
    let op = "";
    try {
      const req = JSON.parse(text) as { i?: unknown; op?: unknown; a?: unknown };
      i = req.i;
      op = String(req.op);
      return { op, answer: { i, r: await this.o.signer.handle(op, req.a ?? {}) } };
    } catch (error) {
      return { op, answer: { i, e: { code: error instanceof AgentError ? error.code : "bad_request", message: (error as Error).message } } };
    }
  }

  /**
   * Writes an answer (sealed on the channel when there is one), takes up the channel a `hello`
   * opened, and acts on `stop`. Kept synchronous: every branch after the awaits is here.
   */
  private answerLine(socket: Socket, state: { channel?: Channel }, handled: { op: string; answer: Answer } | undefined): void {
    if (handled === undefined) {
      socket.destroy();
      return;
    }
    const text = JSON.stringify(handled.answer);
    const out = `${state.channel === undefined ? text : JSON.stringify({ x: state.channel.seal(text) })}\n`;
    const opened = handled.answer.r?.[CHANNEL] as Channel | undefined;
    if (opened !== undefined) state.channel = opened;
    if (handled.op !== "stop" || handled.answer.r === undefined) {
      // A connection that went away meanwhile drops the answer (its error is ignored above).
      socket.write(out);
      return;
    }
    // Stopped listening before the answer goes out, so a client that has the answer finds the
    // endpoint closed (`wim agent unlock` relies on that to tell a signer from an impostor). The
    // answer is flushed, then this connection is closed like every other.
    this.server!.close();
    socket.end(out, () => socket.destroy());
    void this.close(socket);
  }

  /**
   * Stops listening, closes every connection (but `answering`, which closes itself once its
   * answer is out) and wipes the keys. It waits for no client: one that keeps its end of a
   * connection open, or a Windows pipe slow to report its close, does not keep it running.
   */
  async close(answering?: Socket): Promise<void> {
    if (this.stopping) return this.stopped;
    this.stopping = true;
    clearInterval(this.watcher);
    this.o.signer.lock();
    for (const s of this.sockets) if (s !== answering) s.destroy();
    await new Promise<void>((resolve) => (this.server === undefined ? resolve() : this.server.close(() => resolve())));
    this.resolveStopped();
  }
}

type Answer = { i: unknown; r?: Record<string | symbol, unknown>; e?: { code: string; message: string } };
