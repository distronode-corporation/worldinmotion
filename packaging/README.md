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

## npm: `packaging/npm`

The package `worldinmotion` is `wim.mjs` and its licence files, with one bin, `wim`, and no
dependencies. With a single bin, `npx worldinmotion <command>` runs it, and a global install
puts `wim` on the `PATH`.

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

## Extension registries

`release.yml`'s header says what each gated job needs before its repository variable is
turned on. The publishing CLIs are pinned by `.github/publish/package-lock.json`, apart from
the workspaces.
