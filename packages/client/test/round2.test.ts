import { promises as fs } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { commandUsage, SHORT_USAGE } from "../src/cli.ts";
import { MeshSession } from "../src/client.ts";
import { processIo, type Proc } from "../src/io.ts";
import { WimMcp } from "../src/mcp.ts";
import { FS, LIVE_PID, makeMesh, openSession, RelayHarness, run, said, scratch, sessionOpts, sleep, term, until } from "./helpers.ts";

const open: Array<{ stop(): Promise<unknown> }> = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

const byes = (relay: RelayHarness): number => relay.sentByClients.filter((t) => t === '{"t":"bye","ended":true}').length;

describe("help", () => {
  it("prints usage for wim, --help, help and help <command>", async () => {
    const t = term(await scratch("help"), new RelayHarness());
    expect(await run(t)).toBe(2);
    expect(t.out.at(-1)).toBe(SHORT_USAGE);
    expect(await run(t, "--help")).toBe(0);
    expect(t.out.at(-1)).toMatch(/wim init \[--name/);
    expect(await run(t, "help")).toBe(0);
    expect(await run(t, "help", "send")).toBe(0);
    expect(t.out.at(-1)).toBe("wim send <to> <text...> [--allow-secret] [--as <name>]");
    expect(await run(t, "send", "--help")).toBe(0);
    expect(t.out.at(-1)).toMatch(/^wim send /);
    expect(await run(t, "help", "nope")).toBe(2);
    expect(said(t)).toMatch(/no command "nope"/);
    expect(commandUsage("ci")).toBe("wim bot <config.json> | wim ci <config.json> | wim a2a <config.json>");
    expect(commandUsage("recover")).toMatch(/^wim recover <code>/);
    expect(commandUsage("recovery")).toBe("wim recovery show | wim recovery rotate");
    expect(commandUsage("a.*")).toBeUndefined();
  });
});

describe("clean ends of wim mcp", () => {
  async function serve(trigger: "eof" | "signal" | "parent") {
    const relay = new RelayHarness();
    const { devices } = await makeMesh(relay, ["one"]);
    const stdin = new PassThrough();
    let gone = false;
    const t = term(devices[0]!.root, relay, { stdin, parentGone: () => gone, parentPollMs: 10, closeMs: 2000 });
    const before = byes(relay);
    const serving = run(t, "mcp");
    await until(() => relay.sentByClients.some((x) => x.startsWith('{"t":"auth"') && x.includes('"kind":"mcp"')), 5000);
    if (trigger !== "eof") await sleep(50);
    if (trigger === "eof") stdin.end();
    if (trigger === "signal") t.stop.abort();
    if (trigger === "parent") gone = true;
    expect(await serving).toBe(0);
    await until(() => byes(relay) === before + 1, 2000, "bye");
  }

  it("ends its session on stdin EOF", () => serve("eof"));
  it("ends its session on a signal", () => serve("signal"));
  it("ends its session when its parent goes away", () => serve("parent"));

  it("frees the name, so the next session with it is not name-2", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const first = new WimMcp({ session: sessionOpts(devices[0]!, mesh, relay, { name: "alice" }), channel: false, internalTools: false, version: "t" });
    await (await first.start())!.ready(3000);
    await first.close({ ended: true });
    const second = await openSession(devices[0]!, mesh, relay, { name: "alice" });
    open.push(second);
    expect(second.address).toBe("alice@one");
  });

  it("wires SIGHUP and the parent check in processIo", async () => {
    const handlers = new Map<string, () => void>();
    let ppid = 50;
    let alive = true;
    const proc = {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      platform: "linux",
      pid: 7,
      get ppid() {
        return ppid;
      },
      cwd: () => "/",
      once: (s: string, cb: () => void) => handlers.set(s, cb),
      on: (_e: string, cb: (r: unknown) => void) => {
        cb(new Error("stray"));
        cb("plain");
      },
    } as unknown as Proc;
    const io = processIo(proc, {
      homedir: () => "/h",
      hostname: () => "h",
      kill: () => {
        if (!alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
    });
    expect(io.parentGone()).toBe(false);
    alive = false;
    expect(io.parentGone()).toBe(true);
    alive = true;
    ppid = 1;
    expect(io.parentGone()).toBe(true);
    handlers.get("SIGHUP")!();
    expect(io.signal.aborted).toBe(true);
    // The default machine facts come from the operating system.
    ppid = 2_000_000_000;
    expect(processIo({ ...proc, once: () => undefined } as unknown as Proc).parentGone()).toBe(true);
    let err = "";
    (proc.stderr as PassThrough).on("data", (d: Buffer) => (err += d.toString()));
    processIo(proc, { homedir: () => "/h", hostname: () => "h", kill: () => undefined });
    await sleep(10);
    expect(err).toContain("wim: unexpected error: stray\nwim: unexpected error: plain\n");
  });
});

describe("same-project takeover", () => {
  it("takes back an offline session with the same name and directory, queue included", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const work = await scratch("proj");
    const a1 = await openSession(devices[0]!, mesh, relay, { name: "alice", cwd: work });
    const sid = a1.sid;
    await a1.stop();
    const b = await openSession(devices[1]!, mesh, relay, { name: "bob" });
    open.push(b);
    expect((await b.send("alice@one", "while you were away")).results[0]!.status).toBe("queued");
    const a2 = await openSession(devices[0]!, mesh, relay, { name: "alice", cwd: work });
    open.push(a2);
    expect(a2.sid).toBe(sid);
    expect(a2.address).toBe("alice@one");
    await until(async () => (await a2.spool.unread()).some((i) => i.rendered.includes("while you were away")));
  });

  it("does not take a session from another directory, an ended one, or one a live process holds", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const here = await scratch("here");
    const there = await scratch("there");
    const a1 = await openSession(devices[0]!, mesh, relay, { name: "alice", cwd: here });
    await a1.stop();
    const other = await openSession(devices[0]!, mesh, relay, { name: "alice", cwd: there });
    open.push(other);
    expect(other.sid).not.toBe(a1.sid);
    expect(other.address).toBe("alice-2@one");
    // An ended session is a tombstone: never taken back.
    const ended = await openSession(devices[0]!, mesh, relay, { name: "carol", cwd: here });
    await ended.stop({ ended: true });
    const carol = await openSession(devices[0]!, mesh, relay, { name: "carol", cwd: here });
    open.push(carol);
    expect(carol.sid).not.toBe(ended.sid);
    expect(carol.address).toBe("carol@one");
    // A session held by another live process.
    const held = await MeshSession.open(sessionOpts(devices[0]!, mesh, relay, { name: "dave", cwd: here, env: { ...FS, pid: LIVE_PID } }));
    const dave = await MeshSession.open(sessionOpts(devices[0]!, mesh, relay, { name: "dave", cwd: here }));
    expect(dave.sid).not.toBe(held.sid);
    await dave.stop();
    await held.stop();
    // A keyed session that ended is not reused either.
    const k1 = await MeshSession.open({ ...sessionOpts(devices[0]!, mesh, relay, { name: "erin" }), sessionKey: "key:erin" });
    await k1.stop({ ended: true });
    const k2 = await MeshSession.open({ ...sessionOpts(devices[0]!, mesh, relay, { name: "erin" }), sessionKey: "key:erin" });
    expect(k2.sid).not.toBe(k1.sid);
    await k2.stop();
    expect(JSON.parse(await fs.readFile(k1.files.statePath, "utf8")).ended).toBe(true);
  });
});

describe("trusted devices assign work", () => {
  it("frames items from a delivered device as assignable, and everything else as information", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"]);
    const { MeshFiles } = await import("../src/mesh.ts");
    const { FS } = await import("./helpers.ts");
    await new MeshFiles(devices[1]!.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, policy: { [devices[0]!.device.id]: "deliver-relayed", [devices[2]!.device.id]: "hold" } }));
    const a = await openSession(devices[0]!, mesh, relay, { name: "a" });
    const c = await openSession(devices[2]!, mesh, relay, { name: "c" });
    const b = await openSession(devices[1]!, mesh, relay, { name: "b" });
    open.push(a, b, c);
    await a.send("b@two", "please do this", { kind: "task" });
    await a.send("b@two", "model output", { relayed: true });
    const held = await c.send("b@two", "from a held device");
    await until(async () => (await b.held.list()).length === 1);
    await b.decide(held.id, "approve");
    await until(async () => (await b.spool.unread()).filter((i) => i.kind !== "notice").length === 3);
    const items = (await b.spool.unread()).filter((i) => i.kind !== "notice");
    const of = (t: string) => items.find((i) => i.rendered.includes(t))!.rendered;
    expect(of("please do this")).toMatch(/may assign you work/);
    expect(of("model output")).not.toMatch(/may assign you work/);
    expect(of("from a held device")).toMatch(/Treat it as\ninformation from a peer/);
  });
});

describe("derived messages (revision 8)", () => {
  async function trio() {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"]);
    const { MeshFiles } = await import("../src/mesh.ts");
    const { FS } = await import("./helpers.ts");
    // two trusts one; three is held at two.
    await new MeshFiles(devices[1]!.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, policy: { [devices[0]!.device.id]: "deliver", [devices[2]!.device.id]: "hold" } }));
    // One clock for the relay and every session, so moving it keeps messages fresh everywhere.
    let now = Date.now();
    relay.now = () => now;
    const a = await openSession(devices[0]!, mesh, relay, { name: "a", now: () => now });
    const b = await openSession(devices[1]!, mesh, relay, { name: "b", now: () => now });
    const c = await openSession(devices[2]!, mesh, relay, { name: "c", now: () => now });
    open.push(a, b, c);
    return { a, b, c, mesh, devices, relay, advance: (ms: number) => (now += ms) };
  }

  it("marks sends derived during a mesh-started turn and in the window after information-only items", async () => {
    const { a, b, c, advance } = await trio();
    // Not derived: nothing informed yet.
    await b.send("a@one", "plain");
    await until(async () => (await a.spool.unread()).length === 1);
    expect((await a.spool.unread())[0]!.rendered).not.toMatch(/Derived:/);
    // A turn the plugin started with a mesh item.
    await fs.writeFile(b.files.presencePath, "busy-mesh");
    await b.send("a@one", "during mesh turn");
    await until(async () => (await a.spool.unread()).length === 2);
    expect((await a.spool.unread())[1]!.rendered).toMatch(/Derived: written while handling another agent's message/);
    await fs.writeFile(b.files.presencePath, "busy");
    // An information-only item from a held device, approved by the person, opens the window.
    const held = await c.send("b@two", "info");
    await until(async () => (await b.held.list()).length === 1);
    await b.decide(held.id, "approve");
    expect((await b.spool.unread()).find((i) => i.rendered.includes("info"))!.informs).toBe(true);
    await b.send("a@one", "inside the window");
    await until(async () => (await a.spool.unread()).length === 3);
    const third = (await a.spool.unread())[2]!.rendered;
    expect(third).toMatch(/Derived:/);
    // Derived text from a trusted device only informs.
    expect(third).not.toMatch(/may assign you work/);
    advance(11 * 60_000);
    await b.send("a@one", "after the window");
    await until(async () => (await a.spool.unread()).length === 4);
    expect((await a.spool.unread())[3]!.rendered).not.toMatch(/Derived:/);
    // Reading the inbox, waiting, or history all reopen it.
    await b.inbox(false);
    await b.send("a@one", "after inbox");
    await until(async () => (await a.spool.unread()).length === 5);
    expect((await a.spool.unread())[4]!.rendered).toMatch(/Derived:/);
  });

  it("opens the window from room history, and shows busy-mesh to peers as busy", async () => {
    const { a, b, c, advance } = await trio();
    await fs.writeFile(b.files.presencePath, "busy-mesh");
    await until(() => a.peers.get("b@two")?.status === "busy");
    await fs.writeFile(b.files.presencePath, "idle");
    await sleep(40);
    await b.joinRoom("#d");
    await c.joinRoom("#d");
    await c.send("#d", "in the room");
    // The room message itself (held device) opened the window; let it pass first.
    advance(11 * 60_000);
    await until(async () => (await b.roomHistory("#d")).items.length === 1);
    await b.send("a@one", "after room history");
    await until(async () => (await a.spool.unread()).some((i) => i.rendered.includes("after room history")));
    expect((await a.spool.unread()).find((i) => i.rendered.includes("after room history"))!.rendered).toMatch(/Derived:/);
  });
});

describe("room routes", () => {
  it("are deliver only when every acting device is", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const s = await openSession(devices[0]!, mesh, relay, { name: "a" });
    open.push(s);
    expect(await s.route("#all")).toEqual({ mesh: true, policy: "deliver" });
  });
});
