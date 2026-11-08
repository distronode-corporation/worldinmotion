// The worker: sleeps until a message arrives, decides whether its sender may wake it, runs one
// job through the runner, and replies. Log lines name message ids, devices and reasons, never a
// message's text or a wake code.

import type { WorkerConfig } from "./config.ts";
import { parseProfile, stripCode } from "./gate.ts";
import { DailyLedger, RateLimit } from "./limits.ts";
import { RUNNER_MAX_BYTES, runJob, runnerEnv, type RunDeps, type RunnerOutcome, type RunnerRequest, type RunnerSpec } from "./runner.ts";

/** One verified inbound item, as the mesh client hands it over. */
export interface WorkerItem {
  kind: "msg" | "task" | "result" | "file";
  id: string;
  /** The sender's address (`name@device`): chosen by the sender, so only ever a reply address. */
  from: string;
  /** The device id whose key signed the item, from the roster. */
  device: string | undefined;
  text: string;
  /** The sender marked the text as not its own (another model's output, CI logs). */
  relayed: boolean;
  /** Written while its sender handled another agent's message: information only, never a job. */
  derived?: boolean;
  /** Whether the person trusts the sender device right now (`wim devices trust`). */
  trusted: boolean;
  /** Epoch milliseconds after which a task's answer is no longer wanted. */
  deadline?: number;
  /** The signed frame it came in, when the session keeps frames: passed to the runner untouched. */
  frame?: unknown;
}

export type ReplyStatus = "done" | "failed" | "declined" | "timeout";

/** The mesh connection, behind an interface so the worker can be tested without a relay. */
export interface WorkerIO {
  onItem(cb: (item: WorkerItem) => void): void;
  /** A reply to one item. Always sent marked relayed: a model wrote it, not the session. */
  send(to: string, text: string, opts: { reply_to: string; kind: "msg" | "result"; status?: ReplyStatus }): Promise<void>;
  /** A copy to a room, also marked relayed. */
  post(room: string, text: string): Promise<void>;
}

export const NOT_ACCEPTED = "not accepted";
/** To an allowed device whose message was written while it handled another agent's item. */
export const NOT_ACCEPTED_DERIVED = "not accepted: derived";
export const BUSY = "busy: another job is running, or this device sent too many messages this hour; try again later";
export const DAILY_CAP = "declined: today's job limit is reached";
export const FAILED = "the job failed; the worker's operator can see why in its log";
export const TIMED_OUT = "the job timed out";
export const NO_TASK = "declined: the message holds no task";
export const TRUNCATED_NOTE = `\n\n[answer cut at ${RUNNER_MAX_BYTES / 1024} KiB]`;

export interface WorkerOptions {
  config: WorkerConfig;
  io: WorkerIO;
  ledger: DailyLedger;
  /** The wake code when `wake.mode` is `local`. */
  code?: string;
  /** The worker's own environment, from which the runner gets only `runner.passEnv`. */
  env: Readonly<Record<string, string | undefined>>;
  now: () => number;
  log: (line: string) => void;
  /** Replaces how the runner is run (tests). */
  run?: (spec: RunnerSpec, req: RunnerRequest, deps: RunDeps) => Promise<RunnerOutcome>;
  runDeps?: Omit<RunDeps, "log" | "stderr">;
}

type Refusal = "kind" | "no_device" | "not_allowed" | "untrusted" | "relayed" | "derived" | "rate" | "too_long" | "code" | "profile" | "empty" | "busy" | "daily";

export class Worker {
  private readonly o: WorkerOptions;
  private readonly rate: RateLimit;
  private readonly allowed: ReadonlySet<string>;
  private running = false;
  private readonly inflight = new Set<Promise<void>>();

  constructor(options: WorkerOptions) {
    if (options.config.wake.mode === "local" && (options.code === undefined || options.code === "")) {
      throw new Error("wake.mode local needs the wake code");
    }
    this.o = options;
    this.rate = new RateLimit(options.config.limits.perSenderPerHour, options.now);
    this.allowed = new Set(options.config.senders.devices);
  }

  start(): void {
    this.o.io.onItem((item) => void this.handle(item));
  }

  /** Handles one item; never rejects, so one failure cannot stop the next item. */
  handle(item: WorkerItem): Promise<void> {
    const p = this.process(item).catch((err: unknown) => this.o.log(`worker: ${item.id}: ${(err as Error).message}`));
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
    return p;
  }

  /** Resolves once every item handed over so far is fully handled. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all(this.inflight);
  }

  private refused(item: WorkerItem, why: Refusal): void {
    this.o.log(`worker: not running ${item.kind} ${item.id} from device ${item.device ?? "-"}: ${why}`);
  }

  private async process(item: WorkerItem): Promise<void> {
    const c = this.o.config;
    // A result never wakes the worker (answering results is how two peers loop), nor does a file.
    if (item.kind !== "msg" && item.kind !== "task") return this.refused(item, "kind");
    // Silent from here until the sender is known to be allowed: a stranger learns nothing.
    if (item.device === undefined) return this.refused(item, "no_device");
    if (!this.allowed.has(item.device)) return this.refused(item, "not_allowed");
    if (c.senders.requireTrusted && !item.trusted) return this.refused(item, "untrusted");
    // Another model's output must not drive a job, or two agents could drive each other.
    if (item.relayed) return this.refused(item, "relayed");
    // Nor text a session wrote while it handled another agent's message (information only).
    if (item.derived === true) {
      this.refused(item, "derived");
      if (this.o.config.replies.refused === "generic") await this.reply(item, NOT_ACCEPTED_DERIVED, "declined");
      return;
    }

    // Every attempt counts, accepted or not, so a wake code cannot be guessed at speed.
    if (!this.rate.take(item.device)) {
      this.refused(item, "rate");
      return this.reply(item, BUSY, "declined");
    }
    if (item.text.length > c.limits.maxTaskChars) {
      this.refused(item, "too_long");
      return this.reply(item, `declined: the task is over ${c.limits.maxTaskChars} characters`, "declined");
    }

    let text = item.text;
    if (c.wake.mode === "local") {
      const stripped = stripCode(text, this.o.code!);
      if (!stripped.ok) return this.refuse(item, "code");
      text = stripped.rest;
    }
    let profile = "";
    if (c.profiles !== undefined) {
      const parsed = parseProfile(text, c.profiles.allowed, c.profiles.default);
      if (!parsed.ok) return this.refuse(item, "profile");
      profile = parsed.profile;
      text = parsed.task;
    }
    // With the code at the runner, an empty-looking text may still be a code and a task.
    if (c.wake.mode !== "runner" && text.trim() === "") {
      this.refused(item, "empty");
      return this.reply(item, NO_TASK, "declined");
    }

    // One job at a time. Claimed before anything is awaited, so two messages cannot both start.
    if (this.running) {
      this.refused(item, "busy");
      return this.reply(item, BUSY, "declined");
    }
    this.running = true;
    try {
      await this.runOne(item, profile, text);
    } finally {
      this.running = false;
    }
  }

  private async runOne(item: WorkerItem, profile: string, text: string): Promise<void> {
    const c = this.o.config;
    let timeoutMs = c.runner.timeoutSeconds * 1000;
    if (item.kind === "task" && item.deadline !== undefined) {
      const left = item.deadline - this.o.now();
      if (left <= 0) {
        this.o.log(`worker: task ${item.id} arrived past its deadline`);
        return this.reply(item, "deadline passed before the job started", "timeout");
      }
      timeoutMs = Math.min(timeoutMs, left);
    }
    if (!(await this.o.ledger.take())) {
      this.refused(item, "daily");
      return this.reply(item, DAILY_CAP, "declined");
    }

    const spec: RunnerSpec = {
      command: c.runner.command,
      args: c.runner.args,
      timeoutMs,
      killGraceMs: c.runner.killGraceSeconds * 1000,
      env: runnerEnv(this.o.env, c.runner.passEnv),
    };
    const req: RunnerRequest = { v: 2, id: item.id, from: { device: item.device!, address: item.from }, profile, text, ...(item.frame === undefined ? {} : { frame: item.frame }) };
    const started = this.o.now();
    this.o.log(`worker: job ${item.id} start from device ${item.device} profile ${profile === "" ? "-" : profile}`);
    const run = this.o.run ?? runJob;
    const out = await run(spec, req, {
      ...this.o.runDeps,
      log: this.o.log,
      ...(c.runner.logStderr ? { stderr: (line: string) => this.o.log(`runner: ${line}`) } : {}),
    });
    this.o.log(`worker: job ${item.id} ${out.kind} ms=${this.o.now() - started}${out.kind === "failed" ? ` code=${out.code} signal=${out.signal}` : ""}`);

    switch (out.kind) {
      case "answered": {
        const answer = out.answer.trim() === "" ? "(empty answer)" : out.answer;
        await this.reply(item, out.truncated ? `${answer}${TRUNCATED_NOTE}` : answer, "done");
        if (c.replies.room !== undefined) {
          // The answer only: never the task, the raw text or the code.
          await this.o.io.post(c.replies.room, answer).catch((err: unknown) => this.o.log(`worker: room copy of ${item.id} not sent: ${(err as Error).message}`));
        }
        return;
      }
      // The runner ran no job, so today's allowance is not spent on it (#134).
      case "refused":
        await this.o.ledger.giveBack();
        return this.refuse(item, "code");
      case "busy":
        await this.o.ledger.giveBack();
        return this.reply(item, BUSY, "declined");
      case "timeout":
        return this.reply(item, TIMED_OUT, "timeout");
      case "failed":
        return this.reply(item, FAILED, "failed");
    }
  }

  /** A refusal an allowed device hears about (or not, with `replies.refused: silent`). */
  private async refuse(item: WorkerItem, why: "code" | "profile"): Promise<void> {
    this.refused(item, why);
    if (this.o.config.replies.refused === "generic") await this.reply(item, NOT_ACCEPTED, "declined");
  }

  /** A task is answered with a `result`; a message with a `msg` threaded to it. */
  private async reply(item: WorkerItem, text: string, status: ReplyStatus): Promise<void> {
    const opts = item.kind === "task" ? { reply_to: item.id, kind: "result" as const, status } : { reply_to: item.id, kind: "msg" as const };
    await this.o.io.send(item.from, text, opts).catch((err: unknown) => this.o.log(`worker: reply to ${item.id} not sent: ${(err as Error).message}`));
  }
}

/** Reads the wake code from its file or variable: trimmed, and never empty. */
export async function readCode(
  wake: WorkerConfig["wake"],
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => Promise<string>,
): Promise<string | undefined> {
  if (wake.mode !== "local") return undefined;
  const raw = wake.codeFile !== undefined ? await readFile(wake.codeFile) : env[wake.codeEnv!];
  const code = (raw ?? "").trim();
  if (code === "" || /\s/.test(code)) {
    throw new Error(`the wake code (${wake.codeFile ?? wake.codeEnv}) is empty or holds whitespace`);
  }
  return code;
}

export interface RunWorkerDeps {
  now?: () => number;
  log?: (line: string) => void;
  env?: Readonly<Record<string, string | undefined>>;
  readFile?: (path: string) => Promise<string>;
  run?: WorkerOptions["run"];
  runDeps?: WorkerOptions["runDeps"];
}

/** Wires a validated config to a mesh connection and starts listening. */
export async function runWorker(config: WorkerConfig, io: WorkerIO, deps: RunWorkerDeps = {}): Promise<Worker> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const env = deps.env ?? process.env;
  const read = deps.readFile ?? (async (path: string) => (await import("node:fs/promises")).readFile(path, "utf8"));
  const code = await readCode(config.wake, env, read);
  const ledger = await DailyLedger.open(config.limits.ledgerPath, config.limits.dailyJobs, now);
  const worker = new Worker({
    config,
    io,
    ledger,
    ...(code === undefined ? {} : { code }),
    env,
    now,
    log,
    ...(deps.run === undefined ? {} : { run: deps.run }),
    ...(deps.runDeps === undefined ? {} : { runDeps: deps.runDeps }),
  });
  worker.start();
  log(`worker: listening; ${config.senders.devices.length} allowed device(s), wake code ${config.wake.mode}, ${ledger.used} of ${config.limits.dailyJobs} jobs used today`);
  return worker;
}
