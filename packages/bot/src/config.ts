import { z } from "zod";
import { BedrockConverseModel } from "./bedrock.ts";
import { parseModelSpec, type ChatModel } from "./model.ts";
import { OllamaModel } from "./ollama.ts";
import { VertexGeminiModel } from "./vertex.ts";

const positiveInt = z.number().int().positive();

const Price = z.strictObject({
  inputPerMillion: z.number().nonnegative(),
  outputPerMillion: z.number().nonnegative(),
});

const ConfigSchema = z
  .strictObject({
    /** `bedrock:<id>`, `vertex:<id>` or `ollama:<id>`. */
    model: z.string(),
    /** Added after the fixed safety preamble, never instead of it. */
    systemPrompt: z.string().default(""),
    /** Longest one model call may take; the sender then gets a failed answer, not silence. */
    callTimeoutSeconds: z.number().positive().default(60),
    bedrock: z.strictObject({ region: z.string().min(1) }).optional(),
    vertex: z
      .strictObject({
        project: z.string().min(1),
        location: z.string().min(1),
        /**
         * A named level or a token budget. The default is the lowest level gemini-3.8-flash
         * accepts ("minimal" is refused with 400 INVALID_ARGUMENT); `{}` sends no setting.
         */
        thinking: z
          .strictObject({
            level: z.enum(["minimal", "low", "medium", "high"]).optional(),
            budgetTokens: z.number().int().nonnegative().optional(),
          })
          .refine((t) => t.level === undefined || t.budgetTokens === undefined, {
            message: "set thinking.level or thinking.budgetTokens, not both",
          })
          .default({ level: "low" }),
        idleTimeoutSeconds: z.number().positive().default(30),
      })
      .optional(),
    ollama: z
      .strictObject({
        baseUrl: z.url().default("http://127.0.0.1:11434"),
        /**
         * Ollama's `think`. Unset (the default) leaves the model's own default, which works for
         * models without thinking support too. Set `true` for qwen3, which otherwise reasons
         * inline; the adapter strips inline reasoning either way.
         */
        think: z.boolean().optional(),
      })
      .optional(),
    budget: z.strictObject({
      ledgerPath: z.string().min(1),
      maxTokens: positiveInt.default(1024),
      dailyTokens: positiveInt.optional(),
      dailyUsd: z.number().positive().optional(),
      prices: z.record(z.string(), Price).default({}),
    }),
    conversations: z
      .strictObject({
        maxTurns: positiveInt.default(20),
        maxChars: positiveInt.default(24_000),
        idleHours: z.number().positive().default(24),
      })
      .default({ maxTurns: 20, maxChars: 24_000, idleHours: 24 }),
    guards: z
      .strictObject({
        replyToBots: z.boolean().default(false),
        perPeerPerHour: positiveInt.default(30),
        maxConcurrent: positiveInt.default(2),
        maxQueue: positiveInt.default(100),
      })
      .default({ replyToBots: false, perPeerPerHour: 30, maxConcurrent: 2, maxQueue: 100 }),
  })
  .superRefine((c, ctx) => {
    let provider: string;
    try {
      provider = parseModelSpec(c.model).provider;
    } catch (err) {
      ctx.addIssue({ code: "custom", path: ["model"], message: (err as Error).message });
      return;
    }
    if (provider === "bedrock" && c.bedrock === undefined) {
      ctx.addIssue({ code: "custom", path: ["bedrock"], message: "bedrock.region is required" });
    }
    if (provider === "vertex" && c.vertex === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["vertex"],
        message: "vertex.project and vertex.location are required",
      });
    }
    // A bot with no daily cap at all is exactly what the caps exist to prevent.
    if (c.budget.dailyTokens === undefined && c.budget.dailyUsd === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["budget"],
        message: "set budget.dailyTokens, budget.dailyUsd, or both",
      });
    }
  });

export type BotConfig = z.infer<typeof ConfigSchema>;

/** Validates a config given as JSON text or as an already parsed value. */
export function loadConfig(json: unknown): BotConfig {
  const value = typeof json === "string" ? (JSON.parse(json) as unknown) : json;
  const parsed = ConfigSchema.safeParse(value);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`invalid bot config:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

/** Builds the adapter the config names. The config has already been validated. */
export function createModel(config: BotConfig): ChatModel {
  const spec = parseModelSpec(config.model);
  if (spec.provider === "bedrock") {
    return new BedrockConverseModel({
      modelId: spec.model,
      region: (config.bedrock as { region: string }).region,
    });
  }
  if (spec.provider === "vertex") {
    const v = config.vertex as NonNullable<BotConfig["vertex"]>;
    return new VertexGeminiModel({
      model: spec.model,
      project: v.project,
      location: v.location,
      thinking: v.thinking,
      idleTimeoutMs: v.idleTimeoutSeconds * 1000,
    });
  }
  const o = config.ollama ?? { baseUrl: "http://127.0.0.1:11434" };
  return new OllamaModel({ model: spec.model, baseUrl: o.baseUrl, think: o.think });
}
