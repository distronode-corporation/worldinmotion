// Bundles `wim` into one file, dist/wim.mjs, and copies it to the Claude Code plugin as
// dist/client.mjs. Run with `npm run bundle -w @worldinmotion/client`.

import { build } from "esbuild";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const out = join(pkg, "dist", "wim.mjs");
const plugin = join(pkg, "..", "..", "plugins", "claude-code", "dist", "client.mjs");

// `debug` (through the MCP SDK and others) does an optional `require("supports-color")` inside a
// try/catch and runs without colour when it gets nothing. supports-color is not a dependency of
// the client; it is in node_modules only for the Workers test tooling, so resolving it would make
// the shipped bundle depend on which dev dependencies happen to be installed. Stub it instead.
const stubSupportsColor = {
  name: "stub-supports-color",
  setup(b) {
    b.onResolve({ filter: /^supports-color$/ }, () => ({ path: "supports-color", namespace: "wim-stub" }));
    b.onLoad({ filter: /.*/, namespace: "wim-stub" }, () => ({ contents: "module.exports = false;", loader: "js" }));
  },
};

await build({
  entryPoints: [join(pkg, "src", "bin.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.18",
  // The source already starts with a shebang, which esbuild keeps; CommonJS dependencies inside
  // an ES module bundle need a real `require` for Node built-ins.
  banner: { js: 'import { createRequire as __wimCreateRequire } from "node:module"; const require = __wimCreateRequire(import.meta.url);' },
  // Optional native speed-ups of `ws`; it falls back to JavaScript without them.
  external: ["bufferutil", "utf-8-validate"],
  plugins: [stubSupportsColor],
  legalComments: "eof",
  logLevel: "warning",
});
await chmod(out, 0o755);
await mkdir(dirname(plugin), { recursive: true });
await copyFile(out, plugin);
console.log(`wrote ${out} and ${plugin}`);
