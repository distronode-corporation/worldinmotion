// `wim events --json` adding a device (docs/events.md): `invite` and `admit` on an admin device,
// `join` events for waiting requests, and setup mode, where a device in no mesh yet joins one.

import { promises as fs } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { joinMesh } from "../src/admin.ts";
import { MeshSession } from "../src/client.ts";
import { runEvents, runSetupEvents } from "../src/events.ts";
import { Home } from "../src/home.ts";
import { MeshFiles } from "../src/mesh.ts";
import { FS, makeMesh, newDevice, RelayHarness, run, said, scratch, sessionOpts, term, until, type TestDevice } from "./helpers.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f().catch(() => undefined);
});

type Line = Record<string, unknown> & { type: string };

function harness() {
  const lines: Line[] = [];
  const input = new PassThrough();
  const stop = new AbortController();
  let n = 0;
  const request = async (op: string, args?: Record<string, unknown>): Promise<Line> => {
    const id = `r${++n}`;
    input.write(`${JSON.stringify({ v: 1, id, op, ...(args === undefined ? {} : { args }) })}\n`);
    await until(() => lines.some((l) => l.type === "response" && l["id"] === id), 5000, `response ${id}`);
    return lines.find((l) => l.type === "response" && l["id"] === id)!;
  };
  const of = (type: string): Line[] => lines.filter((l) => l.type === type);
  return { lines, input, stop, request, of, write: (l: string) => void lines.push(JSON.parse(l) as Line) };
}

async function start(d: TestDevice, mesh: string, relay: RelayHarness, agent?: string) {
  const h = harness();
  const session = await MeshSession.open({ ...sessionOpts(d, mesh, relay, { name: "vscode", kind: "vscode" }), sessionKey: "events:vscode" });
  const running = runEvents({
    session,
    mesh: new MeshFiles(d.home.meshDir(mesh), FS),
    env: FS,
    device: d.device,
    version: "test",
    write: h.write,
    input: h.input,
    signal: h.stop.signal,
    now: Date.now,
    pollMs: 20,
    leasePollMs: 1000,
    ...(agent === undefined ? {} : { agent }),
  });
  cleanup.push(async () => {
    h.stop.abort();
    await running;
    await session.stop();
  });
  await until(() => h.of("snapshot").length > 0, 5000, "first snapshot");
  return h;
}

function setup(home: Home, relay: RelayHarness, agent?: string) {
  const h = harness();
  const running = runSetupEvents({
    home,
    defaultName: "fresh",
    dialer: relay.dialer,
    version: "test",
    write: h.write,
    input: h.input,
    signal: h.stop.signal,
    now: Date.now,
    ...(agent === undefined ? {} : { agent }),
  });
  cleanup.push(async () => {
    h.stop.abort();
    await running;
  });
  return { ...h, running };
}

describe("adding a device through wim events", () => {
  it("invites, shows a waiting request without its code, and admits it by the code typed", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["admin"]);
    const e = await start(devices[0]!, mesh, relay);
    expect(e.of("snapshot")[0]!["joins"]).toEqual([]);
    expect(await e.request("invite", { exp: 10 })).toMatchObject({ ok: false, error: { code: "input" } });
    expect(await e.request("invite")).toMatchObject({ ok: true, result: { exp: expect.any(Number) } });
    const made = await e.request("invite", { exp: 600_000 });
    expect(made).toMatchObject({ ok: true, result: { code: expect.stringMatching(/^wim1_/), invite: expect.any(String), exp: expect.any(Number) } });
    const joiner = await newDevice("newbox");
    let sas = "";
    const joined = joinMesh({ home: joiner.home, device: joiner.device, code: (made["result"] as { code: string }).code, dialer: relay.dialer, now: Date.now, showSas: (s) => (sas = s) });
    await until(() => e.of("join").length > 0);
    const [added] = e.of("join");
    expect(added).toMatchObject({ op: "add", request: { name: "newbox", id: joiner.device.id, invite: (made["result"] as { invite: string }).invite } });
    expect(JSON.stringify(e.lines)).not.toContain(sas);
    const snap = await e.request("snapshot");
    expect(snap["ok"]).toBe(true);
    expect(e.of("snapshot").at(-1)!["joins"]).toEqual([expect.objectContaining({ name: "newbox" })]);
    expect(await e.request("admit", { device: "newbox", code: "AAAAA-AAAAA" })).toMatchObject({ ok: false, error: { code: "mismatch" } });
    expect(await e.request("admit", { device: "newbox", code: sas })).toMatchObject({ ok: true, result: { device: "newbox" } });
    await joined;
    expect(e.of("join").at(-1)).toMatchObject({ op: "remove", request: { name: "newbox" } });
    await until(() => e.of("device").some((d) => d["name"] === "newbox"));
  }, 20_000);

  it("refuses an admit the client refuses, and keeps going when the join requests do not read", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["admin"]);
    const e = await start(devices[0]!, mesh, relay);
    const twin = async (code: string) => {
      const d = await newDevice("twin");
      let sas = "";
      const done = joinMesh({ home: d.home, device: d.device, code, dialer: relay.dialer, now: Date.now, showSas: (s) => (sas = s) });
      done.catch(() => undefined);
      await until(() => sas !== "");
      return { sas, done };
    };
    const one = await twin(((await e.request("invite"))["result"] as { code: string }).code);
    const two = await twin(((await e.request("invite"))["result"] as { code: string }).code);
    await until(() => e.of("join").filter((j) => j["op"] === "add").length === 2);
    expect(await e.request("admit", { device: "twin", code: one.sas })).toMatchObject({ ok: true });
    await one.done;
    expect(await e.request("admit", { device: "twin", code: two.sas })).toMatchObject({ ok: false, error: { code: "refused", message: "could not admit twin: the name twin is taken" } });
    // The requests' folder becomes a file: each poll's join pass fails, and the next one still runs.
    // A message shows at the start of a pass; once a second one shows, the pass after the first ended.
    const files = new MeshFiles(devices[0]!.home.meshDir(mesh), FS);
    await fs.rm(files.joinsDir, { recursive: true, force: true });
    await fs.writeFile(files.joinsDir, "not a folder");
    const peer = await MeshSession.open({ ...sessionOpts(devices[0]!, mesh, relay, { name: "peer" }) });
    peer.start();
    await peer.ready(3000);
    cleanup.push(() => peer.stop({ ended: true }));
    for (const text of ["one", "two"]) {
      await peer.send("vscode@admin", text);
      await until(() => e.of("message").some((m) => m["text"] === text && m["dir"] === "in"));
    }
    await fs.rm(files.joinsDir, { force: true });
  }, 20_000);

  it("refuses invite, admit and join to an events process an agent started", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["admin"]);
    const e = await start(devices[0]!, mesh, relay, "CLAUDECODE");
    expect(await e.request("invite")).toMatchObject({ ok: false, error: { code: "refused", message: expect.stringMatching(/inviting a device is the person's/) } });
    expect(await e.request("admit", { device: "x", code: "AAAAA-AAAAA" })).toMatchObject({ ok: false, error: { code: "refused" } });
    const s = setup(new Home(await scratch("agent-setup"), { ...FS, uid: process.getuid?.() }), relay, "CLAUDECODE");
    expect(await s.request("join", { code: "wim1_x" })).toMatchObject({ ok: false, error: { code: "refused", message: expect.stringMatching(/joining a mesh is the person's/) } });
  });
});

describe("setup mode", () => {
  it("joins a mesh from a device with no keys yet, then ends", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["admin", "member"]);
    const admin = await MeshSession.open({ ...sessionOpts(devices[0]!, mesh, relay, { name: "a" }) });
    admin.start();
    await admin.ready(3000);
    cleanup.push(() => admin.stop({ ended: true }));
    const { issueInvite, admitPending } = await import("../src/admin.ts");
    const inv = await issueInvite(admin, { ttlMs: 600_000, auto: false, now: Date.now });
    const home = new Home(await scratch("setup"), { ...FS, uid: process.getuid?.() });
    const s = setup(home, relay);
    await until(() => s.of("setup").length > 0);
    expect(s.of("setup")[0]).toMatchObject({ v: 1, version: "test", device: null });
    expect(await s.request("snapshot")).toMatchObject({ ok: false, error: { code: "setup" } });
    s.input.write("not json\n");
    s.input.write(`${JSON.stringify({ v: 2, id: "x", op: "join" })}\n`);
    expect(await s.request("join")).toMatchObject({ ok: false, error: { code: "input" } });
    s.input.write("   \n");
    expect(await s.request("join", { code: "wim1_nonsense" })).toMatchObject({ ok: false, error: { code: "input" } });
    expect(await home.loadDevice()).toBeUndefined();
    expect(s.of("response").filter((r) => r["id"] === undefined).length).toBe(2);
    // No name: the device takes the default one.
    const answer = await s.request("join", { code: inv.code });
    expect(answer).toMatchObject({ ok: true, result: { device: { name: "fresh" }, code: expect.stringMatching(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/) } });
    expect(await s.request("join", { code: inv.code })).toMatchObject({ ok: false, error: { code: "busy" } });
    await admin.listPeers();
    await admin.settled();
    await admitPending(admin, "fresh", (answer["result"] as { code: string }).code, Date.now);
    await s.running;
    expect(s.of("joined")[0]).toMatchObject({ mesh: `${mesh.slice(0, 4)}…`, devices: [{ name: "admin" }, { name: "member" }] });
  }, 20_000);

  it("reports a join that fails after its code was shown, and can try again", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["admin"]);
    const admin = await MeshSession.open({ ...sessionOpts(devices[0]!, mesh, relay, { name: "a" }) });
    admin.start();
    await admin.ready(3000);
    cleanup.push(() => admin.stop({ ended: true }));
    const { issueInvite } = await import("../src/admin.ts");
    const inv = await issueInvite(admin, { ttlMs: 600_000, auto: false, now: Date.now });
    const d = await newDevice("known");
    const s = setup(d.home, relay);
    await until(() => s.of("setup").length > 0);
    expect(s.of("setup")[0]).toMatchObject({ device: { name: "known", id: d.device.id } });
    expect(await s.request("join", { code: inv.code })).toMatchObject({ ok: true, result: { device: { name: "known" } } });
    // The relay goes away while the device waits for an admin.
    relay.dropAll(1006);
    await until(() => s.of("join_failed").length > 0);
    expect(s.of("join_failed")[0]).toMatchObject({ message: expect.any(String) });
    expect(await s.request("join", { code: inv.code })).toMatchObject({ ok: true });
    s.input.end();
    await s.running;
  }, 20_000);

  it("says a join that fails before its code is shown, or one for a mesh this device is in, and ends on an aborted signal", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["admin"]);
    const admin = await MeshSession.open({ ...sessionOpts(devices[0]!, mesh, relay, { name: "a" }) });
    admin.start();
    await admin.ready(3000);
    cleanup.push(() => admin.stop({ ended: true }));
    const { issueInvite } = await import("../src/admin.ts");
    const inv = await issueInvite(admin, { ttlMs: 600_000, auto: false, now: Date.now });
    // The relay cannot be reached: refused before any code, and the next try still runs.
    const home = new Home(await scratch("setup-down"), { ...FS, uid: process.getuid?.() });
    const s = setup(home, relay);
    relay.down = true;
    expect(await s.request("join", { code: inv.code, name: "named" })).toMatchObject({ ok: false, error: { code: "error" } });
    expect((await home.loadDevice())?.name).toBe("named");
    relay.down = false;
    // A device already in the mesh the code is for.
    const mine = setup(devices[0]!.home, relay);
    expect(await mine.request("join", { code: inv.code })).toMatchObject({ ok: false, error: { code: "error", message: expect.stringMatching(/already in that mesh/) } });
    // An aborted signal ends it at once.
    const stop = new AbortController();
    stop.abort();
    await runSetupEvents({ home, defaultName: "x", dialer: relay.dialer, version: "t", write: () => undefined, input: new PassThrough(), signal: stop.signal, now: Date.now });
  }, 20_000);

  it("is what `wim events --json` runs on a device in no mesh, and refuses an agent's invite in a mesh", async () => {
    const relay = new RelayHarness();
    const t = term(await scratch("events-setup"), relay);
    const stdin = new PassThrough();
    t.io.stdin = stdin;
    const running = run(t, "events", "--json");
    await until(() => t.out.some((l) => l.includes('"type":"setup"')));
    stdin.end();
    expect(await running).toBe(0);
    const agent = term(await scratch("events-agent"), relay, {}, { CLAUDECODE: "1" });
    const agentIn = new PassThrough();
    agent.io.stdin = agentIn;
    const agentRun = run(agent, "events", "--json");
    agentIn.write(`${JSON.stringify({ v: 1, id: "j", op: "join", args: { code: "wim1_x" } })}\n`);
    await until(() => agent.out.some((l) => l.includes('"refused"')));
    agentIn.end();
    expect(await agentRun).toBe(0);
    // In a mesh, an events process an agent started refuses `invite`.
    const { devices } = await makeMesh(relay, ["admin"]);
    const inMesh = term(devices[0]!.root, relay, {}, { CLAUDECODE: "1" });
    const meshIn = new PassThrough();
    inMesh.io.stdin = meshIn;
    const meshRun = run(inMesh, "events", "--json");
    await until(() => inMesh.out.some((l) => l.includes('"type":"snapshot"')));
    meshIn.write(`${JSON.stringify({ v: 1, id: "i", op: "invite" })}\n`);
    await until(() => inMesh.out.some((l) => l.includes('"refused"')));
    meshIn.end();
    expect(await meshRun).toBe(0);
    void said;
  });
});
