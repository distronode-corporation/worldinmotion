// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

// Bundles `wim` into one file, dist/wim.mjs, which is committed: the GitHub Action runs it from
// this repository at a tag, and CI checks it equals a fresh build. Run with
// `npm run bundle -w @worldinmotion/client`.
//
// Crash reports (src/crash.ts): the committed address in crash-report-dsn.txt (read and checked
// by dsn.mjs) is written into the bundle in place of `globalThis.__WIM_SENTRY_DSN__`. There is one
// build: the committed dist/wim.mjs, the release's wim.mjs, npm's (which the Claude Code plugin
// runs) and the extension's are the same bytes, and all of them carry the address. Run from source, `wim` has none.

import { build } from "esbuild";
import { chmod, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readDsn } from "./dsn.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const out = join(pkg, "dist", "wim.mjs");

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

const DSN_GLOBAL = "globalThis.__WIM_SENTRY_DSN__";

/** dist/wim.mjs with `dsn` as the crash-report address. */
const bundle = (dsn) => build({
  define: { [DSN_GLOBAL]: JSON.stringify(dsn) },
  entryPoints: [join(pkg, "src", "bin.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.18",
  // The source already starts with a shebang, which esbuild keeps; CommonJS dependencies inside
  // an ES module bundle need a real `require` for Node built-ins.
  banner: { js: 'import { createRequire as __wimCreateRequire } from "node:module"; const require = __wimCreateRequire(import.meta.url);' },
  // Optional native speed-ups of `ws`; it falls back to JavaScript without them. The Claude Agent
  // SDK is loaded by `wim agent runner` with a dynamic import, from wherever it is installed
  // beside wim (`npm install --global worldinmotion @anthropic-ai/claude-agent-sdk`): it ships
  // its own platform binary and licence, so it is never copied into this file.
  external: ["bufferutil", "utf-8-validate", "@anthropic-ai/claude-agent-sdk"],
  plugins: [stubSupportsColor],
  legalComments: "eof",
  logLevel: "warning",
});

const dsn = await readDsn(join(pkg, "crash-report-dsn.txt"));
await bundle(dsn);
const built = await readFile(out, "utf8");
if (built.includes("__WIM_SENTRY_DSN__")) throw new Error(`${out} still reads ${DSN_GLOBAL}: the define did not replace it`);
if (!built.includes(JSON.stringify(dsn))) throw new Error(`${out} does not carry the crash-report address`);
if (!built.includes('import("@anthropic-ai/claude-agent-sdk")')) throw new Error(`${out} no longer loads the Agent SDK with a dynamic import: it must stay external`);
await chmod(out, 0o755);
console.log(`wrote ${out}, carrying the crash-report address`);
