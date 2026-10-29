// Forward secrecy on the client (SPEC section 6b): the device's prekey store (store, rotate,
// delete), peers' prekeys, and what sessions do with them.

import {
  b64u,
  createPrekey,
  LIMITS,
  makeDeviceRecord,
  nextRoster,
  openMessage,
  prekeyDeleteAt,
  sealMessage,
  ulid,
  type Prekey,
  type PrekeyBox,
  type Roster,
  type SendFrame,
} from "@worldinmotion/protocol";
import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { revokeDevice } from "../src/admin.ts";
import { MeshSession } from "../src/client.ts";
import { writeJson } from "../src/fsx.ts";
import { MeshFiles } from "../src/mesh.ts";
import { PeerPrekeys, PrekeyStore } from "../src/prekeys.ts";
import { FS, makeMesh, newDevice, openSession, RelayHarness, run, said, scratch, sessionOpts, term, until, type TestDevice } from "./helpers.ts";

const HOUR = 3_600_000;
const T = 1_790_000_000_000;

const open: Array<{ stop: () => Promise<unknown> }> = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

async function session(...args: Parameters<typeof openSession>): Promise<MeshSession> {
  const s = await openSession(...args);
  open.push(s);
  return s;
}

function sentFrames(relay: RelayHarness): SendFrame[] {
  return relay.sentByClients.map((t) => JSON.parse(t) as { t: string }).filter((f): f is SendFrame => f.t === "send");
}

const vectors = JSON.parse(readFileSync(new URL("../../protocol/vectors/prekey.json", import.meta.url), "utf8")) as {
  roster: Roster;
  prekeys: { bob: { prekey: Prekey } };
  message: { now: number };
};

/** A one-device mesh roster for store tests, with the device's own keys. */
async function solo(): Promise<{ d: TestDevice; roster: Roster; dir: string }> {
  const d = await newDevice("solo");
  const { createGenesisRoster } = await import("@worldinmotion/protocol");
  const roster = createGenesisRoster({ name: "solo", keys: d.device.keys, now: T });
  return { d, roster, dir: await scratch("prekeys") };
}

describe("PrekeyStore: store, rotate, delete", () => {
  it("makes a prekey, rotates daily, deletes each secret at until + 72 hours", async () => {
    const { d, roster, dir } = await solo();
    let now = T;
    const path = join(dir, "prekeys.json");
    const store = new PrekeyStore({ path, env: FS, device: d.device, mesh: roster.mesh, now: () => now });
    expect(store.current()).toBeUndefined();
    expect(await store.maintain()).toBe(true);
    const first = store.current()!;
    expect(first).toMatchObject({ device: d.device.id, at: T, until: T + LIMITS.prekeyLifetimeMs });
    expect(store.secret(first.id)).toHaveLength(32);
    expect(store.due).toBe(T + LIMITS.prekeyRotateMs);
    // The same day: nothing to do, and the file is not rewritten.
    const mtime = (await fs.stat(path)).mtimeMs;
    now += HOUR;
    expect(await store.maintain()).toBe(false);
    expect((await fs.stat(path)).mtimeMs).toBe(mtime);
    // A day later: a new prekey, the old one kept for history and late deliveries.
    now = T + LIMITS.prekeyRotateMs;
    expect(await store.maintain()).toBe(true);
    const second = store.current()!;
    expect(second.id).not.toBe(first.id);
    expect(store.secret(first.id)).toBeDefined();
    // Daily for a week: the first secret goes at until + 72 hours, and at most six live at once.
    const ids = [first.id, second.id];
    for (let day = 2; day <= 7; day++) {
      now = T + day * LIMITS.prekeyRotateMs;
      await store.maintain();
      ids.push(store.current()!.id);
    }
    expect(prekeyDeleteAt(first)).toBe(T + 120 * HOUR);
    expect(store.secret(first.id)).toBeUndefined();
    const file = await fs.readFile(path, "utf8");
    expect(file).not.toContain(first.id);
    expect((JSON.parse(file) as { keys: unknown[] }).keys.length).toBeLessThanOrEqual(6);
    expect(store.due).toBeLessThanOrEqual(now + LIMITS.prekeyRotateMs);
  });

  it("never hands out a secret past its deletion time, even before the file is rewritten", async () => {
    const { d, roster, dir } = await solo();
    let now = T;
    const store = new PrekeyStore({ path: join(dir, "p.json"), env: FS, device: d.device, mesh: roster.mesh, now: () => now });
    await store.maintain();
    const pk = store.current()!;
    now = prekeyDeleteAt(pk) - 1;
    expect(store.secret(pk.id)).toBeDefined();
    now = prekeyDeleteAt(pk);
    expect(store.secret(pk.id)).toBeUndefined();
  });

  it("a sibling's rotation is read on reload; one prekey a day across siblings", async () => {
    const { d, roster, dir } = await solo();
    let now = T;
    const opts = { path: join(dir, "p.json"), env: FS, device: d.device, mesh: roster.mesh, now: () => now };
    const one = new PrekeyStore(opts);
    const two = new PrekeyStore(opts);
    await Promise.all([one.maintain(), two.maintain()]);
    expect(one.current()!.id).toBe(two.current()!.id);
    now += LIMITS.prekeyRotateMs;
    await one.maintain();
    const fresh = one.current()!;
    expect(two.secret(fresh.id)).toBeUndefined();
    await two.reload();
    expect(two.secret(fresh.id)).toEqual(one.secret(fresh.id));
  });

  it("a clock set back rotates once, not on every pass, and the count stays capped", async () => {
    const { d, roster, dir } = await solo();
    let now = T + 10 * HOUR;
    const path = join(dir, "p.json");
    const store = new PrekeyStore({ path, env: FS, device: d.device, mesh: roster.mesh, now: () => now });
    await store.maintain();
    now = T;
    expect(store.current()).toBeUndefined();
    expect(await store.maintain()).toBe(true);
    expect(await store.maintain()).toBe(false);
    expect(store.current()!.at).toBe(T);
    // Nine valid prekeys written by hand (a misbehaving clock): the store keeps the newest eight.
    const nine = Array.from({ length: 9 }, (_, i) => createPrekey({ mesh: roster.mesh, deviceId: d.device.id, signSec: d.device.keys.signSec, at: T + i }));
    await writeJson(path, { v: 1, keys: nine.map((h) => ({ prekey: h.prekey, secret: b64u.encode(h.secret) })) }, FS);
    expect(await store.maintain()).toBe(false);
    expect(store.secret(nine[0]!.prekey.id)).toBeUndefined();
    expect(store.secret(nine[8]!.prekey.id)).toBeDefined();
  });

  it("an unreadable file on reload keeps the secrets already held", async () => {
    const { d, roster, dir } = await solo();
    const path = join(dir, "p.json");
    const store = new PrekeyStore({ path, env: FS, device: d.device, mesh: roster.mesh, now: () => T });
    await store.maintain();
    const pk = store.current()!;
    await fs.rm(path);
    await fs.mkdir(path);
    await store.reload();
    expect(store.secret(pk.id)).toBeDefined();
  });

  it("skips anything in the file that is not a prekey with its secret", async () => {
    const { d, roster, dir } = await solo();
    const path = join(dir, "p.json");
    const store = new PrekeyStore({ path, env: FS, device: d.device, mesh: roster.mesh, now: () => T });
    const good = createPrekey({ mesh: roster.mesh, deviceId: d.device.id, signSec: d.device.keys.signSec, at: T });
    await writeJson(path, { v: 2, keys: [{ prekey: good.prekey, secret: b64u.encode(good.secret) }] }, FS);
    await store.reload();
    expect(store.secret(good.prekey.id)).toBeUndefined();
    await writeJson(path, { v: 1, keys: "nope" }, FS);
    await store.reload();
    expect(store.current()).toBeUndefined();
    const short = b64u.encode(new Uint8Array(16));
    await writeJson(path, { v: 1, keys: [null, { prekey: { x: 1 }, secret: b64u.encode(good.secret) }, { prekey: good.prekey, secret: short }, { prekey: good.prekey, secret: b64u.encode(good.secret) }] }, FS);
    await store.reload();
    expect(store.secret(good.prekey.id)).toEqual(good.secret);
  });
});

describe("PeerPrekeys: the newest verified prekey per peer device", () => {
  async function pair() {
    const a = await newDevice("a");
    const b = await newDevice("b");
    const { createGenesisRoster } = await import("@worldinmotion/protocol");
    const genesis = createGenesisRoster({ name: "a", keys: a.device.keys, now: T });
    const roster = nextRoster(genesis, { add: [makeDeviceRecord("b", b.device.keys, "member", T)] }, { keys: a.device.keys }, T);
    const make = (at: number) => createPrekey({ mesh: roster.mesh, deviceId: b.device.id, signSec: b.device.keys.signSec, at }).prekey;
    return { a, b, roster, genesis, make, dir: await scratch("peer-prekeys") };
  }

  it("keeps a newer one, refuses an older (replayed), forged, vector or malformed one, and shares them on disk", async () => {
    const { a, b, roster, make, dir } = await pair();
    let now = T;
    const path = join(dir, "peer.json");
    const peers = new PeerPrekeys({ path, env: FS, now: () => now });
    const p0 = make(T - HOUR);
    const p1 = make(T);
    expect(await peers.offer(p1, roster)).toBe(true);
    // A relay replaying an older card cannot roll the device back.
    expect(await peers.offer(p0, roster)).toBe(false);
    expect(await peers.offer(p1, roster)).toBe(false);
    expect(await peers.offer(undefined, roster)).toBe(false);
    const forged = { ...make(T + 1), sig: createPrekey({ mesh: roster.mesh, deviceId: a.device.id, signSec: a.device.keys.signSec, at: T + 1 }).prekey.sig };
    expect(await peers.offer(forged, roster)).toBe(false);
    // The published test vectors' prekey verifies, but its secret is public.
    expect(await peers.offer(vectors.prekeys.bob.prekey, vectors.roster)).toBe(false);
    expect(peers.forSend(roster, [b.device.id, a.device.id])).toEqual({ [b.device.id]: p1 });
    // A sibling session reads it from the file, merged with its own.
    const sibling = new PeerPrekeys({ path, env: FS, now: () => now });
    await sibling.reload();
    expect(sibling.forSend(roster, [b.device.id])).toEqual({ [b.device.id]: p1 });
    const p2 = make(T + HOUR);
    now = T + HOUR;
    expect(await sibling.offer(p2, roster)).toBe(true);
    await peers.reload();
    expect(peers.forSend(roster, [b.device.id])).toEqual({ [b.device.id]: p2 });
    // A session that still holds the older one writes it back: the newer one on disk stays.
    const slow = new PeerPrekeys({ path, env: FS, now: () => now });
    expect(await slow.offer(p1, roster)).toBe(true);
    const disk = new PeerPrekeys({ path, env: FS, now: () => now });
    await disk.reload();
    expect(disk.forSend(roster, [b.device.id])).toEqual({ [b.device.id]: p2 });
  });

  it("does not seal to an expired or revoked device's prekey", async () => {
    const { a, b, roster, make, dir } = await pair();
    let now = T;
    const peers = new PeerPrekeys({ path: join(dir, "peer.json"), env: FS, now: () => now });
    const pk = make(T);
    await peers.offer(pk, roster);
    const revoked = nextRoster(roster, { revoke: [b.device.id] }, { keys: a.device.keys }, T + 1);
    expect(peers.forSend(revoked, [b.device.id])).toEqual({});
    now = pk.until - LIMITS.prekeySendMarginMs;
    expect(peers.forSend(roster, [b.device.id])).toEqual({});
  });

  it("reads a damaged file as empty", async () => {
    const { roster, b, make, dir } = await pair();
    const path = join(dir, "peer.json");
    const peers = new PeerPrekeys({ path, env: FS, now: () => T });
    for (const content of [{ v: 2, prekeys: { x: make(T) } }, { v: 1, prekeys: null }, { v: 1, prekeys: "abc" }, { v: 1, prekeys: { x: { not: "a prekey" } } }]) {
      await writeJson(path, content, FS);
      await peers.reload();
      expect(peers.forSend(roster, [b.device.id])).toEqual({});
    }
  });
});

describe("sessions seal to prekeys", () => {
  it("a direct send uses the recipient's prekey and carries the sender's; the recipient reads it", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const out = await a.send("b@two", "forward secret");
    expect(out.unprotected).toBeUndefined();
    const frame = sentFrames(relay).at(-1)!;
    expect((frame.boxes[devices[1]!.device.id] as PrekeyBox).s).toBe(2);
    expect(frame.pk?.device).toBe(devices[0]!.device.id);
    await until(async () => (await b.spool.unread()).length === 1);
    // b learned a's prekey from the header (and a's card), so its reply is sealed to it.
    await b.send("a@one", "and back");
    const reply = sentFrames(relay).at(-1)!;
    expect((reply.boxes[devices[0]!.device.id] as PrekeyBox).p).toBe(frame.pk!.id);
    await until(async () => (await a.spool.unread()).length === 1);
  });

  it("sibling sessions read one box, and a sibling's rotation is picked up from the file", async () => {
    const relay = new RelayHarness();
    let now = Date.now();
    const clock = () => now;
    relay.now = clock;
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    // b2 runs no housekeeping of its own, so only b1 rotates.
    const b1 = await session(devices[1]!, mesh, relay, { name: "b1", now: clock });
    const b2 = await session(devices[1]!, mesh, relay, { name: "b2", now: clock, tickMs: 3_600_000 });
    const a = await session(devices[0]!, mesh, relay, { name: "a", now: clock });
    await b1.joinRoom("#ops");
    await b2.joinRoom("#ops");
    await a.send("#ops", "first");
    await until(async () => (await b1.spool.unread()).length === 1 && (await b2.spool.unread()).length === 1);
    const before = sentFrames(relay).at(-1)!.boxes[devices[1]!.device.id] as PrekeyBox;
    now += LIMITS.prekeyRotateMs + 1000;
    // b1's housekeeping rotates and publishes the new prekey in its card; a learns it.
    await until(() => relay.sentByClients.filter((t) => t.startsWith('{"t":"card.set"') && t.includes('"session":"b1"')).length >= 2, 3000, "b1's new card");
    await until(async () => {
      const out = await a.send("#ops", `probe ${ulid()}`);
      const box = sentFrames(relay).at(-1)!.boxes[devices[1]!.device.id] as PrekeyBox;
      return out.unprotected === undefined && box.p !== before.p;
    }, 3000, "a seals to the rotated prekey");
    // b2 never read the new prekey itself: it reloads the device's file to open the box.
    await until(async () => (await b2.spool.unread()).some((i) => /probe/.test(i.rendered)), 3000, "b2 reads the rotated box");
  });

  it("a sender holding an older, still valid prekey is still read", async () => {
    const relay = new RelayHarness();
    let now = Date.now();
    const clock = () => now;
    relay.now = clock;
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a", now: clock });
    const b = await session(devices[1]!, mesh, relay, { name: "b", now: clock });
    await a.send("b@two", "first");
    const old = (sentFrames(relay).at(-1)!.boxes[devices[1]!.device.id] as PrekeyBox).p;
    // b's rotation never reaches a: the relay drops cards to a from now on.
    relay.toClient = (text) => (text.startsWith('{"t":"card"') ? undefined : text);
    now += LIMITS.prekeyRotateMs + 1000;
    await until(() => relay.sentByClients.filter((t) => t.startsWith('{"t":"card.set"') && t.includes('"session":"b"')).length >= 2, 3000, "b rotated");
    await a.send("b@two", "stale but valid");
    expect((sentFrames(relay).at(-1)!.boxes[devices[1]!.device.id] as PrekeyBox).p).toBe(old);
    await until(async () => (await b.spool.unread()).some((i) => /stale but valid/.test(i.rendered)));
  });
});

describe("cards and sibling rotation", () => {
  it("a card sealed to a prekey a sibling made since is read after a reload", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b", tickMs: 3_600_000 });
    // A sibling on two adds a prekey to the device's file; b has not read it.
    const files = new MeshFiles(devices[1]!.home.meshDir(mesh), FS);
    const raw = JSON.parse(await fs.readFile(files.prekeysPath, "utf8")) as { v: 1; keys: unknown[] };
    const fresh = createPrekey({ mesh, deviceId: devices[1]!.device.id, signSec: devices[1]!.device.keys.signSec, at: Date.now() });
    await writeJson(files.prekeysPath, { v: 1, keys: [{ prekey: fresh.prekey, secret: b64u.encode(fresh.secret) }, ...raw.keys] }, FS);
    const card = sealMessage({
      roster: a.roster,
      sender: { deviceId: devices[0]!.device.id, keys: devices[0]!.device.keys },
      session: "a",
      sid: a.sid,
      to: ["*"],
      seq: 0,
      at: Date.now(),
      kind: "card",
      card: { cwd: "fresh-work" },
      recipients: a.roster.devices.map((r) => r.id),
      prekeys: { [devices[1]!.device.id]: fresh.prekey },
    });
    relay.inject(mesh, JSON.stringify({ t: "card", msg: card }));
    await until(async () => (await b.listPeers({ forPane: true })).find((p) => p.address === "a@one")?.card?.cwd === "fresh-work", 3000, "the card read");
  });
});

describe("the migration window and failure modes", () => {
  it("a device that publishes no prekey (a v0.1 client) gets a v0.1 box, reported as unprotected", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    // Strip the prekey from every card, as if two ran v0.1 (which publishes none).
    relay.toClient = (text) => (text.startsWith('{"t":"card') ? text.replace(/,"pk":\{[^}]*\}/g, "") : text);
    await fs.rm(new MeshFiles(devices[0]!.home.meshDir(mesh), FS).peerPrekeysPath, { force: true });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const t = term(devices[0]!.root, relay);
    expect(await run(t, "send", "b@two", "hello old client")).toBe(0);
    expect(said(t)).toMatch(/Sent without forward secrecy to two: no current prekey/);
    const frame = sentFrames(relay).at(-1)!;
    expect(Object.keys(frame.boxes[devices[1]!.device.id]!).sort()).toEqual(["c", "n"]);
    await until(async () => (await b.spool.unread()).length === 1);
  });

  it("a first send from a fresh process seals again once the cards page is read", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await session(devices[1]!, mesh, relay, { name: "b" });
    const files = new MeshFiles(devices[0]!.home.meshDir(mesh), FS);
    await fs.rm(files.peerPrekeysPath, { force: true });
    const a = await MeshSession.open(sessionOpts(devices[0]!, mesh, relay, { name: "a" }));
    open.push(a);
    a.start();
    // Sealed before the connection is ready: two's prekey is not known yet.
    const out = await a.send("b@two", "first words");
    expect(out.unprotected).toBeUndefined();
    expect((sentFrames(relay).at(-1)!.boxes[devices[1]!.device.id] as PrekeyBox).s).toBe(2);
  });

  it("does not wait forever for a cards page the relay withholds", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await session(devices[1]!, mesh, relay, { name: "b" });
    await fs.rm(new MeshFiles(devices[0]!.home.meshDir(mesh), FS).peerPrekeysPath, { force: true });
    relay.toClient = (text) => (text.startsWith('{"t":"cards"') ? undefined : text.startsWith('{"t":"card"') ? text.replace(/,"pk":\{[^}]*\}/g, "") : text);
    const a = await session(devices[0]!, mesh, relay, { name: "a", answerMs: 300 });
    const started = Date.now();
    const out = await a.send("b@two", "anyway");
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(out.unprotected).toEqual(["two"]);
  });

  it("a session past its own prekey's validity seals its own box without one, and sends no pk", async () => {
    const relay = new RelayHarness();
    let now = Date.now();
    const clock = () => now;
    relay.now = clock;
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a", now: clock, tickMs: 3_600_000 });
    now += LIMITS.prekeyLifetimeMs;
    const out = await a.send("*", "late");
    const frame = sentFrames(relay).at(-1)!;
    expect(frame.pk).toBeUndefined();
    expect(out.unprotected).toContain("one");
  });

  it("a message sealed to a deleted prekey is dropped, with one notice per sender device", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    // A prekey of two's that two no longer holds (its file was lost, or the secret deleted).
    const gone = createPrekey({ mesh, deviceId: devices[1]!.device.id, signSec: devices[1]!.device.keys.signSec, at: Date.now() - HOUR }).prekey;
    const frameTo = (text: string) =>
      sealMessage({ roster: a.roster, sender: { deviceId: devices[0]!.device.id, keys: devices[0]!.device.keys }, session: "a", sid: a.sid, to: ["b@two"], seq: 1000 + text.length, at: Date.now(), text, recipients: [devices[1]!.device.id], prekeys: { [devices[1]!.device.id]: gone } });
    expect(await b.receive(frameTo("one"))).toBe("dropped");
    expect(await b.receive(frameTo("second"))).toBe("dropped");
    const notices = (await b.spool.unread()).filter((i) => i.kind === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.rendered).toMatch(/could not be read: it was sealed to a prekey this device no longer holds/);
  });

  it("logs, and goes on, when a card's prekey cannot be stored", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const lines: string[] = [];
    const files = new MeshFiles(devices[0]!.home.meshDir(mesh), FS);
    await fs.rm(files.peerPrekeysPath, { force: true });
    // A directory where the file goes: every write of a learned prekey fails.
    await fs.mkdir(files.peerPrekeysPath, { recursive: true });
    const a = await session(devices[0]!, mesh, relay, { name: "a", log: (l) => lines.push(l) });
    await session(devices[1]!, mesh, relay, { name: "b" });
    await until(() => lines.some((l) => /^wim: prekey not stored: /.test(l)), 3000, "a logged line");
    void a;
  });
});

describe("a stolen key file", () => {
  it("cannot read recorded traffic older than the retention", async () => {
    const relay = new RelayHarness();
    let now = Date.now();
    const clock = () => now;
    relay.now = clock;
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const b = await session(devices[1]!, mesh, relay, { name: "b", now: clock });
    const a = await session(devices[0]!, mesh, relay, { name: "a", now: clock });
    await a.send("b@two", "the plan");
    // Recorded on the way (by the relay, its operator, or anyone who copied the frame).
    const recorded = sentFrames(relay).at(-1)!;
    await until(async () => (await b.spool.unread()).length === 1);
    const files = new MeshFiles(devices[1]!.home.meshDir(mesh), FS);
    const used = (recorded.boxes[devices[1]!.device.id] as PrekeyBox).p;
    expect(await fs.readFile(files.prekeysPath, "utf8")).toContain(used);
    // Daily housekeeping for six days on device two.
    for (let day = 1; day <= 6; day++) {
      now += LIMITS.prekeyRotateMs;
      await b.tick();
    }
    // The session's housekeeping deleted the secret on schedule (until + 72 hours).
    await until(async () => !(await fs.readFile(files.prekeysPath, "utf8")).includes(used), 3000, "the used secret deleted");
    const thief = new PrekeyStore({ path: files.prekeysPath, env: FS, device: devices[1]!.device, mesh, now: clock });
    await thief.reload();
    const me = { deviceId: devices[1]!.device.id, keys: devices[1]!.device.keys, address: "b@two", sid: b.sid, prekey: (id: string) => thief.secret(id) };
    expect(openMessage(recorded, { roster: b.roster, me, now, history: true })).toEqual({ ok: false, reason: "key_expired" });
  });
});

describe("revocation", () => {
  it("a revoked device's prekey is never sealed to", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    await session(devices[2]!, mesh, relay, { name: "c" });
    await a.send("*", "before");
    expect(Object.keys(sentFrames(relay).at(-1)!.boxes)).toContain(devices[2]!.device.id);
    await revokeDevice(a, "three", Date.now);
    await until(() => a.roster.revoked.includes(devices[2]!.device.id));
    await a.send("*", "after");
    expect(Object.keys(sentFrames(relay).at(-1)!.boxes)).not.toContain(devices[2]!.device.id);
  });
});
