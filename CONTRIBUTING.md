# Contributing to worldinmotion

Thanks for helping. This file says how the repository is laid out, how to run what CI
runs, and the few rules that are not negotiable because the project is a security
boundary between agents.

## Layout

```
SPEC.md                    The wire protocol (`wim/1`): the contract between clients and
                           relays. Code follows the spec, not the other way round.
SECURITY-MODEL.md          What the system protects against, and what it does not.
docs/design.md             The pieces on one machine: state on disk, MCP tools, the plugin
                           contract. Change it before the code that follows it.
packages/protocol/         Canonical encoding, crypto, roster chain and frame schemas.
                           Everything else depends on it.
packages/relay-core/       The per-mesh relay state machine, behind a storage interface.
packages/relay-node/       The self-hosted relay (node:http, ws, node:sqlite) and its Dockerfile.
packages/relay-cloudflare/ The relay as a Cloudflare Worker, one Durable Object per mesh.
packages/client/           `wim`: the CLI, the client library and the MCP server.
packages/bot/              `wim bot`: a model API as a mesh peer.
packages/ci/               `wim ci`: GitLab and GitHub pipeline and deployment watcher.
packages/a2a/              `wim a2a`: the Agent2Agent gateway.
packages/vscode/           The VS Code extension.
plugins/claude-code/       The Claude Code plugin. Its `dist/client.mjs` is the client bundle,
                           committed, because the marketplace installs it from the repo, at
                           the release tag that `.claude-plugin/marketplace.json` pins.
packaging/                 The npm package `worldinmotion` (the bundled `wim`) and the draft
                           Homebrew formula. packaging/README.md lists every install channel.
test/                      Repository-wide tests.
```

It is an npm workspaces monorepo written in TypeScript, tested with vitest.

## Setup

You need Node.js 22.18 or newer (`.nvmrc` names 24, which is what CI uses) and npm.

```
npm ci          # install exactly what package-lock.json says
npx tsc -b      # type-check every project in the build graph
npm test        # the vitest suite
```

`npx vitest run <file>` runs one test file. Tests need no network and no relay: anything
that talks to a socket is tested against an in-process fake or an in-process relay.

## Running each package's tests

The root vitest config runs every package except `relay-cloudflare`, so `npx vitest run
--coverage` covers them all. To run one package, filter by path and limit coverage to that
package's sources (the thresholds are per file, so an unfiltered coverage report fails on every
package you did not run):

```
npx vitest run packages/client --coverage --coverage.include='packages/client/src/**/*.ts'
```

The same works for `protocol`, `relay-core`, `relay-node`, `bot`, `ci`, `a2a` and `vscode`. The
others have their own commands:

| what | command |
|---|---|
| `packages/relay-cloudflare` (inside workerd) | `npm run test:coverage --workspace=@worldinmotion/relay-cloudflare` |
| `packages/vscode`, smoke test in a real VS Code | `npm run bundle --workspace=@worldinmotion/client`, `npm run bundle --workspace=worldinmotion`, then `xvfb-run -a node packages/vscode/test-electron/run.mjs` (drop `xvfb-run -a` on a desktop) |
| `plugins/claude-code` | `claude plugin test plugins/claude-code` (needs the Claude Code CLI, no login) |

## The whole local gate

This is every job in `.github/workflows/ci.yml`. All of it must be green on a pull request, and
`release.yml` runs the same workflow again on a tagged commit.

```
npm ci
npx tsc -b                                                         # test projects included
npx vitest run --coverage                                          # every package but relay-cloudflare
npm run test:coverage --workspace=@worldinmotion/relay-cloudflare  # the Workers relay, in workerd
npm run bundle --workspace=@worldinmotion/client                   # wim.mjs and the plugin bundle
npm run bundle --workspace=worldinmotion                           # the VS Code extension
git diff --exit-code --stat plugins/claude-code/dist/client.mjs    # the committed bundle equals the build
xvfb-run -a node packages/vscode/test-electron/run.mjs             # the extension's smoke test
(cd packages/vscode && npx vsce package --no-dependencies --pre-release)  # the .vsix packages
claude plugin test plugins/claude-code                             # the plugin's own tests
docker build --file packages/relay-node/Dockerfile --tag wim-relay:ci .
node .github/scripts/check-versions.mjs                            # every version string agrees, and the plugin pin
```

`check-versions.mjs` reads the release tags with git, so run it in a clone with the tags
(`git fetch --tags`), not a shallow one.

CI runs the `vitest` step on Linux, macOS and Windows, on the Node version in `.nvmrc` and on
22.18. Platform-specific code takes the platform as a parameter, so its tests cover every
platform's branches on any one machine; keep it that way. If you change the client, commit the rebuilt
`plugins/claude-code/dist/client.mjs` with it.

The supply-chain checks on pull requests (dependency review, and zizmor on the workflows) are in
`.github/workflows/supply-chain.yml`.

## Coverage is 100 percent

Every package is held at 100 percent line, branch, function and statement coverage, per file:
by the thresholds in the root `vitest.config.ts` for everything under `packages/*/src`, and by
`packages/relay-cloudflare/vitest.config.ts` for the Workers relay. The only excluded files are
the `bin.ts` entry points, which only wire the environment and signals to a tested function
(`test/bin-files.test.ts` keeps them that small). The rules that go with it:

- A reachable branch gets a test. Guards and parsers get hostile input, not just the
  happy path.
- An unreachable branch is dead code: delete it, with a one-line comment if the reason is
  not obvious. Do not add it to a coverage exclude.
- No `v8 ignore`, `istanbul ignore` or `c8 ignore` comments.
- Do not mock a dependency into a state it cannot produce. A test that passes only against
  an impossible mock proves nothing.
- If coverage is reached only on some runs (timers, socket races, test order), make the
  test deterministic rather than re-running until it passes.

## Dependencies

Every dependency is a piece of code that runs next to private keys, so:

- **Pinned exactly.** `"1.2.3"`, never `^1.2.3` or `~1.2.3`. `package-lock.json` is
  committed and CI installs with `npm ci`.
- **At least 7 days old.** A new dependency, or a new version of an existing one, must have
  been published at least seven days before the pull request adds it. A compromised
  release is usually caught and pulled within days; the wait keeps it out of this tree.
  Dependabot applies the same 7-day cooldown to its own updates.
- **Few.** Prefer the standard library and the existing dependencies. Say in the pull
  request why a new dependency is worth its weight, and check its licence is compatible
  with Apache-2.0.

## The protocol specification

`SPEC.md` is versioned along with the code. A pull request that changes it must:

- Say in the change itself what changed, as a short version note under the status line
  at the top of `SPEC.md` (for example "0.1.1: `receipt` gains the `expired` status").
- Say whether the change is compatible with existing clients and relays. A change that an
  existing peer would reject, or would accept and misread, is a new protocol version
  (`wim/2`), not an edit to `wim/1`.
- Change the code and its tests in the same pull request, so the spec never describes
  behaviour the code does not have.
- Update `SECURITY-MODEL.md` if the change affects what a relay or a peer can see or do.

## Releasing

A release is a `vX.Y.Z` tag on main, and `.github/workflows/release.yml` builds and publishes
everything from it. Each release takes three steps, in this order:

1. **The version bump**, as a pull request. It bumps every version string
   (`node .github/scripts/check-versions.mjs X.Y.Z` passes), commits the rebuilt
   `plugins/claude-code/dist/client.mjs`, and moves the CHANGELOG's Unreleased section to
   `[X.Y.Z]`, with its link at the bottom.
2. **The tag**, on the bump's merge commit. A release is never re-tagged: a bad one gets a new
   patch version.
3. **The plugin pin**, as a pull request right after the tag. The Claude Code marketplace
   installs the plugin from the release that `.claude-plugin/marketplace.json` pins, not from
   main, so code merged for the next release never reaches new installs before it is released.
   The pull request sets the plugin entry's `source.ref` to `vX.Y.Z` and `source.sha` to the
   tagged commit's full 40-character sha (`git rev-parse 'vX.Y.Z^{commit}'`), and changes
   nothing else. Claude Code checks out the sha, so the sha is what decides what installs.

Until the pin moves, the `versions` job fails on every pull request and on main: it checks that
the pin names the latest release tag before the commit it runs on, and that tag's commit. On the
tagged commit itself, the pin still names the release before, which is what the check expects
there.

## Commits and pull requests

Conventional Commits are not required. What is required is that the message says **why**,
not just what. The diff already says what. A good message names the thing that was wrong,
the evidence, and what would have caught it.

There is no Developer Certificate of Origin sign-off requirement. By opening a pull
request you agree that your contribution is licensed under the Apache License, Version
2.0, as section 5 of that licence describes.

Keep pull requests focused: one change, with its tests and docs. If you change behaviour
the README describes, change the README in the same pull request.

## Reporting bugs

Open an issue with what you ran, what happened and what you expected, plus your Node
version and OS. Never paste a device key file, an invite code or an operator key.

For anything security-relevant, do not open an issue. See [SECURITY.md](SECURITY.md).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
