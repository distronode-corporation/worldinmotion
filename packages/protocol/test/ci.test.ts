import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import {
  checkCiPlaintext,
  checkCiTimes,
  checkSendAudience,
  ciAtFresh,
  ciCandidateTags,
  ciClaims,
  ciDedupeExpiry,
  ciNoticeOf,
  ciOneTimeKey,
  ciOpenRequest,
  ciRecipientCode,
  ciRefMatches,
  ciRuleRefSchema,
  ciRuleTag,
  ciSenderId,
  githubAudience,
  githubCountingKey,
  githubSeen,
  CI_REF_MAX,
  isCiFullRef,
  isCiRefPattern,
  isCiRuleRef,
  gitlabAudience,
  gitlabCountingKey,
  parseCiRecipientCode,
  parseCiRequest,
  sealCiNotice,
  verifyCiPrekey,
  verifyCiToken,

  type GithubClaims,
} from "../src/ci.ts";
import type { CiNotice } from "../src/ci-schema.ts";
import { b64u, canon, canonBytes, sha256, utf8 } from "../src/encoding.ts";
import { deviceIdFromSignPub, generateDeviceKeys, LIMITS, openBox, parseClientFrame, parseRelayFrame, signObject, ulid } from "../src/index.ts";
import { GITHUB_ISSUER, GITLAB_ISSUER, type Jwk } from "../src/jwt.ts";
import { sealBox } from "../src/keyring.ts";
import { createPrekey, type Prekey } from "../src/prekey.ts";
import { fixtureKeys, githubClaims, gitlabClaims, mintToken, FIXTURE_ISSUER_JWK, FIXTURE_KID } from "../scripts/ci-issuer.ts";

const T = 1760000000000;
const HOUR = 3_600_000;
const RELAY = "wss://relay.example";
const MESH = b64u.encode(sha256(utf8("ci test mesh")).subarray(0, 16));
const keys = generateDeviceKeys();
const SIGN = b64u.encode(keys.signPub);
const DEVICE = deviceIdFromSignPub(keys.signPub);
const made = createPrekey({ mesh: MESH, deviceId: DEVICE, signSec: keys.signSec, at: T - HOUR });
const prekey: Prekey = made.prekey;
const me = { mesh: MESH, device: DEVICE, name: "deploys" };
const secretOf = (id: string) => (id === prekey.id ? made.secret : undefined);

function github(over: Record<string, unknown> = {}, text = "deployed") {
  const otk = ciOneTimeKey();
  const token = mintToken(githubClaims(githubAudience(MESH, DEVICE, otk.pub), T, over));
  return { otk, token, ...sealCiNotice({ mesh: MESH, device: DEVICE, prekey, to: "deploys", text, token, via: "github", otk, at: T }) };
}

function gitlab(over: Record<string, unknown> = {}) {
  const token = mintToken(gitlabClaims(gitlabAudience(MESH, DEVICE), T, over));
  return { token, ...sealCiNotice({ mesh: MESH, device: DEVICE, prekey, to: "deploys", text: "pipeline passed", token, via: "gitlab", at: T }) };
}

function open(notice: unknown) {
  const r = ciOpenRequest(notice, me);
  if (!r.ok) return r;
  return checkCiPlaintext(r.value.notice, openBox(undefined, secretOf, r.value.req));
}

describe("the recipient code", () => {
  it("round-trips, deriving the device id from the signing key", () => {
    const code = ciRecipientCode({ relay: RELAY, mesh: MESH, sign: SIGN });
    expect(code.startsWith("wimci1_")).toBe(true);
    expect(parseCiRecipientCode(code)).toEqual({ ok: true, value: { relay: RELAY, mesh: MESH, sign: SIGN, device: DEVICE } });
  });

  it("refuses to make a code from bad parts", () => {
    expect(() => ciRecipientCode({ relay: "https://relay.example", mesh: MESH, sign: SIGN })).toThrow(TypeError);
    expect(() => ciRecipientCode({ relay: RELAY, mesh: MESH, sign: "short" })).toThrow(TypeError);
  });

  it("refuses every other spelling", () => {
    const body = (v: unknown) => `wimci1_${b64u.encode(utf8(typeof v === "string" ? v : canon(v)))}`;
    const bad = [
      7,
      "wim1_abc",
      `wimci1_${"A".repeat(4100)}`,
      "wimci1_AB",
      `wimci1_${b64u.encode(new Uint8Array([0xff]))}`,
      body("{"),
      body({ relay: RELAY, mesh: MESH, sign: SIGN, extra: 1 }),
      body({ relay: "ws://relay.example", mesh: MESH, sign: SIGN }),
      // Not canonical: whitespace, and keys out of order.
      body(`{"mesh":"${MESH}", "relay":"${RELAY}","sign":"${SIGN}"}`),
      body(`{"relay":"${RELAY}","mesh":"${MESH}","sign":"${SIGN}"}`),
    ];
    for (const code of bad) expect(parseCiRecipientCode(code), String(code).slice(0, 40)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("derivations", () => {
  it("gives each audience its fixed form", () => {
    const otk = ciOneTimeKey().pub;
    const gh = githubAudience(MESH, DEVICE, otk);
    expect(gh).toMatch(/^wimci1\.[A-Za-z0-9_-]{43}$/);
    expect(githubAudience(MESH, DEVICE, ciOneTimeKey().pub)).not.toBe(gh);
    expect(gitlabAudience(MESH, DEVICE)).toBe(`wimci1.${MESH}.${DEVICE}`);
  });

  it("derives a 22-character CI sender id and rule tag, the tag without case in the repository", () => {
    expect(ciSenderId(ciOneTimeKey().pub)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const t = { mesh: MESH, device: DEVICE, iss: GITHUB_ISSUER, repo: "Octo/Repo", ref: "refs/heads/main" };
    expect(ciRuleTag(t)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(ciRuleTag({ ...t, repo: "octo/repo" })).toBe(ciRuleTag(t));
    expect(ciRuleTag({ ...t, ref: "refs/tags/main" })).not.toBe(ciRuleTag(t));
  });

  it("counts GitHub notices by repository ids and GitLab ones per device", () => {
    expect(githubCountingKey(GITHUB_ISSUER, "1", "2")).toMatch(/^gh~[A-Za-z0-9_-]{22}$/);
    expect(githubCountingKey(GITHUB_ISSUER, "1", "2")).not.toBe(githubCountingKey(GITHUB_ISSUER, "2", "1"));
    expect(gitlabCountingKey(DEVICE)).toBe(`gl~${DEVICE}`);
  });
});

describe("refs and ref patterns", () => {
  const cp = (n: number) => "x".repeat(n);

  it("tells a full ref from a pattern, and refuses every other spelling", () => {
    for (const r of ["refs/heads/main", "refs/tags/v3.3.0", "refs/heads/release/1.x", "refs/tags/é"]) {
      expect([isCiFullRef(r), isCiRefPattern(r), isCiRuleRef(r)], r).toEqual([true, false, true]);
    }
    for (const p of ["refs/tags/v*", "refs/heads/release/*", "refs/tags/*", "refs/heads/*"]) {
      expect([isCiFullRef(p), isCiRefPattern(p), isCiRuleRef(p)], p).toEqual([false, true, true]);
    }
    const refused = [
      "*",
      "",
      "refs/*",
      "refs/heads/",
      "refs/tags/",
      "refs/pull/1/merge",
      "refs/pull/*",
      "main",
      "v*",
      "refs/tags/v**",
      "refs/tags/*v",
      "refs/tags/v*.0",
      "refs/heads/a*b*",
      "refs/tags/v?",
      "refs/tags/v[0-9]*",
      "refs/tags/v[0]",
      "refs/tags/v\\*",
      "refs/tags/a\\b",
      "refs/heads/a?b",
      "refs/tags/v 1*",
      "refs/tags/v\t*",
      "refs/tags/v\u0000",
      "refs/tags/v\u007f*",
      "refs/heads/main\n",
      "Refs/heads/main",
    ];
    for (const r of refused) expect([isCiFullRef(r), isCiRefPattern(r), isCiRuleRef(r)], JSON.stringify(r)).toEqual([false, false, false]);
    for (const v of [undefined, null, 1, ["refs/heads/main"], { ref: "refs/heads/main" }]) {
      expect([isCiFullRef(v), isCiRefPattern(v), isCiRuleRef(v)]).toEqual([false, false, false]);
    }
  });

  it("holds both forms to 255 code points, counting characters, not UTF-16 units", () => {
    expect(CI_REF_MAX).toBe(255);
    const full = `refs/heads/${cp(255 - 11)}`;
    expect(isCiFullRef(full)).toBe(true);
    expect(isCiFullRef(`${full}x`)).toBe(false);
    const pattern = `refs/tags/${cp(255 - 11)}*`;
    expect([...pattern].length).toBe(255);
    expect(isCiRefPattern(pattern)).toBe(true);
    expect(isCiRefPattern(`refs/tags/${cp(255 - 10)}*`)).toBe(false);
    // 244 astral characters are 488 UTF-16 units but 255 code points with the prefix.
    const astral = `refs/heads/${"\u{1F680}".repeat(244)}`;
    expect(astral.length).toBeGreaterThan(255);
    expect(isCiFullRef(astral)).toBe(true);
    expect(isCiFullRef(`${astral}x`)).toBe(false);
  });

  it("checks a rule's ref as a schema", () => {
    expect(ciRuleRefSchema.safeParse("refs/tags/v*").success).toBe(true);
    expect(ciRuleRefSchema.safeParse("refs/heads/main").success).toBe(true);
    expect(ciRuleRefSchema.safeParse("refs/tags/v*1").success).toBe(false);
    expect(ciRuleRefSchema.safeParse(7).success).toBe(false);
  });

  it("matches a full ref exactly and a pattern by its prefix, the prefix itself included", () => {
    expect(ciRefMatches("refs/heads/main", "refs/heads/main")).toBe(true);
    expect(ciRefMatches("refs/heads/main", "refs/heads/main2")).toBe(false);
    expect(ciRefMatches("refs/heads/main", "refs/heads/Main")).toBe(false);
    expect(ciRefMatches("refs/tags/v*", "refs/tags/v3.3.0")).toBe(true);
    expect(ciRefMatches("refs/tags/v*", "refs/tags/v")).toBe(true);
    expect(ciRefMatches("refs/tags/v*", "refs/tags/V3")).toBe(false);
    expect(ciRefMatches("refs/tags/v*", "refs/heads/v3")).toBe(false);
    expect(ciRefMatches("refs/tags/v*", "refs/tags/")).toBe(false);
    expect(ciRefMatches("refs/heads/release/*", "refs/heads/release/1/hotfix")).toBe(true);
    expect(ciRefMatches("refs/heads/release/*", "refs/heads/release")).toBe(false);
    expect(ciRefMatches("refs/tags/*", "refs/tags/anything")).toBe(true);
    // The star is never a wildcard in the token's ref, and a rule outside the syntax matches nothing.
    expect(ciRefMatches("refs/tags/v*", "refs/tags/v*")).toBe(true);
    expect(ciRefMatches("refs/heads/main", "refs/heads/*")).toBe(false);
    for (const bad of ["*", "refs/*", "refs/tags/v**", "refs/tags/*v", "", "refs/heads/a b"]) {
      expect(ciRefMatches(bad, "refs/tags/v1"), bad).toBe(false);
      expect(ciRefMatches(bad, bad), bad).toBe(false);
    }
  });

  it("gives the relay the exact tag and one per prefix pattern, so a device's pattern tag is among them", () => {
    const t = { mesh: MESH, device: DEVICE, iss: GITHUB_ISSUER, repo: "Octo-Org/Deploys", ref: "refs/tags/v3.3.0" };
    const tags = ciCandidateTags(t);
    expect(tags).toHaveLength(t.ref.length + 2);
    expect(tags[0]).toBe(ciRuleTag(t));
    expect(tags[1]).toBe(ciRuleTag({ ...t, ref: "*" }));
    expect(tags.at(-1)).toBe(ciRuleTag({ ...t, ref: "refs/tags/v3.3.0*" }));
    for (const p of ["refs/tags/v*", "refs/tags/*", "refs/tags/v3.*", "refs/tags/v3.3.0*"]) expect(tags, p).toContain(ciRuleTag({ ...t, ref: p }));
    for (const p of ["refs/tags/w*", "refs/heads/*", "refs/tags/v3.3.0.1*"]) expect(tags, p).not.toContain(ciRuleTag({ ...t, ref: p }));
    expect(new Set(tags).size).toBe(tags.length);
    // The repository's case is not in the tag, as for an exact rule.
    expect(ciCandidateTags({ ...t, repo: "octo-org/deploys" })).toEqual(tags);
  });

  it("caps the candidates at 255 patterns, so a long ref costs at most 256 hashes", () => {
    const t = { mesh: MESH, device: DEVICE, iss: GITHUB_ISSUER, repo: "o/r" };
    const at254 = `refs/tags/${cp(254 - 10)}`;
    expect(ciCandidateTags({ ...t, ref: at254 })).toHaveLength(256);
    expect(ciCandidateTags({ ...t, ref: at254 }).at(-1)).toBe(ciRuleTag({ ...t, ref: `${at254}*` }));
    const at255 = `${at254}x`;
    const c255 = ciCandidateTags({ ...t, ref: at255 });
    expect(c255).toHaveLength(256);
    expect(c255.at(-1)).toBe(ciRuleTag({ ...t, ref: `${at254}*` }));
    expect(c255).not.toContain(ciRuleTag({ ...t, ref: `${at255}*` }));
    const long = ciCandidateTags({ ...t, ref: `refs/tags/${cp(1000)}` });
    expect(long).toHaveLength(256);
    expect(long.at(-1)).toBe(ciRuleTag({ ...t, ref: `refs/tags/${cp(244)}*` }));
    // The longest pattern a rule may hold is always a candidate for a ref under it.
    const longest = `refs/tags/${cp(244)}*`;
    expect(isCiRefPattern(longest)).toBe(true);
    expect(long).toContain(ciRuleTag({ ...t, ref: longest }));
    expect(ciCandidateTags({ ...t, ref: "" })).toEqual([ciRuleTag({ ...t, ref: "" }), ciRuleTag({ ...t, ref: "*" })]);
  });

  it("cuts prefixes between characters, never inside one", () => {
    const t = { mesh: MESH, device: DEVICE, iss: GITHUB_ISSUER, repo: "o/r", ref: "refs/tags/\u{1F680}1" };
    const tags = ciCandidateTags(t);
    expect(tags).toHaveLength([...t.ref].length + 2);
    expect(tags).toContain(ciRuleTag({ ...t, ref: "refs/tags/\u{1F680}*" }));
  });
});

describe("parseCiRequest", () => {
  it("reads both requests", () => {
    const g = github();
    expect(parseCiRequest(JSON.stringify(g.request))).toEqual({ ok: true, value: g.request });
    expect(parseCiRequest(JSON.stringify(gitlab().request)).ok).toBe(true);
    expect(parseCiRequest(JSON.stringify({ t: "ci.prekey", device: DEVICE, via: "gitlab" })).ok).toBe(true);
  });

  it("refuses what is not one", () => {
    const g = github().request;
    const { otk: _otk, sig: _sig, ...unsigned } = g;
    const gl = gitlab().request;
    const cases: [unknown, string][] = [
      [5, "malformed"],
      ["x".repeat(LIMITS.ciRequestBytes + 1), "too_large"],
      ["{", "not_json"],
      ['{"t":"ci.prekey","t":"ci.send"}', "duplicate_key"],
      ["null", "malformed"],
      [JSON.stringify({ t: "send" }), "malformed"],
      [JSON.stringify({ t: "ci.prekey", device: DEVICE, via: "jenkins" }), "malformed"],
      [JSON.stringify({ ...g, extra: 1 }), "malformed"],
      [JSON.stringify({ ...unsigned, token: g.token }), "malformed"],
      [JSON.stringify({ ...g, token: undefined }), "malformed"],
      [JSON.stringify({ ...gl, token: g.token }), "malformed"],
      [JSON.stringify({ ...gl, otk: g.otk }), "malformed"],
      [JSON.stringify({ ...g, box: { ...g.box, s: 1 } }), "malformed"],
    ];
    for (const [text, reason] of cases) expect(parseCiRequest(text), String(text).slice(0, 60)).toEqual({ ok: false, reason });
  });
});

describe("verifyCiPrekey", () => {
  const r = { mesh: MESH, sign: SIGN };
  const resign = (over: Partial<Prekey>) => {
    const { sig: _sig, ...body } = { ...prekey, ...over };
    return signObject("prekey", body, keys.signSec);
  };

  it("accepts the device's own prekey", () => {
    expect(verifyCiPrekey(prekey, r, T)).toEqual({ ok: true, value: prekey });
  });

  it("refuses anything else, with its reason", () => {
    const other = generateDeviceKeys();
    const lowOrder = b64u.encode(new Uint8Array(32));
    const cases: [unknown, string, number?][] = [
      [{ ...prekey, extra: 1 }, "malformed"],
      [{ ...prekey, mesh: b64u.encode(new Uint8Array(16)) }, "wrong_mesh"],
      [createPrekey({ mesh: MESH, deviceId: deviceIdFromSignPub(other.signPub), signSec: other.signSec, at: T }).prekey, "wrong_device"],
      [resign({ id: "AAAAAAAAAAAAAAAAAAAAAA" }), "bad_id"],
      [{ ...prekey, sig: signObject("prekey", { a: 1 }, keys.signSec).sig }, "bad_signature"],
      [resign({ until: prekey.at }), "bad_window"],
      [resign({ until: prekey.at + LIMITS.prekeyLifetimeMs + 1 }), "bad_window"],
      [resign({ pub: lowOrder, id: deviceIdFromSignPub(new Uint8Array(32)) }), "bad_key"],
      [prekey, "not_yet", prekey.at - LIMITS.messageMaxFutureMs - 1],
      [prekey, "expired", prekey.until],
    ];
    for (const [pk, reason, now] of cases) expect(verifyCiPrekey(pk, r, now ?? T), reason).toEqual({ ok: false, reason });
  });
});

describe("sealing and opening a notice", () => {
  it("seals a GitHub notice that the device opens and the one-time key signed", () => {
    const g = github();
    expect(g.request.token).toBe(g.token);
    expect(ciNoticeOf(g.request)).toEqual(g.notice);
    expect("token" in g.notice).toBe(false);
    const p = open(g.notice);
    expect(p).toEqual({ ok: true, value: { v: 1, kind: "ci", id: g.notice.id, device: DEVICE, to: "deploys", at: T, text: "deployed", token: g.token } });
  });

  it("seals a GitLab notice with no one-time key and the token only inside the box", () => {
    const g = gitlab();
    expect(g.request).toEqual(g.notice);
    expect(g.notice.otk).toBeUndefined();
    expect(JSON.stringify(g.request)).not.toContain(g.token.split(".")[1]);
    expect(open(g.notice).ok).toBe(true);
  });

  it("refuses to seal what must not go out", () => {
    const base = { mesh: MESH, device: DEVICE, prekey, to: "deploys", text: "x", token: github().token, at: T };
    expect(() => sealCiNotice({ ...base, via: "gitlab", text: "é".repeat(2049) })).toThrow(RangeError);
    expect(() => sealCiNotice({ ...base, via: "gitlab", text: `token ${github().token}` })).toThrow(/appears to contain a secret \(jwt\)/);
    expect(() => sealCiNotice({ ...base, via: "github" })).toThrow(/one-time key/);
    expect(() => sealCiNotice({ ...base, via: "gitlab", otk: ciOneTimeKey() })).toThrow(/one-time key/);
    expect(() => sealCiNotice({ ...base, via: "gitlab", to: "Not A Name" })).toThrow(/sealCiNotice: to:/);
    expect(() => sealCiNotice({ ...base, via: "gitlab", token: "x".repeat(LIMITS.ciTokenBytes + 1) })).toThrow(/sealCiNotice: token:/);
    expect(() => sealCiNotice({ ...base, via: "gitlab", mesh: "not a mesh" })).toThrow(/sealCiNotice: mesh:/);
  });

  it("lets the person's own override send text that looks like a credential", () => {
    const token = github().token;
    const s = sealCiNotice({ mesh: MESH, device: DEVICE, prekey, to: "deploys", text: token, token, via: "gitlab", at: T, allowSecrets: true, id: ulid(T) });
    expect(open(s.notice).ok).toBe(true);
  });

  it("refuses a notice for another mesh, device or session before opening it", () => {
    const n = gitlab().notice;
    expect(ciOpenRequest({ ...n, extra: 1 }, me)).toEqual({ ok: false, reason: "malformed" });
    expect(ciOpenRequest(n, { ...me, mesh: b64u.encode(new Uint8Array(16)) })).toEqual({ ok: false, reason: "wrong_mesh" });
    expect(ciOpenRequest(n, { ...me, device: "AAAAAAAAAAAAAAAAAAAAAA" })).toEqual({ ok: false, reason: "not_addressed" });
    expect(ciOpenRequest(n, { ...me, name: "other" })).toEqual({ ok: false, reason: "not_addressed" });
  });

  it("computes the sender from xk, so a changed header or swapped xk does not open", () => {
    const n = gitlab().notice;
    expect(open({ ...n, at: n.at + 1 })).toEqual({ ok: false, reason: "decrypt_failed" });
    expect(open({ ...n, xk: b64u.encode(x25519.getPublicKey(sha256(utf8("other")))) })).toEqual({ ok: false, reason: "decrypt_failed" });
    const r = ciOpenRequest(n, me);
    expect(r.ok && checkCiPlaintext(r.value.notice, openBox(undefined, () => undefined, r.value.req))).toEqual({ ok: false, reason: "key_expired" });
  });

  // A box sealed by hand around any plaintext, the way a hostile sender could.
  function sealRaw(plaintext: Uint8Array, header: Record<string, unknown>): CiNotice {
    const xkSec = sha256(utf8("raw xk"));
    const xk = b64u.encode(x25519.getPublicKey(xkSec));
    const h = { t: "ci.send", mesh: MESH, id: ulid(T), device: DEVICE, to: "deploys", at: T, via: "gitlab", xk, ...header };
    const box = sealBox(xkSec, { mesh: MESH, sender: ciSenderId(xk), recipient: DEVICE, recipientBox: new Uint8Array(32), prekey: { id: prekey.id, pub: b64u.decode(prekey.pub) }, aad: sha256(canonBytes(h)), plaintext });
    return { ...h, box } as CiNotice;
  }

  it("refuses a plaintext that is not exactly the canonical one for its header", () => {
    const token = gitlab().token;
    const body = (over: Record<string, unknown> = {}) => ({ v: 1, kind: "ci", id: "01K70000000000000000000C20", device: DEVICE, to: "deploys", at: T, text: "t", token, ...over });
    const header = { id: "01K70000000000000000000C20" };
    expect(open(sealRaw(canonBytes(body()), header)).ok).toBe(true);
    expect(open(sealRaw(new Uint8Array([0xff, 0xfe]), header))).toEqual({ ok: false, reason: "plaintext_malformed" });
    expect(open(sealRaw(utf8("{"), header))).toEqual({ ok: false, reason: "plaintext_malformed" });
    expect(open(sealRaw(canonBytes(body({ kind: "msg" })), header))).toEqual({ ok: false, reason: "plaintext_malformed" });
    expect(open(sealRaw(utf8(JSON.stringify(body(), null, 1)), header))).toEqual({ ok: false, reason: "plaintext_malformed" });
    for (const over of [{ id: "01K70000000000000000000C21" }, { device: "AAAAAAAAAAAAAAAAAAAAAA" }, { to: "other" }, { at: T + 1 }]) {
      expect(open(sealRaw(canonBytes(body(over)), header)), JSON.stringify(over)).toEqual({ ok: false, reason: "header_mismatch" });
    }
  });
});

describe("verifyCiToken", () => {
  it("verifies a GitHub notice's token and returns its claims", async () => {
    const g = github({ environment: "production" });
    const r = await verifyCiToken(g.token, g.notice, fixtureKeys);
    expect(r.ok).toBe(true);
    const c = (r as { value: GithubClaims }).value;
    expect(c).toMatchObject({ via: "github", repository: "octo-org/deploys", repositoryId: "74", ownerId: "65", ref: "refs/heads/main", event: "push", environment: "production" });
    expect(c.workflowRef).toBe("octo-org/deploys/.github/workflows/deploy.yml@refs/heads/main");
  });

  it("verifies a GitLab notice's token, reading ref_protected as GitLab writes it", async () => {
    const g = gitlab({ environment: "production", environment_protected: "true" });
    const r = await verifyCiToken(g.token, g.notice, fixtureKeys);
    expect(r).toMatchObject({ ok: true, value: { via: "gitlab", projectPath: "octo-group/site", projectId: "20", namespaceId: "4", ref: "refs/heads/main", refProtected: true, environment: "production", environmentProtected: true, sha: expect.any(String), pipelineId: "1000" } });
  });

  it("refuses the token of another one-time key, device or mesh: the replay with a new key", async () => {
    const a = github();
    const b = github();
    // b's notice carries a's token: its audience names a's one-time key, not b's.
    expect(await verifyCiToken(a.token, b.notice, fixtureKeys)).toEqual({ ok: false, reason: "wrong_audience" });
    const gl = gitlab({ aud: gitlabAudience(MESH, "AAAAAAAAAAAAAAAAAAAAAA") });
    expect(await verifyCiToken(gl.token, gl.notice, fixtureKeys)).toEqual({ ok: false, reason: "wrong_audience" });
  });

  it("refuses a GitHub notice whose signature is not the one-time key's", async () => {
    const g = github();
    const forged = { ...g.notice, sig: signObject("ci", { x: 1 }, g.otk.sec).sig };
    expect(await verifyCiToken(g.token, forged, fixtureKeys)).toEqual({ ok: false, reason: "bad_otk_signature" });
    // A changed `to` is no longer what the one-time key signed.
    expect(await verifyCiToken(g.token, { ...g.notice, to: "other" }, fixtureKeys)).toEqual({ ok: false, reason: "bad_otk_signature" });
  });

  it("refuses a token of the wrong provider, header, key or signature", async () => {
    const g = github();
    const gl = gitlab();
    const flip = (t: string) => `${t.slice(0, -2)}${t.at(-2) === "A" ? "B" : "A"}${t.at(-1)}`;
    expect(await verifyCiToken(gl.token, { ...gl.notice, via: "github" } as CiNotice, fixtureKeys)).toEqual({ ok: false, reason: "bad_issuer" });
    expect(await verifyCiToken(mintToken({}, { alg: "none", kid: "k" }), g.notice, fixtureKeys)).toEqual({ ok: false, reason: "bad_header" });
    expect(await verifyCiToken(flip(g.token), g.notice, fixtureKeys)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verifyCiToken(g.token, g.notice, async () => undefined)).toEqual({ ok: false, reason: "unknown_key" });
    const weak: Jwk = { kid: FIXTURE_KID, n: FIXTURE_ISSUER_JWK.n, e: "Aw" };
    expect(await verifyCiToken(g.token, g.notice, async () => weak)).toEqual({ ok: false, reason: "weak_key" });
  });

  it("checks the time only when given a clock, as a relay does", async () => {
    const g = github();
    const iat = Math.floor(T / 1000) - 60;
    expect((await verifyCiToken(g.token, g.notice, fixtureKeys, T)).ok).toBe(true);
    // exp is iat + 300 s; 5 minutes of skew after it still passes.
    expect((await verifyCiToken(g.token, g.notice, fixtureKeys, (iat + 300) * 1000 + LIMITS.ciSkewMs)).ok).toBe(true);
    expect(await verifyCiToken(g.token, g.notice, fixtureKeys, (iat + 300) * 1000 + LIMITS.ciSkewMs + 1)).toEqual({ ok: false, reason: "token_expired" });
    // nbf is iat - 600 s.
    expect(await verifyCiToken(g.token, g.notice, fixtureKeys, (iat - 600) * 1000 - LIMITS.ciSkewMs - 1)).toEqual({ ok: false, reason: "token_not_yet" });
    const noNbf = github({ nbf: undefined });
    expect(await verifyCiToken(noNbf.token, noNbf.notice, fixtureKeys, iat * 1000 - LIMITS.ciSkewMs - 1)).toEqual({ ok: false, reason: "token_not_yet" });
    // Without a clock, an expired token still verifies: a queued notice arrives late.
    expect((await verifyCiToken(g.token, g.notice, fixtureKeys)).ok).toBe(true);
  });

  it("refuses a token missing a claim the rule needs", async () => {
    for (const over of [{ repository: undefined }, { workflow_ref: 5 }, { run_id: "" }, { environment: 7 }, { sha: "s".repeat(1025) }]) {
      const g = github(over);
      expect(await verifyCiToken(g.token, g.notice, fixtureKeys), JSON.stringify(over)).toEqual({ ok: false, reason: "bad_claims" });
    }
    for (const over of [{ project_id: undefined }, { ref_type: "merge" }, { ref_protected: "yes" }, { ref_protected: undefined }, { environment_protected: "maybe" }, { pipeline_id: 5 }]) {
      const g = gitlab(over);
      expect(await verifyCiToken(g.token, g.notice, fixtureKeys), JSON.stringify(over)).toEqual({ ok: false, reason: "bad_claims" });
    }
  });
});

describe("ciClaims for GitLab refs", () => {
  const base = { iss: GITLAB_ISSUER, aud: "a", jti: "j", iat: 1, exp: 2 };
  const p = (over: Record<string, unknown>) => ({ project_path: "g/p", project_id: "1", namespace_id: "2", ref: "v1", ref_type: "tag", ref_protected: false, ...over });

  it("builds the full ref from ref_type when ref_path is absent, and reads boolean flags", () => {
    expect(ciClaims("gitlab", p({}), base)).toEqual({ ok: true, value: { ...base, via: "gitlab", projectPath: "g/p", projectId: "1", namespaceId: "2", ref: "refs/tags/v1", refProtected: false } });
    expect(ciClaims("gitlab", p({ ref_type: "branch", ref: "main", ref_protected: true, environment_protected: false }), base)).toMatchObject({
      ok: true,
      value: { ref: "refs/heads/main", refProtected: true, environmentProtected: false },
    });
  });

  it("prefers ref_path, so a tag named like a branch keeps its own ref", () => {
    expect(ciClaims("gitlab", p({ ref: "main", ref_path: "refs/tags/main" }), base)).toMatchObject({ ok: true, value: { ref: "refs/tags/main" } });
  });
});

describe("the receiver's times and memory", () => {
  const claims = { iss: GITHUB_ISSUER, aud: "a", jti: "j", iat: T / 1000 - 60, nbf: T / 1000 - 660, exp: T / 1000 + 240 };

  it("accepts `at` inside the token's window give or take 5 minutes, never comparing exp with now", () => {
    expect(checkCiTimes(T, claims, T)).toEqual({ ok: true, value: true });
    // A day later the token has expired, but the notice is still fresh and inside its window.
    expect(checkCiTimes(T, claims, T + 24 * HOUR)).toEqual({ ok: true, value: true });
    expect(checkCiTimes(claims.exp * 1000 + LIMITS.ciTokenWindowSkewMs + 1, claims, T)).toEqual({ ok: false, reason: "outside_token_window" });
    expect(checkCiTimes(claims.nbf * 1000 - LIMITS.ciTokenWindowSkewMs - 1, claims, T)).toEqual({ ok: false, reason: "outside_token_window" });
    const { nbf: _nbf, ...noNbf } = claims;
    expect(checkCiTimes(noNbf.iat * 1000 - LIMITS.ciTokenWindowSkewMs - 1, noNbf, T)).toEqual({ ok: false, reason: "outside_token_window" });
  });

  it("applies the message freshness window first", () => {
    expect(checkCiTimes(T, claims, T + 48 * HOUR)).toEqual({ ok: false, reason: "too_old" });
    expect(checkCiTimes(T, claims, T - 11 * 60_000)).toEqual({ ok: false, reason: "too_new" });
  });

  it("remembers ids until the later of the freshness memory and the token's life", () => {
    expect(ciDedupeExpiry(T, T / 1000 + 300)).toBe(T + LIMITS.dedupeRetentionMs);
    const longJob = T / 1000 + 50 * 3600;
    expect(ciDedupeExpiry(T, longJob)).toBe(longJob * 1000 + LIMITS.ciJtiRetentionMs);
  });
});

describe("checkSendAudience", () => {
  it("passes only the one expected wimci1. string", () => {
    expect(checkSendAudience({ aud: "wimci1.x" }, "wimci1.x")).toEqual({ ok: true, value: true });
    expect(checkSendAudience({ aud: ["wimci1.x"] }, "wimci1.x")).toEqual({ ok: false, reason: "aud_array" });
    expect(checkSendAudience({ aud: "https://gitlab.com" }, "wimci1.x")).toEqual({ ok: false, reason: "not_wim_audience" });
    expect(checkSendAudience({ aud: "sts.amazonaws.com" }, "wimci1.x")).toEqual({ ok: false, reason: "not_wim_audience" });
    expect(checkSendAudience({}, "wimci1.x")).toEqual({ ok: false, reason: "not_wim_audience" });
    expect(checkSendAudience({ aud: "wimci1.y" }, "wimci1.x")).toEqual({ ok: false, reason: "wrong_audience" });
  });
});

describe("what a relay keeps", () => {
  it("keeps the tag, counting key, a jti hash and the expiry, never a claim", async () => {
    const g = github();
    const r = await verifyCiToken(g.token, g.notice, fixtureKeys);
    const claims = (r as { value: GithubClaims }).value;
    const seen = githubSeen(claims, MESH, DEVICE);
    const exact = { mesh: MESH, device: DEVICE, iss: GITHUB_ISSUER, repo: "octo-org/deploys", ref: "refs/heads/main" };
    expect(seen.tags[0]).toBe(ciRuleTag(exact));
    expect(seen.tags).toEqual(ciCandidateTags(exact));
    expect(seen.tags).toContain(ciRuleTag({ ...exact, ref: "refs/heads/*" }));
    expect(seen.key).toBe(githubCountingKey(GITHUB_ISSUER, "65", "74"));
    expect(seen.jti).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(seen.jti).toBe(b64u.encode(sha256(utf8(`${GITHUB_ISSUER} ${claims.jti}`))));
    // Exactly these four fields, each checked above, so no claim is kept. (The tags hash a random
    // device id, so matching words in the serialised record would fail now and then.)
    expect(Object.keys(seen).sort()).toEqual(["exp", "jti", "key", "tags"]);
    expect(seen.exp).toBe((Math.floor(T / 1000) + 240) * 1000);
  });

  it("allows 5 minutes of skew on a request's at", () => {
    expect(ciAtFresh(T + LIMITS.ciSkewMs, T)).toBe(true);
    expect(ciAtFresh(T - LIMITS.ciSkewMs - 1, T)).toBe(false);
  });
});

describe("CI frames on the WebSocket", () => {
  const tags = Array.from({ length: 64 }, (_, i) => b64u.encode(sha256(utf8(String(i)))).slice(0, 22));

  it("parses ci.rules from a session, up to 64 tags", () => {
    expect(parseClientFrame(JSON.stringify({ t: "ci.rules", tags, gitlab: true }))).toMatchObject({ ok: true });
    expect(parseClientFrame(JSON.stringify({ t: "ci.rules", tags: [...tags, tags[0]], gitlab: false }))).toEqual({ ok: false, reason: "malformed" });
    expect(parseClientFrame(JSON.stringify({ t: "ci.rules", tags: [], gitlab: false }), { preAuth: true })).toEqual({ ok: false, reason: "unknown_type" });
  });

  it("parses the relay's ci.rules answer and ci.deliver, a delivered notice strictly", () => {
    const n = github().notice;
    expect(parseRelayFrame(JSON.stringify({ t: "ci.rules", count: 3, more: "ignored" }))).toMatchObject({ ok: true });
    expect(parseRelayFrame(JSON.stringify({ t: "ci.deliver", cursor: 4, msg: n }))).toMatchObject({ ok: true, value: { msg: n } });
    expect(parseRelayFrame(JSON.stringify({ t: "ci.deliver", cursor: 4, msg: { ...n, token: "a.b.c" } }))).toEqual({ ok: false, reason: "malformed" });
  });

  it("is signed under its own label, so a ci signature never passes as a send", () => {
    const otk = ed25519.utils.randomSecretKey();
    const signed = signObject("ci", { a: 1 }, otk);
    expect(signed.sig).not.toBe(signObject("send", { a: 1 }, otk).sig);
  });
});
