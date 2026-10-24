import { describe, expect, it } from "vitest";
import {
  b64u,
  canonBytes,
  createGenesisRoster,
  createRecoveryIdentity,
  createRecoveryKeys,
  deviceKeysFromSecrets,
  findDevice,
  generateDeviceKeys,
  hash,
  nextRoster,
  parseRecoveryCode,
  randomBytes,
  recoveryCode,
  recoverySummary,
  sha256,
  utf8,
  verifyGenesisRoster,
  verifyNextRoster,
  verifyRecoveryChain,
  verifyRosterChain,
  type DeviceKeys,
} from "../src/index.ts";
import { withRandomSource } from "../src/ids.ts";
import { device, T0 } from "./helpers.ts";

const meshId = b64u.encode(new Uint8Array(16).fill(3));
const genesisHash = b64u.encode(sha256(utf8("a genesis")));
const crockford = (h: Uint8Array) => {
  let bits = 0n;
  for (const b of h.subarray(0, 5)) bits = (bits << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 8; i++) out = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Number((bits >> BigInt(5 * i)) & 31n)]! + out;
  return out;
};
const withChecksum = (body: string) => `wimrec1_${body}-${crockford(sha256(utf8(body)))}`;

/** A mesh created the way a client does it: recovery keys, genesis, then the code. */
function createMesh() {
  const laptop = generateDeviceKeys();
  const rec = createRecoveryKeys(meshId, { now: T0 });
  const genesis = createGenesisRoster({ name: "laptop", keys: laptop, now: T0, meshId, recovery: rec.record });
  const code = recoveryCode(rec.keys, { mesh: meshId, genesis: hash(genesis) });
  return { laptop, rec, genesis, code };
}

describe("recovery identity", () => {
  it("makes an admin record named recovery and a code that reads back to its keys and genesis", () => {
    const { rec, genesis, code } = createMesh();
    expect(rec.record).toMatchObject({ name: "recovery", role: "admin", added: T0 });
    expect(code).toMatch(/^wimrec1_[A-Za-z0-9_-]+-[0-9A-HJKMNP-TV-Z]{8}$/);
    const parsed = parseRecoveryCode(code, meshId);
    expect(parsed).toMatchObject({ mesh: meshId, genesis: hash(genesis) });
    expect(parsed.signPub).toEqual(rec.keys.signPub);
    expect(parsed.boxSec).toEqual(rec.keys.boxSec);
    expect(parseRecoveryCode(`  ${code}\n`).mesh).toBe(meshId);
    expect(createRecoveryKeys(meshId).record.added).toBeGreaterThan(T0);
  });

  it("createRecoveryIdentity does it in one step once genesis is known", () => {
    const one = createRecoveryIdentity(meshId, { name: "recovery-2", now: T0, genesis: genesisHash });
    expect(one.record.name).toBe("recovery-2");
    expect(parseRecoveryCode(one.code).genesis).toBe(genesisHash);
    expect(() => createRecoveryIdentity(meshId)).toThrow(/genesis hash/);
  });

  it("encodes canon of mesh, genesis and both secrets, with a SHA-256 Crockford checksum", () => {
    const { rec, genesis, code } = createMesh();
    const dash = code.lastIndexOf("-");
    const body = code.slice(8, dash);
    const expected = { mesh: meshId, genesis: hash(genesis), sign: b64u.encode(rec.keys.signSec), box: b64u.encode(rec.keys.boxSec) };
    expect(b64u.decode(body)).toEqual(canonBytes(expected));
    expect(code.slice(dash + 1)).toBe(crockford(sha256(utf8(body))));
  });

  it("reads the checksum leniently, as Crockford allows", () => {
    // Fixed randomness that gives a checksum containing both 0 and 1, so O, I and L can be tried.
    let code = "";
    for (let i = 0; !/0.*1|1.*0/.test(code.slice(-8)); i++) {
      code = withRandomSource(
        (n) => sha256(utf8(`lenient ${i}`)).slice(0, n),
        () => recoveryCode(createRecoveryKeys(meshId, { now: T0 }).keys, { mesh: meshId, genesis: genesisHash }),
      );
    }
    const dash = code.lastIndexOf("-");
    const check = code.slice(dash + 1);
    expect(parseRecoveryCode(code.slice(0, dash + 1) + check.toLowerCase().replace("0", "o").replace("1", "l")).mesh).toBe(meshId);
    expect(parseRecoveryCode(code.slice(0, dash + 1) + check.replace("1", "I")).mesh).toBe(meshId);
  });

  it("refuses damaged codes, other meshes and bad inputs", () => {
    const { code } = createMesh();
    const dash = code.lastIndexOf("-");
    expect(() => parseRecoveryCode("hello")).toThrow(/must look like/);
    expect(() => parseRecoveryCode(5 as unknown as string)).toThrow(/must look like/);
    expect(() => parseRecoveryCode("wimrec1_abc")).toThrow(/must look like/);
    expect(() => parseRecoveryCode("wimrec1_-ABCDEFGH")).toThrow(/checksum/);
    const typo = code.slice(0, 20) + (code[20] === "A" ? "B" : "A") + code.slice(21);
    expect(() => parseRecoveryCode(typo)).toThrow(/checksum/);
    expect(() => parseRecoveryCode(code.slice(0, dash + 1) + "ZZZZZZZZ")).toThrow(/checksum/);
    expect(() => parseRecoveryCode(code, b64u.encode(new Uint8Array(16)))).toThrow(/another mesh/);
    expect(() => parseRecoveryCode(withChecksum("***"))).toThrow(/damaged/);
    expect(() => parseRecoveryCode(withChecksum(b64u.encode(utf8("{not json"))))).toThrow(/damaged/);
    expect(() => parseRecoveryCode(withChecksum(b64u.encode(utf8('{"mesh":"x"}'))))).toThrow(/damaged/);
    expect(() => parseRecoveryCode(withChecksum(b64u.encode(new Uint8Array([0xff]))))).toThrow(/damaged/);
    // A code from before the genesis pin existed is refused.
    const old = b64u.encode(canonBytes({ mesh: meshId, sign: b64u.encode(randomBytes(32)), box: b64u.encode(randomBytes(32)) }));
    expect(() => parseRecoveryCode(withChecksum(old))).toThrow(/damaged/);
    const keys = generateDeviceKeys();
    expect(() => recoveryCode(keys, { mesh: "x", genesis: genesisHash })).toThrow(/mesh id/);
    expect(() => recoveryCode(keys, { mesh: meshId, genesis: "x" })).toThrow(/genesis/);
    expect(() => createRecoveryKeys("x")).toThrow(/mesh id/);
    expect(() => createRecoveryKeys(meshId, { name: "backup" })).toThrow(/start with recovery/);
  });
});

describe("verifyRecoveryChain", () => {
  it("accepts the pinned genesis walked to the newest roster", () => {
    const { genesis, code } = createMesh();
    const r2 = nextRoster(genesis, { add: [device("phone").record] }, { keys: parseRecoveryCode(code) }, T0 + 1);
    expect(verifyRecoveryChain(code, [genesis])).toEqual({ ok: true, value: genesis });
    expect(verifyRecoveryChain(code, [genesis, r2])).toEqual({ ok: true, value: r2 });
  });

  it("refuses another genesis, a bad chain, a revoked recovery record and a bad code", () => {
    const { laptop, rec, genesis, code } = createMesh();
    const other = createGenesisRoster({ name: "laptop", keys: laptop, now: T0 + 5, meshId, recovery: rec.record });
    expect(verifyRecoveryChain(code, [other])).toEqual({ ok: false, reason: "recovery_genesis_mismatch" });
    expect(verifyRecoveryChain(code, [])).toEqual({ ok: false, reason: "chain_empty" });
    expect(verifyRecoveryChain(code, "x" as unknown as unknown[])).toEqual({ ok: false, reason: "chain_empty" });
    expect(verifyRecoveryChain(code, [{ seq: 1 }])).toEqual({ ok: false, reason: "roster_malformed" });
    const r2 = nextRoster(genesis, { add: [device("phone").record] }, { keys: laptop }, T0 + 1);
    expect(verifyRecoveryChain(code, [genesis, { ...r2, at: T0 + 2 }])).toEqual({ ok: false, reason: "roster_bad_signature" });
    const revoked = nextRoster(genesis, { revoke: [rec.record.id] }, { keys: laptop }, T0 + 1);
    expect(verifyRecoveryChain(code, [genesis, revoked])).toEqual({ ok: false, reason: "recovery_not_admin" });
    expect(verifyRecoveryChain("nonsense", [genesis])).toEqual({ ok: false, reason: "recovery_code_invalid" });
    // A code whose mesh field disagrees with the genesis it pins.
    const lying = recoveryCode(rec.keys, { mesh: b64u.encode(new Uint8Array(16)), genesis: hash(genesis) });
    expect(verifyRecoveryChain(lying, [genesis])).toEqual({ ok: false, reason: "recovery_wrong_mesh" });
  });
});

describe("recovering a mesh", () => {
  it("lets the recovery identity add a new admin, revoke lost devices, and be rotated", () => {
    const { genesis, rec, code } = createMesh();
    expect(genesis.devices.map((d) => [d.name, d.role])).toEqual([["laptop", "admin"], ["recovery", "admin"]]);
    expect(verifyGenesisRoster(genesis).ok).toBe(true);
    const keys: DeviceKeys = parseRecoveryCode(code, meshId);
    const fresh = device("desktop", "admin", T0 + 1);
    const recovered = nextRoster(genesis, { add: [fresh.record], revoke: [genesis.devices[0]!.id] }, { keys }, T0 + 1);
    expect(verifyNextRoster(genesis, recovered).ok).toBe(true);
    expect(recovered.by).toBe(rec.record.id);
    const next = createRecoveryIdentity(meshId, { name: "recovery-2", now: T0 + 2, genesis: hash(genesis) });
    const rotated = nextRoster(recovered, { add: [next.record], revoke: [rec.record.id] }, fresh, T0 + 2);
    expect(verifyRosterChain({ seq: 1, hash: hash(genesis) }, [genesis, recovered, rotated]).ok).toBe(true);
    expect(findDevice(rotated, "recovery")).toBeUndefined();
    expect(verifyRecoveryChain(next.code, [genesis, recovered, rotated]).ok).toBe(true);
    expect(verifyRecoveryChain(code, [genesis, recovered, rotated])).toEqual({ ok: false, reason: "recovery_not_admin" });
  });

  it("refuses misplaced recovery names", () => {
    const laptop = generateDeviceKeys();
    expect(() => createGenesisRoster({ name: "recovery", keys: laptop, now: T0 })).toThrow(/reserved/);
    expect(() => createGenesisRoster({ name: "laptop", keys: laptop, now: T0, meshId, recovery: device("helper", "admin").record })).toThrow(
      /genesis_bad_devices/,
    );
    const asMember = { ...createRecoveryKeys(meshId).record, role: "member" as const };
    expect(() => createGenesisRoster({ name: "laptop", keys: laptop, now: T0, meshId, recovery: asMember })).toThrow(
      /roster_recovery_not_admin/,
    );
    const genesis = createGenesisRoster({ name: "laptop", keys: laptop, now: T0, meshId });
    expect(() => nextRoster(genesis, { add: [device("recovery-x").record] }, { keys: laptop }, T0)).toThrow(/reserved/);
  });
});

describe("deviceKeysFromSecrets and the random source", () => {
  it("rebuilds keys from secrets and refuses bad lengths", () => {
    const keys = generateDeviceKeys();
    expect(deviceKeysFromSecrets(keys.signSec, keys.boxSec)).toEqual(keys);
    expect(() => deviceKeysFromSecrets(new Uint8Array(31), keys.boxSec)).toThrow(/32-byte/);
    expect(() => deviceKeysFromSecrets(keys.signSec, "x" as unknown as Uint8Array)).toThrow(/32-byte/);
  });

  it("swaps the random source only inside the callback, even when it throws", () => {
    const zeros = (n: number) => new Uint8Array(n);
    expect(withRandomSource(zeros, () => randomBytes(4))).toEqual(new Uint8Array(4));
    expect(() =>
      withRandomSource(zeros, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(randomBytes(16)).not.toEqual(new Uint8Array(16));
  });
});

describe("recoverySummary", () => {
  it("shows the newest roster and every device revoked since genesis, by name", () => {
    const { laptop, genesis } = createMesh();
    const phone = device("phone");
    const r2 = nextRoster(genesis, { add: [phone.record] }, { keys: laptop }, T0 + 1);
    const r3 = nextRoster(r2, { revoke: [phone.id] }, { keys: laptop }, T0 + 2);
    const summary = recoverySummary([genesis, r2, r3]);
    expect(summary).toEqual({
      seq: 3,
      at: T0 + 2,
      devices: r3.devices.map((d) => ({ id: d.id, name: d.name, role: d.role })),
      revoked: [{ id: phone.id, name: "phone" }],
    });
    // A chain that starts after the device was listed has no name for it.
    expect(recoverySummary([r3]).revoked).toEqual([{ id: phone.id, name: "" }]);
    expect(() => recoverySummary([])).toThrow(/empty chain/);
  });
});
