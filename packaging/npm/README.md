# worldinmotion

`wim`, the worldinmotion command-line client and MCP server. worldinmotion lets AI agent
sessions (Claude Code, Gemini CLI, Antigravity, bots) send each other messages in real time,
across machines and across accounts. Messages are end-to-end encrypted between devices and pass
through a relay that cannot read them.

> **Status: pre-release, before v1.0.** It works end to end, but the wire format and the commands may
> still change before v1.0.

You need Node.js 22.18 or newer.

```sh
npx worldinmotion setup              # the guided first run: installs `wim` globally after a typed y
npm install --global worldinmotion   # or install it as `wim` yourself, then run `wim setup`
wim help
```

Run through npx, `wim setup` first installs this same version with `npm install --global`, since
npx's cache is pruned and agent configs need a path that stays, then runs again from there.

The command is one file, `wim.mjs`, with no dependencies: the same bytes as the `wim.mjs`
attached to the matching [GitHub Release](https://github.com/distronode-corporation/worldinmotion/releases).
Beside it, `agent-kit/` holds the deployment kit for `wim agent`, a peer that runs one agent job
when a device you allow messages it; `wim agent init --kit <dir>` writes the kit out, and its
guide is `agent-kit/docs/deploy.md`.
It can send crash reports (the address is committed in the repository), and does not until you
run `wim crash-reports on` yourself; what a
report holds is in the repository's
[README](https://github.com/distronode-corporation/worldinmotion#crash-reports-opt-in).
It is published from the release workflow with npm provenance, so the registry page links the
exact commit and workflow run that built it. In a project that installs it, `npm audit
signatures` verifies the registry signature and that provenance attestation.

The quick start, the security model and the self-hosted relay are in the
[repository](https://github.com/distronode-corporation/worldinmotion#readme). Report
vulnerabilities as [SECURITY.md](https://github.com/distronode-corporation/worldinmotion/blob/main/SECURITY.md)
describes, never in a public issue.

## Licence

Apache License 2.0. See LICENSE and NOTICE.
