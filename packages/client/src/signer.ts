// The session side of the signer (`wim agent`): a client for its local socket, and the device
// keyring that asks it for every operation that needs a secret key. Sessions never read the key
// file while the signer holds it; they ask, and the signer answers or refuses.
//
// Wire: one JSON object per line. A request is `{ "i": n, "op": "...", "a": { ... } }`, the
// answer `{ "i": n, "r": { ... } }` or `{ "i": n, "e": { "code": "...", "message": "..." } }`.
// Bytes travel as b64u.

import { b64u, randomBytes, type Box, type OpenRequest, type Opened, type Prekey, type SealRequest, type SignType } from "@worldinmotion/protocol";
import { createPublicKey, verify } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { openWithClearPrekey, type DeviceKeyring, type PrekeyEntry } from "./keyring.ts";

/** The longest line either side accepts: a send frame (1 MiB) to sign, in JSON, with room to spare. */
export const MAX_LINE = 4 * 1024 * 1024;

/** The label of the signer's proof that it holds this device's signing key (never a `wim/1` type). */
export const HELLO_LABEL = "wim-agent/1 hello\n";

/** Why the signer could not do what was asked. `unavailable`: no signer answers at the endpoint. */
export type SignerCode = "unavailable" | "locked" | "rate_limited" | "refused" | "bad_request" | "bad_passphrase" | "timeout" | "mismatch";

export class SignerError extends Error {
  override readonly name = "SignerError";
  readonly code: SignerCode;
  constructor(code: SignerCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** What `hello` tells: the device the signer holds, whether it is locked, and its process. */
export type Hello = { id: string; name: string; signPub: string; boxPub: string; locked: boolean; pid: number; proof?: string };

/** The bytes the signer signs to prove it holds the signing key: the label and the client's nonce. */
export function helloBytes(nonce: Uint8Array): Uint8Array {
  return Buffer.concat([Buffer.from(HELLO_LABEL, "utf8"), nonce]);
}

/** An Ed25519 public key as Node's crypto takes it (SPKI DER around the 32 raw bytes). */
export function ed25519Public(pub: Uint8Array) {
  return createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub]), format: "der", type: "spki" });
}

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

type Pending = { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * One connection to the signer, made on first use and again after it drops. Each new connection
 * starts with `hello`: when the signer is unlocked it must prove it holds `expect` (the device's
 * signing key, from the key file's public part), so no other process can stand in for it.
 */
export class SignerClient {
  readonly endpoint: string;
  private readonly expect: Uint8Array | undefined;
  private readonly timeoutMs: number;
  private readonly connect: (endpoint: string) => Socket;
  private socket: Socket | undefined;
  private opening: Promise<Socket> | undefined;
  private next = 0;
  private readonly pending = new Map<number, Pending>();
  private buffered = "";

  constructor(o: { endpoint: string; expect?: Uint8Array; timeoutMs?: number; connect?: (endpoint: string) => Socket }) {
    this.endpoint = o.endpoint;
    this.expect = o.expect;
    this.timeoutMs = o.timeoutMs ?? 30_000;
    this.connect = o.connect ?? ((endpoint) => createConnection(endpoint));
  }

  /** Asks the signer; rejects with a SignerError when it refuses, is not there, or does not answer. */
  async call(op: string, a: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const socket = await this.connected();
    return this.send(socket, op, a);
  }

  /** `hello` on a connection of its own choosing: the signer's state, checked against `expect`. */
  async hello(): Promise<Hello> {
    const socket = await this.connected();
    return this.greet(socket);
  }

  /** Drops the connection; pending calls fail as `unavailable`. */
  close(): void {
    this.socket?.destroy();
  }

  private send(socket: Socket, op: string, a: Record<string, unknown>): Promise<Record<string, unknown>> {
    const i = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(i);
        this.idle(socket);
        reject(new SignerError("timeout", `the signer did not answer ${op} in ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(i, { resolve, reject, timer });
      // A connection with calls in flight keeps the process alive; an idle one does not.
      socket.ref();
      socket.write(`${JSON.stringify({ i, op, a })}\n`);
    });
  }

  private idle(socket: Socket): void {
    if (this.pending.size === 0) socket.unref();
  }

  private connected(): Promise<Socket> {
    if (this.socket !== undefined) return Promise.resolve(this.socket);
    this.opening ??= this.open().finally(() => (this.opening = undefined));
    return this.opening;
  }

  private open(): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const socket = this.connect(this.endpoint);
      socket.setEncoding("utf8");
      // Before the connection: no signer there. After it: the close that follows fails what is pending.
      socket.on("error", (error: NodeJS.ErrnoException) => {
        reject(new SignerError("unavailable", `no signer answers at ${this.endpoint} (${error.code ?? error.message}): run \`wim agent start\` in your own terminal`));
      });
      socket.once("connect", () => {
        socket.on("data", (chunk: string) => this.take(socket, chunk));
        socket.once("close", () => this.dropped(socket));
        this.greet(socket).then(
          () => {
            this.socket = socket;
            resolve(socket);
          },
          (error: unknown) => {
            socket.destroy();
            reject(error as Error);
          },
        );
      });
    });
  }

  private async greet(socket: Socket): Promise<Hello> {
    const nonce = randomBytes(32);
    const hello = (await this.send(socket, "hello", { nonce: b64u.encode(nonce) })) as Hello;
    if (this.expect !== undefined && hello.signPub !== b64u.encode(this.expect)) {
      throw new SignerError("mismatch", `the signer at ${this.endpoint} holds another device's keys (${hello.id})`);
    }
    // Locked, it holds no key to prove; it can then only be unlocked or asked for its status.
    if (!hello.locked && (hello.proof === undefined || !verify(null, helloBytes(nonce), ed25519Public(b64u.decode(hello.signPub)), b64u.decode(hello.proof)))) {
      throw new SignerError("mismatch", `the signer at ${this.endpoint} could not prove it holds its device's signing key`);
    }
    return hello;
  }

  private take(socket: Socket, chunk: string): void {
    this.buffered += chunk;
    if (this.buffered.length > MAX_LINE) {
      socket.destroy();
      return;
    }
    for (let nl = this.buffered.indexOf("\n"); nl !== -1; nl = this.buffered.indexOf("\n")) {
      const line = this.buffered.slice(0, nl);
      this.buffered = this.buffered.slice(nl + 1);
      let answer: { i?: unknown; r?: Record<string, unknown>; e?: { code: SignerCode; message: string } };
      try {
        answer = JSON.parse(line) as typeof answer;
      } catch {
        socket.destroy();
        return;
      }
      const waiting = this.pending.get(answer.i as number);
      if (waiting === undefined) continue;
      this.pending.delete(answer.i as number);
      clearTimeout(waiting.timer);
      this.idle(socket);
      if (answer.e !== undefined) waiting.reject(new SignerError(answer.e.code, answer.e.message));
      else waiting.resolve(answer.r as Record<string, unknown>);
    }
  }

  private dropped(socket: Socket): void {
    if (this.socket === socket) this.socket = undefined;
    this.buffered = "";
    for (const [i, waiting] of this.pending) {
      this.pending.delete(i);
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
