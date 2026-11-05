// A throwaway CI token issuer for tests (SPEC section 18): an RSA key made at run time with
// WebCrypto, tokens it signs, and a key lookup that serves it as a JWKS would.

import type { webcrypto } from "node:crypto";
import { b64u, GITHUB_ISSUER, utf8, type Jwk, type KeyLookup } from "@worldinmotion/protocol";

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

/** GitHub token claims for a job of `octo-org/deploys` on main, issued just before `at`. */
export function githubClaims(aud: string, at: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const iat = Math.floor(at / 1000) - 60;
  return {
    iss: GITHUB_ISSUER,
    aud,
    jti: `jti-${Math.random()}`,
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
