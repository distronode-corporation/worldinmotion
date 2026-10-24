import { isIP } from "node:net";

/** 1 MiB: the largest response body the gateway reads from an external agent. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

const MAX_REDIRECTS = 3;

/** `localhost`, `127.0.0.0/8` and `::1`. Bracketed IPv6 (as `URL.hostname` gives it) is accepted. */
export function isLoopbackHost(host: string): boolean {
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (h === "localhost" || h === "::1") return true;
  return isIP(h) === 4 && h.startsWith("127.");
}

/** The names a loopback-only server answers to by default. */
export const LOOPBACK_NAMES: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

/** Lowercases a host name and brackets a bare IPv6 address, the form a Host header carries. */
export function normalizeHostName(name: string): string {
  const n = name.toLowerCase();
  return n.includes(":") && !n.startsWith("[") ? `[${n}]` : n;
}

/**
 * The host name in a `Host` header, without its port, or undefined when the header is missing
 * or is not a plain `name[:port]` or `[ipv6][:port]`.
 */
export function hostHeaderName(header: string | undefined): string | undefined {
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.exec(header ?? "");
  return m === null ? undefined : m[1]!.toLowerCase();
}

/**
 * Parses an external agent URL: `https:`, or `http:` to a loopback host only, and never with
 * credentials in it. Throws with a reason otherwise.
 */
export function checkAgentUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("not a valid URL");
  }
  if (url.username !== "" || url.password !== "") throw new Error("URL must not hold credentials");
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url;
  throw new Error("URL must be https, or http to a loopback host");
}

export interface FetchLimits {
  timeoutMs: number;
  maxBytes?: number;
  fetch?: typeof fetch;
}

export interface FetchedJson {
  status: number;
  body: unknown;
}

/**
 * Fetches JSON from an external agent with hard limits: the whole exchange (headers and body)
 * ends at `timeoutMs`, the body is cut off past `maxBytes`, and a redirect is followed only for
 * a GET and only within the same origin (scheme, host and port), at most three times. A POST is
 * never redirected, so a request body and its auth header go only where they were addressed.
 */
export async function fetchJson(
  url: URL,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
  limits: FetchLimits,
): Promise<FetchedJson> {
  const doFetch = limits.fetch ?? fetch;
  const maxBytes = limits.maxBytes ?? MAX_RESPONSE_BYTES;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), limits.timeoutMs);
  try {
    let target = url;
    for (let hop = 0; ; hop++) {
      const res = await doFetch(target, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        redirect: "manual",
        signal: ctrl.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        target = nextHop(target, res.headers.get("location"), init.method, hop);
        continue;
      }
      const text = await readCapped(res, maxBytes);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`response is not JSON (HTTP ${res.status})`);
      }
      return { status: res.status, body };
    }
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error(`timed out after ${limits.timeoutMs} ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function nextHop(from: URL, location: string | null, method: string, hop: number): URL {
  if (method !== "GET") throw new Error("redirect refused for a POST");
  if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
  if (location === null) throw new Error("redirect without a location");
  const to = new URL(location, from);
  if (to.origin !== from.origin) throw new Error(`redirect to another host refused (${to.host})`);
  return to;
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    await res.body?.cancel();
    throw new Error(`response larger than ${maxBytes} bytes`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (res.body !== null) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`response larger than ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}
