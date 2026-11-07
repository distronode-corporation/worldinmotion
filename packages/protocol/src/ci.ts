// CI senders (SPEC section 18): a CI job that is not a mesh member sends one information-only
// notice to one session, proving where it runs with its provider's OIDC ID token. This module has
// the codes, audiences, tags and keys every party derives, the wire schemas, sealing and opening a
// notice, and the token checks the relay (GitHub only) and the receiving client (both) run.

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { z } from "zod";
import { findSecrets } from "./agent.ts";
import { b64u, bytesEqual, canon, canonBytes, fitsUtf8, fromUtf8, sha256, utf8 } from "./encoding.ts";
import { deviceIdFromSignPub, randomBytes, ulid } from "./ids.ts";
import { parseJson } from "./json.ts";
import { baseClaims, GITHUB_ISSUER, GITLAB_ISSUER, parseJwt, verifyJwtSignature, type BaseClaims, type Jwk } from "./jwt.ts";
import { sealBox, type Opened, type OpenRequest } from "./keyring.ts";
import { fail, LIMITS, ok, PROTOCOL, type Result } from "./limits.ts";
import { prekeyId, prekeySchema, prekeyUsable, type Prekey } from "./prekey.ts";
import { checkFreshness } from "./replay.ts";
import {
  ciNoticeSchema,
  ciPlaintextSchema,
  ciPrekeyRequestSchema,
  ciSendRequestSchema,
  type CiNotice,
  type CiPlaintext,
  type CiRequest,
  type CiSendRequest,
  type CiVia,
} from "./ci-schema.ts";
import { keySchema, meshIdSchema, relayUrlSchema, safeParse } from "./schema.ts";
import { signObject, verifyObject } from "./sign.ts";



/** The issuer each provider's tokens must name. */
export const CI_ISSUERS: Readonly<Record<CiVia, string>> = { github: GITHUB_ISSUER, gitlab: GITLAB_ISSUER };

const cut22 = (bytes: Uint8Array): string => b64u.encode(bytes).slice(0, 22);

// ---- the recipient code ----

const CODE_PREFIX = "wimci1_";
const codeBodySchema = z.strictObject({ relay: relayUrlSchema, mesh: meshIdSchema, sign: keySchema });

/** What a recipient code names: the relay, the mesh and the device, by its public signing key. */
export type CiRecipient = { relay: string; mesh: string; sign: string; device: string };

/** The recipient code a device's person puts in a CI variable (SPEC section 18). Not a secret. */
export function ciRecipientCode(r: { relay: string; mesh: string; sign: string }): string {
  const body = safeParse(codeBodySchema, { relay: r.relay, mesh: r.mesh, sign: r.sign });
  if (!body.success) throw new TypeError("ciRecipientCode: a relay URL, a mesh id and a 32-byte signing key");
  return CODE_PREFIX + b64u.encode(canonBytes(body.data));
}

/**
 * Reads a recipient code. Never throws. `malformed` for anything but the canonical encoding of
 * exactly a relay URL, a mesh id and a 32-byte signing key; the device id is derived, never read.
 */
export function parseCiRecipientCode(code: unknown): Result<CiRecipient> {
  if (typeof code !== "string" || !code.startsWith(CODE_PREFIX) || code.length > 4096) return fail("malformed");
  let text: string;
  try {
    text = fromUtf8(b64u.decode(code.slice(CODE_PREFIX.length)));
  } catch {
    return fail("malformed");
  }
  const json = parseJson(text);
  const body = json.ok ? safeParse(codeBodySchema, json.value) : undefined;
  // One spelling per code, as for every signed or hashed object.
  if (body?.success !== true || canon(body.data) !== text) return fail("malformed");
  return ok({ ...body.data, device: deviceIdFromSignPub(b64u.decode(body.data.sign)) });
}

// ---- derivations ----

/** The audience of a GitHub token for one notice: it names the sender's one-time key. */
export function githubAudience(mesh: string, device: string, otk: string): string {
  return `wimci1.${b64u.encode(sha256(utf8(`${PROTOCOL} ci aud ${mesh} ${device} ${otk}`)))}`;
}

/** The fixed audience a GitLab job declares in `id_tokens:` for one device. */
export function gitlabAudience(mesh: string, device: string): string {
  return `wimci1.${mesh}.${device}`;
}

/** The CI sender id in a notice box's HPKE info: derived from `xk`, never read from a frame. */
export function ciSenderId(xk: string): string {
  return cut22(sha256(utf8(`${PROTOCOL} ci sender ${xk}`)));
}

/** A device's rule tag for the relay: a hash of (mesh, device, issuer, repository, ref). */
export function ciRuleTag(t: { mesh: string; device: string; iss: string; repo: string; ref: string }): string {
  const label = utf8(`${PROTOCOL} ci rule `);
  const body = canonBytes({ mesh: t.mesh, device: t.device, iss: t.iss, repo: t.repo.toLowerCase(), ref: t.ref });
  const bytes = new Uint8Array(label.length + body.length);
  bytes.set(label);
  bytes.set(body, label.length);
  return cut22(sha256(bytes));
}

// ---- refs and ref patterns ----

/** The longest full ref or ref pattern a rule holds, in Unicode code points (SPEC section 18). */
export const CI_REF_MAX = 255;

// No glob character (`*`, `?`, `[`, `\`) in a name: git refuses each in a ref, so a pattern's only
// special character is its one trailing `*`.
const FULL_REF = /^refs\/(?:heads|tags)\/[^\s\u0000-\u001f\u007f*?[\\]+$/;
const REF_PATTERN = /^refs\/(?:heads|tags)\/[^\s\u0000-\u001f\u007f*?[\\]*\*$/;

const codePoints = (s: string): number => [...s].length;

/** A full ref a rule may hold: `refs/heads/<name>` or `refs/tags/<name>`, no glob character, at most 255 code points. */
export function isCiFullRef(v: unknown): boolean {
  return typeof v === "string" && FULL_REF.test(v) && codePoints(v) <= CI_REF_MAX;
}

/** A ref pattern: `refs/heads/` or `refs/tags/`, a name part with no glob character, then one trailing `*`. */
export function isCiRefPattern(v: unknown): boolean {
  return typeof v === "string" && REF_PATTERN.test(v) && codePoints(v) <= CI_REF_MAX;
}

/** What a rule's `ref` may be: a full ref or a ref pattern. */
export function isCiRuleRef(v: unknown): v is string {
  return isCiFullRef(v) || isCiRefPattern(v);
}

/** A rule's `ref` as a schema: a full ref or a ref pattern, nothing else. */
export const ciRuleRefSchema = z.string().refine(isCiRuleRef, "a full ref (refs/heads/... or refs/tags/...) or one with a single trailing *");

/**
 * Whether a token's full ref falls under a rule's ref (SPEC section 18): equal to a full ref, or
 * starting with a pattern's prefix (the prefix itself included). False for a rule ref that is
 * neither, so a hostile or corrupt rule matches nothing.
 */
export function ciRefMatches(ruleRef: string, ref: string): boolean {
  if (isCiFullRef(ruleRef)) return ref === ruleRef;
  return isCiRefPattern(ruleRef) && ref.startsWith(ruleRef.slice(0, -1));
}

/**
 * The tags a relay compares with a device's for a verified token's (repository, ref): the exact
 * one, then one for each prefix of `ref` of k code points followed by `*`, k from 0 to the smaller
 * of its length and 254 (SPEC section 18). Every prefix is tried, whether or not a rule could hold
 * it, so the device never names its patterns to the relay. At most 256 tags.
 */
export function ciCandidateTags(t: { mesh: string; device: string; iss: string; repo: string; ref: string }): string[] {
  const chars = [...t.ref];
  const tags = [ciRuleTag(t)];
  const last = Math.min(chars.length, CI_REF_MAX - 1);
  for (let k = 0; k <= last; k++) tags.push(ciRuleTag({ ...t, ref: `${chars.slice(0, k).join("")}*` }));
  return tags;
}

/** The key a GitHub repository's notices are counted under: its ids, so a rename keeps the count. */
export function githubCountingKey(iss: string, ownerId: string, repoId: string): string {
  return `gh~${cut22(sha256(utf8(`${PROTOCOL} ci count ${iss} ${ownerId} ${repoId}`)))}`;
}

/** The key a device's GitLab notices are counted under: one share per device. */
export function gitlabCountingKey(device: string): string {
  return `gl~${device}`;
}

/**
 * Parses a CI sender's HTTP request body. Never throws. Reasons: `too_large` (over 32 KiB),
 * `not_json`, `duplicate_key`, `malformed` (anything else, unknown keys included).
 */
export function parseCiRequest(text: unknown): Result<CiRequest> {
  if (typeof text !== "string") return fail("malformed");
  if (!fitsUtf8(text, LIMITS.ciRequestBytes)) return fail("too_large");
  const json = parseJson(text);
  if (!json.ok) return json;
  const t = (json.value as { t?: unknown } | null)?.t;
  const schema = t === "ci.send" ? ciSendRequestSchema : t === "ci.prekey" ? ciPrekeyRequestSchema : undefined;
  const parsed = schema === undefined ? undefined : safeParse<CiRequest>(schema, json.value);
  return parsed?.success === true ? ok(parsed.data) : fail("malformed");
}

// ---- the prekey a sender seals to ----

// Any fixed scalar: X25519 with a low-order point throws.
const PROBE = sha256(utf8("wim/1 ci prekey probe"));

/**
 * Checks the prekey a relay handed a CI sender against the recipient code (SPEC section 18): the
 * checks of SPEC section 6b with the roster replaced by the code's signing key. Never throws.
 * Reasons: `malformed`, `wrong_mesh`, `wrong_device`, `bad_id`, `bad_signature`, `bad_window`,
 * `bad_key`, `not_yet`, `expired`.
 */
export function verifyCiPrekey(raw: unknown, r: { mesh: string; sign: string }, now: number): Result<Prekey> {
  const parsed = safeParse(prekeySchema, raw);
  if (!parsed.success) return fail("malformed");
  const pk = parsed.data;
  if (pk.mesh !== r.mesh) return fail("wrong_mesh");
  const signPub = b64u.decode(r.sign);
  if (pk.device !== deviceIdFromSignPub(signPub)) return fail("wrong_device");
  const pub = b64u.decode(pk.pub);
  if (prekeyId(pub) !== pk.id) return fail("bad_id");
  if (!verifyObject("prekey", pk, signPub)) return fail("bad_signature");
  if (pk.until <= pk.at || pk.until - pk.at > LIMITS.prekeyLifetimeMs) return fail("bad_window");
  try {
    x25519.getSharedSecret(PROBE, pub);
  } catch {
    return fail("bad_key");
  }
  if (pk.at > now + LIMITS.messageMaxFutureMs) return fail("not_yet");
  if (!prekeyUsable(pk, now)) return fail("expired");
  return ok(pk);
}

// ---- sealing ----

/** The header of a notice: everything but `box` and `sig`, whatever fields it holds. */
function headerAad(notice: object): Uint8Array {
  const { box: _box, sig: _sig, token: _token, ...header } = notice as Record<string, unknown>;
  return sha256(canonBytes(header));
}

/** A one-time Ed25519 key for one GitHub notice; its public half goes in the token's audience. */
export function ciOneTimeKey(): { pub: string; sec: Uint8Array } {
  const sec = randomBytes(32);
  return { pub: b64u.encode(ed25519.getPublicKey(sec)), sec };
}

export type CiSealOptions = {
  /** The recipient: the code's mesh and device. */
  mesh: string;
  device: string;
  /** The recipient's prekey, verified with `verifyCiPrekey`. */
  prekey: Prekey;
  to: string;
  text: string;
  token: string;
  via: CiVia;
  /** GitHub only: the one-time key the token's audience names. */
  otk?: { pub: string; sec: Uint8Array };
  at: number;
  id?: string;
  /** Skips the credential check: offered only to a person at their own command line (SPEC section 6a). */
  allowSecrets?: boolean;
};

/**
 * Seals a notice to the recipient's prekey and, for GitHub, signs it with the one-time key.
 * Returns the request to send (`token` included for GitHub) and the notice the relay keeps.
 * Throws, before anything is sent, on text over 4 KiB or that looks like a credential, a token
 * over 8 KiB, a missing or unexpected one-time key, or a malformed input.
 */
export function sealCiNotice(o: CiSealOptions): { request: CiSendRequest; notice: CiNotice } {
  if (!fitsUtf8(o.text, LIMITS.ciTextBytes)) throw new RangeError(`sealCiNotice: text must be at most ${LIMITS.ciTextBytes} UTF-8 bytes`);
  const secrets = o.allowSecrets === true ? [] : findSecrets(o.text);
  if (secrets.length > 0) throw new TypeError(`sealCiNotice: text appears to contain a secret (${secrets.join(", ")})`);
  if ((o.via === "github") !== (o.otk !== undefined)) throw new TypeError("sealCiNotice: a github notice needs its one-time key, a gitlab one has none");
  const xkSec = randomBytes(32);
  const xk = b64u.encode(x25519.getPublicKey(xkSec));
  const header = {
    t: "ci.send" as const,
    mesh: o.mesh,
    id: o.id ?? ulid(o.at),
    device: o.device,
    to: o.to,
    at: o.at,
    via: o.via,
    ...(o.otk === undefined ? {} : { otk: o.otk.pub }),
    xk,
  };
  const plaintext = { v: 1 as const, kind: "ci" as const, id: header.id, device: o.device, to: o.to, at: o.at, text: o.text, token: o.token };
  const checked = safeParse(ciPlaintextSchema, plaintext);
  if (!checked.success) throw new TypeError(`sealCiNotice: ${checked.error.issues[0]!.path.join(".")}: ${checked.error.issues[0]!.message}`);
  const box = sealBox(xkSec, {
    mesh: o.mesh,
    sender: ciSenderId(xk),
    recipient: o.device,
    recipientBox: new Uint8Array(32),
    prekey: { id: o.prekey.id, pub: b64u.decode(o.prekey.pub) },
    aad: headerAad(header),
    plaintext: canonBytes(plaintext),
  }) as CiNotice["box"];
  const notice = o.otk === undefined ? { ...header, box } : signObject("ci", { ...header, box }, o.otk.sec);
  const request = o.via === "github" ? { ...notice, token: o.token } : notice;
  const parsed = safeParse(ciSendRequestSchema, request);
  if (!parsed.success) throw new TypeError(`sealCiNotice: ${parsed.error.issues[0]!.path.join(".")}: ${parsed.error.issues[0]!.message}`);
  return { request: parsed.data, notice: notice as CiNotice };
}

/** The notice a relay keeps from a `ci.send` request: the request without its token. */
export function ciNoticeOf(request: CiSendRequest): CiNotice {
  const { token: _token, ...notice } = request;
  return notice;
}

// ---- opening ----

/**
 * The checks of SPEC section 18 before decryption, for the receiving session: the notice parses,
 * and is for its mesh, device and session name. On success, the box to open with the device's
 * keyring: the sender id is computed from `xk`, never read from the frame.
 */
export function ciOpenRequest(raw: unknown, me: { mesh: string; device: string; name: string }): Result<{ notice: CiNotice; req: OpenRequest }> {
  const parsed = safeParse(ciNoticeSchema, raw);
  if (!parsed.success) return fail("malformed");
  const n = parsed.data;
  if (n.mesh !== me.mesh) return fail("wrong_mesh");
  if (n.device !== me.device || n.to !== me.name) return fail("not_addressed");
  const req = { mesh: n.mesh, sender: ciSenderId(n.xk), recipient: n.device, senderBox: b64u.decode(n.xk), box: n.box, aad: headerAad(n) };
  return ok({ notice: n, req });
}

/** The checks after decryption: a canonical plaintext that repeats the header. */
export function checkCiPlaintext(notice: CiNotice, opened: Opened): Result<CiPlaintext> {
  if (typeof opened === "string") return fail(opened);
  let text: string;
  try {
    text = fromUtf8(opened);
  } catch {
    return fail("plaintext_malformed");
  }
  const json = parseJson(text);
  const parsed = json.ok ? safeParse(ciPlaintextSchema, json.value) : undefined;
  if (parsed?.success !== true || !bytesEqual(canonBytes(parsed.data), opened)) return fail("plaintext_malformed");
  const p = parsed.data;
  if (p.id !== notice.id || p.device !== notice.device || p.to !== notice.to || p.at !== notice.at) return fail("header_mismatch");
  return ok(p);
}

// ---- tokens ----

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024;
const optStr = (v: unknown): v is string | undefined => v === undefined || str(v);

/** What a verified GitHub token says, for the rule and the frame. */
export type GithubClaims = BaseClaims & {
  via: "github";
  repository: string;
  repositoryId: string;
  ownerId: string;
  ref: string;
  workflowRef: string;
  event: string;
  sha: string;
  runId: string;
  environment?: string;
};

/** What a verified GitLab token says, for the rule and the frame. */
export type GitlabClaims = BaseClaims & {
  via: "gitlab";
  projectPath: string;
  projectId: string;
  namespaceId: string;
  /** The full ref: `ref_path`, or `refs/heads/` or `refs/tags/` plus `ref` by `ref_type`. */
  ref: string;
  refProtected: boolean;
  environment?: string;
  environmentProtected?: boolean;
  sha?: string;
  pipelineId?: string;
};

export type CiClaims = GithubClaims | GitlabClaims;

/** GitLab writes some flags as the strings `"true"` and `"false"`; a boolean is read too. */
function flag(v: unknown): boolean | undefined {
  return v === true || v === "true" ? true : v === false || v === "false" ? false : undefined;
}

/** The claims a rule and the frame use, each checked; `bad_claims` when any is missing or wrong. */
export function ciClaims(via: CiVia, payload: Record<string, unknown>, base: BaseClaims): Result<CiClaims> {
  const p = payload;
  if (via === "github") {
    const fields = [p["repository"], p["repository_id"], p["repository_owner_id"], p["ref"], p["workflow_ref"], p["event_name"], p["sha"], p["run_id"]];
    if (!fields.every(str) || !optStr(p["environment"])) return fail("bad_claims");
    const [repository, repositoryId, ownerId, ref, workflowRef, event, sha, runId] = fields as string[];
    return ok({
      ...base,
      via,
      repository: repository!,
      repositoryId: repositoryId!,
      ownerId: ownerId!,
      ref: ref!,
      workflowRef: workflowRef!,
      event: event!,
      sha: sha!,
      runId: runId!,
      ...(p["environment"] === undefined ? {} : { environment: p["environment"] as string }),
    });
  }
  const fields = [p["project_path"], p["project_id"], p["namespace_id"], p["ref"], p["ref_type"]];
  const refProtected = flag(p["ref_protected"]);
  const envProtected = flag(p["environment_protected"]);
  if (!fields.every(str) || refProtected === undefined || ![p["ref_path"], p["environment"], p["sha"], p["pipeline_id"]].every(optStr)) return fail("bad_claims");
  if (p["environment_protected"] !== undefined && envProtected === undefined) return fail("bad_claims");
  const [projectPath, projectId, namespaceId, ref, refType] = fields as string[];
  const prefix = refType === "branch" ? "refs/heads/" : refType === "tag" ? "refs/tags/" : undefined;
  if (prefix === undefined) return fail("bad_claims");
  const opt = (k: string, as: string) => (p[k] === undefined ? {} : { [as]: p[k] });
  return ok({
    ...base,
    via,
    projectPath: projectPath!,
    projectId: projectId!,
    namespaceId: namespaceId!,
    ref: (p["ref_path"] as string | undefined) ?? prefix + ref!,
    refProtected,
    ...opt("environment", "environment"),
    ...(envProtected === undefined ? {} : { environmentProtected: envProtected }),
    ...opt("sha", "sha"),
    ...opt("pipeline_id", "pipelineId"),
  } as GitlabClaims);
}

/** Looks up an issuer's key by `kid` (a `JwksCache`, or a fixture in tests). */
export type KeyLookup = (iss: string, kid: string) => Promise<Jwk | undefined>;

/**
 * Verifies a CI token for a notice (SPEC section 18): parse, issuer, signature against the
 * issuer's key from `keys`, the shared claims, the audience for the notice's `via`, and the
 * provider's claims. With `now` (the relay) it also checks the token's time by that clock with 5
 * minutes of skew; a client passes none (a queued notice may arrive after `exp`). Never throws.
 * Reasons: those of `parseJwt` and `baseClaims`, `unknown_key`, `weak_key`, `bad_signature`,
 * `wrong_audience`, `bad_otk_signature`, `token_expired`, `token_not_yet`, `bad_claims`.
 */
export async function verifyCiToken(token: string, notice: CiNotice, keys: KeyLookup, now?: number): Promise<Result<CiClaims>> {
  const jwt = parseJwt(token);
  if (!jwt.ok) return jwt;
  const iss = CI_ISSUERS[notice.via];
  const base = baseClaims(jwt.value.payload, iss);
  if (!base.ok) return base;
  const expected = notice.via === "github" ? githubAudience(notice.mesh, notice.device, notice.otk!) : gitlabAudience(notice.mesh, notice.device);
  if (base.value.aud !== expected) return fail("wrong_audience");
  if (notice.via === "github" && !verifyObject("ci", notice as { sig: string }, b64u.decode(notice.otk!))) return fail("bad_otk_signature");
  if (now !== undefined) {
    if (base.value.exp * 1000 + LIMITS.ciSkewMs < now) return fail("token_expired");
    if ((base.value.nbf ?? base.value.iat) * 1000 - LIMITS.ciSkewMs > now) return fail("token_not_yet");
  }
  const key = await keys(iss, jwt.value.kid);
  if (key === undefined) return fail("unknown_key");
  const signed = await verifyJwtSignature(jwt.value, key);
  if (!signed.ok) return signed;
  return ciClaims(notice.via, jwt.value.payload, base.value);
}

/**
 * The time checks a receiving client makes (SPEC section 18, step 5): `at` within the freshness
 * window of `now`, and within the token's own window give or take 5 minutes. Never compares `exp`
 * with `now`. Reasons: `too_old`, `too_new`, `outside_token_window`.
 */
export function checkCiTimes(at: number, claims: BaseClaims, now: number): Result {
  const fresh = checkFreshness(at, now);
  if (!fresh.ok) return fresh;
  const from = (claims.nbf ?? claims.iat) * 1000 - LIMITS.ciTokenWindowSkewMs;
  const until = claims.exp * 1000 + LIMITS.ciTokenWindowSkewMs;
  return at >= from && at <= until ? ok(true) : fail("outside_token_window");
}

/** Until when a receiver keeps a notice's id and token id: the later of the two retentions. */
export function ciDedupeExpiry(at: number, exp: number): number {
  return Math.max(at + LIMITS.dedupeRetentionMs, exp * 1000 + LIMITS.ciJtiRetentionMs);
}

/**
 * The sender's check before it transmits anything (SPEC section 18): the token's `aud` is one
 * string, starts with `wimci1.`, and equals `expected`. Never throws. Reasons: `malformed`,
 * `aud_array`, `not_wim_audience`, `wrong_audience`.
 */
export function checkSendAudience(payload: Record<string, unknown>, expected: string): Result {
  const aud = payload["aud"];
  if (Array.isArray(aud)) return fail("aud_array");
  if (typeof aud !== "string" || !aud.startsWith("wimci1.")) return fail("not_wim_audience");
  return aud === expected ? ok(true) : fail("wrong_audience");
}

/** A relay's view of a verified GitHub notice: only what it keeps or uses. */
export type GithubSeen = { tags: string[]; key: string; jti: string; exp: number };

/**
 * What the relay keeps of a verified GitHub token: the candidate tags it compares (the exact one
 * and every prefix pattern of the ref), the counting key, and the `jti` hash.
 */
export function githubSeen(claims: GithubClaims, mesh: string, device: string): GithubSeen {
  return {
    tags: ciCandidateTags({ mesh, device, iss: claims.iss, repo: claims.repository, ref: claims.ref }),
    key: githubCountingKey(claims.iss, claims.ownerId, claims.repositoryId),
    jti: b64u.encode(sha256(utf8(`${claims.iss} ${claims.jti}`))),
    exp: claims.exp * 1000,
  };
}

/** Within `ciSkewMs` of the relay's clock: the relay's check on a request's `at`. */
export function ciAtFresh(at: number, now: number): boolean {
  return Math.abs(at - now) <= LIMITS.ciSkewMs;
}
