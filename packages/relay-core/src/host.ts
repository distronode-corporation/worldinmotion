import { b64u, hmacSha256, isId22, isMeshId, isRelayUrl, LIMITS, sanitizeForDisplay, utf8 } from "@worldinmotion/protocol";
import type { Limits } from "./relay.ts";

/*
 * What every relay host shares around `MeshRelay`: the dial path, the rate-limit key for a client
 * address, the settings read from the environment, and the `/healthz` answer. relay-node and
 * relay-cloudflare both use these, so the two hosts answer the same way.
 */

// The dial path is `<relay path>/v1/<mesh id>` (SPEC section 8); a proxy or route in front of the
// relay may or may not keep the relay's own path prefix.
const DIAL_PATH = /\/v1\/([^/]*)$/;

/** A dial path's mesh id, or the HTTP status and error a host answers with. */
export type DialPath = { ok: true; meshId: string } | { ok: false; status: 400 | 404; error: string };

/**
 * Parses the path of a request to the relay. Anything that is not `.../v1/<one segment>` is a
 * 404; a segment that is not a mesh id (16 bytes of canonical base64url) is a 400.
 */
export function parseDialPath(pathname: string): DialPath {
  const match = DIAL_PATH.exec(pathname);
  if (match === null) return { ok: false, status: 404, error: "not found" };
  const meshId = match[1]!;
  if (!isMeshId(meshId)) return { ok: false, status: 400, error: "invalid mesh id" };
  return { ok: true, meshId };
}

/** `<prefix>/v1/info`: the relay's public description (`relayInfo`). */
export function isInfoPath(pathname: string): boolean {
  return /\/v1\/info$/.test(pathname);
}

// A short invite code's box (SPEC section 5): relay-wide, so its path names no mesh.
const RDV_PATH = /\/v1\/rdv\/([^/]*)$/;

/** A box path's lookup id, or the HTTP status and error a host answers with. */
export type RdvPath = { ok: true; rdv: string } | { ok: false; status: 400; error: string };

/**
 * `<prefix>/v1/rdv/<id>`: where a joiner fetches a short invite code's box. Undefined for any
 * other path; an id that is not 22 characters of base64url is a 400.
 */
export function parseRdvPath(pathname: string): RdvPath | undefined {
  const match = RDV_PATH.exec(pathname);
  if (match === null) return undefined;
  return isId22(match[1]) ? { ok: true, rdv: match[1] } : { ok: false, status: 400, error: "invalid id" };
}

/** Headers of a box answer: JSON, and never kept by a cache along the way. */
export const RDV_HEADERS: Readonly<Record<string, string>> = { "content-type": "application/json", "cache-control": "no-store" };

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const HEXTET = /^[0-9a-f]{1,4}$/;

/** The eight 16-bit words of an IPv6 address, or undefined for anything else. */
function ipv6Words(text: string): number[] | undefined {
  let s = text;
  // A dotted IPv4 tail (`::ffff:1.2.3.4`) is the last two words.
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (tail !== null) {
    const o = tail.slice(1).map(Number);
    if (o.some((n) => n > 255)) return undefined;
    s = `${s.slice(0, tail.index)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const groups = halves.map((h) => (h === "" ? [] : h.split(":")));
  if (!groups.every((g) => g.every((x) => HEXTET.test(x)))) return undefined;
  const words = groups.map((g) => g.map((x) => parseInt(x, 16)));
  if (words.length === 1) return words[0]!.length === 8 ? words[0] : undefined;
  const missing = 8 - words[0]!.length - words[1]!.length;
  return missing < 1 ? undefined : [...words[0]!, ...Array<number>(missing).fill(0), ...words[1]!];
}

/**
 * The rate-limit bucket of a client address. An IPv4 address is its own bucket, and so is an
 * IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, as a dual-stack socket reports IPv4 clients). An
 * IPv6 address is bucketed by its /64, the block one subscriber or host is usually given, so a
 * client cannot draw fresh limits by rotating addresses inside it. Brackets and a zone id are
 * ignored; anything that is not an IP address is its own bucket, unchanged.
 */
export function sourceBucket(address: string): string {
  const bare = address.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  // The zone id is cut at the first `%` by index, not with a regex that can backtrack.
  const zone = bare.indexOf("%");
  const a = zone < 0 ? bare : bare.slice(0, zone);
  if (IPV4.test(a)) return a;
  const w = ipv6Words(a);
  if (w === undefined) return address;
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return [w[6]! >> 8, w[6]! & 255, w[7]! >> 8, w[7]! & 255].join(".");
  return `${w.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/**
 * The rate-limit key for a client address: the first 22 characters of
 * `b64u(HMAC-SHA-256(secret, sourceBucket(address)))`, under a random secret each relay keeps to
 * itself (relay-node in its database, relay-cloudflare in its registry object). Hosts store and
 * pass on only this key, never the raw address, and without the secret a key cannot be matched
 * to an address by trying every address.
 */
export function sourceKey(address: string, secret: Uint8Array): string {
  return b64u.encode(hmacSha256(secret, utf8(sourceBucket(address)))).slice(0, 22);
}

/** The relay settings both hosts read from their environment (each relay's README lists them). */
export type RelayEnv = {
  WIM_RELAY_URLS?: string;
  WIM_CREATE_KEY?: string;
  WIM_OPEN_CREATE?: string;
  WIM_MAX_MESHES?: string;
  WIM_IDLE_MESH_DAYS?: string;
  WIM_BLOB_BYTES_PER_MESH_PER_DAY?: string;
  WIM_BLOB_BYTES_PER_DEVICE_PER_DAY?: string;
  WIM_BLOB_BYTES_PER_MESH?: string;
  WIM_OFFER?: string;
};

/**
 * `WIM_RELAY_URLS`: comma-separated exact public base URLs, trimmed, empty entries dropped (so an
 * unset or blank value is an empty list). Throws on an entry that is not a relay URL; the message
 * names the entry by position, never by value.
 */
export function parseRelayUrls(value: string | undefined): string[] {
  const urls = (value ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
  urls.forEach((url, i) => {
    if (!isRelayUrl(url)) throw new Error(`WIM_RELAY_URLS entry ${i + 1} is not a relay URL (wss://, or ws:// to loopback, with no trailing slash)`);
  });
  return urls;
}

/** How a relay answers `create`, as `MeshRelay` takes it, plus the configuration problem if any. */
export type CreateRule = { createKey?: string; createRefused?: string; problem?: string };

/** What a client is told when the operator has not opened creation. */
export const CREATE_CLOSED = "this relay does not accept new meshes";
/** What a client is told when the creation settings are wrong (the detail goes to the operator only). */
export const CREATE_MISCONFIGURED = "this relay cannot create meshes until its operator fixes its configuration";

const ON = new Set(["1", "true"]);
const OFF = new Set(["", "0", "false"]);

/**
 * The create rule from `WIM_CREATE_KEY` and `WIM_OPEN_CREATE`. Creation is never open by
 * accident:
 *
 * - a non-empty `WIM_CREATE_KEY` alone: `create` must carry that key;
 * - `WIM_OPEN_CREATE=1` (or `true`) alone: anyone may create a mesh;
 * - neither: every `create` is refused (`CREATE_CLOSED`);
 * - an empty `WIM_CREATE_KEY` (for example a secret pipe that wrote nothing), both settings at
 *   once, or a `WIM_OPEN_CREATE` that is not `1`, `true`, `0`, `false` or empty: a problem, which
 *   refuses every `create` and which the host reports in `/healthz` and its log. The problem
 *   names settings, never their values.
 */
export function createRule(env: RelayEnv): CreateRule {
  const key = env.WIM_CREATE_KEY;
  const open = env.WIM_OPEN_CREATE ?? "";
  let problem: string | undefined;
  if (!ON.has(open) && !OFF.has(open)) problem = "WIM_OPEN_CREATE must be 1 or 0";
  else if (key !== undefined && key.trim() === "") problem = "WIM_CREATE_KEY is set but empty";
  else if (key !== undefined && ON.has(open)) problem = "set WIM_CREATE_KEY or WIM_OPEN_CREATE=1, not both";
  if (problem !== undefined) return { createRefused: CREATE_MISCONFIGURED, problem };
  if (key !== undefined) return { createKey: key };
  return ON.has(open) ? {} : { createRefused: CREATE_CLOSED };
}

/**
 * Everything a host takes from its environment besides the relay URLs: the create rule, the
 * guardrails a hosted relay sets, and the offer text. Every guardrail has a safe default when
 * unset: no mesh cap, no idle expiry, the protocol's limits, no offer.
 */
export type RelaySettings = CreateRule & {
  /** `WIM_MAX_MESHES`: the most meshes the relay holds; `create` past it is `full`. */
  maxMeshes?: number;
  /** `WIM_IDLE_MESH_DAYS`: a mesh with no authenticated session for this many days is deleted. */
  idleMeshDays?: number;
  /** Lower relay-side limits (only ever lower than the protocol's `LIMITS`). */
  limits: Partial<Limits>;
  /** `WIM_OFFER`: one line about the service, shown by clients (for example in `wim doctor`). */
  offer?: string;
};

/** The byte limits an operator may lower, by setting. */
const BYTE_LIMITS = [
  ["WIM_BLOB_BYTES_PER_MESH_PER_DAY", "blobBytesPerMeshPerDay"],
  ["WIM_BLOB_BYTES_PER_DEVICE_PER_DAY", "blobBytesPerDevicePerDay"],
  ["WIM_BLOB_BYTES_PER_MESH", "blobBytesPerMesh"],
] as const;

const UNIT: Record<string, number> = { "": 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 };

/** A whole number of 1 or more, or undefined. */
function count(value: string): number | undefined {
  return /^[1-9]\d{0,8}$/.test(value) ? Number(value) : undefined;
}

/**
 * The relay's settings from its environment (relay-node and relay-cloudflare both read them
 * here). A bad value is a problem, as in `createRule`: the relay refuses every `create`, reports
 * the problem in `/healthz` and its log, and keeps the safe default for that setting. Problems
 * name settings, never their values.
 */
export function relaySettings(env: RelayEnv): RelaySettings {
  const rule = createRule(env);
  const problems: string[] = rule.problem === undefined ? [] : [rule.problem];
  const settings: RelaySettings = { limits: {} };
  const whole = (name: "WIM_MAX_MESHES" | "WIM_IDLE_MESH_DAYS"): number | undefined => {
    const raw = (env[name] ?? "").trim();
    if (raw === "") return undefined;
    const n = count(raw);
    if (n === undefined) problems.push(`${name} must be a whole number of 1 or more`);
    return n;
  };
  const maxMeshes = whole("WIM_MAX_MESHES");
  if (maxMeshes !== undefined) settings.maxMeshes = maxMeshes;
  const idleMeshDays = whole("WIM_IDLE_MESH_DAYS");
  if (idleMeshDays !== undefined) settings.idleMeshDays = idleMeshDays;
  for (const [name, key] of BYTE_LIMITS) {
    const raw = (env[name] ?? "").trim();
    if (raw === "") continue;
    const m = /^(\d{1,13})\s*(kib|mib|gib)?$/i.exec(raw);
    const bytes = m === null ? 0 : Number(m[1]) * UNIT[(m[2] ?? "").toLowerCase()]!;
    if (bytes < 1 || bytes > LIMITS[key]) problems.push(`${name} must be a byte count from 1 to ${LIMITS[key]}: it may only lower the protocol limit`);
    else settings.limits[key] = bytes;
  }
  const offer = (env.WIM_OFFER ?? "").trim();
  if (offer.length > 280 || /[\t\n]/.test(offer) || sanitizeForDisplay(offer) !== offer) {
    problems.push("WIM_OFFER must be one line of at most 280 printable characters");
  } else if (offer !== "") settings.offer = offer;
  if (problems.length > 0) return { createRefused: CREATE_MISCONFIGURED, problem: problems[0]!, limits: {} };
  return { ...rule, ...settings };
}

/** The relay software version `relayInfo` reports (relay-core's package version). */
export const RELAY_VERSION = "0.1.7";

/**
 * The public `GET <prefix>/v1/info` document (format `v` 1). `null` means unlimited, or no offer.
 * `blob_bytes_per_mesh_per_day` is the effective value: the setting, or the protocol limit. No
 * secret and no live count is ever in it.
 */
export type RelayInfo = {
  v: 1;
  software: "worldinmotion-relay";
  version: string;
  create: "key" | "open" | "closed";
  limits: { max_meshes: number | null; idle_mesh_days: number | null; blob_bytes_per_mesh_per_day: number };
  offer: string | null;
};

/** The `/v1/info` document for these settings. `create` is `closed` when creation is refused or misconfigured. */
export function relayInfo(s: RelaySettings): RelayInfo {
  return {
    v: 1,
    software: "worldinmotion-relay",
    version: RELAY_VERSION,
    create: s.createRefused !== undefined ? "closed" : s.createKey !== undefined ? "key" : "open",
    limits: {
      max_meshes: s.maxMeshes ?? null,
      idle_mesh_days: s.idleMeshDays ?? null,
      blob_bytes_per_mesh_per_day: s.limits.blobBytesPerMeshPerDay ?? LIMITS.blobBytesPerMeshPerDay,
    },
    offer: s.offer ?? null,
  };
}

/** The `/healthz` answer: 200 `{"ok":true}`, or 503 with the configuration problem. */
export function healthz(problem: string | undefined): { status: 200 | 503; body: { ok: true } | { ok: false; error: string } } {
  return problem === undefined ? { status: 200, body: { ok: true } } : { status: 503, body: { ok: false, error: problem } };
}
