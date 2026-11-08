// Dependable idle notices (SPEC section 8): a watched session that stays offline fires its
// notices after a grace period, a notice that fires while its subscriber is offline waits for the
// subscriber's next `ready`, each arm is confirmed, and a peer row says whether its session reports
// turns. The harness clock is wound by hand, so every grace and lifetime is exact.

import { LIMITS } from "@worldinmotion/protocol";
import { describe, expect, it } from "vitest";
import { Client, Harness, KINDS, world } from "./helpers.ts";

const GRACE = LIMITS.idleOfflineGraceMs;
const LIFETIME = LIMITS.idleNoticeLifetimeMs;

function pair(kind: (typeof KINDS)[number]) {
  const w = world(kind, ["laptop", "server"]);
  const a = new Client(w.h, w.members[0]!, "writer");
  const b = new Client(w.h, w.members[1]!, "reviewer");
  a.connect();
  b.connect();
  w.root.conn.take();
  a.conn.take();
  return { ...w, a, b };
}

const notice = (of: string, why: string) => ({ t: "notice", kind: "idle", of, why });

describe.each(KINDS)("idle notices for a session that goes offline (%s store)", (kind) => {
  it("fires once the watched session has been offline for the grace period, and only once", () => {
    const { h, a, b } = pair(kind);
    a.frame({ t: "notify_idle", of: b.address });
    h.drop(b.conn);
    a.conn.take();
    h.advance(GRACE - 1);
    expect(a.conn.of("notice")).toEqual([]);
    h.advance(1);
    expect(a.conn.of("notice")).toEqual([notice(b.address, "offline")]);
    h.advance(GRACE);
    expect(a.conn.of("notice")).toHaveLength(1);
    expect(h.store.idleFor(b.sid)).toEqual([]);
  });

  it("starts the grace again when the session reconnects in time, and fires for a session already offline when armed", () => {
    const { h, a, b } = pair(kind);
    a.frame({ t: "notify_idle", of: b.address });
    h.drop(b.conn);
    h.advance(GRACE / 2);
    b.connect();
    h.advance(GRACE);
    expect(a.conn.of("notice")).toEqual([]);
    h.drop(b.conn);
    h.advance(GRACE - 1);
    expect(a.conn.of("notice")).toEqual([]);
    h.advance(1);
    expect(a.conn.of("notice")).toEqual([notice(b.address, "offline")]);
    // Armed on a session that is already past the grace: the next sweep fires it.
    a.conn.take();
    expect(a.frame({ t: "notify_idle", of: b.address })).toEqual([{ t: "idle.armed", of: b.address, exp: h.now + LIFETIME }]);
    h.advance(1000);
    expect(a.conn.of("notice")).toEqual([notice(b.address, "offline")]);
  });

  it("fires every subscriber of one session in one sweep, and leaves sessions that are online alone", () => {
    const { h, a, b, root } = pair(kind);
    a.frame({ t: "notify_idle", of: b.address });
    root.frame({ t: "notify_idle", of: b.address });
    root.frame({ t: "notify_idle", of: a.address });
    h.drop(b.conn);
    h.advance(GRACE);
    expect(a.conn.of("notice")).toEqual([notice(b.address, "offline")]);
    expect(root.conn.of("notice")).toEqual([notice(b.address, "offline")]);
    expect(h.store.idleFor(a.sid)).toHaveLength(1);
  });

  it("keeps the offline sweep working after a relay restart that lost every connection", () => {
    const { h, a, b } = pair(kind);
    a.frame({ t: "notify_idle", of: b.address });
    // A restart marks every session offline from the restart on (the new host starts at T0, now).
    const restarted = new Harness(h.store);
    expect(restarted.now).toBe(h.now);
    const again = new Client(restarted, a.d, "writer", { sid: a.sid, resume: a.resume });
    again.connect();
    restarted.advance(GRACE - 1);
    expect(again.conn.of("notice")).toEqual([]);
    restarted.advance(1);
    expect(again.conn.of("notice")).toEqual([notice(b.address, "offline")]);
  });
});

describe.each(KINDS)("idle notices held for a subscriber that is offline (%s store)", (kind) => {
  it("keeps a notice that fired while the subscriber was offline and sends it after its next ready, once", () => {
    const { h, a, b } = pair(kind);
    a.frame({ t: "notify_idle", of: b.address });
    h.drop(a.conn);
    b.frame({ t: "presence", status: "idle" });
    // A second report while the notice waits does not queue a second one.
    b.frame({ t: "presence", status: "idle" });
    expect(h.store.idleFor(b.sid)).toEqual([{ sub: a.sid, target: b.sid, exp: expect.any(Number), fired: "idle" }]);
    h.advance(GRACE);
    const frames = a.connect();
    const types = frames.map((f) => f["t"]);
    expect(types.indexOf("notice")).toBeGreaterThan(types.indexOf("ready"));
    expect(frames.filter((f) => f["t"] === "notice")).toEqual([notice(b.address, "idle")]);
    expect(a.connect().filter((f) => f["t"] === "notice")).toEqual([]);
  });

  it("holds why it fired: the session ended, or went offline while its subscriber was offline too", () => {
    const { h, a, b, root } = pair(kind);
    a.frame({ t: "notify_idle", of: b.address });
    root.frame({ t: "notify_idle", of: a.address });
    h.drop(a.conn);
    h.drop(root.conn);
    b.frame({ t: "bye", ended: true });
    h.advance(GRACE);
    expect(a.connect().filter((f) => f["t"] === "notice")).toEqual([notice(b.address, "ended")]);
    expect(root.connect().filter((f) => f["t"] === "notice")).toEqual([notice(a.address, "offline")]);
  });

  it("follows the subscriber through a restart that takes its name back with a new sid", () => {
    const { h, a, b } = pair(kind);
    a.frame({ t: "notify_idle", of: b.address });
    h.drop(a.conn);
    b.frame({ t: "presence", status: "idle" });
    const restarted = new Client(h, a.d, "writer", { resume: a.resume });
    expect(restarted.connect().filter((f) => f["t"] === "notice")).toEqual([notice(b.address, "idle")]);
  });

  it("drops a held notice once the arm's 12 hours pass, whether or not the sweep reached it", () => {
    const { h, a, b, root } = pair(kind);
    a.frame({ t: "notify_idle", of: b.address });
    root.frame({ t: "notify_idle", of: b.address });
    h.drop(a.conn);
    h.drop(root.conn);
    b.frame({ t: "presence", status: "idle" });
    // Past the lifetime with no sweep yet: the row is still there, and is dropped unsent at ready.
    h.now += LIFETIME;
    expect(a.connect().filter((f) => f["t"] === "notice")).toEqual([]);
    expect(h.store.idleBy(a.sid)).toEqual([]);
    h.advance(1);
    expect(h.store.idleBy(root.sid)).toEqual([]);
    expect(root.connect().filter((f) => f["t"] === "notice")).toEqual([]);
  });
});

describe.each(KINDS)("presence on peer rows (%s store)", (kind) => {
  const row = (frames: Record<string, any>[], address: string) => frames.find((f) => f["t"] === "peer" && f["peer"]["address"] === address)?.["peer"];

  it("marks a row once its session sends presence on the current connection, and clears it on a new connection", () => {
    const { h, a, b } = pair(kind);
    b.conn.take();
    expect(a.frame({ t: "peers" })[0]!["peers"].find((p: { address: string }) => p.address === b.address)).not.toHaveProperty("presence");
    // The status stays idle, but the row changed: it is pushed once, with the mark.
    a.frame({ t: "presence", status: "idle" });
    expect(row(b.conn.take(), a.address)).toMatchObject({ status: "idle", presence: true });
    a.frame({ t: "presence", status: "idle" });
    expect(b.conn.take()).toEqual([]);
    expect(b.frame({ t: "peers" })[0]!["peers"].find((p: { address: string }) => p.address === a.address)).toMatchObject({ presence: true });
    // A hibernation keeps the mark with the connection's saved state.
    h.hibernate();
    expect(b.frame({ t: "peers" })[0]!["peers"].find((p: { address: string }) => p.address === a.address)).toMatchObject({ presence: true });
    h.drop(a.conn);
    expect(row(b.conn.take(), a.address)).not.toHaveProperty("presence");
    a.connect();
    expect(row(b.conn.take(), a.address)).toEqual({ address: a.address, sid: a.sid, kind: "cli", status: "idle", since: h.now, rooms: [] });
    const others = b.connect().find((f) => f["t"] === "ready")!["peers"] as { address: string }[];
    expect(others.find((p) => p.address === a.address)).not.toHaveProperty("presence");
  });

  it("carries the mark in the session's own row after a rename or a room leave", () => {
    const { a } = pair(kind);
    a.frame({ t: "presence", status: "busy" });
    expect(a.frame({ t: "rename", name: "editor" }).find((f) => f["t"] === "peer")!["peer"]).toMatchObject({ address: "editor@laptop", presence: true });
    expect(a.frame({ t: "room.leave", room: "#none" })[0]!["peer"]).toMatchObject({ presence: true });
  });
});
