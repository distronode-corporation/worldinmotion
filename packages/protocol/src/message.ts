import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import { findSecrets } from "./agent.ts";
import { b64u, bytesEqual, canon, canonBytes, fitsUtf8, fromUtf8, hash, sha256, utf8 } from "./encoding.ts";
import { sendFrameSchema, type Box, type SendFrame } from "./frames.ts";
import { deviceIdFromSignPub, randomBytes, ulid } from "./ids.ts";
import { parseJson } from "./json.ts";
import type { DeviceKeys } from "./keys.ts";
import { fail, LIMITS, ok, PROTOCOL, WIRE_VERSION, type Result } from "./limits.ts";
import { checkFreshness } from "./replay.ts";
import { fileSchema, type FileInfo } from "./blob.ts";
import { hpkeOpenAuth, hpkeSealAuth } from "./hpke.ts";
import { verifyPrekey, type Prekey } from "./prekey.ts";
import { fromSchema, isRoom, rosterRefSchema, timeSchema, toSchema, ulidSchema, type Roster } from "./schema.ts";
import { isRecoveryName } from "./roster.ts";
import { signObject, verifyObject } from "./sign.ts";

const textSchema = z.string().refine((s) => fitsUtf8(s, LIMITS.textBytes), { message: "text is over 256 KiB" });

/** A peer card (SPEC section 17): labels for a session's peer row, never trusted input. */
export const cardSchema = z.strictObject({
  cwd: z.string().max(512).optional(),
  branch: z.string().max(255).optional(),
  title: z.string().max(120).optional(),
});
export type Card = z.infer<typeof cardSchema>;

/** A result's status (SPEC section 12): the one list every package imports. */
export const RESULT_STATUSES = ["done", "failed", "declined", "timeout"] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

const common = {
  v: z.literal(WIRE_VERSION),
  id: ulidSchema,
  from: fromSchema,
  to: toSchema,
  at: timeSchema,
  roster: rosterRefSchema,
};

/**
 * Set when the sender did not write the text itself (SPEC section 6a): a bot's model output, CI
 * logs, an external agent's reply. Present only as `true`.
 */
const relayed = z.literal(true).optional();

/**
 * Set when the session wrote the text while handling another agent's information-only item
 * (SPEC section 6a). Receivers treat a derived item as information only. Present only as `true`.
 */
const derived = z.literal(true).optional();

/**
 * The decrypted body of a message (SPEC sections 6 and 12). `kind` exists only here, so the relay
 * never learns it, and an unknown kind is refused.
 */
export const plaintextSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ ...common, kind: z.literal("msg"), text: textSchema, reply_to: ulidSchema.optional(), relayed, derived }),
    z.strictObject({
      ...common,
      kind: z.literal("task"),
      text: textSchema,
      deadline: timeSchema.optional(),
      reply_to: ulidSchema.optional(),
      relayed,
      derived,
    }),
    z.strictObject({
      ...common,
      kind: z.literal("result"),
      text: textSchema,
      reply_to: ulidSchema,
      status: z.enum(RESULT_STATUSES),
      relayed,
      derived,
    }),
    z.strictObject({
      ...common,
      kind: z.literal("card"),
      // Never present on the wire; declared so `text` reads the same on every kind of plaintext.
      text: z.undefined().optional(),
      card: cardSchema,
      reply_to: ulidSchema.optional(),
    }),
    z.strictObject({
      ...common,
      kind: z.literal("file"),
      text: textSchema.optional(),
      file: fileSchema,
      reply_to: ulidSchema.optional(),
      relayed,
      derived,
    }),
  ])
  .refine((p) => p.kind !== "card" || (p.to.length === 1 && p.to[0] === "*"), {
    message: "a card is sent to * only",
    path: ["to"],
  })
  .refine(
    (p) => p.kind !== "task" || p.deadline === undefined || (p.deadline > p.at && p.deadline - p.at <= LIMITS.taskDeadlineMaxMs),
    { message: "deadline must be after at and at most 24 hours after it", path: ["deadline"] },
  );

export type Plaintext = z.infer<typeof plaintextSchema>;
export type MessageKind = Plaintext["kind"];

/** The header: the send object without `boxes` and `sig`. */
export type SendHeader = Omit<SendFrame, "boxes" | "sig">;

/**
 * The symmetric key for one sender device and one recipient device: HKDF-SHA256 over the X25519
 * shared secret, salted with the mesh id, labelled with both device ids in sender-to-recipient
 * order, so the two directions between a pair of devices use different keys. X25519 refuses
 * low-order public keys, which would otherwise give an all-zero, predictable shared secret.
 */
function boxKey(meshId: string, mySec: Uint8Array, theirPub: Uint8Array, senderId: string, recipientId: string) {
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
 * Every box's AAD: `H(canon(header))`, where the header is whatever the frame holds apart from
 * `boxes` and `sig`. Computed generically so a new header field can never be left out.
 */
function headerAad(frame: object): Uint8Array {
  const { boxes: _boxes, sig: _sig, ...header } = frame as Record<string, unknown>;
  return sha256(canonBytes(header));
}

/**
 * Encrypts a message to each recipient device and signs the frame. `roster` is the sender's newest
 * verified roster: it supplies the mesh id, the recipients' box keys and the roster reference the
 * header carries. `kind` defaults to `msg`; `task`, `result` and `file` take their own fields
 * (SPEC section 12). Throws, before anything is sent, when an input is malformed, a recipient is
 * not a current device, a broadcast or room send leaves a device out, the text is over 256 KiB or
 * looks like it holds a credential, or the frame would be over 1 MiB.
 *
 * `allowSecrets: true` skips the credential check. A client offers it only to a person at its own
 * command line, never to an agent or through a tool interface (SPEC section 6a).
 */
export function sealMessage(opts: {
  roster: Roster;
  sender: { deviceId: string; keys: DeviceKeys };
  session: string;
  sid: string;
  to: string[];
  seq: number;
  at: number;
  id?: string;
  kind?: MessageKind;
  /** Required for `msg`, `task` and `result`; an optional caption for `file`; absent for `card`. */
  text?: string;
  card?: Card;
  reply_to?: string;
  deadline?: number;
  status?: ResultStatus;
  file?: FileInfo;
  /**
   * Recipient device ids. A broadcast or room send must name every device in the roster except
   * recovery records, which are skipped; a recovery record named for any other send is refused.
   */
  recipients: string[];
  allowSecrets?: boolean;
  /** The text was not written by the sender (SPEC section 6a). Required when forwarding such text. */
  relayed?: boolean;
  /** Written while handling another agent's information-only item (SPEC section 6a). */
  derived?: boolean;
  /**
   * Current prekeys of recipient devices, by device id (SPEC section 6b). Each must pass
   * `verifyPrekey` at `at` for the device it is listed under, else the seal is refused. A device
   * listed here gets a scheme 2 box, sealed to its prekey with a fresh ephemeral key.
   */
  prekeys?: Readonly<Record<string, Prekey>>;
  /** The sender device's own current prekey, carried in the header as `pk` for receivers to use. */
  prekey?: Prekey;
  /**
   * The migration window (SPEC section 6b, default true): a recipient with no prekey in `prekeys`
   * gets a scheme 1 box. With `false`, a broadcast or room send skips such a device and any other
   * send that names one is refused.
   */
  legacy?: boolean;
}): SendFrame {
  const { roster, sender } = opts;
  const kind = opts.kind ?? "msg";
  if (deviceIdFromSignPub(sender.keys.signPub) !== sender.deviceId) {
    throw new TypeError("sealMessage: sender.deviceId does not match the signing key");
  }
  if (!roster.devices.some((d) => d.id === sender.deviceId)) {
    throw new TypeError("sealMessage: the sender is not a current device in the roster");
  }
  const noCaption = (kind === "file" || kind === "card") && opts.text === undefined;
  if (!noCaption && (typeof opts.text !== "string" || !fitsUtf8(opts.text, LIMITS.textBytes))) {
    throw new RangeError(`sealMessage: text must be a string of at most ${LIMITS.textBytes} UTF-8 bytes`);
  }
  const scanned = [opts.text ?? "", ...Object.values(opts.card ?? {})].join("\n");
  const secrets = opts.allowSecrets === true ? [] : findSecrets(scanned);
  if (secrets.length > 0) throw new TypeError(`sealMessage: text appears to contain a secret (${secrets.join(", ")})`);

  if (!Array.isArray(opts.recipients) || opts.recipients.length === 0) {
    throw new TypeError("sealMessage: at least one recipient device");
  }
  if (new Set(opts.recipients).size !== opts.recipients.length) throw new TypeError("sealMessage: duplicate recipient device");
  const group = Array.isArray(opts.to) && opts.to.some((a) => a === "*" || isRoom(a));
  const named = opts.recipients.map((id) => {
    const device = roster.devices.find((d) => d.id === id);
    if (!device) throw new TypeError(`sealMessage: ${String(id)} is not a current device in the roster`);
    return device;
  });
  // Recovery records never act, so they never get a box (SPEC section 4a).
  if (!group && named.some((d) => isRecoveryName(d.name))) {
    throw new TypeError("sealMessage: a recovery record cannot receive messages");
  }
  const acting = roster.devices.filter((d) => !isRecoveryName(d.name));
  if (group && named.filter((d) => !isRecoveryName(d.name)).length !== acting.length) {
    throw new TypeError("sealMessage: a broadcast or room send needs a box for every device in the roster");
  }
  const prekeys = opts.prekeys ?? {};
  for (const [deviceId, pk] of Object.entries(prekeys)) {
    const checked = verifyPrekey(pk, roster, opts.at);
    if (!checked.ok || pk.device !== deviceId) {
      throw new TypeError(`sealMessage: the prekey for ${deviceId} is not usable (${checked.ok ? "another device's" : checked.reason})`);
    }
  }
  const legacy = opts.legacy !== false;
  const keyed = (d: { id: string }): boolean => Object.hasOwn(prekeys, d.id);
  const missing = named.filter((d) => !isRecoveryName(d.name) && !keyed(d));
  if (!legacy && !group && missing.length > 0) {
    throw new TypeError(`sealMessage: no current prekey for ${missing.map((d) => d.id).join(", ")}`);
  }
  // Without the migration window, a broadcast or room send reaches every device that has a prekey.
  const recipients = named.filter((d) => !isRecoveryName(d.name) && (legacy || keyed(d)));
  if (recipients.length === 0) throw new TypeError("sealMessage: no device to seal to has a current prekey");
  if (opts.prekey !== undefined) {
    const own = verifyPrekey(opts.prekey, roster, opts.at);
    if (!own.ok || opts.prekey.device !== sender.deviceId) {
      throw new TypeError(`sealMessage: the sender's prekey is not usable (${own.ok ? "another device's" : own.reason})`);
    }
  }

  const header = {
    t: "send" as const,
    mesh: roster.mesh,
    id: opts.id ?? ulid(),
    from: { device: sender.deviceId, session: opts.session, sid: opts.sid },
    to: opts.to,
    // Cards have their own seq space: always 0, never a message seq (SPEC section 17).
    seq: kind === "card" ? 0 : opts.seq,
    at: opts.at,
    roster: { seq: roster.seq, hash: hash(roster) },
    ...(opts.prekey === undefined ? {} : { pk: opts.prekey }),
  };
  const body = dropUndefined({
    v: WIRE_VERSION,
    kind,
    id: header.id,
    from: header.from,
    to: header.to,
    at: header.at,
    roster: header.roster,
    text: opts.text,
    reply_to: opts.reply_to,
    deadline: opts.deadline,
    status: opts.status,
    file: opts.file,
    card: opts.card,
    relayed: opts.relayed === true ? true : undefined,
    derived: opts.derived === true ? true : undefined,
  });
  const checked = plaintextSchema.safeParse(body);
  if (!checked.success) {
    const issue = checked.error.issues[0]!;
    throw new TypeError(`sealMessage: ${issue.path.join(".")}: ${issue.message}`);
  }
  const plaintext = canonBytes(body);
  const aad = headerAad(header);
  const boxes: Record<string, Box> = {};
  for (const r of recipients) {
    const pk = prekeys[r.id];
    if (pk !== undefined) {
      // Scheme 2: the ephemeral secret exists only inside this call, so this device's key file,
      // stolen later, cannot reopen the box (SPEC section 6b).
      const sealed = hpkeSealAuth({ pkR: b64u.decode(pk.pub), skS: sender.keys.boxSec, info: box2Info(roster.mesh, sender.deviceId, r.id, pk.id), aad, plaintext });
      boxes[r.id] = { s: 2, p: pk.id, e: b64u.encode(sealed.enc), c: b64u.encode(sealed.ciphertext) };
      continue;
    }
    const key = boxKey(roster.mesh, sender.keys.boxSec, b64u.decode(r.box), sender.deviceId, r.id);
    const nonce = randomBytes(24);
    const c = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
    boxes[r.id] = { n: b64u.encode(nonce), c: b64u.encode(c) };
  }

  const frame = signObject("send", { ...header, boxes }, sender.keys.signSec);
  const limit = kind === "card" ? LIMITS.cardFrameBytes : LIMITS.frameBytes;
  if (!fitsUtf8(canon(frame), limit)) throw new RangeError(`sealMessage: frame would be over ${limit} bytes`);
  const parsed = sendFrameSchema.safeParse(frame);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new TypeError(`sealMessage: ${issue.path.join(".")}: ${issue.message}`);
  }
  return frame;
}

function dropUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function sameTo(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * The receiving session: its device keys, its current address, its session id and its rooms, and
 * `prekey`, which returns the secret of one of its device's prekeys by id, or undefined once the
 * device has deleted it (SPEC section 6b).
 */
export type Receiver = {
  deviceId: string;
  keys: DeviceKeys;
  address: string;
  sid: string;
  rooms?: readonly string[];
  prekey?: (id: string) => Uint8Array | undefined;
};

/**
 * Verifies and decrypts a received `send` frame for this session (SPEC section 6). `roster` is
 * the receiver's newest verified roster and `now` its clock. Checks run in this order, and each
 * failure has its own `reason`:
 *
 * - `malformed`, `wrong_mesh`, `sender_revoked`
 * - `roster_behind` for a sender this roster does not know yet, when the frame names a newer
 *   roster: fetch and verify the chain up to `frame.roster.seq`, then retry, parking the message
 *   meanwhile. Otherwise `unknown_sender`.
 * - `recovery_sender` (recovery records never send), `bad_signature`
 * - `roster_behind` for a known sender whose signature verified, and `roster_fork` (same seq,
 *   different hash, now authenticated by the sender's signature: treat the mesh as forked)
 * - `not_addressed` (no matching address, `*` or joined room), `own_broadcast` (a `*` or room
 *   send from this very session, outside history)
 * - `too_old`, `too_new` (the clock window)
 * - `no_box`; `key_expired` (a scheme 2 box for a prekey whose secret this device no longer
 *   holds: deleted on schedule, or lost); `legacy_box` (a scheme 1 box with `legacy: false`, once
 *   the migration window is closed); `decrypt_failed`, `plaintext_malformed` (including duplicate keys or bytes that are
 *   not canonical), `seq_kind_mismatch` (seq 0 is for cards only, and every card has seq 0),
 *   then `id_mismatch`, `from_mismatch`, `to_mismatch`, `at_mismatch`, `roster_mismatch`
 *
 * With `history: true` (messages from `room.history`, and peer cards) the freshness check is
 * skipped, and so is `own_broadcast`: history includes the reader's own messages (SPEC section 13).
 * The caller MUST present the result as history. Dedupe by id and `seq` tracking need state, so
 * they are the caller's (see `SeqTracker`).
 */
export function openMessage(
  frame: unknown,
  ctx: { roster: Roster; me: Receiver; now: number; history?: boolean; legacy?: boolean },
): Result<Plaintext> {
  const parsed = sendFrameSchema.safeParse(frame);
  if (!parsed.success) return fail("malformed");
  const f = parsed.data;
  const { roster, me } = ctx;
  if (f.mesh !== roster.mesh) return fail("wrong_mesh");
  if (roster.revoked.includes(f.from.device)) return fail("sender_revoked");
  const sender = roster.devices.find((d) => d.id === f.from.device);
  // An unknown sender may have joined in a roster this receiver has not seen; nothing about the
  // frame can be authenticated until then.
  if (!sender) return fail(f.roster.seq > roster.seq ? "roster_behind" : "unknown_sender");
  if (isRecoveryName(sender.name)) return fail("recovery_sender");
  // Signature first, so an unauthenticated frame can neither trigger a roster fetch nor a fork alarm.
  if (!verifyObject("send", f, b64u.decode(sender.sign))) return fail("bad_signature");
  if (f.roster.seq > roster.seq) return fail("roster_behind");
  if (f.roster.seq === roster.seq && f.roster.hash !== hash(roster)) return fail("roster_fork");

  if (!f.to.includes(me.address)) {
    const rooms = me.rooms ?? [];
    if (!f.to.some((a) => a === "*" || (isRoom(a) && rooms.includes(a)))) return fail("not_addressed");
    // Live, a session never receives its own `*` or room send; read back as history, it is part of the conversation.
    if (ctx.history !== true && f.from.device === me.deviceId && f.from.sid === me.sid) return fail("own_broadcast");
  }
  // Room history (SPEC section 13) is old by design; the caller shows it as history, not as new.
  const fresh = ctx.history === true ? ok(true) : checkFreshness(f.at, ctx.now);
  if (!fresh.ok) return fresh;

  const box: Box | undefined = Object.hasOwn(f.boxes, me.deviceId) ? f.boxes[me.deviceId] : undefined;
  if (box === undefined) return fail("no_box");

  let open: () => Uint8Array;
  if ("s" in box) {
    const secret = me.prekey?.(box.p);
    if (secret === undefined) return fail("key_expired");
    const info = box2Info(roster.mesh, sender.id, me.deviceId, box.p);
    open = () => hpkeOpenAuth({ enc: b64u.decode(box.e), skR: secret, pkS: b64u.decode(sender.box), info, aad: headerAad(f), ciphertext: b64u.decode(box.c) });
  } else {
    if (ctx.legacy === false) return fail("legacy_box");
    open = () => {
      const key = boxKey(roster.mesh, me.keys.boxSec, b64u.decode(sender.box), sender.id, me.deviceId);
      return xchacha20poly1305(key, b64u.decode(box.n), headerAad(f)).decrypt(b64u.decode(box.c));
    };
  }
  let bytes: Uint8Array;
  let text: string;
  try {
    bytes = open();
    text = fromUtf8(bytes);
  } catch {
    return fail("decrypt_failed");
  }

  const json = parseJson(text);
  if (!json.ok) return fail("plaintext_malformed");
  const result = plaintextSchema.safeParse(json.value);
  if (!result.success) return fail("plaintext_malformed");
  const body = result.data;
  // Only one byte string may encode a plaintext, so no two parsers can disagree about it.
  if (!bytesEqual(canonBytes(body), bytes)) return fail("plaintext_malformed");

  if ((body.kind === "card") !== (f.seq === 0)) return fail("seq_kind_mismatch");
  if (body.id !== f.id) return fail("id_mismatch");
  if (canon(body.from) !== canon(f.from)) return fail("from_mismatch");
  if (!sameTo(body.to, f.to)) return fail("to_mismatch");
  if (body.at !== f.at) return fail("at_mismatch");
  if (body.roster.seq !== f.roster.seq || body.roster.hash !== f.roster.hash) return fail("roster_mismatch");
  return ok(body);
}
