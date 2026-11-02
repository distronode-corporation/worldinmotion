import { b64u } from "@worldinmotion/protocol";
import type { Env } from "./config.ts";
import { REGISTRY_NAME } from "./registry.ts";

/** This isolate's copy of the relay's source key secret, once read. */
let secret: Uint8Array | undefined;

/**
 * The secret the Worker makes source keys under (`MeshRegistry.sourceSecret`), read from the
 * registry object on an isolate's first request and kept for the isolate's life, so later
 * requests, refused dials included, reach no Durable Object for it. The value is kept rather
 * than the promise, so no request awaits another request's I/O.
 */
export async function sourceSecret(env: Env): Promise<Uint8Array> {
  secret ??= b64u.decode(await env.REGISTRY.get(env.REGISTRY.idFromName(REGISTRY_NAME)).sourceSecret());
  return secret;
}
