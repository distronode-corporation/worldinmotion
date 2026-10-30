// The channel between a session and the signer. `hello` carries an X25519 key from each side; the
// signer signs the client's nonce and both keys with its own key for this run, which the device's
// signing key certified when the signer was unlocked (so a locked signer still proves itself), and
// both derive two ChaCha20-Poly1305 keys from the exchange. Every later line on that connection is
// sealed. A process in the middle (a proxy on the socket path) can relay the hello, but it holds
// neither secret: it can read nothing after it, and forge or change nothing.

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { b64u, canonBytes } from "@worldinmotion/protocol";
// Not ChaCha20-Poly1305 from node:crypto: the VS Code extension runs this client on VS Code's own
// Node (Electron), whose BoringSSL has no such cipher ("Unknown cipher"), so the AEAD is noble's.
import { createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject } from "node:crypto";

/** The label of the signer's proof (never a `wim/1` signature type). */
export const HELLO_LABEL = "wim-agent/2 hello\n";

/** The label under which the device key certifies a signer's key for one run. */
export const CERT_LABEL = "wim-agent/2 signer\n";

const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

/**
 * A run key's certificate body: the key (b64u), whether it is a locked signer's, when it was issued
 * and until when it holds (ms), and the signer's process id. The device key signs certBytes(body).
 */
export type CertBody = { pub: string; locked: boolean; issued: number; expires: number; pid: number };

/** What the device key signs to certify a run key: the label and the canonical certificate body. */
export function certBytes(body: CertBody): Uint8Array {
  return Buffer.concat([Buffer.from(CERT_LABEL, "utf8"), canonBytes(body)]);
}

/** A fresh Ed25519 key for one signer run: the private key object and the raw 32-byte public key. */
export function runKey(): { privateKey: KeyObject; pub: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, pub: new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(ED25519_SPKI.length)) };
}

/** An Ed25519 public key as Node's crypto takes it (SPKI DER around the 32 raw bytes). */
export function ed25519Public(pub: Uint8Array): KeyObject {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI, pub]), format: "der", type: "spki" });
}

const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");

/** A fresh X25519 key for one connection: the private key object and the raw 32-byte public key. */
export function ephemeral(): { privateKey: KeyObject; pub: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return { privateKey, pub: new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(X25519_SPKI.length)) };
}

/** What a hello says about the signer, all of it signed (helloTranscript): nothing a client acts on travels unsigned. */
export type HelloInfo = { id: string; name: string; signPub: string; boxPub: string; locked: boolean; pid: number };

/**
 * What the signer signs in `hello`: the label, the client's nonce, the client's key, its own, then
 * the canonical HelloInfo, so a process in the middle can change none of it (not even `locked`).
 */
export function helloTranscript(nonce: Uint8Array, clientPub: Uint8Array, serverPub: Uint8Array, info: HelloInfo): Uint8Array {
  return Buffer.concat([Buffer.from(HELLO_LABEL, "utf8"), nonce, clientPub, serverPub, canonBytes(info)]);
}

/**
 * One direction each way: a key and a message counter, which is the nonce. Lines arrive in order
 * on a stream, so a counter that does not match (a line dropped, replayed or reordered) fails the
 * tag like any change.
 */
export class Channel {
  private readonly sendKey: Uint8Array;
  private readonly recvKey: Uint8Array;
  private sent = 0;
  private received = 0;

  constructor(sendKey: Uint8Array, recvKey: Uint8Array) {
    this.sendKey = sendKey;
    this.recvKey = recvKey;
  }

  private static nonce(n: number): Uint8Array {
    const nonce = Buffer.alloc(12);
    nonce.writeUIntBE(n, 6, 6);
    return nonce;
  }

  /** Seals one line's text: b64u of ciphertext and tag. */
  seal(text: string): string {
    return b64u.encode(chacha20poly1305(this.sendKey, Channel.nonce(this.sent++)).encrypt(Buffer.from(text, "utf8")));
  }

  /** Opens what the other end sealed next; undefined for anything else. */
  open(sealed: unknown): string | undefined {
    try {
      const plain = chacha20poly1305(this.recvKey, Channel.nonce(this.received)).decrypt(b64u.decode(sealed as string));
      this.received++;
      return Buffer.from(plain).toString("utf8");
    } catch {
      return undefined;
    }
  }
}

/**
 * The channel one side derives: X25519 between its own key and the other side's, then HKDF-SHA256
 * salted with the hash of the signed transcript, so the keys belong to this very hello.
 */
export function channelFor(side: "client" | "signer", mine: KeyObject, theirPub: Uint8Array, transcript: Uint8Array): Channel {
  const shared = diffieHellman({ privateKey: mine, publicKey: createPublicKey({ key: Buffer.concat([X25519_SPKI, theirPub]), format: "der", type: "spki" }) });
  const salt = createHash("sha256").update(transcript).digest();
  const keys = new Uint8Array(hkdfSync("sha256", shared, salt, "wim-agent/2 channel", 64));
  shared.fill(0);
  const toSigner = keys.slice(0, 32);
  const toClient = keys.slice(32);
  keys.fill(0);
  return side === "client" ? new Channel(toSigner, toClient) : new Channel(toClient, toSigner);
}
