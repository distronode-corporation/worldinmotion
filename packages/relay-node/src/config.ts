import { parseRelayUrls, relaySettings } from "@worldinmotion/relay-core";
import type { StartConfig } from "./server.ts";

/**
 * The relay's configuration from its environment and arguments (README.md lists each setting):
 * `WIM_RELAY_URLS` (comma-separated exact public base URLs), `PORT` (default 8787), `WIM_HOST`,
 * `WIM_DB` (default `wim-relay.db`), `WIM_CREATE_KEY` or `WIM_OPEN_CREATE` (creation is refused
 * unless one of them opens it), the guardrails `WIM_MAX_MESHES`, `WIM_IDLE_MESH_DAYS` and the
 * `WIM_BLOB_BYTES_*` limits, `WIM_OFFER` (all read by relay-core's `relaySettings`),
 * `WIM_TRUST_PROXY` (`1` or `true`), and `--lan` (or `WIM_LAN=1`) for a self-signed wss relay on
 * the LAN address.
 */
export function configFromEnv(env: Record<string, string | undefined>, argv: readonly string[]): StartConfig {
  const flag = (v: string | undefined) => v === "1" || v === "true";
  const urls = parseRelayUrls(env["WIM_RELAY_URLS"]);
  const port = env["PORT"] === undefined ? 8787 : Number(env["PORT"]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid PORT: ${env["PORT"]}`);
  for (const arg of argv) if (arg !== "--lan") throw new Error(`unknown argument: ${arg}`);
  return {
    db: env["WIM_DB"] ?? "wim-relay.db",
    port,
    host: env["WIM_HOST"],
    relayUrls: urls.length > 0 ? urls : undefined,
    ...relaySettings(env),
    trustProxy: flag(env["WIM_TRUST_PROXY"]),
    lan: argv.includes("--lan") || flag(env["WIM_LAN"]),
  };
}
