import { b64u, sha256 } from "./encoding.ts";

type RandomSource = (n: number) => Uint8Array;

const platformRandom: RandomSource = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
let source: RandomSource = platformRandom;

/** Cryptographically secure random bytes from the platform (Node, browsers, Workers). */
export function randomBytes(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0 || n > 65536) {
    throw new RangeError("randomBytes: length must be an integer from 0 to 65536");
  }
  return source(n);
}

/**
 * Runs `fn` with a substitute random source, for generating the deterministic test vectors
 * (SPEC section 16) only. It is deliberately not exported from the package entry point, so
 * applications cannot reach it. The platform source is restored even if `fn` throws.
 */
export function withRandomSource<T>(substitute: RandomSource, fn: () => T): T {
  const previous = source;
  source = substitute;
  try {
    return fn();
  } finally {
    source = previous;
  }
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_TIME = 2 ** 48 - 1;
const RANDOM_BYTES = 10;

let lastTime = -1;
let lastRandom: Uint8Array = new Uint8Array(RANDOM_BYTES);

/**
 * A ULID: 48-bit millisecond time and 80 random bits, Crockford base32, 26 characters.
 *
 * Ids from one process are strictly increasing: when `now` is not later than the previous call
 * (same millisecond, or a clock step backwards), the previous time is reused and the random part
 * is incremented. Should the random part overflow, the time advances by one millisecond.
 */
export function ulid(now: number = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_TIME) {
    throw new RangeError("ulid: time must be an integer from 0 to 2^48 - 1");
  }
  if (now > lastTime) {
    lastTime = now;
    lastRandom = randomBytes(RANDOM_BYTES);
  } else if (!increment(lastRandom)) {
    if (lastTime === MAX_TIME) throw new RangeError("ulid: time space exhausted");
    lastTime += 1;
    lastRandom = randomBytes(RANDOM_BYTES);
  }
  return encodeTime(lastTime) + encodeRandom(lastRandom);
}

/** Adds one to a big-endian byte string in place. Returns false on overflow. */
function increment(bytes: Uint8Array): boolean {
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i] !== 0xff) {
      bytes[i] = bytes[i]! + 1;
      return true;
    }
    bytes[i] = 0;
  }
  return false;
}

function encodeTime(time: number): string {
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[time % 32]! + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 80 bits is exactly 16 base32 digits, so the value is read as a bigint and emitted 5 bits at a time.
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 16; i++) {
    out = CROCKFORD[Number(n & 31n)]! + out;
    n >>= 5n;
  }
  return out;
}

// Canonical form only: upper case, no I L O U, and a first digit of at most 7 (128 bits).
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isUlid(s: unknown): s is string {
  return typeof s === "string" && ULID_RE.test(s);
}

/** Time component of a ULID, in milliseconds. */
export function ulidTime(id: string): number {
  if (!isUlid(id)) throw new TypeError("ulidTime: not a ULID");
  let time = 0;
  for (const ch of id.slice(0, 10)) time = time * 32 + CROCKFORD.indexOf(ch);
  return time;
}

// The one name grammar (SPEC section 2): 1 to 32 of `[a-z0-9-]`, starting with a letter or digit.
// Addresses and rooms are built from it, so the three can never drift apart.
const NAME = "[a-z0-9][a-z0-9-]{0,31}";
const NAME_RE = new RegExp(`^${NAME}$`);
/** `name@device`. */
export const ADDRESS_RE = new RegExp(`^${NAME}@${NAME}$`);
/** `#name`: a room (SPEC section 13). */
export const ROOM_RE = new RegExp(`^#${NAME}$`);

/** Session and device names: 1 to 32 of `[a-z0-9-]`, starting with a letter or digit. */
export function isName(s: unknown): s is string {
  return typeof s === "string" && NAME_RE.test(s);
}

/** Device id: `b64u(SHA-256(signPub))` truncated to 22 characters. */
export function deviceIdFromSignPub(pub: Uint8Array): string {
  if (!(pub instanceof Uint8Array) || pub.length !== 32) {
    throw new TypeError("deviceIdFromSignPub: expected a 32-byte Ed25519 public key");
  }
  return b64u.encode(sha256(pub)).slice(0, 22);
}

const ID22_RE = /^[A-Za-z0-9_-]{22}$/;

/** Shape of a device id or invite id (22 characters of base64url). */
export function isId22(s: unknown): s is string {
  return typeof s === "string" && ID22_RE.test(s);
}
