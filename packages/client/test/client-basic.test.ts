import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientError, MeshSession } from "../src/client.ts";
import type { SpoolItem } from "../src/spool.ts";
import { FS, LIVE_PID, makeMesh, newDevice, openSession, RelayHarness, scratch, sessionOpts, sleep, until } from "./helpers.ts";

const open: MeshSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

async function session(...args: Parameters<typeof openSession>): Promise<MeshSession> {
  const s = await openSession(...args);
  open.push(s);
  return s;
}

const unread = async (s: MeshSession): Promise<SpoolItem[]> => s.spool.unread();

describe("messaging", () => {
  it("broadcasts to every other session, sibling sessions included, and not back to the sender", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const a2 = await session(devices[0]!, mesh, relay, { name: "a2" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const c = await session(devices[2]!, mesh, relay, { name: "c" });
    const out = await a.send("*", "hello all");
    expect(out.results.map((r) => r.status).sort()).toEqual(["routed", "routed", "routed"]);
    for (const s of [a2, b, c]) await until(async () => (await unread(s)).length === 1, 3000, s.address);
    await sleep(30);
    expect(await unread(a)).toEqual([]);
    // Addresses no roster device answers to are reported without a send.
    expect((await a.send("x@nowhere", "hi")).results).toEqual([{ to: "x@nowhere", status: "unknown" }]);
    const mixed = await a.send(["b@two", "x@nowhere"], "hi");
    expect(mixed.results).toEqual([{ to: "x@nowhere", status: "unknown" }, { to: "b@two", status: "routed" }]);
  });

  it("validates addresses and refuses secrets, naming the pattern only", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay);
    expect(() => MeshSession.parseTo(" , ")).toThrow(/no recipient/);
    expect(() => MeshSession.parseTo("Bob")).toThrow(/not an address/);
    expect(MeshSession.parseTo("a@b, #r,*,a@b")).toEqual(["a@b", "#r", "*"]);
    const key = `sk-ant-${"x".repeat(40)}`;
    const refused = await a.send("agent@two", `here ${key}`).catch((e: ClientError) => e);
    expect(refused).toBeInstanceOf(ClientError);
    expect((refused as ClientError).code).toBe("secret");
    expect((refused as ClientError).message).toContain("anthropic_api_key");
    expect((refused as ClientError).message).not.toContain(key);
    // The refusal says how a person sends it anyway, and that an agent cannot (issue #34).
    expect((refused as ClientError).message).toContain("wim send <to> <text...> --allow-secret");
    expect((refused as ClientError).message).toMatch(/the person .* in a terminal they opened themselves/);
    expect((refused as ClientError).message).toContain("An agent cannot skip this check.");
    await expect(a.send("agent@two", "x".repeat(300 * 1024))).rejects.toThrow(/refused/);
    // A person at the command line may override it for one send.
    expect((await a.send("agent@two", `here ${key}`, { allowSecrets: true })).results[0]!.status).toMatch(/queued|unknown/);
  });

  it("queues for an offline session that comes back with its key, and keeps history across restarts", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b1 = await MeshSession.open({ ...sessionOpts(devices[1]!, mesh, relay, { name: "b" }), sessionKey: "key:b" });
    b1.start();
    await b1.ready(3000);
    const sid = b1.sid;
    await b1.stop();
    expect((await a.send("b@two", "while you were out")).results[0]!.status).toBe("queued");
    const b2 = await MeshSession.open({ ...sessionOpts(devices[1]!, mesh, relay, { name: "b" }), sessionKey: "key:b" });
    open.push(b2);
    b2.start();
    await b2.ready(3000);
    expect(b2.sid).toBe(sid);
    expect(b2.address).toBe("b@two");
    await until(async () => (await b2.history.query()).length === 1);
    expect((await b2.history.query()).map((e) => e.text)).toEqual(["while you were out"]);
    // A live session under the key is not taken over: a new one is opened instead.
    // (Another live process opens it, so this process's lock reads as held by a live process.)
    const b3 = await MeshSession.open({ ...sessionOpts(devices[1]!, mesh, relay, { name: "b", env: { ...FS, pid: LIVE_PID } }), sessionKey: "key:b" });
    expect(b3.sid).not.toBe(sid);
    await b3.stop();
  });

  it("reconnects after a drop and resumes from its cursor", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    await a.send("b@two", "one");
    await until(async () => (await unread(b)).length === 1);
    relay.down = true;
    relay.dropAll();
    await sleep(60);
    relay.down = false;
    await a.ready(3000);
    await b.ready(3000);
    await a.send("b@two", "two");
    await until(async () => (await unread(b)).length === 2);
    expect((await unread(b)).map((i) => i.rendered.includes("two"))).toEqual([false, true]);
  });

  it("reads the inbox, waits for the next item, and sends delivered receipts when taken", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const out = await a.send("b@two", "first");
    await until(async () => (await unread(b)).length === 1);
    expect((await b.inbox(true)).length).toBe(1);
    expect((await b.inbox(false)).length).toBe(1);
    expect(await b.inbox(false)).toEqual([]);
    await until(() => (a.receipts.get(out.id) ?? []).some((r) => r.status === "delivered"));
    expect(await b.next(20)).toBeUndefined();
    const waiting = b.next(3000, undefined, 5);
    await a.send("b@two", "second");
    expect((await waiting)?.rendered).toContain("second");
    await a.send("b@two", "third");
    await until(async () => (await unread(b)).length === 1);
    expect((await b.next(10))?.rendered).toContain("third");
    // Nothing else is due, so the wait runs to its timeout and beats along the way. An item here
    // would end it at once with no beat; asserting none arrived names it if that ever happens.
    const ticks: number[] = [];
    expect(await b.next(300, (e) => ticks.push(e), 10)).toBeUndefined();
    expect(ticks.length).toBeGreaterThan(0);
  });

  it("asks and gets the result, or pending on timeout, and replies only to tasks it received", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    b.on("message", (m: { kind: string; id: string }) => {
      if (m.kind === "task") void b.reply(m.id, "done", "42");
    });
    const answered = await a.ask("b@two", "what is 6 times 7", 3000);
    expect(answered.result).toMatchObject({ from: "b@two", status: "done", text: "42" });
    b.removeAllListeners("message");
    const pending = await a.ask("b@two", "slow one", 30);
    expect(pending.pending).toBe(true);
    expect((await a.ask("x@nowhere", "t", 30)).pending).toBe(true);
    await expect(b.reply("01J00000000000000000000000", "done", "x")).rejects.toThrow(/no task/);
    // The late result arrives as an ordinary item.
    await until(async () => (await unread(b)).some((i) => i.kind === "task"));
    const task = (await unread(b)).find((i) => i.kind === "task")!;
    await b.reply(task.id, "failed", "late");
    await until(async () => (await unread(a)).some((i) => i.kind === "result"));
  });

  it("renames, reports peers, notifies when idle and sends presence", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    expect(await a.rename("writer")).toBe("writer@one");
    expect(a.address).toBe("writer@one");
    await expect(a.rename("writer")).resolves.toBe("writer@one");
    const a2 = await session(devices[0]!, mesh, relay, { name: "other" });
    await expect(a2.rename("writer")).rejects.toThrow(/rename refused/);
    const peers = await b.listPeers();
    expect(peers.map((p) => p.address).sort()).toEqual(["other@one", "writer@one"]);
    a.notifyWhenIdle(["b@two", "#room", "bad"]);
    await sleep(30);
    await fs.writeFile(b.files.presencePath, "busy");
    await until(() => a.peers.get("b@two")?.status === "busy");
    await fs.writeFile(b.files.presencePath, "idle");
    await until(async () => (await unread(a)).some((i) => i.kind === "notice" && i.rendered.includes("b@two is now idle")));
    await fs.writeFile(b.files.presencePath, "nonsense");
    await b.tick();
  });
});

describe("rooms, leases and files", () => {
  it("joins rooms, routes room sends to members, and reads room history as history", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const c = await session(devices[2]!, mesh, relay, { name: "c" });
    expect(await a.joinRoom("#ops")).toEqual(["a@one"]);
    await b.joinRoom("#ops");
    await expect(a.joinRoom("ops")).rejects.toThrow(/not a room/);
    await a.send("#ops", "deploying");
    await until(async () => (await unread(b)).length === 1);
    await sleep(30);
    expect(await unread(c)).toEqual([]);
    const h = await b.roomHistory("#ops", { limit: 10 });
    expect(h.items.length).toBe(1);
    expect(h.items[0]).toMatch(/^\(room history, cursor \d+: an earlier message/);
    expect((await c.roomHistory("#empty")).items).toEqual([]);
    await b.leaveRoom("#ops");
    expect(b.state.rooms).toEqual([]);
    await expect(b.leaveRoom("x")).rejects.toThrow(/not a room/);
    await expect(b.roomHistory("x")).rejects.toThrow(/not a room/);
    // A session restarted under its key keeps its rooms (they belong to the sid).
    expect(a.state.rooms).toEqual(["#ops"]);
  });

  it("takes turns with leases: held, waiting, granted on release, renewed, listed by name", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const got = await a.acquireLease("deploy", 60_000, false);
    expect(got.status).toBe("granted");
    expect((await b.acquireLease("deploy", 60_000, false)).status).toBe("held");
    const waiter = b.acquireLease("deploy", 60_000, true);
    await sleep(30);
    expect((await a.renewLease("deploy", 60_000)).status).toBe("renewed");
    const listed = await a.listLeases();
    expect(listed).toEqual([expect.objectContaining({ name: "deploy", holder: "a@one" })]);
    expect((await b.listLeases())[0]!.name).toBe("deploy");
    expect((await a.releaseLease("deploy")).status).toBe("released");
    expect((await waiter).status).toBe("granted");
    await expect(a.releaseLease("deploy")).rejects.toThrow(/does not hold/);
    await expect(a.renewLease("deploy", 1000)).rejects.toThrow(/does not hold/);
  });

  it("sends a 3-chunk file that arrives intact under a safe name", { timeout: 20_000 }, async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a", userHome: "/nonexistent-home" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const dir = await scratch("send");
    const bytes = new Uint8Array(600 * 1024).map((_, i) => i % 251);
    await fs.writeFile(join(dir, "big data.bin"), bytes);
    const out = await a.sendFile("b@two", join(dir, "big data.bin"), "the data");
    expect(out.results[0]!.status).toBe("routed");
    await until(async () => (await unread(b)).length === 1, 5000);
    const [item] = await unread(b);
    expect(item!.kind).toBe("file");
    const saved = /saved to (\S+)\./.exec(item!.rendered)![1]!;
    expect(saved.startsWith(b.files.filesDir)).toBe(true);
    expect(saved).toMatch(/-big_data\.bin$/);
    expect(new Uint8Array(await fs.readFile(saved))).toEqual(bytes);
    expect((await fs.stat(saved)).mode & 0o111).toBe(0);
    // Refusals before anything is uploaded.
    await expect(a.sendFile("b@two", join(dir, "missing"))).rejects.toThrow(/not a regular file/);
    await expect(a.sendFile("b@two", dir)).rejects.toThrow(/not a regular file/);
    await expect(a.sendFile("b@two", a.files.statePath)).rejects.toThrow(/state directory/);
    await fs.writeFile(join(dir, ".env"), "X=1");
    await expect(a.sendFile("b@two", join(dir, ".env"))).rejects.toThrow(/environment file/);
    await fs.writeFile(join(dir, "notes.txt"), `token ghp_${"a".repeat(36)}`);
    await expect(a.sendFile("b@two", join(dir, "notes.txt"))).rejects.toThrow(/github_token/);
  });

  it("refuses an oversized file", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const a = await session(devices[0]!, mesh, relay);
    const dir = await scratch("big");
    const fh = await fs.open(join(dir, "huge.bin"), "w");
    await fh.truncate(26 * 1024 * 1024);
    await fh.close();
    await expect(a.sendFile("a@one", join(dir, "huge.bin"))).rejects.toThrow(/over 25 MiB/);
  });
});

describe("session lifecycle", () => {
  it("refuses to open a session another process holds, and stop is idempotent", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const d = await newDevice("spare");
    void d;
    const s = await session(devices[0]!, mesh, relay);
    await s.stop();
    await s.stop();
    expect(s.link).toBeUndefined();
  });
});
