import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Bot, BUDGET_EXHAUSTED, MODEL_FAILED, SAFETY_PREAMBLE, type BotIO, type BotItem, type SendOptions } from "../src/bot.ts";
import { Budget } from "../src/budget.ts";
import { Conversations } from "../src/conversations.ts";
import { Gate, Guards, MAX_TEXT_BYTES } from "../src/guards.ts";
import { ModelRefusedError, type ChatModel, type ChatRequest, type ChatResponse } from "../src/model.ts";
import { VertexGeminiModel, type VertexOptions } from "../src/vertex.ts";
import { clock, scratchDir } from "./helpers.ts";

interface Sent {
  to: string;
  text: string;
  opts: SendOptions | undefined;
}

class FakeIO implements BotIO {
  sent: Sent[] = [];
  cb: ((item: BotItem) => void) | undefined;
  fail = false;
  onItem(cb: (item: BotItem) => void): void {
    this.cb = cb;
  }
  async send(to: string, text: string, opts?: SendOptions): Promise<void> {
    if (this.fail) throw new Error("relay down");
    this.sent.push({ to, text, opts });
  }
}

type Behaviour = (req: ChatRequest) => Promise<ChatResponse>;

class FakeModel implements ChatModel {
  readonly id = "bedrock:fake";
  calls: ChatRequest[] = [];
  behaviour: Behaviour = async (req) => ({
    text: `echo ${req.messages.length}`,
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "end_turn",
  });
  complete(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(structuredClone({ ...req, signal: undefined }));
    return this.behaviour(req);
  }
}

async function setup(over: {
  dailyTokens?: number;
  maxConcurrent?: number;
  maxQueue?: number;
  systemPrompt?: string;
  replyToBots?: boolean;
  callTimeoutMs?: number;
  model?: ChatModel;
} = {}) {
  const c = clock();
  const io = new FakeIO();
  const fake = new FakeModel();
  const model = over.model ?? fake;
  const logs: string[] = [];
  const dir = await scratchDir();
  const budget = await Budget.open({
    path: join(dir, "ledger.json"),
    modelId: model.id,
    dailyTokens: over.dailyTokens ?? 1_000_000,
    prices: {},
    now: c.now,
  });
  const bot = new Bot({
    io,
    model,
    budget,
    conversations: new Conversations({ maxTurns: 20, maxChars: 24_000, idleMs: 86_400_000, now: c.now }),
    guards: new Guards({ replyToBots: over.replyToBots ?? false, perPeerPerHour: 30, now: c.now }),
    gate: new Gate(over.maxConcurrent ?? 2, over.maxQueue ?? 100),
    systemPrompt: over.systemPrompt ?? "Speak like a pirate.",
    maxTokens: 100,
    callTimeoutMs: over.callTimeoutMs ?? 60_000,
    now: c.now,
    log: (l) => logs.push(l),
  });
  bot.start();
  return { bot, io, model: fake, budget, logs, c };
}

let seq = 0;
function msg(text: string, over: Partial<BotItem> = {}): BotItem {
  seq++;
  return { kind: "msg", from: "a@x", fromKind: "claude-code", id: `id${seq}`, text, ...over };
}

describe("Bot", () => {
  it("prefixes the safety preamble to the configured prompt, or uses it alone", async () => {
    expect((await setup()).bot.systemPrompt).toBe(`${SAFETY_PREAMBLE}\n\nSpeak like a pirate.`);
    expect((await setup({ systemPrompt: "  " })).bot.systemPrompt).toBe(SAFETY_PREAMBLE);
    for (const phrase of ["AI peer", "not from a person", "no tools", "system prompt", "concisely"]) {
      expect(SAFETY_PREAMBLE).toContain(phrase);
    }
  });

  it("answers a msg with a threaded msg and keeps the conversation", async () => {
    const { bot, io, model, budget } = await setup();
    io.cb?.(msg("hello", { id: "m1" }));
    await bot.idle();
    io.cb?.(msg("again", { id: "m2" }));
    await bot.idle();
    expect(io.sent).toEqual([
      { to: "a@x", text: "echo 1", opts: { reply_to: "m1", kind: "msg" } },
      { to: "a@x", text: "echo 3", opts: { reply_to: "m2", kind: "msg" } },
    ]);
    expect(model.calls[1]).toEqual({
      system: bot.systemPrompt,
      messages: [
        { role: "user", text: "message from a@x:\nhello" },
        { role: "assistant", text: "echo 1" },
        { role: "user", text: "message from a@x:\nagain" },
      ],
      maxTokens: 100,
      signal: undefined,
    });
    expect(budget.today()).toMatchObject({ inputTokens: 20, outputTokens: 10 });
  });

  it("answers a task with a done result in its own thread", async () => {
    const { bot, io, model } = await setup();
    await bot.handle(msg("first", { kind: "task", id: "t1" }));
    await bot.handle(msg("second", { kind: "task", id: "t2" }));
    expect(io.sent).toEqual([
      { to: "a@x", text: "echo 1", opts: { reply_to: "t1", kind: "result", status: "done" } },
      { to: "a@x", text: "echo 1", opts: { reply_to: "t2", kind: "result", status: "done" } },
    ]);
    expect(model.calls[0]?.messages[0]?.text).toBe("task from a@x:\nfirst");
  });

  it("sends a placeholder for an empty model reply", async () => {
    const { bot, io, model } = await setup();
    model.behaviour = async () => ({ text: "", usage: { inputTokens: 1, outputTokens: 0 }, stopReason: "end_turn" });
    await bot.handle(msg("hi"));
    expect(io.sent[0]?.text).toBe("(empty reply)");
  });

  it("records results as context without replying, and ignores files and notices", async () => {
    const { bot, io, model } = await setup();
    await bot.handle(msg("build passed", { kind: "result", from: "ci@x" }));
    await bot.handle(msg("a file", { kind: "file", from: "ci@x" }));
    await bot.handle(msg("joined", { kind: "notice", from: "ci@x" }));
    expect(io.sent).toEqual([]);
    expect(model.calls).toEqual([]);
    await bot.handle(msg("what happened?", { from: "ci@x" }));
    expect(model.calls[0]?.messages).toEqual([
      { role: "user", text: "result from ci@x: build passed\n\nmessage from ci@x:\nwhat happened?" },
    ]);
  });

  it("does not answer bots unless configured", async () => {
    const off = await setup();
    await off.bot.handle(msg("hi", { fromKind: "bot" }));
    expect(off.io.sent).toEqual([]);
    const on = await setup({ replyToBots: true });
    await on.bot.handle(msg("hi", { fromKind: "bot" }));
    expect(on.io.sent).toHaveLength(1);
  });

  it("ignores duplicates silently and declines over-long texts", async () => {
    const { bot, io } = await setup();
    await bot.handle(msg("same", { id: "d1" }));
    await bot.handle(msg("same", { id: "d2" }));
    await bot.handle(msg("x".repeat(MAX_TEXT_BYTES + 1), { id: "long" }));
    await bot.handle(msg("y".repeat(MAX_TEXT_BYTES + 1), { id: "longtask", kind: "task" }));
    expect(io.sent).toEqual([
      { to: "a@x", text: "echo 1", opts: { reply_to: "d1", kind: "msg" } },
      { to: "a@x", text: `declined: text is over ${MAX_TEXT_BYTES} bytes`, opts: { reply_to: "long", kind: "msg" } },
      {
        to: "a@x",
        text: `declined: text is over ${MAX_TEXT_BYTES} bytes`,
        opts: { reply_to: "longtask", kind: "result", status: "declined" },
      },
    ]);
  });

  it("says budget exhausted once per sender per day, then stays silent", async () => {
    const { bot, io, model, budget, c } = await setup({ dailyTokens: 200 });
    // The estimate includes maxTokens (100) and the system prompt, so the first call fits.
    await bot.handle(msg("one"));
    await budget.record({ inputTokens: 150, outputTokens: 0 });
    await bot.handle(msg("two"));
    await bot.handle(msg("three"));
    await bot.handle(msg("four", { from: "b@x", kind: "task", id: "tb" }));
    await bot.handle(msg("five", { from: "b@x" }));
    expect(model.calls).toHaveLength(1);
    expect(io.sent.slice(1)).toEqual([
      { to: "a@x", text: BUDGET_EXHAUSTED, opts: { reply_to: expect.any(String), kind: "msg" } },
      { to: "b@x", text: BUDGET_EXHAUSTED, opts: { reply_to: "tb", kind: "result", status: "declined" } },
    ]);
    c.advance(86_400_000);
    await bot.handle(msg("next day"));
    expect(model.calls).toHaveLength(2);
    // The first exchange is still in the thread; only the refused messages were never kept.
    expect(io.sent.at(-1)?.text).toBe("echo 3");
  });

  it("reports a refused call as a failed result or a short msg, charging nothing", async () => {
    const { bot, io, model, budget, logs } = await setup();
    const err = new ModelRefusedError("bedrock: ThrottlingException: Too many requests");
    model.behaviour = async () => {
      throw err;
    };
    await bot.handle(msg("hi", { kind: "task", id: "t" }));
    await bot.handle(msg("hi again", { id: "m" }));
    expect(io.sent).toEqual([
      { to: "a@x", text: MODEL_FAILED, opts: { reply_to: "t", kind: "result", status: "failed" } },
      { to: "a@x", text: MODEL_FAILED, opts: { reply_to: "m", kind: "msg" } },
    ]);
    expect(logs.at(-1)).toMatch(/ ModelRefusedError: bedrock: ThrottlingException: Too many requests$/);
    expect(budget.today()).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    // A failed exchange is not kept, so the next call starts the thread afresh.
    model.behaviour = new FakeModel().behaviour;
    await bot.handle(msg("third"));
    expect(model.calls.at(-1)?.messages).toHaveLength(1);
  });

  it("charges the reserved estimate when the provider answered with an unusable body", async () => {
    const { bot, io, model, budget } = await setup();
    model.behaviour = async () => {
      throw new Error("bedrock: response has no token usage");
    };
    await bot.handle(msg("hi"));
    expect(io.sent[0]?.text).toBe(MODEL_FAILED);
    const used = budget.today();
    expect(used.outputTokens).toBe(100);
    expect(used.inputTokens).toBeGreaterThan(0);
  });

  it("charges the reserved estimate for a failure not known to come before billing", async () => {
    const { bot, io, model, budget } = await setup();
    // A connection reset part way through the response: the provider may have billed it.
    model.behaviour = async () => {
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    };
    await bot.handle(msg("hi"));
    const used = budget.today();
    expect(used.outputTokens).toBe(100);
    expect(used.inputTokens).toBeGreaterThan(0);
  });

  it("charges a stalled Vertex stream, so the daily cap still trips", async () => {
    vi.useFakeTimers();
    try {
      const first = new TextEncoder().encode(
        `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }] })}\n\n`,
      );
      const stalled = async () =>
        new Response(new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(first) }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      const vertex = new VertexGeminiModel({
        model: "gemini-3.8-flash",
        project: "example-project",
        location: "us-central1",
        idleTimeoutMs: 1000,
        httpOptions: { fetch: stalled as typeof fetch },
        googleAuthOptions: {
          authClient: { getRequestHeaders: async () => new Headers({ authorization: "Bearer t" }) },
        } as unknown as VertexOptions["googleAuthOptions"],
      });
      const { bot, io, budget } = await setup({ model: vertex, dailyTokens: 400 });
      for (const id of ["S1", "S2", "S3", "S4"]) {
        const done = bot.handle(msg("hi", { id, from: `${id}@x` }));
        await vi.advanceTimersByTimeAsync(1000);
        await done;
      }
      // Each stalled call holds and keeps its estimate, so the cap stops the bot calling.
      expect(budget.today().outputTokens).toBeGreaterThan(0);
      expect(io.sent.map((s) => s.text)).toContain(BUDGET_EXHAUSTED);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the peer a fixed text and keeps the provider's detail in the local log", async () => {
    const { bot, io, model, logs } = await setup();
    const arn = "arn:aws:sts::123456789012:assumed-role/wim-bot/session";
    model.behaviour = async () => {
      throw Object.assign(new Error(`User: ${arn} is not authorized to perform: bedrock:InvokeModel`), {
        name: "AccessDeniedException",
      });
    };
    await bot.handle(msg("hi", { kind: "task", id: "t" }));
    expect(io.sent).toEqual([{ to: "a@x", text: MODEL_FAILED, opts: { reply_to: "t", kind: "result", status: "failed" } }]);
    expect(logs.at(-1)).toContain(`AccessDeniedException: User: ${arn}`);
  });

  it("logs a non-Error rejection, truncating long reasons", async () => {
    const { bot, io, model, logs } = await setup();
    model.behaviour = () => Promise.reject("x".repeat(500));
    await bot.handle(msg("hi"));
    expect(io.sent[0]?.text).toBe(MODEL_FAILED);
    expect(logs.at(-1)).toMatch(new RegExp(` ms=0 ${"x".repeat(200)}$`));
  });

  it("times out a task whose deadline has already passed without calling the model", async () => {
    const { bot, io, model, c } = await setup();
    await bot.handle(msg("late", { kind: "task", id: "t", deadline: c.now() }));
    expect(model.calls).toEqual([]);
    expect(io.sent).toEqual([
      { to: "a@x", text: "deadline passed before the task started", opts: { reply_to: "t", kind: "result", status: "timeout" } },
    ]);
  });

  it("aborts the model call at the deadline and answers timeout", async () => {
    vi.useFakeTimers();
    try {
      const { bot, io, model, c } = await setup();
      let seen: AbortSignal | undefined;
      model.behaviour = (req) =>
        new Promise((_, reject) => {
          seen = req.signal;
          req.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      const done = bot.handle(msg("slow", { kind: "task", id: "t", deadline: c.now() + 5000 }));
      await vi.advanceTimersByTimeAsync(4999);
      expect(seen?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(io.sent).toEqual([
        {
          to: "a@x",
          text: "deadline passed before the model answered",
          opts: { reply_to: "t", kind: "result", status: "timeout" },
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers a task that finishes before its deadline and clears the timer", async () => {
    vi.useFakeTimers();
    try {
      const { bot, io, c } = await setup();
      await bot.handle(msg("quick", { kind: "task", id: "t", deadline: c.now() + 5000 }));
      expect(io.sent[0]?.opts?.status).toBe("done");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs at most maxConcurrent model calls and queues the rest", async () => {
    const { bot, io, model } = await setup({ maxConcurrent: 1, maxQueue: 1 });
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    model.behaviour = (req) =>
      new Promise((resolve) => {
        active++;
        peak = Math.max(peak, active);
        releases.push(() => {
          active--;
          resolve({ text: req.messages.at(-1)!.text, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" });
        });
      });
    io.cb?.(msg("1", { from: "p1@x" }));
    io.cb?.(msg("2", { from: "p2@x" }));
    io.cb?.(msg("3", { from: "p3@x" }));
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases[0]?.();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]?.();
    await bot.idle();
    expect(peak).toBe(1);
    expect(io.sent.map((s) => s.to)).toEqual(["p1@x", "p2@x"]);
  });

  it("logs and drops an item when the queue is full", async () => {
    const { bot, io, model, logs } = await setup({ maxConcurrent: 1, maxQueue: 0 });
    let release: (() => void) | undefined;
    model.behaviour = () =>
      new Promise((resolve) => {
        release = () => resolve({ text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" });
      });
    const first = bot.handle(msg("1", { from: "p1@x" }));
    await bot.handle(msg("2", { from: "p2@x", id: "dropped" }));
    expect(logs).toContain("bot: queue full, dropped msg dropped from p2@x");
    await vi.waitFor(() => expect(release).toBeDefined());
    release?.();
    await first;
    expect(io.sent).toHaveLength(1);
  });

  it("logs a failed send instead of rejecting, and frees the slot", async () => {
    const { bot, io, logs } = await setup({ maxConcurrent: 1 });
    io.fail = true;
    await expect(bot.handle(msg("hi"))).resolves.toBeUndefined();
    expect(logs.at(-1)).toBe("bot: Error: relay down");
    io.fail = false;
    await bot.handle(msg("hi again"));
    expect(io.sent).toHaveLength(1);
  });

  it("logs each model call's start, end and usage", async () => {
    const { bot, logs } = await setup();
    await bot.handle(msg("hi", { id: "L1" }));
    expect(logs).toEqual([
      expect.stringMatching(/^bot: model call start bedrock:fake msg L1 from a@x est_in=\d+ max_out=100$/),
      "bot: model call done bedrock:fake msg L1 from a@x ms=0 in=10 out=5 stop=end_turn",
    ]);
  });

  it("logs a model error with its reason", async () => {
    const { bot, logs, model } = await setup();
    model.behaviour = () => Promise.reject(new Error("boom"));
    await bot.handle(msg("hi", { id: "E1" }));
    expect(logs.at(-1)).toBe("bot: model call failed bedrock:fake msg E1 from a@x ms=0 Error: boom");
  });

  it("logs why an item got no answer", async () => {
    const { bot, logs } = await setup({ dailyTokens: 1 });
    await bot.handle(msg("n", { kind: "notice", id: "N" }));
    await bot.handle(msg("b", { fromKind: "bot", id: "B" }));
    await bot.handle(msg("x", { id: "X" }));
    await bot.handle(msg("t", { kind: "task", id: "T", deadline: 0 }));
    expect(logs).toEqual([
      "bot: ignoring notice N from a@x",
      "bot: not answering msg B from a@x: bot",
      "bot: budget exhausted, not answering msg X from a@x",
      "bot: task T from a@x arrived past its deadline",
    ]);
  });

  it("answers a msg with a failed reply when a call never settles, and charges the estimate", async () => {
    vi.useFakeTimers();
    try {
      const { bot, io, model, budget, logs } = await setup({ callTimeoutMs: 60_000 });
      // A call that ignores its abort signal entirely, as a stuck connection would.
      model.behaviour = () => new Promise(() => undefined);
      const done = bot.handle(msg("hello?", { id: "H" }));
      await vi.advanceTimersByTimeAsync(59_999);
      expect(io.sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(io.sent).toEqual([
        { to: "a@x", text: "model call timed out after 60 s", opts: { reply_to: "H", kind: "msg" } },
      ]);
      expect(logs.at(-1)).toBe("bot: model call failed bedrock:fake msg H from a@x ms=0 Error: model call timed out");
      expect(budget.today().outputTokens).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a task a failed result when the call timeout comes before its deadline", async () => {
    vi.useFakeTimers();
    try {
      const { bot, io, model, c } = await setup({ callTimeoutMs: 1000 });
      model.behaviour = (req) =>
        new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      const done = bot.handle(msg("slow", { kind: "task", id: "T", deadline: c.now() + 5000 }));
      await vi.advanceTimersByTimeAsync(1000);
      await done;
      expect(io.sent).toEqual([
        { to: "a@x", text: "model call timed out after 1 s", opts: { reply_to: "T", kind: "result", status: "failed" } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reserves the adapter's raised output cap when it has one", async () => {
    const { bot, model, budget, logs } = await setup();
    Object.assign(model, { outputLimit: (n: number) => n + 64 });
    model.behaviour = async () => {
      throw new Error("bad body");
    };
    await bot.handle(msg("hi", { id: "O" }));
    expect(logs[0]).toMatch(/max_out=164$/);
    // A malformed answer is charged the reservation, which here includes the thinking room.
    expect(budget.today().outputTokens).toBe(164);
  });
});
