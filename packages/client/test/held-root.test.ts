// Issue #159: held messages that piled up with no way out. A session holds its own device's
// relayed lines until the person trusts this device with --relayed (A); a trust change releases
// what was held under the old policy (C); held feed lines expire by themselves (expiry); and the
// person clears the rest in one command (D). Each test uses the real CLI and sessions.

import { ulid } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeshSession } from "../src/client.ts";
import { HeldBox, type HeldItem } from "../src/held.ts";
import { MeshFiles } from "../src/mesh.ts";
import { expireOffline } from "../src/offline.ts";
import { breakerOf, FS, makeMesh, openSession, RelayHarness, run, said, scratch, sessionOpts, sleep, term, until, type TestDevice } from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000 });

const HOUR = 3_600_000;

const open: MeshSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

async function session(d: TestDevice, mesh: string, relay: RelayHarness, extra: Parameters<typeof openSession>[3] = {}): Promise<MeshSession> {
  const s = await openSession(d, mesh, relay, extra);
  open.push(s);
  return s;
}

const filesOf = (d: TestDevice, mesh: string): MeshFiles => new MeshFiles(d.home.meshDir(mesh), FS);

async function setPolicy(d: TestDevice, mesh: string, device: string, level: "deliver" | "deliver-relayed" | "hold" | "refuse"): Promise<void> {
  await filesOf(d, mesh).updateConfig((c) => ({ ...c, policy: { ...c.policy, [device]: level } }));
}

/** A relayed feed line as a session would have held it, `at` when it was sent. */
function feedLine(from: string, device: string, at: number, text = `line ${at}`): HeldItem {
  const id = ulid();
  return { id, from, device, kind: "msg", at, preview: text, rendered: "", reason: "policy", entry: { dir: "in", peer: from, device, id, kind: "msg", at, text, relayed: true } };
}

const heldTexts = async (s: MeshSession): Promise<string[]> => (await s.held.list()).map((h) => h.entry.text).sort();
const unreadTexts = async (s: MeshSession): Promise<string[]> => (await s.spool.unread()).filter((i) => i.kind !== "notice").map((i) => i.rendered);

/**
 * Device one runs `wim ci` (session ci) and a hub session, both in #ci; device two runs a bot that
 * posts to #ci too. Every device trusts the others with plain `deliver` (makeMesh), so relayed
 * text is held everywhere.
 */
async function ciWorld(extra: Parameters<typeof openSession>[3] = {}) {
  const relay = new RelayHarness();
  const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
  const [one, two] = devices as [TestDevice, TestDevice];
  const hub = await session(one, mesh, relay, { name: "hub", ...extra });
  const ci = await session(one, mesh, relay, { name: "ci", kind: "ci" });
  const bot = await session(two, mesh, relay, { name: "bot", kind: "bot" });
  const mac = await session(two, mesh, relay, { name: "mac", ...extra });
  for (const s of [hub, ci, bot, mac]) await s.joinRoom("#ci");
  return { relay, mesh, one, two, hub, ci, bot, mac };
}

describe("A: this device's own relayed lines", () => {
  it("are held by default; trusting this device with --relayed delivers them, while another device's relayed lines stay held", async () => {
    const w = await ciWorld();
    await w.ci.send("#ci", "pipeline 1 running", { relayed: true });
    await w.bot.send("#ci", "bot says hi", { relayed: true });
    await until(async () => (await w.hub.held.list()).length === 2, 10_000, "two held at the hub");
    expect((await w.hub.held.list()).every((h) => h.reason === "policy")).toBe(true);

    // The list says why, and the one command that delivers it.
    const t = term(w.one.root, w.relay);
    expect(await run(t, "devices", "list")).toBe(0);
    expect(said(t)).toContain(`one  admin  ${w.one.device.id}  this device (relayed text held)`);
    t.out.length = 0;
    const id = (await w.hub.held.list()).find((h) => h.from === "ci@one")!.id;
    // Answering no changes nothing; the view says why it waits.
    t.answers.push("N");
    expect(await run(t, "held", "approve", id)).toBe(1);
    expect(said(t)).toContain("held     because it is relayed text, and its device's policy here is deliver, which holds relayed text (`wim devices trust one --relayed` delivers it)");

    t.out.length = 0;
    t.answers.push("y");
    expect(await run(t, "devices", "trust", "one", "--relayed")).toBe(0);
    const out = said(t);
    expect(out).toContain("Changing the inbound policy of this device itself:");
    expect(out).toContain(`  one  admin  id ${w.one.device.id}  policy deliver -> deliver-relayed`);
    expect(out).toContain("Its own sessions always deliver to each other. This decides only the text they relay");
    expect(out).toContain("With deliver-relayed, that text is delivered to the other sessions here, always as information only: it never assigns work and never starts a turn.");
    expect(out).toContain("1 message held from it now is then delivered too, by each session here as it runs (the breaker's hourly limits apply).");
    expect(out).toContain("Sessions on this device now deliver to each other the text they relay (wim ci, wim bot, wim a2a, a worker's room posts here), as information only.");

    // C: the hub releases its own device's line by itself; device two's stays held.
    await until(async () => (await w.hub.held.list()).length === 1, 10_000, "own line released");
    expect(await heldTexts(w.hub)).toEqual(["bot says hi"]);
    expect((await unreadTexts(w.hub)).some((r) => r.includes("pipeline 1 running"))).toBe(true);
    // A new own line is delivered at once; a new one from device two is still held.
    await w.ci.send("#ci", "pipeline 1 success", { relayed: true });
    await w.bot.send("#ci", "bot again", { relayed: true });
    await until(async () => (await unreadTexts(w.hub)).some((r) => r.includes("pipeline 1 success")), 10_000, "new own line");
    await until(async () => (await w.hub.held.list()).length === 2, 10_000, "bot line held");
    expect(await heldTexts(w.hub)).toEqual(["bot again", "bot says hi"]);

    t.out.length = 0;
    expect(await run(t, "devices", "list")).toBe(0);
    expect(said(t)).toContain("this device (relayed text delivered)");

    // Untrusting this device never holds its own sessions: only relayed text is held again.
    t.out.length = 0;
    t.answers.push("y");
    expect(await run(t, "devices", "untrust", "one")).toBe(0);
    expect(said(t)).toContain("policy deliver-relayed -> deliver");
    expect(said(t)).toContain("With deliver, that text is held for your approval, as from any device.");
    expect(said(t)).toContain("Sessions on this device deliver each other's own messages, as always; text they relay is held again.");
    expect((await filesOf(w.one, w.mesh).loadConfig()).policy[w.one.device.id]).toBe("deliver");
    await w.ci.send("#ci", "pipeline 2 running", { relayed: true });
    await until(async () => (await w.hub.held.list()).length === 3, 10_000, "own line held again");
  });
});

describe("C: a trust change releases what the old policy held", () => {
  it("on another device: trust --relayed delivers the lines already held, in every session there", async () => {
    const w = await ciWorld();
    await w.ci.send("#ci", "deploy us running", { relayed: true });
    await w.ci.send("#ci", "deploy us success", { relayed: true });
    await until(async () => (await w.mac.held.list()).length === 2, 10_000, "held on two");
    const t = term(w.two.root, w.relay);
    t.answers.push("y");
    expect(await run(t, "devices", "trust", "one", "--relayed")).toBe(0);
    expect(said(t)).toContain("2 messages held from it now are then delivered too");
    await until(async () => (await w.mac.held.list()).length === 0, 10_000, "released on two");
    const got = await unreadTexts(w.mac);
    expect(got.filter((r) => r.includes("deploy us")).length).toBe(2);
    // Framed as relayed, third-party text: information only.
    expect(got.every((r) => /third party/.test(r))).toBe(true);
  });

  it("with --all: counts what it delivers from all of them, and delivers it", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"], { trust: false });
    const [one, two, three] = devices as [TestDevice, TestDevice, TestDevice];
    const inbox = await session(two, mesh, relay, { name: "inbox" });
    const a = await session(one, mesh, relay, { name: "a" });
    const c = await session(three, mesh, relay, { name: "c" });
    await a.send("inbox@two", "from one");
    await c.send("inbox@two", "from three");
    await until(async () => (await inbox.held.list()).length === 2, 10_000, "two held");
    const t = term(two.root, relay);
    t.answers.push("y");
    expect(await run(t, "devices", "trust", "--all")).toBe(0);
    expect(said(t)).toContain("2 messages held from them now are then delivered too");
    await until(async () => (await inbox.held.list()).length === 0, 10_000, "released");
    expect((await unreadTexts(inbox)).length).toBe(2);
  });

  it("drops what a policy of refuse now refuses, and leaves a hold alone", async () => {
    const w = await ciWorld();
    await w.ci.send("#ci", "to be refused", { relayed: true });
    await until(async () => (await w.mac.held.list()).length === 1, 10_000, "held");
    // Hold changes nothing held.
    await setPolicy(w.two, w.mesh, w.one.device.id, "hold");
    await sleep(200);
    expect(await heldTexts(w.mac)).toEqual(["to be refused"]);
    await setPolicy(w.two, w.mesh, w.one.device.id, "refuse");
    await until(async () => (await w.mac.held.list()).length === 0, 10_000, "dropped");
    expect(await unreadTexts(w.mac)).toEqual([]);
  });

  it("releases what was held before this version ran, at a session's first pass, with no step by the person", async () => {
    // The device trusted the sender with --relayed already; its sessions held lines under the old client.
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const [one, two] = devices as [TestDevice, TestDevice];
    const before = await MeshSession.open(sessionOpts(two, mesh, relay, { name: "mac", sessionKey: "k" }));
    await before.stop();
    const now = Date.now();
    const lines = [feedLine("ci@one", one.device.id, now - 3 * HOUR), feedLine("ci@one", one.device.id, now - 2 * HOUR)];
    const box = new HeldBox(before.files.heldDir, FS);
    for (const l of lines) await box.add(l);
    await setPolicy(two, mesh, one.device.id, "deliver-relayed");
    const log: string[] = [];
    const after = await session(two, mesh, relay, { name: "mac", sessionKey: "k", log: (l) => void log.push(l) });
    expect(after.files.heldDir).toBe(before.files.heldDir);
    await until(() => log.some((l) => l.startsWith("wim: the policy now delivers")), 10_000, "released at start");
    expect(await after.held.list()).toEqual([]);
    expect((await after.spool.unread()).filter((i) => i.kind !== "notice").map((i) => i.id).sort()).toEqual(lines.map((l) => l.id).sort());
    expect(log).toContain("wim: the policy now delivers 2 and refuses 0 of what was held");
  });

  it("keeps to the breaker's hourly limits, and what they leave waits for a later review", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"]);
    const [one, two, three] = devices as [TestDevice, TestDevice, TestDevice];
    // Two a peer an hour, five in all.
    await filesOf(two, mesh).updateConfig((c) => ({ ...c, breaker: breakerOf({ perPeerPerHour: 2, totalPerHour: 5, pingPong: false, pingPongExchanges: 32 }) }));
    const before = await MeshSession.open(sessionOpts(two, mesh, relay, { name: "mac", sessionKey: "k" }));
    await before.stop();
    const box = new HeldBox(before.files.heldDir, FS);
    const now = Date.now();
    for (let i = 0; i < 3; i++) await box.add(feedLine("ci@one", one.device.id, now - (10 - i) * 60_000, `one ${i}`));
    for (let i = 0; i < 3; i++) await box.add(feedLine("ci@three", three.device.id, now - (5 - i) * 60_000, `three ${i}`));
    await setPolicy(two, mesh, one.device.id, "deliver-relayed");
    await setPolicy(two, mesh, three.device.id, "deliver-relayed");
    const log: string[] = [];
    const s = await session(two, mesh, relay, { name: "mac", sessionKey: "k", log: (l) => void log.push(l), heldReviewMs: 60 * 60_000 });
    await until(() => log.some((l) => l.startsWith("wim: the policy now delivers")), 10_000, "a review");
    // Two from each device: the per-peer limit leaves one of each.
    expect(log).toContain("wim: the policy now delivers 4 and refuses 0 of what was held; 2 more wait for the breaker's hourly limits");
    expect(await heldTexts(s)).toEqual(["one 2", "three 2"]);
  });

  it("stops at the hour's total, and passes over a device the breaker paused", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const [one, two] = devices as [TestDevice, TestDevice];
    await filesOf(two, mesh).updateConfig((c) => ({ ...c, breaker: breakerOf({ perPeerPerHour: 5, totalPerHour: 1, pingPong: false, pingPongExchanges: 32 }) }));
    const log: string[] = [];
    const a = await session(one, mesh, relay, { name: "a" });
    const s = await session(two, mesh, relay, { name: "mac", log: (l) => void log.push(l) });
    // Relayed text from a plain-deliver device: held by policy, never counted.
    await a.send("mac@two", "relayed 1", { relayed: true });
    await a.send("mac@two", "relayed 2", { relayed: true });
    await until(async () => (await s.held.list()).length === 2, 10_000, "two held");
    await setPolicy(two, mesh, one.device.id, "deliver-relayed");
    await until(() => log.some((l) => l.startsWith("wim: the policy now delivers")), 10_000, "a review");
    expect(log).toContain("wim: the policy now delivers 1 and refuses 0 of what was held; 1 more wait for the breaker's hourly limits");
    // The total is spent, so the next message trips the breaker: a pause on device one.
    await a.send("mac@two", "plain");
    await until(async () => (await s.held.list()).some((h) => h.reason === "breaker"), 10_000, "breaker hold");
    // A larger total now, but device one is paused: its policy hold still waits.
    log.length = 0;
    await filesOf(two, mesh).updateConfig((c) => ({ ...c, breaker: breakerOf({ perPeerPerHour: 5, totalPerHour: 50, pingPong: false, pingPongExchanges: 32 }), policy: { ...c.policy, "an-unrelated-device": "hold" } }));
    await until(() => log.some((l) => l.startsWith("wim: the policy now delivers")), 10_000, "a second review");
    expect(log).toContain("wim: the policy now delivers 0 and refuses 0 of what was held; 1 more wait for the breaker's hourly limits");
  });

  it("reads a mesh.json it cannot parse again on the next pass", async () => {
    const w = await ciWorld({ heldReviewMs: 50 });
    await w.ci.send("#ci", "later", { relayed: true });
    await until(async () => (await w.mac.held.list()).length === 1, 10_000, "held");
    const path = join(w.two.home.meshDir(w.mesh), "mesh.json");
    const good = await fs.readFile(path, "utf8");
    await fs.writeFile(path, "{ not json");
    await sleep(200);
    expect(await heldTexts(w.mac)).toEqual(["later"]);
    const parsed = JSON.parse(good) as { policy: Record<string, string> };
    await fs.writeFile(path, JSON.stringify({ ...parsed, policy: { ...parsed.policy, [w.one.device.id]: "deliver-relayed" } }));
    await until(async () => (await w.mac.held.list()).length === 0, 10_000, "released once readable");
  });
});

describe("expiry: held feed lines do not pile up", () => {
  it("drops this device's own lines older than the bound, and the superseded ones, at a session's first pass", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const [one] = devices as [TestDevice];
    const before = await MeshSession.open(sessionOpts(one, mesh, relay, { name: "hub", sessionKey: "k" }));
    await before.stop();
    const box = new HeldBox(before.files.heldDir, FS);
    const now = Date.now();
    // As on the device that ran wim ci: 11 lines from today, 3 from two days ago, 22 in a second feed.
    const today = Array.from({ length: 11 }, (_, i) => feedLine("ci@one", one.device.id, now - (60 - i) * 60_000));
    const stale = Array.from({ length: 3 }, (_, i) => feedLine("ci@one", one.device.id, now - (49 - i) * HOUR));
    const busy = Array.from({ length: 22 }, (_, i) => feedLine("ci2@one", one.device.id, now - (30 - i) * 60_000));
    // Not feed lines: a relayed reply and a task stay, however old.
    const reply = { ...feedLine("bot@one", one.device.id, now - 30 * HOUR), entry: { ...feedLine("bot@one", one.device.id, 0).entry, reply_to: ulid() } };
    const task = { ...feedLine("a2a@one", one.device.id, now - 30 * HOUR), kind: "task" as const };
    for (const l of [...today, ...stale, ...busy, reply, task]) await box.add(l);
    const log: string[] = [];
    const s = await session(one, mesh, relay, { name: "hub", sessionKey: "k", log: (l) => void log.push(l) });
    // The log line comes once the pass has dropped them all.
    await until(() => log.some((l) => l.includes("held feed lines expired")), 10_000, "expired at start");
    expect(await s.held.list()).toHaveLength(11 + 20 + 2);
    const left = new Set((await s.held.list()).map((h) => h.id));
    for (const l of [...today, ...busy.slice(2), reply, task]) expect(left.has(l.id)).toBe(true);
    expect(log.join("\n")).toContain("wim: 5 held feed lines expired (older than 24 hours, or more than 20 newer held from the same feed), never delivered");
  });

  it("expires a line in a running session once it grows too old, by the bound in mesh.json", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const [one] = devices as [TestDevice];
    await filesOf(one, mesh).updateConfig((c) => ({ ...c, heldFeeds: { maxAgeHours: 1, keep: 20 } }));
    const log: string[] = [];
    const s = await session(one, mesh, relay, { name: "hub", log: (l) => void log.push(l), heldReviewMs: 50 });
    // Held while the session runs; it turns an hour old a moment later.
    await s.held.add(feedLine("ci@one", one.device.id, Date.now() - HOUR + 300));
    await until(() => log.some((l) => l.includes("held feed line expired")), 10_000, "expired");
    expect(await s.held.list()).toEqual([]);
    expect(log.join("\n")).toContain("wim: 1 held feed line expired (older than 1 hour, or more than 20 newer held from the same feed), never delivered");
  });

  it("drops the expired lines of a session no process runs when the person lists what is held", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const [one] = devices as [TestDevice];
    const off = await MeshSession.open(sessionOpts(one, mesh, relay, { name: "gone" }));
    await off.stop();
    const box = new HeldBox(off.files.heldDir, FS);
    const now = Date.now();
    await box.add(feedLine("ci@one", one.device.id, now - 30 * HOUR));
    const t = term(one.root, relay);
    expect(await run(t, "held", "list")).toBe(0);
    expect(said(t)).toContain("Dropped 1 held feed line that expired (older than 24 hours, or more than 20 newer held from the same feed).");
    expect(said(t)).toContain("Nothing is held.");
    for (const at of [now - 30 * HOUR, now - 31 * HOUR, now - 1000]) await box.add(feedLine("ci@one", one.device.id, at));
    // A session another process runs is left to that process.
    const live = await session(one, mesh, relay, { name: "live", heldReviewMs: 60 * 60_000 });
    await sleep(100);
    await live.held.add(feedLine("ci@one", one.device.id, now - 30 * HOUR));
    t.out.length = 0;
    expect(await run(t, "held", "list")).toBe(0);
    expect(said(t)).toContain("Dropped 2 held feed lines that expired");
    expect(await live.held.list()).toHaveLength(1);
    expect(await expireOffline(filesOf(one, mesh), FS, now)).toBe(0);
  });
});

describe("D and item 1: clearing what is held at the person's terminal", () => {
  /** Device two holds what device one's ci session and its a session send; nobody runs it after. */
  async function heldWorld() {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"], { trust: false });
    const [one, two, three] = devices as [TestDevice, TestDevice, TestDevice];
    const inbox = await session(two, mesh, relay, { name: "inbox" });
    const ci = await session(one, mesh, relay, { name: "ci", kind: "ci" });
    const a = await session(one, mesh, relay, { name: "a" });
    const c = await session(three, mesh, relay, { name: "c" });
    const fromCi = [await ci.send("inbox@two", "ci 1", { relayed: true }), await ci.send("inbox@two", "ci 2", { relayed: true }), await ci.send("inbox@two", "ci 3", { relayed: true })].map((m) => m.id);
    const fromA = (await a.send("inbox@two", "from a")).id;
    const fromC = (await c.send("inbox@two", "from c")).id;
    await until(async () => (await inbox.held.list()).length === 5, 10_000, "five held");
    await inbox.stop();
    const box = new HeldBox(inbox.files.heldDir, FS);
    return { relay, mesh, one, two, three, box, fromCi, fromA, fromC, t: term(two.root, relay) };
  }

  it("a shell loop of `wim held refuse <id>` works: a yes is asked again, `all` takes the set, and the ids after it are done already", async () => {
    const w = await heldWorld();
    // The loop: for id in $(wim held list | awk '$2=="ci@one"{print $1}'); do wim held refuse "$id"; done
    expect(await run(w.t, "held", "list")).toBe(0);
    const ids = w.t.out.filter((l) => l.split(/\s+/)[2] === "ci@one").map((l) => l.trim().split(/\s+/)[0]!);
    expect(ids).toEqual(w.fromCi);
    w.t.out.length = 0;
    w.t.answers.push("y", "all");
    expect(await run(w.t, "held", "refuse", ids[0]!)).toBe(0);
    expect(said(w.t)).toContain(`y is not an answer to a set. Type all to refuse all 4, or one to refuse only ${ids[0]} [all/one/N] `);
    expect(said(w.t)).toContain(`Refused 4 held from device one (device id ${w.one.device.id}): `);
    for (const id of ids.slice(1)) {
      w.t.out.length = 0;
      expect(await run(w.t, "held", "refuse", id)).toBe(0);
      expect(said(w.t)).toContain(`${id} is not held here now (decided already, perhaps with the rest of its set, or expired): nothing to refuse.`);
    }
    expect((await w.box.list()).map((h) => h.id)).toEqual([w.fromC]);
    // Approving what is not held is still an error, and so is refusing what is not an id at all.
    expect(await run(w.t, "held", "approve", ids[1]!)).toBe(1);
    expect(w.t.err.join("\n")).toContain(`no held message ${ids[1]}`);
    expect(await run(w.t, "held", "refuse", "not-an-id")).toBe(1);
    expect(w.t.err.join("\n")).toContain("no held message not-an-id");
  });

  it("piped input is still refused, before anything changes: the guard is on standard input and output of wim itself", async () => {
    const w = await heldWorld();
    const piped = term(w.two.root, w.relay, { inputIsTTY: false });
    expect(await run(piped, "held", "refuse", w.fromCi[0]!)).toBe(1);
    expect(said(piped)).toContain("this command's input is not an interactive terminal (it is piped or redirected)");
    const redirected = term(w.two.root, w.relay, { isTTY: false });
    expect(await run(redirected, "held", "refuse", "--from", "ci@one")).toBe(1);
    expect(said(redirected)).toContain("this command's output is not an interactive terminal");
    // An agent's shell: refused, whatever the terminal.
    const agent = term(w.two.root, w.relay, {}, { CLAUDECODE: "1" });
    expect(await run(agent, "held", "refuse", "--all")).toBe(1);
    expect(said(agent)).toContain("CLAUDECODE is set: this shell belongs to Claude Code");
    expect(await w.box.list()).toHaveLength(5);
  });

  it("--from <session@device> shows the set and decides exactly that session's items on one typed yes", async () => {
    const w = await heldWorld();
    w.t.answers.push("n");
    expect(await run(w.t, "held", "refuse", "--from", "ci@one")).toBe(1);
    expect(w.t.err).toContain("wim: nothing changed.");
    w.t.out.length = 0;
    w.t.answers.push("y");
    expect(await run(w.t, "held", "refuse", "--from", "ci@one")).toBe(0);
    const out = said(w.t);
    // Device one's whole set is shown; only ci@one's three are decided.
    expect(out).toContain(`Held from device one (device id ${w.one.device.id}): 4 messages, from `);
    expect(out).toContain("Refuse 3 of the 4 shown (those from ci@one), in 1 set? (they are dropped, never delivered) [y/N] ");
    expect(out).toContain("Refused 3 held from ci@one.");
    expect(out).toContain("Anything held after this list was drawn stays held: wim held list shows it.");
    expect((await w.box.list()).map((h) => h.id).sort()).toEqual([w.fromA, w.fromC].sort());
    // Nothing left from it; an unknown device is refused, never "nothing held".
    w.t.out.length = 0;
    expect(await run(w.t, "held", "refuse", "--from", "ci@one")).toBe(0);
    expect(said(w.t)).toContain("Nothing is held from ci@one.");
    expect(await run(w.t, "held", "refuse", "--from", "ci@nowhere")).toBe(1);
    expect(w.t.err.join("\n")).toContain("no device named nowhere in this mesh (wim devices list)");
  });

  it("--from <device> takes every session on it, --all everything, and approve delivers them", async () => {
    const w = await heldWorld();
    w.t.answers.push("y");
    expect(await run(w.t, "held", "approve", "--from", "one")).toBe(0);
    expect(said(w.t)).toContain("Approve all 4 held from one, in 1 set? (they are delivered) [y/N] ");
    expect(said(w.t)).toContain("Approved 4 held from one.");
    expect((await w.box.list()).map((h) => h.id)).toEqual([w.fromC]);
    w.t.out.length = 0;
    w.t.answers.push("y");
    expect(await run(w.t, "held", "refuse", "--all")).toBe(0);
    expect(said(w.t)).toContain("Refuse all 1 held, in 1 set? (they are dropped, never delivered) [y/N] ");
    expect(await w.box.list()).toEqual([]);
    w.t.out.length = 0;
    expect(await run(w.t, "held", "approve", "--all")).toBe(0);
    expect(said(w.t)).toContain("Nothing is held.");
  });

  it("says what was decided elsewhere meanwhile, and that a breaker's pause stays after approving", async () => {
    const w = await heldWorld();
    // As the loop breaker would have held device three's.
    await w.box.add({ ...(await w.box.get(w.fromC))!, reason: "breaker" });
    w.t.answers.push(async () => (await w.box.remove(w.fromA), "y"));
    expect(await run(w.t, "held", "approve", "--all")).toBe(0);
    const out = said(w.t);
    expect(out).toContain("Approve all 5 held, in 2 sets? (they are delivered) [y/N] ");
    expect(out).toContain("Approved 4 held.");
    expect(out).toContain("1 of the 5 shown had been decided elsewhere meanwhile.");
    expect(out).toContain("The breaker still pauses what it paused: `wim held resume c@three` lifts it (wim held list shows each pause).");
  });

  it("refuses its usage mistakes before deciding anything", async () => {
    const w = await heldWorld();
    for (const argv of [
      ["held", "list", "--all"],
      ["held", "resume", "--from", "one"],
      ["held", "refuse", w.fromA, "--all"],
      ["held", "refuse", "--from", "one", "--all"],
    ]) {
      w.t.err.length = 0;
      expect(await run(w.t, ...argv)).toBe(1);
      expect(w.t.err.join("\n")).toMatch(/usage: wim held/);
    }
    expect(await run(w.t, "held", "refuse", "--from")).toBe(2);
    expect(w.t.err.join("\n")).toContain("--from needs a value");
    expect(await w.box.list()).toHaveLength(5);
  });
});

describe("D with CI notices", () => {
  it("--all approves CI notices except those that pin ids, which it names; none approvable decides nothing", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const [one] = devices as [TestDevice];
    const s = await MeshSession.open(sessionOpts(one, mesh, relay, { name: "agent" }));
    await s.stop();
    const box = new HeldBox(s.files.heldDir, FS);
    const rule = ulid();
    const notice = (pins?: Record<string, string>): HeldItem => {
      const id = ulid();
      const entry = { dir: "in" as const, peer: "ci:github:o/r", id, kind: "msg" as const, at: 1, text: "n", relayed: true as const, ci: { via: "github" as const, repo: "o/r", ref: "refs/heads/main" } };
      return { id, from: "ci:github:o/r", device: "", kind: "msg", at: 1, preview: "n", rendered: "framed", reason: "policy", entry, ci: { rule, ...(pins === undefined ? {} : { pins }) } };
    };
    const pinning = notice({ repositoryId: "7", ownerId: "8" });
    await box.add(pinning);
    const t = term(one.root, relay);
    expect(await run(t, "held", "approve", "--all")).toBe(1);
    expect(said(t)).toContain(`Not in this approval: ${pinning.id} pins its rule's ids, so it is approved only on its own: wim held approve ${pinning.id}`);
    const plain = notice();
    await box.add(plain);
    t.out.length = 0;
    t.answers.push("y");
    expect(await run(t, "held", "approve", "--all")).toBe(0);
    expect(said(t)).toContain("Approve 1 of the 2 shown, in 2 sets? (they are delivered) [y/N] ");
    expect((await box.list()).map((h) => h.id)).toEqual([pinning.id]);
    // --from names a device: CI notices come from none.
    t.out.length = 0;
    expect(await run(t, "held", "refuse", "--from", "one")).toBe(0);
    expect(said(t)).toContain("Nothing is held from one.");
  });
});

describe("B: wim ci says at start who would hold its lines", () => {
  it("names the room's members on this device and on others, with each device's command", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const [one, two] = devices as [TestDevice, TestDevice];
    const hub = await session(one, mesh, relay, { name: "hub" });
    const mac = await session(two, mesh, relay, { name: "mac" });
    await hub.joinRoom("#ci");
    await mac.joinRoom("#ci");
    const dir = await scratch("ci-warn");
    await fs.writeFile(join(dir, "ci.json"), JSON.stringify({ statePath: join(dir, "state.json"), sources: [{ type: "github", owner: "o", repo: "r", room: "#ci" }] }));
    const t = term(one.root, relay, { fetch: (async () => new Response("[]", { status: 200 })) as typeof fetch });
    const ciRun = run(t, "ci", join(dir, "ci.json"));
    await until(() => t.out.some((l) => l.startsWith("ci running")), 10_000, "ci running");
    await until(() => t.err.some((l) => l.startsWith("Lines held anyway expire")), 10_000, "the warning");
    t.stop.abort();
    expect(await ciRun).toBe(0);
    expect(t.err).toContain("  #ci: hub@one (this device) holds them. Here, run: wim devices trust one --relayed");
    expect(t.err).toContain("  #ci: mac@two holds them unless two trusts one with --relayed. On two, run: wim devices trust one --relayed");
  });

  it("keeps running when the relay does not answer the peer list, and says so", async () => {
    const relay = new RelayHarness();
    const { devices } = await makeMesh(relay, ["one"]);
    const [one] = devices as [TestDevice];
    // The relay never sees the peer list request, so it times out.
    relay.toRelay = (text) => (text.startsWith('{"t":"peers"') ? undefined : text);
    const dir = await scratch("ci-warn-down");
    await fs.writeFile(join(dir, "ci.json"), JSON.stringify({ statePath: join(dir, "state.json"), sources: [{ type: "github", owner: "o", repo: "r", room: "#ci" }] }));
    const t = term(one.root, relay, { fetch: (async () => new Response("[]", { status: 200 })) as typeof fetch });
    const ciRun = run(t, "ci", join(dir, "ci.json"));
    await until(() => t.err.some((l) => l.startsWith("wim: warning: could not list the rooms' members")), 25_000, "the fallback warning");
    expect(t.err.some((l) => l.startsWith("Lines held anyway expire"))).toBe(false);
    t.stop.abort();
    expect(await ciRun).toBe(0);
  }, 40_000);
});
