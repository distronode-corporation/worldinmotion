import { readFile } from "node:fs/promises";
import { readToken } from "./auth.ts";
import type { GatewayConfig } from "./config.ts";
import { InboundGateway } from "./inbound.ts";
import type { MeshPort } from "./mesh.ts";
import { OutboundBridge } from "./outbound.ts";

export interface GatewayDeps {
  env?: Record<string, string | undefined>;
  now?: () => number;
  log?: (line: string) => void;
  fetch?: typeof fetch;
}

export interface Gateway {
  inbound?: InboundGateway;
  /** Where the inbound server listens. */
  url?: string;
  outbound?: OutboundBridge;
  close(): Promise<void>;
}

/**
 * Starts whichever halves the config enables, on one mesh connection. Credentials for the two
 * directions are separate: the inbound bearer token is checked and dropped, and each external
 * agent's header comes only from its own environment variable.
 */
export async function startGateway(
  config: GatewayConfig,
  mesh: MeshPort,
  deps: GatewayDeps = {},
): Promise<Gateway> {
  const env = deps.env ?? process.env;
  // Read the token first, so a missing one stops startup before anything subscribes.
  const token = config.inbound === undefined ? "" : readToken(env, config.inbound.tokenEnv);
  const tlsFiles = config.inbound?.tls;
  const tls =
    tlsFiles === undefined
      ? undefined
      : { cert: await readFile(tlsFiles.certPath), key: await readFile(tlsFiles.keyPath) };
  const gw: Gateway = {
    close: async () => {
      await gw.inbound?.close();
    },
  };
  if (config.outbound !== undefined) {
    const o = config.outbound;
    gw.outbound = new OutboundBridge({
      mesh,
      agents: o.agents,
      env,
      requestTimeoutMs: o.requestTimeoutSeconds * 1000,
      defaultDeadlineMs: o.defaultDeadlineSeconds * 1000,
      maxDeadlineMs: o.maxDeadlineSeconds * 1000,
      maxConcurrent: o.maxConcurrent,
      now: deps.now,
      log: deps.log,
      fetch: deps.fetch,
    });
    gw.outbound.start();
  }
  if (config.inbound !== undefined) {
    const i = config.inbound;
    gw.inbound = new InboundGateway({
      mesh,
      token,
      host: i.host,
      port: i.port,
      allowNonLoopback: i.allowNonLoopback,
      tls,
      publicHosts: i.publicHosts,
      publicUrl: i.publicUrl,
      name: i.name,
      description: i.description,
      defaultTo: i.defaultTo,
      taskTimeoutMs: i.taskTimeoutSeconds * 1000,
      maxTasks: i.maxTasks,
      taskTtlMs: i.taskTtlSeconds * 1000,
      cardRequiresAuth: i.cardRequiresAuth,
      now: deps.now,
      log: deps.log,
    });
    gw.url = (await gw.inbound.start()).url;
  }
  return gw;
}
