import { describe, expect, it } from "vitest";
import {
  b64u,
  createGenesisRoster,
  detectFork,
  findDevice,
  generateDeviceKeys,
  hash,
  makeDeviceRecord,
  nextRoster,
  rosterRef,
  signObject,
  verifyGenesisRoster,
  verifyNextRoster,
  verifyRosterChain,
  type Roster,
} from "../src/index.ts";
import { clone, device, mesh, T0 } from "./helpers.ts";

/** Re-signs a hand-edited roster with a real key, so only the rule under test is broken. */
function resign(roster: Omit<Roster, "sig"> & { sig?: string }, signSec: Uint8Array): Roster {
  return signObject("roster", roster, signSec) as Roster;
}

describe("genesis", () => {
  it("has seq 1, no prev, one admin who signs it, and a 16-byte mesh id", () => {
    const { admin, chain } = mesh();
    const genesis = chain[0]!;
    expect(genesis).toMatchObject({ seq: 1, prev: null, revoked: [], by: admin.id, at: T0 });
    expect(genesis.devices).toEqual([admin.record]);
    expect(b64u.decode(genesis.mesh)).toHaveLength(16);
    expect(verifyGenesisRoster(genesis)).toEqual({ ok: true, value: genesis });
  });

  it("accepts a chosen mesh id and refuses bad input", () => {
    const keys = generateDeviceKeys();
    const meshId = b64u.encode(new Uint8Array(16).fill(1));
    expect(createGenesisRoster({ name: "a", keys, now: T0, meshId }).mesh).toBe(meshId);
    expect(() => createGenesisRoster({ name: "a", keys, now: T0, meshId: "short" })).toThrow(/mesh id/);
    expect(() => createGenesisRoster({ name: "Bad Name", keys, now: T0 })).toThrow(/makeDeviceRecord/);
  });

  it("verifyGenesisRoster refuses anything but a lone self-signed admin", () => {
    const { admin, members, chain } = mesh(["m1"]);
    const genesis = chain[0]!;
    const m = members[0]!;
    expect(verifyGenesisRoster({ ...genesis, extra: 1 })).toEqual({ ok: false, reason: "roster_malformed" });
    expect(verifyGenesisRoster(chain[1])).toEqual({ ok: false, reason: "genesis_not_first" });
    expect(verifyGenesisRoster(resign({ ...genesis, prev: hash(genesis) }, admin.keys.signSec))).toMatchObject({
      reason: "genesis_not_first",
    });
    const asMember = { ...admin.record, role: "member" as const };
    expect(verifyGenesisRoster(resign({ ...genesis, devices: [asMember] }, admin.keys.signSec))).toMatchObject({
      reason: "genesis_bad_devices",
    });
    expect(verifyGenesisRoster(resign({ ...genesis, devices: [] }, admin.keys.signSec))).toMatchObject({
      reason: "genesis_bad_devices",
    });
    expect(
      verifyGenesisRoster(resign({ ...genesis, devices: [admin.record, m.record] }, admin.keys.signSec)),
    ).toMatchObject({ reason: "genesis_bad_devices" });
    expect(verifyGenesisRoster(resign({ ...genesis, revoked: [m.id] }, admin.keys.signSec))).toMatchObject({
      reason: "genesis_bad_devices",
    });
    const renamed = { ...admin.record, name: "recovery" };
    expect(verifyGenesisRoster(resign({ ...genesis, devices: [renamed] }, admin.keys.signSec))).toMatchObject({
      reason: "genesis_reserved_name",
    });
    expect(verifyGenesisRoster(resign({ ...genesis, by: m.id }, m.keys.signSec))).toMatchObject({
      reason: "genesis_wrong_signer",
    });
    expect(verifyGenesisRoster(resign({ ...genesis }, m.keys.signSec))).toMatchObject({
      reason: "roster_bad_signature",
    });
  });
});

describe("nextRoster and verifyNextRoster", () => {
  it("adds a member and the result verifies", () => {
    const { admin, members, chain } = mesh(["m1"]);
    const [genesis, second] = chain as [Roster, Roster];
    expect(second).toMatchObject({ mesh: genesis.mesh, seq: 2, prev: hash(genesis), by: admin.id });
    expect(second.devices.map((d) => d.name)).toEqual(["admin", "m1"]);
    expect(verifyNextRoster(genesis, second)).toEqual({ ok: true, value: second });
    expect(findDevice(second, "m1")).toEqual(members[0]!.record);
  });

  it("revokes a device, moving its id to revoked", () => {
    const { admin, members, chain } = mesh(["m1", "m2"]);
    const prev = chain.at(-1)!;
    const next = nextRoster(prev, { revoke: [members[0]!.id] }, admin, T0 + 10);
    expect(next.devices.map((d) => d.name)).toEqual(["admin", "m2"]);
    expect(next.revoked).toEqual([members[0]!.id]);
    expect(verifyNextRoster(prev, next).ok).toBe(true);
    expect(findDevice(next, members[0]!.id)).toBeUndefined();
  });

  it("allows an empty update, a new admin, and reusing a revoked device's name", () => {
    const { admin, members, chain } = mesh(["m1"]);
    const empty = nextRoster(chain.at(-1)!, {}, admin, T0 + 10);
    expect(verifyNextRoster(chain.at(-1)!, empty).ok).toBe(true);
    const second = device("admin2", "admin");
    const withAdmin = nextRoster(empty, { add: [second.record] }, admin, T0 + 11);
    // The new admin signs the next roster and revokes the first one.
    const handover = nextRoster(withAdmin, { revoke: [admin.id] }, second, T0 + 12);
    expect(verifyNextRoster(withAdmin, handover).ok).toBe(true);
    const replacement = device("m1");
    const swapped = nextRoster(handover, { revoke: [members[0]!.id], add: [replacement.record] }, second, T0 + 13);
    expect(findDevice(swapped, "m1")).toEqual(replacement.record);
  });

  it("refuses a signer that is not an unrevoked admin", () => {
    const { admin, members, chain } = mesh(["m1"]);
    const prev = chain.at(-1)!;
    const outsider = device("outsider");
    expect(() => nextRoster(prev, {}, members[0]!, T0)).toThrow(/not an unrevoked admin/);
    expect(() => nextRoster(prev, {}, outsider, T0)).toThrow(/not an unrevoked admin/);
    // A roster that lists a device and also revokes it is inconsistent; the signer check still holds.
    const inconsistent = { ...prev, revoked: [admin.id] };
    expect(() => nextRoster(inconsistent, {}, admin, T0)).toThrow(/not an unrevoked admin/);
  });

  it("refuses a revoked admin as signer", () => {
    const { admin, chain } = mesh();
    const second = device("admin2", "admin");
    const r2 = nextRoster(chain[0]!, { add: [second.record] }, admin, T0 + 1);
    const r3 = nextRoster(r2, { revoke: [second.id] }, admin, T0 + 2);
    expect(() => nextRoster(r3, {}, second, T0 + 3)).toThrow(/not an unrevoked admin/);
    const forged = resign({ ...r3, seq: 4, prev: hash(r3), by: second.id }, second.keys.signSec);
    expect(verifyNextRoster(r3, forged)).toEqual({ ok: false, reason: "roster_signer_not_admin" });
  });

  it("refuses duplicate names and ids", () => {
    const { admin, members, chain } = mesh(["m1"]);
    const prev = chain.at(-1)!;
    const sameName = device("m1");
    expect(() => nextRoster(prev, { add: [sameName.record] }, admin, T0)).toThrow(/duplicate device name/);
    expect(() => nextRoster(prev, { add: [members[0]!.record] }, admin, T0)).toThrow(/duplicate device id/);
    const twin = { ...members[0]!.record, name: "twin" };
    expect(() => nextRoster(prev, { add: [twin] }, admin, T0)).toThrow(/duplicate device id/);
    const a = device("same");
    const b = device("same");
    expect(() => nextRoster(prev, { add: [a.record, b.record] }, admin, T0)).toThrow(/duplicate device name/);
    expect(() => nextRoster(prev, { revoke: [members[0]!.id, members[0]!.id] }, admin, T0)).toThrow(
      /duplicate id in revoke/,
    );
  });

  it("refuses re-adding a revoked id, revoking a stranger, and leaving no admin", () => {
    const { admin, members, chain } = mesh(["m1"]);
    const m1 = members[0]!;
    const r = nextRoster(chain.at(-1)!, { revoke: [m1.id] }, admin, T0 + 10);
    expect(() => nextRoster(r, { add: [m1.record] }, admin, T0)).toThrow(/revoked and cannot return/);
    expect(() => nextRoster(chain.at(-1)!, { revoke: [m1.id], add: [m1.record] }, admin, T0)).toThrow(
      /revoked and cannot return/,
    );
    expect(() => nextRoster(r, { revoke: [m1.id] }, admin, T0)).toThrow(/not a current device/);
    expect(() => nextRoster(r, { revoke: [admin.id] }, admin, T0)).toThrow(/no admin/);
  });

  it("refuses malformed device records", () => {
    const { admin, chain } = mesh();
    const prev = chain[0]!;
    const d = device("m1");
    expect(() => nextRoster(prev, { add: [{ ...d.record, name: "Bad" }] }, admin, T0)).toThrow(/invalid device record/);
    const other = generateDeviceKeys();
    const mismatched = { ...d.record, sign: b64u.encode(other.signPub) };
    expect(() => nextRoster(prev, { add: [mismatched] }, admin, T0)).toThrow(/does not match its signing key/);
  });

  it("verifyNextRoster refuses every broken rule with its own reason", () => {
    const { admin, members, chain } = mesh(["m1"]);
    const prev = chain.at(-1)!;
    const m1 = members[0]!;
    const good = nextRoster(prev, { add: [device("m2").record] }, admin, T0 + 10);
    const sign = (r: Omit<Roster, "sig">) => resign(r, admin.keys.signSec);
    const otherMesh = b64u.encode(new Uint8Array(16));
    const stranger = device("x").id;
    const cases: Array<[unknown, string]> = [
      [{ ...good, seq: "3" }, "roster_malformed"],
      [sign({ ...good, mesh: otherMesh }), "roster_wrong_mesh"],
      [sign({ ...good, seq: 4 }), "roster_wrong_seq"],
      [sign({ ...good, seq: prev.seq }), "roster_wrong_seq"],
      [sign({ ...good, prev: hash(chain[0]) }), "roster_wrong_prev"],
      [sign({ ...good, prev: null }), "roster_wrong_prev"],
      [resign({ ...good, by: m1.id }, m1.keys.signSec), "roster_signer_not_admin"],
      [{ ...good, at: good.at + 1 }, "roster_bad_signature"],
      [resign({ ...good }, m1.keys.signSec), "roster_bad_signature"],
      [sign({ ...good, devices: good.devices.filter((d) => d.id !== m1.id) }), "roster_device_dropped"],
      [
        // Demotion is not in wim/1.
        sign({ ...good, devices: good.devices.map((d) => (d.id === admin.id ? { ...d, role: "member" as const } : d)) }),
        "roster_device_changed",
      ],
      [
        // A promotion must change nothing but the role.
        sign({ ...good, devices: good.devices.map((d) => (d.id === m1.id ? { ...d, role: "admin" as const, added: 1 } : d)) }),
        "roster_device_changed",
      ],
      [
        sign({
          ...good,
          devices: good.devices.map((d) => (d.id === m1.id ? { ...d, box: b64u.encode(generateDeviceKeys().boxPub) } : d)),
        }),
        "roster_device_changed",
      ],
      [sign({ ...good, devices: [...good.devices, { ...m1.record }] }), "roster_duplicate_id"],
      [sign({ ...good, devices: [...good.devices, { ...device("m1").record }] }), "roster_duplicate_name"],
      [
        sign({ ...good, devices: good.devices.map((d) => (d.id === m1.id ? { ...d, id: device("x").id } : d)) }),
        "roster_bad_device_id",
      ],
      [sign({ ...good, revoked: [stranger, stranger] }), "roster_duplicate_revoked"],
      [sign({ ...good, revoked: [m1.id] }), "roster_revoked_present"],
      [
        sign({ ...good, devices: good.devices.filter((d) => d.id !== admin.id), revoked: [admin.id] }),
        "roster_no_admin",
      ],
    ];
    for (const [next, reason] of cases) expect(verifyNextRoster(prev, next), reason).toEqual({ ok: false, reason });
  });

  it("refuses undoing a revocation", () => {
    const { admin, members, chain } = mesh(["m1", "m2"]);
    const r1 = nextRoster(chain.at(-1)!, { revoke: [members[0]!.id] }, admin, T0 + 10);
    const r2 = resign({ ...r1, seq: r1.seq + 1, prev: hash(r1), revoked: [] }, admin.keys.signSec);
    expect(verifyNextRoster(r1, r2)).toEqual({ ok: false, reason: "roster_revocation_undone" });
    // Revoking a device, then listing it again with its id gone from revoked, is the same attack.
    const back = resign(
      { ...r1, seq: r1.seq + 1, prev: hash(r1), revoked: [], devices: [...r1.devices, members[0]!.record] },
      admin.keys.signSec,
    );
    expect(verifyNextRoster(r1, back)).toEqual({ ok: false, reason: "roster_revocation_undone" });
  });
});

describe("verifyRosterChain", () => {
  it("walks forward from the pin and returns the newest", () => {
    const { chain } = mesh(["a", "b", "c"]);
    const newest = chain.at(-1)!;
    expect(verifyRosterChain({ seq: 1, hash: hash(chain[0]) }, chain)).toEqual({ ok: true, value: newest });
    expect(verifyRosterChain({ seq: 3, hash: hash(chain[2]) }, chain.slice(2))).toEqual({ ok: true, value: newest });
    expect(verifyRosterChain({ seq: 4, hash: hash(newest) }, [newest])).toEqual({ ok: true, value: newest });
  });

  it("refuses an empty chain, a wrong start, a pin mismatch and a rollback", () => {
    const { chain } = mesh(["a", "b"]);
    const pin = { seq: 2, hash: hash(chain[1]) };
    expect(verifyRosterChain(pin, [])).toEqual({ ok: false, reason: "chain_empty" });
    expect(verifyRosterChain(pin, "x" as unknown as unknown[])).toEqual({ ok: false, reason: "chain_empty" });
    expect(verifyRosterChain(pin, [{}])).toEqual({ ok: false, reason: "roster_malformed" });
    // Rollback: the relay serves an older roster than the client's pin.
    expect(verifyRosterChain(pin, chain)).toEqual({ ok: false, reason: "chain_wrong_start" });
    expect(verifyRosterChain(pin, chain.slice(2))).toEqual({ ok: false, reason: "chain_wrong_start" });
    expect(verifyRosterChain({ seq: 2, hash: hash(chain[0]) }, chain.slice(1))).toEqual({
      ok: false,
      reason: "chain_pin_mismatch",
    });
  });

  it("refuses a chain with a tampered roster in the middle", () => {
    const { chain } = mesh(["a", "b", "c"]);
    const tampered = clone(chain);
    tampered[2]!.devices[2]!.name = "evil";
    expect(verifyRosterChain({ seq: 1, hash: hash(chain[0]) }, tampered)).toEqual({
      ok: false,
      reason: "roster_bad_signature",
    });
    const gap = [chain[0], chain[1], chain[3]];
    expect(verifyRosterChain({ seq: 1, hash: hash(chain[0]) }, gap)).toEqual({ ok: false, reason: "roster_wrong_seq" });
    const forkMesh = mesh(["a"]);
    const spliced = [chain[0], forkMesh.chain[1]];
    expect(verifyRosterChain({ seq: 1, hash: hash(chain[0]) }, spliced)).toMatchObject({ ok: false });
  });
});

describe("findDevice", () => {
  it("finds by id first, then by name", () => {
    const { members, chain } = mesh(["m1"]);
    const roster = chain.at(-1)!;
    const m1 = members[0]!;
    expect(findDevice(roster, m1.id)).toEqual(m1.record);
    expect(findDevice(roster, "m1")).toEqual(m1.record);
    expect(findDevice(roster, "nobody")).toBeUndefined();
  });

  it("makeDeviceRecord refuses a bad name or time", () => {
    const keys = generateDeviceKeys();
    expect(() => makeDeviceRecord("Nope", keys, "member", T0)).toThrow(/makeDeviceRecord/);
    expect(() => makeDeviceRecord("ok", keys, "member", -1)).toThrow(/makeDeviceRecord/);
  });
});

describe("forks and references", () => {
  it("rosterRef is seq plus hash", () => {
    const { chain } = mesh(["a"]);
    expect(rosterRef(chain[1]!)).toEqual({ seq: 2, hash: hash(chain[1]) });
  });

  it("detectFork needs the same mesh and seq with different content", () => {
    const { admin, chain } = mesh();
    const genesis = chain[0]!;
    const a = nextRoster(genesis, { add: [device("x").record] }, admin, T0 + 1);
    const b = nextRoster(genesis, { add: [device("y").record] }, admin, T0 + 1);
    expect(verifyNextRoster(genesis, a).ok && verifyNextRoster(genesis, b).ok).toBe(true);
    expect(detectFork(a, b)).toBe(true);
    expect(detectFork(a, clone(a))).toBe(false);
    expect(detectFork(a, nextRoster(a, {}, admin, T0 + 2))).toBe(false);
    const other = mesh(["x"]).chain[1]!;
    expect(detectFork(a, other)).toBe(false);
  });
});

describe("promotion", () => {
  it("promotes a member to admin, and the new admin can sign", () => {
    const { admin, members, chain } = mesh(["m1", "m2"]);
    const prev = chain.at(-1)!;
    const m1 = members[0]!;
    const next = nextRoster(prev, { promote: [m1.id] }, admin, T0 + 10);
    expect(findDevice(next, m1.id)).toEqual({ ...m1.record, role: "admin" });
    expect(verifyNextRoster(prev, next).ok).toBe(true);
    const after = nextRoster(next, { revoke: [admin.id] }, m1, T0 + 11);
    expect(verifyNextRoster(next, after).ok).toBe(true);
  });

  it("refuses promoting an admin, a stranger, a revoked device or the same id twice", () => {
    const { admin, members, chain } = mesh(["m1"]);
    const prev = chain.at(-1)!;
    const m1 = members[0]!;
    expect(() => nextRoster(prev, { promote: [admin.id] }, admin, T0)).toThrow(/already an admin/);
    expect(() => nextRoster(prev, { promote: [device("x").id] }, admin, T0)).toThrow(/not a current device/);
    expect(() => nextRoster(prev, { promote: [m1.id], revoke: [m1.id] }, admin, T0)).toThrow(/not a current device/);
    expect(() => nextRoster(prev, { promote: [m1.id, m1.id] }, admin, T0)).toThrow(/duplicate id in promote/);
  });
});
