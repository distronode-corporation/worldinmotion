// Every place the release version is written down must agree.
//
//   node .github/scripts/check-versions.mjs          all of them equal the root package.json
//   node .github/scripts/check-versions.mjs 0.2.0    all of them equal 0.2.0 (the release tag)
//
// What it reads:
//   - package.json (the root) and every packages/*/package.json: `version`;
//   - in those, every dependency on another workspace package (they are pinned exactly);
//   - package-lock.json: the root and every workspace entry's `version`;
//   - plugins/claude-code/.claude-plugin/plugin.json: `version`;
//   - .claude-plugin/marketplace.json: any `version` field (top level, `metadata`, each
//     plugin entry), if one is ever added;
//   - the versions typed in source, below in SOURCE_CONSTANTS;
//   - any `<name>-X.Y.Z.vsix` file name in a package.json script.
// A constant that is no longer found is an error, so renaming one cannot turn the check off.
// Exits 1 and lists every mismatch.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const json = (path) => JSON.parse(read(path));

const SOURCE_CONSTANTS = [
  { file: "packages/client/src/cli.ts", pattern: /export const VERSION = "([^"]+)";/ },
  { file: "packages/a2a/src/inbound.ts", pattern: /const GATEWAY_VERSION = "([^"]+)";/ },
  { file: "packages/relay-core/src/host.ts", pattern: /export const RELAY_VERSION = "([^"]+)";/ },
];

const want = process.argv[2] ?? json("package.json").version;
const found = [];
const errors = [];
const check = (where, have) => {
  found.push(where);
  if (have !== want) errors.push(`${where} is ${JSON.stringify(have)}, expected ${want}`);
};

check("package.json version", json("package.json").version);

const workspaces = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `packages/${entry.name}`);
const manifests = new Map(workspaces.map((dir) => [dir, json(`${dir}/package.json`)]));
const names = new Set([...manifests.values()].map((pkg) => pkg.name));

for (const [dir, pkg] of manifests) {
  check(`${dir}/package.json version`, pkg.version);
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [dep, spec] of Object.entries(pkg[field] ?? {})) {
      if (names.has(dep)) check(`${dir}/package.json ${field}.${dep}`, spec);
    }
  }
  for (const [script, command] of Object.entries(pkg.scripts ?? {})) {
    for (const match of command.matchAll(/[\w.-]+-(\d+\.\d+\.\d+[\w.-]*?)\.vsix/g)) {
      check(`${dir}/package.json scripts.${script} (${match[0]})`, match[1]);
    }
  }
}

const lock = json("package-lock.json");
check("package-lock.json root version", lock.version);
for (const dir of workspaces) check(`package-lock.json packages["${dir}"].version`, lock.packages[dir]?.version);

check("plugins/claude-code/.claude-plugin/plugin.json version", json("plugins/claude-code/.claude-plugin/plugin.json").version);

const marketplace = json(".claude-plugin/marketplace.json");
if (marketplace.version !== undefined) check(".claude-plugin/marketplace.json version", marketplace.version);
if (marketplace.metadata?.version !== undefined) {
  check(".claude-plugin/marketplace.json metadata.version", marketplace.metadata.version);
}
for (const plugin of marketplace.plugins ?? []) {
  if (plugin.version !== undefined) check(`.claude-plugin/marketplace.json plugins[${plugin.name}].version`, plugin.version);
}

for (const { file, pattern } of SOURCE_CONSTANTS) {
  const match = read(file).match(pattern);
  if (match === null) errors.push(`${file}: ${pattern} not found; update SOURCE_CONSTANTS in this script`);
  else check(`${file} ${pattern.source.split(" = ")[0]}`, match[1]);
}

for (const where of found) console.log(`checked ${where}`);
if (errors.length > 0) {
  for (const error of errors) console.error(`::error::${error}`);
  process.exit(1);
}
console.log(`all ${found.length} version strings are ${want}`);
