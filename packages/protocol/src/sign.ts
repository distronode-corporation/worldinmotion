import { ed25519 } from "@noble/curves/ed25519.js";
import { b64u, canonBytes, utf8 } from "./encoding.ts";
import { PROTOCOL } from "./limits.ts";

/** What a signature is for. Each type signs under its own label, so one can never pass as another. */
export type SignType = "roster" | "send" | "auth" | "join" | "prekey";

const SIGN_TYPES: ReadonlySet<string> = new Set<SignType>(["roster", "send", "auth", "join", "prekey"]);

function withoutSig(obj: object): Record<string, unknown> {
  const { sig: _sig, ...rest } = obj as Record<string, unknown>;
  return rest;
}

/** The signed bytes: `UTF-8("wim/1 " + type + "\n") || canonBytes(obj without sig)`. */
function signedBytes(type: SignType, obj: object): Uint8Array {
  if (!SIGN_TYPES.has(type)) throw new TypeError(`unknown signature type ${String(type)}`);
  const label = utf8(`${PROTOCOL} ${type}\n`);
  const body = canonBytes(withoutSig(obj));
  const out = new Uint8Array(label.length + body.length);
  out.set(label);
  out.set(body, label.length);
  return out;
}

/**
 * Signs an object of the given type with Ed25519 and returns a copy carrying `sig`. An existing
 * `sig` is replaced. Throws if the type is unknown or the object cannot be canonically encoded.
 */
export function signObject<T extends object>(type: SignType, obj: T, signSec: Uint8Array): T & { sig: string } {
  const sig = b64u.encode(ed25519.sign(signedBytes(type, obj), signSec));
  return { ...withoutSig(obj), sig } as T & { sig: string };
}

/**
 * Verifies a signature made by `signObject` with the same type. Never throws: any malformed
 * object, signature, key or type gives false. Verification is strict RFC 8032 (S < L, canonical
 * R and A, small-order keys refused), so a signature has a single accepted encoding.
 */
export function verifyObject(type: SignType, obj: { sig: string }, signPub: Uint8Array): boolean {
  try {
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return false;
    if (typeof obj.sig !== "string") return false;
    const sig = b64u.decode(obj.sig);
    if (sig.length !== 64 || !(signPub instanceof Uint8Array) || signPub.length !== 32) return false;
    return ed25519.verify(sig, signedBytes(type, obj), signPub, { zip215: false });
  } catch {
    return false;
  }
}
