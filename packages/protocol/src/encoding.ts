import { hmac } from "@noble/hashes/hmac.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

/**
 * Canonical JSON (SPEC section 2). Every hash and signature in the protocol is computed over these
 * bytes, so two implementations must produce identical output for the same value.
 *
 * - Object keys are sorted by UTF-16 code unit (the default JavaScript string order).
 * - No whitespace. Strings use the escapes of ECMAScript `JSON.stringify` (`\"`, `\\`, `\b`,
 *   `\f`, `\n`, `\r`, `\t`, `\u00XX` for other control characters); all other characters,
 *   including non-ASCII, are written as themselves.
 * - Numbers must be safe integers (no floats, NaN or infinities). `-0` encodes as `0`.
 * - Object keys whose value is `undefined` are omitted. Anything else that JSON cannot represent
 *   exactly (bigint, functions, symbols, class instances, sparse arrays, `undefined` in an array,
 *   strings with unpaired surrogates, cycles) throws instead of being coerced.
 */
export function canon(value: unknown): string {
  return encode(value, 0, new Set());
}

/** UTF-8 bytes of `canon(value)`. */
export function canonBytes(value: unknown): Uint8Array {
  return utf8(canon(value));
}

// Deep enough for every protocol object, shallow enough that hostile input cannot exhaust the stack.
const MAX_DEPTH = 64;

// With the `u` flag, a surrogate range matches only code units that are not part of a valid pair.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

function encode(value: unknown, depth: number, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(`canon: ${String(value)} is not a safe integer`);
      }
      return Object.is(value, -0) ? "0" : String(value);
    case "string":
      if (LONE_SURROGATE.test(value)) throw new TypeError("canon: string has an unpaired surrogate");
      return JSON.stringify(value);
    case "object":
      return encodeContainer(value, depth, seen);
    default:
      throw new TypeError(`canon: cannot encode a value of type ${typeof value}`);
  }
}

function encodeContainer(value: object, depth: number, seen: Set<object>): string {
  if (depth >= MAX_DEPTH) throw new TypeError(`canon: nesting deeper than ${MAX_DEPTH}`);
  if (seen.has(value)) throw new TypeError("canon: cyclic value");
  seen.add(value);
  let out: string;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) throw new TypeError("canon: sparse array");
      const item: unknown = value[i];
      if (item === undefined) throw new TypeError("canon: undefined in an array");
      parts.push(encode(item, depth + 1, seen));
    }
    out = `[${parts.join(",")}]`;
  } else {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError("canon: not a plain object");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("canon: object has symbol keys");
    }
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) continue;
      parts.push(`${encode(key, depth + 1, seen)}:${encode(item, depth + 1, seen)}`);
    }
    out = `{${parts.join(",")}}`;
  }
  seen.delete(value);
  return out;
}

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** UTF-8 bytes of a string. */
export function utf8(str: string): Uint8Array {
  return encoder.encode(str);
}

/** Decodes UTF-8, throwing on invalid byte sequences instead of substituting U+FFFD. */
export function fromUtf8(bytes: Uint8Array): string {
  return strictDecoder.decode(bytes);
}

/**
 * True when the UTF-8 encoding of `str` is at most `limit` bytes. A UTF-16 code unit encodes to at
 * least one byte, so an over-long string is refused before it is encoded.
 */
export function fitsUtf8(str: string, limit: number): boolean {
  return str.length <= limit && encoder.encode(str).length <= limit;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
// Character code to 6-bit value, or 255 for characters outside the alphabet.
const LOOKUP = new Uint8Array(128).fill(255);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;
const CODES = Uint8Array.from(ALPHABET, (c) => c.charCodeAt(0));
const asciiDecoder = new TextDecoder();

/**
 * base64url without padding (RFC 4648 section 5). `decode` accepts only the canonical form: no
 * padding, no characters outside the alphabet, no impossible length, and zero trailing bits, so
 * every byte string has exactly one accepted encoding.
 */
export const b64u = {
  encode(bytes: Uint8Array): string {
    // Written as ASCII codes into one buffer, then decoded once: fast for megabyte inputs.
    const out = new Uint8Array(Math.ceil((bytes.length * 4) / 3));
    let i = 0;
    let j = 0;
    for (; i + 2 < bytes.length; i += 3) {
      const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
      out[j++] = CODES[n >> 18]!;
      out[j++] = CODES[(n >> 12) & 63]!;
      out[j++] = CODES[(n >> 6) & 63]!;
      out[j++] = CODES[n & 63]!;
    }
    const rest = bytes.length - i;
    if (rest > 0) {
      const n = (bytes[i]! << 16) | (rest === 2 ? bytes[i + 1]! << 8 : 0);
      out[j++] = CODES[n >> 18]!;
      out[j++] = CODES[(n >> 12) & 63]!;
      if (rest === 2) out[j++] = CODES[(n >> 6) & 63]!;
    }
    return asciiDecoder.decode(out);
  },

  decode(str: string): Uint8Array {
    if (typeof str !== "string") throw new TypeError("b64u: not a string");
    if (str.length % 4 === 1) throw new TypeError("b64u: impossible length");
    const out = new Uint8Array(Math.floor((str.length * 3) / 4));
    let bits = 0;
    let acc = 0;
    let j = 0;
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      const v = code < 128 ? LOOKUP[code]! : 255;
      if (v === 255) throw new TypeError("b64u: invalid character");
      acc = ((acc << 6) | v) & 0xffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[j++] = (acc >> bits) & 0xff;
      }
    }
    if ((acc & ((1 << bits) - 1)) !== 0) throw new TypeError("b64u: non-zero trailing bits");
    return out;
  },
};

/** SHA-256. */
export function sha256(bytes: Uint8Array): Uint8Array {
  return nobleSha256(bytes);
}

/** HMAC-SHA-256 of `bytes` under `key` (RFC 2104). */
export function hmacSha256(key: Uint8Array, bytes: Uint8Array): Uint8Array {
  return hmac(nobleSha256, key, bytes);
}

/** `hash(x)` from SPEC section 2: `b64u(SHA-256(canon(x)))`. */
export function hash(value: unknown): string {
  return b64u.encode(sha256(canonBytes(value)));
}

/** Constant-time comparison of two byte strings. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
