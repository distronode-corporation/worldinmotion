// `wim agent init|doctor|run|runner|privileged` through the CLI, on real files and a real mesh on
// the in-process relay. The serve path and the jobs themselves are in worker-e2e.test.ts.

import { promises as fs } from "node:fs";
import { delimiter, join, sep } from "node:path";
import type { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { PLACEHOLDER, type DoctorDeps } from "@worldinmotion/agent";
import { beforeAll, describe, expect, it } from "vitest";
import { kindOf, kitCandidates, sdkFrom, statOf, which } from "../src/workercli.ts";
import { makeMesh, newDevice, RelayHarness, run, said, scratch, term, type TestDevice } from "./helpers.ts";

const POSIX = process.platform !== "win32";
let relay: RelayHarness;
let sender: TestDevice;
let worker: TestDevice;
let dir: string;
let stub: string;

beforeAll(async () => {
  relay = new RelayHarness();
  const made = await makeMesh(relay, ["laptop", "worker"]);
  [sender, worker] = made.devices as [TestDevice, TestDevice];
  dir = await scratch("worker-cli");
  stub = join(dir, "stub.mjs");
  await fs.writeFile(stub, `let s = ""; process.stdin.on("data", (c) => (s += c)); process.stdin.on("end", () => process.stdout.write("ok " + JSON.parse(s).id));`);
}, 60_000);

/** A terminal on the worker device whose "wim" is the stub runner, and doctor probes that answer no. */
function wt(extra: Parameters<typeof term>[2] = {}, env: Record<string, string | undefined> = {}) {
  const doctor: Partial<DoctorDeps> = { probe: async () => "no" };
  return term(worker.root, relay, { wim: () => [process.execPath, stub], workerDoctor: doctor, ...extra }, env);
}

/** What the command reads on stdin. */
const feed = (t: ReturnType<typeof wt>, text: string): void => void (t.io.stdin as PassThrough).end(text);

async function fresh(name: string): Promise<string> {
  const d = join(dir, name);
  await fs.mkdir(d);
  return join(d, "worker.json");
}

describe("wim agent", () => {
  it("names its actions, and needs a config path", async () => {
    const t = wt();
    expect(await run(t, "agent")).toBe(1);
    expect(t.err.join("\n")).toContain("wim agent init <config>");
    const u = wt();
    expect(await run(u, "agent", "doctor")).toBe(1);
    expect(u.err.join("\n")).toContain("a worker config path is required");
    expect(await run(wt(), "agent", "fly", "x")).toBe(1);
  });

  it("is in wim help, and refuses another command's flags", async () => {
    const t = wt();
    expect(await run(t, "help", "agent")).toBe(0);
    expect(said(t)).toContain("wim agent serve <config>");
    const u = wt();
    expect(await run(u, "agent", "doctor", "x", "--relay", "ws://x")).toBe(2);
  });
});

describe("wim agent init", () => {
  it("writes a valid direct config from roster ids, private to its owner, and lists the devices by id", async () => {
    const cfg = await fresh("direct");
    const t = wt();
    expect(await run(t, "agent", "init", cfg, "--allow", sender.device.id, "--wake-file", "wake", "--room", "#agents")).toBe(0);
    const c = JSON.parse(await fs.readFile(cfg, "utf8")) as Record<string, Record<string, unknown>>;
    expect(c["senders"]!["devices"]).toEqual([sender.device.id]);
    expect(c["runner"]).toMatchObject({ command: process.execPath, args: [stub, "agent", "runner"] });
    // A relative --wake-file is taken from the working directory (the device's home here).
    expect(c["wake"]).toEqual({ mode: "local", codeFile: join(worker.root, "wake") });
    expect(c["replies"]!["room"]).toBe("#agents");
    if (POSIX) expect((await fs.stat(cfg)).mode & 0o777).toBe(0o600);
    expect(said(t)).toContain(`  ${sender.device.id}  laptop`);
    expect(said(t)).not.toContain(`  ${worker.device.id}  worker`);
    expect(said(t)).not.toContain("Still to fill in");
  });

  it("with profiles, writes the runner config that lists them", async () => {
    const cfg = await fresh("profiles");
    const t = wt();
    expect(await run(t, "agent", "init", cfg, "--allow", sender.device.id, "--profiles", "a, b")).toBe(0);
    const runner = join(dir, "profiles", "runner.json");
    expect(JSON.parse(await fs.readFile(runner, "utf8"))).toEqual({ profiles: { a: {}, b: {} } });
    expect(JSON.parse(await fs.readFile(cfg, "utf8")).runner.args).toEqual([stub, "agent", "runner", "--config", runner]);
    expect(said(t)).toContain(`Also wrote ${runner}.`);
    // A runner config already there is never overwritten.
    await fs.rm(cfg);
    const u = wt();
    expect(await run(u, "agent", "init", cfg, "--allow", sender.device.id, "--profiles", "a")).toBe(1);
    expect(u.err.join("\n")).toContain(`${runner} exists`);
  });

  it("privileged: sudo -n on the launcher, and a runner config for root to install", async () => {
    const cfg = await fresh("priv");
    const t = wt();
    expect(await run(t, "agent", "init", cfg, "--mode", "privileged", "--auth", "wif", "--allow", sender.device.id)).toBe(0);
    const c = JSON.parse(await fs.readFile(cfg, "utf8")) as { runner: { command: string; args: string[] }; wake: unknown };
    expect(c.runner.command).toBe("sudo");
    expect(c.runner.args[0]).toBe("-n");
    expect(c.wake).toEqual({ mode: "runner" });
    const priv = await fs.readFile(join(dir, "priv", "privileged.json"), "utf8");
    expect(priv).toContain(PLACEHOLDER);
    expect(said(t)).toMatch(/As root, install it as \S+ \(owner root, mode 600\)/);
    await fs.rm(cfg);
    expect(await run(wt(), "agent", "init", cfg, "--mode", "privileged")).toBe(1);
  });

  it("without --allow, leaves a placeholder and says so", async () => {
    const cfg = await fresh("empty");
    const t = wt();
    expect(await run(t, "agent", "init", cfg)).toBe(0);
    expect(said(t)).toContain("Still to fill in: senders.devices[0].");
    // serve and run refuse it before doing anything.
    const u = wt();
    expect(await run(u, "agent", "serve", cfg)).toBe(1);
    expect(u.err.join("\n")).toContain("still to fill in: senders.devices[0]");
  });

  it("refuses a device name, a bad mode or auth, and an existing file", async () => {
    const cfg = await fresh("refuse");
    const t = wt();
    expect(await run(t, "agent", "init", cfg, "--allow", "laptop")).toBe(1);
    expect(t.err.join("\n")).toContain(`use ${sender.device.id}`);
    expect(await run(wt(), "agent", "init", cfg, "--mode", "root")).toBe(1);
    expect(await run(wt(), "agent", "init", cfg, "--auth", "password")).toBe(1);
    await fs.writeFile(cfg, "{}");
    const u = wt();
    expect(await run(u, "agent", "init", cfg)).toBe(1);
    expect(u.err.join("\n")).toContain("exists: edit it, or remove it first");
  });
});

describe("wim agent init --kit", () => {
  it("writes the deployment kit alone, or with a config, and never over a directory that holds files", async () => {
    const out = join(dir, "kit-only");
    const t = wt();
    expect(await run(t, "agent", "init", "--kit", out)).toBe(0);
    expect(said(t)).toMatch(/Wrote the deployment kit to \S+kit-only \(\d+ files\)\. Its guide is \S+deploy\.md\./);
    expect(await fs.readdir(join(out, "deploy"))).toContain("wim-agent-privileged-runner");
    const u = wt();
    expect(await run(u, "agent", "init", "--kit", out)).toBe(1);
    expect(u.err.join("\n")).toContain("is not empty");
    const cfg = await fresh("kit-and-config");
    const v = wt();
    expect(await run(v, "agent", "init", cfg, "--allow", sender.device.id, "--kit", join(dir, "kit-and-config", "kit"))).toBe(0);
    expect(said(v)).toContain("Wrote the deployment kit");
    expect(said(v)).toContain(`Wrote ${cfg}.`);
  });

  it("says so when this wim carries no kit", async () => {
    const t = wt({ workerKit: [join(dir, "no-kit-here")] });
    expect(await run(t, "agent", "init", "--kit", join(dir, "kit-none"))).toBe(1);
    expect(t.err.join("\n")).toContain("this wim carries no deployment kit");
  });

  it("looks beside the published wim.mjs first, then in the repository", () => {
    const [published, repo] = kitCandidates(pathToFileURL(join(dir, "pkg", "wim.mjs")).href);
    expect(published).toBe(join(dir, "pkg", "agent-kit") + sep);
    expect(repo).toBe(join(dir, "..", "agent") + sep);
  });
});

describe("wim agent run --once", () => {
  it("sends one request through the configured runner", async () => {
    const cfg = await fresh("once");
    expect(await run(wt(), "agent", "init", cfg, "--allow", sender.device.id)).toBe(0);
    const t = wt();
    const out: string[] = [];
    t.io.stdout.on("data", (c: Buffer) => void out.push(c.toString()));
    feed(t, JSON.stringify({ v: 2, id: "m-once", from: { device: sender.device.id, address: "a@laptop" }, profile: "", text: "hi" }));
    expect(await run(t, "agent", "run", "--once", cfg)).toBe(0);
    expect(out.join("")).toBe("ok m-once");
  });

  it("needs --once, and a config that is JSON", async () => {
    const t = wt();
    expect(await run(t, "agent", "run", "x.json")).toBe(1);
    expect(t.err.join("\n")).toContain("usage: wim agent run --once");
    const bad = join(dir, "bad.json");
    await fs.writeFile(bad, "{");
    const u = wt();
    expect(await run(u, "agent", "run", "--once", bad)).toBe(1);
    expect(u.err.join("\n")).toContain("not valid JSON");
  });
});

describe("wim agent runner", () => {
  it("is the built-in SDK runner: it reads the request and refuses to start with no key", async () => {
    const t = wt({}, { ANTHROPIC_API_KEY: undefined });
    feed(t, JSON.stringify({ v: 2, id: "m-r", from: { device: sender.device.id, address: "a@laptop" }, profile: "", text: "hi" }));
    expect(await run(t, "agent", "runner")).toBe(1);
    expect(t.err.join("\n")).toContain("no API key");
  });

  it("hands --config to the runner", async () => {
    const t = wt();
    feed(t, "{}");
    expect(await run(t, "agent", "runner", "--config", join(dir, "no-such-runner.json"))).toBe(1);
    expect(t.err.join("\n")).toContain("config not read");
  });
});

describe("wim agent privileged", () => {
  it("is the privileged runner's entry: no arguments but --worker, and the job child needs its job", async () => {
    // The job child (`--worker`) is started by the runner with its job in WIM_AGENT_JOB; without
    // one it refuses before reading anything.
    const t = wt({}, { WIM_AGENT_JOB: undefined });
    feed(t, "");
    // Windows has no uid to refuse root by, so the job child fails there in another way.
    const code = await run(t, "agent", "privileged", "--worker");
    if (POSIX) expect(code).toBe(2);
    else expect(code).not.toBe(0);
    // Any other argument is refused by the CLI before the runner sees it.
    expect(await run(wt(), "agent", "privileged", "--config", "x")).toBe(2);
    expect(await run(wt(), "agent", "privileged", "extra")).toBe(2);
    // With no arguments it is the runner itself; here, with no config of its own, it refuses.
    const r = wt();
    feed(r, "");
    expect(await run(r, "agent", "privileged")).not.toBe(0);
  });
});

describe("wim agent doctor", () => {
  it("checks a fresh direct install, with this machine's real view but the probes", async () => {
    const cfg = await fresh("doctor");
    expect(await run(wt(), "agent", "init", cfg, "--allow", sender.device.id)).toBe(0);
    const t = wt({}, { PATH: process.env["PATH"], ANTHROPIC_API_KEY: "test-key-not-real" });
    const code = await run(t, "agent", "doctor", cfg);
    const text = said(t);
    expect(text).toMatch(/ok +Node \S+ is supported/);
    expect(text).toContain(`allowed sender laptop (${sender.device.id}) is in the roster and trusted here`);
    expect(text).toContain("wim devices trust worker --relayed");
    expect(text).toMatch(/ok +runner \S+ is /);
    expect(text).toMatch(/Claude Agent SDK \S+ is installed/);
    expect(text).not.toContain("test-key-not-real");
    // Run as root the peer user is root, which doctor reports, and Windows has no id(1) to find
    // the user; as anyone else on Linux or macOS this is clean.
    if (POSIX) expect(code).toBe(process.getuid!() === 0 ? 1 : 0);
    expect(said(t)).toMatch(code === 0 ? /No problems found\./ : /Problems: \d+\./);
  });

  it("reads the runner config it names, probes for real, and runs without a uid (Windows)", async () => {
    const cfg = join(dir, "profiles", "worker.json");
    await fs.rm(cfg, { force: true });
    await fs.rm(join(dir, "profiles", "runner.json"), { force: true });
    expect(await run(wt(), "agent", "init", cfg, "--allow", sender.device.id, "--profiles", "a")).toBe(0);
    // No probe stand-in: the metadata endpoint is really dialled (2 s at most per address).
    const t = term(worker.root, relay, {}, { PATH: process.env["PATH"] });
    await run(t, "agent", "doctor", cfg);
    expect(said(t)).toContain(`profile a is in the runner config ${join(dir, "profiles", "runner.json")}`);
    expect(said(t)).toMatch(/(ok|problem|skip) +job user \S+ (cannot reach|can reach|reaching) the (cloud )?metadata endpoint 169\.254\.169\.254:80/);
    // With no uid (Windows), no user's view can be probed: those checks are skipped.
    const u = term(worker.root, relay, { uid: undefined }, { PATH: process.env["PATH"] });
    await run(u, "agent", "doctor", cfg);
    expect(said(u)).toMatch(/skip +job user \S+ reaching the metadata endpoint/);
  }, 30_000);

  it("a missing config, and a device in no mesh", async () => {
    const lonely = await newDevice("lonely");
    const t = term(lonely.root, relay, { workerDoctor: { probe: async () => "no" } });
    expect(await run(t, "agent", "doctor", join(dir, "nope.json"))).toBe(1);
    expect(said(t)).toMatch(/nope\.json: cannot be read \(ENOENT\)/);
    const cfg = join(dir, "lonely.json");
    await fs.writeFile(cfg, JSON.stringify({ senders: { devices: [sender.device.id] }, wake: { mode: "none" }, runner: { command: "/bin/sh" }, limits: { ledgerPath: join(dir, "l.json") } }));
    const u = term(lonely.root, relay, { workerDoctor: { probe: async () => "no" } });
    await run(u, "agent", "doctor", cfg);
    expect(said(u)).toMatch(/skip +allowed senders against the roster:/);
  });

  it("a privileged config: the root-only parts say so when not root", async () => {
    const cfg = await fresh("doctor-priv");
    expect(await run(wt(), "agent", "init", cfg, "--mode", "privileged", "--allow", sender.device.id)).toBe(0);
    const t = wt();
    expect(await run(t, "agent", "doctor", cfg, "--peer-user", "nobody", "--privileged-config", join(dir, "doctor-priv", "privileged.json"), "--sudoers", join(dir, "sudoers"))).toBe(1);
    expect(said(t)).toMatch(/privileged runner \S+: ENOENT|privileged runner \S+ is root's/);
    // The template init wrote is one the privileged runner's own parser accepts (its paths are
    // POSIX paths, so a Windows home is refused there, which is right).
    if (POSIX) expect(said(t)).toMatch(/ok +\S+privileged\.json is a valid privileged runner config/);
  });
});

describe("which, statOf and sdkFrom", () => {
  it("which: an absolute executable, a PATH match, and nothing else", async () => {
    const exe = join(dir, "tool");
    await fs.writeFile(exe, "#!/bin/sh\n", { mode: 0o755 });
    const plain = join(dir, "plain");
    await fs.writeFile(plain, "", { mode: 0o644 });
    expect(await which(exe, undefined)).toBe(exe);
    // Windows has no execute bit: there every file that exists is "executable".
    if (POSIX) expect(await which(plain, undefined)).toBeUndefined();
    expect(await which(join(dir, "absent"), undefined)).toBeUndefined();
    expect(await which("tool", `${join(dir, "nonexistent")}${delimiter}${dir}`)).toBe(exe);
    expect(await which("tool", "")).toBeUndefined();
    expect(await which("tool", undefined)).toBeUndefined();
    expect(await which("./tool", dir)).toBeUndefined();
  });

  it("statOf and kindOf name files, directories, sockets and the rest", async () => {
    const f = join(dir, "f");
    await fs.writeFile(f, "x");
    expect((await statOf(f)).kind).toBe("file");
    expect((await statOf(dir)).kind).toBe("dir");
    const kind = (file: boolean, d: boolean, sock: boolean) => kindOf({ isFile: () => file, isDirectory: () => d, isSocket: () => sock });
    expect(kind(false, false, true)).toBe("socket");
    expect(kind(false, false, false)).toBe("other");
  });

  it("sdkFrom resolves the SDK beside a global wim.mjs, as the dynamic import would", async () => {
    // <prefix>/lib/node_modules/worldinmotion/wim.mjs next to <prefix>/lib/node_modules/@anthropic-ai/claude-agent-sdk.
    const lib = join(dir, "prefix", "lib", "node_modules");
    const wim = join(lib, "worldinmotion", "wim.mjs");
    const sdk = join(lib, "@anthropic-ai", "claude-agent-sdk");
    await fs.mkdir(join(lib, "worldinmotion"), { recursive: true });
    await fs.writeFile(wim, "");
    // Not installed beside it (a separate prefix, since Node caches lookups it has made).
    const bare = join(dir, "bare", "lib", "node_modules", "worldinmotion", "wim.mjs");
    await fs.mkdir(join(bare, ".."), { recursive: true });
    await fs.writeFile(bare, "");
    expect(sdkFrom(pathToFileURL(bare).href)).toBeUndefined();
    await fs.mkdir(sdk, { recursive: true });
    await fs.writeFile(join(sdk, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "9.9.9", type: "module", exports: { ".": { default: "./sdk.mjs" } } }));
    await fs.writeFile(join(sdk, "sdk.mjs"), "export const query = () => undefined;\n");
    expect(sdkFrom(pathToFileURL(wim).href)).toEqual({ version: "9.9.9" });
    // The same resolution Node's import makes from there.
    const resolved = await import(pathToFileURL(join(sdk, "sdk.mjs")).href);
    expect(typeof resolved.query).toBe("function");
    await fs.writeFile(join(sdk, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", exports: { ".": { default: "./sdk.mjs" } } }));
    expect(sdkFrom(pathToFileURL(wim).href)).toEqual({ version: "(unknown version)" });
  });
});
