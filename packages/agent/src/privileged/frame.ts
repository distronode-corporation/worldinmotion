// The sender, authenticated by the privileged runner itself (RUNNER contract v2). The peer hands
// over the signed `send` frame the relay delivered; the runner checks its signature against sender
// keys pinned in its own root config, opens the box with the recipient device's keys, and reads
// the text from what the sender signed. A compromised peer can withhold or replay a frame, but it
// cannot make one: it holds no sender's signing key.

import { b64u, decodeKeys, deviceIdFromSignPub, LIMITS, openMessage, prekeyDeleteAt, prekeySchema, type DeviceKeys, type Roster } from "@worldinmotion/protocol";

/** A sender's public keys, as `wim devices` and the roster list them (base64url, 32 bytes each). */
export interface PinnedSender {
  sign: string;
  box: string;
}

/** The receiving device's keys, read by root from the peer's key and prekey files. */
export interface RecipientKeys {
  deviceId: string;
  keys: DeviceKeys;
  prekeys: Map<string, Uint8Array>;
}

export class FrameError extends Error {
  override readonly name = "FrameError";
}

/** Whether `id` is the device id the sign key names: a pin cannot claim another device's id. */
export function pinMatches(id: string, sign: string): boolean {
  try {
    const bytes = b64u.decode(sign);
    return bytes.length === 32 && deviceIdFromSignPub(bytes) === id;
  } catch {
    return false;
  }
}

/**
 * The recipient's keys from the text of its key file and prekey file. Both files belong to the
 * peer, so their contents are untrusted: a swapped key can only make a message unreadable, never
 * make a forged one verify, because the signature is checked with the pinned sender keys.
 */
export function parseRecipient(deviceJson: string, prekeysJson: string | undefined, now: number): RecipientKeys {
  let raw: unknown;
  try {
    raw = JSON.parse(deviceJson);
  } catch {
    throw new FrameError("the recipient's key file is not JSON");
  }
  if ((raw as { v?: unknown } | null)?.v === 2) {
    throw new FrameError("the recipient's key file is encrypted; the privileged runner needs a plaintext key file it can read as root");
  }
  let keys: DeviceKeys;
  try {
    keys = decodeKeys(raw as object);
  } catch (error) {
    throw new FrameError(`the recipient's key file is unusable (${(error as Error).message})`);
  }
  const prekeys = new Map<string, Uint8Array>();
  let file: { v?: unknown; keys?: unknown } | undefined;
  try {
    file = prekeysJson === undefined ? undefined : (JSON.parse(prekeysJson) as typeof file);
  } catch {
    // An unreadable prekey file leaves only the device key: a scheme 2 box then fails to open.
  }
  const list = file?.v === 1 && Array.isArray(file.keys) ? file.keys : [];
  for (const entry of list as Array<{ prekey?: unknown; secret?: unknown }>) {
    const pk = prekeySchema.safeParse(entry.prekey);
    if (!pk.success || typeof entry.secret !== "string") continue;
    const raw = b64u.decode(entry.secret);
    if (raw.length === 32 && prekeyDeleteAt(pk.data) > now) prekeys.set(pk.data.id, raw);
  }
  return { deviceId: deviceIdFromSignPub(keys.signPub), keys, prekeys };
}

export interface Verified {
  id: string;
  device: string;
  at: number;
  text: string;
}

/**
 * Verifies and opens a frame with the protocol's own checks (signature, mesh, address,
 * freshness, box, plaintext bound to the header). The pinned senders stand in for the roster:
 * only they can sign, and the roster's sequence checks are moot without one, so the stand-in's
 * seq is past any real one. Only a `msg` or `task` the sender wrote itself is accepted.
 */
export function verifyFrame(frame: unknown, ctx: { senders: Record<string, PinnedSender>; mesh: string; address: string; recipient: RecipientKeys; now: number }): Verified {
  const ids = Object.keys(ctx.senders);
  const roster: Roster = {
    mesh: ctx.mesh,
    seq: Number.MAX_SAFE_INTEGER,
    prev: null,
    devices: ids.map((id) => ({ id, name: "pinned", sign: ctx.senders[id]!.sign, box: ctx.senders[id]!.box, role: "member" as const, added: 0 })),
    revoked: [],
    by: ids[0]!,
    at: 0,
    sig: "",
  };
  const r = ctx.recipient;
  const opened = openMessage(frame, {
    roster,
    me: { deviceId: r.deviceId, keys: r.keys, address: ctx.address, sid: "", rooms: [], prekey: (id) => r.prekeys.get(id) },
    now: ctx.now,
  });
  if (!opened.ok) throw new FrameError(`the frame does not verify (${opened.reason})`);
  const p = opened.value;
  if (p.kind !== "msg" && p.kind !== "task") throw new FrameError(`a ${p.kind} is never a job`);
  if (p.relayed === true) throw new FrameError("relayed text is never a job");
  return { id: p.id, device: p.from.device, at: p.at, text: p.text };
}

/** How long a seen frame id is kept: past it, the freshness check refuses the frame anyway. */
export const SEEN_WINDOW_MS = LIMITS.messageMaxAgeMs + LIMITS.messageMaxFutureMs;
