// Runs `wim events --json` as a child process: splits its stdout into lines, parses them, matches
// responses to requests by id, and restarts it with backoff when it exits. No `vscode` import.

import { spawn as nodeSpawn } from "node:child_process";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { NAME_RE } from "./display.ts";
import { parseLine, type WimEvent } from "./protocol.ts";

/** The parts of a ChildProcess this module uses. */
export interface Child {
  stdin: { write(chunk: string): boolean; end(): void; on(ev: "error", fn: (err: Error) => void): unknown } | null;
  stdout: { on(ev: "data", fn: (chunk: Buffer) => void): unknown } | null;
  stderr: { on(ev: "data", fn: (chunk: Buffer) => void): unknown } | null;
  on(ev: "exit", fn: (code: number | null, signal: string | null) => void): unknown;
  on(ev: "error", fn: (err: Error) => void): unknown;
  kill(): boolean;
}

export type SpawnFn = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"]; windowsHide: true }) => Child;

/** `cwd` matters: the client publishes its working directory (and that folder's git branch) on its card. */
export type Command = { cmd: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string };

export type Timers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type ProcessOptions = {
  /** Called at every (re)start, so a settings change applies to the next process. */
  command(): Command;
  onEvent(ev: WimEvent): void;
  /** `starting` before each spawn; `exited` when the process ends, with why. */
  onState(state: "starting" | "exited", detail?: string): void;
  log(line: string): void;
  spawn?: SpawnFn;
  timers?: Timers;
  now?: () => number;
  /** The longest stdout or stderr line kept; MAX_LINE unless a test sets it. */
  maxLine?: number;
};

export class RequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Waits between restarts; back to the start once a process has stayed up for STABLE_MS. */
export const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
export const STABLE_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 15_000;
/** A longer line than this is dropped: a `history` answer of 500 messages stays well under it. */
export const MAX_LINE = 64 * 1024 * 1024;

/** Splits a byte stream into lines, holding a partial line between chunks. */
export class LineSplitter {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private dropping = false;

  private readonly onLine: (line: string) => void;
  private readonly onDrop: () => void;
  private readonly max: number;

  constructor(onLine: (line: string) => void, onDrop: () => void, max = MAX_LINE) {
    this.onLine = onLine;
    this.onDrop = onDrop;
    this.max = max;
  }

  push(chunk: Buffer): void {
    const parts = (this.buffer + this.decoder.write(chunk)).split("\n");
    this.buffer = parts.pop()!;
    for (const part of parts) {
      if (this.dropping) this.dropping = false;
      else this.emit(part);
    }
    if (this.buffer.length > this.max) {
      if (!this.dropping) this.onDrop();
      this.dropping = true;
      this.buffer = "";
    }
  }

  private emit(part: string): void {
    const line = part.endsWith("\r") ? part.slice(0, -1) : part;
    if (line.trim() !== "") this.onLine(line);
  }
}

type Pending = { resolve(result: unknown): void; reject(err: RequestError): void; timer: unknown };

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class EventsProcess {
  private child: Child | undefined;
  private stopped = true;
  private attempt = 0;
  private startedAt = 0;
  private restartTimer: unknown;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly spawnFn: SpawnFn;
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly maxLine: number;

  private readonly opts: ProcessOptions;

  constructor(opts: ProcessOptions) {
    this.opts = opts;
    this.spawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
    this.timers = opts.timers ?? realTimers;
    this.now = opts.now ?? Date.now;
    this.maxLine = opts.maxLine ?? MAX_LINE;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.spawn();
  }

  /** Stops the process and does not restart it. */
  stop(): void {
    this.stopped = true;
    this.timers.clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.kill();
  }

  /** Stops and starts again now, as after a settings change. */
  restart(): void {
    this.stop();
    this.start();
  }

  private kill(): void {
    const child = this.child;
    this.child = undefined;
    this.failPending("closed", "the wim events process stopped");
    if (child === undefined) return;
    child.stdin?.end();
    child.kill();
  }

  private spawn(): void {
    this.opts.onState("starting");
    let cmd: Command;
    let child: Child;
    try {
      cmd = this.opts.command();
      this.opts.log(`starting ${cmd.cmd} ${cmd.args.join(" ")}`);
      // Node reports most spawn failures as an `error` event, but a few (bad arguments) throw.
      child = this.spawnFn(cmd.cmd, cmd.args, { cwd: cmd.cwd, env: cmd.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      this.exited(undefined, (e as Error).message);
      return;
    }
    this.child = child;
    this.startedAt = this.now();
    const out = new LineSplitter(
      (line) => this.line(line),
      () => this.opts.log(`dropped a stdout line longer than ${this.maxLine} bytes`),
      this.maxLine,
    );
    // The client's last stderr line is usually why it exited ("run `wim init` first").
    let lastErr = "";
    const err = new LineSplitter(
      (line) => {
        lastErr = line;
        this.opts.log(line);
      },
      () => this.opts.log("dropped a long stderr line"),
      this.maxLine,
    );
    child.stdout!.on("data", (chunk) => {
      if (this.child === child) out.push(chunk);
    });
    child.stderr!.on("data", (chunk) => {
      if (this.child === child) err.push(chunk);
    });
    child.stdin!.on("error", (e) => this.opts.log(`stdin: ${e.message}`));
    child.on("error", (e) => {
      this.opts.log(`could not run ${cmd.cmd}: ${e.message}`);
      this.exited(child, e.message);
    });
    child.on("exit", (code, signal) => {
      const why = signal === null ? `exited with code ${code}` : `stopped by ${signal}`;
      this.exited(child, lastErr === "" ? why : `${why}: ${lastErr}`);
    });
  }

  /** The child ended (or never started); `child` undefined means the command could not be built. */
  private exited(child: Child | undefined, detail: string): void {
    if (child !== undefined && this.child !== child) return;
    this.child = undefined;
    this.failPending("closed", `the wim events process ${detail}`);
    this.opts.log(`wim events ${detail}`);
    this.opts.onState("exited", detail);
    // No `stopped` check is needed: stop() detaches the child first, so its exit returns above.
    if (this.now() - this.startedAt >= STABLE_MS) this.attempt = 0;
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt += 1;
    this.opts.log(`restarting in ${wait / 1000} s`);
    this.restartTimer = this.timers.setTimeout(() => {
      this.restartTimer = undefined;
      this.spawn();
    }, wait);
  }

  private line(line: string): void {
    const parsed = parseLine(line);
    switch (parsed.kind) {
      case "event":
        this.opts.onEvent(parsed.event);
        return;
      case "response": {
        const r = parsed.response;
        const p = this.pending.get(r.id);
        if (p === undefined) {
          this.opts.log(`a response to no pending request (${JSON.stringify(r.id)})`);
          return;
        }
        this.pending.delete(r.id);
        this.timers.clearTimeout(p.timer);
        if (r.ok) p.resolve(r.result);
        else p.reject(new RequestError(r.error.code, r.error.message));
        return;
      }
      case "ignored":
        return;
      case "invalid":
        this.opts.log(`ignored a line from wim events: ${parsed.reason}`);
    }
  }

  private failPending(code: string, message: string): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      this.timers.clearTimeout(p.timer);
      p.reject(new RequestError(code, message));
    }
  }

  /** Sends one request; resolves with its `result`, or rejects with a RequestError. */
  request(op: string, args: Record<string, unknown> = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const child = this.child;
    if (child === undefined) return Promise.reject(new RequestError("closed", "the wim events process is not running"));
    const id = `r${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(id);
        reject(new RequestError("timeout", `no answer to ${op} within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(`${JSON.stringify({ v: 1, id, op, args })}\n`);
    });
  }
}

/** What runs the client: the bundled one, or `wimPath` (see clientCommand). */
type ClientOptions = { extensionPath: string; wimPath: string; execPath: string; env: NodeJS.ProcessEnv };

/**
 * A command line of the client: the bundled client on VS Code's own Node (Electron run as Node),
 * or `wimPath` instead. A `.mjs`, `.cjs` or `.js` path also runs on VS Code's Node; anything else
 * runs as an executable, without a shell.
 */
function wimInvocation(o: ClientOptions, rest: string[]): { cmd: string; args: string[]; env: NodeJS.ProcessEnv; script: boolean } {
  const env = { ...o.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const path = o.wimPath.trim();
  if (path !== "" && !/\.[cm]?js$/i.test(path)) return { cmd: path, args: rest, env, script: false };
  const script = path === "" ? join(o.extensionPath, "dist", "wim.mjs") : path;
  return { cmd: o.execPath, args: [script, ...rest], env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, script: true };
}

/** The command for `wim events`. */
export function clientCommand(o: ClientOptions & { sessionName: string; cwd: string }): Command {
  if (!NAME_RE.test(o.sessionName)) {
    throw new Error(`worldinmotion.sessionName must be lowercase letters, digits and hyphens (up to 32), not ${JSON.stringify(o.sessionName)}`);
  }
  const { cmd, args, env } = wimInvocation(o, ["events", "--json", "--as", o.sessionName]);
  return { cmd, args, env, cwd: o.cwd };
}

/**
 * The integrated terminal that starts the signer (`wim agent start`, or `unlock` when it is
 * locked) with the same client as `wim events`. The person types the passphrase there, in a
 * terminal they opened by running the command, not in one an agent drives. The terminal adds its
 * `env` to VS Code's own, so only Electron's run-as-Node switch is set (or cleared).
 */
export function signerTerminal(o: ClientOptions & { locked: boolean; cwd: string }): { name: string; shellPath: string; shellArgs: string[]; env: Record<string, string | null>; cwd: string } {
  const run = wimInvocation(o, ["agent", o.locked ? "unlock" : "start"]);
  return { name: "worldinmotion signer", shellPath: run.cmd, shellArgs: run.args, env: { ELECTRON_RUN_AS_NODE: run.script ? "1" : null }, cwd: o.cwd };
}

/**
 * The client's working directory: the window's first workspace folder when it is on this
 * machine, else the home directory. A remote folder (a non-file URI) is not a path here, and
 * the process VS Code itself was started from says nothing about this window.
 */
export function clientCwd(folders: readonly { scheme: string; fsPath: string }[] | undefined, home: string): string {
  const first = folders?.[0];
  return first?.scheme === "file" ? first.fsPath : home;
}
