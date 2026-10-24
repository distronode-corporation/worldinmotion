import { hmac } from "@noble/hashes/hmac.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import {
  admitJoin,
  b64u,
  canon,
  canonBytes,
  createInvite,
  createJoin,
  generateDeviceKeys,
  hash,
  inviteIdFromSecret,
  joinProof,
  LIMITS,
  parseInvite,
  sasFor,
  sha256,
  spkiPin,
  signObject,
  utf8,
  verifyJoin,
  verifyJoinProof,
} from "../src/index.ts";
import { device, mesh, T0 } from "./helpers.ts";

const { chain } = mesh();
const genesis = chain[0]!;
const base = { relay: "wss://relay.example", mesh: genesis.mesh, pin: { seq: 1, hash: hash(genesis) }, now: T0 };

function encodeBody(body: unknown): string {
  return "wim1_" + b64u.encode(utf8(JSON.stringify(body)));
}

describe("invites", () => {
  it("round trips, derives the invite id from the secret, and defaults exp to one hour", () => {
    const invite = createInvite(base);
    expect(invite.exp).toBe(T0 + LIMITS.inviteDefaultTtlMs);
    expect(invite.code.startsWith("wim1_")).toBe(true);
    expect(invite.secret).toHaveLength(32);
    const parsed = parseInvite(invite.code);
    const { now: _now, ...fields } = base;
    expect(parsed).toEqual({ ...fields, exp: invite.exp, secret: invite.secret, inviteId: invite.inviteId });
    expect(parsed.inviteId).toHaveLength(22);
    const body = new TextDecoder().decode(b64u.decode(invite.code.slice(5)));
    expect(body).toBe(canon({ ...fields, exp: invite.exp, secret: b64u.encode(invite.secret) }));
    expect(parseInvite(`  ${invite.code}\n`).inviteId).toBe(invite.inviteId);
    expect(createInvite(base).inviteId).not.toBe(invite.inviteId);
    // Without `now`, the clock is used.
    expect(createInvite({ ...base, now: undefined }).exp).toBeGreaterThan(Date.now());
  });

  it("caps exp at seven days and refuses exp at or before now", () => {
    expect(createInvite({ ...base, exp: T0 + LIMITS.inviteMaxTtlMs }).exp).toBe(T0 + LIMITS.inviteMaxTtlMs);
    expect(() => createInvite({ ...base, exp: T0 + LIMITS.inviteMaxTtlMs + 1 })).toThrow(/7 days/);
    expect(() => createInvite({ ...base, exp: T0 })).toThrow(/after now/);
    expect(() => createInvite({ ...base, exp: 1.5 })).toThrow(/exp/);
    expect(() => createInvite({ ...base, now: Number.NaN })).toThrow(/exp/);
  });

  it("inviteId is b64u(sha256('wim/1 invite ' + b64u(secret))) cut to 22", () => {
    const secret = new Uint8Array(32).fill(9);
    const expected = b64u.encode(sha256(utf8("wim/1 invite " + b64u.encode(secret)))).slice(0, 22);
    expect(inviteIdFromSecret(secret)).toBe(expected);
    expect(() => inviteIdFromSecret(new Uint8Array(31))).toThrow(TypeError);
    expect(() => inviteIdFromSecret("s" as unknown as Uint8Array)).toThrow(TypeError);
  });

  it("createInvite refuses bad fields", () => {
    expect(() => createInvite({ ...base, relay: "https://relay.example" })).toThrow(/relay/);
    expect(() => createInvite({ ...base, relay: "ws://relay.example" })).toThrow(/relay/);
    expect(() => createInvite({ ...base, mesh: "x" })).toThrow(/mesh/);
    expect(() => createInvite({ ...base, pin: { seq: 0, hash: base.pin.hash } })).toThrow(/pin.seq/);
  });

  it("parseInvite gives a clear error for a bad code", () => {
    const secret = b64u.encode(new Uint8Array(32));
    const { now: _now, ...fields } = { ...base, exp: T0 + 1 };
    expect(() => parseInvite("hello")).toThrow(/must start with wim1_/);
    expect(() => parseInvite(5 as unknown as string)).toThrow(/must start with wim1_/);
    expect(() => parseInvite("wim1_***")).toThrow(/damaged or incomplete/);
    expect(() => parseInvite("wim1_" + b64u.encode(utf8("{not json")))).toThrow(/damaged or incomplete/);
    expect(() => parseInvite("wim1_" + b64u.encode(new Uint8Array([0xff, 0xfe])))).toThrow(/damaged/);
    expect(() => parseInvite(encodeBody(5))).toThrow(/invalid invite code: invite:/);
    expect(() => parseInvite(encodeBody({ ...fields }))).toThrow(/secret/);
    expect(() => parseInvite(encodeBody({ ...fields, secret, extra: 1 }))).toThrow(/invalid invite code/);
    expect(() => parseInvite(encodeBody({ ...fields, secret: "AAAA" }))).toThrow(/secret/);
    const dup = JSON.stringify({ ...fields, secret }).replace("{", `{"exp":${T0 + 2},`);
    expect(() => parseInvite("wim1_" + b64u.encode(utf8(dup)))).toThrow(/damaged/);
  });
});

describe("joining", () => {
  const invite = createInvite(base);
  const code = parseInvite(invite.code);
  const keys = generateDeviceKeys();
  const nonce = b64u.encode(sha256(utf8("hello nonce of this connection")));
  const join = createJoin(code, "newbox", keys, nonce);

  it("builds a join with the four-field record, proof and possession signature", () => {
    expect(Object.keys(join.device).sort()).toEqual(["box", "id", "name", "sign"]);
    expect(join).toMatchObject({ t: "join", mesh: genesis.mesh, invite: invite.inviteId });
    expect(join.proof).toBe(b64u.encode(hmac(nobleSha256, invite.secret, canonBytes(join.device))));
    expect(verifyJoin(join)).toMatchObject({ ok: true });
    const { t: _t, ...body } = join;
    expect(verifyJoin(body, invite.secret)).toEqual({ ok: true, value: body });
    expect(() => createJoin(code, "Bad Name", keys, nonce)).toThrow(/invalid device name/);
    expect(() => createJoin(code, "recovery", keys, nonce)).toThrow(/reserved/);
    expect(() => createJoin(code, "newbox", keys, "short")).toThrow(/nonce/);
  });

  it("binds the join to the connection's hello nonce", () => {
    const { t: _t, ...body } = join;
    expect(join.nonce).toBe(nonce);
    expect(verifyJoin(body, undefined, nonce)).toEqual({ ok: true, value: body });
    expect(verifyJoin(body, invite.secret, nonce).ok).toBe(true);
    // Replayed on another connection: the relay's nonce differs.
    const other = b64u.encode(sha256(utf8("another connection")));
    expect(verifyJoin(body, undefined, other)).toEqual({ ok: false, reason: "join_wrong_nonce" });
    // Rewriting the nonce to match breaks the signature.
    expect(verifyJoin({ ...body, nonce: other }, undefined, other)).toEqual({ ok: false, reason: "join_bad_signature" });
    // A signature that leaves the nonce out is refused.
    const unbound = signObject("join", { t: "join", mesh: body.mesh, invite: body.invite, device: body.device }, keys.signSec);
    expect(verifyJoin({ ...body, sig: unbound.sig })).toEqual({ ok: false, reason: "join_bad_signature" });
    // A re-sent join on a new connection is built with that connection's nonce.
    const again = createJoin(code, "newbox", keys, other);
    const { t: _t2, ...againBody } = again;
    expect(verifyJoin(againBody, invite.secret, other).ok).toBe(true);
  });

  it("verifyJoin refuses each broken part", () => {
    const { t: _t, ...body } = join;
    const other = generateDeviceKeys();
    expect(verifyJoin({ ...body, extra: 1 })).toEqual({ ok: false, reason: "join_malformed" });
    expect(verifyJoin({ ...body, device: { ...body.device, role: "admin" } })).toEqual({ ok: false, reason: "join_malformed" });
    expect(verifyJoin({ ...body, device: { ...body.device, sign: b64u.encode(other.signPub) } })).toEqual({
      ok: false,
      reason: "join_bad_device_id",
    });
    expect(verifyJoin({ ...body, device: { ...body.device, name: "renamed" } })).toEqual({
      ok: false,
      reason: "join_bad_signature",
    });
    // Signed by a key other than the device's own: no proof of possession.
    const wrongSigner = signObject("join", { t: "join", mesh: body.mesh, invite: body.invite, device: body.device, nonce }, other.signSec);
    expect(verifyJoin({ ...body, sig: wrongSigner.sig })).toEqual({ ok: false, reason: "join_bad_signature" });
    // The signature is domain separated: a "roster" signature over the same object is refused.
    const asRoster = signObject("roster", { t: "join", mesh: body.mesh, invite: body.invite, device: body.device, nonce }, keys.signSec);
    expect(verifyJoin({ ...body, sig: asRoster.sig })).toEqual({ ok: false, reason: "join_bad_signature" });
    expect(verifyJoin(body, createInvite(base).secret)).toEqual({ ok: false, reason: "join_bad_proof" });
    // A joiner cannot claim a recovery name, even with a valid signature.
    const named = { ...body.device, name: "recovery" };
    const signedReserved = signObject("join", { t: "join", mesh: body.mesh, invite: body.invite, device: named, nonce }, keys.signSec);
    expect(verifyJoin({ ...body, device: named, sig: signedReserved.sig })).toEqual({ ok: false, reason: "join_reserved_name" });
  });

  it("admitJoin makes a member record", () => {
    expect(admitJoin(join.device, T0 + 5)).toEqual({ ...join.device, role: "member", added: T0 + 5 });
    expect(() => admitJoin(join.device, -1)).toThrow(/admitJoin/);
    expect(() => admitJoin({ ...join.device, name: "recovery" }, T0)).toThrow(/reserved name/);
  });
});

describe("join proofs", () => {
  const { secret } = createInvite(base);
  const joiner = device("newbox");

  it("is HMAC over the four-field record, whatever record shape is passed", () => {
    const four = { id: joiner.record.id, name: joiner.record.name, sign: joiner.record.sign, box: joiner.record.box };
    const proof = joinProof(secret, joiner.record);
    expect(proof).toBe(b64u.encode(hmac(nobleSha256, secret, canonBytes(four))));
    expect(joinProof(secret, four)).toBe(proof);
    expect(verifyJoinProof(secret, four, proof)).toBe(true);
    expect(verifyJoinProof(secret, { ...joiner.record, role: "admin" }, proof)).toBe(true);
  });

  it("fails with the wrong secret, an altered device or a damaged proof", () => {
    const proof = joinProof(secret, joiner.record);
    expect(verifyJoinProof(createInvite(base).secret, joiner.record, proof)).toBe(false);
    expect(verifyJoinProof(secret, { ...joiner.record, name: "other" }, proof)).toBe(false);
    expect(verifyJoinProof(secret, device("newbox").record, proof)).toBe(false);
    expect(verifyJoinProof(secret, joiner.record, proof.slice(0, -2))).toBe(false);
    expect(verifyJoinProof(secret, joiner.record, "@@@")).toBe(false);
    expect(verifyJoinProof("x" as unknown as Uint8Array, joiner.record, proof)).toBe(false);
  });
});

describe("short authentication string", () => {
  it("is 10 Crockford characters (50 bits) of H('wim/1 sas ' || canon(four fields)) as XXXXX-XXXXX", () => {
    const d = device("newbox");
    const four = { id: d.record.id, name: d.record.name, sign: d.record.sign, box: d.record.box };
    const h = sha256(new Uint8Array([...utf8("wim/1 sas "), ...canonBytes(four)]));
    let bits = "";
    for (const b of h.subarray(0, 7)) bits += b.toString(2).padStart(8, "0");
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const chars = Array.from({ length: 10 }, (_, i) => alphabet[parseInt(bits.slice(i * 5, i * 5 + 5), 2)]).join("");
    const sas = sasFor(d.record);
    expect(sas).toBe(`${chars.slice(0, 5)}-${chars.slice(5)}`);
    expect(sas).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(sasFor(four)).toBe(sas);
    expect(sasFor({ ...four, name: "other" })).not.toBe(sas);
  });
});

describe("relay certificate pins", () => {
  it("spkiPin is b64u(sha256(spki)) and invites carry it", () => {
    const der = utf8("not really DER, but bytes");
    const pin = spkiPin(der);
    expect(pin).toBe(b64u.encode(sha256(der)));
    expect(pin).toHaveLength(43);
    const invite = createInvite({ ...base, tls: pin });
    expect(parseInvite(invite.code).tls).toBe(pin);
    expect("tls" in parseInvite(createInvite(base).code)).toBe(false);
    expect(() => createInvite({ ...base, tls: "short" })).toThrow(/tls/);
    expect(() => spkiPin(new Uint8Array(0))).toThrow(/DER/);
    expect(() => spkiPin("x" as unknown as Uint8Array)).toThrow(/DER/);
  });
});
