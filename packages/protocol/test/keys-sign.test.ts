import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { b64u, canonBytes, decodeKeys, encodeKeys, generateDeviceKeys, signObject, utf8, verifyObject, type SignType } from "../src/index.ts";

describe("device keys", () => {
  it("generates 32-byte pairs and round trips the key file", () => {
    const keys = generateDeviceKeys();
    for (const k of Object.values(keys)) expect(k).toHaveLength(32);
    const text = encodeKeys(keys);
    expect(JSON.parse(text)).toMatchObject({ v: 1, signPub: b64u.encode(keys.signPub) });
    expect(decodeKeys(text)).toEqual(keys);
    expect(decodeKeys(JSON.parse(text) as object)).toEqual(keys);
  });

  it("refuses a damaged or inconsistent key file", () => {
    const a = JSON.parse(encodeKeys(generateDeviceKeys())) as Record<string, unknown>;
    const b = JSON.parse(encodeKeys(generateDeviceKeys())) as Record<string, unknown>;
    expect(() => decodeKeys("null")).toThrow(/not an object/);
    expect(() => decodeKeys("7")).toThrow(/not an object/);
    expect(() => decodeKeys({ ...a, v: 2 })).toThrow(/version/);
    expect(() => decodeKeys({ ...a, boxSec: undefined })).toThrow(/boxSec is missing/);
    expect(() => decodeKeys({ ...a, signSec: "AAAA" })).toThrow(/32 bytes/);
    expect(() => decodeKeys({ ...a, signSec: b["signSec"] })).toThrow(/signPub does not match/);
    expect(() => decodeKeys({ ...a, boxSec: b["boxSec"] })).toThrow(/boxPub does not match/);
    expect(() => decodeKeys({ ...a, id: b["id"] })).toThrow(/id does not match/);
    expect(() => decodeKeys("{")).toThrow(/not JSON/);
    expect(() => decodeKeys(encodeKeys(generateDeviceKeys()).replace("{", '{"v":1,'))).toThrow(/duplicate key/);
  });
});

describe("signObject and verifyObject", () => {
  const loose = (o: object) => o as { sig: string };
  const keys = generateDeviceKeys();

  it("signs canon of the object without sig and verifies regardless of key order", () => {
    const signed = signObject("send", { b: 1, a: { y: "x" } }, keys.signSec);
    expect(b64u.decode(signed.sig)).toHaveLength(64);
    expect(verifyObject("send", signed, keys.signPub)).toBe(true);
    const reordered = { sig: signed.sig, a: { y: "x" }, b: 1 };
    expect(verifyObject("send", reordered, keys.signPub)).toBe(true);
    // Re-signing replaces an existing sig rather than signing over it.
    const again = signObject("send", signed, keys.signSec);
    expect(again.sig).toBe(signed.sig);
  });

  it("returns false, never throws, on anything wrong", () => {
    const signed = signObject("send", { a: 1 }, keys.signSec);
    const other = generateDeviceKeys();
    expect(verifyObject("send", loose({ ...signed, a: 2 }), keys.signPub)).toBe(false);
    expect(verifyObject("send", loose({ ...signed, extra: true }), keys.signPub)).toBe(false);
    expect(verifyObject("send", signed, other.signPub)).toBe(false);
    expect(verifyObject("send", { ...signed, sig: "!!" }, keys.signPub)).toBe(false);
    expect(verifyObject("send", { ...signed, sig: b64u.encode(new Uint8Array(63)) }, keys.signPub)).toBe(false);
    expect(verifyObject("send", { ...signed, sig: b64u.encode(new Uint8Array(64)) }, keys.signPub)).toBe(false);
    expect(verifyObject("send", { a: 1 } as unknown as { sig: string }, keys.signPub)).toBe(false);
    expect(verifyObject("send", null as unknown as { sig: string }, keys.signPub)).toBe(false);
    expect(verifyObject("send", [] as unknown as { sig: string }, keys.signPub)).toBe(false);
    expect(verifyObject("send", signed, new Uint8Array(31))).toBe(false);
    expect(verifyObject("send", signed, "key" as unknown as Uint8Array)).toBe(false);
    expect(verifyObject("send", loose({ ...signed, a: 1.5 }), keys.signPub)).toBe(false);
    // A low-order public key is refused by strict verification.
    expect(verifyObject("send", signed, new Uint8Array(32).fill(0).map((_, i) => (i === 0 ? 1 : 0)))).toBe(false);
  });

  it("separates domains: the signed bytes are the type label then canon", () => {
    const signed = signObject("roster", { a: 1 }, keys.signSec);
    const label = utf8("wim/1 roster\n");
    const body = canonBytes({ a: 1 });
    const bytes = new Uint8Array([...label, ...body]);
    expect(ed25519.verify(b64u.decode(signed.sig), bytes, keys.signPub)).toBe(true);
    for (const other of ["send", "auth", "join"] as const) expect(verifyObject(other, signed, keys.signPub)).toBe(false);
    expect(verifyObject("roster", signed, keys.signPub)).toBe(true);
    expect(() => signObject("bogus" as SignType, { a: 1 }, keys.signSec)).toThrow(/unknown signature type/);
    expect(verifyObject("bogus" as SignType, signed, keys.signPub)).toBe(false);
  });

  it("refuses to sign a value canon cannot encode", () => {
    expect(() => signObject("send", { a: 0.5 }, keys.signSec)).toThrow(TypeError);
  });
});
