import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { builtInRunner, nodeSupported, privilegedRunner, runDoctor, type Check, type DoctorDeps, type DoctorInput, type FileStat, type PrivilegedView } from "../src/doctor.ts";
import type { ProbeAnswer, ProbeOp, UserId } from "../src/probe.ts";

const SELF = "S".repeat(22);
const LAPTOP = "L".repeat(22);
const DESK = "D".repeat(22);
const LAUNCHER = "/usr/local/sbin/runner";
const SUDOERS = "/etc/sudoers.d/w";
const PRIV = "/etc/w/privileged.json";

const users: Record<string, UserId> = {
  peer: { name: "peer", uid: 1001, gid: 1001 },
  job: { name: "job", uid: 1002, gid: 1002 },
  root: { name: "root", uid: 0, gid: 0 },
};

const errno = (code: string) => Object.assign(new Error(`${code}: nope`), { code });

/** A machine: files by path, and what each user can do (`probes["peer connect 169.254.169.254"]`). */
type Machine = {
  uid: number;
  files: Record<string, FileStat | Error>;
  texts: Record<string, string | Error>;
  probes: Record<string, ProbeAnswer>;
  priv?: PrivilegedView | Error;
  which?: string;
  sdk?: { version: string };
  env?: Record<string, string>;
  node?: string;
};

const file = (uid: number, mode: number, kind: FileStat["kind"] = "file"): FileStat => ({ uid, gid: uid, mode, kind });

function deps(m: Machine, seen: string[] = []): DoctorDeps {
  return {
    uid: m.uid,
    userName: "peer",
    nodeVersion: m.node ?? "24.1.0",
    env: m.env ?? {},
    loadConfig,
    stat: async (p) => {
      const f = m.files[p];
      if (f === undefined) throw errno("ENOENT");
      if (f instanceof Error) throw f;
      return f;
    },
    readText: async (p) => {
      const t = m.texts[p];
      if (t === undefined) throw errno("ENOENT");
      if (t instanceof Error) throw t;
      return t;
    },
    lookupUser: async (name) => users[name],
    probe: async (as: UserId | undefined, op: ProbeOp) => {
      const who = as?.name ?? "self";
      const key = `${who} ${op.op} ${op.op === "connect" ? op.host : op.path}`;
      seen.push(key);
      return m.probes[key] ?? m.probes[`${who} ${op.op}`] ?? "no";
    },
    which: async () => m.which,
    sdk: () => m.sdk,
    loadPrivileged: async () => {
      if (m.priv === undefined) throw errno("ENOENT");
      if (m.priv instanceof Error) throw m.priv;
      return m.priv;
    },
    sudoersLine: (peer) => `${peer} ALL=(root) NOPASSWD: ${LAUNCHER} ""`,
  };
}

const mesh: DoctorInput["mesh"] = {
  self: { id: SELF, name: "worker-box" },
  devices: [
    { id: SELF, name: "worker-box" },
    { id: LAPTOP, name: "laptop" },
    { id: DESK, name: "desk" },
  ],
  trusted: (id) => id === LAPTOP,
};

const directConfig = (over: Record<string, unknown> = {}) => ({
  senders: { devices: [LAPTOP] },
  wake: { mode: "none" },
  runner: { command: "/usr/bin/node", args: ["/opt/wim.mjs", "worker", "runner"] },
  limits: { ledgerPath: "/var/lib/w/ledger.json" },
  ...over,
});
const privConfig = (over: Record<string, unknown> = {}) => directConfig({ wake: { mode: "runner" }, runner: { command: "sudo", args: ["-n", LAUNCHER] }, ...over });

const privView = (over: Partial<PrivilegedView> = {}): PrivilegedView => ({
  profiles: { a: { auth: { type: "api-key", keyFile: "/etc/w/a.key" } }, b: { auth: { type: "wif", identity: { type: "file" } } } },
  defaultProfile: "a",
  lock: { path: "/run/w/job.lock" },
  wakeCode: { file: "/etc/w/wake-code" },
  worker: { user: "job" },
  runDir: "/run/w",
  ...over,
});

async function doctor(config: unknown, m: Machine, input: Partial<DoctorInput> = {}) {
  const lines: Check[] = [];
  const seen: string[] = [];
  const problems = await runDoctor(
    { configPath: "w.json", configText: typeof config === "string" ? config : JSON.stringify(config), privilegedPath: PRIV, launcherPath: LAUNCHER, sudoersPath: SUDOERS, mesh, ...input },
    deps(m, seen),
    (c) => lines.push(c),
  );
  const has = (level: Check["level"], re: RegExp) => lines.some((c) => c.level === level && re.test(c.line));
  return { problems, lines, has, seen };
}

const healthyPriv = (): Machine => ({
  uid: 0,
  files: { [LAUNCHER]: file(0, 0o755), "/etc/w/a.key": file(0, 0o600), "/run/w": file(0, 0o750, "dir") },
  texts: { [SUDOERS]: `# the worker\npeer ALL=(root) NOPASSWD: ${LAUNCHER} ""\n` },
  probes: {},
  priv: privView(),
  sdk: { version: "0.3.310" },
});

describe("helpers", () => {
  it("nodeSupported compares to 22.18.0", () => {
    expect(nodeSupported("22.18.0")).toBe(true);
    expect(nodeSupported("v22.18")).toBe(true);
    expect(nodeSupported("22.17.9")).toBe(false);
    expect(nodeSupported("23.0.0")).toBe(true);
    expect(nodeSupported("20.30.0")).toBe(false);
  });
  it("privilegedRunner and builtInRunner read the runner line", () => {
    const c = (command: string, args: string[]) => loadConfig(directConfig({ runner: { command, args } }));
    expect(privilegedRunner(c(LAUNCHER, []), LAUNCHER)).toBe(true);
    expect(privilegedRunner(c("/usr/bin/sudo", ["-n", LAUNCHER]), LAUNCHER)).toBe(true);
    expect(privilegedRunner(c("sudo", ["-n", "/other"]), LAUNCHER)).toBe(false);
    expect(privilegedRunner(c("/bin/my-runner", [LAUNCHER]), LAUNCHER)).toBe(false);
    expect(builtInRunner(c("/usr/local/bin/wim-agent-runner", []), LAUNCHER)).toBe(true);
    expect(builtInRunner(c("node", ["wim.mjs", "worker", "runner", "--config", "x"]), LAUNCHER)).toBe(true);
    expect(builtInRunner(c("node", ["wim.mjs", "worker", "serve"]), LAUNCHER)).toBe(false);
    expect(builtInRunner(c("/bin/my-runner", []), LAUNCHER)).toBe(false);
  });
});

describe("the config itself", () => {
  it("an unreadable file stops there with the init hint", async () => {
    const d = await doctor(undefined, healthyPriv(), { configText: undefined, readError: "ENOENT" });
    expect(d.problems).toBe(1);
    expect(d.has("problem", /cannot be read \(ENOENT\); `wim worker init w\.json`/)).toBe(true);
    const e = await doctor(undefined, healthyPriv(), { configText: undefined });
    expect(e.has("problem", /\(unknown\)/)).toBe(true);
  });
  it("bad JSON, placeholders and schema errors are each a problem", async () => {
    expect((await doctor("{", healthyPriv())).has("problem", /not valid JSON/)).toBe(true);
    expect((await doctor(directConfig({ senders: { devices: ["REPLACE-ME"] } }), healthyPriv())).has("problem", /still to fill in: senders\.devices\[0\]/)).toBe(true);
    const bad = await doctor(directConfig({ senders: { devices: ["laptop"] } }), healthyPriv());
    expect(bad.has("problem", /w\.json: senders\.devices\.0: a 22-character device id/)).toBe(true);
  });
  it("an old Node is a problem", async () => {
    const d = await doctor(directConfig(), { ...healthyPriv(), node: "20.1.0" });
    expect(d.has("problem", /Node 20\.1\.0 is too old/)).toBe(true);
  });
});

describe("senders", () => {
  it("each allowed id is checked against the roster and trust; the relayed hint is printed", async () => {
    const d = await doctor(directConfig({ senders: { devices: [LAPTOP, DESK, SELF, "Q".repeat(22)] } }), { ...healthyPriv(), uid: 1001 });
    expect(d.has("ok", /allowed sender laptop \(L+\) is in the roster and trusted here/)).toBe(true);
    expect(d.has("problem", /allowed sender desk \(D+\) is not trusted here.*wim devices trust desk/)).toBe(true);
    expect(d.has("problem", /is this worker's own device/)).toBe(true);
    expect(d.has("problem", /Q+ is not in this mesh's roster/)).toBe(true);
    expect(d.has("info", /wim devices trust worker-box --relayed/)).toBe(true);
  });
  it("without requireTrusted, trust is not asked", async () => {
    const d = await doctor(directConfig({ senders: { devices: [DESK], requireTrusted: false } }), { ...healthyPriv(), uid: 1001 });
    expect(d.has("ok", /allowed sender desk \(D+\) is in the roster$/)).toBe(true);
  });
  it("no mesh: skipped with the reason", async () => {
    const d = await doctor(directConfig(), { ...healthyPriv(), uid: 1001 }, { mesh: { error: "no device here" } });
    expect(d.has("skip", /allowed senders against the roster: no device here/)).toBe(true);
  });
});

describe("the peer user", () => {
  it("must exist and not be root", async () => {
    expect((await doctor(directConfig(), healthyPriv(), { peerUser: "ghost" })).has("problem", /peer user ghost: no such user/)).toBe(true);
    expect((await doctor(directConfig(), healthyPriv(), { peerUser: "root" })).has("problem", /peer user root is root/)).toBe(true);
    expect((await doctor(directConfig(), { ...healthyPriv(), uid: 1001 })).has("ok", /peer user peer is not root \(uid 1001\)/)).toBe(true);
  });
});

describe("direct runner", () => {
  it("as the peer itself: runner found, metadata blocked, SDK there", async () => {
    const d = await doctor(directConfig(), { ...healthyPriv(), uid: 1001, which: "/usr/bin/node", env: { ANTHROPIC_API_KEY: "sk-test" } });
    expect(d.problems).toBe(0);
    expect(d.has("ok", /runner \/usr\/bin\/node is \/usr\/bin\/node/)).toBe(true);
    expect(d.has("ok", /job user peer cannot reach the metadata endpoint 169\.254\.169\.254:80/)).toBe(true);
    expect(d.has("ok", /\[fd00:ec2::254\]:80/)).toBe(true);
    expect(d.has("ok", /ANTHROPIC_API_KEY is set \(not shown\)/)).toBe(true);
    expect(d.lines.some((c) => c.line.includes("sk-test"))).toBe(false);
    expect(d.has("ok", /Claude Agent SDK 0\.3\.310 is installed/)).toBe(true);
    // Run as the peer, it probes as itself.
    expect(d.seen.every((s) => s.startsWith("self "))).toBe(true);
  });

  it("problems: no runner, metadata reachable, a probe that fails, no SDK", async () => {
    const d = await doctor(directConfig(), { ...healthyPriv(), uid: 1001, probes: { "self connect 169.254.169.254": "yes", "self connect fd00:ec2::254": "error" }, sdk: undefined });
    expect(d.has("problem", /runner \/usr\/bin\/node is not found/)).toBe(true);
    expect(d.has("problem", /can reach the cloud metadata endpoint 169\.254\.169\.254:80/)).toBe(true);
    expect(d.has("problem", /metadata probe of \[fd00:ec2::254\]:80 failed to run/)).toBe(true);
    expect(d.has("problem", /Agent SDK is not installed/)).toBe(true);
    expect(d.has("info", /ANTHROPIC_API_KEY is not set here/)).toBe(true);
  });

  it("another user, not as root: the probes are skipped", async () => {
    const d = await doctor(directConfig(), { ...healthyPriv(), uid: 1500, which: "/usr/bin/node" });
    expect(d.has("skip", /job user peer reaching the metadata endpoint .*sudo wim worker doctor/)).toBe(true);
    expect(d.seen).toEqual([]);
  });

  it("as root: probes run as the peer's uid", async () => {
    const d = await doctor(directConfig(), { ...healthyPriv(), which: "/usr/bin/node" });
    expect(d.seen[0]).toBe("peer connect 169.254.169.254");
  });

  it("a local wake code file: closed to others, readable by the peer (600, or 640 through its group)", async () => {
    const cfg = directConfig({ wake: { mode: "local", codeFile: "/home/peer/wake" } });
    const run = (f: FileStat | undefined, read: ProbeAnswer = "yes", o: { peerUser?: string; uid?: number } = {}) =>
      doctor(cfg, { ...healthyPriv(), uid: o.uid ?? 1001, probes: { "self read /home/peer/wake": read, "peer read /home/peer/wake": read }, files: f === undefined ? {} : { "/home/peer/wake": f } }, o.peerUser === undefined ? {} : { peerUser: o.peerUser });
    expect((await run(file(1001, 0o600))).has("ok", /wake code file \/home\/peer\/wake is closed to others and readable by the peer user peer/)).toBe(true);
    expect((await run(file(0, 0o640))).has("ok", /closed to others and readable by the peer user/)).toBe(true);
    expect((await run(file(1001, 0o644))).has("problem", /open to others or writable by its group \(mode 644\)/)).toBe(true);
    expect((await run(file(1001, 0o660))).has("problem", /writable by its group \(mode 660\)/)).toBe(true);
    expect((await run(file(0, 0o600), "no")).has("problem", /the peer user peer cannot read it, and the worker needs to/)).toBe(true);
    expect((await run(undefined)).has("problem", /wake code file \/home\/peer\/wake: ENOENT/)).toBe(true);
    // An unknown peer user: only the mode can be checked; another user, not as root: skipped.
    expect((await run(file(1002, 0o600), "yes", { peerUser: "ghost" })).has("ok", /wake code file \/home\/peer\/wake is closed to others \(not shown\)/)).toBe(true);
    expect((await run(file(1001, 0o600), "yes", { uid: 1500 })).has("skip", /wake code file \/home\/peer\/wake readable by peer: run `sudo/)).toBe(true);
  });

  it("a local wake code from a variable has no file to check", async () => {
    const d = await doctor(directConfig({ wake: { mode: "local", codeEnv: "WAKE" } }), { ...healthyPriv(), uid: 1001 });
    expect(d.lines.some((c) => /wake code file/.test(c.line))).toBe(false);
  });

  it("profiles need the built-in runner's --config listing them, with private key files", async () => {
    const withProfiles = (args: string[]) => directConfig({ profiles: { allowed: ["a", "b"], default: "a" }, runner: { command: "/usr/bin/node", args } });
    const base = ["/opt/wim.mjs", "worker", "runner"];
    expect((await doctor(withProfiles(base), { ...healthyPriv(), uid: 1001 })).has("problem", /give it `--config <runner\.json>` listing a, b/)).toBe(true);
    // `--config` as the last word names no file.
    expect((await doctor(withProfiles([...base, "--config"]), { ...healthyPriv(), uid: 1001 })).has("problem", /give it `--config/)).toBe(true);
    const rc = (texts: Record<string, string | Error>, files: Record<string, FileStat> = {}) => doctor(withProfiles([...base, "--config", "/w/runner.json"]), { ...healthyPriv(), uid: 1001, texts, files });
    expect((await rc({})).has("problem", /runner config \/w\/runner\.json: ENOENT/)).toBe(true);
    expect((await rc({ "/w/runner.json": "{" })).has("problem", /runner config \/w\/runner\.json:/)).toBe(true);
    const d = await rc({ "/w/runner.json": JSON.stringify({ keyFile: "/w/k0", profiles: { a: { keyFile: "/w/k1" }, c: { keyFile: "/w/k2" } } }) }, { "/w/k0": file(1001, 0o600), "/w/k1": file(1001, 0o644) });
    expect(d.has("ok", /profile a is in the runner config/)).toBe(true);
    expect(d.has("problem", /profile b: the worker accepts it, but the runner config \/w\/runner\.json does not list it/)).toBe(true);
    // The fake machine's probes answer "no" unless told: the peer cannot read k0.
    expect(d.has("problem", /key file \/w\/k0: the peer user peer cannot read it/)).toBe(true);
    expect(d.has("problem", /key file \/w\/k1 is open to others/)).toBe(true);
    expect(d.has("problem", /key file \/w\/k2: ENOENT/)).toBe(true);
    // No profiles, and a runner config without any: nothing to compare.
    const none = await doctor(directConfig({ runner: { command: "/usr/bin/node", args: [...base, "--config", "/w/r.json"] } }), { ...healthyPriv(), uid: 1001, texts: { "/w/r.json": "{}" } });
    expect(none.lines.some((c) => /profile|key file/.test(c.line))).toBe(false);
    // A key owned by another user, with the peer unknown: only the mode counts.
    const ghost = await doctor(withProfiles([...base, "--config", "/w/runner.json"]), { ...healthyPriv(), uid: 1001, texts: { "/w/runner.json": JSON.stringify({ keyFile: "/w/k0" }) }, files: { "/w/k0": file(4, 0o600) } }, { peerUser: "ghost" });
    expect(ghost.has("ok", /key file \/w\/k0 is closed to others \(not shown\)/)).toBe(true);
  });

  it("your own runner: profiles are its business and the SDK is not checked", async () => {
    const d = await doctor(directConfig({ profiles: { allowed: ["a"], default: "a" }, runner: { command: "/opt/my-runner", args: [], passEnv: ["PATH"] } }), { ...healthyPriv(), uid: 1001, which: "/opt/my-runner" });
    expect(d.has("info", /profiles a go to your runner/)).toBe(true);
    expect(d.has("info", /runner \/opt\/my-runner is your own: the Agent SDK check is skipped/)).toBe(true);
    expect(d.has("info", /runner\.passEnv does not pass ANTHROPIC_API_KEY/)).toBe(true);
    const plain = await doctor(directConfig({ runner: { command: "/opt/my-runner", args: [] } }), { ...healthyPriv(), uid: 1001, which: "/opt/my-runner" });
    expect(plain.lines.some((c) => /go to your runner/.test(c.line))).toBe(false);
  });
});

describe("privileged runner", () => {
  it("a healthy install, checked as root, has no problems", async () => {
    const d = await doctor(privConfig(), healthyPriv());
    expect(d.lines.filter((c) => c.level === "problem")).toEqual([]);
    expect(d.has("ok", /privileged runner \/usr\/local\/sbin\/runner is root's/)).toBe(true);
    expect(d.has("ok", /\/etc\/sudoers\.d\/w holds exactly: peer ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/runner ""/)).toBe(true);
    expect(d.has("ok", /privileged\.json is a valid privileged runner config/)).toBe(true);
    expect(d.has("ok", /profile a: key file \/etc\/w\/a\.key is root's alone/)).toBe(true);
    expect(d.has("ok", /profile b: keyless \(workload identity, file\)/)).toBe(true);
    expect(d.has("ok", /wake code \/etc\/w\/wake-code is unreadable by the peer user peer/)).toBe(true);
    expect(d.has("ok", /job user job cannot reach the metadata endpoint 169\.254\.169\.254:80/)).toBe(true);
    expect(d.has("ok", /peer user peer cannot reach the metadata endpoint/)).toBe(true);
    expect(d.has("ok", /\/run\/w \(the lock \/run\/w\/job\.lock\) is root's to write/)).toBe(true);
    expect(d.has("ok", /peer user peer cannot write \/run\/w/)).toBe(true);
    expect(d.has("ok", /job user job cannot write \/run\/w/)).toBe(true);
    expect(d.has("ok", /peer user peer cannot read \/run\/w/)).toBe(true);
    expect(d.has("ok", /Claude Agent SDK/)).toBe(true);
  });

  it("not as root: root-only checks are skipped, never guessed", async () => {
    const d = await doctor(privConfig(), { ...healthyPriv(), uid: 1001, priv: errno("EACCES") });
    expect(d.has("skip", /sudoers line in \/etc\/sudoers\.d\/w: run `sudo wim worker doctor`/)).toBe(true);
    expect(d.has("skip", /privileged\.json: run `sudo wim worker doctor`/)).toBe(true);
  });

  it("not as root but readable: probes as the peer run, the job user's are skipped", async () => {
    const d = await doctor(privConfig(), { ...healthyPriv(), uid: 1001, files: { ...healthyPriv().files, "/etc/w/a.key": errno("EACCES") as never } });
    expect(d.has("skip", /profile a: key file \/etc\/w\/a\.key: run `sudo/)).toBe(true);
    expect(d.has("ok", /wake code \/etc\/w\/wake-code is unreadable by the peer user/)).toBe(true);
    expect(d.has("skip", /job user job reaching the metadata endpoint/)).toBe(true);
    expect(d.has("skip", /job user job writing \/run\/w/)).toBe(true);
    const other = await doctor(privConfig(), { ...healthyPriv(), uid: 1500 });
    expect(other.has("skip", /wake code \/etc\/w\/wake-code unreadable by peer/)).toBe(true);
    expect(other.has("skip", /peer user peer reading \/run\/w/)).toBe(true);
  });

  it("the sudoers file: extra rules, a different rule, or none", async () => {
    const run = (text: string | Error) => doctor(privConfig(), { ...healthyPriv(), texts: { [SUDOERS]: text } });
    expect((await run(`peer ALL=(root) NOPASSWD: ${LAUNCHER}\n`)).has("problem", /must hold exactly one rule, `peer ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/runner ""` \(found 1 rule line\(s\) that differ\)/)).toBe(true);
    expect((await run(`peer ALL=(root) NOPASSWD: ${LAUNCHER} ""\npeer ALL=(ALL) ALL\n`)).has("problem", /found 2 rule line/)).toBe(true);
    expect((await run(errno("ENOENT"))).has("problem", /\/etc\/sudoers\.d\/w: ENOENT/)).toBe(true);
  });

  it("the launcher must be root's and not writable by others", async () => {
    const run = (f: FileStat | undefined) => doctor(privConfig(), { ...healthyPriv(), files: { ...healthyPriv().files, ...(f === undefined ? {} : { [LAUNCHER]: f }) } });
    expect((await run(file(1001, 0o755))).has("problem", /privileged runner \/usr\/local\/sbin\/runner must be owned by root/)).toBe(true);
    expect((await run(file(0, 0o775))).has("problem", /must be owned by root and not group or other writable/)).toBe(true);
    const gone = await doctor(privConfig(), { ...healthyPriv(), files: { "/etc/w/a.key": file(0, 0o600), "/run/w": file(0, 0o750, "dir") } });
    expect(gone.has("problem", /privileged runner \/usr\/local\/sbin\/runner: ENOENT/)).toBe(true);
  });

  it("an invalid privileged config stops the privileged checks", async () => {
    const d = await doctor(privConfig(), { ...healthyPriv(), priv: new Error("profiles.a.auth: required") });
    expect(d.has("problem", /privileged\.json: profiles\.a\.auth: required/)).toBe(true);
    expect(d.lines.some((c) => /job user/.test(c.line))).toBe(false);
  });

  it("profiles: missing, bad key files", async () => {
    const d = await doctor(privConfig({ wake: { mode: "none" }, profiles: { allowed: ["a", "zz"], default: "a" } }), { ...healthyPriv(), files: { ...healthyPriv().files, "/etc/w/a.key": file(0, 0o640) } });
    expect(d.has("problem", /profile zz: the worker accepts it but \/etc\/w\/privileged\.json has no such profile/)).toBe(true);
    expect(d.has("problem", /profile a: key file \/etc\/w\/a\.key must be owned by root with mode 600/)).toBe(true);
    const notRoot = await doctor(privConfig(), { ...healthyPriv(), files: { ...healthyPriv().files, "/etc/w/a.key": file(5, 0o600) } });
    expect(notRoot.has("problem", /must be owned by root with mode 600/)).toBe(true);
    const gone = await doctor(privConfig(), { ...healthyPriv(), files: { [LAUNCHER]: file(0, 0o755), "/run/w": file(0, 0o750, "dir") } });
    expect(gone.has("problem", /profile a: key file \/etc\/w\/a\.key: ENOENT/)).toBe(true);
  });

  it("the wake code: local mode refused; none; from env; readable, missing or unprobed", async () => {
    expect((await doctor(privConfig({ wake: { mode: "local", codeEnv: "W" }, runner: { command: "sudo", args: ["-n", LAUNCHER], passEnv: ["PATH"] } }), healthyPriv())).has("problem", /wake\.mode is local, but the privileged runner/)).toBe(true);
    expect((await doctor(privConfig(), { ...healthyPriv(), priv: privView({ wakeCode: undefined }) as PrivilegedView })).has("info", /checks no wake code/)).toBe(true);
    expect((await doctor(privConfig(), { ...healthyPriv(), priv: privView({ wakeCode: { env: "CODE" } }) })).has("info", /runner's CODE; sudo resets the environment/)).toBe(true);
    const probe = (a: ProbeAnswer) => doctor(privConfig(), { ...healthyPriv(), probes: { "peer read /etc/w/wake-code": a } });
    expect((await probe("yes")).has("problem", /the peer user peer can read the wake code/)).toBe(true);
    expect((await probe("missing")).has("problem", /wake code \/etc\/w\/wake-code does not exist/)).toBe(true);
    expect((await probe("error")).has("problem", /wake code \/etc\/w\/wake-code: the read probe failed to run/)).toBe(true);
    // No peer user to probe as.
    const ghost = await doctor(privConfig(), healthyPriv(), { peerUser: "ghost" });
    expect(ghost.lines.some((c) => /wake code/.test(c.line))).toBe(false);
  });

  it("the job user: missing, root, the peer itself", async () => {
    expect((await doctor(privConfig(), { ...healthyPriv(), priv: privView({ worker: { user: "nobody-here" } }) })).has("problem", /job user nobody-here: no such user/)).toBe(true);
    expect((await doctor(privConfig(), { ...healthyPriv(), priv: privView({ worker: { user: "root" } }) })).has("problem", /job user root is root/)).toBe(true);
    expect((await doctor(privConfig(), { ...healthyPriv(), priv: privView({ worker: { user: "peer" } }) })).has("problem", /job user peer is the peer user/)).toBe(true);
    // The peer unknown: the job user is still checked on its own.
    const ghost = await doctor(privConfig(), healthyPriv(), { peerUser: "ghost" });
    expect(ghost.has("ok", /job user job cannot reach/)).toBe(true);
  });

  it("the run directory and lock", async () => {
    const run = (f: FileStat | undefined, probes: Record<string, ProbeAnswer> = {}) =>
      doctor(privConfig(), { ...healthyPriv(), probes, files: { [LAUNCHER]: file(0, 0o755), "/etc/w/a.key": file(0, 0o600), ...(f === undefined ? {} : { "/run/w": f }) } });
    expect((await run(file(0, 0o770, "dir"))).has("problem", /\/run\/w must be a directory owned by root/)).toBe(true);
    expect((await run(file(0, 0o700, "file"))).has("problem", /must be a directory/)).toBe(true);
    expect((await run(file(1002, 0o700, "dir"))).has("problem", /must be a directory owned by root/)).toBe(true);
    const gone = await run(undefined, { "peer write": "missing", "job write": "missing", "peer read": "missing" });
    expect(gone.has("problem", /\/run\/w: ENOENT \(the privileged runner creates it/)).toBe(true);
    expect(gone.has("ok", /peer user peer cannot write \/run\/w/)).toBe(true);
    expect(gone.has("ok", /peer user peer cannot read \/run\/w/)).toBe(true);
    const open = await run(file(0, 0o750, "dir"), { "peer write": "yes", "job write": "error", "peer read": "yes" });
    expect(open.has("problem", /peer user peer can write \/run\/w, where the runner keeps its lock/)).toBe(true);
    expect(open.has("problem", /job user job: the write probe of \/run\/w failed to run/)).toBe(true);
    expect(open.has("problem", /peer user peer can read \/run\/w, where the job's credentials are/)).toBe(true);
    const broken = await run(file(0, 0o750, "dir"), { "peer read": "error" });
    expect(broken.has("problem", /peer user peer: the read probe of \/run\/w failed to run/)).toBe(true);
    // A root job user is reported, and never probed.
    const rootJob = await doctor(privConfig(), { ...healthyPriv(), priv: privView({ worker: { user: "root" } }) });
    expect(rootJob.seen.some((s) => s.startsWith("root "))).toBe(false);
  });
});
