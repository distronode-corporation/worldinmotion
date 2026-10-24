import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { BedrockConverseModel } from "../src/bedrock.ts";
import { ModelRefusedError } from "../src/model.ts";

interface Captured {
  method: string;
  hostname: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

// A recorded Converse response, shaped as in the Bedrock API reference.
const CONVERSE_OK = {
  output: {
    message: {
      role: "assistant",
      content: [{ text: "Hello from " }, { reasoningContent: { reasoningText: { text: "hm" } } }, { text: "Bedrock." }],
    },
  },
  stopReason: "end_turn",
  usage: { inputTokens: 31, outputTokens: 7, totalTokens: 38 },
  metrics: { latencyMs: 412 },
};

/**
 * A request handler in the SDK's HttpHandler shape: the real client builds, serializes and
 * signs the request, and this returns a canned HTTP response instead of opening a socket.
 */
function handler(status: number, body: unknown, headers: Record<string, string> = {}) {
  const captured: Captured[] = [];
  return {
    captured,
    requestHandler: {
      handle: async (req: {
        method: string;
        hostname: string;
        path: string;
        headers: Record<string, string>;
        body: string;
      }) => {
        captured.push({
          method: req.method,
          hostname: req.hostname,
          path: req.path,
          headers: req.headers,
          body: JSON.parse(req.body),
        });
        return {
          response: {
            statusCode: status,
            headers: { "content-type": "application/json", ...headers },
            body: Readable.from([Buffer.from(JSON.stringify(body))]),
          },
        };
      },
      updateHttpClientConfig: () => undefined,
      httpHandlerConfigs: () => ({}),
    },
  };
}

function model(h: ReturnType<typeof handler>) {
  return new BedrockConverseModel({
    modelId: "us.anthropic.claude-haiku-5-5",
    region: "us-east-1",
    clientConfig: {
      credentials: { accessKeyId: "AKIDTEST", secretAccessKey: "test-secret" },
      requestHandler: h.requestHandler,
      maxAttempts: 1,
    },
  });
}

const REQUEST = {
  system: "be brief",
  messages: [
    { role: "user" as const, text: "hi" },
    { role: "assistant" as const, text: "hello" },
    { role: "user" as const, text: "how are you" },
  ],
  maxTokens: 256,
};

describe("BedrockConverseModel", () => {
  it("sends a signed Converse request and maps text, usage and stop reason", async () => {
    const h = handler(200, CONVERSE_OK);
    const m = model(h);
    expect(m.id).toBe("bedrock:us.anthropic.claude-haiku-5-5");
    const res = await m.complete(REQUEST);
    expect(res).toEqual({
      text: "Hello from Bedrock.",
      usage: { inputTokens: 31, outputTokens: 7 },
      stopReason: "end_turn",
    });
    const req = h.captured[0] as Captured;
    expect(req.method).toBe("POST");
    expect(req.hostname).toBe("bedrock-runtime.us-east-1.amazonaws.com");
    expect(req.path).toBe(`/model/${encodeURIComponent("us.anthropic.claude-haiku-5-5")}/converse`);
    expect(req.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\//);
    expect(req.body).toEqual({
      system: [{ text: "be brief" }],
      messages: [
        { role: "user", content: [{ text: "hi" }] },
        { role: "assistant", content: [{ text: "hello" }] },
        { role: "user", content: [{ text: "how are you" }] },
      ],
      inferenceConfig: { maxTokens: 256 },
    });
  });

  it("returns empty text and an unknown stop reason when the output is missing", async () => {
    const res = await model(handler(200, { usage: { inputTokens: 1, outputTokens: 0 } })).complete(
      REQUEST,
    );
    expect(res).toEqual({ text: "", usage: { inputTokens: 1, outputTokens: 0 }, stopReason: "unknown" });
  });

  it("returns empty text when the message has no content", async () => {
    const res = await model(
      handler(200, { output: { message: { role: "assistant" } }, usage: { inputTokens: 1, outputTokens: 0 } }),
    ).complete(REQUEST);
    expect(res.text).toBe("");
  });

  it("treats a response with no usage as malformed", async () => {
    const err = await model(handler(200, { output: CONVERSE_OK.output })).complete(REQUEST).catch((e: unknown) => e);
    expect(err).toEqual(new Error("bedrock: response has no token usage"));
    expect(err).not.toBeInstanceOf(ModelRefusedError);
  });

  it("treats a usage block without output tokens as malformed", async () => {
    const err = await model(
      handler(200, { output: CONVERSE_OK.output, usage: { inputTokens: 3 } }),
    ).complete(REQUEST).catch((e: unknown) => e);
    expect(err).toEqual(new Error("bedrock: response has no token usage"));
    expect(err).not.toBeInstanceOf(ModelRefusedError);
  });

  it("marks a ThrottlingException or AccessDeniedException as refused before billing", async () => {
    const cases = [
      [429, "ThrottlingException", "Too many requests, please wait before trying again."],
      [403, "AccessDeniedException", "User: arn:aws:sts::123456789012:assumed-role/r/s is not authorized"],
    ] as const;
    for (const [status, type, message] of cases) {
      const h = handler(status, { message }, { "x-amzn-errortype": `${type}:http://internal.amazon.com/coral/com.amazon.bedrock/` });
      const err = (await model(h).complete(REQUEST).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(ModelRefusedError);
      expect(err.message).toBe(`bedrock: ${type}: ${message}`);
      expect((err.cause as { $metadata: { httpStatusCode: number } }).$metadata.httpStatusCode).toBe(status);
      expect(h.captured).toHaveLength(1);
    }
  });

  it("passes on a model-side error (ModelErrorException, 424), which may be billed", async () => {
    const h = handler(424, { message: "The model failed." }, { "x-amzn-errortype": "ModelErrorException:" });
    const err = (await model(h).complete(REQUEST).catch((e: unknown) => e)) as Error;
    expect(err.name).toBe("ModelErrorException");
    expect(err).not.toBeInstanceOf(ModelRefusedError);
  });

  it("passes on a reset part way through, which carries no status", async () => {
    const h = handler(200, CONVERSE_OK);
    h.requestHandler.handle = async () => {
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    };
    const err = (await model(h).complete(REQUEST).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("socket hang up");
    expect(err).not.toBeInstanceOf(ModelRefusedError);
  });

  it("marks missing credentials as refused: nothing was sent", async () => {
    const h = handler(200, CONVERSE_OK);
    const m = new BedrockConverseModel({
      modelId: "us.anthropic.claude-haiku-5-5",
      region: "us-east-1",
      clientConfig: {
        credentials: async () => {
          throw Object.assign(new Error("Could not load credentials from any providers"), { name: "CredentialsProviderError" });
        },
        requestHandler: h.requestHandler,
        maxAttempts: 1,
      },
    });
    const err = await m.complete(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelRefusedError);
    expect(h.captured).toHaveLength(0);
  });
});
