import {
  ApiError,
  GoogleGenAI,
  ThinkingLevel,
  type GenerateContentResponse,
  type GoogleGenAIOptions,
  type HttpOptions,
  type ThinkingConfig,
} from "@google/genai";
import { refused, refusedStatus, type ChatModel, type ChatRequest, type ChatResponse } from "./model.ts";

export type ThinkingLevelName = "minimal" | "low" | "medium" | "high";

/**
 * Either a named level (Gemini 3.x) or a token budget, never both. An empty object sends no
 * thinking setting at all, which leaves the model's own default in force.
 */
export interface VertexThinking {
  level?: ThinkingLevelName;
  budgetTokens?: number;
}

export interface VertexOptions {
  model: string;
  /**
   * Both are required and never read from gcloud defaults or the environment: a bot that bills
   * whatever project happens to be configured on the machine is a billing surprise.
   */
  project: string;
  location: string;
  /** Defaults to the lowest level, so a short reply is not spent on thinking. */
  thinking?: VertexThinking;
  /** The stream is aborted when no chunk arrives for this long (default 30 s). */
  idleTimeoutMs?: number;
  /** Overrides for tests or unusual setups; normal use leaves both unset (ADC). */
  httpOptions?: HttpOptions;
  googleAuthOptions?: GoogleGenAIOptions["googleAuthOptions"];
}

const LEVELS: Record<ThinkingLevelName, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/**
 * Gemini on Vertex AI through `@google/genai` in Vertex mode, authenticated by ADC. It streams:
 * a unary call shows nothing until the whole answer is ready, and was seen to sit with no
 * response headers until the caller gave up, while a stream shows progress chunk by chunk and
 * lets a stalled call be told apart from a slow one.
 */
export class VertexGeminiModel implements ChatModel {
  readonly id: string;
  private readonly model: string;
  private readonly ai: GoogleGenAI;
  private readonly thinkingConfig: ThinkingConfig | undefined;
  private readonly thinkingBudget: number;
  private readonly idleTimeoutMs: number;

  constructor(options: VertexOptions) {
    if (options.project.trim() === "" || options.location.trim() === "") {
      throw new Error("vertex: project and location are required");
    }
    const thinking = options.thinking ?? { level: "low" };
    if (thinking.level !== undefined && thinking.budgetTokens !== undefined) {
      throw new Error("vertex: set thinking.level or thinking.budgetTokens, not both");
    }
    this.model = options.model;
    this.id = `vertex:${options.model}`;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
    this.thinkingBudget = thinking.budgetTokens ?? 0;
    if (thinking.level !== undefined) {
      this.thinkingConfig = { thinkingLevel: LEVELS[thinking.level] };
    } else if (thinking.budgetTokens !== undefined) {
      this.thinkingConfig = { thinkingBudget: thinking.budgetTokens };
    }
    this.ai = new GoogleGenAI({
      vertexai: true,
      project: options.project,
      location: options.location,
      httpOptions: options.httpOptions,
      googleAuthOptions: options.googleAuthOptions,
    });
  }

  /**
   * Gemini counts thinking inside `maxOutputTokens`. With a token budget the cap is raised by
   * that budget so `maxTokens` stays the visible reply's allowance; a named level has no
   * numeric bound, so there the cap covers thinking and reply together.
   */
  outputLimit(maxTokens: number): number {
    return maxTokens + this.thinkingBudget;
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const stall = new AbortController();
    const signal =
      request.signal === undefined ? stall.signal : AbortSignal.any([stall.signal, request.signal]);
    // Each wait (for the stream to open, then for each chunk) gets a fresh idle timer.
    const step = <T>(p: Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          stall.abort();
          reject(new Error(`vertex: no data for ${this.idleTimeoutMs / 1000} s`));
        }, this.idleTimeoutMs);
        p.then(
          (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          (e: unknown) => {
            clearTimeout(timer);
            reject(e);
          },
        );
      });

    const opened = step(
      this.ai.models.generateContentStream({
        model: this.model,
        contents: request.messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.text }],
        })),
        config: {
          systemInstruction: request.system,
          maxOutputTokens: this.outputLimit(request.maxTokens),
          thinkingConfig: this.thinkingConfig,
          abortSignal: signal,
        },
      }),
    );
    // Only an error status on opening is known to come before billing. Once the stream is
    // open, a stall, a reset or an error chunk may follow billed work, so it is passed on as is.
    const stream = await opened.catch((err: unknown) => {
      throw err instanceof ApiError && refusedStatus(err.status) ? refused("vertex", err) : err;
    });

    let text = "";
    let usage: GenerateContentResponse["usageMetadata"];
    let stopReason = "unknown";
    for (;;) {
      const next = await step(stream.next());
      if (next.done === true) break;
      const chunk = next.value;
      // `text` skips thought parts, so only the visible reply accumulates.
      text += chunk.text ?? "";
      // Each chunk's usage is the running total, so the last one seen is the call's usage.
      usage = chunk.usageMetadata ?? usage;
      stopReason = chunk.candidates?.[0]?.finishReason ?? stopReason;
    }

    if (usage?.promptTokenCount === undefined) {
      throw new Error("vertex: stream ended with no token usage");
    }
    // Thinking tokens are billed as output, so they count against the cap like reply tokens.
    const outputTokens = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
    return { text, usage: { inputTokens: usage.promptTokenCount, outputTokens }, stopReason };
  }
}
