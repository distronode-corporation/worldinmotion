import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildVectors, vectorPublicKeys } from "../scripts/vectors.ts";
import {
  b64u,
  canon,
  deviceIdFromSignPub,
  deviceKeysFromSecrets,
  generateDeviceKeys,
  isVectorKey,
  VECTOR_SEED_PUBLIC_KEYS,
  openMessage,
  parseInvite,
  parseJson,
  parseRecoveryCode,
  plaintextSchema,
  verifyObject,
  verifyPrekey,
  verifyRosterChain,
  type SignType,
} from "../src/index.ts";

const dir = new URL("../vectors/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
const load = (name: string) => JSON.parse(read(name)) as Record<string, any>;
const bytes = (hex: string) => new Uint8Array((hex.match(/../g) ?? []).map((x) => parseInt(x, 16)));

// Building the vectors runs real crypto over a quarter megabyte, slow under coverage.
describe("test vectors", { timeout: 60_000 }, () => {
  const built = buildVectors();

  it("the committed files equal a fresh generation, byte for byte (no drift)", () => {
    expect(readdirSync(dir).filter((f) => f.endsWith(".json")).sort()).toEqual(Object.keys(built).sort());
    for (const [name, text] of Object.entries(built)) expect(read(name), name).toBe(text);
  });

  it("generation is deterministic and the files are ASCII with a trailing newline", () => {
    expect(buildVectors()).toEqual(built);
    for (const text of Object.values(built)) {
      expect(text.endsWith("}\n")).toBe(true);
      expect(/^[\n\x20-\x7e]*$/.test(text)).toBe(true);
    }
  });

  it("VECTOR_SEED_PUBLIC_KEYS lists exactly the vectors' fixed keys", () => {
    expect([...VECTOR_SEED_PUBLIC_KEYS]).toEqual(vectorPublicKeys());
    const alice = load("keys.json").keys[0];
    expect(isVectorKey(alice.signPub)).toBe(true);
    expect(isVectorKey(b64u.decode(alice.boxPub))).toBe(true);
    expect(isVectorKey(generateDeviceKeys().signPub)).toBe(false);
  });

  it("the library reproduces the committed values", () => {
    for (const v of load("canon.json").valid) expect(canon((parseJson(v.json) as { value: unknown } & { ok: true }).value)).toBe(v.canon);
    for (const v of load("b64u.json").valid) expect(b64u.encode(bytes(v.hex))).toBe(v.b64u);
    for (const k of load("keys.json").keys) {
      const keys = deviceKeysFromSecrets(bytes(k.signSec), bytes(k.boxSec));
      expect([b64u.encode(keys.signPub), b64u.encode(keys.boxPub), deviceIdFromSignPub(keys.signPub)]).toEqual([k.signPub, k.boxPub, k.id]);
    }
    const alice = load("keys.json").keys[0];
    for (const c of load("sign.json").cases) {
      expect(verifyObject(c.type as SignType, { ...c.object, sig: c.sig }, b64u.decode(alice.signPub))).toBe(true);
    }
    const roster = load("roster.json");
    const chain = roster.chain.map((c: { roster: unknown }) => c.roster);
    expect(verifyRosterChain({ seq: 1, hash: roster.chain[0].hash }, chain).ok).toBe(true);
    expect(parseRecoveryCode(roster.recovery.code).mesh).toBe(chain[0].mesh);
    const invite = load("invite.json");
    expect(parseInvite(invite.code).inviteId).toBe(invite.invite_id);
    const message = load("message.json");
    const bob = load("keys.json").keys[1];
    const me = { ...message.receiver, deviceId: bob.id, keys: deviceKeysFromSecrets(bytes(bob.signSec), bytes(bob.boxSec)) };
    expect(openMessage(message.frame, { roster: message.roster, me, now: message.now })).toEqual({ ok: true, value: message.plaintext });
    for (const t of message.tampers) {
      expect(openMessage(t.frame, { roster: message.roster, me: { ...me, address: t.address }, now: t.now })).toEqual({ ok: false, reason: t.reason });
    }
    const pk = load("prekey.json");
    const bobPk = { ...me, roster: pk.roster };
    const held = (ids: string[]) => (id: string) =>
      ids.includes(id) ? b64u.decode(id === pk.prekeys.bob.prekey.id ? pk.prekeys.bob.secret : pk.prekeys.alice.secret) : undefined;
    expect(verifyPrekey(pk.prekeys.bob.prekey, pk.roster, pk.message.now).ok).toBe(true);
    expect(openMessage(pk.message.frame, { roster: pk.roster, me: { ...bobPk, ...pk.message.receiver, prekey: held([pk.prekeys.bob.prekey.id]) }, now: pk.message.now })).toEqual({
      ok: true,
      value: pk.message.plaintext,
    });
    for (const t of pk.message.tampers) {
      expect(openMessage(t.frame, { roster: pk.roster, me: { ...bobPk, ...pk.message.receiver, prekey: held(t.held) }, now: pk.message.now })).toEqual({ ok: false, reason: t.reason });
    }
    for (const v of pk.invalid_prekeys) expect(verifyPrekey(v.prekey, pk.roster, v.now)).toEqual({ ok: false, reason: v.reason });
    const ping = load("ping.json");
    const aliceKeys = deviceKeysFromSecrets(bytes(alice.signSec), bytes(alice.boxSec));
    const atBob = { ...ping.ping.receiver, deviceId: bob.id, keys: me.keys, prekey: held([pk.prekeys.bob.prekey.id]) };
    const atAlice = { ...ping.pong.receiver, deviceId: alice.id, keys: aliceKeys, prekey: held([pk.prekeys.alice.prekey.id]) };
    expect(openMessage(ping.ping.frame, { roster: ping.roster, me: atBob, now: ping.ping.now })).toEqual({ ok: true, value: ping.ping.plaintext });
    expect(openMessage(ping.pong.frame, { roster: ping.roster, me: atAlice, now: ping.pong.now })).toEqual({ ok: true, value: ping.pong.plaintext });
    expect(ping.pong.plaintext.reply_to).toBe(ping.ping.plaintext.id);
    for (const v of ping.invalid_plaintexts) expect(plaintextSchema.safeParse(v.plaintext).success, v.why).toBe(false);
  });
});
