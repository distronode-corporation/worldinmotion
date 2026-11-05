// Bundles `wim` into one file, dist/wim.mjs, and copies it to the Claude Code plugin as
// dist/client.mjs. Run with `npm run bundle -w @worldinmotion/client`.
//
// Crash reports (src/crash.ts): the address they go to is written into the bundle in place of
// `globalThis.__WIM_SENTRY_DSN__`. Without WIM_SENTRY_DSN in the environment that is `""`, so the
// bundle has no address and never reports; that is the bundle the plugin gets, always, because
// the plugin is committed. With WIM_SENTRY_DSN (only the release workflow sets it, from the
// repository secret of that name), dist/wim.mjs is built again carrying the address, and checked
// to differ from the plugin's bundle by that string alone.

import { build } from "esbuild";
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
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

const DSN_GLOBAL = "globalThis.__WIM_SENTRY_DSN__";

/** dist/wim.mjs with `dsn` as the crash-report address ("" for none). */
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
  // Optional native speed-ups of `ws`; it falls back to JavaScript without them.
  external: ["bufferutil", "utf-8-validate"],
  plugins: [stubSupportsColor],
  legalComments: "eof",
  logLevel: "warning",
});

await bundle("");
const plain = await readFile(out, "utf8");
if (plain.includes("__WIM_SENTRY_DSN__")) throw new Error(`${out} still reads ${DSN_GLOBAL}: the define did not replace it`);
await chmod(out, 0o755);
await mkdir(dirname(plugin), { recursive: true });
await copyFile(out, plugin);
console.log(`wrote ${out} and ${plugin}`);

const dsn = (process.env.WIM_SENTRY_DSN ?? "").trim();
if (dsn !== "") {
  if (!/^https:\/\/[0-9a-f]{16,64}@[a-z0-9.-]+(:\d{1,5})?\/\d{1,20}$/.test(dsn)) throw new Error("WIM_SENTRY_DSN is not an https Sentry DSN (https://<key>@<host>/<project>)");
  await bundle(dsn);
  const baked = await readFile(out, "utf8");
  const literal = JSON.stringify(dsn);
  if (!baked.includes(literal)) throw new Error(`${out} does not carry the crash-report address`);
  if (baked.replaceAll(literal, '""') !== plain) throw new Error(`${out} differs from the plugin's bundle by more than the crash-report address`);
  await chmod(out, 0o755);
  console.log(`wrote ${out} again, carrying the crash-report address (the plugin's copy has none)`);
}
