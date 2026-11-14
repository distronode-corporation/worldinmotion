// A fake ACP agent for `wim run` tests: in-process streams, driven by a transcript (one line per
// message, as an ACP session over stdio is recorded), and a clock whose waits a test releases by
// hand, so no test depends on a real timer.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentProcess } from "../src/run.ts";

/** One client message as the fake read it. */
export type Msg = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };

/**
 * One transcript step:
 * - `{ from: "client", method }`: the next message wim sends is this request or notification;
 * - `{ from: "client", response: id }`: the next message wim sends answers the agent's request `id`;
 * - `{ from: "agent", reply: method, result | error }`: the agent answers the last such request;
 * - `{ from: "agent", message }`: the agent sends this message as it is;
 * - `{ from: "test", wait: label }`: the transcript pauses until the test calls `go(label)`.
 */
export type Step =
  | { from: "client"; method: string }
  | { from: "client"; response: number | string }
  | { from: "agent"; reply: string; result?: unknown; error?: { code: number; message: string } }
  | { from: "agent"; message: Record<string, unknown> }
  | { from: "test"; wait: string };

export type Transcript = { agent: string; source: string; steps: Step[] };

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "test", "fixtures", "acp");

/** A recorded transcript from `test/fixtures/acp/<agent>/<name>`. */
export function transcript(agent: string, name: string): Transcript {
  return JSON.parse(readFileSync(join(FIXTURES, agent, name), "utf8")) as Transcript;
}

export class FakeAgent implements AgentProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly exited: Promise<string>;
  /** Every message wim sent, in order. */
  readonly received: Msg[] = [];
  /** The client steps matched so far, by method or response id. */
  readonly matched: Msg[] = [];
  kills = 0;
  /** Whether closing its stdin makes it exit (an agent that ignores EOF does not). */
  exitOnEof = true;
  /** Whether `kill` makes it exit. */
  exitOnKill = true;

  private exit!: (how: string) => void;
  private queue: Msg[] = [];
  private waiters: Array<() => void> = [];
  private readonly labels = new Map<string, () => void>();
  private readonly lastRequest = new Map<string, Msg>();
  private buffer = "";

  constructor() {
    this.exited = new Promise((resolve) => (this.exit = resolve));
    this.stdin.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      for (let nl = this.buffer.indexOf("\n"); nl !== -1; nl = this.buffer.indexOf("\n")) {
        const msg = JSON.parse(this.buffer.slice(0, nl)) as Msg;
        this.buffer = this.buffer.slice(nl + 1);
        this.received.push(msg);
        this.queue.push(msg);
        for (const w of this.waiters.splice(0)) w();
      }
    });
    this.stdin.on("finish", () => {
      if (this.exitOnEof) this.quit("exit code 0");
    });
  }

  kill(): void {
    this.kills++;
    if (this.exitOnKill) this.quit("signal SIGTERM");
  }

  /** Ends the process: its output closes, then it has exited. */
  quit(how: string): void {
    this.stdout.end();
    this.stderr.end();
    this.exit(how);
  }

  send(msg: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  }

  /** The next message wim sends. */
  async next(): Promise<Msg> {
    while (this.queue.length === 0) await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.queue.shift()!;
  }

  /** What wim sent that no step has matched yet. */
  unread(): Msg[] {
    return [...this.queue];
  }

  /** Lets a transcript paused at `wait: label` go on. */
  go(label: string): void {
    const release = this.labels.get(label);
    if (release === undefined) throw new Error(`the transcript is not waiting at ${label}`);
    this.labels.delete(label);
    release();
  }

  /** Resolves once the transcript has reached `wait: label`. */
  reached(label: string): Promise<void> {
    if (this.reachedLabels.has(label)) return Promise.resolve();
    return new Promise<void>((resolve) => this.onReach.set(label, resolve));
  }

  private readonly reachedLabels = new Set<string>();
  private readonly onReach = new Map<string, () => void>();

  /** Plays `steps`; each client step must be the next message wim sends. */
  async play(steps: readonly Step[]): Promise<void> {
    for (const step of steps) {
      if (step.from === "test") {
        const paused = new Promise<void>((resolve) => this.labels.set(step.wait, resolve));
        this.reachedLabels.add(step.wait);
        this.onReach.get(step.wait)?.();
        await paused;
      } else if (step.from === "client") {
        const msg = await this.next();
        const want = "method" in step ? `method ${step.method}` : `a response to ${String(step.response)}`;
        const ok = "method" in step ? msg.method === step.method : msg.method === undefined && msg.id === step.response;
        if (!ok) throw new Error(`expected ${want}, got ${JSON.stringify(msg)}`);
        this.matched.push(msg);
        if ("method" in step && msg.id !== undefined) this.lastRequest.set(step.method, msg);
      } else if ("reply" in step) {
        const req = this.lastRequest.get(step.reply);
        if (req === undefined) throw new Error(`no ${step.reply} request to answer`);
        this.lastRequest.delete(step.reply);
        this.send(step.error === undefined ? { id: req.id, result: step.result } : { id: req.id, error: step.error });
      } else this.send(step.message);
    }
  }

  /** The matched client message for `method` (the `n`th one). */
  sent(method: string, n = 0): Msg {
    const found = this.matched.filter((m) => m.method === method)[n];
    if (found === undefined) throw new Error(`wim sent no ${method} (#${n})`);
    return found;
  }
}

/** A clock for `delay`: each wait stays pending until the test fires it. */
export class Clock {
  private pending: Array<{ ms: number; resolve: () => void }> = [];
  private watchers: Array<() => void> = [];

  readonly delay = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      this.pending.push({ ms, resolve });
      for (const w of this.watchers.splice(0)) w();
    });

  /** Resolves once a wait of `ms` is pending. */
  async waiting(ms: number): Promise<void> {
    while (!this.pending.some((p) => p.ms === ms)) await new Promise<void>((resolve) => this.watchers.push(resolve));
  }

  /** Ends every pending wait of `ms`. */
  fire(ms: number): void {
    const due = this.pending.filter((p) => p.ms === ms);
    this.pending = this.pending.filter((p) => p.ms !== ms);
    for (const p of due) p.resolve();
  }

  /** Waits for a wait of `ms`, then ends it. */
  async tick(ms: number): Promise<void> {
    await this.waiting(ms);
    this.fire(ms);
  }
}
