// A value validation must never throw on, even when the input is hostile. zod 4 runs a string or
// array length check (and a set size check) on any value that carries a `length` or `size`
// property, even after the type check has already failed, and then compares that property with a
// number. When the property is an object with no primitive conversion, which JSON can carry as
// `{"length":{"valueOf":1,"toString":1}}`, the comparison throws a TypeError. The protocol wraps
// every untrusted check in `safeParse`, so a frame, a pasted code, a decrypted plaintext or a
// stored record that carries such a value becomes an ordinary validation failure, never a throw.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  b64u,
  newShortKey,
  openRdv,
  parseClientFrame,
  parseInvite,
  parseRecoverAuthFrame,
  parseRelayFrame,
  rosterRef,
  safeParse,
  utf8,
  verifyAuth,
  verifyGenesisRoster,
  verifyNextRoster,
  verifyPrekey,
  verifyRecoverAuth,
  verifyRosterChain,
} from "../src/index.ts";
import { mesh, T0 } from "./helpers.ts";

/** An object JSON can produce whose length/size cannot convert to a primitive. */
const HOSTILE = JSON.parse('{"valueOf":1,"toString":1}') as unknown;

describe("safeParse", () => {
  it("passes a valid value straight through", () => {
    const r = safeParse(z.string().max(8), "ok");
    expect(r.success && r.data).toBe("ok");
  });

  it("turns a thrown length check into an ordinary failure instead of throwing", () => {
    const run = () => safeParse(z.string().max(8), { length: HOSTILE });
    expect(run).not.toThrow();
    const r = run();
    expect(r.success).toBe(false);
    expect(r.success === false && r.error).toBeInstanceOf(z.ZodError);
    expect(r.success === false && r.error.issues[0]!.message).toBe("input could not be validated");
  });

  it("also covers a hostile array length and a hostile set size", () => {
    expect(safeParse(z.array(z.string()).max(2), { length: HOSTILE }).success).toBe(false);
    expect(safeParse(z.set(z.string()).max(2), { size: HOSTILE }).success).toBe(false);
  });
});

describe("the wire parsers never throw on a hostile length value", () => {
  const BAD_AUTH = JSON.stringify({ t: "auth", mesh: HOSTILE });

  it("parseClientFrame, pre-auth and authed", () => {
    expect(() => parseClientFrame(BAD_AUTH, { preAuth: true })).not.toThrow();
    expect(parseClientFrame(BAD_AUTH, { preAuth: true })).toEqual({ ok: false, reason: "malformed" });
    const pub = JSON.stringify({ t: "roster.publish", roster: { mesh: HOSTILE } });
    expect(() => parseClientFrame(pub)).not.toThrow();
    expect(parseClientFrame(pub)).toEqual({ ok: false, reason: "malformed" });
  });

  it("parseRecoverAuthFrame", () => {
    expect(() => parseRecoverAuthFrame(BAD_AUTH)).not.toThrow();
    expect(parseRecoverAuthFrame(BAD_AUTH)).toEqual({ ok: false, reason: "malformed" });
  });

  it("parseRelayFrame, including a hostile value inside a deliver envelope", () => {
    const deliver = JSON.stringify({ t: "deliver", cursor: 1, msg: { mesh: HOSTILE } });
    expect(() => parseRelayFrame(deliver)).not.toThrow();
    expect(parseRelayFrame(deliver)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("the verify and open helpers never throw on a hostile length value", () => {
  const { admin, chain } = mesh(["laptop"]);
  const genesis = chain[0]!;

  it("verifyAuth and verifyRecoverAuth", () => {
    const expect_ = { relay: "wss://relay.example.com", nonce: "n", now: T0 };
    expect(() => verifyAuth({ t: "auth", mesh: HOSTILE }, new Uint8Array(32), expect_)).not.toThrow();
    expect(verifyAuth({ t: "auth", mesh: HOSTILE }, new Uint8Array(32), expect_)).toEqual({ ok: false, reason: "malformed" });
    const recover = verifyRecoverAuth({ t: "auth", mesh: HOSTILE }, { roster: genesis, genesis }, expect_);
    expect(recover).toEqual({ ok: false, reason: "malformed" });
  });

  it("verifyPrekey", () => {
    expect(() => verifyPrekey({ mesh: HOSTILE }, genesis, T0)).not.toThrow();
    expect(verifyPrekey({ mesh: HOSTILE }, genesis, T0)).toEqual({ ok: false, reason: "malformed" });
  });

  it("verifyGenesisRoster, verifyNextRoster and verifyRosterChain", () => {
    expect(verifyGenesisRoster({ mesh: HOSTILE })).toEqual({ ok: false, reason: "roster_malformed" });
    expect(verifyNextRoster(genesis, { mesh: HOSTILE })).toEqual({ ok: false, reason: "roster_malformed" });
    expect(verifyRosterChain(rosterRef(genesis), [{ mesh: HOSTILE }])).toEqual({ ok: false, reason: "roster_malformed" });
  });

  it("openRdv", () => {
    const r = openRdv(newShortKey(), { v: 1, rdv: HOSTILE, n: "n", c: "c" });
    expect(r).toEqual({ ok: false, reason: "rdv_malformed" });
  });

  it("parseInvite reports a clean error, not a raw TypeError", () => {
    const code = "wim1_" + b64u.encode(utf8(JSON.stringify({ relay: "wss://relay.example.com", mesh: HOSTILE, secret: HOSTILE, pin: { seq: 1, hash: "x" }, exp: T0 })));
    expect(() => parseInvite(code)).toThrow(/invalid invite code/);
    expect(() => parseInvite(code)).not.toThrow(/convert object to primitive/);
  });

  it("admin and chain are a real mesh, so a valid roster still verifies", () => {
    expect(verifyGenesisRoster(genesis).ok).toBe(true);
    expect(verifyNextRoster(genesis, chain[1]!)).toMatchObject({ ok: true });
    expect(admin.record.role).toBe("admin");
  });
});

describe("a fuzz sweep: no object-valued length or size ever makes a parser throw", () => {
  const weird = fc.oneof(
    fc.constant(JSON.parse('{"valueOf":1,"toString":1}') as unknown),
    fc.constant(JSON.parse('{"length":{"valueOf":1,"toString":1}}') as unknown),
    fc.constant({ length: { valueOf: 1 } } as unknown),
    fc.constant({ size: { toString: 1 } } as unknown),
    fc.constant([] as unknown),
    fc.string(),
    fc.integer(),
  );

  it("parseClientFrame", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 16 }), weird, (t, v) => {
        expect(() => parseClientFrame(JSON.stringify({ t, mesh: v, roster: v, key: v }), { preAuth: true })).not.toThrow();
        expect(() => parseClientFrame(JSON.stringify({ t, roster: v, msg: v }))).not.toThrow();
      }),
    );
  });

  it("parseRelayFrame", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 16 }), weird, (t, v) => {
        expect(() => parseRelayFrame(JSON.stringify({ t, msg: v, chain: v, peers: v }))).not.toThrow();
      }),
    );
  });
});
