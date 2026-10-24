import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Coverage excludes packages/*/src/bin.ts, so each must stay a thin wrapper: no branches of its
// own, only imports from its own package and one call into a tested entry point.
const root = join(import.meta.dirname, "..", "packages");
const bins = readdirSync(root)
  .map((pkg) => join(root, pkg, "src", "bin.ts"))
  .filter((path) => existsSync(path));

// A line that branches. Keywords need word boundaries; the operators do not, because `\b` next to
// `||` or `&&` needs a word character there, so the spaced form `a || b` would slip through.
const branching = /\b(if|else|switch|case|while|for\s*\(|catch)\b|\?\?|\|\||&&|\?[^.]/;

describe("the branch pattern", () => {
  it.each([
    ['main(process.env.A || "x");'],
    ["main(a && b);"],
    ['main(process.env.A ?? "x");'],
    ["main(a||b);"],
    ["main(a ? b : c);"],
    ["if (a) main();"],
  ])("flags %s", (line) => {
    expect(line).toMatch(branching);
  });
  it.each([['import { main } from "./cli.ts";'], ["await main(process.argv.slice(2), process.env);"], ["main(a?.b);"]])(
    "passes %s",
    (line) => {
      expect(line).not.toMatch(branching);
    },
  );
});

describe("bin.ts entry points", () => {
  it("exist", () => {
    expect(bins.length).toBeGreaterThan(0);
  });
  for (const path of bins) {
    it(`${path.slice(root.length + 1)} is a thin wrapper`, () => {
      const code = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "" && !line.trim().startsWith("//") && !line.startsWith("#!"));
      expect(code.length).toBeLessThanOrEqual(8);
      for (const line of code) {
        expect(line).not.toMatch(branching);
        if (line.startsWith("import")) expect(line).toMatch(/from "\.\/[\w-]+\.ts";$/);
      }
    });
  }
});
