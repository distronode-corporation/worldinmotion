import { z } from "zod";
import {
  ModelRefusedError,
  refused,
  refusedStatus,
  type ChatModel,
  type ChatRequest,
  type ChatResponse,
} from "./model.ts";

export interface OllamaOptions {
  model: string;
  /** Usually `http://127.0.0.1:11434`; Ollama should stay bound to the bot's own machine. */
  baseUrl: string;
  /**
   * Ollama's `think`, sent only when set; left unset, the model's own default applies, which
   * is the one value that suits every model (a model without thinking support only takes
   * `false`). qwen3 wants `true`: with `false` it still reasons, but inline in the reply.
   */
  think?: boolean;
}

// Only the fields the bot uses. A fully cached prompt can omit `prompt_eval_count`.
// `message.thinking` (the model's reasoning when `think` is on) is never read or passed on.
const ChatReply = z.object({
  message: z.object({ content: z.string() }),
  done_reason: z.string().default("unknown"),
  prompt_eval_count: z.number().int().nonnegative().default(0),
  eval_count: z.number().int().nonnegative().default(0),
});

const THINK_END = "</think>";

/**
 * Some models (qwen3 with `think: false`) put their reasoning inline, closed by `</think>`,
 * before the answer. Only the text after the last closing tag is the reply; if nothing is
 * left, the reply is empty and the bot treats it like any other empty reply.
 */
export function visibleReply(content: string): string {
  const end = content.lastIndexOf(THINK_END);
  return end < 0 ? content : content.slice(end + THINK_END.length).trim();
}

/** A local Ollama server through its plain HTTP chat endpoint; no SDK needed. */
export class OllamaModel implements ChatModel {
  readonly id: string;
  private readonly model: string;
  private readonly url: string;
  private readonly think: boolean | undefined;

  constructor(options: OllamaOptions) {
    this.model = options.model;
    this.id = `ollama:${options.model}`;
    // A loop, not `/\/+$/`: that regex backtracks quadratically on a long run of slashes.
    let base = options.baseUrl;
    while (base.endsWith("/")) base = base.slice(0, -1);
    this.url = `${base}/api/chat`;
    this.think = options.think;
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: request.system },
        ...request.messages.map((m) => ({ role: m.role, content: m.text })),
      ],
      stream: false,
      ...(this.think === undefined ? {} : { think: this.think }),
      // num_predict bounds the reply, which on a CPU is what bounds the reply time.
      options: { num_predict: request.maxTokens },
    };
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (err) {
      // Nothing listening: the request never reached a model. Any other failure (a reset, an
      // abort) may come after the model started, so it is passed on as is.
      throw connectionRefused(err) ? refused("ollama", err) : err;
    }
    // A reset while the body is read rejects here, after the model ran.
    const raw = await res.text();
    if (!res.ok) {
      // Ollama answers 400 and 404 (no such model) before running anything; a 500 may not be.
      const reason = `ollama: HTTP ${res.status}: ${raw.slice(0, 200)}`;
      throw refusedStatus(res.status) ? new ModelRefusedError(reason) : new Error(reason);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error("ollama: response is not JSON");
    }
    const parsed = ChatReply.safeParse(json);
    if (!parsed.success) {
      throw new Error("ollama: response is not a chat reply");
    }
    return {
      text: visibleReply(parsed.data.message.content),
      usage: { inputTokens: parsed.data.prompt_eval_count, outputTokens: parsed.data.eval_count },
      stopReason: parsed.data.done_reason,
    };
  }
}

function connectionRefused(err: unknown): err is Error {
  return (err as { cause?: { code?: unknown } }).cause?.code === "ECONNREFUSED";
}
