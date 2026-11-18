# Governance

worldinmotion is owned by Distronode Corporation and published from the
`distronode-corporation` organization on GitHub. This file says who decides what, how a change
gets in, how a release goes out, and what happens if the maintainer is no longer available.

## How decisions are made

The maintainer decides. A change to the code, the protocol (`SPEC.md`) or the security model
(`SECURITY-MODEL.md`) is proposed as a pull request against `main`, discussed there, and merged
only once the maintainer approves it. Larger questions (a protocol change, a new component, a
change of scope) are raised as an issue first, and the maintainer's decision is recorded on that
issue or pull request.

What the repository enforces today:

- **Every path has a code owner.** `.github/CODEOWNERS` assigns every path to the maintainer
  (`@seandean`), so every pull request requests the maintainer's review.
- **`main` takes changes only through a pull request.** The default branch ruleset requires an
  approving review from the code owner, approval of the most recent push (a push after the
  approval dismisses it), every review thread resolved, and the required CI checks passing on a
  branch that is up to date with `main`. It refuses force pushes and deletion of `main`, and
  merges are squash or rebase only. The maintainer can bypass this ruleset.
- **The author never approves their own change.** Pull requests are often written by the
  organization's own account (`@distronode-com`), which cannot approve them, so the approval
  always comes from a different person.
- **Review threads must be resolved.** The `review-threads` check is red while any thread on a
  pull request is open, whether a person or a review bot started it.

## How releases are made

A release is a `vX.Y.Z` tag on `main`, and `.github/workflows/release.yml` builds and publishes
everything from that tag. The steps (the version bump as a pull request, the tag, then the plugin
pin as a pull request) are in [CONTRIBUTING.md](CONTRIBUTING.md), "Releasing". A ruleset refuses
moving or deleting a release tag (repository admins can bypass it), and a bad release gets a new
patch version, never a re-tag. Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Roles and responsibilities

- **Maintainer** (`@seandean`): reviews and approves every pull request, decides on issues and
  on the project's direction, makes releases, and answers security reports.
- **Contributors**: anyone who opens an issue or a pull request. How to build, test and propose
  a change is in [CONTRIBUTING.md](CONTRIBUTING.md); everyone follows the
  [Code of Conduct](CODE_OF_CONDUCT.md). Contributions are under the Apache License 2.0 (see
  [LICENSE](LICENSE)).
- **Security contact**: vulnerabilities are reported privately as described in
  [SECURITY.md](SECURITY.md), never in a public issue.

## Continuity

The project does not depend on one person's account. The `distronode-corporation` GitHub
organization has more than one owner: besides the maintainer, a second owner account,
`distronode-legal`, is held by Distronode Corporation's legal function (legal@distronode.com).
If the maintainer is lost or unavailable, the corporation can, within one week, create and
close issues, accept changes and make a release.
