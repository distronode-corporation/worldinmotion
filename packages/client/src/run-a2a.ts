// `wim a2a`: the Agent2Agent gateway on one mesh session.

import { startGateway, type Gateway, type GatewayConfig } from "@worldinmotion/a2a";
import { meshPort } from "./adapters.ts";
import type { MeshSession } from "./client.ts";

/** Starts the gateway; `config` is already validated (`loadConfig`), before the session connected. */
export async function runGateway(config: GatewayConfig, s: MeshSession, env: Record<string, string | undefined>, log: (line: string) => void, fetcher: typeof fetch): Promise<Gateway> {
  return startGateway(config, meshPort(s), { env, log, fetch: fetcher });
}
