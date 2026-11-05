// OpenID Connect ID tokens from CI providers (SPEC section 18): a strict compact-JWS parser, RS256
// verification through WebCrypto (in Node and in workerd, so no new dependency), the claim checks
// both providers share, and a JWKS cache that only ever fetches an issuer's fixed URL.

import { b64u, fromUtf8, utf8 } from "./encoding.ts";
import { parseJson } from "./json.ts";
import { fail, LIMITS, ok, type Result } from "./limits.ts";

/** GitHub Actions' issuer. */
export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
/** gitlab.com's issuer. */
export const GITLAB_ISSUER = "https://gitlab.com";

/**
 * Each issuer's JWKS, fixed here (SPEC section 18). A key is never fetched from a URL a token or
 * a relay names, so no request can make a relay or client fetch anything else.
 */
export const JWKS_URLS: Readonly<Record<string, string>> = {
  [GITHUB_ISSUER]: `${GITHUB_ISSUER}/.well-known/jwks`,
  [GITLAB_ISSUER]: `${GITLAB_ISSUER}/oauth/discovery/keys`,
};

/** One RSA verification key from a JWKS, by its `kid`. */
export type Jwk = { kid: string; n: string; e: string };

/** A parsed token: its header and payload, the signed bytes and the signature. */
export type Jwt = { kid: string; payload: Record<string, unknown>; signed: Uint8Array; signature: Uint8Array };

// Three base64url parts. The decoder refuses non-canonical ones (padding, stray bits).
const COMPACT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
// Header members that would let a token name its own key, or demand processing we do not do.
const REFUSED_HEADER = ["crit", "jku", "jwk", "x5u", "x5c"];

function jsonObject(part: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = fromUtf8(b64u.decode(part));
  } catch {
    return undefined;
  }
  const parsed = parseJson(text);
  if (!parsed.ok) return undefined;
  const v = parsed.value;
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Parses a compact JWS without verifying it. Never throws. Reasons: `malformed` (not a string, over
 * 8 KiB, not three canonical base64url parts, or a header or payload that is not a JSON object with
 * no repeated key), `bad_header` (`alg` not exactly `RS256`, no string `kid`, a `typ` other than
 * `JWT`, or any of `crit`, `jku`, `jwk`, `x5u`, `x5c`).
 */
export function parseJwt(token: unknown): Result<Jwt> {
  if (typeof token !== "string" || token.length > LIMITS.ciTokenBytes || !COMPACT.test(token)) return fail("malformed");
  const [h, p, s] = token.split(".") as [string, string, string];
  const header = jsonObject(h);
  const payload = jsonObject(p);
  let signature: Uint8Array;
  try {
    signature = b64u.decode(s);
  } catch {
    return fail("malformed");
  }
  if (header === undefined || payload === undefined) return fail("malformed");
  const kid = header["kid"];
  if (header["alg"] !== "RS256" || typeof kid !== "string" || kid.length === 0 || kid.length > 256) return fail("bad_header");
  if ((header["typ"] !== undefined && header["typ"] !== "JWT") || REFUSED_HEADER.some((k) => Object.hasOwn(header, k))) return fail("bad_header");
  return ok({ kid, payload, signed: utf8(`${h}.${p}`), signature });
}

/**
 * The payload of a token, read without verifying anything: what a sender checks before it sends a
 * token anywhere (the audience). Never throws; `malformed` when it does not parse.
 */
export function unverifiedPayload(token: unknown): Result<Record<string, unknown>> {
  if (typeof token !== "string" || token.length > LIMITS.ciTokenBytes || !COMPACT.test(token)) return fail("malformed");
  const payload = jsonObject(token.split(".")[1]!);
  return payload === undefined ? fail("malformed") : ok(payload);
}

/**
 * Verifies a token's RS256 signature with one key. Never throws. Reasons: `weak_key` (the key is
 * not RSA with `e` 65537 and a modulus of 2048 to 8192 bits in canonical base64url),
 * `bad_signature`.
 */
export async function verifyJwtSignature(jwt: Jwt, key: Jwk): Promise<Result> {
  let n: Uint8Array;
  try {
    n = b64u.decode(key.n);
  } catch {
    return fail("weak_key");
  }
  if (key.e !== "AQAB" || n.length < 256 || n.length > 1024 || n[0] === 0) return fail("weak_key");
  // A signature is exactly as long as the modulus; anything else cannot verify.
  if (jwt.signature.length !== n.length) return fail("bad_signature");
  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const imported = await crypto.subtle.importKey("jwk", { kty: "RSA", n: key.n, e: key.e, alg: "RS256", ext: true }, algorithm, false, ["verify"]);
  const valid = await crypto.subtle.verify(algorithm, imported, jwt.signature as Uint8Array<ArrayBuffer>, jwt.signed as Uint8Array<ArrayBuffer>);
  return valid ? ok(true) : fail("bad_signature");
}

/** The claims every CI token must carry, checked; times in seconds as the token has them. */
export type BaseClaims = { iss: string; aud: string; jti: string; iat: number; exp: number; nbf?: number };

const isSeconds = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/**
 * Checks the claims both providers share. Never throws. Reasons: `bad_issuer` (not `iss`),
 * `aud_array` (an array, which a receiver refuses), `bad_audience` (not a string), `bad_claims`
 * (`iat`, `exp` or `nbf` not whole seconds, or no string `jti`), `bad_lifetime` (`exp` not after
 * `iat`, or more than 24 hours after it).
 */
export function baseClaims(payload: Record<string, unknown>, iss: string): Result<BaseClaims> {
  if (payload["iss"] !== iss) return fail("bad_issuer");
  const aud = payload["aud"];
  if (Array.isArray(aud)) return fail("aud_array");
  if (typeof aud !== "string") return fail("bad_audience");
  const { iat, exp, nbf, jti } = payload;
  if (!isSeconds(iat) || !isSeconds(exp) || (nbf !== undefined && !isSeconds(nbf))) return fail("bad_claims");
  if (typeof jti !== "string" || jti.length === 0 || jti.length > 256) return fail("bad_claims");
  if (exp <= iat || (exp - iat) * 1000 > LIMITS.ciTokenMaxLifetimeMs) return fail("bad_lifetime");
  return ok({ iss, aud, jti, iat, exp, ...(nbf === undefined ? {} : { nbf }) });
}

/** What a JWKS fetch returns: an HTTP status and the body. */
export type JwksFetch = (url: string) => Promise<{ status: number; text(): Promise<string> }>;

/** The usable keys of a JWKS text, by `kid`; undefined when it is not a JWKS at all. */
export function parseJwks(text: string): Map<string, Jwk> | undefined {
  if (text.length > LIMITS.jwksBytes) return undefined;
  const parsed = parseJson(text);
  if (!parsed.ok) return undefined;
  const keys = (parsed.value as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length > 64) return undefined;
  const out = new Map<string, Jwk>();
  for (const k of keys as unknown[]) {
    if (typeof k !== "object" || k === null) continue;
    const { kty, kid, n, e, alg, use } = k as Record<string, unknown>;
    // A key for another algorithm or use is not this one; it is skipped, not trusted.
    if (kty !== "RSA" || typeof kid !== "string" || typeof n !== "string" || typeof e !== "string") continue;
    if ((alg !== undefined && alg !== "RS256") || (use !== undefined && use !== "sig")) continue;
    out.set(kid, { kid, n, e });
  }
  return out;
}

type Held = { keys: Map<string, Jwk>; at: number };

/**
 * Each issuer's verification keys, fetched from its fixed JWKS URL only (`JWKS_URLS`), kept for
 * `ttlMs`, and fetched again for a `kid` not held at most once per `refetchMs` per issuer, so junk
 * tokens with made-up key ids cannot make it fetch. Concurrent lookups share one fetch. A failed
 * or oversized answer keeps what was held. `seed` and `onFetched` let a client keep the keys on
 * disk.
 */
export class JwksCache {
  private readonly held = new Map<string, Held>();
  private readonly tried = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly fetch: JwksFetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly refetchMs: number;
  private readonly onFetched: ((iss: string, text: string, at: number) => void) | undefined;

  constructor(opts: { fetch: JwksFetch; now: () => number; ttlMs: number; refetchMs?: number; onFetched?: (iss: string, text: string, at: number) => void }) {
    this.fetch = opts.fetch;
    this.now = opts.now;
    this.ttlMs = opts.ttlMs;
    this.refetchMs = opts.refetchMs ?? LIMITS.jwksRefetchMs;
    this.onFetched = opts.onFetched;
  }

  /** Takes keys fetched earlier (a client's copy on disk), unless newer ones are held. */
  seed(iss: string, text: string, at: number): void {
    const keys = parseJwks(text);
    if (keys === undefined || !Object.hasOwn(JWKS_URLS, iss) || (this.held.get(iss)?.at ?? -1) >= at) return;
    this.held.set(iss, { keys, at });
  }

  /** The key `kid` of issuer `iss`, or undefined (an unknown issuer, key or fetch failure). */
  async key(iss: string, kid: string): Promise<Jwk | undefined> {
    if (!Object.hasOwn(JWKS_URLS, iss)) return undefined;
    const found = this.fresh(iss)?.get(kid);
    if (found !== undefined) return found;
    // `refresh` records the attempt before its first await, so a lookup made while a fetch is in
    // flight lands in the second branch and waits for that fetch instead of starting another.
    if (this.now() - (this.tried.get(iss) ?? -Infinity) >= this.refetchMs) {
      const run = this.refresh(iss).finally(() => this.inflight.delete(iss));
      this.inflight.set(iss, run);
      await run;
    } else await this.inflight.get(iss);
    return this.fresh(iss)?.get(kid);
  }

  private fresh(iss: string): Map<string, Jwk> | undefined {
    const h = this.held.get(iss);
    return h !== undefined && this.now() - h.at < this.ttlMs ? h.keys : undefined;
  }

  private async refresh(iss: string): Promise<void> {
    const at = this.now();
    this.tried.set(iss, at);
    let text: string;
    try {
      const res = await this.fetch(JWKS_URLS[iss]!);
      if (res.status !== 200) return;
      text = await res.text();
    } catch {
      return;
    }
    const keys = parseJwks(text);
    if (keys === undefined) return;
    this.held.set(iss, { keys, at });
    this.onFetched?.(iss, text, at);
  }
}
