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

- **`wim setup`, a guided first run on one machine.** In a terminal of your own it creates the
  device and a mesh, offering the host name as the device name and the hosted relay as the relay,
  shows what the relay says it offers, and asks for a typed `y` before it creates anything. It
  shows the recovery code once and waits for Enter. When the `claude` or `code` command is
  installed, it offers the Claude Code plugin or the VS Code extension, showing the commands it
  runs (without a shell) and waiting for a `y`; it prints the state directory and why, and warns
  when `CLAUDE_CONFIG_DIR` is set. It ends with `wim status`, problems first. Run again on a device
  that is set up, it skips what is done. It refuses an agent's shell and piped input or output, as
  the other person-only commands do, never asks about crash reports and does not start the
  signer. Adding a machine to an existing mesh from `wim setup`, and `wim setup <invite code>`,
  come later; `wim invite` and `wim join` do that today. `wim init`, `wim join` and
  `wim invite --auto` are unchanged.
- **`wim recovery show --wait`** waits for Enter after showing the code, so a terminal that closes
  when its command ends keeps the code on screen until the person has stored it.
- **Close the downgrade window early.** `wim legacy-boxes refuse` makes a device refuse v0.1
  boxes now, as every device will from 1.0 (SPEC section 6b): it never sends one (a direct send
  to a device with no current prekey is refused with the reason, a broadcast, room send or card
  skips that device and `wim send` names it), and it drops every one it receives as
  `legacy_box`. A relay that withholds prekeys can no longer strip forward secrecy from that
  device's sends. Anyone may turn it on; `wim legacy-boxes accept` turns it off and is the
  person's alone (their own terminal and a typed `y`, as for `wim devices trust`), with no MCP
  tool or events op. `wim status` and `wim doctor` show it. Off by default until 1.0. No wire
  change.
- **`wim hook <agent>`: other agents look again at turn end.** It is a turn-end hook for Gemini
  CLI, Antigravity CLI, Codex CLI, Cursor and Copilot CLI. When a turn ends and messages from
  devices you trust wait for that session, the hook asks the agent for one more turn. The request
  is a fixed line: how many messages wait, and to call the `inbox` tool. It never holds a peer's
  text, name or address. Each message is announced once per agent session. Held messages,
  untrusted devices, relayed text, CI notices and paused devices never wake it, and anything
  unclear lets the agent stop (exit 0 always). The hook counts only the `wim mcp` that the same
  agent session started, which `wim mcp` now records in its session directory (`ancestry.json`)
  while it runs. Add the hook entry by hand for now: [docs/peers.md](docs/peers.md) has it for
  each agent. Gemini CLI and Antigravity CLI were checked live; the other three follow their
  documentation. An idle session still does not wake.
- **A dropped v0.1 box is told and counted.** With `wim legacy-boxes refuse` on, a message
  dropped as `legacy_box` gives the session a local notice, once per sender device per session, that
  names the sender and carries none of the message, and `wim status` shows how many this device
  has dropped.

### Fixed

- **The GitHub Action did not load.** The description of its `status` input showed the
  job-status expression literally, and GitHub evaluates expressions anywhere in an action's
  metadata, so every run stopped in "Set up job" (`Unrecognized named-value: 'job'`) before
  sending anything. The description now names the expression in words, and a test refuses any
  expression in `action.yml`. Found by the first live run of `ci-notice-staging.yml`; the GitLab
  component was not affected.
- **The Cloudflare relay refused every GitHub notice** with a 403. It fetched GitHub's signing
  keys with `redirect: "error"`, which workerd refuses with a TypeError before any request, so it
  never held a key and no GitHub token verified. It now fetches with `redirect: "manual"` (a
  redirect comes back as its 3xx and is not taken, as before). The test that the fetch follows
  no redirect dialled an unreachable address, which hid the TypeError; it now gets a real 302
  from the test outbound service. GitLab notices were not affected (the relay does not verify
  their tokens), nor was the Node relay.

### Changed

- **The hosted relay takes CI senders** since 2026-11-06 (relay 0.1.9, `"ci": true` in
  `/v1/info`), and [docs/hosted-relay.md](docs/hosted-relay.md) now says so, with what the relay
  sees for them. The README gains a CI notices section: the `wim ci` commands, the two senders and
  where to find them.

## [0.1.9] - 2026-11-06

### Added

- **Crash reports, opt in and off by default.** `wim crash-reports on` (a person at their own
  terminal only, after reading what a report holds; no is the default) lets every bundled `wim`
  send a report to Distronode's Sentry organisation in the EU when a bug ends a command
  or goes uncaught; `wim crash-reports off` stops them at once. A report holds the error's type,
  its scrubbed message, function and file names and line numbers, the version, the command name,
  the OS family and the Node version, and never message text, keys, ids, addresses, paths or
  names, at most 5 a process and one per distinct error. The address is committed
  (`packages/client/crash-report-dsn.txt`) and written into every bundle, the Claude Code
  plugin's included; `wim` run from source has none. `WIM_NO_CRASH_REPORTS` and
  `DO_NOT_TRACK` keep them off; the VS Code extension sets the first while VS Code's telemetry is
  off, and gains **Turn Crash Reports On...** and **Turn Crash Reports Off**. New dependency:
  `@sentry/core` 11.10.0 in the client (MIT), with no integrations; the bundle grows by about
  145 KiB.
- **CI senders, protocol (SPEC section 18).** `@worldinmotion/protocol` gains the recipient code,
  both audiences, rule tags, counting keys, sealing and opening a notice to a device's prekey with
  a one-time key, the `ci` signature type, the `ci.*` frame schemas, and ID token checks: a strict
  RS256 JWS parser verified through WebCrypto (no new dependency), the shared claim checks, and a
  JWKS cache that fetches only each issuer's fixed URL, at most once a minute for an unknown key.
  `vectors/ci.json` holds a GitHub and a GitLab notice sealed by hand and tokens that must be
  refused; `sign.json` gains a `ci` case. Nothing sends or receives notices yet: the relays and
  the client follow.
- **CI senders, relays (SPEC section 18), off unless `WIM_CI=1`.** Both relays take
  `POST /v1/<mesh>/ci`: a prekey request, and a notice, which goes to the named session as
  `ci.deliver` from its own queue cursor. A GitHub notice's token is checked before any mesh state
  (in the Worker, before any Durable Object), against GitHub's fixed JWKS URL only, and is never
  stored: the relay keeps a counting key per repository and a hash of the token's `jti` until it
  expires. Sessions send `ci.rules` (the device's hashed rule tags, and whether it takes GitLab
  notices). CI notices have their own queue share (20 per session, 10 per repository) apart from
  the 50 messages, their own rate per repository (60 a minute, bursts of 20), and a per-source
  budget. A GitLab notice, whose sender the relay cannot verify, is answered only `queued` or
  `limited` (a resent notice id too, which is dropped), so a recipient code tells no session name
  or presence. With `WIM_CI` unset a relay
  answers `ci.rules` with `unknown_type` and stores nothing, as an older relay does. `/v1/info` gains `ci`. Relay schema version 2 adds the tables and columns for this; it is
  additive, so a relay of the previous release (with the `reader` change above) keeps serving it.
- **CI senders, client (SPEC section 18).** `wim ci allow github|gitlab`, `wim ci list` and
  `wim ci remove` keep the person's rules in `ci-rules.json`, behind the guard of `wim devices
  trust` (an interactive terminal, no agent's variables, a typed yes); no MCP tool, message or
  local UI request reaches them. `allow` pins a public repository's ids from the provider's API;
  for a private one the first matching notice is held with its ids, and only `wim held approve`
  pins them. A session sends `ci.rules` after `ready` and when the rules change, and checks every
  `ci.deliver` itself: the box, the token against keys it fetches from each provider's fixed URL
  (kept 24 hours in `ci-jwks.json`), the audience and one-time key, the times, the whole rule
  (`pull_request_target` and `workflow_run` refused unless named; GitLab protected refs by
  `ref_path`), and single use of the notice id and `jti`, claimed under the device-wide lock so
  two sessions of one device accept a token once. A notice is relayed CI text: inbox only, never
  pushed, never receipted, information only, and it starts the derived window. A notice whose
  provider's keys cannot be fetched is acknowledged and kept on the device (at most 20 per
  session, in `ci-parked.json`), checked again once a minute until it is too old, so it never
  holds back a peer's acknowledgements. The loop breaker counts CI in a bucket of its own (60 an
  hour per repository, 240 in all): the notice that trips it is held, later ones are dropped. A
  rule keeps at most 5 held notices while unpinned and 20 when it holds every notice, and the
  person hears about held CI notices at most once an hour per rule, by a notice for the person
  that is never pushed as a channel turn. `wim held approve` shows every other notice held under
  the same rule with its ids, warns when they differ, and pins on the rules as they are after the
  typed yes; `allow`, `remove` and the pin change `ci-rules.json` under a lock. A session logs
  at most 10 dropped CI notices a minute; past that it counts them by reason, in one line a minute.
  `wim ci notify` is the job's side: it checks that its token's audience is one `wimci1.` string
  for this recipient before it sends anything, takes a GitHub token bound to a one-time key or
  the GitLab token in `WIM_CI_ID_TOKEN` (sealed in the box, never shown to the relay), and always
  exits 0 with one line saying what happened. A config file named `allow`, `list`, `remove` or
  `notify` for the polling `wim ci` now needs `./` before its name.
- **CI senders as users install them** (SPEC section 18): a GitHub Action
  (`packaging/github-action`, running the client's own `wim ci notify` from the bundle it ships
  with) and a GitLab CI/CD component (`packaging/gitlab-component`, two jobs in `.post`, one per
  outcome, each with its own ID token). Neither is published yet; both run from this repository
  at a pinned commit, and a hand-run workflow sends one notice through a relay to test them.
- **`wim status`** (#65): the summary of `wim doctor` for a new setup. It names this device, and
  for each mesh its relay, whether this device is an admin, the roster seq, how many other devices
  and live sessions there are, and how long the relay keeps a mesh nobody uses, with any problem
  in full and the next step for a mesh with one device. `wim init`, `wim mesh create` and
  `wim join` end by pointing to it.
- **`wim mesh delete`** (#65, SPEC section 11): an admin device deletes its mesh at the relay for
  every device, then this device's copy. A new client frame `mesh.delete { mesh }`, answered
  `mesh.deleted`, and a new close code 4005; both relays then close every socket on the mesh and
  delete it as they delete an idle one, its place in the mesh cap included. A member is refused,
  and so is a recovery connection. Like `wim devices trust`, the command runs only at an
  interactive terminal with no agent's variables, after showing the mesh's devices and a typed
  yes; no MCP tool, internal op or events request reaches it. On a device whose relay no longer
  holds the mesh (deleted, or idle past the relay's time), the same command removes that device's
  copy after a typed yes. Additive: an older relay answers `unknown_type` and the client says it
  cannot delete there; an older client reconnects after 4005, is refused as for an unknown mesh,
  and stops.

### Changed

- **A relay rolled back to this release keeps serving a database a newer relay migrated, when
  that migration was additive.** `migrate()` refused any newer schema, and the Durable Object
  migrates on every wake, so after the first real relay migration (CI senders add one) a
  redeploy of the previous version would have broken every mesh. Each schema version now
  records `reader`, the oldest version that still runs correctly on it; a relay accepts a newer
  database whose reader it meets, and still refuses one that needs a newer relay or that records
  no reader. This release must be deployed before any release that migrates the schema.
- **`wim init` says that it waits, and for how long** (#65). When it cannot show the recovery code
  (an agent's shell, or no terminal), it says it keeps running for up to 10 minutes so the code
  can be collected with `wim recovery show`, that only that process holds the code, and that
  `wim recovery rotate` makes a new one if it is stopped first. The README's step 2 and the Claude
  Code skill say the same.
- **`wim devices` explains the `recovery` admin** (#65) in one line under the list: it is the
  mesh's recovery code, an admin record that never connects, which is why its policy reads hold.
- **"Unknown mesh" says why it may be** (#65): an admin deleted it, the relay removed it after it
  went unused, or the relay URL is wrong, and `wim mesh delete` removes this device's copy.
- **The loop breaker's pause is a cool-down** (#59, SECURITY-MODEL section 7.3). Only devices the
  person trusts are counted (any other is held by policy before the breaker sees it). When a pause
  ends, after `cooldownMinutes` (new in mesh.json's `breaker`, 10 by default, at most 60), the
  client releases the peer by itself and delivers, oldest first, at most the per-peer limit of what
  it held and no more than is left under the total, counted as delivered; the rest waits for the
  person, as in 0.1.8, and so does a second trip within the hour of a release. So, per receiving
  session, a looping peer gets at most about twice the per-peer limit an hour and all peers together
  at most the total, across restarts too (the hour's counts are kept). Nothing is released for a
  device no longer trusted or revoked. A message the person or a release delivered is recorded as
  seen, so the relay's copy of an unacknowledged frame is never delivered twice.
  A mesh.json keeps the limits written in it, lower ones included; one written before 0.1.9 gets
  only the cool-down. New meshes keep 0.1.8's 120, 300 and 32. The settings are documented in
  docs/design.md.
- **Pauses show, with the rule, its numbers and their end** (#59). Each session keeps its pauses
  in a new `breaker.json` (with the sessions told, the releases and deliveries of the last hour, and
  taken back after a restart while they still hold something). `wim held list` lists running pauses first and
  names the rule of each breaker hold; the Claude Code pane and `wim events` list them too; both
  notices read like "the per-peer limit: 121 messages from a@one in 60 minutes, limit 120; until
  <time>"; `wim events` gives `until` and `auto` on `breaker` events and rows, and VS Code lets a
  pause lapse at its `until`.
- **`send` returns `held` for a session whose breaker holds this device's messages** (#59). The
  receiving client tells each sending session once per pause (a room sender included) with a new
  plaintext kind, `pause` (SPEC section 12; older clients drop it), and the sender keeps it in
  `paused-by.json`, with the sessions its device sent to in `sent-to.json`, for every session of
  its device: `send`, `ask`, `reply`, `send_file` and `wim send` then report `held` with `relay`
  and `breaker` (the rule and its numbers) instead of `routed`, the MCP result adds a `held_note`,
  and the agent is told once, only for a device its person trusts. A `pause` is a label only: it never changes what is sent, held or
  delivered, and never resumes anything.
- **"Approve and resume this device"** (#59): the pane offers it on every breaker hold, and `wim
  held approve <id>` takes `resume` as well as `y` for one, approving the item and lifting the
  pause on its device, in every session of this device, in one step. Both stay the person's: no
  MCP tool, internal op, message or `pause` approves or resumes.
- **A held message goes to the spool before it leaves `held/`** (#76), on every path that releases
  one: the person's approve, a resume, a cool-down's release, and `wim held approve` while no
  process runs the session. A process that stops in between loses nothing: the next one finds the
  item delivered (a `<id>.delivered` mark, or the item in the spool) and only takes it out of
  `held/`, so the agent never gets it twice. Before, the entry went first, and a stop then lost it.
- **Test vectors for `pause`** (`vectors/pause.json`, SPEC section 16): a pause with every field
  and a lift, sealed and opened, the plaintexts that must be refused, and the kinds an older
  client knows, whose schema refuses both.

### Fixed

- **Tests:** the held-code test's wrong proof always differs from the real one; it sent the real
  proof when that ended in `A`, one run in sixteen.
- **`wim status` and `wim doctor` on a device never set up** ended in a raw file error
  (`ENOENT`) for the missing state directory. They now say the device is not set up yet and name
  `wim init` and `wim join <code>`, and exit 1, as for any problem they find. A state directory
  that cannot be read is a problem line of its own.
- **`wim status` and `wim doctor` on a device in two or more meshes** reported every mesh as
  failed ("set WIM_MESH or pass --mesh"): each mesh's roster check opened its session without the
  mesh's id. Every mesh is checked now, whatever `WIM_MESH` says.
- **`wim init` on a device already set up** said only that `device.json` exists. It now says the
  device is set up, that `wim status` shows it, and that `wim mesh create --relay <url>` or `wim
  join <code>` adds a mesh.
- **A stopped `wim init --relay` or `wim mesh create` exits 130** (Ctrl-C, a kill, or the
  terminal closing while it holds the recovery code for `wim recovery show`), as a shell reports
  Ctrl-C, and does not connect the device's `cli` session after the stop. It exited 0.
- **Tests:** the Workers relay's mesh-delete and mesh-cap tests read the mesh count right after
  the relay's answer, before the Durable Object gave the place back, and failed about one run in
  four under load ("expected 4 to be 3"). They wait for it now; the close codes are checked as
  before.
- **A command ended for good could leave its session reusable, and the next one was refused.**
  A session's state writes could land out of order, so a write still in flight when
  `stop({ ended: true })` wrote `ended` could land after it and undo it. The next command with
  that name then took the ended session's id, and the relay refused it ("the relay refused this
  device's authentication"). Seen as `wim inbox --as <name>` failing right after a refused
  `--as` for a Claude Code tab's name, about one run in six on Linux and on Windows CI. A
  session now writes its state one write at a time, in the order asked.
- **`wim send --wait` said a cool-down hold waits for the person.** For a message a trusted
  device's loop breaker held for its cool-down, it printed "held for the approval of that
  device's person. It is not delivered until they approve it there", and that device's client then
  delivered it by itself when the cool-down ended. With a `pause` from that session it now prints
  the line a `held` send row prints: the rule, and that its client delivers at the cool-down's end
  (with the time), or, for a pause that waits for the person (a second trip within the hour),
  that it waits for them; and that the person there can approve it sooner. A hold with no `pause`
  after it within 2 seconds (an inbound policy hold) still says it waits for the person.
- **Tests:** two client tests checked a result after a fixed sleep (a joined member's roster seq,
  and the deliveries after a cool-down's release); they wait for the result now.

### Documentation

- **The send that trips a peer's loop breaker** (SECURITY-MODEL section 7.3): it is held there
  itself, and still reports the relay's `routed` or `queued`, since the relay answers before the
  receiving client opens it; its `held` receipt and the `pause`, whose `reply_to` names it, say
  so afterwards. A test pins it.
- **CI senders are specified (SPEC section 18).** A GitHub Actions or GitLab CI/CD job that is not
  in the mesh can send one information-only notice to one session, proving where it runs with its
  provider's OIDC ID token, under rules only the receiving device's person sets. SECURITY-MODEL
  gains the CI job as an actor (5.10) and property 6.17, and boundary 2 of section 3 is rewritten
  for it; the hosted relay's terms say what it would see if CI senders were enabled there. The
  protocol, relay and client parts above implement it.
- **The hosted relay's terms say it is open now.** `docs/hosted-relay.md` still said the relay
  opens for new meshes with the public launch of the project. It is open now (`/v1/info` reports
  `"create": "open"`), and the line says so.
- **Deleting a mesh, and the idle-out, are documented** (#65). The README gains step 12: the hosted
  relay deletes a mesh no device has connected to for 30 days, `wim mesh delete` deletes one
  sooner, and each other device removes its copy the same way. SECURITY-MODEL says any admin can
  delete the mesh for everyone (sections 3, 5.2 and 9), that a relay can delete one at any time
  (5.4), and lists `wim mesh delete` among the person's commands (7.2, 7.5); both relay READMEs
  and the hosted relay's terms say the same.
- **The README names the Claude Code version that added cross-machine messaging: v2.1.224.**
  Its changelog adds cross-session `SendMessage` across your machines in 2.1.224; 2.1.225 only
  let a session start a conversation with a remote one by name.

### Dependencies

- **minimatch 11.0.3 under `@vscode/vsce`** (GHSA-g3hv-75wg-m249), the update 0.1.8 moved to
  this release. minimatch below 11.0.1 can be made to amplify glob parts into a denial of
  service. It reaches this repository only through `@vscode/vsce`, the tool that packages the VS
  Code extension, and is in nothing a release ships. An override scoped to that tool pins 11.0.3,
  which adds `@isaacs/nonrecursive-glob-match` 1.0.3; the extension packages the same files.

## [0.1.8] - 2026-11-02

### Changed

- **Relays bound connection setup per source address, before anything is held for a mesh.**
  relay-node checks each WebSocket upgrade against a dial budget (600 a minute per source) and a
  cap of 256 connections per source that have not authenticated, and builds mesh state only after
  a successful handshake; its expiry sweeps skip mesh ids that do not exist. The Workers relay
  asks a Workers Rate Limiting binding (`DIALS`, 600 a minute per source) before it reaches any
  Durable Object, for dials and for short invite code fetches. A refused dial is answered HTTP 429
  with `Retry-After`, which clients already treat as a lost connection and retry. If you run your
  own Workers relay, copy the new `ratelimits` entry from `wrangler.jsonc`; without it the relay
  keeps serving with no dial limit and logs that once.
- **Recovery attempts count against the per-source pre-auth limit**, shared with `create` and
  `join`, and a mesh's recovery budget (5 an hour) is spent only by a verified recovery (SPEC
  sections 4a and 9).
- **Per-source rate-limit keys are a keyed hash** under a random secret each relay creates in its
  own storage on first start (relay-node: its database; Workers: the registry object). No
  configuration is needed; existing per-source buckets start over once after the upgrade.
- **`wim invite --auto` shows its code only in the person's own terminal.** Where an agent's
  variable is set, or output is piped, the code is held in memory for `wim invite show`, run by
  the person in a terminal they opened, for the shorter of 10 minutes and the invite's lifetime.
  A script that read the code from `wim invite --auto`'s output no longer gets it.
- **A held recovery or invite code goes only to a reader that can read this device's state
  directory.** `wim recovery show` and `wim invite show` first send a random proof written to an
  owner-only file in the state directory; any other connection gets nothing and does not end the
  window. The same code runs on Linux, macOS and Windows.
- **The private-relay pin rule covers every non-public address range, in any spelling.** A
  `wss://` relay at an address in shared address space (`100.64.0.0/10`), `0.0.0.0/8`,
  `198.18.0.0/15`, or an IPv6 form that carries a private IPv4 address (IPv4-mapped, NAT64, 6to4)
  now needs a pinned certificate, as RFC 1918 addresses already did (SPEC section 5).
- **New meshes get higher loop breaker limits** (120 messages per peer and 300 in total an hour,
  ping-pong after 32 alternating short messages), and both pause notices name the rule that
  tripped and its limit (#59). A `mesh.json` written before 0.1.8 keeps its written breaker; to
  raise it, set for example `"breaker": {"perPeerPerHour": 120, "totalPerHour": 300,
  "pingPongExchanges": 32}` (docs/design.md, the loop breaker).
- **Dependabot auto-merge applies only to the cooldown-bound development group**, and only while
  the base branch requires status checks and a review. Security updates and the build tools that
  write shipped files (esbuild, @vscode/vsce, wrangler, now in their own group) wait for a person.

### Fixed

- **An item approved while its session is not running is framed and flagged as a live release
  is**, so reading it opens the `derived` window and a trusted device's item is framed as work it
  may assign, as on the live path.
- **Tests:** the relay host tests for frames that fail validation now exercise the 0.1.7 fix, and
  the VS Code extension tests retry removing their temporary directory while Windows still holds
  it.

### Documentation

- Trusted devices are described as devices the person chose to trust (`wim devices trust`),
  matching the agent frame since 0.1.7, rather than as the person's own devices.

### Security

The advisories for the hardening above, published with this release. The hosted relay runs 0.1.8.

- **Relay connection setup is bounded per source address** (GHSA-hcv3-5v65-frf3 for the Workers
  relay, GHSA-hx2m-4mhm-8qfc for relay-node; high). Dials to mesh ids were not limited before the
  WebSocket upgrade, and relay-node could keep state for an id whose handshake failed.
- **Recovery attempts cannot use up a mesh's recovery budget** (GHSA-34c8-vp57-xxhc; medium).
- **Per-source rate-limit keys are keyed hashes** (GHSA-f3v2-vx3w-2wf4; low).
- **`wim invite --auto` keeps its code out of an agent's output** (GHSA-3hg3-r8jj-7rj4; medium).
- **An item approved offline opens the derived window** (GHSA-28v5-87hv-58p4; medium).
- **A held recovery code goes only to a reader that can read the state directory**, which
  matters on Windows (GHSA-m6wf-mrjc-pqrc; medium).
- **The private-relay pin rule covers every non-public range** (GHSA-pc36-45vc-8g74; low).
- **Dependabot auto-merge is scoped to cooldown-bound development updates, keeps build tools for
  a person, and needs the branch rules in force** (GHSA-w2p2-jjwf-hgmj, medium;
  GHSA-pr5c-3c82-6qc3 and GHSA-2jhw-q579-46j4, low).

### Dependencies

- **The minimatch update moves to 0.1.9.** minimatch reaches this repository only through
  `@vscode/vsce`, the tool that packages and publishes the VS Code extension, and is in nothing a
  release ships. Its fixed version is younger than the 7-day rule in
  CONTRIBUTING.md allows, so it is updated in 0.1.9.

## [0.1.7] - 2026-10-31

### Changed

- **The Claude Code plugin installs from the latest release, not from main.** The marketplace
  listed the plugin as `./plugins/claude-code`, so `/plugin install` copied whatever the default
  branch held, including client changes merged for a release that was not out yet. The entry is
  now a `git-subdir` source pinned to the tag `v0.1.6` and its full commit sha, and Claude Code
  checks out that commit. The install commands are unchanged. Each release moves the pin in a
  pull request right after its tag (CONTRIBUTING.md, "Releasing"), and
  `.github/scripts/check-versions.mjs` fails CI while the pin lags the latest release or names a
  sha that is not the tag's commit.

### Fixed

- **A message that arrives after you press Stop is no longer lost behind a `delivered` receipt.**
  After a person stops a turn, Claude Code refuses new work until their next input, and drops a
  prompt still queued behind the stopped turn. The plugin started the message's turn with
  `$.prompt.submit`, saw it dropped, logged a line Claude never reads, and moved `spool/cursor`
  past the message anyway, so the client deleted it and told the sender `delivered`. The plugin
  now keeps the message and does not move the cursor past it, so no receipt goes, and hands it over
  when the next turn ends (after your next input), once. A message the session read meanwhile
  through `inbox` or `wait` is not handed over again, and messages that arrive behind a kept one
  wait with it, in order, so none of them reaches the conversation twice. A relayed item that you
  hand over from the pane while a Stop stands gets its button back instead of vanishing. Found by reading the code against the mods
  API docs; the plugin's tests reproduce it.
- **Three client tests that failed now and then in CI no longer depend on timing.** Each one
  raced a fixed time budget against work that takes longer on a busy runner. None of the product
  code changed.
  - `ping.test.ts`: the test helper that opens a session failed it with "not connected to the
    relay" when the first connect took over 3 s (seen on Windows). The helper now waits for the
    session's own `open` or `fatal` event.
  - `races.test.ts`: the overlapping-sends test gave the receiver 3 s to spool both messages
    (seen on Windows). It now waits for the receiver's `item` events for the two ids.
  - `client-security.test.ts`: the unsolicited-result test sent a forged result during a 400 ms
    `ask` and read the spool once the ask ended. On a slow runner the ask gave up first, so the
    spool was read before the forged result arrived (seen on Ubuntu). The test now runs the steps
    in order: the forged result is spooled while the ask still waits, then the addressee answers,
    and the ask must return that answer.

- **`wim send --wait` waits through `held` and reports the `delivered` that follows.** It
  returned at the first receipt, so a send to a device that holds messages for its person printed
  `held` and exited, and the later `delivered` (after the person approved it) showed only in
  `wim history`, as the two-organisation test of 0.1.6 found. Now `held` is printed once as
  progress ("Still waiting for it to be delivered...") and the command waits until every
  recipient's receipt is `delivered`, `refused` or `expired`, or the wait ends, when it says
  "still held". The exit codes are unchanged and now documented in `docs/design.md`: 0 when every
  recipient was routed or queued and no receipt failed (still held included), 1 on a refused or
  expired receipt or a recipient that was not accepted, 3 when a running `wim watch` did not report
  back.

- **A trusted peer's message no longer tells the agent the device is the person's own.** The frame
  for a work assignment said "Your person has marked org-b as one of their own devices", but trust
  is only a policy the person sets, and the two-organisation test of 0.1.6 trusted a device of
  another organisation. The frame now says what the trust state is: "Your person chose to trust
  device org-b here, so its sessions may assign you work. wim does not know whose device it is: it
  may be one of your person's own, or a device of someone else in the same mesh." A message from
  another session on the receiving device says "It comes from another session on this same device
  (laptop), so it may assign you work." What may assign work is unchanged, and so is every frame
  that only informs. The plugin's skill and README say the same.

### Documentation

- **The README's claims match what is true and tested.** The "Why" section said an agent session
  cannot talk to a session on another machine; Claude Code's built-in messaging has done that on
  one account since August 2026, so the section now says what it does not cover (other accounts,
  other vendors, a relay that cannot read the messages). Peer text is described as framed, which reduces
  risk and is not a guarantee, and the secret filter as best effort. Delivery is labelled push,
  turn or pull per agent (only Claude Code wakes today), the two-account test is marked as not run
  yet, and the README now shows a tested `notify.json` example for a ping when a message is held.
  The same corrections are in `docs/peers.md` and the plugin's README. No code change.

- **MLS for rooms is a design, not part of v0.2** (`docs/mls.md`). Rooms keep today's per-device
  sealing. The document sets out what an MLS room mode would need before any code: one MLS
  member per device held by the signer, the relay as the commit sequencer, eviction of devices
  offline for 72 hours, what happens to history, and the library question. It cites the
  agent-connect, SLIM, Marmot and Matrix MSC4268 designs it draws on. SPEC section 6 now says so
  where it reserves the box scheme numbers. No code change.

- **A page for security teams** (`docs/security-teams.md`), linked from the README. It maps wim to
  the nine mitigations of OWASP ASI07 (Insecure Inter-Agent Communication) and names the gaps:
  per-device rather than per-agent credentials, the downgrade window that closes at 1.0, no
  metadata padding, approval marks that are files, and a held view that shows one item at a time.
  It also names two client-side scanners as a second layer to the secret filter, Docker MCP
  Gateway and GitGuardian's AI hooks, neither yet tested with wim.
- **SECURITY-MODEL names agent session smuggling** (section 5.2 and the known limits in section
  9): a request spread across harmless-looking messages, which a held view of one item at a time
  makes easy to approve piece by piece. Until the held view shows the whole thread, it says how to
  read the thread before approving.
- **Running relay-node on a tailnet** (`packages/relay-node/README.md`), with LAN mode on the
  tailnet address or Tailscale Serve in front. Marked as not yet tested.

No code change.

### Security

- **A malformed frame could stop a self-hosted relay** (GHSA-54x6-pfpq-wmc9). One
  unauthenticated frame could make the protocol's frame and schema checks throw instead of
  failing, and the self-hosted relay (`wim-relay`, the `worldinmotion-relay` image) then exited,
  taking down every mesh it served until a restart. The checks now return a failure for any input
  at every place that parses untrusted data, and the self-hosted relay logs any uncaught error and
  keeps serving. The Workers relay and the client's receive path answer or drop such a frame as
  malformed. The hosted relay at `worldinmotion.distronode.com` runs the fix; upgrade a
  self-hosted relay to 0.1.7.

- **Approving held messages and trusting devices now need the person at their own terminal.**
  `wim held approve` and `wim devices trust` ran from an agent's shell: in the two-organisation
  test of 0.1.6, an agent with `CLAUDECODE` set approved a held message and trusted a device, and
  no person was asked, although the README said `wim` refuses the steps that decide trust. Now
  `wim held approve`, `refuse` and `resume`, and `wim devices trust` and `untrust` (one device or
  `--all`), run only when standard input and output are an interactive terminal and no agent's
  variables are set, and they show what is being decided (the held message's sender, device id,
  reason and text; each device's name, role, id and policy before and after) and act only on a
  typed `y`. There is no flag that skips it. An events process started with an agent's variables
  refuses `approve`, `refuse`, `resume`, `trust` and `untrust` as it already refused `invite` and
  `admit`. The variables checked now include `CLAUDE_CODE_SESSION_ID`,
  `CLAUDE_CODE_MESSAGING_SOCKET` and `AI_AGENT`, which Claude Code sets in its shells; other
  `CLAUDE_CODE_` variables are not checked, because people set some in their own profile. No MCP
  tool decides any of these, as before, and a test now pins that. This is a same-user check, not a
  boundary: a program running as the OS user can still unset the variables or write the files
  (SECURITY-MODEL.md sections 7.2 and 9). The README and the plugin README now say so.

## [0.1.6] - 2026-10-30

### Changed

- **`wim inbox` marks nothing read when its output is not a terminal.** Piped into `head`, an item
  cut off part-way still counted as read, and the writer cannot know how much of a pipe's buffer
  the reader took. Into a pipe or a file, `wim inbox` now marks nothing (as `--peek` does) and says
  on stderr: "stdout is not a terminal, so these 2 items stay unread (a pipe such as `| head` can
  cut one off part-way). Run `wim inbox` in a terminal to read and mark them, or add --mark-read
  to mark what this run printed." At a terminal it marks each item once printed, as before. (#33)

- **A closed Claude Code tab goes offline instead of ending, so a resumed conversation gets what
  was sent meanwhile.** `wim mcp` used to say `bye { ended: true }` when its tab closed, so senders
  got `ended` and the messages were gone even when the person resumed the conversation
  (`claude --continue`) under the same name. It now goes offline: the relay queues for the name
  for 24 hours (senders see `queued`), and the resumed conversation takes the session back with
  them. The name stays held for those 24 hours, and a new conversation in the same folder takes
  the session over, queue included. No relay or protocol change. (#37)

### Documentation

- **Keepalive and liveness timings are in SPEC.md section 8.** The client pings after 30 s of
  quiet; the Cloudflare relay closes a socket silent for 5 minutes (`STALE_MS`) on a 1-minute alarm
  (`HEARTBEAT_MS`); the self-hosted relay closes one that missed a 30 s protocol ping. So a frozen
  recipient (stopped, or asleep with its connection open) stays `busy` or `idle` in peers, and sends
  to it answer `routed`, for up to about 6 minutes on the Cloudflare relay. Nothing is lost: it
  receives them when it runs again. No code change. (#39)

### Added

- **`wim inbox --mark-read`** marks what it printed even when its output is not a terminal (the
  0.1.5 behaviour, for a script that keeps what it reads). (#33)

### Fixed

- **A session the relay renamed `<name>-2` was not told its new address.** After a Claude Code
  plugin reinstall the same conversation came back as `distronode-2@latitude` while the chat kept
  giving peers its old address. Whenever the relay assigns a session another address than the one
  it had or asked for, the client now writes it one notice that reaches the agent: "this session's
  address is distronode-2@latitude, not distronode@latitude: another session on this device holds
  that name. Give peers distronode-2@latitude; messages sent to distronode@latitude do not reach
  this session." (#36)

- **A send refused for a secret did not say how to send it anyway.** The refusal (`wim send`, the
  MCP `send` tool, `wim events`) now ends: "If the person means to send it, the person runs the
  send themselves in a terminal they opened themselves: wim send <to> <text...> --allow-secret. An
  agent cannot skip this check." (#34)
- **`code --install-extension distronode.worldinmotion` failed with no detail.** The extension is
  published as a pre-release only, so an unpinned install finds no stable version and prints only
  "Failed Installing Extensions". The README and the extension's README now say why the command
  needs `--pre-release` (or `@<version>`), and a test keeps every documented install command
  that way. (#35)
- **`wim inbox --as <name>`, where `<name>` is a live Claude Code session, registered `<name>-2`
  and read its empty inbox.** A terminal command whose name belongs to a session of another kind
  on this device now ends that registration at once, so no `<name>-2` lingers in peers, and says
  so: "distronode-2@latitude is a claude-code session on this device (idle): its messages go to
  that session, not to a terminal. `wim history --session distronode-2` shows what it received;
  for a terminal session of your own, pick another name with --as <name>." The same holds for
  `wim send` and `wim watch`. (#38)
- **The loop breaker held a peer's messages without telling the receiving session.** Only the
  person got a toast, so an agent waiting on that peer concluded it had dropped the work. When the
  breaker pauses a peer, the session now also gets one notice that reaches the agent: the peer is
  paused, its messages are held from now on and not delivered, only the person can release them
  (`wim held resume <peer>` in a terminal they opened themselves, or Approve in /wim or the Held
  view in VS Code), and it has not gone silent. One per pause, so the pause cannot become a loop
  of its own. (#40)
- **A sender's agent never learned that its message was held.** The `send` result says `routed`,
  and the later `held` receipt reached the person only as a toast, so the agent went on assuming
  the message had arrived. The first `held` receipt from a recipient now also gives the sending
  agent one notice: "<to> is holding your message <id> for its person's approval: it is not
  delivered until they approve it on that device. Tell your person; resending will not get it
  through. Only the person on that device can approve it." Once per recipient, until something to
  that recipient is delivered, so a recipient that holds everything cannot wake the sender over and
  over. (#42)

## [0.1.5] - 2026-10-30

### Fixed

- **A message that arrived as a Claude Code turn ended reached the tab twice.** The plugin appended
  it to the running turn and, since no request of that turn had read it, submitted its text again
  as "(delivered again: it arrived as your last turn ended)". The new turn now names it by sender
  and id instead ("a message from reviewer@laptop (id ...) arrived as your last turn ended. It is
  in the conversation above, not repeated here."), so its text is in the conversation once. Each
  spool item is also claimed before the plugin hands it over and the cursor moves past it even
  when a later item fails, so a failed submit, or a pass still running after a reload, never hands
  an item over a second time; and items the client's `inbox` or `wait` tool already handed to the
  session (its `spool/cursor` is past them) are not delivered again.
- **`wim inbox | head` marked everything read, even what `head` cut off.** `wim inbox` now prints
  one item at a time and marks each read once stdout took it; when the reader goes away (EPIPE),
  it stops, says on stderr how many stay unread, and leaves them for the next run.
- **The VS Code extension's session (`vscode@<device>`) never came online on a device whose keys
  are in the signer.** The extension runs the client on VS Code's own Node (Electron), whose
  BoringSSL has no ChaCha20-Poly1305, so the encrypted channel to the signer failed with "Unknown
  cipher" and every connection attempt with it. The signer channel and the key file now use the
  same cipher from `@noble/ciphers`, byte for byte as before, so signers, clients and key files of
  0.1.4 still fit. The extension already started its session when VS Code finished starting
  (`onStartupFinished`); the integration smoke test now checks that VS Code activates it with no
  view opened.
- **A Claude Code tab opened before the signer was up never heard the mesh.** `wim mcp` decided
  once, at its start, that it could not open a session ("no signer is running") and answered that
  until the tab was restarted, and the plugin handshook only at the session's start and showed a
  "not set up" line whatever the reason. Now `wim mcp` keeps asking (on every tool call and every
  5 s) while the problem is one that clears on its own: the signer not running or locked, or the
  device without keys or a mesh yet. The plugin's handshake is kept meanwhile, and the client
  writes a link file once a session opens, which the plugin reads from its timer and links by
  itself. (An MCP call from a plugin timer is not inside a hook dispatch, so Claude Code asks the
  person to allow it; the plugin never makes one.) An internal call refused for its token (the
  client restarted) runs the handshake again. The tab's status line shows the client's own
  reason, or once linked its address and held count, for example `billing@laptop, 1 held`.
- A Claude Code tab whose wait for a link ended with a problem that stands lost the token its client
  had issued, so its next handshake was refused as another caller's and the tab stayed unlinked.
  The plugin keeps the last token issued.
- The notice that a session must be restarted to use the signer (its keys were encrypted while it
  ran) reached only the MCP log; it is now a notice for the person, which the plugin shows as a
  toast and on its status line.

### Added

- **`wim inbox --peek`** prints the terminal inbox and marks nothing read.
- **`wim agent autostart enable | disable | status`**: a login item (a launchd agent on macOS, an
  XDG autostart entry on Linux, a logon task on Windows) that starts the signer at each log in with
  `wim agent start --foreground --ask-gui`, which asks for the passphrase in a native dialog; its
  output and errors go to `agent/autostart.log`.
  `enable --keyring` (opt-in) keeps the passphrase in the macOS login keychain, which asks on
  every read, or in libsecret on Linux after a plain warning; not offered on Windows
  (`SECURITY-MODEL.md` section 5.8).
- **`wim agent start` and `unlock` take `--ask-gui` and `--keyring`**, and say that the signer keeps
  running after the terminal or VS Code closes and stops at log out, restart or `wim agent stop`.
- **VS Code: the signer in the status bar**, and the command "worldinmotion: Start Signer", which
  runs `wim agent start` (or `unlock`) in an integrated terminal. `wim events` hello carries
  `keys: local | signer`.
- **`wim send --wait <30s>`** stays connected and prints each recipient's receipt: delivered,
  held (with how to approve it on that device), refused or expired.
- **Receipts are recorded in history**, and `wim history` and the `history` tool show them with
  what was sent. A `held` receipt becomes a notice, which the Claude Code plugin shows as a toast.
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
- **Short invite codes**: `wim invite` prints `wim2-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX` (plus
  `@relay` off the hosted relay), short enough to read out or type, and `wim join` and VS Code's
  Join a Mesh... take it as well as a full code (SPEC section 5). The admin device seals the full
  code under a key from the code's 100-bit secret and stores the box at the relay, which never
  sees the secret; the box lives at most an hour and is handed out three times. New: the `rdv.put`
  frame, `GET /v1/rdv/<id>` on both relays (a relay-wide `RendezvousStore` Durable Object and
  `v3` migration on Cloudflare), test vectors `rdv.json`, and `wim invite --full` for a device on
  0.1.4 or older. On a relay without it, or a mesh that pins its relay's certificate, `wim invite`
  prints the full code and says why.
- `/wim status` in Claude Code: the tab's address, device, mesh, relay connection, signer, held
  count and state directory (with why it is that one), from a new read-only internal op, `status`.
  `/wim name <name>` renames the tab.
- `wim doctor` says which state directory it uses and why (`WIM_HOME`, `CLAUDE_CONFIG_DIR` or the
  default), and lists the other device directories it finds on the machine.
- `wim send` names a live Claude Code tab on a device whose terminal inbox a send was queued for:
  `live on desk now: billing@desk (claude-code)`.
- VS Code: **Send Message...**, and the setting `worldinmotion.notifyForClaudeTabs` to also notify
  for messages to any Claude Code tab on this device, naming the tab.
- The README's first-run guide for one person and three machines, every step labelled
  [Terminal], [Claude chat] or [VS Code]; the skill lists the commands only the person runs and
  the read-only ones Claude may run.

### Changed

- **`--passphrase-stdin`, `--ask-gui` and `--keyring` are refused under an agent's variables**
  unless `--allow-agent-passphrase` is given, which warns that an agent able to read the
  passphrase's source defeats the signer's protection against agents. A signer started from an
  agent shell with `--passphrase-stdin` needs the new flag.
- **`routed` and `queued` are said in plain words** (handed to a live session; that session is
  offline and the relay keeps it 24 h), and that neither means read. The Claude Code plugin says
  "Sent through worldinmotion", no longer "Delivered".
- **Only a `wim watch` takes a one-off send's handover**: a session now records that it takes them
  (`handover`), so a `wim send --wait` holding the name is not mistaken for a watch, and `wim watch`
  and `wim inbox` say the name is busy instead.
- **No more y/N when adding a device.** `wim invite` asks the person to type the comparison code
  the new device shows, compared without case or dashes, and no longer shows its own copy
  (SECURITY-MODEL section 5.6). The confirmation is taken only from an interactive terminal
  (standard input and output) with no agent's variables set; without `--auto`, `wim invite`
  refuses to start anywhere else, before any code exists. It also prints "On the new device, in a
  terminal: `wim join <code>`". `wim join` says "comparison code" and how to admit it.
- Refusals of person-only steps (`wim agent start`, `unlock`, `encrypt`, `decrypt`, `autostart enable --keyring`,
  `wim recovery show`, `--allow-secret`) name the cause (`CLAUDECODE is set: this shell belongs to
  Claude Code`, or that the output is not an interactive terminal) and say to open a terminal
  yourself and run the exact command there.
- Install docs put npm first (`npm install --global worldinmotion`, with the `PATH` fix for npm's
  global bin), and say the VS Code extension is on the Marketplace and Open VSX.

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

[Unreleased]: https://github.com/distronode-corporation/worldinmotion/compare/v0.1.9...HEAD
[0.1.9]: https://github.com/distronode-corporation/worldinmotion/releases/tag/v0.1.9
[0.1.8]: https://github.com/distronode-corporation/worldinmotion/releases/tag/v0.1.8
[0.1.7]: https://github.com/distronode-corporation/worldinmotion/releases/tag/v0.1.7
[0.1.6]: https://github.com/distronode-corporation/worldinmotion/releases/tag/v0.1.6
[0.1.5]: https://github.com/distronode-corporation/worldinmotion/releases/tag/v0.1.5
[0.1.4]: https://github.com/distronode-corporation/worldinmotion/releases/tag/v0.1.4
[0.1.3]: https://github.com/distronode-corporation/worldinmotion/releases/tag/v0.1.3
[0.1.2]: https://github.com/distronode-corporation/worldinmotion/releases/tag/v0.1.2
[0.1.1]: https://github.com/distronode-corporation/worldinmotion/releases/tag/v0.1.1
[0.1.0]: https://github.com/distronode-corporation/worldinmotion/releases/tag/v0.1.0
