import { z } from "zod";
import { fitsUtf8 } from "./encoding.ts";
import { blobChunkFields } from "./blob.ts";
import { joinBodySchema } from "./invite.ts";
import { parseJson } from "./json.ts";
import { fail, LIMITS, ok, WIRE_VERSION, type Result } from "./limits.ts";
import {
  addressSchema,
  b64uBytes,
  b64uRange,
  cursorSchema,
  deviceIdSchema,
  fromSchema,
  inviteIdSchema,
  meshIdSchema,
  nameSchema,
  relayUrlSchema,
  rosterRefSchema,
  roomSchema,
  rosterSchema,
  secret32Schema,
  seqSchema,
  sessionAddressSchema,
  sigSchema,
  timeSchema,
  toSchema,
  ulidSchema,
} from "./schema.ts";

/*
 * Strictness policy.
 *
 * Client frames (parsed by the relay) are strict objects: an unknown key is refused. The relay
 * forwards signed objects byte for byte, so it must neither strip a key (the signature would
 * break) nor pass along fields it does not understand; new fields arrive with a new wire version.
 *
 * Relay frames (parsed by clients) are loose at the top level and in relay-authored rows (peers,
 * send results): unknown keys are kept and ignored, so a newer relay can add fields without
 * breaking older clients. Signed objects nested in relay frames (rosters, delivered messages) stay
 * strict, because their signatures cover every key and a stray key means tampering.
 */

// `kind` is a free label, but in the name alphabet so it cannot carry markup or controls.
const kindSchema = nameSchema;
const nonceSchema = secret32Schema;

// ---- shared pieces ----

export const boxSchema = z.strictObject({
  n: b64uBytes(24),
  // At least the 16-byte Poly1305 tag; at most what a frame can carry.
  c: b64uRange(16, LIMITS.frameBytes),
});

export const sendFrameSchema = z.strictObject({
  t: z.literal("send"),
  mesh: meshIdSchema,
  id: ulidSchema,
  from: fromSchema,
  to: toSchema,
  /** From 1 per session for messages; 0 for cards, which have their own seq space. */
  seq: cursorSchema,
  at: timeSchema,
  /** The sender's newest verified roster when it sent. */
  roster: rosterRefSchema,
  boxes: z.record(deviceIdSchema, boxSchema).refine((b) => Object.keys(b).length > 0, {
    message: "at least one box",
  }),
  sig: sigSchema,
});

const receiptFields = {
  t: z.literal("receipt"),
  id: ulidSchema,
  to: sessionAddressSchema,
  status: z.enum(["delivered", "held", "refused", "expired"]),
};


// ---- client frames ----

export const authFrameSchema = z.strictObject({
  t: z.literal("auth"),
  v: z.literal(WIRE_VERSION),
  relay: relayUrlSchema,
  mesh: meshIdSchema,
  device: deviceIdSchema,
  nonce: nonceSchema,
  at: timeSchema,
  session: z.strictObject({
    name: nameSchema,
    kind: kindSchema,
    sid: ulidSchema,
    /** A secret kept with the agent's state; its hash proves a later claim on this name and queue. */
    resume: secret32Schema,
  }),
  resume: z.strictObject({ cursor: cursorSchema }).optional(),
  /** The client's newest verified roster. */
  pin: rosterRefSchema,
  sig: sigSchema,
});

/**
 * The `auth` a recovery record sends to recover a mesh (SPEC section 4a): no session, no resume,
 * and a pin on the genesis roster. The relay then allows only `roster.get` and one
 * `roster.publish` on the connection.
 */
export const recoverAuthFrameSchema = z.strictObject({
  t: z.literal("auth"),
  v: z.literal(WIRE_VERSION),
  purpose: z.literal("recover"),
  relay: relayUrlSchema,
  mesh: meshIdSchema,
  device: deviceIdSchema,
  nonce: nonceSchema,
  at: timeSchema,
  pin: z.strictObject({ seq: z.literal(1), hash: rosterRefSchema.shape.hash }),
  sig: sigSchema,
});

export const ackFrameSchema = z.strictObject({ t: z.literal("ack"), cursor: cursorSchema });
export const receiptFrameSchema = z.strictObject(receiptFields);
export const presenceFrameSchema = z.strictObject({ t: z.literal("presence"), status: z.enum(["busy", "idle"]) });
export const peersRequestFrameSchema = z.strictObject({ t: z.literal("peers") });
export const renameFrameSchema = z.strictObject({ t: z.literal("rename"), name: nameSchema });
export const notifyIdleFrameSchema = z.strictObject({ t: z.literal("notify_idle"), of: sessionAddressSchema });
export const inviteCreateFrameSchema = z.strictObject({
  t: z.literal("invite.create"),
  invite: inviteIdSchema,
  exp: timeSchema,
  /** The admin's newest roster when it made the invite; `joined` starts its chain here. */
  pin: rosterRefSchema.optional(),
});
export const rosterPublishFrameSchema = z.strictObject({ t: z.literal("roster.publish"), roster: rosterSchema });
export const pingFrameSchema = z.strictObject({ t: z.literal("ping") });
export const byeFrameSchema = z.strictObject({ t: z.literal("bye"), ended: z.boolean() });
export const rosterGetFrameSchema = z.strictObject({ t: z.literal("roster.get"), from: seqSchema });
/** Evidence of a fork: two different rosters with the same mesh and seq. */
export const rosterForkFrameSchema = z.strictObject({ t: z.literal("roster.fork"), a: rosterSchema, b: rosterSchema });
// Rooms (SPEC section 13).
export const roomJoinFrameSchema = z.strictObject({ t: z.literal("room.join"), room: roomSchema });
export const roomLeaveFrameSchema = z.strictObject({ t: z.literal("room.leave"), room: roomSchema });
export const roomHistoryRequestFrameSchema = z.strictObject({
  t: z.literal("room.history"),
  room: roomSchema,
  before: cursorSchema.optional(),
  limit: z.int().min(1).max(LIMITS.roomHistoryPageMax).optional(),
});

// Leases (SPEC section 14).
const leaseKeySchema = deviceIdSchema;
const leaseTokenSchema = z.int().min(1);
const leaseTtlSchema = z.int().min(LIMITS.leaseTtlMinMs).max(LIMITS.leaseTtlMaxMs);
export const leaseAcquireFrameSchema = z.strictObject({
  t: z.literal("lease.acquire"),
  key: leaseKeySchema,
  ttl: leaseTtlSchema,
  wait: z.boolean().optional(),
});
export const leaseRenewFrameSchema = z.strictObject({
  t: z.literal("lease.renew"),
  key: leaseKeySchema,
  token: leaseTokenSchema,
  ttl: leaseTtlSchema,
});
export const leaseReleaseFrameSchema = z.strictObject({ t: z.literal("lease.release"), key: leaseKeySchema, token: leaseTokenSchema });
export const leaseListFrameSchema = z.strictObject({ t: z.literal("lease.list") });
export const leaseWatchFrameSchema = z.strictObject({ t: z.literal("lease.watch"), key: leaseKeySchema });

// Blobs (SPEC section 15).
export const blobPutFrameSchema = z.strictObject({ t: z.literal("blob.put"), ...blobChunkFields });
export const blobGetFrameSchema = z.strictObject({ t: z.literal("blob.get"), blob: blobChunkFields.blob, index: blobChunkFields.index });

// Peer cards (SPEC section 17): the newest card per session, never delivered as a message.
export const cardSetFrameSchema = z.strictObject({ t: z.literal("card.set"), msg: sendFrameSchema });
/** Asks for the next `cards` page, after the session id that ended the previous one. */
export const cardsGetFrameSchema = z.strictObject({ t: z.literal("cards.get"), after: ulidSchema.optional() });

export const createFrameSchema = z.strictObject({
  t: z.literal("create"),
  roster: rosterSchema,
  /** Operator key, for relays that restrict mesh creation. */
  key: z.string().min(1).max(512).optional(),
});
export const joinFrameSchema = z.strictObject({ t: z.literal("join"), ...joinBodySchema.shape });

const clientSchemas = {
  auth: authFrameSchema,
  send: sendFrameSchema,
  ack: ackFrameSchema,
  receipt: receiptFrameSchema,
  presence: presenceFrameSchema,
  peers: peersRequestFrameSchema,
  rename: renameFrameSchema,
  notify_idle: notifyIdleFrameSchema,
  "invite.create": inviteCreateFrameSchema,
  "roster.publish": rosterPublishFrameSchema,
  "roster.get": rosterGetFrameSchema,
  "roster.fork": rosterForkFrameSchema,
  "room.join": roomJoinFrameSchema,
  "room.leave": roomLeaveFrameSchema,
  "room.history": roomHistoryRequestFrameSchema,
  "lease.acquire": leaseAcquireFrameSchema,
  "lease.renew": leaseRenewFrameSchema,
  "lease.release": leaseReleaseFrameSchema,
  "lease.list": leaseListFrameSchema,
  "lease.watch": leaseWatchFrameSchema,
  "blob.put": blobPutFrameSchema,
  "blob.get": blobGetFrameSchema,
  "card.set": cardSetFrameSchema,
  "cards.get": cardsGetFrameSchema,
  ping: pingFrameSchema,
  bye: byeFrameSchema,
  create: createFrameSchema,
  join: joinFrameSchema,
} as const;

export const clientFrameSchema = z.discriminatedUnion("t", [
  authFrameSchema,
  sendFrameSchema,
  ackFrameSchema,
  receiptFrameSchema,
  presenceFrameSchema,
  peersRequestFrameSchema,
  renameFrameSchema,
  notifyIdleFrameSchema,
  inviteCreateFrameSchema,
  rosterPublishFrameSchema,
  rosterGetFrameSchema,
  rosterForkFrameSchema,
  roomJoinFrameSchema,
  roomLeaveFrameSchema,
  roomHistoryRequestFrameSchema,
  leaseAcquireFrameSchema,
  leaseRenewFrameSchema,
  leaseReleaseFrameSchema,
  leaseListFrameSchema,
  leaseWatchFrameSchema,
  blobPutFrameSchema,
  blobGetFrameSchema,
  cardSetFrameSchema,
  cardsGetFrameSchema,
  pingFrameSchema,
  byeFrameSchema,
  createFrameSchema,
  joinFrameSchema,
]);

// ---- relay frames ----

export const peerSchema = z.looseObject({
  address: sessionAddressSchema,
  /** The session id, also visible to recipients as `from.sid`; matches a session to its card. */
  sid: ulidSchema.optional(),
  kind: kindSchema,
  status: z.enum(["idle", "busy", "offline"]),
  since: timeSchema,
  rooms: z.array(roomSchema).max(LIMITS.roomsPerSession),
});

export const helloFrameSchema = z.looseObject({
  t: z.literal("hello"),
  v: z.literal(WIRE_VERSION),
  nonce: nonceSchema,
  at: timeSchema,
});
export const readyFrameSchema = z.looseObject({
  t: z.literal("ready"),
  sid: ulidSchema,
  name: nameSchema,
  cursor: cursorSchema,
  /** The newest roster. */
  roster: rosterSchema,
  /** True when rosters exist between the client's pin and `roster`; walk them with `roster.get`. */
  more: z.boolean(),
  peers: z.array(peerSchema),
});
export const sentFrameSchema = z.looseObject({
  t: z.literal("sent"),
  id: ulidSchema,
  results: z.array(
    z.looseObject({
      to: addressSchema,
      status: z.enum(["routed", "queued", "unknown", "ended", "full", "limited", "invalid"]),
    }),
  ),
});
export const deliverFrameSchema = z.looseObject({ t: z.literal("deliver"), cursor: seqSchema, msg: sendFrameSchema });
export const relayReceiptFrameSchema = z.looseObject(receiptFields);
export const peersFrameSchema = z.looseObject({ t: z.literal("peers"), peers: z.array(peerSchema) });
export const peerFrameSchema = z.looseObject({ t: z.literal("peer"), peer: peerSchema });
export const noticeFrameSchema = z.looseObject({
  t: z.literal("notice"),
  kind: z.literal("idle"),
  of: sessionAddressSchema,
});
/** One page of a roster chain, oldest first, at most 64 rosters. */
const chainPage = z.array(rosterSchema).min(1).max(LIMITS.rosterPageMax);
/** A page of rosters: an answer to `roster.get`, or a new roster pushed to every session. */
export const rosterFrameSchema = z.looseObject({ t: z.literal("roster"), chain: chainPage, more: z.boolean() });
export const joinRequestFrameSchema = z.looseObject({ t: z.literal("join.request"), join: joinBodySchema });
export const joinedFrameSchema = z.looseObject({ t: z.literal("joined"), chain: chainPage, more: z.boolean() });
export const errorFrameSchema = z.looseObject({
  t: z.literal("error"),
  code: z.string().min(1).max(64),
  message: z.string().max(4096),
  /** What the error refers to: a message id or the `t` of the refused frame. */
  ref: z.string().max(128).optional(),
});
export const pongFrameSchema = z.looseObject({ t: z.literal("pong") });
/** The relay's answer to a verified recovery `auth` (SPEC section 4a): the newest roster. */
export const recoverReadyFrameSchema = z.looseObject({ t: z.literal("recover.ready"), roster: rosterSchema });
/** The relay's answer to `invite.create`. */
export const inviteCreatedFrameSchema = z.looseObject({ t: z.literal("invite.created"), invite: inviteIdSchema });

export const roomJoinedFrameSchema = z.looseObject({
  t: z.literal("room.joined"),
  room: roomSchema,
  members: z.array(sessionAddressSchema).max(LIMITS.sessionsPerMesh),
});
export const roomHistoryFrameSchema = z.looseObject({
  t: z.literal("room.history"),
  room: roomSchema,
  msgs: z.array(z.looseObject({ cursor: seqSchema, msg: sendFrameSchema })).max(LIMITS.roomHistoryPageMax),
  more: z.boolean(),
});
export const leaseFrameSchema = z.looseObject({
  t: z.literal("lease"),
  key: leaseKeySchema,
  status: z.enum(["granted", "held", "released", "expired", "renewed", "refused"]),
  holder: sessionAddressSchema.optional(),
  until: timeSchema.optional(),
  /** Fencing token: a per-key counter the relay increments on every grant. */
  token: leaseTokenSchema.optional(),
});
export const leasesFrameSchema = z.looseObject({
  t: z.literal("leases"),
  leases: z
    .array(z.looseObject({ key: leaseKeySchema, holder: sessionAddressSchema, until: timeSchema, token: leaseTokenSchema }))
    .max(LIMITS.leasesPerMesh),
});
export const blobStoredFrameSchema = z.looseObject({
  t: z.literal("blob.stored"),
  blob: blobChunkFields.blob,
  index: blobChunkFields.index,
});
export const blobChunkFrameSchema = z.looseObject({ t: z.literal("blob.chunk"), ...blobChunkFields });
export const cardsFrameSchema = z.looseObject({
  t: z.literal("cards"),
  cards: z.array(sendFrameSchema).max(LIMITS.sessionsPerMesh),
  /** True when another page follows; ask for it with `cards.get`. Absent means false. */
  more: z.boolean().optional(),
});
export const cardFrameSchema = z.looseObject({ t: z.literal("card"), msg: sendFrameSchema });

const relaySchemas = {
  hello: helloFrameSchema,
  ready: readyFrameSchema,
  sent: sentFrameSchema,
  deliver: deliverFrameSchema,
  receipt: relayReceiptFrameSchema,
  peers: peersFrameSchema,
  peer: peerFrameSchema,
  notice: noticeFrameSchema,
  roster: rosterFrameSchema,
  "join.request": joinRequestFrameSchema,
  joined: joinedFrameSchema,
  error: errorFrameSchema,
  pong: pongFrameSchema,
  "invite.created": inviteCreatedFrameSchema,
  "recover.ready": recoverReadyFrameSchema,
  "room.joined": roomJoinedFrameSchema,
  "room.history": roomHistoryFrameSchema,
  lease: leaseFrameSchema,
  leases: leasesFrameSchema,
  "blob.stored": blobStoredFrameSchema,
  "blob.chunk": blobChunkFrameSchema,
  cards: cardsFrameSchema,
  card: cardFrameSchema,
} as const;

export const relayFrameSchema = z.discriminatedUnion("t", [
  helloFrameSchema,
  readyFrameSchema,
  sentFrameSchema,
  deliverFrameSchema,
  relayReceiptFrameSchema,
  peersFrameSchema,
  peerFrameSchema,
  noticeFrameSchema,
  rosterFrameSchema,
  joinRequestFrameSchema,
  joinedFrameSchema,
  errorFrameSchema,
  pongFrameSchema,
  inviteCreatedFrameSchema,
  recoverReadyFrameSchema,
  roomJoinedFrameSchema,
  roomHistoryFrameSchema,
  leaseFrameSchema,
  leasesFrameSchema,
  blobStoredFrameSchema,
  blobChunkFrameSchema,
  cardsFrameSchema,
  cardFrameSchema,
]);

// ---- types ----

export type Box = z.infer<typeof boxSchema>;
export type SendFrame = z.infer<typeof sendFrameSchema>;
export type AuthFrame = z.infer<typeof authFrameSchema>;
export type AckFrame = z.infer<typeof ackFrameSchema>;
export type ReceiptFrame = z.infer<typeof receiptFrameSchema>;
export type PresenceFrame = z.infer<typeof presenceFrameSchema>;
export type PeersRequestFrame = z.infer<typeof peersRequestFrameSchema>;
export type RenameFrame = z.infer<typeof renameFrameSchema>;
export type NotifyIdleFrame = z.infer<typeof notifyIdleFrameSchema>;
export type InviteCreateFrame = z.infer<typeof inviteCreateFrameSchema>;
export type RosterPublishFrame = z.infer<typeof rosterPublishFrameSchema>;
export type RosterGetFrame = z.infer<typeof rosterGetFrameSchema>;
export type RosterForkFrame = z.infer<typeof rosterForkFrameSchema>;
export type PingFrame = z.infer<typeof pingFrameSchema>;
export type ByeFrame = z.infer<typeof byeFrameSchema>;
export type CreateFrame = z.infer<typeof createFrameSchema>;
export type RoomJoinFrame = z.infer<typeof roomJoinFrameSchema>;
export type RoomLeaveFrame = z.infer<typeof roomLeaveFrameSchema>;
export type RoomHistoryRequestFrame = z.infer<typeof roomHistoryRequestFrameSchema>;
export type LeaseAcquireFrame = z.infer<typeof leaseAcquireFrameSchema>;
export type LeaseRenewFrame = z.infer<typeof leaseRenewFrameSchema>;
export type LeaseReleaseFrame = z.infer<typeof leaseReleaseFrameSchema>;
export type LeaseListFrame = z.infer<typeof leaseListFrameSchema>;
export type LeaseWatchFrame = z.infer<typeof leaseWatchFrameSchema>;
export type BlobPutFrame = z.infer<typeof blobPutFrameSchema>;
export type BlobGetFrame = z.infer<typeof blobGetFrameSchema>;
export type CardSetFrame = z.infer<typeof cardSetFrameSchema>;
export type CardsGetFrame = z.infer<typeof cardsGetFrameSchema>;
export type JoinFrame = z.infer<typeof joinFrameSchema>;
export type ClientFrame = z.infer<typeof clientFrameSchema>;
export type RecoverAuthFrame = z.infer<typeof recoverAuthFrameSchema>;

export type Peer = z.infer<typeof peerSchema>;
export type HelloFrame = z.infer<typeof helloFrameSchema>;
export type ReadyFrame = z.infer<typeof readyFrameSchema>;
export type SentFrame = z.infer<typeof sentFrameSchema>;
export type SendResult = SentFrame["results"][number];
export type DeliverFrame = z.infer<typeof deliverFrameSchema>;
export type RelayReceiptFrame = z.infer<typeof relayReceiptFrameSchema>;
export type PeersFrame = z.infer<typeof peersFrameSchema>;
export type PeerFrame = z.infer<typeof peerFrameSchema>;
export type NoticeFrame = z.infer<typeof noticeFrameSchema>;
export type RosterFrame = z.infer<typeof rosterFrameSchema>;
export type JoinRequestFrame = z.infer<typeof joinRequestFrameSchema>;
export type JoinedFrame = z.infer<typeof joinedFrameSchema>;
export type ErrorFrame = z.infer<typeof errorFrameSchema>;
export type PongFrame = z.infer<typeof pongFrameSchema>;
export type InviteCreatedFrame = z.infer<typeof inviteCreatedFrameSchema>;
export type RecoverReadyFrame = z.infer<typeof recoverReadyFrameSchema>;
export type RoomJoinedFrame = z.infer<typeof roomJoinedFrameSchema>;
export type RoomHistoryFrame = z.infer<typeof roomHistoryFrameSchema>;
export type LeaseFrame = z.infer<typeof leaseFrameSchema>;
export type LeasesFrame = z.infer<typeof leasesFrameSchema>;
export type BlobStoredFrame = z.infer<typeof blobStoredFrameSchema>;
export type BlobChunkFrame = z.infer<typeof blobChunkFrameSchema>;
export type CardsFrame = z.infer<typeof cardsFrameSchema>;
export type CardFrame = z.infer<typeof cardFrameSchema>;
export type RelayFrame = z.infer<typeof relayFrameSchema>;

// ---- parsing ----

function parseWith<T>(text: unknown, schemas: Record<string, z.ZodType>, maxBytes: number): Result<T> {
  if (typeof text !== "string") return fail("not_text");
  if (!fitsUtf8(text, maxBytes)) return fail("too_large");
  const json = parseJson(text);
  if (!json.ok) return json;
  const value = json.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("malformed");
  const t: unknown = (value as Record<string, unknown>)["t"];
  if (typeof t !== "string") return fail("malformed");
  const schema = Object.hasOwn(schemas, t) ? schemas[t] : undefined;
  if (schema === undefined) return fail("unknown_type");
  // Card frames have their own, smaller limit (SPEC section 17).
  if ((t === "card.set" || t === "card") && !fitsUtf8(text, LIMITS.cardFrameBytes)) return fail("too_large");
  const parsed = schema.safeParse(value);
  return parsed.success ? ok(parsed.data as T) : fail("malformed");
}

const preAuthSchemas = { auth: authFrameSchema, join: joinFrameSchema, create: createFrameSchema } as const;

/**
 * Parses a frame a client sent. Never throws. Reasons: `not_text`, `too_large`, `not_json`,
 * `duplicate_key`, `unknown_type` (answer with an `error`, SPEC section 8) and `malformed`.
 * With `preAuth`, for a connection that has not authenticated, the limit is 16 KiB and only
 * `auth`, `join` and `create` are known types.
 */
export function parseClientFrame(text: string, opts: { preAuth?: boolean } = {}): Result<ClientFrame> {
  return opts.preAuth === true
    ? parseWith<ClientFrame>(text, preAuthSchemas, LIMITS.preAuthFrameBytes)
    : parseWith<ClientFrame>(text, clientSchemas, LIMITS.frameBytes);
}

/**
 * Parses a recovery record's `auth` (SPEC section 4a), with the pre-auth limits. It is kept apart
 * from `parseClientFrame`, whose `auth` is always a session's, so a relay never mistakes one for the
 * other: try `parseClientFrame(text, { preAuth: true })` first, and this when it fails. Never throws.
 */
export function parseRecoverAuthFrame(text: string): Result<RecoverAuthFrame> {
  return parseWith<RecoverAuthFrame>(text, { auth: recoverAuthFrameSchema }, LIMITS.preAuthFrameBytes);
}

/**
 * Parses a frame a relay sent. Never throws. Same reasons as `parseClientFrame`; the size limit
 * is a full frame plus 4 KiB for the `deliver` envelope.
 */
export function parseRelayFrame(text: string): Result<RelayFrame> {
  return parseWith<RelayFrame>(text, relaySchemas, LIMITS.receiveFrameBytes);
}
