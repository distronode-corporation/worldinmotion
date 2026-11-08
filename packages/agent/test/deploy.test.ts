// The deployment kit in packages/agent/deploy: shellcheck on every shell file, the logic of
// wim-agent-imds-block and wim-agent-job against stub commands, and the static rules the
// sudoers example and the units must keep. The shell files run on Linux hosts only, so these
// tests do too.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { loadConfig } from "../src/config.ts";

const DEPLOY = join(dirname(fileURLToPath(import.meta.url)), "..", "deploy");
const IMDS = join(DEPLOY, "wim-agent-imds-block");
const JOB = join(DEPLOY, "wim-agent-job");
const linux = process.platform === "linux";
/** The real bash, by absolute path: the stubs' PATH holds no bash, and a stub must never find itself. */
const BASH = linux ? spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim() : "bash";

function scratch(): string {
  const root = process.env["WIM_TEST_TMP"] || tmpdir();
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "wim-agent-deploy-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function stub(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), `#!${BASH}\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}

/** Every shell file in the kit: anything with a bash or sh shebang, examples included. */
function shellFiles(dir = DEPLOY): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...shellFiles(p));
    else if (/^#!\/usr\/bin\/env (bash|sh)\b|^#!\/bin\/(ba)?sh\b/.test(readFileSync(p, "utf8"))) out.push(p);
  }
  return out.sort();
}

function run(cmd: string, args: string[], env: Record<string, string>, input?: string) {
  const r = spawnSync(BASH, [cmd, ...args], { env: { LANG: "C.UTF-8", ...env }, input, encoding: "utf8", timeout: 20_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe.skipIf(!linux)("deploy kit shell files", () => {
  it("finds the kit's shell files", () => {
    const names = shellFiles().map((p) => p.slice(DEPLOY.length + 1));
    expect(names).toEqual(expect.arrayContaining(["wim-agent-imds-block", "wim-agent-job", "wim-agent-privileged-runner", "examples/jobs/repo-digest/collect", "examples/jobs/repo-digest/post"]));
  });

  it("every one passes shellcheck (required on Linux)", () => {
    const v = spawnSync("shellcheck", ["--version"], { encoding: "utf8" });
    expect(v.status, "shellcheck must be installed to run this suite on Linux").toBe(0);
    const r = spawnSync("shellcheck", ["--severity=style", "--external-sources", ...shellFiles()], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("every one parses and is executable", () => {
    for (const f of shellFiles()) {
      expect(spawnSync("bash", ["-n", f]).status, f).toBe(0);
      expect(statSync(f).mode & 0o111, f).not.toBe(0);
    }
  });
});

/** Stubs for wim-agent-imds-block: id, nft, iptables, ip6tables, runuser and timeout, with state in files. */
function imdsRig(opts: { nft?: boolean; ip6?: boolean; uid?: string } = {}) {
  const dir = scratch();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const state = join(dir, "state");
  mkdirSync(state);
  const log = join(dir, "log");
  // id -u -> the caller's uid (FAKE_UID, default 0); id -u <user> -> a fixed table.
  stub(bin, "id", `if [ "$#" = 1 ]; then echo "\${FAKE_UID:-0}"; exit 0; fi
case "$2" in agent) echo 990;; worker) echo 991;; rootish) echo 0;; *) exit 1;; esac`);
  if (opts.nft !== false) {
    stub(bin, "nft", `echo "nft $*" >> "${log}"
f="${state}/nft"
case "$1 $2" in
  "list table") [ -f "$f" ] && { if [ -n "\${FAKE_NFT_NAMES:-}" ]; then sed -E 's/skuid ([0-9]+)/skuid "u\\1"/; s/"u990"/"agent"/; s/"u991"/"worker"/' "$f"; else cat "$f"; fi; };;
  "delete table") rm -f "$f";;
  "-f -") cat > "$f";;
  *) exit 9;;
esac`);
  }
  const ipt = (name: string) =>
    stub(bin, name, `echo "${name} $*" >> "${log}"
f="${state}/${name}"; touch "$f"; op="$1"; shift; rule="$*"
case "$op" in
  -C) grep -qxF -- "$rule" "$f";;
  -I) echo "$rule" >> "$f";;
  -D) n="$(grep -nxF -- "$rule" "$f" | head -1 | cut -d: -f1)"; [ -n "$n" ] && sed -i "\${n}d" "$f";;
  *) exit 9;;
esac`);
  ipt("iptables");
  if (opts.ip6 !== false) ipt("ip6tables");
  // runuser -u U -- timeout ... : the user's connect; exit 0 = it connected.
  stub(bin, "runuser", `echo "runuser $*" >> "${log}"; exit "\${FAKE_USER_CONNECT:-1}"`);
  stub(bin, "timeout", `exit "\${FAKE_ROOT_CONNECT:-1}"`);
  for (const t of ["grep", "cat", "rm", "sed", "touch", "head", "cut"]) {
    const which = spawnSync(BASH, ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
    stub(bin, `${t}`, `exec ${which} "$@"`);
  }
  const env = (extra: Record<string, string> = {}) => ({ PATH: bin, ...(opts.uid ? { FAKE_UID: opts.uid } : {}), ...extra });
  const read = (name: string) => (existsSync(join(state, name)) ? readFileSync(join(state, name), "utf8") : "");
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  return { env, read, calls, imds: (args: string[], extra: Record<string, string> = {}) => run(IMDS, args, env(extra)) };
}

describe.skipIf(!linux)("wim-agent-imds-block", () => {
  it.each([[[]], [["block", "agent"]], [["apply"]], [["apply", "--backend"]], [["apply", "--backend", "pf", "agent"]], [["apply", "--also"]], [["apply", "-x", "agent"]]])(
    "refuses a bad command line %j with exit 2",
    (args) => {
      const r = imdsRig().imds(args);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/usage:/);
    },
  );

  it("refuses a user name outside the grammar, so nothing odd reaches a firewall command", () => {
    for (const bad of ["Agent", "a;b", "-agent", "a b", "x".repeat(33)]) {
      const rig = imdsRig();
      const r = rig.imds(["apply", "--", bad]);
      expect(r.code, bad).toBe(2);
      expect(rig.calls()).toBe("");
    }
  });

  it("refuses an --also that is not an address", () => {
    const r = imdsRig().imds(["apply", "--also", "metadata;reboot", "agent"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/not an IP address/);
  });

  it("runs only as root", () => {
    const rig = imdsRig({ uid: "1000" });
    const r = rig.imds(["apply", "agent"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/run as root/);
    expect(rig.calls()).toBe("");
  });

  it("refuses an unknown user and a uid-0 user (root keeps the route for the runner)", () => {
    expect(imdsRig().imds(["apply", "nobody-here"]).err).toMatch(/no such user/);
    const r = imdsRig().imds(["apply", "agent", "rootish"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/refusing to block root/);
  });

  it("nft: apply writes one table for every user and address, and re-apply replaces it", () => {
    const rig = imdsRig();
    expect(rig.imds(["apply", "agent", "worker", "--also", "192.0.2.7", "--also", "2001:db8::7"]).code).toBe(0);
    const table = rig.read("nft");
    expect(table).toContain("table inet wim_agent_imds {");
    expect(table).toContain("type filter hook output priority 0; policy accept;");
    for (const uid of ["990", "991"]) {
      expect(table).toContain(`meta skuid ${uid} ip daddr 169.254.169.254 reject`);
      expect(table).toContain(`meta skuid ${uid} ip daddr 192.0.2.7 reject`);
      expect(table).toContain(`meta skuid ${uid} ip6 daddr fd00:ec2::254 reject`);
      expect(table).toContain(`meta skuid ${uid} ip6 daddr 2001:db8::7 reject`);
    }
    expect(rig.calls()).not.toContain("delete table");
    expect(rig.imds(["apply", "agent"]).code).toBe(0);
    expect(rig.calls()).toContain("nft delete table inet wim_agent_imds");
    expect(rig.read("nft")).not.toContain("skuid 991");
  });

  it("auto picks nft when it exists and iptables when it does not", () => {
    const withNft = imdsRig();
    expect(withNft.imds(["apply", "agent"]).out).toMatch(/apply done \(nft\)/);
    const noNft = imdsRig({ nft: false });
    expect(noNft.imds(["apply", "agent"]).out).toMatch(/apply done \(iptables\)/);
  });

  it("iptables: apply inserts each rule once, however often it runs", () => {
    const rig = imdsRig({ nft: false });
    for (let i = 0; i < 3; i++) expect(rig.imds(["apply", "--backend", "iptables", "agent", "worker"]).code).toBe(0);
    expect(rig.read("iptables").trim().split("\n").sort()).toEqual([
      "OUTPUT -m owner --uid-owner 990 -d 169.254.169.254 -j REJECT",
      "OUTPUT -m owner --uid-owner 991 -d 169.254.169.254 -j REJECT",
    ]);
    expect(rig.read("ip6tables").trim().split("\n").sort()).toEqual([
      "OUTPUT -m owner --uid-owner 990 -d fd00:ec2::254 -j REJECT",
      "OUTPUT -m owner --uid-owner 991 -d fd00:ec2::254 -j REJECT",
    ]);
  });

  it("iptables: without ip6tables only the IPv4 rules are written", () => {
    const rig = imdsRig({ nft: false, ip6: false });
    expect(rig.imds(["apply", "agent"]).code).toBe(0);
    expect(rig.read("iptables").trim()).toBe("OUTPUT -m owner --uid-owner 990 -d 169.254.169.254 -j REJECT");
    expect(rig.calls()).not.toContain("ip6tables");
  });

  it("remove takes every rule away on both backends, and is harmless when nothing is there", () => {
    const nft = imdsRig();
    expect(nft.imds(["remove", "agent"]).code).toBe(0);
    nft.imds(["apply", "agent"]);
    expect(nft.imds(["remove", "agent"]).code).toBe(0);
    expect(nft.read("nft")).toBe("");
    const ipt = imdsRig({ nft: false });
    ipt.imds(["apply", "agent", "worker"]);
    ipt.imds(["apply", "agent"]);
    expect(ipt.imds(["remove", "agent", "worker"]).code).toBe(0);
    expect(ipt.read("iptables").trim()).toBe("");
    expect(ipt.read("ip6tables").trim()).toBe("");
  });

  it("verify passes when the rule is there and the user cannot connect, and runs the root control", () => {
    for (const backend of ["nft", "iptables"]) {
      const rig = imdsRig();
      rig.imds(["apply", "--backend", backend, "agent", "worker"]);
      const r = rig.imds(["verify", "--backend", backend, "agent", "worker"], { FAKE_ROOT_CONNECT: "0" });
      expect(r.code, backend).toBe(0);
      expect(r.out).toContain("ok agent cannot reach 169.254.169.254");
      expect(r.out).toContain("ok worker cannot reach 169.254.169.254");
      expect(r.out).toContain("control root reaches 169.254.169.254");
      expect(rig.calls()).toContain("runuser -u agent -- timeout 3 bash -c");
    }
  });

  it("verify reads nft's listing whether it shows uids or user names", () => {
    const rig = imdsRig();
    rig.imds(["apply", "agent"]);
    expect(rig.imds(["verify", "agent"], { FAKE_NFT_NAMES: "1" }).code).toBe(0);
  });

  it("verify fails when a rule is missing", () => {
    for (const backend of ["nft", "iptables"]) {
      const rig = imdsRig();
      rig.imds(["apply", "--backend", backend, "agent"]);
      const r = rig.imds(["verify", "--backend", backend, "agent", "worker"]);
      expect(r.code, backend).toBe(1);
      expect(r.out).toMatch(new RegExp(`FAIL no ${backend} rule for worker -> 169.254.169.254`));
    }
  });

  it("verify fails when the user can still connect, and says when root cannot either", () => {
    const rig = imdsRig();
    rig.imds(["apply", "agent"]);
    const r = rig.imds(["verify", "agent"], { FAKE_USER_CONNECT: "0" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL agent can reach 169.254.169.254");
    expect(r.out).toContain("note root cannot reach 169.254.169.254 either");
  });
});

/** A job directory, a stub runner that records its stdin, and the wrapper's environment. */
function jobRig(conf = "enabled=yes\nprofile=main\n") {
  const dir = scratch();
  const jobs = join(dir, "jobs");
  const job = join(jobs, "digest");
  mkdirSync(job, { recursive: true, mode: 0o755 });
  writeFileSync(join(job, "job.conf"), conf, { mode: 0o644 });
  writeFileSync(join(job, "prompt.md"), "Summarise the inputs.", { mode: 0o644 });
  const seen = join(dir, "request.json");
  const runner = join(dir, "runner");
  writeFileSync(runner, `#!/usr/bin/env bash\ncat > "${seen}"\n[ "$#" = 0 ] || exit 2\nprintf 'the answer'\nexit "\${FAKE_RUNNER_EXIT:-0}"\n`, { mode: 0o755 });
  const group = spawnSync("id", ["-gn"], { encoding: "utf8" }).stdout.trim();
  const env = (extra: Record<string, string> = {}) => ({
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    TMPDIR: dir,
    WIM_AGENT_JOBS_DIR: jobs,
    WIM_AGENT_IN_ROOT: join(dir, "in"),
    WIM_AGENT_WORKER_GROUP: group,
    WIM_AGENT_RUNNER: runner,
    ...extra,
  });
  const hook = (name: string, body: string) => writeFileSync(join(job, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  const request = () => JSON.parse(readFileSync(seen, "utf8")) as { v: number; id: string; from: { device: string; address: string }; profile: string; text: string };
  return { dir, job, env, hook, request, seen, run: (args = ["digest"], extra: Record<string, string> = {}) => run(JOB, args, env(extra)) };
}

describe.skipIf(!linux)("wim-agent-job", () => {
  it("takes exactly one job name in the grammar", () => {
    const rig = jobRig();
    for (const args of [[], ["a", "b"], ["../etc"], ["Digest"], ["-x"], ["a".repeat(65)]]) {
      const r = rig.run(args);
      expect(r.code, JSON.stringify(args)).toBe(2);
    }
    expect(existsSync(rig.seen)).toBe(false);
  });

  it("refuses a missing job, a missing prompt or conf, and a file others could change", () => {
    const rig = jobRig();
    expect(rig.run(["other"]).code).toBe(78);
    chmodSync(join(rig.job, "prompt.md"), 0o664);
    expect(rig.run().err).toMatch(/not group- or other-writable/);
    chmodSync(join(rig.job, "prompt.md"), 0o644);
    rig.hook("collect", "exit 0");
    chmodSync(join(rig.job, "collect"), 0o757);
    expect(rig.run().code).toBe(78);
    rmSync(join(rig.job, "collect"));
    rmSync(join(rig.job, "prompt.md"));
    expect(rig.run().err).toMatch(/no .*prompt\.md/);
    rmSync(join(rig.job, "job.conf"));
    expect(rig.run().err).toMatch(/no .*job\.conf/);
  });

  it.each([
    ["enabled=maybe\n", /enabled must be yes or no/],
    ["enabled=yes\nmodel=x\n", /unknown key model/],
    ["enabled=yes\nprofile=../x\n", /profile must be/],
    ["profile=a\n", /enabled=yes\|no is required/],
    ["enabled yes\n", /not KEY=VALUE/],
  ])("refuses job.conf %j with exit 78", (conf, msg) => {
    const r = jobRig(conf).run();
    expect(r.code).toBe(78);
    expect(r.err).toMatch(msg);
  });

  it("enabled=no is the kill switch: no collect, no model call", () => {
    const rig = jobRig("# off for now\n\nenabled=no");
    rig.hook("collect", `touch "${join(rig.dir, "collected")}"`);
    const r = rig.run();
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/digest is off/);
    expect(existsSync(join(rig.dir, "collected"))).toBe(false);
    expect(existsSync(rig.seen)).toBe(false);
  });

  it("collect exit 3 means nothing new: no model call, exit 0", () => {
    const rig = jobRig();
    rig.hook("collect", "exit 3");
    const r = rig.run();
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/nothing new/);
    expect(existsSync(rig.seen)).toBe(false);
  });

  it("a failed or slow collect stops the job before the model", () => {
    const rig = jobRig();
    rig.hook("collect", "exit 6");
    expect(rig.run().err).toMatch(/collect failed \(exit 6\)/);
    rig.hook("collect", "sleep 5");
    const r = rig.run(["digest"], { WIM_AGENT_COLLECT_TIMEOUT: "1" });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/collect ran past 1s/);
    expect(existsSync(rig.seen)).toBe(false);
  });

  it("collect, analyse, answer to the journal: the runner gets one contract v1 request on stdin and no argv", () => {
    const rig = jobRig();
    rig.hook("collect", `printf 'x' > "$1/b.txt"; mkdir "$1/sub"; printf 'y' > "$1/sub/a.txt"; chmod 0666 "$1/b.txt"`);
    const r = rig.run();
    expect(r.code).toBe(0);
    expect(r.out).toBe("the answer");
    const req = rig.request();
    expect(req.v).toBe(1);
    expect(req.id).toMatch(/^job-digest-\d{8}T\d{6}Z$/);
    expect(req.from).toEqual({ device: "local", address: "local@localhost" });
    expect(req.profile).toBe("main");
    const inDir = join(rig.dir, "in", "digest");
    expect(req.text).toBe(`Summarise the inputs.\n\nThe inputs for this run are files under ${inDir}:\n- b.txt\n- sub/a.txt\n`);
    // Inputs: readable by the worker's group, writable by nobody but root.
    expect(statSync(inDir).mode & 0o777).toBe(0o750);
    expect(statSync(join(inDir, "b.txt")).mode & 0o777).toBe(0o640);
  });

  it("an empty profile means the runner's default profile, and a job may have no collect", () => {
    const rig = jobRig("enabled=yes\n");
    expect(rig.run().code).toBe(0);
    expect(rig.request().profile).toBe("");
    expect(rig.request().text).toMatch(/files under .*:\n$/);
  });

  it("the previous run's inputs never leak into the next", () => {
    const rig = jobRig();
    rig.hook("collect", `[ -e "$1/old.txt" ] && exit 7; printf 'x' > "$1/old.txt"`);
    expect(rig.run().code).toBe(0);
    expect(rig.run().code).toBe(0);
  });

  it("post gets the answer file and the inputs; a failed post fails the job", () => {
    const rig = jobRig();
    rig.hook("post", `cp "$1" "${join(rig.dir, "posted")}"; [ -d "$2" ]`);
    const r = rig.run();
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/digest: posted/);
    expect(readFileSync(join(rig.dir, "posted"), "utf8")).toBe("the answer");
    rig.hook("post", "exit 1");
    expect(rig.run().err).toMatch(/post failed \(exit 1\)/);
  });

  it.each([
    ["4", 75, /runner busy/],
    ["3", 1, /runner refused/],
    ["5", 1, /runner timed out/],
    ["1", 1, /runner failed \(exit 1\)/],
    ["9", 1, /runner failed \(exit 9\)/],
  ])("runner exit %s gives wrapper exit %i, and nothing is posted", (exit, code, msg) => {
    const rig = jobRig();
    rig.hook("post", `touch "${join(rig.dir, "posted")}"`);
    const r = rig.run(["digest"], { FAKE_RUNNER_EXIT: exit });
    expect(r.code).toBe(code);
    expect(r.err).toMatch(msg);
    expect(existsSync(join(rig.dir, "posted"))).toBe(false);
  });

  it("leaves no scratch files behind", () => {
    const rig = jobRig();
    rig.run();
    expect(readdirSync(rig.dir).sort()).toEqual(["in", "jobs", "request.json", "runner"]);
  });
});

describe.skipIf(!linux)("wim-agent-privileged-runner launcher", () => {
  /** The launcher with its target swapped for printenv, so the test sees the environment it passes. */
  function launcher(): string {
    const dir = scratch();
    const p = join(dir, "launcher");
    const text = readFileSync(join(DEPLOY, "wim-agent-privileged-runner"), "utf8");
    expect(text).toMatch(/^WIM_BIN=\/usr\/local\/bin\/wim$/m);
    expect(text).toMatch(/^exec \/usr\/bin\/env -i "\$@" "\$WIM_BIN" worker privileged$/m);
    // printenv prints nothing for the names "worker" and "privileged", so only the environment shows.
    writeFileSync(p, text.replace(/^WIM_BIN=.*$/m, "WIM_BIN=/usr/bin/printenv").replace('"$WIM_BIN" worker privileged', '"$WIM_BIN"'), { mode: 0o755 });
    return p;
  }
  const sh = (p: string, args: string[], env: Record<string, string>) => {
    const r = spawnSync("/bin/sh", [p, ...args], { env, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it("refuses any argument", () => {
    const r = sh(launcher(), ["--config", "/x"], {});
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/takes no arguments/);
  });

  it("passes a fixed environment and nothing the caller set", () => {
    const r = sh(launcher(), [], { PATH: "/evil", NODE_OPTIONS: "--require /evil.js", HTTPS_PROXY: "http://evil", HOME: "/evil" });
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n").sort()).toEqual(["LANG=C.UTF-8", "PATH=/usr/local/bin:/usr/bin:/bin"]);
  });

  it("keeps sudo's SUDO_* markers, exactly, so the runner can tell the peer from a local root job", () => {
    const r = sh(launcher(), [], { SUDO_UID: "990", SUDO_GID: "990", SUDO_USER: 'wim agent"$(x)', SUDO_COMMAND: "/usr/local/sbin/wim-agent-privileged-runner", OTHER: "1" });
    expect(r.out.trim().split("\n").sort()).toEqual([
      "LANG=C.UTF-8",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "SUDO_COMMAND=/usr/local/sbin/wim-agent-privileged-runner",
      "SUDO_GID=990",
      "SUDO_UID=990",
      'SUDO_USER=wim agent"$(x)',
    ]);
  });

  it("passes an empty SUDO_UID as set, not as absent", () => {
    expect(sh(launcher(), [], { SUDO_UID: "" }).out).toContain("SUDO_UID=\n");
  });
});

const EXAMPLE = join(DEPLOY, "examples", "jobs", "repo-digest");

/** git with a fixed identity and no global config, so the test never reads the operator's. */
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: cwd },
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

/** A copy of the example job, pointed at a fresh clone of a fresh origin. */
function exampleRig() {
  const dir = scratch();
  const job = join(dir, "repo-digest");
  mkdirSync(job);
  for (const f of ["collect", "post", "job.conf", "prompt.md"]) writeFileSync(join(job, f), readFileSync(join(EXAMPLE, f)), { mode: statSync(join(EXAMPLE, f)).mode & 0o777 });
  const origin = join(dir, "origin");
  mkdirSync(origin);
  git(origin, "init", "-q");
  const clone = join(dir, "clone");
  writeFileSync(join(job, "repo"), `${clone}\n`);
  const inDir = join(dir, "in");
  mkdirSync(inDir);
  const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: dir, WIM_AGENT_REPORTS: join(dir, "reports") };
  const commit = (name: string, text: string) => {
    writeFileSync(join(origin, name), text);
    git(origin, "add", name);
    git(origin, "commit", "-q", "-m", `add ${name}`);
  };
  return { dir, job, origin, clone, inDir, env, commit };
}

describe.skipIf(!linux)("example job repo-digest", () => {
  it("collect writes the day's commits and one diff per commit", () => {
    const rig = exampleRig();
    rig.commit("a.txt", "one\n");
    rig.commit("b.txt", "two\n");
    git(rig.dir, "clone", "-q", rig.origin, rig.clone);
    const r = run(join(rig.job, "collect"), [rig.inDir], rig.env);
    expect(r.code, r.err).toBe(0);
    const commits = readFileSync(join(rig.inDir, "commits.txt"), "utf8").trim().split("\n");
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatch(/^[0-9a-f]{40} Test \S+ add b\.txt$/);
    const diffs = readdirSync(join(rig.inDir, "diffs")).sort();
    expect(diffs).toHaveLength(2);
    expect(diffs[0]).toMatch(/^01-[0-9a-f]{12}\.diff$/);
    expect(readFileSync(join(rig.inDir, "diffs", diffs[1] ?? ""), "utf8")).toContain("+one");
  });

  it("collect stops at its budget and says so", () => {
    const rig = exampleRig();
    for (let i = 0; i < 42; i++) rig.commit(`f${i}.txt`, `${i}\n`);
    git(rig.dir, "clone", "-q", rig.origin, rig.clone);
    expect(run(join(rig.job, "collect"), [rig.inDir], rig.env).code).toBe(0);
    expect(readdirSync(join(rig.inDir, "diffs"))).toHaveLength(40);
    expect(readFileSync(join(rig.inDir, "commits.txt"), "utf8")).toContain("(budget reached after 40 commits");
  });

  it("collect exits 3 when nothing was committed in the last day, and refuses an odd branch name", () => {
    const rig = exampleRig();
    writeFileSync(join(rig.origin, "a.txt"), "old\n");
    git(rig.origin, "add", "a.txt");
    const old = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "old"], {
      cwd: rig.origin,
      env: { ...rig.env, GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" },
    });
    expect(old.status).toBe(0);
    git(rig.dir, "clone", "-q", rig.origin, rig.clone);
    expect(run(join(rig.job, "collect"), [rig.inDir], rig.env).code).toBe(3);
    writeFileSync(join(rig.job, "branch"), "main;rm\n");
    const r = run(join(rig.job, "collect"), [rig.inDir], rig.env);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/bad branch name/);
  });

  it("post keeps a dated report and, with a webhook, sends the answer as JSON with the URL off argv", async () => {
    const rig = exampleRig();
    const answer = join(rig.dir, "answer");
    writeFileSync(answer, "the \"answer\"\n");
    expect(run(join(rig.job, "post"), [answer, rig.inDir], rig.env).code).toBe(0);
    const reports = readdirSync(join(rig.dir, "reports"));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(/^repo-digest-\d{8}T\d{6}Z\.md$/);

    const got: string[] = [];
    const server = createServer((req, res) => {
      let b = "";
      req.on("data", (c: Buffer) => (b += c.toString()));
      req.on("end", () => {
        got.push(`${req.method} ${req.url} ${req.headers["content-type"]} ${b}`);
        res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    onTestFinished(() => new Promise<void>((r) => server.close(() => r())));
    const port = (server.address() as { port: number }).port;
    writeFileSync(join(rig.job, "webhook"), `http://127.0.0.1:${port}/hook?token=abc\n`, { mode: 0o600 });
    const code = await new Promise<number | null>((resolve) => {
      const p = spawn(BASH, [join(rig.job, "post"), answer, rig.inDir], { env: rig.env, stdio: "ignore" });
      p.on("exit", resolve);
    });
    expect(code).toBe(0);
    expect(got).toEqual([`POST /hook?token=abc application/json ${JSON.stringify({ text: 'the "answer"\n' })}`]);
    expect(readdirSync(join(rig.dir, "reports")).filter((f) => f.startsWith("."))).toEqual([]);
  });

  it("post refuses a webhook that is not a plain URL", () => {
    const rig = exampleRig();
    const answer = join(rig.dir, "answer");
    writeFileSync(answer, "x");
    writeFileSync(join(rig.job, "webhook"), 'http://example.com/"\nurl = "file:///etc/shadow\n');
    const r = run(join(rig.job, "post"), [answer, rig.inDir], rig.env);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not a plain http\(s\) URL/);
  });
});

describe("deploy kit static rules", () => {
  const read = (p: string) => readFileSync(join(DEPLOY, p), "utf8");
  const live = (text: string) => text.split("\n").filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));

  it("the sudoers example is ONE exact line: one program, no arguments, no wildcards", () => {
    const lines = live(read("sudoers/wim-agent"));
    expect(lines).toEqual(['wim-agent ALL=(root) NOPASSWD: /usr/local/sbin/wim-agent-privileged-runner ""']);
    expect(lines[0]).not.toMatch(/[*?[\]]|SETENV|env_keep/);
  });

  it("every unit runs only kit programs from /usr/local/sbin, and every job runs in the capped slice", () => {
    const units = readdirSync(join(DEPLOY, "systemd"));
    expect(units).toEqual(expect.arrayContaining(["wim-agent.service", "wim-agent.slice", "wim-agent-job@.service", "wim-agent-job@.timer"]));
    for (const u of units.filter((n) => n.endsWith(".service"))) {
      const text = read(`systemd/${u}`);
      expect(text, u).toMatch(/^Slice=wim-agent\.slice$/m);
      expect(text, u).toMatch(/^ExecStartPre=\+?\/usr\/local\/sbin\/wim-agent-imds-block apply wim-agent wim-agent-worker$/m);
      for (const m of text.matchAll(/^Exec\w+=[+!-]*(\S+)/gm)) {
        const prog = m[1] ?? "";
        expect(prog, u).toMatch(/^\/usr\/local\/(s)?bin\//);
      }
    }
  });

  it("the peer runs as its own unprivileged user, and keeps what sudo needs", () => {
    const peer = read("systemd/wim-agent.service");
    expect(peer).toMatch(/^ExecStart=\/usr\/local\/bin\/wim worker serve \/etc\/wim-agent\/agent\.json --as agents$/m);
    expect(peer).toMatch(/^User=wim-agent$/m);
    expect(peer).not.toMatch(/^User=root$/m);
    // NoNewPrivileges would stop sudo; an IMDS IPAddressDeny on the unit would also bind the
    // root runner sudo starts in this cgroup, and it needs the metadata service.
    expect(peer).not.toMatch(/^NoNewPrivileges=yes/m);
    // Each of these makes systemd set no_new_privs for a User= unit, which stops sudo too.
    for (const opt of ["LockPersonality", "RestrictRealtime", "ProtectKernelTunables", "ProtectKernelModules", "ProtectKernelLogs", "ProtectClock", "SystemCallFilter", "SystemCallArchitectures", "MemoryDenyWriteExecute", "RestrictNamespaces", "RestrictAddressFamilies", "RestrictSUIDSGID", "PrivateDevices", "DynamicUser"]) {
      expect(peer, opt).not.toMatch(new RegExp(`^${opt}=`, "m"));
    }
    expect(peer).not.toMatch(/^IPAddressDeny=/m);
  });

  it("the slice caps memory and CPU", () => {
    const slice = read("systemd/wim-agent.slice");
    expect(slice).toMatch(/^MemoryMax=\d+[KMG]$/m);
    expect(slice).toMatch(/^CPUQuota=\d+%$/m);
  });

  it("the job unit treats the runner's busy exit as success", () => {
    const unit = read("systemd/wim-agent-job@.service");
    expect(unit).toMatch(/^SuccessExitStatus=75$/m);
    expect(unit).toMatch(/^ExecStart=\/usr\/local\/sbin\/wim-agent-job %i$/m);
    expect(read("systemd/wim-agent-job@.timer")).toMatch(/^Unit=wim-agent-job@%i\.service$/m);
  });

  it("the example peer config is valid and is the privileged layout: no code, sudo with no extra argument", () => {
    const cfg = loadConfig(JSON.parse(read("config/agent.json")));
    expect(cfg.wake.mode).toBe("runner");
    expect(cfg.runner.command).toBe("/usr/bin/sudo");
    expect(cfg.runner.args).toEqual(["-n", "/usr/local/sbin/wim-agent-privileged-runner"]);
    expect(cfg.runner.passEnv).toEqual(["PATH", "LANG"]);
    const priv = JSON.parse(read("config/privileged.json")) as { timeoutSeconds: number; killGraceSeconds: number; allowLocal: boolean; profiles: Record<string, { tools: string[] }> };
    // The runner's own timeout fires first, so the sender hears "timed out", not a kill.
    expect(cfg.runner.timeoutSeconds).toBeGreaterThan(priv.timeoutSeconds + priv.killGraceSeconds);
    expect(priv.allowLocal).toBe(false);
    for (const p of Object.values(priv.profiles)) expect(p.tools).toEqual(["Read", "Grep", "Glob"]);
  });

  it("the runtime directory is closed to the peer user", () => {
    expect(live(read("tmpfiles/wim-agent.conf"))).toEqual(["d /run/wim-agent 0750 root wim-agent-worker -"]);
  });

});
