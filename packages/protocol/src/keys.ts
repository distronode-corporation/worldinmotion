import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { b64u, bytesEqual, canon } from "./encoding.ts";
import { deviceIdFromSignPub, randomBytes } from "./ids.ts";
import { parseJson } from "./json.ts";

/** A device's two key pairs (SPEC section 3). Secrets are 32-byte seeds. */
export type DeviceKeys = {
  signPub: Uint8Array;
  signSec: Uint8Array;
  boxPub: Uint8Array;
  boxSec: Uint8Array;
};

/** The key file as JSON: every key in b64u, plus the derived device id for readability. */
export type EncodedKeys = {
  v: 1;
  id: string;
  signPub: string;
  signSec: string;
  boxPub: string;
  boxSec: string;
};

export function generateDeviceKeys(): DeviceKeys {
  return deviceKeysFromSecrets(randomBytes(32), randomBytes(32));
}

/** Rebuilds a key set from its two 32-byte secrets (an Ed25519 seed and an X25519 secret). */
export function deviceKeysFromSecrets(signSec: Uint8Array, boxSec: Uint8Array): DeviceKeys {
  if (!(signSec instanceof Uint8Array) || signSec.length !== 32 || !(boxSec instanceof Uint8Array) || boxSec.length !== 32) {
    throw new TypeError("deviceKeysFromSecrets: expected two 32-byte secrets");
  }
  return {
    signPub: ed25519.getPublicKey(signSec),
    signSec: signSec.slice(),
    boxPub: x25519.getPublicKey(boxSec),
    boxSec: boxSec.slice(),
  };
}

/** Serialises keys for the key file. The caller is responsible for the file's permissions. */
export function encodeKeys(keys: DeviceKeys): string {
  const encoded: EncodedKeys = {
    v: 1,
    id: deviceIdFromSignPub(keys.signPub),
    signPub: b64u.encode(keys.signPub),
    signSec: b64u.encode(keys.signSec),
    boxPub: b64u.encode(keys.boxPub),
    boxSec: b64u.encode(keys.boxSec),
  };
  return canon(encoded);
}

/**
 * Parses a key file (JSON text or an already parsed object). Throws on duplicate keys, and
 * unless every key has the right length, each public key matches its secret, and the stored id
 * matches the signing key.
 */
export function decodeKeys(json: string | object): DeviceKeys {
  let raw: unknown = json;
  if (typeof json === "string") {
    const parsed = parseJson(json);
    if (!parsed.ok) throw new TypeError(`decodeKeys: ${parsed.reason === "duplicate_key" ? "duplicate key" : "not JSON"}`);
    raw = parsed.value;
  }
  if (typeof raw !== "object" || raw === null) throw new TypeError("decodeKeys: not an object");
  const r = raw as Record<string, unknown>;
  if (r["v"] !== 1) throw new TypeError("decodeKeys: unsupported key file version");
  const field = (name: string): Uint8Array => {
    const value = r[name];
    if (typeof value !== "string") throw new TypeError(`decodeKeys: ${name} is missing`);
    const bytes = b64u.decode(value);
    if (bytes.length !== 32) throw new TypeError(`decodeKeys: ${name} must be 32 bytes`);
    return bytes;
  };
  const keys: DeviceKeys = {
    signPub: field("signPub"),
    signSec: field("signSec"),
    boxPub: field("boxPub"),
    boxSec: field("boxSec"),
  };
  if (!bytesEqual(ed25519.getPublicKey(keys.signSec), keys.signPub)) {
    throw new TypeError("decodeKeys: signPub does not match signSec");
  }
  if (!bytesEqual(x25519.getPublicKey(keys.boxSec), keys.boxPub)) {
    throw new TypeError("decodeKeys: boxPub does not match boxSec");
  }
  if (r["id"] !== deviceIdFromSignPub(keys.signPub)) {
    throw new TypeError("decodeKeys: id does not match signPub");
  }
  return keys;
}
