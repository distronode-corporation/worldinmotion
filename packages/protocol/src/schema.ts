import { z } from "zod";
import { b64u } from "./encoding.ts";
import { ADDRESS_RE, isId22, isName, isUlid, ROOM_RE } from "./ids.ts";
import { LIMITS } from "./limits.ts";

function decodes(s: string, length?: number): boolean {
  try {
    const bytes = b64u.decode(s);
    return length === undefined || bytes.length === length;
  } catch {
    return false;
  }
}

/** Canonical b64u text of exactly `n` bytes. */
export const b64uBytes = (n: number) =>
  z
    .string()
    .length(Math.ceil((n * 4) / 3))
    .refine((s) => decodes(s, n), { message: `expected ${n} bytes of base64url` });

/** Canonical b64u text of `minBytes` to `maxBytes` bytes. */
export const b64uRange = (minBytes: number, maxBytes: number) =>
  z
    .string()
    .min(Math.ceil((minBytes * 4) / 3))
    .max(Math.ceil((maxBytes * 4) / 3))
    .refine((s) => decodes(s), { message: "expected base64url" });

export const nameSchema = z.string().refine(isName, { message: "expected a name: 1 to 32 of [a-z0-9-]" });
export const ulidSchema = z.string().refine(isUlid, { message: "expected a ULID" });
export const deviceIdSchema = z.string().refine(isId22, { message: "expected a 22-character id" });
export const inviteIdSchema = deviceIdSchema;
export const meshIdSchema = b64uBytes(16);
export const hashSchema = b64uBytes(32);
export const keySchema = b64uBytes(32);
export const sigSchema = b64uBytes(64);
/** A 32-byte secret, such as an auth nonce or a session resume secret. */
export const secret32Schema = b64uBytes(32);
/** Milliseconds since the Unix epoch. */
export const timeSchema = z.int().min(0);
/** Counters that start at 1. */
export const seqSchema = z.int().min(1);
/** Queue cursors, where 0 means nothing acknowledged yet. */
export const cursorSchema = z.int().min(0);

/** `name@device`. */
export const sessionAddressSchema = z.string().regex(ADDRESS_RE, { message: "expected name@device" });
/** `#name`: a room (SPEC section 13). */
export const roomSchema = z.string().regex(ROOM_RE, { message: "expected #name" });
/** `name@device`, `#room`, or `*` (every other session in the mesh). */
export const addressSchema = z.union([z.literal("*"), sessionAddressSchema, roomSchema]);

/** True for a room address: `#` followed by a name. */
export function isRoom(address: unknown): address is string {
  return typeof address === "string" && ROOM_RE.test(address);
}

/** The name of a room address, without the `#`. Throws for anything that is not a room. */
export function roomName(address: string): string {
  if (!isRoom(address)) throw new TypeError("roomName: not a room address");
  return address.slice(1);
}
export const toSchema = z.array(addressSchema).min(1).max(LIMITS.sessionsPerMesh);

const LOOPBACK_HOST = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/;

/**
 * A relay base URL as written in an invite or configuration (SPEC section 8). It is signed and
 * compared byte for byte, so it is never normalised; instead only one spelling is accepted:
 * `wss://host[:port][/path]` with no trailing slash, query, fragment or credentials. `ws://` is
 * allowed only to a loopback host, for local development.
 */
export function isRelayUrl(s: unknown): s is string {
  if (typeof s !== "string" || s.length > 2048) return false;
  if (!/^wss?:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/.test(s) || s.endsWith("/")) return false;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return false;
  }
  return url.protocol === "wss:" || LOOPBACK_HOST.test(url.hostname);
}

/** A mesh id: 16 bytes of canonical base64url. */
export function isMeshId(s: unknown): s is string {
  return meshIdSchema.safeParse(s).success;
}

/** The URL a client dials for a mesh: `<relay>/v1/<mesh id>`. */
export function relayDialUrl(relay: string, meshId: string): string {
  if (!isRelayUrl(relay)) throw new TypeError("relayDialUrl: invalid relay URL");
  if (!isMeshId(meshId)) throw new TypeError("relayDialUrl: invalid mesh id");
  return `${relay}/v1/${meshId}`;
}

export const relayUrlSchema = z.string().refine(isRelayUrl, {
  message: "expected a wss:// URL (ws:// only to loopback) without a trailing slash",
});

export const fromSchema = z.strictObject({ device: deviceIdSchema, session: nameSchema, sid: ulidSchema });

/** A reference to one roster version: its seq and its hash. */
export const rosterRefSchema = z.strictObject({ seq: seqSchema, hash: hashSchema });

/** The public part of a device that a joiner sends (SPEC section 5). */
export const joinDeviceSchema = z.strictObject({
  id: deviceIdSchema,
  name: nameSchema,
  sign: keySchema,
  box: keySchema,
});

export const deviceRecordSchema = z.strictObject({
  id: deviceIdSchema,
  name: nameSchema,
  sign: keySchema,
  box: keySchema,
  role: z.enum(["admin", "member"]),
  added: timeSchema,
});

export const rosterSchema = z.strictObject({
  mesh: meshIdSchema,
  seq: seqSchema,
  prev: hashSchema.nullable(),
  devices: z.array(deviceRecordSchema),
  revoked: z.array(deviceIdSchema),
  by: deviceIdSchema,
  at: timeSchema,
  sig: sigSchema,
});

/** A device in a roster (SPEC section 4). */
export type DeviceRecord = z.infer<typeof deviceRecordSchema>;
/** The four public fields a joining device sends. */
export type JoinDevice = z.infer<typeof joinDeviceSchema>;
/** A signed roster version (SPEC section 4). */
export type Roster = z.infer<typeof rosterSchema>;
/** `{ seq, hash }` of a roster. */
export type RosterRef = z.infer<typeof rosterRefSchema>;
/** Sender of a message. */
export type From = z.infer<typeof fromSchema>;
