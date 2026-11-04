// The receiving client's CI helpers (SPEC section 18): the providers' keys it fetches itself and
// keeps on disk, and how a notice is labelled, counted and logged.

import { GITHUB_ISSUER, GITLAB_ISSUER, JWKS_URLS, type GithubClaims, type GitlabClaims } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderForAgent } from "../src/history.ts";
import { CiKeys, ciBucket, ciLabel, ciPauseNotices, fetchJwks, jtiKey, noticeId } from "../src/cireceive.ts";
import { issuer } from "./ci-fixture.ts";
import { FS, scratch } from "./helpers.ts";

describe("CiKeys", () => {
  it("fetches an issuer's keys once, keeps them on disk, and a new process starts from that copy", async () => {
    const gh = await issuer("k1");
    const dir = await scratch("cikeys");
    const path = join(dir, "ci-jwks.json");
    const fetched: string[] = [];
    const fetcher = async (url: string) => (fetched.push(url), { status: 200, text: async () => gh.jwks });
    const now = () => 1_000_000;
    const keys = new CiKeys({ path, env: FS, fetch: fetcher, now });
    expect(await keys.lookup(GITHUB_ISSUER, "k1")).toMatchObject({ kid: "k1" });
    expect(await keys.lookup(GITHUB_ISSUER, "k1")).toMatchObject({ kid: "k1" });
    await keys.flushed();
    expect(fetched).toEqual([JWKS_URLS[GITHUB_ISSUER]]);
    const again = new CiKeys({ path, env: FS, fetch: fetcher, now });
    expect(await again.lookup(GITHUB_ISSUER, "k1")).toMatchObject({ kid: "k1" });
    expect(fetched).toHaveLength(1);
  });

  it("only costs a fetch when the file is damaged, foreign or unwritable", async () => {
    const gh = await issuer("k2");
    const dir = await scratch("cikeys");
    const fetcher = async () => ({ status: 200, text: async () => gh.jwks });
    const now = () => 5;
    for (const text of ["{", '{"v":2,"keys":{}}', '{"v":1,"keys":null}', `{"v":1,"keys":{"${GITLAB_ISSUER}":{"text":1,"at":1},"${GITHUB_ISSUER}":null}}`, `{"v":1,"keys":{"${GITHUB_ISSUER}":{"text":"x","at":"y"}}}`]) {
      const path = join(dir, "ci-jwks.json");
      await fs.writeFile(path, text);
      expect(await new CiKeys({ path, env: FS, fetch: fetcher, now }).lookup(GITHUB_ISSUER, "k2")).toMatchObject({ kid: "k2" });
    }
    // A directory where the file should be: the write fails quietly and the key is still served.
    const blocked = join(dir, "blocked");
    await fs.mkdir(join(blocked, "ci-jwks.json"), { recursive: true });
    const keys = new CiKeys({ path: join(blocked, "ci-jwks.json"), env: FS, fetch: fetcher, now });
    expect(await keys.lookup(GITHUB_ISSUER, "k2")).toMatchObject({ kid: "k2" });
    await keys.flushed();
  });

  it("fetches with no redirects and a time limit (refused here: nothing listens)", async () => {
    await expect(fetchJwks("http://127.0.0.1:9/jwks")).rejects.toThrow();
  });
});

const base = { aud: "a", jti: "j1", iat: 1, exp: 2 };
const gh: GithubClaims = { ...base, iss: GITHUB_ISSUER, via: "github", repository: "o/r", repositoryId: "74", ownerId: "65", ref: "refs/heads/main", workflowRef: "o/r/.github/workflows/d.yml@refs/heads/main", event: "push", sha: "abc", runId: "9", environment: "prod" };
const gl: GitlabClaims = { ...base, iss: GITLAB_ISSUER, via: "gitlab", projectPath: "g/a", projectId: "20", namespaceId: "11", ref: "refs/heads/main", refProtected: true };

describe("labels, buckets and log lines", () => {
  it("labels a notice from its claims", () => {
    expect(ciLabel(gh, { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", via: "github", repo: "o/r", ref: "refs/heads/main", workflow: "d.yml" })).toEqual({
      via: "github",
      repo: "o/r",
      ref: "refs/heads/main",
      workflow: "d.yml",
      sha: "abc",
      event: "push",
      run: "9",
      environment: "prod",
    });
    expect(ciLabel(gl, { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", via: "gitlab", repo: "g/a", ref: "refs/heads/main" })).toEqual({ via: "gitlab", repo: "g/a", ref: "refs/heads/main" });
  });

  it("renders a CI notice from history in its own frame", () => {
    const out = renderForAgent({ dir: "in", peer: "ci:gitlab:g/a", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", kind: "msg", at: 1, text: "built", relayed: true, ci: { via: "gitlab", repo: "g/a", ref: "refs/heads/main" } });
    expect(out).toContain("(history: received earlier, not a new message)");
    expect(out).toContain("relayed CI text from a GitLab CI/CD job of repository g/a");
  });

  it("counts by ids, keeps token ids by hash, and says why CI is paused", () => {
    expect(ciBucket(gh)).toBe("github:65/74");
    expect(ciBucket(gl)).toBe("gitlab:11/20");
    expect(jtiKey(gh)).toMatch(/^ci-jti-[A-Za-z0-9_-]{43}$/);
    expect(jtiKey(gh)).not.toBe(jtiKey(gl));
    expect(ciPauseNotices("ci:gitlab:g/a", "total").person).toContain("240 CI notices from all repositories in an hour");
    expect(noticeId({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(noticeId({ id: "x\n" })).toBe("(no id)");
    expect(noticeId(null)).toBe("(no id)");
  });
});
