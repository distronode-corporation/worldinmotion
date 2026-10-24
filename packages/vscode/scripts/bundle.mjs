// Builds the extension: dist/extension.js (the extension host side, `vscode` external),
// media/activity.js (the activity webview), and a copy of the wim client bundle at dist/wim.mjs.
// Run with `npm run bundle -w worldinmotion` after `npm run bundle -w @worldinmotion/client`.

import { build } from "esbuild";
import { access, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(pkg, "..", "..");
const client = join(root, "packages", "client", "dist", "wim.mjs");

try {
  await access(client);
} catch {
  console.error(`missing ${client}: run npm run bundle -w @worldinmotion/client first`);
  process.exit(1);
}

await build({
  entryPoints: [join(pkg, "src", "extension.ts")],
  outfile: join(pkg, "dist", "extension.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  // The extension host runs Electron's Node (24 in VS Code 1.143); the client targets 22.18 too.
  target: "node22.18",
  external: ["vscode"],
  sourcemap: false,
  legalComments: "eof",
  logLevel: "warning",
});

await build({
  entryPoints: [join(pkg, "src", "webview", "main.ts")],
  outfile: join(pkg, "media", "activity.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  legalComments: "eof",
  logLevel: "warning",
});

await mkdir(join(pkg, "dist"), { recursive: true });
await copyFile(client, join(pkg, "dist", "wim.mjs"));
// The packaged extension carries the project's licence and notice.
await copyFile(join(root, "LICENSE"), join(pkg, "LICENSE"));
await copyFile(join(root, "NOTICE"), join(pkg, "NOTICE"));
console.log("wrote dist/extension.js, media/activity.js and dist/wim.mjs");
