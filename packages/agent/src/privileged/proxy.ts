// The job's only way to the Anthropic API: a loopback proxy the privileged runner owns. The job
// gets the proxy's address and a random key that is good for this job only; the proxy checks it,
// removes it, and adds the real credential, which never leaves the runner's memory. Whatever the
// job reads (its own environment included) holds nothing that works once the job has ended.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

/** The API paths the Agent SDK calls (checked against the real SDK); anything else is refused. */
export const PROXY_PATHS: readonly string[] = ["/v1/messages", "/v1/messages/count_tokens"];
const QUERIES = new Set(["", "?beta=true"]);

/** Headers never forwarded upstream: the job's key, hop-by-hop ones, and encodings fetch rewrites. */
const DROP_REQUEST = new Set(["host", "x-api-key", "authorization", "connection", "content-length", "transfer-encoding", "accept-encoding", "proxy-authorization", "keep-alive", "upgrade"]);
const DROP_RESPONSE = new Set(["connection", "content-length", "transfer-encoding", "content-encoding", "keep-alive", "set-cookie"]);

/** The credential the proxy adds to each forwarded request. */
export type UpstreamAuth = () => Promise<Record<string, string>>;

export type UpstreamFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

export interface ProxyOptions {
  /** The API's origin, such as https://api.anthropic.com. */
  upstream: string;
  auth: UpstreamAuth;
  /** Models the job may ask for. */
  models: readonly string[];
  maxTokens: number;
  /** Requests this job may make in all. */
  maxRequests: number;
  maxBodyBytes: number;
  /** Longest one upstream request may take. */
  requestTimeoutMs: number;
  fetch: UpstreamFetch;
  log: (line: string) => void;
}

export interface RunningProxy {
  /** The base URL the job gets as ANTHROPIC_BASE_URL. */
  url: string;
  /** The job's key, as ANTHROPIC_API_KEY: good only on this proxy, only while it runs. */
  key: string;
  requests(): number;
  close(): Promise<void>;
}

const digest = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

function refuse(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: status === 429 ? "rate_limit_error" : "invalid_request_error", message } }));
}

/** The body, or undefined once it passes `max` (the rest is not kept). An aborted upload rejects. */
async function readBody(req: IncomingMessage, max: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size <= max) chunks.push(c);
  }
  return size > max ? undefined : Buffer.concat(chunks).toString("utf8");
}

/** What the job asked for, checked against the limits; a reason when it is refused. */
function checkBody(body: string, o: ProxyOptions, counted: boolean): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "the request body is not JSON";
  }
  const b = parsed as { model?: unknown; max_tokens?: unknown } | null;
  if (typeof b !== "object" || b === null || typeof b.model !== "string" || !o.models.includes(b.model)) return "this job may not use that model";
  if (counted && (typeof b.max_tokens !== "number" || b.max_tokens > o.maxTokens)) return `max_tokens must be at most ${o.maxTokens}`;
  return undefined;
}

export async function startProxy(o: ProxyOptions): Promise<RunningProxy> {
  const key = `wimjob-${randomBytes(32).toString("base64url")}`;
  const want = digest(key);
  let count = 0;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url!;
    const q = url.indexOf("?");
    const path = q === -1 ? url : url.slice(0, q);
    const query = q === -1 ? "" : url.slice(q);
    const given = req.headers["x-api-key"];
    if (typeof given !== "string" || !timingSafeEqual(digest(given), want)) return refuse(res, 401, "not this job's key");
    if (req.method !== "POST" || !PROXY_PATHS.includes(path) || !QUERIES.has(query)) return refuse(res, 404, "not a path this job may call");
    const body = await readBody(req, o.maxBodyBytes);
    if (body === undefined) return refuse(res, 413, `the request body is over ${o.maxBodyBytes} bytes`);
    const messages = path === "/v1/messages";
    const why = checkBody(body, o, messages);
    if (why !== undefined) return refuse(res, 400, why);
    if (messages && ++count > o.maxRequests) return refuse(res, 429, `this job made its ${o.maxRequests} requests`);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP_REQUEST.has(k)) headers[k] = String(v);
    const auth = await o.auth();
    // A bearer token needs its beta flag next to whatever the job asked for.
    if (auth["anthropic-beta"] !== undefined && headers["anthropic-beta"] !== undefined) auth["anthropic-beta"] = `${headers["anthropic-beta"]},${auth["anthropic-beta"]}`;
    const upstream = await o.fetch(`${o.upstream}${path}${query}`, { method: "POST", headers: { ...headers, ...auth }, body, signal: AbortSignal.timeout(o.requestTimeoutMs) });
    const out: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (!DROP_RESPONSE.has(k)) out[k] = v;
    });
    res.writeHead(upstream.status, out);
    o.log(`proxy: ${path} ${upstream.status} (request ${count} of ${o.maxRequests})`);
    if (upstream.body === null) return void res.end();
    Readable.fromWeb(upstream.body as never).on("error", () => res.destroy()).pipe(res);
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      // The name only: an upstream error can carry request ids, a body could carry the task.
      // Every failure comes before the response starts (a stream error destroys it on its own).
      o.log(`proxy: failed: ${(error as Error).name}`);
      refuse(res, 502, "the API could not be reached");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}`,
    key,
    requests: () => count,
    close() {
      // Once closed, nothing listens: the job's key is good for nothing.
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
