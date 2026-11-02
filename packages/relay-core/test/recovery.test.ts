import { CLOSE, b64u, createGenesisRoster, generateDeviceKeys, hash, nextRoster, randomBytes, signRecoverAuth } from "@worldinmotion/protocol";
import { describe, expect, it } from "vitest";
import { dev, Harness, KINDS, makeStore, MESH, publish, RELAY, roster, T0, world, type Dev, type World } from "./helpers.ts";

/** A mesh whose roster holds a recovery record, as SPEC 4a has every mesh created with. */
function recoverable(kind: (typeof KINDS)[number], config = {}) {
  const w = world(kind, ["laptop"], config);
  const rec = dev("recovery", "admin");
  publish(w, { add: [rec.record] });
  return { ...w, rec };
}

/** Opens a connection and answers hello with a recovery auth. */
function recoverConn(w: World, d: Dev, opts: { genesis?: string; nonce?: string; source?: string } = {}) {
  const c = w.h.open(opts.source);
  const nonce = c.take()[0]!["nonce"] as string;
  const auth = signRecoverAuth({ relay: RELAY, mesh: MESH, nonce: opts.nonce ?? nonce, at: w.h.now, genesis: opts.genesis ?? hash(w.chain[0]!) }, d.keys);
  w.h.sendFrame(c, auth);
  return c;
}

describe.each(KINDS)("recovery connection (%s store)", (kind) => {
  it("reads the chain, publishes one roster, and closes as recovered, with no session or peer row", () => {
    const w = recoverable(kind);
    const c = recoverConn(w, w.rec);
    expect(c.take()).toEqual([{ t: "recover.ready", roster: roster(w.h) }]);
    expect(c.closed).toBeUndefined();
    w.h.sendFrame(c, { t: "roster.get", from: 1 });
    expect(c.take()).toEqual([{ t: "roster", chain: w.chain, more: false }]);
    w.h.sendFrame(c, { t: "roster.get", from: 9 });
    expect(c.take()[0]).toMatchObject({ code: "malformed", ref: "roster.get" });
    for (const t of ["ping", "peers", "lease.list"]) {
      w.h.sendFrame(c, { t });
      expect(c.take()).toEqual([{ t: "error", code: "unauthorized", message: "a recovery connection only reads and publishes rosters", ref: t }]);
    }
    expect(w.root.frame({ t: "peers" })[0]!["peers"].map((p: { address: string }) => p.address)).toEqual([]);

    const fresh = dev("newadmin", "admin");
    const next = nextRoster(roster(w.h), { add: [fresh.record] }, w.rec, w.h.now);
    w.h.sendFrame(c, { t: "roster.publish", roster: next });
    expect(c.closed).toEqual({ code: CLOSE.recovered, reason: "recovered" });
    expect(w.root.conn.last("roster")).toEqual({ t: "roster", chain: [next], more: false });
    expect(w.h.store.sessionsOf(w.rec.id)).toEqual([]);
    // Closed connections are ignored, including their late close event.
    w.h.sendFrame(c, { t: "roster.get", from: 1 });
    w.h.relay.onClose(c);
    expect(c.take()).toEqual([]);
  });

  it("closes after a refused publish too, and answers bad frames without closing", () => {
    const w = recoverable(kind, { limits: { frameBytes: 3000 } });
    const c = recoverConn(w, w.rec);
    c.take();
    w.h.sendFrame(c, JSON.stringify({ t: "ping", pad: "x".repeat(3000) }));
    w.h.sendFrame(c, "[]");
    w.h.sendFrame(c, '{"t":"ping","t":"ping"}');
    expect(c.take().map((f) => f["code"])).toEqual(["too_large", "malformed", "duplicate_key"]);
    w.h.sendFrame(c, { t: "roster.publish", roster: w.chain[0] });
    expect(c.take()[0]).toMatchObject({ code: "roster_invalid" });
    expect(c.closed?.code).toBe(CLOSE.recovered);
  });

  it("refuses a recovery auth with a wrong pin, from a device that is not a recovery record, or with another nonce", () => {
    const w = recoverable(kind);
    const cases: [ReturnType<typeof recoverConn>, string][] = [
      [recoverConn(w, w.rec, { genesis: b64u.encode(randomBytes(32)) }), "wrong_pin"],
      [recoverConn(w, w.admin), "not_recovery"],
      [recoverConn(w, w.rec, { nonce: b64u.encode(randomBytes(32)) }), "wrong_nonce"],
    ];
    for (const [c, message] of cases) {
      expect(c.take()).toEqual([{ t: "error", code: "unauthorized", message, ref: "auth" }]);
      expect(c.closed?.code).toBe(CLOSE.unauthorized);
    }
  });

  it("refuses recovery before the mesh exists", () => {
    const h = new Harness(makeStore(kind));
    const keys = generateDeviceKeys();
    const c = h.open();
    const nonce = c.take()[0]!["nonce"] as string;
    const genesis = createGenesisRoster({ name: "admin", keys, now: T0, meshId: MESH });
    h.sendFrame(c, signRecoverAuth({ relay: RELAY, mesh: MESH, nonce, at: T0, genesis: hash(genesis) }, keys));
    expect(c.take()).toEqual([{ t: "error", code: "unauthorized", message: "unknown mesh", ref: "auth" }]);
    // Nothing is stored for a mesh that does not exist, not even the recovery budget.
    expect(h.store.getBucket("recover")).toBeUndefined();
    expect(h.relay.exists()).toBe(false);
  });

  it("limits recovery per mesh in its own bucket, whatever the source", () => {
    const w = recoverable(kind, { limits: { recoveryPerMeshPerHour: 1 } });
    expect(recoverConn(w, w.rec, { source: "s" }).closed).toBeUndefined();
    const second = recoverConn(w, w.rec, { source: "other" });
    expect(second.take()[0]).toMatchObject({ code: "limited", message: "too many recovery attempts for this mesh", ref: "auth" });
    expect(second.closed?.code).toBe(CLOSE.limited);
  });

  it("spends the per-mesh recovery budget only on a valid signature", () => {
    const w = recoverable(kind, { limits: { recoveryPerMeshPerHour: 1 } });
    for (let i = 0; i < 5; i++) {
      const bad = recoverConn(w, w.rec, { source: `bad-${i}`, nonce: b64u.encode(randomBytes(32)) });
      expect(bad.take()[0]).toMatchObject({ code: "unauthorized", ref: "auth" });
    }
    expect(w.h.store.getBucket("recover")).toBeUndefined();
    // The record holder still recovers, and that spends the mesh's one recovery.
    expect(recoverConn(w, w.rec, { source: "owner" }).closed).toBeUndefined();
    expect(w.h.store.getBucket("recover")).toMatchObject({ tokens: 0 });
  });

  it("charges every recovery attempt to its source's pre-auth budget, before the signature is checked", () => {
    const w = recoverable(kind, { limits: { createJoinPerSourcePerHour: 2 } });
    for (let i = 0; i < 2; i++) {
      const bad = recoverConn(w, w.rec, { source: "s", nonce: b64u.encode(randomBytes(32)) });
      expect(bad.take()[0]).toMatchObject({ code: "unauthorized", ref: "auth" });
    }
    // The source's budget is spent, so even a valid recovery from it waits.
    const third = recoverConn(w, w.rec, { source: "s" });
    expect(third.take()[0]).toMatchObject({ code: "limited", message: "too many recovery attempts from this address", ref: "auth" });
    expect(third.closed?.code).toBe(CLOSE.limited);
    // Another source is unaffected, and so is the mesh's own recovery budget.
    expect(recoverConn(w, w.rec, { source: "elsewhere" }).closed).toBeUndefined();
  });

  it("asks the host's per-source limiter for a recovery attempt", () => {
    const asked: string[] = [];
    const h = new Harness(makeStore(kind), {}, { allowSource: (source) => (asked.push(source), false) });
    const c = h.open("host-src");
    h.sendFrame(c, signRecoverAuth({ relay: RELAY, mesh: MESH, nonce: c.nonce, at: T0, genesis: b64u.encode(randomBytes(32)) }, generateDeviceKeys()));
    expect(asked).toEqual(["host-src"]);
    expect(c.take().at(-1)).toMatchObject({ code: "limited", ref: "auth" });
  });
});
