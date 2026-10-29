import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfSignedCert } from "@worldinmotion/relay-node";
import { onTestFinished } from "vitest";
import type {
  MeshMessage,
  MeshPeer,
  MeshPort,
  MeshResult,
  MeshTask,
  ResultStatus,
} from "../src/mesh.ts";

/** Where test scratch directories go: `WIM_TEST_TMP` when set, else the system temp directory (honours TMPDIR). */
function scratchRoot(): string {
  return process.env["WIM_TEST_TMP"] || tmpdir();
}

export const TOKEN = "inbound-token-0123456789abcdef";

/** Waits until `check` returns something other than undefined, or fails after `ms`. */
export async function until<T>(check: () => T | undefined, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A hand-wound clock. */
export function clock(start = Date.UTC(2026, 9, 24, 12, 0, 0)) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

export interface SentTask {
  id: string;
  to: string;
  text: string;
  deadline?: number;
}

export interface SentResult {
  to: string;
  taskId: string;
  status: ResultStatus;
  text: string;
}

/** A mesh connection that records what the gateway sends and lets a test play the peers. */
export class FakeMesh implements MeshPort {
  peerList: MeshPeer[] = [
    { address: "reviewer@laptop", kind: "claude-code", status: "idle" },
    { address: "helper@laptop", kind: "bot", status: "busy" },
    { address: "gone@laptop", kind: "claude-code", status: "offline" },
    { address: "outside@laptop", kind: "a2a", status: "idle" },
  ];
  peersError?: Error;
  sendTaskError?: Error;
  /** Runs inside sendTask, after the id is chosen and before the promise resolves. */
  beforeSendResolves?: (id: string) => void;
  sendResultError?: Error;
  /** When set, sendTask waits for it, so a test can hold sends in flight. */
  holdSends?: Promise<void>;
  readonly sent: SentTask[] = [];
  readonly results: SentResult[] = [];
  private readonly resultCbs: Array<(r: MeshResult) => void> = [];
  private readonly taskCbs: Array<(t: MeshTask) => void> = [];
  private readonly messageCbs: Array<(m: MeshMessage) => void> = [];
  private n = 0;

  /** How many sendTask calls have started. */
  get attempts(): number {
    return this.n;
  }

  async peers(): Promise<MeshPeer[]> {
    if (this.peersError !== undefined) throw this.peersError;
    return this.peerList;
  }

  async sendTask(to: string, text: string, opts: { deadline?: number }): Promise<{ id: string }> {
    if (this.sendTaskError !== undefined) throw this.sendTaskError;
    this.n += 1;
    const id = `01WIMTASK${String(this.n).padStart(17, "0")}`;
    const hold = this.holdSends;
    if (hold !== undefined) await hold;
    this.beforeSendResolves?.(id);
    this.sent.push({ id, to, text, deadline: opts.deadline });
    return { id };
  }

  onResult(cb: (r: MeshResult) => void): void {
    this.resultCbs.push(cb);
  }

  onTask(cb: (t: MeshTask) => void): void {
    this.taskCbs.push(cb);
  }

  onMessage(cb: (m: MeshMessage) => void): void {
    this.messageCbs.push(cb);
  }

  async sendResult(to: string, taskId: string, status: ResultStatus, text: string): Promise<void> {
    if (this.sendResultError !== undefined) throw this.sendResultError;
    this.results.push({ to, taskId, status, text });
  }

  result(r: MeshResult): void {
    for (const cb of this.resultCbs) cb(r);
  }

  task(t: MeshTask): void {
    for (const cb of this.taskCbs) cb(t);
  }

  message(m: MeshMessage): void {
    for (const cb of this.messageCbs) cb(m);
  }
}

export interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export type Handler = (req: Seen, res: ServerResponse) => void | Promise<void>;

/** A local HTTP server on loopback, closed when the test ends. */
export async function serve(handler: Handler): Promise<{ base: string; port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const s: Seen = { method: req.method!, path: req.url!, headers: req.headers, body };
      seen.push(s);
      void handler(s, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, port, seen };
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** A valid protocol 1.0 agent card for an agent at `rpcUrl`. */
export function agentCard(rpcUrl: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Fake Agent",
    description: "A test agent.",
    supportedInterfaces: [{ url: rpcUrl, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [{ id: "echo", name: "Echo", description: "Echoes.", tags: ["test"] }],
    ...extra,
  };
}

export interface TlsFiles {
  certPath: string;
  keyPath: string;
  cert: Buffer;
  key: Buffer;
}

/**
 * A throwaway self-signed certificate for localhost and 127.0.0.1, made in this process (the
 * relay's own LAN certificate code) under the user's cache (never the shared temp directory) and
 * removed when the test ends. Call only from inside a test. It used the openssl CLI, which blocked
 * the test process for about 30 s on its first run on Windows CI: a synchronous call that no test
 * timeout can interrupt.
 */
export function selfSignedTls(): TlsFiles {
  const root = scratchRoot();
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "wim-a2a-tls-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  const made = selfSignedCert(["localhost", "127.0.0.1"], new Date());
  writeFileSync(keyPath, made.key, { mode: 0o600 });
  writeFileSync(certPath, made.cert);
  return { certPath, keyPath, cert: readFileSync(certPath), key: readFileSync(keyPath) };
}

/**
 * A raw request with full control of headers (fetch will not set Host), over HTTP or, with
 * `ca`, HTTPS. Resolves with the status and body text.
 */
export function rawRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; ca?: Buffer } = {},
): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  const send = u.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method ?? "GET",
        headers: opts.headers,
        ca: opts.ca,
      },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}
