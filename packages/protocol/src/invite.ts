import { hmac } from "@noble/hashes/hmac.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import { b64u, bytesEqual, canonBytes, fromUtf8, sha256, utf8 } from "./encoding.ts";
import { deviceIdFromSignPub, randomBytes } from "./ids.ts";
import { parseJson } from "./json.ts";
import type { DeviceKeys } from "./keys.ts";
import { fail, LIMITS, ok, PROTOCOL, type Result } from "./limits.ts";
import {
  deviceRecordSchema,
  inviteIdSchema,
  joinDeviceSchema,
  meshIdSchema,
  relayUrlSchema,
  rosterRefSchema,
  secret32Schema,
  sigSchema,
  timeSchema,
  b64uBytes,
  type DeviceRecord,
  type JoinDevice,
  type RosterRef,
} from "./schema.ts";
import { signObject, verifyObject } from "./sign.ts";

const PREFIX = "wim1_";

const inviteBodySchema = z.strictObject({
  relay: relayUrlSchema,
  mesh: meshIdSchema,
  secret: secret32Schema,
  pin: rosterRefSchema,
  exp: timeSchema,
  /** Optional relay certificate pin: b64u SHA-256 of its SubjectPublicKeyInfo (SPEC section 5). */
  tls: b64uBytes(32).optional(),
});

/** A decoded invite code (SPEC section 5). */
export type InviteCode = {
  relay: string;
  mesh: string;
  secret: Uint8Array;
  pin: RosterRef;
  exp: number;
  /** The relay certificate pin, when the invite carries one. */
  tls?: string;
  /** Derived from the secret; what the relay knows the invite by. */
  inviteId: string;
};

/**
 * A relay certificate pin: `b64u(SHA-256(spkiDer))`, the 43-character form an invite's `tls` field
 * carries. `spkiDer` is the DER encoding of the certificate's SubjectPublicKeyInfo.
 */
export function spkiPin(spkiDer: Uint8Array): string {
  if (!(spkiDer instanceof Uint8Array) || spkiDer.length === 0) throw new TypeError("spkiPin: expected DER bytes");
  return b64u.encode(sha256(spkiDer));
}

/**
 * `inviteId` = `b64u(SHA-256(UTF-8("wim/1 invite " + b64u(secret))))`, first 22 characters. The
 * secret enters as its b64u text, the same form it has inside the invite code.
 */
export function inviteIdFromSecret(secret: Uint8Array): string {
  if (!(secret instanceof Uint8Array) || secret.length !== 32) {
    throw new TypeError("inviteIdFromSecret: expected a 32-byte secret");
  }
  return b64u.encode(sha256(utf8(`${PROTOCOL} invite ${b64u.encode(secret)}`))).slice(0, 22);
}

/**
 * Makes a one-time invite code. `exp` defaults to one hour after `now` and may be at most seven
 * days after it. Only `inviteId` and `exp` are ever sent to the relay; the caller keeps the secret
 * until the invite is used or expires, then deletes it.
 */
export function createInvite(opts: {
  relay: string;
  mesh: string;
  pin: RosterRef;
  exp?: number;
  now?: number;
  /** A relay certificate pin from `spkiPin`, for a relay without a CA-issued certificate. */
  tls?: string;
}): { code: string; secret: Uint8Array; inviteId: string; exp: number } {
  const now = opts.now ?? Date.now();
  const exp = opts.exp ?? now + LIMITS.inviteDefaultTtlMs;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(exp) || exp <= now) {
    throw new RangeError("createInvite: exp must be an integer time after now");
  }
  if (exp - now > LIMITS.inviteMaxTtlMs) throw new RangeError("createInvite: exp is more than 7 days away");
  const secret = randomBytes(32);
  const body = { relay: opts.relay, mesh: opts.mesh, secret: b64u.encode(secret), pin: opts.pin, exp, tls: opts.tls };
  const parsed = inviteBodySchema.safeParse(body);
  if (!parsed.success) throw new TypeError(`createInvite: ${describe(parsed.error)}`);
  return { code: PREFIX + b64u.encode(canonBytes(body)), secret, inviteId: inviteIdFromSecret(secret), exp };
}

function describe(error: z.ZodError): string {
  const issue = error.issues[0]!;
  return `${issue.path.join(".") || "invite"}: ${issue.message}`;
}

/**
 * Decodes an invite code. Throws an Error with a readable message on any malformed code. Expiry
 * is not checked here: the relay and the admin client enforce it.
 */
export function parseInvite(code: string): InviteCode {
  // Codes are pasted by people, so surrounding whitespace is forgiven.
  const text = typeof code === "string" ? code.trim() : "";
  if (!text.startsWith(PREFIX)) throw new Error("invalid invite code: it must start with wim1_");
  let json: string;
  try {
    json = fromUtf8(b64u.decode(text.slice(PREFIX.length)));
  } catch {
    throw new Error("invalid invite code: it is damaged or incomplete");
  }
  const body = parseJson(json);
  if (!body.ok) throw new Error("invalid invite code: it is damaged or incomplete");
  const parsed = inviteBodySchema.safeParse(body.value);
  if (!parsed.success) throw new Error(`invalid invite code: ${describe(parsed.error)}`);
  const secret = b64u.decode(parsed.data.secret);
  return { ...parsed.data, secret, inviteId: inviteIdFromSecret(secret) };
}

/** The four public fields of a device, whether given a join record or a full roster record. */
function joinFields(device: JoinDevice | DeviceRecord): JoinDevice {
  return { id: device.id, name: device.name, sign: device.sign, box: device.box };
}

/** `b64u(HMAC-SHA256(secret, canon({ id, name, sign, box })))`: the joiner holds the secret. */
export function joinProof(secret: Uint8Array, device: JoinDevice | DeviceRecord): string {
  return b64u.encode(hmac(nobleSha256, secret, canonBytes(joinFields(device))));
}

/** Checks a join proof in constant time. Never throws. */
export function verifyJoinProof(secret: Uint8Array, device: JoinDevice | DeviceRecord, proof: string): boolean {
  try {
    return bytesEqual(hmac(nobleSha256, secret, canonBytes(joinFields(device))), b64u.decode(proof));
  } catch {
    return false;
  }
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Short authentication string for a joining device, shown on both the joiner and the admin so a
 * person can confirm they are the same device: the first 50 bits of
 * `SHA-256(UTF-8("wim/1 sas ") || canonBytes({ id, name, sign, box }))` as 10 Crockford base32
 * characters, formatted `XXXXX-XXXXX`.
 */
export function sasFor(device: JoinDevice | DeviceRecord): string {
  const label = utf8(`${PROTOCOL} sas `);
  const body = canonBytes(joinFields(device));
  const input = new Uint8Array(label.length + body.length);
  input.set(label);
  input.set(body, label.length);
  const h = sha256(input);
  let bits = 0n;
  // 56 bits read, the top 50 used.
  for (const b of h.subarray(0, 7)) bits = (bits << 8n) | BigInt(b);
  bits >>= 6n;
  let out = "";
  for (let i = 0; i < 10; i++) out = CROCKFORD[Number((bits >> BigInt(5 * i)) & 31n)]! + out;
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** The body of a `join` frame (and of `join.request`). */
export const joinBodySchema = z.strictObject({
  mesh: meshIdSchema,
  invite: inviteIdSchema,
  device: joinDeviceSchema,
  /** The `hello` nonce of the connection the join is sent on; signed, so a join cannot be replayed. */
  nonce: secret32Schema,
  proof: b64uBytes(32),
  sig: sigSchema,
});
export type JoinBody = z.infer<typeof joinBodySchema>;

// verifyJoin takes either a whole `join` frame or the body a `join.request` carries.
const joinOrBodySchema = joinBodySchema.extend({ t: z.literal("join").optional() });

/**
 * Builds a joiner's `join` frame: its four-field device record, the connection's `hello` nonce,
 * the invite proof, and a signature with its own key over
 * `{ t: "join", mesh, invite, device, nonce }` (proof of possession, bound to this connection).
 * A re-sent join on a new connection is built again with that connection's nonce.
 */
export function createJoin(invite: InviteCode, name: string, keys: DeviceKeys, nonce: string): JoinBody & { t: "join" } {
  const device = {
    id: deviceIdFromSignPub(keys.signPub),
    name,
    sign: b64u.encode(keys.signPub),
    box: b64u.encode(keys.boxPub),
  };
  if (!joinDeviceSchema.safeParse(device).success) throw new TypeError("createJoin: invalid device name");
  if (device.name.startsWith("recovery")) throw new TypeError("createJoin: names starting with recovery are reserved");
  if (!secret32Schema.safeParse(nonce).success) throw new TypeError("createJoin: nonce must be the 32-byte hello nonce");
  const body = { t: "join" as const, mesh: invite.mesh, invite: invite.inviteId, device, nonce };
  const signed = signObject("join", body, keys.signSec);
  return { ...signed, proof: joinProof(invite.secret, device) };
}

/**
 * Verifies a `join` frame or a `join.request` body. Every check confirms shape, that the device id
 * derives from its signing key, and the possession signature (which covers the nonce). The relay
 * passes its `hello` nonce for this connection as `nonce`; the admin passes the invite `secret` to
 * verify the proof too. Never throws. Reasons: `join_malformed`, `join_reserved_name`,
 * `join_wrong_nonce`, `join_bad_device_id`, `join_bad_signature`, `join_bad_proof`.
 */
export function verifyJoin(join: unknown, secret?: Uint8Array, nonce?: string): Result<JoinBody> {
  const parsed = joinOrBodySchema.safeParse(join);
  if (!parsed.success) return fail("join_malformed");
  const { t: _t, ...j } = parsed.data;
  // Recovery records are made by an admin, never by joining (SPEC section 4a).
  if (j.device.name.startsWith("recovery")) return fail("join_reserved_name");
  if (nonce !== undefined && j.nonce !== nonce) return fail("join_wrong_nonce");
  const signPub = b64u.decode(j.device.sign);
  if (deviceIdFromSignPub(signPub) !== j.device.id) return fail("join_bad_device_id");
  const signed = { t: "join", mesh: j.mesh, invite: j.invite, device: j.device, nonce: j.nonce, sig: j.sig };
  if (!verifyObject("join", signed, signPub)) return fail("join_bad_signature");
  if (secret !== undefined && !verifyJoinProof(secret, j.device, j.proof)) return fail("join_bad_proof");
  return ok(j);
}

/** The roster record an admin adds for an accepted joiner: role `member`, added at `now`. */
export function admitJoin(device: JoinDevice, now: number): DeviceRecord {
  const record = { ...joinFields(device), role: "member" as const, added: now };
  const parsed = deviceRecordSchema.safeParse(record);
  if (!parsed.success || record.name.startsWith("recovery")) throw new TypeError("admitJoin: invalid device, reserved name or bad time");
  return record;
}
