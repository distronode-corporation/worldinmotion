import { CI_NOT_FOUND, ciPrecheck, healthz, isInfoPath, parseCiPath, parseDialPath, parseRdvPath, RDV_HEADERS, relayInfo, relaySettings, sourceKey, type CiAnswer } from "@worldinmotion/relay-core";
import { LIMITS } from "@worldinmotion/protocol";
import { ciKeys } from "./ci.ts";
import { configProblem, type Env } from "./config.ts";
import { CI_HEADER, MESH_HEADER, SOURCE_HEADER } from "./mesh.ts";
import { RDV_NAME } from "./rdv.ts";
import { json } from "./route.ts";
import { sourceSecret } from "./source.ts";

// The Worker's entry module (wrangler.jsonc `main`). The runtime reads every export of it as a
// handler or a Durable Object class, so it exports exactly those and nothing else.
export { MeshDurableObject } from "./mesh.ts";
export { SourceLimiter } from "./limiter.ts";
export { MeshRegistry } from "./registry.ts";
export { RendezvousStore } from "./rdv.ts";

/**
 * The rate-limit key of the client's address, under the relay's secret. Cloudflare sets
 * CF-Connecting-IP itself and overwrites any client copy.
 */
async function sourceOf(request: Request, env: Env): Promise<string> {
  return sourceKey(request.headers.get("cf-connecting-ip") ?? "", await sourceSecret(env));
}

/** What a source past its limit is told. A client retries it with backoff, like a lost connection. */
const LIMITED = { error: "too many connections from this address; try again later" };
/** The limiter counts a minute at a time (wrangler.jsonc), so a minute is always long enough. */
const RETRY_AFTER = "60";

let unlimitedLogged = false;

/**
 * Whether `source` may make a request that reaches a Durable Object now, by the `DIALS` rate
 * limit. Asked before any object is, so a refused request costs no Durable Object request.
 */
async function withinLimit(env: Env, source: string): Promise<boolean> {
  if (env.DIALS === undefined) {
    if (!unlimitedLogged) console.warn(JSON.stringify({ event: "config", binding: "DIALS", warning: "no rate limit binding: dials are not limited per source (see README.md)" }));
    unlimitedLogged = true;
    return true;
  }
  return (await env.DIALS.limit({ key: source })).success;
}

/**
 * A request's body as text, read only up to `max` bytes: undefined when its declared length or
 * the bytes that arrive pass it, so an oversized body is never held in memory whole.
 */
async function boundedText(request: Request, max: number): Promise<string | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > max) return undefined;
  const reader = request.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(bytes);
}

/** A CI answer the Worker gives itself: never a 429, whose limit is the Worker's own rate limiter. */
function ciResponse(a: CiAnswer): Response {
  return json(a.status, a.body);
}

/**
 * `POST <prefix>/v1/<mesh>/ci` (SPEC section 18): whether the relay takes CI senders, the source's
 * rate limit, then the size, the parse and a GitHub token's check, all before any Durable Object
 * is asked, so junk costs no object request. Only then does the mesh's object get the request,
 * with what the relay keeps of a verified token in a header only the Worker sets.
 */
async function ciRequest(request: Request, env: Env, meshId: string): Promise<Response> {
  if (relaySettings(env).ci !== true) return ciResponse(CI_NOT_FOUND);
  const source = await sourceOf(request, env);
  if (!(await withinLimit(env, source))) return json(429, LIMITED, { "content-type": "application/json", "retry-after": RETRY_AFTER });
  const text = await boundedText(request, LIMITS.ciRequestBytes);
  if (text === undefined) return ciResponse({ status: 413, body: { t: "error", code: "too_large", message: "the request is over 32 KiB" } });
  const pre = await ciPrecheck(text, { enabled: true, keys: (iss, kid) => ciKeys().key(iss, kid), now: Date.now() });
  if (!pre.ok) return ciResponse(pre.answer);
  const headers = new Headers({ [SOURCE_HEADER]: source, [MESH_HEADER]: meshId, [CI_HEADER]: JSON.stringify(pre.github ?? null) });
  const stub = env.MESH.get(env.MESH.idFromName(meshId));
  return stub.fetch(new Request(request.url, { method: "POST", headers, body: text }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const ci = request.method === "POST" ? parseCiPath(url.pathname) : undefined;
    if (ci !== undefined) return ci.ok ? ciRequest(request, env, ci.meshId) : json(ci.status, { t: "error", code: "malformed", message: ci.error });
    if (request.method === "GET" && url.pathname === "/healthz") {
      // Reads the configuration only (no Durable Object), as the mesh objects will read it.
      const health = healthz(configProblem(env));
      return json(health.status, health.body);
    }
    if (request.method !== "GET") return json(404, { error: "not found" });
    // The public description (no secret, no live count); it needs no Durable Object either.
    if (isInfoPath(url.pathname)) return json(200, relayInfo(relaySettings(env)));
    // A short invite code's box (SPEC section 5), from the one rendezvous object, by source key.
    const rdv = parseRdvPath(url.pathname);
    if (rdv !== undefined) {
      if (!rdv.ok) return json(rdv.status, { error: rdv.error }, RDV_HEADERS);
      const source = await sourceOf(request, env);
      if (!(await withinLimit(env, source))) return json(429, LIMITED, { ...RDV_HEADERS, "retry-after": RETRY_AFTER });
      const answer = await env.RDV.get(env.RDV.idFromName(RDV_NAME)).get(rdv.rdv, source);
      return json(answer.status, answer.body, RDV_HEADERS);
    }
    const dial = parseDialPath(url.pathname);
    if (!dial.ok) return json(dial.status, { error: dial.error });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json(426, { error: "expected a WebSocket upgrade" });
    const source = await sourceOf(request, env);
    if (!(await withinLimit(env, source))) return json(429, LIMITED, { "content-type": "application/json", "retry-after": RETRY_AFTER });
    // A fresh header set: nothing the client sent reaches the object except the upgrade, so a
    // client cannot supply its own source key or mesh header.
    const headers = new Headers({
      upgrade: "websocket",
      [SOURCE_HEADER]: source,
      [MESH_HEADER]: dial.meshId,
    });
    const stub = env.MESH.get(env.MESH.idFromName(dial.meshId));
    return stub.fetch(new Request(url.toString(), { headers }));
  },
} satisfies ExportedHandler<Env>;
