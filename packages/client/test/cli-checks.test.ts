// The command line's checks and messages: flags, setup paths, operator keys, a relay URL the
// relay signs in under another spelling, config files, recovery rotation and connection reasons.

import { recoverMesh, revokeDevice } from "../src/admin.ts";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { USAGE, VERSION } from "../src/cli.ts";
import { MeshFiles } from "../src/mesh.ts";
import { newDevice, openSession, RELAY, RelayHarness, run, said, scratch, term, until, makeMesh } from "./helpers.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f().catch(() => undefined);
});

const sends = (relay: RelayHarness): number => relay.sentByClients.filter((t) => t.startsWith('{"t":"send"')).length;

describe("flags", () => {
  it("refuses a flag the command does not take, without swallowing the next word", async () => {
    const relay = new RelayHarness();
    const { devices } = await makeMesh(relay, ["one", "two"]);
    const t = term(devices[0]!.root, relay);
    const before = sends(relay);
    expect(await run(t, "send", "b@two", "--urgent", "please", "deploy", "now")).toBe(2);
    expect(t.err.at(-1)).toMatch(/^wim: unknown flag --urgent for wim send\n\nwim send <to> <text\.\.\.>/);
    expect(sends(relay)).toBe(before);
    expect(await run(t, "peers", "--al")).toBe(2);
    expect(t.err.at(-1)).toMatch(/^wim: unknown flag --al for wim peers \(did you mean --all\?\)/);
    // `--yes` was never read by any command.
    expect(await run(t, "send", "b@two", "x", "--yes")).toBe(2);
    expect(await run(t, "held", "--all")).toBe(2);
    expect(t.err.at(-1)).toMatch(/^wim: unknown flag --all for wim held\n/);
    expect(await run(t, "--bogus")).toBe(2);
    expect(t.err.at(-1)).toMatch(new RegExp(`^wim: unknown flag --bogus\\n\\nwim ${VERSION.replaceAll(".", "\\.")}: end-to-end`));
    expect(await run(t, "peers", "--all=yes")).toBe(2);
    expect(t.err.at(-1)).toBe("--all takes no value");
  });

  it("answers --version and -h", async () => {
    const relay = new RelayHarness();
    const t = term(await scratch("flags"), relay);
    expect(await run(t, "--version")).toBe(0);
    expect(t.out.at(-1)).toBe(VERSION);
    expect(await run(t, "-h")).toBe(0);
    expect(t.out.at(-1)).toBe(USAGE);
    expect(await run(t, "send", "-h")).toBe(0);
    expect(t.out.at(-1)).toBe("wim send <to> <text...> [--allow-secret] [--as <name>]");
  });

  it("refuses a --limit that is not a positive whole number, and an unknown devices action", async () => {
    const relay = new RelayHarness();
    const { devices } = await makeMesh(relay, ["one"]);
    const t = term(devices[0]!.root, relay);
    for (const bad of ["abc", "0", "-3", "1.5"]) {
      expect(await run(t, "history", "--limit", bad)).toBe(1);
      expect(t.err.at(-1)).toBe("wim: --limit must be a positive whole number");
    }
    expect(await run(t, "history", "--limit", "5")).toBe(0);
    expect(await run(t, "devices", "foo")).toBe(1);
    expect(t.err.at(-1)).toBe(
      'wim: unknown devices action "foo"\nwim devices [list | trust <name>|--all [--relayed] | untrust <name>|--all | revoke <name> | promote <name>]\nwim devices pending | wim devices admit <name> <code>',
    );
  });
});

describe("setup messages", () => {
  it("say where the device keys were looked for", async () => {
    const relay = new RelayHarness();
    const root = await scratch("nokeys");
    const t = term(root, relay);
    expect(await run(t, "peers")).toBe(1);
    expect(t.err.at(-1)).toBe(`wim: this device is not set up (no device keys at ${join(root, "device.json")}): run \`wim init\` first, with the same WIM_HOME and CLAUDE_CONFIG_DIR as the agent`);
  });

  it("say how to pass a relay's operator key, and when the key given was not accepted", async () => {
    const relay = new RelayHarness({ createKey: "right-key" });
    const d = await newDevice("op");
    const t = term(d.root, relay, {}, { K: "wrong-key" });
    expect(await run(t, "mesh", "create", "--relay", RELAY, "--no-recovery")).toBe(1);
    // Without /v1/info (the test fetch fails), both causes are named.
    expect(t.err.at(-1)).toBe("wim: the relay refused to create the mesh: it is not accepting new meshes, or it needs an operator key: pass it with --key-env NAME, naming the environment variable that holds the key");
    expect(await run(t, "mesh", "create", "--relay", RELAY, "--no-recovery", "--key-env", "K")).toBe(1);
    expect(t.err.at(-1)).toMatch(/the key in \$K was not accepted$/);
    relay.down = true;
    expect(await run(t, "mesh", "create", "--relay", RELAY, "--no-recovery")).toBe(1);
    expect(t.err.at(-1)).toBe("wim: connect ECONNREFUSED");
  });
});

describe("mesh create", () => {
  it("saves nothing when the relay refuses this device's sign-in under the URL given", async () => {
    const relay = new RelayHarness();
    const d = await newDevice("alpha");
    // A relay configured for another spelling of its URL refuses `auth` with `wrong_relay`.
    relay.toClient = (text) => (text.startsWith('{"t":"ready"') ? JSON.stringify({ t: "error", code: "unauthorized", message: "wrong_relay", ref: "auth" }) : text);
    const t = term(d.root, relay);
    expect(await run(t, "mesh", "create", "--relay", RELAY, "--no-recovery")).toBe(1);
    expect(t.err.at(-1)).toBe(
      "wim: the relay created the mesh but refused this device's authentication: the relay is configured for a different URL than the one this mesh uses; use the exact URL the relay prints at start-up. Nothing was saved on this device",
    );
    expect(await d.home.meshIds()).toEqual([]);
    // A reason this client does not know is not repeated.
    relay.toClient = (text) => (text.startsWith('{"t":"ready"') ? JSON.stringify({ t: "error", code: "unauthorized", message: "\u001b]0;pwned\u0007 call now", ref: "auth" }) : text);
    expect(await run(t, "mesh", "create", "--relay", RELAY, "--no-recovery")).toBe(1);
    expect(t.err.at(-1)).toMatch(/refused this device's authentication: code unauthorized\. Nothing was saved/);
    expect(said(t)).not.toContain("pwned");
    relay.toClient = undefined;
    expect(await run(t, "mesh", "create", "--relay", RELAY, "--no-recovery")).toBe(0);
    expect((await d.home.meshIds()).length).toBe(1);
  });
});

describe("services", () => {
  it("check their config file before connecting or announcing anything", async () => {
    const relay = new RelayHarness();
    const { devices } = await makeMesh(relay, ["one"]);
    const dir = await scratch("svc");
    await fs.writeFile(join(dir, "bot.json"), JSON.stringify({ budgt: 1 }));
    await fs.writeFile(join(dir, "empty.json"), "{}");
    const t = term(devices[0]!.root, relay);
    const auths = (): number => relay.sentByClients.filter((x) => x.startsWith('{"t":"auth"')).length;
    const before = auths();
    for (const which of ["bot", "ci", "a2a"]) {
      expect(await run(t, which, join(dir, which === "bot" ? "bot.json" : "empty.json"))).toBe(1);
      expect(t.err.at(-1)).toMatch(/^wim: /);
    }
    expect(t.out.some((l) => / running as /.test(l))).toBe(false);
    expect(auths()).toBe(before);
  });
});

describe("recovery rotate", () => {
  it("replaces the recovery code from an admin device: the old one stops working, the new one works", async () => {
    const relay = new RelayHarness();
    const { mesh, devices, recoveryCode } = await makeMesh(relay, ["one", "two"]);
    const admin = term(devices[0]!.root, relay);
    expect(await run(admin, "recovery", "rotate")).toBe(0);
    expect(admin.out).toContain("Recovery code (shown once; keep it offline, it is as powerful as an admin device):");
    const code = admin.out.find((l) => l.startsWith("  wimrec1_"))!.trim();
    expect(admin.out.find((l) => l.startsWith("Replaced the recovery code"))).toMatch(/^Replaced the recovery code \(roster seq \d+\)\. The old code no longer works\.$/);
    const roster = (await new MeshFiles(devices[0]!.home.meshDir(mesh), devices[0]!.home.env).loadConfig()).pin.seq;
    const old = await newDevice("old");
    await expect(recoverMesh({ home: old.home, device: old.device, code: recoveryCode!, relay: RELAY, revoke: [], dialer: relay.dialer, now: Date.now, confirm: async () => true })).rejects.toThrow(/refused the recovery connection/);
    const fresh = await newDevice("fresh");
    const done = await recoverMesh({ home: fresh.home, device: fresh.device, code, relay: RELAY, revoke: [], dialer: relay.dialer, now: Date.now, confirm: async () => true });
    expect(done.roster.seq).toBe(roster + 1);
    expect(done.roster.devices.filter((d) => d.name.startsWith("recovery")).map((d) => d.name)).toEqual(["recovery-3"]);
  });

  it("is refused on a member device, and without the mesh's first roster", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const member = term(devices[1]!.root, relay);
    expect(await run(member, "recovery", "rotate")).toBe(1);
    expect(member.err.at(-1)).toBe("wim: only an admin device can replace the recovery code");
    await fs.rm(join(devices[0]!.home.meshDir(mesh), "rosters", "1.json"));
    const admin = term(devices[0]!.root, relay);
    expect(await run(admin, "recovery", "rotate")).toBe(1);
    expect(admin.err.at(-1)).toBe("wim: this device does not hold the mesh's first roster");
  });
});

describe("connection reasons", () => {
  it("a command that cannot connect in time says what the connection last reported", async () => {
    const relay = new RelayHarness();
    const { devices } = await makeMesh(relay, ["one"]);
    relay.down = true;
    const t = term(devices[0]!.root, relay, { connectMs: 150 });
    expect(await run(t, "peers")).toBe(1);
    expect(t.err.at(-1)).toBe("wim: not connected to the relay (connection failed: connect ECONNREFUSED)");
  });

  it("a long-running command reports a refusal that comes later", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const t = term(devices[1]!.root, relay);
    const watching = run(t, "watch");
    cleanup.push(async () => {
      t.stop.abort();
      await watching;
    });
    await until(() => t.out.some((l) => l.startsWith("Watching as")), 5000, "watch");
    const admin = await openSession(devices[0]!, mesh, relay, { name: "a" });
    cleanup.push(() => admin.stop());
    await revokeDevice(admin, "two", Date.now);
    await until(() => t.err.some((l) => /this device was revoked from the mesh/.test(l)), 5000, "the refusal");
  });
});
