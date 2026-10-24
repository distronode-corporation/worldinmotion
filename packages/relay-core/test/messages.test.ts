import { CLOSE, b64u, randomBytes, ulid } from "@worldinmotion/protocol";
import { describe, expect, it } from "vitest";
import { Client, Harness, KINDS, world } from "./helpers.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A mesh with the admin's root session plus `a` on laptop and `b` on server. */
function pair(kind: (typeof KINDS)[number], config = {}) {
  const w = world(kind, ["laptop", "server"], config);
  const a = new Client(w.h, w.members[0]!, "writer");
  const b = new Client(w.h, w.members[1]!, "reviewer");
  a.connect();
  b.connect();
  w.root.conn.take();
  a.conn.take();
  return { ...w, a, b };
}

describe.each(KINDS)("send and deliver (%s store)", (kind) => {
  it("routes to an online session and queues for an offline one, then replays in order", () => {
    const { h, a, b } = pair(kind);
    b.conn.take();
    expect(a.send([b.address])["results"]).toEqual([{ to: "reviewer@server", status: "routed" }]);
    expect(b.conn.take()).toMatchObject([{ t: "deliver", cursor: 1, msg: { from: { sid: a.sid } } }]);
    h.drop(b.conn);
    expect(a.conn.last("peer")["peer"]).toMatchObject({ address: "reviewer@server", status: "offline" });
    const ids = [a.send([b.address]), a.send([b.address])].map((s) => {
      expect(s["results"]).toEqual([{ to: "reviewer@server", status: "queued" }]);
      return s["id"];
    });
    // Reconnect holding cursor 1: only the two queued messages arrive, oldest first, no duplicate.
    const frames = b.connect({ cursor: 1 });
    expect(frames[0]).toMatchObject({ t: "ready", cursor: 1, name: "reviewer" });
    expect(frames.filter((f) => f["t"] === "deliver").map((f) => [f["cursor"], f["msg"]["id"]])).toEqual([
      [2, ids[0]],
      [3, ids[1]],
    ]);
    b.frame({ t: "ack", cursor: 3 });
    expect(h.store.queueCount(b.sid)).toBe(0);
  });

  it("replays everything unacknowledged without a resume cursor, and never acks past what was delivered", () => {
    const { h, a, b } = pair(kind);
    a.send([b.address]);
    a.send([b.address]);
    h.drop(b.conn);
    const frames = b.connect({ cursor: 99 });
    expect(frames[0]!["cursor"]).toBe(2);
    h.drop(b.conn);
    a.send([b.address]);
    expect(b.connect().filter((f) => f["t"] === "deliver").map((f) => f["cursor"])).toEqual([3]);
  });

  it("refuses an ack beyond the highest delivered cursor and ignores an old one", () => {
    const { a, b } = pair(kind);
    b.conn.take();
    expect(b.frame({ t: "ack", cursor: 1 })).toEqual([{ t: "error", code: "malformed", message: "ack beyond the highest delivered cursor", ref: "ack" }]);
    a.send([b.address]);
    b.frame({ t: "ack", cursor: 1 });
    expect(b.frame({ t: "ack", cursor: 0 })).toEqual([]);
  });

  it("checks from against the connection and the mesh", () => {
    const { a, b } = pair(kind);
    const f = a.seal([b.address]);
    const forged = { ...f, from: { ...f.from, session: "someone" } };
    expect(a.frame(forged)).toEqual([{ t: "error", code: "unauthorized", message: "from does not match this connection", ref: f.id }]);
    expect(a.frame({ ...f, from: { ...f.from, sid: ulid() } })[0]!["code"]).toBe("unauthorized");
    expect(a.frame({ ...f, from: { ...f.from, device: b.d.id } })[0]!["code"]).toBe("unauthorized");
    expect(a.frame({ ...f, mesh: b64u.encode(new Uint8Array(16)) })[0]).toMatchObject({ code: "malformed", message: "wrong mesh" });
  });

  it("answers unknown, ended and invalid per address, once per session however often it is named", () => {
    const { a, b } = pair(kind);
    const results = a.send([b.address, b.address, "nobody@server", "x@nowhere"])["results"];
    expect(results).toEqual([
      { to: "nobody@server", status: "unknown" },
      { to: "x@nowhere", status: "unknown" },
      { to: "reviewer@server", status: "routed" },
    ]);
    // A box only for the laptop: the server session cannot read it.
    expect(a.send([b.address], { recipients: [a.d.id] })["results"]).toEqual([{ to: "reviewer@server", status: "invalid" }]);
    b.frame({ t: "bye", ended: true });
    expect(a.send([b.address])["results"]).toEqual([{ to: "reviewer@server", status: "ended" }]);
  });

  it("lets a session address itself explicitly", () => {
    const { a } = pair(kind);
    expect(a.send([a.address])["results"]).toEqual([{ to: "writer@laptop", status: "routed" }]);
    expect(a.conn.of("deliver")).toHaveLength(1);
  });

  it("broadcasts to every other live session, siblings and offline ones included", () => {
    const { h, w, a, b, root } = { ...pair(kind), w: undefined };
    void w;
    const sibling = new Client(h, a.d, "tester");
    sibling.connect();
    h.drop(b.conn);
    const results = a.send(["*"])["results"] as { to: string; status: string }[];
    expect(results.sort((x, y) => x.to.localeCompare(y.to))).toEqual([
      { to: "reviewer@server", status: "queued" },
      { to: "root@admin", status: "routed" },
      { to: "tester@laptop", status: "routed" },
    ]);
    expect(a.conn.of("deliver")).toHaveLength(0);
    expect(root.conn.of("deliver")).toHaveLength(1);
  });

  it("skips ended sessions in a broadcast", () => {
    const { a, b } = pair(kind);
    b.frame({ t: "bye", ended: true });
    expect(a.send(["*"])["results"]).toEqual([{ to: "root@admin", status: "routed" }]);
  });

  it("answers unknown for a broadcast that reaches nobody", () => {
    const w = world(kind);
    expect(w.root.send(["*"])["results"]).toEqual([{ to: "*", status: "unknown" }]);
  });

  it("refuses a message id another session already used, and merges a sender's own retry", () => {
    const { h, a, b, root } = pair(kind);
    const f = a.seal([b.address]);
    a.frame(f);
    a.frame(a.seal([root.address], { id: f.id }));
    expect(h.store.getMessage(f.id)!.rcpts.sort()).toEqual([b.sid, root.sid].sort());
    const stolen = b.seal([a.address], { id: f.id });
    b.conn.take();
    expect(b.frame(stolen)).toEqual([{ t: "error", code: "malformed", message: "message id already used", ref: f.id }]);
  });

  it("holds 50 messages per queue and 10 from any one sender device", () => {
    const w = world(kind, ["laptop", "server", "box2", "box3", "box4", "box5"]);
    const target = new Client(w.h, w.members[1]!, "inbox");
    target.connect();
    w.h.drop(target.conn);
    const senders = [0, 2, 3, 4, 5].map((i) => {
      const c = new Client(w.h, w.members[i]!, "s");
      c.connect();
      return c;
    });
    for (const s of senders) {
      for (let i = 0; i < 10; i++) expect(s.send([target.address])["results"][0]["status"]).toBe("queued");
    }
    // Each device used its share; the queue is now full for anyone.
    expect(senders[0]!.send([target.address])["results"][0]["status"]).toBe("full");
    expect(w.root.send([target.address])["results"][0]["status"]).toBe("full");
  });

  it("rate limits sends at a burst of 20, refilling at 60 a minute", () => {
    const { h, a, b } = pair(kind, { limits: { queuePerSenderDevice: 50 } });
    for (let i = 0; i < 20; i++) a.send([b.address]);
    expect(a.send([b.address, "x@y"])["results"]).toEqual([
      { to: "reviewer@server", status: "limited" },
      { to: "x@y", status: "limited" },
    ]);
    h.now += 1000;
    expect(a.send([b.address])["results"][0]["status"]).toBe("routed");
  });

  it("rate limits broadcasts at 6 a minute without spending a send", () => {
    const { a, b } = pair(kind);
    for (let i = 0; i < 6; i++) a.send(["*"]);
    expect(a.send(["*"])["results"]).toEqual([{ to: "*", status: "limited" }]);
    expect(a.send([b.address])["results"][0]["status"]).toBe("routed");
  });

  it("limits fanned-out bytes per sender device", () => {
    const { a, b } = pair(kind, { limits: { fanoutBytesPerMinute: 6000 } });
    const first = a.send([b.address, "root@admin"]);
    expect(first["results"].map((r: { status: string }) => r.status)).toEqual(["routed", "routed"]);
    expect(a.send(["*"])["results"].map((r: { status: string }) => r.status)).toEqual(["limited", "limited"]);
  });

  it("checks the frame limit after auth without closing", () => {
    const { a } = pair(kind, { limits: { frameBytes: 2000 } });
    expect(a.frame(JSON.stringify({ t: "ping", pad: "x".repeat(2000) }))).toEqual([{ t: "error", code: "too_large", message: "frame is too large" }]);
    expect(a.frame("[1]")).toEqual([{ t: "error", code: "malformed", message: "malformed" }]);
    expect(a.frame('{"t":"ping","t":"ping"}')[0]!["code"]).toBe("duplicate_key");
    expect(a.frame({ t: "teleport" })).toEqual([{ t: "error", code: "unknown_type", message: "unknown_type", ref: "teleport" }]);
    expect(a.frame({ t: "ping" })).toEqual([{ t: "pong" }]);
    expect(a.conn.closed).toBeUndefined();
  });
});

describe.each(KINDS)("receipts and expiry (%s store)", (kind) => {
  it("forwards a receipt from an addressee with its own address, and drops the rest", () => {
    const { a, b, root } = pair(kind);
    const id = a.send([b.address])["id"] as string;
    b.frame({ t: "receipt", id, to: "spoof@admin", status: "delivered" });
    expect(a.conn.last()).toEqual({ t: "receipt", id, to: "reviewer@server", status: "delivered" });
    a.conn.take();
    root.conn.take();
    root.frame({ t: "receipt", id, to: root.address, status: "held" });
    b.frame({ t: "receipt", id: ulid(), to: b.address, status: "held" });
    expect(a.conn.take()).toEqual([]);
    expect(b.frame({ t: "receipt", id, to: b.address, status: "expired" })[0]).toMatchObject({ code: "malformed", ref: "receipt" });
    a.frame({ t: "bye", ended: false });
    b.conn.take();
    expect(b.frame({ t: "receipt", id, to: b.address, status: "refused" })).toEqual([]);
  });

  it("expires queued messages after 24 hours with an expired receipt to an online sender", () => {
    const { h, a, b } = pair(kind);
    h.drop(b.conn);
    const id = a.send([b.address])["id"];
    h.advance(DAY - 1);
    expect(h.store.queueCount(b.sid)).toBe(1);
    h.advance(1);
    expect(h.store.queueCount(b.sid)).toBe(0);
    expect(a.conn.last()).toEqual({ t: "receipt", id, to: "reviewer@server", status: "expired" });
  });

  it("drops the expired receipt when the sender is offline or gone", () => {
    const { h, a, b, root } = pair(kind);
    h.drop(b.conn);
    a.send([b.address]);
    root.send([b.address]);
    a.frame({ t: "bye", ended: false });
    h.drop(root.conn);
    h.advance(DAY);
    // Both senders' sessions were offline for a day with empty queues, so they are gone too.
    expect(h.store.getSession(a.sid)).toBeUndefined();
    expect(h.store.queueCount(b.sid)).toBe(0);
  });
});

describe.each(KINDS)("sessions and names (%s store)", (kind) => {
  it("takes over an offline name and queue by resume proof, with a new sid", () => {
    const { h, a, b } = pair(kind);
    h.drop(b.conn);
    a.send([b.address]);
    const restarted = new Client(h, b.d, "reviewer", { resume: b.resume });
    const frames = restarted.connect();
    expect(frames[0]).toMatchObject({ name: "reviewer", sid: restarted.sid });
    expect(frames.filter((f) => f["t"] === "deliver")).toHaveLength(1);
    expect(h.store.getSession(b.sid)).toBeUndefined();
    // Receipts now route to the new sid as well.
    const id = restarted.send([a.address])["id"];
    a.frame({ t: "receipt", id, to: a.address, status: "delivered" });
    expect(restarted.conn.last()).toMatchObject({ t: "receipt", id });
  });

  it("gives name-N without proof, and while the holder is online", () => {
    const { h, b } = pair(kind);
    const intruder = new Client(h, b.d, "reviewer");
    intruder.connect();
    expect(intruder.name).toBe("reviewer-2");
    h.drop(b.conn);
    const third = new Client(h, b.d, "reviewer");
    third.connect();
    expect(third.name).toBe("reviewer-3");
  });

  it("keeps a long name within 32 characters when numbering it", () => {
    const { h, b } = pair(kind);
    const long = "a".repeat(32);
    new Client(h, b.d, long).connect();
    const second = new Client(h, b.d, long);
    second.connect();
    expect(second.name).toBe(`${"a".repeat(30)}-2`);
  });

  it("reclaims its own offline row by sid, renaming if its name was taken meanwhile", () => {
    const { h, b } = pair(kind);
    h.drop(b.conn);
    const taker = new Client(h, b.d, "reviewer");
    taker.connect();
    expect(taker.name).toBe("reviewer-2");
    const again = new Client(h, b.d, "reviewer", { sid: b.sid, resume: b.resume });
    again.connect();
    expect(again.ready).toMatchObject({ sid: b.sid, name: "reviewer" });
    // A sid alone does not reclaim an offline row: it appears in peer rows.
    h.drop(taker.conn);
    const bySid = new Client(h, b.d, "reviewer-2", { sid: taker.sid });
    expect(bySid.connect()[0]).toMatchObject({ code: "unauthorized", message: "the session id is not available without its resume secret" });
  });

  it("replaces a live connection for the same sid only with the resume secret", () => {
    const { h, b } = pair(kind);
    const wrong = new Client(h, b.d, "reviewer", { sid: b.sid });
    wrong.connect();
    expect(wrong.conn.closed?.code).toBe(CLOSE.unauthorized);
    const right = new Client(h, b.d, "reviewer", { sid: b.sid, resume: b.resume });
    expect(right.connect()[0]).toMatchObject({ t: "ready", name: "reviewer" });
    expect(b.conn.closed).toEqual({ code: CLOSE.replaced, reason: "replaced by a new connection" });
    // The replaced socket's late close does not take the session offline.
    h.relay.onClose(b.conn);
    expect(h.store.getSession(b.sid)!.conn).toBe(right.conn.id);
  });

  it("refuses a sid held by another device or a session that ended", () => {
    const { h, a, b } = pair(kind);
    const thief = new Client(h, b.d, "x", { sid: a.sid });
    expect(thief.connect()[0]).toMatchObject({ code: "unauthorized", message: "the session id is not available" });
    a.frame({ t: "bye", ended: true });
    const back = new Client(h, a.d, "writer", { sid: a.sid, resume: a.resume });
    back.connect();
    expect(back.conn.closed?.code).toBe(CLOSE.unauthorized);
  });

  it("caps sessions per device and per mesh", () => {
    const w = world(kind, ["laptop"], { limits: { sessionsPerDevice: 2, sessionsPerMesh: 3 } });
    const d = w.members[0]!;
    new Client(w.h, d, "one").connect();
    new Client(w.h, d, "two").connect();
    const three = new Client(w.h, d, "three");
    expect(three.connect()[0]).toMatchObject({ code: "limited", ref: "auth" });
    expect(three.conn.closed?.code).toBe(CLOSE.limited);
    const extra = new Client(w.h, w.admin, "extra");
    extra.connect();
    expect(extra.conn.closed?.code).toBe(CLOSE.limited);
  });

  it("renames, refuses a name another session holds, and accepts its own name", () => {
    const { h, a, b } = pair(kind);
    const sib = new Client(h, a.d, "tester");
    sib.connect();
    h.drop(sib.conn);
    a.conn.take();
    expect(a.frame({ t: "rename", name: "tester" })).toEqual([{ t: "error", code: "name_taken", message: "a session on this device holds that name", ref: "rename" }]);
    const frames = a.frame({ t: "rename", name: "author" });
    expect(frames[0]).toMatchObject({ t: "peer", peer: { address: "author@laptop" } });
    expect(b.conn.last("peers")["peers"].map((p: { address: string }) => p.address)).toContain("author@laptop");
    a.name = "author";
    expect(a.send([b.address])["results"][0]["status"]).toBe("routed");
    a.conn.take();
    expect(a.frame({ t: "rename", name: "author" })[0]!["t"]).toBe("peer");
  });

  it("reports presence, lists peers, and ends a session with bye", () => {
    const { h, a, b } = pair(kind);
    b.conn.take();
    h.now += 5;
    a.frame({ t: "presence", status: "busy" });
    expect(b.conn.take()).toEqual([{ t: "peer", peer: { address: "writer@laptop", sid: a.sid, kind: "cli", status: "busy", since: h.now, rooms: [] } }]);
    a.frame({ t: "presence", status: "busy" });
    expect(b.conn.take()).toEqual([]);
    expect(a.frame({ t: "peers" })[0]!["peers"].map((p: { address: string }) => p.address).sort()).toEqual(["reviewer@server", "root@admin"]);
    a.frame({ t: "bye", ended: true });
    expect(a.conn.closed).toEqual({ code: CLOSE.bye, reason: "bye" });
    expect(b.conn.last("peers")["peers"].map((p: { address: string }) => p.address)).toEqual(["root@admin"]);
    // The name is free again for a new session.
    const next = new Client(h, a.d, "writer");
    next.connect();
    expect(next.name).toBe("writer");
  });

  it("forgets tombstones and abandoned offline sessions after a day", () => {
    const { h, a, b } = pair(kind);
    a.frame({ t: "bye", ended: true });
    h.drop(b.conn);
    h.advance(DAY - 1);
    expect(h.store.getSession(a.sid)).toBeDefined();
    h.advance(1);
    expect(h.store.getSession(a.sid)).toBeUndefined();
    expect(h.store.getSession(b.sid)).toBeUndefined();
  });

  it("keeps an offline session while its queue still holds messages", () => {
    const { h, a, b } = pair(kind);
    h.drop(b.conn);
    h.advance(HOUR);
    a.send([b.address]);
    h.advance(DAY - HOUR);
    expect(h.store.getSession(b.sid)).toBeDefined();
    h.advance(HOUR);
    h.advance(1);
    expect(h.store.getSession(b.sid)).toBeUndefined();
  });
});

describe.each(KINDS)("idle notices (%s store)", (kind) => {
  it("sends one notice when the target next reports idle", () => {
    const { a, b } = pair(kind);
    expect(a.frame({ t: "notify_idle", of: b.address })).toEqual([]);
    a.frame({ t: "notify_idle", of: b.address });
    b.frame({ t: "presence", status: "busy" });
    expect(a.conn.of("notice")).toEqual([]);
    b.frame({ t: "presence", status: "idle" });
    b.frame({ t: "presence", status: "idle" });
    expect(a.conn.of("notice")).toEqual([{ t: "notice", kind: "idle", of: "reviewer@server" }]);
  });

  it("notifies when the target ends, not when the subscriber is offline, and not after 12 hours", () => {
    const { h, a, b, root } = pair(kind);
    a.frame({ t: "notify_idle", of: b.address });
    root.frame({ t: "notify_idle", of: b.address });
    h.drop(root.conn);
    b.frame({ t: "bye", ended: true });
    expect(a.conn.of("notice")).toHaveLength(1);
    expect(root.conn.of("notice")).toHaveLength(0);
    const c = new Client(h, b.d, "c");
    c.connect();
    h.sendFrame(a.conn, { t: "notify_idle", of: c.address });
    // Lapsed but not yet swept: still not delivered.
    h.now += 12 * HOUR;
    c.frame({ t: "presence", status: "idle" });
    expect(a.conn.of("notice")).toHaveLength(1);
    h.sendFrame(a.conn, { t: "notify_idle", of: c.address });
    h.advance(12 * HOUR);
    c.frame({ t: "presence", status: "idle" });
    expect(a.conn.of("notice")).toHaveLength(1);
  });

  it("refuses an unknown target and more than 16 armed notices", () => {
    const w = world(kind, ["laptop"], { limits: { notifyIdlePerSession: 1 } });
    const a = new Client(w.h, w.members[0]!, "a");
    a.connect();
    w.root.conn.take();
    expect(w.root.frame({ t: "notify_idle", of: "x@laptop" })[0]).toMatchObject({ code: "not_found", ref: "notify_idle" });
    w.root.frame({ t: "notify_idle", of: a.address });
    expect(w.root.frame({ t: "notify_idle", of: "root@admin" })[0]).toMatchObject({ code: "limited" });
    // Re-arming the same target refreshes it rather than counting twice.
    expect(w.root.frame({ t: "notify_idle", of: a.address })).toEqual([]);
  });
});

describe.each(KINDS)("restarts (%s store)", (kind) => {
  it("queues for a session whose socket vanished before its close event arrived", () => {
    const { h, a, b } = pair(kind);
    h.conns.delete(b.conn.id);
    expect(a.send([b.address])["results"]).toEqual([{ to: "reviewer@server", status: "queued" }]);
  });

  it("survives a hibernation: a new relay instance continues every session from the store and saved states", () => {
    const { h, a, b } = pair(kind);
    a.send([b.address]);
    h.hibernate();
    b.frame({ t: "ack", cursor: 1 });
    expect(h.store.queueCount(b.sid)).toBe(0);
    expect(a.send([b.address])["results"]).toEqual([{ to: "reviewer@server", status: "routed" }]);
    expect(b.conn.last("deliver")["cursor"]).toBe(2);
    b.frame({ t: "ack", cursor: 2 });
    expect(b.frame({ t: "ack", cursor: 3 })[0]!["code"]).toBe("malformed");
  });

  it("marks sessions offline after a process restart that lost every connection", () => {
    const { h, a, b } = pair(kind);
    a.send([b.address]);
    const restarted = new Harness(h.store);
    restarted.now = h.now;
    expect(restarted.store.getSession(b.sid)!.conn).toBeNull();
    const again = new Client(restarted, b.d, "reviewer", { sid: b.sid, resume: b.resume });
    const frames = again.connect();
    expect(frames.filter((f) => f["t"] === "deliver").map((f) => f["cursor"])).toEqual([1]);
    void randomBytes;
  });
});
