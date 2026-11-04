// Receiving a CI notice (SPEC section 18): the checks a receiving client makes itself, never
// taking the relay's word for anything, and the token keys it fetches from each provider's fixed
// JWKS URL and keeps on disk for at most 24 hours.

import {
  b64u,
  checkCiPlaintext,
  checkCiTimes,
  ciOpenRequest,
  fail,
  JwksCache,
  LIMITS,
  ok,
  sha256,
  utf8,
  verifyCiToken,
  type CiClaims,
  type CiLabel,
  type CiNotice,
  type CiPlaintext,
  type JwksFetch,
  type Jwk,
  type Opened,
  type OpenRequest,
  type Result,
} from "@worldinmotion/protocol";
import { z } from "zod";
import { readJson, writeJson, type FsEnv } from "./fsx.ts";
import { matchRule, type CiPins, type CiRule, type GithubRule } from "./cirules.ts";

/** Fetches a provider's JWKS: no redirects, 5 seconds at most. Only ever given a fixed URL (`JWKS_URLS`). */
export const fetchJwks: JwksFetch = (url) => fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });

type JwksFile = { v: 1; keys: Record<string, { text: string; at: number }> };
const heldSchema = z.strictObject({ text: z.string(), at: z.number().int().nonnegative() });

/**
 * The providers' token keys for this device: fetched by the client itself, kept 24 hours, and
 * written to `ci-jwks.json` so the next process starts with them. Damage to the file only costs
 * a fetch.
 */
export class CiKeys {
  private readonly cache: JwksCache;
  private readonly path: string;
  private readonly env: FsEnv;
  private seeded: Promise<void> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private readonly saved: Record<string, { text: string; at: number }> = {};
  /**
   * Whether the last JWKS fetch failed for the network's or the provider's reasons (no answer, or
   * not 200): a key not found then is not a verdict on the token, and the notice is tried again.
   */
  unreachable = false;

  constructor(o: { path: string; env: FsEnv; fetch: JwksFetch; now: () => number }) {
    this.path = o.path;
    this.env = o.env;
    this.cache = new JwksCache({
      fetch: async (url) => {
        try {
          const res = await o.fetch(url);
          this.unreachable = res.status !== 200;
          return res;
        } catch (error) {
          this.unreachable = true;
          throw error;
        }
      },
      now: o.now,
      ttlMs: LIMITS.jwksClientTtlMs,
      onFetched: (iss, text, at) => {
        this.saved[iss] = { text, at };
        const file: JwksFile = { v: 1, keys: { ...this.saved } };
        this.writing = this.writing.then(() => writeJson(this.path, file, this.env)).catch(() => undefined);
      },
    });
  }

  /** Waits for the last write of fetched keys (tests, and a clean stop). */
  flushed(): Promise<void> {
    return this.writing;
  }

  private seed(): Promise<void> {
    this.seeded ??= readJson(this.path)
      .catch(() => undefined)
      .then((raw) => {
        const file = raw as Partial<JwksFile> | undefined;
        const keys = file?.v === 1 && typeof file.keys === "object" && file.keys !== null ? file.keys : {};
        for (const [iss, raw] of Object.entries(keys)) {
          const held = heldSchema.safeParse(raw);
          if (!held.success) continue;
          this.saved[iss] = held.data;
          this.cache.seed(iss, held.data.text, held.data.at);
        }
      });
    return this.seeded;
  }

  /** The key `kid` of issuer `iss`, or undefined. */
  readonly lookup = async (iss: string, kid: string): Promise<Jwk | undefined> => {
    await this.seed();
    return this.cache.key(iss, kid);
  };
}

/**
 * A notice whose token names a key this device could not fetch because the provider did not
 * answer: the machine's fault, not the notice's (`EAGAIN`), so it is not acknowledged and the
 * relay delivers it again once the connection is retried.
 */
export class KeysUnreachable extends Error {
  readonly code = "EAGAIN";
  constructor() {
    super("a CI provider's keys could not be fetched; the notice is tried again later");
  }
}

/** What a notice that passed every check gives the session. */
export type CheckedNotice = {
  notice: CiNotice;
  plaintext: CiPlaintext;
  claims: CiClaims;
  rule: CiRule;
  /** Set when the rule has no ids yet: the person's approval pins these. */
  pins?: CiPins;
};

export type CiCheckDeps = {
  me: { mesh: string; device: string; name: string };
  open: (req: OpenRequest) => Promise<Opened>;
  keys: (iss: string, kid: string) => Promise<Jwk | undefined>;
  rules: readonly CiRule[];
  now: number;
};

/**
 * The receiving checks of SPEC section 18, steps 1 to 6, in order: the frame and its address, the
 * box (sender id from `xk`, never the frame) and plaintext, the token against keys this client
 * fetched (audience and, for GitHub, the one-time key's signature), the times, and the person's
 * rules. Single use (step 7) is the session's, against its durable store. Never throws for a bad
 * notice; rejects only when the keyring cannot answer, so the frame is delivered again.
 */
export async function checkCiNotice(raw: unknown, d: CiCheckDeps): Promise<Result<CheckedNotice>> {
  const addressed = ciOpenRequest(raw, d.me);
  if (!addressed.ok) return addressed;
  const { notice, req } = addressed.value;
  const plaintext = checkCiPlaintext(notice, await d.open(req));
  if (!plaintext.ok) return plaintext;
  const claims = await verifyCiToken(plaintext.value.token, notice, d.keys);
  if (!claims.ok) return claims;
  const times = checkCiTimes(notice.at, claims.value, d.now);
  if (!times.ok) return times;
  const match = matchRule(d.rules, claims.value);
  if (match === undefined) return fail("no_rule");
  return ok({ notice, plaintext: plaintext.value, claims: claims.value, rule: match.rule, ...(match.pinned ? {} : { pins: match.ids }) });
}

/** The key under which a token's `jti` is kept, device-wide: a hash, as the relay keeps it. */
export function jtiKey(c: CiClaims): string {
  return `ci-jti-${b64u.encode(sha256(utf8(`${c.iss} ${c.jti}`)))}`;
}

/** Where a notice comes from, for the frame and history: the token's claims, never the relay's words. */
export function ciLabel(c: CiClaims, rule: CiRule): CiLabel {
  const env = c.environment === undefined ? {} : { environment: c.environment };
  if (c.via === "github") {
    // The rule matched `workflow_ref` exactly (so it is a GitHub rule), and its file is the workflow that ran.
    return { via: "github", repo: c.repository, ref: c.ref, workflow: (rule as GithubRule).workflow, sha: c.sha, event: c.event, run: c.runId, ...env };
  }
  return { via: "gitlab", repo: c.projectPath, ref: c.ref, ...(c.sha === undefined ? {} : { sha: c.sha }), ...(c.pipelineId === undefined ? {} : { run: c.pipelineId }), ...env };
}

/** The sender a CI notice shows as (held lists, history, notices): provider and repository. */
export function ciFrom(label: CiLabel): string {
  return `ci:${label.via}:${label.repo.slice(0, 200)}`;
}

/** The loop breaker's bucket for a repository: its ids, so a rename keeps its count. */
export function ciBucket(c: CiClaims): string {
  return c.via === "github" ? `github:${c.ownerId}/${c.repositoryId}` : `gitlab:${c.namespaceId}/${c.projectId}`;
}

/** The CI breaker's limits (SECURITY-MODEL section 7.3): per repository, and for all CI together. */
export const CI_BREAKER = { perPeerPerHour: 60, totalPerHour: 240, pingPong: false, pingPongExchanges: 0 } as const;

/** The notices a CI pause raises: for the person, and once for the session. */
export function ciPauseNotices(from: string, reason: "peer" | "total"): { person: string; agent: string } {
  const why = reason === "peer" ? `${CI_BREAKER.perPeerPerHour} CI notices from it in an hour` : `${CI_BREAKER.totalPerHour} CI notices from all repositories in an hour`;
  return {
    person: `worldinmotion paused CI notices from ${from} (${why}); they are held: wim held list`,
    agent:
      `this device's loop breaker paused CI notices from ${from} (${why}): they are held from now on, not delivered to you, until the hour rolls over. ` +
      "Only the person can release one: `wim held approve <id>` in a terminal they opened themselves.",
  };
}

/** A short form of a notice id for log lines, safe whatever the relay sent. */
export function noticeId(raw: unknown): string {
  const id = (raw as { id?: unknown } | null)?.id;
  return typeof id === "string" && /^[0-9A-Z]{26}$/.test(id) ? id : "(no id)";
}
