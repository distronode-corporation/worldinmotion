import { x25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { hpkeOpenAuth, hpkeSealAuth } from "../src/hpke.ts";

const hex = (s: string): Uint8Array => new Uint8Array((s.replace(/\s+/g, "").match(/../g) ?? []).map((x) => parseInt(x, 16)));
const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// RFC 9180 Appendix A.2.3: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20Poly1305, mode_auth.
const A23 = {
  info: "4f6465206f6e2061204772656369616e2055726e",
  skEm: "c94619e1af28971c8fa7957192b7e62a71ca2dcdde0a7cc4a8a9e741d600ab13",
  pkEm: "f7674cc8cd7baa5872d1f33dbaffe3314239f6197ddf5ded1746760bfc847e0e",
  pkRm: "1a478716d63cb2e16786ee93004486dc151e988b34b475043d3e0175bdb01c44",
  skRm: "3ca22a6d1cda1bb9480949ec5329d3bf0b080ca4c45879c95eddb55c70b80b82",
  pkSm: "f0f4f9e96c54aeed3f323de8534fffd7e0577e4ce269896716bcb95643c8712b",
  skSm: "2def0cb58ffcf83d1062dd085c8aceca7f4c0c3fd05912d847b61f3e54121f05",
  enc: "f7674cc8cd7baa5872d1f33dbaffe3314239f6197ddf5ded1746760bfc847e0e",
  sharedSecret: "d2d67828c8bc9fa661cf15a31b3ebf1febe0cafef7abfaaca580aaf6d471e3eb",
  key: "b071fd1136680600eb447a845a967d35e9db20749cdf9ce098bcc4deef4b1356",
  baseNonce: "d20577dff16d7cea2c4bf780",
  // Sequence number 0.
  pt: "4265617574792069732074727574682c20747275746820626561757479",
  aad: "436f756e742d30",
  ct: "ab1a13c9d4f01a87ec3440dbd756e2677bd2ecf9df0ce7ed73869b98e00c09be111cb9fdf077347aeb88e61bdf",
};

describe("HPKE mode_auth (RFC 9180 A.2.3)", () => {
  it("reproduces the RFC's key schedule and first encryption", () => {
    expect(toHex(x25519.getPublicKey(hex(A23.skRm)))).toBe(A23.pkRm);
    expect(toHex(x25519.getPublicKey(hex(A23.skSm)))).toBe(A23.pkSm);
    const sealed = hpkeSealAuth({
      pkR: hex(A23.pkRm),
      skS: hex(A23.skSm),
      info: hex(A23.info),
      aad: hex(A23.aad),
      plaintext: hex(A23.pt),
      ephemeral: hex(A23.skEm),
    });
    expect(toHex(sealed.enc)).toBe(A23.enc);
    expect(toHex(sealed.enc)).toBe(A23.pkEm);
    expect(toHex(sealed.sharedSecret)).toBe(A23.sharedSecret);
    expect(toHex(sealed.key)).toBe(A23.key);
    expect(toHex(sealed.nonce)).toBe(A23.baseNonce);
    expect(toHex(sealed.ciphertext)).toBe(A23.ct);
  });

  it("opens the RFC's ciphertext, and nothing that differs in any input", () => {
    const base = { enc: hex(A23.enc), skR: hex(A23.skRm), pkS: hex(A23.pkSm), info: hex(A23.info), aad: hex(A23.aad), ciphertext: hex(A23.ct) };
    expect(toHex(hpkeOpenAuth(base))).toBe(A23.pt);
    const other = x25519.getPublicKey(hex("11".repeat(32)));
    for (const bad of [
      { pkS: other },
      { enc: other },
      { skR: hex("22".repeat(32)) },
      { info: hex("00") },
      { aad: hex("00") },
      { ciphertext: hex(A23.ct.replace(/^ab/, "aa")) },
    ]) {
      expect(() => hpkeOpenAuth({ ...base, ...bad })).toThrow();
    }
  });

  it("a fresh ephemeral per seal, and a low-order key is refused", () => {
    const opts = { pkR: hex(A23.pkRm), skS: hex(A23.skSm), info: hex(A23.info), aad: hex(A23.aad), plaintext: hex(A23.pt) };
    const a = hpkeSealAuth(opts);
    const b = hpkeSealAuth(opts);
    expect(toHex(a.enc)).not.toBe(toHex(b.enc));
    expect(toHex(a.ciphertext)).not.toBe(toHex(b.ciphertext));
    expect(toHex(hpkeOpenAuth({ enc: a.enc, skR: hex(A23.skRm), pkS: hex(A23.pkSm), info: opts.info, aad: opts.aad, ciphertext: a.ciphertext }))).toBe(A23.pt);
    expect(() => hpkeSealAuth({ ...opts, pkR: new Uint8Array(32) })).toThrow();
  });
});
