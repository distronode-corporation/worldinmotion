import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BotIO, BotItem, SendOptions } from "../src/bot.ts";
import { loadConfig } from "../src/config.ts";
import * as index from "../src/index.ts";
import type { ChatModel } from "../src/model.ts";
import { runBot } from "../src/run.ts";
import { scratchDir } from "./helpers.ts";

function io() {
  const sent: Array<{ to: string; text: string; opts?: SendOptions }> = [];
  let cb: ((item: BotItem) => void) | undefined;
  const value: BotIO & { fail: boolean } = {
    fail: false,
    onItem: (c) => {
      cb = c;
    },
    send: async (to, text, opts) => {
      if (value.fail) throw new Error("relay down");
      sent.push({ to, text, opts });
    },
  };
  return { value, sent, deliver: (item: BotItem) => cb?.(item) };
}

const model: ChatModel = {
  id: "ollama:fake",
  complete: async () => ({ text: "hi back", usage: { inputTokens: 2, outputTokens: 3 }, stopReason: "stop" }),
};

describe("runBot", () => {
  it("wires a config to the IO and answers", async () => {
    const dir = await scratchDir();
    const config = loadConfig({
      model: "ollama:fake",
      budget: { ledgerPath: join(dir, "ledger.json"), dailyTokens: 10_000, maxTokens: 50 },
      systemPrompt: "Be kind.",
    });
    const conn = io();
    const bot = await runBot(config, conn.value, { model, now: () => Date.UTC(2026, 9, 24), log: () => undefined });
    expect(bot.systemPrompt).toContain("Be kind.");
    conn.deliver({ kind: "msg", from: "a@x", fromKind: "claude-code", id: "1", text: "hello" });
    await bot.idle();
    expect(conn.sent).toEqual([{ to: "a@x", text: "hi back", opts: { reply_to: "1", kind: "msg" } }]);
  });

  it("builds the model from the config and logs to stderr by default", async () => {
    const dir = await scratchDir();
    const config = loadConfig({
      // Nothing listens on port 1, so the model call fails fast without leaving the machine.
      model: "ollama:none",
      ollama: { baseUrl: "http://127.0.0.1:1" },
      budget: { ledgerPath: join(dir, "ledger.json"), dailyTokens: 10_000 },
    });
    const conn = io();
    conn.value.fail = true;
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const bot = await runBot(config, conn.value);
      await bot.handle({ kind: "msg", from: "a@x", fromKind: "claude-code", id: "1", text: "hello" });
      expect(write).toHaveBeenCalledWith("bot: Error: relay down\n");
    } finally {
      write.mockRestore();
    }
  });

  it("refuses to start with a USD cap and no price for the model", async () => {
    const dir = await scratchDir();
    const config = loadConfig({
      model: "ollama:fake",
      budget: { ledgerPath: join(dir, "ledger.json"), dailyUsd: 1 },
    });
    await expect(runBot(config, io().value, { model })).rejects.toThrow(/no price for ollama:fake/);
  });

  it("exports the public surface", () => {
    for (const name of ["Bot", "runBot", "loadConfig", "createModel", "Budget", "Conversations", "Guards", "Gate", "parseModelSpec", "BedrockConverseModel", "VertexGeminiModel", "OllamaModel", "ModelRefusedError", "MODEL_FAILED", "SAFETY_PREAMBLE"]) {
      expect(index).toHaveProperty(name);
    }
  });
});
