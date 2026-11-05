// Receiving a CI notice (SPEC section 18): the checks a receiving client makes itself, never
// taking the relay's word for anything, and the token keys it fetches from each provider's fixed
// JWKS URL and keeps on disk for at most 24 hours.

import {
  b64u,
  checkCiPlaintext,
  checkCiTimes,
  ciNoticeSchema,
  ciOpenRequest,
  fail,
  JwksCache,
  JWKS_URLS,
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
  private readonly now: () => number;
  /**
   * The issuers whose last JWKS fetch failed for the network's or the provider's reasons (no
   * answer, or not 200). Kept per issuer: one provider's outage says nothing about the other's.
   */
  private readonly down = new Set<string>();

  constructor(o: { path: string; env: FsEnv; fetch: JwksFetch; now: () => number }) {
    this.path = o.path;
    this.env = o.env;
    this.now = o.now;
    this.cache = new JwksCache({
      fetch: async (url) => {
        // Only ever called with one of the fixed JWKS URLs.
        const iss = Object.keys(JWKS_URLS).find((k) => JWKS_URLS[k] === url)!;
        try {
          const res = await o.fetch(url);
          if (res.status === 200) this.down.delete(iss);
          else this.down.add(iss);
          return res;
        } catch (error) {
          this.down.add(iss);
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

  /**
   * Whether a key of `iss` not found is no verdict on the token: the last fetch got no answer and
   * no fresh copy of the issuer's keys is held. With fresh keys in hand an unknown `kid` is far
   * more likely junk than a rotation, so it is a drop, not a retry.
   */
  unreachable(iss: string): boolean {
    const held = this.saved[iss];
    return this.down.has(iss) && (held === undefined || this.now() - held.at >= LIMITS.jwksClientTtlMs);
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
          // A copy dated in the future would never go stale: anything that can write the file
          // could plant keys that are trusted for ever.
          if (!held.success || held.data.at > this.now()) continue;
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

/** At most this many notices wait for their provider's keys in one session (`ci-parked.json`). */
export const CI_PARKED_MAX = 20;

const parkedSchema = z.strictObject({ v: z.literal(1), notices: z.array(ciNoticeSchema).max(CI_PARKED_MAX) });

/**
 * `ci-parked.json`: the notices a session acknowledged while their provider's keys could not be
 * fetched, kept to be checked again (SPEC section 18). A CI notice never holds the ack stream, so
 * it never keeps a real peer's messages queued at the relay. A damaged file holds none.
 */
export class CiParked {
  private readonly path: string;
  private readonly env: FsEnv;
  /** The last change, so changes run one at a time (a park during a retry is never written over). */
  private changing: Promise<unknown> = Promise.resolve();

  constructor(path: string, env: FsEnv) {
    this.path = path;
    this.env = env;
  }

  async list(): Promise<CiNotice[]> {
    const parsed = parkedSchema.safeParse(await readJson(this.path).catch(() => undefined));
    return parsed.success ? parsed.data.notices : [];
  }

  /** Reads, changes and writes the list, after every change asked for before it. */
  update(change: (notices: CiNotice[]) => CiNotice[]): Promise<void> {
    const run = this.changing.then(async () => writeJson(this.path, { v: 1, notices: change(await this.list()) }, this.env));
    this.changing = Promise.allSettled([run]);
    return run;
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
    person: `worldinmotion paused CI notices from ${from} (${why}); the one that tripped it is held (wim held list), later ones are dropped until the hour rolls over`,
    agent:
      `this device's loop breaker paused CI notices from ${from} (${why}): later ones are dropped, not delivered to you, until the hour rolls over. ` +
      "Only the person can release the one that is held: `wim held approve <id>` in a terminal they opened themselves.",
  };
}

/** A short form of a notice id for log lines, safe whatever the relay sent. */
export function noticeId(raw: unknown): string {
  const id = (raw as { id?: unknown } | null)?.id;
  return typeof id === "string" && /^[0-9A-Z]{26}$/.test(id) ? id : "(no id)";
}
