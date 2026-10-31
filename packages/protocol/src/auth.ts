import { b64u, hash } from "./encoding.ts";
import { authFrameSchema, recoverAuthFrameSchema, type AuthFrame, type RecoverAuthFrame } from "./frames.ts";
import { deviceIdFromSignPub } from "./ids.ts";
import type { DeviceKeys } from "./keys.ts";
import { signObjectWith, type Keyring } from "./keyring.ts";
import { fail, LIMITS, ok, WIRE_VERSION, type Result } from "./limits.ts";
import { isRecoveryName } from "./roster.ts";
import { safeParse } from "./schema.ts";
import type { DeviceRecord, Roster } from "./schema.ts";
import { signObject, verifyObject } from "./sign.ts";

/** The fields of an `auth` frame that the client chooses. `device` is derived from the keys. */
export type AuthFields = Omit<AuthFrame, "t" | "v" | "sig" | "device"> & { device?: string };

/** Builds and signs the `auth` answer to a relay's `hello` (SPEC section 8). */
export function signAuth(fields: AuthFields, keys: DeviceKeys): AuthFrame {
  return checkAuth(signObject("auth", authBody(fields, keys.signPub), keys.signSec));
}

/** `signAuth` with the device's keys behind a keyring (SPEC section 3). */
export async function signAuthWith(fields: AuthFields, keyring: Pick<Keyring, "signPub" | "sign">): Promise<AuthFrame> {
  return checkAuth(await signObjectWith("auth", authBody(fields, keyring.signPub), keyring));
}

function authBody(fields: AuthFields, signPub: Uint8Array) {
  const device = deviceIdFromSignPub(signPub);
  if (fields.device !== undefined && fields.device !== device) {
    throw new TypeError("signAuth: device does not match the signing key");
  }
  return { ...fields, t: "auth" as const, v: WIRE_VERSION, device };
}

function checkAuth(frame: object): AuthFrame {
  const parsed = authFrameSchema.safeParse(frame);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new TypeError(`signAuth: ${issue.path.join(".")}: ${issue.message}`);
  }
  return parsed.data;
}

/**
 * The relay's check of an `auth` frame against the device's signing key (looked up in the
 * current roster by `frame.device`). `relay` is the relay's configured public URL, or a list of
 * them; it is compared byte for byte and never derived from request headers. `nonce` is the one
 * this connection's `hello` sent. Never throws. Reasons: `malformed`, `wrong_relay`, `wrong_nonce`,
 * `clock_skew`, `wrong_device`, `bad_signature`.
 */
export function verifyAuth(
  frame: unknown,
  signPub: Uint8Array,
  expect: Expect,
): Result {
  const parsed = safeParse(authFrameSchema, frame);
  if (!parsed.success) return fail("malformed");
  const f = parsed.data;
  const checked = checkCommon(f, expect);
  if (!checked.ok) return checked;
  let device: string;
  try {
    device = deviceIdFromSignPub(signPub);
  } catch {
    return fail("wrong_device");
  }
  if (f.device !== device) return fail("wrong_device");
  if (!verifyObject("auth", f, signPub)) return fail("bad_signature");
  return ok(true);
}

type Expect = { relay: string | readonly string[]; nonce: string; now: number; skewMs?: number };

function checkCommon(f: { relay: string; nonce: string; at: number }, expect: Expect): Result {
  const relays: readonly string[] = typeof expect.relay === "string" ? [expect.relay] : expect.relay;
  if (!relays.includes(f.relay)) return fail("wrong_relay");
  if (f.nonce !== expect.nonce) return fail("wrong_nonce");
  if (Math.abs(f.at - expect.now) > (expect.skewMs ?? LIMITS.authSkewMs)) return fail("clock_skew");
  return ok(true);
}

/**
 * Builds and signs a recovery record's `auth` (SPEC section 4a). `genesis` is the mesh's roster 1,
 * the one the recovery code pins.
 */
export function signRecoverAuth(
  fields: { relay: string; mesh: string; nonce: string; at: number; genesis: string },
  keys: DeviceKeys,
): RecoverAuthFrame {
  const body = {
    t: "auth" as const,
    v: WIRE_VERSION,
    purpose: "recover" as const,
    relay: fields.relay,
    mesh: fields.mesh,
    device: deviceIdFromSignPub(keys.signPub),
    nonce: fields.nonce,
    at: fields.at,
    pin: { seq: 1 as const, hash: fields.genesis },
  };
  const frame = signObject("auth", body, keys.signSec);
  const parsed = recoverAuthFrameSchema.safeParse(frame);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new TypeError(`signRecoverAuth: ${issue.path.join(".")}: ${issue.message}`);
  }
  return parsed.data;
}

/**
 * The relay's check of a recovery `auth`. `roster` is the mesh's current roster and `genesis` its
 * roster 1. The device must be a current, unrevoked recovery record of that roster. Returns its
 * record. Never throws. Reasons: `malformed`, `wrong_relay`, `wrong_nonce`, `clock_skew`,
 * `wrong_mesh`, `wrong_pin`, `not_recovery` (unknown, revoked, or not a recovery record) and
 * `bad_signature`.
 */
export function verifyRecoverAuth(
  frame: unknown,
  mesh: { roster: Roster; genesis: Roster },
  expect: Expect,
): Result<DeviceRecord> {
  const parsed = safeParse(recoverAuthFrameSchema, frame);
  if (!parsed.success) return fail("malformed");
  const f = parsed.data;
  const checked = checkCommon(f, expect);
  if (!checked.ok) return checked;
  if (f.mesh !== mesh.roster.mesh) return fail("wrong_mesh");
  if (f.pin.hash !== hash(mesh.genesis)) return fail("wrong_pin");
  const record = mesh.roster.devices.find((d) => d.id === f.device);
  if (record === undefined || !isRecoveryName(record.name)) return fail("not_recovery");
  if (!verifyObject("auth", f, b64u.decode(record.sign))) return fail("bad_signature");
  return ok(record);
}
