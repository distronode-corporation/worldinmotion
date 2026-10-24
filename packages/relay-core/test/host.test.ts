import { b64u, sha256, utf8 } from "@worldinmotion/protocol";
import { describe, expect, it } from "vitest";
import { LIMITS } from "@worldinmotion/protocol";
import { readFileSync } from "node:fs";
import {
  CREATE_CLOSED,
  CREATE_MISCONFIGURED,
  createRule,
  healthz,
  isInfoPath,
  parseDialPath,
  parseRelayUrls,
  RELAY_VERSION,
  relayInfo,
  relaySettings,
  sourceBucket,
  sourceKey,
} from "../src/index.ts";
import { MESH } from "./helpers.ts";

describe("parseDialPath", () => {
  it("takes /v1/<mesh id>, with or without a path prefix in front", () => {
    expect(parseDialPath(`/v1/${MESH}`)).toEqual({ ok: true, meshId: MESH });
    expect(parseDialPath(`/relay/v1/${MESH}`)).toEqual({ ok: true, meshId: MESH });
  });

  it("answers 404 for anything that is not a dial path", () => {
    for (const path of ["/", "/healthz", "/v1", `/v1/${MESH}/`, `/v2/${MESH}`, `/v1/${MESH}/x`]) {
      expect(parseDialPath(path), path).toEqual({ ok: false, status: 404, error: "not found" });
    }
  });

  it("answers 400 for a dial path whose mesh id is not 16 bytes of canonical base64url", () => {
    for (const id of ["", "short", "not-a-mesh-id", "A".repeat(23), "AAAAAAAAAAAAAAAAAAAAA!", "AAAAAAAAAAAAAAAAAAAAAB"]) {
      expect(parseDialPath(`/v1/${id}`), id).toEqual({ ok: false, status: 400, error: "invalid mesh id" });
    }
  });
});

describe("sourceKey", () => {
  it("is the first 22 characters of b64u(SHA-256(address)), never the address", () => {
    const k = sourceKey("203.0.113.7");
    expect(k).toBe(b64u.encode(sha256(utf8("203.0.113.7"))).slice(0, 22));
    expect(k).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(k).not.toContain("203");
    expect(sourceKey("203.0.113.8")).not.toBe(k);
  });
});

describe("sourceBucket", () => {
  it("keeps an IPv4 address whole, and treats IPv4-mapped IPv6 as IPv4", () => {
    expect(sourceBucket("203.0.113.7")).toBe("203.0.113.7");
    for (const mapped of ["::ffff:203.0.113.7", "::FFFF:203.0.113.7", "0:0:0:0:0:ffff:cb00:7107", "[::ffff:203.0.113.7]"]) {
      expect(sourceBucket(mapped), mapped).toBe("203.0.113.7");
    }
    expect(sourceKey("::ffff:203.0.113.7")).toBe(sourceKey("203.0.113.7"));
  });

  it("buckets IPv6 by /64, however the address is spelled", () => {
    const net = "2001:db8:1:2::/64";
    for (const a of ["2001:db8:1:2::1", "2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:0DB8:0001:0002:0:0:0:ffff", "[2001:db8:1:2::9]", "2001:db8:1:2::7%eth0", "2001:db8:1:2:0:0:1.2.3.4"]) {
      expect(sourceBucket(a), a).toBe(net);
    }
    expect(sourceKey("2001:db8:1:2::1")).toBe(sourceKey("2001:db8:1:2:ffff::1"));
    expect(sourceBucket("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(sourceBucket("::1")).toBe("0:0:0:0::/64");
    expect(sourceBucket("fe80::")).toBe("fe80:0:0:0::/64");
  });

  it("leaves anything that is not an IP address as it is", () => {
    for (const odd of ["", "unknown", "1:2:3", "1::2::3", "1:2:3:4:5:6:7:8:9", "12345::", "g::1", "::ffff:1.2.3.999", "1:2:3:4:5:6:7:8::"]) {
      expect(sourceBucket(odd), odd).toBe(odd);
    }
  });
});

describe("parseRelayUrls", () => {
  it("reads a comma list, trimmed, without empty entries", () => {
    expect(parseRelayUrls(" wss://a.example , wss://b.example/wim ,")).toEqual(["wss://a.example", "wss://b.example/wim"]);
    expect(parseRelayUrls(undefined)).toEqual([]);
    expect(parseRelayUrls(" , ")).toEqual([]);
  });

  it("refuses an invalid entry by position, without echoing it", () => {
    expect(() => parseRelayUrls("wss://a.example,wss://user:secret@b.example")).toThrow(/^WIM_RELAY_URLS entry 2 is not a relay URL/);
    try {
      parseRelayUrls("wss://user:secret@b.example");
    } catch (e) {
      expect((e as Error).message).not.toContain("secret");
    }
    for (const bad of ["https://relay.example.com", "wss://relay.example.com/", "ws://relay.example.com"]) {
      expect(() => parseRelayUrls(bad), bad).toThrow(/entry 1 is not a relay URL/);
    }
  });
});

describe("createRule", () => {
  it("requires a key when WIM_CREATE_KEY is set", () => {
    expect(createRule({ WIM_CREATE_KEY: "k" })).toEqual({ createKey: "k" });
    expect(createRule({ WIM_CREATE_KEY: "k", WIM_OPEN_CREATE: "0" })).toEqual({ createKey: "k" });
  });

  it("opens creation only with WIM_OPEN_CREATE=1 or true", () => {
    expect(createRule({ WIM_OPEN_CREATE: "1" })).toEqual({});
    expect(createRule({ WIM_OPEN_CREATE: "true" })).toEqual({});
  });

  it("refuses creation by default, without calling it a problem", () => {
    for (const open of [undefined, "", "0", "false"]) {
      expect(createRule({ WIM_OPEN_CREATE: open }), String(open)).toEqual({ createRefused: CREATE_CLOSED });
    }
  });

  it("treats an empty key, both settings, or an unreadable flag as a problem that refuses creation", () => {
    const cases: [Record<string, string>, string][] = [
      [{ WIM_CREATE_KEY: "" }, "WIM_CREATE_KEY is set but empty"],
      [{ WIM_CREATE_KEY: " \n" }, "WIM_CREATE_KEY is set but empty"],
      [{ WIM_CREATE_KEY: "", WIM_OPEN_CREATE: "1" }, "WIM_CREATE_KEY is set but empty"],
      [{ WIM_CREATE_KEY: "k", WIM_OPEN_CREATE: "1" }, "set WIM_CREATE_KEY or WIM_OPEN_CREATE=1, not both"],
      [{ WIM_OPEN_CREATE: "yes" }, "WIM_OPEN_CREATE must be 1 or 0"],
    ];
    for (const [env, problem] of cases) {
      const rule = createRule(env);
      expect(rule, JSON.stringify(env)).toEqual({ createRefused: CREATE_MISCONFIGURED, problem });
      expect(rule.createKey).toBeUndefined();
    }
    // The problem names the setting, never its value.
    expect(createRule({ WIM_CREATE_KEY: "s3cret-value", WIM_OPEN_CREATE: "1" }).problem).not.toContain("s3cret");
  });
});

describe("healthz", () => {
  it("is 200 ok without a problem and 503 with it", () => {
    expect(healthz(undefined)).toEqual({ status: 200, body: { ok: true } });
    expect(healthz("WIM_CREATE_KEY is set but empty")).toEqual({ status: 503, body: { ok: false, error: "WIM_CREATE_KEY is set but empty" } });
  });
});

describe("relaySettings", () => {
  it("has safe defaults: creation closed, no cap, no expiry, the protocol limits, no offer", () => {
    expect(relaySettings({})).toEqual({ createRefused: CREATE_CLOSED, limits: {} });
  });

  it("reads every guardrail", () => {
    expect(
      relaySettings({
        WIM_OPEN_CREATE: "1",
        WIM_MAX_MESHES: "2000",
        WIM_IDLE_MESH_DAYS: "90",
        WIM_BLOB_BYTES_PER_MESH_PER_DAY: "25MiB",
        WIM_BLOB_BYTES_PER_DEVICE_PER_DAY: "10 MiB",
        WIM_BLOB_BYTES_PER_MESH: "524288",
        WIM_OFFER: "  Free hosted relay during the preview, until version 1.0  ",
      }),
    ).toEqual({
      maxMeshes: 2000,
      idleMeshDays: 90,
      limits: { blobBytesPerMeshPerDay: 25 * 1024 * 1024, blobBytesPerDevicePerDay: 10 * 1024 * 1024, blobBytesPerMesh: 524288 },
      offer: "Free hosted relay during the preview, until version 1.0",
    });
    expect(relaySettings({ WIM_BLOB_BYTES_PER_MESH: "1GiB", WIM_BLOB_BYTES_PER_DEVICE_PER_DAY: "1KiB", WIM_MAX_MESHES: "", WIM_OFFER: " " }).limits).toEqual({
      blobBytesPerMesh: LIMITS.blobBytesPerMesh,
      blobBytesPerDevicePerDay: 1024,
    });
  });

  it("calls a bad value a problem, refuses creation, and keeps the safe default for that setting", () => {
    const cases: [Record<string, string>, string][] = [
      [{ WIM_MAX_MESHES: "0" }, "WIM_MAX_MESHES must be a whole number of 1 or more"],
      [{ WIM_MAX_MESHES: "lots" }, "WIM_MAX_MESHES must be a whole number of 1 or more"],
      [{ WIM_IDLE_MESH_DAYS: "1.5" }, "WIM_IDLE_MESH_DAYS must be a whole number of 1 or more"],
      [{ WIM_BLOB_BYTES_PER_MESH_PER_DAY: "2GiB" }, `WIM_BLOB_BYTES_PER_MESH_PER_DAY must be a byte count from 1 to ${LIMITS.blobBytesPerMeshPerDay}: it may only lower the protocol limit`],
      [{ WIM_BLOB_BYTES_PER_MESH: "0" }, `WIM_BLOB_BYTES_PER_MESH must be a byte count from 1 to ${LIMITS.blobBytesPerMesh}: it may only lower the protocol limit`],
      [{ WIM_BLOB_BYTES_PER_DEVICE_PER_DAY: "25 MB" }, `WIM_BLOB_BYTES_PER_DEVICE_PER_DAY must be a byte count from 1 to ${LIMITS.blobBytesPerDevicePerDay}: it may only lower the protocol limit`],
      [{ WIM_OFFER: "line one\nline two" }, "WIM_OFFER must be one line of at most 280 printable characters"],
      [{ WIM_OFFER: "x".repeat(281) }, "WIM_OFFER must be one line of at most 280 printable characters"],
      [{ WIM_OFFER: "hidden\u202Etext" }, "WIM_OFFER must be one line of at most 280 printable characters"],
    ];
    for (const [env, problem] of cases) {
      expect(relaySettings({ WIM_OPEN_CREATE: "1", ...env }), JSON.stringify(env)).toEqual({ createRefused: CREATE_MISCONFIGURED, problem, limits: {} });
    }
    // A create problem comes first, and still refuses creation.
    expect(relaySettings({ WIM_CREATE_KEY: "", WIM_MAX_MESHES: "x" })).toMatchObject({ problem: "WIM_CREATE_KEY is set but empty", createRefused: CREATE_MISCONFIGURED });
  });
});

describe("relayInfo", () => {
  it("describes the create rule and the effective limits, with no secret and no live count", () => {
    const info = relayInfo(relaySettings({ WIM_CREATE_KEY: "s3cret", WIM_MAX_MESHES: "2000", WIM_BLOB_BYTES_PER_MESH_PER_DAY: "25MiB", WIM_OFFER: "Free during the preview" }));
    expect(info).toEqual({
      v: 1,
      software: "worldinmotion-relay",
      version: RELAY_VERSION,
      create: "key",
      limits: { max_meshes: 2000, idle_mesh_days: null, blob_bytes_per_mesh_per_day: 25 * 1024 * 1024 },
      offer: "Free during the preview",
    });
    expect(JSON.stringify(info)).not.toContain("s3cret");
    expect(relayInfo(relaySettings({ WIM_OPEN_CREATE: "1", WIM_IDLE_MESH_DAYS: "30" }))).toEqual({
      v: 1,
      software: "worldinmotion-relay",
      version: RELAY_VERSION,
      create: "open",
      limits: { max_meshes: null, idle_mesh_days: 30, blob_bytes_per_mesh_per_day: LIMITS.blobBytesPerMeshPerDay },
      offer: null,
    });
    expect(relayInfo(relaySettings({ WIM_CREATE_KEY: "" })).create).toBe("closed");
    expect(relayInfo(relaySettings({})).create).toBe("closed");
    // An offer of exactly 280 characters is taken.
    expect(relayInfo(relaySettings({ WIM_OFFER: "y".repeat(280) })).offer).toHaveLength(280);
  });

  it("reports the relay-core package version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(RELAY_VERSION).toBe(pkg.version);
  });

  it("is served at <prefix>/v1/info", () => {
    expect(isInfoPath("/v1/info")).toBe(true);
    expect(isInfoPath("/wim/v1/info")).toBe(true);
    for (const p of ["/v1/info/", "/info", "/v1/infos", "/v2/info"]) expect(isInfoPath(p), p).toBe(false);
  });
});
