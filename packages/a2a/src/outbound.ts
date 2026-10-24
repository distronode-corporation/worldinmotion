import { randomUUID } from "node:crypto";
import { LIMITS } from "@worldinmotion/protocol";
import type { MeshPort, ResultStatus } from "./mesh.ts";
import { checkAgentUrl, fetchJson } from "./net.ts";
import {
  A2A_VERSION,
  AgentCardSchema,
  isInterrupted,
  isTerminal,
  RpcResponseSchema,
  SendMessageResponseSchema,
  TaskSchema,
  textOf,
  type Part,
  type Task,
} from "./spec.ts";

/** The largest result text sent back on the mesh: its message text limit. */
export const MAX_RESULT_BYTES = LIMITS.textBytes;
const MAX_ERROR_CHARS = 1000;

export interface ExternalAgent {
  /** The mesh session name the agent appears under (kind `a2a`). */
  name: string;
  /** The agent card URL, usually `https://host/.well-known/agent-card.json`. */
  cardUrl: string;
  /** An environment variable holding the whole `Authorization` header value for this agent. */
  authHeaderEnv?: string;
}

export interface OutboundOptions {
  mesh: MeshPort;
  agents: ExternalAgent[];
  env?: Record<string, string | undefined>;
  /** One HTTP exchange with an agent. Default 15 seconds. */
  requestTimeoutMs?: number;
  /** For a task with no deadline. Default 5 minutes. */
  defaultDeadlineMs?: number;
  /** A later deadline is pulled in to this. Default 1 hour. */
  maxDeadlineMs?: number;
  /** First wait between `GetTask` polls, growing by half each time. Default 1 second. */
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  /** Tasks in flight per agent; more are declined. Default 4. */
  maxConcurrent?: number;
  /** How long a fetched agent card is trusted. Default 10 minutes. */
  cardTtlMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  fetch?: typeof fetch;
}

interface Outcome {
  status: ResultStatus;
  text: string;
}

interface Endpoint {
  url: URL;
  tenant?: string;
  fetchedAt: number;
}

/** A JSON-RPC error an external agent answered with. */
class RemoteError extends Error {}

/**
 * One external A2A agent: resolves its agent card, then runs a task through `SendMessage` and
 * `GetTask` polling until it ends or the deadline passes.
 */
export class RemoteAgent {
  readonly name: string;
  private readonly cardUrl: URL;
  private readonly auth?: string;
  private readonly o: Required<
    Pick<
      OutboundOptions,
      "requestTimeoutMs" | "pollIntervalMs" | "maxPollIntervalMs" | "cardTtlMs" | "now"
    >
  > & { fetch?: typeof fetch };
  private endpoint?: Endpoint;

  constructor(agent: ExternalAgent, opts: OutboundOptions) {
    this.name = agent.name;
    this.cardUrl = checkAgentUrl(agent.cardUrl);
    if (agent.authHeaderEnv !== undefined) {
      const value = (opts.env ?? process.env)[agent.authHeaderEnv];
      if (value === undefined || value === "") {
        throw new Error(`environment variable ${agent.authHeaderEnv} is not set`);
      }
      this.auth = value;
    }
    this.o = {
      requestTimeoutMs: opts.requestTimeoutMs ?? 15_000,
      pollIntervalMs: opts.pollIntervalMs ?? 1000,
      maxPollIntervalMs: opts.maxPollIntervalMs ?? 10_000,
      cardTtlMs: opts.cardTtlMs ?? 600_000,
      now: opts.now ?? Date.now,
      fetch: opts.fetch,
    };
  }

  /** Runs one task to its end. Never throws: every failure becomes a `failed` outcome. */
  async run(text: string, deadline: number): Promise<Outcome> {
    let ep: Endpoint;
    try {
      ep = await this.resolve();
    } catch (err) {
      return { status: "failed", text: `The agent card for ${this.name} is unusable: ${(err as Error).message}` };
    }
    let taskId: string | undefined;
    try {
      const sent = SendMessageResponseSchema.safeParse(
        await this.call(ep, "SendMessage", {
          message: {
            messageId: randomUUID(),
            role: "ROLE_USER",
            parts: [{ text, mediaType: "text/plain" }],
          },
          configuration: { returnImmediately: true, acceptedOutputModes: ["text/plain"], historyLength: 0 },
        }),
      );
      if (!sent.success) throw new Error("SendMessage answered with neither a task nor a message");
      if (sent.data.message !== undefined) return { status: "done", text: render(sent.data.message.parts) };
      let task = sent.data.task!;
      taskId = task.id;
      let wait = this.o.pollIntervalMs;
      for (;;) {
        const state = task.status.state;
        if (isTerminal(state) || isInterrupted(state)) return outcomeOf(task);
        const left = deadline - this.o.now();
        if (left <= 0) {
          await this.cancel(ep, task.id);
          return { status: "timeout", text: `${this.name} did not finish before the deadline.` };
        }
        await new Promise((r) => setTimeout(r, Math.min(wait, left)));
        wait = Math.min(wait * 1.5, this.o.maxPollIntervalMs);
        const got = TaskSchema.safeParse(await this.call(ep, "GetTask", { id: task.id, historyLength: 0 }));
        if (!got.success || got.data.id !== task.id) throw new Error("GetTask answered with another or no task");
        task = got.data;
      }
    } catch (err) {
      const what = err instanceof RemoteError ? "answered with an error" : "failed";
      const msg = clip((err as Error).message, MAX_ERROR_CHARS);
      return { status: "failed", text: `${this.name} ${what}: ${msg}${taskId === undefined ? "" : ` (task ${taskId})`}` };
    }
  }

  /** The JSON-RPC endpoint from the agent card, fetched again once `cardTtlMs` has passed. */
  async resolve(): Promise<Endpoint> {
    const cached = this.endpoint;
    if (cached !== undefined && this.o.now() - cached.fetchedAt < this.o.cardTtlMs) return cached;
    const got = await fetchJson(
      this.cardUrl,
      { method: "GET", headers: this.headers({ accept: "application/json" }) },
      { timeoutMs: this.o.requestTimeoutMs, fetch: this.o.fetch },
    );
    if (got.status !== 200) throw new Error(`HTTP ${got.status}`);
    const card = AgentCardSchema.safeParse(got.body);
    if (!card.success) throw new Error("not an A2A agent card");
    const iface = card.data.supportedInterfaces.find(
      (i) => i.protocolBinding === "JSONRPC" && i.protocolVersion === A2A_VERSION,
    );
    if (iface === undefined) throw new Error(`no JSONRPC interface for protocol ${A2A_VERSION}`);
    const url = checkAgentUrl(iface.url);
    // The card decides where task text and the auth header go next, so it may not send them to
    // a host other than the one it was fetched from.
    if (url.hostname !== this.cardUrl.hostname) throw new Error(`interface is on another host (${url.host})`);
    if (!card.data.defaultInputModes.some((m) => /^(text(\/.*)?|\*\/\*)$/i.test(m))) {
      throw new Error("the agent does not accept text");
    }
    const ep: Endpoint = { url, tenant: iface.tenant, fetchedAt: this.o.now() };
    this.endpoint = ep;
    return ep;
  }

  private async cancel(ep: Endpoint, id: string): Promise<void> {
    try {
      await this.call(ep, "CancelTask", { id });
    } catch {
      // Best effort: the task is reported as timed out either way.
    }
  }

  private async call(ep: Endpoint, method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = randomUUID();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: ep.tenant === undefined ? params : { tenant: ep.tenant, ...params },
    });
    const got = await fetchJson(
      ep.url,
      {
        method: "POST",
        headers: this.headers({
          "content-type": "application/json",
          accept: "application/json",
          "a2a-version": A2A_VERSION,
        }),
        body,
      },
      { timeoutMs: this.o.requestTimeoutMs, fetch: this.o.fetch },
    );
    const res = RpcResponseSchema.safeParse(got.body);
    if (!res.success || res.data.id !== id) throw new Error(`not a JSON-RPC response (HTTP ${got.status})`);
    const err = res.data.error;
    if (err !== undefined) throw new RemoteError(`${err.code} ${err.message}`);
    return res.data.result;
  }

  private headers(base: Record<string, string>): Record<string, string> {
    return this.auth === undefined ? base : { ...base, authorization: this.auth };
  }
}

/**
 * The outbound half of the gateway: every configured external agent is a mesh session of kind
 * `a2a`, and a `task` (or `msg`) addressed to one runs on that agent and is answered on the
 * mesh with a `result`.
 */
export class OutboundBridge {
  private readonly mesh: MeshPort;
  private readonly agents = new Map<string, RemoteAgent>();
  private readonly active = new Map<string, number>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly defaultDeadlineMs: number;
  private readonly maxDeadlineMs: number;
  private readonly maxConcurrent: number;

  constructor(opts: OutboundOptions) {
    this.mesh = opts.mesh;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => void process.stderr.write(`${line}\n`));
    this.defaultDeadlineMs = opts.defaultDeadlineMs ?? 300_000;
    this.maxDeadlineMs = opts.maxDeadlineMs ?? 3_600_000;
    this.maxConcurrent = opts.maxConcurrent ?? 4;
    for (const a of opts.agents) {
      if (this.agents.has(a.name)) throw new Error(`external agent ${a.name} is listed twice`);
      this.agents.set(a.name, new RemoteAgent(a, opts));
    }
  }

  /** The sessions the mesh client should hold for the external agents. */
  sessions(): Array<{ name: string; kind: "a2a" }> {
    return [...this.agents.keys()].map((name) => ({ name, kind: "a2a" }));
  }

  start(): void {
    this.mesh.onTask((t) => void this.relay(t.id, t.to, t.from, t.text, t.deadline));
    this.mesh.onMessage?.((m) => void this.relay(m.id, m.to, m.from, m.text, undefined));
  }

  /** Resolves when the result has been sent (or the item was not for an external agent). */
  async relay(id: string, to: string, from: string, text: string, deadline?: number): Promise<void> {
    const agent = this.agents.get(to.split("@")[0]!);
    if (agent === undefined) return;
    const busy = this.active.get(agent.name) ?? 0;
    let out: Outcome;
    if (busy >= this.maxConcurrent) {
      out = { status: "declined", text: `${agent.name} is busy with ${busy} tasks; try again later.` };
    } else {
      const now = this.now();
      const due = Math.min(deadline ?? now + this.defaultDeadlineMs, now + this.maxDeadlineMs);
      this.active.set(agent.name, busy + 1);
      this.log(`a2a: task ${id} from ${from} to external agent ${agent.name}`);
      try {
        out = await agent.run(text, due);
      } finally {
        this.active.set(agent.name, this.active.get(agent.name)! - 1);
      }
    }
    try {
      await this.mesh.sendResult(from, id, out.status, clip(out.text, MAX_RESULT_BYTES));
    } catch (err) {
      this.log(`a2a: result for ${id} not sent: ${(err as Error).message}`);
    }
  }
}

function outcomeOf(task: Task): Outcome {
  const said = task.status.message === undefined ? "" : render(task.status.message.parts);
  switch (task.status.state) {
    case "TASK_STATE_COMPLETED": {
      const parts = (task.artifacts ?? []).flatMap((a) => a.parts);
      return { status: "done", text: parts.length > 0 ? render(parts) : said };
    }
    case "TASK_STATE_REJECTED":
      return { status: "declined", text: said };
    case "TASK_STATE_CANCELED":
      return { status: "failed", text: `The agent canceled the task.${said === "" ? "" : ` ${said}`}` };
    case "TASK_STATE_FAILED":
      return { status: "failed", text: said === "" ? "The agent reported a failure." : said };
    default:
      // Input-required or auth-required: the mesh task model has no second turn to carry them.
      return {
        status: "failed",
        text: `The agent asked for more input, which the gateway cannot relay.${said === "" ? "" : ` ${said}`}`,
      };
  }
}

function render(parts: readonly Part[]): string {
  const { text, other } = textOf(parts);
  if (other === 0) return text;
  const note = `[${other} non-text part${other === 1 ? "" : "s"} omitted]`;
  return text === "" ? note : `${text}\n\n${note}`;
}

function clip(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  return `${Buffer.from(text).subarray(0, maxBytes - 16).toString("utf8")} [truncated]`;
}
