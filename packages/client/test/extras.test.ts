import { PassThrough } from "node:stream";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { botIO, ciIO, meshPort } from "../src/adapters.ts";
import type { MeshSession } from "../src/client.ts";
import { processIo, type Proc } from "../src/io.ts";
import { MeshFiles } from "../src/mesh.ts";
import { decideHeld, listAllHeld, resumeEverywhere } from "../src/offline.ts";
import { agentEnv, canShowSecret, fetchHeldCode, holdForShow, showSocketPath } from "../src/secretout.ts";
import { SessionFiles } from "../src/session.ts";
import { FS, LIVE_PID, makeMesh, openSession, RelayHarness, scratch, sleep, until } from "./helpers.ts";

const open: MeshSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

async function session(...args: Parameters<typeof openSession>): Promise<MeshSession> {
  const s = await openSession(...args);
  open.push(s);
  return s;
}

async function trustRelayed(dev: { home: { meshDir(m: string): string } }, mesh: string, ids: string[]): Promise<void> {
  await new MeshFiles(dev.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, policy: Object.fromEntries(ids.map((i) => [i, "deliver-relayed"])) }));
}

describe("adapters", () => {
  it("botIO hands over verified items and marks the bot's replies relayed", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const bot = await session(devices[0]!, mesh, relay, { name: "bot", kind: "bot" });
    const user = await session(devices[1]!, mesh, relay, { name: "user" });
    await trustRelayed(devices[1]!, mesh, [devices[0]!.device.id]);
    const io = botIO(bot);
    const got: Array<{ kind: string; fromKind: string; reply_to?: string; deadline?: number }> = [];
    io.onItem((item) => {
      got.push(item);
      void io.send(item.from, `echo ${item.text}`, item.kind === "task" ? { kind: "result", reply_to: item.id, status: "done" } : {});
    });
    await user.send("bot@one", "hi");
    await user.send("bot@one", "do it", { kind: "task", deadline: Date.now() + 60_000 });
    await until(async () => (await user.spool.unread()).length === 2);
    expect(got.map((g) => g.kind)).toEqual(["msg", "task"]);
    expect(got[0]!.fromKind).toBe("mcp");
    expect(got[1]!.deadline).toBeGreaterThan(Date.now());
    const items = await user.spool.unread();
    expect(items.every((i) => i.relayed === true)).toBe(true);
    await user.send("bot@one", "again", { reply_to: items[0]!.id });
    await until(() => got.length === 3);
    expect(got[2]!.reply_to).toBe(items[0]!.id);
    await until(async () => (await bot.spool.unread()).length === 0);
  });

  it("ciIO joins its room once and posts relayed lines", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const ci = await session(devices[0]!, mesh, relay, { name: "ci" });
    const watcher = await session(devices[1]!, mesh, relay, { name: "watcher" });
    await trustRelayed(devices[1]!, mesh, [devices[0]!.device.id]);
    await watcher.joinRoom("#ci");
    const logs: string[] = [];
    const io = ciIO(ci, (l) => logs.push(l));
    await io.post("#ci", "pipeline 1 passed");
    await io.post("#ci", "pipeline 2 failed");
    io.log("x");
    await until(async () => (await watcher.spool.unread()).length === 2);
    expect((await watcher.spool.unread()).every((i) => i.relayed === true)).toBe(true);
    expect(logs).toEqual(["x"]);
    expect(ci.state.rooms).toEqual(["#ci"]);
  });

  it("meshPort sends tasks and results, and reports tasks, results and messages", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const gw = await session(devices[0]!, mesh, relay, { name: "a2a", kind: "a2a" });
    const peer = await session(devices[1]!, mesh, relay, { name: "peer" });
    await trustRelayed(devices[1]!, mesh, [devices[0]!.device.id]);
    const port = meshPort(gw);
    expect((await port.peers()).map((p) => p.address)).toEqual(["peer@two"]);
    const results: unknown[] = [];
    const tasks: unknown[] = [];
    const msgs: unknown[] = [];
    port.onResult((r) => results.push(r));
    port.onTask((t) => tasks.push(t));
    port.onMessage!((m) => msgs.push(m));
    const { id } = await port.sendTask("peer@two", "work", { deadline: Date.now() + 60_000 });
    const sentNoDeadline = await port.sendTask("peer@two", "more", {});
    await until(async () => (await peer.spool.unread()).filter((i) => i.kind === "task").length === 2);
    await peer.send("a2a@one", "done it", { kind: "result", reply_to: id, status: "done" });
    await peer.send("a2a@one", "a task for you", { kind: "task" });
    await peer.send("a2a@one", "just saying");
    await until(() => results.length === 1 && tasks.length === 1 && msgs.length === 1);
    expect(results[0]).toEqual({ reply_to: id, status: "done", text: "done it", from: "peer@two" });
    expect(tasks[0]).toMatchObject({ to: "a2a@one", from: "peer@two", text: "a task for you" });
    await port.sendResult("peer@two", (tasks[0] as { id: string }).id, "done", "answer");
    await expect(port.sendTask("x@nowhere", "t", {})).rejects.toThrow(/not delivered to x@nowhere/);
    await expect(port.sendResult("x@nowhere", id, "done", "t")).rejects.toThrow(/not delivered/);
    void sentNoDeadline;
    // A result without reply_to cannot exist on the wire; the guard covers it anyway.
    gw.emit("message", { kind: "result", peer: "peer@two", id: "x", at: 1, dir: "in", text: "t", cursor: 0 });
    gw.emit("message", { kind: "task", peer: "peer@two", id: "y", at: 1, dir: "in", text: "t", cursor: 0, deadline: 5 });
    expect(results.length).toBe(1);
    expect(tasks[1]).toMatchObject({ deadline: 5 });
  });
});

describe("offline decisions", () => {
  it("applies to sessions nobody runs, marks live ones, and defers file fetches", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"], { trust: false });
    const a = await session(devices[0]!, mesh, relay, { name: "a", userHome: "/none" });
    const live = await session(devices[1]!, mesh, relay, { name: "live" });
    const idle = await session(devices[1]!, mesh, relay, { name: "idle" });
    const files = new MeshFiles(devices[1]!.home.meshDir(mesh), FS);
    const toLive = await a.send("live@two", "for live");
    const toIdle = await a.send("idle@two", "for idle");
    await a.send("idle@two", "relayed", { relayed: true });
    const dir = await scratch("off");
    await fs.writeFile(join(dir, "f.txt"), "file");
    const fileMsg = await a.sendFile("idle@two", join(dir, "f.txt"));
    await until(async () => (await listAllHeld(files, FS)).length === 4);
    const idleSid = idle.sid;
    await idle.stop();
    open.splice(open.indexOf(idle), 1);
    // The live session is held by "another process".
    await fs.writeFile(new SessionFiles(files, live.sid, FS).liveLock, String(LIVE_PID));
    expect(await decideHeld(files, toLive.id, "approve", FS, Date.now)).toBe(1);
    expect(await fs.readdir(live.files.heldDir)).toContain(`${toLive.id}.approve`);
    expect(await decideHeld(files, toIdle.id, "approve", FS, Date.now)).toBe(1);
    const idleFiles = new SessionFiles(files, idleSid, FS);
    const spooled = await fs.readdir(idleFiles.spoolDir);
    expect(spooled.filter((n) => n.endsWith(".json")).length).toBeGreaterThan(0);
    expect(await decideHeld(files, fileMsg.id, "approve", FS, Date.now)).toBe(1);
    expect(await fs.readdir(idleFiles.heldDir)).toContain(`${fileMsg.id}.approve`);
    const relayedItem = (await listAllHeld(files, FS)).find((h) => h.entry.relayed === true)!;
    expect(await decideHeld(files, relayedItem.id, "approve", FS, Date.now)).toBe(1);
    expect(await decideHeld(files, "01J00000000000000000000000", "refuse", FS, Date.now)).toBe(0);
    await fs.writeFile(new SessionFiles(files, live.sid, FS).liveLock, String(process.pid));
  });

  it("resumes a paused peer everywhere", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const files = new MeshFiles(devices[1]!.home.meshDir(mesh), FS);
    await files.updateConfig((c) => ({ ...c, breaker: { perPeerPerHour: 1, totalPerHour: 50, pingPong: false } }));
    const a = await session(devices[0]!, mesh, relay, { name: "a", userHome: "/none" });
    const idle = await session(devices[1]!, mesh, relay, { name: "idle" });
    const live = await session(devices[1]!, mesh, relay, { name: "live" });
    for (const t of ["1", "2"]) await a.send("idle@two", t);
    const dir = await scratch("off2");
    await fs.writeFile(join(dir, "g.txt"), "g");
    await a.sendFile("idle@two", join(dir, "g.txt"));
    await a.send("idle@two", "from another", { relayed: false });
    await until(async () => (await idle.held.list()).length === 3);
    await idle.stop();
    open.splice(open.indexOf(idle), 1);
    await fs.writeFile(live.files.liveLock, String(LIVE_PID));
    expect(await resumeEverywhere(files, "a@one", FS, Date.now)).toBe(3);
    expect(await fs.readdir(live.files.controlDir)).toEqual(["resume-a@one"]);
    expect(await resumeEverywhere(files, "b@three", FS, Date.now)).toBe(0);
    await fs.writeFile(live.files.liveLock, String(process.pid));
  });
});

describe("secretout", () => {
  it("knows agent environments and terminals", () => {
    expect(agentEnv({})).toBeUndefined();
    expect(agentEnv({ CLAUDECODE: "1" })).toBe("CLAUDECODE");
    expect(agentEnv({ CLAUDECODE: "" })).toBeUndefined();
    expect(agentEnv({ CODEX_SANDBOX: "seatbelt" })).toBe("CODEX_SANDBOX");
    expect(agentEnv({ CODEX_X: "" })).toBeUndefined();
    expect(canShowSecret({}, true)).toBe(true);
    expect(canShowSecret({}, false)).toBe(false);
    expect(showSocketPath("/h", "linux")).toBe("/h/recovery.sock");
    expect(showSocketPath("C:\\h", "win32")).toMatch(/^\\\\\.\\pipe\\wim-recovery-/);
  });

  it("hands the code over once, then closes; times out; and fails a fetch with nothing waiting", async () => {
    // A Unix socket in the directory on POSIX, a named pipe on Windows, as the CLI uses.
    const dir = await scratch("sock");
    const path = showSocketPath(dir, process.platform);
    const stop = new AbortController();
    const held = holdForShow(path, "CODE", 2000, stop.signal, process.platform);
    await sleep(20);
    expect(await fetchHeldCode(path)).toBe("CODE");
    expect(await held).toBe(true);
    await expect(fetchHeldCode(path)).rejects.toThrow(/no recovery code is waiting/);
    expect(await holdForShow(path, "CODE", 10, new AbortController().signal, process.platform)).toBe(false);
    // A second connection at the same moment gets nothing.
    const h2 = holdForShow(path, "C2", 2000, new AbortController().signal, process.platform);
    await sleep(20);
    const [x, y] = await Promise.allSettled([fetchHeldCode(path), fetchHeldCode(path)]);
    expect([x.status, y.status].sort()).toEqual(["fulfilled", "rejected"]);
    await h2;
    // Neither a socket in a missing directory nor (on Windows) a path that is not a pipe can listen.
    for (const platform of ["linux", "win32"]) {
      await expect(holdForShow(join(dir, "missing", "deep", "r.sock"), "C", 10, new AbortController().signal, platform)).rejects.toThrow();
    }
  });
});

describe("processIo", () => {
  it("wires a process to the CLI", async () => {
    const stdin = new PassThrough();
    const stdout = Object.assign(new PassThrough(), { isTTY: true });
    const stderr = new PassThrough();
    const handlers = new Map<string, () => void>();
    const proc: Proc = { stdin, stdout, stderr, platform: "linux", pid: 7, ppid: process.pid, getuid: () => 5, cwd: () => "/w", once: (s, cb) => handlers.set(s, cb), on: () => undefined };
    const io = processIo(proc, { homedir: () => "/home/u", hostname: () => "host", kill: () => undefined, wim: () => [] });
    expect(io).toMatchObject({ cwd: "/w", homedir: "/home/u", hostname: "host", platform: "linux", uid: 5, pid: 7, isTTY: true });
    let out = "";
    stdout.on("data", (d: Buffer) => (out += d.toString()));
    let err = "";
    stderr.on("data", (d: Buffer) => (err += d.toString()));
    io.out("hello");
    io.err("oops");
    const answer = io.prompt("? ");
    stdin.write("yes\n");
    expect(await answer).toBe("yes");
    expect(out).toBe("hello\n");
    expect(err).toContain("oops\n");
    expect(io.signal.aborted).toBe(false);
    handlers.get("SIGTERM")!();
    expect(io.signal.aborted).toBe(true);
    handlers.get("SIGINT")!();
    expect(typeof io.now()).toBe("number");
    const plain = processIo({ ...proc, stdout: new PassThrough(), getuid: undefined });
    expect(plain.isTTY).toBe(false);
    expect(plain.uid).toBeUndefined();
  });
});
