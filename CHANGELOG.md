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

### Added

- **`wim ping <address,...>` and `wim ping --all`**: a new message kind that the receiving client
  answers itself with a `pong` (SPEC section 12), never an agent: nothing is spooled, kept in
  history or receipted, and no turn starts. One pong proves both directions between two devices,
  encryption included; the command prints a row per session and a verdict per device. Pongs are
  rate limited per sender device, a ping older than a minute is not answered, and a device the
  person refuses gets no answer. Older clients drop the new kind and show as "no pong". New test
  vectors: `ping.json`.
- **Adding a device later**: every session of an admin device keeps a join request that passes
  the checks (never its comparison code), so `wim devices pending` lists waiting devices and
  `wim devices admit <name> <code>` admits one after `wim invite` has stopped.
- **`wim devices trust --all`** (and `untrust --all`), and after an admit or a join the question
  "Is X your own device? Trust its messages here?" at an interactive terminal.
- **VS Code: Add a Device..., Admit a Device... and Join a Mesh...**, through new `wim events`
  requests (`invite`, `admit`, and `join` in a new setup mode for a device in no mesh yet) and a
  `join` event (docs/events.md). The invite code is copied with a button and taken in a password
  field, never shown.

### Changed

- **No more y/N when adding a device.** `wim invite` asks the person to type the comparison code
  the new device shows, compared without case or dashes, and no longer shows its own copy
  (SECURITY-MODEL section 5.6). The confirmation is taken only from an interactive terminal
  (standard input and output) with no agent's variables set; without `--auto`, `wim invite`
  refuses to start anywhere else, before any code exists. It also prints "On the new device, in a
  terminal: `wim join <code>`". `wim join` says "comparison code" and how to admit it.
- SPEC section 5 records a design for short invite codes that are no weaker than today's, as
  proposed and not implemented.

## [0.1.4] - 2026-10-29

### Added

- **`wim agent`, a signer that keeps the device keys out of agents' reach** (`SECURITY-MODEL.md`
  section 5.8), the ssh-agent model, optional. `wim agent encrypt` encrypts `device.json` under a
  passphrase (scrypt, ChaCha20-Poly1305) and seals every prekey secret; `wim agent start`, run in
  your own terminal, asks for the passphrase once and starts a signer process that holds the keys.
  Sessions then sign, seal and open through it over a Unix socket in a 0700 directory (a named
  pipe with a secret name on Windows) and never read the keys. `wim agent lock` wipes them from its
  memory, and `wim agent unlock` starts a new signer with the passphrase, which never goes over the
  socket; `wim agent status` and `wim agent stop`; `wim agent decrypt` goes back to the plaintext
  file with the same identity. The signer never signs a prekey for a caller, refuses a prekey
  past its deletion time, logs every request and rate limits key operations. A process running as
  you can still ask the unlocked signer to act for the device; section 5.8 says what it stops and
  what it does not. The wire is unchanged.
- **The signer's socket is a sealed channel** after the signer's `hello`, which signs the client's
  nonce and both sides' X25519 keys: a process relaying the hello (a proxy at the socket path)
  reads and forges nothing. The signer locks and stops when its socket path comes to name
  anything else, two starts at once cannot both bind, a Windows pipe name is new for each start,
  and every command needs the signer to prove itself, locked or not, with a run key the device key
  certified at start: `lock` and `stop` cannot be answered by anything else.
- **`require_signer`**: set by `wim agent encrypt` (or `WIM_REQUIRE_SIGNER=1`), clients refuse a
  plaintext key file. Without it, and without an encrypted key file, nothing changes.
- **Keyring variants in the protocol package**: `sealMessageWith`, `openMessageWith`,
  `signAuthWith`, `createGenesisRosterWith`, `nextRosterWith` and `createJoinWith` take a `Keyring`
  (`sign`, `seal`, `open`) instead of raw keys, so an implementation can keep its keys in another
  process; `localKeyring` is the in-memory one.

### Changed

- **Client library: a `Device` carries a `keyring`, not its raw `keys`.** A device read from a
  plaintext key file is a `LocalDevice`, which still has `keys`; one whose keys are in the signer
  has none. Peer cards are opened one at a time in arrival order.
- **Prompts on a closed stdin answer empty** instead of leaving the process to exit with Node's
  "unsettled top-level await" warning: `--passphrase-stdin` with no input fails with "no
  passphrase given", and a confirmation (`wim invite`, `wim recover`) reads as no. A last line
  without a newline still counts as the answer.
- **Dependencies**: `@aws-sdk/client-bedrock-runtime` 3.1155.0; the GitHub Actions the workflows
  pin move to their latest minor versions.

## [0.1.3] - 2026-10-29

### Added

- **Forward secrecy, bounded** (`SPEC.md` section 6b, `SECURITY-MODEL.md` section 6.14). Each
  device makes a signed X25519 prekey per mesh every day (signed by its own key, valid 48 hours)
  and deletes each prekey's secret 72 hours after it expires. Every box is sealed to the
  recipient device's current prekey with a fresh ephemeral key: RFC 9180 HPKE in auth mode,
  DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and ChaCha20-Poly1305, built on the noble libraries the
  protocol already used (no new dependency) and checked against the RFC's test vectors. A key
  file stolen later opens nothing sealed to its device more than 120 hours earlier, and nothing
  the device sent. Sibling sessions still read one box per device, redelivery and dedupe work as
  before, and revocation needs no rekey.
- **A scheme field on every new box** (`"s": 2`), so a later scheme, such as an MLS room mode as
  `wim/2`, is added without breaking this one. A box without `s` is a v0.1 box.
- **Prekeys travel in headers**, as `pk` in every `send` frame and peer card. No relay frame was
  added, and a relay needs no code change, only the new protocol package.
- New test vectors in `packages/protocol/vectors/prekey.json`; `sign.json` covers the `prekey`
  signature type.

### Changed

- **The wire format changes.** A v0.1 client drops any frame that holds a new box or a `pk`, and a
  v0.1 relay refuses such frames as malformed: upgrade relays first. Devices can then upgrade one
  at a time: an upgraded client sends a v0.1 device only frames it reads (below).
- **The migration window, until 1.0.** Clients still open v0.1 boxes, so v0.1 senders and messages
  queued or kept in history from before an upgrade still read. A message with any recipient
  device that has no current prekey (a v0.1 client, or one offline for over 48 hours) goes in the
  v0.1 format for every recipient: no `pk` and v0.1 boxes only, so a v0.1 device in the send reads
  it. It has no forward secrecy for anyone in it: `wim send` prints "Sent without forward secrecy
  to <every device in the send>: no current prekey for <the devices without one> ...", and the MCP
  `send`, `reply` and `send_file` results carry `unprotected`, `no_prekey` and that sentence as
  `note`. In a mesh with a v0.1 device that is every room and broadcast message; upgraded devices
  still learn each other's prekeys from cards, so messages among them alone keep forward secrecy.
  A hostile relay can force that downgrade during the window by withholding cards. From 1.0, v0.1
  boxes are refused and senders never fall back.
- **Peer cards keep `pk` in a mixed mesh**, since they are how upgraded devices learn prekeys. A
  v0.1 client drops them and loses peer labels (the labels of a whole `cards` page holding one),
  nothing else.
- **Every session now publishes a peer card**, with no labels when cards are off or it has no
  working directory, because the card's header carries the device's prekey. Listings show no
  labels for an empty card, as before.
- **A message sealed to a prekey this device no longer holds** (deleted on schedule, or lost with
  the prekey file) is dropped, and the session gets one notice per sender device asking for it to
  be sent again.

## [0.1.2] - 2026-10-29

### Added

- **Install channels.** `npx worldinmotion` (a standalone package that is the bundled `wim`), the
  VS Code Marketplace listing as a pre-release under the `distronode` publisher, and gated release
  jobs for npm and Open VSX. `packaging/README.md` lists every channel.

### Changed

- **Relays keep room history for 72 hours, not 7 days**, to match the prekey retention planned for
  forward secrecy. 72 hours is now the ceiling for everything a relay holds for delivery: room
  history (72 hours), queued messages for an offline session (24 hours, so an undelivered direct
  box never outlives it) and files (24 hours). A relay may lower these lifetimes but no longer
  raise one past 72 hours, and it never serves a history entry older than 72 hours, even before
  its sweep has deleted it. `SPEC.md` sections 9 and 13 say so.
- **Upgrading a relay needs no step.** The first sweeps after the upgrade delete the older
  history in batches of at most 256 entries per mesh, so a large mesh or Durable Object never runs
  one long sweep. relay-node now also sweeps meshes nobody has dialled since it started (8 a
  second, in turn); before, their expired queues, history and files waited for the next dial. A
  Cloudflare relay object deletes its older history on its next alarm, at most 4 days after the
  deploy for an object nobody dials.

### Security

- **The release tools pin `@azure/msal-node` 7.1.1** (GHSA-xcx6-jx8p-x3h5): `@vscode/vsce` pulls
  `@azure/identity`, which still asks for an affected 6.x. The publish jobs never used the
  affected flow. `@vscode/vsce` is 4.1.0, the first with `--oidc` trusted publishing.

## [0.1.1] - 2026-10-25

A fix for the first message of the quick start.

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

[Unreleased]: https://github.com/distronode-corporation/worldinmotion/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/distronode-corporation/worldinmotion/releases/tag/v0.1.4
[0.1.3]: https://github.com/distronode-corporation/worldinmotion/releases/tag/v0.1.3
[0.1.2]: https://github.com/distronode-corporation/worldinmotion/releases/tag/v0.1.2
[0.1.1]: https://github.com/distronode-corporation/worldinmotion/releases/tag/v0.1.1
[0.1.0]: https://github.com/distronode-corporation/worldinmotion/releases/tag/v0.1.0
