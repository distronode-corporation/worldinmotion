// The VS Code extension runs this client on VS Code's own Node (Electron), whose BoringSSL has no
// ChaCha20-Poly1305: node:crypto's createCipheriv throws "Unknown cipher" there, which kept the
// extension's session from ever signing in through the signer. Here node:crypto behaves as it
// does in Electron, and the signer channel and the key file still work, with the very bytes
// node:crypto's cipher made before (so a 0.1.5 signer, client or key file still fits).

import { b64u, canonBytes, createPrekey, deviceIdFromSignPub, generateDeviceKeys, randomBytes, utf8 } from "@worldinmotion/protocol";
import * as crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Channel } from "../src/channel.ts";
import { openKeyFile, openPrekeySecret, sealKeyFile, sealPrekeySecret, type SealedKeyFile } from "../src/vault.ts";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const unknown = (): never => {
    throw new Error("Unknown cipher");
  };
  return { ...actual, default: { ...actual, createCipheriv: unknown, createDecipheriv: unknown }, createCipheriv: unknown, createDecipheriv: unknown };
});

const real = await vi.importActual<typeof import("node:crypto")>("node:crypto");

/** ChaCha20-Poly1305 as node:crypto (OpenSSL) seals it: ciphertext, then the 16-byte tag. */
function nodeSeal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plain: Uint8Array): Uint8Array {
  const c = real.createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  c.setAAD(aad, { plaintextLength: plain.length });
  return new Uint8Array(Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]));
}

function nodeOpen(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Uint8Array {
  const d = real.createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  d.setAAD(aad, { plaintextLength: sealed.length - 16 });
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return new Uint8Array(Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]));
}

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => new Uint8Array([...a, ...b]);
/** The channel's nonce for message `n`: a 48-bit counter at the end of 12 bytes. */
const counter = (n: number): Uint8Array => new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, n]);
const NONE = new Uint8Array(0);

describe("on a Node without ChaCha20-Poly1305 in node:crypto (VS Code's Electron)", () => {
  it("node:crypto refuses the cipher here, as it does there", () => {
    expect(() => crypto.createCipheriv("chacha20-poly1305", Buffer.alloc(32), Buffer.alloc(12))).toThrow("Unknown cipher");
  });

  it("the signer channel seals and opens, byte for byte as node:crypto did", () => {
    const toSigner = randomBytes(32);
    const toClient = randomBytes(32);
    const client = new Channel(toSigner, toClient);
    const signer = new Channel(toClient, toSigner);
    const first = client.seal("hello");
    expect(b64u.decode(first)).toEqual(nodeSeal(toSigner, counter(0), NONE, utf8("hello")));
    expect(signer.open(first)).toBe("hello");
    expect(signer.open(client.seal("again"))).toBe("again");
    // What a signer sealed with node:crypto opens here, in order.
    expect(client.open(b64u.encode(nodeSeal(toClient, counter(0), NONE, utf8("back"))))).toBe("back");
    // The counter is the nonce: the signer's first line is 0, its second 1.
    expect(nodeOpen(toClient, counter(0), NONE, b64u.decode(signer.seal("first back")))).toEqual(utf8("first back"));
    expect(nodeOpen(toClient, counter(1), NONE, b64u.decode(signer.seal("second back")))).toEqual(utf8("second back"));
  });

  it("a key file node:crypto sealed opens, and one sealed now opens with node:crypto", async () => {
    const keys = generateDeviceKeys();
    const kdf = { alg: "scrypt" as const, N: 1024, r: 8, p: 1, salt: b64u.encode(randomBytes(16)) };
    const pub = { v: 2 as const, id: deviceIdFromSignPub(keys.signPub), name: "laptop", signPub: b64u.encode(keys.signPub), boxPub: b64u.encode(keys.boxPub), kdf };
    const aad = concat(utf8("wim-agent/1 key file\n"), canonBytes(pub));
    const key = new Uint8Array(real.scryptSync("pass", b64u.decode(kdf.salt), 32, { N: 1024, r: 8, p: 1 }));
    const data = randomBytes(32);
    const secrets = canonBytes({ signSec: b64u.encode(keys.signSec), boxSec: b64u.encode(keys.boxSec), data: b64u.encode(data) });
    const nonce = randomBytes(12);
    const before: SealedKeyFile = { ...pub, nonce: b64u.encode(nonce), sealed: b64u.encode(nodeSeal(key, nonce, aad, secrets)) };
    const opened = await openKeyFile(before, "pass");
    expect(opened.keys).toEqual(keys);
    expect(opened.data).toEqual(data);

    const now = await sealKeyFile({ name: "laptop", keys, passphrase: "pass", data, kdf: { N: 1024, r: 8, p: 1 } });
    const nowKey = new Uint8Array(real.scryptSync("pass", b64u.decode(now.kdf.salt), 32, { N: 1024, r: 8, p: 1 }));
    const nowAad = concat(utf8("wim-agent/1 key file\n"), canonBytes({ v: now.v, id: now.id, name: now.name, signPub: now.signPub, boxPub: now.boxPub, kdf: now.kdf }));
    expect(JSON.parse(Buffer.from(nodeOpen(nowKey, b64u.decode(now.nonce), nowAad, b64u.decode(now.sealed))).toString("utf8"))).toEqual(JSON.parse(Buffer.from(secrets).toString("utf8")));
  });

  it("a prekey secret node:crypto sealed opens, and one sealed now opens with node:crypto", () => {
    const keys = generateDeviceKeys();
    const { prekey, secret } = createPrekey({ mesh: b64u.encode(randomBytes(16)), deviceId: deviceIdFromSignPub(keys.signPub), signSec: keys.signSec, at: 1_760_000_000_000 });
    const data = randomBytes(32);
    const aad = concat(utf8("wim-agent/1 prekey\n"), canonBytes(prekey));
    const nonce = randomBytes(12);
    expect(openPrekeySecret(data, prekey, b64u.encode(concat(nonce, nodeSeal(data, nonce, aad, secret))))).toEqual(secret);
    const now = b64u.decode(sealPrekeySecret(data, prekey, secret));
    expect(nodeOpen(data, now.subarray(0, 12), aad, now.subarray(12))).toEqual(secret);
  });
});
