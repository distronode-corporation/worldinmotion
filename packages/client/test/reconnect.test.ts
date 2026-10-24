// The live finding: a session that lost its relay connection. These pin down what happens on a
// drop (b), and that a second process for the same session key cannot take the session over (a).

import { afterEach, describe, expect, it } from "vitest";
import { MeshSession } from "../src/client.ts";
import { WimMcp } from "../src/mcp.ts";
import { makeMesh, openSession, RelayHarness, sessionOpts, sleep, until } from "./helpers.ts";

const open: Array<{ stop(): Promise<unknown> }> = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

describe("connection loss and takeover", () => {
  it("(b) logs the close code, reconnects at once, and a send during the drop waits and goes through", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const logs: string[] = [];
    const a = await openSession(devices[0]!, mesh, relay, { name: "a", log: (l) => logs.push(l), reconnectMs: 2000 });
    const b = await openSession(devices[1]!, mesh, relay, { name: "b" });
    open.push(a, b);
    // The edge drops the socket, and the relay is unreachable for a moment.
    relay.down = true;
    relay.dropAll(1006);
    const sending = a.send("b@two", "sent across the drop");
    await sleep(100);
    relay.down = false;
    // The immediate retry failed while the relay was down; the next one, after a backoff, works.
    expect((await sending).results[0]!.status).toBe("routed");
    await until(async () => (await b.spool.unread()).length === 1, 5000);
    expect(logs).toContain("wim: connection closed (code 1006, dropped)");
    expect(logs).toContain("wim: reconnecting in 0 ms");
    expect(logs.some((l) => /^wim: connected as a \(sid /.test(l))).toBe(true);
    // Only the host and a mesh id prefix: hosts keep MCP stderr in log files.
    expect(logs.some((l) => /^wim: connecting to ws:\/\/127\.0\.0\.1:4444 \(mesh [A-Za-z0-9_-]{4}…\) \(attempt 2\)$/.test(l))).toBe(true);
    expect(logs.some((l) => l.includes(mesh))).toBe(false);
  });

  it("(b) resends a frame whose connection closed before the relay answered", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const logs: string[] = [];
    const a = await openSession(devices[0]!, mesh, relay, { name: "a", log: (l) => logs.push(l) });
    const b = await openSession(devices[1]!, mesh, relay, { name: "b" });
    open.push(a, b);
    let dropped = false;
    relay.toRelay = (text) => {
      if (!dropped && text.startsWith('{"t":"send"')) {
        dropped = true;
        setImmediate(() => relay.dropAll(1001));
        return undefined;
      }
      return text;
    };
    const out = await a.send("b@two", "once");
    expect(out.results[0]!.status).toBe("routed");
    expect(logs.some((l) => l.includes("sending again after reconnecting"))).toBe(true);
    await until(async () => (await b.spool.unread()).length === 1);
  });

  it("(a) a second process with the same Claude session id starts fresh and does not disturb the first", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const logsA: string[] = [];
    const first = new WimMcp({ session: sessionOpts(devices[0]!, mesh, relay, { name: "agent", log: (l) => logsA.push(l) }), channel: false, internalTools: true, version: "t" });
    open.push({ stop: () => first.close() });
    await first.start();
    const helloA = await first.call("_internal", { op: "hello", args: { claudeSessionId: "cc-live" } }, undefined, async () => undefined);
    const sidA = helloA.structuredContent!["sid"];
    await first.current!.ready(3000);
    // The second process (another pid) asks for the same Claude session.
    const second = new WimMcp({ session: sessionOpts(devices[0]!, mesh, relay, { name: "agent", env: { platform: "linux", pid: 1 } }), channel: false, internalTools: true, version: "t" });
    open.push({ stop: () => second.close() });
    await second.start();
    const helloB = await second.call("_internal", { op: "hello", args: { claudeSessionId: "cc-live" } }, undefined, async () => undefined);
    expect(helloB.structuredContent!["sid"]).not.toBe(sidA);
    await second.current!.ready(3000);
    expect(second.current!.address).toBe("agent-2@one");
    await sleep(50);
    expect(logsA.some((l) => l.includes("took over"))).toBe(false);
    expect(first.current!.link?.isOpen).toBe(true);
    const peer = await openSession(devices[1]!, mesh, relay, { name: "peer" });
    open.push(peer);
    expect((await peer.send("agent@one", "still you?")).results[0]!.status).toBe("routed");
  });

  it("logs a notice it cannot write, holds presence while offline, and times out a send the relay ignores", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const logs: string[] = [];
    const s = await openSession(devices[0]!, mesh, relay, { name: "x", log: (l) => logs.push(l), answerMs: 200, reconnectMs: 60_000 });
    open.push(s);
    const { promises: fs } = await import("node:fs");
    await fs.mkdir(s.files.spoolDir, { recursive: true });
    await fs.chmod(s.files.spoolDir, 0o500);
    relay.inject(mesh, JSON.stringify({ t: "notice", kind: "idle", of: "y@one" }));
    await until(() => logs.some((l) => l.startsWith("wim: notice: ")));
    // A sweep that cannot read the spool fails that pass only; the next one runs.
    await fs.chmod(s.files.spoolDir, 0o000);
    const sweep = (s as unknown as { sweep(): Promise<void> }).sweep.bind(s);
    await expect(sweep()).rejects.toThrow();
    await fs.chmod(s.files.spoolDir, 0o700);
    await sweep();
    relay.toRelay = (text) => (text.startsWith('{"t":"send"') ? undefined : text);
    await expect(s.send("x@one", "into the void")).rejects.toThrow(/did not answer in time/);
    relay.toRelay = undefined;
    relay.down = true;
    relay.dropAll(1006);
    await sleep(20);
    await fs.writeFile(s.files.presencePath, "busy");
    await s.tick();
    expect(relay.sentByClients.filter((t) => t.includes('"presence"')).length).toBe(0);
  });

  it("logs the full URL only when debugging, and redacts every other form", async () => {
    const { redactUrl } = await import("../src/wire.ts");
    expect(redactUrl("wss://relay.example/base/v1/abcdefghijklmnopqrstuv")).toBe("wss://relay.example (mesh abcd…)");
    expect(redactUrl("not a url")).toBe("the relay");
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const logs: string[] = [];
    const s = await openSession(devices[0]!, mesh, relay, { name: "dbg", debug: true, log: (l) => logs.push(l) });
    open.push(s);
    expect(logs.some((l) => l.includes(`/v1/${mesh}`))).toBe(true);
  });

  it("a connection another one took over is reported and not retried", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const logs: string[] = [];
    const s = await MeshSession.open(sessionOpts(devices[0]!, mesh, relay, { name: "x", log: (l) => logs.push(l) }));
    open.push(s);
    s.start();
    await s.ready(3000);
    relay.dropAll(4009);
    await until(() => logs.some((l) => l === "wim: not reconnecting: another connection took over this session (dropped)"));
    await expect(s.ready(50)).rejects.toThrow(/took over/);
  });
});
