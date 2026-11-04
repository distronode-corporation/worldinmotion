// The person's CI rules (SPEC section 18): the file, exact matching (fork and privileged events
// included), id pins, and what the relay is told.

import { ciRuleTag, GITHUB_ISSUER, GITLAB_ISSUER, ulid, type GithubClaims, type GitlabClaims } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkRule,
  claimIds,
  fullRef,
  isPinned,
  loadCiRules,
  matchesByName,
  matchRule,
  pinRule,
  readCiRules,
  ruleLine,
  rulesFrame,
  saveCiRules,
  type CiRule,
  type GithubRule,
  type GitlabRule,
} from "../src/cirules.ts";
import { FS, POSIX, scratch } from "./helpers.ts";

const base = { iss: "", aud: "", jti: "j", iat: 1, exp: 2 };
const gh = (over: Partial<GithubClaims> = {}): GithubClaims => ({
  ...base,
  iss: GITHUB_ISSUER,
  via: "github",
  repository: "Octo-Org/Deploys",
  repositoryId: "74",
  ownerId: "65",
  ref: "refs/heads/main",
  workflowRef: "Octo-Org/Deploys/.github/workflows/deploy.yml@refs/heads/main",
  event: "push",
  sha: "abc",
  runId: "1",
  ...over,
});
const gl = (over: Partial<GitlabClaims> = {}): GitlabClaims => ({
  ...base,
  iss: GITLAB_ISSUER,
  via: "gitlab",
  projectPath: "Group/App",
  projectId: "20",
  namespaceId: "11",
  ref: "refs/heads/main",
  refProtected: true,
  ...over,
});
const ghRule = (over: Partial<GithubRule> = {}): GithubRule => ({ id: ulid(), via: "github", repo: "octo-org/deploys", ref: "refs/heads/main", workflow: "deploy.yml", ...over });
const glRule = (over: Partial<GitlabRule> = {}): GitlabRule => ({ id: ulid(), via: "gitlab", repo: "group/app", ref: "refs/heads/main", ...over });

describe("matching a GitHub rule", () => {
  it("matches the repository without case, the ref and the workflow file exactly", () => {
    expect(matchesByName(ghRule(), gh())).toBe(true);
    expect(matchesByName(ghRule(), gh({ repository: "octo-org/other" }))).toBe(false);
    expect(matchesByName(ghRule(), gh({ ref: "refs/heads/dev", workflowRef: "Octo-Org/Deploys/.github/workflows/deploy.yml@refs/heads/dev" }))).toBe(false);
    // Another workflow file on the same ref, and a workflow_ref naming another repository.
    expect(matchesByName(ghRule(), gh({ workflowRef: "Octo-Org/Deploys/.github/workflows/other.yml@refs/heads/main" }))).toBe(false);
    expect(matchesByName(ghRule(), gh({ workflowRef: "evil-org/Deploys/.github/workflows/deploy.yml@refs/heads/main" }))).toBe(false);
    expect(matchesByName(ghRule(), gh({ workflowRef: "Octo-Org/Deploys/.github/workflows/deploy.yml@refs/heads/dev" }))).toBe(false);
  });

  it("refuses a fork's pull request ref and a fork's own repository", () => {
    expect(matchesByName(ghRule(), gh({ event: "pull_request", ref: "refs/pull/7/merge", workflowRef: "Octo-Org/Deploys/.github/workflows/deploy.yml@refs/pull/7/merge" }))).toBe(false);
    expect(matchesByName(ghRule(), gh({ repository: "forker/deploys", workflowRef: "forker/deploys/.github/workflows/deploy.yml@refs/heads/main" }))).toBe(false);
  });

  it("refuses pull_request_target and workflow_run unless the rule names them; a rule naming events takes only those", () => {
    expect(matchesByName(ghRule(), gh({ event: "pull_request_target" }))).toBe(false);
    expect(matchesByName(ghRule(), gh({ event: "workflow_run" }))).toBe(false);
    expect(matchesByName(ghRule(), gh({ event: "workflow_dispatch" }))).toBe(true);
    expect(matchesByName(ghRule({ events: ["pull_request_target"] }), gh({ event: "pull_request_target" }))).toBe(true);
    expect(matchesByName(ghRule({ events: ["workflow_run"] }), gh({ event: "workflow_run" }))).toBe(true);
    expect(matchesByName(ghRule({ events: ["workflow_run"] }), gh({ event: "push" }))).toBe(false);
  });

  it("matches the environment when the rule names one", () => {
    expect(matchesByName(ghRule({ environment: "prod" }), gh({ environment: "prod" }))).toBe(true);
    expect(matchesByName(ghRule({ environment: "prod" }), gh())).toBe(false);
    expect(matchesByName(ghRule(), gh({ environment: "anything" }))).toBe(true);
  });

  it("never matches the other provider", () => {
    expect(matchesByName(ghRule(), gl())).toBe(false);
    expect(matchesByName(glRule(), gh())).toBe(false);
  });
});

describe("matching a GitLab rule", () => {
  it("matches the project without case and the full ref; a tag named like the branch does not", () => {
    expect(matchesByName(glRule(), gl())).toBe(true);
    expect(matchesByName(glRule(), gl({ ref: "refs/tags/main" }))).toBe(false);
    expect(matchesByName(glRule(), gl({ projectPath: "group/other" }))).toBe(false);
  });

  it("takes only protected refs unless the rule allows unprotected ones", () => {
    expect(matchesByName(glRule(), gl({ refProtected: false }))).toBe(false);
    expect(matchesByName(glRule({ unprotected: true }), gl({ refProtected: false }))).toBe(true);
  });

  it("matches an environment only when it is protected", () => {
    expect(matchesByName(glRule({ environment: "prod" }), gl({ environment: "prod", environmentProtected: true }))).toBe(true);
    expect(matchesByName(glRule({ environment: "prod" }), gl({ environment: "prod", environmentProtected: false }))).toBe(false);
    expect(matchesByName(glRule({ environment: "prod" }), gl({ environment: "staging", environmentProtected: true }))).toBe(false);
  });
});

describe("pins", () => {
  it("prefers a rule pinned to the token's ids; else holds under an unpinned one; a rule pinned to other ids never matches", () => {
    const pinned = ghRule({ pins: { repositoryId: "74", ownerId: "65" } });
    const other = ghRule({ pins: { repositoryId: "99", ownerId: "65" } });
    const open = ghRule();
    expect(matchRule([other, open, pinned], gh())).toEqual({ rule: pinned, pinned: true });
    expect(matchRule([other, open], gh())).toEqual({ rule: open, pinned: false, ids: { repositoryId: "74", ownerId: "65" } });
    expect(matchRule([other], gh())).toBeUndefined();
    expect(matchRule([glRule()], gl())).toEqual({ rule: expect.anything(), pinned: false, ids: { projectId: "20", namespaceId: "11" } });
    expect(claimIds(gl())).toEqual({ projectId: "20", namespaceId: "11" });
  });

  it("pins once; refuses other ids, and a removed rule", () => {
    const open = ghRule();
    const ids = { repositoryId: "74", ownerId: "65" };
    const rules = pinRule([open, glRule()], open.id, ids);
    expect(rules[0]).toEqual({ ...open, pins: ids });
    expect(isPinned(rules, open.id, ids)).toBe(true);
    expect(isPinned(rules, open.id, { ...ids, ownerId: "1" })).toBe(false);
    expect(isPinned(rules, rules[1]!.id, ids)).toBe(false);
    expect(isPinned(rules, ulid(), ids)).toBe(false);
    expect(pinRule(rules, open.id, ids)).toEqual(rules);
    expect(() => pinRule(rules, open.id, { repositoryId: "75", ownerId: "65" })).toThrow(/already pinned to other ids/);
    expect(() => pinRule(rules, ulid(), ids)).toThrow(/was removed/);
  });
});

describe("the rules file", () => {
  it("round-trips, is absent as undefined, and refuses anything that is not exactly a rules file", async () => {
    const dir = await scratch("cirules");
    const path = join(dir, "ci-rules.json");
    expect(await readCiRules(path)).toBeUndefined();
    expect(await loadCiRules(path)).toEqual([]);
    const rules: CiRule[] = [ghRule({ events: ["push"], environment: "prod", hold: true }), glRule({ unprotected: true, pins: { projectId: "20", namespaceId: "11" } })];
    await saveCiRules(path, rules, FS);
    expect(await loadCiRules(path)).toEqual(rules);
    if (POSIX) expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    for (const bad of ["{", '{"v":1,"rules":[],"x":1}', `{"v":1,"rules":[${JSON.stringify({ ...ghRule(), repo: "Upper/Case" })}]}`]) {
      await fs.writeFile(path, bad);
      await expect(readCiRules(path)).rejects.toThrow(/not a valid CI rules file/);
    }
  });

  it("checks a rule before it is written", () => {
    expect(() => checkRule({ ...ghRule(), workflow: "../x.yml" })).toThrow(/invalid CI rule: workflow/);
    expect(() => checkRule({ ...glRule(), ref: "main" })).toThrow(/invalid CI rule: ref/);
  });

  it("reads --ref as a branch, a tag with --tag, and keeps a full ref", () => {
    expect(fullRef("main", false)).toBe("refs/heads/main");
    expect(fullRef("v1", true)).toBe("refs/tags/v1");
    expect(fullRef("refs/heads/x", true)).toBe("refs/heads/x");
  });
});

describe("what the relay is told", () => {
  it("one tag per GitHub repository and ref, none for GitLab, and whether GitLab notices are taken", () => {
    const mesh = "m".repeat(22);
    const device = "d".repeat(22);
    const tag = ciRuleTag({ mesh, device, iss: GITHUB_ISSUER, repo: "octo-org/deploys", ref: "refs/heads/main" });
    expect(rulesFrame([ghRule(), ghRule({ workflow: "other.yml" })], mesh, device)).toEqual({ t: "ci.rules", tags: [tag], gitlab: false });
    expect(rulesFrame([glRule()], mesh, device)).toEqual({ t: "ci.rules", tags: [], gitlab: true });
    expect(rulesFrame([], mesh, device)).toEqual({ t: "ci.rules", tags: [], gitlab: false });
  });
});

describe("ruleLine", () => {
  it("says what each rule takes", () => {
    expect(ruleLine(ghRule())).toBe("github  octo-org/deploys  refs/heads/main  workflow deploy.yml  events: all but pull_request_target, workflow_run  ids not pinned yet (the first notice is held for you)");
    expect(ruleLine(ghRule({ events: ["push", "workflow_run"], environment: "prod", hold: true, pins: { repositoryId: "1", ownerId: "2" } }))).toBe(
      "github  octo-org/deploys  refs/heads/main  workflow deploy.yml  events push,workflow_run  environment prod  ids repositoryId=1 ownerId=2  every notice held",
    );
    expect(ruleLine(glRule())).toContain("protected refs only");
    expect(ruleLine(glRule({ unprotected: true }))).toContain("protected or not");
  });
});
