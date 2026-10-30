import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { describe, expect, it } from "vitest";
import {
  b64u,
  createInvite,
  findSecrets,
  formatShortCode,
  hash,
  isShortCode,
  LIMITS,
  newShortKey,
  openRdv,
  parseShortCode,
  rdvAnswerSchema,
  rdvId,
  rdvKey,
  sealRdv,
  SHORT_CODE_RELAY,
  utf8,
} from "../src/index.ts";
import { mesh, T0 } from "./helpers.ts";

const K = "0123456789ABCDEFGHJK";
const { chain } = mesh();
const full = createInvite({ relay: "wss://relay.example", mesh: chain[0]!.mesh, pin: { seq: 1, hash: hash(chain[0]) }, now: T0 }).code;

describe("short code format", () => {
  it("makes 100-bit secrets in canonical Crockford base32", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const k = newShortKey();
      expect(k).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
      seen.add(k);
    }
    expect(seen.size).toBe(50);
  });

  it("formats six groups of four, naming the relay unless it is the hosted one", () => {
    const hosted = formatShortCode(K, SHORT_CODE_RELAY);
    expect(hosted).toMatch(/^wim2-(?:[0-9A-HJKMNP-TV-Z]{4}-){5}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(hosted.startsWith("wim2-0123-4567-89AB-CDEF-GHJK-")).toBe(true);
    expect(formatShortCode(K, "wss://relay.example:8443/wim")).toBe(`${hosted}@relay.example:8443/wim`);
    expect(formatShortCode(K, "ws://127.0.0.1:8787")).toBe(`${hosted}@ws://127.0.0.1:8787`);
    expect(() => formatShortCode(K, "https://relay.example")).toThrow(/invalid relay URL/);
    expect(() => formatShortCode("0123", SHORT_CODE_RELAY)).toThrow(/20 Crockford/);
    expect(() => formatShortCode(42 as unknown as string, SHORT_CODE_RELAY)).toThrow(/20 Crockford/);
  });

  it("reads a code back as people type it", () => {
    const code = formatShortCode(K, SHORT_CODE_RELAY);
    expect(parseShortCode(code)).toEqual({ k: K, relay: SHORT_CODE_RELAY });
    // Any case, no dashes, spaces, I and L for 1, O for 0, and space around the code.
    const typed = `  ${code.toLowerCase().replace(/-/g, " ").replace("wim2 ", "WIM2-").replace(/1/g, "l").replace(/0/g, "o")}\n`;
    expect(parseShortCode(typed)).toEqual({ k: K, relay: SHORT_CODE_RELAY });
    expect(parseShortCode(`${code}@relay.example`)).toEqual({ k: K, relay: "wss://relay.example" });
    expect(parseShortCode(`${code}@ws://localhost:8787`)).toEqual({ k: K, relay: "ws://localhost:8787" });
    expect(parseShortCode(`${code}@wss://relay.example/x`)).toEqual({ k: K, relay: "wss://relay.example/x" });
  });

  it("refuses what is not a short code, a typing mistake, and a bad relay", () => {
    const code = formatShortCode(K, SHORT_CODE_RELAY);
    expect(isShortCode(code)).toBe(true);
    expect(isShortCode(` WIM2-x`)).toBe(true);
    expect(isShortCode(full)).toBe(false);
    expect(isShortCode(undefined)).toBe(false);
    expect(() => parseShortCode(full)).toThrow(/must start with wim2-/);
    expect(() => parseShortCode(undefined as unknown as string)).toThrow(/must start with wim2-/);
    expect(() => parseShortCode("wim2-ABCD")).toThrow(/24 letters and digits/);
    expect(() => parseShortCode(`${code}U`)).toThrow(/24 letters and digits/);
    // One character changed: the check catches it.
    const typo = code.replace("wim2-0123", "wim2-0124");
    expect(() => parseShortCode(typo)).toThrow(/check does not match/);
    expect(() => parseShortCode(`${code}@`)).toThrow(/not a relay address/);
    expect(() => parseShortCode(`${code}@ws://relay.example`)).toThrow(/not a relay address/);
    expect(() => parseShortCode(`${code}@relay.example/`)).toThrow(/not a relay address/);
  });

  it("is refused in an outbound message like a full code", () => {
    const code = formatShortCode(newShortKey(), SHORT_CODE_RELAY);
    expect(findSecrets(`join with ${code} please`)).toEqual(["wim_short_invite_code"]);
    expect(findSecrets(`${code.toLowerCase()}@relay.example`)).toEqual(["wim_short_invite_code"]);
    expect(findSecrets(`x${code}`)).toEqual([]);
    expect(findSecrets(`${code}A`)).toEqual([]);
  });
});

describe("the rendezvous box", () => {
  it("derives a 22-character id and a 32-byte key from k, each under its own label", () => {
    const id = rdvId(K);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(rdvKey(K)).toHaveLength(32);
    expect(rdvId(newShortKey())).not.toBe(id);
    expect(b64u.encode(rdvKey(K)).slice(0, 22)).not.toBe(id);
    expect(() => rdvId("x")).toThrow(/20 Crockford/);
    expect(() => rdvKey("x")).toThrow(/20 Crockford/);
  });

  it("seals a full code that only k opens", () => {
    const box = { v: 1, exp: T0, ...sealRdv(K, full) };
    expect(box.rdv).toBe(rdvId(K));
    expect(rdvAnswerSchema.safeParse(box).success).toBe(true);
    expect(openRdv(K, box)).toEqual({ ok: true, value: full });
    // Unknown keys in the relay's answer are ignored.
    expect(openRdv(K, { ...box, gets: 1 })).toEqual({ ok: true, value: full });
    // A fresh nonce each time.
    expect(sealRdv(K, full).n).not.toBe(box.n);
  });

  it("refuses a malformed answer, a box under another id, and one that does not open", () => {
    const box = { v: 1, exp: T0, ...sealRdv(K, full) };
    const other = newShortKey();
    expect(openRdv(K, { ...box, v: 2 })).toEqual({ ok: false, reason: "rdv_malformed" });
    expect(openRdv(K, null)).toEqual({ ok: false, reason: "rdv_malformed" });
    expect(openRdv(other, box)).toEqual({ ok: false, reason: "rdv_wrong_id" });
    // The relay relabels another box with this id: the AAD binds the id, so it does not open.
    const moved = { ...box, ...sealRdv(other, full), rdv: box.rdv };
    expect(openRdv(K, moved)).toEqual({ ok: false, reason: "rdv_decrypt_failed" });
    const flipped = b64u.decode(box.c);
    flipped[0]! ^= 1;
    expect(openRdv(K, { ...box, c: b64u.encode(flipped) })).toEqual({ ok: false, reason: "rdv_decrypt_failed" });
    // Sealed by a holder of k over bytes that are not UTF-8: refused too.
    const nonce = new Uint8Array(24);
    const c = xchacha20poly1305(rdvKey(K), nonce, utf8(`wim/1 rdv ${box.rdv}`)).encrypt(new Uint8Array([0xff, 0xfe]));
    expect(openRdv(K, { ...box, n: b64u.encode(nonce), c: b64u.encode(c) })).toEqual({ ok: false, reason: "rdv_decrypt_failed" });
    expect(() => openRdv("x", box)).toThrow(/20 Crockford/);
  });

  it("refuses to seal nothing, or a code past the box limit", () => {
    expect(() => sealRdv(K, "")).toThrow(/does not fit/);
    expect(sealRdv(K, "x".repeat(LIMITS.rdvBoxBytes - 16)).c.length).toBe(Math.ceil((LIMITS.rdvBoxBytes * 4) / 3));
    expect(() => sealRdv(K, "x".repeat(LIMITS.rdvBoxBytes - 15))).toThrow(/does not fit/);
  });

  it("fits the longest full code a relay URL allows", () => {
    const relay = `wss://relay.example/${"p".repeat(2048 - "wss://relay.example/".length)}`;
    const longest = createInvite({ relay, mesh: chain[0]!.mesh, pin: { seq: 1, hash: hash(chain[0]) }, now: T0, exp: T0 + LIMITS.inviteMaxTtlMs, tls: b64u.encode(new Uint8Array(32)) });
    expect(openRdv(K, { v: 1, exp: T0, ...sealRdv(K, longest.code) })).toEqual({ ok: true, value: longest.code });
  });
});
