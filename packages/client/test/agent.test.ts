// The signer's answers, apart from any socket: what it signs, seals and opens, what it refuses,
// its rate limit and its lock. Every clock here is driven by hand.

import {
  b64u,
  createPrekey,
  deviceIdFromSignPub,
  generateDeviceKeys,
  LIMITS,
  openBox,
  randomBytes,
  sealBox,
  signObject,
  utf8,
  verifyObject,
  type Box,
  type DeviceKeys,
} from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentError, AgentLog, Signer, TokenBucket, type LogEntry } from "../src/agent.ts";
import { ed25519Public, helloBytes } from "../src/signer.ts";
import { openPrekeySecret, sealKeyFile, sealPrekeySecret, type SealedKeyFile, type Unlocked } from "../src/vault.ts";
import { scratch } from "./helpers.ts";
import { verify } from "node:crypto";

const KDF = { N: 1024, r: 8, p: 1 };
const T = 1_760_000_000_000;
const MESH = b64u.encode(randomBytes(16));

async function fixture(keys: DeviceKeys = generateDeviceKeys()): Promise<{ file: SealedKeyFile; unlocked: () => Unlocked; keys: DeviceKeys; data: Uint8Array }> {
  const data = randomBytes(32);
  const file = await sealKeyFile({ name: "laptop", keys, passphrase: "pass phrase", data, kdf: KDF });
  // Copies, so a lock that zeroes them leaves the test's own keys intact.
  const unlocked = (): Unlocked => ({ keys: { signPub: keys.signPub, boxPub: keys.boxPub, signSec: keys.signSec.slice(), boxSec: keys.boxSec.slice() }, data: data.slice() });
  return { file, unlocked, keys, data };
}

type Made = Awaited<ReturnType<typeof fixture>> & { signer: Signer; log: LogEntry[]; clock: { now: number } };

async function made(over: Partial<ConstructorParameters<typeof Signer>[0]> = {}): Promise<Made> {
  const f = await fixture();
  const log: LogEntry[] = [];
  const clock = { now: T };
  const signer = new Signer({ file: f.file, unlocked: f.unlocked(), now: () => clock.now, pid: 42, log: (e) => log.push(e), ...over });
  return { ...f, signer, log, clock };
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (error) {
    return (error as AgentError).code;
  }
};

describe("TokenBucket", () => {
  it("allows a burst, then refills at its rate", () => {
    let now = 0;
    const b = new TokenBucket(10, 3, () => now);
    expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false]);
    now += 100;
    expect([b.take(), b.take()]).toEqual([true, false]);
    now += 10_000;
    expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false]);
  });
});

describe("AgentLog", () => {
  it("appends JSON lines, moves the file aside past its size, and never throws", async () => {
    const dir = await scratch("log");
    const path = join(dir, "log.jsonl");
    const log = new AgentLog(path, 120);
    log.write({ at: 1, op: "sign", ok: true, type: "send" });
    await log.flushed();
    expect(JSON.parse(await fs.readFile(path, "utf8"))).toEqual({ at: 1, op: "sign", ok: true, type: "send" });
    for (let i = 0; i < 4; i++) log.write({ at: i, op: "open", ok: false, code: "refused" });
    await log.flushed();
    expect((await fs.readFile(`${path}.1`, "utf8")).length).toBeGreaterThan(120);
    // A log that cannot be written (here: its path is a directory) is skipped, not fatal.
    const broken = new AgentLog(dir);
    broken.write({ at: 1, op: "x", ok: true });
    await expect(broken.flushed()).resolves.toBeUndefined();
  });
});

describe("Signer", () => {
  it("proves it holds the signing key in hello, and says nothing it cannot prove when locked", async () => {
    const m = await made();
    const nonce = randomBytes(32);
    const hello = await m.signer.handle("hello", { nonce: b64u.encode(nonce) });
    expect(hello).toMatchObject({ id: m.file.id, name: "laptop", signPub: m.file.signPub, locked: false, pid: 42 });
    expect(verify(null, helloBytes(nonce), ed25519Public(m.keys.signPub), b64u.decode(hello["proof"] as string))).toBe(true);
    m.signer.lock();
    m.signer.lock();
    const locked = await m.signer.handle("hello", { nonce: b64u.encode(nonce) });
    expect(locked["locked"]).toBe(true);
    expect(locked["proof"]).toBeUndefined();
  });

  it("signs exactly what signObject signs, for this device's objects only, and never a prekey", async () => {
    const m = await made();
    const me = m.file.id;
    const objects: Array<[string, Record<string, unknown>]> = [
      ["auth", { t: "auth", mesh: MESH, device: me, nonce: "n" }],
      ["roster", { mesh: MESH, seq: 2, by: me }],
      ["send", { mesh: MESH, from: { device: me, session: "a", sid: "s" }, sig: "old" }],
      ["join", { t: "join", mesh: MESH, device: { id: me } }],
    ];
    for (const [type, obj] of objects) {
      const r = await m.signer.handle("sign", { type, obj });
      expect(r["sig"]).toBe(signObject(type as "auth", obj, m.keys.signSec).sig);
    }
    expect(m.log.filter((e) => e.op === "sign").map((e) => [e.type, e.mesh, e.ok])).toEqual(objects.map(([t]) => [t, MESH, true]));
    const other = deviceIdFromSignPub(generateDeviceKeys().signPub);
    expect(await code(m.signer.handle("sign", { type: "prekey", obj: { device: me } }))).toBe("refused");
    expect(await code(m.signer.handle("sign", { type: "auth", obj: { device: other } }))).toBe("refused");
    expect(await code(m.signer.handle("sign", { type: "send", obj: {} }))).toBe("refused");
    expect(await code(m.signer.handle("sign", { type: "join", obj: {} }))).toBe("refused");
    expect(await code(m.signer.handle("sign", { type: "blob", obj: {} }))).toBe("bad_request");
    // An object of this device with no mesh is signed, and logged without one.
    await m.signer.handle("sign", { type: "auth", obj: { device: me } });
    expect(m.log.at(-1)).toMatchObject({ op: "sign", ok: true, type: "auth" });
    expect(m.log.at(-1)!.mesh).toBeUndefined();
  });

  it("seals boxes from this device only, both schemes", async () => {
    const m = await made();
    const peer = generateDeviceKeys();
    const peerId = deviceIdFromSignPub(peer.signPub);
    const pk = createPrekey({ mesh: MESH, deviceId: peerId, signSec: peer.signSec, at: T });
    const aad = randomBytes(32);
    const base = { mesh: MESH, sender: m.file.id, recipient: peerId, aad: b64u.encode(aad), recipientBox: b64u.encode(peer.boxPub), plaintext: b64u.encode(utf8("hi")) };
    const one = (await m.signer.handle("seal", base))["box"] as Box;
    const two = (await m.signer.handle("seal", { ...base, prekey: { id: pk.prekey.id, pub: pk.prekey.pub } }))["box"] as Box;
    const req = { mesh: MESH, sender: m.file.id, recipient: peerId, aad, senderBox: m.keys.boxPub };
    expect(openBox(peer.boxSec, () => undefined, { ...req, box: one })).toEqual(utf8("hi"));
    expect(openBox(undefined, () => pk.secret, { ...req, box: two })).toEqual(utf8("hi"));
    expect(m.log.at(-1)).toMatchObject({ op: "seal", ok: true, mesh: MESH, peer: peerId });
    expect(await code(m.signer.handle("seal", { ...base, sender: peerId }))).toBe("refused");
    // A low-order recipient key makes the box code throw: a bad request, not a crash.
    expect(await code(m.signer.handle("seal", { ...base, recipientBox: b64u.encode(new Uint8Array(32)) }))).toBe("bad_request");
  });

  it("opens scheme 1 boxes with the device key, and scheme 2 boxes with a sealed prekey it made", async () => {
    const m = await made();
    const peer = generateDeviceKeys();
    const peerId = deviceIdFromSignPub(peer.signPub);
    const aad = randomBytes(32);
    const made2 = await m.signer.handle("prekey", { mesh: MESH, at: T });
    const entry = { prekey: made2["prekey"] as never as ReturnType<typeof createPrekey>["prekey"], sealed: made2["sealed"] as string };
    expect(verifyObject("prekey", entry.prekey, m.keys.signPub)).toBe(true);
    expect(openPrekeySecret(m.data, entry.prekey, entry.sealed)).toHaveLength(32);
    const seal = { mesh: MESH, sender: peerId, recipient: m.file.id, aad, recipientBox: m.keys.boxPub, plaintext: utf8("yo") };
    const one = sealBox(peer.boxSec, seal);
    const two = sealBox(peer.boxSec, { ...seal, prekey: { id: entry.prekey.id, pub: b64u.decode(entry.prekey.pub) } });
    const req = { mesh: MESH, sender: peerId, recipient: m.file.id, aad: b64u.encode(aad), senderBox: b64u.encode(peer.boxPub) };
    expect(await m.signer.handle("open", { ...req, box: one })).toEqual({ opened: b64u.encode(utf8("yo")) });
    expect(await m.signer.handle("open", { ...req, box: two })).toEqual({ reason: "key_expired" });
    expect(await m.signer.handle("open2", { ...req, box: two, entry })).toEqual({ opened: b64u.encode(utf8("yo")) });
    expect(await m.signer.handle("open", { ...req, box: { ...one, c: b64u.encode(randomBytes(30)) } })).toEqual({ reason: "decrypt_failed" });
    expect(await code(m.signer.handle("open", { ...req, recipient: peerId, box: one }))).toBe("refused");
    // open2 refuses what the deletion schedule, the prekey or the seal rule out.
    expect(await m.signer.handle("open2", { ...req, box: one, entry })).toEqual({ reason: "decrypt_failed" });
    expect(await m.signer.handle("open2", { ...req, box: { ...two, p: "x".repeat(22) }, entry })).toEqual({ reason: "decrypt_failed" });
    expect(await m.signer.handle("open2", { ...req, box: two, entry: { ...entry, sealed: "AAAA" } })).toEqual({ reason: "decrypt_failed" });
    const foreign = createPrekey({ mesh: MESH, deviceId: peerId, signSec: peer.signSec, at: T });
    expect(await m.signer.handle("open2", { ...req, box: two, entry: { prekey: foreign.prekey, sealed: entry.sealed } })).toEqual({ reason: "key_expired" });
    m.clock.now = entry.prekey.until + LIMITS.prekeyRetentionMs;
    expect(await m.signer.handle("open2", { ...req, box: two, entry })).toEqual({ reason: "key_expired" });
  });

  it("seals a clear prekey secret of this device's own (adopt), and nothing else", async () => {
    const m = await made();
    const own = createPrekey({ mesh: MESH, deviceId: m.file.id, signSec: m.keys.signSec, at: T });
    const r = await m.signer.handle("adopt", { prekey: own.prekey, secret: b64u.encode(own.secret) });
    expect(openPrekeySecret(m.data, own.prekey, r["sealed"] as string)).toEqual(own.secret);
    expect(sealPrekeySecret(m.data, own.prekey, own.secret)).not.toBe(r["sealed"]);
    const peer = generateDeviceKeys();
    const foreign = createPrekey({ mesh: MESH, deviceId: deviceIdFromSignPub(peer.signPub), signSec: peer.signSec, at: T });
    expect(await code(m.signer.handle("adopt", { prekey: foreign.prekey, secret: b64u.encode(foreign.secret) }))).toBe("refused");
    // Claimed for this device but signed by another key.
    const forged = { ...foreign.prekey, device: m.file.id };
    expect(await code(m.signer.handle("adopt", { prekey: forged, secret: b64u.encode(foreign.secret) }))).toBe("refused");
  });

  it("refuses unknown operations and malformed arguments", async () => {
    const m = await made();
    expect(await code(m.signer.handle("export", {}))).toBe("bad_request");
    expect(await code(m.signer.handle("hasOwnProperty", {}))).toBe("bad_request");
    expect(await code(m.signer.handle("hello", { nonce: "short" }))).toBe("bad_request");
    expect(await code(m.signer.handle("hello", { nonce: "!!!" }))).toBe("bad_request");
    expect(await code(m.signer.handle("status", { extra: 1 }))).toBe("bad_request");
    expect(m.log.every((e) => !e.ok && e.code === "bad_request")).toBe(true);
  });

  it("locks for good: refuses key operations, and takes no passphrase over its socket", async () => {
    const m = await made();
    expect(await code(m.signer.handle("prekey", { mesh: MESH, at: T }))).toBe("ok");
    await m.signer.handle("lock", {});
    expect(m.signer.locked).toBe(true);
    expect(await code(m.signer.handle("prekey", { mesh: MESH, at: T }))).toBe("locked");
    // Unlocking is a new signer (`wim agent unlock` restarts it): there is no such operation.
    expect(await code(m.signer.handle("unlock", { passphrase: "pass phrase" }))).toBe("bad_request");
    expect(m.signer.locked).toBe(true);
    const s = await m.signer.handle("status", {});
    expect(s).toMatchObject({ id: m.file.id, name: "laptop", locked: true, pid: 42, started: T, ops: { prekey: 1, lock: 1 }, refused: 0, limited: 0 });
    expect(m.log.filter((e) => e.code === "locked")).toHaveLength(1);
  });

  it("zeroes the key bytes it held when locked", async () => {
    const f = await fixture();
    const held = f.unlocked();
    const signer = new Signer({ file: f.file, unlocked: held, now: () => T, pid: 1, log: () => undefined });
    signer.lock();
    for (const b of [held.keys.signSec, held.keys.boxSec, held.data]) expect(b.every((x) => x === 0)).toBe(true);
  });

  it("rate limits key operations on its clock, and counts refusals", async () => {
    const m = await made({ rate: { perSecond: 2, burst: 2 } });
    const op = () => code(m.signer.handle("prekey", { mesh: MESH, at: T }));
    expect([await op(), await op(), await op()]).toEqual(["ok", "ok", "rate_limited"]);
    // hello and status are never limited.
    expect(await code(m.signer.handle("status", {}))).toBe("ok");
    m.clock.now += 500;
    expect([await op(), await op()]).toEqual(["ok", "rate_limited"]);
    await code(m.signer.handle("sign", { type: "prekey", obj: {} }));
    expect(await m.signer.handle("status", {})).toMatchObject({ limited: 3, refused: 0 });
    m.clock.now += 10_000;
    await code(m.signer.handle("sign", { type: "prekey", obj: {} }));
    expect(await m.signer.handle("status", {})).toMatchObject({ refused: 1 });
  });
});
