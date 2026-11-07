// "worldinmotion: Run Self-Test": reading `wim test --json`'s report (and refusing what is not
// one), the rows and the message, and running the client: its output, its errors, and a cancel
// that stops it.

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { SpawnFn } from "../src/process.ts";
import { parseReport, reportLines, runClient, runSelfTest, SHOW, summary, type SelfTestReport } from "../src/selftest.ts";

const step = (name: string, result: "pass" | "fail" | "skip", ms: number, detail?: string) => ({ name, result, ms, ...(detail === undefined ? {} : { detail }) });

const passed: SelfTestReport = { ok: true, passed: 2, failed: 0, skipped: 0, ms: 4200, steps: [step("create the mesh", "pass", 900), step("remove the sandbox", "pass", 12)] };
const failed: SelfTestReport = {
  ok: false,
  passed: 1,
  failed: 1,
  skipped: 1,
  ms: 61_000,
  steps: [step("create the mesh", "pass", 900), step("ping both directions", "fail", 5000, "no pong\nfrom qa@test-b"), step("mesh delete", "skip", 0, "an earlier step failed")],
};

describe("the report", () => {
  it("is the last line of the output, counted from its steps", () => {
    const line = JSON.stringify({ mode: "sandbox", ok: false, passed: 9, failed: 9, skipped: 9, ms: 61_000, steps: failed.steps });
    expect(parseReport(`a line before\n${line}\n`)).toEqual(failed);
    // No total time: 0.
    expect(parseReport(JSON.stringify({ ok: true, steps: [] }))).toEqual({ ok: true, passed: 0, failed: 0, skipped: 0, ms: 0, steps: [] });
  });

  it("is refused when the line is not one", () => {
    for (const text of ["", "not json", "null", "[]", '{"ok":"yes","steps":[]}', '{"ok":true}', '{"ok":true,"steps":[null]}', '{"ok":true,"steps":[{"name":"x","result":"maybe","ms":1}]}', '{"ok":true,"steps":[{"name":"x","result":"pass"}]}', '{"ok":false,"steps":[{"name":"x","result":"fail","ms":1,"detail":{"not":"text"}}]}']) {
      expect(parseReport(text)).toBeUndefined();
    }
  });

  it("shows each step with its mark first, then the summary; details on one line", () => {
    expect(reportLines(failed)).toEqual([
      "PASS  create the mesh       900 ms",
      "FAIL  ping both directions   5.0 s  no pong from qa@test-b",
      "skip  mesh delete             0 ms  an earlier step failed",
      "FAILED: 3 steps, 1 passed, 1 failed, 1 skipped, in 1 min.",
    ]);
    expect(reportLines(passed).at(-1)).toBe("PASSED: 2 steps, 2 passed, 0 failed, 0 skipped, in 4.2 s.");
  });

  it("says the outcome in one line, naming the first failed step", () => {
    expect(summary(passed)).toBe("worldinmotion: the self-test passed (2 of 2 steps, in 4.2 s).");
    expect(summary(failed)).toBe("worldinmotion: the self-test failed: 1 failed, 1 skipped; first: ping both directions (no pong from qa@test-b).");
    // Failed without a failed step (a skip that fails the run), and a failed step with no detail.
    expect(summary({ ...failed, steps: [step("a", "skip", 0)] })).toBe("worldinmotion: the self-test failed: 1 failed, 1 skipped.");
    expect(summary({ ...failed, steps: [step("a", "fail", 0)] })).toBe("worldinmotion: the self-test failed: 1 failed, 1 skipped; first: a.");
  });
});

/** A child process stand-in: what it writes, how it ends, and whether it was killed. */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  /** What was written to stdin, and whether it was ended. */
  readonly written: string[] = [];
  ended = false;
  readonly stdin = Object.assign(new EventEmitter(), { write: (t: string) => (this.written.push(t), true), end: () => void (this.ended = true) });
  killed = 0;
  kill(): boolean {
    this.killed++;
    setImmediate(() => this.emit("close", null, "SIGTERM"));
    return true;
  }
}

const command = { cmd: "wim", args: ["test", "--json"], env: {}, cwd: "/" };
const never = { onCancellationRequested: () => undefined };

describe("running the client", () => {
  it("reads the report, in chunks that split characters", async () => {
    const child = new FakeChild();
    const asked: unknown[] = [];
    const spawn = ((...a: unknown[]) => (asked.push(a), child)) as unknown as SpawnFn;
    const done = runClient(command, spawn, never);
    const bytes = Buffer.from(`${JSON.stringify({ ok: true, ms: 5, steps: [step("é", "pass", 1)] })}\n`);
    const at = bytes.indexOf(0xc3) + 1;
    child.stdout.emit("data", bytes.subarray(0, at));
    child.stdout.emit("data", bytes.subarray(at));
    child.emit("close", 0, null);
    expect(await done).toEqual({ report: { ok: true, passed: 1, failed: 0, skipped: 0, ms: 5, steps: [step("é", "pass", 1)] } });
    expect(asked).toEqual([["wim", ["test", "--json"], { cwd: "/", env: {}, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }]]);
  });

  it("says why there is no report: the last stderr line, or the exit code", async () => {
    const child = new FakeChild();
    const done = runClient(command, (() => child) as unknown as SpawnFn, never);
    child.stdout.emit("data", Buffer.from("not a report\n"));
    child.stderr.emit("data", Buffer.from("wim: first\nwim: the last one\n"));
    child.emit("close", 1, null);
    expect(await done).toEqual({ error: "wim: the last one" });
    const quiet = new FakeChild();
    const silent = runClient(command, (() => quiet) as unknown as SpawnFn, never);
    quiet.emit("close", 2, null);
    expect(await silent).toEqual({ error: "the client exited 2 with no report" });
  });

  it("keeps at most MAX_OUTPUT of each stream", async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 0x61);
    const report = JSON.stringify({ ok: true, ms: 1, steps: [step("create the mesh", "pass", 1)] });
    // A valid report past the limit on stdout is not read: nothing past MAX_OUTPUT is kept.
    const out = new FakeChild();
    const outDone = runClient(command, (() => out) as unknown as SpawnFn, never);
    for (let i = 0; i < 2; i++) out.stdout.emit("data", big);
    out.stdout.emit("data", Buffer.from(`\n${report}\n`));
    out.emit("close", 0, null);
    expect(await outDone).toEqual({ error: "the client exited 0 with no report" });
    // On stderr, a line past the limit is not the reason given.
    const err = new FakeChild();
    const errDone = runClient(command, (() => err) as unknown as SpawnFn, never);
    for (let i = 0; i < 2; i++) err.stderr.emit("data", big);
    err.stderr.emit("data", Buffer.from("\nwim: a line past the limit\n"));
    err.emit("close", 1, null);
    const r = await errDone;
    expect("error" in r && !r.error.includes("past the limit")).toBe(true);
  });

  it("says when the client cannot start, whether spawn throws or the child errors", async () => {
    const throws = (() => {
      throw new Error("EACCES");
    }) as unknown as SpawnFn;
    expect(await runClient(command, throws, never)).toEqual({ error: "the client could not start: EACCES" });
    const child = new FakeChild();
    const done = runClient(command, (() => child) as unknown as SpawnFn, never);
    child.emit("error", new Error("ENOENT"));
    expect(await done).toEqual({ error: "the client could not start: ENOENT" });
  });

  it("asks the client to stop when the person cancels, so it removes what it made, and kills it only when it does not end", async () => {
    // It ends by itself after the stop line, with its report: not killed.
    const polite = new FakeChild();
    let cancel: () => void = () => undefined;
    const ended = runClient(command, (() => polite) as unknown as SpawnFn, { onCancellationRequested: (fn) => void (cancel = fn) }, 5000);
    expect(polite.ended).toBe(false);
    cancel();
    expect([polite.written, polite.ended]).toEqual([["stop\n"], true]);
    polite.stdout.emit("data", Buffer.from(JSON.stringify(failed)));
    polite.emit("close", 1, null);
    expect(await ended).toEqual({ report: failed });
    expect(polite.killed).toBe(0);
    // It does not end: killed once the grace runs out.
    const child = new FakeChild();
    const done = runClient(command, (() => child) as unknown as SpawnFn, { onCancellationRequested: (fn) => void (cancel = fn) }, 10);
    cancel();
    expect(await done).toEqual({ error: "the client exited null with no report" });
    expect(child.killed).toBe(1);
    // A write error on stdin (the client gone) is not thrown.
    child.stdin.emit("error", new Error("EPIPE"));
  });
});

describe("the command", () => {
  /** The command's dependencies, with a client that prints `stdout` and exits `code`, and the person answering `answer`. */
  function deps(stdout: string, code: number, answer: string | undefined, cancel = false) {
    const lines: string[] = [];
    const shown: boolean[] = [];
    const messages: Array<{ level: string; message: string; items: string[] }> = [];
    const progress: unknown[] = [];
    const say = (level: string) => (message: string, ...items: string[]) => (messages.push({ level, message, items }), Promise.resolve(answer));
    const child = new FakeChild();
    return {
      lines,
      shown,
      messages,
      progress,
      d: {
        window: {
          withProgress: <T,>(options: unknown, task: (p: unknown, t: { onCancellationRequested(fn: () => void): unknown }) => Promise<T>) => {
            progress.push(options);
            // `cancel`: the person cancels as soon as the task listens.
            const running = task(undefined, cancel ? { onCancellationRequested: (fn: () => void) => fn() } : never);
            child.stdout.emit("data", Buffer.from(stdout));
            child.emit("close", code, null);
            return running;
          },
          showInformationMessage: say("info"),
          showErrorMessage: say("error"),
        },
        notification: 15,
        channel: { appendLine: (l: string) => void lines.push(l), show: (keep?: boolean) => void shown.push(keep === true) },
        command: () => command,
        spawn: (() => child) as unknown as SpawnFn,
      },
    };
  }

  it("shows a pass, and the steps on request", async () => {
    const w = deps(`${JSON.stringify(passed)}\n`, 0, SHOW);
    await runSelfTest(w.d);
    expect(w.progress).toEqual([{ location: 15, title: "worldinmotion: running the self-test (throwaway devices and a relay on loopback)...", cancellable: true }]);
    expect(w.messages).toEqual([{ level: "info", message: "worldinmotion: the self-test passed (2 of 2 steps, in 4.2 s).", items: [SHOW] }]);
    expect(w.lines.slice(1)).toEqual(reportLines(passed));
    expect(w.lines[0]).toMatch(/^self-test, \d{4}-/);
    expect(w.shown).toEqual([true]);
  });

  it("shows a fail as an error, and the steps stay closed when not asked for", async () => {
    const w = deps(`${JSON.stringify(failed)}\n`, 1, undefined);
    await runSelfTest(w.d);
    expect(w.messages[0]).toMatchObject({ level: "error", message: summary(failed) });
    expect(w.shown).toEqual([]);
  });

  it("says when there is no report", async () => {
    const w = deps("garbage", 1, undefined);
    await runSelfTest(w.d);
    expect(w.messages).toEqual([{ level: "error", message: "worldinmotion: the self-test did not finish: the client exited 1 with no report", items: [] }]);
    expect(w.lines.at(-1)).toBe("no report: the client exited 1 with no report");
  });

  it("says a cancelled run was cancelled, not failed, with or without a report", async () => {
    const w = deps(`${JSON.stringify(failed)}\n`, 1, SHOW, true);
    await runSelfTest(w.d);
    expect(w.messages).toEqual([{ level: "info", message: "worldinmotion: the self-test was cancelled.", items: [SHOW] }]);
    expect(w.lines.slice(1)).toEqual(reportLines(failed));
    expect(w.shown).toEqual([true]);
    const none = deps("", null as unknown as number, undefined, true);
    await runSelfTest(none.d);
    expect(none.messages).toEqual([{ level: "info", message: "worldinmotion: the self-test was cancelled: the client exited null with no report", items: [] }]);
  });
});
