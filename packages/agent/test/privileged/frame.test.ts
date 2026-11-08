import { b64u, encodeKeys, LIMITS } from "@worldinmotion/protocol";
import { describe, expect, it } from "vitest";
import { FrameError, parseRecipient, pinMatches, SEEN_WINDOW_MS, verifyFrame } from "../../src/privileged/frame.ts";
import { ADDRESS, device, MESH, RECIPIENT, recipientKeyFile, recipientPrekey, seal, SENDER, SENDERS } from "./helpers.ts";

const now = () => Date.now();
const ctx = (over: Record<string, unknown> = {}) => ({ senders: SENDERS, mesh: MESH, address: ADDRESS, recipient: parseRecipient(recipientKeyFile(), undefined, now()), now: now(), ...over });

describe("pinMatches", () => {
  it("accepts only the id a sign key names", () => {
    expect(pinMatches(SENDER.id, SENDER.sign)).toBe(true);
    expect(pinMatches(RECIPIENT.id, SENDER.sign)).toBe(false);
    expect(pinMatches(SENDER.id, "short")).toBe(false);
    expect(pinMatches(SENDER.id, "!!!")).toBe(false);
  });
});

describe("parseRecipient", () => {
  it("reads the plaintext key file and the live prekeys", () => {
    const pk = recipientPrekey();
    const r = parseRecipient(recipientKeyFile(), pk.file, now());
    expect(r.deviceId).toBe(RECIPIENT.id);
    expect([...r.prekeys.keys()]).toEqual([pk.prekey.id]);
  });
  it("drops prekeys past their deletion time, malformed entries, and an unreadable file", () => {
    const pk = recipientPrekey(now() - 30 * 86_400_000);
    expect(parseRecipient(recipientKeyFile(), pk.file, now()).prekeys.size).toBe(0);
    const bad = JSON.stringify({ v: 1, keys: [{ prekey: {}, secret: "x" }, { prekey: recipientPrekey().prekey, secret: 7 }, { prekey: recipientPrekey().prekey, secret: b64u.encode(new Uint8Array(5)) }] });
    expect(parseRecipient(recipientKeyFile(), bad, now()).prekeys.size).toBe(0);
    expect(parseRecipient(recipientKeyFile(), "{", now()).prekeys.size).toBe(0);
    expect(parseRecipient(recipientKeyFile(), JSON.stringify({ v: 2 }), now()).prekeys.size).toBe(0);
  });
  it("refuses an encrypted key file clearly, and a file that is not a key file", () => {
    expect(() => parseRecipient(JSON.stringify({ v: 2, sealed: "x" }), undefined, now())).toThrow(/encrypted.*plaintext key file/);
    expect(() => parseRecipient("{", undefined, now())).toThrow(/not JSON/);
    expect(() => parseRecipient("null", undefined, now())).toThrow(FrameError);
    expect(() => parseRecipient(JSON.stringify({ v: 1 }), undefined, now())).toThrow(/unusable/);
  });
});

describe("verifyFrame", () => {
  it("returns what the pinned sender signed, through a legacy box and a prekey box", () => {
    expect(verifyFrame(seal("do it"), ctx())).toMatchObject({ device: SENDER.id, text: "do it" });
    const pk = recipientPrekey();
    const recipient = parseRecipient(recipientKeyFile(), pk.file, now());
    expect(verifyFrame(seal("with fs", { prekey: pk.prekey }), ctx({ recipient })).text).toBe("with fs");
  });

  it("refuses a sender that is not pinned, even with a real signature", () => {
    const stranger = device();
    expect(() => verifyFrame(seal("x", { from: stranger }), ctx())).toThrow(/unknown_sender/);
  });

  it("refuses a frame whose claimed sender did not sign it (a peer forging from.device)", () => {
    const forger = device();
    const f = seal("x", { from: forger });
    const forged = { ...f, from: { ...f.from, device: SENDER.id } };
    expect(() => verifyFrame(forged, ctx())).toThrow(/bad_signature/);
  });

  it("refuses any change to a signed frame", () => {
    const f = seal("x");
    expect(() => verifyFrame({ ...f, at: f.at + 1 }, ctx())).toThrow(/bad_signature/);
  });

  it("with a swapped recipient key only fails to open; it never accepts a forged frame", () => {
    const swapped = parseRecipient(`${encodeKeys(device().keys)}`, undefined, now());
    expect(() => verifyFrame(seal("x"), ctx({ recipient: { ...swapped, deviceId: RECIPIENT.id } }))).toThrow(/decrypt_failed|not verify/);
    const forger = device();
    const forged = { ...seal("x", { from: forger }), from: { device: SENDER.id, sid: "01JB0000000000000000000000", session: "dev" } };
    expect(() => verifyFrame(forged, ctx({ recipient: { ...swapped, deviceId: RECIPIENT.id } }))).toThrow(/bad_signature/);
  });

  it("refuses a frame for another address, another mesh, or outside the freshness window", () => {
    expect(() => verifyFrame(seal("x", { to: "other@server" }), ctx())).toThrow(/not_addressed/);
    expect(() => verifyFrame(seal("x"), ctx({ mesh: b64u.encode(new Uint8Array(16)) }))).toThrow(/wrong_mesh/);
    expect(() => verifyFrame(seal("x", { at: now() - LIMITS.messageMaxAgeMs - 60_000 }), ctx())).toThrow(/too_old/);
    expect(() => verifyFrame(seal("x", { at: now() + LIMITS.messageMaxFutureMs + 60_000 }), ctx())).toThrow(/too_new/);
    expect(() => verifyFrame({ nope: 1 }, ctx())).toThrow(/malformed/);
  });

  it("takes a task, and never a result or relayed text", () => {
    expect(verifyFrame(seal("t", { kind: "task" }), ctx()).text).toBe("t");
    expect(() => verifyFrame(seal("r", { kind: "result", reply_to: "01JB0000000000000000000000" }), ctx())).toThrow(/a result is never a job/);
    expect(() => verifyFrame(seal("x", { relayed: true }), ctx())).toThrow(/relayed/);
    expect(() => verifyFrame(seal("x", { derived: true }), ctx())).toThrow(/derived text is never a job/);
  });

  it("keeps seen ids for the whole freshness window", () => {
    expect(SEEN_WINDOW_MS).toBe(LIMITS.messageMaxAgeMs + LIMITS.messageMaxFutureMs);
  });
});
