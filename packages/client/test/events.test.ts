import { promises as fs } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ulid } from "@worldinmotion/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { MeshSession } from "../src/client.ts";
import { relayHost, runEvents } from "../src/events.ts";
import { MeshFiles } from "../src/mesh.ts";
import { FS, makeMesh, openSession, RelayHarness, run, said, scratch, sessionOpts, sleep, term, until, type TestDevice } from "./helpers.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f().catch(() => undefined);
});

type Line = Record<string, unknown> & { type: string };

/** Runs the events process for device `d` in-process and collects its lines. */
async function start(d: TestDevice, mesh: string, relay: RelayHarness, extra: { name?: string; answerMs?: number } = {}) {
  const lines: Line[] = [];
  const input = new PassThrough();
  const stop = new AbortController();
  const files = new MeshFiles(d.home.meshDir(mesh), FS);
  const session = await MeshSession.open({ ...sessionOpts(d, mesh, relay, { name: extra.name ?? "vscode", kind: "vscode", cwd: d.root, ...(extra.answerMs === undefined ? {} : { answerMs: extra.answerMs }) }), handover: true, sessionKey: "events:vscode" });
  const running = runEvents({
    session,
    mesh: files,
    env: FS,
    device: d.device,
    version: "test",
    write: (l) => void lines.push(JSON.parse(l) as Line),
    input,
    signal: stop.signal,
    now: Date.now,
    pollMs: 20,
    leasePollMs: 40,
  });
  cleanup.push(async () => {
    stop.abort();
    await running;
    await session.stop();
  });
  let n = 0;
  const request = async (op: string, args?: Record<string, unknown>): Promise<Line> => {
    const id = `r${++n}`;
    input.write(`${JSON.stringify({ v: 1, id, op, ...(args === undefined ? {} : { args }) })}\n`);
    await until(() => lines.some((l) => l.type === "response" && l["id"] === id), 5000, `response ${id}`);
    return lines.find((l) => l.type === "response" && l["id"] === id)!;
  };
  const raw = (text: string): void => void input.write(`${text}\n`);
  const of = (type: string): Line[] => lines.filter((l) => l.type === type);
  await until(() => of("snapshot").length > 0, 5000, "first snapshot");
  return { lines, request, raw, of, session, input, stop, running, files };
}

describe("wim events --json", () => {
  it("says hello, reports the connection and a snapshot, and answers snapshot requests", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const peer = await openSession(devices[1]!, mesh, relay, { name: "peer", cwd: devices[1]!.root });
    cleanup.push(() => peer.stop());
    await peer.joinRoom("#ops");
    await peer.acquireLease("deploy", 60_000, false);
    const e = await start(devices[0]!, mesh, relay);
    const [hello] = e.lines;
    expect(hello).toMatchObject({ v: 1, type: "hello", version: "test", device: { name: "one", id: devices[0]!.device.id }, session: "vscode@one", relay: "127.0.0.1:4444", mesh: `${mesh.slice(0, 4)}…` });
    expect(e.of("connection").map((c) => c["state"])).toEqual(["connecting", "open"]);
    const snap = e.of("snapshot")[0]!;
    expect(snap["devices"]).toEqual([
      { name: "one", id: devices[0]!.device.id, role: "admin", policy: "deliver", self: true },
      { name: "two", id: devices[1]!.device.id, role: "member", policy: "deliver", self: false },
    ]);
    expect(snap["sessions"]).toEqual([expect.objectContaining({ address: "peer@two", kind: "mcp", rooms: ["#ops"], local: false })]);
    expect(snap["rooms"]).toEqual([{ name: "#ops", members: ["peer@two"] }]);
    expect(snap["leases"]).toEqual([expect.objectContaining({ name: expect.any(String), holder: "peer@two" })]);
    expect(snap["held"]).toEqual([]);
    const r = await e.request("snapshot");
    expect(r).toMatchObject({ ok: true, result: {} });
    expect(e.of("snapshot").length).toBe(2);
    expect(JSON.stringify(e.lines)).not.toContain(mesh);
    // Leases come and go.
    await peer.releaseLease("deploy");
    await until(() => e.of("lease").some((l) => l["released"] === true));
    await peer.acquireLease("again", 60_000, false);
    await until(() => e.of("lease").some((l) => l["holder"] === "peer@two"));
    // Presence and cards change peer rows.
    await fs.writeFile(peer.files.presencePath, "busy");
    await until(() => e.of("peer").some((p) => p["address"] === "peer@two" && p["status"] === "busy"));
    // Connection loss and recovery.
    relay.dropAll(1006);
    await until(() => e.of("connection").some((c) => c["state"] === "closed" && c["detail"] === "connection closed (code 1006, dropped)"));
    await until(() => e.of("connection").filter((c) => c["state"] === "open").length === 2);
    await until(() => e.of("snapshot").length === 3);
  });

  it("follows every local session's history as message events, from now on", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const before = await openSession(devices[0]!, mesh, relay, { name: "older" });
    cleanup.push(() => before.stop());
    const peer = await openSession(devices[1]!, mesh, relay, { name: "peer" });
    cleanup.push(() => peer.stop());
    await before.send("peer@two", "from before the start");
    const e = await start(devices[0]!, mesh, relay);
    await sleep(60);
    expect(e.of("message")).toEqual([]);
    await before.send("peer@two", "after the start");
    await until(() => e.of("message").some((m) => m["text"] === "after the start" && m["session"] === "older@one" && m["dir"] === "out"));
    expect(e.of("message").find((m) => m["text"] === "after the start")!["to"]).toEqual(["peer@two"]);
    // A session created after the start is read from its beginning.
    const later = await openSession(devices[0]!, mesh, relay, { name: "later" });
    cleanup.push(() => later.stop());
    await peer.send("later@one", "to the new session");
    await until(() => e.of("message").some((m) => m["text"] === "to the new session" && m["session"] === "later@one" && m["dir"] === "in"));
    // The events process's own sends, with their receipts.
    expect(await e.request("send", { to: "peer@two", text: "a reply", reply_to: ulid() })).toMatchObject({ ok: true });
    const sent = await e.request("send", { to: "peer@two", text: "from the ui", kind: "task" });
    expect(sent).toMatchObject({ ok: true, result: { results: [{ to: "peer@two", status: "routed" }] } });
    const id = (sent["result"] as { id: string }).id;
    await until(() => e.of("message").some((m) => m["id"] === id && m["session"] === "vscode@one" && m["kind"] === "task"));
    await until(async () => (await peer.spool.unread()).some((i) => i.id === id));
    await peer.take((await peer.spool.unread()).find((i) => i.id === id)!.cursor);
    await until(() => e.of("receipt").some((r) => r["id"] === id && r["status"] === "delivered"));
    // A half-written line waits; a rotated (shorter) file is read from its start.
    const f = later.files.historyPath;
    await fs.appendFile(f, JSON.stringify({ dir: "in", peer: "x@two", id: ulid(), kind: "msg", at: 1, text: "half" }).slice(0, 20));
    await sleep(60);
    expect(e.of("message").some((m) => m["text"] === "half")).toBe(false);
    await fs.writeFile(f, `${JSON.stringify({ dir: "in", peer: "x@two", id: ulid(), kind: "msg", at: 2, text: "rotated" })}\nnot json\n`);
    await until(() => e.of("message").some((m) => m["text"] === "rotated"));
  });

  it("answers history requests across sessions, filtered and paged", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await openSession(devices[0]!, mesh, relay, { name: "a" });
    cleanup.push(() => a.stop());
    const peer = await openSession(devices[1]!, mesh, relay, { name: "peer" });
    cleanup.push(() => peer.stop());
    const ids: string[] = [];
    for (const t of ["m1", "m2", "m3"]) ids.push((await a.send("peer@two", t)).id);
    const e = await start(devices[0]!, mesh, relay);
    await e.request("send", { to: "peer@two", text: "m4" });
    const all = await e.request("history", {});
    expect(((all["result"] as { messages: Array<{ text: string }> }).messages).map((m) => m.text)).toEqual(["m1", "m2", "m3", "m4"]);
    const mine = await e.request("history", { session: "a@one", before: ids[2], limit: 1 });
    expect(((mine["result"] as { messages: Array<{ text: string; session: string }> }).messages)).toEqual([expect.objectContaining({ text: "m2", session: "a@one" })]);
    const byPeer = await e.request("history", { peer: "nobody@x" });
    expect((byPeer["result"] as { messages: unknown[] }).messages).toEqual([]);
    const unknownBefore = await e.request("history", { before: "nope" });
    expect((unknownBefore["result"] as { messages: unknown[] }).messages.length).toBe(4);
  });

  it("shows held items, and approve, refuse, trust, untrust and resume act for the person", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"], { trust: false });
    await new MeshFiles(devices[0]!.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, breaker: { perPeerPerHour: 1, totalPerHour: 50, pingPong: false, pingPongExchanges: 32 } }));
    const other = await openSession(devices[0]!, mesh, relay, { name: "other" });
    cleanup.push(() => other.stop());
    const peer = await openSession(devices[1]!, mesh, relay, { name: "peer" });
    cleanup.push(() => peer.stop());
    const e = await start(devices[0]!, mesh, relay);
    // Held by policy, in this process and in another local session.
    const m1 = await peer.send("vscode@one", "please hold");
    const m2 = await peer.send("other@one", "hold elsewhere");
    await until(() => e.of("held").filter((h) => h["op"] === "add").length === 2);
    const added = e.of("held").map((h) => h["item"] as Record<string, unknown>);
    expect(added).toEqual(expect.arrayContaining([expect.objectContaining({ id: m1.id, session: "vscode@one", from: "peer@two", preview: "please hold", reason: "policy" })]));
    expect(JSON.stringify(added)).not.toContain('"text"');
    expect(await e.request("approve", { held: m1.id })).toMatchObject({ ok: true, result: {} });
    expect(await e.request("refuse", { held: m2.id })).toMatchObject({ ok: true });
    await until(() => e.of("held").filter((h) => h["op"] === "remove").length === 2);
    expect(await e.request("approve", { held: ulid() })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await e.request("approve", { held: "x" })).toMatchObject({ ok: false, error: { code: "input" } });
    // Trust: a device event and the new policy.
    expect(await e.request("trust", { device: "two" })).toMatchObject({ ok: true, result: { policy: "deliver" } });
    await until(() => e.of("device").some((d) => d["name"] === "two" && d["policy"] === "deliver"));
    expect(await e.request("trust", { device: "two", relayed: true })).toMatchObject({ result: { policy: "deliver-relayed" } });
    expect(await e.request("untrust", { device: "two" })).toMatchObject({ result: { policy: "hold" } });
    expect(await e.request("trust", { device: "ghost" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    // The breaker: this process's own trips with a reason, another session's from its holds.
    await e.request("trust", { device: "two" });
    await new MeshFiles(devices[0]!.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, policy: { ...c.policy, [devices[1]!.device.id]: "deliver" } }));
    for (const t of ["1", "2"]) await peer.send("vscode@one", t);
    for (const t of ["1", "2", "3"]) await peer.send("other@one", t);
    await until(() => e.of("breaker").some((b) => b["state"] === "tripped" && b["reason"] === "peer"));
    await until(() => e.of("breaker").filter((b) => b["state"] === "tripped").length === 2);
    // Every breaker hold has landed before the resume, so none arrives after it.
    await until(async () => (await other.held.list()).filter((h) => h.reason === "breaker").length === 2);
    // A snapshot lists the paused peer once, with this process's reason.
    await e.request("snapshot");
    expect(e.of("snapshot").at(-1)!["breakers"]).toEqual([expect.objectContaining({ peer: "peer@two", reason: "peer", at: expect.any(Number) })]);
    const resumed = await e.request("resume", { peer: "peer@two" });
    expect(resumed).toMatchObject({ ok: true });
    expect((resumed["result"] as { released: number }).released).toBeGreaterThanOrEqual(2);
    expect(e.of("breaker").some((b) => b["state"] === "resumed" && b["peer"] === "peer@two")).toBe(true);
    await e.request("snapshot");
    expect(e.of("snapshot").at(-1)!["breakers"]).toEqual([]);
    // A device or policy change made elsewhere shows up too.
    await new MeshFiles(devices[0]!.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, policy: { ...c.policy, [devices[1]!.device.id]: "refuse" } }));
    await e.session.tick();
    e.session.config = await e.files.loadConfig();
    await until(() => e.of("device").some((d) => d["name"] === "two" && d["policy"] === "refuse"));
  }, 20_000);

  it("refuses bad requests and secrets, checks file paths, and ends when stdin closes", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const e = await start(devices[0]!, mesh, relay);
    const before = e.of("response").length;
    e.raw("not json");
    e.raw("");
    e.raw(JSON.stringify({ v: 2, id: "vv", op: "snapshot" }));
    e.raw(JSON.stringify({ v: 2, op: "snapshot" }));
    await until(() => e.of("response").length === before + 3);
    const bad = e.of("response").slice(before);
    expect(bad.map((r) => (r["error"] as { code: string }).code)).toEqual(["input", "input", "input"]);
    expect(bad[1]!["id"]).toBe("vv");
    expect(bad[0]!["id"]).toBeUndefined();
    expect(await e.request("dance")).toMatchObject({ ok: false, error: { code: "input", message: "unknown op dance" } });
    expect(await e.request("send", { to: 5 })).toMatchObject({ ok: false, error: { code: "input" } });
    expect(await e.request("send", { to: "vscode@one", text: `sk-ant-${"x".repeat(40)}` })).toMatchObject({ ok: false, error: { code: "refused" } });
    expect(await e.request("send", { to: "Not An Address", text: "x" })).toMatchObject({ ok: false, error: { code: "input" } });
    expect(await e.request("send", { to: "vscode@one", text: "x", allow_secret: true })).toMatchObject({ ok: true });
    expect(await e.request("send_file", { to: "vscode@one", path: "relative.txt" })).toMatchObject({ ok: false, error: { code: "input" } });
    const dir = await scratch("ev-file");
    await fs.writeFile(join(dir, "n.txt"), "note");
    expect(await e.request("send_file", { to: "vscode@one", path: join(dir, "n.txt") })).toMatchObject({ ok: true });
    expect(await e.request("send_file", { to: "vscode@one", path: join(dir, "missing.txt") })).toMatchObject({ ok: false, error: { code: "not_found" } });
    relay.down = true;
    relay.dropAll();
    await until(() => e.of("connection").some((c) => c["state"] === "closed" && String(c["detail"]).startsWith("connection")));
    const offline = await e.request("snapshot");
    expect(offline).toMatchObject({ ok: true });
    const lastSnap = e.of("snapshot").at(-1)!;
    expect(lastSnap["leases"]).toEqual([]);
    const sendOffline = await e.request("send", { to: "vscode@one", text: "x" });
    expect(sendOffline).toMatchObject({ ok: false, error: { code: "error" } });
    e.input.end();
    await e.running;
  });

  it("reports a revoked device, a session that ended, and breaker holds that predate the process", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"]);
    await new MeshFiles(devices[0]!.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, breaker: { perPeerPerHour: 1, totalPerHour: 50, pingPong: false, pingPongExchanges: 32 } }));
    const other = await openSession(devices[0]!, mesh, relay, { name: "other" });
    cleanup.push(() => other.stop());
    const peer = await openSession(devices[1]!, mesh, relay, { name: "peer" });
    for (const t of ["1", "2"]) await peer.send("other@one", t);
    await until(async () => (await other.held.list()).length === 1);
    const e = await start(devices[0]!, mesh, relay);
    expect(e.of("snapshot")[0]!["breakers"]).toEqual([expect.objectContaining({ peer: "peer@two" })]);
    expect((e.of("snapshot")[0]!["breakers"] as Array<Record<string, unknown>>)[0]!["reason"]).toBeUndefined();
    await peer.stop({ ended: true });
    await until(() => e.of("peer").some((p) => p["address"] === "peer@two" && p["removed"] === true));
    const { revokeDevice } = await import("../src/admin.ts");
    const admin = await openSession(devices[0]!, mesh, relay, { name: "admin" });
    cleanup.push(() => admin.stop());
    await revokeDevice(admin, "three", Date.now);
    await until(() => e.of("device").some((d) => d["name"] === "three" && d["removed"] === true));
  });

  it("keeps going when the relay stops answering or local state cannot be read", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"], { trust: false });
    const peer = await openSession(devices[1]!, mesh, relay, { name: "peer" });
    cleanup.push(() => peer.stop());
    const e = await start(devices[0]!, mesh, relay, { answerMs: 150 });
    // A held file shows its file details.
    const dir = await scratch("ev-held");
    await fs.writeFile(join(dir, "h.txt"), "held file");
    await peer.sendFile("vscode@one", join(dir, "h.txt"));
    await until(() => e.of("held").some((h) => (h["item"] as { file?: { name: string } }).file?.name === "h.txt"));
    // A session directory without a state file still has its history followed.
    const stray = join(e.files.sessionsDir, ulid());
    await fs.mkdir(stray, { recursive: true });
    await fs.writeFile(join(stray, "history.jsonl"), `${JSON.stringify({ dir: "in", peer: "x@two", id: ulid(), kind: "msg", at: 1, text: "stray" })}\n`);
    await until(() => e.of("message").some((m) => m["text"] === "stray" && m["session"] === "?@one"));
    // The relay stops answering peers and lease lists: snapshots fall back to what is known.
    relay.toRelay = (text) => (text === '{"t":"peers"}' || text === '{"t":"lease.list"}' ? undefined : text);
    expect(await e.request("snapshot")).toMatchObject({ ok: true });
    await sleep(200);
    // Unreadable state fails a pass (and the snapshot after a reconnect), not the process: a file
    // where the held directory should be cannot be listed, on any platform.
    const heldDir = join(stray, "held");
    await fs.writeFile(heldDir, "");
    relay.dropAll(1006);
    await until(() => e.of("connection").filter((c) => c["state"] === "open").length === 2);
    // The snapshot first waits out the unanswered peers and lease requests (2 x 150 ms).
    await sleep(600);
    await fs.rm(heldDir);
    relay.toRelay = undefined;
    expect(await e.request("snapshot")).toMatchObject({ ok: true });
  });

  it("returns at once when started with an aborted signal", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const session = await MeshSession.open(sessionOpts(devices[0]!, mesh, relay, { name: "x" }));
    const stop = new AbortController();
    stop.abort();
    await runEvents({ session, mesh: new MeshFiles(devices[0]!.home.meshDir(mesh), FS), env: FS, device: devices[0]!.device, version: "t", write: () => undefined, input: new PassThrough(), signal: stop.signal, now: Date.now });
    await session.stop();
  });

  it("runs as a CLI command named vscode, honouring --as and WIM_KIND", async () => {
    const relay = new RelayHarness();
    const { devices } = await makeMesh(relay, ["one"]);
    const t = term(devices[0]!.root, relay);
    expect(await run(t, "events")).toBe(1);
    expect(said(t)).toMatch(/usage: wim events --json/);
    const stdin = new PassThrough();
    const u = term(devices[0]!.root, relay, { stdin }, { WIM_KIND: "editor" });
    const running = run(u, "events", "--json", "--as", "ev-test");
    await until(() => u.out.some((l) => l.includes('"type":"snapshot"')), 5000);
    const hello = JSON.parse(u.out[0]!) as Line;
    expect(hello).toMatchObject({ type: "hello", session: "ev-test@one" });
    stdin.end();
    expect(await running).toBe(0);
    expect(u.err.every((l) => !l.includes("/v1/"))).toBe(true);
    expect(relayHost("wss://relay.example:8443/base")).toBe("relay.example:8443");
    const stdin2 = new PassThrough();
    const v = term(devices[0]!.root, relay, { stdin: stdin2 });
    const plain = run(v, "events", "--json");
    await until(() => v.out.some((l) => l.includes('"type":"snapshot"')), 5000);
    expect(JSON.parse(v.out[0]!)).toMatchObject({ session: "vscode@one" });
    stdin2.end();
    expect(await plain).toBe(0);
  });
});
