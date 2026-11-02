import { parseRelayUrls, relaySettings, type RelaySettings } from "@worldinmotion/relay-core";
import type { MeshDurableObject } from "./mesh.ts";
import type { MeshRegistry } from "./registry.ts";
import type { RendezvousStore } from "./rdv.ts";
import type { SourceLimiter } from "./limiter.ts";

/** The Worker's bindings and variables (see wrangler.jsonc and README.md). */
export type Env = {
  /** One Durable Object per mesh, named by the mesh id. */
  MESH: DurableObjectNamespace<MeshDurableObject>;
  /** One Durable Object per source key: the create, join and recovery limit across meshes. */
  SOURCES: DurableObjectNamespace<SourceLimiter>;
  /** One Durable Object for the whole Worker: the mesh count for `WIM_MAX_MESHES`. */
  REGISTRY: DurableObjectNamespace<MeshRegistry>;
  /** One Durable Object for the whole Worker: the boxes of short invite codes (SPEC section 5). */
  RDV: DurableObjectNamespace<RendezvousStore>;
  /**
   * The rate limit per source key on requests that would reach a Durable Object (dials and box
   * fetches), asked before any object is. A copy of wrangler.jsonc older than it has none: the
   * Worker then serves those requests unlimited, as before, and logs that once per isolate.
   */
  DIALS?: RateLimit;
  /** Comma-separated exact public base URLs clients use, for example `wss://relay.example.com`. */
  WIM_RELAY_URLS?: string;
  /** When set (as a Worker secret), `create` must carry this operator key. Empty is a misconfiguration. */
  WIM_CREATE_KEY?: string;
  /** `1` lets anyone create a mesh without a key. Without it or a key, creation is refused. */
  WIM_OPEN_CREATE?: string;
  /** The guardrails and the offer line, as relay-core's `relaySettings` reads them (see README.md). */
  WIM_MAX_MESHES?: string;
  WIM_IDLE_MESH_DAYS?: string;
  WIM_BLOB_BYTES_PER_MESH_PER_DAY?: string;
  WIM_BLOB_BYTES_PER_DEVICE_PER_DAY?: string;
  WIM_BLOB_BYTES_PER_MESH?: string;
  WIM_OFFER?: string;
};

export type CfRelayConfig = RelaySettings & { relayUrls: string[] };

/**
 * The relay's configuration from the Worker environment, read as relay-node reads it (relay-core's
 * `parseRelayUrls` and `relaySettings`). Throws when `WIM_RELAY_URLS` is missing or names a URL that
 * is not a valid relay URL: an `auth` signs the relay URL, so a relay that guessed its own URL
 * from request headers could be replayed against. Any other setting that is wrong does not throw:
 * it refuses creation and comes back as `problem`.
 */
export function relayConfig(env: Env): CfRelayConfig {
  const relayUrls = parseRelayUrls(env.WIM_RELAY_URLS);
  if (relayUrls.length === 0) throw new Error("WIM_RELAY_URLS is not set");
  return { relayUrls, ...relaySettings(env) };
}

/** What `/healthz` reports: the configuration problem, or undefined when the relay can run. */
export function configProblem(env: Env): string | undefined {
  try {
    return relayConfig(env).problem;
  } catch (err) {
    return (err as Error).message;
  }
}
