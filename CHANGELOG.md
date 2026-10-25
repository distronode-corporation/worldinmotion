# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release workflow note: `.github/workflows/release.yml` extracts the section for a tag out
of this file and uses it verbatim as the GitHub Release body. The extraction is
index-based on the `## [x.y.z]` heading and stops at the next such heading or at the first
line beginning with `[`, so keep the link definitions at the bottom and do not start a
body line with a bracket.

## [Unreleased]

### Fixed

- **A first send to a new device answered `unknown`.** Following the quick start (init, invite,
  join, trust), `wim send cli@<second device> hello` failed with `cli@<second device>: unknown`
  until the second device had run `wim inbox` once, because a relay knows a session only after it
  has connected. `wim join`, `wim init --relay` and `wim mesh create` now connect the device's
  default `cli` session (or `WIM_NAME`) once and leave it offline, so a first send answers
  `queued` and the next `wim inbox` there reads it. The wire protocol is unchanged. If the relay
  cannot be reached for that step, the command still succeeds and says so.
- **README quick start:** step 4 runs `wim inbox` on the second device before the first send.
  As written, the send to `cli@<second device>` was refused as unknown, because that session
  had never connected.

## [0.1.0] - 2026-10-24

The first pre-release. The wire format and the commands may still change before 1.0.

### Added

- **Protocol `wim/1`** (`SPEC.md`, `packages/protocol`): canonical encoding, Ed25519 signatures,
  per-recipient XChaCha20-Poly1305 boxes, a hash-chained roster signed by admin devices,
  one-time invites confirmed with a short authentication string, a recovery record, rooms,
  advisory leases with fencing tokens, encrypted files in chunks, and peer cards. No forward
  secrecy in this version.
- **Relays**: the per-mesh state machine (`packages/relay-core`), a self-hosted Node relay with
  SQLite and a container image (`packages/relay-node`, `ghcr.io/distronode-corporation/worldinmotion-relay`),
  and a Cloudflare Worker with one Durable Object per mesh (`packages/relay-cloudflare`). A relay
  refuses mesh creation unless `WIM_CREATE_KEY` or `WIM_OPEN_CREATE=1` is set, can cap meshes,
  delete idle meshes and lower file limits, and describes itself at `GET /v1/info`.
- **The `wim` client** (`packages/client`), shipped as one file, `wim.mjs`, with `SHA256SUMS` and
  a build provenance attestation on each GitHub Release. Commands to create and join a mesh,
  manage devices and their inbound policy (`deliver`, `deliver-relayed`, `hold`, `refuse`),
  send, watch, read the inbox and history, approve held messages, recover a mesh, replace the
  recovery code (`wim recovery rotate`), and check the setup (`wim doctor`).
- **`wim mcp`**: an MCP server over stdio with the tools `peers`, `send`, `ask`, `reply`,
  `inbox`, `wait`, `rooms`, `lease`, `send_file`, `history` and `rename`. Peer text reaches the
  agent framed as another AI session's text; outbound text and text files that look like
  credentials are refused.
- **Agent safety in the client**: messages from devices not marked as the person's own are held
  for approval, relayed text never assigns work, and a loop and cost breaker pauses a peer that
  wakes an agent too often.
- **The Claude Code plugin** (`plugins/claude-code`, installed from this repository's
  marketplace): push delivery into the session, the SendMessage and ListAgents bridges, and the
  `/wim` pane with the held queue.
- **`wim events`** (`docs/events.md`): a JSON-lines interface for local user interfaces.
- **The VS Code extension** (`packages/vscode`, built from source, not on the Marketplace): the
  mesh, rooms, leases, held messages, threads and a live activity view.
- **Peers without an agent**: `wim bot` (`packages/bot`) runs a Bedrock, Vertex AI Gemini or
  Ollama model as a peer with daily token and cost caps; `wim ci` (`packages/ci`) posts GitLab
  and GitHub pipeline and deployment changes into a room; `wim a2a` (`packages/a2a`) is a gateway
  to Agent2Agent agents in both directions.
- **Phone notifications** through a `command` provider (`notify.json`, `wim notify-test`).
- **Documentation**: setup for Gemini CLI, Antigravity, Claude Desktop, Codex, Cursor and other
  MCP clients (`docs/peers.md`), the threat model (`SECURITY-MODEL.md`), and the hosted relay's
  terms (`docs/hosted-relay.md`).

[Unreleased]: https://github.com/distronode-corporation/worldinmotion/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/distronode-corporation/worldinmotion/releases/tag/v0.1.0
