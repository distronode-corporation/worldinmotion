import { b64u, nextRoster, makeDeviceRecord, generateDeviceKeys, sealMessage, ulid, type Roster, type SendFrame } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decideJoin, issueInvite, joinMesh, revokeDevice } from "../src/admin.ts";
import { MeshSession } from "../src/client.ts";
import { MeshFiles } from "../src/mesh.ts";
import type { SpoolItem } from "../src/spool.ts";
import { FS, makeMesh, newDevice, openSession, RELAY, RelayHarness, scratch, sleep, until, type TestDevice, keysOf } from "./helpers.ts";

const open: MeshSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

async function session(...args: Parameters<typeof openSession>): Promise<MeshSession> {
  const s = await openSession(...args);
  open.push(s);
  return s;
}

const unread = (s: MeshSession): Promise<SpoolItem[]> => s.spool.unread();

/** The send frames a session put on the wire, newest last. */
function sentFrames(relay: RelayHarness): SendFrame[] {
  return relay.sentByClients.map((t) => JSON.parse(t) as { t: string }).filter((f): f is SendFrame => f.t === "send");
}

async function setPolicy(d: TestDevice, mesh: string, device: string, level: "deliver" | "deliver-relayed" | "hold" | "refuse"): Promise<void> {
  await new MeshFiles(d.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, policy: { ...c.policy, [device]: level } }));
}

describe("receiving checks", () => {
  it("drops a replay, a tampered frame and a frame for another mesh", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    await a.send("b@two", "once");
    await until(async () => (await unread(b)).length === 1);
    const frame = sentFrames(relay).at(-1)!;
    expect(await b.receive(frame)).toBe("dropped");
    const box = Object.values(frame.boxes)[0]!;
    const bytes = b64u.decode(box.c);
    bytes[0] = bytes[0]! ^ 1;
    const tampered = { ...frame, boxes: Object.fromEntries(Object.keys(frame.boxes).map((k) => [k, { ...box, c: b64u.encode(bytes) }])) };
    expect(await b.receive(tampered)).toBe("dropped");
    expect(await b.receive({ ...frame, mesh: b64u.encode(new Uint8Array(16)) })).toBe("dropped");
    // The relay's own deliver path drops the replay too.
    relay.inject(mesh, JSON.stringify({ t: "deliver", cursor: 1, msg: frame }));
    await sleep(50);
    expect((await unread(b)).length).toBe(1);
  });

  it("drops a revoked sender, and a revoked device's own session is told", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"]);
    const admin = await session(devices[0]!, mesh, relay, { name: "admin" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const c = await session(devices[2]!, mesh, relay, { name: "c" });
    const fatal = new Promise<string>((resolve) => c.once("fatal", resolve));
    await c.send("b@two", "before");
    await until(async () => (await unread(b)).length === 1);
    const old = sentFrames(relay).at(-1)!;
    const later = sealMessage({ roster: c.roster, sender: { deviceId: c.device.id, keys: keysOf(c.device) }, session: "c", sid: c.sid, to: ["b@two"], seq: 99, at: Date.now(), text: "after", recipients: [b.device.id] });
    await revokeDevice(admin, "three", Date.now);
    expect(await fatal).toMatch(/revoked/);
    await until(() => b.roster.revoked.includes(c.device.id));
    expect(await b.receive(later)).toBe("dropped");
    expect(await b.receive(old)).toBe("dropped");
  });

  it("fetches a newer roster before trusting a sender added after its pin, or parks the message", { timeout: 20_000 }, async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const adminSession = await session(devices[0]!, mesh, relay, { name: "admin" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    // b misses roster pushes and, at first, roster pages too.
    let pagesAllowed = false;
    relay.toClient = (text) => (text.startsWith('{"t":"roster"') && !pagesAllowed ? undefined : text);
    const c = await newDevice("three");
    const inv = await issueInvite(adminSession, { ttlMs: 60_000, auto: true, now: Date.now });
    adminSession.once("join", (body) => void decideJoin(adminSession, body, async () => true, Date.now));
    // The joiner needs its roster frames; only b's are withheld.
    relay.toClient = (text, conn) => (text.startsWith('{"t":"roster"') && !pagesAllowed && conn === bConn() ? undefined : text);
    await joinMesh({ home: c.home, device: c.device, code: inv.code, dialer: relay.dialer, now: Date.now, showSas: () => undefined });
    await new MeshFiles(devices[1]!.home.meshDir(mesh), FS).updateConfig((x) => ({ ...x, policy: { ...x.policy, [c.device.id]: "deliver" } }));
    const cs = await session(c, mesh, relay, { name: "c" });
    expect(b.roster.devices.some((d) => d.id === c.device.id)).toBe(false);
    await cs.send("b@two", "parked first");
    await until(async () => (await fs.readdir(b.files.behindDir).catch(() => [])).length === 1, 5000, "parked");
    pagesAllowed = true;
    await cs.send("b@two", "fetched");
    await until(async () => (await unread(b)).length === 2, 5000, "both delivered");
    expect(await fs.readdir(b.files.behindDir)).toEqual([]);

    function bConn(): string {
      return [...relay.relays.get(mesh)!.states.entries()].find(([, st]) => st.sid === b.sid)?.[0] ?? "";
    }
  });

  it("treats two valid rosters for one seq as a fork: evidence, an alert, and no more trust in new devices", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const prev = (await new MeshFiles(devices[1]!.home.meshDir(mesh), FS).loadRoster(b.roster.seq - 1))!;
    const rival: Roster = nextRoster(prev, { add: [makeDeviceRecord("rival", generateDeviceKeys(), "member", Date.now())] }, { keys: keysOf(devices[0]!.device) }, Date.now());
    relay.inject(mesh, JSON.stringify({ t: "roster", chain: [rival], more: false }));
    await until(() => b.book.fork !== undefined, 3000, "fork");
    await until(async () => (await unread(b)).some((i) => i.kind === "notice" && i.rendered.includes("forked")));
    expect(relay.sentByClients.some((t) => t.startsWith('{"t":"roster.fork"'))).toBe(true);
    // A device added at or after the fork point is not trusted any more.
    expect(b.book.fork!.base).not.toContain(devices[1]!.device.id);
    // b's own device was added at the fork point: a sibling session of it is no longer trusted,
    // while a device from before the fork still is.
    const sibling = await session(devices[1]!, mesh, relay, { name: "sibling" });
    await sibling.send("b@two", "from after the fork");
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    await a.send("b@two", "from before the fork");
    await until(async () => (await unread(b)).filter((i) => i.kind === "msg").length === 1);
    await sleep(50);
    expect((await unread(b)).filter((i) => i.kind === "msg").map((i) => i.from)).toEqual(["a@one"]);
  });

  it("probes for a fork when a message names its roster seq with another hash", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const frame = sealMessage({ roster: { ...a.roster, at: a.roster.at + 1 }, sender: { deviceId: a.device.id, keys: keysOf(a.device) }, session: "a", sid: a.sid, to: ["b@two"], seq: 50, at: Date.now(), text: "x", recipients: [b.device.id] });
    expect(await b.receive(frame)).toBe("dropped");
    expect(b.book.fork).toBeUndefined();
  });
});

describe("inbound policy and the breaker", () => {
  it("holds a device the person has not trusted, then approves or refuses", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"], { trust: false });
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const first = await a.send("b@two", "please hold");
    await until(async () => (await b.held.list()).length === 1);
    await until(() => (a.receipts.get(first.id) ?? []).some((r) => r.status === "held"));
    await until(async () => (await unread(b)).some((i) => i.kind === "notice"));
    const notice = (await unread(b)).find((i) => i.kind === "notice")!;
    expect(notice.held).toBe(1);
    expect((await unread(b)).filter((i) => i.kind === "msg")).toEqual([]);
    await b.decide(first.id, "approve");
    expect((await unread(b)).some((i) => i.kind === "msg" && i.rendered.includes("please hold"))).toBe(true);
    const second = await a.send("b@two", "refuse me");
    await until(async () => (await b.held.list()).length === 1);
    await b.decide(second.id, "refuse");
    await until(() => (a.receipts.get(second.id) ?? []).some((r) => r.status === "refused"));
    await expect(b.decide(second.id, "approve")).rejects.toThrow(/no held message/);
    // A decision left by the CLI as a marker is applied on the next pass.
    const third = await a.send("b@two", "marker");
    await until(async () => (await b.held.list()).length === 1);
    await b.held.mark(third.id, "approve");
    await b.held.mark(ulid(), "approve");
    await until(async () => (await unread(b)).some((i) => i.rendered.includes("marker")));
  });

  it("refuses a refused device and holds a held file without fetching it until approved", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"], { trust: false });
    const a = await session(devices[0]!, mesh, relay, { name: "a", userHome: "/nonexistent-home" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    await setPolicy(devices[1]!, mesh, a.device.id, "refuse");
    const refused = await a.send("b@two", "no");
    await until(() => (a.receipts.get(refused.id) ?? []).some((r) => r.status === "refused"));
    await setPolicy(devices[1]!, mesh, a.device.id, "hold");
    const dir = await scratch("held-file");
    await fs.writeFile(join(dir, "f.txt"), "hello file");
    const sent = await a.sendFile("b@two", join(dir, "f.txt"));
    await until(async () => (await b.held.list()).length === 1);
    const getsBefore = relay.sentByClients.filter((t) => t.startsWith('{"t":"blob.get"')).length;
    expect(getsBefore).toBe(0);
    expect((await b.held.list())[0]!.preview).toBe("file f.txt");
    await b.decide(sent.id, "approve");
    const item = (await unread(b)).find((i) => i.kind === "file")!;
    expect(item.rendered).toContain("f.txt");
    expect(relay.sentByClients.some((t) => t.startsWith('{"t":"blob.get"'))).toBe(true);
  });

  it("holds relayed text from a plain deliver device and keeps relayed items readable after the cursor", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, { name: "bot" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    await a.send("b@two", "model output", { relayed: true });
    await until(async () => (await b.held.list()).length === 1);
    await setPolicy(devices[1]!, mesh, a.device.id, "deliver-relayed");
    await a.send("b@two", "more model output", { relayed: true });
    await until(async () => (await unread(b)).some((i) => i.relayed === true));
    const item = (await unread(b)).find((i) => i.relayed === true)!;
    expect(item.rendered).toMatch(/third party/);
    // The plugin passes it without starting a turn; it stays readable through inbox.
    await b.take(item.cursor);
    expect((await b.spool.relayed()).map((i) => i.id)).toEqual([item.id]);
    const got = await b.inbox(false);
    expect(got.some((i) => i.id === item.id && i.relayed === true)).toBe(true);
    expect(await b.spool.relayed()).toEqual([]);
    // Channel pushes skip relayed items, which wait in the inbox.
    const pushed: SpoolItem[] = [];
    b.push = async (i) => void pushed.push(i);
    await a.send("b@two", "plain");
    await a.send("b@two", "relayed again", { relayed: true });
    await until(() => pushed.length === 1);
    await until(async () => (await b.inbox(true)).some((i) => i.relayed === true));
    expect(pushed[0]!.rendered).toContain("plain");
  });

  it("pauses a peer past its limit, tells the person, and resumes on request", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await new MeshFiles(devices[1]!.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, breaker: { perPeerPerHour: 2, totalPerHour: 50, pingPong: true } }));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    for (const t of ["1", "2", "3", "4"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 2);
    const notices = (await unread(b)).filter((i) => i.kind === "notice");
    expect(notices.some((n) => n.rendered.includes("worldinmotion paused a@one: 2 messages in an hour"))).toBe(true);
    expect((await b.held.list()).every((h) => h.reason === "breaker")).toBe(true);
    expect(await b.resumePeer("x@unknown")).toBe(0);
    // The CLI leaves a resume marker; the session applies it.
    await fs.mkdir(b.files.controlDir, { recursive: true });
    await fs.writeFile(join(b.files.controlDir, "resume-a@one"), "");
    await fs.writeFile(join(b.files.controlDir, "junk"), "");
    await until(async () => (await unread(b)).filter((i) => i.kind === "msg").length === 4);
    expect(await b.held.list()).toEqual([]);
  });

  it("accepts a task's result only from its addressee", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const c = await session(devices[2]!, mesh, relay, { name: "c" });
    const asked = a.ask("b@two", "question", 400);
    await until(async () => (await unread(b)).some((i) => i.kind === "task"));
    const task = (await unread(b)).find((i) => i.kind === "task")!;
    // c answers a task it was never given.
    await c.send("a@one", "forged answer", { kind: "result", reply_to: task.id, status: "done" });
    const out = await asked;
    expect(out.pending).toBe(true);
    const item = (await unread(a)).find((i) => i.kind === "result")!;
    expect(item.rendered).toMatch(/unsolicited result/);
    // A room task may be answered by any member.
    await a.joinRoom("#r");
    await b.joinRoom("#r");
    await sleep(30);
    const roomTask = await a.send("#r", "anyone?", { kind: "task" });
    await b.send("a@one", "me", { kind: "result", reply_to: roomTask.id, status: "done" });
    await until(async () => (await unread(a)).filter((i) => i.kind === "result").length === 2);
    expect((await unread(a)).filter((i) => i.kind === "result")[1]!.rendered).not.toMatch(/unsolicited/);
    const all = await a.send("*", "everyone?", { kind: "task" });
    await c.send("a@one", "me too", { kind: "result", reply_to: all.id, status: "done" });
    await until(async () => (await unread(a)).filter((i) => i.kind === "result").length === 3);
    expect((await unread(a)).filter((i) => i.kind === "result")[2]!.rendered).not.toMatch(/unsolicited/);
  });
});

describe("peer cards", () => {
  it("shares cwd and branch, shows them to agents only for delivered devices, and to the pane always", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"]);
    await setPolicy(devices[1]!, mesh, devices[2]!.device.id, "hold");
    const work = await scratch("work");
    await fs.mkdir(join(work, ".git"));
    await fs.writeFile(join(work, ".git", "HEAD"), "ref: refs/heads/main\n");
    const a = await session(devices[0]!, mesh, relay, { name: "a", cwd: work });
    const c = await session(devices[2]!, mesh, relay, { name: "c", cwd: work });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    await until(async () => (await b.listPeers({ forPane: true })).filter((p) => p.card !== undefined).length === 2, 3000, "cards");
    const shown = await b.listPeers();
    expect(shown.find((p) => p.address === "a@one")!.card).toEqual({ cwd: basename(work), branch: "main" });
    expect(shown.find((p) => p.address === "c@three")!.card).toBeUndefined();
    expect(await b.route("a@one")).toEqual({ mesh: true, policy: "deliver" });
    expect(await b.route("c@three")).toEqual({ mesh: true, policy: "hold" });
    // device three is held, so a room is not all-deliver.
    expect(await b.route("#ops")).toEqual({ mesh: true, policy: "hold" });
    expect(await b.route("x@nowhere")).toEqual({ mesh: false, policy: null });
    expect(await b.route("teammate")).toEqual({ mesh: false, policy: null });
    void a;
    void c;
  });

  it("sends a card with no labels when the mesh turns cards off: only its prekey", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await new MeshFiles(devices[0]!.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, share_cards: false }));
    await session(devices[0]!, mesh, relay, { name: "a", cwd: "/" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    await until(() => relay.sentByClients.some((t) => t.startsWith('{"t":"card.set"') && t.includes(`"device":"${devices[0]!.device.id}"`)), 3000, "a's card");
    const card = JSON.parse(relay.sentByClients.find((t) => t.startsWith('{"t":"card.set"') && t.includes(`"session":"a"`))!) as { msg: SendFrame };
    expect(card.msg.pk?.device).toBe(devices[0]!.device.id);
    await sleep(30);
    expect((await b.listPeers({ forPane: true })).find((p) => p.address === "a@one")!.card).toBeUndefined();
    void RELAY;
  });
});
