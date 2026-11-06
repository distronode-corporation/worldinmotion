// The person's CI rules (SPEC section 18): the file, exact and pattern matching (fork and
// privileged events included), id pins, and what the relay is told.

import { ciCandidateTags, ciRuleTag, GITHUB_ISSUER, GITLAB_ISSUER, ulid, type GithubClaims, type GitlabClaims } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkRule,
  claimIds,
  isPinned,
  loadCiRules,
  matchesByName,
  matchRule,
  patternLines,
  pinRule,
  readCiRules,
  refRefusal,
  ruleLine,
  ruleRef,
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

describe("matching a pattern rule", () => {
  const tagged = (ref: string, repo = "Octo-Org/Deploys", file = "release.yml") => gh({ ref, workflowRef: `${repo}/.github/workflows/${file}@${ref}` });
  const release = ghRule({ ref: "refs/tags/v*", workflow: "release.yml" });

  it("takes every GitHub ref under the prefix, the prefix itself and names with / included, and nothing else", () => {
    for (const ref of ["refs/tags/v3.3.0", "refs/tags/v", "refs/tags/v1/rc", "refs/tags/vx*?"]) expect(matchesByName(release, tagged(ref))).toBe(true);
    for (const ref of ["refs/tags/V1", "refs/tags/x-v1", "refs/heads/v1", "refs/tags/", "refs/tag/v1"]) expect(matchesByName(release, tagged(ref))).toBe(false);
    expect(matchesByName(ghRule({ ref: "refs/tags/*", workflow: "release.yml" }), tagged("refs/tags/anything"))).toBe(true);
    expect(matchesByName(ghRule({ ref: "refs/tags/*", workflow: "release.yml" }), tagged("refs/heads/main"))).toBe(false);
    expect(matchesByName(ghRule({ ref: "refs/heads/release/*", workflow: "release.yml" }), tagged("refs/heads/release/1.x"))).toBe(true);
    expect(matchesByName(ghRule({ ref: "refs/heads/release/*", workflow: "release.yml" }), tagged("refs/heads/release"))).toBe(false);
  });

  it("reads a full ref exactly: a ref holding a literal * is not a pattern for the rule", () => {
    // A token's ref is compared with a full-ref rule byte for byte; a rule can never hold a * in the middle.
    expect(matchesByName(ghRule({ ref: "refs/tags/v1", workflow: "release.yml" }), tagged("refs/tags/v1"))).toBe(true);
    expect(matchesByName(ghRule({ ref: "refs/tags/v1", workflow: "release.yml" }), tagged("refs/tags/v10"))).toBe(false);
  });

  it("needs workflow_ref to name the token's own ref exactly, so the pattern applies to it too", () => {
    expect(matchesByName(release, gh({ ref: "refs/tags/v3.3.0", workflowRef: "octo-org/deploys/.github/workflows/release.yml@refs/tags/v3.3.0" }))).toBe(true);
    // Another ref under the same pattern in workflow_ref, a branch, or no ref at all.
    expect(matchesByName(release, gh({ ref: "refs/tags/v3.3.0", workflowRef: "Octo-Org/Deploys/.github/workflows/release.yml@refs/tags/v3.3.1" }))).toBe(false);
    expect(matchesByName(release, gh({ ref: "refs/tags/v3.3.0", workflowRef: "Octo-Org/Deploys/.github/workflows/release.yml@refs/heads/main" }))).toBe(false);
    expect(matchesByName(release, gh({ ref: "refs/tags/v3.3.0", workflowRef: "Octo-Org/Deploys/.github/workflows/release.yml@refs/tags/v" }))).toBe(false);
    expect(matchesByName(release, gh({ ref: "refs/tags/v3.3.0", workflowRef: "Octo-Org/Deploys/.github/workflows/release.yml" }))).toBe(false);
    expect(matchesByName(release, tagged("refs/tags/v1", "Octo-Org/Deploys", "deploy.yml"))).toBe(false);
    expect(matchesByName(release, tagged("refs/tags/v1", "Octo-Org/Other"))).toBe(false);
  });

  it("takes every GitLab ref under the prefix, protected only unless the rule allows unprotected", () => {
    const rule = glRule({ ref: "refs/tags/v*" });
    expect(matchesByName(rule, gl({ ref: "refs/tags/v2.0" }))).toBe(true);
    expect(matchesByName(rule, gl({ ref: "refs/tags/v" }))).toBe(true);
    expect(matchesByName(rule, gl({ ref: "refs/heads/v2.0" }))).toBe(false);
    expect(matchesByName(rule, gl({ ref: "refs/tags/v2.0", refProtected: false }))).toBe(false);
    expect(matchesByName(glRule({ ref: "refs/tags/v*", unprotected: true }), gl({ ref: "refs/tags/v2.0", refProtected: false }))).toBe(true);
    expect(matchesByName(glRule({ ref: "refs/heads/release/*" }), gl({ ref: "refs/heads/release/a/b" }))).toBe(true);
  });

  it("matches nothing under a corrupt rule ref that never went through the schema", () => {
    expect(matchesByName(ghRule({ ref: "refs/tags/v?*", workflow: "release.yml" }), tagged("refs/tags/v?x"))).toBe(false);
    expect(matchesByName(glRule({ ref: "*" }), gl())).toBe(false);
  });
});

describe("what a pattern rule tells the person", () => {
  it("says nothing extra for a full ref", () => {
    expect(patternLines(ghRule())).toEqual([]);
  });

  it("names the prefix and the GitHub ruleset targets that cover it, / included", () => {
    const lines = patternLines(ghRule({ ref: "refs/tags/v*" }));
    expect(lines[0]).toBe('This rule is a pattern: it takes every tag whose name starts with "v" (that name itself included, and names with / in them), so anyone who can push such a tag can send.');
    expect(lines[1]).toContain("a tag ruleset (Settings, Rules, Rulesets)");
    expect(lines[1]).toContain("targeting both v* and v*/**/*");
    expect(patternLines(ghRule({ ref: "refs/heads/*" }))[0]).toBe("This rule is a pattern: it takes every branch, so anyone who can push any branch can send.");
    expect(patternLines(ghRule({ ref: "refs/heads/release/*" }))[1]).toContain("a branch ruleset");
  });

  it("names GitLab's protected tags or branches, and what the protection setting means", () => {
    const tags = patternLines(glRule({ ref: "refs/tags/v*" }));
    expect(tags[1]).toBe("Protect the same tags at GitLab: Settings, Repository, Protected tags, with the wildcard v*.");
    expect(tags[2]).toContain("nothing from a matching tag is delivered until it is protected");
    const branches = patternLines(glRule({ ref: "refs/heads/release/*", unprotected: true }));
    expect(branches[1]).toContain("Protected branches, with the wildcard release/*.");
    expect(branches[2]).toContain("anyone who can push a matching branch can send");
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

  it("reads --tag as a tag name, --ref as a full ref or else a branch name", () => {
    expect(ruleRef("ref", "release/*")).toBe("refs/heads/release/*");
    expect(ruleRef("ref", "refs/heads/release/*")).toBe("refs/heads/release/*");
    expect(ruleRef("tag", "v*")).toBe("refs/tags/v*");
    expect(ruleRef("tag", "v1")).toBe("refs/tags/v1");
    // A name is a name: --tag never reads refs/ as a full ref.
    expect(ruleRef("tag", "refs/heads/x")).toBe("refs/tags/refs/heads/x");
    expect(ruleRef("ref", "main")).toBe("refs/heads/main");
    expect(ruleRef("ref", "refs/tags/v*")).toBe("refs/tags/v*");
    expect(ruleRef("ref", "refs/heads/x")).toBe("refs/heads/x");
  });

  it("takes full refs and patterns with one trailing *, the bare prefix included, and refuses every other spelling", () => {
    for (const good of ["refs/heads/main", "refs/tags/v1.2.3", "refs/tags/v*", "refs/heads/release/*", "refs/tags/*", "refs/heads/*", `refs/tags/${"é".repeat(244)}*`]) {
      expect(refRefusal(good)).toBeUndefined();
      expect(checkRule({ ...ghRule(), ref: good }).ref).toBe(good);
    }
    for (const bad of ["refs/tags/v**", "refs/tags/*v", "refs/tags/v*.*", "refs/tags/v?", "refs/tags/v[0-9]*", "refs/tags/v\\*", "refs/tags/v 1*", "refs/tags/v\u0001*", "refs/pull/*", "refs/heads/", "refs/*", "main", "*"]) {
      expect(refRefusal(bad)).toMatch(/^not a branch or tag name, or a pattern: .*A pattern ends in one \*/);
      expect(() => checkRule({ ...glRule(), ref: bad })).toThrow(/invalid CI rule: ref/);
    }
    // 255 code points is the limit, counted as code points, never UTF-16 units.
    expect(refRefusal(`refs/tags/${"é".repeat(245)}`)).toBeUndefined();
    expect(refRefusal(`refs/tags/${"😀".repeat(245)}`)).toBeUndefined();
    expect(refRefusal(`refs/tags/${"😀".repeat(245)}*`)).toMatch(/^the ref is longer than 255 characters: refs\/tags\/😀+\.\.\.$/u);
    expect(refRefusal(`refs/tags/${"x".repeat(246)}`)).toMatch(/longer than 255/);
  });

  it("refuses a rules file holding a ref with any other glob spelling", async () => {
    const dir = await scratch("cirules-glob");
    const path = join(dir, "ci-rules.json");
    for (const ref of ["refs/tags/v?", "refs/tags/*v", "refs/heads/**"]) {
      await fs.writeFile(path, JSON.stringify({ v: 1, rules: [{ ...ghRule(), ref }] }));
      await expect(readCiRules(path)).rejects.toThrow(/not a valid CI rules file/);
    }
    await saveCiRules(path, [ghRule({ ref: "refs/tags/v*" })], FS);
    expect((await loadCiRules(path))[0]!.ref).toBe("refs/tags/v*");
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

  it("tags a pattern as the rule spells it, *, and that tag is one of a matching token's candidates", () => {
    const mesh = "m".repeat(22);
    const device = "d".repeat(22);
    const tag = ciRuleTag({ mesh, device, iss: GITHUB_ISSUER, repo: "octo-org/deploys", ref: "refs/tags/v*" });
    expect(rulesFrame([ghRule({ ref: "refs/tags/v*" })], mesh, device).tags).toEqual([tag]);
    expect(ciCandidateTags({ mesh, device, iss: GITHUB_ISSUER, repo: "Octo-Org/Deploys", ref: "refs/tags/v3.3.0" })).toContain(tag);
    expect(ciCandidateTags({ mesh, device, iss: GITHUB_ISSUER, repo: "Octo-Org/Deploys", ref: "refs/heads/v3.3.0" })).not.toContain(tag);
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
