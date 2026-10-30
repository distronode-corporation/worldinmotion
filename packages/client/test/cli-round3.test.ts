import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ulid } from "@worldinmotion/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { revokeDevice } from "../src/admin.ts";
import { closestAddress } from "../src/cli.ts";
import { MeshSession } from "../src/client.ts";
import { fsOps } from "../src/fsx.ts";
import { MeshFiles } from "../src/mesh.ts";
import { listSessions } from "../src/session.ts";
import { FS, LIVE_PID, makeMesh, openSession, RelayHarness, run, said, scratch, sessionOpts, term, until } from "./helpers.ts";

const open: Array<{ stop(): Promise<unknown> }> = [];
const realRm = fsOps.rm;
afterEach(async () => {
  fsOps.rm = realRm;
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

/**
 * A `wim watch` in "another process" (a live pid that is not this one): it says it takes
 * handed-over sends, and does unless `handover` is false (a watch that stopped taking them).
 */
async function watcher(d: Parameters<typeof sessionOpts>[0], mesh: string, relay: RelayHarness, name = "cli", handover = true): Promise<MeshSession> {
  const s = await MeshSession.open({ ...sessionOpts(d, mesh, relay, { name, kind: "cli", handover, env: { ...FS, pid: LIVE_PID } }), sessionKey: `cli:${name}` });
  open.push(s);
  await s.files.markHandover(true);
  s.start();
  await s.ready(3000);
  return s;
}

const sendsFrom = (relay: RelayHarness, sid: string) => relay.sentByClients.filter((t) => t.startsWith('{"t":"send"') && t.includes(`"sid":"${sid}"`)).length;

describe("one-off sends", () => {
  it("go out through a running wim watch, so the reply comes back to it", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const w = await watcher(devices[0]!, mesh, relay);
    const b = await openSession(devices[1]!, mesh, relay, { name: "b" });
    open.push(b);
    const before = (await listSessions(new MeshFiles(devices[0]!.home.meshDir(mesh), FS))).length;
    const t = term(devices[0]!.root, relay);
    expect(await run(t, "send", "b@two", "hello", "there")).toBe(0);
    expect(said(t)).toMatch(/b@two: routed/);
    expect(sendsFrom(relay, w.sid)).toBe(1);
    expect((await listSessions(new MeshFiles(devices[0]!.home.meshDir(mesh), FS))).length).toBe(before);
    await until(async () => (await b.spool.unread()).length === 1);
    await b.send("cli@one", "the reply");
    await until(async () => (await w.history.query()).some((e) => e.text === "the reply"));
    // An address nobody answers to on a device with live sessions gets a suggestion.
    expect(await run(t, "send", "bb@two", "x")).toBe(1);
    expect(said(t)).toMatch(/bb@two: unknown \(did you mean b@two\?\)/);
    // A refusal by the watcher comes back as the command's error.
    expect(await run(t, "send", "b@two", `sk-ant-${"x".repeat(40)}`)).toBe(1);
    expect(said(t)).toMatch(/anthropic_api_key/);
    // The person's one-send override is never handed over: this command sends it itself.
    const handed = sendsFrom(relay, w.sid);
    expect(await run(t, "send", "b@two", `sk-ant-${"x".repeat(40)}`, "--allow-secret")).toBe(0);
    expect(sendsFrom(relay, w.sid)).toBe(handed);
    // A malformed or unreadable request left in the control directory is answered, not acted on.
    await fs.writeFile(join(w.files.controlDir, `send-${ulid()}.json`), JSON.stringify({ to: 3 }));
    await fs.writeFile(join(w.files.controlDir, `send-${ulid()}.json`), "{");
    await until(async () => (await fs.readdir(w.files.controlDir)).filter((n) => n.endsWith(".done.json")).length === 2);
    // Answers are left for the CLI to read: a housekeeping pass does not touch them.
    await w.tick();
    expect((await fs.readdir(w.files.controlDir)).filter((n) => n.endsWith(".done.json")).length).toBe(2);
  });

  it("say so when the running watch does not take the send", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    await watcher(devices[0]!, mesh, relay, "cli", false);
    const t = term(devices[0]!.root, relay, { handoverMs: 100 });
    expect(await run(t, "send", "cli@one", "hi")).toBe(1);
    expect(said(t)).toMatch(/did not take the send\. Is it still connected\? Restart it if it is stuck\./);
  });

  it("says the outcome is unknown when the request it would withdraw is busy, as when the watch is taking it", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    await watcher(devices[0]!, mesh, relay, "cli", false);
    // On Windows a request that another handle is deleting cannot be removed for a moment.
    fsOps.rm = async (path) => {
      if (/send-[0-9A-Z]{26}\.json$/.test(path)) throw Object.assign(new Error("delete pending"), { code: "EPERM" });
      return realRm(path);
    };
    const t = term(devices[0]!.root, relay, { handoverMs: 100, platform: "win32" });
    expect(await run(t, "send", "cli@one", "hi")).toBe(3);
    expect(said(t)).not.toMatch(/did not take/);
  });

  it("says the outcome is unknown when the watch took the send but did not answer in time", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const w = await watcher(devices[0]!, mesh, relay);
    // The relay never answers the watch's send, so the CLI's wait runs out after the watch took it.
    relay.toRelay = (text) => (text.startsWith('{"t":"send"') ? undefined : text);
    const t = term(devices[0]!.root, relay, { handoverMs: 150 });
    expect(await run(t, "send", "cli@one", "maybe")).toBe(3);
    expect(said(t)).toMatch(/took the send but did not report back in time, so whether it went out is unknown\. Check `wim history --session cli`/);
    expect(said(t)).not.toMatch(/did not take/);
    // The answer it writes later is never collected; housekeeping removes it once it is old.
    await until(async () => (await fs.readdir(w.files.controlDir)).some((n) => n.endsWith(".done.json")), 5000);
    // A ULID from 2024, built by hand (ulid() never goes back in time within a process).
    const old = `send-01J00000000000000000000000.done.json`;
    const fresh = `send-${ulid()}.done.json`;
    await fs.writeFile(join(w.files.controlDir, old), "{}");
    await fs.writeFile(join(w.files.controlDir, fresh), "{}");
    // The session's own housekeeping (every 20 ms here) removes it; the fresh one stays.
    await until(async () => !(await fs.readdir(w.files.controlDir)).includes(old));
    expect(await fs.readdir(w.files.controlDir)).toContain(fresh);
  });

  it("without a watch, use the cli session, publish no labels, end offline, and replies wait for wim inbox", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const b = await openSession(devices[1]!, mesh, relay, { name: "b" });
    open.push(b);
    const t = term(devices[0]!.root, relay);
    expect(await run(t, "send", "b@two", "ping")).toBe(0);
    // The cli session's card, if it went out before the session ended, carries its prekey and no labels.
    for (const c of relay.sentByClients.filter((x) => x.startsWith('{"t":"card.set"'))) expect(c).not.toMatch(/"cwd"|"branch"/);
    expect(relay.sentByClients).toContain('{"t":"bye","ended":false}');
    await until(async () => (await b.spool.unread()).length === 1);
    expect((await b.send("cli@one", "pong")).results[0]!.status).toBe("queued");
    expect(await run(t, "inbox")).toBe(0);
    expect(said(t)).toMatch(/pong/);
    expect(await run(t, "inbox")).toBe(0);
    expect(said(t)).toMatch(/Nothing new for cli@one\./);
  });

  it("suggests only addresses on the same device", () => {
    expect(closestAddress("bob@two", ["bot@two", "zed@two", "bob@three"])).toBe("bot@two");
    expect(closestAddress("bob@nine", ["bot@two"])).toBeUndefined();
    expect(closestAddress("#room", ["bot@two"])).toBeUndefined();
  });
});

describe("names and takeover", () => {
  it("takes over the name an earlier one-off got, and honours WIM_NAME with --as first", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    // The old behaviour left a one-off session named cli-2 next to a watch holding cli.
    const w = await watcher(devices[0]!, mesh, relay);
    const oneOff = await MeshSession.open(sessionOpts(devices[0]!, mesh, relay, { name: "cli", kind: "cli" }));
    oneOff.start();
    await oneOff.ready(3000);
    expect(oneOff.address).toBe("cli-2@one");
    await oneOff.stop();
    await w.stop();
    const t = term(devices[0]!.root, relay);
    const watching = run(t, "watch", "--as", "cli-2");
    await until(() => t.out.some((l) => l === "Watching as cli-2@one (Ctrl-C to stop)."), 5000);
    t.stop.abort();
    expect(await watching).toBe(0);
    const n = term(devices[0]!.root, relay, {}, { WIM_NAME: "reader" });
    const named = run(n, "watch");
    await until(() => n.out.some((l) => l.startsWith("Watching as reader@one")), 5000);
    n.stop.abort();
    await named;
    const both = term(devices[0]!.root, relay, {}, { WIM_NAME: "reader" });
    const asFirst = run(both, "watch", "--as", "writer");
    await until(() => both.out.some((l) => l.startsWith("Watching as writer@one")), 5000);
    both.stop.abort();
    await asFirst;
    expect(await run(both, "watch", "--as", "Not A Name")).toBe(1);
    expect(said(both)).toMatch(/invalid name/);
  });

  it("names the reason when it cannot connect", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const admin = await openSession(devices[0]!, mesh, relay, { name: "a" });
    await revokeDevice(admin, "two", Date.now);
    await admin.stop();
    const t = term(devices[1]!.root, relay);
    expect(await run(t, "peers")).toBe(1);
    // The relay's refusal, in words the person can act on, and said once.
    const reason = "wim: the relay refused this device's authentication (this device is not in the relay's roster (it may have been revoked))";
    expect([...t.out, ...t.err].filter((l) => l.startsWith("wim: "))).toEqual([reason]);
  });

  it("runs a bot under WIM_NAME", async () => {
    const relay = new RelayHarness();
    const { devices } = await makeMesh(relay, ["one"]);
    const dir = await scratch("bot-name");
    await fs.writeFile(join(dir, "bot.json"), JSON.stringify({ model: "ollama:tiny", budget: { ledgerPath: join(dir, "l.json"), dailyTokens: 10 } }));
    const t = term(devices[0]!.root, relay, {}, { WIM_NAME: "helper" });
    const running = run(t, "bot", join(dir, "bot.json"));
    await until(() => t.out.some((l) => l.startsWith("bot running as helper@one")), 5000);
    t.stop.abort();
    expect(await running).toBe(0);
  });
});

describe("long-offline sessions in listings", () => {
  it("hides offline sessions without a card that have been gone over an hour, unless --all", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    // A one-off session that went offline two hours ago (by the relay's clock when it left).
    const gone = await MeshSession.open(sessionOpts(devices[1]!, mesh, relay, { name: "oneoff", kind: "cli" }));
    gone.start();
    await gone.ready(3000);
    relay.now = () => Date.now() - 2 * 3_600_000;
    await gone.stop();
    await new Promise((r) => setTimeout(r, 20));
    relay.now = Date.now;
    const live = await openSession(devices[1]!, mesh, relay, { name: "live" });
    open.push(live);
    const t = term(devices[0]!.root, relay);
    expect(await run(t, "peers")).toBe(0);
    expect(said(t)).not.toMatch(/oneoff@two/);
    expect(said(t)).toMatch(/\(1 long-offline session\(s\) without a card hidden; --all shows them\)/);
    expect(await run(t, "peers", "--all")).toBe(0);
    expect(said(t)).toMatch(/oneoff@two {2}cli {2}offline/);
    const { WimMcp } = await import("../src/mcp.ts");
    const server = new WimMcp({ session: sessionOpts(devices[0]!, mesh, relay, { name: "agent" }), channel: false, internalTools: false, version: "t" });
    open.push({ stop: () => server.close() });
    await (await server.start())!.ready(3000);
    const notify = async () => undefined;
    const hidden = await server.call("peers", {}, undefined, notify);
    expect(JSON.stringify(hidden.content)).not.toMatch(/oneoff/);
    const shown = await server.call("peers", { all: true }, undefined, notify);
    expect(JSON.stringify(shown.content)).toMatch(/oneoff@two/);
  });
});

describe("short commands next to a running watch", () => {
  it("peers takes a throwaway session that ends, inbox defers to the watch, and a second watch is refused", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    await watcher(devices[0]!, mesh, relay);
    const t = term(devices[0]!.root, relay);
    expect(await run(t, "peers")).toBe(0);
    expect(relay.sentByClients).toContain('{"t":"bye","ended":true}');
    // Nothing lingers: the throwaway session is not listed afterwards.
    const after = term(devices[0]!.root, relay);
    await run(after, "peers", "--all");
    expect(said(after)).not.toMatch(/cli-\d+@one/);
    expect(await run(t, "inbox")).toBe(0);
    expect(said(t)).toMatch(/A `wim watch` is reading as cli on this device/);
    expect(await run(t, "watch")).toBe(1);
    expect(said(t)).toMatch(/already reading as cli/);
  });
});
