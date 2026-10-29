// Signed prekeys (SPEC section 6b): a device's short-lived X25519 keys, each signed by its own
// long-term signing key, that senders seal every box to. Deleting a prekey's secret on schedule
// is what makes recorded traffic unreadable to a key file stolen later.

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { z } from "zod";
import { b64u, sha256, utf8 } from "./encoding.ts";
import { deviceIdFromSignPub, randomBytes } from "./ids.ts";
import { fail, LIMITS, ok, type Result } from "./limits.ts";
import { deviceIdSchema, keySchema, meshIdSchema, sigSchema, timeSchema, type Roster } from "./schema.ts";
import { isRecoveryName } from "./roster.ts";
import { signObject, verifyObject } from "./sign.ts";

/**
 * A prekey as published: `id` is `b64u(H(pub))` cut to 22 characters, `at` when it was made and
 * `until` the last moment a sender may seal to it. `sig` is the device's own signature, type
 * `prekey`. No admin signs it: a device rotates its prekeys on its own.
 */
export const prekeySchema = z.strictObject({
  mesh: meshIdSchema,
  device: deviceIdSchema,
  id: deviceIdSchema,
  pub: keySchema,
  at: timeSchema,
  until: timeSchema,
  sig: sigSchema,
});

export type Prekey = z.infer<typeof prekeySchema>;

/** A prekey's id: `b64u(SHA-256(pub))` truncated to 22 characters, like a device id. */
export function prekeyId(pub: Uint8Array): string {
  return deviceIdFromSignPub(pub);
}

/**
 * Makes and signs a new prekey for this device. Returns the published object and its 32-byte
 * secret, which the device keeps until `until` + 72 hours (SPEC section 6b) and then deletes.
 * Throws when `deviceId` is not the id of `signSec`'s public key.
 */
export function createPrekey(opts: { mesh: string; deviceId: string; signSec: Uint8Array; at: number }): { prekey: Prekey; secret: Uint8Array } {
  if (deviceIdFromSignPub(ed25519.getPublicKey(opts.signSec)) !== opts.deviceId) {
    throw new TypeError("createPrekey: deviceId does not match the signing key");
  }
  const secret = randomBytes(32);
  const pub = x25519.getPublicKey(secret);
  const body = {
    mesh: opts.mesh,
    device: opts.deviceId,
    id: prekeyId(pub),
    pub: b64u.encode(pub),
    at: opts.at,
    until: opts.at + LIMITS.prekeyLifetimeMs,
  };
  return { prekey: signObject("prekey", body, opts.signSec), secret };
}

// Any fixed scalar: X25519 with a low-order point gives an all-zero secret, which noble refuses.
const PROBE = sha256(utf8("wim/1 prekey probe"));

/**
 * Checks a published prekey against the receiver's newest verified roster and clock. Never
 * throws. Reasons, in the order checked:
 *
 * - `malformed`, `wrong_mesh`
 * - `unknown_device` (not in this roster), `revoked_device`, `recovery_device` (recovery records
 *   never connect, so never publish one)
 * - `bad_id` (`id` is not derived from `pub`), `bad_signature` (not the device's own `sign` key)
 * - `bad_window` (`until` not after `at`, or more than 48 hours after it), `bad_key` (a low-order
 *   X25519 key)
 * - `not_yet` (`at` more than 10 minutes ahead of `now`), `expired` (fewer than 10 minutes before
 *   `until`: a sender must not seal to it any more)
 */
export function verifyPrekey(raw: unknown, roster: Roster, now: number): Result<Prekey> {
  const parsed = prekeySchema.safeParse(raw);
  if (!parsed.success) return fail("malformed");
  const pk = parsed.data;
  if (pk.mesh !== roster.mesh) return fail("wrong_mesh");
  if (roster.revoked.includes(pk.device)) return fail("revoked_device");
  const device = roster.devices.find((d) => d.id === pk.device);
  if (device === undefined) return fail("unknown_device");
  if (isRecoveryName(device.name)) return fail("recovery_device");
  const pub = b64u.decode(pk.pub);
  if (prekeyId(pub) !== pk.id) return fail("bad_id");
  if (!verifyObject("prekey", pk, b64u.decode(device.sign))) return fail("bad_signature");
  if (pk.until <= pk.at || pk.until - pk.at > LIMITS.prekeyLifetimeMs) return fail("bad_window");
  try {
    x25519.getSharedSecret(PROBE, pub);
  } catch {
    return fail("bad_key");
  }
  if (pk.at > now + LIMITS.messageMaxFutureMs) return fail("not_yet");
  if (!prekeyUsable(pk, now)) return fail("expired");
  return ok(pk);
}

/**
 * The time rule alone, for a prekey already verified: not more than 10 minutes ahead of `now`,
 * and at least 10 minutes before its `until`. Senders seal only to a prekey that passes it.
 */
export function prekeyUsable(pk: { at: number; until: number }, now: number): boolean {
  return pk.at <= now + LIMITS.messageMaxFutureMs && now + LIMITS.prekeySendMarginMs < pk.until;
}

/**
 * When a device deletes a prekey's secret: `until` + 72 hours (SPEC section 6b), so a box sealed
 * at the last moment a sender may use the prekey still opens for the whole 72-hour room history.
 */
export function prekeyDeleteAt(pk: { until: number }): number {
  return pk.until + LIMITS.prekeyRetentionMs;
}
