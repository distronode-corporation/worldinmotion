// The keyring variants (SPEC section 3): the same frames and checks as the key-holding functions,
// with the secret-key operations behind an interface a signer process can implement.

import { describe, expect, it } from "vitest";
import {
  b64u,
  createGenesisRoster,
  createGenesisRosterWith,
  createInvite,
  createJoin,
  createJoinWith,
  createPrekey,
  hash,
  localKeyring,
  nextRoster,
  nextRosterWith,
  openBox,
  openMessage,
  openMessageWith,
  parseInvite,
  randomBytes,
  sealBox,
  sealMessage,
  sealMessageWith,
  signAuth,
  signAuthWith,
  signObject,
  signObjectWith,
  ulid,
  utf8,
  verifyAuth,
  verifyGenesisRoster,
  verifyJoin,
  verifyNextRoster,
  type Keyring,
  type OpenRequest,
} from "../src/index.ts";
import { device, mesh, T0, type Device } from "./helpers.ts";

const HOUR = 3600_000;
const { admin, members, chain } = mesh(["laptop", "server"]);
const [laptop, server] = members as [Device, Device];
const roster = chain.at(-1)!;
const serverPk = createPrekey({ mesh: roster.mesh, deviceId: server.id, signSec: server.keys.signSec, at: T0 - HOUR });
const laptopPk = createPrekey({ mesh: roster.mesh, deviceId: laptop.id, signSec: laptop.keys.signSec, at: T0 - HOUR });
const held = (id: string): Uint8Array | undefined => (id === serverPk.prekey.id ? serverPk.secret : undefined);

const base = { roster, session: "writer", sid: ulid(), to: ["reviewer@server"], seq: 1, at: T0, text: "hello", recipients: [server.id] };
const receiver = { deviceId: server.id, address: "reviewer@server", sid: ulid() };

describe("localKeyring", () => {
  it("signs exactly as signObject and exposes the public keys", async () => {
    const ring = localKeyring(laptop.keys);
    expect(ring.signPub).toBe(laptop.keys.signPub);
    expect(ring.boxPub).toBe(laptop.keys.boxPub);
    const obj = { a: 1, b: "two" };
    expect(await ring.sign("send", obj)).toBe(signObject("send", obj, laptop.keys.signSec).sig);
  });

  it("seals and opens both schemes, and reports a missing prekey or a bad box", async () => {
    const req = { mesh: roster.mesh, sender: laptop.id, recipient: server.id, aad: utf8("aad"), recipientBox: server.keys.boxPub, plaintext: utf8("hi") };
    const one = await localKeyring(laptop.keys).seal(req);
    const two = await localKeyring(laptop.keys).seal({ ...req, prekey: { id: serverPk.prekey.id, pub: b64u.decode(serverPk.prekey.pub) } });
    expect("s" in one).toBe(false);
    expect(two).toMatchObject({ s: 2, p: serverPk.prekey.id });
    const open = (box: OpenRequest["box"], ring: Keyring = localKeyring(server.keys, held)) =>
      ring.open({ mesh: roster.mesh, sender: laptop.id, recipient: server.id, aad: utf8("aad"), senderBox: laptop.keys.boxPub, box });
    expect(await open(one)).toEqual(utf8("hi"));
    expect(await open(two)).toEqual(utf8("hi"));
    // No prekey lookup given: a scheme 2 box reads as for a deleted prekey.
    expect(await open(two, localKeyring(server.keys))).toBe("key_expired");
    expect(await open({ ...one, c: b64u.encode(randomBytes(20)) })).toBe("decrypt_failed");
    expect(await open({ ...two, e: "!" })).toBe("decrypt_failed");
  });

  it("openBox without the device's box secret opens scheme 2 only", () => {
    const req = { mesh: roster.mesh, sender: laptop.id, recipient: server.id, aad: utf8("x"), recipientBox: server.keys.boxPub, plaintext: utf8("p") };
    const one = sealBox(laptop.keys.boxSec, req);
    const two = sealBox(laptop.keys.boxSec, { ...req, prekey: { id: serverPk.prekey.id, pub: b64u.decode(serverPk.prekey.pub) } });
    const open = { mesh: roster.mesh, sender: laptop.id, recipient: server.id, aad: utf8("x"), senderBox: laptop.keys.boxPub };
    expect(openBox(undefined, held, { ...open, box: one })).toBe("decrypt_failed");
    expect(openBox(undefined, held, { ...open, box: two })).toEqual(utf8("p"));
  });

  it("signObjectWith replaces an existing sig", async () => {
    const signed = await signObjectWith("roster", { x: 1, sig: "old" }, localKeyring(admin.keys));
    expect(signed).toEqual(signObject("roster", { x: 1 }, admin.keys.signSec));
  });
});

describe("sealMessageWith and openMessageWith", () => {
  it("make and read the same frames as the key-holding functions", async () => {
    const frame = await sealMessageWith({ ...base, sender: { deviceId: laptop.id, keyring: localKeyring(laptop.keys) }, prekeys: { [server.id]: serverPk.prekey }, prekey: laptopPk.prekey });
    const legacy = await sealMessageWith({ ...base, sender: { deviceId: laptop.id, keyring: localKeyring(laptop.keys) } });
    for (const f of [frame, legacy]) {
      expect(openMessage(f, { roster, me: { ...receiver, keys: server.keys, prekey: held }, now: T0 })).toMatchObject({ ok: true, value: { text: "hello" } });
    }
    const sync = sealMessage({ ...base, sender: { deviceId: laptop.id, keys: laptop.keys }, prekeys: { [server.id]: serverPk.prekey } });
    const opened = await openMessageWith(sync, { roster, me: { ...receiver, keyring: localKeyring(server.keys, held) }, now: T0 });
    expect(opened).toMatchObject({ ok: true, value: { text: "hello" } });
  });

  it("refuse as the key-holding functions do, with the same errors", async () => {
    const wrong = { deviceId: server.id, keyring: localKeyring(laptop.keys) };
    await expect(sealMessageWith({ ...base, sender: wrong })).rejects.toThrow(/^sealMessage: sender.deviceId does not match/);
    const big = await sealMessageWith({ ...base, kind: "card", to: ["*"], text: undefined, card: { cwd: "x".repeat(512) }, recipients: roster.devices.map((d) => d.id), sender: { deviceId: laptop.id, keyring: localKeyring(laptop.keys) } });
    expect(big.seq).toBe(0);
    // A keyring that returns a signature the frame schema refuses.
    const badSig: Keyring = { ...localKeyring(laptop.keys), sign: async () => "short" };
    await expect(sealMessageWith({ ...base, sender: { deviceId: laptop.id, keyring: badSig } })).rejects.toThrow(/^sealMessage: sig/);
  });

  it("checks before decrypting, and decrypts nothing that fails a check", async () => {
    let asked = 0;
    const counting: Pick<Keyring, "open"> = {
      open: async (req) => {
        asked++;
        return localKeyring(server.keys, held).open(req);
      },
    };
    const frame = sealMessage({ ...base, sender: { deviceId: laptop.id, keys: laptop.keys } });
    const elsewhere = await openMessageWith(frame, { roster, me: { ...receiver, address: "other@server", keyring: counting }, now: T0 });
    expect(elsewhere).toEqual({ ok: false, reason: "not_addressed" });
    const closed = await openMessageWith(frame, { roster, me: { ...receiver, keyring: counting }, now: T0, legacy: false });
    expect(closed).toEqual({ ok: false, reason: "legacy_box" });
    expect(asked).toBe(0);
  });

  it("maps what the keyring says, and passes a keyring failure on rather than dropping the frame", async () => {
    const frame = sealMessage({ ...base, sender: { deviceId: laptop.id, keys: laptop.keys } });
    const answer = (opened: Awaited<ReturnType<Keyring["open"]>>) => openMessageWith(frame, { roster, me: { ...receiver, keyring: { open: async () => opened } }, now: T0 });
    expect(await answer("key_expired")).toEqual({ ok: false, reason: "key_expired" });
    expect(await answer("decrypt_failed")).toEqual({ ok: false, reason: "decrypt_failed" });
    // Bytes that are not UTF-8 never passed an honest seal.
    expect(await answer(Uint8Array.of(0xff, 0xfe))).toEqual({ ok: false, reason: "decrypt_failed" });
    expect(await answer(utf8("{}"))).toEqual({ ok: false, reason: "plaintext_malformed" });
    const gone = openMessageWith(frame, { roster, me: { ...receiver, keyring: { open: async () => Promise.reject(new Error("the signer is locked")) } }, now: T0 });
    await expect(gone).rejects.toThrow(/locked/);
  });
});

describe("the builders' keyring variants", () => {
  const ring = localKeyring(admin.keys);

  it("signAuthWith gives the frame signAuth gives", async () => {
    const fields = { relay: "wss://relay.example", mesh: roster.mesh, nonce: b64u.encode(randomBytes(32)), at: T0, session: { name: "a", kind: "cli", sid: ulid(), resume: b64u.encode(randomBytes(32)) }, pin: { seq: 1, hash: hash(chain[0]) } };
    const frame = await signAuthWith(fields, ring);
    expect(frame).toEqual(signAuth(fields, admin.keys));
    expect(verifyAuth(frame, admin.keys.signPub, { relay: fields.relay, nonce: fields.nonce, now: T0 }).ok).toBe(true);
    await expect(signAuthWith({ ...fields, device: laptop.id }, ring)).rejects.toThrow(/device does not match/);
    await expect(signAuthWith({ ...fields, at: -1 }, ring)).rejects.toThrow(/^signAuth: at/);
  });

  it("createGenesisRosterWith and nextRosterWith give verifying rosters", async () => {
    const genesis = await createGenesisRosterWith({ name: "admin", keyring: ring, now: T0 });
    expect(genesis).toEqual(createGenesisRoster({ name: "admin", keys: admin.keys, now: T0, meshId: genesis.mesh }));
    expect(verifyGenesisRoster(genesis).ok).toBe(true);
    const other = device("other");
    const next = await nextRosterWith(genesis, { add: [other.record] }, ring, T0 + 1);
    expect(next).toEqual(nextRoster(genesis, { add: [other.record] }, { keys: admin.keys }, T0 + 1));
    expect(verifyNextRoster(genesis, next).ok).toBe(true);
    await expect(nextRosterWith(genesis, {}, localKeyring(other.keys), T0)).rejects.toThrow(/not an unrevoked admin/);
    // A keyring whose signature does not verify never yields a genesis roster.
    await expect(createGenesisRosterWith({ name: "admin", keyring: { ...ring, sign: async () => b64u.encode(new Uint8Array(64)) }, now: T0 })).rejects.toThrow(/^createGenesisRoster: /);
  });

  it("createJoinWith gives the frame createJoin gives", async () => {
    const invite = parseInvite(createInvite({ relay: "wss://relay.example", mesh: roster.mesh, pin: { seq: 1, hash: hash(chain[0]) }, now: T0 }).code);
    const joiner = device("joiner");
    const nonce = b64u.encode(randomBytes(32));
    const frame = await createJoinWith(invite, "joiner", localKeyring(joiner.keys), nonce);
    expect(frame).toEqual(createJoin(invite, "joiner", joiner.keys, nonce));
    expect(verifyJoin(frame, invite.secret, nonce).ok).toBe(true);
  });
});
