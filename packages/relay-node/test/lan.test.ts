import { X509Certificate } from "node:crypto";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { b64u } from "@worldinmotion/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { certPin, derTime, lanAddress, lanCert, selfSignedCert, start, type RunningRelay } from "../src/index.ts";
import { Dial, pinnedConnection, scratchDir } from "./helpers.ts";

const running: RunningRelay[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.close();
});

const MESH = b64u.encode(new Uint8Array(16).fill(1));

describe("LAN mode", () => {
  it("serves wss with a self-signed certificate that a pinned client accepts and a wrong pin refuses", async () => {
    const db = join(await scratchDir(), "relay.db");
    const lines: string[] = [];
    const r = await start({ db, port: 0, lan: true, host: "127.0.0.1", log: (l) => void lines.push(l) });
    running.push(r);
    const url = r.relayUrls[0]!;
    expect(url).toBe(`wss://127.0.0.1:${r.port}`);
    expect(r.pin).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(lines.join("\n")).toContain(`LAN relay URL: ${url}`);
    expect(lines.join("\n")).toContain(`TLS pin (SPKI SHA-256, for the invite): ${r.pin}`);

    const good = new Dial(`${url}/v1/${MESH}`, { createConnection: pinnedConnection(r.pin!) });
    expect((await good.next())["t"]).toBe("hello");
    good.ws.close();

    const wrong = new Dial(`${url}/v1/${MESH}`, { createConnection: pinnedConnection("A".repeat(43)) });
    await expect(wrong.opened()).rejects.toThrow(/pin mismatch/);

    // An ordinary client doing CA validation refuses the self-signed certificate.
    const plain = new Dial(`${url}/v1/${MESH}`);
    await expect(plain.opened()).rejects.toThrow();
  });

  it("keeps its key and certificate next to the database, 0600, and reuses them", async () => {
    const db = join(await scratchDir(), "relay.db");
    const first = await start({ db, port: 0, lan: true, host: "127.0.0.1", log: () => {} });
    await first.close();
    if (process.platform !== "win32") {
      expect(statSync(`${db}.key.pem`).mode & 0o777).toBe(0o600);
      expect(statSync(`${db}.cert.pem`).mode & 0o777).toBe(0o600);
    }
    const second = await start({ db, port: 0, lan: true, host: "127.0.0.1", log: () => {} });
    running.push(second);
    expect(second.pin).toBe(first.pin);
  });

  it("refuses to start over a key path it cannot read, and never replaces half a pair", async () => {
    const now = new Date("2026-10-24T00:00:00Z");
    const odd = join(await scratchDir(), "relay.db");
    mkdirSync(`${odd}.key.pem`);
    expect(() => lanCert(odd, ["127.0.0.1"], now)).toThrow(/EISDIR/);
    // A key with no certificate is left alone: `wx` refuses to write over it.
    const half = join(await scratchDir(), "relay.db");
    const made = lanCert(half, ["127.0.0.1"], now);
    expect(lanCert(half, ["127.0.0.1"], now)).toEqual(made);
    rmSync(`${half}.cert.pem`);
    expect(() => lanCert(half, ["127.0.0.1"], now)).toThrow(/EEXIST/);
  });

  it("binds the LAN address by default", async () => {
    // Only meaningful where the machine has one; the address choice itself is tested below.
    let host: string;
    try {
      host = lanAddress((await import("node:os")).networkInterfaces());
    } catch {
      return;
    }
    const r = await start({ db: join(await scratchDir(), "relay.db"), port: 0, lan: true, log: () => {} });
    running.push(r);
    expect(r.relayUrls).toEqual([`wss://${host}:${r.port}`]);
  });
});

describe("certificates", () => {
  it("makes a valid self-signed ECDSA P-256 certificate naming its hosts", () => {
    const { cert } = selfSignedCert(["192.168.1.20", "relay.lan"], new Date("2026-10-24T00:00:00Z"));
    const x = new X509Certificate(cert);
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(x.subjectAltName).toBe("IP Address:192.168.1.20, DNS:relay.lan");
    expect(x.subject).toBe("CN=wim-relay");
    expect(new Date(x.validFrom).toISOString()).toBe("2026-10-24T00:00:00.000Z");
    expect(certPin(cert)).toHaveLength(43);
  });

  it("always encodes a minimal positive serial, so every certificate verifies", () => {
    for (let i = 0; i < 300; i++) {
      const x = new X509Certificate(selfSignedCert(["127.0.0.1"], new Date("2026-10-24T00:00:00Z")).cert);
      expect(x.serialNumber).toMatch(/^[4-7]/);
      expect(x.verify(x.publicKey)).toBe(true);
    }
  });

  it("encodes times as UTCTime through 2049 and GeneralizedTime after", () => {
    expect(Buffer.from(derTime(new Date("2049-12-31T23:59:59Z"))).toString("latin1")).toBe("\x17\x0d491231235959Z");
    expect(Buffer.from(derTime(new Date("2050-01-01T00:00:00Z"))).toString("latin1")).toBe("\x18\x0f20500101000000Z");
    const { cert } = selfSignedCert(["h".repeat(200)], new Date("2051-01-01T00:00:00Z"));
    expect(new Date(new X509Certificate(cert).validFrom).getUTCFullYear()).toBe(2051);
  });

  it("picks the first non-internal IPv4 address, and refuses when there is none", () => {
    const iface = (address: string, family: "IPv4" | "IPv6", internal: boolean) =>
      ({ address, family, internal, netmask: "", mac: "", cidr: null }) as never;
    expect(lanAddress({ lo: [iface("127.0.0.1", "IPv4", true)], none: undefined, eth0: [iface("fe80::1", "IPv6", false), iface("192.168.1.9", "IPv4", false)] })).toBe(
      "192.168.1.9",
    );
    expect(() => lanAddress({ lo: [iface("127.0.0.1", "IPv4", true)] })).toThrow(/no LAN/);
  });
});
