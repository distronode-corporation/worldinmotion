import { JwksCache, LIMITS, type JwksFetch } from "@worldinmotion/protocol";

/**
 * How the Worker fetches GitHub's JWKS for CI tokens (SPEC section 18): no redirects, 5 seconds
 * at most, and only ever an issuer's fixed URL. A redirect is not followed: its 3xx status comes
 * back, and `JwksCache` takes only a 200. workerd refuses `redirect: "error"` outright (a
 * TypeError before any request), so `manual` is the only way to say no redirects here. Tests
 * replace `jwks.fetch`, since the Worker and the tests share one isolate.
 */
export const jwks: { fetch: JwksFetch } = {
  fetch: (url) => fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) }),
};

let cache: JwksCache | undefined;

/**
 * GitHub's keys, kept per isolate: an hour, and fetched again for an unknown `kid` at most once a
 * minute. Isolates do not share the cache, so the whole relay may fetch a little more often than
 * one process would.
 */
export function ciKeys(): JwksCache {
  cache ??= new JwksCache({ fetch: (url) => jwks.fetch(url), now: () => Date.now(), ttlMs: LIMITS.jwksRelayTtlMs });
  return cache;
}

/** Forgets the kept keys (tests only). */
export function resetCiKeys(): void {
  cache = undefined;
}
