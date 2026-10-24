import { describe, expect, it } from "vitest";
import { CREATE_CLOSED, CREATE_MISCONFIGURED } from "@worldinmotion/relay-core";
import { configFromEnv } from "../src/index.ts";

describe("configFromEnv", () => {
  it("has defaults for a local relay", () => {
    expect(configFromEnv({}, [])).toEqual({
      db: "wim-relay.db",
      port: 8787,
      host: undefined,
      relayUrls: undefined,
      createRefused: CREATE_CLOSED,
      limits: {},
      trustProxy: false,
      lan: false,
    });
  });

  it("reads the guardrails", () => {
    const env = { WIM_OPEN_CREATE: "1", WIM_MAX_MESHES: "2000", WIM_IDLE_MESH_DAYS: "90", WIM_BLOB_BYTES_PER_MESH_PER_DAY: "25MiB", WIM_OFFER: "Free" };
    expect(configFromEnv(env, [])).toMatchObject({ maxMeshes: 2000, idleMeshDays: 90, limits: { blobBytesPerMeshPerDay: 25 * 1024 * 1024 }, offer: "Free" });
    expect(configFromEnv({ WIM_OPEN_CREATE: "1", WIM_MAX_MESHES: "none" }, [])).toMatchObject({ problem: "WIM_MAX_MESHES must be a whole number of 1 or more" });
  });

  it("opens creation only with WIM_OPEN_CREATE=1, and calls an empty WIM_CREATE_KEY a problem, not no key", () => {
    const open = configFromEnv({ WIM_OPEN_CREATE: "1" }, []);
    expect([open.createKey, open.createRefused, open.problem]).toEqual([undefined, undefined, undefined]);
    const empty = configFromEnv({ WIM_CREATE_KEY: "" }, []);
    expect([empty.createKey, empty.createRefused, empty.problem]).toEqual([undefined, CREATE_MISCONFIGURED, "WIM_CREATE_KEY is set but empty"]);
  });

  it("reads every variable and --lan", () => {
    const env = {
      WIM_RELAY_URLS: " wss://a.example , wss://b.example/wim,",
      PORT: "9000",
      WIM_HOST: "0.0.0.0",
      WIM_DB: "/data/relay.db",
      WIM_CREATE_KEY: "k",
      WIM_TRUST_PROXY: "true",
    };
    expect(configFromEnv(env, ["--lan"])).toEqual({
      db: "/data/relay.db",
      port: 9000,
      host: "0.0.0.0",
      relayUrls: ["wss://a.example", "wss://b.example/wim"],
      createKey: "k",
      limits: {},
      trustProxy: true,
      lan: true,
    });
    expect(configFromEnv({ WIM_LAN: "1", WIM_TRUST_PROXY: "1" }, [])).toMatchObject({ lan: true, trustProxy: true });
  });

  it("refuses a bad port or an unknown argument", () => {
    expect(() => configFromEnv({ PORT: "x" }, [])).toThrow(/invalid PORT/);
    expect(() => configFromEnv({ PORT: "70000" }, [])).toThrow(/invalid PORT/);
    expect(() => configFromEnv({ PORT: "-1" }, [])).toThrow(/invalid PORT/);
    expect(() => configFromEnv({}, ["--help"])).toThrow(/unknown argument/);
    expect(() => configFromEnv({ WIM_RELAY_URLS: "wss://relay.example/" }, [])).toThrow(/WIM_RELAY_URLS entry 1 is not a relay URL/);
  });
});
