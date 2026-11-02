// Showing a recovery code (SPEC section 4a, revision 4 H2), or an `--auto` invite code: only on
// an interactive terminal and never where an agent is driving the command. Otherwise the code
// waits in this process's memory for up to 10 minutes, for `wim recovery show` (or `wim invite
// show`) run by the person in their own terminal.

import { b64u, LIMITS, randomBytes, sha256, utf8 } from "@worldinmotion/protocol";
import { timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { pathFor, type Platform } from "./platform.ts";

/**
 * Variables that agent CLIs set in the commands they run. Claude Code sets several in every shell
 * it starts (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, and the socket of its
 * messaging bridge, `CLAUDE_CODE_MESSAGING_SOCKET`); `AI_AGENT` is a cross-vendor marker. There is
 * no `CLAUDE_CODE_` prefix match: people export settings such as `CLAUDE_CODE_USE_BEDROCK` in
 * their own shell profile, and that terminal is still theirs.
 */
export const AGENT_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "AI_AGENT",
  "GEMINI_CLI",
  "CURSOR_AGENT",
  "CURSOR_TRACE_ID",
  "OPENCODE",
  "AIDER_MODEL",
  "ANTIGRAVITY_AGENT",
  "WIM_AGENT",
];
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
  CLAUDE_CODE_SESSION_ID: "Claude Code",
  CLAUDE_CODE_MESSAGING_SOCKET: "Claude Code",
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
  return cannotConfirm(env, io) === undefined;
}

/** Why a confirmation cannot be taken here (`canConfirm`), or undefined when it can. */
export function cannotConfirm(env: Record<string, string | undefined>, io: { isTTY: boolean; inputIsTTY: boolean }): string | undefined {
  return notAPerson(env, io.isTTY) ?? (io.inputIsTTY ? undefined : "this command's input is not an interactive terminal (it is piped or redirected)");
}

/** The recovery code display window, in minutes, for messages. */
export const SHOW_WINDOW_MINUTES = LIMITS.recoveryShowWindowMs / 60_000;

/** The codes a person collects with a show command. */
export type ShowKind = "recovery" | "invite";

/**
 * Where a held code is offered: a Unix socket in the private state directory, or a named pipe on
 * Windows; and the proof file next to the state, which a reader must read and send back first.
 */
export type ShowPaths = { socket: string; proof: string; what: string };

export function showPaths(home: string, platform: Platform, kind: ShowKind = "recovery"): ShowPaths {
  const p = pathFor(platform);
  const socket = platform === "win32" ? `\\\\.\\pipe\\wim-${kind}-${b64u.encode(sha256(utf8(home))).slice(0, 16)}` : p.join(home, `${kind}.sock`);
  return { socket, proof: p.join(home, `${kind}.proof`), what: `${kind} code` };
}

/** How long a connection may take to send its proof before it is dropped. */
export const PROOF_WAIT_MS = 5_000;
/** The longest proof line read: a proof is 43 characters. */
const PROOF_MAX = 128;

function ignore(): void {}
/** A file that cannot be read reads as absent. */
const absent = (): undefined => undefined;

/** Removes the proof file if it is still this holder's (a later holder may have replaced it). */
async function removeOwnProof(path: string, proof: string): Promise<void> {
  if ((await fs.readFile(path, "utf8").catch(absent)) === proof) await fs.rm(path, { force: true });
}

export type HoldOptions = { ms: number; signal: AbortSignal; platform: Platform; onListening?: () => void; proofWaitMs?: number };

/**
 * Holds `code` for one show command within `o.ms`. Resolves true when it was handed over, false
 * when the window closed or `o.signal` aborted. The code itself is never written to disk.
 *
 * Only a reader that can read the state directory gets it: a random proof is written there, owner
 * only (the 0700 home on POSIX, the user profile on Windows), and a connection must send it back
 * before anything is sent. That matters on Windows, where the pipe's name can be guessed and Node
 * cannot restrict who opens it. A connection with a wrong proof, none, or too long a line is
 * dropped without ending the window, so another user cannot use it up or lock the person out. The
 * proof is removed when the window ends.
 */
export async function holdForShow(paths: ShowPaths, code: string, o: HoldOptions): Promise<boolean> {
  if (o.platform !== "win32") await fs.rm(paths.socket, { force: true });
  const proof = b64u.encode(randomBytes(32));
  const expected = sha256(utf8(proof));
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", ignore);
    socket.setTimeout(o.proofWaitMs ?? PROOF_WAIT_MS, () => socket.destroy());
    socket.setEncoding("utf8");
    let line = "";
    socket.on("data", (d: string) => {
      line += d;
      const end = line.indexOf("\n");
      if (end === -1) {
        if (line.length > PROOF_MAX) socket.destroy();
        return;
      }
      // Compared as hashes: equal lengths for timingSafeEqual, and in constant time.
      if (timingSafeEqual(sha256(utf8(line.slice(0, end))), expected)) server.emit("proved", socket);
      else socket.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(paths.socket, resolve);
  });
  try {
    // The proof exists only while this process holds the socket or pipe, so it is never sent to
    // a listener that took the name first.
    await fs.rm(paths.proof, { force: true });
    await fs.writeFile(paths.proof, proof, { mode: 0o600, flag: "wx" });
  } catch (error) {
    await new Promise((r) => server.close(r));
    throw error;
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), o.ms);
    const onAbort = (): void => finish(false);
    function finish(handed: boolean): void {
      clearTimeout(timer);
      o.signal.removeEventListener("abort", onAbort);
      server.removeAllListeners("proved");
      // No reader is taken after this, even one that read the proof just before it is removed,
      // and every other reader still connected is dropped.
      const closed = new Promise((r) => server.close(r));
      for (const s of sockets) s.destroy();
      void Promise.all([closed, removeOwnProof(paths.proof, proof)]).then(() => resolve(handed));
    }
    server.once("proved", (socket: Socket) => {
      sockets.delete(socket);
      socket.end(`${code}\n`);
      finish(true);
    });
    o.signal.addEventListener("abort", onAbort, { once: true });
    (o.onListening ?? ignore)();
  });
}

/** Fetches a code held by `holdForShow`, proving first that this reader can read the state directory. */
export async function fetchHeldCode(paths: ShowPaths): Promise<string> {
  const none = `no ${paths.what} is waiting (it is offered for at most ${SHOW_WINDOW_MINUTES} minutes after it is made)`;
  const proof = await fs.readFile(paths.proof, "utf8").catch(absent);
  if (proof === undefined) throw new Error(none);
  return new Promise((resolve, reject) => {
    let text = "";
    const socket = createConnection(paths.socket);
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => (text += d));
    socket.once("error", () => reject(new Error(none)));
    socket.once("end", () => (text.trim() === "" ? reject(new Error(`no ${paths.what} is waiting`)) : resolve(text.trim())));
    socket.write(`${proof}\n`);
  });
}
