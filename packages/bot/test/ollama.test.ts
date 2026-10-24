import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRefusedError } from "../src/model.ts";
import { OllamaModel, visibleReply } from "../src/ollama.ts";

// A recorded non-streaming /api/chat response, shaped as in Ollama's docs/api.md.
const CHAT_OK = {
  model: "qwen3:4b",
  created_at: "2026-10-24T00:00:00.000000Z",
  message: { role: "assistant", content: "Hello from Ollama." },
  done: true,
  done_reason: "stop",
  total_duration: 2_100_000_000,
  load_duration: 50_000_000,
  prompt_eval_count: 26,
  prompt_eval_duration: 300_000_000,
  eval_count: 6,
  eval_duration: 1_700_000_000,
};

interface Seen {
  method: string;
  url: string;
  body: unknown;
}

let server: Server | undefined;

afterEach(async () => {
  // Tests that start no server have nothing to close.
  const s = server;
  server = undefined;
  if (s !== undefined) await new Promise((r) => s.close(r));
});

async function serve(status: number, body: string): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", body: JSON.parse(raw) });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, seen };
}

const REQUEST = {
  system: "be brief",
  messages: [{ role: "user" as const, text: "hi" }],
  maxTokens: 64,
};

describe("OllamaModel", () => {
  it("posts a non-streaming chat with the system turn first and maps the counts", async () => {
    const { base, seen } = await serve(200, JSON.stringify(CHAT_OK));
    const model = new OllamaModel({ model: "qwen3:4b", baseUrl: `${base}//`, think: false });
    expect(model.id).toBe("ollama:qwen3:4b");
    const res = await model.complete(REQUEST);
    expect(res).toEqual({
      text: "Hello from Ollama.",
      usage: { inputTokens: 26, outputTokens: 6 },
      stopReason: "stop",
    });
    expect(seen[0]).toEqual({
      method: "POST",
      url: "/api/chat",
      body: {
        model: "qwen3:4b",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hi" },
        ],
        stream: false,
        think: false,
        options: { num_predict: 64 },
      },
    });
  });

  it("omits think when not configured and defaults missing counts and reason", async () => {
    const { base, seen } = await serve(200, JSON.stringify({ message: { content: "ok" } }));
    const res = await new OllamaModel({ model: "llama3.2:3b", baseUrl: base }).complete(REQUEST);
    expect(res).toEqual({ text: "ok", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "unknown" });
    expect(seen[0]?.body).not.toHaveProperty("think");
  });

  it("marks a 404 (no such model) as refused before billing, with the start of the body", async () => {
    const { base } = await serve(404, JSON.stringify({ error: "model 'nope' not found" }));
    const err = await new OllamaModel({ model: "nope", baseUrl: base }).complete(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelRefusedError);
    expect((err as Error).message).toBe(`ollama: HTTP 404: {"error":"model 'nope' not found"}`);
  });

  it("passes on a 500, which may come after the model ran", async () => {
    const { base } = await serve(500, JSON.stringify({ error: "llama runner process has terminated" }));
    const err = await new OllamaModel({ model: "m", baseUrl: base }).complete(REQUEST).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ModelRefusedError);
    expect((err as Error).message).toBe(`ollama: HTTP 500: {"error":"llama runner process has terminated"}`);
  });

  it("marks a connection refused as refused before billing: nothing was listening", async () => {
    const { base } = await serve(200, "{}");
    await new Promise((r) => server?.close(r));
    server = undefined;
    const err = await new OllamaModel({ model: "m", baseUrl: base }).complete(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelRefusedError);
    expect((err as Error).message).toBe("ollama: TypeError: fetch failed");
  });

  it("passes on a connection reset part way through, which may be billed", async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
        res.write('{"message":');
        setTimeout(() => res.socket?.destroy(), 10);
      });
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const err = await new OllamaModel({ model: "m", baseUrl: `http://127.0.0.1:${port}` })
      .complete(REQUEST)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ModelRefusedError);
  });

  it("passes on a reset before any response header, which may be billed", async () => {
    server = createServer((req) => {
      req.resume();
      req.on("end", () => req.socket.destroy());
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const err = await new OllamaModel({ model: "m", baseUrl: `http://127.0.0.1:${port}` })
      .complete(REQUEST)
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe("fetch failed");
    expect(err).not.toBeInstanceOf(ModelRefusedError);
  });

  it("passes on the caller's abort", async () => {
    const { base } = await serve(200, JSON.stringify(CHAT_OK));
    const caller = new AbortController();
    caller.abort();
    const err = await new OllamaModel({ model: "m", baseUrl: base })
      .complete({ ...REQUEST, signal: caller.signal })
      .catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
    expect(err).not.toBeInstanceOf(ModelRefusedError);
  });

  it("treats a body that is not JSON as malformed", async () => {
    const { base } = await serve(200, "<html>proxy error</html>");
    await expect(new OllamaModel({ model: "m", baseUrl: base }).complete(REQUEST)).rejects.toThrow(
      new Error("ollama: response is not JSON"),
    );
  });

  it("treats JSON that is not a chat reply as malformed", async () => {
    const { base } = await serve(200, JSON.stringify({ done: true }));
    await expect(new OllamaModel({ model: "m", baseUrl: base }).complete(REQUEST)).rejects.toThrow(
      new Error("ollama: response is not a chat reply"),
    );
  });

  it("keeps only the answer after leaked inline reasoning, with usage unchanged", async () => {
    // Recorded shape from qwen3:4b with think:false: the reasoning is in content.
    const leaked = {
      ...CHAT_OK,
      model: "qwen3:4b",
      message: {
        role: "assistant",
        content: "<think>\nThe user asks for the capital of Canada. That is Ottawa.\n</think>\n\nThe capital of Canada is Ottawa.",
      },
      prompt_eval_count: 31,
      eval_count: 48,
    };
    const { base } = await serve(200, JSON.stringify(leaked));
    const res = await new OllamaModel({ model: "qwen3:4b", baseUrl: base, think: false }).complete(REQUEST);
    expect(res).toEqual({
      text: "The capital of Canada is Ottawa.",
      usage: { inputTokens: 31, outputTokens: 48 },
      stopReason: "stop",
    });
  });

  it("returns the clean content and never the separate thinking field", async () => {
    // Recorded shape from qwen3:4b with think:true: the reasoning is in message.thinking.
    const clean = {
      ...CHAT_OK,
      model: "qwen3:4b",
      message: {
        role: "assistant",
        content: "The capital of Canada is Ottawa.",
        thinking: "The user asks for the capital of Canada. That is Ottawa.",
      },
      prompt_eval_count: 31,
      eval_count: 48,
    };
    const { base, seen } = await serve(200, JSON.stringify(clean));
    const res = await new OllamaModel({ model: "qwen3:4b", baseUrl: base, think: true }).complete(REQUEST);
    expect(res).toEqual({
      text: "The capital of Canada is Ottawa.",
      usage: { inputTokens: 31, outputTokens: 48 },
      stopReason: "stop",
    });
    expect(seen[0]?.body).toMatchObject({ think: true });
  });

  it("gives an empty reply when nothing follows the last closing tag", async () => {
    const { base } = await serve(
      200,
      JSON.stringify({ ...CHAT_OK, message: { role: "assistant", content: "<think>a</think> x </think>\n " } }),
    );
    const res = await new OllamaModel({ model: "qwen3:4b", baseUrl: base }).complete(REQUEST);
    expect(res.text).toBe("");
  });
});

describe("visibleReply", () => {
  it("keeps the text after the last closing tag, trimmed, and leaves other text alone", () => {
    expect(visibleReply("a</think>b</think>  c \n")).toBe("c");
    expect(visibleReply("  plain reply  ")).toBe("  plain reply  ");
    expect(visibleReply("</think>")).toBe("");
  });
});
