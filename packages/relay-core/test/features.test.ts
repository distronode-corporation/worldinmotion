import { leaseKey, sealBlob, ulid } from "@worldinmotion/protocol";
import { describe, expect, it } from "vitest";
import { Client, KINDS, MESH, publish, world } from "./helpers.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function trio(kind: (typeof KINDS)[number], config = {}) {
  const w = world(kind, ["laptop", "server"], config);
  const a = new Client(w.h, w.members[0]!, "a");
  const b = new Client(w.h, w.members[1]!, "b");
  a.connect();
  b.connect();
  for (const c of [w.root, a, b]) c.conn.take();
  return { ...w, a, b };
}

describe.each(KINDS)("rooms (%s store)", (kind) => {
  it("joins, routes a room send to every other member, and keeps history", () => {
    const { h, a, b, root } = trio(kind);
    expect(a.frame({ t: "room.join", room: "#ops" })).toEqual([{ t: "room.joined", room: "#ops", members: ["a@laptop"] }]);
    expect(b.conn.last("peer")["peer"]).toMatchObject({ address: "a@laptop", rooms: ["#ops"] });
    expect(b.frame({ t: "room.join", room: "#ops" }).at(-1)).toEqual({ t: "room.joined", room: "#ops", members: ["a@laptop", "b@server"] });
    // Joining again is a no-op that still answers.
    expect(b.frame({ t: "room.join", room: "#ops" })).toEqual([{ t: "room.joined", room: "#ops", members: ["a@laptop", "b@server"] }]);
    h.drop(b.conn);
    const sent = a.send(["#ops"]);
    expect(sent["results"]).toEqual([{ to: "b@server", status: "queued" }]);
    // A non-member may send to the room too; the sender is never a recipient.
    expect(root.send(["#ops", "#ops"])["results"].map((r: { to: string }) => r.to).sort()).toEqual(["a@laptop", "b@server"]);
    expect(a.send(["#nowhere"])["results"]).toEqual([{ to: "#nowhere", status: "unknown" }]);
    // Membership survives a reconnect.
    const back = b.connect();
    expect(back[0]!["peers"].find((p: { address: string }) => p.address === "a@laptop").rooms).toEqual(["#ops"]);
    expect(h.store.roomsOf(b.sid)).toEqual(["#ops"]);

    const hist = a.frame({ t: "room.history", room: "#ops" })[0]!;
    expect(hist).toMatchObject({ t: "room.history", room: "#ops", more: false });
    expect(hist["msgs"].map((m: { cursor: number; msg: { id: string } }) => [m.cursor, m.msg.id])).toEqual([
      [1, sent["id"]],
      [2, expect.any(String)],
    ]);
  });

  it("pages history before a cursor and caps a page by count and by frame size", () => {
    const { a } = trio(kind, { limits: { roomHistoryPageMax: 3, frameBytes: 20000, broadcastsPerMinute: 60 } });
    a.frame({ t: "room.join", room: "#log" });
    for (let i = 0; i < 5; i++) a.send(["#log"]);
    const page = a.frame({ t: "room.history", room: "#log", limit: 10 })[0]!;
    expect(page["msgs"].map((m: { cursor: number }) => m.cursor)).toEqual([3, 4, 5]);
    expect(page["more"]).toBe(true);
    const older = a.frame({ t: "room.history", room: "#log", before: 3, limit: 1 })[0]!;
    expect(older["msgs"].map((m: { cursor: number }) => m.cursor)).toEqual([2]);
    for (let i = 0; i < 3; i++) expect(a.send(["#log"], { text: "x".repeat(3000) })["t"]).toBe("sent");
    const big = a.frame({ t: "room.history", room: "#log" })[0]!;
    expect(big["msgs"]).toHaveLength(1);
    expect(big["more"]).toBe(true);
    expect(a.frame({ t: "room.history", room: "#none" })).toEqual([{ t: "room.history", room: "#none", msgs: [], more: false }]);
  });

  it("answers an empty page before the oldest message with more: false", () => {
    const { a } = trio(kind);
    a.frame({ t: "room.join", room: "#ops" });
    a.send(["#ops"]);
    // The one message has cursor 1, so nothing is older: a client paging back must be told to stop.
    expect(a.frame({ t: "room.history", room: "#ops", before: 1, limit: 5 })).toEqual([{ t: "room.history", room: "#ops", msgs: [], more: false }]);
    expect(a.frame({ t: "room.history", room: "#ops", before: 2, limit: 5 })[0]).toMatchObject({ msgs: [{ cursor: 1 }], more: false });
  });

  it("keeps the last 100 messages for 7 days, then forgets an empty room", () => {
    const { h, a } = trio(kind, { limits: { roomHistoryMessages: 2, broadcastsPerMinute: 60 } });
    a.frame({ t: "room.join", room: "#log" });
    for (let i = 0; i < 4; i++) a.send(["#log"]);
    expect(a.frame({ t: "room.history", room: "#log" })[0]!["msgs"].map((m: { cursor: number }) => m.cursor)).toEqual([3, 4]);
    a.frame({ t: "room.leave", room: "#log" });
    h.advance(7 * DAY);
    expect(h.store.getRoom("#log")).toBeUndefined();
  });

  it("leaves a room, and leaves every room on bye", () => {
    const { h, a, b } = trio(kind);
    a.frame({ t: "room.join", room: "#x" });
    a.frame({ t: "room.join", room: "#y" });
    expect(a.frame({ t: "room.leave", room: "#x" })).toEqual([{ t: "peer", peer: expect.objectContaining({ rooms: ["#y"] }) }]);
    expect(a.frame({ t: "room.leave", room: "#x" })[0]!["peer"]["rooms"]).toEqual(["#y"]);
    a.frame({ t: "bye", ended: true });
    expect(h.store.roomsOf(a.sid)).toEqual([]);
    expect(b.conn.last("peers")["peers"]).toEqual([expect.objectContaining({ address: "root@admin" })]);
  });

  it("limits rooms per session and per mesh", () => {
    const { a, b } = trio(kind, { limits: { roomsPerSession: 1, roomsPerMesh: 2 } });
    a.frame({ t: "room.join", room: "#one" });
    expect(a.frame({ t: "room.join", room: "#two" })).toEqual([{ t: "error", code: "room_limit", message: "too many rooms", ref: "room.join" }]);
    b.frame({ t: "room.join", room: "#two" });
    const c = new Client(a.h, a.d, "c");
    c.connect();
    expect(c.frame({ t: "room.join", room: "#three" })[0]!["code"]).toBe("room_limit");
    expect(c.frame({ t: "room.join", room: "#one" })[0]!["t"]).toBe("room.joined");
  });

  it("counts a room send against the broadcast rate", () => {
    const { a } = trio(kind, { limits: { broadcastsPerMinute: 2 } });
    a.frame({ t: "room.join", room: "#r" });
    a.send(["#r"]);
    a.send(["*"]);
    expect(a.send(["#r"])["results"]).toEqual([{ to: "#r", status: "limited" }]);
  });

  it("caps the mesh's history in bytes, dropping the oldest entries of any room", () => {
    // One room send's size in this mesh shape, measured on a throwaway copy.
    const probe = trio(kind);
    probe.a.frame({ t: "room.join", room: "#x" });
    probe.a.send(["#x"]);
    const size = probe.h.store.historyBytes();
    const { a } = trio(kind, { limits: { roomHistoryBytesPerMesh: Math.floor(size * 2.5), broadcastsPerMinute: 60 } });
    a.frame({ t: "room.join", room: "#x" });
    a.frame({ t: "room.join", room: "#y" });
    a.send(["#x"]);
    a.send(["#y"]);
    a.send(["#y"]);
    a.send(["#x"]);
    const cursors = (room: string) => a.frame({ t: "room.history", room })[0]!["msgs"].map((m: { cursor: number }) => m.cursor);
    expect(cursors("#x")).toEqual([2]);
    expect(cursors("#y")).toEqual([2]);
  });

  it("does not store history for a send refused by the fan-out budget", () => {
    const { a, b } = trio(kind, { limits: { fanoutBytesPerMinute: 100 } });
    a.frame({ t: "room.join", room: "#r" });
    b.frame({ t: "room.join", room: "#r" });
    expect(a.send(["#r"])["results"]).toEqual([{ to: "b@server", status: "limited" }]);
    expect(a.frame({ t: "room.history", room: "#r" })[0]!["msgs"]).toEqual([]);
  });

  it("moves membership with a takeover by proof", () => {
    const { h, b } = trio(kind);
    b.frame({ t: "room.join", room: "#ops" });
    h.drop(b.conn);
    const again = new Client(h, b.d, "b", { resume: b.resume });
    again.connect();
    expect(h.store.roomsOf(again.sid)).toEqual(["#ops"]);
  });
});

describe.each(KINDS)("leases (%s store)", (kind) => {
  const key = leaseKey(MESH, "deploy");

  it("grants, reports held, renews, releases, and fences with a rising token", () => {
    const { h, a, b } = trio(kind);
    const g = a.frame({ t: "lease.acquire", key, ttl: MIN })[0]!;
    expect(g).toEqual({ t: "lease", key, status: "granted", holder: "a@laptop", until: h.now + MIN, token: 1 });
    expect(b.frame({ t: "lease.acquire", key, ttl: MIN })).toEqual([{ t: "lease", key, status: "held", holder: "a@laptop", until: h.now + MIN }]);
    expect(a.frame({ t: "lease.acquire", key, ttl: MIN, wait: true })[0]!["status"]).toBe("held");
    expect(a.frame({ t: "lease.list" })).toEqual([{ t: "leases", leases: [{ key, holder: "a@laptop", until: h.now + MIN, token: 1 }] }]);
    h.now += 1000;
    expect(a.frame({ t: "lease.renew", key, token: 1, ttl: MIN })).toEqual([{ t: "lease", key, status: "renewed", until: h.now + MIN, token: 1 }]);
    expect(b.frame({ t: "lease.renew", key, token: 1, ttl: MIN })[0]!["status"]).toBe("refused");
    expect(a.frame({ t: "lease.renew", key, token: 2, ttl: MIN })[0]!["status"]).toBe("refused");
    expect(b.frame({ t: "lease.release", key, token: 1 })[0]!["status"]).toBe("refused");
    expect(a.frame({ t: "lease.release", key, token: 2 })[0]!["status"]).toBe("refused");
    expect(a.frame({ t: "lease.release", key, token: 1 })).toEqual([{ t: "lease", key, status: "released", token: 1 }]);
    expect(b.frame({ t: "lease.acquire", key, ttl: MIN })[0]).toMatchObject({ status: "granted", token: 2 });
    expect(a.frame({ t: "lease.renew", key: leaseKey(MESH, "none"), token: 1, ttl: MIN })[0]!["status"]).toBe("refused");
  });

  it("hands a freed lease to the first waiter, and tells watchers", () => {
    const { h, a, b, root } = trio(kind);
    a.frame({ t: "lease.acquire", key, ttl: MIN });
    expect(b.frame({ t: "lease.acquire", key, ttl: MIN, wait: true })).toEqual([]);
    expect(root.frame({ t: "lease.acquire", key, ttl: 2 * MIN, wait: true })).toEqual([]);
    expect(root.frame({ t: "lease.watch", key })).toEqual([]);
    a.frame({ t: "lease.release", key, token: 1 });
    expect(b.conn.last("lease")).toMatchObject({ status: "granted", holder: "b@server", token: 2 });
    expect(root.conn.of("lease")).toEqual([{ t: "lease", key, status: "released" }]);
    // The expiry of b's lease reaches b, and the next waiter gets it.
    h.advance(MIN);
    expect(b.conn.last("lease")).toEqual({ t: "lease", key, status: "expired", token: 2 });
    expect(root.conn.last("lease")).toMatchObject({ status: "granted", token: 3 });
  });

  it("expires a waiter whose own ttl passes first, and skips waiters that went offline", () => {
    const { h, a, b, root } = trio(kind);
    a.frame({ t: "lease.acquire", key, ttl: 10 * MIN });
    b.frame({ t: "lease.acquire", key, ttl: MIN, wait: true });
    h.advance(MIN);
    expect(b.conn.last("lease")).toEqual({ t: "lease", key, status: "expired" });
    root.frame({ t: "lease.acquire", key, ttl: 10 * MIN, wait: true });
    h.drop(root.conn);
    const c = new Client(h, b.d, "c");
    c.connect();
    c.frame({ t: "lease.acquire", key, ttl: 2 * MIN, wait: true });
    const d = new Client(h, b.d, "d");
    d.connect();
    d.frame({ t: "lease.acquire", key, ttl: 5 * MIN, wait: true });
    // Released before the sweep saw c's wait lapse: c is told, root (offline) is skipped, d is granted.
    h.now += 3 * MIN;
    a.frame({ t: "lease.release", key, token: 1 });
    expect(c.conn.last("lease")).toEqual({ t: "lease", key, status: "expired" });
    expect(d.conn.last("lease")).toMatchObject({ status: "granted" });
  });

  it("ends a lease when its holder says bye, but not on a disconnect", () => {
    const { h, a, b } = trio(kind);
    a.frame({ t: "lease.acquire", key, ttl: MIN });
    h.drop(a.conn);
    expect(b.frame({ t: "lease.acquire", key, ttl: MIN })[0]!["status"]).toBe("held");
    const back = new Client(h, a.d, "a", { sid: a.sid, resume: a.resume });
    back.connect();
    // Another session's lease is untouched by a's bye; b, offline, is not told when its own ends.
    b.frame({ t: "lease.acquire", key: leaseKey(MESH, "other"), ttl: MIN });
    back.frame({ t: "bye", ended: true });
    h.drop(b.conn);
    h.advance(MIN);
    b.connect();
    expect(b.frame({ t: "lease.acquire", key, ttl: MIN })[0]!["status"]).toBe("granted");
  });

  it("treats a lease past its until as free before the sweep", () => {
    const { h, a, b } = trio(kind);
    a.frame({ t: "lease.acquire", key, ttl: MIN });
    h.now += MIN;
    expect(b.frame({ t: "lease.acquire", key, ttl: MIN })[0]).toMatchObject({ status: "granted", token: 2 });
    expect(a.conn.last("lease")).toMatchObject({ status: "expired" });
    expect(b.frame({ t: "lease.list" })[0]!["leases"]).toHaveLength(1);
    h.now += MIN;
    expect(b.frame({ t: "lease.list" })[0]!["leases"]).toEqual([]);
  });

  it("refuses a bad ttl and requests past the limits", () => {
    const { a, b } = trio(kind, { limits: { leaseTtlMaxMs: MIN, leasesPerSession: 1, leasesPerMesh: 2, leaseWatchesPerSession: 1 } });
    const k = (n: string) => leaseKey(MESH, n);
    expect(a.frame({ t: "lease.acquire", key, ttl: 2 * MIN })[0]!["status"]).toBe("refused");
    a.frame({ t: "lease.acquire", key: k("1"), ttl: MIN });
    expect(a.frame({ t: "lease.renew", key: k("1"), token: 1, ttl: 2 * MIN })[0]!["status"]).toBe("refused");
    expect(a.frame({ t: "lease.acquire", key: k("2"), ttl: MIN })[0]!["status"]).toBe("refused");
    b.frame({ t: "lease.acquire", key: k("2"), ttl: MIN });
    expect(b.frame({ t: "lease.acquire", key: k("1"), ttl: MIN, wait: true })[0]!["status"]).toBe("refused");
    const c = new Client(a.h, a.d, "c");
    c.connect();
    expect(c.frame({ t: "lease.acquire", key: k("3"), ttl: MIN })[0]!["status"]).toBe("refused");
    expect(c.frame({ t: "lease.watch", key: k("1") })).toEqual([]);
    expect(c.frame({ t: "lease.watch", key: k("1") })).toEqual([]);
    expect(c.frame({ t: "lease.watch", key: k("2") })[0]!["status"]).toBe("refused");
  });

  it("caps leases per device and a continuous hold at 4 hours", () => {
    const { h, a, b } = trio(kind, { limits: { leasesPerDevice: 1 } });
    const sib = new Client(h, a.d, "sib");
    sib.connect();
    a.frame({ t: "lease.acquire", key, ttl: HOUR });
    expect(sib.frame({ t: "lease.acquire", key: leaseKey(MESH, "x"), ttl: MIN })[0]!["status"]).toBe("refused");
    // A waiter whose device is at its cap when the lease frees is refused, and the next one granted.
    b.frame({ t: "lease.acquire", key: leaseKey(MESH, "y"), ttl: HOUR });
    sib.frame({ t: "lease.acquire", key: leaseKey(MESH, "y"), ttl: MIN, wait: true });
    b.frame({ t: "lease.release", key: leaseKey(MESH, "y"), token: 2 });
    expect(sib.conn.last("lease")).toEqual({ t: "lease", key: leaseKey(MESH, "y"), status: "refused" });
    for (let i = 1; i <= 3; i++) {
      h.now += HOUR - 1000;
      expect(a.frame({ t: "lease.renew", key, token: 1, ttl: HOUR })[0]!["status"]).toBe("renewed");
    }
    h.now += HOUR - 1000;
    expect(a.frame({ t: "lease.renew", key, token: 1, ttl: HOUR })[0]!["status"]).toBe("refused");
    expect(a.frame({ t: "lease.renew", key, token: 1, ttl: 4000 })[0]!["status"]).toBe("renewed");
  });

  it("lets a watch lapse after an hour", () => {
    const { h, a, b } = trio(kind);
    a.frame({ t: "lease.acquire", key, ttl: HOUR });
    b.frame({ t: "lease.watch", key });
    h.now += HOUR;
    a.frame({ t: "lease.release", key, token: 1 });
    expect(b.conn.of("lease")).toEqual([]);
  });

  it("hands a revoked device's leases on", () => {
    const w = world(kind, ["laptop"]);
    const a = new Client(w.h, w.members[0]!, "a");
    a.connect();
    a.frame({ t: "lease.acquire", key, ttl: MIN });
    w.root.frame({ t: "lease.acquire", key, ttl: MIN, wait: true });
    w.root.conn.take();
    publish(w, { revoke: [w.members[0]!.id] });
    expect(w.root.frame({ t: "lease.list" })[0]!["leases"]).toEqual([expect.objectContaining({ key, holder: "root@admin", token: 2 })]);
  });

  it("moves leases with a takeover by proof", () => {
    const { h, b } = trio(kind);
    b.frame({ t: "lease.acquire", key, ttl: MIN });
    b.frame({ t: "lease.watch", key: leaseKey(MESH, "w") });
    h.drop(b.conn);
    const again = new Client(h, b.d, "b", { resume: b.resume });
    again.connect();
    expect(again.frame({ t: "lease.renew", key, token: 1, ttl: MIN })[0]!["status"]).toBe("renewed");
  });
});

describe.each(KINDS)("blobs (%s store)", (kind) => {
  const sealed = sealBlob(new Uint8Array(1000).fill(3));
  const chunk = sealed.chunks[0]!;
  const put = (blob = sealed.blob) => ({ t: "blob.put", blob, index: 0, last: true, n: chunk.n, data: chunk.data });

  it("stores a chunk and serves it to any session of the mesh", () => {
    const { a, b } = trio(kind);
    expect(a.frame(put())).toEqual([{ t: "blob.stored", blob: sealed.blob, index: 0 }]);
    expect(b.frame({ t: "blob.get", blob: sealed.blob, index: 0 })).toEqual([{ t: "blob.chunk", blob: sealed.blob, index: 0, last: true, n: chunk.n, data: chunk.data }]);
    expect(b.frame({ t: "blob.get", blob: sealed.blob, index: 1 })).toEqual([{ t: "error", code: "blob_missing", message: "no such chunk", ref: "blob.get" }]);
    // The storing device may replace its chunk; another device may not.
    expect(a.frame(put())[0]!["t"]).toBe("blob.stored");
    expect(b.frame(put())[0]).toMatchObject({ code: "unauthorized", ref: "blob.put" });
  });

  it("forgets chunks after 24 hours", () => {
    const { h, a } = trio(kind);
    a.frame(put());
    h.advance(DAY);
    expect(a.frame({ t: "blob.get", blob: sealed.blob, index: 0 })[0]!["code"]).toBe("blob_missing");
  });

  it("enforces the per-device daily and per-mesh quotas", () => {
    const bytes = Math.floor((chunk.data.length * 3) / 4);
    const { h, a, b } = trio(kind, { limits: { blobBytesPerDevicePerDay: bytes * 2, blobBytesPerMesh: bytes * 3 } });
    a.frame(put(ulid()));
    a.frame(put(ulid()));
    expect(a.frame(put(ulid()))).toEqual([{ t: "error", code: "blob_quota", message: "blob storage limit reached", ref: "blob.put" }]);
    b.frame(put(ulid()));
    expect(b.frame(put(ulid()))[0]!["code"]).toBe("blob_quota");
    // The mesh is full whatever the device budget; a day later the chunks are gone and both refill.
    h.now += DAY / 2;
    expect(a.frame(put(ulid()))[0]!["code"]).toBe("blob_quota");
    h.advance(DAY / 2);
    expect(a.frame(put(ulid()))[0]!["t"]).toBe("blob.stored");
  });

  it("enforces a per-mesh daily budget across devices, refilling over the day", () => {
    const bytes = Math.floor((chunk.data.length * 3) / 4);
    const { h, a, b } = trio(kind, { limits: { blobBytesPerMeshPerDay: bytes * 2 } });
    expect(a.frame(put(ulid()))[0]!["t"]).toBe("blob.stored");
    expect(b.frame(put(ulid()))[0]!["t"]).toBe("blob.stored");
    const refused = { t: "error", code: "blob_quota", message: "this mesh's daily file allowance is used up; it refills over the day", ref: "blob.put" };
    expect(a.frame(put(ulid()))).toEqual([refused]);
    expect(b.frame(put(ulid()))).toEqual([refused]);
    // Half a day refills half the budget: one more chunk.
    h.now += DAY / 2;
    expect(a.frame(put(ulid()))[0]!["t"]).toBe("blob.stored");
    expect(b.frame(put(ulid()))).toEqual([refused]);
  });

  it("drops a revoked device's chunks", () => {
    const w = world(kind, ["laptop"]);
    const a = new Client(w.h, w.members[0]!, "a");
    a.connect();
    a.frame(put());
    publish(w, { revoke: [w.members[0]!.id] });
    expect(w.root.frame({ t: "blob.get", blob: sealed.blob, index: 0 })[0]!["code"]).toBe("blob_missing");
  });
});
