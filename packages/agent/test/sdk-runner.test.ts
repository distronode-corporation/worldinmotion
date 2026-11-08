import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RUNNER_EXIT, RUNNER_MAX_REQUEST_BYTES, type RunnerRequest } from "../src/runner.ts";
import { promptFor, READ_ONLY_TOOLS, RUNNER_PREAMBLE, runnerMain, sdkOptions, toolOptions, type QueryFn, type RunnerIO } from "../src/sdk-runner.ts";
import { LAPTOP, scratchDir } from "./helpers.ts";

// No real API call in any test: the SDK is replaced wholesale.
const sdkQuery = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdkQuery }));

const KEY = "sk-ant-test-not-a-real-key";
const req: RunnerRequest = { v: 2, id: "m1", from: { device: LAPTOP, address: "me@laptop" }, profile: "", text: "list the files" };

function success(result: string) {
  return { type: "result", subtype: "success", is_error: false, result, num_turns: 2, total_cost_usd: 0.01 };
}

async function* messages(...ms: unknown[]): AsyncGenerator<unknown> {
  for (const m of ms) yield m;
}

function io(extra: Partial<RunnerIO> & { request?: unknown; config?: unknown } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const { request, config, ...rest } = extra;
  const body = typeof request === "string" ? request : JSON.stringify(request ?? req);
  const files: Record<string, string> = { "/cfg.json": JSON.stringify(config ?? {}), "/key": `${KEY}\n` };
  const query: QueryFn = (p) => {
    calls.push(p);
    return messages({ type: "system" }, success("the answer"));
  };
  const value: RunnerIO = {
    stdin: messages(Buffer.from(body)) as AsyncIterable<Buffer>,
    stdout: (t) => void out.push(t),
    stderr: (l) => void err.push(l),
    env: { ANTHROPIC_API_KEY: KEY, PATH: "/bin", HOME: "/home/w", SECRET: "no" },
    cwd: "/work",
    readFile: async (p) => {
      if (!(p in files)) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
      return files[p]!;
    },
    query,
    ...rest,
  };
  return { value, out, err, calls };
}

describe("runnerMain", () => {
  it("runs one read-only job and prints only the answer", async () => {
    const t = io();
    expect(await runnerMain(["--config", "/cfg.json"], t.value)).toBe(RUNNER_EXIT.ok);
    expect(t.out).toEqual(["the answer"]);
    expect(t.calls).toHaveLength(1);
    const o = t.calls[0]!.options;
    expect(o).toMatchObject({
      model: "claude-opus-5-5",
      effort: "medium",
      tools: READ_ONLY_TOOLS,
      allowedTools: READ_ONLY_TOOLS,
      permissionMode: "dontAsk",
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      persistSession: false,
      maxTurns: 30,
      cwd: "/work",
    });
    expect(o["env"]).toEqual({ ANTHROPIC_API_KEY: KEY, CLAUDE_AGENT_SDK_CLIENT_APP: "worldinmotion-agent", PATH: "/bin", HOME: "/home/w" });
    expect(o).not.toHaveProperty("maxBudgetUsd");
    expect(o).not.toHaveProperty("pathToClaudeCodeExecutable");
    expect(t.calls[0]!.prompt).toBe(promptFor(req));
    // Nothing of the task, key or answer on stderr.
    const logged = t.err.join("\n");
    expect(logged).toBe("wim-agent-runner: job m1 success turns=2 cost_usd=0.01");
    expect(logged).not.toContain(KEY);
  });

  it("accepts a request carrying a frame, and ignores it", async () => {
    const t = io({ request: { ...req, frame: { sig: "x" } } });
    expect(await runnerMain([], t.value)).toBe(0);
    expect(t.calls[0]!.prompt).not.toContain("sig");
  });

  it("uses the SDK's own query when none is given", async () => {
    sdkQuery.mockReturnValueOnce(messages(success("from the sdk")));
    const t = io({ query: undefined });
    delete (t.value as Partial<RunnerIO>).query;
    expect(await runnerMain([], t.value)).toBe(0);
    expect(t.out).toEqual(["from the sdk"]);
    expect(sdkQuery).toHaveBeenCalledTimes(1);
  });

  it("applies config, profiles and a key file", async () => {
    const config = {
      model: "claude-sonnet-5",
      effort: "low",
      tools: ["Read", "Bash"],
      cwd: "/repo",
      maxTurns: 5,
      maxBudgetUsd: 0.5,
      keyFile: "/key",
      systemPrompt: "Be brief.",
      claudeCodePath: "/usr/local/bin/claude",
      profiles: { b: { model: "claude-opus-5-5", effort: "high" }, c: { keyFile: "/missing" } },
    };
    const t = io({ config, request: { ...req, profile: "b" }, env: {} });
    expect(await runnerMain(["--config", "/cfg.json"], t.value)).toBe(0);
    const o = t.calls[0]!.options;
    expect(o).toMatchObject({ model: "claude-opus-5-5", effort: "high", tools: ["Read", "Bash"], cwd: "/repo", maxTurns: 5, maxBudgetUsd: 0.5, pathToClaudeCodeExecutable: "/usr/local/bin/claude" });
    expect(o["env"]).toEqual({ ANTHROPIC_API_KEY: KEY, CLAUDE_AGENT_SDK_CLIENT_APP: "worldinmotion-agent" });
    expect(o["systemPrompt"]).toEqual({ type: "preset", preset: "claude_code", append: `${RUNNER_PREAMBLE}\n\nBe brief.` });
    const u = io({ config, request: { ...req, profile: "c" } });
    expect(await runnerMain(["--config", "/cfg.json"], u.value)).toBe(1);
    expect(u.err).toEqual(["wim-agent-runner: key file not read: ENOENT"]);
  });

  it("refuses a profile it does not know and an empty task (exit 3)", async () => {
    const t = io({ request: { ...req, profile: "zz" } });
    expect(await runnerMain([], t.value)).toBe(RUNNER_EXIT.refused);
    expect(t.err).toEqual(["wim-agent-runner: job m1: profile not configured"]);
    const e = io({ request: { ...req, text: "  " } });
    expect(await runnerMain([], e.value)).toBe(RUNNER_EXIT.refused);
    expect(t.calls).toEqual([]);
  });

  it.each([
    ["not json", "bad request"],
    [JSON.stringify({ ...req, v: 1 }), "bad request: not a version 2 request"],
    [JSON.stringify({ ...req, extra: 1 }), "bad request"],
  ])("fails on a bad request %#", async (request, message) => {
    const t = io({ request });
    expect(await runnerMain([], t.value)).toBe(1);
    expect(t.err[0]).toContain(message);
  });

  it("reads a request of exactly RUNNER_MAX_REQUEST_BYTES and refuses one byte more", async () => {
    const base = Buffer.byteLength(JSON.stringify({ ...req, text: "" }));
    const at = JSON.stringify({ ...req, text: "x".repeat(RUNNER_MAX_REQUEST_BYTES - base) });
    expect(Buffer.byteLength(at)).toBe(RUNNER_MAX_REQUEST_BYTES);
    const ok = io({ request: at });
    expect(await runnerMain([], ok.value)).toBe(0);
    const over = io({ request: `${at} ` });
    expect(await runnerMain([], over.value)).toBe(1);
    expect(over.err).toEqual([`wim-agent-runner: request over ${RUNNER_MAX_REQUEST_BYTES} bytes`]);
  });

  it("fails on a request over the cap in several chunks", async () => {
    const t = io({ stdin: messages("x".repeat(RUNNER_MAX_REQUEST_BYTES), "y") as AsyncIterable<string> });
    expect(await runnerMain([], t.value)).toBe(1);
    expect(t.err).toEqual([`wim-agent-runner: request over ${RUNNER_MAX_REQUEST_BYTES} bytes`]);
  });

  it("fails on a bad or unreadable config", async () => {
    const t = io({ config: { tools: "everything" } });
    expect(await runnerMain(["--config", "/cfg.json"], t.value)).toBe(1);
    expect(t.err[0]).toMatch(/^wim-agent-runner: invalid config: tools: /);
    const u = io();
    expect(await runnerMain(["--config", "/nope.json"], u.value)).toBe(1);
    expect(u.err[0]).toBe("wim-agent-runner: config not read: ENOENT /nope.json");
  });

  it("fails without a key", async () => {
    const t = io({ env: {} });
    expect(await runnerMain([], t.value)).toBe(1);
    expect(t.err).toEqual(["wim-agent-runner: no API key (set ANTHROPIC_API_KEY or keyFile)"]);
  });

  it("fails on an error result, a missing result or a thrown error, naming no detail", async () => {
    const bad = io({ query: () => messages({ type: "result", subtype: "error_max_budget_usd", is_error: true, num_turns: 9, total_cost_usd: 1 }) });
    expect(await runnerMain([], bad.value)).toBe(1);
    const flagged = io({ query: () => messages({ ...success("x"), is_error: true }) });
    expect(await runnerMain([], flagged.value)).toBe(1);
    expect(flagged.out).toEqual([]);
    const none = io({ query: () => messages({ type: "assistant" }) });
    expect(await runnerMain([], none.value)).toBe(1);
    expect(none.err).toEqual(["wim-agent-runner: job m1 ended without a result"]);
    const thrown = io({
      query: () =>
        (async function* () {
          throw new TypeError(`api said ${KEY}`);
        })(),
    });
    expect(await runnerMain([], thrown.value)).toBe(1);
    expect(thrown.err).toEqual(["wim-agent-runner: job m1 failed: TypeError"]);
  });

  it("an empty result prints nothing and succeeds", async () => {
    const t = io({ query: () => messages({ type: "result", subtype: "success" }) });
    expect(await runnerMain([], t.value)).toBe(0);
    expect(t.out).toEqual([""]);
  });

  it("exits 5 when stopped by its signal, whether the SDK throws or just ends", async () => {
    for (const ends of [true, false]) {
      const ac = new AbortController();
      const t = io({
        signal: ac.signal,
        query: ({ options }) =>
          (async function* () {
            ac.abort();
            expect((options["abortController"] as AbortController).signal.aborted).toBe(true);
            if (!ends) throw new Error("aborted");
          })(),
      });
      expect(await runnerMain([], t.value)).toBe(RUNNER_EXIT.timeout);
    }
  });
});

describe("files", () => {
  it("reads the config and key from disk by default", async () => {
    const dir = await scratchDir();
    await writeFile(join(dir, "c.json"), JSON.stringify({ keyFile: join(dir, "key") }));
    await writeFile(join(dir, "key"), KEY);
    const t = io({ env: {} });
    delete (t.value as Partial<RunnerIO>).readFile;
    expect(await runnerMain(["--config", join(dir, "c.json")], t.value)).toBe(0);
    expect(t.calls[0]!.options["env"]).toMatchObject({ ANTHROPIC_API_KEY: KEY });
  });

  it("names no detail of a key file error without a code", async () => {
    const t = io({ config: { keyFile: "/key" }, readFile: async (p) => (p === "/cfg.json" ? JSON.stringify({ keyFile: "/key" }) : Promise.reject(new Error(`no ${KEY}`))) });
    expect(await runnerMain(["--config", "/cfg.json"], t.value)).toBe(1);
    expect(t.err).toEqual(["wim-agent-runner: key file not read: error"]);
  });
});

describe("helpers", () => {
  it("toolOptions", () => {
    expect(toolOptions("read-only")).toEqual({ tools: ["Read", "Grep", "Glob"], allowedTools: ["Read", "Grep", "Glob"] });
    expect(toolOptions("none")).toEqual({ tools: [], allowedTools: [] });
    expect(toolOptions(["Read"])).toEqual({ tools: ["Read"], allowedTools: ["Read"] });
  });

  it("sdkOptions uses the preamble alone without a systemPrompt", () => {
    const o = sdkOptions({ model: "m", effort: "medium", tools: "none", maxTurns: 1, systemPrompt: " ", profiles: {} }, {}, KEY, { env: {}, cwd: "/" }, new AbortController());
    expect(o["systemPrompt"]).toEqual({ type: "preset", preset: "claude_code", append: RUNNER_PREAMBLE });
  });
});
