import { x25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { hpkeOpenAuth } from "../src/hpke.ts";
import {
  b64u,
  canonBytes,
  createPrekey,
  LIMITS,
  nextRoster,
  openMessage,
  prekeyDeleteAt,
  prekeyId,
  sealMessage,
  sha256,
  signObject,
  ulid,
  utf8,
  verifyPrekey,
  type Prekey,
  type PrekeyBox,
  type Roster,
  type SendFrame,
} from "../src/index.ts";
import { device, mesh, T0, type Device } from "./helpers.ts";

const HOUR = 3600_000;
const { admin, members, chain } = mesh(["laptop", "server"]);
const [laptop, server] = members as [Device, Device];
const roster = chain.at(-1)!;
const laptopSid = ulid();
const serverSid = ulid();

type Held = { prekey: Prekey; secret: Uint8Array };
const make = (d: Device, at = T0 - HOUR): Held => createPrekey({ mesh: roster.mesh, deviceId: d.id, signSec: d.keys.signSec, at });

function seal(over: Partial<Parameters<typeof sealMessage>[0]> = {}): SendFrame {
  return sealMessage({
    roster,
    sender: { deviceId: laptop.id, keys: laptop.keys },
    session: "writer",
    sid: laptopSid,
    to: ["reviewer@server"],
    seq: 1,
    at: T0,
    text: "hello",
    recipients: [server.id],
    ...over,
  });
}

/** A receiving session of `me` whose device still holds the secrets in `held`. */
function open(frame: unknown, me: Device, held: Held[], over: { now?: number; legacy?: boolean; history?: boolean; roster?: Roster } = {}) {
  const lookup = (id: string): Uint8Array | undefined => held.find((h) => h.prekey.id === id)?.secret;
  return openMessage(frame, {
    roster: over.roster ?? roster,
    me: { deviceId: me.id, keys: me.keys, address: `reviewer@${me.name}`, sid: serverSid, rooms: [], prekey: lookup },
    now: over.now ?? T0,
    ...(over.history === undefined ? {} : { history: over.history }),
    ...(over.legacy === undefined ? {} : { legacy: over.legacy }),
  });
}

describe("createPrekey", () => {
  it("signs a 48-hour prekey whose id derives from its key", () => {
    const { prekey, secret } = make(server, T0);
    expect(prekey).toMatchObject({ mesh: roster.mesh, device: server.id, at: T0, until: T0 + LIMITS.prekeyLifetimeMs });
    expect(prekey.pub).toBe(b64u.encode(x25519.getPublicKey(secret)));
    expect(prekey.id).toBe(prekeyId(x25519.getPublicKey(secret)));
    expect(verifyPrekey(prekey, roster, T0)).toEqual({ ok: true, value: prekey });
    expect(prekeyDeleteAt(prekey)).toBe(T0 + 120 * HOUR);
    // Every prekey is new: the secret never repeats.
    expect(make(server, T0).prekey.id).not.toBe(prekey.id);
  });

  it("refuses a device id that is not the signing key's", () => {
    expect(() => createPrekey({ mesh: roster.mesh, deviceId: laptop.id, signSec: server.keys.signSec, at: T0 })).toThrow(/does not match/);
  });
});

describe("verifyPrekey (hostile prekeys)", () => {
  const good = make(server).prekey;
  const resign = (over: Partial<Prekey>, by = server) => signObject("prekey", { ...good, ...over }, by.keys.signSec) as Prekey;

  it("refuses each kind of bad prekey with its reason", () => {
    const rec = device("recovery", "admin");
    const withRec = nextRoster(roster, { add: [rec.record] }, admin, T0 + 100);
    const recPk = createPrekey({ mesh: roster.mesh, deviceId: rec.id, signSec: rec.keys.signSec, at: T0 }).prekey;
    const revoked = nextRoster(roster, { revoke: [server.id] }, admin, T0 + 100);
    const stranger = device("stranger");
    const strangerPk = createPrekey({ mesh: roster.mesh, deviceId: stranger.id, signSec: stranger.keys.signSec, at: T0 }).prekey;
    // A low-order point, signed properly and with a matching id: refused by its key alone.
    const low = new Uint8Array(32);
    const lowPk = resign({ pub: b64u.encode(low), id: prekeyId(low) });
    const other = make(laptop).prekey;
    const cases: Array<[unknown, Roster, number, string]> = [
      [{ ...good, extra: 1 }, roster, T0, "malformed"],
      ["not a prekey", roster, T0, "malformed"],
      [{ ...good, mesh: b64u.encode(new Uint8Array(16)) }, roster, T0, "wrong_mesh"],
      [good, revoked, T0, "revoked_device"],
      [strangerPk, roster, T0, "unknown_device"],
      [recPk, withRec, T0, "recovery_device"],
      [{ ...good, id: other.id }, roster, T0, "bad_id"],
      [{ ...good, pub: other.pub, id: other.id }, roster, T0, "bad_signature"],
      // Forged: a valid signature, but by another member's key.
      [resign({}, laptop), roster, T0, "bad_signature"],
      [resign({ until: good.at }), roster, T0, "bad_window"],
      [resign({ until: good.at + LIMITS.prekeyLifetimeMs + 1 }), roster, T0, "bad_window"],
      [lowPk, roster, T0, "bad_key"],
      [good, roster, good.at - LIMITS.messageMaxFutureMs - 1, "not_yet"],
      [good, roster, good.until - LIMITS.prekeySendMarginMs, "expired"],
    ];
    for (const [pk, r, now, reason] of cases) expect(verifyPrekey(pk, r, now), reason).toEqual({ ok: false, reason });
    // The edges that are still fine.
    expect(verifyPrekey(good, roster, good.at - LIMITS.messageMaxFutureMs).ok).toBe(true);
    expect(verifyPrekey(good, roster, good.until - LIMITS.prekeySendMarginMs - 1).ok).toBe(true);
  });
});

describe("scheme 2 boxes", () => {
  const serverPk = make(server);
  const laptopPk = make(laptop);

  it("seals to the recipient's prekey and carries the sender's own prekey as pk", () => {
    const frame = seal({ prekeys: { [server.id]: serverPk.prekey }, prekey: laptopPk.prekey });
    const box = frame.boxes[server.id] as PrekeyBox;
    expect(box).toMatchObject({ s: 2, p: serverPk.prekey.id });
    expect(Object.keys(box).sort()).toEqual(["c", "e", "p", "s"]);
    expect(frame.pk).toEqual(laptopPk.prekey);
    expect(open(frame, server, [serverPk])).toMatchObject({ ok: true, value: { text: "hello" } });
    // A fresh ephemeral per box: sealing the same message twice gives different e and c.
    const again = seal({ prekeys: { [server.id]: serverPk.prekey } });
    expect((again.boxes[server.id] as PrekeyBox).e).not.toBe(box.e);
  });

  it("sibling sessions on one device all open the same box, as often as asked (stateless)", () => {
    const frame = seal({ prekeys: { [server.id]: serverPk.prekey } });
    const first = open(frame, server, [serverPk]);
    const sibling = openMessage(frame, {
      roster,
      me: { deviceId: server.id, keys: server.keys, address: "other@server", sid: ulid(), prekey: (id) => (id === serverPk.prekey.id ? serverPk.secret : undefined) },
      now: T0,
    });
    expect(first.ok).toBe(true);
    expect(sibling).toMatchObject({ ok: false, reason: "not_addressed" });
    const broadcast = seal({ to: ["*"], recipients: roster.devices.map((d) => d.id), prekeys: { [server.id]: serverPk.prekey } });
    for (const address of ["a@server", "b@server", "c@server"]) {
      const r = openMessage(broadcast, { roster, me: { deviceId: server.id, keys: server.keys, address, sid: ulid(), prekey: () => serverPk.secret }, now: T0 });
      expect(r).toMatchObject({ ok: true, value: { text: "hello" } });
    }
    // Repeat opens (redelivery, a restarted session) give the same plaintext.
    expect(open(frame, server, [serverPk])).toEqual(first);
  });

  it("a deleted or unknown prekey fails as key_expired, a wrong one as decrypt_failed", () => {
    const frame = seal({ prekeys: { [server.id]: serverPk.prekey } });
    expect(open(frame, server, [])).toEqual({ ok: false, reason: "key_expired" });
    expect(openMessage(frame, { roster, me: { deviceId: server.id, keys: server.keys, address: "reviewer@server", sid: serverSid }, now: T0 })).toEqual({ ok: false, reason: "key_expired" });
    // The device holds a secret under that id, but not the right one.
    const wrong = { prekey: serverPk.prekey, secret: make(server).secret };
    expect(open(frame, server, [wrong])).toEqual({ ok: false, reason: "decrypt_failed" });
    // History reads fail the same way: older than this device keeps keys.
    expect(open(frame, server, [], { history: true, now: T0 + 30 * 24 * HOUR })).toEqual({ ok: false, reason: "key_expired" });
  });

  it("binds the box to the sender's roster box key, the pair, the prekey and the header", () => {
    const frame = seal({ prekeys: { [server.id]: serverPk.prekey } });
    const box = frame.boxes[server.id] as PrekeyBox;
    const resign = (f: object) => signObject("send", f, laptop.keys.signSec) as SendFrame;
    // A box re-sealed by another member's static key under laptop's name cannot exist with a
    // valid signature, but even the raw HPKE refuses a sender other than the roster's.
    const info = utf8(`wim/1 box2 ${roster.mesh} ${laptop.id} ${server.id} ${serverPk.prekey.id}`);
    const { boxes: _b, sig: _s, ...header } = frame;
    const aad = sha256(canonBytes(header));
    const raw = { enc: b64u.decode(box.e), skR: serverPk.secret, info, aad, ciphertext: b64u.decode(box.c) };
    expect(hpkeOpenAuth({ ...raw, pkS: laptop.keys.boxPub })).toBeInstanceOf(Uint8Array);
    expect(() => hpkeOpenAuth({ ...raw, pkS: admin.keys.boxPub })).toThrow();
    expect(() => hpkeOpenAuth({ ...raw, pkS: laptop.keys.boxPub, info: utf8(`wim/1 box2 ${roster.mesh} ${laptop.id} ${admin.id} ${serverPk.prekey.id}`) })).toThrow();
    expect(open(resign({ ...frame, seq: 2 }), server, [serverPk])).toEqual({ ok: false, reason: "decrypt_failed" });
    const other = make(server);
    expect(open(resign({ ...frame, boxes: { [server.id]: { ...box, p: other.prekey.id } } }), server, [serverPk, other])).toEqual({ ok: false, reason: "decrypt_failed" });
  });

  it("refuses prekeys a sender must not use", () => {
    const stale = make(server, T0 - LIMITS.prekeyLifetimeMs);
    expect(() => seal({ prekeys: { [server.id]: stale.prekey } })).toThrow(/prekey for .* is not usable \(expired\)/);
    expect(() => seal({ prekeys: { [server.id]: laptopPk.prekey } })).toThrow(/another device's/);
    expect(() => seal({ prekey: serverPk.prekey })).toThrow(/sender's prekey is not usable \(another device's\)/);
    expect(() => seal({ prekey: make(laptop, T0 - LIMITS.prekeyLifetimeMs).prekey })).toThrow(/sender's prekey is not usable \(expired\)/);
    // A recipient prekey that was forged (signed by another member) is refused too.
    const forged = signObject("prekey", { ...serverPk.prekey }, laptop.keys.signSec) as Prekey;
    expect(() => seal({ prekeys: { [server.id]: forged } })).toThrow(/bad_signature/);
  });
});

describe("the migration window (scheme 1 boxes)", () => {
  const serverPk = make(server);
  const laptopPk = make(laptop);

  it("v0.1 boxes still open while the window is open, and are refused once it closes", () => {
    const legacy = seal();
    expect(Object.keys(legacy.boxes[server.id]!).sort()).toEqual(["c", "n"]);
    expect(open(legacy, server, [])).toMatchObject({ ok: true, value: { text: "hello" } });
    expect(open(legacy, server, [], { legacy: false })).toEqual({ ok: false, reason: "legacy_box" });
  });

  it("mixes schemes per device while the window is open", () => {
    const all = roster.devices.map((d) => d.id);
    const frame = seal({ to: ["*"], recipients: all, prekeys: { [server.id]: serverPk.prekey } });
    expect((frame.boxes[server.id] as PrekeyBox).s).toBe(2);
    expect(Object.keys(frame.boxes[admin.id]!).sort()).toEqual(["c", "n"]);
    expect(open(frame, admin, [])).toMatchObject({ ok: true });
  });

  it("with legacy: false, a group send skips devices without a prekey and a direct send refuses", () => {
    const all = roster.devices.map((d) => d.id);
    const frame = seal({ to: ["*"], recipients: all, legacy: false, prekeys: { [server.id]: serverPk.prekey, [laptop.id]: laptopPk.prekey } });
    expect(Object.keys(frame.boxes).sort()).toEqual([laptop.id, server.id].sort());
    expect(() => seal({ legacy: false })).toThrow(/no current prekey for/);
    expect(() => seal({ to: ["*"], recipients: all, legacy: false })).toThrow(/no device to seal to/);
    expect(open(seal({ legacy: false, prekeys: { [server.id]: serverPk.prekey } }), server, [serverPk], { legacy: false })).toMatchObject({ ok: true });
  });
});

describe("retention covers the room history, and no more", () => {
  it("a box sealed at the last moment a sender may use a prekey opens for the whole 72-hour history", () => {
    const pk = make(server, T0);
    const lastSeal = pk.prekey.until - LIMITS.prekeySendMarginMs - 1;
    expect(verifyPrekey(pk.prekey, roster, lastSeal).ok).toBe(true);
    const frame = seal({ at: lastSeal, prekeys: { [server.id]: pk.prekey } });
    // The room history keeps an entry 72 hours (relay branch feat/relay-history-72h); the queue 24.
    const history = 72 * HOUR;
    expect(LIMITS.prekeyRetentionMs).toBeGreaterThanOrEqual(history);
    expect(LIMITS.prekeyRetentionMs).toBeGreaterThanOrEqual(LIMITS.queueLifetimeMs);
    expect(prekeyDeleteAt(pk.prekey) - lastSeal).toBeGreaterThanOrEqual(history);
    expect(open(frame, server, [pk], { history: true, now: lastSeal + history })).toMatchObject({ ok: true, value: { text: "hello" } });
    // A box sealed with the prekey when new is readable at most validity + retention: 120 hours.
    expect(prekeyDeleteAt(pk.prekey) - pk.prekey.at).toBe(LIMITS.prekeyLifetimeMs + LIMITS.prekeyRetentionMs);
    expect(LIMITS.prekeyLifetimeMs + LIMITS.prekeyRetentionMs).toBe(120 * HOUR);
  });
});

describe("a stolen key file opens nothing older than the retention", () => {
  it("traffic sealed to a deleted prekey stays closed to every key the thief holds", () => {
    // Day 0: laptop sends to server under server's prekey of the day; the relay (or anyone on
    // the path) records the frame.
    const day0 = make(server, T0 - HOUR);
    const recorded = seal({ prekeys: { [server.id]: day0.prekey }, text: "the day-0 plan" });
    // Within the retention the device itself still reads it (queue, history).
    expect(open(recorded, server, [day0], { history: true, now: T0 + 24 * HOUR })).toMatchObject({ ok: true, value: { text: "the day-0 plan" } });

    // Server rotates daily and deletes each secret at `until` + 72 hours (`at` + 120 hours).
    const later = [23, 47, 71, 95, 119].map((h) => make(server, T0 + h * HOUR));
    const theftAt = prekeyDeleteAt(day0.prekey) + 1;
    const kept = [day0, ...later].filter((h) => prekeyDeleteAt(h.prekey) > theftAt);
    expect(kept).not.toContain(day0);

    // The thief copies the whole key file now: the static keys and every prekey secret still kept.
    const stolen = { keys: server.keys, prekeys: kept };
    expect(open(recorded, server, stolen.prekeys, { history: true, now: theftAt })).toEqual({ ok: false, reason: "key_expired" });
    // Brute force with every secret in the file, under the box's own prekey id, fails too.
    const box = recorded.boxes[server.id] as PrekeyBox;
    // The sender's key file, stolen as well, adds nothing: the ephemeral secret is gone.
    for (const secret of [stolen.keys.boxSec, laptop.keys.boxSec, ...stolen.prekeys.map((h) => h.secret)]) {
      expect(open(recorded, server, [{ prekey: day0.prekey, secret }], { history: true, now: theftAt })).toEqual({ ok: false, reason: "decrypt_failed" });
    }
    expect(box.s).toBe(2);
  });
});
