import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commandUsage } from "../packages/client/src/cli.ts";
import { SETUP_COMMANDS } from "../packages/client/src/setup.ts";

// The VS Code extension is published as a pre-release only. An unpinned `code --install-extension
// distronode.worldinmotion` asks for the latest stable version, finds none and prints only "Failed
// Installing Extensions" (issue #35), so every documented install command names the pre-release
// track or a version, and each page that gives it says why.
const repo = join(import.meta.dirname, "..");
const pages = ["README.md", "packages/vscode/README.md"];
const command = /code --install-extension distronode\.worldinmotion(@[^\s`]+)?(?<rest>[^`\n]*)/g;

describe("VS Code install commands in the docs", () => {
  for (const page of pages) {
    const text = readFileSync(join(repo, page), "utf8");
    const found = [...text.matchAll(command)];

    it(`${page} gives the command`, () => {
      expect(found.length).toBeGreaterThan(0);
    });

    it(`${page} names the pre-release track or a version in every one`, () => {
      for (const m of found) expect(m[1] !== undefined || /--pre-release/.test(m.groups!["rest"]!)).toBe(true);
    });

    it(`${page} says why, and what the failure without it looks like`, () => {
      expect(text).toMatch(/published as a\s+pre-release only/);
      expect(text).toContain("Failed Installing Extensions");
    });
  }
});

// `wim setup` (README, Quick start) runs these commands for the person; the README names the same
// ones, and every `wim` command the quick start names exists.
describe("the README's quick start", () => {
  const text = readFileSync(join(repo, "README.md"), "utf8");
  const quick = text.slice(text.indexOf("## Quick start: `wim setup`"), text.indexOf("## First run"));

  it("comes before the manual first run, which stays", () => {
    expect(text.indexOf("## Quick start: `wim setup`")).toBeGreaterThan(-1);
    expect(quick.length).toBeGreaterThan(0);
    expect(text).toContain("### 2. Create the mesh, on the first machine");
  });

  it("starts with `npx worldinmotion setup`, with the global install as the alternative", () => {
    expect(/```sh\n([^\n]*)\n/.exec(quick)![1]).toBe("npx worldinmotion setup");
    expect(quick).toContain("`npm install --global worldinmotion@<version>`");
    expect(quick).toContain("install `wim` first (step 1 below) and run `wim setup`");
  });

  it("names the commands wim setup runs, exactly", () => {
    for (const c of SETUP_COMMANDS) expect(quick.replace(/\s+/g, " ")).toContain(c);
  });

  it("names only wim commands that exist, and wim help setup and recovery show --wait give them", () => {
    const named = [...quick.matchAll(/`wim ([a-z-]+)/g)].map((m) => m[1]!);
    expect(named).toContain("setup");
    for (const c of named) expect(commandUsage(c)).toBeDefined();
    expect(commandUsage("setup")).toBe("wim setup [<invite code>] [--name <device>] [--relay <url>] [--key-env NAME]");
    expect(commandUsage("recovery")).toContain("wim recovery show [--wait]");
    expect(text).toContain("`wim recovery show --wait`");
  });
});
