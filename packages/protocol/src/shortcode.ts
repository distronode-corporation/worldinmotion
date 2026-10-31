import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import { b64u, fromUtf8, sha256, utf8 } from "./encoding.ts";
import { randomBytes } from "./ids.ts";
import { fail, LIMITS, ok, PROTOCOL, type Result } from "./limits.ts";
import { b64uBytes, b64uRange, deviceIdSchema, isRelayUrl, safeParse, timeSchema } from "./schema.ts";

/*
 * Short invite codes (SPEC section 5): `wim2-` and 24 Crockford base32 characters, the first 20
 * a random secret `k` (100 bits) and the last 4 a check against typing mistakes, plus `@relay`
 * when the invite's relay is not the hosted one. The admin device seals the full `wim1_` code
 * under a key derived from `k` and stores the box at the relay under an id that is a hash of
 * `k`; the joiner fetches the box by that id and opens it. The relay never sees `k`.
 */

const PREFIX = "wim2-";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const K_CHARS = 20;
const CHECK_CHARS = 4;
const K_RE = /^[0-9A-HJKMNP-TV-Z]{20}$/;

/** The relay a short code without `@` names: the hosted relay (README). */
export const SHORT_CODE_RELAY = "wss://worldinmotion.distronode.com";

/** The first `chars * 5` bits of `bytes`, big-endian, as Crockford base32. */
function crockford(bytes: Uint8Array, chars: number): string {
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  bits >>= BigInt(bytes.length * 8 - chars * 5);
  let out = "";
  for (let i = 0; i < chars; i++) out = CROCKFORD[Number((bits >> BigInt(5 * i)) & 31n)]! + out;
  return out;
}

/** The 4-character check: the first 20 bits of `SHA-256(UTF-8("wim/1 short code " + k))`. */
function check(k: string): string {
  return crockford(sha256(utf8(`${PROTOCOL} short code ${k}`)).subarray(0, 3), CHECK_CHARS);
}

function assertK(k: string, where: string): void {
  if (typeof k !== "string" || !K_RE.test(k)) throw new TypeError(`${where}: k must be 20 Crockford base32 characters`);
}

/** A fresh short code secret: 100 random bits as 20 upper-case Crockford base32 characters. */
export function newShortKey(): string {
  return crockford(randomBytes(13), K_CHARS);
}

/**
 * The code a person reads and types: `wim2-` and `k` with its check in six groups of four, then
 * `@` and the relay URL without `wss://` (a `ws://` loopback URL in full), unless the relay is
 * the hosted one.
 */
export function formatShortCode(k: string, relay: string): string {
  assertK(k, "formatShortCode");
  if (!isRelayUrl(relay)) throw new TypeError("formatShortCode: invalid relay URL");
  const groups = `${k}${check(k)}`.match(/.{4}/g)!.join("-");
  const where = relay === SHORT_CODE_RELAY ? "" : `@${relay.startsWith("wss://") ? relay.slice("wss://".length) : relay}`;
  return `${PREFIX}${groups}${where}`;
}

/** Whether a pasted or typed code is a short invite code (by its prefix, in any case). */
export function isShortCode(code: unknown): boolean {
  return typeof code === "string" && code.trim().toLowerCase().startsWith(PREFIX);
}

/**
 * Reads a short invite code back into its secret `k` and the relay it names. Forgiving as people
 * type: any case, with or without the dashes or spaces between groups, and `I` and `L` read as
 * `1`, `O` as `0`. Throws an Error with a readable message when the code is not one, its check
 * does not match (a typing mistake), or the part after `@` is not a relay.
 */
export function parseShortCode(code: string): { k: string; relay: string } {
  const text = typeof code === "string" ? code.trim() : "";
  if (!isShortCode(text)) throw new Error("invalid short invite code: it must start with wim2-");
  const at = text.indexOf("@");
  const body = (at < 0 ? text.slice(PREFIX.length) : text.slice(PREFIX.length, at))
    .replace(/[\s-]/g, "")
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (!/^[0-9A-HJKMNP-TV-Z]{24}$/.test(body)) throw new Error("invalid short invite code: it must have 24 letters and digits after wim2-");
  const k = body.slice(0, K_CHARS);
  if (body.slice(K_CHARS) !== check(k)) throw new Error("invalid short invite code: the check does not match (look for a typing mistake)");
  const where = at < 0 ? undefined : text.slice(at + 1);
  const relay = where === undefined ? SHORT_CODE_RELAY : /^wss?:\/\//.test(where) ? where : `wss://${where}`;
  if (!isRelayUrl(relay)) throw new Error("invalid short invite code: the part after @ is not a relay address");
  return { k, relay };
}

/** The box's lookup id at the relay: `b64u(SHA-256(UTF-8("wim/1 rdv id " + k)))`, first 22 characters. */
export function rdvId(k: string): string {
  assertK(k, "rdvId");
  return b64u.encode(sha256(utf8(`${PROTOCOL} rdv id ${k}`))).slice(0, 22);
}

/** The box key: HKDF-SHA256 of UTF-8 `k`, empty salt, info `wim/1 rdv key`, 32 bytes. */
export function rdvKey(k: string): Uint8Array {
  assertK(k, "rdvKey");
  return hkdf(nobleSha256, utf8(k), new Uint8Array(0), utf8(`${PROTOCOL} rdv key`), 32);
}

/** The AAD of a box: UTF-8 `"wim/1 rdv " + rdv`, binding it to its lookup id. */
function rdvAad(rdv: string): Uint8Array {
  return utf8(`${PROTOCOL} rdv ${rdv}`);
}

/** The fields of a stored box, as `rdv.put` carries them and the relay's answer returns them. */
export const rdvBoxFields = {
  rdv: deviceIdSchema,
  exp: timeSchema,
  n: b64uBytes(24),
  // The tag alone is 16 bytes; a full invite code is never near the cap.
  c: b64uRange(16, LIMITS.rdvBoxBytes),
};

/** The relay's answer to `GET <relay>/v1/rdv/<rdv>`: the box, as stored. Unknown keys are ignored. */
export const rdvAnswerSchema = z.looseObject({ v: z.literal(1), ...rdvBoxFields });
export type RdvAnswer = z.infer<typeof rdvAnswerSchema>;

/**
 * Seals a full invite code for the relay: XChaCha20-Poly1305 under `rdvKey(k)` with a random
 * 24-byte nonce, AAD `wim/1 rdv <rdv>`. Throws when the code would not fit a box.
 */
export function sealRdv(k: string, fullCode: string): { rdv: string; n: string; c: string } {
  const rdv = rdvId(k);
  const plain = utf8(fullCode);
  if (plain.length === 0 || plain.length + 16 > LIMITS.rdvBoxBytes) throw new RangeError("sealRdv: the code does not fit a box");
  const nonce = randomBytes(24);
  const c = xchacha20poly1305(rdvKey(k), nonce, rdvAad(rdv)).encrypt(plain);
  return { rdv, n: b64u.encode(nonce), c: b64u.encode(c) };
}

/**
 * Opens a box fetched from the relay with the code's `k`, returning the full invite code it holds
 * (still to be read with `parseInvite`). Never throws. Reasons: `rdv_malformed`, `rdv_wrong_id`
 * (a box stored under another id), `rdv_decrypt_failed`.
 */
export function openRdv(k: string, box: unknown): Result<string> {
  assertK(k, "openRdv");
  const parsed = safeParse(rdvAnswerSchema, box);
  if (!parsed.success) return fail("rdv_malformed");
  const rdv = rdvId(k);
  if (parsed.data.rdv !== rdv) return fail("rdv_wrong_id");
  try {
    const plain = xchacha20poly1305(rdvKey(k), b64u.decode(parsed.data.n), rdvAad(rdv)).decrypt(b64u.decode(parsed.data.c));
    return ok(fromUtf8(plain));
  } catch {
    return fail("rdv_decrypt_failed");
  }
}
