import { describe, expect, it } from "vitest";
import { ModelRefusedError } from "../src/model.ts";
import { VertexGeminiModel, type VertexOptions } from "../src/vertex.ts";

interface Captured {
  url: string;
  authorization: string | null;
  body: { generationConfig?: Record<string, unknown> } & Record<string, unknown>;
}

// Recorded streamGenerateContent chunks, shaped like the SDK's GenerateContentResponse: text
// arrives over several chunks, and the last one carries the finish reason and the usage totals.
const CHUNKS = [
  { candidates: [{ content: { role: "model", parts: [{ text: "Hello from " }] } }] },
  {
    candidates: [{ content: { role: "model", parts: [{ text: "Gemini." }] } }],
    usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 3 },
  },
  {
    candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 40,
      candidatesTokenCount: 9,
      thoughtsTokenCount: 5,
      totalTokenCount: 54,
      trafficType: "ON_DEMAND",
    },
    modelVersion: "gemini-3.8-flash",
  },
];

const sse = (chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");

type Reply =
  | { status: number; body: string }
  | { stream: ReadableStream<Uint8Array> }
  | { never: true };

/**
 * The SDK accepts a custom fetch, so the real client builds the request and this answers it.
 * Auth goes through an injected auth client, so no credential lookup happens on the test box.
 */
function setup(reply: Reply, overrides: Partial<VertexOptions> = {}) {
  const captured: Captured[] = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    captured.push({
      url: req.url,
      authorization: req.headers.get("authorization"),
      body: JSON.parse(await req.text()) as Captured["body"],
    });
    // Like the real fetch, refuse to start once the signal (caller's and stall timer's) is aborted.
    if (init?.signal?.aborted === true) throw init.signal.reason;
    if ("never" in reply) return new Promise<Response>(() => undefined);
    if ("stream" in reply) {
      return new Response(reply.stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(reply.body, {
      status: reply.status,
      headers: { "content-type": reply.status === 200 ? "text/event-stream" : "application/json" },
    });
  };
  const authClient = {
    getRequestHeaders: async () => new Headers({ authorization: "Bearer test-token" }),
  };
  const model = new VertexGeminiModel({
    model: "gemini-3.8-flash",
    project: "example-project",
    location: "us-central1",
    httpOptions: { fetch: fakeFetch as typeof fetch },
    googleAuthOptions: { authClient } as unknown as VertexOptions["googleAuthOptions"],
    ...overrides,
  });
  return { model, captured };
}

const ok = (chunks: unknown[] = CHUNKS): Reply => ({ status: 200, body: sse(chunks) });

const REQUEST = {
  system: "be brief",
  messages: [
    { role: "user" as const, text: "hi" },
    { role: "assistant" as const, text: "hello" },
    { role: "user" as const, text: "and now?" },
  ],
  maxTokens: 128,
};

describe("VertexGeminiModel", () => {
  it("streams from the project, location and model path, joining text and taking the last usage", async () => {
    const { model, captured } = setup(ok());
    expect(model.id).toBe("vertex:gemini-3.8-flash");
    const res = await model.complete({ ...REQUEST, signal: new AbortController().signal });
    expect(res).toEqual({
      text: "Hello from Gemini.",
      usage: { inputTokens: 40, outputTokens: 14 },
      stopReason: "STOP",
    });
    const req = captured[0] as Captured;
    const url = new URL(req.url);
    expect(url.hostname).toBe("us-central1-aiplatform.googleapis.com");
    expect(url.pathname).toMatch(
      /\/projects\/example-project\/locations\/us-central1\/publishers\/google\/models\/gemini-3\.8-flash:streamGenerateContent$/,
    );
    expect(url.searchParams.get("alt")).toBe("sse");
    expect(req.authorization).toBe("Bearer test-token");
    expect(req.body).toMatchObject({
      contents: [
        { role: "user", parts: [{ text: "hi" }] },
        { role: "model", parts: [{ text: "hello" }] },
        { role: "user", parts: [{ text: "and now?" }] },
      ],
      systemInstruction: { parts: [{ text: "be brief" }] },
    });
    // The default is the lowest level gemini-3.8-flash accepts.
    expect(req.body.generationConfig).toEqual({
      maxOutputTokens: 128,
      thinkingConfig: { thinkingLevel: "LOW" },
    });
    expect(model.outputLimit(128)).toBe(128);
  });

  it("with a thinking budget, raises the output cap so maxTokens stays the visible allowance", async () => {
    const { model, captured } = setup(ok(), { thinking: { budgetTokens: 64 } });
    await model.complete(REQUEST);
    expect(captured[0]?.body.generationConfig).toEqual({
      maxOutputTokens: 192,
      thinkingConfig: { thinkingBudget: 64 },
    });
    expect(model.outputLimit(128)).toBe(192);
  });

  it("sends a named level, or no thinking setting for an empty object", async () => {
    const high = setup(ok(), { thinking: { level: "high" } });
    await high.model.complete(REQUEST);
    expect(high.captured[0]?.body.generationConfig).toEqual({
      maxOutputTokens: 128,
      thinkingConfig: { thinkingLevel: "HIGH" },
    });
    const none = setup(ok(), { thinking: {} });
    await none.model.complete(REQUEST);
    expect(none.captured[0]?.body.generationConfig).toEqual({ maxOutputTokens: 128 });
  });

  it("refuses both a level and a budget, and an empty project or location", () => {
    expect(() => setup(ok(), { thinking: { level: "low", budgetTokens: 1 } })).toThrow(
      "vertex: set thinking.level or thinking.budgetTokens, not both",
    );
    expect(() => setup(ok(), { project: " " })).toThrow(/project and location are required/);
    expect(() => setup(ok(), { location: "" })).toThrow(/project and location are required/);
  });

  it("keeps the earlier stop reason and usage across chunks that lack them", async () => {
    const { model } = setup(
      ok([
        {
          candidates: [{ content: { role: "model", parts: [{ text: "a" }] }, finishReason: "MAX_TOKENS" }],
          usageMetadata: { promptTokenCount: 3 },
        },
        { candidates: [{ content: { role: "model", parts: [{ text: "b" }] } }] },
      ]),
    );
    expect(await model.complete(REQUEST)).toEqual({
      text: "ab",
      usage: { inputTokens: 3, outputTokens: 0 },
      stopReason: "MAX_TOKENS",
    });
  });

  it("reports an unknown stop reason when no chunk carries one", async () => {
    const { model } = setup(
      ok([{ candidates: [], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 } }]),
    );
    const res = await model.complete({ ...REQUEST, signal: undefined });
    expect(res).toEqual({ text: "", usage: { inputTokens: 2, outputTokens: 1 }, stopReason: "unknown" });
  });

  it("treats a stream with no usage as malformed", async () => {
    const { model } = setup(
      ok([{ candidates: [{ content: { role: "model", parts: [{ text: "x" }] }, finishReason: "STOP" }] }]),
    );
    const err = await model.complete(REQUEST).catch((e: unknown) => e);
    expect(err).toEqual(new Error("vertex: stream ended with no token usage"));
    expect(err).not.toBeInstanceOf(ModelRefusedError);
  });

  it("marks a refusal on opening (throttled, denied) as refused before billing", async () => {
    for (const [code, status] of [[429, "RESOURCE_EXHAUSTED"], [403, "PERMISSION_DENIED"]] as const) {
      const { model } = setup({ status: code, body: JSON.stringify({ error: { code, message: "No.", status } }) });
      const err = await model.complete(REQUEST).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ModelRefusedError);
      expect((err as Error).message).toMatch(new RegExp(`^vertex: ApiError: .*${status}`));
    }
  });

  it("passes on a server error on opening, which may follow billed work", async () => {
    const { model } = setup({ status: 500, body: JSON.stringify({ error: { code: 500, message: "Internal.", status: "INTERNAL" } }) });
    const err = await model.complete(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ModelRefusedError);
    expect((err as Error).message).toMatch(/Internal/);
  });

  it("aborts when the stream never opens", async () => {
    const { model } = setup({ never: true }, { idleTimeoutMs: 30 });
    await expect(model.complete(REQUEST)).rejects.toThrow("vertex: no data for 0.03 s");
  });

  it("aborts when a stream stops sending chunks", async () => {
    const first = new TextEncoder().encode(sse([CHUNKS[0]]));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first);
        // Then nothing more, and never closed: a stalled connection.
      },
    });
    const { model } = setup({ stream }, { idleTimeoutMs: 30 });
    const err = await model.complete(REQUEST).catch((e: unknown) => e);
    expect(err).toEqual(new Error("vertex: no data for 0.03 s"));
    // The prompt went out and work may have been billed, so the budget must charge it.
    expect(err).not.toBeInstanceOf(ModelRefusedError);
  });

  it("stops when the caller aborts", async () => {
    const { model } = setup(ok());
    const caller = new AbortController();
    caller.abort();
    await expect(model.complete({ ...REQUEST, signal: caller.signal })).rejects.toThrow(/abort/i);
  });
});
