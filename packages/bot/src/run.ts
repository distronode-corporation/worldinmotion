import { Bot, type BotIO } from "./bot.ts";
import { Budget } from "./budget.ts";
import { createModel, type BotConfig } from "./config.ts";
import { Conversations } from "./conversations.ts";
import { Gate, Guards } from "./guards.ts";
import type { ChatModel } from "./model.ts";

export interface RunDeps {
  /** Replaces the adapter the config names (tests, or a custom model). */
  model?: ChatModel;
  now?: () => number;
  log?: (line: string) => void;
}

/** Wires a validated config to a mesh connection and starts answering. */
export async function runBot(config: BotConfig, io: BotIO, deps: RunDeps = {}): Promise<Bot> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const model = deps.model ?? createModel(config);
  const budget = await Budget.open({
    path: config.budget.ledgerPath,
    modelId: model.id,
    dailyTokens: config.budget.dailyTokens,
    dailyUsd: config.budget.dailyUsd,
    prices: config.budget.prices,
    now,
  });
  const bot = new Bot({
    io,
    model,
    budget,
    conversations: new Conversations({
      maxTurns: config.conversations.maxTurns,
      maxChars: config.conversations.maxChars,
      idleMs: config.conversations.idleHours * 3_600_000,
      now,
    }),
    guards: new Guards({
      replyToBots: config.guards.replyToBots,
      perPeerPerHour: config.guards.perPeerPerHour,
      now,
    }),
    gate: new Gate(config.guards.maxConcurrent, config.guards.maxQueue),
    systemPrompt: config.systemPrompt,
    maxTokens: config.budget.maxTokens,
    callTimeoutMs: config.callTimeoutSeconds * 1000,
    now,
    log,
  });
  bot.start();
  return bot;
}
