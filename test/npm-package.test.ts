import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { npmLayout } from "../packages/client/src/npxsetup.ts";

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

  it("puts wim.mjs where `npx worldinmotion setup` runs it from after a global install", () => {
    // npxsetup.ts runs <global node_modules>/worldinmotion/wim.mjs: the package's name and its one bin.
    const bin = (pkg.bin as Record<string, string>).wim!;
    expect(join(npmLayout("/usr/local", "linux").modules, pkg.name as string, bin)).toBe(join("/usr/local/lib/node_modules/worldinmotion/wim.mjs"));
    expect(pkg.files).toContain(bin);
  });

  it("ships the bundle with no dependencies to install", () => {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "bundleDependencies"]) {
      expect(pkg[field]).toBeUndefined();
    }
    expect(pkg.files).toEqual(["wim.mjs", "LICENSE", "NOTICE", "README.md"]);
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
