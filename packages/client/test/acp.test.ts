import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ACP_VERSION, initializeParams, JsonRpc, RPC, RpcError, shaped, type RpcHandlers } from "../src/acp.ts";

type Wire = { rpc: JsonRpc; input: PassThrough; output: PassThrough; sent: Array<Record<string, unknown>>; logs: string[]; notes: Array<[string, unknown]> };

function wire(handlers: Partial<RpcHandlers> = {}, maxLine?: number): Wire {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const notes: Array<[string, unknown]> = [];
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n").filter((l) => l !== "")) sent.push(JSON.parse(line) as Record<string, unknown>);
  });
  const rpc = new JsonRpc(
    input,
    output,
    {
      request: handlers.request ?? (async () => undefined),
      notification: handlers.notification ?? ((m, p) => void notes.push([m, p])),
    },
    (l) => void logs.push(l),
    maxLine,
  );
  return { rpc, input, output, sent, logs, notes };
}

/** Lets stream events and handlers run, without a timer. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("acp: the JSON-RPC peer", () => {
  it("sends one message per line and resolves a request with its result", async () => {
    const w = wire();
    const answer = w.rpc.request("initialize", { a: "x\ny" });
    w.rpc.notify("session/cancel", { sessionId: "s" });
    await flush();
    expect(w.sent).toEqual([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { a: "x\ny" } },
      { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s" } },
    ]);
    w.input.write('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
    expect(await answer).toEqual({ ok: true });
  });

  it("reads CRLF lines, lines split across chunks, and UTF-8 split inside a character", async () => {
    const w = wire();
    const bytes = Buffer.from('{"jsonrpc":"2.0","method":"n","params":"é✓"}\r\n', "utf8");
    const cut = bytes.indexOf(Buffer.from("✓", "utf8")) + 1;
    w.input.write(bytes.subarray(0, 5));
    w.input.write(bytes.subarray(5, cut));
    w.input.write(bytes.subarray(cut));
    w.input.write("\n   \n");
    await flush();
    expect(w.notes).toEqual([["n", "é✓"]]);
    expect(w.logs).toEqual([]);
  });

  it("skips what is not one JSON-RPC message, and drops an over-long line, read whole or in pieces", async () => {
    const w = wire({}, 64);
    w.input.write("not json\n");
    w.input.write('{"id":1,"method":"m"}\n');
    w.input.write("[1,2]\n");
    w.input.write(`${"y".repeat(80)}\n`);
    w.input.write("z".repeat(40));
    w.input.write("z".repeat(40));
    w.input.write("z".repeat(40));
    w.input.write(`${"z".repeat(40)}\n{"jsonrpc":"2.0","method":"after"}\n`);
    await flush();
    expect(w.logs).toEqual([
      "wim run: the agent wrote a line that is not JSON; skipped",
      "wim run: the agent wrote a line that is not a JSON-RPC message; skipped",
      "wim run: the agent wrote a line that is not a JSON-RPC message; skipped",
      "wim run: dropped a message from the agent longer than 64 characters",
      "wim run: dropped a message from the agent longer than 64 characters",
    ]);
    expect(w.notes).toEqual([["after", undefined]]);
  });

  it("answers the other side's requests: a result, null for none, an RpcError's code, and an internal error for anything else", async () => {
    const w = wire({
      request: async (method) => {
        if (method === "value") return { v: 1 };
        if (method === "nothing") return undefined;
        if (method === "refused") throw new RpcError(RPC.methodNotFound, "no such method");
        throw new Error("secret detail");
      },
    });
    for (const [id, method] of [[1, "value"], ["two", "nothing"], [3, "refused"], [4, "broken"]] as const) w.input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method })}\n`);
    await flush();
    expect(w.sent).toEqual([
      { jsonrpc: "2.0", id: 1, result: { v: 1 } },
      { jsonrpc: "2.0", id: "two", result: null },
      { jsonrpc: "2.0", id: 3, error: { code: -32601, message: "no such method" } },
      { jsonrpc: "2.0", id: 4, error: { code: -32603, message: "internal error" } },
    ]);
  });

  it("logs a notification handler that throws, and goes on", async () => {
    const w = wire({
      notification: (m) => {
        if (m === "bad") throw new Error("broke");
      },
    });
    w.input.write('{"jsonrpc":"2.0","method":"bad"}\n{"jsonrpc":"2.0","method":"good"}\n');
    await flush();
    expect(w.logs).toEqual(["wim run: handling bad failed: broke"]);
  });

  it("rejects with the error the other side sent, or a generic one when it is malformed; ignores answers to nothing it asked", async () => {
    const w = wire();
    const a = w.rpc.request("a", {});
    const b = w.rpc.request("b", {});
    w.input.write('{"jsonrpc":"2.0","id":99,"result":1}\n{"jsonrpc":"2.0","id":"1","result":1}\n');
    w.input.write('{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"sign in"}}\n{"jsonrpc":"2.0","id":2,"error":"nope"}\n');
    const ea = (await a.catch((e: unknown) => e)) as RpcError;
    const eb = (await b.catch((e: unknown) => e)) as RpcError;
    expect([ea.code, ea.message]).toEqual([-32000, "sign in"]);
    expect([eb.code, eb.message]).toEqual([-32603, "an error response with no code or message"]);
  });

  it("closing rejects what waits, reads and sends nothing more, and is idempotent", async () => {
    const w = wire();
    const waiting = w.rpc.request("a", {});
    w.rpc.close("closed by the test");
    w.rpc.close("again");
    await expect(waiting).rejects.toThrow("the agent's connection closed before it answered");
    await expect(w.rpc.request("b", {})).rejects.toThrow("the agent's connection is closed");
    w.rpc.notify("n", {});
    w.input.write('{"jsonrpc":"2.0","method":"late"}\n');
    await flush();
    expect(w.rpc.isClosed).toBe(true);
    expect(w.logs).toEqual(["closed by the test"]);
    expect(w.notes).toEqual([]);
    expect(w.sent.map((m) => m["method"])).toEqual(["a"]);
    await w.rpc.closed;
  });

  it("closes when the input ends or fails, or a write fails", async () => {
    const ended = wire();
    ended.input.end();
    await ended.rpc.closed;
    const failed = wire();
    failed.input.destroy(new Error("EIO"));
    await failed.rpc.closed;
    expect(failed.logs).toEqual(["the agent's output failed: EIO"]);
    const broken = wire();
    broken.output.destroy(new Error("EPIPE"));
    await broken.rpc.closed;
    expect(broken.logs).toEqual(["writing to the agent failed: EPIPE"]);
  });

  it("writes nothing to an output that has ended", async () => {
    const w = wire();
    w.output.end();
    w.rpc.notify("n", {});
    await flush();
    expect(w.sent).toEqual([]);
  });
});

describe("acp: shapes", () => {
  it("initialize offers ACP version 1 and no client capability", () => {
    expect(ACP_VERSION).toBe(1);
    expect(initializeParams("1.2.3")).toEqual({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "worldinmotion", title: "worldinmotion (wim run)", version: "1.2.3" },
    });
  });

  it("shaped returns what parses and names what does not", () => {
    expect(shaped(z.number(), 3, "answer")).toBe(3);
    expect(() => shaped(z.number(), "3", "answer")).toThrow("the agent's answer is not what ACP describes");
  });
});
