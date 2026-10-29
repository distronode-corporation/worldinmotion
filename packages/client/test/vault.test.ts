// The encrypted key file (version 2) and the sealed prekey secrets: what a copy of either gives
// without the passphrase (nothing), and what changes to it are refused.

import { b64u, createPrekey, deviceIdFromSignPub, generateDeviceKeys, randomBytes } from "@worldinmotion/protocol";
import { describe, expect, it } from "vitest";
import { BadPassphrase, DEFAULT_KDF, openKeyFile, openPrekeySecret, parseSealedKeyFile, sealKeyFile, sealPrekeySecret, type SealedKeyFile } from "../src/vault.ts";

/** A small scrypt cost: the format is the same, the tests are fast. */
const KDF = { N: 1024, r: 8, p: 1 };
const keys = generateDeviceKeys();

describe("the encrypted key file", () => {
  it("round trips the keys and the data key, and holds no secret in the clear", async () => {
    const data = randomBytes(32);
    const file = await sealKeyFile({ name: "laptop", keys, passphrase: "correct horse", data, kdf: KDF });
    expect(file).toMatchObject({ v: 2, name: "laptop", id: deviceIdFromSignPub(keys.signPub), signPub: b64u.encode(keys.signPub), kdf: { alg: "scrypt", N: 1024, r: 8, p: 1 } });
    const text = JSON.stringify(file);
    expect(text).not.toContain(b64u.encode(keys.signSec));
    expect(text).not.toContain(b64u.encode(keys.boxSec));
    expect(text).not.toContain("signSec");
    const opened = await openKeyFile(parseSealedKeyFile(JSON.parse(text) as Record<string, unknown>), "correct horse");
    expect(opened.keys).toEqual(keys);
    expect(opened.data).toEqual(data);
    // Without `data`, a new data key.
    const fresh = await sealKeyFile({ name: "laptop", keys, passphrase: "x", kdf: KDF });
    expect((await openKeyFile(fresh, "x")).data).not.toEqual(data);
  });

  it("defaults to scrypt N = 2^17, r = 8, p = 1", async () => {
    const file = await sealKeyFile({ name: "laptop", keys, passphrase: "x" });
    expect(file.kdf).toMatchObject(DEFAULT_KDF);
    expect((await openKeyFile(file, "x")).keys).toEqual(keys);
  });

  it("refuses a wrong passphrase and any change to the file", async () => {
    const file = await sealKeyFile({ name: "laptop", keys, passphrase: "right", kdf: KDF });
    await expect(openKeyFile(file, "wrong")).rejects.toBeInstanceOf(BadPassphrase);
    const other = generateDeviceKeys();
    const tampered: SealedKeyFile[] = [
      { ...file, name: "desktop" },
      { ...file, boxPub: b64u.encode(other.boxPub) },
      { ...file, kdf: { ...file.kdf, salt: b64u.encode(randomBytes(16)) } },
      { ...file, nonce: b64u.encode(randomBytes(12)) },
    ];
    for (const t of tampered) await expect(openKeyFile(t, "right")).rejects.toThrow(/does not open/);
  });

  it("refuses secrets whose public keys are not the ones the file names", async () => {
    const other = generateDeviceKeys();
    const mixed = await sealKeyFile({ name: "x", keys: { ...keys, boxPub: other.boxPub }, passphrase: "p", kdf: KDF });
    await expect(openKeyFile(mixed, "p")).rejects.toThrow(/public keys do not match/);
  });

  it("parses only a well-formed version 2 file", async () => {
    const file = (await sealKeyFile({ name: "laptop", keys, passphrase: "p", kdf: KDF })) as unknown as Record<string, unknown>;
    expect(parseSealedKeyFile({ ...file, extra: 1 })).toEqual(file);
    const kdf = file["kdf"] as Record<string, unknown>;
    const bad: Array<Record<string, unknown>> = [
      { ...file, v: 3 },
      { ...file, id: "" },
      { ...file, name: "Not A Name" },
      { ...file, signPub: 1 },
      { ...file, boxPub: "" },
      { ...file, nonce: undefined },
      { ...file, sealed: "" },
      { ...file, kdf: null },
      { ...file, kdf: "scrypt" },
      { ...file, kdf: { ...kdf, alg: "argon2" } },
      { ...file, kdf: { ...kdf, N: 2 ** 21 } },
      { ...file, kdf: { ...kdf, N: 0 } },
      { ...file, kdf: { ...kdf, r: 1.5 } },
      { ...file, kdf: { ...kdf, p: 17 } },
      { ...file, kdf: { ...kdf, salt: "" } },
    ];
    for (const b of bad) expect(() => parseSealedKeyFile(b), JSON.stringify(b).slice(0, 80)).toThrow(/malformed/);
    expect(() => parseSealedKeyFile({ ...file, id: deviceIdFromSignPub(generateDeviceKeys().signPub) })).toThrow(/id does not match/);
  });
});

describe("sealed prekey secrets", () => {
  const data = randomBytes(32);
  const made = createPrekey({ mesh: b64u.encode(randomBytes(16)), deviceId: deviceIdFromSignPub(keys.signPub), signSec: keys.signSec, at: 1_760_000_000_000 });

  it("open only with the data key, for the very prekey they were sealed with", () => {
    const sealed = sealPrekeySecret(data, made.prekey, made.secret);
    expect(sealed).not.toContain(b64u.encode(made.secret));
    expect(openPrekeySecret(data, made.prekey, sealed)).toEqual(made.secret);
    expect(openPrekeySecret(randomBytes(32), made.prekey, sealed)).toBeUndefined();
    // A later `until` would extend the secret's life past its deletion time: refused.
    expect(openPrekeySecret(data, { ...made.prekey, until: made.prekey.until + 1 }, sealed)).toBeUndefined();
    expect(openPrekeySecret(data, made.prekey, "!!")).toBeUndefined();
    expect(openPrekeySecret(data, made.prekey, b64u.encode(randomBytes(20)))).toBeUndefined();
  });
});
