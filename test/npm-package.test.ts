import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// packaging/npm is the `worldinmotion` package that release.yml's npm job publishes with
// provenance: the bundled client and nothing else to run. These are the properties that make
// `npx worldinmotion` work and the provenance verify, checked here because the package is only
// assembled on a tag.
const root = join(import.meta.dirname, "..");
const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8")) as Record<string, unknown>;

const pkg = json("packaging/npm/package.json");
const client = json("packages/client/package.json");
const extension = json("packages/vscode/package.json");

describe("the worldinmotion npm package", () => {
  it("is the unscoped name `npx worldinmotion` resolves", () => {
    expect(pkg.name).toBe("worldinmotion");
    expect(pkg.private).toBeUndefined();
  });

  it("has exactly one bin, wim, so npx runs it whatever the package is called", () => {
    expect(pkg.bin).toEqual({ wim: "wim.mjs" });
    expect((client.bin as Record<string, string>).wim).toBe("./dist/wim.mjs");
  });

  it("ships the bundle with no dependencies to install", () => {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "bundleDependencies"]) {
      expect(pkg[field]).toBeUndefined();
    }
    expect(pkg.files).toEqual(["wim.mjs", "agent-kit", "LICENSE", "NOTICE", "README.md"]);
  });

  it("supports the same Node as the client", () => {
    expect(pkg.engines).toEqual(client.engines);
  });

  it("names this repository, which npm provenance requires", () => {
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/distronode-corporation/worldinmotion.git",
      directory: "packaging/npm",
    });
    expect((extension.repository as { url: string }).url).toBe("https://github.com/distronode-corporation/worldinmotion.git");
  });

  it("publishes publicly, with provenance, to the public registry", () => {
    expect(pkg.publishConfig).toEqual({ access: "public", provenance: true, registry: "https://registry.npmjs.org/" });
  });

  it("is not a workspace, so it does not collide with the extension's own name", () => {
    expect(extension.name).toBe("worldinmotion");
    expect(extension.private).toBe(true);
    expect(json("package.json").workspaces).toEqual(["packages/*"]);
  });
});

describe("the deployment kit in the npm package", () => {
  it("is copied in by the release, from the tagged sources", () => {
    const release = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
    expect(release).toContain("node packaging/npm/agent-kit.mjs");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain("packaging/npm/agent-kit/");
  });

  it("holds every file of the kit, modes kept, where `wim agent init --kit` looks (agent-kit/ beside wim.mjs)", () => {
    const out = mkdtempSync(join(process.env["WIM_TEST_TMP"] || tmpdir(), "wim-npm-kit-"));
    try {
      const to = join(out, "agent-kit");
      execFileSync(process.execPath, [join(root, "packaging", "npm", "agent-kit.mjs"), to], { stdio: "pipe" });
      const walk = (d: string, rel = ""): string[] =>
        readdirSync(join(d, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(d, join(rel, e.name)) : [join(rel, e.name)]));
      const kit = join(root, "packages", "agent");
      const want = [...walk(kit, "deploy"), join("docs", "deploy.md"), join("docs", "privileged-runner.md")].sort();
      expect(walk(to).sort()).toEqual(want);
      for (const f of want) expect(statSync(join(to, f)).mode & 0o777).toBe(statSync(join(kit, f)).mode & 0o777);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
