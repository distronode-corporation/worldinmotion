// The receiving client's CI helpers (SPEC section 18): the providers' keys it fetches itself and
// keeps on disk, and how a notice is labelled, counted and logged.

import { b64u, GITHUB_ISSUER, GITLAB_ISSUER, JWKS_URLS, ulid, type CiNotice, type GithubClaims, type GitlabClaims } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderForAgent } from "../src/history.ts";
import { CiKeys, CiParked, ciBucket, ciLabel, ciPauseNotices, fetchJwks, jtiKey, noticeId } from "../src/cireceive.ts";
import { issuer } from "./ci-fixture.ts";
import { fsOps } from "../src/fsx.ts";
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
    let fetches = 0;
    const fetcher = async () => (fetches++, { status: 200, text: async () => gh.jwks });
    const now = () => 5;
    const cases = [
      "{",
      '{"v":2,"keys":{}}',
      '{"v":1,"keys":null}',
      `{"v":1,"keys":{"${GITLAB_ISSUER}":{"text":1,"at":1},"${GITHUB_ISSUER}":null}}`,
      `{"v":1,"keys":{"${GITHUB_ISSUER}":{"text":"x","at":"y"}}}`,
      // Real keys dated after now: never trusted, or they would never go stale.
      JSON.stringify({ v: 1, keys: { [GITHUB_ISSUER]: { text: gh.jwks, at: 6 } } }),
    ];
    for (const [i, text] of cases.entries()) {
      // Each case its own file, and each write of fetched keys awaited: a write still in flight
      // from one case would otherwise replace the next case's damaged file before it is read.
      const path = join(dir, `ci-jwks-${i}.json`);
      await fs.writeFile(path, text);
      const keys = new CiKeys({ path, env: FS, fetch: fetcher, now });
      expect(await keys.lookup(GITHUB_ISSUER, "k2")).toMatchObject({ kid: "k2" });
      await keys.flushed();
      expect(fetches).toBe(i + 1);
    }
    // A directory where the file should be: the write fails quietly and the key is still served.
    const blocked = join(dir, "blocked");
    await fs.mkdir(join(blocked, "ci-jwks.json"), { recursive: true });
    const keys = new CiKeys({ path: join(blocked, "ci-jwks.json"), env: FS, fetch: fetcher, now });
    expect(await keys.lookup(GITHUB_ISSUER, "k2")).toMatchObject({ kid: "k2" });
    await keys.flushed();
  });

  it("knows per issuer whether its keys were out of reach, and treats an unknown key as junk while fresh keys are held", async () => {
    const gh = await issuer("k3");
    const dir = await scratch("cikeys");
    let t = 1_000_000;
    let answer: "down" | 503 | 200 = "down";
    const fetcher = async () => {
      if (answer === "down") throw new Error("offline");
      return { status: answer, text: async () => gh.jwks };
    };
    const keys = new CiKeys({ path: join(dir, "ci-jwks.json"), env: FS, fetch: fetcher, now: () => t });
    expect(await keys.lookup(GITLAB_ISSUER, "x")).toBeUndefined();
    // GitLab's fetch failed; GitHub's was never tried, so it is not out of reach.
    expect([keys.unreachable(GITLAB_ISSUER), keys.unreachable(GITHUB_ISSUER)]).toEqual([true, false]);
    answer = 503;
    expect(await keys.lookup(GITHUB_ISSUER, "k3")).toBeUndefined();
    expect(keys.unreachable(GITHUB_ISSUER)).toBe(true);
    // A minute on, both answer: GitHub's keys are held fresh, GitLab's still fail.
    t += 61_000;
    answer = 200;
    expect(await keys.lookup(GITHUB_ISSUER, "k3")).toMatchObject({ kid: "k3" });
    expect(keys.unreachable(GITHUB_ISSUER)).toBe(false);
    // Then GitHub goes down. An unknown kid with fresh keys in hand is junk, not a retry...
    t += 61_000;
    answer = "down";
    expect(await keys.lookup(GITHUB_ISSUER, "junk")).toBeUndefined();
    expect(keys.unreachable(GITHUB_ISSUER)).toBe(false);
    // ...until the held copy is a day old.
    t += 24 * 3_600_000;
    expect(await keys.lookup(GITHUB_ISSUER, "junk")).toBeUndefined();
    expect(keys.unreachable(GITHUB_ISSUER)).toBe(true);
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
    expect(ciPauseNotices("ci:gitlab:g/a", "total", "01ARZ3NDEKTSV4RRFFQ69G5FAV").person).toContain("240 CI notices from all repositories in an hour");
    expect(ciPauseNotices("ci:gitlab:g/a", "peer", "01ARZ3NDEKTSV4RRFFQ69G5FAV").agent).toContain("`wim held approve 01ARZ3NDEKTSV4RRFFQ69G5FAV` in a terminal they opened themselves");
    expect(noticeId({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(noticeId({ id: "x\n" })).toBe("(no id)");
    expect(noticeId(null)).toBe("(no id)");
  });
});

describe("CiParked", () => {
  const key = b64u.encode(new Uint8Array(32));
  const id22 = b64u.encode(new Uint8Array(16));
  const notice = (): CiNotice => ({ t: "ci.send", mesh: id22, id: ulid(), device: id22, to: "agent", at: 1, via: "gitlab", xk: key, box: { s: 2, p: id22, e: key, c: "c".repeat(22) } });

  it("runs changes one at a time, so a park during a retry is never written over, and a failed change stops none after it", async () => {
    const parked = new CiParked(join(await scratch("ciparked"), "ci-parked.json"), FS);
    const [a, b] = [notice(), notice()];
    await Promise.all([parked.update((n) => [...n, a]), parked.update((n) => [...n, b])]);
    expect((await parked.list()).map((n) => n.id)).toEqual([a.id, b.id]);
    await expect(
      parked.update(() => {
        throw new Error("no change");
      }),
    ).rejects.toThrow("no change");
    await parked.update((n) => n.slice(1));
    expect((await parked.list()).map((n) => n.id)).toEqual([b.id]);
  });

  it("reads a missing or damaged file as none, and never writes over a file it could not read", async () => {
    const path = join(await scratch("ciparked"), "ci-parked.json");
    const parked = new CiParked(path, FS);
    expect(await parked.list()).toEqual([]);
    await fs.writeFile(path, "{");
    expect(await parked.list()).toEqual([]);
    await fs.writeFile(path, '{"v":1,"v":1,"notices":[]}');
    expect(await parked.list()).toEqual([]);
    const [a, b] = [notice(), notice()];
    await parked.update(() => [a]);
    // A read that fails (here EIO, once) rejects the update, and the parked notice stays.
    const realReadFile = fsOps.readFile;
    fsOps.readFile = async () => {
      fsOps.readFile = realReadFile;
      throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
    };
    try {
      await expect(parked.update((n) => [...n, b])).rejects.toThrow("EIO");
    } finally {
      fsOps.readFile = realReadFile;
    }
    expect((await parked.list()).map((n) => n.id)).toEqual([a.id]);
    await parked.update((n) => [...n, b]);
    expect((await parked.list()).map((n) => n.id)).toEqual([a.id, b.id]);
  });
});
