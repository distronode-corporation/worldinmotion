import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// These tests run inside workerd (the Workers runtime), not Node, against the Worker and Durable
// Objects described by wrangler.jsonc. The root vitest config excludes this package.
//
// The template leaves mesh creation closed (no WIM_CREATE_KEY, no WIM_OPEN_CREATE); the tests
// create meshes freely, so only they open it. They also turn on idle mesh expiry (30 days) so it
// runs through real objects. Tests of other settings build their own environment.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { WIM_OPEN_CREATE: "1", WIM_IDLE_MESH_DAYS: "30" } },
    }),
  ],
  test: {
    root: import.meta.dirname,
    include: ["test-workers/**/*.test.ts"],
    coverage: {
      // v8 coverage needs the inspector of a Node process; workerd needs istanbul instrumentation.
      provider: "istanbul",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
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
