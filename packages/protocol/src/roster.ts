import { b64u, hash } from "./encoding.ts";
import { deviceIdFromSignPub, randomBytes } from "./ids.ts";
import type { DeviceKeys } from "./keys.ts";
import { signObjectWith, type Keyring } from "./keyring.ts";
import { fail, ok, type Result } from "./limits.ts";
import { deviceRecordSchema, meshIdSchema, rosterSchema, safeParse, type DeviceRecord, type Roster, type RosterRef } from "./schema.ts";
import { signObject, verifyObject } from "./sign.ts";

/** A device's two public keys, as a key set or a keyring holds them. */
export type PublicKeys = { signPub: Uint8Array; boxPub: Uint8Array };

/** Builds the public device record for a key set. */
export function makeDeviceRecord(
  name: string,
  keys: PublicKeys,
  role: DeviceRecord["role"],
  added: number,
): DeviceRecord {
  const record = {
    id: deviceIdFromSignPub(keys.signPub),
    name,
    sign: b64u.encode(keys.signPub),
    box: b64u.encode(keys.boxPub),
    role,
    added,
  };
  const parsed = deviceRecordSchema.safeParse(record);
  if (!parsed.success) throw new TypeError(`makeDeviceRecord: ${parsed.error.issues[0]!.message}`);
  return record;
}

/** Names starting with `recovery` belong to recovery records (SPEC section 4a). */
export function isRecoveryName(name: string): boolean {
  return name.startsWith("recovery");
}

/**
 * The genesis roster: seq 1, no prev, the creating admin device that signs it, and optionally the
 * mesh's recovery record (an admin named `recovery...`, from `createRecoveryIdentity`).
 */
export function createGenesisRoster(opts: GenesisOptions & { keys: DeviceKeys }): Roster {
  return checkGenesis(signObject("roster", genesisBody(opts), opts.keys.signSec));
}

/** `createGenesisRoster` with the device's keys behind a keyring (SPEC section 3). */
export async function createGenesisRosterWith(opts: GenesisOptions & { keyring: Pick<Keyring, "signPub" | "boxPub" | "sign"> }): Promise<Roster> {
  return checkGenesis(await signObjectWith("roster", genesisBody({ ...opts, keys: opts.keyring }), opts.keyring));
}

type GenesisOptions = { name: string; now: number; meshId?: string; recovery?: DeviceRecord };

function genesisBody(opts: GenesisOptions & { keys: PublicKeys }) {
  if (isRecoveryName(opts.name)) throw new TypeError("createGenesisRoster: names starting with recovery are reserved");
  const mesh = opts.meshId ?? b64u.encode(randomBytes(16));
  if (!meshIdSchema.safeParse(mesh).success) throw new TypeError("createGenesisRoster: invalid mesh id");
  const device = makeDeviceRecord(opts.name, opts.keys, "admin", opts.now);
  const devices = opts.recovery === undefined ? [device] : [device, { ...opts.recovery }];
  return { mesh, seq: 1, prev: null, devices, revoked: [], by: device.id, at: opts.now };
}

function checkGenesis(roster: Roster): Roster {
  const verified = verifyGenesisRoster(roster);
  if (!verified.ok) throw new TypeError(`createGenesisRoster: ${verified.reason}`);
  return roster;
}

/** A device that may sign the next roster: present (so not revoked) with role admin. */
function adminSigner(roster: Roster, id: string): DeviceRecord | undefined {
  if (roster.revoked.includes(id)) return undefined;
  return roster.devices.find((d) => d.id === id && d.role === "admin");
}

/**
 * Signs roster `prev.seq + 1`. Revoked devices move to `revoked`, promoted members become admins,
 * and added devices are appended. Throws if the signer is not an unrevoked admin of `prev`, if a
 * name or id would be duplicated, if a revoked id would come back, if a revoked or promoted id is
 * not a current device, if a promoted device is already an admin, if a `recovery...` name is
 * added as a member, or if the change would leave the mesh with no admin.
 */
export function nextRoster(prev: Roster, change: RosterChange, signer: { keys: DeviceKeys }, now: number): Roster {
  return signObject("roster", nextRosterBody(prev, change, signer.keys.signPub, now), signer.keys.signSec);
}

/** `nextRoster` with the signing admin's keys behind a keyring (SPEC section 3). */
export async function nextRosterWith(prev: Roster, change: RosterChange, keyring: Pick<Keyring, "signPub" | "sign">, now: number): Promise<Roster> {
  return signObjectWith("roster", nextRosterBody(prev, change, keyring.signPub, now), keyring);
}

/** A roster change: devices to add, ids to revoke, members to promote to admin. */
export type RosterChange = { add?: DeviceRecord[]; revoke?: string[]; promote?: string[] };

function nextRosterBody(prev: Roster, change: RosterChange, signPub: Uint8Array, now: number) {
  const signerId = deviceIdFromSignPub(signPub);
  if (!adminSigner(prev, signerId)) throw new Error("nextRoster: signer is not an unrevoked admin");

  const revoke = change.revoke ?? [];
  if (new Set(revoke).size !== revoke.length) throw new Error("nextRoster: duplicate id in revoke");
  for (const id of revoke) {
    if (!prev.devices.some((d) => d.id === id)) throw new Error(`nextRoster: ${id} is not a current device`);
  }
  const devices = prev.devices.filter((d) => !revoke.includes(d.id)).map((d) => ({ ...d }));
  const revoked = [...prev.revoked, ...revoke];

  const promote = change.promote ?? [];
  if (new Set(promote).size !== promote.length) throw new Error("nextRoster: duplicate id in promote");
  for (const id of promote) {
    const device = devices.find((d) => d.id === id);
    if (!device) throw new Error(`nextRoster: ${id} is not a current device`);
    if (device.role !== "member") throw new Error(`nextRoster: ${id} is already an admin`);
    device.role = "admin";
  }

  for (const device of change.add ?? []) {
    const parsed = deviceRecordSchema.safeParse(device);
    if (!parsed.success) throw new Error(`nextRoster: invalid device record: ${parsed.error.issues[0]!.message}`);
    if (deviceIdFromSignPub(b64u.decode(device.sign)) !== device.id) {
      throw new Error("nextRoster: device id does not match its signing key");
    }
    if (revoked.includes(device.id)) throw new Error(`nextRoster: ${device.id} was revoked and cannot return`);
    if (devices.some((d) => d.id === device.id)) throw new Error(`nextRoster: duplicate device id ${device.id}`);
    if (devices.some((d) => d.name === device.name)) throw new Error(`nextRoster: duplicate device name ${device.name}`);
    if (isRecoveryName(device.name) && device.role !== "admin") {
      throw new Error("nextRoster: names starting with recovery are reserved for recovery records");
    }
    devices.push({ ...device });
  }
  if (!devices.some((d) => d.role === "admin")) throw new Error("nextRoster: the mesh would have no admin");
  return { mesh: prev.mesh, seq: prev.seq + 1, prev: hash(prev), devices, revoked, by: signerId, at: now };
}

/** Rules that hold for every roster on its own: ids derived from keys, unique names and ids. */
function checkShape(roster: unknown): Result<Roster> {
  const parsed = safeParse(rosterSchema, roster);
  if (!parsed.success) return fail("roster_malformed");
  const r = parsed.data;
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const d of r.devices) {
    if (deviceIdFromSignPub(b64u.decode(d.sign)) !== d.id) return fail("roster_bad_device_id");
    if (ids.has(d.id)) return fail("roster_duplicate_id");
    if (names.has(d.name)) return fail("roster_duplicate_name");
    if (isRecoveryName(d.name) && d.role !== "admin") return fail("roster_recovery_not_admin");
    ids.add(d.id);
    names.add(d.name);
  }
  const revoked = new Set(r.revoked);
  if (revoked.size !== r.revoked.length) return fail("roster_duplicate_revoked");
  if (r.devices.some((d) => revoked.has(d.id))) return fail("roster_revoked_present");
  return ok(r);
}

/**
 * Verifies a genesis roster on its own (what a relay checks on `create`): seq 1, no prev, no
 * revocations, the creating admin first (it signs), and at most one more device, which must be a
 * recovery record (an admin named `recovery...`).
 */
export function verifyGenesisRoster(roster: unknown): Result<Roster> {
  const shape = checkShape(roster);
  if (!shape.ok) return shape;
  const r = shape.value;
  if (r.seq !== 1 || r.prev !== null) return fail("genesis_not_first");
  const [creator, recovery, ...rest] = r.devices;
  if (creator === undefined || creator.role !== "admin" || rest.length > 0 || r.revoked.length !== 0) {
    return fail("genesis_bad_devices");
  }
  if (isRecoveryName(creator.name)) return fail("genesis_reserved_name");
  if (recovery !== undefined && !isRecoveryName(recovery.name)) return fail("genesis_bad_devices");
  if (r.by !== creator.id) return fail("genesis_wrong_signer");
  if (!verifyObject("roster", r, b64u.decode(creator.sign))) return fail("roster_bad_signature");
  return ok(r);
}

/**
 * Verifies that `next` is a valid successor of `prev` (SPEC section 4). `prev` must already be
 * trusted. Devices kept from `prev` must be unchanged except that a member may be promoted to
 * admin, a device may leave `devices` only by being revoked, and at least one admin must remain.
 */
export function verifyNextRoster(prev: Roster, next: unknown): Result<Roster> {
  const shape = checkShape(next);
  if (!shape.ok) return shape;
  const n = shape.value;
  if (n.mesh !== prev.mesh) return fail("roster_wrong_mesh");
  if (n.seq !== prev.seq + 1) return fail("roster_wrong_seq");
  if (n.prev !== hash(prev)) return fail("roster_wrong_prev");
  const signer = adminSigner(prev, n.by);
  if (!signer) return fail("roster_signer_not_admin");
  if (!verifyObject("roster", n, b64u.decode(signer.sign))) return fail("roster_bad_signature");

  if (prev.revoked.some((id, i) => n.revoked[i] !== id)) return fail("roster_revocation_undone");
  const revokedNow = new Set(n.revoked);
  const kept = new Map(n.devices.map((d) => [d.id, d]));
  for (const old of prev.devices) {
    const now = kept.get(old.id);
    if (now === undefined) {
      if (!revokedNow.has(old.id)) return fail("roster_device_dropped");
    } else if (hash(now) !== hash(old) && !isPromotion(old, now)) {
      return fail("roster_device_changed");
    }
  }
  if (!n.devices.some((d) => d.role === "admin")) return fail("roster_no_admin");
  return ok(n);
}

/** The one allowed change to a kept device: member to admin, every other field byte-identical. */
function isPromotion(old: DeviceRecord, now: DeviceRecord): boolean {
  return old.role === "member" && now.role === "admin" && hash({ ...now, role: "member" }) === hash(old);
}

/**
 * Walks a roster chain forward from a pinned roster. `chain[0]` must be the pinned roster itself
 * (same seq and hash); each later entry must be a valid successor of the one before. Returns the
 * newest roster. A chain that starts lower or higher than the pin is refused, so a relay cannot
 * roll a client back.
 */
export function verifyRosterChain(pinned: { seq: number; hash: string }, chain: unknown[]): Result<Roster> {
  if (!Array.isArray(chain) || chain.length === 0) return fail("chain_empty");
  const first = checkShape(chain[0]);
  if (!first.ok) return first;
  if (first.value.seq !== pinned.seq) return fail("chain_wrong_start");
  if (hash(first.value) !== pinned.hash) return fail("chain_pin_mismatch");
  let current = first.value;
  for (const next of chain.slice(1)) {
    const step = verifyNextRoster(current, next);
    if (!step.ok) return step;
    current = step.value;
  }
  return ok(current);
}

/**
 * Looks up a current (unrevoked) device by id or name. An id match wins, so a device name that
 * happens to equal another device's id cannot shadow it.
 */
export function findDevice(roster: Roster, idOrName: string): DeviceRecord | undefined {
  return roster.devices.find((d) => d.id === idOrName) ?? roster.devices.find((d) => d.name === idOrName);
}

/** The `{ seq, hash }` reference to a roster, as carried in `auth` pins and message headers. */
export function rosterRef(roster: Roster): RosterRef {
  return { seq: roster.seq, hash: hash(roster) };
}

/**
 * True when two rosters prove a fork: same mesh and seq, different content. Both must already be
 * verified (each against its own predecessor); an unverified roster proves nothing.
 */
export function detectFork(a: Roster, b: Roster): boolean {
  return a.mesh === b.mesh && a.seq === b.seq && hash(a) !== hash(b);
}
