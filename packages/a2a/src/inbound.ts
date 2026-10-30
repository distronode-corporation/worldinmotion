import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { LIMITS } from "@worldinmotion/protocol";
import { z } from "zod";
import { bearerMatches } from "./auth.ts";
import type { MeshPeer, MeshPort, MeshResult } from "./mesh.ts";
import { hostHeaderName, isLoopbackHost, LOOPBACK_NAMES, normalizeHostName } from "./net.ts";
import {
  A2A_VERSION,
  A2AError,
  AGENT_CARD_PATH,
  CancelTaskRequestSchema,
  ErrorCode,
  GetTaskRequestSchema,
  isTerminal,
  ListTasksRequestSchema,
  RpcRequestSchema,
  SendMessageRequestSchema,
  textOf,
  type AgentCard,
  type Message,
  type SendMessageRequest,
  type Task,
  type TaskState,
} from "./spec.ts";
import { TtlStore } from "./store.ts";

/** The largest JSON-RPC request body the gateway reads. */
export const MAX_REQUEST_BYTES = 1024 * 1024;
/** The largest task text: the mesh's message text limit, since the text travels as one. */
export const MAX_TASK_TEXT_BYTES = LIMITS.textBytes;

const GATEWAY_VERSION = "0.1.5";
const EARLY_RESULTS = 64;

export interface InboundOptions {
  mesh: MeshPort;
  /** The bearer token every request must present. */
  token: string;
  /** Default `127.0.0.1`. Anything that is not loopback also needs `allowNonLoopback` and `tls`. */
  host?: string;
  /** Default 0, an ephemeral port. */
  port?: number;
  allowNonLoopback?: boolean;
  /** A PEM certificate chain and key. Serves HTTPS; required for any non-loopback bind. */
  tls?: { cert: string | Buffer; key: string | Buffer };
  /**
   * The host names requests may carry in their `Host` header; others get 421, which stops DNS
   * rebinding. Default `localhost`, `127.0.0.1` and `[::1]`.
   */
  publicHosts?: readonly string[];
  /** The URL the agent card advertises. Default `http(s)://<host>:<port>/`. */
  publicUrl?: string;
  name?: string;
  description?: string;
  /** The peer a message goes to when it names none. Unset means a message must name one. */
  defaultTo?: string;
  /** How long a task may wait for its mesh `result`. Default 5 minutes. */
  taskTimeoutMs?: number;
  /** Tasks kept in memory. Default 1000. */
  maxTasks?: number;
  /** How long a task is kept after its last change. Default 1 hour. */
  taskTtlMs?: number;
  /** Whether the agent card also needs the bearer token. Default true. */
  cardRequiresAuth?: boolean;
  now?: () => number;
  log?: (line: string) => void;
}

interface TaskRecord {
  task: Task;
  peer: string;
  statusMs: number;
  wimId?: string;
  waiters: Set<() => void>;
  timer?: NodeJS.Timeout;
}

const WimMetadata = z.looseObject({
  to: z.string().optional(),
  skill: z.string().optional(),
});

/**
 * The inbound half of the gateway: an A2A server (JSON-RPC binding, protocol 1.0) whose skills
 * are the reachable mesh peers. A message becomes a mesh `task` for one peer, and the A2A task
 * stays working until that peer's `result` comes back.
 */
export class InboundGateway {
  private readonly opts: InboundOptions;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly timeoutMs: number;
  private readonly store: TtlStore<TaskRecord>;
  private readonly byWimId = new Map<string, string>();
  private readonly early = new Map<string, MeshResult>();
  private inflight = 0;
  private server?: Server;
  private cardUrl = "";
  private readonly hosts: ReadonlySet<string>;

  constructor(opts: InboundOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => void process.stderr.write(`${line}\n`));
    this.timeoutMs = opts.taskTimeoutMs ?? 300_000;
    this.store = new TtlStore<TaskRecord>({
      max: opts.maxTasks ?? 1000,
      ttlMs: opts.taskTtlMs ?? 3_600_000,
      now: this.now,
      evictable: (r) => isTerminal(r.task.status.state),
    });
    this.hosts = new Set((opts.publicHosts ?? LOOPBACK_NAMES).map(normalizeHostName));
    opts.mesh.onResult((r) => this.onResult(r));
  }

  /** Starts listening. Returns the address actually bound. */
  async start(): Promise<{ url: string; port: number }> {
    const host = this.opts.host ?? "127.0.0.1";
    const tls = this.opts.tls;
    if (!isLoopbackHost(host)) {
      if (this.opts.allowNonLoopback !== true) {
        throw new Error(`refusing to bind ${host}: set allowNonLoopback to serve beyond loopback`);
      }
      if (tls === undefined) throw new Error(`refusing to bind ${host} without TLS: set tls`);
    }
    // A request that dies mid-body (the client hung up) just ends its socket.
    const onRequest = (req: IncomingMessage, res: ServerResponse) =>
      void this.handle(req, res).catch(() => res.destroy());
    const server: Server =
      tls === undefined ? createServer(onRequest) : createTlsServer({ cert: tls.cert, key: tls.key }, onRequest);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.port ?? 0, host, () => resolve());
    });
    this.server = server;
    const port = (server.address() as AddressInfo).port;
    const urlHost = host.includes(":") ? `[${host}]` : host;
    const url = `${tls === undefined ? "http" : "https"}://${urlHost}:${port}/`;
    this.cardUrl = this.opts.publicUrl ?? url;
    return { url, port };
  }

  async close(): Promise<void> {
    for (const r of this.store.values()) clearTimeout(r.timer);
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const name = hostHeaderName(req.headers.host);
    if (name === undefined || !this.hosts.has(name)) {
      return reply(res, 421, { error: "unknown host" }, { connection: "close" });
    }
    const url = new URL(req.url as string, "http://gateway");
    const authed = bearerMatches(req.headers.authorization, this.opts.token);
    const isCard = url.pathname === AGENT_CARD_PATH;
    if (!authed && !(isCard && this.opts.cardRequiresAuth === false)) {
      return reply(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
    }
    if (isCard) {
      if (req.method !== "GET") return reply(res, 405, { error: "method not allowed" });
      return this.serveCard(res);
    }
    if (url.pathname !== "/") return reply(res, 404, { error: "not found" });
    if (req.method !== "POST") return reply(res, 405, { error: "method not allowed" });
    const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json" && type !== "application/a2a+json") {
      return reply(res, 415, { error: "content type must be application/json" });
    }
    const raw = await readBody(req);
    if (raw === undefined) return reply(res, 413, { error: "request too large" }, { connection: "close" });
    const version = req.headers["a2a-version"] ?? url.searchParams.get("A2A-Version") ?? "";
    reply(res, 200, await this.rpc(raw, String(version).trim(), res));
  }

  private async serveCard(res: ServerResponse): Promise<void> {
    let card: AgentCard;
    try {
      card = await this.card();
    } catch (err) {
      this.log(`a2a: agent card unavailable: ${(err as Error).message}`);
      return reply(res, 503, { error: "mesh unavailable" });
    }
    const body = JSON.stringify(card);
    const etag = `"${createHash("sha256").update(body).digest("base64url")}"`;
    reply(res, 200, card, { "cache-control": "max-age=30", etag });
  }

  /** The gateway's agent card: one skill per reachable mesh peer. */
  async card(): Promise<AgentCard> {
    const peers = await this.reachable();
    return {
      name: this.opts.name ?? "worldinmotion gateway",
      description:
        this.opts.description ??
        "Agent sessions on a worldinmotion mesh. Each skill is one session; a message goes to it as a task from another agent.",
      supportedInterfaces: [
        { url: this.cardUrl, protocolBinding: "JSONRPC", protocolVersion: A2A_VERSION },
      ],
      version: GATEWAY_VERSION,
      capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: peers.map((p) => ({
        id: p.address,
        name: p.address,
        description: `The ${p.kind} session ${p.address} on the mesh. Name it in metadata.worldinmotion.to, or this skill id in metadata.worldinmotion.skill.`,
        tags: ["worldinmotion", p.kind],
        inputModes: ["text/plain"],
        outputModes: ["text/plain"],
      })),
    };
  }

  private async reachable(): Promise<MeshPeer[]> {
    // External A2A agents bridged onto the mesh are not offered back out, which keeps the
    // gateway from relaying A2A to A2A through itself.
    const peers = await this.opts.mesh.peers();
    return peers.filter((p) => p.status !== "offline" && p.kind !== "a2a");
  }

  private async rpc(raw: string, version: string, res: ServerResponse): Promise<unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return rpcError(null, ErrorCode.parse, "Invalid JSON payload");
    }
    const req = RpcRequestSchema.safeParse(parsed);
    if (!req.success) return rpcError(null, ErrorCode.invalidRequest, "Request payload validation error");
    const { id, method, params } = req.data;
    try {
      // Section 3.6.2: an empty version means 0.3, which this gateway does not speak.
      if (version !== A2A_VERSION) {
        throw new A2AError(
          ErrorCode.versionNotSupported,
          `A2A-Version ${version === "" ? "(empty, meaning 0.3)" : version} is not supported; use ${A2A_VERSION}`,
        );
      }
      return { jsonrpc: "2.0", id, result: await this.dispatch(method, params, res) };
    } catch (err) {
      if (err instanceof A2AError) return rpcError(id, err.code, err.message);
      this.log(`a2a: ${method} failed: ${(err as Error).message}`);
      return rpcError(id, ErrorCode.internal, "Internal error");
    }
  }

  private async dispatch(method: string, params: unknown, res: ServerResponse): Promise<unknown> {
    switch (method) {
      case "SendMessage":
        return this.sendMessage(parseParams(SendMessageRequestSchema, params), res);
      case "GetTask": {
        const p = parseParams(GetTaskRequestSchema, params);
        return this.view(this.find(p.id), p.historyLength);
      }
      case "CancelTask":
        return this.cancel(parseParams(CancelTaskRequestSchema, params).id);
      case "ListTasks":
        return this.list(parseParams(ListTasksRequestSchema, params));
      case "SendStreamingMessage":
      case "SubscribeToTask":
        throw new A2AError(ErrorCode.unsupportedOperation, "Streaming is not supported");
      case "GetExtendedAgentCard":
        throw new A2AError(ErrorCode.unsupportedOperation, "There is no extended agent card");
      case "CreateTaskPushNotificationConfig":
      case "GetTaskPushNotificationConfig":
      case "ListTaskPushNotificationConfigs":
      case "DeleteTaskPushNotificationConfig":
        throw new A2AError(ErrorCode.pushNotificationNotSupported, "Push notifications are not supported");
      default:
        throw new A2AError(ErrorCode.methodNotFound, "Method not found");
    }
  }

  private async sendMessage(p: SendMessageRequest, res: ServerResponse): Promise<unknown> {
    const m = p.message;
    if (m.role !== "ROLE_USER") throw invalid("message.role must be ROLE_USER");
    if (p.configuration?.taskPushNotificationConfig !== undefined) {
      throw new A2AError(ErrorCode.pushNotificationNotSupported, "Push notifications are not supported");
    }
    const accepted = p.configuration?.acceptedOutputModes ?? [];
    if (accepted.length > 0 && !accepted.some((mode) => /^(text\/plain|text\/\*|\*\/\*)$/i.test(mode))) {
      throw new A2AError(ErrorCode.contentTypeNotSupported, "This agent only answers in text/plain");
    }
    if (m.taskId !== undefined) {
      this.find(m.taskId);
      throw new A2AError(
        ErrorCode.unsupportedOperation,
        "Follow-up messages to a task are not supported; send a new message",
      );
    }
    for (const part of m.parts) {
      if (typeof part.text !== "string" || (part.mediaType !== undefined && !/^text\//i.test(part.mediaType))) {
        throw new A2AError(ErrorCode.contentTypeNotSupported, "Only text parts are supported");
      }
    }
    const text = textOf(m.parts).text;
    if (text.trim() === "") throw invalid("message text is empty");
    if (Buffer.byteLength(text) > MAX_TASK_TEXT_BYTES) {
      throw invalid(`message text is larger than ${MAX_TASK_TEXT_BYTES} bytes`);
    }
    const peer = await this.target(m, p);

    const id = randomUUID();
    const contextId = m.contextId ?? randomUUID();
    const rec: TaskRecord = {
      task: {
        id,
        contextId,
        status: { state: "TASK_STATE_SUBMITTED", timestamp: iso(this.now()) },
        history: [{ ...m, taskId: id, contextId }],
      },
      peer,
      statusMs: this.now(),
      waiters: new Set(),
    };
    if (!this.store.add(id, rec)) throw new A2AError(ErrorCode.internal, "Too many tasks in progress");

    const deadline = this.now() + this.timeoutMs;
    this.inflight += 1;
    let wimId: string;
    try {
      wimId = (await this.opts.mesh.sendTask(peer, text, { deadline })).id;
    } catch (err) {
      this.log(`a2a: task ${id} to ${peer} not delivered: ${(err as Error).message}`);
      this.finish(rec, "TASK_STATE_FAILED", "The task could not be delivered to the mesh.");
      return { task: this.view(rec, p.configuration?.historyLength) };
    } finally {
      this.inflight -= 1;
    }
    this.log(`a2a: task ${id} sent to ${peer} as ${wimId}`);
    this.setState(rec, "TASK_STATE_WORKING");
    rec.wimId = wimId;
    this.byWimId.set(wimId, id);
    rec.timer = setTimeout(
      () => this.finish(rec, "TASK_STATE_FAILED", `No result from ${peer} before the deadline.`),
      this.timeoutMs,
    );
    rec.timer.unref();
    const early = this.early.get(wimId);
    if (early !== undefined) this.onResult(early);
    if (this.inflight === 0) this.early.clear();

    if (p.configuration?.returnImmediately !== true && !isTerminal(rec.task.status.state)) {
      await new Promise<void>((resolve) => {
        rec.waiters.add(resolve);
        res.once("close", resolve);
      });
    }
    return { task: this.view(rec, p.configuration?.historyLength) };
  }

  private async target(m: Message, p: SendMessageRequest): Promise<string> {
    const meta = WimMetadata.safeParse(m.metadata?.worldinmotion ?? p.metadata?.worldinmotion ?? {});
    if (!meta.success) throw invalid("metadata.worldinmotion must be an object of strings");
    const wanted = meta.data.to ?? meta.data.skill ?? this.opts.defaultTo;
    if (wanted === undefined) {
      throw invalid(
        "Name a peer: metadata.worldinmotion.to (an address) or metadata.worldinmotion.skill (a skill id from the agent card)",
      );
    }
    const hit = (await this.reachable()).find((peer) => peer.address === wanted);
    if (hit === undefined) throw invalid(`No reachable peer ${wanted}`);
    return hit.address;
  }

  private onResult(r: MeshResult): void {
    const id = this.byWimId.get(r.reply_to);
    if (id === undefined) {
      // A result can overtake the sendTask promise that names its task. Keep a few briefly.
      if (this.inflight > 0) {
        if (this.early.size >= EARLY_RESULTS) this.early.delete(this.early.keys().next().value!);
        this.early.set(r.reply_to, r);
      }
      return;
    }
    const rec = this.store.get(id);
    if (rec === undefined || isTerminal(rec.task.status.state)) return;
    if (r.from !== rec.peer) {
      this.log(`a2a: result for task ${id} from ${r.from}, not ${rec.peer}: ignored`);
      return;
    }
    if (r.status === "done") this.finish(rec, "TASK_STATE_COMPLETED", r.text);
    else if (r.status === "declined") this.finish(rec, "TASK_STATE_REJECTED", r.text);
    else if (r.status === "failed") this.finish(rec, "TASK_STATE_FAILED", r.text);
    // A2A has no timeout state; a peer that ran out of time failed the task.
    else this.finish(rec, "TASK_STATE_FAILED", r.text === "" ? `${rec.peer} timed out.` : r.text);
  }

  private finish(rec: TaskRecord, state: TaskState, text: string): void {
    clearTimeout(rec.timer);
    if (rec.wimId !== undefined) this.byWimId.delete(rec.wimId);
    if (state === "TASK_STATE_COMPLETED") {
      rec.task.artifacts = [
        { artifactId: randomUUID(), name: "result", parts: [{ text, mediaType: "text/plain" }] },
      ];
    }
    this.setState(rec, state, state === "TASK_STATE_COMPLETED" ? undefined : text);
    for (const wake of rec.waiters) wake();
    rec.waiters.clear();
  }

  private setState(rec: TaskRecord, state: TaskState, text?: string): void {
    rec.statusMs = this.now();
    rec.task.status = { state, timestamp: iso(rec.statusMs) };
    if (text !== undefined) {
      rec.task.status.message = {
        messageId: randomUUID(),
        role: "ROLE_AGENT",
        parts: [{ text, mediaType: "text/plain" }],
        taskId: rec.task.id,
        contextId: rec.task.contextId,
      };
    }
    this.store.touch(rec.task.id);
  }

  private find(id: string): TaskRecord {
    const rec = this.store.get(id);
    if (rec === undefined) throw new A2AError(ErrorCode.taskNotFound, "Task not found");
    return rec;
  }

  private cancel(id: string): Task {
    const rec = this.find(id);
    if (isTerminal(rec.task.status.state)) {
      throw new A2AError(ErrorCode.taskNotCancelable, "Task is already finished");
    }
    // The mesh has no cancel message, so the peer may still finish; its result is dropped.
    this.finish(rec, "TASK_STATE_CANCELED", "Canceled by the client.");
    return this.view(rec, undefined);
  }

  private list(p: z.infer<typeof ListTasksRequestSchema>): unknown {
    const after = p.statusTimestampAfter === undefined ? -Infinity : Date.parse(p.statusTimestampAfter);
    const all = this.store
      .values()
      .filter(
        (r) =>
          (p.contextId === undefined || r.task.contextId === p.contextId) &&
          (p.status === undefined || r.task.status.state === p.status) &&
          r.statusMs >= after,
      )
      .sort((a, b) => b.statusMs - a.statusMs || Number(a.task.id < b.task.id) - Number(a.task.id > b.task.id));
    let start = 0;
    if (p.pageToken !== undefined && p.pageToken !== "") {
      const cursor = decodeCursor(p.pageToken);
      start = all.findIndex(
        (r) => r.statusMs < cursor.ms || (r.statusMs === cursor.ms && r.task.id < cursor.id),
      );
      if (start === -1) start = all.length;
    }
    const pageSize = p.pageSize ?? 50;
    const page = all.slice(start, start + pageSize);
    const last = page.at(-1);
    const more = start + page.length < all.length;
    return {
      tasks: page.map((r) => {
        const t = this.view(r, p.historyLength);
        if (p.includeArtifacts !== true) delete t.artifacts;
        return t;
      }),
      nextPageToken: more ? encodeCursor(last!.statusMs, last!.task.id) : "",
      pageSize,
      totalSize: all.length,
    };
  }

  /** A copy of the task with at most `historyLength` history messages (0 drops the field). */
  private view(rec: TaskRecord, historyLength: number | undefined): Task {
    const t = structuredClone(rec.task);
    if (historyLength === 0) delete t.history;
    else if (historyLength !== undefined) t.history = t.history!.slice(-historyLength);
    return t;
  }
}

function invalid(message: string): A2AError {
  return new A2AError(ErrorCode.invalidParams, message);
}

function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const r = schema.safeParse(params);
  if (r.success) return r.data;
  const issue = r.error.issues[0]!;
  const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  throw invalid(`Invalid parameters: ${where}${issue.message}`);
}

function rpcError(id: string | number | null, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function encodeCursor(ms: number, id: string): string {
  return Buffer.from(JSON.stringify([ms, id])).toString("base64url");
}

const Cursor = z.tuple([z.number(), z.string()]);

function decodeCursor(token: string): { ms: number; id: string } {
  try {
    const [ms, id] = Cursor.parse(JSON.parse(Buffer.from(token, "base64url").toString("utf8")));
    return { ms, id };
  } catch {
    throw invalid("Invalid parameters: pageToken is not a token this server issued");
  }
}

function reply(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** The request body as text, or undefined when it is larger than MAX_REQUEST_BYTES. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
