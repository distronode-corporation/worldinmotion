// The credential the proxy adds, held only in the privileged runner's memory. Workload Identity
// Federation uses the Anthropic SDK's own exchange (RFC 7523 jwt-bearer at /v1/oauth/token) and
// its token cache, which refreshes in this process before expiry. Every step has a time limit.

import type { Auth } from "./config.ts";
import { fetchIdentityToken, type IdentityDeps } from "./identity.ts";
import type { UpstreamAuth } from "./proxy.ts";

/** Longest a token exchange or an identity mint may take. */
export const AUTH_TIMEOUT_MS = 30_000;

/** The beta flag a request signed with an OAuth bearer token needs (the SDK's OAUTH_API_BETA_HEADER). */
export const OAUTH_BETA = "oauth-2025-04-20";

export interface TokenSource {
  getToken(): Promise<string>;
}

/** The SDK's provider and cache, as they are used here; loaded on demand (an optional peer). */
export interface AnthropicCredentials {
  oidcFederationProvider(config: {
    identityTokenProvider: () => Promise<string>;
    federationRuleId: string;
    organizationId: string;
    serviceAccountId?: string;
    workspaceId?: string;
    baseURL: string;
    fetch: typeof fetch;
  }): unknown;
  TokenCache: new (provider: never, onAdvisoryRefreshError?: (err: unknown) => void) => TokenSource;
}

export async function loadAnthropicCredentials(): Promise<AnthropicCredentials> {
  const federation = await import("@anthropic-ai/sdk/lib/credentials/oidc-federation");
  const cache = await import("@anthropic-ai/sdk/lib/credentials/token-cache");
  return { oidcFederationProvider: federation.oidcFederationProvider as never, TokenCache: cache.TokenCache as never };
}

/** Rejects when `p` takes longer than `ms`. */
export function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} s`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export interface AuthDeps {
  identity: IdentityDeps;
  credentials: () => Promise<AnthropicCredentials>;
  fetch: typeof fetch;
  log: (line: string) => void;
}

/** The headers for one upstream request, from the profile's sign-in. */
export async function upstreamAuth(auth: Auth, apiKey: string | undefined, upstream: string, deps: AuthDeps): Promise<UpstreamAuth> {
  if (auth.type === "api-key") {
    const key = apiKey!;
    return async () => ({ "x-api-key": key });
  }
  const sdk = await deps.credentials();
  const timedFetch = ((url: string, init?: RequestInit) => deps.fetch(url, { ...init, signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) })) as typeof fetch;
  const provider = sdk.oidcFederationProvider({
    identityTokenProvider: () => within(fetchIdentityToken(auth.identity, auth.audience, deps.identity), AUTH_TIMEOUT_MS, "the identity token"),
    federationRuleId: auth.federationRuleId,
    organizationId: auth.organizationId,
    serviceAccountId: auth.serviceAccountId,
    ...(auth.workspaceId === undefined ? {} : { workspaceId: auth.workspaceId }),
    baseURL: upstream,
    fetch: timedFetch,
  });
  const cache = new sdk.TokenCache(provider as never, (err) => deps.log(`token refresh failed: ${(err as Error).name}`));
  // The first exchange happens now, so a sign-in failure fails the job before it starts.
  const token = () => within(cache.getToken(), AUTH_TIMEOUT_MS * 2, "the token exchange");
  await token();
  return async () => ({ authorization: `Bearer ${await token()}`, "anthropic-beta": OAUTH_BETA });
}
