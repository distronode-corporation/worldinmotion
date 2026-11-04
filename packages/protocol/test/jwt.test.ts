import { describe, expect, it } from "vitest";
import { b64u, utf8 } from "../src/encoding.ts";
import {
  baseClaims,
  GITHUB_ISSUER,
  GITLAB_ISSUER,
  JWKS_URLS,
  JwksCache,
  parseJwks,
  parseJwt,
  unverifiedPayload,
  verifyJwtSignature,
  type Jwk,
  type Jwt,
} from "../src/jwt.ts";
import { FIXTURE_ISSUER_JWK, FIXTURE_JWKS, FIXTURE_KID, mintToken } from "../scripts/ci-issuer.ts";

const part = (v: unknown): string => b64u.encode(utf8(typeof v === "string" ? v : JSON.stringify(v)));
const HEADER = { alg: "RS256", kid: FIXTURE_KID, typ: "JWT" };
const PAYLOAD = { iss: GITHUB_ISSUER, aud: "wimci1.x", jti: "j", iat: 1000, exp: 1300 };
const KEY: Jwk = { kid: FIXTURE_KID, n: FIXTURE_ISSUER_JWK.n, e: FIXTURE_ISSUER_JWK.e };
const sigOf = (t: string) => t.split(".")[2]!;

function parsed(token: string): Jwt {
  const r = parseJwt(token);
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}

describe("parseJwt", () => {
  it("reads a well-formed RS256 token", () => {
    const jwt = parsed(mintToken(PAYLOAD));
    expect(jwt.kid).toBe(FIXTURE_KID);
    expect(jwt.payload).toEqual(PAYLOAD);
    expect(jwt.signature.length).toBe(256);
  });

  it("refuses what is not a compact JWS", () => {
    const valid = mintToken(PAYLOAD);
    for (const bad of [undefined, 42, "", "a.b", "a.b.c.d", `${valid}=`, "a=.b.c", "x".repeat(8193)]) {
      expect(parseJwt(bad)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("refuses a part that is not canonical base64url, or not a JSON object", () => {
    const [h, p, s] = mintToken(PAYLOAD).split(".") as [string, string, string];
    // "AB" has stray bits after its one byte: a second spelling of 0x00.
    for (const bad of [`AB.${p}.${s}`, `${h}.AB.${s}`, `${h}.${p}.AB`, `${part("[1]")}.${p}.${s}`, `${h}.${part("null")}.${s}`, `${h}.${part("{")}.${s}`]) {
      expect(parseJwt(bad)).toEqual({ ok: false, reason: "malformed" });
    }
    // Invalid UTF-8 in the header.
    expect(parseJwt(`${b64u.encode(new Uint8Array([0xff, 0xfe]))}.${p}.${s}`)).toEqual({ ok: false, reason: "malformed" });
    // A repeated key could be read two ways.
    expect(parseJwt(`${part('{"alg":"none","alg":"RS256","kid":"k"}')}.${p}.${s}`)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses every header but plain RS256 with a key id", () => {
    const headers: Record<string, unknown>[] = [
      { alg: "none", kid: "k" },
      { alg: "HS256", kid: "k" },
      { alg: "rs256", kid: "k" },
      { alg: "RS256" },
      { alg: "RS256", kid: "" },
      { alg: "RS256", kid: "k".repeat(257) },
      { alg: "RS256", kid: 7 },
      { alg: "RS256", kid: "k", typ: "at+jwt" },
      { alg: "RS256", kid: "k", crit: ["exp"] },
      { alg: "RS256", kid: "k", jku: "https://attacker.example" },
      { alg: "RS256", kid: "k", jwk: {} },
      { alg: "RS256", kid: "k", x5u: "https://attacker.example" },
      { alg: "RS256", kid: "k", x5c: [] },
    ];
    for (const h of headers) expect(parseJwt(mintToken(PAYLOAD, h)), JSON.stringify(h)).toEqual({ ok: false, reason: "bad_header" });
    expect(parseJwt(mintToken(PAYLOAD, { alg: "RS256", kid: "k" })).ok).toBe(true);
  });
});

describe("unverifiedPayload", () => {
  it("reads the payload of any well-formed token, refused header or not", () => {
    expect(unverifiedPayload(mintToken(PAYLOAD, { alg: "none", kid: "k" }))).toEqual({ ok: true, value: PAYLOAD });
  });

  it("refuses what does not parse", () => {
    const [h, , s] = mintToken(PAYLOAD).split(".");
    for (const bad of [7, "a.b", `${h}.${part("[1]")}.${s}`]) expect(unverifiedPayload(bad)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("verifyJwtSignature", () => {
  it("accepts the issuer's signature", async () => {
    expect(await verifyJwtSignature(parsed(mintToken(PAYLOAD)), KEY)).toEqual({ ok: true, value: true });
  });

  it("refuses a forged signature: one bit changed, or another key's", async () => {
    const token = mintToken(PAYLOAD);
    const flipped = sigOf(token).replace(/^./, (c) => (c === "A" ? "B" : "A"));
    expect(await verifyJwtSignature(parsed(`${token.split(".").slice(0, 2).join(".")}.${flipped}`), KEY)).toEqual({ ok: false, reason: "bad_signature" });
    const other = { ...PAYLOAD, aud: "wimci1.y" };
    const swapped = `${token.split(".").slice(0, 2).join(".")}.${sigOf(mintToken(other))}`;
    expect(await verifyJwtSignature(parsed(swapped), KEY)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a signature that is not as long as the modulus", async () => {
    const jwt = parsed(mintToken(PAYLOAD));
    expect(await verifyJwtSignature({ ...jwt, signature: jwt.signature.subarray(1) }, KEY)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a weak or malformed key", async () => {
    const jwt = parsed(mintToken(PAYLOAD));
    const n = b64u.decode(KEY.n);
    const weak: Jwk[] = [
      { ...KEY, e: "Aw" },
      { ...KEY, n: "not base64url!" },
      { ...KEY, n: b64u.encode(n.subarray(0, 255)) },
      { ...KEY, n: b64u.encode(new Uint8Array([0, ...n])) },
      { ...KEY, n: b64u.encode(new Uint8Array(1025).fill(1)) },
    ];
    for (const k of weak) expect(await verifyJwtSignature(jwt, k)).toEqual({ ok: false, reason: "weak_key" });
  });
});

describe("baseClaims", () => {
  it("takes the shared claims, nbf when present", () => {
    expect(baseClaims(PAYLOAD, GITHUB_ISSUER)).toEqual({ ok: true, value: PAYLOAD });
    expect(baseClaims({ ...PAYLOAD, nbf: 900 }, GITHUB_ISSUER)).toEqual({ ok: true, value: { ...PAYLOAD, nbf: 900 } });
  });

  it("refuses each bad claim with its reason", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...PAYLOAD, iss: GITLAB_ISSUER }, "bad_issuer"],
      [{ ...PAYLOAD, aud: ["wimci1.x"] }, "aud_array"],
      [{ ...PAYLOAD, aud: 5 }, "bad_audience"],
      [{ ...PAYLOAD, iat: 1.5 }, "bad_claims"],
      [{ ...PAYLOAD, exp: "1300" }, "bad_claims"],
      [{ ...PAYLOAD, iat: -1 }, "bad_claims"],
      [{ ...PAYLOAD, nbf: "0" }, "bad_claims"],
      [{ ...PAYLOAD, jti: 3 }, "bad_claims"],
      [{ ...PAYLOAD, jti: "" }, "bad_claims"],
      [{ ...PAYLOAD, jti: "j".repeat(257) }, "bad_claims"],
      [{ ...PAYLOAD, exp: 1000 }, "bad_lifetime"],
      [{ ...PAYLOAD, exp: 1000 + 86401 }, "bad_lifetime"],
    ];
    for (const [p, reason] of cases) expect(baseClaims(p, GITHUB_ISSUER), reason).toEqual({ ok: false, reason });
    expect(baseClaims({ ...PAYLOAD, exp: 1000 + 86400 }, GITHUB_ISSUER).ok).toBe(true);
  });
});

describe("parseJwks", () => {
  it("keeps the RSA signing keys and skips the rest", () => {
    const text = JSON.stringify({
      keys: [
        ...FIXTURE_JWKS.keys,
        { kty: "RSA", kid: "plain", n: "n", e: "AQAB" },
        { kty: "EC", kid: "ec", crv: "P-256" },
        { kty: "RSA", kid: "enc", n: "n", e: "AQAB", use: "enc" },
        { kty: "RSA", kid: "ps", n: "n", e: "AQAB", alg: "PS256" },
        { kty: "RSA", kid: 5, n: "n", e: "AQAB" },
        { kty: "RSA", kid: "no-n", e: "AQAB" },
        { kty: "RSA", kid: "no-e", n: "n" },
        null,
        "key",
      ],
    });
    const keys = parseJwks(text)!;
    expect([...keys.keys()]).toEqual([FIXTURE_KID, "plain"]);
    expect(keys.get(FIXTURE_KID)).toEqual(KEY);
  });

  it("refuses what is not a JWKS", () => {
    for (const bad of ["{", "null", "{}", '{"keys":{}}', JSON.stringify({ keys: Array(65).fill({}) }), JSON.stringify({ keys: [], pad: "x".repeat(65536) })]) {
      expect(parseJwks(bad), bad.slice(0, 20)).toBeUndefined();
    }
  });
});

describe("JwksCache", () => {
  type Answer = { status: number; body: string } | Error;
  function cache(answers: Answer[], opts: { ttlMs?: number; refetchMs?: number } = {}) {
    let now = 1_000_000;
    const urls: string[] = [];
    const fetched: [string, number][] = [];
    const c = new JwksCache({
      fetch: async (url) => {
        urls.push(url);
        const a = answers.shift() ?? { status: 200, body: JSON.stringify(FIXTURE_JWKS) };
        if (a instanceof Error) throw a;
        return { status: a.status, text: async () => a.body };
      },
      now: () => now,
      ttlMs: opts.ttlMs ?? 3_600_000,
      ...(opts.refetchMs === undefined ? {} : { refetchMs: opts.refetchMs }),
      onFetched: (iss, _text, at) => fetched.push([iss, at]),
    });
    return { c, urls, fetched, advance: (ms: number) => (now += ms) };
  }
  const JWKS = JSON.stringify(FIXTURE_JWKS);

  it("fetches an issuer's fixed URL once and keeps the keys", async () => {
    const { c, urls, fetched } = cache([]);
    expect(await c.key(GITHUB_ISSUER, FIXTURE_KID)).toEqual(KEY);
    expect(await c.key(GITHUB_ISSUER, FIXTURE_KID)).toEqual(KEY);
    expect(urls).toEqual([JWKS_URLS[GITHUB_ISSUER]]);
    expect(fetched).toEqual([[GITHUB_ISSUER, 1_000_000]]);
  });

  it("never fetches for an issuer it does not know", async () => {
    const { c, urls } = cache([]);
    expect(await c.key("https://attacker.example", FIXTURE_KID)).toBeUndefined();
    expect(urls).toEqual([]);
  });

  it("fetches again for an unknown kid at most once a minute", async () => {
    const { c, urls, advance } = cache([]);
    expect(await c.key(GITLAB_ISSUER, "made-up-1")).toBeUndefined();
    expect(await c.key(GITLAB_ISSUER, "made-up-2")).toBeUndefined();
    advance(59_999);
    expect(await c.key(GITLAB_ISSUER, "made-up-3")).toBeUndefined();
    expect(urls.length).toBe(1);
    advance(1);
    expect(await c.key(GITLAB_ISSUER, FIXTURE_KID)).toEqual(KEY);
    expect(urls.length).toBe(1);
    expect(await c.key(GITLAB_ISSUER, "made-up-4")).toBeUndefined();
    expect(urls.length).toBe(2);
  });

  it("fetches again once the keys are older than the time to live", async () => {
    const { c, urls, advance } = cache([], { ttlMs: 10_000, refetchMs: 1000 });
    await c.key(GITHUB_ISSUER, FIXTURE_KID);
    advance(10_000);
    expect(await c.key(GITHUB_ISSUER, FIXTURE_KID)).toEqual(KEY);
    expect(urls.length).toBe(2);
  });

  it("keeps what it held when a fetch fails, but not past the time to live", async () => {
    const { c, advance } = cache([{ status: 200, body: JWKS }, { status: 500, body: "" }, new Error("offline"), { status: 200, body: "not json" }], {
      ttlMs: 10_000,
      refetchMs: 1000,
    });
    expect(await c.key(GITHUB_ISSUER, FIXTURE_KID)).toEqual(KEY);
    for (const step of [1000, 1000, 1000]) {
      advance(step);
      expect(await c.key(GITHUB_ISSUER, "other")).toBeUndefined();
      expect(await c.key(GITHUB_ISSUER, FIXTURE_KID)).toEqual(KEY);
    }
    advance(10_000);
    // The next fetch (the default answer) succeeds again.
    expect(await c.key(GITHUB_ISSUER, FIXTURE_KID)).toEqual(KEY);
  });

  it("lets concurrent lookups share one fetch", async () => {
    const { c, urls } = cache([]);
    const all = await Promise.all([c.key(GITHUB_ISSUER, FIXTURE_KID), c.key(GITHUB_ISSUER, "a"), c.key(GITHUB_ISSUER, FIXTURE_KID)]);
    expect(all).toEqual([KEY, undefined, KEY]);
    expect(urls.length).toBe(1);
  });

  it("takes seeded keys for a known issuer unless it holds newer ones", async () => {
    const { c, urls, advance } = cache([{ status: 200, body: JSON.stringify({ keys: [] }) }]);
    c.seed("https://attacker.example", JWKS, 1_000_000);
    c.seed(GITHUB_ISSUER, "not json", 1_000_000);
    c.seed(GITHUB_ISSUER, JWKS, 999_000);
    expect(await c.key(GITHUB_ISSUER, FIXTURE_KID)).toEqual(KEY);
    expect(urls).toEqual([]);
    c.seed(GITHUB_ISSUER, JSON.stringify({ keys: [] }), 998_000);
    expect(await c.key(GITHUB_ISSUER, FIXTURE_KID)).toEqual(KEY);
    advance(60_000);
    // A newer fetch replaces the seed, and an older seed does not undo it.
    expect(await c.key(GITHUB_ISSUER, "other")).toBeUndefined();
    c.seed(GITHUB_ISSUER, JWKS, 1_000_000);
    expect(await c.key(GITHUB_ISSUER, FIXTURE_KID)).toBeUndefined();
  });

  it("uses a one-minute refetch limit by default", async () => {
    let now = 0;
    let fetches = 0;
    // With no time to live nothing is ever fresh, so every lookup would fetch but for the limit.
    const c = new JwksCache({ fetch: async () => ({ status: 200, text: async () => (fetches++, JWKS) }), now: () => now, ttlMs: 0 });
    expect(await c.key(GITHUB_ISSUER, FIXTURE_KID)).toBeUndefined();
    now = 59_999;
    expect(await c.key(GITHUB_ISSUER, FIXTURE_KID)).toBeUndefined();
    expect(fetches).toBe(1);
    now = 60_000;
    await c.key(GITHUB_ISSUER, FIXTURE_KID);
    expect(fetches).toBe(2);
  });
});
