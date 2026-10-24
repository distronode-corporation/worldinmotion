import { describe, expect, it } from "vitest";
import {
  b64u,
  createRecoveryKeys,
  hash,
  LIMITS,
  nextRoster,
  parseClientFrame,
  parseRecoverAuthFrame,
  randomBytes,
  signAuth,
  signObject,
  signRecoverAuth,
  ulid,
  verifyAuth,
  verifyRecoverAuth,
  type AuthFields,
} from "../src/index.ts";
import { device, mesh, T0 } from "./helpers.ts";

const { admin, chain } = mesh();
const relay = "wss://relay.example";
const nonce = b64u.encode(randomBytes(32));

function fields(over: Partial<AuthFields> = {}): AuthFields {
  return {
    relay,
    mesh: chain[0]!.mesh,
    nonce,
    at: T0,
    session: { name: "reviewer", kind: "claude-code", sid: ulid(), resume: b64u.encode(randomBytes(32)) },
    resume: { cursor: 41 },
    pin: { seq: 1, hash: hash(chain[0]) },
    ...over,
  };
}

const expectOk = { relay, nonce, now: T0 };

describe("auth", () => {
  it("signs a valid frame that verifies", () => {
    const frame = signAuth(fields(), admin.keys);
    expect(frame).toMatchObject({ t: "auth", v: 1, device: admin.id, pin: { seq: 1 } });
    expect(verifyAuth(frame, admin.keys.signPub, expectOk)).toEqual({ ok: true, value: true });
    expect(verifyAuth(signAuth(fields({ device: admin.id, resume: undefined }), admin.keys), admin.keys.signPub, expectOk).ok).toBe(true);
  });

  it("refuses a wrong relay, a wrong nonce and the wrong key", () => {
    const frame = signAuth(fields(), admin.keys);
    expect(verifyAuth(frame, admin.keys.signPub, { ...expectOk, relay: "wss://other.example" })).toEqual({
      ok: false,
      reason: "wrong_relay",
    });
    expect(verifyAuth(frame, admin.keys.signPub, { ...expectOk, nonce: b64u.encode(randomBytes(32)) })).toEqual({
      ok: false,
      reason: "wrong_nonce",
    });
    const other = device("other");
    expect(verifyAuth(frame, other.keys.signPub, expectOk)).toEqual({ ok: false, reason: "wrong_device" });
    expect(verifyAuth(frame, new Uint8Array(3), expectOk)).toEqual({ ok: false, reason: "wrong_device" });
    // A frame claiming another device's id but signed with our key.
    const claimed = signObject("auth", { ...frame, device: other.id }, admin.keys.signSec);
    expect(verifyAuth(claimed, other.keys.signPub, expectOk)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyAuth(signObject("send", frame, admin.keys.signSec), admin.keys.signPub, expectOk)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(verifyAuth({ ...frame, at: T0 + 1 }, admin.keys.signPub, expectOk)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses clock skew in both directions, using 5 minutes by default", () => {
    const frame = signAuth(fields(), admin.keys);
    const skew = LIMITS.authSkewMs;
    expect(verifyAuth(frame, admin.keys.signPub, { ...expectOk, now: T0 + skew }).ok).toBe(true);
    expect(verifyAuth(frame, admin.keys.signPub, { ...expectOk, now: T0 - skew }).ok).toBe(true);
    expect(verifyAuth(frame, admin.keys.signPub, { ...expectOk, now: T0 + skew + 1 })).toEqual({
      ok: false,
      reason: "clock_skew",
    });
    expect(verifyAuth(frame, admin.keys.signPub, { ...expectOk, now: T0 - skew - 1 })).toEqual({
      ok: false,
      reason: "clock_skew",
    });
    expect(verifyAuth(frame, admin.keys.signPub, { ...expectOk, now: T0 + 1001, skewMs: 1000 })).toMatchObject({
      reason: "clock_skew",
    });
  });

  it("refuses malformed frames and bad fields", () => {
    const frame = signAuth(fields(), admin.keys);
    expect(verifyAuth({ ...frame, v: 2 }, admin.keys.signPub, expectOk)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyAuth("auth", admin.keys.signPub, expectOk)).toEqual({ ok: false, reason: "malformed" });
    expect(() => signAuth(fields({ device: device("x").id }), admin.keys)).toThrow(/does not match/);
    expect(() => signAuth(fields({ relay: "http://relay.example" }), admin.keys)).toThrow(/relay/);
    expect(() => signAuth(fields({ nonce: "short" }), admin.keys)).toThrow(/nonce/);
    expect(() => signAuth(fields({ relay: "ws://relay.example" }), admin.keys)).toThrow(/relay/);
    expect(() => signAuth(fields({ session: { name: "a", kind: "Claude Code", sid: ulid(), resume: nonce } }), admin.keys)).toThrow(
      /session.kind/,
    );
    const { pin: _pin, ...unpinned } = fields();
    expect(() => signAuth(unpinned as AuthFields, admin.keys)).toThrow(/pin/);
  });

  it("matches the relay against a list of configured public URLs, byte for byte", () => {
    const frame = signAuth(fields(), admin.keys);
    const list = ["wss://other.example", relay];
    expect(verifyAuth(frame, admin.keys.signPub, { ...expectOk, relay: list }).ok).toBe(true);
    expect(verifyAuth(frame, admin.keys.signPub, { ...expectOk, relay: ["wss://RELAY.example"] })).toMatchObject({
      reason: "wrong_relay",
    });
    const local = signAuth(fields({ relay: "ws://127.0.0.1:8787" }), admin.keys);
    expect(verifyAuth(local, admin.keys.signPub, { ...expectOk, relay: "ws://127.0.0.1:8787" }).ok).toBe(true);
  });
});

describe("recovery auth", () => {
  const meshId = chain[0]!.mesh;

  function recoveryMesh() {
    const rec = createRecoveryKeys(meshId, { now: T0 });
    const withRec = nextRoster(chain[0]!, { add: [rec.record] }, admin, T0 + 1);
    return { rec, withRec };
  }

  it("signs and verifies a recovery auth pinned on genesis", () => {
    const { rec, withRec } = recoveryMesh();
    const frame = signRecoverAuth({ relay, mesh: meshId, nonce, at: T0, genesis: hash(chain[0]) }, rec.keys);
    expect(frame).toMatchObject({ t: "auth", purpose: "recover", pin: { seq: 1 } });
    expect("session" in frame).toBe(false);
    expect(verifyRecoverAuth(frame, { roster: withRec, genesis: chain[0]! }, expectOk)).toEqual({ ok: true, value: rec.record });
    // Session parsing refuses it; the recovery parser accepts it, and refuses a session auth.
    expect(parseClientFrame(JSON.stringify(frame), { preAuth: true })).toEqual({ ok: false, reason: "malformed" });
    expect(parseRecoverAuthFrame(JSON.stringify(frame))).toEqual({ ok: true, value: frame });
    expect(parseRecoverAuthFrame(JSON.stringify(signAuth(fields(), admin.keys)))).toEqual({ ok: false, reason: "malformed" });
    expect(parseRecoverAuthFrame('{"t":"ping"}')).toEqual({ ok: false, reason: "unknown_type" });
    // The session check refuses it, so a relay cannot mistake it for a session auth.
    expect(verifyAuth(frame, rec.keys.signPub, expectOk)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses each broken part", () => {
    const { rec, withRec } = recoveryMesh();
    const good = { relay, mesh: meshId, nonce, at: T0, genesis: hash(chain[0]) };
    const ctx = { roster: withRec, genesis: chain[0]! };
    const sign = (over: Partial<typeof good>, keys = rec.keys) => signRecoverAuth({ ...good, ...over }, keys);
    expect(verifyRecoverAuth({ ...sign({}), session: {} }, ctx, expectOk)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyRecoverAuth({ ...sign({}), pin: { seq: 2, hash: good.genesis } }, ctx, expectOk)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyRecoverAuth(sign({ relay: "wss://other.example" }), ctx, expectOk)).toEqual({ ok: false, reason: "wrong_relay" });
    expect(verifyRecoverAuth(sign({ nonce: b64u.encode(randomBytes(32)) }), ctx, expectOk)).toEqual({ ok: false, reason: "wrong_nonce" });
    expect(verifyRecoverAuth(sign({ at: T0 + LIMITS.authSkewMs + 1 }), ctx, expectOk)).toEqual({ ok: false, reason: "clock_skew" });
    expect(verifyRecoverAuth(sign({ mesh: mesh().chain[0]!.mesh }), ctx, expectOk)).toEqual({ ok: false, reason: "wrong_mesh" });
    expect(verifyRecoverAuth(sign({ genesis: hash(withRec) }), ctx, expectOk)).toEqual({ ok: false, reason: "wrong_pin" });
    // An ordinary device, an unknown device, and a revoked recovery record are all refused.
    expect(verifyRecoverAuth(sign({}, admin.keys), ctx, expectOk)).toEqual({ ok: false, reason: "not_recovery" });
    expect(verifyRecoverAuth(sign({}, device("x").keys), ctx, expectOk)).toEqual({ ok: false, reason: "not_recovery" });
    const revoked = nextRoster(withRec, { revoke: [rec.record.id] }, admin, T0 + 2);
    expect(verifyRecoverAuth(sign({}), { ...ctx, roster: revoked }, expectOk)).toEqual({ ok: false, reason: "not_recovery" });
    expect(verifyRecoverAuth({ ...sign({}), at: T0 + 1 }, ctx, expectOk)).toEqual({ ok: false, reason: "bad_signature" });
    expect(() => sign({ genesis: "x" })).toThrow(/pin.hash/);
  });
});
