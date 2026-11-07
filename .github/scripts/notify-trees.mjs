// Builds the two published CI senders (SPEC section 18) as the trees their own repositories
// hold, so release.yml and test/notify-trees.test.ts share one definition of what goes in:
//
//   github/   distronode-corporation/worldinmotion-notify on GitHub, for the Marketplace:
//             packaging/github-action, the release's own wim.mjs, LICENSE and NOTICE.
//   gitlab/   distronode-corporation/worldinmotion-notify on GitLab, for the CI/CD Catalog:
//             packaging/gitlab-component, LICENSE and NOTICE.
//
//   node .github/scripts/notify-trees.mjs <version> <wim.mjs> <out dir>
//
// Nothing else goes in: the Marketplace lists a repository holding one action at its root, and
// the tree carries only what that action needs. Each source folder must hold exactly the files listed here, so a file added to
// one is refused until it is listed. A README's `<!-- unpublished -->` ... `<!-- /unpublished -->`
// blocks are what is true only while it is read in this repository; the published copy drops
// them. Every refusal names what is wrong and writes nothing.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A release version as release.yml's guard has it: the tag without its `v`. */
export const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Each tree: the published path, and where it comes from (a path from the repository root, or
 * `BUNDLE` for the wim.mjs given on the command line). Sorted by published path.
 */
export const BUNDLE = Symbol("the wim.mjs of this release");
export const TREES = Object.freeze({
  github: Object.freeze({
    source: "packaging/github-action",
    files: Object.freeze([
      ["LICENSE", "LICENSE"],
      ["NOTICE", "NOTICE"],
      ["README.md", "packaging/github-action/README.md"],
      ["action.yml", "packaging/github-action/action.yml"],
      ["main.mjs", "packaging/github-action/main.mjs"],
      ["notify.mjs", "packaging/github-action/notify.mjs"],
      ["wim.mjs", BUNDLE],
    ]),
  }),
  gitlab: Object.freeze({
    source: "packaging/gitlab-component",
    files: Object.freeze([
      [".gitlab-ci.yml", "packaging/gitlab-component/.gitlab-ci.yml"],
      ["LICENSE", "LICENSE"],
      ["NOTICE", "NOTICE"],
      ["README.md", "packaging/gitlab-component/README.md"],
      ["templates/notify.yml", "packaging/gitlab-component/templates/notify.yml"],
    ]),
  }),
});

const OPEN = "<!-- unpublished -->";
const CLOSE = "<!-- /unpublished -->";

/**
 * A README as its published repository shows it: every unpublished block removed, markers
 * included. Refuses unbalanced or nested markers, and a link relative to this repository, which
 * would not resolve in the published one.
 * @param {string} text
 * @param {string} where the file, for messages
 */
export function publishedReadme(text, where) {
  let out = "";
  let at = 0;
  for (;;) {
    const open = text.indexOf(OPEN, at);
    const close = text.indexOf(CLOSE, at);
    if (open === -1 && close === -1) break;
    if (close === -1) throw new Error(`${where}: ${OPEN} is never closed`);
    if (open === -1 || close < open) throw new Error(`${where}: ${CLOSE} without an ${OPEN} before it`);
    const inner = text.slice(open + OPEN.length, close);
    if (inner.includes(OPEN)) throw new Error(`${where}: unpublished blocks do not nest`);
    out += text.slice(at, open);
    at = close + CLOSE.length;
    // The block's own line ending goes with it, so no blank line is left behind.
    if (text[at] === "\n") at += 1;
  }
  out += text.slice(at);
  const relative = /\]\((?!https:\/\/|#)([^)]*)\)/.exec(out);
  if (relative !== null) {
    throw new Error(`${where}: the link ${JSON.stringify(relative[1])} is relative to this repository; the published README needs an https:// link`);
  }
  return out;
}

/**
 * The checks each published file must pass, beyond being copied.
 * @param {string} tree
 * @param {string} path the published path
 * @param {Buffer} bytes
 * @param {string} version
 * @returns {Buffer}
 */
function published(tree, path, bytes, version) {
  const where = `${tree}/${path}`;
  const text = bytes.toString("utf8");
  if (path === "README.md") return Buffer.from(publishedReadme(text, where));
  if (path === "wim.mjs") {
    const declared = [...text.matchAll(/^var VERSION = "([^"]*)";$/gm)].map((m) => m[1]);
    if (declared.length !== 1) throw new Error(`${where}: not a wim client bundle (${declared.length} VERSION declarations, expected one)`);
    if (declared[0] !== version) throw new Error(`${where}: the bundle is wim ${declared[0]}, not this release's ${version}`);
  }
  if (path === "action.yml" && text.includes("${{")) {
    // GitHub evaluates expressions anywhere in an action's metadata, descriptions included, and
    // one it cannot evaluate there stops the action from loading.
    throw new Error(`${where}: holds a \${{ }} expression, which stops the action from loading`);
  }
  if (path === "templates/notify.yml" && !text.includes(`      default: "worldinmotion@${version}"\n`)) {
    throw new Error(`${where}: wim_package does not default to worldinmotion@${version}`);
  }
  return bytes;
}

/** Every file under `dir`, as paths relative to it with `/`, sorted. */
function listFiles(dir, prefix = "") {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      return entry.isDirectory() ? listFiles(dir, path) : [path];
    })
    .sort();
}

/**
 * Both trees, in memory: tree name, then published path, then bytes.
 * @param {{ root: string, version: string, bundle: string }} options the repository root, the
 *   release version (X.Y.Z) and the path of the release's wim.mjs
 * @returns {Record<string, Map<string, Buffer>>}
 */
export function buildTrees({ root, version, bundle }) {
  if (typeof version !== "string" || !VERSION.test(version)) {
    throw new Error(`the version is ${JSON.stringify(version)}: it must be X.Y.Z, the release tag without its v`);
  }
  if (!existsSync(bundle)) throw new Error(`the bundle ${bundle} does not exist`);
  const trees = {};
  for (const [name, { source, files }] of Object.entries(TREES)) {
    const expected = files
      .map(([, from]) => from)
      .filter((from) => from !== BUNDLE && from.startsWith(`${source}/`))
      .map((from) => from.slice(source.length + 1))
      .sort();
    const actual = listFiles(join(root, source));
    if (actual.join("\n") !== expected.join("\n")) {
      throw new Error(`${source} holds ${JSON.stringify(actual)}, expected exactly ${JSON.stringify(expected)}: list a new file in TREES in .github/scripts/notify-trees.mjs, or remove it`);
    }
    const tree = new Map();
    for (const [path, from] of files) {
      const bytes = readFileSync(from === BUNDLE ? bundle : join(root, from));
      tree.set(path, published(name, path, bytes, version));
    }
    trees[name] = tree;
  }
  return trees;
}

/**
 * Writes the trees under `out`, which must not exist yet.
 * @param {string} out
 * @param {Record<string, Map<string, Buffer>>} trees
 * @returns {string[]} one line per file: its sha256 and path, as sha256sum prints them
 */
export function writeTrees(out, trees) {
  if (existsSync(out)) throw new Error(`${out} already exists; the trees are written to a new directory`);
  const lines = [];
  for (const [name, tree] of Object.entries(trees)) {
    for (const [path, bytes] of tree) {
      const file = join(out, name, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
      lines.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}/${path}`);
    }
  }
  return lines;
}

/**
 * The command line. Returns the exit code.
 * @param {string[]} args
 * @param {{ root: string, out: (line: string) => void, err: (line: string) => void }} io
 */
export function cli(args, io) {
  if (args.length !== 3) {
    io.err("usage: node .github/scripts/notify-trees.mjs <version> <wim.mjs> <out dir>");
    return 2;
  }
  const [version, bundle, out] = args;
  try {
    for (const line of writeTrees(out, buildTrees({ root: io.root, version, bundle }))) io.out(line);
  } catch (error) {
    io.err(`::error::${error.message}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = cli(process.argv.slice(2), {
    root: join(import.meta.dirname, "..", ".."),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
