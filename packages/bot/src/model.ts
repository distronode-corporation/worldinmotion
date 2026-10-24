// The one interface every model adapter implements. The bot never sees provider types: it hands
// over a system prompt and an alternating user/assistant transcript, and gets text plus the
// provider's own token counts back, which the budget then charges.

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ChatRequest {
  system: string;
  messages: ChatTurn[];
  maxTokens: number;
  signal?: AbortSignal;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResponse {
  text: string;
  usage: ChatUsage;
  stopReason: string;
}

export interface ChatModel {
  /** Provider and model, such as `bedrock:us.anthropic.claude-haiku-5-5`; also the price-table key. */
  readonly id: string;
  complete(request: ChatRequest): Promise<ChatResponse>;
  /**
   * The output cap the provider is really sent for a given `maxTokens`, when an adapter raises
   * it (room for a thinking budget). The budget reserves this, not `maxTokens`.
   */
  outputLimit?(maxTokens: number): number;
}

/**
 * The provider turned the call away before any model ran, so nothing was billed: a credential,
 * permission, throttling or request-shape error. It is the one failure the budget charges
 * nothing for. Every other failure (a stall, a reset part way through, a body that is not the
 * documented shape, an error the adapter cannot place) may have been billed, so the budget
 * charges the reserved estimate.
 */
export class ModelRefusedError extends Error {
  override readonly name = "ModelRefusedError";
}

/**
 * HTTP statuses a provider returns before running the model: bad request, unauthenticated,
 * forbidden, not found, too many requests. 408 (model timeout) and 424 (model error) are not
 * here, because the model ran.
 */
const REFUSED_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 429]);

export function refusedStatus(status: number): boolean {
  return REFUSED_STATUSES.has(status);
}

/** Wraps a provider error the adapter knows came before billing, keeping its name in the text. */
export function refused(provider: string, err: Error): ModelRefusedError {
  return new ModelRefusedError(`${provider}: ${err.name}: ${err.message}`, { cause: err });
}

export type Provider = "bedrock" | "vertex" | "ollama";

export interface ModelSpec {
  provider: Provider;
  model: string;
}

const PROVIDERS: readonly string[] = ["bedrock", "vertex", "ollama"];

/**
 * Splits `provider:model` at the first colon only, because model ids carry their own colons
 * (`qwen3:4b`, `...-v1:0`).
 */
export function parseModelSpec(spec: string): ModelSpec {
  const at = spec.indexOf(":");
  const provider = at < 0 ? "" : spec.slice(0, at);
  const model = at < 0 ? "" : spec.slice(at + 1);
  if (!PROVIDERS.includes(provider) || model.trim() === "") {
    throw new Error(`model must be bedrock:<id>, vertex:<id> or ollama:<id>, got "${spec}"`);
  }
  return { provider: provider as Provider, model };
}
