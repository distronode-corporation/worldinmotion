// CI sender fixtures (SPEC section 18): throwaway issuers for GitHub and GitLab tokens, GitHub's
// ID token service, both providers' JWKS URLs, and the relay's CI endpoint answered by the
// in-process relay (`ciPrecheck`, then the mesh's `ci`), so `wim ci notify` and the receiving
// session run end to end with no network.

import type { webcrypto } from "node:crypto";
import { b64u, GITHUB_ISSUER, GITLAB_ISSUER, JWKS_URLS, unverifiedPayload, utf8, type Jwk, type KeyLookup } from "@worldinmotion/protocol";
import { ciPrecheck } from "@worldinmotion/relay-core";
import { RELAY, type RelayHarness } from "./helpers.ts";

export type Issuer = { kid: string; keys: KeyLookup; jwks: string; mint(payload: Record<string, unknown>, header?: Record<string, unknown>): Promise<string> };

const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

export async function issuer(kid = "test-1"): Promise<Issuer> {
  const pair = (await crypto.subtle.generateKey({ ...ALG, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as { n: string; e: string };
  const jwk: Jwk = { kid, n: pub.n, e: pub.e };
  const part = (v: unknown) => b64u.encode(utf8(JSON.stringify(v)));
  return {
    kid,
    keys: async (_iss, k) => (k === kid ? jwk : undefined),
    jwks: JSON.stringify({ keys: [{ kty: "RSA", use: "sig", alg: "RS256", ...jwk }] }),
    async mint(payload, header = { alg: "RS256", kid, typ: "JWT" }) {
      const input = `${part(header)}.${part(payload)}`;
      const sig = new Uint8Array(await crypto.subtle.sign(ALG, pair.privateKey, utf8(input) as Uint8Array<ArrayBuffer>));
      return `${input}.${b64u.encode(sig)}`;
    },
  };
}

let jtis = 0;

/** GitHub token claims for a job of `octo-org/deploys` on main, issued just before `at`. */
export function githubClaims(aud: unknown, at: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const iat = Math.floor(at / 1000) - 60;
  return {
    iss: GITHUB_ISSUER,
    aud,
    jti: `gh-jti-${++jtis}`,
    iat,
    nbf: iat - 600,
    exp: iat + 300,
    repository: "octo-org/deploys",
    repository_id: "74",
    repository_owner_id: "65",
    ref: "refs/heads/main",
    workflow_ref: "octo-org/deploys/.github/workflows/deploy.yml@refs/heads/main",
    event_name: "push",
    sha: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4",
    run_id: "1",
    ...over,
  };
}

/** GitLab token claims for a job of `group/app` on a protected main, issued just before `at`. */
export function gitlabClaims(aud: unknown, at: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const iat = Math.floor(at / 1000) - 60;
  return {
    iss: GITLAB_ISSUER,
    aud,
    jti: `gl-jti-${++jtis}`,
    iat,
    nbf: iat,
    exp: iat + 600,
    project_path: "group/app",
    project_id: "20",
    namespace_id: "11",
    ref: "main",
    ref_type: "branch",
    ref_path: "refs/heads/main",
    ref_protected: "true",
    sha: "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00",
    pipeline_id: "900",
    user_email: "someone@example.com",
    ...over,
  };
}

/** Where the GitHub job's runner asks for ID tokens (`ACTIONS_ID_TOKEN_REQUEST_URL`). */
export const TOKEN_URL = "https://token.test/_apis/idtoken?api-version=2.0";

export type CiWorld = {
  gh: Issuer;
  gl: Issuer;
  /** What the client fetches JWKS with: each provider's fixed URL answered from its issuer. */
  jwksFetch: (url: string) => Promise<{ status: number; text(): Promise<string> }>;
  /** `fetch` for the job: GitHub's token service and the relay's CI endpoint. */
  fetch: typeof fetch;
  /** Overrides the next GitHub token's claims (the audience the job asked for is kept unless given). */
  ghOver: Record<string, unknown>;
  /** Requests the relay's CI endpoint answered, with their bodies. */
  requests: Array<{ url: string; body: Record<string, unknown> }>;
  /** Token service requests (the audience asked for). */
  tokenAsks: string[];
  /** The job's environment on GitHub, and on GitLab with `token` as its wim ID token. */
  githubEnv(): Record<string, string>;
  gitlabEnv(token: string): Record<string, string>;
};

export async function ciWorld(relay: RelayHarness): Promise<CiWorld> {
  const gh = await issuer("gh-1");
  const gl = await issuer("gl-1");
  const world: CiWorld = {
    gh,
    gl,
    jwksFetch: async (url) => {
      const text = url === JWKS_URLS[GITHUB_ISSUER] ? gh.jwks : url === JWKS_URLS[GITLAB_ISSUER] ? gl.jwks : undefined;
      if (text === undefined) throw new Error(`unexpected JWKS url ${url}`);
      return { status: 200, text: async () => text };
    },
    ghOver: {},
    requests: [],
    tokenAsks: [],
    fetch: (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://token.test/")) {
        const aud = new URL(url).searchParams.get("audience")!;
        world.tokenAsks.push(aud);
        return new Response(JSON.stringify({ value: await gh.mint(githubClaims(aud, relay.now(), world.ghOver)) }), { status: 200 });
      }
      const m = new RegExp(`^${RELAY.replace("ws://", "http://")}/v1/([A-Za-z0-9_-]+)/ci$`).exec(url);
      if (m === null || init?.method !== "POST") throw new Error(`unexpected request ${url}`);
      const text = String(init.body);
      world.requests.push({ url, body: JSON.parse(text) as Record<string, unknown> });
      const pre = await ciPrecheck(text, { enabled: true, keys: gh.keys, now: relay.now() });
      const answer = pre.ok ? relay.relay(m[1]!).ci(pre.req, { source: "job", ...(pre.github === undefined ? {} : { github: pre.github }) }) : pre.answer;
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: answer.retryAfter === undefined ? {} : { "retry-after": String(answer.retryAfter) } });
    }) as typeof fetch,
    githubEnv: () => ({ GITHUB_ACTIONS: "true", ACTIONS_ID_TOKEN_REQUEST_URL: TOKEN_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runtime-bearer" }),
    gitlabEnv: (token) => ({ GITLAB_CI: "true", WIM_CI_ID_TOKEN: token }),
  };
  return world;
}

/** The `aud` claim of a token, read without verifying it. */
export function audOf(token: string): unknown {
  const p = unverifiedPayload(token);
  return p.ok ? p.value["aud"] : undefined;
}
