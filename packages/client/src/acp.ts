// A small JSON-RPC 2.0 peer over a pair of byte streams, newline-delimited as the Agent Client
// Protocol's stdio transport is (one message per line, no batches), and the ACP version 1 shapes
// `wim run` (run.ts) uses. wim is the client: it starts the agent and talks to its stdin and
// stdout. The official ACP TypeScript SDK is not used: it is about 9 MB unpacked, wants a newer MCP
// server package than wim's as a peer dependency, and implements the client file system and
// terminal methods that a hosted session never offers. Everything read here is the agent's: each
// line is parsed as untrusted JSON, and every field wim acts on is checked against a schema.

import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";

/** The ACP major version wim speaks. v2 is still a draft upstream; every agent wim runs serves v1. */
export const ACP_VERSION = 1;

/** A line longer than this is dropped (a tool call's diff can be large, but not this large). */
export const MAX_LINE = 8 << 20;

/** JSON-RPC and ACP error codes wim uses or reads. */
export const RPC = {
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** ACP: the agent wants the person to sign in before a session. */
  authRequired: -32000,
} as const;

/** An error response the other side sent, or one a handler throws to answer with. */
export class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** What answers the other side's requests and notifications. */
export type RpcHandlers = {
  /** The result to answer a request with; throw an RpcError to answer with that error. */
  request: (method: string, params: unknown) => Promise<unknown>;
  notification: (method: string, params: unknown) => void;
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

const message = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

const errorBody = z.looseObject({ code: z.number(), message: z.string() });

/**
 * One JSON-RPC connection. Requests it sends get numeric ids; a response to an id it never sent is
 * ignored. A line that is not one JSON-RPC message is logged and skipped. When the input ends or
 * fails, every request still waiting is rejected and `closed` resolves.
 */
export class JsonRpc {
  /** Resolves once the input has ended, failed or been closed. */
  readonly closed: Promise<void>;

  private readonly output: Writable;
  private readonly handlers: RpcHandlers;
  private readonly log: (line: string) => void;
  private readonly pending = new Map<number, Pending>();
  private next = 0;
  private buffer = "";
  /** Set while the rest of an over-long line is being skipped. */
  private skipping = false;
  private done = false;
  private ended!: () => void;

  constructor(input: Readable, output: Writable, handlers: RpcHandlers, log: (line: string) => void, maxLine = MAX_LINE) {
    this.output = output;
    this.handlers = handlers;
    this.log = log;
    this.closed = new Promise((resolve) => (this.ended = resolve));
    const decoder = new StringDecoder("utf8");
    input.on("data", (chunk: Buffer) => this.take(decoder.write(chunk), maxLine));
    input.once("end", () => this.close());
    input.once("close", () => this.close());
    input.once("error", (error: Error) => this.close(`the agent's output failed: ${error.message}`));
    // A write to an agent that already exited fails here (EPIPE), never as an uncaught error.
    output.on("error", (error: Error) => this.close(`writing to the agent failed: ${error.message}`));
  }

  /** Whether the connection has closed: nothing more is sent or read. */
  get isClosed(): boolean {
    return this.done;
  }

  /** Sends a request and resolves with its result; rejects with an RpcError, or when the connection closes. */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.done) return Promise.reject(new Error("the agent's connection is closed"));
    const id = ++this.next;
    const answered = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.write({ jsonrpc: "2.0", id, method, params });
    return answered;
  }

  /** Sends a notification (no answer). */
  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Ends the connection from this side: waiting requests are rejected. Idempotent. */
  close(why?: string): void {
    if (this.done) return;
    this.done = true;
    if (why !== undefined) this.log(why);
    for (const p of this.pending.values()) p.reject(new Error("the agent's connection closed before it answered"));
    this.pending.clear();
    this.ended();
  }

  private write(msg: Record<string, unknown>): void {
    // JSON.stringify escapes every newline inside strings, so one message is one line.
    if (!this.done && this.output.writable) this.output.write(`${JSON.stringify(msg)}\n`);
  }

  private take(text: string, maxLine: number): void {
    let rest = text;
    for (let nl = rest.indexOf("\n"); nl !== -1; nl = rest.indexOf("\n")) {
      const line = this.buffer + rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      this.buffer = "";
      if (this.skipping) this.skipping = false;
      // Windows agents may end lines with CRLF.
      else this.line(line.endsWith("\r") ? line.slice(0, -1) : line, maxLine);
    }
    if (this.skipping) return;
    this.buffer += rest;
    if (this.buffer.length > maxLine) {
      this.log(`wim run: dropped a message from the agent longer than ${maxLine} characters`);
      this.buffer = "";
      this.skipping = true;
    }
  }

  private line(text: string, maxLine: number): void {
    if (text.trim() === "" || this.done) return;
    if (text.length > maxLine) return this.log(`wim run: dropped a message from the agent longer than ${maxLine} characters`);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return this.log("wim run: the agent wrote a line that is not JSON; skipped");
    }
    const m = message.safeParse(value);
    if (!m.success) return this.log("wim run: the agent wrote a line that is not a JSON-RPC message; skipped");
    const { id, method } = m.data;
    if (method !== undefined && id !== undefined) return void this.answer(id, method, m.data.params);
    if (method !== undefined) return this.notified(method, m.data.params);
    if (typeof id === "number") this.settle(id, m.data);
  }

  private notified(method: string, params: unknown): void {
    try {
      this.handlers.notification(method, params);
    } catch (error) {
      this.log(`wim run: handling ${method} failed: ${(error as Error).message}`);
    }
  }

  private settle(id: number, m: z.infer<typeof message>): void {
    const p = this.pending.get(id);
    if (p === undefined) return;
    this.pending.delete(id);
    if (m.error === undefined) return p.resolve(m.result);
    const e = errorBody.safeParse(m.error);
    p.reject(e.success ? new RpcError(e.data.code, e.data.message) : new RpcError(RPC.internal, "an error response with no code or message"));
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      this.write({ jsonrpc: "2.0", id, result: (await this.handlers.request(method, params)) ?? null });
    } catch (error) {
      const code = error instanceof RpcError ? error.code : RPC.internal;
      this.write({ jsonrpc: "2.0", id, error: { code, message: error instanceof RpcError ? error.message : "internal error" } });
    }
  }
}

/** Throws a readable error when `value` does not have the shape `schema` describes. */
export function shaped<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(`the agent's ${what} is not what ACP describes`);
  return r.data;
}

/**
 * `initialize`: ACP version 1, and no client capability at all. With no file system and no
 * terminal offered, the agent cannot ask wim to read or write a file or to run a command; it
 * uses only its own tools, under its own configuration.
 */
export function initializeParams(version: string): Record<string, unknown> {
  return {
    protocolVersion: ACP_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "worldinmotion", title: "worldinmotion (wim run)", version },
  };
}

export const initializeResult = z.looseObject({ protocolVersion: z.number().int() });

export const newSessionResult = z.looseObject({ sessionId: z.string().min(1).max(512) });

export const promptResult = z.looseObject({ stopReason: z.string() });

/** A tool's programmatic name, when it is a plain identifier; anything else is not shown. */
const toolName = z.string().regex(/^[A-Za-z0-9_.:/-]{1,64}$/);

/** The tool call fields wim reads: its id, and what names the tool (its name, or its kind). */
export const toolCall = z.looseObject({
  toolCallId: z.string(),
  name: toolName.optional().catch(undefined),
  kind: z.enum(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"]).optional().catch(undefined),
});

export const permissionRequest = z.looseObject({
  toolCall,
  options: z.array(z.looseObject({ optionId: z.string(), kind: z.string() })),
});

export const sessionUpdate = z.looseObject({
  update: z.looseObject({ sessionUpdate: z.string() }),
});

export const textChunk = z.looseObject({ content: z.looseObject({ type: z.literal("text"), text: z.string() }) });
