// A job's processes and how all of them end: the transient scope, the process-group fallback,
// and the reviewer's repro (a job that leaves its process group with setsid).

import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultScope, detectScopeMode, ownSlice, scopeUnit, startScopedJob, type ScopeOptions } from "../../src/privileged/jobscope.ts";
import { privilegedMain, type JobSpec } from "../../src/privileged/main.ts";
import { acquireLock, systemDeps } from "../../src/privileged/system.ts";
import { ADDRESS, MESH, recipientKeyFile, requestFor, seal, SENDERS } from "./helpers.ts";
import { startMockApi } from "./mock-api.ts";

const linux = process.platform === "linux";
let dir: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(join(process.env["WIM_TEST_TMP"] || tmpdir(), "wim-jobscope-"));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("detectScopeMode", () => {
  it("uses a system scope only as root under systemd", () => {
    expect(detectScopeMode(0, true)).toBe("system");
    expect(detectScopeMode(0, false)).toBe("none");
    expect(detectScopeMode(1000, true)).toBe("none");
    expect(detectScopeMode(1000)).toBe("none");
  });
});

describe("ownSlice", () => {
  it("names the slice of the manager that owns that part of the path", () => {
    expect(ownSlice("system", "0::/distronode-agent.slice/wim-agent.service\n")).toBe("distronode-agent.slice");
    expect(ownSlice("system", "0::/wim.slice/wim-agent.slice/wim-agent.service")).toBe("wim-agent.slice");
    const session = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-x.scope";
    expect(ownSlice("system", session)).toBe("user-1000.slice");
    expect(ownSlice("user", session)).toBe("app.slice");
  });
  it("is undefined with no slice, no unified line, or no user manager in the path", () => {
    expect(ownSlice("system", "0::/init.scope")).toBeUndefined();
    expect(ownSlice("system", "1:name=systemd:/x.slice")).toBeUndefined();
    expect(ownSlice("user", "0::/system.slice/x.service")).toBeUndefined();
  });
});

describe("scopeUnit and defaultScope", () => {
  it("names each job's scope after the runner's pid and a counter", () => {
    const a = scopeUnit(42);
    const b = scopeUnit(42);
    expect(a).toMatch(/^wim-agent-job-42-\d+$/);
    expect(b).not.toBe(a);
  });
  it("is the process group off root or off systemd, else a system scope in the runner's slice", () => {
    expect(defaultScope(1000, 1)).toEqual({ mode: "none", unit: "", drainMs: 2000 });
    expect(defaultScope(0, 7, true, () => "0::/distronode-agent.slice/wim-agent.service\n")).toMatchObject({ mode: "system", unit: expect.stringMatching(/^wim-agent-job-7-\d+$/), slice: "distronode-agent.slice", drainMs: 2000 });
    expect(defaultScope(0, 7, true, () => "0::/\n")).not.toHaveProperty("slice");
  });
  it.runIf(linux)("reads the runner's own cgroup by default", () => {
    const own = ownSlice("system", spawnSync("cat", ["/proc/self/cgroup"], { encoding: "utf8" }).stdout);
    const s = defaultScope(0, 7, true);
    expect(s.mode).toBe("system");
    expect(s.slice).toBe(own);
  });
});

/** A child process stand-in that records how it was spawned. */
function fakeSpawn() {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  let child!: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number };
  const spawnFn = ((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 2 ** 22 + 12345 });
    return child;
  }) as unknown as typeof spawn;
  return { spawnFn, calls, child: () => child };
}

const SPEC: JobSpec = { command: "/usr/bin/node", args: ["/opt/wim.mjs", "agent", "privileged", "--worker"], cwd: "/work", env: { PATH: "/usr/bin" }, stdin: "task", uid: 990, gid: 991 };

describe("startScopedJob with a stand-in process", () => {
  it("system scope: systemd-run switches the user itself, in the runner's slice; the spawn itself stays root", () => {
    const f = fakeSpawn();
    startScopedJob(SPEC, { mode: "system", unit: "wim-agent-job-1-1", slice: "distronode-agent.slice", drainMs: 10, spawn: f.spawnFn, systemctl: async () => undefined });
    const c = f.calls[0]!;
    expect(c.command).toBe("systemd-run");
    expect(c.args).toEqual(["--scope", "--quiet", "--collect", "--unit=wim-agent-job-1-1", "--slice=distronode-agent.slice", "--uid=990", "--gid=991", "--", "/usr/bin/node", "/opt/wim.mjs", "agent", "privileged", "--worker"]);
    expect(c.options).toMatchObject({ cwd: "/work", env: { PATH: "/usr/bin" }, detached: true });
    expect(c.options).not.toHaveProperty("uid");
  });

  it("user scope: --user, no slice or ids when none are given, and the manager's environment for systemd-run", () => {
    const f = fakeSpawn();
    const { uid: _u, gid: _g, ...asUser } = SPEC;
    startScopedJob(asUser, { mode: "user", unit: "u", drainMs: 10, scopeEnv: { XDG_RUNTIME_DIR: "/run/user/1000" }, spawn: f.spawnFn, systemctl: async () => undefined });
    expect(f.calls[0]!.args).toEqual(["--user", "--scope", "--quiet", "--collect", "--unit=u", "--", "/usr/bin/node", "/opt/wim.mjs", "agent", "privileged", "--worker"]);
    expect(f.calls[0]!.options["env"]).toEqual({ PATH: "/usr/bin", XDG_RUNTIME_DIR: "/run/user/1000" });
  });

  it("a scope keeps every $ in the command line literal (systemd-run would expand it), and no scope leaves it alone", () => {
    const f = fakeSpawn();
    const spec: JobSpec = { ...SPEC, command: "/opt/$dir/node", args: ["-e", "x$HOME${Y}$$"] };
    startScopedJob(spec, { mode: "user", unit: "u", drainMs: 10, spawn: f.spawnFn, systemctl: async () => undefined });
    expect(f.calls[0]!.args.slice(-3)).toEqual(["/opt/$$dir/node", "-e", "x$$HOME$${Y}$$$$"]);
    startScopedJob(spec, { mode: "none", unit: "", drainMs: 10, spawn: f.spawnFn });
    expect(f.calls[1]).toMatchObject({ command: "/opt/$dir/node", args: ["-e", "x$HOME${Y}$$"] });
  });

  it("no scope: the command itself, switched by the spawn when ids are given", () => {
    const f = fakeSpawn();
    startScopedJob(SPEC, { mode: "none", unit: "", drainMs: 10, spawn: f.spawnFn });
    expect(f.calls[0]).toMatchObject({ command: "/usr/bin/node", args: SPEC.args, options: { uid: 990, gid: 991, env: { PATH: "/usr/bin" } } });
    const { uid: _u, gid: _g, ...asUser } = SPEC;
    startScopedJob(asUser, { mode: "none", unit: "", drainMs: 10, spawn: f.spawnFn });
    expect(f.calls[1]!.options).not.toHaveProperty("uid");
  });

  it("settles on the leader's exit even while the pipes stay open, and on a spawn error with 127", async () => {
    const f = fakeSpawn();
    const h = startScopedJob(SPEC, { mode: "none", unit: "", drainMs: 10, spawn: f.spawnFn });
    f.child().emit("exit", 4);
    expect(await h.exited).toBe(4);
    const g = startScopedJob(SPEC, { mode: "none", unit: "", drainMs: 10, spawn: f.spawnFn });
    f.child().emit("error", new Error("ENOENT"));
    expect(await g.exited).toBe(127);
  });

  it("killGroup signals the scope through systemctl and the process group; an absent group is fine", () => {
    const f = fakeSpawn();
    const sent: string[][] = [];
    const h = startScopedJob(SPEC, { mode: "user", unit: "u1", drainMs: 10, spawn: f.spawnFn, systemctl: async (a) => void sent.push(a) });
    h.killGroup("SIGTERM");
    expect(sent).toEqual([["--user", "kill", "--signal=SIGTERM", "--kill-whom=all", "u1.scope"]]);
    const n = startScopedJob(SPEC, { mode: "none", unit: "", drainMs: 10, spawn: f.spawnFn, systemctl: async (a) => void sent.push(a) });
    n.killGroup("SIGKILL");
    expect(sent).toHaveLength(1);
  });

  it("cleanup kills the rest, waits for the pipes only up to drainMs, and closes them", async () => {
    const f = fakeSpawn();
    const sent: string[][] = [];
    const cancelled: unknown[] = [];
    const o: ScopeOptions = { mode: "system", unit: "s", drainMs: 10, spawn: f.spawnFn, systemctl: async (a) => void sent.push(a), setTimeout: (fn) => (fn(), "t"), clearTimeout: (t) => void cancelled.push(t) };
    const h = startScopedJob(SPEC, o);
    f.child().emit("exit", 0);
    await h.cleanup();
    expect(sent).toEqual([["kill", "--signal=SIGKILL", "--kill-whom=all", "s.scope"]]);
    expect(cancelled).toEqual(["t"]);
    expect(f.child().stdout.destroyed && f.child().stderr.destroyed && f.child().stdin.destroyed).toBe(true);
  });

  it("cleanup returns at once when the pipes close first", async () => {
    const f = fakeSpawn();
    const h = startScopedJob(SPEC, { mode: "none", unit: "", drainMs: 60_000, spawn: f.spawnFn });
    f.child().emit("exit", 0);
    f.child().emit("close", 0);
    const t = Date.now();
    await h.cleanup();
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it("the default systemctl runs and never throws, whether or not the unit or systemctl exists", async () => {
    const f = fakeSpawn();
    const h = startScopedJob(SPEC, { mode: "user", unit: `wim-agent-job-test-${process.pid}-absent`, drainMs: 1, spawn: f.spawnFn });
    f.child().emit("exit", 0);
    await h.cleanup();
  });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/**
 * Whether a user scope really contains an escaped process here: systemd-run --user --scope can
 * start on a host (a CI runner, say) whose user manager still cannot kill what left the group.
 * The probe runs the same escape in a scope, kills the scope the way cleanup does, and passes
 * only when the escapee is gone. Where it fails the scope tests cannot say anything, so they skip.
 */
function scopeKillWorks(): boolean {
  if (!linux || process.geteuid!() === 0) return false;
  // The escape lives in a script file, so the command systemd-run gets holds no `$` (it expands them).
  const probe = [
    'u="wim-agent-probe-$$"; d="${TMPDIR:-.}"; f="$d/wim-agent-probe-$$.pid"; s="$d/wim-agent-probe-$$.sh"; rm -f "$f"',
    `printf "setsid sh -c 'echo \\$\\$ > %s; exec sleep 30' </dev/null >/dev/null 2>&1 &\\nsleep 30\\n" "$f" > "$s"`,
    'systemd-run --user --scope --quiet --unit="$u" /bin/sh "$s" >/dev/null 2>&1 &',
    'i=0; while [ ! -s "$f" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done',
    'p=$(cat "$f" 2>/dev/null); rm -f "$f" "$s"; case "$p" in ""|*[!0-9]*) exit 2;; esac; kill -0 "$p" || exit 2',
    'systemctl --user kill --kill-whom=all --signal=SIGKILL "$u.scope" >/dev/null 2>&1',
    'i=0; while kill -0 "$p" 2>/dev/null && [ $i -lt 60 ]; do sleep 0.05; i=$((i+1)); done',
    'if kill -0 "$p" 2>/dev/null; then kill -9 "$p"; exit 3; fi',
  ].join("\n");
  return spawnSync("sh", ["-c", probe], { stdio: "ignore", timeout: 15_000, env: { ...process.env, TMPDIR: process.env["WIM_TEST_TMP"] || tmpdir() } }).status === 0;
}
// GitHub's hosted runners pass the probe but the scoped job never settles there (it ran past 30 s
// on both Ubuntu images, twice), so the real-scope tests run on developer machines and
// self-hosted runners only; the scope logic itself is covered by the stubbed tests above.
const userScopes = process.env["GITHUB_ACTIONS"] !== "true" && scopeKillWorks();
/** Each scope test's own limit: scope start-up, the 2 s drain, and the wait for the escapee, with room on a slow runner. */
const SCOPE_TEST_MS = 30_000;
const USER_ENV = { XDG_RUNTIME_DIR: process.env["XDG_RUNTIME_DIR"] ?? "" };
/**
 * The reviewer's repro: the leader starts `setsid sh -c 'sleep 8'` in the background and exits.
 * The escaped shell writes its own pid only once setsid() has run, and the leader waits for
 * that file, so the leader never exits (and its group is never killed) while the child is still
 * in the leader's process group: that race once made the no-scope case kill the child early.
 */
const ESCAPE = (pidFile: string) =>
  `setsid sh -c 'echo $$ > "$0"; exec sleep 8' '${pidFile}' & while [ ! -s '${pidFile}' ]; do sleep 0.05; done; echo leader done`;
const shSpec = (script: string): JobSpec => ({ command: "/bin/sh", args: ["-c", script], cwd: dir, env: { PATH: "/usr/bin:/bin" }, stdin: "" });

describe.runIf(linux)("the setsid escape, with real processes", () => {
  it.runIf(userScopes)("in a scope: the job ends at the leader's exit and cleanup kills the escaped process", async () => {
    const pidFile = join(dir, "escapee-scope");
    const t = Date.now();
    const h = startScopedJob(shSpec(ESCAPE(pidFile)), { mode: "user", unit: scopeUnit(process.pid), drainMs: 2000, scopeEnv: USER_ENV });
    const out: string[] = [];
    h.onStdout((b) => out.push(b.toString()));
    expect(await h.exited).toBe(0);
    const escapee = Number((await fs.readFile(pidFile, "utf8")).trim());
    expect(alive(escapee)).toBe(true);
    await h.cleanup();
    // Well under the escapee's 8 s sleep: cleanup did not wait for it, it killed it.
    expect(Date.now() - t).toBeLessThan(7500);
    expect(out.join("")).toBe("leader done\n");
    for (let i = 0; i < 100 && alive(escapee); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(escapee)).toBe(false);
  }, SCOPE_TEST_MS);

  it("without a scope: the job still ends at the leader's exit and the runner does not wait for the escaped process", async () => {
    const pidFile = join(dir, "escapee-none");
    const t = Date.now();
    const h = startScopedJob(shSpec(ESCAPE(pidFile)), { mode: "none", unit: "", drainMs: 300 });
    expect(await h.exited).toBe(0);
    await h.cleanup();
    expect(Date.now() - t).toBeLessThan(4000);
    // The documented limit of the fallback: a process that left the group survives the job.
    const escapee = Number((await fs.readFile(pidFile, "utf8")).trim());
    expect(alive(escapee)).toBe(true);
    process.kill(escapee, "SIGKILL");
  });

  it.runIf(userScopes)("through the runner: it returns, releases the lock, closes the proxy and the escaped process is dead", async () => {
    const pidFile = join(dir, "escapee-runner");
    const stub = join(dir, "escaping-worker.sh");
    await fs.writeFile(stub, `#!/bin/sh\n[ "$1" = --worker ] || exit 9\ncat > /dev/null\n${ESCAPE(pidFile)}\n`, { mode: 0o755 });
    await fs.writeFile(join(dir, "source-token"), "id.jwt\n");
    await fs.mkdir(join(dir, "work"), { recursive: true });
    const lockPath = join(dir, "job.lock");
    const runDir = join(dir, "run");
    const cfgPath = join(dir, "privileged.json");
    await fs.mkdir(join(dir, "peer"), { recursive: true });
    await fs.writeFile(join(dir, "peer", "device.json"), recipientKeyFile(), { mode: 0o600 });
    const api = await startMockApi(() => ({ text: "unused" }));
    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        v: 1,
        worker: { user: userInfo().username, home: dir, cwd: join(dir, "work") },
        runDir,
        lock: { path: lockPath, waitSeconds: 0 },
        statePath: join(dir, "state", "state.json"),
        minMemAvailableMb: 0,
        senders: SENDERS,
        recipient: { home: join(dir, "peer"), mesh: MESH, address: ADDRESS, user: userInfo().username },
        apiUrl: api.url,
        defaultProfile: "a",
        profiles: { a: { auth: { type: "wif", organizationId: "org", federationRuleId: "rule", serviceAccountId: "sa", identity: { type: "file", path: join(dir, "source-token") } } } },
      }),
    );
    const deps = systemDeps();
    deps.readStdin = async () => Buffer.from(JSON.stringify(requestFor(seal("escape"), "escape")));
    let proxyUrl = "";
    const realProxy = deps.startProxy;
    deps.startProxy = async (o) => {
      const p = await realProxy(o);
      proxyUrl = p.url;
      return p;
    };
    const out: Buffer[] = [];
    deps.out = (b) => void out.push(b);
    deps.err = () => undefined;
    deps.startJob = (spec) => startScopedJob(spec, { mode: "user", unit: scopeUnit(process.pid), drainMs: 2000, scopeEnv: USER_ENV });
    const t = Date.now();
    try {
      expect(await privilegedMain([], { WIM_AGENT_PRIVILEGED_CONFIG: cfgPath }, ["/bin/sh", stub], deps)).toBe(0);
    } finally {
      await api.close();
    }
    expect(Date.now() - t).toBeLessThan(7500);
    expect(Buffer.concat(out).toString()).toBe("leader done\n");
    const lock = await acquireLock(lockPath, 0);
    expect(lock).not.toBeNull();
    await lock!.release();
    await expect(fetch(`${proxyUrl}/v1/messages`, { method: "POST", body: "{}" })).rejects.toThrow();
    const escapee = Number((await fs.readFile(pidFile, "utf8")).trim());
    for (let i = 0; i < 100 && alive(escapee); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(escapee)).toBe(false);
  }, SCOPE_TEST_MS);
});
