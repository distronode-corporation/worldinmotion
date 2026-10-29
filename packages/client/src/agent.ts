// The signer (`wim agent`), the ssh-agent model: one long-running process per device holds the
// device's secret keys and the data key that seals its prekey secrets, and answers sessions over a
// local socket. It signs, seals and opens; it never hands out a key. Locking wipes the keys from
// its memory until the person unlocks it again with the passphrase.
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
import { createPrivateKey, sign as edSign } from "node:crypto";
import { promises as fs } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { z } from "zod";
import type { EndpointFiles } from "./agentpath.ts";
import { MAX_LINE, helloBytes } from "./signer.ts";
import { openKeyFile, openPrekeySecret, sealPrekeySecret, type SealedKeyFile, type Unlocked } from "./vault.ts";

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
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) * this.perSecond) / 1000);
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
  hello: z.strictObject({ nonce: bytes(32) }),
  status: z.strictObject({}),
  sign: signArgs,
  seal: sealArgs,
  open: openArgs,
  open2: open2Args,
  prekey: z.strictObject({ mesh: boxArgs.mesh, at: z.int().min(0) }),
  adopt: z.strictObject({ prekey: prekeySchema, secret: bytes(32) }),
  lock: z.strictObject({}),
  unlock: z.strictObject({ passphrase: z.string().min(1).max(1024) }),
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

/** An Ed25519 private key as Node's crypto takes it (PKCS#8 DER around the 32-byte seed). */
function ed25519Private(seed: Uint8Array) {
  return createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
}

export type SignerOptions = {
  file: SealedKeyFile;
  unlocked: Unlocked;
  now: () => number;
  pid: number;
  log: (entry: LogEntry) => void;
  rate?: { perSecond: number; burst: number };
  /** Opens the key file for `unlock` (openKeyFile); tests pass a faster or a slower one. */
  unlock?: (file: SealedKeyFile, passphrase: string) => Promise<Unlocked>;
};

/**
 * The signer's state and its answer to each request, apart from any socket. Locked, it holds no
 * key and answers only `hello`, `status`, `unlock`, `lock` and `stop`.
 */
export class Signer {
  readonly file: SealedKeyFile;
  readonly started: number;
  private keys: Unlocked | undefined;
  private readonly bucket: TokenBucket;
  private readonly counts: Record<string, number> = {};
  private refused = 0;
  private limited = 0;
  private readonly o: SignerOptions;

  constructor(o: SignerOptions) {
    this.o = o;
    this.file = o.file;
    this.keys = o.unlocked;
    this.started = o.now();
    const rate = o.rate ?? AGENT_RATE;
    this.bucket = new TokenBucket(rate.perSecond, rate.burst, o.now);
  }

  get locked(): boolean {
    return this.keys === undefined;
  }

  /** Wipes the keys from memory (as far as JavaScript can: the byte arrays are zeroed). */
  lock(): void {
    const k = this.keys;
    this.keys = undefined;
    if (k === undefined) return;
    for (const b of [k.keys.signSec, k.keys.boxSec, k.data]) b.fill(0);
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
        return this.hello(b64u.decode(a["nonce"] as string));
      case "status":
        return { id: this.file.id, name: this.file.name, locked: this.locked, pid: this.o.pid, started: this.started, ops: { ...this.counts }, refused: this.refused, limited: this.limited };
      case "lock":
        this.lock();
        return {};
      case "unlock":
        return this.unlock(a["passphrase"] as string);
      case "stop":
        return {};
    }
    const keys = this.keys;
    if (keys === undefined) throw new AgentError("locked", "the signer is locked: run `wim agent unlock` in your own terminal");
    if (!this.bucket.take()) {
      this.limited++;
      throw new AgentError("rate_limited", "too many signer operations; slow down");
    }
    return this.keyOp(op as Exclude<Op, "hello" | "status" | "lock" | "unlock" | "stop">, a, keys, entry);
  }

  private hello(nonce: Uint8Array): Record<string, unknown> {
    const f = this.file;
    const base = { id: f.id, name: f.name, signPub: f.signPub, boxPub: f.boxPub, locked: this.locked, pid: this.o.pid };
    if (this.keys === undefined) return base;
    const proof = edSign(null, helloBytes(nonce), ed25519Private(this.keys.keys.signSec));
    return { ...base, proof: b64u.encode(proof) };
  }

  private async unlock(passphrase: string): Promise<Record<string, unknown>> {
    if (this.keys !== undefined) return {};
    try {
      this.keys = await (this.o.unlock ?? openKeyFile)(this.file, passphrase);
    } catch {
      throw new AgentError("bad_passphrase", "the passphrase does not open the key file");
    }
    return {};
  }

  private keyOp(op: "sign" | "seal" | "open" | "open2" | "prekey" | "adopt", a: Record<string, unknown>, k: Unlocked, entry: LogEntry): Record<string, unknown> {
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
        entry.mesh = typeof obj["mesh"] === "string" ? obj["mesh"] : undefined;
        // The same bytes signObject signs: the type label, then the canonical object without sig.
        const { sig: _sig, ...rest } = obj;
        const message = Buffer.concat([Buffer.from(`wim/1 ${type}\n`, "utf8"), canonBytes(rest)]);
        return { sig: b64u.encode(edSign(null, message, ed25519Private(k.keys.signSec))) };
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
        const made = createPrekey({ mesh, deviceId: me, signSec: k.keys.signSec, at: a["at"] as number });
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
 * connections run side by side. `stop` answers, then closes everything.
 */
export class AgentServer {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private stopping = false;
  readonly stopped: Promise<void>;
  private resolveStopped!: () => void;
  private readonly o: { signer: Signer; endpoint: string; files: EndpointFiles };

  constructor(o: { signer: Signer; endpoint: string; files: EndpointFiles }) {
    this.o = o;
    this.stopped = new Promise((r) => (this.resolveStopped = r));
  }

  /** Listens. Refuses when a signer already answers there; a stale socket file is replaced. */
  async listen(): Promise<void> {
    if (await answers(this.o.endpoint)) throw new AgentError("running", `a signer is already running at ${this.o.endpoint}`);
    await this.o.files.clear(this.o.endpoint);
    const server = createServer((socket) => this.serve(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.o.endpoint, () => resolve());
    });
    await this.o.files.secure(this.o.endpoint);
    this.server = server;
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    let buffered = "";
    let queue: Promise<void> = Promise.resolve();
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
        queue = queue.then(() => this.request(socket, line));
      }
    });
  }

  private async request(socket: Socket, line: string): Promise<void> {
    let i: unknown = 0;
    let op = "";
    let answer: { i: unknown; r?: Record<string, unknown>; e?: { code: string; message: string } };
    try {
      const req = JSON.parse(line) as { i?: unknown; op?: unknown; a?: unknown };
      i = req.i;
      op = String(req.op);
      answer = { i, r: await this.o.signer.handle(op, req.a ?? {}) };
    } catch (error) {
      answer = { i, e: { code: error instanceof AgentError ? error.code : "bad_request", message: (error as Error).message } };
    }
    // A connection that went away meanwhile drops the answer (its error is ignored above).
    socket.write(`${JSON.stringify(answer)}\n`);
    if (op === "stop" && answer.r !== undefined) await this.close();
  }

  /** Stops listening, ends every connection, wipes the keys. */
  async close(): Promise<void> {
    if (this.stopping) return this.stopped;
    this.stopping = true;
    this.o.signer.lock();
    for (const s of this.sockets) s.end();
    await new Promise<void>((resolve) => (this.server === undefined ? resolve() : this.server.close(() => resolve())));
    this.resolveStopped();
  }
}
