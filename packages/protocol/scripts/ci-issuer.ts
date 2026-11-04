// A fixed RSA key that stands in for a CI provider's token signer (SPEC section 18), for the test
// vectors and the tests of every package. Its private half is published here, so nothing may ever
// trust it: no issuer in JWKS_URLS serves it.

import { createPrivateKey, sign as rsaSign, verify as rsaVerify, createPublicKey } from "node:crypto";
import { b64u, utf8 } from "../src/encoding.ts";
import { GITHUB_ISSUER, GITLAB_ISSUER, type Jwk } from "../src/jwt.ts";

/** The fixture issuer's private key, as a JWK. Public on purpose. */
export const FIXTURE_ISSUER_JWK = {
  kty: "RSA",
  n:
    "tsFz2ip9sDhD1-jQY6sks-cZshRSpcz_E_SH1c79_dsVln_FMmPIrUR-aGwBu3TmU1heKLImJo8pFddN2KmrHLAQ3VAYz-ZozlAq1lQTVoYpJVV0TTmHYvWw32QTIQ2bSJJhb7oFHOck4p7zljaGRl2Db0IFZDjFxD14urxoPmc16d1tbdsjumgrIiABSeB7JTAIvu_NLd3UJHVSmK-qF9nfe47EUcKgO2xUYR_IZoN9YiUH2oMFTtmZtHgn0RBarPPd1ti6jCZ_09jb35GzxjBvKX2YNJqxYP0cnRdL8wvWoxUOnHQAUJBlPtsi-eIt790d7oCanJXJ2IpGPgDV9w",
  e: "AQAB",
  d:
    "CtyzChB-D-87X3Kfw1mOTbMHb_Im4PviKhZEMvNukGjPftzXpG5FCydUnz6fWIjskTkujE5D8WuPQZREzpym_7mA0-aWBiVOE8hOaeOG-Ry-oIPUhpJ_KkteckIvpBNIjqbeOHz4Um0NxpQAxLjQ5w9ZZ7XacPtLpdirFRsFoLYsiIVDnyvCh1wDx6U1Cr5hd7khpEgswv-DmgkW5Uzhj7vUhs7ZmpxKfuHmIX6BevrT1xs109MewPPFvpNjlWWg8mTnqf90mLxUmQJAeWWssxpaHUZ7BuNuw7W0PX5EtSwbjKjzrUDvY5N-d8sMMoO3Uzkt005YiXea2MZ7oJL_AQ",
  p:
    "-R1IRnJUER54Qdp_mBCnH_mzB1T6H-LSN-j-NQHPU60qWLAbo7_lMD9iZ41pGZG5_TCOzaorloGg0qhKfIenmuVok6sMz3LJGyBoQ5DNZfUJTUstMgCfJzbfHjNXf_MFltn1kAxmEZS5bjWtztEjFGgeMljQ1dCZ_6GajNvAE6E",
  q:
    "u86ew715ZV8Yc9gLd16_8NMykjmFg1aKrVLDqOulXihmKe1Zwf3x7CylpU8SPDg-Wl5XEqlQD2vXBDLagdtI5A50Y22GFSYHFB3hOUVETDBGfmB0-SwlBRg1wxsWCX__QvFCYjx38G9prf_7RotIT7PFyqOpNPT8FbDhqNTOApc",
  dp:
    "SWB-sYFrkb9P3NXnT3tYPurl-Prm0g2VrjJK7oIh95vCJW16NrmHYLbK3YWht45dIl7zMVE2lZaJMIOxrQyoKc_5BcYUd-ZvpjXdgEletvF-U-4Y2emk94AKKHMnCuEifFSnKE7-oZ8VH4lgMNMZaiFhA6N1oAVZ1xpa07LG2QE",
  dq:
    "deP-z1p6AMNQAzAECpukmxTIMvf-snI5vREuFzRM6y0q7Hi8lkTFfv6LwJhBFyIrKej8eY9k3TlRkKYnecpgGCBmuR9AQrhLSzpybdPoSncnWR9NbjhiyK7o2J-BFteNMcVmaWoR1BDr4rjEUAUQkE-GAmz3w3FhaHBPRv7GjuM",
  qi:
    "9Tz3WAShtsLkQBLhudjMx38OEKA_edvEWcAE2asaojcN3QogvBkJgLfhLGr-_Lxe2ZWgxMM3QN70jjxhHtJLhOs63kOhWzJhVTULefL3ZmnPTMMY8xiSLEvcJMAVqTrvR4ghKDudLi68AUomspW9AmfDhYzworfbxyExGvWGZUk",
} as const;

/** The key id the fixture tokens carry. */
export const FIXTURE_KID = "wim-vectors-ci-1";

/** The fixture issuer's JWKS, as an issuer would serve it. */
export const FIXTURE_JWKS = {
  keys: [{ kty: "RSA", kid: FIXTURE_KID, use: "sig", alg: "RS256", n: FIXTURE_ISSUER_JWK.n, e: FIXTURE_ISSUER_JWK.e }],
};

const privateKey = createPrivateKey({ key: { ...FIXTURE_ISSUER_JWK }, format: "jwk" });
const publicKey = createPublicKey({ key: { kty: "RSA", n: FIXTURE_ISSUER_JWK.n, e: FIXTURE_ISSUER_JWK.e }, format: "jwk" });

const part = (v: unknown): string => b64u.encode(utf8(JSON.stringify(v)));

/** A compact JWS over `header` and `payload`, signed RS256 by the fixture key (synchronous). */
export function mintToken(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: FIXTURE_KID, typ: "JWT" }): string {
  const input = `${part(header)}.${part(payload)}`;
  return `${input}.${b64u.encode(rsaSign("sha256", utf8(input), privateKey))}`;
}

/** Whether the fixture key signed `token` (synchronous; for checks inside the vector builder). */
export function fixtureSigned(token: string): boolean {
  const [h, p, s] = token.split(".") as [string, string, string];
  return rsaVerify("sha256", utf8(`${h}.${p}`), publicKey, b64u.decode(s));
}

/** A key lookup that serves the fixture key for any issuer, as a fixture JWKS would. */
export async function fixtureKeys(_iss: string, kid: string): Promise<Jwk | undefined> {
  return kid === FIXTURE_KID ? { kid, n: FIXTURE_ISSUER_JWK.n, e: FIXTURE_ISSUER_JWK.e } : undefined;
}

/** The claims of the GitHub token issued just before `at`, with GitHub's sample times: `exp` = `iat` + 300, `nbf` = `iat` - 600. */
export function githubClaims(aud: string, at: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const iat = Math.floor(at / 1000) - 60;
  return {
    iss: GITHUB_ISSUER,
    aud,
    sub: "repo:octo-org/deploys:ref:refs/heads/main",
    jti: "6f7d3c4e-0d6b-4d2e-9a1e-0c1d2e3f4a5b",
    iat,
    nbf: iat - 600,
    exp: iat + 300,
    repository: "octo-org/deploys",
    repository_id: "74",
    repository_owner: "octo-org",
    repository_owner_id: "65",
    ref: "refs/heads/main",
    ref_type: "branch",
    workflow: "Deploy",
    workflow_ref: "octo-org/deploys/.github/workflows/deploy.yml@refs/heads/main",
    event_name: "push",
    sha: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4",
    run_id: "1234567890",
    actor: "octocat",
    actor_id: "1",
    ...over,
  };
}

/** The claims of the GitLab token issued just before `at`, for a one-hour job, `ref_protected` as the string GitLab writes. */
export function gitlabClaims(aud: string, at: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const iat = Math.floor(at / 1000) - 60;
  return {
    iss: GITLAB_ISSUER,
    aud,
    sub: "project_path:octo-group/site:ref_type:branch:ref:main",
    jti: "1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9",
    iat,
    nbf: iat - 5,
    exp: iat + 3600,
    project_path: "octo-group/site",
    project_id: "20",
    namespace_id: "4",
    namespace_path: "octo-group",
    ref: "main",
    ref_type: "branch",
    ref_path: "refs/heads/main",
    ref_protected: "true",
    pipeline_id: "1000",
    sha: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4",
    user_login: "pipeline-user",
    ...over,
  };
}

