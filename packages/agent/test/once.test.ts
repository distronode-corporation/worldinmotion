import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { exitFor, parseRequest, runOnce } from "../src/once.ts";
import { RUNNER_MAX_BYTES } from "../src/runner.ts";

const DEVICE = "A".repeat(22);
let dir: string;
let stub: string;

beforeAll(async () => {
  const base = process.env["WIM_TEST_TMP"] || tmpdir();
  await mkdir(base, { recursive: true });
  dir = await mkdtemp(join(base, "wim-agent-once-"));
  stub = join(dir, "runner.mjs");
  // Echoes the request back in the answer; MODE (from the request text) picks the exit code.
  await writeFile(
    stub,
    `let s = ""; process.stdin.on("data", (c) => (s += c)); process.stdin.on("end", () => {
      const r = JSON.parse(s);
      process.stderr.write("stub got " + r.id + "\\n");
      if (r.text === "big") { process.stdout.write("x".repeat(${RUNNER_MAX_BYTES} + 10)); process.exit(0); }
      if (r.text.startsWith("exit ")) process.exit(Number(r.text.slice(5)));
      if (r.text === "env") { process.stdout.write(String(process.env.KEEP) + "," + String(process.env.DROP)); process.exit(0); }
      process.stdout.write("answer for " + r.profile + ": " + r.text);
    });`,
  );
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const config = (over: Record<string, unknown> = {}) =>
  loadConfig({
    senders: { devices: [DEVICE] },
    wake: { mode: "none" },
    runner: { command: process.execPath, args: [stub], timeoutSeconds: 10, passEnv: ["KEEP"], ...over },
    limits: { ledgerPath: join(dir, "ledger.json") },
  });

const req = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({ v: 1, id: "m1", from: { device: DEVICE, address: "a@b" }, profile: "p", text, ...extra });

function io(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (t: string) => void out.push(t), err: (l: string) => void err.push(l), env } };
}

describe("parseRequest", () => {
  it("takes a contract request and nothing else", () => {
    expect(parseRequest(req("hi"))).toEqual({ v: 1, id: "m1", from: { device: DEVICE, address: "a@b" }, profile: "p", text: "hi" });
    expect(parseRequest("{")).toMatch(/^not valid JSON/);
    expect(parseRequest("null")).toBe('expected {"v":1, ...}');
    expect(parseRequest(JSON.stringify({ v: 2 }))).toBe('expected {"v":1, ...}');
    for (const bad of [{ id: 1 }, { from: null }, { from: "x" }, { from: { device: 1, address: "a" } }, { from: { device: "d" } }, { profile: 3 }, { text: null }]) {
      expect(parseRequest(req("hi", bad))).toMatch(/^expected \{"v":1,"id"/);
    }
    expect(parseRequest(" ".repeat(RUNNER_MAX_BYTES + 1))).toMatch(/over/);
  });
});

describe("exitFor", () => {
  it("keeps the contract's codes and folds every failure into 1", () => {
    expect(exitFor({ kind: "answered", answer: "", truncated: false })).toBe(0);
    expect(exitFor({ kind: "refused" })).toBe(3);
    expect(exitFor({ kind: "busy" })).toBe(4);
    expect(exitFor({ kind: "timeout" })).toBe(5);
    expect(exitFor({ kind: "failed", code: 9, signal: null })).toBe(1);
  });
});

describe("runOnce, through a real runner process", () => {
  it("prints the answer and logs the runner's stderr", async () => {
    const o = io();
    expect(await runOnce(config(), req("hello"), o.io)).toBe(0);
    expect(o.out.join("")).toBe("answer for p: hello");
    expect(o.err).toContain("runner: stub got m1");
  });

  it("passes only runner.passEnv to the runner", async () => {
    const o = io({ KEEP: "k", DROP: "d" });
    expect(await runOnce(config(), req("env"), o.io)).toBe(0);
    expect(o.out.join("")).toBe("k,undefined");
  });

  it("keeps stderr out when logStderr is off", async () => {
    const o = io();
    expect(await runOnce(config({ logStderr: false }), req("hello"), o.io)).toBe(0);
    expect(o.err).toEqual([]);
  });

  it("says when the answer was cut", async () => {
    const o = io();
    expect(await runOnce(config(), req("big"), o.io)).toBe(0);
    expect(o.out.join("").length).toBe(RUNNER_MAX_BYTES);
    expect(o.err.at(-1)).toMatch(/cut at/);
  });

  it.each([
    [3, "refused"],
    [4, "busy"],
    [5, "timeout"],
  ])("exit %i is %s", async (code, word) => {
    const o = io();
    expect(await runOnce(config(), req(`exit ${code}`), o.io)).toBe(code);
    expect(o.err.at(-1)).toBe(`wim worker run: ${word}`);
  });

  it("any other exit is a failure, named by its code", async () => {
    const o = io();
    expect(await runOnce(config(), req("exit 7"), o.io)).toBe(1);
    expect(o.err.at(-1)).toBe("wim worker run: the runner failed (exit 7)");
  });

  it("a runner killed by a signal, and one that never started", async () => {
    const o = io();
    const killer = join(dir, "self-kill.mjs");
    await writeFile(killer, `process.stdin.resume(); process.kill(process.pid, "SIGKILL");`);
    expect(await runOnce(config({ args: [killer] }), req("x"), o.io)).toBe(1);
    expect(o.err.at(-1)).toBe("wim worker run: the runner failed (signal SIGKILL)");
    const p = io();
    expect(await runOnce(config({ command: join(dir, "no-such-runner") }), req("x"), p.io)).toBe(1);
    expect(p.err.at(-1)).toBe("wim worker run: the runner failed (it did not start)");
  });

  it("refuses a malformed request before starting anything", async () => {
    const o = io();
    expect(await runOnce(config(), "not json", o.io)).toBe(2);
    expect(o.err[0]).toMatch(/^wim worker run: not valid JSON/);
  });
});
