import {
  BedrockRuntimeClient,
  ConverseCommand,
  type BedrockRuntimeClientConfig,
} from "@aws-sdk/client-bedrock-runtime";
import { refused, refusedStatus, type ChatModel, type ChatRequest, type ChatResponse } from "./model.ts";

export interface BedrockOptions {
  /** A model id or an inference profile id (newer models are served only through a profile). */
  modelId: string;
  region: string;
  /**
   * Extra client settings. Left empty in normal use so the SDK's default credential chain
   * (environment, SSO, shared profile, instance role) applies; tests pass a request handler.
   */
  clientConfig?: Omit<BedrockRuntimeClientConfig, "region">;
}

/** Amazon Bedrock through the model-neutral Converse API. */
export class BedrockConverseModel implements ChatModel {
  readonly id: string;
  private readonly modelId: string;
  private readonly client: BedrockRuntimeClient;

  constructor(options: BedrockOptions) {
    this.modelId = options.modelId;
    this.id = `bedrock:${options.modelId}`;
    this.client = new BedrockRuntimeClient({ ...options.clientConfig, region: options.region });
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const command = new ConverseCommand({
      modelId: this.modelId,
      system: [{ text: request.system }],
      messages: request.messages.map((m) => ({ role: m.role, content: [{ text: m.text }] })),
      inferenceConfig: { maxTokens: request.maxTokens },
    });
    let out;
    try {
      out = await this.client.send(command, { abortSignal: request.signal });
    } catch (err) {
      throw beforeBilling(err) ? refused("bedrock", err) : err;
    }
    const usage = out.usage;
    if (usage?.inputTokens === undefined || usage.outputTokens === undefined) {
      throw new Error("bedrock: response has no token usage");
    }
    // Non-text blocks (reasoning, citations) carry no `text`; only the text is a reply.
    const blocks = out.output?.message?.content ?? [];
    const text = blocks.map((b) => b.text ?? "").join("");
    return {
      text,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      stopReason: out.stopReason ?? "unknown",
    };
  }
}

type SdkError = Error & { $metadata?: { httpStatusCode?: number } };

/**
 * No credentials found (the request was never signed or sent), or a status Bedrock returns
 * before the model runs: AccessDenied, Throttling, Validation, ResourceNotFound and the like.
 */
function beforeBilling(err: unknown): err is SdkError {
  const e = err as SdkError;
  return e.name === "CredentialsProviderError" || refusedStatus(e.$metadata?.httpStatusCode ?? 0);
}
