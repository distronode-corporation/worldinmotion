import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { latestRelease, PINNED_SOURCE, pinErrors } from "../.github/scripts/plugin-pin.mjs";

// The marketplace entry must install the Claude Code plugin from a release, never from the
// default branch, where unreleased client code would reach every new install. These are
// the rules `.github/scripts/check-versions.mjs` applies with the repository's real tags; here
// they get hostile input with made-up ones.
const root = join(import.meta.dirname, "..");
const marketplace = JSON.parse(readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8")) as {
  plugins: { name: string; source: unknown }[];
};

const A = "1111111111111111111111111111111111111111";
const B = "2222222222222222222222222222222222222222";
const C = "3333333333333333333333333333333333333333";
const releases = [
  { name: "v0.1.5", commit: A },
  { name: "v0.1.10", commit: B },
  { name: "v0.1.9", commit: C },
];
const pinned = (fields: Record<string, unknown> = {}) => ({
  name: "worldinmotion",
  source: { ...PINNED_SOURCE, ref: "v0.1.10", sha: B, ...fields },
});

type Errors = string[];
const check = (entry: unknown, tags = releases): Errors => pinErrors(entry, tags) as Errors;

describe("latestRelease", () => {
  it("compares versions as numbers, not as text", () => {
    expect(latestRelease(releases)?.name).toBe("v0.1.10");
    expect(latestRelease([{ name: "v1.0.0", commit: A }, { name: "v0.10.0", commit: B }])?.name).toBe("v1.0.0");
    expect(latestRelease([{ name: "v0.2.0", commit: A }, { name: "v0.1.99", commit: B }])?.name).toBe("v0.2.0");
  });

  it("ignores tags that are not a release vX.Y.Z", () => {
    const tags = [{ name: "v0.1.5", commit: A }, { name: "v9.0.0-rc.1", commit: B }, { name: "latest", commit: C }];
    expect(latestRelease(tags)?.name).toBe("v0.1.5");
  });

  it("finds none in an empty list", () => {
    expect(latestRelease([])).toBeUndefined();
  });
});

describe("pinErrors", () => {
  it("accepts a git-subdir source naming the latest release and its commit", () => {
    expect(check(pinned())).toEqual([]);
  });

  it("refuses the relative path that installs from the default branch", () => {
    expect(check({ name: "worldinmotion", source: "./plugins/claude-code" }).join("\n")).toMatch(/default branch/);
  });

  it("refuses a source that is missing or not an object", () => {
    for (const source of [undefined, null, 7, ["git-subdir"]]) {
      expect(check({ name: "worldinmotion", source })).toHaveLength(1);
    }
    for (const entry of [undefined, null, "worldinmotion"]) expect(check(entry)).toHaveLength(1);
  });

  it("refuses any other source type, repository or directory", () => {
    expect(check(pinned({ source: "github" })).join("\n")).toMatch(/source\.source/);
    expect(check(pinned({ url: "https://github.com/someone-else/worldinmotion.git" })).join("\n")).toMatch(/source\.url/);
    expect(check(pinned({ url: "distronode-corporation/worldinmotion" })).join("\n")).toMatch(/source\.url/);
    expect(check(pinned({ path: "plugins/claude-code/" })).join("\n")).toMatch(/source\.path/);
  });

  it("refuses a key it does not know, so nothing can loosen the pin unchecked", () => {
    expect(check(pinned({ sparsePaths: ["plugins"] })).join("\n")).toMatch(/sparsePaths/);
  });

  it("refuses a missing ref or sha: without the sha, a moved tag would change what installs", () => {
    expect(check(pinned({ ref: undefined })).join("\n")).toMatch(/source\.ref/);
    expect(check(pinned({ sha: undefined })).join("\n")).toMatch(/source\.sha/);
  });

  it("refuses a ref that is a branch or not a release tag", () => {
    for (const ref of ["main", "0.1.10", "v0.1", "v0.1.10-rc.1", "refs/tags/v0.1.10"]) {
      expect(check(pinned({ ref })).join("\n")).toMatch(/source\.ref/);
    }
  });

  it("refuses a short, uppercase or padded sha", () => {
    for (const sha of [B.slice(0, 12), B.toUpperCase().replace(/2/g, "A"), ` ${B}`, `${B}0`]) {
      expect(check(pinned({ sha })).join("\n")).toMatch(/source\.sha/);
    }
  });

  it("refuses a pin that lags the latest release: the post-tag pull request was skipped", () => {
    const errors = check(pinned({ ref: "v0.1.9", sha: C }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/v0\.1\.9/);
    expect(errors[0]).toMatch(/v0\.1\.10/);
  });

  it("refuses a pin naming a release that is not on this branch yet", () => {
    expect(check(pinned({ ref: "v0.2.0", sha: A })).join("\n")).toMatch(/v0\.2\.0/);
  });

  it("refuses a sha that is not the tag's commit", () => {
    const errors = check(pinned({ sha: A }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(A);
    expect(errors[0]).toContain(B);
  });

  it("fails closed when no release tag is visible, as in a shallow clone", () => {
    expect(check(pinned(), []).join("\n")).toMatch(/fetch-depth: 0/);
  });
});

describe("the committed marketplace", () => {
  it("lists one plugin, pinned the way pinErrors requires", () => {
    expect(marketplace.plugins).toHaveLength(1);
    const [entry] = marketplace.plugins;
    const { ref, sha } = entry!.source as { ref: string; sha: string };
    // The real tags are checked by check-versions.mjs in CI; this checks the shape offline.
    expect(check(entry, [{ name: ref, commit: sha }])).toEqual([]);
  });
});
