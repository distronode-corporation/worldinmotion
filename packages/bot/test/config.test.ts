import { describe, expect, it } from "vitest";
import { BedrockConverseModel } from "../src/bedrock.ts";
import { createModel, loadConfig } from "../src/config.ts";
import { parseModelSpec } from "../src/model.ts";
import { OllamaModel } from "../src/ollama.ts";
import { VertexGeminiModel } from "../src/vertex.ts";

const budget = { ledgerPath: "/var/lib/wim/ledger.json", dailyTokens: 100_000 };

describe("parseModelSpec", () => {
  it("splits at the first colon only", () => {
    expect(parseModelSpec("ollama:qwen3:4b")).toEqual({ provider: "ollama", model: "qwen3:4b" });
    expect(parseModelSpec("bedrock:amazon.nova-lite-v1:0")).toEqual({
      provider: "bedrock",
      model: "amazon.nova-lite-v1:0",
    });
    expect(parseModelSpec("vertex:gemini-3.8-flash").provider).toBe("vertex");
  });

  it("refuses unknown providers, no colon and an empty model", () => {
    for (const bad of ["openai:gpt", "bedrock", "vertex:", "ollama: ", ""]) {
      expect(() => parseModelSpec(bad)).toThrow(/model must be/);
    }
  });
});

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(JSON.stringify({ model: "ollama:qwen3:4b", budget }));
    expect(c).toEqual({
      model: "ollama:qwen3:4b",
      systemPrompt: "",
      callTimeoutSeconds: 60,
      budget: { ...budget, maxTokens: 1024, prices: {} },
      conversations: { maxTurns: 20, maxChars: 24_000, idleHours: 24 },
      guards: { replyToBots: false, perPeerPerHour: 30, maxConcurrent: 2, maxQueue: 100 },
    });
  });

  it("accepts an already parsed object", () => {
    const c = loadConfig({
      model: "bedrock:us.anthropic.claude-haiku-5-5",
      bedrock: { region: "us-east-1" },
      budget: { ...budget, dailyUsd: 2, prices: { "bedrock:x": { inputPerMillion: 1, outputPerMillion: 5 } } },
      guards: { replyToBots: true },
    });
    expect(c.guards.replyToBots).toBe(true);
    expect(c.budget.dailyUsd).toBe(2);
  });

  it("defaults Vertex to low thinking and a 30 s idle timeout, and refuses a level with a budget", () => {
    const c = loadConfig({ model: "vertex:g", vertex: { project: "p", location: "global" }, budget });
    expect(c.vertex).toEqual({ project: "p", location: "global", thinking: { level: "low" }, idleTimeoutSeconds: 30 });
    expect(() =>
      loadConfig({
        model: "vertex:g",
        vertex: { project: "p", location: "global", thinking: { level: "low", budgetTokens: 8 } },
        budget,
      }),
    ).toThrow("vertex.thinking: set thinking.level or thinking.budgetTokens, not both");
  });

  it("names every problem", () => {
    expect(() => loadConfig({ model: "bedrock:m", budget: { ledgerPath: "x" } })).toThrow(
      "invalid bot config:\nbedrock: bedrock.region is required\nbudget: set budget.dailyTokens, budget.dailyUsd, or both",
    );
    expect(() => loadConfig({ model: "vertex:m", budget })).toThrow(
      "vertex: vertex.project and vertex.location are required",
    );
    expect(() => loadConfig({ model: "nope", budget })).toThrow(/model: model must be/);
    expect(() => loadConfig({ model: "ollama:m", budget, extra: 1 })).toThrow(/\(root\): /);
  });
});

describe("createModel", () => {
  it("builds the adapter the config names", () => {
    const b = createModel(loadConfig({ model: "bedrock:m", bedrock: { region: "eu-central-1" }, budget }));
    expect(b).toBeInstanceOf(BedrockConverseModel);
    expect(b.id).toBe("bedrock:m");
    const v = createModel(
      loadConfig({ model: "vertex:g", vertex: { project: "p", location: "global" }, budget }),
    );
    expect(v).toBeInstanceOf(VertexGeminiModel);
    const budgeted = createModel(
      loadConfig({ model: "vertex:g", vertex: { project: "p", location: "global", thinking: { budgetTokens: 32 } }, budget }),
    ) as VertexGeminiModel;
    expect(budgeted.outputLimit(10)).toBe(42);
    expect(v.id).toBe("vertex:g");
    const o = createModel(
      loadConfig({ model: "ollama:q", ollama: { baseUrl: "http://127.0.0.1:1", think: false }, budget }),
    );
    expect(o).toBeInstanceOf(OllamaModel);
    expect(createModel(loadConfig({ model: "ollama:q", budget })).id).toBe("ollama:q");
  });
});
