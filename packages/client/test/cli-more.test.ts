import { b64u, createJoin, generateDeviceKeys, parseInvite, ulid, type Roster } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { revokeDevice } from "../src/admin.ts";
import { MeshSession } from "../src/client.ts";
import { MeshFiles } from "../src/mesh.ts";
import type { Dialer, WireSocket } from "../src/wire.ts";
import { FS, POSIX_VIEW, makeMesh, openSession, RELAY, RelayHarness, run, said, scratch, sessionOpts, term, until, rosterSeqs } from "./helpers.ts";

describe("more command paths", () => {
  it("uses the real dialer when none is given, and reports what it cannot reach", async () => {
    const relay = new RelayHarness();
    const { devices, mesh } = await makeMesh(relay, ["one"]);
    await new MeshFiles(devices[0]!.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, relay: "ws://127.0.0.1:1", tls: "T".repeat(43) }));
    const t = term(devices[0]!.root, relay, { dialer: undefined });
    expect(await run(t, "doctor")).toBe(1);
    expect(said(t)).toMatch(/relay ws:\/\/127\.0\.0\.1:1: /);
  });

  it("logs with WIM_DEBUG, notifies through notify.json, and says when there are no peers", async () => {
    const relay = new RelayHarness();
    const { devices } = await makeMesh(relay, ["one"]);
    await fs.writeFile(join(devices[0]!.root, "notify.json"), JSON.stringify({ provider: "command", command: ["true"] }));
    const t = term(devices[0]!.root, relay, {}, { WIM_DEBUG: "1" });
    expect(await run(t, "peers")).toBe(0);
    expect(said(t)).toMatch(/No other sessions\./);
    const quiet = term(devices[0]!.root, relay);
    expect(await run(quiet, "peers")).toBe(0);
  });

  it("fails cleanly for a revoked device", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const admin = await openSession(devices[0]!, mesh, relay, { name: "a" });
    await revokeDevice(admin, "two", Date.now);
    await admin.stop();
    const t = term(devices[1]!.root, relay);
    expect(await run(t, "send", "a@one", "hi")).toBe(1);
    expect(said(t)).toMatch(/refused this device's authentication|not connected/);
    expect(await run(t, "doctor")).toBe(1);
  });

  it("creates a mesh with an operator key from the environment and a certificate pin", async () => {
    const relay = new RelayHarness({ createKey: "k" });
    const t = term(await scratch("cli-key"), relay, {}, { OPKEY: "k" });
    await run(t, "init", "--name", "box");
    expect(await run(t, "mesh", "create", "--relay", RELAY, "--key-env", "OPKEY", "--tls", "Q".repeat(43), "--no-recovery")).toBe(0);
    const ids = await fs.readdir(join(t.env["WIM_HOME"]!, "meshes"));
    const files = new MeshFiles(join(t.env["WIM_HOME"]!, "meshes", ids[0]!), FS);
    expect((await files.loadConfig()).tls).toBe("Q".repeat(43));
    // An invite from a pinned mesh carries the pin.
    const inviting = run(t, "invite", "--auto", "--exp", "1h");
    await until(() => t.out.some((l) => l.includes("wim1_")));
    const code = t.out.find((l) => l.includes("wim1_"))!.trim();
    expect(parseInvite(code).tls).toBe("Q".repeat(43));
    // A join request for an invite this device did not issue is ignored; a bad one is refused.
    const mesh = parseInvite(code).mesh;
    const foreign = createJoin({ ...parseInvite(code), secret: new Uint8Array(32).fill(9), inviteId: "Z".repeat(22) }, "x", generateDeviceKeys(), b64u.encode(new Uint8Array(32).fill(4)));
    const { t: _t, ...foreignBody } = foreign;
    relay.inject(mesh, JSON.stringify({ t: "join.request", join: foreignBody }));
    const { t: _t2, ...badBody } = createJoin(parseInvite(code), "bad", generateDeviceKeys(), b64u.encode(new Uint8Array(32).fill(4)));
    relay.inject(mesh, JSON.stringify({ t: "join.request", join: { ...badBody, proof: b64u.encode(new Uint8Array(32)) } }));
    await until(() => t.err.some((l) => l.includes("join_bad_proof")));
    t.stop.abort();
    expect(await inviting).toBe(1);
  });

  it("watches as cli by default, showing held notices and items already waiting", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"], { trust: false });
    // Something already in the cli session's spool.
    const b = await MeshSession.open({ ...sessionOpts(devices[1]!, mesh, relay, { name: "cli", kind: "cli" }), sessionKey: "cli:cli" });
    await b.spool.write({ kind: "msg", from: "x@one", device: devices[0]!.device.id, id: ulid(), at: 1, rendered: "already here" });
    await b.stop();
    const w = term(devices[1]!.root, relay);
    const watching = run(w, "watch");
    await until(() => w.out.some((l) => l.includes("already here")));
    await until(() => w.out.some((l) => l.startsWith("Watching as cli@two")));
    const a = await openSession(devices[0]!, mesh, relay, { name: "a" });
    await a.send("cli@two", "hold this");
    await until(() => w.out.some((l) => l.includes("held for the person's approval")));
    await a.stop();
    w.stop.abort();
    expect(await watching).toBe(0);
  });

  it("words held resume results and history of sessions without an address", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await new MeshFiles(devices[1]!.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, breaker: { perPeerPerHour: 1, totalPerHour: 50, pingPong: false } }));
    const t = term(devices[1]!.root, relay);
    expect(await run(t, "held", "resume")).toBe(1);
    expect(said(t)).toMatch(/usage: wim held resume <peer>/);
    const b = await MeshSession.open({ ...sessionOpts(devices[1]!, mesh, relay, { name: "b" }), sessionKey: "key:b" });
    b.start();
    await b.ready(3000);
    const a = await openSession(devices[0]!, mesh, relay, { name: "a" });
    for (const x of ["1", "2", "3"]) await a.send("b@two", x);
    await until(async () => (await b.held.list()).length === 2);
    await b.stop();
    expect(await run(t, "held", "resume", "a@one")).toBe(0);
    expect(said(t)).toMatch(/released 2 held by the breaker/);
    await a.send("b@two", "4");
    // A never-connected session with no history, and one without an address.
    const fresh = await MeshSession.open(sessionOpts(devices[1]!, mesh, relay, { name: "never" }));
    await fresh.history.append({ dir: "out", peer: "a@one", id: ulid(), kind: "msg", at: 1, text: "x" });
    await fresh.stop();
    const empty = await MeshSession.open(sessionOpts(devices[1]!, mesh, relay, { name: "empty" }));
    await empty.stop();
    expect(await run(t, "history")).toBe(0);
    expect(said(t)).toMatch(/== never \(/);
    await a.stop();
  });

  it("reports a broken mesh to the MCP client instead of failing", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const files = new MeshFiles(devices[0]!.home.meshDir(mesh), FS);
    for (const seq of await rosterSeqs(files)) await fs.rm(join(files.rostersDir, `${seq}.json`));
    const stdin = new PassThrough();
    const t = term(devices[0]!.root, relay, { stdin });
    const serving = run(t, "mcp");
    await until(() => t.err.some((l) => l.includes("pinned roster")));
    stdin.end();
    expect(await serving).toBe(0);
  });

  it("runs an outbound-only a2a gateway", async () => {
    const relay = new RelayHarness();
    const { devices } = await makeMesh(relay, ["one"]);
    const dir = await scratch("a2a-out");
    await fs.writeFile(join(dir, "out.json"), JSON.stringify({ outbound: { agents: [{ name: "ext", cardUrl: "http://127.0.0.1:1/card" }] } }));
    const t = term(devices[0]!.root, relay);
    const running = run(t, "a2a", join(dir, "out.json"));
    await until(() => t.out.some((l) => l === "a2a outbound bridge running."));
    t.stop.abort();
    expect(await running).toBe(0);
  });

  it("doctor reports a loose state directory, a caught-up roster, a fork, and a pinned relay", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"]);
    // Device two's pin is behind: it joined before three.
    const files = new MeshFiles(devices[1]!.home.meshDir(mesh), FS);
    await files.updateConfig((c) => ({ ...c, tls: "R".repeat(43) }));
    const t = term(devices[1]!.root, relay);
    expect(await run(t, "doctor")).toBe(0);
    expect(said(t)).toMatch(/caught up from/);
    // A state directory open to group and others (as a POSIX client reads Windows' mode 666).
    await fs.chmod(devices[1]!.root, 0o755);
    const loose = term(devices[1]!.root, relay, { platform: POSIX_VIEW });
    expect(await run(loose, "doctor")).toBe(1);
    expect(said(loose)).toMatch(/lets group or others in/);
    await fs.chmod(devices[1]!.root, 0o700);
    await files.updateConfig((c) => ({ ...c, fork: { seq: 2, a: "a", b: "b", base: [], at: 1 } }));
    const f = term(devices[1]!.root, relay);
    expect(await run(f, "doctor")).toBe(1);
    expect(said(f)).toMatch(/the roster forked at seq 2/);
  });

  it("recovers through a relay that allows it, confirming with the person", async () => {
    const relay = new RelayHarness();
    const { mesh, devices, recoveryCode } = await makeMesh(relay, ["lost", "two", "gone"]);
    const admin = await openSession(devices[0]!, mesh, relay, { name: "a" });
    await revokeDevice(admin, "gone", Date.now);
    await admin.stop();
    const files = new MeshFiles(devices[0]!.home.meshDir(mesh), FS);
    const chain: Roster[] = [];
    for (const seq of await rosterSeqs(files)) chain.push((await files.loadRoster(seq))!);
    const dialer: Dialer = async () => scriptedRelay(chain);
    const t = term(await scratch("cli-rec2"), relay, { dialer });
    t.answers.push("yes");
    expect(await run(t, "recover", recoveryCode!, "--relay", RELAY, "--tls", "S".repeat(43))).toBe(0);
    expect(said(t)).toMatch(/newest roster is seq \d+, signed \d{4}-\d\d-\d\dT[^,]+, with these devices/);
    expect(said(t)).toMatch(/Revoked since genesis:\n {2}gone {2}/);
    expect(said(t)).toMatch(/check this list with them/);
    expect(said(t)).toMatch(/Recovered mesh/);
    expect(said(t)).toMatch(/wimrec1_/);
    const u = term(await scratch("cli-rec3"), relay, { dialer });
    u.answers.push("no");
    expect(await run(u, "recover", recoveryCode!, "--relay", RELAY, "--revoke", "two")).toBe(1);
    expect(said(u)).toMatch(/, revoke two,/);
    expect(said(u)).toMatch(/cancelled/);
  });
});

function scriptedRelay(chain: Roster[]): WireSocket {
  let msg: (t: string) => void = () => undefined;
  let shut: (c: number, r: string) => void = () => undefined;
  const push = (f: unknown): void => void setImmediate(() => msg(JSON.stringify(f)));
  setImmediate(() => push({ t: "hello", v: 1, nonce: b64u.encode(new Uint8Array(32).fill(2)), at: Date.now() }));
  return {
    send: (text) => {
      const f = JSON.parse(text) as { t: string; from?: number; roster?: Roster };
      if (f.t === "auth") push({ t: "recover.ready", roster: chain.at(-1) });
      if (f.t === "roster.get") push({ t: "roster", chain: chain.slice(f.from! - 1), more: false });
      if (f.t === "roster.publish") push({ t: "roster", chain: [f.roster], more: false });
    },
    close: () => setImmediate(() => shut(1000, "")),
    onMessage: (cb) => void (msg = cb),
    onClose: (cb) => void (shut = cb),
  };
}
