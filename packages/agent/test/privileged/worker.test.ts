import { describe, expect, it, vi } from "vitest";
import { loadSdkQuery, sdkOptions, workerMain, type Query, type WorkerIO } from "../../src/privileged/worker.ts";

const JOB = { model: "claude-opus-5-5", effort: "medium", maxTurns: 20, tools: ["Read", "Grep", "Glob"], cwd: "/w", additionalDirectories: ["/in"] };

function io(over: Partial<WorkerIO> & { messages?: Array<Record<string, unknown>>; throws?: Error } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const seen: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const query: Query = (args) => {
    seen.push(args);
    return (async function* () {
      for (const m of over.messages ?? []) yield m;
      if (over.throws !== undefined) throw over.throws;
    })();
  };
  const w: WorkerIO = {
    env: { WIM_AGENT_JOB: JSON.stringify(JOB), HOME: "/h", PATH: "/bin", ANTHROPIC_IDENTITY_TOKEN_FILE: "/run/t", AWS_ACCESS_KEY_ID: "never" },
    uid: 990,
    readStdin: async () => "the prompt",
    out: (t) => out.push(t),
    err: (l) => err.push(l),
    loadQuery: async () => query,
    ...over,
  };
  return { w, out, err, seen };
}

describe("workerMain", () => {
  it("runs one query with read-only, no-prompt options and prints the result", async () => {
    const { w, out, err, seen } = io({ messages: [{ type: "assistant" }, { type: "result", result: "the answer", total_cost_usd: 0.01, num_turns: 3, is_error: false }] });
    expect(await workerMain(w)).toBe(0);
    expect(out).toEqual(["the answer"]);
    expect(err).toEqual(["worker: cost_usd 0.01 turns 3"]);
    const o = seen[0]!.options;
    expect(seen[0]!.prompt).toBe("the prompt");
    expect(o).toMatchObject({ model: "claude-opus-5-5", effort: "medium", maxTurns: 20, tools: JOB.tools, allowedTools: JOB.tools, permissionMode: "dontAsk", cwd: "/w", additionalDirectories: ["/in"], settingSources: [], persistSession: false });
    // Only the listed variables reach the SDK's child: no cloud credentials.
    expect(o["env"]).toEqual({ HOME: "/h", PATH: "/bin", ANTHROPIC_IDENTITY_TOKEN_FILE: "/run/t" });
  });

  it("prints the subtype of an error result and fails", async () => {
    const { w, out } = io({ messages: [{ type: "result", subtype: "error_max_turns", is_error: true }] });
    expect(await workerMain(w)).toBe(1);
    expect(out).toEqual(["error_max_turns"]);
  });

  it("fails with the error's name only when the SDK throws", async () => {
    const { w, err } = io({ throws: new RangeError("quotes the prompt") });
    expect(await workerMain(w)).toBe(1);
    expect(err).toEqual(["worker: error RangeError"]);
  });

  it("refuses to run as root", async () => {
    const { w, err } = io({ uid: 0 });
    expect(await workerMain(w)).toBe(2);
    expect(err[0]).toMatch(/as root/);
  });

  it.each([[undefined], ["{"], [JSON.stringify({ ...JOB, extra: 1 })]])("refuses a missing or malformed WIM_AGENT_JOB (%s)", async (job) => {
    const { w } = io();
    w.env = { WIM_AGENT_JOB: job };
    expect(await workerMain(w)).toBe(2);
  });
});

describe("sdkOptions", () => {
  it("passes the abort controller through", () => {
    const a = new AbortController();
    expect(sdkOptions(JOB as never, {}, a)["abortController"]).toBe(a);
  });
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: () => "the sdk query" }));

describe("loadSdkQuery", () => {
  it("loads query from the SDK on demand", async () => {
    expect((await loadSdkQuery())({ prompt: "", options: {} })).toBe("the sdk query");
  });
});
