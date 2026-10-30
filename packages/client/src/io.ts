// The real process as the CLI sees it: output, prompts, Ctrl-C, and the facts about the machine.

import { homedir, hostname } from "node:os";
import { createInterface, type Interface } from "node:readline";
import { Writable, type Readable } from "node:stream";
import { spawnDetached, wimCommand } from "./agentcli.ts";
import type { CliIO } from "./cli.ts";
import { pidAlive } from "./platform.ts";

/**
 * One answer line. Input that ends with a last line and no newline gives that line. Input that
 * ends before any line (stdin closed, or empty) gives "", which a confirmation reads as no and a
 * passphrase prompt as none given: a question alone would never settle then, and the process
 * would end with Node's "unsettled top-level await" instead. A line ended by a newline answers
 * the question; a last line without one comes as readline's `line` event, before its `close`.
 */
function ask(input: Readable, open: () => Interface, question: string): Promise<string> {
  // A stream that already ended (an earlier prompt read it to the end) never says so again.
  if (input.readableEnded) return Promise.resolve("");
  const rl = open();
  return new Promise<string>((resolve) => {
    rl.question(question, resolve);
    rl.once("line", resolve);
    rl.once("close", () => resolve(""));
  }).finally(() => rl.close());
}

/** The parts of `process` the CLI uses, so tests can pass a stand-in. */
export type Proc = {
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable;
  platform: string;
  pid: number;
  ppid: number;
  getuid?: () => number;
  cwd(): string;
  once(signal: "SIGINT" | "SIGTERM" | "SIGHUP", cb: () => void): unknown;
  on(event: "unhandledRejection", cb: (reason: unknown) => void): unknown;
};

export function processIo(
  proc: Proc,
  machine: { homedir: () => string; hostname: () => string; kill: (pid: number, signal: 0) => void; wim: () => string[] } = { homedir, hostname, kill: (pid, s) => void process.kill(pid, s), wim: wimCommand },
): CliIO {
  const stop = new AbortController();
  // Ctrl-C, a kill, or the terminal going away (SIGHUP) all end the command cleanly.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) proc.once(signal, () => stop.abort());
  const parent = proc.ppid;
  // A stray rejection must not take down a long-running server (an MCP server the agent relies
  // on): it is reported on stderr instead.
  proc.on("unhandledRejection", (reason) => void proc.stderr.write(`wim: unexpected error: ${reason instanceof Error ? reason.message : String(reason)}\n`));
  return {
    out: (line) => void proc.stdout.write(`${line}\n`),
    // `wim mcp` owns stdout for the protocol, so diagnostics always go to stderr.
    err: (line) => void proc.stderr.write(`${line}\n`),
    prompt: (question) => ask(proc.stdin, () => createInterface({ input: proc.stdin, output: proc.stderr }), question),
    // The question goes to stderr; what is typed is echoed nowhere (readline writes it to a sink).
    promptSecret: async (question) => {
      proc.stderr.write(question);
      const answer = await ask(proc.stdin, () => createInterface({ input: proc.stdin, output: new Writable({ write: (_chunk, _enc, done) => done() }), terminal: true }), "");
      proc.stderr.write("\n");
      return answer;
    },
    startAgent: (passphrase) => spawnDetached([...machine.wim(), "agent", "serve"], passphrase),
    signal: stop.signal,
    cwd: proc.cwd(),
    homedir: machine.homedir(),
    hostname: machine.hostname(),
    platform: proc.platform,
    uid: proc.getuid?.(),
    pid: proc.pid,
    now: Date.now,
    stdin: proc.stdin,
    stdout: proc.stdout,
    isTTY: proc.stdout.isTTY === true,
    inputIsTTY: proc.stdin.isTTY === true,
    fetch: globalThis.fetch,
    // Orphaned children are re-parented, so a changed ppid means the parent died.
    parentGone: () => proc.ppid !== parent || !pidAlive(parent, machine.kill),
  };
}
