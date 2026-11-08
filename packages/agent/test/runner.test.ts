import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { encodeRequest, RUNNER_EXIT, RUNNER_MAX_BYTES, RUNNER_MAX_REQUEST_BYTES, runJob, runnerEnv, signalGroup, truncateUtf8, type RunnerRequest, type RunnerSpec } from "../src/runner.ts";
import { LAPTOP, scratchDir } from "./helpers.ts";

const POSIX = process.platform !== "win32";

const req: RunnerRequest = { v: 2, id: "01JC0000000000000000000000", from: { device: LAPTOP, address: "me@laptop" }, profile: "a", text: "list the files ünïcode" };

/** A runner script in a scratch directory, run with this Node. */
async function stub(body: string, extra: Partial<RunnerSpec> = {}): Promise<RunnerSpec> {
  const dir = await scratchDir();
  const path = join(dir, "runner.mjs");
  await writeFile(path, body);
  return { command: process.execPath, args: [path, "--fixed", "arg"], timeoutMs: 10_000, killGraceMs: 200, env: { PATH: process.env["PATH"] ?? "", ONLY: "this" }, ...extra };
}

const READ_STDIN = `let b = ""; process.stdin.setEncoding("utf8"); for await (const c of process.stdin) b += c;`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runJob", () => {
  it("sends the request on stdin, never on argv, and returns stdout as the answer", async () => {
    const spec = await stub(`${READ_STDIN} process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), req: JSON.parse(b), env: Object.keys(process.env).sort() }));`);
    const out = await runJob(spec, req);
    expect(out.kind).toBe("answered");
    const got = JSON.parse((out as { answer: string }).answer);
    expect(got.argv).toEqual(["--fixed", "arg"]);
    expect(got.req).toEqual(req);
    expect(got.env).toEqual(expect.arrayContaining(["ONLY", "PATH"]));
    expect(got.env).not.toContain("HOME");
    expect((out as { truncated: boolean }).truncated).toBe(false);
  });

  it.each([
    [RUNNER_EXIT.refused, { kind: "refused" }],
    [RUNNER_EXIT.busy, { kind: "busy" }],
    [RUNNER_EXIT.timeout, { kind: "timeout" }],
    [1, { kind: "failed", code: 1, signal: null }],
    [7, { kind: "failed", code: 7, signal: null }],
  ])("maps exit %i", async (code, outcome) => {
    const spec = await stub(`${READ_STDIN} process.stdout.write("ignored"); process.exit(${code});`);
    expect(await runJob(spec, req)).toEqual(outcome);
  });

  it.runIf(POSIX)("reports a runner killed by a signal as failed", async () => {
    const spec = await stub(`process.kill(process.pid, "SIGKILL");`);
    expect(await runJob(spec, req)).toEqual({ kind: "failed", code: null, signal: "SIGKILL" });
  });

  it("cuts an answer over 64 KiB on a character boundary and says so", async () => {
    // "é" is two bytes, so 64 KiB of them plus one byte cannot end on the limit.
    const spec = await stub(`${READ_STDIN} process.stdout.write("x" + "é".repeat(${RUNNER_MAX_BYTES})); `);
    const out = await runJob(spec, req);
    expect(out).toMatchObject({ kind: "answered", truncated: true });
    const answer = (out as { answer: string }).answer;
    expect(Buffer.byteLength(answer)).toBeLessThanOrEqual(RUNNER_MAX_BYTES);
    expect(answer.endsWith("é")).toBe(true);
    expect(answer).not.toContain("�");
  });

  it("copies stderr lines, capped, and the last partial line", async () => {
    const spec = await stub(`process.stderr.write("one\\ntwo\\n" + "z".repeat(600)); setTimeout(() => process.stderr.write("\\ntail"), 50);`);
    const lines: string[] = [];
    await runJob(spec, req, { stderr: (l) => lines.push(l) });
    expect(lines[0]).toBe("one");
    expect(lines[1]).toBe("two");
    expect(lines[2]).toBe("z".repeat(500));
    expect(lines.at(-1)).toBe("tail");
    // Without a stderr sink the lines are dropped.
    expect(await runJob(spec, req)).toMatchObject({ kind: "answered" });
  });

  it.runIf(POSIX)("on timeout sends SIGTERM to the whole group, then SIGKILL after the grace", async () => {
    const dir = await scratchDir();
    const pidFile = join(dir, "grandchild");
    const spec = await stub(
      `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
       process.on("SIGTERM", () => undefined);
       const g = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => undefined); setInterval(() => {}, 1000)"], { stdio: "ignore" });
       writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
       setInterval(() => {}, 1000);`,
      { timeoutMs: 300, killGraceMs: 200 },
    );
    const logs: string[] = [];
    const signals: string[] = [];
    const out = await runJob(spec, req, {
      log: (l) => logs.push(l),
      killGroup: (pgid, signal) => {
        signals.push(signal);
        process.kill(pgid, signal);
      },
    });
    expect(out).toEqual({ kind: "timeout" });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(logs[0]).toContain("passed 0.3 s; stopping the runner");
    const { readFile } = await import("node:fs/promises");
    const grandchild = Number(await readFile(pidFile, "utf8"));
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(grandchild)).toBe(false);
  });

  it.runIf(POSIX)("still kills the group after a leader that exits on SIGTERM, with the default kill", async () => {
    const spec = await stub(`setInterval(() => {}, 1000);`, { timeoutMs: 100, killGraceMs: 50 });
    const out = await runJob(spec, req);
    expect(out).toEqual({ kind: "timeout" });
    // The SIGKILL after the grace finds the group gone (ESRCH), quietly.
    await new Promise((r) => setTimeout(r, 120));
  });

  it("logs EPERM on the kill (a runner under sudo) without failing", async () => {
    const spec = await stub(`setTimeout(() => process.exit(0), 400);`, { timeoutMs: 50, killGraceMs: 20 });
    const logs: string[] = [];
    const out = await runJob(spec, req, {
      log: (l) => logs.push(l),
      killGroup: () => {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      },
    });
    expect(out).toEqual({ kind: "timeout" });
    expect(logs.filter((l) => l.includes("EPERM"))).toEqual([
      "worker: SIGTERM to the runner's process group failed: EPERM",
      "worker: SIGKILL to the runner's process group failed: EPERM",
    ]);
  });

  it("does not start a runner that cannot be found", async () => {
    const logs: string[] = [];
    const spec = await stub("");
    expect(await runJob({ ...spec, command: join(await scratchDir(), "missing") }, req, { log: (l) => logs.push(l) })).toEqual({ kind: "failed", code: null, signal: null });
    expect(logs[0]).toMatch(/^worker: the runner did not start: /);
  });

  it("survives a spawn that throws", async () => {
    const logs: string[] = [];
    const spec = await stub("");
    const out = await runJob(spec, req, {
      log: (l) => logs.push(l),
      spawn: () => {
        throw new Error("EAGAIN");
      },
    });
    expect(out).toEqual({ kind: "failed", code: null, signal: null });
    expect(logs).toEqual(["worker: the runner did not start: EAGAIN"]);
  });

  it("times out a child that never got a pid", async () => {
    const child = Object.assign(new EventEmitter(), { pid: undefined, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    const spec = await stub("", { timeoutMs: 10 });
    const p = runJob(spec, req, { spawn: () => child as unknown as ChildProcess, killGroup: () => expect.unreachable() });
    await new Promise((r) => setTimeout(r, 30));
    child.emit("close", null, null);
    expect(await p).toEqual({ kind: "timeout" });
  });

  it("refuses a request over 64 KiB before starting anything", async () => {
    const spec = await stub("");
    const big = { ...req, text: "x".repeat(RUNNER_MAX_REQUEST_BYTES) };
    expect(await runJob(spec, big, { spawn: () => expect.unreachable() })).toEqual({ kind: "failed", code: null, signal: null });
    expect(await runJob(spec, big)).toEqual({ kind: "failed", code: null, signal: null });
  });
});

describe("helpers", () => {
  it("encodeRequest is UTF-8 JSON", () => {
    expect(JSON.parse(encodeRequest(req).toString("utf8"))).toEqual(req);
    expect(() => encodeRequest({ ...req, text: "é".repeat(RUNNER_MAX_REQUEST_BYTES / 2) })).toThrow(RangeError);
    // A frame up to the relay's limit fits.
    expect(encodeRequest({ ...req, frame: { boxes: "x".repeat(1024 * 1024 + 4 * 1024) } }).length).toBeLessThanOrEqual(RUNNER_MAX_REQUEST_BYTES);
  });

  it("truncateUtf8 keeps short text whole", () => {
    expect(truncateUtf8(Buffer.from("abc"), 3)).toEqual({ text: "abc", truncated: false });
    expect(truncateUtf8(Buffer.from("aé"), 2)).toEqual({ text: "a", truncated: true });
    expect(truncateUtf8(Buffer.from("é"), 1)).toEqual({ text: "", truncated: true });
  });

  it("signalGroup signals the negative pid, quiet on ESRCH, logs anything else", () => {
    const logs: string[] = [];
    const seen: Array<[number, string]> = [];
    signalGroup(42, "SIGTERM", (p, s) => void seen.push([p, s]), (l) => logs.push(l));
    expect(seen).toEqual([[-42, "SIGTERM"]]);
    signalGroup(42, "SIGKILL", () => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    }, (l) => logs.push(l));
    signalGroup(42, "SIGKILL", () => {
      throw "weird";
    }, (l) => logs.push(l));
    expect(logs).toEqual(["worker: SIGKILL to the runner's process group failed: weird"]);
  });

  it("runnerEnv passes only the named variables that are set", () => {
    expect(runnerEnv({ PATH: "/bin", HOME: "/h", SECRET: "x" }, ["PATH", "HOME", "LANG"])).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});
