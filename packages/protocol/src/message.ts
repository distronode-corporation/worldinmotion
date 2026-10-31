import { z } from "zod";
import { findSecrets } from "./agent.ts";
import { b64u, bytesEqual, canon, canonBytes, fitsUtf8, fromUtf8, hash, sha256, utf8 } from "./encoding.ts";
import { sendFrameSchema, type Box, type SendFrame } from "./frames.ts";
import { deviceIdFromSignPub, ulid } from "./ids.ts";
import { parseJson } from "./json.ts";
import type { DeviceKeys } from "./keys.ts";
import { openBox, sealBox, type Keyring, type Opened, type OpenRequest, type SealRequest } from "./keyring.ts";
import { fail, LIMITS, ok, WIRE_VERSION, type Result } from "./limits.ts";
import { checkFreshness } from "./replay.ts";
import { fileSchema, type FileInfo } from "./blob.ts";
import { verifyPrekey, type Prekey } from "./prekey.ts";
import { fromSchema, isRoom, rosterRefSchema, safeParse, timeSchema, toSchema, ulidSchema, type Roster } from "./schema.ts";
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
    // A liveness probe (SPEC section 12): the receiving client answers it itself with a `pong`,
    // never an agent. Neither carries text, and neither is relayed or derived.
    z.strictObject({ ...common, kind: z.literal("ping"), text: z.undefined().optional() }),
    z.strictObject({ ...common, kind: z.literal("pong"), text: z.undefined().optional(), reply_to: ulidSchema }),
  ])
  .refine((p) => p.kind !== "card" || (p.to.length === 1 && p.to[0] === "*"), {
    message: "a card is sent to * only",
    path: ["to"],
  })
  .refine((p) => p.kind !== "ping" || p.to.every((a) => a !== "*" && !isRoom(a)), {
    message: "a ping names sessions, never * or a room",
    path: ["to"],
  })
  .refine((p) => p.kind !== "pong" || (p.to.length === 1 && p.to[0] !== "*" && !isRoom(p.to[0]!)), {
    message: "a pong answers one session",
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
export type SealOptions = {
  roster: Roster;
  session: string;
  sid: string;
  to: string[];
  seq: number;
  at: number;
  id?: string;
  kind?: MessageKind;
  /** Required for `msg`, `task` and `result`; an optional caption for `file`; absent for `card`, `ping` and `pong`. */
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
};

export function sealMessage(opts: SealOptions & { sender: { deviceId: string; keys: DeviceKeys } }): SendFrame {
  const { keys } = opts.sender;
  const plan = planSeal(opts, keys.signPub);
  const boxes: Record<string, Box> = {};
  for (const req of plan.requests) boxes[req.recipient] = sealBox(keys.boxSec, req);
  return finishSeal(plan, signObject("send", { ...plan.header, boxes }, keys.signSec));
}

/**
 * `sealMessage` with the device's keys behind a keyring (SPEC section 3), for a client whose keys
 * live in a signer process. Same checks, same frame, same `sealMessage:` errors.
 */
export async function sealMessageWith(opts: SealOptions & { sender: { deviceId: string; keyring: Keyring } }): Promise<SendFrame> {
  const { keyring } = opts.sender;
  const plan = planSeal(opts, keyring.signPub);
  const boxes: Record<string, Box> = {};
  for (const req of plan.requests) boxes[req.recipient] = await keyring.seal(req);
  const body = { ...plan.header, boxes };
  return finishSeal(plan, { ...body, sig: await keyring.sign("send", body) });
}

type SealPlan = { kind: MessageKind; header: Omit<SendFrame, "boxes" | "sig">; requests: SealRequest[] };

/** Every check and the header and plaintext of a seal; what is left needs the device's secret keys. */
function planSeal(opts: SealOptions & { sender: { deviceId: string } }, signPub: Uint8Array): SealPlan {
  const { roster, sender } = opts;
  const kind = opts.kind ?? "msg";
  if (deviceIdFromSignPub(signPub) !== sender.deviceId) {
    throw new TypeError("sealMessage: sender.deviceId does not match the signing key");
  }
  if (!roster.devices.some((d) => d.id === sender.deviceId)) {
    throw new TypeError("sealMessage: the sender is not a current device in the roster");
  }
  const noCaption = (kind === "file" || kind === "card" || kind === "ping" || kind === "pong") && opts.text === undefined;
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
  const requests = recipients.map((r): SealRequest => {
    const pk = prekeys[r.id];
    const base = { mesh: roster.mesh, sender: sender.deviceId, recipient: r.id, recipientBox: b64u.decode(r.box), aad, plaintext };
    return pk === undefined ? base : { ...base, prekey: { id: pk.id, pub: b64u.decode(pk.pub) } };
  });
  return { kind, header, requests };
}

/** The size and shape checks of a signed frame. */
function finishSeal(plan: SealPlan, frame: object): SendFrame {
  const limit = plan.kind === "card" ? LIMITS.cardFrameBytes : LIMITS.frameBytes;
  if (!fitsUtf8(canon(frame), limit)) throw new RangeError(`sealMessage: frame would be over ${limit} bytes`);
  const parsed = sendFrameSchema.safeParse(frame);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new TypeError(`sealMessage: ${issue.path.join(".")}: ${issue.message}`);
  }
  return frame as SendFrame;
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
  const checked = checkFrame(frame, ctx);
  if (!checked.ok) return checked;
  const { me } = ctx;
  return checkPlaintext(checked.value.f, openBox(me.keys.boxSec, me.prekey ?? (() => undefined), checked.value.req));
}

/**
 * The receiving session for `openMessageWith`: as `Receiver`, with the device's keys behind a
 * keyring, which also finds the secret of the prekey a scheme 2 box names.
 */
export type KeyringReceiver = Omit<Receiver, "keys" | "prekey"> & { keyring: Pick<Keyring, "open"> };

/**
 * `openMessage` with the device's keys behind a keyring (SPEC section 3). Same checks and reasons.
 * When the keyring cannot answer (a signer that is locked or gone) this rejects instead of
 * returning a reason, so the caller can keep the frame and try again rather than drop it.
 */
export async function openMessageWith(
  frame: unknown,
  ctx: { roster: Roster; me: KeyringReceiver; now: number; history?: boolean; legacy?: boolean },
): Promise<Result<Plaintext>> {
  const checked = checkFrame(frame, ctx);
  if (!checked.ok) return checked;
  return checkPlaintext(checked.value.f, await ctx.me.keyring.open(checked.value.req));
}

/** Every check before decryption, in SPEC order; on success, the box to open. */
function checkFrame(
  frame: unknown,
  ctx: { roster: Roster; me: Omit<Receiver, "keys" | "prekey">; now: number; history?: boolean; legacy?: boolean },
): Result<{ f: SendFrame; req: OpenRequest }> {
  const parsed = safeParse(sendFrameSchema, frame);
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
  if (!("s" in box) && ctx.legacy === false) return fail("legacy_box");
  return ok({ f, req: { mesh: roster.mesh, sender: sender.id, recipient: me.deviceId, senderBox: b64u.decode(sender.box), box, aad: headerAad(f) } });
}

/** The checks after decryption: the plaintext is canonical and repeats the header's fields. */
function checkPlaintext(f: SendFrame, opened: Opened): Result<Plaintext> {
  if (typeof opened === "string") return fail(opened);
  let text: string;
  try {
    text = fromUtf8(opened);
  } catch {
    return fail("decrypt_failed");
  }
  const bytes = opened;

  const json = parseJson(text);
  if (!json.ok) return fail("plaintext_malformed");
  const result = safeParse(plaintextSchema, json.value);
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
