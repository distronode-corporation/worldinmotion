import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
