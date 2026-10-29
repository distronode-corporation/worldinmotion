// RFC 9180 HPKE, one suite and one mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and
// ChaCha20-Poly1305 in mode_auth, single shot (sequence number 0). Built on the noble primitives
// the protocol already uses, so it adds no dependency. SPEC section 3 says where wim uses it (the
// scheme 2 box); test/hpke.test.ts checks it against the RFC's Appendix A.2.3 vectors.

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8 } from "./encoding.ts";
import { randomBytes } from "./ids.ts";

const MODE_AUTH = 0x02;
const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0003;

const i2osp2 = (n: number): Uint8Array => Uint8Array.of(n >> 8, n & 0xff);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const KEM_SUITE = concat(utf8("KEM"), i2osp2(KEM_ID));
const HPKE_SUITE = concat(utf8("HPKE"), i2osp2(KEM_ID), i2osp2(KDF_ID), i2osp2(AEAD_ID));
const V1 = utf8("HPKE-v1");

function labeledExtract(suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array): Uint8Array {
  return extract(sha256, concat(V1, suite, utf8(label), ikm), salt);
}

function labeledExpand(suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, length: number): Uint8Array {
  return expand(sha256, prk, concat(i2osp2(length), V1, suite, utf8(label), info), length);
}

/** RFC 9180 section 4.1 ExtractAndExpand, for the KEM's shared secret. */
function kemSecret(dh: Uint8Array, kemContext: Uint8Array): Uint8Array {
  const prk = labeledExtract(KEM_SUITE, new Uint8Array(0), "eae_prk", dh);
  return labeledExpand(KEM_SUITE, prk, "shared_secret", kemContext, 32);
}

/** RFC 9180 section 5.1 KeySchedule for mode_auth (no PSK): the AEAD key and base nonce. */
function keySchedule(sharedSecret: Uint8Array, info: Uint8Array): { key: Uint8Array; nonce: Uint8Array } {
  const empty = new Uint8Array(0);
  const pskIdHash = labeledExtract(HPKE_SUITE, empty, "psk_id_hash", empty);
  const infoHash = labeledExtract(HPKE_SUITE, empty, "info_hash", info);
  const context = concat(Uint8Array.of(MODE_AUTH), pskIdHash, infoHash);
  const secret = labeledExtract(HPKE_SUITE, sharedSecret, "secret", empty);
  return {
    key: labeledExpand(HPKE_SUITE, secret, "key", context, 32),
    nonce: labeledExpand(HPKE_SUITE, secret, "base_nonce", context, 12),
  };
}

/** The intermediate values of one seal, for the test vectors (SPEC section 16). */
export type HpkeTrace = { enc: Uint8Array; sharedSecret: Uint8Array; key: Uint8Array; nonce: Uint8Array; ciphertext: Uint8Array };

/**
 * SealAuth: encrypts `plaintext` to the recipient public key `pkR`, authenticated by the sender's
 * static secret `skS`, with a fresh ephemeral key. Returns the encapsulated key `enc` (the
 * ephemeral public key) and the ciphertext. The ephemeral secret lives only inside this call.
 * `ephemeral` fixes the ephemeral secret, for test vectors only. Throws when a public key is of
 * low order (X25519 then gives an all-zero secret).
 */
export function hpkeSealAuth(opts: {
  pkR: Uint8Array;
  skS: Uint8Array;
  info: Uint8Array;
  aad: Uint8Array;
  plaintext: Uint8Array;
  ephemeral?: Uint8Array;
}): HpkeTrace {
  const skE = opts.ephemeral ?? randomBytes(32);
  const enc = x25519.getPublicKey(skE);
  const dh = concat(x25519.getSharedSecret(skE, opts.pkR), x25519.getSharedSecret(opts.skS, opts.pkR));
  const sharedSecret = kemSecret(dh, concat(enc, opts.pkR, x25519.getPublicKey(opts.skS)));
  const { key, nonce } = keySchedule(sharedSecret, opts.info);
  const ciphertext = chacha20poly1305(key, nonce, opts.aad).encrypt(opts.plaintext);
  return { enc, sharedSecret, key, nonce, ciphertext };
}

/**
 * OpenAuth: decrypts what `hpkeSealAuth` sealed, given the recipient's secret `skR` and the
 * sender's static public key `pkS`. Throws on any failure: a wrong key, sender, `info`, `aad`,
 * `enc` or ciphertext, or a low-order public key.
 */
export function hpkeOpenAuth(opts: { enc: Uint8Array; skR: Uint8Array; pkS: Uint8Array; info: Uint8Array; aad: Uint8Array; ciphertext: Uint8Array }): Uint8Array {
  const dh = concat(x25519.getSharedSecret(opts.skR, opts.enc), x25519.getSharedSecret(opts.skR, opts.pkS));
  const sharedSecret = kemSecret(dh, concat(opts.enc, x25519.getPublicKey(opts.skR), opts.pkS));
  const { key, nonce } = keySchedule(sharedSecret, opts.info);
  return chacha20poly1305(key, nonce, opts.aad).decrypt(opts.ciphertext);
}
