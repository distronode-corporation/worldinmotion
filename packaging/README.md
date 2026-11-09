# Packaging

How a release reaches each install channel. Every channel carries the same client build: the
`wim.mjs` that `release.yml` builds from the tag, checks against `SHA256SUMS` and attests.

| Channel | What users run | Built from | Published by |
|---|---|---|---|
| GitHub Release | `wim.mjs` + `SHA256SUMS` | `release.yml` `client` | `release.yml` `draft`, `publish` |
| npm | `npx worldinmotion`, `npm install --global worldinmotion` | `packaging/npm` + `wim.mjs` | `release.yml` `npm` (gated) |
| Homebrew | `brew install distronode-corporation/tap/worldinmotion` | the npm tarball | the tap's `bump-worldinmotion.yml`, in [homebrew-tap](https://github.com/distronode-corporation/homebrew-tap) |
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

## Homebrew: the tap

The formula lives in [distronode-corporation/homebrew-tap](https://github.com/distronode-corporation/homebrew-tap)
as `Formula/worldinmotion.rb`, not here. It installs the npm tarball with Homebrew's
`std_npm_args` and depends on Homebrew's `node`. It uses the tarball rather than the release's
bare `wim.mjs` because the tarball also carries `agent-kit/`, and because every release before 1.0
is a GitHub pre-release, which `brew audit --online` refuses as a formula URL. The tarball's
`wim.mjs` is the release's file, byte for byte. Its `test do` runs `wim --version`, writes the
deployment kit, and runs `wim test`.

Nothing in `release.yml` touches the tap, and it holds no credential for it: the tap updates
itself. Its `bump-worldinmotion.yml` runs daily and follows npm's `latest` `worldinmotion`.
Before it changes the formula's `url` and `sha256` it checks:

- that the GitHub Release `v<version>` is published;
- that the tarball's SHA-512 equals the registry's `dist.integrity`;
- that the tarball's npm provenance attestation verifies (`gh attestation verify --bundle`
  against this repository's `release.yml` at that tag, on a GitHub-hosted runner);
- that the tarball's `wim.mjs` matches the release's `SHA256SUMS` and asset digest;
- that the release's build provenance attestation verifies.

It refuses a version older than the formula's. It pushes a `bump/worldinmotion-<version>` branch
for a person to open as a pull request, and the tap's CI installs and tests the formula on Linux
and macOS. A release reaches Homebrew when that pull request is merged, after the bump's next
daily run (or a run by hand) once the release is on npm.

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
