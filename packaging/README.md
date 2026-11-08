# Packaging

How a release reaches each install channel. Every channel carries the same client build: the
`wim.mjs` that `release.yml` builds from the tag, checks against `SHA256SUMS` and attests.

| Channel | What users run | Built from | Published by |
|---|---|---|---|
| GitHub Release | `wim.mjs` + `SHA256SUMS` | `release.yml` `client` | `release.yml` `draft`, `publish` |
| npm | `npx worldinmotion`, `npm install --global worldinmotion` | `packaging/npm` + `wim.mjs` | `release.yml` `npm` (gated) |
| Homebrew | `brew install distronode-corporation/tap/worldinmotion` | the npm tarball | the tap (`packaging/homebrew` is the draft) |
| VS Code Marketplace | the extension `distronode.worldinmotion` | `packages/vscode` | `release.yml` `marketplace` (gated) |
| Open VSX | the same extension, for Cursor, VSCodium and others | `packages/vscode` | `release.yml` `openvsx` (gated) |
| GitHub Marketplace | the action `worldinmotion CI notice` | `packaging/github-action` + `wim.mjs` | `release.yml` `notify-github` (gated) commits and tags its own repository; the Marketplace listing of each tag is a release drafted there by hand |
| GitLab CI/CD Catalog | the component `notify` | `packaging/gitlab-component` | `release.yml` `notify-gitlab` (gated), into its own project |

## npm: `packaging/npm`

The package `worldinmotion` is `wim.mjs` and its licence files, with one bin, `wim`, and no
dependencies. With a single bin, `npx worldinmotion <command>` runs it, and a global install
puts `wim` on the `PATH`. `npx worldinmotion setup` is `wim setup`: run from npx's cache, it
installs this same version globally (`npm install --global worldinmotion@<version>`, after a typed
`y`) and runs `wim setup` again from `<prefix>/lib/node_modules/worldinmotion/wim.mjs`
(`<prefix>\node_modules\worldinmotion\wim.mjs` on Windows), the path agent configs then name.

It is not a workspace package, for two reasons:

- The name `worldinmotion` is already the VS Code extension's workspace name, which is also its
  Marketplace identity (`distronode.worldinmotion`), so it cannot change. npm workspaces need
  unique names. The extension stays `"private": true`, which keeps it off npm.
- The workspace packages (`@worldinmotion/client` and the rest) export their TypeScript sources.
  Node strips types only outside `node_modules` (inside it, it fails with
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so they would not run from npm as they are.
  The bundle has no such problem, and needs none of their runtime dependencies.

The `@worldinmotion` scope is reserved on npm for library packages, which would first need a
build that emits JavaScript.

To see what the npm job would publish, from the repository root:

```sh
npm run bundle -w @worldinmotion/client
cp packages/client/dist/wim.mjs LICENSE NOTICE packaging/npm/
(cd packaging/npm && npm pack --dry-run)
```

`packaging/npm/package.json` carries the release version like every other manifest;
`.github/scripts/check-versions.mjs` checks it against the tag.

## Homebrew: `packaging/homebrew/worldinmotion.rb`

A draft formula for [distronode-corporation/homebrew-tap](https://github.com/distronode-corporation/homebrew-tap),
to live there as `Formula/worldinmotion.rb`. It installs the npm tarball with Homebrew's
`std_npm_args` and depends on Homebrew's `node`. Its `sha256` is a placeholder until the first
version is on npm.

The tap today holds one cask and its automation is cask-only, so moving the formula there is a
tap pull request that also:

- extends `audit.yml`: its `brew style` and `brew audit --tap` already cover the whole tap,
  but the job counts only `Casks/*.rb` before running them, and nothing installs a formula,
  so it needs a formula-aware check plus `brew install` and `brew test` (on Linux and macOS);
- adds a bump workflow beside `bump.yml` that reads the latest `worldinmotion` version from
  the npm registry, downloads its tarball, refuses to go on unless the tarball's SHA-512
  equals the registry's `dist.integrity` and its provenance attestation names this repository's
  `release.yml` at the matching tag, then writes the formula's `url` and `sha256` and opens
  a pull request, as `bump.yml` does for the cask.

## CI senders: `packaging/github-action` and `packaging/gitlab-component`

The two ways a CI job sends a notice (SPEC section 18), each laid out as the root of the
repository or project it is published from, both named `distronode-corporation/worldinmotion-notify`:
a GitHub repository for the Marketplace (`action.yml` at its root) and a GitLab project for the
CI/CD Catalog (`templates/notify.yml`). `.github/workflows/ci-notice-staging.yml` runs the action
from this repository by hand against a relay.

`.github/scripts/notify-trees.mjs` builds both trees, which `release.yml`'s `notify-github` and
`notify-gitlab` jobs commit and tag (`vX.Y.Z` on GitHub, `X.Y.Z` on GitLab, whose own
`.gitlab-ci.yml` lists the tag in the Catalog), and which `test/notify-trees.test.ts` checks:

- GitHub: `action.yml`, `main.mjs`, `notify.mjs`, the release's `wim.mjs`, `README.md`,
  `LICENSE` and `NOTICE`, only what the action needs (no workflow, no tests);
- GitLab: `templates/notify.yml`, `.gitlab-ci.yml`, `README.md`, `LICENSE` and `NOTICE`.

Each README drops its `<!-- unpublished -->` blocks in the published copy. To see the trees, from
the repository root:

```sh
npm run bundle -w @worldinmotion/client
node .github/scripts/notify-trees.mjs "$(node -p 'require("./package.json").version')" packages/client/dist/wim.mjs ../notify-trees
```

- **The action** is a JavaScript action on GitHub's Node.js 24. `main.mjs` (through `notify.mjs`) runs `wim ci notify`
  from the bundle beside it (`wim.mjs` in its own repository; here, the Claude Code plugin's
  committed bundle, which CI checks against a fresh build), so the pinned commit is the code
  that runs and nothing is downloaded. Its own repository holds the `wim.mjs` of the release
  it was published from.
- **The component** runs `npm exec` of `worldinmotion` at the exact version in its
  `wim_package` default, which `check-versions.mjs` holds to the release version.

`test/ci-integrations.test.ts` holds both to the contract of `wim ci notify`.

## Extension registries

`release.yml`'s header says what each gated job needs before its repository variable is
turned on. The publishing CLIs are pinned by `.github/publish/package-lock.json`, apart from
the workspaces.
