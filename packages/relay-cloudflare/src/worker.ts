import { healthz, isInfoPath, parseDialPath, parseRdvPath, RDV_HEADERS, relayInfo, relaySettings, sourceKey } from "@worldinmotion/relay-core";
import { configProblem, type Env } from "./config.ts";
import { MESH_HEADER, SOURCE_HEADER } from "./mesh.ts";
import { RDV_NAME } from "./rdv.ts";
import { json } from "./route.ts";

// The Worker's entry module (wrangler.jsonc `main`). The runtime reads every export of it as a
// handler or a Durable Object class, so it exports exactly those and nothing else.
export { MeshDurableObject } from "./mesh.ts";
export { SourceLimiter } from "./limiter.ts";
export { MeshRegistry } from "./registry.ts";
export { RendezvousStore } from "./rdv.ts";

/**
 * The rate-limit key of the client's address. Cloudflare sets CF-Connecting-IP itself and
 * overwrites any client copy.
 */
function sourceOf(request: Request): string {
  return sourceKey(request.headers.get("cf-connecting-ip") ?? "");
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      // Reads the configuration only (no Durable Object), as the mesh objects will read it.
      const health = healthz(configProblem(env));
      return json(health.status, health.body);
    }
    if (request.method !== "GET") return json(404, { error: "not found" });
    // The public description (no secret, no live count); it needs no Durable Object either.
    if (isInfoPath(url.pathname)) return json(200, relayInfo(relaySettings(env)));
    // A short invite code's box (SPEC section 5), from the one rendezvous object, by hashed address.
    const rdv = parseRdvPath(url.pathname);
    if (rdv !== undefined) {
      if (!rdv.ok) return json(rdv.status, { error: rdv.error }, RDV_HEADERS);
      const source = sourceOf(request);
      if (!(await withinLimit(env, source))) return json(429, LIMITED, { ...RDV_HEADERS, "retry-after": RETRY_AFTER });
      const answer = await env.RDV.get(env.RDV.idFromName(RDV_NAME)).get(rdv.rdv, source);
      return json(answer.status, answer.body, RDV_HEADERS);
    }
    const dial = parseDialPath(url.pathname);
    if (!dial.ok) return json(dial.status, { error: dial.error });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json(426, { error: "expected a WebSocket upgrade" });
    const source = sourceOf(request);
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
