// The operations that need a device's secret keys (SPEC section 3), behind one interface, so the
// keys can live in memory (`localKeyring`) or in another process, a signer that hands out
// signatures and opened boxes but never the keys. The wire is the same either way.

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { b64u, utf8 } from "./encoding.ts";
import type { Box } from "./frames.ts";
import { hpkeOpenAuth, hpkeSealAuth } from "./hpke.ts";
import { randomBytes } from "./ids.ts";
import type { DeviceKeys } from "./keys.ts";
import { PROTOCOL } from "./limits.ts";
import { signObject, type SignType } from "./sign.ts";

/** One box between two devices of a mesh: the ids in sender-to-recipient order and the header's AAD. */
export type BoxRequest = { mesh: string; sender: string; recipient: string; aad: Uint8Array };

/**
 * Seal a box from this device. With `prekey` (the recipient's current prekey) it is a scheme 2
 * box; without, a scheme 1 box to the recipient's roster box key `recipientBox`.
 */
export type SealRequest = BoxRequest & { recipientBox: Uint8Array; prekey?: { id: string; pub: Uint8Array }; plaintext: Uint8Array };

/** Open a box to this device, from the sender whose roster box key is `senderBox`. */
export type OpenRequest = BoxRequest & { senderBox: Uint8Array; box: Box };

/**
 * What opening gives: the plaintext bytes, `key_expired` for a scheme 2 box whose prekey this
 * device no longer holds, or `decrypt_failed`. A keyring that cannot answer at all (a signer that
 * is locked or gone) throws instead, so the caller can try again later rather than drop the box.
 */
export type Opened = Uint8Array | "key_expired" | "decrypt_failed";

/**
 * A device's secret-key operations. `signPub` and `boxPub` are its public keys as in the roster.
 * `sign` returns the b64u signature `signObject` would put in `sig`.
 */
export interface Keyring {
  readonly signPub: Uint8Array;
  readonly boxPub: Uint8Array;
  sign(type: SignType, obj: object): Promise<string>;
  seal(req: SealRequest): Promise<Box>;
  open(req: OpenRequest): Promise<Opened>;
}

/**
 * The symmetric key of a scheme 1 box for one sender and one recipient device: HKDF-SHA256 over
 * the X25519 shared secret, salted with the mesh id, labelled with both device ids in
 * sender-to-recipient order, so the two directions between a pair use different keys. X25519
 * refuses low-order public keys, which would give an all-zero, predictable shared secret.
 */
function boxKey(meshId: string, mySec: Uint8Array, theirPub: Uint8Array, senderId: string, recipientId: string): Uint8Array {
  const shared = x25519.getSharedSecret(mySec, theirPub);
  return hkdf(nobleSha256, shared, utf8(meshId), utf8(`${PROTOCOL} box ${senderId} ${recipientId}`), 32);
}

/**
 * The HPKE `info` of a scheme 2 box (SPEC section 6b): the mesh, both device ids in
 * sender-to-recipient order, and the prekey id, so a box cannot be moved to another mesh, pair
 * or prekey.
 */
function box2Info(meshId: string, senderId: string, recipientId: string, prekeyId: string): Uint8Array {
  return utf8(`${PROTOCOL} box2 ${meshId} ${senderId} ${recipientId} ${prekeyId}`);
}

/**
 * Seals one box with the sender device's box secret. Scheme 2: the ephemeral secret exists only
 * inside this call, so the device's key file, stolen later, cannot reopen the box (SPEC section
 * 6b). Throws on a low-order public key.
 */
export function sealBox(boxSec: Uint8Array, req: SealRequest): Box {
  if (req.prekey !== undefined) {
    const info = box2Info(req.mesh, req.sender, req.recipient, req.prekey.id);
    const sealed = hpkeSealAuth({ pkR: req.prekey.pub, skS: boxSec, info, aad: req.aad, plaintext: req.plaintext });
    return { s: 2, p: req.prekey.id, e: b64u.encode(sealed.enc), c: b64u.encode(sealed.ciphertext) };
  }
  const key = boxKey(req.mesh, boxSec, req.recipientBox, req.sender, req.recipient);
  const nonce = randomBytes(24);
  return { n: b64u.encode(nonce), c: b64u.encode(xchacha20poly1305(key, nonce, req.aad).encrypt(req.plaintext)) };
}

/**
 * Opens one box to this device. A scheme 2 box needs only the secret of its prekey, from
 * `prekeySecret` (undefined once deleted: `key_expired`); a scheme 1 box needs the device's box
 * secret, which may be undefined where the caller never opens one.
 */
export function openBox(boxSec: Uint8Array | undefined, prekeySecret: (id: string) => Uint8Array | undefined, req: OpenRequest): Opened {
  const box = req.box;
  try {
    if ("s" in box) {
      const secret = prekeySecret(box.p);
      if (secret === undefined) return "key_expired";
      const info = box2Info(req.mesh, req.sender, req.recipient, box.p);
      return hpkeOpenAuth({ enc: b64u.decode(box.e), skR: secret, pkS: req.senderBox, info, aad: req.aad, ciphertext: b64u.decode(box.c) });
    }
    if (boxSec === undefined) return "decrypt_failed";
    const key = boxKey(req.mesh, boxSec, req.senderBox, req.sender, req.recipient);
    return xchacha20poly1305(key, b64u.decode(box.n), req.aad).decrypt(b64u.decode(box.c));
  } catch {
    return "decrypt_failed";
  }
}

/**
 * A keyring over keys held in this process: the reference behaviour. `prekeySecret` returns the
 * secret of one of the device's prekeys by id, or undefined once it is deleted (SPEC section 6b).
 */
export function localKeyring(keys: DeviceKeys, prekeySecret: (id: string) => Uint8Array | undefined = () => undefined): Keyring {
  return {
    signPub: keys.signPub,
    boxPub: keys.boxPub,
    sign: async (type, obj) => signObject(type, obj, keys.signSec).sig,
    seal: async (req) => sealBox(keys.boxSec, req),
    open: async (req) => openBox(keys.boxSec, prekeySecret, req),
  };
}

/** `signObject` through a keyring: a copy of `obj` carrying the keyring's `sig` (an existing one is replaced). */
export async function signObjectWith<T extends object>(type: SignType, obj: T, keyring: Pick<Keyring, "sign">): Promise<T & { sig: string }> {
  const { sig: _sig, ...rest } = obj as Record<string, unknown>;
  return { ...rest, sig: await keyring.sign(type, rest) } as T & { sig: string };
}
