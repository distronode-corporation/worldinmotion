import { describe, expect, it } from "vitest";
import {
  A2AError,
  AgentCardSchema,
  ErrorCode,
  isInterrupted,
  isTerminal,
  RpcResponseSchema,
  SendMessageResponseSchema,
  TASK_STATES,
  textOf,
} from "../src/spec.ts";
import { agentCard } from "./helpers.ts";

describe("task states", () => {
  it("sorts the eight states into terminal, interrupted and active", () => {
    expect(TASK_STATES.filter(isTerminal)).toEqual([
      "TASK_STATE_COMPLETED",
      "TASK_STATE_FAILED",
      "TASK_STATE_CANCELED",
      "TASK_STATE_REJECTED",
    ]);
    expect(TASK_STATES.filter(isInterrupted)).toEqual(["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED"]);
  });
});

describe("textOf", () => {
  it("joins text parts and counts the rest", () => {
    expect(textOf([{ text: "a" }, { url: "https://x" }, { text: "b" }, { data: { k: 1 } }])).toEqual({
      text: "a\n\nb",
      other: 2,
    });
    expect(textOf([])).toEqual({ text: "", other: 0 });
  });
});

describe("schemas", () => {
  it("accepts a card with unknown fields and refuses one missing required fields", () => {
    expect(AgentCardSchema.safeParse(agentCard("https://a/x", { iconUrl: "https://a/i.png" })).success).toBe(true);
    const { skills: _skills, ...noSkills } = agentCard("https://a/x");
    expect(AgentCardSchema.safeParse(noSkills).success).toBe(false);
    expect(AgentCardSchema.safeParse(agentCard("https://a/x", { supportedInterfaces: [] })).success).toBe(false);
  });

  it("takes exactly one of task or message in a SendMessage response", () => {
    const task = { id: "t", status: { state: "TASK_STATE_WORKING" } };
    const message = { messageId: "m", role: "ROLE_AGENT", parts: [{ text: "hi" }] };
    expect(SendMessageResponseSchema.safeParse({ task }).success).toBe(true);
    expect(SendMessageResponseSchema.safeParse({ message }).success).toBe(true);
    expect(SendMessageResponseSchema.safeParse({ task, message }).success).toBe(false);
    expect(SendMessageResponseSchema.safeParse({}).success).toBe(false);
    expect(SendMessageResponseSchema.safeParse({ task: { id: "t", status: { state: "RUNNING" } } }).success).toBe(false);
  });

  it("reads a JSON-RPC response with a result or an error", () => {
    const ok = RpcResponseSchema.parse({ jsonrpc: "2.0", id: 1, result: { a: 1 } });
    expect(ok.result).toEqual({ a: 1 });
    const bad = RpcResponseSchema.parse({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "no" } });
    expect(bad.error?.code).toBe(-32601);
    expect(RpcResponseSchema.safeParse({ jsonrpc: "1.0", id: 1, result: 1 }).success).toBe(false);
  });

  it("carries a JSON-RPC code on A2AError", () => {
    const e = new A2AError(ErrorCode.taskNotFound, "Task not found");
    expect(e.code).toBe(-32001);
    expect(e.message).toBe("Task not found");
  });
});
