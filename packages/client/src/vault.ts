// The key file at rest. Version 1 (`device.json` as before) holds the secret keys in the clear.
// Version 2 holds them encrypted under a passphrase, so a copy of the file is useless without it:
// only the signer (`wim agent`) unlocks it, once, and keeps the keys in its memory. The public
// fields stay readable, so every process can name the device without the signer.
//
// Version 2 also holds a random data key that seals this device's prekey secrets in
// `prekeys.json` (SPEC section 6b), so those, too, open only in the signer.

import { b64u, canonBytes, deviceIdFromSignPub, deviceKeysFromSecrets, fromUtf8, isName, randomBytes, utf8, type DeviceKeys, type Prekey } from "@worldinmotion/protocol";
import { createCipheriv, createDecipheriv, scrypt, type ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

/** scrypt with N = 2^17, r = 8, p = 1: 128 MiB and about half a second per guess on a laptop. */
export const DEFAULT_KDF = { N: 2 ** 17, r: 8, p: 1 } as const;

/** The largest scrypt cost a key file may ask for: a hostile file must not exhaust memory. */
const MAX_N = 2 ** 20;

export type KdfParams = { alg: "scrypt"; N: number; r: number; p: number; salt: string };

/** `device.json`, version 2. */
export type SealedKeyFile = {
  v: 2;
  id: string;
  name: string;
  signPub: string;
  boxPub: string;
  kdf: KdfParams;
  nonce: string;
  sealed: string;
};

/** What unlocking gives: the device keys and the data key for prekey secrets. */
export type Unlocked = { keys: DeviceKeys; data: Uint8Array };

/** A passphrase that does not open the key file (or a file changed since it was sealed). */
export class BadPassphrase extends Error {
  override readonly name = "BadPassphrase";
  constructor() {
    super("the passphrase does not open this key file");
  }
}

const FILE_LABEL = "wim-agent/1 key file\n";
const PREKEY_LABEL = "wim-agent/1 prekey\n";

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** ChaCha20-Poly1305 with a fresh 12-byte nonce, from Node's crypto. */
function aeadSeal(key: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): { nonce: Uint8Array; sealed: Uint8Array } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { nonce, sealed: new Uint8Array(body) };
}

/** Opens what `aeadSeal` sealed; undefined when the key, nonce, AAD or bytes are wrong. */
function aeadOpen(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Uint8Array | undefined {
  try {
    const decipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad, { plaintextLength: sealed.length - 16 });
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    return new Uint8Array(Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]));
  } catch {
    return undefined;
  }
}

const scryptAsync = promisify(scrypt) as (password: string, salt: Uint8Array, length: number, options: ScryptOptions) => Promise<Buffer>;

/** The key-encryption key: scrypt over the passphrase (NFC, so one passphrase has one spelling). */
async function derive(passphrase: string, kdf: KdfParams): Promise<Uint8Array> {
  const opts: ScryptOptions = { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r + 1024 * 1024 };
  return new Uint8Array(await scryptAsync(passphrase.normalize("NFC"), b64u.decode(kdf.salt), 32, opts));
}

/** The authenticated, public part of a version 2 file. */
function fileAad(file: Omit<SealedKeyFile, "nonce" | "sealed">): Uint8Array {
  return concat(utf8(FILE_LABEL), canonBytes({ v: file.v, id: file.id, name: file.name, signPub: file.signPub, boxPub: file.boxPub, kdf: file.kdf }));
}

/** Encrypts a device's keys under `passphrase`, with a new data key unless `data` keeps the old one. */
export async function sealKeyFile(o: { name: string; keys: DeviceKeys; passphrase: string; data?: Uint8Array; kdf?: { N: number; r: number; p: number } }): Promise<SealedKeyFile> {
  const kdf: KdfParams = { alg: "scrypt", ...(o.kdf ?? DEFAULT_KDF), salt: b64u.encode(randomBytes(16)) };
  const pub = { v: 2 as const, id: deviceIdFromSignPub(o.keys.signPub), name: o.name, signPub: b64u.encode(o.keys.signPub), boxPub: b64u.encode(o.keys.boxPub), kdf };
  const key = await derive(o.passphrase, kdf);
  const secrets = canonBytes({ signSec: b64u.encode(o.keys.signSec), boxSec: b64u.encode(o.keys.boxSec), data: b64u.encode(o.data ?? randomBytes(32)) });
  const { nonce, sealed } = aeadSeal(key, fileAad(pub), secrets);
  key.fill(0);
  secrets.fill(0);
  return { ...pub, nonce: b64u.encode(nonce), sealed: b64u.encode(sealed) };
}

/** Reads a parsed `device.json` of version 2; throws on any field out of shape. */
export function parseSealedKeyFile(raw: Record<string, unknown>): SealedKeyFile {
  const str = (v: unknown): v is string => typeof v === "string" && v !== "";
  const kdf = raw["kdf"] as Partial<KdfParams> | undefined;
  const int = (v: unknown, max: number): boolean => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= max;
  const ok =
    raw["v"] === 2 &&
    str(raw["id"]) &&
    isName(raw["name"]) &&
    str(raw["signPub"]) &&
    str(raw["boxPub"]) &&
    str(raw["nonce"]) &&
    str(raw["sealed"]) &&
    typeof kdf === "object" &&
    kdf !== null &&
    kdf.alg === "scrypt" &&
    int(kdf.N, MAX_N) &&
    int(kdf.r, 32) &&
    int(kdf.p, 16) &&
    str(kdf.salt);
  if (!ok) throw new TypeError("the encrypted key file is malformed");
  const file = raw as SealedKeyFile;
  if (deviceIdFromSignPub(b64u.decode(file.signPub)) !== file.id) throw new TypeError("the encrypted key file's id does not match its signing key");
  return { v: 2, id: file.id, name: file.name, signPub: file.signPub, boxPub: file.boxPub, kdf: { alg: "scrypt", N: kdf.N!, r: kdf.r!, p: kdf.p!, salt: kdf.salt! }, nonce: file.nonce, sealed: file.sealed };
}

/** Decrypts a version 2 key file. Throws BadPassphrase for a wrong passphrase or a tampered file. */
export async function openKeyFile(file: SealedKeyFile, passphrase: string): Promise<Unlocked> {
  const key = await derive(passphrase, file.kdf);
  const bytes = aeadOpen(key, b64u.decode(file.nonce), fileAad(file), b64u.decode(file.sealed));
  key.fill(0);
  if (bytes === undefined) throw new BadPassphrase();
  // Authenticated, so written by sealKeyFile: the three fields are there.
  const secrets = JSON.parse(fromUtf8(bytes)) as Record<"signSec" | "boxSec" | "data", string>;
  bytes.fill(0);
  const decode = (name: keyof typeof secrets): Uint8Array => b64u.decode(secrets[name]);
  const keys = deviceKeysFromSecrets(decode("signSec"), decode("boxSec"));
  if (b64u.encode(keys.signPub) !== file.signPub || b64u.encode(keys.boxPub) !== file.boxPub) throw new TypeError("the encrypted key file's public keys do not match its secrets");
  return { keys, data: decode("data") };
}

function prekeyAad(prekey: Prekey): Uint8Array {
  return concat(utf8(PREKEY_LABEL), canonBytes(prekey));
}

/** Seals a prekey secret under the data key, bound to the whole signed prekey (its `until` included). */
export function sealPrekeySecret(data: Uint8Array, prekey: Prekey, secret: Uint8Array): string {
  const { nonce, sealed } = aeadSeal(data, prekeyAad(prekey), secret);
  return b64u.encode(concat(nonce, sealed));
}

/** Opens what `sealPrekeySecret` sealed for this very prekey; undefined for anything else. */
export function openPrekeySecret(data: Uint8Array, prekey: Prekey, sealed: string): Uint8Array | undefined {
  let bytes: Uint8Array;
  try {
    bytes = b64u.decode(sealed);
  } catch {
    return undefined;
  }
  if (bytes.length !== 12 + 32 + 16) return undefined;
  return aeadOpen(data, bytes.subarray(0, 12), prekeyAad(prekey), bytes.subarray(12));
}
