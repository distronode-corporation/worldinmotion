// `wim test` (SECURITY-MODEL section 7.6): the sandbox run end to end, its report and JSON, and
// the isolation rules, each against hostile input: a real device's WIM_HOME and agent variables
// in the caller's environment, a temporary directory inside the caller's state, existing state
// directories, symbolic links, a relay that is not the run's own, and the scripted terminal
// reachable from nowhere but `wim test`.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.ts";
import { notAPerson } from "../src/secretout.ts";
import {
  deviceEnv,
  grab,
  inside,
  need,
  noLinks,
  onLoopback,
  BUDGET_SPENT,
  report,
  runBase,
  runSteps,
  Sandbox,
  SandboxError,
  sandboxDialer,
  sandboxFetch,
  SANDBOX_MARK,
  selfTest,
  SHORT_TMP,
  signerStep,
  STALE_MS,
  sweepStale,
  waitFor,
  type Run,
  type Step,
} from "../src/selftest.ts";
import type { MeshSession } from "../src/client.ts";
import type { WireSocket } from "../src/wire.ts";
import { makeMesh, POSIX, RelayHarness, scratch, term } from "./helpers.ts";

/** Every file under `dir`: its path, size, mode, modification time and a hash of its bytes. */
async function snapshot(dir: string): Promise<string[]> {
  const rows: string[] = [];
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const st = await fs.lstat(path);
    const hash = entry.isFile() ? createHash("sha256").update(await fs.readFile(path)).digest("hex") : "-";
    rows.push(`${path} ${st.size} ${st.mode} ${st.mtimeMs} ${hash}`);
  }
  return rows.sort();
}

/** A real-looking device in a real-looking mesh, and a caller environment that points at it, with an agent's variables. */
async function realDevice(): Promise<{ root: string; env: Record<string, string> }> {
  const { devices } = await makeMesh(new RelayHarness(), ["real-one", "real-two"]);
  const root = devices[0]!.root;
  return { root, env: { WIM_HOME: root, CLAUDE_CONFIG_DIR: join(root, "claude"), CLAUDECODE: "1", CODEX_SANDBOX: "1", WIM_MESH: "not-a-sandbox-mesh" } };
}

describe("wim test, the sandbox run", () => {
  it(
    "passes every step, and reads and writes nothing of the caller's real device",
    async () => {
      const real = await realDevice();
      const before = await snapshot(real.root);
      const caller = term(await scratch("caller"), new RelayHarness());
      // On POSIX the real state directory cannot even be listed while the test runs.
      if (POSIX) await fs.chmod(real.root, 0o000);
      let code: number;
      try {
        code = await main(["test"], real.env, caller.io);
      } finally {
        if (POSIX) await fs.chmod(real.root, 0o700);
      }
      const out = caller.out.join("\n");
      expect(out, out).toMatch(/^PASS: 14 steps, 14 passed, 0 failed, 0 skipped/m);
      expect(code).toBe(0);
      for (const step of ["create the mesh", "invite, join, comparison code, admit", "trust both ways", "ping both directions", "send and receive, with receipts", "the offline queue and reconnect", "held from an untrusted device: approve, then refuse", "rooms, a file, a lease, ask and reply, rename", "the loop breaker: trip, then resume", "status and doctor on a device not set up", "status and doctor on a device in two meshes", "mesh delete", "remove the sandbox"]) {
        expect(out).toMatch(new RegExp(`^  pass  ${step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
      }
      expect(await snapshot(real.root)).toEqual(before);
    },
    480_000,
  );
});

/** A caller's terminal, with its environment pointing at a real device. */
async function caller(): Promise<{ io: ReturnType<typeof term>; real: Awaited<ReturnType<typeof realDevice>> }> {
  return { io: term(await scratch("caller"), new RelayHarness()), real: await realDevice() };
}

const pass = (name: string): Step => ({ name, run: async () => undefined });

/** A new, empty directory whose real path is at least `length` bytes long (longer under a long scratch root). */
async function longDir(length: number): Promise<string> {
  const at = await fs.realpath(await scratch("long"));
  const dir = join(at, "x".repeat(Math.max(1, length - Buffer.byteLength(at) - 1)));
  await fs.mkdir(dir);
  expect(Buffer.byteLength(dir)).toBeGreaterThanOrEqual(length);
  return dir;
}

// Each test makes a real-looking device in a mesh first, which takes a few seconds on a slow disk.
describe("the runner and its report", { timeout: 30_000 }, () => {
  it("skips every step after a failure, still removes the sandbox, and prints the same as JSON", async () => {
    const { io, real } = await caller();
    let root = "";
    const code = await selfTest({
      main,
      env: real.env,
      io: io.io,
      json: true,
      steps: (run: Run) => [
        { name: "open", run: async () => {
          await run.open();
          root = run.box!.root;
          await run.device("test-a");
        } },
        { name: "breaks", run: () => Promise.reject(new Error("it broke")) },
        pass("after"),
      ],
    });
    expect(code).toBe(1);
    const json = JSON.parse(io.out.at(-1)!) as { mode: string; ok: boolean; passed: number; failed: number; skipped: number; steps: Array<{ name: string; result: string; detail?: string }> };
    expect(json).toMatchObject({ mode: "sandbox", ok: false, passed: 2, failed: 1, skipped: 1 });
    expect(json.steps.map((s) => [s.name, s.result, s.detail])).toEqual([
      ["open", "pass", undefined],
      ["breaks", "fail", "it broke"],
      ["after", "skip", "an earlier step failed"],
      ["remove the sandbox", "pass", undefined],
    ]);
    await expect(fs.lstat(root)).rejects.toThrow();
  });

  it("fails a step that runs past its time", async () => {
    const rows = await runSteps([{ name: "hangs", run: () => new Promise(() => undefined) }], () => Promise.resolve(), new AbortController().signal, 30);
    expect(rows).toMatchObject([{ name: "hangs", result: "fail", detail: "timed out after 0.03 s" }]);
  });

  it("stops at a line `stop` on a piped stdin, which a program that started it sends (a kill on Windows allows no clean-up)", async () => {
    const { io, real } = await caller();
    const stdin = new PassThrough();
    let root = "";
    const code = await selfTest({
      main,
      env: real.env,
      io: { ...io.io, stdin, inputIsTTY: false },
      json: false,
      steps: (run: Run) => [
        { name: "open", run: async () => {
          await run.open();
          root = run.box!.root;
          stdin.write("something else\n");
          stdin.write("stop\n");
          // Still awaiting when stopped, and over a moment later: the end of the run waits for it.
          await new Promise((r) => setTimeout(r, 300));
        } },
        pass("next"),
      ],
    });
    expect(code).toBe(1);
    const out = io.out.join("\n");
    expect(out).toMatch(/^ {2}fail {2}open .*stopped$/m);
    expect(out).toMatch(/^ {2}skip {2}next .*stopped$/m);
    expect(out).toMatch(/^ {2}pass {2}remove the sandbox/m);
    await expect(fs.lstat(root)).rejects.toThrow();
  });

  it("does not start when stopped before it began", async () => {
    const { io, real } = await caller();
    const stop = new AbortController();
    stop.abort();
    expect(await selfTest({ main, env: real.env, io: { ...io.io, signal: stop.signal }, json: false, steps: () => [pass("one")] })).toBe(1);
    expect(io.out.join("\n")).toMatch(/^ {2}skip {2}one .*stopped$/m);
  });

  it("stops at Ctrl-C: the sandbox devices' commands are stopped and the rest is skipped", async () => {
    const { io, real } = await caller();
    const stop = new AbortController();
    let deviceSignal: AbortSignal | undefined;
    const code = await selfTest({
      main,
      env: real.env,
      io: { ...io.io, signal: stop.signal },
      json: false,
      steps: (run: Run) => [
        { name: "open", run: async () => {
          await run.open();
          deviceSignal = run.term(await run.device("test-a"), []).io.signal;
          stop.abort();
          // Still awaiting when stopped, and over a moment later: the end of the run waits for it.
          await new Promise((r) => setTimeout(r, 300));
        } },
        pass("next"),
      ],
    });
    expect(code).toBe(1);
    expect(deviceSignal!.aborted).toBe(true);
    // The step running at Ctrl-C ends at once, without waiting for what it awaits.
    expect(io.out.join("\n")).toMatch(/^  fail  open .*stopped$/m);
    expect(io.out.join("\n")).toMatch(/^  skip  next .*stopped$/m);
  });

  it("reports a relay that would not close, and removes the sandbox all the same", async () => {
    const { io, real } = await caller();
    let root = "";
    const code = await selfTest({
      main,
      env: real.env,
      io: io.io,
      json: false,
      steps: (run: Run) => [
        { name: "open", run: async () => {
          await run.open();
          root = run.box!.root;
          const relay = run.relay!;
          run.relay = { ...relay, close: () => relay.close().then(() => Promise.reject(new Error("the relay would not close"))) };
        } },
      ],
    });
    expect(code).toBe(1);
    expect(io.out.join("\n")).toMatch(/^  fail  remove the sandbox .*the relay would not close$/m);
    await expect(fs.lstat(root)).rejects.toThrow();
  });

  it("says what a command that never got ready printed last", async () => {
    const { io, real } = await caller();
    await selfTest({
      main,
      env: real.env,
      io: io.io,
      json: false,
      steps: (run: Run) => [
        { name: "open", run: async () => {
          await run.open();
          run.readyMs = 300;
          const a = await run.device("test-a");
          // One that ends first fails at once; one that keeps running fails when the wait ends.
          await expect(run.background(a, ["version"], /never printed/)).rejects.toThrow(/^`wim version` on test-a exited 0 before it was ready: \d+\.\d+\.\d+$/);
          await run.background(a, ["events", "--json"], /never printed/);
        } },
      ],
    });
    expect(io.out.join("\n")).toMatch(/^  fail  open .*timed out waiting for `wim events --json` on test-a: /m);
  });

  it("prints one row per step and a summary", () => {
    expect(report([{ name: "one", result: "pass", ms: 5 }, { name: "two", result: "skip", ms: 0, detail: "why" }], 1500)).toEqual([
      "  pass  one       5 ms",
      "  skip  two       0 ms  why",
      "FAIL: 2 steps, 1 passed, 0 failed, 1 skipped, in 1.5 s.",
    ]);
  });

  it("fails clearly when a step's check or output is not what it should be", async () => {
    expect(() => need(false, "no pong")).toThrow("no pong");
    expect(() => grab("nothing here", /id (\S+)/, "mesh id")).toThrow("no mesh id in the output");
    expect(grab("id m1", /id (\S+)/, "mesh id")).toBe("m1");
    await expect(waitFor(() => undefined, 20, "the code")).rejects.toThrow("timed out waiting for the code");
  });

  it("takes no arguments and no --mesh, and has its usage line", async () => {
    const t = term(await scratch("usage"), new RelayHarness());
    expect(await main(["test", "now"], {}, t.io)).toBe(2);
    expect(await main(["test", "--mesh", "m"], {}, t.io)).toBe(2);
    expect(t.err.join("\n")).toContain("usage: wim test [--full] [--relay <url> [--key-env NAME]] [--person] [--budget <seconds>] [--json]");
    expect(await main(["test", "--tls", "pin"], {}, t.io)).toBe(2);
    expect(await main(["help", "test"], {}, t.io)).toBe(0);
    expect(t.out.at(-1)).toBe("wim test [--full] [--relay <url> [--key-env NAME]] [--person] [--budget <seconds>] [--json]");
  });

  it("takes --budget in whole seconds, from 1 to a day", async () => {
    const t = term(await scratch("budget"), new RelayHarness());
    for (const bad of ["0", "-5", "1.5", "abc", "86401", "010", ""]) {
      t.err.length = 0;
      expect(await main(["test", "--budget", bad], {}, t.io), bad).toBe(2);
      expect(t.err.join("\n"), bad).toContain("--budget takes whole seconds, from 1 to 86400");
    }
    // A good one is taken: this run is then refused for its relay, before anything is made.
    t.err.length = 0;
    expect(await main(["test", "--budget", "86400", "--relay", "http://example.com"], {}, t.io)).toBe(2);
    expect(t.err.join("\n")).toContain("a live relay must be a wss:// URL");
  });

  it("keeps to its time budget: the step running then fails, the rest are skipped, and the run still cleans up and reports", async () => {
    const rows = await runSteps(
      [pass("quick"), { name: "hangs", run: () => new Promise(() => undefined) }, pass("after")],
      () => Promise.resolve(),
      new AbortController().signal,
      60_000,
      undefined,
      Date.now() + 200,
    );
    expect(rows.map((r) => [r.name, r.result, r.detail])).toEqual([
      ["quick", "pass", undefined],
      ["hangs", "fail", BUDGET_SPENT],
      ["after", "skip", "an earlier step failed"],
    ]);
    // A budget already spent skips every step, and the run does not pass.
    const spent = await runSteps([pass("one"), pass("two")], () => Promise.resolve(), new AbortController().signal, 60_000, undefined, Date.now() - 1);
    expect(spent).toMatchObject([
      { name: "one", result: "skip", detail: BUDGET_SPENT },
      { name: "two", result: "skip", detail: BUDGET_SPENT },
    ]);
    const { io, real } = await caller();
    let root = "";
    const code = await selfTest({
      main,
      env: real.env,
      io: io.io,
      json: true,
      budgetMs: 1500,
      steps: (run: Run) => [
        { name: "open", run: async () => {
          await run.open();
          root = run.box!.root;
        } },
        // Past the budget, and over a moment later: the end of the run waits for it.
        { name: "slow", run: () => new Promise((r) => setTimeout(r, 2500)) },
        pass("never"),
      ],
    });
    expect(code).toBe(1);
    const json = JSON.parse(io.out.at(-1)!) as { ok: boolean; steps: Array<{ name: string; result: string; detail?: string }> };
    expect(json.ok).toBe(false);
    expect(json.steps.map((s) => [s.name, s.result, s.detail])).toEqual([
      ["open", "pass", undefined],
      ["slow", "fail", BUDGET_SPENT],
      ["never", "skip", "an earlier step failed"],
      ["remove the sandbox", "pass", undefined],
    ]);
    await expect(fs.lstat(root)).rejects.toThrow();
  });

  it("waits for a stopped step's late work: a relay still starting is closed and its sandbox removed", async () => {
    const { io, real } = await caller();
    const stop = new AbortController();
    let ran: Run | undefined;
    let opened = false;
    const code = await selfTest({
      main,
      env: real.env,
      io: { ...io.io, signal: stop.signal },
      json: false,
      steps: (run: Run) => [
        { name: "open", run: async () => {
          ran = run;
          // Ctrl-C while the sandbox and its relay are still starting.
          stop.abort();
          await run.open();
          opened = true;
        } },
      ],
    });
    expect(code).toBe(1);
    expect(io.out.join("\n")).toMatch(/^ {2}fail {2}open .*stopped$/m);
    // The end of the run waited for open(), then closed its relay and removed its sandbox.
    expect(opened).toBe(true);
    expect(io.out.join("\n")).toMatch(/^ {2}pass {2}remove the sandbox/m);
    await expect(fs.lstat(ran!.box!.root)).rejects.toThrow();
  });

  it("stops what a stopped step started after the end of the run began: a command and a session", async () => {
    const { io, real } = await caller();
    const stop = new AbortController();
    let late: AbortSignal | undefined;
    let sessionStopped = false;
    const code = await selfTest({
      main,
      env: real.env,
      io: { ...io.io, signal: stop.signal },
      json: false,
      steps: (run: Run) => [
        { name: "open", run: async () => {
          await run.open();
          const a = await run.device("test-a");
          stop.abort();
          // The end of the run has begun: its first pass aborted the terminals it knew of.
          await new Promise((r) => setTimeout(r, 50));
          const t = run.term(a, []);
          late = t.io.signal;
          run.running.push({ term: t, done: new Promise<number>((r) => t.io.signal.addEventListener("abort", () => r(130), { once: true })) });
          run.sessions.push({ stop: async () => void (sessionStopped = true) } as unknown as MeshSession);
        } },
      ],
    });
    expect(code).toBe(1);
    expect(late!.aborted).toBe(true);
    expect(sessionStopped).toBe(true);
  });
});

describe("the isolation rules, against hostile input", { timeout: 30_000 }, () => {
  it("refuses a temporary directory inside the caller's state, and touches nothing there", async () => {
    const { io, real } = await caller();
    const before = await snapshot(real.root);
    const code = await selfTest({ main, env: real.env, io: io.io, json: false, tmp: real.root });
    expect(code).toBe(1);
    const out = io.out.join("\n");
    expect(out).toMatch(/fail {2}start the sandbox relay on loopback .*is inside this device's state/);
    expect(out).toMatch(/^ {2}pass {2}remove the sandbox/m);
    expect(await snapshot(real.root)).toEqual(before);
  });

  it("removes run directories left behind more than a day ago, marked as runs, and nothing else", async () => {
    const base = await scratch("sweep");
    const old = (Date.now() - STALE_MS - 60_000) / 1000;
    const marked = async (name: string, aged: boolean): Promise<string> => {
      const dir = join(base, name);
      await fs.mkdir(dir);
      await fs.writeFile(join(dir, SANDBOX_MARK), "");
      await fs.writeFile(join(dir, "keep.txt"), "x");
      if (aged) await fs.utimes(join(dir, SANDBOX_MARK), old, old);
      return dir;
    };
    const stale = await marked("wim-test-stale", true);
    const young = await marked("wim-test-young", false);
    const named = await marked("not-a-run", true);
    // Old, but not marked: a directory of someone else's that happens to have the name.
    const unmarked = join(base, "wim-test-unmarked");
    await fs.mkdir(unmarked);
    // A link named like a run, to an old marked run elsewhere: refused, and its target kept.
    const outside = join(await scratch("outside"), "run");
    await fs.mkdir(outside);
    await fs.writeFile(join(outside, SANDBOX_MARK), "");
    await fs.utimes(join(outside, SANDBOX_MARK), old, old);
    await fs.symlink(outside, join(base, "wim-test-link"), "junction");
    // A file named like a run, and a run whose mark is a directory.
    await fs.writeFile(join(base, "wim-test-file"), "x");
    const odd = join(base, "wim-test-odd");
    await fs.mkdir(join(odd, SANDBOX_MARK), { recursive: true });
    expect(await sweepStale(base, Date.now())).toEqual([stale]);
    for (const kept of [young, named, unmarked, join(base, "wim-test-file"), odd, join(outside, SANDBOX_MARK)]) await fs.lstat(kept);
    await expect(fs.lstat(stale)).rejects.toThrow();
    // A base that cannot be read has nothing to sweep.
    expect(await sweepStale(join(base, "missing"), Date.now())).toEqual([]);
  });

  it("skips, and never fails on, a run directory that is another user's, gone before it is read, or cannot be removed", async () => {
    const base = await scratch("sweep2");
    const old = (Date.now() - STALE_MS - 60_000) / 1000;
    const dir = join(base, "wim-test-planted");
    await fs.mkdir(dir);
    await fs.writeFile(join(dir, SANDBOX_MARK), "");
    await fs.utimes(join(dir, SANDBOX_MARK), old, old);
    const mine = (await fs.lstat(dir)).uid;
    const real = { lstat: fs.lstat, rm: fs.rm };
    // Another user's (on a shared /tmp): not ours to remove.
    expect(await sweepStale(base, Date.now(), { ...real, uid: mine + 1 })).toEqual([]);
    // Gone between the listing and its lstat (another run sweeping at once).
    const gone = (async (path: string) => (path === dir ? Promise.reject(new Error("ENOENT")) : fs.lstat(path))) as typeof fs.lstat;
    expect(await sweepStale(base, Date.now(), { ...real, lstat: gone, uid: mine })).toEqual([]);
    // Its removal fails (files another user put inside): skipped, the run goes on.
    const refused = (async () => Promise.reject(new Error("EACCES"))) as typeof fs.rm;
    expect(await sweepStale(base, Date.now(), { ...real, rm: refused, uid: mine })).toEqual([]);
    await fs.lstat(dir);
    // With no owners to compare (Windows), and with the right one, it goes.
    expect(await sweepStale(base, Date.now(), { ...real, uid: undefined })).toEqual([dir]);
  });

  it("marks each run's directory, so a later run can tell it is one, and removes one it cannot mark", async () => {
    const base = await scratch("box");
    const box = await Sandbox.open(base, []);
    expect((await fs.lstat(join(box.root, SANDBOX_MARK))).isFile()).toBe(true);
    await box.remove();
    // A mark that cannot be written (a full disk): the unmarked directory, which no sweep would
    // ever take, is removed, and the error is the run's.
    const write = vi.spyOn(fs, "writeFile").mockRejectedValueOnce(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));
    try {
      await expect(Sandbox.open(base, [])).rejects.toThrow("ENOSPC");
    } finally {
      write.mockRestore();
    }
    expect(await fs.readdir(base)).toEqual([]);
  });

  it("refuses a state directory that already exists, made or not", async () => {
    const box = await Sandbox.open(await scratch("box"), []);
    await fs.mkdir(join(box.root, "taken"));
    await expect(box.device("taken")).rejects.toThrow(/refusing the state directory .*taken/);
    await expect(box.absent("taken")).rejects.toThrow(/refusing the state directory .*taken: it already exists/);
    await box.remove();
  });

  it("refuses symbolic links: to the sandbox, inside it, and a device directory swapped for one between steps", async () => {
    const outside = await scratch("outside");
    const box = await Sandbox.open(await scratch("box"), []);
    box.attach("ws://127.0.0.1:1");
    // The sandbox reached through a link.
    const linked = join(await scratch("link"), "to-box");
    await fs.symlink(box.root, linked, "junction");
    await expect(noLinks(linked, join(linked, "a"))).rejects.toThrow(/reached through a symbolic link/);
    // A path outside it.
    await expect(noLinks(box.root, outside)).rejects.toThrow(/is outside the sandbox/);
    // A link inside it, on the way to a device.
    await fs.symlink(outside, join(box.root, "dev"), "junction");
    await expect(box.device("dev")).rejects.toThrow(/dev is a symbolic link/);
    // A device directory made, then swapped for a link to another device's state.
    await box.device("test-a");
    await box.check();
    await fs.rm(join(box.root, "test-a"), { recursive: true });
    await fs.symlink(outside, join(box.root, "test-a"), "junction");
    await expect(box.check()).rejects.toThrow(SandboxError);
    await box.remove();
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("refuses any relay that is not the run's own on loopback", async () => {
    const box = await Sandbox.open(await scratch("box"), []);
    await expect(box.check()).rejects.toThrow(/the relay undefined is not the sandbox's own/);
    for (const url of ["wss://relay.example", "ws://relay.example", "ws://localhost:1", "ws://[::1]:1", "not a url"]) {
      expect(onLoopback(url)).toBe(false);
      expect(() => box.attach(url)).toThrow(/must be on loopback/);
    }
    box.attach("ws://127.0.0.1:4");
    await box.check();
    // Swapped after it was checked once.
    (box as unknown as { relay: string }).relay = "wss://relay.example";
    await expect(box.check()).rejects.toThrow(/not the sandbox's own/);
    await box.remove();
  });

  it("dials and fetches only the sandbox relay", async () => {
    const dialed: string[] = [];
    const dialer = sandboxDialer("ws://127.0.0.1:1234", async (url) => {
      dialed.push(url);
      return {} as WireSocket;
    });
    await dialer("ws://127.0.0.1:1234/v1/m", {});
    for (const url of ["ws://127.0.0.1:12345/v1/m", "wss://relay.example/v1/m", "ws://127.0.0.1:1234.example/v1/m"]) await expect(dialer(url, {})).rejects.toThrow(SandboxError);
    expect(dialed).toEqual(["ws://127.0.0.1:1234/v1/m"]);
    const fetched: string[] = [];
    const f = sandboxFetch("http://127.0.0.1:1234/", (async (url: string) => {
      fetched.push(url);
      return new Response("{}");
    }) as typeof fetch);
    await f("http://127.0.0.1:1234/v1/info");
    await expect(f("https://relay.example/v1/info")).rejects.toThrow(SandboxError);
    await expect(f(new URL("http://127.0.0.1:12345/v1/info"))).rejects.toThrow(SandboxError);
    expect(fetched).toEqual(["http://127.0.0.1:1234/v1/info"]);
  });

  it("builds each device's environment from nothing, so the device is a person's terminal with its own state", () => {
    const env = deviceEnv("/sandbox/test-a");
    expect(env).toEqual({ WIM_HOME: "/sandbox/test-a", WIM_NO_CRASH_REPORTS: "1" });
    expect(notAPerson(env, true)).toBeUndefined();
    // Nothing in the scripted terminal is a parent that can go away (\`wim mcp\` reads it).
    const t = term("/sandbox/test-a", new RelayHarness());
    expect(t.io.parentGone()).toBe(false);
  });

  it("answers a prompt with no answer left with an empty line, which every prompt reads as no", async () => {
    const t = term("/sandbox/test-a", new RelayHarness());
    t.answers.push("y", () => "later");
    expect([await t.io.prompt("one? "), await t.io.prompt("two? "), await t.io.prompt("three? ")]).toEqual(["y", "later", ""]);
    expect(t.out).toEqual(["one? ", "two? ", "three? "]);
  });

  it("counts a path as inside only when it is", () => {
    const root = join("/", "s", "box");
    expect(inside(root, root)).toBe(true);
    expect(inside(root, join(root, "a"))).toBe(true);
    expect(inside(root, join(root, "..a"))).toBe(true);
    expect(inside(root, join(root, ".."))).toBe(false);
    expect(inside(root, join("/", "s", "box2"))).toBe(false);
  });

  it("moves a --full run whose temporary directory is too long for the signer's socket, or refuses it up front", async () => {
    const long = await longDir(110);
    const root = await fs.realpath("/");
    // Under the long base the socket would be over 103 bytes: on POSIX the run goes to the fallback.
    expect(await runBase(long, "linux", root)).toBe(root);
    expect(await runBase(long, "darwin", root)).toBe(root);
    // A base that fits is kept, and Windows names a pipe, so any base fits there.
    expect(await runBase(root, "linux", join(long, "missing"))).toBe(root);
    expect(await runBase(long, "win32", join(long, "missing"))).toBe(long);
    // A fallback that is missing or too long as well: refused, with the advice that works in the sandbox.
    for (const fallback of [join(long, "missing"), long]) {
      await expect(runBase(long, "linux", fallback)).rejects.toThrow(`the temporary directory ${long} is too long for the signer's socket (at most 103 bytes): set TMPDIR to a shorter directory`);
    }
    expect(SHORT_TMP).toBe("/tmp");
  });

  it.skipIf(!POSIX)("runs the signer step under a temporary directory of about 110 characters", async () => {
    const { io, real } = await caller();
    const long = await longDir(110);
    // The fallback: right under the system's temporary directory, whose path is short on every runner.
    const short = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "wim-s-"));
    let root = "";
    try {
      const code = await selfTest({
        main,
        env: real.env,
        io: io.io,
        json: true,
        full: true,
        tmp: long,
        shortTmp: short,
        steps: (run: Run) => [
          { name: "open", run: async () => {
            await run.open();
            root = run.box!.root;
          } },
          signerStep(run),
        ],
      });
      const json = JSON.parse(io.out.at(-1)!) as { steps: Array<{ name: string; result: string; detail?: string }> };
      expect(json.steps.map((s) => [s.name, s.result, s.detail])).toEqual([
        ["open", "pass", undefined],
        ["the signer: encrypt, start, lock, unlock, stop", "pass", undefined],
        ["remove the sandbox", "pass", undefined],
      ]);
      expect(code).toBe(0);
      expect(inside(short, root)).toBe(true);
      expect(await fs.readdir(long)).toEqual([]);
    } finally {
      await fs.rm(short, { recursive: true, force: true });
    }
  });

  it("keeps the scripted terminal inside wim test: only the CLI's test command imports it", async () => {
    const src = join(import.meta.dirname, "..", "src");
    const importers: string[] = [];
    for (const name of await fs.readdir(src)) {
      if (name === "selftest.ts") continue;
      if ((await fs.readFile(join(src, name), "utf8")).includes("selftest")) importers.push(name);
    }
    expect(importers).toEqual(["cli.ts"]);
    const cli = await fs.readFile(join(src, "cli.ts"), "utf8");
    expect(cli.match(/selfTest/g)).toHaveLength(2);
    expect(cli).toContain('import { selfTest } from "./selftest.ts";');
    // The MCP server and the events feed reach the CLI only for its types.
    for (const name of ["mcp.ts", "events.ts"]) expect(await fs.readFile(join(src, name), "utf8")).not.toMatch(/from "\.\/cli\.ts"/);
  });
});
