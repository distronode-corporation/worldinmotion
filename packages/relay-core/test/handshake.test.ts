import { CLOSE, b64u, createGenesisRoster, generateDeviceKeys, randomBytes, rosterRef, signAuth } from "@worldinmotion/protocol";
import { describe, expect, it } from "vitest";
import { MeshRelay, type MeshStore } from "../src/index.ts";
import { Client, dev, Harness, KINDS, makeStore, MESH, publish, RELAY, roster, T0, world } from "./helpers.ts";

describe("config", () => {
  const host = { store: makeStore("memory"), now: () => T0, connections: () => [], getState: () => undefined, setState: () => {}, log: () => {} };
  it("needs at least one relay URL", () => {
    expect(() => new MeshRelay({ meshId: MESH, relayUrls: [] }, host)).toThrow(/relay URL/);
  });
  it("refuses a bad relay URL or mesh id", () => {
    expect(() => new MeshRelay({ meshId: MESH, relayUrls: ["https://x"] }, host)).toThrow();
    expect(() => new MeshRelay({ meshId: "nope", relayUrls: [RELAY] }, host)).toThrow();
  });
  it("takes lower limits", () => {
    const r = new MeshRelay({ meshId: MESH, relayUrls: [RELAY], limits: { sendBurst: 2 } }, host);
    expect(r.limits.sendBurst).toBe(2);
    expect(r.limits.sendsPerMinute).toBe(60);
  });
});

describe.each(KINDS)("handshake (%s store)", (kind) => {
  it("opens with hello and a fresh nonce per connection", () => {
    const h = new Harness(makeStore(kind));
    const a = h.open().take()[0]!;
    const b = h.open().take()[0]!;
    expect(a).toMatchObject({ t: "hello", v: 1, at: T0 });
    expect(a["nonce"]).not.toBe(b["nonce"]);
    expect(b64u.decode(a["nonce"] as string)).toHaveLength(32);
  });

  it("is active while an authenticated connection is open, and not for one still before auth", () => {
    const w = world(kind);
    expect(w.h.relay.active()).toBe(true);
    const pre = w.h.open();
    w.h.drop(w.root.conn);
    expect(w.h.relay.active()).toBe(false);
    w.h.drop(pre);
    expect(w.h.relay.active()).toBe(false);
  });

  it("closes a connection that does not authenticate within 10 seconds", () => {
    const w = world(kind);
    const c = w.h.open();
    w.h.advance(9_999);
    expect(c.closed).toBeUndefined();
    w.h.advance(1);
    expect(c.closed).toEqual({ code: CLOSE.authTimeout, reason: "auth timeout" });
    // The authenticated root session is untouched by the sweep.
    expect(w.root.conn.closed).toBeUndefined();
  });

  it("ignores frames for unknown or closed connections", () => {
    const w = world(kind);
    const c = w.h.open();
    c.take();
    w.h.drop(c);
    w.h.sendFrame(c, { t: "ping" });
    w.h.relay.onClose(c);
    expect(c.sent).toEqual([]);
    const stranger = { id: "zz", send: () => expect.unreachable(), close: () => expect.unreachable() };
    w.h.relay.onMessage(stranger, "{}");
    w.h.relay.onClose(stranger);
  });

  it("authenticates a device in the roster and answers ready", () => {
    const w = world(kind, ["laptop"]);
    const a = new Client(w.h, w.members[0]!, "writer");
    const frames = a.connect();
    expect(frames[0]).toMatchObject({ t: "ready", sid: a.sid, name: "writer", cursor: 0, more: false });
    expect(frames[0]!["roster"]).toEqual(roster(w.h));
    expect(frames[0]!["peers"]).toEqual([{ address: "root@admin", sid: w.root.sid, kind: "cli", status: "idle", since: T0, rooms: [] }]);
    // Everyone else hears about the new session.
    expect(w.root.conn.last("peer")["peer"]).toMatchObject({ address: "writer@laptop", status: "idle" });
  });

  it("says more when the pin is more than one roster behind", () => {
    const w = world(kind, ["a", "b", "c"]);
    const c = new Client(w.h, w.members[0]!, "x");
    expect(c.connect({ pin: rosterRef(w.chain[0]!) })[0]!["more"]).toBe(true);
    const d = new Client(w.h, w.members[0]!, "y");
    expect(d.connect({ pin: rosterRef(w.chain[2]!) })[0]!["more"]).toBe(false);
  });

  const refusals: [string, (w: ReturnType<typeof world>, c: Client, nonce: string) => unknown, string][] = [
    ["an unknown mesh", (w, c, nonce) => ({ ...c.authFrame(nonce), mesh: b64u.encode(new Uint8Array(16)) }), "unknown mesh"],
    ["a device not in the roster", (w, _c, nonce) => new Client(w.h, dev("ghost"), "x").authFrame(nonce), "the device is not in the roster"],
    ["the wrong relay URL", (_w, c, nonce) => c.authFrame(nonce, { relay: "wss://other.example" }), "wrong_relay"],
    ["another connection's nonce (replay)", (_w, c) => c.authFrame(b64u.encode(randomBytes(32))), "wrong_nonce"],
    ["a clock more than 5 minutes off", (w, c, nonce) => c.authFrame(nonce, { at: w.h.now - 5 * 60_000 - 1 }), "clock_skew"],
    ["a bad signature", (_w, c, nonce) => ({ ...c.authFrame(nonce), sig: c.authFrame(nonce, { at: T0 + 1 }).sig }), "bad_signature"],
    ["a pin newer than the relay's roster", (w, c, nonce) => c.authFrame(nonce, { pin: { seq: 9, hash: rosterRef(roster(w.h)).hash } }), "the pinned roster is newer than any this relay holds"],
  ];
  it.each(refusals)("refuses %s and closes", (_label, build, message) => {
    const w = world(kind, ["laptop"]);
    const c = new Client(w.h, w.members[0]!, "writer");
    c.conn = w.h.open();
    const nonce = c.conn.take()[0]!["nonce"] as string;
    w.h.sendFrame(c.conn, build(w, c, nonce));
    expect(c.conn.take()).toEqual([{ t: "error", code: "unauthorized", message, ref: "auth" }]);
    expect(c.conn.closed?.code).toBe(CLOSE.unauthorized);
  });

  it("refuses auth before the mesh exists", () => {
    const h = new Harness(makeStore(kind));
    const c = new Client(h, dev("admin", "admin"), "x");
    c.conn = h.open();
    const nonce = c.conn.take()[0]!["nonce"] as string;
    const genesis = createGenesisRoster({ name: "admin", keys: c.d.keys, now: T0, meshId: MESH });
    h.sendFrame(c.conn, signAuth({ relay: RELAY, mesh: MESH, nonce, at: T0, session: { name: "x", kind: "cli", sid: c.sid, resume: c.resume }, pin: rosterRef(genesis) }, c.d.keys));
    expect(c.conn.last()).toMatchObject({ code: "unauthorized", message: "unknown mesh" });
  });

  it("refuses a recovery record", () => {
    const w = world(kind);
    const rec = dev("recovery-1", "admin");
    publish(w, { add: [rec.record] });
    const c = new Client(w.h, rec, "x");
    expect(c.connect()[0]).toMatchObject({ code: "unauthorized", message: "recovery records do not connect" });
  });

  it("uses the host's shared source limiter when it has one", () => {
    const seen: string[] = [];
    const h = new Harness(makeStore(kind));
    const relay = new MeshRelay(
      { meshId: MESH, relayUrls: [RELAY] },
      { store: h.store, now: () => h.now, connections: () => h.conns.values(), getState: (c) => h.states.get(c.id), setState: (c, s) => void h.states.set(c.id, s), log: () => {}, allowSource: (s) => (seen.push(s), false) },
    );
    h.relay = relay;
    const c = h.open("addr");
    h.sendFrame(c, { t: "create", roster: createGenesisRoster({ name: "admin", keys: generateDeviceKeys(), now: T0, meshId: MESH }) });
    expect(c.last()).toMatchObject({ code: "limited" });
    expect(seen).toEqual(["addr"]);
  });

  it("refuses a revoked device", () => {
    const w = world(kind, ["laptop"]);
    publish(w, { revoke: [w.members[0]!.id] });
    const c = new Client(w.h, w.members[0]!, "writer");
    c.connect();
    expect(c.conn.closed?.code).toBe(CLOSE.unauthorized);
  });

  it("records a fork when a pin hash differs from the relay's roster at that seq", () => {
    const w = world(kind, ["laptop"]);
    const c = new Client(w.h, w.members[0]!, "writer");
    const other = createGenesisRoster({ name: "admin", keys: generateDeviceKeys(), now: T0, meshId: MESH });
    expect(c.connect({ pin: rosterRef(other) })[0]!["t"]).toBe("ready");
    expect(w.h.store.forks()).toMatchObject([{ kind: "pin", seq: 1, signer: c.d.id, b: rosterRef(other).hash }]);
    expect(w.h.logs.map((l) => l.event)).toContain("fork");
  });

  it("authenticates a connection only once", () => {
    const w = world(kind);
    expect(w.root.frame(w.root.authFrame(b64u.encode(randomBytes(32))))).toEqual([
      { t: "error", code: "unauthorized", message: "this connection is already authenticated", ref: "auth" },
    ]);
    expect(w.root.frame({ t: "create", roster: w.chain[0] })[0]!["ref"]).toBe("create");
  });
});

describe.each(KINDS)("before auth (%s store)", (kind) => {
  const fresh = () => {
    const w = world(kind);
    const c = w.h.open();
    c.take();
    return { w, c };
  };

  it("closes on a frame over 16 KiB", () => {
    const { w, c } = fresh();
    w.h.sendFrame(c, JSON.stringify({ t: "auth", pad: "x".repeat(16 * 1024) }));
    expect(c.take()[0]).toMatchObject({ code: "too_large" });
    expect(c.closed?.code).toBe(CLOSE.protocol);
  });

  it.each([
    ["not json", "{", "malformed"],
    ["a duplicate key", '{"t":"auth","t":"auth"}', "duplicate_key"],
    ["a bad shape", '{"t":"auth"}', "malformed"],
  ])("closes on %s", (_label, text, code) => {
    const { w, c } = fresh();
    w.h.sendFrame(c, text);
    expect(c.take()[0]).toMatchObject({ t: "error", code });
    expect(c.closed?.code).toBe(CLOSE.protocol);
  });

  it("answers a known frame that needs auth with unauthorized, an unknown one with unknown_type, and stays open", () => {
    const { w, c } = fresh();
    w.h.sendFrame(c, { t: "ping" });
    w.h.sendFrame(c, { t: "warp" });
    expect(c.take()).toEqual([
      { t: "error", code: "unauthorized", message: "authenticate first", ref: "ping" },
      { t: "error", code: "unknown_type", message: "unknown frame type", ref: "warp" },
    ]);
    expect(c.closed).toBeUndefined();
  });

  it("rate limits create and join per source address", () => {
    const { w } = fresh();
    for (let i = 0; i < 10; i++) {
      const c = w.h.open("same");
      w.h.sendFrame(c, { t: "create", roster: w.chain[0] });
      expect(c.last()["code"]).toBe("mesh_exists");
    }
    const c = w.h.open("same");
    w.h.sendFrame(c, { t: "create", roster: w.chain[0] });
    expect(c.last()).toMatchObject({ code: "limited", ref: "create" });
    expect(c.closed?.code).toBe(CLOSE.limited);
    // Another address is unaffected, and an hour refills the bucket.
    const other = w.h.open("elsewhere");
    w.h.sendFrame(other, { t: "create", roster: w.chain[0] });
    expect(other.last()["code"]).toBe("mesh_exists");
    w.h.now += 60 * 60_000;
    const later = w.h.open("same");
    w.h.sendFrame(later, { t: "create", roster: w.chain[0] });
    expect(later.last()["code"]).toBe("mesh_exists");
  });
});

describe.each(KINDS)("create (%s store)", (kind) => {
  const genesisFor = (meshId = MESH) => createGenesisRoster({ name: "admin", keys: generateDeviceKeys(), now: T0, meshId });

  it("creates a mesh from a valid genesis roster and answers with it", () => {
    const h = new Harness(makeStore(kind));
    const c = h.open();
    const g = genesisFor();
    h.sendFrame(c, { t: "create", roster: g });
    expect(c.last()).toEqual({ t: "roster", chain: [g], more: false });
    expect(h.store.rosterHead()).toBe(1);
  });

  it("refuses an existing mesh, another mesh's roster and an invalid genesis", () => {
    const h = new Harness(makeStore(kind));
    const c = h.open();
    h.sendFrame(c, { t: "create", roster: genesisFor(b64u.encode(new Uint8Array(16))) });
    expect(c.last()).toMatchObject({ code: "malformed", message: "the roster is for another mesh" });
    h.sendFrame(c, { t: "create", roster: { ...genesisFor(), at: T0 + 1 } });
    expect(c.last()).toMatchObject({ code: "roster_invalid", message: "roster_bad_signature" });
    h.sendFrame(c, { t: "create", roster: genesisFor() });
    h.sendFrame(c, { t: "create", roster: genesisFor() });
    expect(c.last()).toMatchObject({ code: "mesh_exists", ref: "create" });
  });

  it("requires the operator key when one is configured", () => {
    const h = new Harness(makeStore(kind), { createKey: "s3cret" });
    const c = h.open();
    h.sendFrame(c, { t: "create", roster: genesisFor() });
    expect(c.last()).toMatchObject({ code: "unauthorized", ref: "create" });
    h.sendFrame(c, { t: "create", roster: genesisFor(), key: "wrong" });
    expect(c.last()["code"]).toBe("unauthorized");
    h.sendFrame(c, { t: "create", roster: genesisFor(), key: "s3cret" });
    expect(c.last()["t"]).toBe("roster");
  });

  it("refuses a create with full when the host admits no more meshes, and leaves existing meshes alone", () => {
    let admit = false;
    const h = new Harness(makeStore(kind), {}, { admitMesh: () => admit });
    const c = h.open();
    h.sendFrame(c, { t: "create", roster: genesisFor() });
    expect(c.last()).toEqual({ t: "error", code: "full", message: "this relay holds as many meshes as it accepts; try again later", ref: "create" });
    expect(h.relay.exists()).toBe(false);
    // An invalid create is still answered as invalid, before the cap is consulted.
    h.sendFrame(c, { t: "create", roster: { ...genesisFor(), at: T0 + 1 } });
    expect(c.last()).toMatchObject({ code: "roster_invalid" });
    admit = true;
    h.sendFrame(c, { t: "create", roster: genesisFor() });
    expect(c.last()["t"]).toBe("roster");
    // Once full again, the mesh that exists says mesh_exists, not full.
    admit = false;
    h.sendFrame(c, { t: "create", roster: genesisFor() });
    expect(c.last()).toMatchObject({ code: "mesh_exists" });
  });

  it("refuses every create when creation is refused, whatever key it carries, and stores nothing", () => {
    const h = new Harness(makeStore(kind), { createRefused: "this relay does not accept new meshes", createKey: "s3cret" });
    const c = h.open();
    for (const key of [undefined, "s3cret", "wrong"]) {
      h.sendFrame(c, { t: "create", roster: genesisFor(), ...(key === undefined ? {} : { key }) });
      expect(c.last()).toEqual({ t: "error", code: "unauthorized", message: "this relay does not accept new meshes", ref: "create" });
    }
    expect(h.relay.exists()).toBe(false);
    expect(h.store.rosterHead()).toBe(0);
  });
});

/** A store that counts every call made to it. */
function counted(store: MeshStore): { store: MeshStore; calls: string[] } {
  const calls: string[] = [];
  const proxy = new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(key));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store: proxy, calls };
}

describe.each(KINDS)("the sweep of a mesh id that does not exist (%s store)", (kind) => {
  it("closes late connections but reads the store at most once, until a create makes the mesh", () => {
    const { store, calls } = counted(makeStore(kind));
    const h = new Harness(store, { limits: { authDeadlineMs: 1_000 } });
    const late = h.open();
    calls.length = 0;
    h.advance(2_000);
    expect(late.closed).toEqual({ code: CLOSE.authTimeout, reason: "auth timeout" });
    expect(calls).toEqual(["rosterHead"]);
    calls.length = 0;
    h.advance(1_000);
    h.advance(1_000);
    expect(calls).toEqual([]);

    // Once this relay creates the mesh, the sweep runs again.
    const c = h.open();
    h.sendFrame(c, { t: "create", roster: createGenesisRoster({ name: "admin", keys: generateDeviceKeys(), now: h.now, meshId: MESH }) });
    expect(c.last()).toMatchObject({ t: "roster" });
    calls.length = 0;
    h.advance(1_000);
    expect(calls).toContain("expiredQueue");
  });
});

