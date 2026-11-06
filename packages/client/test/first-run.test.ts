// Issue #65, the points a first-time tester trips on: `wim status`, the wait in `wim init` when it
// cannot show the recovery code, the `recovery` admin in `wim devices`, and deleting a mesh. Only
// the person at their own terminal deletes a mesh: every agent path is tried here too.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { CLOSE } from "@worldinmotion/protocol";
import { createMesh, deleteMesh, forgetMesh } from "../src/admin.ts";
import { commandUsage } from "../src/cli.ts";
import { MeshSession } from "../src/client.ts";
import { Home } from "../src/home.ts";
import { runEvents } from "../src/events.ts";
import { INTERNAL_OPS, PUBLIC_TOOLS, WimMcp } from "../src/mcp.ts";
import { MeshFiles } from "../src/mesh.ts";
import { FATAL_CLOSE, UNKNOWN_MESH } from "../src/wire.ts";
import { FS, makeMesh, openSession, RELAY, RelayHarness, run, said, scratch, sessionOpts, term, until, type Term } from "./helpers.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f().catch(() => undefined);
});

/** What a relay's `/v1/info` answers, with `idle` as its idle days. */
function infoFetch(idle: number | null): typeof fetch {
  const body = { v: 1, software: "worldinmotion-relay", version: "0.1.9", create: "open", limits: { max_meshes: 2000, idle_mesh_days: idle, blob_bytes_per_mesh_per_day: 26214400 }, offer: null };
  return (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

/** Whether the relay still holds the mesh: a session of `d` can connect to it. */
async function meshLives(relay: RelayHarness, mesh: string): Promise<boolean> {
  return relay.relay(mesh).exists();
}

/** What a Home on this machine reads, as the CLI builds it. */
const HOME_ENV = { ...FS, uid: process.getuid?.() };

const exists = (path: string): Promise<boolean> => fs.stat(path).then(() => true, () => false);

describe("wim status", () => {
  it("sums up doctor for an admin alone: connected, no other device yet, the next step and the relay's idle time", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["solo"]);
    const t = term(devices[0]!.root, relay, { fetch: infoFetch(30) });
    expect(await run(t, "status")).toBe(0);
    expect(t.out).toEqual([
      `This device is solo (id ${devices[0]!.device.id}).`,
      `Mesh ${mesh} on ${RELAY}:`,
      "  connected as an admin; roster seq 1; other devices: 0; other sessions online now: 0.",
      "  Next: `wim invite` adds another device. Until one joins, `wim peers` shows no other sessions, which is expected.",
      "  The relay deletes it after 30 days with no device connected. An admin can delete it sooner: `wim mesh delete`.",
      "Everything checks out. `wim doctor` shows each check.",
    ]);
    expect(commandUsage("status")).toBe("wim status | wim doctor");
    // A relay that keeps idle meshes, and one that does not say.
    const keeps = term(devices[0]!.root, relay, { fetch: infoFetch(null) });
    expect(await run(keeps, "status")).toBe(0);
    expect(said(keeps)).toContain("  The relay keeps a mesh nobody uses. An admin can delete it sooner: `wim mesh delete`.");
    const silent = term(devices[0]!.root, relay);
    expect(await run(silent, "status")).toBe(0);
    expect(said(silent)).toContain("  The relay does not say how long it keeps a mesh nobody uses.");
  });

  it("shows a member its other devices and who is online, and leaves out the next-step line", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const live = await openSession(devices[0]!, mesh, relay, { name: "busy" });
    cleanup.push(() => live.stop());
    const t = term(devices[1]!.root, relay);
    expect(await run(t, "status")).toBe(0);
    expect(said(t)).toContain("  connected as a member; roster seq 2; other devices: 1; other sessions online now: 1.");
    expect(said(t)).not.toContain("Next: `wim invite`");
  });

  it("puts problems first and exits 1: a relay it cannot reach, and a device not set up", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    relay.down = true;
    const t = term(devices[0]!.root, relay);
    expect(await run(t, "status")).toBe(1);
    expect(t.out[0]).toMatch(/^problem  mesh .* connect ECONNREFUSED/);
    expect(said(t)).toContain(`Mesh ${mesh} on ${RELAY}:\n  not connected: the problem above says why.`);
    expect(t.out.at(-1)).toBe("Problems: 1, above. `wim doctor` shows each check.");
    const empty = term(await scratch("status-none"), relay);
    expect(await run(empty, "status")).toBe(1);
    expect(empty.out[0]).toMatch(/^problem  not set up yet, no device keys at .*: run `wim init`, or `wim join <code>` with an invite$/);
    expect(said(empty)).not.toContain("This device is");
    // Keys and no mesh yet.
    const fresh = term(await scratch("status-fresh"), relay);
    expect(await run(fresh, "init", "--name", "fresh")).toBe(0);
    expect(await run(fresh, "status")).toBe(0);
    expect(said(fresh)).toContain("It is in no mesh yet: `wim mesh create --relay <url>` makes one, or `wim join <code>` joins one with an invite.");
  });

  it("is the last line of init, mesh create and join", async () => {
    const relay = new RelayHarness();
    const a = term(await scratch("status-init"), relay);
    expect(await run(a, "init", "--name", "first", "--relay", RELAY, "--no-recovery")).toBe(0);
    expect(a.out.at(-1)).toBe("Check this device and its mesh at any time with `wim status`.");
  });
});

describe("wim init, when it cannot show the recovery code", () => {
  it("says it keeps running for up to 10 minutes, why, and that `wim recovery rotate` replaces a code it lost", async () => {
    const relay = new RelayHarness();
    const home = await scratch("init-wait");
    const agent = term(home, relay, { isTTY: false }, { CLAUDECODE: "1" });
    const creating = run(agent, "init", "--name", "box", "--relay", RELAY);
    await until(() => agent.out.some((l) => l.includes("keeps running")), 5000);
    expect(said(agent)).toContain(
      "This command keeps running, for up to 10 minutes, until the code is collected: only this process holds it. If it is stopped before then, the code is gone; run `wim recovery rotate` on this device, in your own terminal, for a new one.",
    );
    agent.stop.abort();
    expect(await creating).toBe(130);
    expect(said(agent)).toContain("The recovery code was not collected and is gone; make a new one from an admin device with `wim recovery rotate`.");
    expect(agent.out.at(-1)).toBe("Check this device and its mesh at any time with `wim status`.");
  }, 20_000);
});

describe("wim devices", () => {
  it("explains the recovery record in one line, and only when the mesh has one", async () => {
    const relay = new RelayHarness();
    const { devices } = await makeMesh(relay, ["one"]);
    const t = term(devices[0]!.root, relay);
    expect(await run(t, "devices")).toBe(0);
    expect(t.out.filter((l) => l.startsWith("recovery  admin  "))).toHaveLength(1);
    expect(t.out.at(-1)).toBe(
      "(recovery: not a machine. It is the mesh's recovery code, an admin record that never connects, so nothing ever comes from it and its policy reads hold. Keep the code offline; `wim recovery rotate` replaces it.)",
    );
    const bare = term(await scratch("devices-bare"), relay);
    expect(await run(bare, "init", "--name", "bare", "--relay", RELAY, "--no-recovery")).toBe(0);
    bare.out.length = 0;
    expect(await run(bare, "devices")).toBe(0);
    expect(said(bare)).not.toContain("recovery");
  });
});

/** Every agent-driven or non-interactive way to run a command. */
const NOT_A_PERSON: Array<{ what: string; io: { isTTY: boolean; inputIsTTY: boolean }; env: Record<string, string> }> = [
  { what: "Claude Code's shell", io: { isTTY: true, inputIsTTY: true }, env: { CLAUDECODE: "1" } },
  { what: "a Claude Code session id", io: { isTTY: true, inputIsTTY: true }, env: { CLAUDE_CODE_SESSION_ID: "abc" } },
  { what: "the AI_AGENT marker", io: { isTTY: true, inputIsTTY: true }, env: { AI_AGENT: "x" } },
  { what: "a Codex variable", io: { isTTY: true, inputIsTTY: true }, env: { CODEX_SANDBOX: "seatbelt" } },
  { what: "an answer piped into stdin", io: { isTTY: true, inputIsTTY: false }, env: {} },
  { what: "output piped away", io: { isTTY: false, inputIsTTY: true }, env: {} },
  { what: "a terminal-looking environment over pipes", io: { isTTY: false, inputIsTTY: false }, env: { TERM: "xterm-256color", FORCE_TTY: "1", WIM_PERSON: "1" } },
];

describe("wim mesh delete", () => {
  it("deletes the mesh at the relay for every device, then this device's copy; another device then removes its own", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const watching = await openSession(devices[1]!, mesh, relay, { name: "watcher" });
    const fatal = new Promise<string>((resolve) => watching.once("fatal", resolve));
    cleanup.push(() => watching.stop());
    const t = term(devices[0]!.root, relay);
    t.answers.push("yes");
    expect(await run(t, "mesh", "delete")).toBe(0);
    expect(said(t)).toContain(`Deleting mesh ${mesh} on ${RELAY}, for every device in it:`);
    expect(said(t)).toContain(`  one  admin  ${devices[0]!.device.id}  this device`);
    expect(said(t)).toContain(`  two  member  ${devices[1]!.device.id}`);
    expect(said(t)).not.toMatch(/^ {2}recovery/m);
    expect(said(t)).toContain("There is no undo");
    expect(said(t)).toContain(`Delete mesh ${mesh}? [y/N] `);
    expect(t.out.at(-1)).toBe(`Deleted mesh ${mesh} at the relay, and this device's copy. On each other device, \`wim mesh delete\` removes its copy.`);
    // Nothing about the relay's own close reached this terminal.
    expect(t.err).toEqual([]);
    expect(await meshLives(relay, mesh)).toBe(false);
    expect(await exists(devices[0]!.home.meshDir(mesh))).toBe(false);
    expect(await exists(devices[0]!.home.devicePath)).toBe(true);
    // The other device's live session was closed for good, and says why.
    expect(await fatal).toBe(`${FATAL_CLOSE.get(CLOSE.deleted)!} (mesh deleted)`);
    // There, the relay no longer knows the mesh: `wim mesh delete` removes that device's copy.
    const b = term(devices[1]!.root, relay);
    b.answers.push("y");
    expect(await run(b, "mesh", "delete")).toBe(0);
    expect(said(b)).toContain(`The relay ${RELAY} does not hold mesh ${mesh}: an admin deleted it, or it went unused for the relay's idle time, or this device has the wrong relay URL.`);
    expect(said(b)).toContain(`Remove this device's copy of mesh ${mesh}? [y/N] `);
    expect(b.out.at(-1)).toBe(`Removed this device's copy of mesh ${mesh}.`);
    expect(await exists(devices[1]!.home.meshDir(mesh))).toBe(false);
    expect(await run(b, "status")).toBe(0);
    expect(said(b)).toContain("It is in no mesh yet");
  }, 30_000);

  it("is refused to every non-person before anything is read, shown or asked, and the mesh stays", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    for (const h of NOT_A_PERSON) {
      const t: Term = term(devices[0]!.root, relay, h.io, h.env);
      t.answers.push("y", "y");
      expect(await run(t, "mesh", "delete"), h.what).toBe(1);
      expect(said(t), h.what).toContain("run `wim mesh delete` there");
      expect(t.answers.length, h.what).toBe(2);
      expect(said(t), h.what).not.toContain("[y/N]");
      expect(said(t), h.what).not.toContain("Deleting mesh");
    }
    expect(await meshLives(relay, mesh)).toBe(true);
    expect(await exists(devices[0]!.home.meshDir(mesh))).toBe(true);
  }, 30_000);

  it("changes nothing unless the person types yes, and refuses a member and bad usage", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const t = term(devices[0]!.root, relay);
    for (const answer of ["", "n", "no", "yess", "sure"]) {
      t.answers.push(answer);
      expect(await run(t, "mesh", "delete")).toBe(1);
    }
    expect(t.err.filter((l) => l === "wim: nothing changed.")).toHaveLength(5);
    expect(await meshLives(relay, mesh)).toBe(true);
    const member = term(devices[1]!.root, relay);
    member.answers.push("y");
    expect(await run(member, "mesh", "delete")).toBe(1);
    expect(said(member)).toContain("only an admin device can delete the mesh, and this device is a member");
    expect(member.answers).toEqual(["y"]);
    for (const argv of [["mesh", "delete", "now"], ["mesh", "delete", "--relay", RELAY], ["mesh", "drop"]]) {
      expect(await run(t, ...argv), argv.join(" ")).toBe(1);
    }
    expect(said(t)).toContain("usage: wim mesh delete [--mesh <id>]");
    expect(said(t)).toContain("usage: wim mesh create --relay <url> | wim mesh delete");
    expect(commandUsage("mesh")).toBe("wim mesh create --relay <url> [--key-env NAME] [--tls <pin>] [--no-recovery] | wim mesh delete");
    expect(await meshLives(relay, mesh)).toBe(true);
    expect(await exists(devices[1]!.home.meshDir(mesh))).toBe(true);
  }, 30_000);

  it("keeps the local copy of a mesh the relay does not hold when the person says no, and reports other failures", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    // The relay lost the mesh (as after its idle time).
    relay.relays.delete(mesh);
    const t = term(devices[0]!.root, relay);
    t.answers.push("n");
    expect(await run(t, "mesh", "delete")).toBe(1);
    expect(await exists(devices[0]!.home.meshDir(mesh))).toBe(true);
    expect(UNKNOWN_MESH).toContain("`wim mesh delete` removes this device's copy");
    // A relay that cannot be reached is not a mesh that is gone.
    relay.down = true;
    expect(await run(t, "mesh", "delete")).toBe(1);
    expect(said(t)).toContain("connect ECONNREFUSED");
    expect(await exists(devices[0]!.home.meshDir(mesh))).toBe(true);
  }, 30_000);

  it("says so when the relay cannot delete meshes or refuses, and keeps everything", async () => {
    const relay = new RelayHarness({ deletes: false });
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const t = term(devices[0]!.root, relay);
    t.answers.push("y");
    expect(await run(t, "mesh", "delete")).toBe(1);
    expect(said(t)).toContain("this relay cannot delete meshes (it runs a version older than wim 0.1.9, or its host does not support it); nothing was deleted");
    // A relay older than mesh.delete answers unknown_type.
    relay.toClient = (text) => text.replace('"code":"unsupported"', '"code":"unknown_type"');
    t.answers.push("y");
    expect(await run(t, "mesh", "delete")).toBe(1);
    expect(t.err.filter((l) => l.includes("this relay cannot delete meshes"))).toHaveLength(2);
    expect(await exists(devices[0]!.home.meshDir(mesh))).toBe(true);
    // Any other refusal is quoted.
    const other = new RelayHarness();
    const made = await makeMesh(other, ["two"]);
    other.toRelay = (text) => (text.includes('"mesh.delete"') ? text.replace(made.mesh, "A".repeat(22)) : text);
    const u = term(made.devices[0]!.root, other);
    u.answers.push("y");
    expect(await run(u, "mesh", "delete")).toBe(1);
    expect(said(u)).toContain("the relay refused to delete the mesh: that is not this connection's mesh");
    expect(await meshLives(other, made.mesh)).toBe(true);
  }, 30_000);

  it("refuses a member session in deleteMesh itself, and forgetMesh removes only that mesh's directory", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const s = await openSession(devices[1]!, mesh, relay, { name: "m" });
    cleanup.push(() => s.stop());
    await expect(deleteMesh(s)).rejects.toMatchObject({ code: "not_admin", message: "only an admin device can delete the mesh" });
    expect(await meshLives(relay, mesh)).toBe(true);
    await forgetMesh(devices[1]!.home, "B".repeat(22));
    expect(await exists(devices[1]!.home.meshDir(mesh))).toBe(true);
  });

  it("has no MCP tool, internal op or events request that deletes a mesh", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    expect(PUBLIC_TOOLS.map((t) => t.name)).toEqual(["peers", "send", "ask", "reply", "inbox", "wait", "rooms", "lease", "send_file", "history", "rename"]);
    expect([...INTERNAL_OPS]).toEqual(["hello", "peers", "route", "held", "leases", "status"]);
    const server = new WimMcp({ channel: false, internalTools: true, version: "test", session: sessionOpts(devices[0]!, mesh, relay, { name: "agent", kind: "claude-code" }) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await server.server.connect(b);
    await client.connect(a);
    cleanup.push(async () => {
      await client.close();
      await server.close();
    });
    const call = async (name: string, args: Record<string, unknown>): Promise<string> =>
      ((await client.callTool({ name, arguments: args }, CallToolResultSchema)) as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");
    for (const op of ["delete", "mesh.delete", "mesh_delete", "forget"]) {
      expect(await call("_internal", { op, args: { mesh } })).toMatch(/invalid input: op/);
      expect(await call(op, { mesh })).toMatch(/unknown tool/);
    }
    // A local UI's events process, even one a person started, has no such request.
    const lines: Array<Record<string, unknown>> = [];
    const input = new PassThrough();
    const stop = new AbortController();
    const files = new MeshFiles(devices[0]!.home.meshDir(mesh), FS);
    const session = await MeshSession.open({ ...sessionOpts(devices[0]!, mesh, relay, { name: "vscode", kind: "vscode" }), handover: true, sessionKey: "events:vscode" });
    const running = runEvents({ session, mesh: files, env: FS, device: devices[0]!.device, version: "test", write: (l) => void lines.push(JSON.parse(l)), input, signal: stop.signal, now: Date.now, pollMs: 20, leasePollMs: 40 });
    cleanup.push(async () => {
      stop.abort();
      await running;
      await session.stop();
    });
    await until(() => lines.some((l) => l["type"] === "snapshot"));
    for (const [n, op] of ["delete", "mesh.delete", "mesh_delete"].entries()) {
      input.write(`${JSON.stringify({ v: 1, id: `d${n}`, op, args: { mesh } })}\n`);
      await until(() => lines.some((l) => l["type"] === "response" && l["id"] === `d${n}`));
      expect(lines.find((l) => l["type"] === "response" && l["id"] === `d${n}`)).toMatchObject({ ok: false, error: { code: "input", message: `unknown op ${op}` } });
    }
    expect(await meshLives(relay, mesh)).toBe(true);
    expect(await exists(devices[0]!.home.meshDir(mesh))).toBe(true);
  }, 30_000);
});

// The 0.1.9 release QA: a device never set up, a device in two meshes, `wim init` run again, and
// a stopped `wim init`.
describe("wim status and wim doctor on a device never set up", () => {
  it("say it is not set up yet and what to run, with no file error, and exit 1 as for any problem", async () => {
    const relay = new RelayHarness();
    // No state directory at all: neither `wim init` nor `wim join` ever ran here.
    const root = join(await scratch("never-set-up"), "wim");
    const setUp = `not set up yet, no device keys at ${join(root, "device.json")}: run \`wim init\`, or \`wim join <code>\` with an invite`;
    const s = term(root, relay);
    expect(await run(s, "status")).toBe(1);
    expect(s.out).toEqual([`problem  ${setUp}`, "Problems: 1, above. `wim doctor` shows each check."]);
    expect(s.err).toEqual([]);
    const d = term(root, relay);
    expect(await run(d, "doctor")).toBe(1);
    expect(d.out.filter((l) => l.startsWith("problem"))).toEqual([`problem  ${setUp}`]);
    expect(said(d)).not.toMatch(/ENOENT|no such file/);
    expect(d.err).toEqual([]);
    // Checking created nothing.
    expect(await exists(root)).toBe(false);
  });

  it("tell a state directory that cannot be read from one that does not exist", async () => {
    const file = join(await scratch("root-is-file"), "plain");
    await fs.writeFile(file, "");
    expect(await new Home(join(file, "wim"), HOME_ENV).rootProblem()).toMatch(/^cannot be read: ENOTDIR/);
    expect(await new Home(join(file, "..", "never"), HOME_ENV).rootProblem()).toBeNull();
  });
});

describe("wim status and wim doctor on a device in two meshes", () => {
  it("check every mesh, each with its own session, with or without WIM_MESH", async () => {
    const relay = new RelayHarness();
    const { mesh: first, devices } = await makeMesh(relay, ["both"]);
    const d = devices[0]!;
    const { mesh: second } = await createMesh({ home: d.home, device: d.device, relay: RELAY, dialer: relay.dialer, now: () => relay.now(), recovery: false });
    expect((await d.home.meshIds()).sort()).toEqual([first, second].sort());
    for (const env of [{}, { WIM_MESH: first }, { WIM_MESH: second }]) {
      const status = term(d.root, relay, {}, env);
      expect(await run(status, "status"), JSON.stringify(env)).toBe(0);
      expect(said(status)).not.toContain("set WIM_MESH or pass --mesh");
      for (const m of [first, second]) expect(said(status)).toContain(`Mesh ${m} on ${RELAY}:\n  connected as an admin;`);
      expect(status.out.at(-1)).toBe("Everything checks out. `wim doctor` shows each check.");
      const doctor = term(d.root, relay, {}, env);
      expect(await run(doctor, "doctor"), JSON.stringify(env)).toBe(0);
      for (const m of [first, second]) expect(said(doctor)).toMatch(new RegExp(`^ok {7}mesh ${m}: authenticated; roster seq \\d+`, "m"));
    }
  });
});

describe("wim init on a device already set up", () => {
  it("refuses, names the next step, and changes nothing", async () => {
    const relay = new RelayHarness();
    const t = term(await scratch("init-again"), relay);
    expect(await run(t, "init", "--name", "first")).toBe(0);
    const keys = await fs.readFile(join(t.env["WIM_HOME"]!, "device.json"), "utf8");
    expect(await run(t, "init", "--name", "second")).toBe(1);
    expect(t.err.at(-1)).toBe(
      `wim: ${join(t.env["WIM_HOME"]!, "device.json")} already exists: this device is set up. \`wim status\` shows it and its meshes; \`wim mesh create --relay <url>\` or \`wim join <code>\` adds a mesh`,
    );
    expect(await fs.readFile(join(t.env["WIM_HOME"]!, "device.json"), "utf8")).toBe(keys);
  });
});

describe("wim init stopped by Ctrl-C", () => {
  it("exits 130 while it holds the recovery code, and connects nothing more; run to the end it exits 0", async () => {
    const relay = new RelayHarness();
    const home = await scratch("init-sigint");
    const agent = term(home, relay, { isTTY: false }, { CLAUDECODE: "1" });
    const creating = run(agent, "init", "--name", "box", "--relay", RELAY);
    await until(() => agent.out.some((l) => l.includes("keeps running")), 5000);
    agent.stop.abort();
    expect(await creating).toBe(130);
    expect(agent.err).toEqual([]);
    expect(agent.out.slice(-2)).toEqual(["The recovery code was not collected and is gone; make a new one from an admin device with `wim recovery rotate`.", "Check this device and its mesh at any time with `wim status`."]);
    // The mesh was made before the stop, and the device's `cli` session never connected to it.
    const [mesh] = await new Home(home, HOME_ENV).meshIds();
    expect(await meshLives(relay, mesh!)).toBe(true);
    const cliAuth = (r: RelayHarness): boolean => r.sentByClients.some((t) => t.includes('"t":"auth"') && t.includes('"name":"cli"'));
    expect(cliAuth(relay)).toBe(false);
    // Not stopped, the same command ends with 0 and connects `cli`.
    const other = new RelayHarness();
    const person = term(await scratch("init-whole"), other);
    expect(await run(person, "init", "--name", "desk", "--relay", RELAY)).toBe(0);
    expect(cliAuth(other)).toBe(true);
  }, 20_000);
});
