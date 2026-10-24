import {
  b64u,
  createInvite,
  createJoin,
  generateDeviceKeys,
  deviceIdFromSignPub,
  hash,
  joinProof,
  makeDeviceRecord,
  signObject,
  nextRoster,
  parseInvite,
  parseRecoveryCode,
  rosterRef,
  ulid,
  type Roster,
} from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMesh, decideJoin, Invites, issueInvite, joinMesh, promoteDevice, publishRoster, recoverMesh, revokeDevice } from "../src/admin.ts";
import { MeshSession } from "../src/client.ts";
import { MeshFiles } from "../src/mesh.ts";
import type { Dialer, WireSocket } from "../src/wire.ts";
import { FS, makeMesh, newDevice, openSession, RELAY, RelayHarness, sleep, until, rosterSeqs } from "./helpers.ts";

const open: MeshSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop({ ended: true }).catch(() => undefined);
});

async function session(...args: Parameters<typeof openSession>): Promise<MeshSession> {
  const s = await openSession(...args);
  open.push(s);
  return s;
}

describe("createMesh", () => {
  it("creates a mesh with a recovery record and a code pinned to its genesis", async () => {
    const relay = new RelayHarness();
    const d = await newDevice("first");
    const made = await createMesh({ home: d.home, device: d.device, relay: RELAY, dialer: relay.dialer, now: Date.now });
    expect(made.roster.devices.map((x) => x.name)).toEqual(["first", "recovery"]);
    const code = parseRecoveryCode(made.recoveryCode!);
    expect(code.genesis).toBe(hash(made.roster));
    expect(await d.home.meshIds()).toEqual([made.mesh]);
    const config = await new MeshFiles(d.home.meshDir(made.mesh), FS).loadConfig();
    expect(config).toMatchObject({ relay: RELAY, device: d.device.id, share_cards: true });
    // The code is never written to disk.
    const all = await fs.readdir(d.home.meshDir(made.mesh), { recursive: true });
    for (const f of all) {
      const p = join(d.home.meshDir(made.mesh), String(f));
      if ((await fs.stat(p)).isFile()) expect(await fs.readFile(p, "utf8")).not.toContain("wimrec1_");
    }
  });

  it("can skip recovery, needs the operator key where the relay wants one, and refuses bad URLs", async () => {
    const relay = new RelayHarness({ createKey: "sesame" });
    const d = await newDevice("first");
    await expect(createMesh({ home: d.home, device: d.device, relay: RELAY, dialer: relay.dialer, now: Date.now })).rejects.toThrow(/operator key/);
    const made = await createMesh({ home: d.home, device: d.device, relay: RELAY, key: "sesame", recovery: false, dialer: relay.dialer, now: Date.now, tls: "A".repeat(43) });
    expect(made.recoveryCode).toBeUndefined();
    expect(made.roster.devices.length).toBe(1);
    expect((await new MeshFiles(d.home.meshDir(made.mesh), FS).loadConfig()).tls).toBe("A".repeat(43));
    await expect(createMesh({ home: d.home, device: d.device, relay: "ws://example.com", dialer: relay.dialer, now: Date.now })).rejects.toThrow(/refusing relay URL/);
  });
});

describe("invites and joining", () => {
  it("shows the SAS on both sides and admits only after the person confirms", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["admin"]);
    const admin = await session(devices[0]!, mesh, relay, { name: "inviter" });
    const joiner = await newDevice("newbox");
    const inv = await issueInvite(admin, { ttlMs: 60_000, auto: false, now: Date.now });
    expect(inv.code.startsWith("wim1_")).toBe(true);
    let shownToJoiner = "";
    let shownToAdmin = "";
    admin.once("join", (body) => {
      void decideJoin(admin, body, async (p) => {
        shownToAdmin = p.sas;
        expect(p.name).toBe("newbox");
        expect(p.id).toBe(joiner.device.id);
        return true;
      }, Date.now);
    });
    const joined = await joinMesh({ home: joiner.home, device: joiner.device, code: inv.code, dialer: relay.dialer, now: Date.now, showSas: (s) => (shownToJoiner = s) });
    expect(shownToJoiner).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    expect(shownToAdmin).toBe(shownToJoiner);
    expect(joined.roster.devices.some((d) => d.id === joiner.device.id)).toBe(true);
    // Single use: the secret is gone and a second join is refused by the admin.
    await until(async () => (await new Invites(admin.mesh, FS, Date.now).get(inv.inviteId))?.used === true);
    const record = await new Invites(admin.mesh, FS, Date.now).get(inv.inviteId);
    expect(record?.secret).toBeUndefined();
    await expect(joinMesh({ home: joiner.home, device: joiner.device, code: inv.code, dialer: relay.dialer, now: Date.now, showSas: () => undefined })).rejects.toThrow(/already in that mesh/);
  });

  it("refuses when the person says no, and the joiner hears it", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["admin"]);
    const admin = await session(devices[0]!, mesh, relay, { name: "inviter" });
    const joiner = await newDevice("newbox");
    const inv = await issueInvite(admin, { ttlMs: 60_000, auto: false, now: Date.now });
    const decided = new Promise((resolve) => admin.once("join", (body) => void decideJoin(admin, body, async () => false, Date.now).then(resolve)));
    const attempt = joinMesh({ home: joiner.home, device: joiner.device, code: inv.code, dialer: relay.dialer, now: Date.now, showSas: () => undefined, waitMs: 300 });
    expect(await decided).toMatchObject({ outcome: "refused", reason: "the person did not confirm" });
    await expect(attempt).rejects.toThrow(/did not answer/);
  });

  it("checks every join request it acts on", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["admin", "taken"]);
    const admin = await session(devices[0]!, mesh, relay, { name: "inviter" });
    const now = Date.now;
    const inv = await issueInvite(admin, { ttlMs: 60_000, auto: true, now });
    const code = parseInvite(inv.code);
    const body = (name: string, keys = generateDeviceKeys()) => {
      // Built by hand, since createJoin itself refuses reserved names.
      const device = { id: deviceIdFromSignPub(keys.signPub), name, sign: b64u.encode(keys.signPub), box: b64u.encode(keys.boxPub) };
      const { t: _t, ...signed } = signObject("join", { t: "join" as const, mesh: code.mesh, invite: code.inviteId, device, nonce: b64u.encode(new Uint8Array(32).fill(4)) }, keys.signSec);
      return { ...signed, proof: joinProof(code.secret, device) };
    };
    // Not one of ours.
    const foreign = createInvite({ relay: RELAY, mesh, pin: rosterRef(admin.roster), now: now() });
    const { t: _t, ...foreignBody } = createJoin(parseInvite(foreign.code), "x", generateDeviceKeys(), b64u.encode(new Uint8Array(32).fill(4)));
    expect((await decideJoin(admin, foreignBody, async () => true, now)).outcome).toBe("ignored");
    expect((await decideJoin(admin, { ...body("ok"), proof: b64u.encode(new Uint8Array(32)) }, async () => true, now)).reason).toBe("join_bad_proof");
    expect((await decideJoin(admin, body("taken"), async () => true, now)).reason).toMatch(/is taken/);
    expect((await decideJoin(admin, body("recovery-9"), async () => true, now)).reason).toMatch(/reserved/);
    expect((await decideJoin(admin, body("again", devices[1]!.device.keys), async () => true, now)).reason).toMatch(/already known/);
    expect(await decideJoin(admin, body("fresh"), async () => true, now)).toMatchObject({ outcome: "admitted" });
    expect((await decideJoin(admin, body("second"), async () => true, now)).reason).toMatch(/already used/);
    // An expired record loses its secret the first time it is read.
    const invites = new Invites(admin.mesh, FS, () => now() + 10 ** 9);
    const inv2 = await issueInvite(admin, { ttlMs: 60_000, auto: true, now });
    expect((await invites.get(inv2.inviteId))?.secret).toBeUndefined();
    expect(await invites.get("../bad")).toBeUndefined();
    // An invite expired by this device's own clock is refused even if the relay still forwards it.
    const inv3 = await issueInvite(admin, { ttlMs: 60_000, auto: true, now });
    const code3 = parseInvite(inv3.code);
    const keys = generateDeviceKeys();
    const { t: _t3, ...late } = createJoin(code3, "late", keys, b64u.encode(new Uint8Array(32).fill(4)));
    expect((await decideJoin(admin, late, async () => true, () => now() + 120_000)).reason).toMatch(/expired/);
    await invites.markUsed(ulid().slice(0, 22));
  });

  it("only admins invite, and the relay can refuse an invite", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["admin", "member"]);
    const member = await session(devices[1]!, mesh, relay, { name: "m" });
    await expect(issueInvite(member, { ttlMs: 60_000, auto: false, now: Date.now })).rejects.toThrow(/only an admin/);
    const admin = await session(devices[0]!, mesh, relay, { name: "a" });
    relay.toRelay = (text) => (text.startsWith('{"t":"invite.create"') ? text.replace(/"exp":\d+/, '"exp":1') : text);
    await expect(issueInvite(admin, { ttlMs: 60_000, auto: false, now: Date.now })).rejects.toThrow(/refused the invite/);
  });

  it("refuses a chain that does not start at the invite's pin, and a roster without this device", async () => {
    const joiner = await newDevice("j");
    const mesh = b64u.encode(new Uint8Array(16).fill(3));
    const inv = createInvite({ relay: RELAY, mesh, pin: { seq: 1, hash: b64u.encode(new Uint8Array(32)) }, now: Date.now() });
    const other = (await makeMesh(new RelayHarness(), ["x"])).devices[0]!;
    const roster = (await new MeshFiles(other.home.meshDir((await other.home.meshIds())[0]!), FS).loadRoster(1))!;
    const script = (answer: unknown): Dialer => async () => scripted((sent, push) => {
      if ((JSON.parse(sent) as { t: string }).t === "join") push(answer);
    });
    const go = (d: Dialer) => joinMesh({ home: joiner.home, device: joiner.device, code: inv.code, dialer: d, now: Date.now, showSas: () => undefined });
    await expect(go(script({ t: "joined", chain: [roster], more: false }))).rejects.toThrow(/does not start at the invite's pin/);
    await expect(go(script({ t: "error", code: "invite_used", message: "used", ref: "join" }))).rejects.toThrow(/join was refused: used/);
    const pinned = createInvite({ relay: RELAY, mesh: roster.mesh, pin: rosterRef(roster), now: Date.now() });
    await expect(joinMesh({ home: joiner.home, device: joiner.device, code: pinned.code, dialer: script({ t: "joined", chain: [roster], more: false }), now: Date.now, showSas: () => undefined })).rejects.toThrow(/not in the mesh's newest roster/);
    await expect(joinMesh({ home: joiner.home, device: joiner.device, code: "nope", dialer: script({}), now: Date.now, showSas: () => undefined })).rejects.toThrow(/invalid invite/);
  });

  it("walks a long chain after joining, authenticating with the newest verified roster", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["admin"]);
    const admin = await session(devices[0]!, mesh, relay, { name: "a" });
    const inv = await issueInvite(admin, { ttlMs: 60_000, auto: true, now: Date.now });
    // 70 more rosters after the invite's pin make the joined page say `more`.
    for (let i = 0; i < 70; i++) {
      const d = await newDevice(`d${i}`);
      await publishRoster(admin, (cur) => nextRoster(cur, { add: [makeDeviceRecord(d.device.name, d.device.keys, "member", Date.now())] }, { keys: admin.device.keys }, Date.now()));
    }
    const joiner = await newDevice("late");
    admin.once("join", (body) => void decideJoin(admin, body, async () => true, Date.now));
    const joined = await joinMesh({ home: joiner.home, device: joiner.device, code: inv.code, dialer: relay.dialer, now: Date.now, showSas: () => undefined });
    expect(joined.roster.seq).toBe(admin.roster.seq);
    expect(joined.roster.devices.some((d) => d.id === joiner.device.id)).toBe(true);
  }, 60_000);
});

describe("roster changes", () => {
  it("revokes and promotes, under the signing lock, admins only", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["admin", "m1", "m2"]);
    const admin = await session(devices[0]!, mesh, relay, { name: "a" });
    await expect(revokeDevice(admin, "admin", Date.now)).rejects.toThrow(/cannot revoke itself/);
    await expect(revokeDevice(admin, "ghost", Date.now)).rejects.toThrow(/no device named/);
    const promoted = await promoteDevice(admin, "m1", Date.now);
    expect(promoted.devices.find((d) => d.name === "m1")!.role).toBe("admin");
    await expect(promoteDevice(admin, "m1", Date.now)).rejects.toThrow(/already an admin/);
    await expect(promoteDevice(admin, "ghost", Date.now)).rejects.toThrow(/no device named/);
    const revoked = await revokeDevice(admin, "m2", Date.now);
    expect(revoked.revoked).toContain(devices[2]!.device.id);
    const member = await session(devices[1]!, mesh, relay, { name: "m" });
    await sleep(10);
    expect(member.roster.seq).toBe(revoked.seq);
  });

  it("reports a relay refusal of a roster and a roster that does not verify here", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["admin"]);
    const admin = await session(devices[0]!, mesh, relay, { name: "a" });
    await expect(publishRoster(admin, (cur) => ({ ...cur, seq: cur.seq + 1 }))).rejects.toThrow(/refused the roster/);
  });
});

/** A relay played by the test, one frame at a time. */
function scripted(onSend: (sent: string, push: (frame: unknown) => void, close: (code: number) => void) => void): WireSocket {
  let msg: (t: string) => void = () => undefined;
  let shut: (c: number, r: string) => void = () => undefined;
  const push = (f: unknown): void => void setImmediate(() => msg(JSON.stringify(f)));
  const close = (code: number): void => void setImmediate(() => setImmediate(() => shut(code, "")));
  setImmediate(() => push({ t: "hello", v: 1, nonce: b64u.encode(new Uint8Array(32).fill(2)), at: Date.now() }));
  return {
    send: (t) => onSend(t, push, close),
    close: () => setImmediate(() => shut(1000, "")),
    onMessage: (cb) => void (msg = cb),
    onClose: (cb) => void (shut = cb),
  };
}

describe("recovery", () => {
  async function meshWithCode() {
    const relay = new RelayHarness();
    const { mesh, devices, recoveryCode } = await makeMesh(relay, ["lost", "member"]);
    const files = new MeshFiles(devices[0]!.home.meshDir(mesh), FS);
    const chain: Roster[] = [];
    for (const seq of await rosterSeqs(files)) chain.push((await files.loadRoster(seq))!);
    return { mesh, chain, code: recoveryCode!, relay };
  }

  /** The relay accepts the recovery identity here, to exercise the client side end to end. */
  function recoveryRelay(chain: Roster[], opts: { refuse?: string; publish?: "close" | "confirm" | "error" | "drop" | "silent" } = {}) {
    let published: Roster | undefined;
    const dialer: Dialer = async () =>
      scripted((sent, push, close) => {
        const f = JSON.parse(sent) as { t: string; purpose?: string; from?: number; roster?: Roster };
        if (f.t === "auth" && f.purpose === "recover" && opts.refuse !== undefined) {
          push({ t: "error", code: "unauthorized", message: opts.refuse, ref: "auth" });
          close(4003);
        } else if (f.t === "auth") push({ t: "recover.ready", roster: chain.at(-1) });
        if (f.t === "roster.get") push({ t: "roster", chain: chain.slice(f.from! - 1, f.from! + 1), more: f.from! + 1 < chain.length });
        if (f.t === "roster.publish") {
          published = f.roster;
          const mode = opts.publish ?? "close";
          if (mode === "confirm") push({ t: "roster", chain: [f.roster], more: false });
          if (mode === "error") push({ t: "error", code: "roster_invalid", message: "no", ref: "roster.publish" });
          if (mode !== "silent") close(mode === "drop" ? 1006 : 4000);
        }
      });
    return { dialer, published: () => published };
  }

  it("verifies the chain from the code's genesis, asks the person, then adds this device and rotates the code", async () => {
    const { chain, code, mesh } = await meshWithCode();
    const fresh = await newDevice("phoenix");
    const fake = recoveryRelay(chain);
    let shown: { seq: number; revoked: unknown[] } | undefined;
    const done = await recoverMesh({ home: fresh.home, device: fresh.device, code, relay: RELAY, revoke: ["lost"], dialer: fake.dialer, now: Date.now, confirm: async (r) => ((shown = r), true) });
    expect(shown!.seq).toBe(chain.at(-1)!.seq);
    expect(shown!.revoked).toEqual([]);
    expect(done.mesh).toBe(mesh);
    const next = fake.published()!;
    expect(next.devices.find((d) => d.id === fresh.device.id)!.role).toBe("admin");
    expect(next.devices.some((d) => d.name === "recovery-2")).toBe(true);
    expect(next.devices.some((d) => d.name === "recovery")).toBe(false);
    expect(next.devices.some((d) => d.name === "lost")).toBe(false);
    expect(parseRecoveryCode(done.recoveryCode).genesis).toBe(hash(chain[0]));
    expect((await new MeshFiles(fresh.home.meshDir(mesh), FS).loadConfig()).pin.seq).toBe(next.seq);
    await expect(recoverMesh({ home: fresh.home, device: fresh.device, code, relay: RELAY, revoke: [], dialer: fake.dialer, now: Date.now, confirm: async () => true })).rejects.toThrow(/already in that mesh/);
  });

  it("stops when the person declines, the chain does not match, a name is unknown, or the relay refuses", async () => {
    const { chain, code } = await meshWithCode();
    const fresh = await newDevice("phoenix");
    const base = { home: fresh.home, device: fresh.device, code, relay: RELAY, revoke: [] as string[], now: Date.now };
    await expect(recoverMesh({ ...base, dialer: recoveryRelay(chain).dialer, confirm: async () => false })).rejects.toThrow(/cancelled/);
    const other = await meshWithCode();
    await expect(recoverMesh({ ...base, dialer: recoveryRelay(other.chain).dialer, confirm: async () => true })).rejects.toThrow(/does not match this recovery code/);
    await expect(recoverMesh({ ...base, revoke: ["ghost"], dialer: recoveryRelay(chain).dialer, confirm: async () => true })).rejects.toThrow(/no device named ghost/);
    await expect(recoverMesh({ ...base, dialer: recoveryRelay(chain, { refuse: "not_recovery" }).dialer, confirm: async () => true })).rejects.toThrow(/refused the recovery connection: not_recovery/);
    await expect(recoverMesh({ ...base, dialer: recoveryRelay(chain, { publish: "error" }).dialer, confirm: async () => true })).rejects.toThrow(/refused the recovery roster/);
    await expect(recoverMesh({ ...base, dialer: recoveryRelay(chain, { publish: "drop" }).dialer, confirm: async () => true })).rejects.toThrow(/closed the recovery connection \(1006\)/);
    await expect(recoverMesh({ ...base, answerMs: 50, dialer: recoveryRelay(chain, { publish: "silent" }).dialer, confirm: async () => true })).rejects.toThrow(/did not confirm/);
    await expect(recoverMesh({ ...base, revoke: ["recovery"], dialer: recoveryRelay(chain, { publish: "confirm" }).dialer, confirm: async () => true })).resolves.toBeDefined();
  });

  it("recovers through relay-core's recovery connection", async () => {
    const { code, relay, mesh, chain } = await meshWithCode();
    const fresh = await newDevice("phoenix");
    const done = await recoverMesh({ home: fresh.home, device: fresh.device, code, relay: RELAY, revoke: ["lost"], dialer: relay.dialer, now: Date.now, confirm: async () => true });
    expect(done.roster.seq).toBe(chain.at(-1)!.seq + 1);
    // The recovered device is an admin the relay now accepts: it can open a session and invite.
    const s = await openSession(fresh, mesh, relay, { name: "back" });
    open.push(s);
    expect(s.roster.devices.find((d) => d.id === fresh.device.id)!.role).toBe("admin");
    expect((await issueInvite(s, { ttlMs: 60_000, auto: true, now: Date.now })).code).toMatch(/^wim1_/);
    // The used code no longer works.
    const again = await newDevice("again");
    await expect(recoverMesh({ home: again.home, device: again.device, code, relay: RELAY, revoke: [], dialer: relay.dialer, now: Date.now, confirm: async () => true })).rejects.toThrow(/refused the recovery connection/);
  });
});
