// `wim setup` (setup.ts): refused anywhere but a person's own terminal, the create path with its
// defaults against the in-process relay, the recovery code shown once, the integrations with a
// fake runner (found, not found, failing), the status summary at the end, and a rerun on a device
// that is already set up. Also `wim recovery show --wait`, and the real `execFile` runner.

import { HOSTED_RELAY } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.ts";
import { AGENT_ENV_VARS } from "../src/secretout.ts";
import { execRunner, HOSTED_TERMS, STORED_PROMPT, type ToolRun } from "../src/setup.ts";
import type { RunResult } from "../src/autostart.ts";
import { makeMesh, RELAY, RelayHarness, run, said, scratch, term, until, type Term } from "./helpers.ts";

/** What a relay's `/v1/info` answers. */
const infoFetch = (async () =>
  new Response(JSON.stringify({ v: 1, software: "worldinmotion-relay", version: "0.1.9", create: "open", limits: { max_meshes: 2000, idle_mesh_days: 30, blob_bytes_per_mesh_per_day: 26214400 }, offer: "free during the preview" }), { status: 200 })) as unknown as typeof fetch;

const ENOENT = (): Error => Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

/** A fake runner: each `cmd args` answered from `table`; anything else is not installed. */
function fakeTools(table: Record<string, RunResult | Error>): { run: ToolRun; calls: string[] } {
  const calls: string[] = [];
  const run: ToolRun = async (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    const answer = table[key];
    if (answer === undefined) throw ENOENT();
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { run, calls };
}

const exists = (path: string): Promise<boolean> => fs.stat(path).then(() => true, () => false);
const recoveryCodes = (t: Term): number => said(t).match(/wimrec1_/g)?.length ?? 0;
/** Every question asked: prompt lines end with a space after `:`, `?]` or `.`. */
const questions = (t: Term): string[] => t.out.filter((l) => / $/.test(l));

describe("wim setup refuses anything but a person's own terminal", () => {
  const cases: Array<{ what: string; io: { isTTY: boolean; inputIsTTY: boolean }; env: Record<string, string> }> = [
    ...AGENT_ENV_VARS.map((k) => ({ what: k, io: { isTTY: true, inputIsTTY: true }, env: { [k]: "1" } })),
    { what: "a Codex variable", io: { isTTY: true, inputIsTTY: true }, env: { CODEX_SANDBOX: "seatbelt" } },
    { what: "piped stdin", io: { isTTY: true, inputIsTTY: false }, env: {} },
    { what: "piped stdout", io: { isTTY: false, inputIsTTY: true }, env: {} },
  ];
  for (const c of cases) {
    it(`under ${c.what}, before any question and with nothing made`, async () => {
      const relay = new RelayHarness();
      const home = await scratch("setup-refuse");
      const t = term(home, relay, c.io, c.env);
      t.answers.push("1", "", "", "y", "");
      expect(await run(t, "setup", "--relay", RELAY)).toBe(1);
      expect(t.out).toEqual([]);
      expect(t.err.join("\n")).toMatch(/Open a terminal yourself \(VS Code: Terminal > New Terminal\) and run `wim setup` there$/);
      expect(await exists(join(home, "device.json"))).toBe(false);
    });
  }
});

describe("wim setup on a new machine", () => {
  it("creates the device and a mesh with the defaults, shows the recovery code once, then the status summary", async () => {
    const relay = new RelayHarness();
    const home = await scratch("setup-new");
    const t = term(home, relay, { fetch: infoFetch });
    // Choose 1, take the name and relay offered, type y, then Enter once the code is stored.
    t.answers.push("1", "", "", "y", "");
    expect(await run(t, "setup", "--relay", RELAY)).toBe(0);
    const text = said(t);
    expect(questions(t)).toEqual([
      "Choose 1 or 2: ",
      "Device name [my-host-local]: ",
      `Relay [${RELAY}]: `,
      `Create a mesh on ${RELAY} with my-host-local as its admin? [y/N] `,
      STORED_PROMPT,
    ]);
    expect(text).toContain("This machine is not set up yet.");
    expect(text).toContain("  the relay creates meshes for anyone");
    expect(text).toContain('  relay offer (the relay\'s own words, not checked): "free during the preview"');
    // Not the hosted relay: no terms line for it.
    expect(text).not.toContain(HOSTED_TERMS);
    expect(text).toMatch(/Created mesh \S+ on ws:\/\/127\.0\.0\.1:4444\. This device is its admin\./);
    expect(recoveryCodes(t)).toBe(1);
    // The code comes before the question that waits for it to be stored.
    expect(t.out.findIndex((l) => l.includes("wimrec1_"))).toBeLessThan(t.out.indexOf(STORED_PROMPT));
    // Nothing asks about crash reports, and the signer is named, not started.
    expect(text).not.toMatch(/crash/i);
    expect(text).toContain("`wim agent encrypt`");
    expect(text).toContain("Claude Code: the `claude` command was not found here.");
    expect(text).toContain("VS Code: the `code` command was not found here.");
    expect(text).toContain("To add another machine: run `wim invite` here");
    // The status summary ends it.
    expect(t.out.at(-1)).toBe("Everything checks out. `wim doctor` shows each check.");
    expect(text).toMatch(/This device is my-host-local \(id \S+\)\.\nMesh \S+ on ws:\/\/127\.0\.0\.1:4444:\n  connected as an admin/);
    expect(await exists(join(home, "device.json"))).toBe(true);
  }, 20_000);

  it("offers the hosted relay by default with its terms, and changes nothing without a typed y", async () => {
    const relay = new RelayHarness();
    const home = await scratch("setup-hosted");
    const t = term(home, relay);
    t.answers.push("1", "laptop", "", "n");
    expect(await run(t, "setup")).toBe(1);
    expect(questions(t)).toContain(`Relay [${HOSTED_RELAY}]: `);
    expect(questions(t)).toContain(`Create a mesh on ${HOSTED_RELAY} with laptop as its admin? [y/N] `);
    expect(said(t)).toContain("  this relay does not publish /v1/info, so what it offers is not known");
    expect(said(t)).toContain(`  The hosted relay's terms: ${HOSTED_TERMS}`);
    expect(t.err).toEqual(["wim: nothing changed."]);
    expect(relay.dials).toEqual([]);
    expect(await exists(join(home, "device.json"))).toBe(false);
  });

  it("says the add path and the invite-code form are not in this version yet", async () => {
    const relay = new RelayHarness();
    const home = await scratch("setup-later");
    const add = term(home, relay);
    add.answers.push("2");
    expect(await run(add, "setup")).toBe(1);
    expect(said(add)).toContain("Adding this machine from `wim setup` is not in this version yet. For now: on a device already in the mesh, run `wim invite` in a terminal; then here, `wim join <code>` with the code it shows.");
    const code = term(home, relay);
    expect(await run(code, "setup", "wim2-0000")).toBe(1);
    expect(said(code)).toContain("`wim setup <invite code>` is not in this version yet: join with an invite code by `wim join <code>`");
    const other = term(home, relay);
    other.answers.push("3");
    expect(await run(other, "setup")).toBe(1);
    expect(other.err).toEqual(["wim: choose 1 or 2. Nothing changed."]);
    expect(await exists(join(home, "device.json"))).toBe(false);
  });

  it("refuses a bad name, a relay it cannot dial and a key variable that is not set, with nothing made", async () => {
    const relay = new RelayHarness();
    const home = await scratch("setup-bad");
    const name = term(home, relay);
    name.answers.push("1", "Not A Name!");
    expect(await run(name, "setup")).toBe(1);
    expect(said(name)).toContain('invalid device name "Not A Name!"');
    const url = term(home, relay);
    url.answers.push("1", "", "https://relay.example");
    expect(await run(url, "setup")).toBe(1);
    expect(said(url)).toMatch(/wim: .*relay/);
    const key = term(home, relay);
    key.answers.push("1", "", "", "y");
    expect(await run(key, "setup", "--relay", RELAY, "--key-env", "NOPE")).toBe(1);
    expect(said(key)).toContain("wim: NOPE is not set");
    expect(await exists(join(home, "device.json"))).toBe(false);
  });

  it("uses a device that exists but is in no mesh, without asking its name", async () => {
    const relay = new RelayHarness();
    const home = await scratch("setup-device");
    const init = term(home, relay);
    expect(await run(init, "init", "--name", "box")).toBe(0);
    const t = term(home, relay);
    t.answers.push("1", "", "y", "");
    expect(await run(t, "setup", "--relay", RELAY, "--name", "ignored")).toBe(0);
    expect(said(t)).toContain("This device is box, in no mesh yet.");
    expect(questions(t).some((q) => q.startsWith("Device name"))).toBe(false);
    expect(questions(t)).toContain(`Create a mesh on ${RELAY} with box as its admin? [y/N] `);
  }, 20_000);

  it("stops after the recovery code when the person stops the command there", async () => {
    const relay = new RelayHarness();
    const t = term(await scratch("setup-stop"), relay);
    t.answers.push("1", "", "", "y", () => {
      t.stop.abort();
      return "";
    });
    expect(await run(t, "setup", "--relay", RELAY)).toBe(130);
    expect(recoveryCodes(t)).toBe(1);
    expect(said(t)).not.toContain("Everything checks out");
  }, 20_000);
});

describe("wim setup on a device already set up", () => {
  it("skips to the integrations and the status summary; only an admin is told how to add a machine", async () => {
    const relay = new RelayHarness();
    const { devices } = await makeMesh(relay, ["one", "two"]);
    const admin = term(devices[0]!.root, relay);
    expect(await run(admin, "setup")).toBe(0);
    expect(said(admin)).toContain(`This device is one (id ${devices[0]!.device.id}), in a mesh already: skipping to the steps that can be repeated.`);
    expect(questions(admin)).toEqual([]);
    expect(recoveryCodes(admin)).toBe(0);
    expect(said(admin)).toContain("To add another machine: run `wim invite` here");
    expect(admin.out.at(-1)).toBe("Everything checks out. `wim doctor` shows each check.");
    const member = term(devices[1]!.root, relay);
    expect(await run(member, "setup")).toBe(0);
    expect(said(member)).not.toContain("To add another machine");
    // A second mesh on the member: it is an admin there.
    const more = term(devices[1]!.root, relay);
    expect(await run(more, "mesh", "create", "--relay", RELAY, "--no-recovery")).toBe(0);
    const again = term(devices[1]!.root, relay);
    expect(await run(again, "setup")).toBe(0);
    expect(said(again)).toContain("in 2 meshes already");
    expect(said(again)).toContain("To add another machine");
  }, 30_000);

  it("ends with the problems of the status summary, and its exit code", async () => {
    const relay = new RelayHarness();
    const { devices } = await makeMesh(relay, ["solo"]);
    relay.down = true;
    const t = term(devices[0]!.root, relay);
    expect(await run(t, "setup")).toBe(1);
    expect(t.out.at(-1)).toBe("Problems: 1, above. `wim doctor` shows each check.");
  });
});

describe("wim setup integrations", () => {
  async function setUp() {
    const relay = new RelayHarness();
    const { devices } = await makeMesh(relay, ["solo"]);
    const root = devices[0]!.root;
    const t = (tools: ToolRun, env: Record<string, string | undefined> = {}) => term(root, relay, { tools }, env);
    return { root, t };
  }

  it("installs the plugin (adding the marketplace) and the extension after a typed y, with fixed arguments", async () => {
    const { t } = await setUp();
    const tools = fakeTools({
      "claude plugin list --json": ok("[]"),
      "claude plugin marketplace list --json": ok('[{"name":"other"}]'),
      "claude plugin marketplace add distronode-corporation/worldinmotion": ok(),
      "claude plugin install worldinmotion@worldinmotion": ok(),
      "code --list-extensions": ok("ms-python.python\n"),
      "code --install-extension distronode.worldinmotion --pre-release": ok(),
    });
    const term1 = t(tools.run);
    term1.answers.push("y", "y");
    expect(await run(term1, "setup")).toBe(0);
    expect(tools.calls).toEqual([
      "claude plugin list --json",
      "claude plugin marketplace list --json",
      "claude plugin marketplace add distronode-corporation/worldinmotion",
      "claude plugin install worldinmotion@worldinmotion",
      "code --list-extensions",
      "code --install-extension distronode.worldinmotion --pre-release",
    ]);
    const text = said(term1);
    expect(text).toContain("Claude Code found. Installing the worldinmotion plugin runs:\n  claude plugin marketplace add distronode-corporation/worldinmotion\n  claude plugin install worldinmotion@worldinmotion");
    expect(text).toContain("Claude Code plugin: installed. Open a new Claude Code tab; it links by itself.");
    expect(questions(term1)).toEqual(["Install the worldinmotion plugin? [y/N] ", "VS Code found. Install the extension? It runs: code --install-extension distronode.worldinmotion --pre-release [y/N] "]);
    expect(text).toContain("VS Code extension: installed. Reload any open VS Code window.");
    expect(text).toMatch(/State directory: .* \(WIM_HOME is set\)\./);
  });

  it("skips the marketplace Claude Code has, and says when both are installed already", async () => {
    const { t } = await setUp();
    const known = fakeTools({
      "claude plugin list --json": ok('[null, "x", {"id":"other@x"}]'),
      "claude plugin marketplace list --json": ok('[{"name":"worldinmotion"}]'),
      "claude plugin install worldinmotion@worldinmotion": ok(),
      "code --list-extensions": ok("Distronode.Worldinmotion\r\n"),
    });
    const a = t(known.run);
    a.answers.push("yes");
    expect(await run(a, "setup")).toBe(0);
    expect(known.calls).not.toContain("claude plugin marketplace add distronode-corporation/worldinmotion");
    expect(said(a)).toContain("VS Code extension: installed.");
    const done = fakeTools({ "claude plugin list --json": ok('[{"id":"worldinmotion@worldinmotion"}]'), "code --list-extensions": ok("distronode.worldinmotion\n") });
    const b = t(done.run);
    expect(await run(b, "setup")).toBe(0);
    expect(questions(b)).toEqual([]);
    expect(said(b)).toContain("Claude Code plugin: installed. Open a new Claude Code tab; it links by itself.");
  });

  it("says what to do by hand when the person answers no, a tool fails or cannot start", async () => {
    const { t } = await setUp();
    const missing = fakeTools({});
    const none = t(missing.run);
    expect(await run(none, "setup")).toBe(0);
    expect(missing.calls).toEqual(["claude plugin list --json", "code --list-extensions"]);
    expect(said(none)).toContain("Claude Code: the `claude` command was not found here. To install the plugin, type these in a Claude Code chat, then open a new tab:\n  /plugin marketplace add distronode-corporation/worldinmotion");
    expect(said(none)).toContain("VS Code: the `code` command was not found here. The extension is distronode.worldinmotion, a pre-release: search for worldinmotion in the Extensions view.");
    const declined = fakeTools({ "claude plugin list --json": ok("not json"), "code --list-extensions": ok("") });
    const no = t(declined.run);
    no.answers.push("n", "");
    expect(await run(no, "setup")).toBe(0);
    expect(said(no)).toContain("Skipped. Later, type these in a Claude Code chat:\n  /plugin marketplace add distronode-corporation/worldinmotion\n  /plugin install worldinmotion@worldinmotion");
    expect(said(no)).toContain("Skipped. Later: code --install-extension distronode.worldinmotion --pre-release");
    expect(declined.calls).toEqual(["claude plugin list --json", "code --list-extensions"]);

    const failing = fakeTools({
      "claude plugin list --json": ok("{}"),
      "claude plugin marketplace list --json": { code: 1, stdout: "", stderr: "" },
      "claude plugin marketplace add distronode-corporation/worldinmotion": { code: 1, stdout: "", stderr: "one\ntwo\nthree\nfour\u001b[0m\n" },
      "code --list-extensions": ok(""),
      "code --install-extension distronode.worldinmotion --pre-release": { code: 2, stdout: "", stderr: "" },
    });
    const bad = t(failing.run);
    bad.answers.push("y", "y");
    expect(await run(bad, "setup")).toBe(0);
    expect(said(bad)).toMatch(/Claude Code: `claude plugin marketplace add distronode-corporation\/worldinmotion` did not work \(two \/ three \/ four.*\)\. In a Claude Code chat instead:\n {2}\/plugin marketplace add/);
    expect(failing.calls).not.toContain("claude plugin install worldinmotion@worldinmotion");
    expect(said(bad)).not.toContain("\u001b");
    expect(said(bad)).toContain("VS Code: the install did not work (exit code 2).");

    const installFails = fakeTools({
      "claude plugin list --json": ok("[]"),
      "claude plugin marketplace list --json": Object.assign(new Error("spawn claude EACCES"), { code: "EACCES" }),
      "claude plugin marketplace add distronode-corporation/worldinmotion": ok(),
      "claude plugin install worldinmotion@worldinmotion": Object.assign(new Error("spawn claude EACCES"), { code: "EACCES" }),
      "code --list-extensions": ok(""),
      "code --install-extension distronode.worldinmotion --pre-release": Object.assign(new Error("spawn code EACCES"), { code: "EACCES" }),
    });
    const cannot = t(installFails.run);
    cannot.answers.push("y", "y");
    expect(await run(cannot, "setup")).toBe(0);
    expect(said(cannot)).toContain("Claude Code: `claude plugin install worldinmotion@worldinmotion` did not work (spawn claude EACCES).");
    expect(said(cannot)).toContain("VS Code: the install did not work (spawn code EACCES).");

    const broken = fakeTools({
      "claude plugin list --json": { code: 1, stdout: "", stderr: "unknown command\n" },
      "code --list-extensions": Object.assign(new Error("spawn code EACCES"), { code: "EACCES" }),
    });
    const listing = t(broken.run);
    expect(await run(listing, "setup")).toBe(0);
    expect(said(listing)).toContain("Claude Code: `claude plugin list` did not work (unknown command). To install the plugin, type these in a Claude Code chat:");
    expect(said(listing)).toContain("VS Code: `code --list-extensions` did not work (spawn code EACCES).");
    const unstarted = fakeTools({ "claude plugin list --json": Object.assign(new Error("spawn claude EPERM"), { code: "EPERM" }), "code --list-extensions": { code: 3, stdout: "", stderr: "" } });
    const other = t(unstarted.run);
    expect(await run(other, "setup")).toBe(0);
    expect(said(other)).toContain("Claude Code: `claude plugin list` did not work (spawn claude EPERM).");
    expect(said(other)).toContain("VS Code: `code --list-extensions` did not work (exit code 3).");
  }, 30_000);

  it("stops before the status summary when the person stops the command at a question", async () => {
    const { t } = await setUp();
    const tools = fakeTools({ "claude plugin list --json": ok("[]"), "code --list-extensions": ok("") });
    const stopped = t(tools.run);
    stopped.answers.push(() => {
      stopped.stop.abort();
      return "";
    });
    expect(await run(stopped, "setup")).toBe(130);
    expect(said(stopped)).not.toContain("Everything checks out");
    expect(said(stopped)).not.toContain("`wim agent encrypt`");
  });

  it("covers the POSIX runner with a fake execFile: no shell, no `where`", async () => {
    const calls: Array<{ file: string; shell: boolean }> = [];
    const execFile = ((file: string, _args: readonly string[], options: { shell: boolean }, callback: (e: null, out: string, err: string) => void) => {
      calls.push({ file, shell: options.shell });
      setImmediate(() => callback(null, "ok", ""));
      return { stdin: null };
    }) as unknown as Parameters<typeof execRunner>[1];
    expect(await execRunner("linux", execFile)("code", ["--list-extensions"])).toEqual({ code: 0, stdout: "ok", stderr: "" });
    expect(calls).toEqual([{ file: "code", shell: false }]);
  });

  it("warns when CLAUDE_CONFIG_DIR picks this state directory, and not when WIM_HOME does", async () => {
    const relay = new RelayHarness();
    const homedir = await scratch("setup-claude-dir");
    const env = { WIM_HOME: undefined, CLAUDE_CONFIG_DIR: join(homedir, "claude-b") };
    const t = term(homedir, relay, {}, env);
    t.answers.push("1", "", "", "y", "");
    expect(await run(t, "setup", "--relay", RELAY)).toBe(0);
    expect(said(t)).toMatch(/State directory: .*profiles.* \(CLAUDE_CONFIG_DIR is set/);
    expect(said(t)).toContain("Warning: CLAUDE_CONFIG_DIR is set in this terminal.");
    // The same directory named by WIM_HOME: no warning, whatever CLAUDE_CONFIG_DIR says.
    const root = /State directory: (.*) \(CLAUDE/.exec(said(t))![1]!;
    const set = term(root, relay, {}, { CLAUDE_CONFIG_DIR: "x" });
    expect(await run(set, "setup")).toBe(0);
    expect(said(set)).not.toContain("Warning: CLAUDE_CONFIG_DIR");
  }, 20_000);
});

describe("wim recovery show --wait", () => {
  it("shows the held code, then waits for Enter; --wait takes no value and only show waits", async () => {
    const relay = new RelayHarness();
    const home = await scratch("setup-wait");
    const agent = term(home, relay, { isTTY: false }, { CLAUDECODE: "1" });
    await run(agent, "init", "--name", "box");
    const creating = run(agent, "mesh", "create", "--relay", RELAY);
    await until(() => agent.out.some((l) => l.includes("wim recovery show")), 5000);
    const person = term(home, relay);
    let waited = false;
    person.answers.push(() => {
      waited = true;
      return "";
    });
    expect(await run(person, "recovery", "show", "--wait")).toBe(0);
    expect(waited).toBe(true);
    expect(person.out.at(-1)).toBe(STORED_PROMPT);
    expect(person.out.findIndex((l) => l.includes("wimrec1_"))).toBe(person.out.length - 2);
    expect(await creating).toBe(0);
    for (const argv of [["recovery", "show", "--wait", "30s"], ["recovery", "rotate", "--wait"], ["recovery", "--wait"]]) {
      const t = term(home, relay);
      expect(await run(t, ...argv)).toBe(1);
      expect(said(t)).toContain("usage: wim recovery show [--wait] | wim recovery rotate");
    }
    // Another command's --wait still needs its duration.
    const send = term(home, relay);
    expect(await run(send, "send", "cli@box", "hi", "--wait")).toBe(1);
    expect(said(send)).toContain("--wait needs a value: a duration such as 30s");
  }, 20_000);

  it("wim help setup and wim help recovery give the new forms", async () => {
    const t = term(await scratch("setup-help"), new RelayHarness());
    expect(await run(t, "help", "setup")).toBe(0);
    expect(await run(t, "recovery", "--help")).toBe(0);
    expect(t.out).toEqual(["wim setup [--name <device>] [--relay <url>] [--key-env NAME]", "wim recovery show [--wait] | wim recovery rotate"]);
  });

  it("parses --wait alone, before another flag, and with a value", () => {
    expect(parseArgs(["--wait"]).flags.get("wait")).toBe(true);
    expect(parseArgs(["--wait", "--mesh", "m"]).flags).toEqual(new Map<string, string | true>([["wait", true], ["mesh", "m"]]));
    expect(parseArgs(["--wait", "30s"]).flags.get("wait")).toBe("30s");
    expect(() => parseArgs(["--name"])).toThrow(/needs a value/);
  });
});

describe("execRunner", () => {
  it("runs a program without a shell and gives its exit code and output; a missing one is ENOENT", async () => {
    const r = execRunner(process.platform);
    const version = await r("node", ["--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout).toMatch(/^v\d+\./);
    expect((await r("node", ["--no-such-flag-for-wim"])).code).not.toBe(0);
    await expect(r("wim-no-such-program-here", [])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("on Windows looks the program up with `where`, then runs it through the shell with the fixed arguments", async () => {
    const calls: Array<{ file: string; args: readonly string[]; shell: boolean }> = [];
    let found = true;
    let ended = 0;
    const execFile = ((file: string, args: readonly string[], options: { shell: boolean }, callback: (e: (Error & { code?: unknown }) | null, out: string, err: string) => void) => {
      calls.push({ file, args, shell: options.shell });
      if (file === "where") setImmediate(() => callback(found ? null : Object.assign(new Error("not found"), { code: 1 }), "", ""));
      else setImmediate(() => callback(null, "done", ""));
      return { stdin: file === "where" ? null : { end: () => void ended++ } };
    }) as unknown as Parameters<typeof execRunner>[1];
    const r = execRunner("win32", execFile);
    expect(await r("code", ["--list-extensions"])).toEqual({ code: 0, stdout: "done", stderr: "" });
    expect(calls).toEqual([
      { file: "where", args: ["code"], shell: false },
      { file: "code", args: ["--list-extensions"], shell: true },
    ]);
    expect(ended).toBe(1);
    found = false;
    await expect(r("claude", ["plugin", "list", "--json"])).rejects.toMatchObject({ code: "ENOENT", message: "claude is not installed" });
  });
});
