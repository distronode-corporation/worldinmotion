// The extension and the Claude Code plugin each keep their own copy of parts of the client's
// contract, because neither can bundle the client. This file runs the real client against those
// copies, so a change on one side fails here instead of in front of a person:
//
// - every line the real `wim events --json` writes goes through the extension's parser and store;
// - the plugin's peer line matches the client's own `peers` text for the same sessions;
// - the extension's and the plugin's policy names, and the extension's trust dialog, match the
//   client's.

import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { MeshSession } from "../../client/src/client.ts";
import { runEvents } from "../../client/src/events.ts";
import { WimMcp } from "../../client/src/mcp.ts";
import { MeshFiles, parseMeshConfig, trustLevel } from "../../client/src/mesh.ts";
import { FS, makeMesh, openSession, RelayHarness, sessionOpts, until } from "../../client/test/helpers.ts";
import { TRUST } from "../src/actions.ts";
import { historyRows, parseLine, POLICIES } from "../src/protocol.ts";
import { Store } from "../src/state.ts";

/**
 * The plugin's pure helpers (plugins/claude-code/hooks/parse.ts), loaded at run time: the plugin
 * is typed against Claude Code's own plugin types, which this project does not have.
 */
type PluginParse = {
  ROUTE_POLICIES: readonly string[];
  parsePeers(value: unknown): unknown[];
  peerLine(peer: unknown): string;
};
const plugin = (await import(new URL("../../../plugins/claude-code/hooks/parse.ts", import.meta.url).href)) as PluginParse;

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f().catch(() => undefined);
});

describe("the real wim events output, read by the extension", () => {
  it("parses every line, keeps one held row per session, and answers requests", async () => {
    const relay = new RelayHarness();
    // Untrusted: what device two sends is held, so held events flow.
    const { mesh, devices } = await makeMesh(relay, ["one", "two"], { trust: false });
    const [one, two] = [devices[0]!, devices[1]!];
    const peer = await openSession(two, mesh, relay, { name: "peer", cwd: two.root });
    cleanup.push(() => peer.stop());
    await peer.joinRoom("#ops");
    // A live lease: its token must not make the snapshot unreadable.
    await peer.acquireLease("deploy", 60_000, false);
    const agent = await openSession(one, mesh, relay, { name: "agent" });
    cleanup.push(() => agent.stop());

    const lines: string[] = [];
    const input = new PassThrough();
    const stop = new AbortController();
    const session = await MeshSession.open({ ...sessionOpts(one, mesh, relay, { name: "vscode", kind: "vscode", cwd: one.root }), handover: true, sessionKey: "events:vscode" });
    const running = runEvents({
      session,
      mesh: new MeshFiles(one.home.meshDir(mesh), FS),
      env: FS,
      device: one.device,
      version: "test",
      write: (l) => void lines.push(l),
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

    const store = new Store();
    const responses = new Map<string, unknown>();
    let read = 0;
    /** Feeds every new line to the extension's parser and store, as process.ts does. */
    const pump = (): void => {
      for (; read < lines.length; read += 1) {
        const parsed = parseLine(lines[read]!);
        if (parsed.kind === "invalid") throw new Error(`the extension refused ${lines[read]}: ${parsed.reason}`);
        if (parsed.kind === "event") store.apply(parsed.event);
        if (parsed.kind === "response") responses.set(parsed.response.id, parsed.response.ok ? parsed.response.result : parsed.response.error);
      }
    };
    const types = (): Set<string> => new Set(lines.map((l) => (JSON.parse(l) as { type: string }).type));
    let n = 0;
    const request = async (op: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      const id = `r${++n}`;
      input.write(`${JSON.stringify({ v: 1, id, op, args })}\n`);
      await until(() => (pump(), responses.has(id)), 5000, `response ${id}`);
      return responses.get(id);
    };

    // A lease's name on the wire is a key derived from its name, so rows are found by holder.
    const leases = () => [...store.leases.values()];
    // The lease and the room membership reach the events process separately, so wait for both.
    await until(() => (pump(), leases().some((l) => l.holder === "peer@two") && store.rooms.has("#ops")), 5000, "a snapshot with the lease and the room");
    expect(typeof leases()[0]!.token).toBe("number");
    expect(store.hello?.session).toBe("vscode@one");
    expect(store.rooms.get("#ops")).toEqual(["peer@two"]);

    // One message to two local sessions is held by each of them.
    const sent = await peer.send(["vscode@one", "agent@one"], "please hold");
    await until(() => (pump(), store.held.size === 2), 5000, "two held rows");
    expect([...store.held.values()].map((h) => [h.session, h.id]).sort()).toEqual([
      ["agent@one", sent.id],
      ["vscode@one", sent.id],
    ]);

    // Leases come and go as events.
    await peer.releaseLease("deploy");
    await until(() => (pump(), leases().length === 0), 5000, "the lease released");
    await peer.acquireLease("again", 60_000, false);
    await until(() => (pump(), leases().length === 1), 5000, "the new lease");

    // Requests: approve decides both copies, history reads back, trust changes the device row.
    await request("approve", { held: sent.id });
    await until(() => (pump(), store.held.size === 0), 5000, "both held rows decided");
    expect(historyRows(await request("history", { limit: 50 })).length).toBeGreaterThan(0);
    expect(await request("trust", { device: "two" })).toEqual({ policy: "deliver" });
    await until(() => (pump(), store.devices.get("two")?.policy === "deliver"), 5000, "the device row");
    await request("snapshot");

    expect([...types()].sort()).toEqual(expect.arrayContaining(["connection", "device", "held", "hello", "lease", "message", "response", "snapshot"]));
  });
});

describe("the plugin's peer line", () => {
  it("reads as the client's own peers text for the same sessions", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const [one, two] = [devices[0]!, devices[1]!];
    const busy = await openSession(two, mesh, relay, { name: "coder", kind: "gemini-cli", cwd: two.root });
    cleanup.push(() => busy.stop());
    await busy.joinRoom("#ops");
    await busy.joinRoom("#ci");
    const quiet = await openSession(two, mesh, relay, { name: "bot", kind: "bot" });
    cleanup.push(() => quiet.stop());

    const server = new WimMcp({ channel: false, internalTools: true, version: "test", session: sessionOpts(one, mesh, relay, { name: "agent", kind: "claude-code" }) });
    cleanup.push(() => server.close());
    const call = (name: string, args: Record<string, unknown>) => server.call(name, args, undefined, async () => undefined);
    const hello = await call("_internal", { op: "hello", args: { claudeSessionId: "cc-1" } });
    const token = hello.structuredContent!["token"] as string;
    const text = (r: { content: unknown[] }): string => (r.content as { text: string }[]).map((c) => c.text).join("\n");

    await until(async () => text(await call("peers", {})).split("\n").length === 2, 5000, "both peers listed");
    const fromClient = text(await call("peers", {})).split("\n");
    const internal = await call("_internal", { op: "peers", args: {}, token });
    const fromPlugin = plugin.parsePeers(JSON.parse(text(internal))).map(plugin.peerLine);
    expect(fromPlugin).toEqual(fromClient);
    expect(fromClient.some((l) => l.includes("cwd="))).toBe(true);
    expect(fromClient.some((l) => l.includes("  -"))).toBe(true);
  });
});

describe("policy names", () => {
  // Every name any side knows, and some it must not.
  const accepted = (): string[] => {
    const candidates = [...new Set([...POLICIES, ...plugin.ROUTE_POLICIES, "deliver_relayed", "trust", "allow", ""])];
    const policy = Object.fromEntries(candidates.map((p, i) => [`dev${i}`, p]));
    const config = parseMeshConfig({ v: 1, mesh: "m", device: "self", relay: "wss://relay.example", pin: { seq: 1, hash: "h" }, policy }, "mesh.json");
    return Object.values(config.policy);
  };

  it("are the client's in the extension and the plugin", () => {
    expect([...POLICIES]).toEqual(accepted());
    expect([...plugin.ROUTE_POLICIES]).toEqual(accepted());
  });

  it("in the extension's trust dialog are the ones the client sets", () => {
    expect(TRUST.trust.policy).toBe(trustLevel("trust", false));
    expect(TRUST.trustRelayed.policy).toBe(trustLevel("trust", true));
    expect(TRUST.untrust.policy).toBe(trustLevel("untrust", false));
  });
});
