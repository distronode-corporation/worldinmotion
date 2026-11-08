import { b64u, nextRoster, makeDeviceRecord, generateDeviceKeys, sealMessage, ulid, type Roster, type SendFrame } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decideJoin, issueInvite, joinMesh, revokeDevice } from "../src/admin.ts";
import { clock } from "../src/breaker.ts";
import { heldSendLine, MeshSession, type HeldBreaker } from "../src/client.ts";
import { DEFAULT_BREAKER, MeshFiles } from "../src/mesh.ts";
import type { SpoolItem } from "../src/spool.ts";
import { FS, makeMesh, newDevice, openSession, RELAY, RelayHarness, scratch, sleep, spooled, until, type TestDevice, keysOf } from "./helpers.ts";

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

  it("spools every client notice quiet: none is pushed, and only the agent's wait in the box for inbox", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const b = await session(devices[0]!, mesh, relay, { name: "b" });
    const pushed: SpoolItem[] = [];
    b.push = async (i) => void pushed.push(i);
    await b.notice("x@one", "for the agent");
    await b.notice("x@one", "2 held for the person", 2);
    await b.notice("x@one", "x@one is holding your message", undefined, "x@one");
    await b.notice("x@one", "restart this session", undefined, undefined, true);
    const items = await unread(b);
    expect(items.map((i) => i.quiet)).toEqual([true, true, true, true]);
    expect(items.every((i) => i.watched === undefined)).toBe(true);
    expect(pushed).toEqual([]);
    await b.take(items.at(-1)!.cursor);
    expect((await b.spool.relayed()).map((i) => i.rendered)).toEqual([items[0]!.rendered]);
  });

  it("pauses a peer past its limit, tells the person and the sender, and resumes on request", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    // A mesh made now, on the device that created it and on one that joined, holds the defaults.
    for (const d of devices) expect((await new MeshFiles(d.home.meshDir(mesh), FS).loadConfig()).breaker).toEqual(DEFAULT_BREAKER);
    // Device one is trusted on two: 2 an hour, then a long cool-down.
    const limits = { perPeerPerHour: 2, totalPerHour: 50, pingPong: true, pingPongExchanges: 32, cooldownMinutes: 60 };
    await new MeshFiles(devices[1]!.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, breaker: limits }));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    for (const t of ["1", "2", "3", "4"]) expect((await a.send("b@two", t)).results).toEqual([{ to: "b@two", status: "routed" }]);
    await until(async () => (await b.held.list()).length === 2);
    const until1 = (await b.held.list())[0]!.pause!.until;
    const end = clock(until1);
    const notices = (await unread(b)).filter((i) => i.kind === "notice");
    expect(
      notices.some((n) =>
        n.rendered.includes(
          `worldinmotion paused a@one: the per-peer limit: 3 messages from a@one in 60 minutes, limit 2; until ${end}, when the client releases it and delivers up to its per-peer limit of what it held (a trusted device's cool-down). /wim to approve, or to approve and resume it now`,
        ),
      ),
    ).toBe(true);
    expect((await b.held.list()).every((h) => h.reason === "breaker" && h.pause?.rule === "peer" && h.pause.auto)).toBe(true);
    // The session itself is told once per pause, in a notice that reaches the agent (no `held`
    // count, which the plugin shows only as a toast), with what only the person can run (issue #40).
    const forAgent = notices.filter((n) => n.held === undefined && n.heldBy === undefined && n.forPerson === undefined);
    expect(forAgent).toHaveLength(1);
    expect(forAgent[0]!.rendered).toBe(
      `worldinmotion notice (from the local client, not from a peer or the person): this device's loop breaker paused a@one (the per-peer limit: 3 messages from a@one in 60 minutes, limit 2): its messages to this session are held from now on, not delivered to you, until the cool-down ends or your person releases them. Only the person can release them early: \`wim held resume a@one\` in a terminal they opened themselves, or Approve in /wim (Claude Code) or the Held view (VS Code). The client releases a@one by itself at ${end} and delivers up to its per-peer limit of what it held then; the rest waits for your person, who can release it earlier. If you are waiting on a@one, tell your person; it has not gone silent.`,
    );
    // Where \`wim held list\` reads it.
    expect(JSON.parse(await fs.readFile(b.files.breakerPath, "utf8"))).toMatchObject({ pauses: [expect.objectContaining({ from: "a@one", peer: devices[0]!.device.id, rule: "peer", count: 3, limit: 2, until: until1, auto: true })] });
    expect(b.pausedRows()).toEqual([expect.objectContaining({ from: "a@one", rule: "peer" })]);

    // The sender heard it once (one \`pause\` for the two held), and its sends to b now say held.
    const told = await spooled(a, (i) => i.kind === "notice" && i.rendered.includes("loop breaker paused messages from this device"));
    expect(told.rendered).toContain(`b@two's loop breaker paused messages from this device (the per-peer limit: 3 messages from this device in 60 minutes, limit 2): what this device sends there is held, not delivered, until its client releases them by itself at ${end}, delivering up to its per-peer limit of what it held (the rest waits for its person)`);
    expect(sentFrames(relay).filter((f) => f.from.session === "b")).toHaveLength(1);
    const held = await a.send("b@two", "5");
    expect(held.results).toEqual([{ to: "b@two", status: "held", relay: "routed", breaker: { rule: "peer", count: 3, limit: 2, minutes: 60, until: until1, auto: true } }]);
    expect(heldSendLine("b@two", (held.results[0] as { breaker: HeldBreaker }).breaker)).toBe(
      `b@two: held there, not delivered: its loop breaker paused this device on the per-peer limit: 3 messages from this device in 60 minutes, limit 2; at ${end} its client delivers by itself up to its per-peer limit of what it held, and the rest waits for its person. Sending more now only adds to what it holds.`,
    );
    // Paused for the hour instead, the line says the person decides.
    expect(heldSendLine("b@two", { rule: "total", count: 51, limit: 50, minutes: 60, until: 0, auto: false })).toBe(
      "b@two: held there, not delivered: its loop breaker paused this device on the total limit: 51 messages from all peers in 60 minutes, limit 50; what it holds waits for its person (the pause itself lifts at 1970-01-01T00:00:00Z). Sending more now only adds to what it holds.",
    );
    // Another session of the same device reads the same device-wide record.
    const a2 = await session(devices[0]!, mesh, relay, { name: "a2" });
    expect((await a2.send("b@two", "6")).results[0]!.status).toBe("held");
    await until(async () => (await b.held.list()).length === 4);
    // a2 sent during the pause, so it is told too, once.
    await spooled(a2, (i) => i.kind === "notice" && i.rendered.includes("loop breaker paused messages from this device"));

    expect(await b.resumePeer("x@unknown")).toBe(0);
    // The CLI leaves a resume marker; the session applies it.
    await fs.mkdir(b.files.controlDir, { recursive: true });
    await fs.writeFile(join(b.files.controlDir, "resume-a@one"), "");
    await fs.writeFile(join(b.files.controlDir, "junk"), "");
    await until(async () => (await unread(b)).filter((i) => i.kind === "msg").length === 6 && (await b.held.list()).length === 0);
    expect(JSON.parse(await fs.readFile(b.files.breakerPath, "utf8"))).toMatchObject({ pauses: [] });
    // Both told sessions hear it lifted, and the device's sends there are routed again.
    await until(async () => Object.keys(await a.pausedBy.active()).length === 0);
    expect((await a.send("b@two", "7")).results).toEqual([{ to: "b@two", status: "routed" }]);
  });

  it("accepts a task's result only from its addressee", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const c = await session(devices[2]!, mesh, relay, { name: "c" });
    // In order, with no clock between them: c's forged result lands while a is still waiting,
    // and only then does b answer. (A 400 ms ask once gave up before the forged result landed on
    // a slow runner, and the spool was read before it was there.) The ask's own timeout is
    // longer than the test's, so it never ends the wait.
    const asked = a.ask("b@two", "question", 60_000);
    let settled = false;
    void asked.then(() => (settled = true), () => (settled = true));
    const task = await spooled(b, (i) => i.kind === "task");
    // c answers a task it was never given: it goes to a's spool as unsolicited, and the ask waits on.
    const forged = spooled(a, (i) => i.kind === "result");
    await c.send("a@one", "forged answer", { kind: "result", reply_to: task.id, status: "done" });
    const item = await forged;
    expect(item.rendered).toMatch(/unsolicited result/);
    expect(item.rendered).toContain("forged answer");
    expect(settled).toBe(false);
    // The addressee's answer is the one the ask returns, and it is not spooled.
    await b.send("a@one", "real answer", { kind: "result", reply_to: task.id, status: "done" });
    const out = await asked;
    expect(out.pending).toBeUndefined();
    expect(out.result).toMatchObject({ from: "b@two", device: devices[1]!.device.id, text: "real answer", status: "done" });
    expect((await unread(a)).filter((i) => i.kind === "result")).toHaveLength(1);
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
