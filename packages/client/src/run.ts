// `wim run <agent>`: a hosted session (docs/peers.md, hosted sessions; SECURITY-MODEL section 7.8).
// wim starts the agent as an Agent Client Protocol server over stdio and is its client, so it can
// give an idle session a turn, which no agent offers to a session the person opened themselves.
//
// - `initialize` offers no client capability: no file system, no terminal. wim runs nothing for
//   the agent.
// - `session/new` hands the agent the worldinmotion MCP server under a name new for each run,
//   `worldinmotion<10 random hex digits>`, with `WIM_SESSION_KEY=run:<random>`, so the runner finds
//   that session by its key, and `WIM_HOSTED=1`, so it offers only `inbox`, `send`, `reply` and
//   `peers` (mcp.ts HOSTED_TOOLS). wim never sets a session mode and passes no flag that loosens
//   the agent's own permissions. Gemini CLI is also told to start no other MCP server
//   (`--allowed-mcp-server-names`), so a worldinmotion entry in its settings does not open a second
//   session; it then allows that server's tools without asking, which is why the server offers
//   only those four.
// - Wake: while no `session/prompt` is in flight and the shared wake predicate (wake.ts) finds
//   something new, the session is marked `busy-mesh`, then one `session/prompt` carries the fixed
//   line (a count and "call inbox", and that no one reads a hosted session's chat, so an answer
//   goes through reply or send), and its stop reason writes a turn mark, `idle <n>`. One prompt
//   at a time: what arrives during a turn is announced when it ends.
// - A `session/request_permission` for worldinmotion's own `inbox`, `send`, `reply` or `peers` on
//   the server this run handed over is allowed with the agent's `allow_once` option (never an
//   "always" one), and said on stderr. Every other request is refused: with the agent's
//   `reject_once` option, or, when it offers none, by cancelling the turn and answering
//   `cancelled`. The person is told which tool, by its name only.
// - Ctrl-C cancels a running turn, then closes the agent; its `wim mcp` then goes offline.
//
// The runner sees the agent's whole ACP stream. It shows the agent's replies on stdout, keeps none
// of it on disk, and sends none of it anywhere.

import { b64u, randomBytes, sanitizeForDisplay } from "@worldinmotion/protocol";
import { spawn as nodeSpawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { z } from "zod";
import { ACP_VERSION, geminiMcp, initializeParams, initializeResult, JsonRpc, newSessionResult, permissionRequest, promptResult, RPC, RpcError, sessionUpdate, shaped, textChunk, toolCall, toolStatus } from "./acp.ts";
import { systemProgram, windowsRoot } from "./autostart.ts";
import { writeAtomic, type FsEnv } from "./fsx.ts";
import { HOSTED_TOOLS } from "./mcp.ts";
import type { MeshFiles } from "./mesh.ts";
import type { Platform } from "./platform.ts";
import { SessionFiles, SessionKeys } from "./session.ts";
import { announce, markIdle, waitingIn, wakeText } from "./wake.ts";

/** How often the runner looks for something new while the agent is idle (as the client reads presence). */
export const POLL_MS = 1000;
/** How many idle checks the person's first turn waits for the agent's `wim mcp` to open its session, so the turn can be marked. */
export const OPEN_TRIES = 10;
/** How long a cancelled turn may take to end before the agent is stopped. */
export const CANCEL_MS = 5000;
/** How long the agent may take to exit once its input is closed, and again after it is killed. */
export const EXIT_MS = 3000;
/** The agent's last stderr lines kept, to show when it exits on its own. */
const STDERR_KEPT = 20;
/** The characters of one stderr line kept and shown. */
const STDERR_LINE = 500;
/** Reply text held before it is shown without its line end. */
const TEXT_HELD = 64 * 1024;
/** Tool calls whose names are kept for a later permission request. */
const TOOLS_KEPT = 1024;

/**
 * The tools of its own server a hosted session allows without asking: reading the inbox, sending,
 * replying and listing peers. Not `wait` (it blocks a turn) and not `history`, nor any other: the
 * server handed over offers only these (mcp.ts HOSTED_TOOLS).
 */
export const OWN_TOOLS: readonly string[] = HOSTED_TOOLS;

/**
 * What a hosted session's wake line adds to the shared one (wake.ts): no person reads the agent's
 * chat there, so an answer that stays in it reaches no one. Fixed text, like the rest of the line.
 */
export const HOSTED_ANSWER = "No one reads this hosted session's chat: answer a message or a task with the worldinmotion reply tool and its id, or write to a session with send.";

/** The line a hosted session is woken with. */
export function hostedWakeText(messages: number, notices = 0): string {
  return `${wakeText(messages, notices)} ${HOSTED_ANSWER}`;
}

/** The stop reasons ACP version 1 defines. */
const STOP_REASONS: readonly string[] = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"];

/** The agent's process, as the runner uses it. */
export type AgentProcess = {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  /** Resolves once the process has exited, saying how ("exit code 1"). */
  exited: Promise<string>;
  /** Stops it (SIGTERM); `force`: outright (SIGKILL). */
  kill(force?: boolean): void;
};

/** An agent `wim run` hosts (agentsetup.ts ACP_AGENTS). */
export type HostedAgent = { name: string; title: string; kind: string; command: readonly string[] };

export type RunOptions = {
  agent: HostedAgent;
  /** Starts the agent's ACP command; `server` is the name of the worldinmotion server this run hands over. */
  start: (server: string) => AgentProcess;
  mesh: MeshFiles;
  /** The mesh's id and the state directory, handed to the agent's `wim mcp`. */
  meshId: string;
  home: string;
  /** What runs this wim (node and its script, absolute): the agent starts `wim mcp` with it. */
  wim: readonly string[];
  fsEnv: FsEnv;
  cwd: string;
  /** The person's first turn, if any. */
  prompt?: string;
  now: () => number;
  delay: (ms: number) => Promise<void>;
  signal: AbortSignal;
  out: (line: string) => void;
  err: (line: string) => void;
  /** `WIM_DEBUG=1`: why each check did not wake, and the agent's stderr as it comes. */
  debug: boolean;
  version: string;
  /** The session key's random part (tests); otherwise 16 random bytes. */
  key?: string;
  /** The server name's random part (tests); otherwise 10 random hex digits. */
  tag?: string;
};

/** Runs one hosted session until Ctrl-C or the agent ends. 0 after Ctrl-C; 1 when the agent ended or failed. */
export function runHosted(o: RunOptions): Promise<number> {
  return new Hosted(o).run();
}

/** A timer that does not keep the process alive. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => void setTimeout(resolve, ms).unref());
}

/** How to start `file`: npm's Windows shims (`.cmd`, `.bat`) run only through the shell. */
export function spawnPlan(file: string, args: readonly string[], platform: Platform): { command: string; args: string[]; shell: boolean } {
  // The arguments are wim's own fixed words from the agent table, never anything typed or received.
  if (platform === "win32" && /\.(cmd|bat)$/i.test(file)) return { command: `"${file}"`, args: [...args], shell: true };
  return { command: file, args: [...args], shell: false };
}

/**
 * Starts the agent with pipes for stdio. On POSIX it gets its own process group, so the Ctrl-C
 * the terminal sends reaches only wim, which cancels the turn and closes the agent itself.
 */
export function startAcpAgent(
  file: string,
  args: readonly string[],
  o: { env: Record<string, string | undefined>; cwd: string; platform: Platform },
  spawn: typeof nodeSpawn = nodeSpawn,
  signalGroup: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => void process.kill(-pid, signal),
): AgentProcess {
  const plan = spawnPlan(file, args, o.platform);
  const child = spawn(plan.command, plan.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], shell: plan.shell, windowsHide: true, detached: o.platform !== "win32" });
  const exited = new Promise<string>((resolve) => {
    child.once("error", (error) => resolve(`it could not be started: ${error.message}`));
    child.once("exit", (code, signal) => resolve(signal === null ? `exit code ${code}` : `signal ${signal}`));
  });
  // On POSIX the agent leads its own process group: stopping it stops what it started too (its
  // `wim mcp`, a tool's process). With no group (never started, or gone already), the child alone.
  // On Windows `taskkill /T` stops the tree (an npm `.cmd` shim runs the agent under a shell).
  const kill = (force = false): void => {
    const signal = force ? "SIGKILL" : "SIGTERM";
    if (o.platform === "win32" && child.pid !== undefined) {
      // By its path in System32, never looked up (autostart.ts, systemProgram).
      spawn(systemProgram("taskkill", windowsRoot(o.env["SystemRoot"])), ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
    } else if (child.pid !== undefined) {
      try {
        signalGroup(child.pid, signal);
        return;
      } catch {
        // No such group any more.
      }
    }
    child.kill(signal);
  };
  return { stdin: child.stdin!, stdout: child.stdout!, stderr: child.stderr!, exited, kill };
}

/** What a tool call says about its tool: its name (null: one wim cannot read) and kind, as the agent stated them. */
type Named = { name?: string | null | undefined; kind?: string | undefined };

/** How a tool is named to the person: its programmatic name, else its kind; never its title or input. */
function toolLabel(call: Named): string | undefined {
  if (typeof call.name === "string") return `\`${call.name}\``;
  return call.kind === undefined ? undefined : `a tool of kind ${call.kind}`;
}

/** An MCP tool as Gemini CLI records it (`_meta`), when both names are plain identifiers. */
function mcpLabel(meta: unknown): string | undefined {
  const g = geminiMcp.safeParse(meta);
  if (!g.success) return undefined;
  const { server_name: server, tool_name: tool } = g.data["gemini-cli"].mcp;
  return plainName.test(server) && plainName.test(tool) ? `\`${tool}\` on the MCP server \`${server}\`` : undefined;
}

/** A name shown to the person as it is: a plain identifier. */
const plainName = /^[A-Za-z0-9_.:/-]{1,64}$/;

/**
 * Which of worldinmotion's own tools (OWN_TOOLS) a permission request is for, on the server named
 * `server` that this run handed over; undefined for anything else. ACP version 1 carries no server
 * identity, so wim reads what each agent states, and every statement must agree:
 * - Gemini CLI: `_meta["gemini-cli"].mcp`, the server's configured name and the tool's own name;
 * - Antigravity CLI (and an agent that names tools the same way): the tool's name,
 *   `mcp_<server>_<tool>`, in the request and in the earlier tool call with the same id (a
 *   Gemini CLI `_meta` is read from the request only).
 * At least one must name an own tool of `server`, and none may name anything else. The server's
 * name is new for each run, so a server configured in the agent's settings cannot take it.
 */
export function ownTool(raw: unknown, server: string, earlier: string | null | undefined): string | undefined {
  const call = toolCall.safeParse((raw as { toolCall?: unknown } | null)?.toolCall);
  if (!call.success) return undefined;
  const claims: Array<string | undefined> = [];
  const meta = call.data._meta;
  if (typeof meta === "object" && meta !== null && "gemini-cli" in meta) {
    const g = geminiMcp.safeParse(meta);
    claims.push(g.success && g.data["gemini-cli"].mcp.server_name === server && OWN_TOOLS.includes(g.data["gemini-cli"].mcp.tool_name) ? g.data["gemini-cli"].mcp.tool_name : undefined);
  }
  // A name in the request and one in its earlier tool call are each a claim, even one wim cannot
  // read (a name that is not a plain identifier).
  const own = (name: string | null | undefined): string | undefined => OWN_TOOLS.find((t) => name === `mcp_${server}_${t}`);
  if (Object.hasOwn(call.data, "name")) claims.push(own(call.data.name));
  if (earlier !== undefined) claims.push(own(earlier));
  if (claims.length === 0 || claims.includes(undefined) || new Set(claims).size !== 1) return undefined;
  return claims[0];
}

/** Text an agent chose, as one terminal line shows it: controls escaped visibly, newlines too. */
const shown = (text: string, max: number): string => sanitizeForDisplay(text).replace(/\n/g, "<U+000A>").slice(0, max);

class Hosted {
  private readonly o: RunOptions;
  /** `WIM_SESSION_KEY` for the agent's `wim mcp`. */
  private readonly sessionKey: string;
  /** The name of the worldinmotion server handed over: new for each run. */
  private readonly server: string;
  private proc!: AgentProcess;
  private rpc!: JsonRpc;
  private sessionId: string | undefined;
  private files: SessionFiles | undefined;
  /** The `session/prompt` in flight; at most one. */
  private inFlight: Promise<unknown> | undefined;
  private stopping = false;
  private exited = false;
  private wakeStop!: () => void;
  private readonly stopped: Promise<void>;
  private readonly tools = new Map<string, Named>();
  private text = "";
  private readonly stderrTail: string[] = [];
  private stderrDone!: Promise<void>;

  constructor(o: RunOptions) {
    this.o = o;
    this.sessionKey = `run:${o.key ?? b64u.encode(randomBytes(16))}`;
    this.server = `worldinmotion${o.tag ?? Array.from(randomBytes(5), (b) => b.toString(16).padStart(2, "0")).join("")}`;
    this.stopped = new Promise((resolve) => (this.wakeStop = resolve));
  }

  async run(): Promise<number> {
    const o = this.o;
    this.proc = o.start(this.server);
    this.rpc = new JsonRpc(this.proc.stdout, this.proc.stdin, { request: (m, p) => this.request(m, p), notification: (m, p) => this.notification(m, p) }, (line) => this.debug(line));
    this.readStderr();
    // A child's `exit` can come before the last of its output: read on until that ends, for a few
    // seconds at most (a process it left behind may hold the output open).
    void this.proc.exited.then(async () => {
      this.exited = true;
      await Promise.race([this.rpc.closed, this.o.delay(EXIT_MS)]);
      this.rpc.close();
    });
    const onAbort = (): void => this.stop();
    o.signal.addEventListener("abort", onAbort, { once: true });
    if (o.signal.aborted) this.stop();
    try {
      const init = shaped(initializeResult, await this.rpc.request("initialize", initializeParams(o.version)), "initialize answer");
      if (init.protocolVersion !== ACP_VERSION) throw new Error(`${o.agent.title} speaks ACP version ${init.protocolVersion}; wim run speaks version ${ACP_VERSION}`);
      const created = shaped(newSessionResult, await this.rpc.request("session/new", { cwd: o.cwd, mcpServers: [this.mcpServer()] }), "session/new answer");
      this.sessionId = created.sessionId;
      o.out(`wim run: ${o.agent.title} runs as a hosted session (Ctrl-C to stop). It gets a turn when messages from devices you trust wait in worldinmotion, and wim allows only worldinmotion's own inbox, send, reply and peers: it refuses every other permission request.`);
      if (o.prompt !== undefined) await this.firstTurn(o.prompt);
      await this.loop();
      return this.stopping ? 0 : await this.gone();
    } catch (error) {
      if (this.stopping) return 0;
      if (this.rpc.isClosed) return await this.gone();
      o.err(`wim run: ${this.problem(error)}`);
      return 1;
    } finally {
      o.signal.removeEventListener("abort", onAbort);
      await this.shutdown();
    }
  }

  /**
   * The person's first turn, once the agent's `wim mcp` has opened its session (it starts while the
   * agent sets up the session, and may open it a moment later), so the turn reads `busy`. After
   * OPEN_TRIES checks it runs anyway, unmarked.
   */
  private async firstTurn(text: string): Promise<void> {
    for (let i = 0; i < OPEN_TRIES; i++) {
      if (typeof (await this.session().catch(() => "unreadable")) !== "string") break;
      await Promise.race([this.o.delay(POLL_MS), this.stopped, this.rpc.closed, this.proc.exited]);
      if (this.stopping || this.rpc.isClosed || this.exited) return;
    }
    // An agent that exited while its session opened gets no turn.
    if (this.exited) return;
    await this.turn(text, false);
  }

  /** Wakes the agent whenever something new may, one turn at a time, until Ctrl-C or the agent ends. */
  private async loop(): Promise<void> {
    // Once the process has exited no turn is asked for, though its last output is still read.
    while (!this.stopping && !this.rpc.isClosed && !this.exited) {
      const due = await this.due();
      if (this.stopping || this.rpc.isClosed || this.exited) {
        // Marked `busy-mesh` for a turn that is now never asked for: the mark ends it.
        if (typeof due !== "string") await this.mark("idle");
        return;
      }
      if (typeof due !== "string") {
        await this.turn(due.text, true);
        continue;
      }
      this.debug(`wim run: no wake: ${due}`);
      await Promise.race([this.o.delay(POLL_MS), this.stopped, this.rpc.closed, this.proc.exited]);
    }
  }

  /**
   * The wake line when something new may wake, with the session already marked `busy-mesh`
   * (wake.ts announce); otherwise why not. Any doubt (a session not found, a file that cannot be
   * read) means no wake.
   */
  private async due(): Promise<{ text: string } | string> {
    try {
      const files = await this.session();
      if (typeof files === "string") return files;
      const now = this.o.now();
      const waiting = await waitingIn(this.o.mesh, files, this.o.fsEnv, now);
      if (waiting === undefined) return "nothing waiting";
      const why = await announce(files, `run\0${this.sessionKey}`, waiting.newest, now, this.o.fsEnv);
      return why ?? { text: hostedWakeText(waiting.messages, waiting.notices) };
    } catch (error) {
      return `cannot tell: ${(error as Error).message}`;
    }
  }

  /** The session the agent's `wim mcp` opened under this run's key, while that `wim mcp` runs. */
  private async session(): Promise<SessionFiles | string> {
    if (this.files === undefined) {
      const known = await new SessionKeys(this.o.mesh, this.o.fsEnv, this.o.now).lookup(`key:${this.sessionKey}`);
      if (known === undefined) return "the agent's wim mcp has not opened its session yet";
      this.files = new SessionFiles(this.o.mesh, known.sid, this.o.fsEnv);
    }
    return (await this.files.isLiveElsewhere()) ? this.files : "the session's wim mcp is not running";
  }

  /**
   * One prompt turn. A mesh turn was marked `busy-mesh` before it was asked for; the person's own
   * first turn is marked `busy`. Whatever ends it writes a turn mark.
   */
  private async turn(text: string, mesh: boolean): Promise<void> {
    if (!mesh) await this.mark("busy");
    const sent = this.rpc.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] });
    this.inFlight = sent;
    try {
      this.ended(shaped(promptResult, await sent, "session/prompt answer").stopReason);
    } catch (error) {
      if (!this.rpc.isClosed) this.o.err(`wim run: the turn ended with an error: ${this.problem(error)}`);
    } finally {
      this.inFlight = undefined;
      this.flushText();
      await this.mark("idle");
    }
  }

  /** Writes the session's presence, when its session is known: `busy`, or a turn mark. */
  private async mark(status: "busy" | "idle"): Promise<void> {
    const files = this.files ?? (await this.session().catch((error: unknown) => `cannot tell: ${(error as Error).message}`));
    const write = typeof files === "string" ? Promise.reject(new Error(files)) : status === "busy" ? writeAtomic(files.presencePath, "busy", this.o.fsEnv) : markIdle(files, this.o.now(), this.o.fsEnv);
    await write.catch((error: unknown) => this.debug(`wim run: presence not written: ${(error as Error).message}`));
  }

  private ended(reason: string): void {
    const how = STOP_REASONS.includes(reason) ? reason : "with a stop reason ACP does not define";
    if (reason === "end_turn" || (reason === "cancelled" && this.stopping)) return this.debug(`wim run: the agent ended its turn: ${how}`);
    this.o.err(`wim run: the turn ended: ${how}`);
  }

  /** Ctrl-C: a running turn is cancelled (and the agent stopped if it does not end in time); otherwise the run ends now. */
  private stop(): void {
    // Called once: by the abort listener, or at the start for a signal already aborted.
    this.stopping = true;
    this.wakeStop();
    if (this.inFlight === undefined) return this.rpc.close();
    this.cancelTurn();
    this.debug("wim run: Ctrl-C: sent session/cancel");
    void this.o.delay(CANCEL_MS).then(() => {
      if (this.inFlight === undefined) return;
      this.o.err(`wim run: ${this.o.agent.title} did not end the cancelled turn within ${CANCEL_MS / 1000} seconds, so wim stopped it`);
      this.proc.kill();
    });
  }

  private cancelTurn(): void {
    if (this.inFlight !== undefined) this.rpc.notify("session/cancel", { sessionId: this.sessionId });
  }

  /** Closes the agent's input, then waits for it to exit, and kills it if it does not. */
  private async shutdown(): Promise<void> {
    this.flushText();
    this.rpc.close();
    this.proc.stdin.end();
    if (this.exited) return;
    const how = await Promise.race([this.proc.exited, this.o.delay(EXIT_MS).then(() => undefined)]);
    if (how !== undefined) return;
    this.debug(`wim run: ${this.o.agent.title} did not exit within ${EXIT_MS / 1000} seconds of its input closing: stopping it`);
    this.proc.kill();
    const killed = await Promise.race([this.proc.exited, this.o.delay(EXIT_MS).then(() => undefined)]);
    if (killed !== undefined) return;
    this.debug(`wim run: ${this.o.agent.title} did not exit within ${EXIT_MS / 1000} seconds of being stopped: killing it`);
    this.proc.kill(true);
  }

  /** The agent ended its connection without Ctrl-C: say how, with its last stderr lines. */
  private async gone(): Promise<number> {
    const how = await Promise.race([this.proc.exited, this.o.delay(EXIT_MS).then(() => undefined)]);
    // Its last output and stderr lines may still be on their way.
    if (how !== undefined) await Promise.race([Promise.all([this.stderrDone, this.rpc.closed]), this.o.delay(EXIT_MS)]);
    this.o.err(`wim run: ${this.o.agent.title} ended its ACP connection (${how ?? "it is still running"})${this.stderrTail.length === 0 ? "." : ". Its last lines on stderr:"}`);
    for (const line of this.stderrTail) this.o.err(`  ${line}`);
    return 1;
  }

  private problem(error: unknown): string {
    if (!(error instanceof RpcError)) return (error as Error).message;
    if (error.code === RPC.authRequired) return `${this.o.agent.title} asks you to sign in first (it said: ${shown(error.message, 200)}): run \`${this.o.agent.command[0]!}\` yourself, sign in, then run wim run again`;
    return `${this.o.agent.title} answered with error ${error.code}: ${shown(error.message, 300)}`;
  }

  /** The worldinmotion MCP server the agent starts for this session: this wim, its state directory and mesh, and the run's key. */
  private mcpServer(): Record<string, unknown> {
    const o = this.o;
    const env = { WIM_HOME: o.home, WIM_MESH: o.meshId, WIM_KIND: o.agent.kind, WIM_SESSION_KEY: this.sessionKey, WIM_HOSTED: "1" };
    return { name: this.server, command: o.wim[0], args: [...o.wim.slice(1), "mcp"], env: Object.entries(env).map(([name, value]) => ({ name, value })) };
  }

  /** The agent's requests: a permission request is answered (`permit`); every other client method is one this client does not offer. */
  private async request(method: string, params: unknown): Promise<unknown> {
    if (method === "session/request_permission") return this.permit(params);
    this.debug(`wim run: answered the agent's ${shown(method, 64)} request with "method not found": a hosted session offers no client methods`);
    throw new RpcError(RPC.methodNotFound, "this client offers no such method");
  }

  /**
   * Allows a request for one of worldinmotion's own tools on this run's server with the agent's
   * `allow_once` option, and says so; refuses every other request, and an own tool's request that
   * offers no `allow_once`.
   */
  private permit(params: unknown): unknown {
    const req = permissionRequest.safeParse(params);
    const earlier = req.success ? this.tools.get(req.data.toolCall.toolCallId)?.name : undefined;
    const own = ownTool(params, this.server, earlier);
    const allow = own === undefined || !req.success ? undefined : req.data.options.find((x) => x.kind === "allow_once");
    if (allow === undefined) return this.refuse(params);
    this.o.err(`wim run: allowed ${this.o.agent.title}'s request to use worldinmotion's own \`${own!}\` tool (a hosted session allows only worldinmotion's inbox, send, reply and peers).`);
    return { outcome: { outcome: "selected", optionId: allow.optionId } };
  }

  /**
   * Refuses a permission request: the agent's `reject_once` option when it offers
   * one; otherwise the running turn is cancelled and the answer is `cancelled`, which ACP allows
   * then. A request wim cannot read is treated as one with no `reject_once`. Nothing here ever
   * selects any other option.
   */
  private refuse(params: unknown): unknown {
    const req = permissionRequest.safeParse(params);
    const earlier = req.success ? this.tools.get(req.data.toolCall.toolCallId) : undefined;
    const tool = req.success ? (toolLabel({ name: req.data.toolCall.name }) ?? (earlier === undefined ? undefined : toolLabel(earlier)) ?? mcpLabel(req.data.toolCall._meta) ?? toolLabel({ kind: req.data.toolCall.kind }) ?? "a tool") : "a tool";
    const title = this.o.agent.title;
    this.o.err(`wim run: refused ${title}'s request to use ${tool}. A hosted session allows only worldinmotion's own inbox, send, reply and peers: allow any other tool a hosted worker may use without asking in ${title}'s own configuration (docs/peers.md, hosted sessions).`);
    const reject = req.success ? req.data.options.find((x) => x.kind === "reject_once") : undefined;
    if (reject !== undefined) return { outcome: { outcome: "selected", optionId: reject.optionId } };
    this.cancelTurn();
    return { outcome: { outcome: "cancelled" } };
  }

  /** The agent's replies are shown; tool calls are remembered by name for a later permission request. */
  private notification(method: string, params: unknown): void {
    const u = method === "session/update" ? sessionUpdate.safeParse(params) : undefined;
    if (u?.success !== true) return;
    const update = u.data.update;
    if (update.sessionUpdate === "agent_message_chunk") {
      const chunk = textChunk.safeParse(update);
      if (chunk.success) this.say(chunk.data.content.text);
      return;
    }
    const call = update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update" ? toolCall.safeParse(update) : undefined;
    if (call?.success !== true) return;
    // A `tool_call_update` carries only the fields that changed: keep what an earlier one said.
    // A name the update carries but wim cannot read replaces the earlier one with one that matches nothing.
    const known = this.tools.get(call.data.toolCallId);
    const named: Named = { name: Object.hasOwn(update, "name") ? (call.data.name ?? null) : known?.name, kind: call.data.kind ?? known?.kind };
    // WIM_DEBUG=1: what the agent's tools did, by name or kind only (a title can carry the input).
    const status = toolStatus.safeParse((update as { status?: unknown }).status);
    if (status.success) this.debug(`wim run: tool call: ${toolLabel(named) ?? "a tool wim cannot name"}, ${status.data}`);
    if (toolLabel(call.data) === undefined && !Object.hasOwn(update, "name")) return;
    if (known === undefined && this.tools.size >= TOOLS_KEPT) this.tools.delete(this.tools.keys().next().value!);
    this.tools.set(call.data.toolCallId, named);
  }

  private say(text: string): void {
    const lines = (this.text + text).split("\n");
    this.text = lines.pop()!;
    for (const line of lines) this.o.out(sanitizeForDisplay(line));
    if (this.text.length > TEXT_HELD) this.flushText();
  }

  private flushText(): void {
    if (this.text !== "") this.o.out(sanitizeForDisplay(this.text));
    this.text = "";
  }

  /** The agent's stderr: always read (a full pipe would stall it), shown with WIM_DEBUG=1, the last lines kept. */
  private readStderr(): void {
    const decoder = new StringDecoder("utf8");
    let part = "";
    this.proc.stderr.on("data", (chunk: Buffer) => {
      const lines = (part + decoder.write(chunk)).split("\n");
      part = lines.pop()!.slice(0, STDERR_LINE * 4);
      for (const line of lines) this.stderrLine(line);
    });
    this.stderrDone = new Promise((resolve) =>
      this.proc.stderr.once("end", () => {
        if (part !== "") this.stderrLine(part);
        resolve();
      }),
    );
  }

  private stderrLine(line: string): void {
    const text = shown(line.replace(/\r$/, ""), STDERR_LINE);
    this.stderrTail.push(text);
    if (this.stderrTail.length > STDERR_KEPT) this.stderrTail.shift();
    this.debug(`${this.o.agent.name}: ${text}`);
  }

  private debug(line: string): void {
    if (this.o.debug) this.o.err(line);
  }
}
