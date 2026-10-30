// Showing a recovery code (SPEC section 4a, revision 4 H2): only on an interactive terminal and
// never where an agent is driving the command. Otherwise the code waits in this process's memory
// for up to 10 minutes, for `wim recovery show` run by the person in their own terminal.

import { b64u, LIMITS, sha256, utf8 } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { createConnection, createServer } from "node:net";
import { pathFor, type Platform } from "./platform.ts";

/** Variables that agent CLIs set in the commands they run. */
export const AGENT_ENV_VARS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "GEMINI_CLI", "CURSOR_AGENT", "CURSOR_TRACE_ID", "OPENCODE", "AIDER_MODEL", "ANTIGRAVITY_AGENT", "WIM_AGENT"];
export const AGENT_ENV_PREFIXES = ["CODEX_"];

/** The agent variable found in `env`, if any. */
export function agentEnv(env: Record<string, string | undefined>): string | undefined {
  for (const k of AGENT_ENV_VARS) if (env[k] !== undefined && env[k] !== "") return k;
  return Object.keys(env).find((k) => AGENT_ENV_PREFIXES.some((p) => k.startsWith(p)) && env[k] !== "");
}

/** Who sets each agent variable, for saying whose shell a command runs in. */
const AGENT_NAMES: Record<string, string> = {
  CLAUDECODE: "Claude Code",
  CLAUDE_CODE_ENTRYPOINT: "Claude Code",
  GEMINI_CLI: "Gemini CLI",
  CURSOR_AGENT: "Cursor",
  CURSOR_TRACE_ID: "Cursor",
  OPENCODE: "opencode",
  AIDER_MODEL: "Aider",
  ANTIGRAVITY_AGENT: "Antigravity",
};

/**
 * Why this command is not a person at their own interactive terminal, or undefined when it is.
 * An agent's variable comes first: it says whose shell this is, which is the cause to fix.
 */
export function notAPerson(env: Record<string, string | undefined>, isTTY: boolean): string | undefined {
  const agent = agentEnv(env);
  if (agent !== undefined) {
    const who = AGENT_NAMES[agent] ?? (agent.startsWith("CODEX_") ? "Codex" : "an AI agent");
    return `${agent} is set: this shell belongs to ${who}`;
  }
  return isTTY ? undefined : "this command's output is not an interactive terminal (it is piped or redirected)";
}

/** The refusal for a person-only step: the cause, then where and what to run instead. */
export function personOnly(why: string, command: string): string {
  return `${why}. Open a terminal yourself (VS Code: Terminal > New Terminal) and run \`${command}\` there`;
}

export function canShowSecret(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  return notAPerson(env, isTTY) === undefined;
}

/**
 * Whether a person can answer a confirmation here: admitting a device by its comparison code, or
 * trusting one (SECURITY-MODEL section 5.6). The rule for a passphrase, plus input from the
 * terminal too: an agent that pipes an answer in (a fifo, a here-string) is not the person.
 */
export function canConfirm(env: Record<string, string | undefined>, io: { isTTY: boolean; inputIsTTY: boolean }): boolean {
  return io.inputIsTTY && canShowSecret(env, io.isTTY);
}

/** The recovery code display window, in minutes, for messages. */
export const SHOW_WINDOW_MINUTES = LIMITS.recoveryShowWindowMs / 60_000;

/** A Unix socket in the private state directory, or a named pipe on Windows. */
export function showSocketPath(home: string, platform: Platform): string {
  if (platform === "win32") return `\\\\.\\pipe\\wim-recovery-${b64u.encode(sha256(utf8(home))).slice(0, 16)}`;
  return pathFor(platform).join(home, "recovery.sock");
}

/**
 * Holds `code` for one `wim recovery show` within `ms`. Resolves true when it was handed over,
 * false when the window closed or `signal` aborted. Nothing is written to disk.
 */
export async function holdForShow(path: string, code: string, ms: number, signal: AbortSignal, platform: Platform, onListening: () => void = () => undefined): Promise<boolean> {
  if (platform !== "win32") await fs.rm(path, { force: true });
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      finish(true);
      socket.end(`${code}\n`);
    });
    // One reader only: Node turns away any connection past the first.
    server.maxConnections = 1;
    const timer = setTimeout(() => finish(false), ms);
    const onAbort = (): void => finish(false);
    function finish(handed: boolean): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      server.close(() => resolve(handed));
    }
    signal.addEventListener("abort", onAbort, { once: true });
    server.once("error", reject);
    server.listen(path, onListening);
  });
}

/** Fetches a code held by `holdForShow`. */
export function fetchHeldCode(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const socket = createConnection(path);
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => (text += d));
    socket.once("error", () => reject(new Error(`no recovery code is waiting (it is offered for ${SHOW_WINDOW_MINUTES} minutes after it is made)`)));
    socket.once("end", () => (text.trim() === "" ? reject(new Error("no recovery code is waiting")) : resolve(text.trim())));
  });
}
