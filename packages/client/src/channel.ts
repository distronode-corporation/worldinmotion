// The channel between a session and the signer. `hello` carries an X25519 key from each side; the
// signer signs the client's nonce and both keys with its own key for this run, which the device's
// signing key certified when the signer was unlocked (so a locked signer still proves itself), and
// both derive two ChaCha20-Poly1305 keys from the exchange. Every later line on that connection is
// sealed. A process in the middle (a proxy on the socket path) can relay the hello, but it holds
// neither secret: it can read nothing after it, and forge or change nothing.

import { b64u } from "@worldinmotion/protocol";
import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject } from "node:crypto";

/** The label of the signer's proof (never a `wim/1` signature type). */
export const HELLO_LABEL = "wim-agent/2 hello\n";

/** The label under which the device key certifies a signer's key for one run. */
export const CERT_LABEL = "wim-agent/2 signer\n";

const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

/** What the device key signs to certify a signer's key for one run: the label and the raw public key. */
export function certBytes(certPub: Uint8Array): Uint8Array {
  return Buffer.concat([Buffer.from(CERT_LABEL, "utf8"), certPub]);
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

/** What the signer signs in `hello`: the label, the client's nonce, the client's key, then its own. */
export function helloTranscript(nonce: Uint8Array, clientPub: Uint8Array, serverPub: Uint8Array): Uint8Array {
  return Buffer.concat([Buffer.from(HELLO_LABEL, "utf8"), nonce, clientPub, serverPub]);
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

  private static nonce(n: number): Buffer {
    const nonce = Buffer.alloc(12);
    nonce.writeUIntBE(n, 6, 6);
    return nonce;
  }

  /** Seals one line's text: b64u of ciphertext and tag. */
  seal(text: string): string {
    const cipher = createCipheriv("chacha20-poly1305", this.sendKey, Channel.nonce(this.sent++), { authTagLength: 16 });
    return b64u.encode(Buffer.concat([cipher.update(text, "utf8"), cipher.final(), cipher.getAuthTag()]));
  }

  /** Opens what the other end sealed next; undefined for anything else. */
  open(sealed: unknown): string | undefined {
    try {
      const bytes = Buffer.from(b64u.decode(sealed as string));
      const decipher = createDecipheriv("chacha20-poly1305", this.recvKey, Channel.nonce(this.received), { authTagLength: 16 });
      decipher.setAuthTag(bytes.subarray(bytes.length - 16));
      const text = Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - 16)), decipher.final()]).toString("utf8");
      this.received++;
      return text;
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
