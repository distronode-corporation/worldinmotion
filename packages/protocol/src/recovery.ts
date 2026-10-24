import { z } from "zod";
import { b64u, canonBytes, fromUtf8, hash, sha256, utf8 } from "./encoding.ts";
import { deviceIdFromSignPub, randomBytes } from "./ids.ts";
import { parseJson } from "./json.ts";
import { deviceKeysFromSecrets, type DeviceKeys } from "./keys.ts";
import { fail, ok, type Result } from "./limits.ts";
import { isRecoveryName, makeDeviceRecord, verifyGenesisRoster, verifyRosterChain } from "./roster.ts";
import { hashSchema, meshIdSchema, secret32Schema, type DeviceRecord, type Roster } from "./schema.ts";

const PREFIX = "wimrec1_";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const bodySchema = z.strictObject({ mesh: meshIdSchema, genesis: hashSchema, sign: secret32Schema, box: secret32Schema });

/** First 40 bits of SHA-256(UTF-8(body)) as 8 Crockford base32 characters. */
function checksum(body: string): string {
  const h = sha256(utf8(body));
  let bits = 0n;
  for (const b of h.subarray(0, 5)) bits = (bits << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 8; i++) out = CROCKFORD[Number((bits >> BigInt(5 * i)) & 31n)]! + out;
  return out;
}

/**
 * Makes a recovery identity's keys and admin record (SPEC section 4a), named `recovery` unless
 * another `recovery...` name is given (for rotation). At mesh creation the record goes into the
 * genesis roster first; the code, which pins that genesis, comes after from `recoveryCode`.
 */
export function createRecoveryKeys(
  meshId: string,
  opts: { name?: string; now?: number } = {},
): { record: DeviceRecord; keys: DeviceKeys } {
  if (!meshIdSchema.safeParse(meshId).success) throw new TypeError("createRecoveryIdentity: invalid mesh id");
  const name = opts.name ?? "recovery";
  if (!isRecoveryName(name)) throw new TypeError("createRecoveryIdentity: the name must start with recovery");
  const keys = deviceKeysFromSecrets(randomBytes(32), randomBytes(32));
  return { record: makeDeviceRecord(name, keys, "admin", opts.now ?? Date.now()), keys };
}

/**
 * The one-time recovery code for a recovery identity:
 * `wimrec1_<b64u(canon({ mesh, genesis, sign, box }))>-<checksum>`, where `genesis` is the hash of
 * the mesh's roster 1, `sign` and `box` are the two secret keys, and the checksum is 8 Crockford
 * base32 characters of SHA-256 of the b64u body.
 *
 * The code is as powerful as an admin device. Show it once, only on an interactive terminal the
 * client controls (SPEC section 4a), and never write it to disk.
 */
export function recoveryCode(keys: DeviceKeys, pin: { mesh: string; genesis: string }): string {
  if (!meshIdSchema.safeParse(pin.mesh).success) throw new TypeError("recoveryCode: invalid mesh id");
  if (!hashSchema.safeParse(pin.genesis).success) throw new TypeError("recoveryCode: invalid genesis hash");
  const body = b64u.encode(
    canonBytes({ mesh: pin.mesh, genesis: pin.genesis, sign: b64u.encode(keys.signSec), box: b64u.encode(keys.boxSec) }),
  );
  return `${PREFIX}${body}-${checksum(body)}`;
}

/**
 * Keys, record and code in one step, for an existing mesh whose genesis hash is known (rotating
 * recovery). At mesh creation use `createRecoveryKeys`, then `recoveryCode` once genesis exists.
 */
export function createRecoveryIdentity(
  meshId: string,
  opts: { name?: string; now?: number; genesis?: string } = {},
): { record: DeviceRecord; code: string; keys: DeviceKeys } {
  if (opts.genesis === undefined) {
    throw new TypeError("createRecoveryIdentity: needs the genesis hash; at mesh creation use createRecoveryKeys and recoveryCode");
  }
  const { record, keys } = createRecoveryKeys(meshId, opts);
  return { record, keys, code: recoveryCode(keys, { mesh: meshId, genesis: opts.genesis }) };
}

/**
 * Reads a recovery code back into its keys, mesh id and pinned genesis hash. Throws an Error with
 * a readable message if the code is damaged (the checksum catches typing mistakes) or, when
 * `meshId` is given, belongs to another mesh. The checksum is read leniently, as Crockford base32
 * allows: any case, with I and L read as 1 and O as 0.
 */
export function parseRecoveryCode(code: string, meshId?: string): DeviceKeys & { mesh: string; genesis: string } {
  const text = typeof code === "string" ? code.trim() : "";
  const dash = text.lastIndexOf("-");
  if (!text.startsWith(PREFIX) || dash < PREFIX.length) {
    throw new Error("invalid recovery code: it must look like wimrec1_...-XXXXXXXX");
  }
  const body = text.slice(PREFIX.length, dash);
  const given = text.slice(dash + 1).toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0");
  if (given !== checksum(body)) {
    throw new Error("invalid recovery code: the checksum does not match (check for typing mistakes)");
  }
  let json: string;
  try {
    json = fromUtf8(b64u.decode(body));
  } catch {
    throw new Error("invalid recovery code: it is damaged");
  }
  const parsedJson = parseJson(json);
  const parsed = parsedJson.ok ? bodySchema.safeParse(parsedJson.value) : undefined;
  if (!parsed?.success) throw new Error("invalid recovery code: it is damaged");
  if (meshId !== undefined && parsed.data.mesh !== meshId) throw new Error("invalid recovery code: it belongs to another mesh");
  const keys = deviceKeysFromSecrets(b64u.decode(parsed.data.sign), b64u.decode(parsed.data.box));
  return { ...keys, mesh: parsed.data.mesh, genesis: parsed.data.genesis };
}

/**
 * What a client checks before it signs with a recovery code (SPEC section 4a): the chain starts at
 * the genesis the code pins (same mesh, a valid genesis roster), verifies all the way to the
 * newest roster, and the newest roster still lists this recovery record as an admin. Returns the
 * newest roster, which the client shows the person (seq and devices) for confirmation before it
 * signs anything. Never throws. Reasons: `recovery_code_invalid`, `recovery_genesis_mismatch`,
 * `recovery_wrong_mesh`, any genesis or chain reason, and `recovery_not_admin`.
 */
export function verifyRecoveryChain(code: string, chain: unknown[]): Result<Roster> {
  let parsed: ReturnType<typeof parseRecoveryCode>;
  try {
    parsed = parseRecoveryCode(code);
  } catch {
    return fail("recovery_code_invalid");
  }
  if (!Array.isArray(chain) || chain.length === 0) return fail("chain_empty");
  const genesis = verifyGenesisRoster(chain[0]);
  if (!genesis.ok) return genesis;
  if (hash(genesis.value) !== parsed.genesis) return fail("recovery_genesis_mismatch");
  if (genesis.value.mesh !== parsed.mesh) return fail("recovery_wrong_mesh");
  const newest = verifyRosterChain({ seq: 1, hash: parsed.genesis }, chain);
  if (!newest.ok) return newest;
  const id = deviceIdFromSignPub(parsed.signPub);
  const record = newest.value.devices.find((d) => d.id === id);
  if (record === undefined || record.role !== "admin") return fail("recovery_not_admin");
  return ok(newest.value);
}

/**
 * What a recovering client shows the person before signing (SPEC section 4a), from a verified
 * chain: the newest roster's seq and time, its devices, and every device revoked since genesis
 * with the name it last had. Assumes `chain` was verified (see `verifyRecoveryChain`).
 */
export function recoverySummary(chain: Roster[]): {
  seq: number;
  at: number;
  devices: Array<{ id: string; name: string; role: DeviceRecord["role"] }>;
  revoked: Array<{ id: string; name: string }>;
} {
  const newest = chain.at(-1);
  if (newest === undefined) throw new TypeError("recoverySummary: empty chain");
  const names = new Map<string, string>();
  for (const r of chain) for (const d of r.devices) names.set(d.id, d.name);
  return {
    seq: newest.seq,
    at: newest.at,
    devices: newest.devices.map((d) => ({ id: d.id, name: d.name, role: d.role })),
    // A revoked id this chain never listed (revoked before the chain's first roster) has no name.
    revoked: newest.revoked.map((id) => ({ id, name: names.get(id) ?? "" })),
  };
}
