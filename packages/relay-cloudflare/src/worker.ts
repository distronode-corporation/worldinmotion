import { healthz, isInfoPath, parseDialPath, relayInfo, relaySettings, sourceKey } from "@worldinmotion/relay-core";
import { configProblem, type Env } from "./config.ts";
import { MESH_HEADER, SOURCE_HEADER } from "./mesh.ts";
import { json } from "./route.ts";

// The Worker's entry module (wrangler.jsonc `main`). The runtime reads every export of it as a
// handler or a Durable Object class, so it exports exactly those and nothing else.
export { MeshDurableObject } from "./mesh.ts";
export { SourceLimiter } from "./limiter.ts";
export { MeshRegistry } from "./registry.ts";

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
    const dial = parseDialPath(url.pathname);
    if (!dial.ok) return json(dial.status, { error: dial.error });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json(426, { error: "expected a WebSocket upgrade" });
    // A fresh header set: nothing the client sent reaches the object except the upgrade, so a
    // client cannot supply its own source key or mesh header. Cloudflare sets CF-Connecting-IP
    // itself and overwrites any client copy.
    const headers = new Headers({
      upgrade: "websocket",
      [SOURCE_HEADER]: sourceKey(request.headers.get("cf-connecting-ip") ?? ""),
      [MESH_HEADER]: dial.meshId,
    });
    const stub = env.MESH.get(env.MESH.idFromName(dial.meshId));
    return stub.fetch(new Request(url.toString(), { headers }));
  },
} satisfies ExportedHandler<Env>;
