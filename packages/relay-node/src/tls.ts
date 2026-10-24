import { generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { NetworkInterfaceInfo } from "node:os";
import { spkiPin } from "@worldinmotion/protocol";

/*
 * A self-signed certificate for LAN mode. node:crypto makes the ECDSA P-256 key and the signature
 * but cannot build an X.509 certificate (X509Certificate only parses one), so the few DER
 * structures a certificate needs are encoded here instead of adding a dependency. Clients never
 * validate this certificate against a CA: they pin the hash of its public key (SPKI), which the
 * relay prints for the invite.
 */

function length(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return [0x80 | bytes.length, ...bytes];
}

function tlv(tag: number, ...content: Uint8Array[]): Uint8Array {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag, ...length(body.length)]), body]);
}

const seq = (...items: Uint8Array[]) => tlv(0x30, ...items);

function oid(dotted: string): Uint8Array {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [a! * 40 + b!];
  for (const n of rest) {
    const groups: number[] = [n & 0x7f];
    for (let v = n >>> 7; v > 0; v >>>= 7) groups.unshift((v & 0x7f) | 0x80);
    out.push(...groups);
  }
  return tlv(0x06, Buffer.from(out));
}

/** RFC 5280: UTCTime through 2049, GeneralizedTime from 2050. */
export function derTime(date: Date): Uint8Array {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso));
}

const ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** A subjectAltName entry: an IPv4 address as iPAddress, anything else as dNSName. */
function altName(host: string): Uint8Array {
  const ip = IPV4.exec(host);
  return ip ? tlv(0x87, Buffer.from(ip.slice(1).map(Number))) : tlv(0x82, Buffer.from(host));
}

/** A PEM pair: an ECDSA P-256 key and a self-signed certificate for `hosts`, valid from `now`. */
export function selfSignedCert(hosts: string[], now: Date): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const serial = randomBytes(16);
  // Positive (top bit clear) and minimal DER (a first byte of zero would need the next byte's
  // top bit set): any first byte from 0x40 to 0x7f satisfies both.
  serial[0] = (serial[0]! & 0x3f) | 0x40;
  const name = seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from("wim-relay")))));
  const algorithm = seq(oid(ECDSA_SHA256));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), // version 3
    tlv(0x02, serial),
    algorithm,
    name,
    // "No well-defined expiration" (RFC 5280 section 4.1.2.5): the pin, not a date, is the trust.
    seq(derTime(now), tlv(0x18, Buffer.from("99991231235959Z"))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    tlv(0xa3, seq(seq(oid("2.5.29.17"), tlv(0x04, seq(...hosts.map(altName)))))),
  );
  const signature = sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  const der = seq(tbs, algorithm, tlv(0x03, Buffer.from([0]), signature));
  const cert = `-----BEGIN CERTIFICATE-----\n${Buffer.from(der).toString("base64").replace(/.{1,64}/g, "$&\n")}-----END CERTIFICATE-----\n`;
  return { key: privateKey.export({ type: "pkcs8", format: "pem" }) as string, cert };
}

/** The SPKI pin of a PEM certificate, as an invite's `tls` field carries it. */
export function certPin(certPem: string): string {
  const spki = new X509Certificate(certPem).publicKey.export({ type: "spki", format: "der" });
  return spkiPin(new Uint8Array(spki));
}

/**
 * The LAN certificate kept next to the database (`<db>.key.pem`, `<db>.cert.pem`, both 0600),
 * created on first start and reused after, so the pin in issued invites stays valid.
 */
export function lanCert(db: string, hosts: string[], now: Date): { key: string; cert: string; pin: string } {
  const keyPath = `${db}.key.pem`;
  const certPath = `${db}.cert.pem`;
  // Read first and create only on ENOENT, so there is no separate existence check to race.
  let pair: { key: string; cert: string };
  try {
    pair = { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    pair = selfSignedCert(hosts, now);
    // `wx` refuses to overwrite, and the mode applies at creation, so the key is never readable by others.
    writeFileSync(keyPath, pair.key, { mode: 0o600, flag: "wx" });
    writeFileSync(certPath, pair.cert, { mode: 0o600, flag: "wx" });
  }
  return { ...pair, pin: certPin(pair.cert) };
}

/** The first non-internal IPv4 address, which LAN peers can reach. */
export function lanAddress(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string {
  for (const list of Object.values(interfaces)) {
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) return i.address;
  }
  throw new Error("LAN mode: no LAN (non-internal IPv4) address found");
}
