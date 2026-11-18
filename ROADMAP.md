# Roadmap

The near-term plan for worldinmotion, taken from what is still open in this repository. It has
no dates: an item is done when the change that does it is merged and released, and it then
leaves this list for [CHANGELOG.md](CHANGELOG.md). Anything here can change; open an issue to
discuss an item or to propose a new one.

## Near term

- **The formal two-account test.** A mesh never uses a vendor account, so crossing accounts is
  how worldinmotion is built, but the formal test across two accounts has not run yet (README,
  the status note at the top; `docs/spikes.md`, S6). The plan is to run the acceptance test on
  two machines signed in to two accounts and record the result.
- **Live runs of Codex, Cursor and Copilot CLI.** `wim run cursor`, `wim run copilot` and
  `wim run codex`, and Codex's hooks, are built from each vendor's documentation and have not
  been run (README, "Other agents", the table's "how it was checked" column; SECURITY-MODEL
  section 9). Gemini CLI and Antigravity CLI have been run live. The plan is to run each of the
  three live with wim and record it in that table.
- **Publishing the CI senders.** The GitHub Action (`packaging/github-action`) and the GitLab
  CI/CD component (`packaging/gitlab-component`) are built, but neither is published yet, so the
  `uses:` and `include:` lines in the README do not resolve (README, "CI notices"). The release
  workflow already has both publish jobs, off until each one's target repository exists
  (`.github/workflows/release.yml`, `notify-github` and `notify-gitlab`). The plan is to turn
  them on for a release. `notify-github` pushes the Action's commit and tag; the Marketplace has
  no API, so its listing is then a release drafted there by hand with the Marketplace option
  ticked. `notify-gitlab` runs after the `npm` job, because the component runs the npm package of
  the same version, and the component's own project then makes the release the Catalog lists.
- **The hosted relay.** `wss://worldinmotion.distronode.com` is running and open to anyone, with
  no SLA, on the terms in [docs/hosted-relay.md](docs/hosted-relay.md). A mesh cannot yet move
  from one relay to another, so leaving the hosted relay means creating a new mesh on another
  relay and inviting each device again (docs/hosted-relay.md, "When the offer ends").
- **Faster `wim held resume` on Windows.** It does about 30 file operations per held item there
  (issue #195).
