import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The VS Code extension imports `vscode`, which only exists inside VS Code; its tests run
    // against a typed fake of the parts it uses.
    alias: [{ find: /^vscode$/, replacement: fileURLToPath(new URL("./packages/vscode/test/fake-vscode.ts", import.meta.url)) }],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "test/**/*.test.ts"],
    // The Cloudflare relay's tests run inside the Workers runtime with their own config.
    exclude: ["**/node_modules/**", "packages/relay-cloudflare/**"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      // A bin.ts only wires process.env and signals to a tested entry point; test/bin-files.test.ts
      // keeps each one that small, so excluding them hides no logic.
      exclude: ["packages/relay-cloudflare/**", "packages/*/src/bin.ts"],
      reporter: ["text", "json-summary"],
      // Every package is held to 100% on all four metrics, per file: each line and branch is
      // exercised by a test, and unreachable code is deleted rather than excluded.
      thresholds: {
        perFile: true,
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
