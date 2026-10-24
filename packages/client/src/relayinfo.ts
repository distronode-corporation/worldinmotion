// What a relay says about itself at `GET /v1/info`: whether it creates meshes for anyone, with an
// operator key, or not at all, its limits, and an offer text. Read only by `wim doctor` and when a
// relay refuses `create`; the answer is the relay's claim, never a trust input.

import { isRelayUrl } from "@worldinmotion/protocol";
import { request, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import * as tls from "node:tls";
import { urlToHttpOptions } from "node:url";
import { z } from "zod";
import { pinnedConnect, relayText } from "./wire.ts";

const InfoSchema = z.object({
  v: z.literal(1),
  software: z.literal("worldinmotion-relay"),
  version: z.string().max(64),
  create: z.enum(["key", "open", "closed"]),
  limits: z.object({
    max_meshes: z.number().int().nonnegative().nullable(),
    idle_mesh_days: z.number().int().nonnegative().nullable(),
    blob_bytes_per_mesh_per_day: z.number().int().nonnegative(),
  }),
  offer: z.string().nullable(),
});

export type RelayInfo = z.infer<typeof InfoSchema>;

/** The largest `/v1/info` answer read; anything longer is not an info document. */
export const INFO_MAX_BYTES = 16 * 1024;

/** The info URL for a relay URL: `wss://` becomes `https://`, `ws://` (loopback only) `http://`. */
export function infoUrl(relay: string): string {
  return `${relay.replace(/^ws/, "http")}/v1/info`;
}

/** The part of `fetch` this module uses, so a pinned relay can be read without it. */
export type InfoFetcher = (url: string, init: { signal: AbortSignal; redirect: "error"; headers: Record<string, string> }) => Promise<{ status: number; text(): Promise<string> }>;

/**
 * A GET that accepts exactly the pinned certificate key, through the same connection the
 * WebSocket dialer uses for a pinned relay (wire.ts). Redirects are not followed, and reading
 * stops once a body is longer than INFO_MAX_BYTES.
 */
export function pinnedFetcher(pin: string, connect: typeof tls.connect = tls.connect): InfoFetcher {
  return (url, init) =>
    new Promise((resolve, reject) => {
      const target = urlToHttpOptions(new URL(url));
      // SNI carries a host name only, as the WebSocket dialer sends it.
      const servername = isIP(target.hostname!) === 0 ? target.hostname! : "";
      const options: RequestOptions = { ...target, servername, headers: init.headers, signal: init.signal, createConnection: pinnedConnect(pin, connect) as RequestOptions["createConnection"] };
      const req = request(options, (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            size += chunk.length;
            if (size > INFO_MAX_BYTES) {
              reject(new Error("the info answer is too large"));
              res.destroy();
            }
          });
          res.on("close", () => resolve({ status: res.statusCode!, text: async () => Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("error", reject);
      req.end();
    });
}

/**
 * The relay's `/v1/info`, or undefined when it publishes none: a refused URL, a network error, a
 * timeout, a non-200 answer, an oversized body or a body of another shape. With the mesh's
 * certificate pin, the relay is read only through that pin; without one, `fetcher` checks the
 * certificate as usual.
 */
export async function fetchRelayInfo(relay: string, fetcher: InfoFetcher, opts: { tlsPin?: string; timeoutMs?: number } = {}): Promise<RelayInfo | undefined> {
  // The same rule as dialing: https, or plain http only to loopback.
  if (!isRelayUrl(relay)) return undefined;
  const get = opts.tlsPin === undefined ? fetcher : pinnedFetcher(opts.tlsPin);
  try {
    const res = await get(infoUrl(relay), { signal: AbortSignal.timeout(opts.timeoutMs ?? 5000), redirect: "error", headers: { accept: "application/json" } });
    if (res.status !== 200) return undefined;
    const body = await res.text();
    if (body.length > INFO_MAX_BYTES) return undefined;
    const parsed = InfoSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const MiB = 1024 * 1024;

/** A byte count in plain words: whole MiB when it is one, else bytes. */
function bytes(n: number): string {
  return n % MiB === 0 ? `${n / MiB} MiB` : `${n} bytes`;
}

/** The info as lines for a person: the create mode, the limits in words, and the offer as the relay's text. */
export function describeInfo(info: RelayInfo): string[] {
  const mode = { open: "creates meshes for anyone", key: "creates meshes only with an operator key", closed: "is not accepting new meshes" }[info.create];
  const l = info.limits;
  const limits = [
    l.max_meshes === null ? "no cap on the number of meshes" : `at most ${l.max_meshes} meshes`,
    l.idle_mesh_days === null ? "idle meshes are kept" : `a mesh idle for ${l.idle_mesh_days} days may be removed`,
    `${bytes(l.blob_bytes_per_mesh_per_day)} of files per mesh per day`,
  ];
  return [
    `the relay ${mode}`,
    `relay limits: ${limits.join("; ")}`,
    ...(info.offer === null ? [] : [`relay offer (the relay's own words, not checked): "${relayText(info.offer)}"`]),
  ];
}
