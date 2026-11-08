import { createGenesisRoster, generateDeviceKeys, hash, makeDeviceRecord, nextRoster, rosterRef, type Roster } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addersOf, DEFAULT_BREAKER, MeshFiles, parseMeshConfig, RosterBook, type MeshConfig } from "../src/mesh.ts";
import { FS, RELAY, scratch, rosterSeqs } from "./helpers.ts";

const T = 1_760_000_000_000;

function chain(n: number) {
  const admin = generateDeviceKeys();
  const rosters: Roster[] = [createGenesisRoster({ name: "admin", keys: admin, now: T })];
  for (let i = 2; i <= n; i++) {
    rosters.push(nextRoster(rosters.at(-1)!, { add: [makeDeviceRecord(`d${i}`, generateDeviceKeys(), "member", T)] }, { keys: admin }, T + i));
  }
  return { admin, rosters };
}

function config(r: Roster, extra: Partial<MeshConfig> = {}): MeshConfig {
  return { v: 1, mesh: r.mesh, relay: RELAY, device: r.devices[0]!.id, pin: rosterRef(r), policy: {}, breaker: DEFAULT_BREAKER, share_cards: true, ...extra };
}

async function files(): Promise<MeshFiles> {
  return new MeshFiles(await scratch("mesh"), FS);
}

describe("parseMeshConfig", () => {
  const { rosters } = chain(1);
  const good = config(rosters[0]!);
  it("accepts a good file and fills defaults", () => {
    const c = parseMeshConfig({ ...good, breaker: undefined, policy: { a: "deliver", b: "nonsense", c: "deliver-relayed" }, share_cards: "full", tls: "A".repeat(43) }, "p");
    expect(c.breaker).toEqual(DEFAULT_BREAKER);
    expect(c.policy).toEqual({ a: "deliver", c: "deliver-relayed" });
    expect(c.share_cards).toBe("full");
    expect(c.tls).toBe("A".repeat(43));
    expect(parseMeshConfig({ ...good, share_cards: false, policy: undefined }, "p").share_cards).toBe(false);
    expect(parseMeshConfig({ ...good, fork: { seq: 2, a: "x", b: "y", base: [], at: 1 } }, "p").fork?.seq).toBe(2);
    const b = parseMeshConfig({ ...good, breaker: { perPeerPerHour: 0, totalPerHour: 5, pingPong: false } }, "p").breaker;
    expect(b).toEqual({ perPeerPerHour: 20, totalPerHour: 5, pingPong: false, pingPongExchanges: 8, cooldownMinutes: 10 });
  });
  it("reads the breaker: absent is the new default, a written one is honoured as written", () => {
    // New meshes (and a file with no breaker at all): the limits of 0.1.8 and a 10-minute cool-down.
    expect(DEFAULT_BREAKER).toEqual({ perPeerPerHour: 120, totalPerHour: 300, pingPong: true, pingPongExchanges: 32, cooldownMinutes: 10 });
    expect(parseMeshConfig({ ...good, breaker: undefined }, "p").breaker).toEqual(DEFAULT_BREAKER);
    // The default every earlier version wrote stays in force as written, threshold included (it
    // had none written), and lower limits are never raised (#59 review, F2): only the cool-down is new.
    expect(parseMeshConfig({ ...good, breaker: { perPeerPerHour: 20, totalPerHour: 60, pingPong: true } }, "p").breaker).toEqual({
      perPeerPerHour: 20,
      totalPerHour: 60,
      pingPong: true,
      pingPongExchanges: 8,
      cooldownMinutes: 10,
    });
    expect(parseMeshConfig({ ...good, breaker: { perPeerPerHour: 2, totalPerHour: 60, pingPong: true } }, "p").breaker.perPeerPerHour).toBe(2);
    // A hand-tuned one, as the person wrote it (the #59 workaround among them).
    expect(parseMeshConfig({ ...good, breaker: { perPeerPerHour: 120, totalPerHour: 300, pingPong: false } }, "p").breaker).toEqual({
      perPeerPerHour: 120,
      totalPerHour: 300,
      pingPong: false,
      pingPongExchanges: 8,
      cooldownMinutes: 10,
    });
    expect(parseMeshConfig({ ...good, breaker: { perPeerPerHour: 50, totalPerHour: 90, pingPong: true, pingPongExchanges: 16, cooldownMinutes: 5 } }, "p").breaker).toEqual({
      perPeerPerHour: 50,
      totalPerHour: 90,
      pingPong: true,
      pingPongExchanges: 16,
      cooldownMinutes: 5,
    });
    // A cool-down is at most an hour.
    expect(parseMeshConfig({ ...good, breaker: { cooldownMinutes: 90 } }, "p").breaker.cooldownMinutes).toBe(60);
    // Anything in a written breaker that is missing or not a positive whole number reads as the
    // value files were written with before 0.1.8, never as the higher new default.
    for (const bad of [0, -1, 1.5, "32", Number.MAX_SAFE_INTEGER + 1, null]) {
      expect(parseMeshConfig({ ...good, breaker: { perPeerPerHour: bad, totalPerHour: bad, pingPong: true, pingPongExchanges: bad, cooldownMinutes: bad } }, "p").breaker).toEqual({
        perPeerPerHour: 20,
        totalPerHour: 60,
        pingPong: true,
        pingPongExchanges: 8,
        cooldownMinutes: 10,
      });
    }
    for (const written of [{}, null, "fast", 7]) {
      expect(parseMeshConfig({ ...good, breaker: written }, "p").breaker).toEqual({ perPeerPerHour: 20, totalPerHour: 60, pingPong: true, pingPongExchanges: 8, cooldownMinutes: 10 });
    }
  });
  it("ignores old and unknown breaker keys, never refuses them, and never raises a written limit", () => {
    // A 0.1.9 draft wrote a `trusted` block (its tier for the devices the person trusts, the only
    // ones the breaker counts). It loads; where it is stricter, it is honoured.
    const draft = { perPeerPerHour: 120, totalPerHour: 300, pingPong: true, pingPongExchanges: 32, trusted: { perPeerPerHour: 5, totalPerHour: 400, pingPong: false, pingPongExchanges: 4, cooldownMinutes: 3 } };
    expect(parseMeshConfig({ ...good, breaker: draft }, "p").breaker).toEqual({ perPeerPerHour: 5, totalPerHour: 300, pingPong: true, pingPongExchanges: 4, cooldownMinutes: 3 });
    // A lowered top-level limit stays lowered whatever `trusted` says.
    expect(parseMeshConfig({ ...good, breaker: { perPeerPerHour: 2, totalPerHour: 60, trusted: { perPeerPerHour: 120, totalPerHour: 300 } } }, "p").breaker).toMatchObject({ perPeerPerHour: 2, totalPerHour: 60 });
    // A top-level cool-down wins over one in `trusted`.
    expect(parseMeshConfig({ ...good, breaker: { cooldownMinutes: 7, trusted: { cooldownMinutes: 3 } } }, "p").breaker.cooldownMinutes).toBe(7);
    // A `trusted` that is not an object, or holds nothing usable, changes nothing.
    for (const trusted of ["fast", 7, null, [], { perPeerPerHour: -1, totalPerHour: "5", pingPongExchanges: 1.5, cooldownMinutes: 0 }]) {
      expect(parseMeshConfig({ ...good, breaker: { perPeerPerHour: 20, totalPerHour: 60, pingPong: true, pingPongExchanges: 8, trusted } }, "p").breaker).toEqual({
        perPeerPerHour: 20,
        totalPerHour: 60,
        pingPong: true,
        pingPongExchanges: 8,
        cooldownMinutes: 10,
      });
    }
    // Keys it does not know (a typo, a later version's) are ignored.
    expect(parseMeshConfig({ ...good, breaker: { perPeerPerHour: 3, perPeerPerMinute: 1, autoRelease: false, tiers: { a: 1 } } }, "p").breaker).toEqual({
      perPeerPerHour: 3,
      totalPerHour: 60,
      pingPong: true,
      pingPongExchanges: 8,
      cooldownMinutes: 10,
    });
  });
  it("refuses broken files", () => {
    expect(() => parseMeshConfig(null, "p")).toThrow(/not a mesh file/);
    expect(() => parseMeshConfig({ ...good, v: 2 }, "p")).toThrow(/not a mesh file/);
    expect(() => parseMeshConfig({ ...good, mesh: 1 }, "p")).toThrow(/mesh or device/);
    expect(() => parseMeshConfig({ ...good, relay: "ws://example.com" }, "p")).toThrow(/relay/);
    expect(() => parseMeshConfig({ ...good, pin: undefined }, "p")).toThrow(/pin/);
    expect(() => parseMeshConfig({ ...good, tls: "short" }, "p")).toThrow(/tls/);
  });
});

describe("MeshFiles", () => {
  it("stores rosters and config, and reports missing ones", async () => {
    const f = await files();
    await expect(f.loadConfig()).rejects.toThrow(/does not exist/);
    const { rosters } = chain(2);
    await f.createConfig(config(rosters[1]!), rosters);
    expect(await rosterSeqs(f)).toEqual([1, 2]);
    expect(await f.loadRoster(3)).toBeUndefined();
    await fs.writeFile(join(f.rostersDir, "3.json"), "{}");
    await expect(f.loadRoster(3)).rejects.toThrow(/not a roster/);
    const c = await f.updateConfig((x) => ({ ...x, policy: { z: "refuse" } }));
    expect(c.policy).toEqual({ z: "refuse" });
    for (const p of [f.invitesDir, f.seenPath, f.seqPath, f.leaseNamesPath, f.keysDir, f.rosterLock]) expect(p.startsWith(f.dir)).toBe(true);
  });
});

describe("RosterBook", () => {
  it("opens at the pin and refuses a pin that does not match", async () => {
    const f = await files();
    const { rosters } = chain(2);
    await f.createConfig(config(rosters[0]!), rosters.slice(0, 1));
    const book = await RosterBook.open(f);
    expect(book.current.seq).toBe(1);
    expect(book.ref.hash).toBe(hash(rosters[0]));
    expect(book.fork).toBeUndefined();
    await f.updateConfig((c) => ({ ...c, pin: { seq: 1, hash: "x" } }));
    await expect(RosterBook.open(f)).rejects.toThrow(/does not match/);
    await f.updateConfig((c) => ({ ...c, pin: { seq: 5, hash: "x" } }));
    await expect(RosterBook.open(f)).rejects.toThrow(/missing/);
  });

  it("walks forward, ignores what it has, refuses gaps, bad successors and mismatches", async () => {
    const f = await files();
    const { rosters, admin } = chain(4);
    await f.createConfig(config(rosters[0]!), rosters.slice(0, 1));
    const book = await RosterBook.open(f);
    expect(await book.accept([rosters[2]!])).toEqual({ ok: false, reason: "gap" });
    expect(await book.accept(rosters.slice(0, 2))).toEqual({ ok: true, advanced: true });
    expect((await f.loadConfig()).pin.seq).toBe(2);
    expect(await book.accept(rosters.slice(0, 2))).toEqual({ ok: true, advanced: false });
    const other = chain(1).rosters[0]!;
    expect(await book.accept([{ ...rosters[2]!, sig: other.sig }])).toMatchObject({ ok: false, reason: "roster_bad_signature" });
    // A different roster 1 that is not valid proves nothing.
    expect(await book.accept([{ ...rosters[0]!, at: 5 }])).toEqual({ ok: false, reason: "roster_mismatch" });
    // An older entry this device never stored is skipped.
    await fs.rm(join(f.rostersDir, "1.json"));
    expect(await book.accept([rosters[0]!, rosters[1]!, rosters[2]!])).toEqual({ ok: true, advanced: true });
    // The pin in mesh.json never moves back.
    await f.updateConfig((c) => ({ ...c, pin: rosterRef(rosters[3]!) }));
    await f.saveRoster(rosters[3]!);
    await book.accept([rosters[2]!]);
    expect((await f.loadConfig()).pin.seq).toBe(4);
    void admin;
  });

  it("catches up from rosters other processes pinned", async () => {
    const f = await files();
    const { rosters } = chain(3);
    await f.createConfig(config(rosters[0]!), rosters.slice(0, 1));
    const book = await RosterBook.open(f);
    await book.reload();
    expect(book.current.seq).toBe(1);
    await f.saveRoster(rosters[1]!);
    await f.updateConfig((c) => ({ ...c, pin: rosterRef(rosters[2]!) }));
    await book.reload();
    expect(book.current.seq).toBe(2);
    await f.saveRoster(rosters[2]!);
    await book.reload();
    expect(book.current.seq).toBe(3);
  });

  it("detects a fork, records evidence, and accepts nothing more", async () => {
    const f = await files();
    const { rosters, admin } = chain(2);
    await f.createConfig(config(rosters[1]!), rosters);
    const book = await RosterBook.open(f);
    const rival = nextRoster(rosters[0]!, { add: [makeDeviceRecord("rival", generateDeviceKeys(), "member", T)] }, { keys: admin }, T + 9);
    const result = await book.accept([rival]);
    expect(result).toMatchObject({ ok: false, reason: "forked" });
    expect(book.fork?.seq).toBe(2);
    expect(book.fork?.base).toEqual([rosters[0]!.devices[0]!.id]);
    expect((await f.loadConfig()).fork?.seq).toBe(2);
    expect(await fs.readFile(join(f.rostersDir, "fork-2.json"), "utf8")).toContain("rival");
    expect(await book.accept([rosters[1]!])).toEqual({ ok: false, reason: "forked" });
    await book.reload();
    expect(book.fork?.seq).toBe(2);
  });

  it("detects a fork at genesis and in an older stored roster", async () => {
    const f = await files();
    const { rosters, admin } = chain(3);
    await f.createConfig(config(rosters[2]!), rosters);
    const book = await RosterBook.open(f);
    const rival = nextRoster(rosters[0]!, { add: [makeDeviceRecord("rival", generateDeviceKeys(), "member", T)] }, { keys: admin }, T + 9);
    expect(await book.accept([rival])).toMatchObject({ ok: false, reason: "forked" });

    const g = await files();
    await g.createConfig(config(rosters[0]!), rosters.slice(0, 1));
    const gbook = await RosterBook.open(g);
    const otherGenesis = createGenesisRoster({ name: "admin", keys: admin, now: T + 1, meshId: rosters[0]!.mesh });
    expect(await gbook.accept([otherGenesis])).toMatchObject({ ok: false, reason: "forked" });
  });

  it("cannot prove a fork without the predecessor", async () => {
    const f = await files();
    const { rosters, admin } = chain(2);
    await f.createConfig(config(rosters[1]!), rosters.slice(1));
    const book = await RosterBook.open(f);
    const rival = nextRoster(rosters[0]!, { add: [makeDeviceRecord("rival", generateDeviceKeys(), "member", T)] }, { keys: admin }, T + 9);
    expect(await book.accept([rival])).toEqual({ ok: false, reason: "roster_mismatch" });
  });
});

describe("addersOf", () => {
  /** admin adds d2 and d3, promotes d2, which adds d5; d3 is revoked by then. */
  function mixed() {
    const { admin, rosters } = chain(3);
    const d2 = generateDeviceKeys();
    const r2 = nextRoster(rosters[0]!, { add: [makeDeviceRecord("d2", d2, "member", T)] }, { keys: admin }, T + 2);
    const r3 = nextRoster(r2, { add: [makeDeviceRecord("d3", generateDeviceKeys(), "member", T)] }, { keys: admin }, T + 3);
    const id2 = r2.devices[1]!.id;
    const id3 = r3.devices[2]!.id;
    const r4 = nextRoster(r3, { promote: [id2], revoke: [id3] }, { keys: admin }, T + 4);
    const r5 = nextRoster(r4, { add: [makeDeviceRecord("d5", generateDeviceKeys(), "member", T)] }, { keys: d2 }, T + 5);
    return { all: [rosters[0]!, r2, r3, r4, r5], id2, id5: r5.devices.at(-1)!.id, adminId: rosters[0]!.devices[0]!.id };
  }

  it("names the signer of the roster that added each device, never one for the genesis's", async () => {
    const { all, id2, id5, adminId } = mixed();
    const f = await files();
    for (const r of all) await f.saveRoster(r);
    const map = await addersOf(f, all.at(-1)!);
    expect(map.get(id2)).toEqual({ id: adminId, name: "admin" });
    expect(map.get(id5)).toEqual({ id: id2, name: "d2" });
    expect(map.has(adminId)).toBe(false);
    expect(await addersOf(f, all[0]!)).toEqual(new Map());
  });

  it("stops at a roster that is missing, unreadable, or not the one the next follows", async () => {
    const { all, id2, id5 } = mixed();
    const head = all.at(-1)!;
    const save = async (skip: (seq: number) => Roster | "missing" | "junk" | undefined) => {
      const f = await files();
      for (const r of all) {
        const instead = skip(r.seq);
        if (instead === "missing") continue;
        if (instead === "junk") await fs.mkdir(f.rostersDir, { recursive: true }).then(() => fs.writeFile(join(f.rostersDir, `${r.seq}.json`), "{}"));
        else await f.saveRoster(instead ?? r);
      }
      return addersOf(f, head);
    };
    // Only the chain from the pin on: d2 was added before it, d5 after.
    const missing = await save((seq) => (seq < 4 ? "missing" : undefined));
    expect([missing.has(id2), missing.get(id5)?.name]).toEqual([false, "d2"]);
    expect((await save((seq) => (seq === 4 ? "junk" : undefined))).size).toBe(0);
    // Another roster at seq 4 (not the one seq 5 follows, by its hash): the walk ends there.
    expect((await save((seq) => (seq === 4 ? { ...all[3]!, at: T + 99 } : undefined))).size).toBe(0);
  });
});
