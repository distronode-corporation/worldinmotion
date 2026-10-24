import { CLOSE, createInvite, createGenesisRoster, createJoin, generateDeviceKeys, hash, nextRoster, rosterRef, admitJoin } from "@worldinmotion/protocol";
import { describe, expect, it } from "vitest";
import type { MeshStore } from "../src/index.ts";
import { Client, dev, Harness, KINDS, makeStore, MESH, publish, RELAY, roster, T0, world, type Dev, type FakeConn, type World } from "./helpers.ts";

const HOUR = 3_600_000;

describe.each(KINDS)("roster publish (%s store)", (kind) => {
  it("verifies, stores and pushes a new roster to every session", () => {
    const w = world(kind, ["laptop"]);
    const a = new Client(w.h, w.members[0]!, "a");
    a.connect();
    const next = publish(w, { add: [dev("server").record] });
    expect(a.conn.last("roster")).toEqual({ t: "roster", chain: [next], more: false });
    expect(w.h.store.rosterHead()).toBe(3);
  });

  it("answers a republish of the held roster with it, and a different one with roster_conflict and fork evidence", () => {
    const w = world(kind, ["laptop"]);
    const held = w.chain[1]!;
    expect(w.root.frame({ t: "roster.publish", roster: held })).toEqual([{ t: "roster", chain: [held], more: false }]);
    const rival = nextRoster(w.chain[0]!, { add: [dev("other").record] }, w.admin, T0 + 5);
    expect(w.root.frame({ t: "roster.publish", roster: rival })).toEqual([
      { t: "error", code: "roster_conflict", message: "a different roster holds that seq", ref: "roster.publish" },
    ]);
    expect(w.h.store.forks()).toMatchObject([{ kind: "evidence", seq: 2, signer: w.admin.id }]);
    expect(w.h.logs.at(-1)).toMatchObject({ event: "fork", fields: { source: "roster.publish" } });
  });

  it("refuses an invalid roster, a gap, a genesis, and a non-admin publisher", () => {
    const w = world(kind, ["laptop"]);
    const bad = { ...nextRoster(w.chain[1]!, { add: [dev("x").record] }, w.admin, T0), at: T0 + 1 };
    expect(w.root.frame({ t: "roster.publish", roster: bad })[0]).toMatchObject({ code: "roster_invalid", message: "roster_bad_signature" });
    const r3 = nextRoster(w.chain[1]!, { add: [dev("x").record] }, w.admin, T0);
    const r4 = nextRoster(r3, { add: [dev("y").record] }, w.admin, T0);
    expect(w.root.frame({ t: "roster.publish", roster: r4 })[0]).toMatchObject({ code: "roster_invalid", message: "no roster precedes it" });
    expect(w.root.frame({ t: "roster.publish", roster: w.chain[0] })[0]).toMatchObject({ code: "roster_invalid" });
    const a = new Client(w.h, w.members[0]!, "a");
    a.connect();
    expect(a.frame({ t: "roster.publish", roster: r3 })[0]).toMatchObject({ code: "unauthorized", ref: "roster.publish" });
  });

  it("treats a lost compare-and-swap as a conflict (another writer stored the seq first)", () => {
    const store = makeStore(kind);
    let race: (() => void) | undefined;
    const racing: MeshStore = Object.create(store) as MeshStore;
    racing.insertRoster = (row) => {
      race?.();
      return store.insertRoster(row);
    };
    const h = new Harness(racing);
    const admin = dev("admin", "admin");
    const genesis = createGenesisRoster({ name: "admin", keys: admin.keys, now: T0, meshId: MESH });
    h.sendFrame(h.open(), { t: "create", roster: genesis });
    const root = new Client(h, admin, "root");
    root.connect();
    const mine = nextRoster(genesis, { add: [dev("a").record] }, admin, T0);
    const theirs = nextRoster(genesis, { add: [dev("b").record] }, admin, T0);
    race = () => {
      race = undefined;
      store.insertRoster({ seq: 2, hash: hash(theirs), json: JSON.stringify(theirs) });
    };
    expect(root.frame({ t: "roster.publish", roster: mine })[0]).toMatchObject({ code: "roster_conflict" });
  });

  it("purges a revoked device: sessions closed, queues and its queued messages gone, invites dropped", () => {
    const w = world(kind, ["laptop", "server"]);
    const a = new Client(w.h, w.members[0]!, "a");
    const b = new Client(w.h, w.members[1]!, "b");
    const b2 = new Client(w.h, w.members[1]!, "b2");
    a.connect();
    b.connect();
    b2.connect();
    w.h.drop(b2.conn);
    b.send([a.address]);
    w.h.drop(a.conn);
    b.send([a.address]);
    expect(w.h.store.queueCount(a.sid)).toBe(2);
    publish(w, { revoke: [w.members[1]!.id] });
    expect(b.conn.closed).toEqual({ code: CLOSE.revoked, reason: "device revoked" });
    expect(w.h.store.sessionsOf(w.members[1]!.id)).toEqual([]);
    expect(w.h.store.queueCount(a.sid)).toBe(0);
    expect(w.root.frame({ t: "peers" })[0]!["peers"].map((p: { address: string }) => p.address)).toEqual(["a@laptop"]);
    expect(w.h.logs.at(-1)).toMatchObject({ event: "revoked", fields: { sessions: 2 } });
  });

  it("drops a revoked admin's invites", () => {
    const w = world(kind);
    const second = dev("second", "admin");
    publish(w, { add: [second.record] });
    const s = new Client(w.h, second, "s");
    s.connect();
    const inv = createInvite({ relay: RELAY, mesh: MESH, pin: rosterRef(roster(w.h)), now: w.h.now });
    s.frame({ t: "invite.create", invite: inv.inviteId, exp: inv.exp });
    publish(w, { revoke: [second.id] });
    expect(w.h.store.getInvite(inv.inviteId)).toBeUndefined();
  });
});

describe.each(KINDS)("roster.get and fork evidence (%s store)", (kind) => {
  it("pages the chain from a seq, oldest first, saying when more follow", () => {
    const w = world(kind, ["a", "b", "c", "d"], { limits: { rosterPageMax: 2 } });
    expect(w.root.frame({ t: "roster.get", from: 1 })).toEqual([{ t: "roster", chain: w.chain.slice(0, 2), more: true }]);
    expect(w.root.frame({ t: "roster.get", from: 4 })).toEqual([{ t: "roster", chain: w.chain.slice(3, 5), more: false }]);
    expect(w.root.frame({ t: "roster.get", from: 6 })[0]).toMatchObject({ code: "malformed", ref: "roster.get" });
  });

  it("stops a page at the byte limit but always sends one roster", () => {
    const w = world(kind, ["a", "b"], { limits: { rosterPageBytes: 10 } });
    expect(w.root.frame({ t: "roster.get", from: 1 })).toEqual([{ t: "roster", chain: [w.chain[0]], more: true }]);
  });

  it("stores and logs valid fork evidence, at genesis or later", () => {
    const w = world(kind, ["a"]);
    const rival = nextRoster(w.chain[0]!, { add: [dev("z").record] }, w.admin, T0 + 9);
    expect(w.root.frame({ t: "roster.fork", a: w.chain[1], b: rival })).toEqual([]);
    const otherGenesis = createGenesisRoster({ name: "admin", keys: generateDeviceKeys(), now: T0, meshId: MESH });
    w.root.frame({ t: "roster.fork", a: w.chain[0], b: otherGenesis });
    expect(w.h.store.forks().map((f) => [f.kind, f.seq])).toEqual([
      ["evidence", 2],
      ["evidence", 1],
    ]);
    expect(w.h.logs.filter((l) => l.event === "fork")).toHaveLength(2);
  });

  it("refuses evidence that proves nothing", () => {
    const w = world(kind, ["a"]);
    const err = [{ t: "error", code: "malformed", message: "not evidence of a fork in this mesh", ref: "roster.fork" }];
    const foreign = createGenesisRoster({ name: "admin", keys: generateDeviceKeys(), now: T0 });
    const foreign2 = createGenesisRoster({ name: "admin", keys: generateDeviceKeys(), now: T0, meshId: foreign.mesh });
    expect(w.root.frame({ t: "roster.fork", a: foreign, b: foreign2 })).toEqual(err);
    expect(w.root.frame({ t: "roster.fork", a: w.chain[1], b: w.chain[1] })).toEqual(err);
    const forged = { ...nextRoster(w.chain[0]!, { add: [dev("z").record] }, w.admin, T0), at: 5 };
    expect(w.root.frame({ t: "roster.fork", a: w.chain[1], b: forged })).toEqual(err);
    expect(w.root.frame({ t: "roster.fork", a: forged, b: w.chain[1] })).toEqual(err);
    const r3 = nextRoster(w.chain[1]!, { add: [dev("x").record] }, w.admin, T0);
    const r4a = nextRoster(r3, { add: [dev("y").record] }, w.admin, T0);
    const r4b = nextRoster(r3, { add: [dev("q").record] }, w.admin, T0);
    expect(w.root.frame({ t: "roster.fork", a: r4a, b: r4b })).toEqual(err);
  });
});

/** An invite registered by the admin's root session. */
function invite(w: World, opts: { exp?: number } = {}) {
  const inv = createInvite({ relay: RELAY, mesh: MESH, pin: rosterRef(roster(w.h)), now: w.h.now, exp: opts.exp });
  expect(w.root.frame({ t: "invite.create", invite: inv.inviteId, exp: inv.exp, pin: rosterRef(roster(w.h)) })).toEqual([
    { t: "invite.created", invite: inv.inviteId },
  ]);
  return { ...inv, parsed: { relay: RELAY, mesh: MESH, secret: inv.secret, pin: rosterRef(roster(w.h)), exp: inv.exp, inviteId: inv.inviteId } };
}

describe.each(KINDS)("invites and joins (%s store)", (kind) => {
  it("runs the whole join: request to online admins, approval, joined with the chain, then auth", () => {
    const w = world(kind, ["laptop"]);
    const inv = invite(w);
    const newbox = dev("newbox");
    // A non-admin session online at the time does not see the request.
    const member = new Client(w.h, w.members[0]!, "m");
    member.connect();
    const joiner = w.h.open("joiner-ip");
    joiner.take();
    const join = createJoin(inv.parsed, "newbox", newbox.keys, joiner.nonce);
    w.h.sendFrame(joiner, join);
    expect(joiner.take()).toEqual([]);
    const { t: _t, ...body } = join;
    expect(w.root.conn.last("join.request")).toEqual({ t: "join.request", join: body });
    expect(member.conn.of("join.request")).toEqual([]);
    // The joiner waits past the 10 second auth deadline, up to the invite's expiry.
    w.h.advance(60_000);
    expect(joiner.closed).toBeUndefined();

    const next = publish(w, { add: [admitJoin(join.device, w.h.now)] });
    expect(joiner.take()).toEqual([{ t: "joined", chain: [w.chain[1], next], more: false }]);
    expect(w.h.store.getInvite(inv.inviteId)!.joiner).toBe(newbox.id);
  });

  it("lets the joiner authenticate on its join connection after joined", () => {
    const w = world(kind);
    const inv = invite(w);
    const newbox = dev("newbox");
    const c = new Client(w.h, newbox, "fresh");
    c.conn = w.h.open();
    const nonce = c.conn.take()[0]!["nonce"] as string;
    w.h.sendFrame(c.conn, createJoin(inv.parsed, "newbox", newbox.keys, nonce));
    publish(w, { add: [admitJoin({ id: newbox.id, name: "newbox", sign: newbox.record.sign, box: newbox.record.box }, w.h.now)] });
    c.conn.take();
    w.h.sendFrame(c.conn, c.authFrame(nonce));
    expect(c.conn.take()[0]).toMatchObject({ t: "ready", name: "fresh" });
  });

  it("queues a join for an admin that comes online later, until the invite expires", () => {
    const w = world(kind);
    const inv = invite(w, { exp: w.h.now + HOUR });
    w.h.drop(w.root.conn);
    const joiner = w.h.open();
    const join = createJoin(inv.parsed, "newbox", dev("newbox").keys, joiner.nonce);
    w.h.sendFrame(joiner, join);
    const later = new Client(w.h, w.admin, "later");
    expect(later.connect().filter((f) => f["t"] === "join.request")).toHaveLength(1);
    w.h.advance(HOUR);
    expect(joiner.take().at(-1)).toEqual({ t: "error", code: "invite_expired", message: "the invite expired before an admin answered", ref: "join" });
    expect(joiner.closed?.code).toBe(CLOSE.authTimeout);
    expect(w.h.store.getInvite(inv.inviteId)).toBeUndefined();
    const again = new Client(w.h, w.admin, "again");
    expect(again.connect().filter((f) => f["t"] === "join.request")).toEqual([]);
  });

  it("does not hand a stale pending join to an admin after expiry but before the sweep", () => {
    const w = world(kind);
    const inv = invite(w, { exp: w.h.now + HOUR });
    const c = w.h.open();
    w.h.sendFrame(c, createJoin(inv.parsed, "newbox", dev("newbox").keys, c.nonce));
    w.h.now += HOUR;
    const late = new Client(w.h, w.admin, "late");
    expect(late.connect().filter((f) => f["t"] === "join.request")).toEqual([]);
  });

  it("is single use: another device is refused, the same device gets joined again", () => {
    const w = world(kind);
    const inv = invite(w);
    const newbox = dev("newbox");
    const joinOn = (c: FakeConn, d: Dev = newbox) => w.h.sendFrame(c, createJoin(inv.parsed, d.name, d.keys, c.nonce));
    const first = w.h.open();
    joinOn(first);
    // While pending: another device is refused, the same device may ask again (replacing its older wait).
    const rival = w.h.open();
    joinOn(rival, dev("rival"));
    expect(rival.last()).toMatchObject({ code: "invite_used", message: "another device is already joining with this invite" });
    expect(first.closed).toBeUndefined();
    const retry = w.h.open();
    joinOn(retry);
    expect(retry.of("error")).toEqual([]);
    expect(first.closed).toEqual({ code: CLOSE.replaced, reason: "replaced by a newer join" });
    publish(w, { add: [admitJoin({ id: newbox.id, name: "newbox", sign: newbox.record.sign, box: newbox.record.box }, w.h.now)] });
    expect(retry.last()["t"]).toBe("joined");
    const lateRival = w.h.open();
    joinOn(lateRival, dev("rival"));
    expect(lateRival.last()).toMatchObject({ code: "invite_used", message: "the invite was already used" });
    const missed = w.h.open();
    joinOn(missed);
    expect(missed.last()).toMatchObject({ t: "joined", more: false });
    expect(retry.closed?.code).toBe(CLOSE.replaced);
  });

  it("refuses a join signed for another connection's nonce (a replay)", () => {
    const w = world(kind);
    const inv = invite(w);
    const a = w.h.open();
    const b = w.h.open();
    w.h.sendFrame(b, createJoin(inv.parsed, "newbox", dev("newbox").keys, a.nonce));
    expect(b.last()).toMatchObject({ code: "malformed", message: "join_wrong_nonce", ref: "join" });
  });

  it("caps the joins waiting in a mesh", () => {
    const w = world(kind, [], { limits: { pendingJoinsPerMesh: 1 } });
    const one = invite(w);
    const two = invite(w);
    const a = w.h.open();
    w.h.sendFrame(a, createJoin(one.parsed, "a", dev("a").keys, a.nonce));
    const b = w.h.open();
    w.h.sendFrame(b, createJoin(two.parsed, "b", dev("b").keys, b.nonce));
    expect(b.last()).toMatchObject({ code: "limited", message: "too many joins are waiting in this mesh" });
  });

  it("refuses unknown, expired and malformed joins, a wrong mesh, and a revoked device", () => {
    const w = world(kind, ["laptop"]);
    const inv = invite(w);
    const c = w.h.open();
    const ghost = createInvite({ relay: RELAY, mesh: MESH, pin: rosterRef(roster(w.h)), now: w.h.now });
    w.h.sendFrame(c, createJoin({ ...inv.parsed, inviteId: ghost.inviteId, secret: ghost.secret }, "x", dev("x").keys, c.nonce));
    expect(c.last()).toMatchObject({ code: "invite_unknown", ref: "join" });
    const join = createJoin(inv.parsed, "x", dev("x").keys, c.nonce);
    w.h.sendFrame(c, { ...join, mesh: "AAAAAAAAAAAAAAAAAAAAAA" });
    expect(c.last()).toMatchObject({ code: "unauthorized", message: "unknown mesh" });
    w.h.sendFrame(c, { ...join, sig: createJoin(inv.parsed, "y", dev("y").keys, c.nonce).sig });
    expect(c.last()).toMatchObject({ code: "malformed", message: "join_bad_signature" });
    publish(w, { revoke: [w.members[0]!.id] });
    w.h.sendFrame(c, createJoin(inv.parsed, "laptop", w.members[0]!.keys, c.nonce));
    expect(c.last()).toMatchObject({ code: "unauthorized", message: "this device was revoked" });
    w.h.now = inv.exp;
    w.h.sendFrame(c, join);
    expect(c.last()).toMatchObject({ code: "invite_expired" });
  });

  it("refuses join before the mesh exists", () => {
    const h = new Harness(makeStore(kind));
    const c = h.open();
    const inv = createInvite({ relay: RELAY, mesh: MESH, pin: { seq: 1, hash: "A".repeat(43) }, now: T0 });
    h.sendFrame(c, createJoin({ relay: RELAY, mesh: MESH, secret: inv.secret, pin: { seq: 1, hash: "A".repeat(43) }, exp: inv.exp, inviteId: inv.inviteId }, "x", dev("x").keys, c.nonce));
    expect(c.last()).toMatchObject({ code: "unauthorized", message: "unknown mesh" });
  });

  it("starts joined at the invite's pin, and refuses a pin the relay does not hold", () => {
    const w = world(kind, ["a", "b"]);
    const inv = createInvite({ relay: RELAY, mesh: MESH, pin: rosterRef(w.chain[1]!), now: w.h.now });
    expect(w.root.frame({ t: "invite.create", invite: inv.inviteId, exp: inv.exp, pin: { seq: 2, hash: rosterRef(w.chain[0]!).hash } })[0]).toMatchObject({
      code: "roster_invalid",
      ref: "invite.create",
    });
    expect(w.root.frame({ t: "invite.create", invite: inv.inviteId, exp: inv.exp, pin: { seq: 9, hash: rosterRef(w.chain[0]!).hash } })[0]!["code"]).toBe("roster_invalid");
    w.root.frame({ t: "invite.create", invite: inv.inviteId, exp: inv.exp, pin: rosterRef(w.chain[1]!) });
    const newbox = dev("newbox");
    const joiner = w.h.open();
    const join = createJoin({ relay: RELAY, mesh: MESH, secret: inv.secret, pin: rosterRef(w.chain[1]!), exp: inv.exp, inviteId: inv.inviteId }, "newbox", newbox.keys, joiner.nonce);
    w.h.sendFrame(joiner, join);
    const next = publish(w, { add: [admitJoin(join.device, w.h.now)] });
    expect(joiner.last()).toEqual({ t: "joined", chain: [w.chain[1], w.chain[2], next], more: false });
  });

  it("checks invite.create: admins only, a lifetime of at most 7 days, unique ids, 16 live per device", () => {
    const w = world(kind, ["laptop"], { limits: { liveInvitesPerDevice: 1 } });
    const m = new Client(w.h, w.members[0]!, "m");
    m.connect();
    const id = createInvite({ relay: RELAY, mesh: MESH, pin: rosterRef(roster(w.h)), now: w.h.now }).inviteId;
    expect(m.frame({ t: "invite.create", invite: id, exp: w.h.now + 1 })[0]).toMatchObject({ code: "unauthorized", ref: "invite.create" });
    w.root.conn.take();
    expect(w.root.frame({ t: "invite.create", invite: id, exp: w.h.now })[0]).toMatchObject({ code: "malformed" });
    expect(w.root.frame({ t: "invite.create", invite: id, exp: w.h.now + 7 * 24 * HOUR + 1 })[0]).toMatchObject({ code: "malformed" });
    expect(w.root.frame({ t: "invite.create", invite: id, exp: w.h.now + 7 * 24 * HOUR })).toEqual([{ t: "invite.created", invite: id }]);
    expect(w.root.frame({ t: "invite.create", invite: id, exp: w.h.now + 1 })[0]).toMatchObject({ code: "invite_used" });
    const id2 = createInvite({ relay: RELAY, mesh: MESH, pin: rosterRef(roster(w.h)), now: w.h.now }).inviteId;
    expect(w.root.frame({ t: "invite.create", invite: id2, exp: w.h.now + 1 })[0]).toMatchObject({ code: "limited" });
  });
});
