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

- **`wim ci` filters by state.** A GitLab or GitHub source takes `pipelineStates` and
  `deploymentStates`, lists of the provider's state names, and posts only lines in those states,
  so a room can hear about failures and approvals without every `running` and `success`. Without
  them a source posts every state, as before. A state the filter drops is still recorded as seen,
  so widening the filter later does not announce it. Downstream pipeline lines follow
  `pipelineStates`. An unknown state name or an empty list is refused at startup. The
  `packages/ci` README's State filters section has the names for each provider.
- **`wim held approve|refuse --from <session@device>`, `--from <device>` and `--all`** (#159). One
  command decides everything held from a session, a device, or everywhere. Every set it touches is
  shown whole, in order, with its count, before one typed `y`, and the decision covers exactly the
  ids shown (`--from` one session of a device shows that device's whole set and decides only that
  session's items). It is for the person at their own terminal, like the rest of `wim held`: piped
  input and an agent's variables (`CLAUDECODE` and the others) are refused, and with the signer
  each part is confirmed there too. Approving never covers a CI notice that pins its rule's ids.
- **Held feed lines expire by themselves** (#159). A held feed line is a relayed `msg` that answers
  nothing (a `wim ci` pipeline line, a bot's or a worker's room post), held by policy. It is dropped,
  never delivered, once it is older than 24 hours or once 20 newer held lines from the same session
  of the same device wait. `"heldFeeds": { "maxAgeHours": N, "keep": M }` in `mesh.json` changes
  either. A running session checks every minute; `wim held list` drops them in sessions no process
  runs. Tasks, results, files, replies, CI notices and the loop breaker's holds never expire this way.
- **`wim ci` says at start who would hold its lines** (#159). It lists the members of each room it
  posts to whose device would hold relayed text, and the exact command for each device: `wim
  devices trust <this device> --relayed` here, or the same on the other device.

### Changed

- **The VS Code extension needs VS Code 1.144 or newer.** `engines.vscode` is `^1.144.0` (was
  `^1.140.0`), and the extension builds against `@types/vscode` 1.144.0. VS Code 1.140 to 1.143
  keep the version they have installed and stop receiving updates; updating VS Code brings them
  back. The smoke test runs on VS Code 1.144.1, the new floor.

### Fixed

- **A trust change releases what the old policy held** (#159). After `wim devices trust <device>
  --relayed` (or plain `trust`), the lines already held from that device stayed held, and only new
  ones were delivered. Each session now looks again at what it holds whenever the policy in
  `mesh.json` changes (and when it starts): what the policy now delivers is delivered, as an
  automatic delivery within the loop breaker's hourly limits, and what a policy of `refuse` now
  refuses is dropped. A held file is released only while connected, at most four a review, since
  it is fetched as it is released, and an item held by a session that keeps no message text (`wim
  worker`) is left for the person. The trust prompt says how many held messages that releases.
- **This device's own relayed text can be delivered to its other sessions** (#159). A `wim ci`,
  `wim bot` or `wim a2a` session and a session on the same device could never deliver to each
  other: relayed text from this device was held, and nothing said `wim devices trust <this device>
  --relayed` delivers it. `wim devices list` now says `this device (relayed text held)` or
  `(relayed text delivered)`, the trust prompt for this device says what changes, a held item's
  view gives the command, and `untrust` of this device holds only its relayed text again, never
  its own sessions' messages.
- **A loop over `wim held refuse <id>` runs to the end** (#159). Each id opened its whole set's
  prompt, where a typed `y` was taken as no without a word, and after `all` the remaining ids failed
  as "no held message". A `y` at a set's prompt is now asked again, and refusing an id that is no
  longer held says so and succeeds. Input piped into `wim held` (`... | xargs wim held refuse`) is
  still refused: the person rule needs standard input and output to be a terminal.

## [0.2.1] - 2026-11-09

### Changed

- **Homebrew: `brew install distronode-corporation/tap/worldinmotion`.** The formula now lives in
  the tap, which installs, tests and bumps it, so the draft under `packaging/homebrew` is gone.
  The README's install step and `packaging/README.md` say how it is built and checked.

### Fixed

- **A session held from another PID namespace is no longer taken over** (#141). A session's lock
  judged its holder only by `kill(pid, 0)`, so a wim in another PID namespace (a Flatpak app with a
  host terminal, a container sharing the home folder, a sandboxed shell) took over the lock of a
  live `wim watch`, `wim mcp` or VS Code session. On Linux a lock's holder now records its PID
  namespace beside the lock (`<lock>.ns`), and a running session refreshes that record every 40
  seconds. A holder in another namespace counts as alive while its record is fresh (2 minutes, three
  refreshes): its lock is left alone, and `wim held approve` leaves that session the resume it asks
  for. Once the record goes stale the holder is judged by its pid here, so a lock left by a holder
  that died in another namespace is taken over about 2 minutes later, from any namespace. `wim
  doctor` names each session held from another namespace, how long ago its holder last refreshed
  it, and whether the next claim takes it over. The lock file itself is still the bare pid, so 0.2.0
  reads 0.2.1's locks as before (a 0.2.0 process still judges a holder by its pid alone). A
  session's stop removes its lock only while the lock still names it, and spool items are numbered
  past what another process wrote, never over it.
- **`$` in a privileged job's command line reaches the job as written on systemd before v254**
  (#139). `wim agent privileged` doubled every `$` for `systemd-run --scope`, which expands `$` only
  from v254. It now reads `systemd-run --version` and doubles `$` only there. No command the runner
  starts today holds a `$`.
- **`wim ci allow` refuses a ref git refuses, and one shown escaped** (#107, #108). A ref holding
  `:`, `..`, `~`, `^`, `@{` or `//`, a part starting with `.` or ending in `.lock`, or a full ref
  ending in `/` or `.`, could never match a token, so its rule did nothing; and the protection
  advice for a ref with a character the terminal shows escaped (`<U+...>`) named another ref. Both
  are refused when a rule is saved. Rules already saved are read as before, and nothing changes on
  the wire or at the relay.
- **`wim test` cleans up what a cut-short run made, and keeps to a time budget** (#109, #110, #111).
  `wim mesh create` prints the new mesh's id as soon as the relay has made it, so `wim test --relay`
  finds and deletes it even when the sign-in after it fails, or says it could not. The end of a run
  waits for a step that was stopped or timed out (a relay it was still starting) before it closes
  the relay and removes the sandbox. `wim test --budget <seconds>` sets a total time, after which
  the steps left are skipped and the run cleans up and reports; `/wim test` in Claude Code passes
  480 seconds, under the host's 10-minute limit.
- **A `held` send row no longer says "not delivered"**. A pause is a label, advisory and never
  proof (SPEC section 12): just after the person there resumes this device, the message may already
  be through. The line now says the message is likely held there, by that client's account.
- **References to 0.1.11, which was never released, say 0.2.0** (docs/security-teams.md,
  docs/events.md and the VS Code extension's protocol types).
- **Agent configs that `wim setup` writes under Homebrew survive `brew upgrade`.** It wrote node's
  and wim's paths in Homebrew's Cellar, whose versioned directories cleanup removes. It now writes
  their `<prefix>/opt/<formula>/` form, when that is the same file; any other install is unchanged.

### Security

- **The signer's keyring and login-item programs run by absolute path, never from `PATH`**, as
  0.2.0 did for the passphrase dialogs (GHSA-gcgc-vfj9-cm52). `wim signer autostart --keyring` runs
  `/usr/bin/security` on macOS and `/usr/bin/secret-tool` on Linux, and only when the program and
  its directory are owned by root and writable by no one else; otherwise it refuses the keyring and
  says why. On Windows the login item's `schtasks` and the `where` that `wim setup` uses run from
  `%SystemRoot%\System32`.

## [0.2.0] - 2026-11-08

This release is built around one promise: encrypted messages between AI agents from different
vendors and different accounts, with a trust model a security team can review. `npx worldinmotion
setup` takes a machine from nothing to a mesh, offers the Claude Code plugin and the VS Code
extension and configures every other agent it finds (Codex CLI, Gemini CLI, Antigravity CLI,
Cursor, Copilot CLI, Claude Desktop), and `wim setup <invite code>` adds the next machine. Your own
devices are trusted inside the approvals you already give, and nothing is passed on; held messages
are decided a set at a time; with the signer, an agent cannot approve one; a device can refuse v0.1
boxes now; and an address is taken over only on request, with each takeover listed by `wim status`.
Agents other than Claude Code look again at turn end (`wim hook`), the finished notice is
dependable on both sides, and `wim agent` runs one agent job when a device you allow messages it.
The signer is now `wim signer`. A device on 0.1.10 or older cannot read the new invite codes:
upgrade it before it joins.

### Added

#### First run

- **`wim setup`, a guided first run on one machine.** In a terminal of your own it creates the
  device and a mesh, offering the host name as the device name and the hosted relay as the relay,
  shows what the relay says it offers, and asks for a typed `y` before it creates anything. It
  shows the recovery code once and waits for Enter. When the `claude` or `code` command is
  installed, it offers the Claude Code plugin or the VS Code extension, showing the commands it
  runs (without a shell) and waiting for a `y`; it prints the state directory and why, and warns
  when `CLAUDE_CONFIG_DIR` is set. It ends with `wim status`, problems first. Run again on a device
  that is set up, it skips what is done. It refuses an agent's shell and piped input or output, as
  the other person-only commands do, never asks about crash reports and does not start the
  signer. `wim setup <invite code>` adds a machine to a mesh you already have: it joins as
  `wim join` does, the joining side's trust questions included, then offers the same steps.
  `wim init`, `wim join` and `wim invite --auto` are unchanged.
- **`npx worldinmotion setup` works from nothing.** Run from npx's cache (`npx` or `npm exec`),
  `wim setup` first says so, then offers, on a typed `y`, to install this exact version with
  `npm install --global worldinmotion@<version>`, run without a shell. When npm's global prefix is
  not writable it offers `~/.npm-global` instead (npm's prefix goes in its environment, not a
  shell word) and says how to put that prefix's `bin` on `PATH`; it never uses `sudo`. It then
  runs `wim setup` again from the installed copy, with the same flags and code, so every path it
  writes into an agent's config is the stable one. On `n` it prints the install command and
  stops before anything is made. The README's Quick start now starts with `npx worldinmotion
  setup`, with the global install as the alternative.
- **`wim setup` configures every agent it finds.** After the Claude Code and VS Code steps, it
  looks for Codex CLI, Gemini CLI, Antigravity CLI, Cursor, Copilot CLI and Claude Desktop (a
  command on `PATH`, or the agent's config directory) and, for each, adds the worldinmotion MCP
  server and the agent's `wim hook` entries: the turn end, and the turn start where the agent has
  one (Gemini CLI `BeforeAgent`, Codex `UserPromptSubmit`, Cursor `beforeSubmitPrompt`, Copilot CLI
  `userPromptSubmitted`; none for Antigravity, and Claude Desktop has no hooks). The server offers
  only `peers`, `inbox`, `wait` and `history` where the agent has a tool list (Gemini CLI
  `includeTools`, Antigravity `enabledTools`, Codex `enabled_tools`, Copilot CLI `tools`); Cursor
  and Claude Desktop have none and ask before each call. The launch is direct, node and the
  absolute path to `wim.mjs`, never npx, npm or a shell, so the hook's session match works. Each
  file change is shown as a diff and written only on a typed `y`, with the original copied beside
  it; only the worldinmotion entries are touched, JSON keeps its indentation and key order, and
  Codex's `config.toml` changes only the worldinmotion lines. A rerun reports an entry that is right
  as configured and offers a stale path as an update, keeping what you added to the entry. A file
  that is a symbolic link, larger than 1 MiB, or not valid JSON or TOML is left alone
  (docs/peers.md, "What `wim setup` writes").
- **`wim recovery show --wait`** waits for Enter after showing the code, so a terminal that closes
  when its command ends keeps the code on screen until the person has stored it.
- **VS Code: Create a Mesh and Join with a Code from the empty Mesh view.** On a device in no mesh
  yet the Mesh view shows a welcome text with both buttons (it reads the new `worldinmotion.state`
  context key: `setup`, `mesh` or `closed`), and VS Code alone needs no npm. **Create a Mesh...**
  asks for this device's name (when it has no keys yet), a relay (the hosted relay by default, or a
  URL), and a confirmation in a modal that names the relay, then creates the mesh through the
  extension's own client. The recovery code never appears in VS Code: **Show Recovery Code** opens a
  terminal running `wim recovery show --wait`, and the extension restarts its client in the new mesh
  once the code is collected or its 10 minutes end, saying so when it was not collected. **Join with
  a Code...** (formerly Join a Mesh...) asks which code you have; the invite code path is unchanged,
  and the pairing code path says it is not in this version yet. Underneath, `wim events` in setup
  mode takes a new person-only request, `create { name?, relay? }`, answered once the code waits for
  `wim recovery show`, then emits `created { mesh, recovery: "shown" | "not_collected" }` and ends
  ([docs/events.md](docs/events.md)).

#### Trust and approvals

- **Your own devices are trusted inside the approvals you already give.** `wim invite` asks "Is the
  new device one of yours? Its messages will then be trusted here when it joins. [y/N]" before it
  shows the code, and keeps the answer in the invite's record on that device, never in the code; an
  own-device invite sets `deliver` for the device it admits, and the question after the admit is
  gone. `wim invite --auto` never trusts. On the joining side, `wim join` and the new
  `wim setup <invite code>` ask about the device that admitted this one alone, then about each
  other device on its own, replacing the one question that covered every device. Every automatic
  trust prints its undo (`wim devices untrust <name>`). Nothing is transitive: a device another
  device added is never trusted because that device is. `wim status` lists those as "held here,
  added by laptop: build (wim devices trust build)", and the VS Code extension asks about each one
  as it joins ("laptop added build to this mesh. Is build your own device?", with **Trust...** and
  **Not Mine**, kept on that machine), with **Review Trust...** for all of them. **Add a Device...**
  asks whose device it is first, and after **Join with a Code...** the extension asks about the
  admitting device, then each other one, in modals. `wim events` takes `invite { own }`, answers
  `admit` with `trusted`, adds `added_by` to device rows (read only from the verified roster chain)
  and `admitted_by` to `joined` ([docs/events.md](docs/events.md), SPEC section 6a,
  SECURITY-MODEL section 7.2). An invite code now names the admin that made it (`by`, SPEC section
  5): the joining side asks about the device that admitted it as the approver only when that is
  the maker, and otherwise says so and asks about it like any other device. Devices on 0.1.10
  or older cannot read a 0.2.0 invite code and must upgrade to 0.2.0 before joining; `wim invite`
  and Add a Device... say so. Admitting on an own-device invite says first that it trusts the
  device (the comparison-code prompt, `wim devices pending`, the VS Code admit box).
- **Held messages are decided a set at a time.** `wim held`, the `approve` and `refuse` requests of
  `wim events`, the VS Code Held view and the Claude Code pane group what is held per sending device
  (by its authenticated device id) and per CI rule (by the rule's id, so `wim ci remove` never
  regroups), and show the whole set, in order, with its count and time span, before the person
  decides. A decision covers exactly the ids shown: an item that arrives after the set was drawn
  stays held. `wim held approve <id>` asks `all` or `one`; a set of one keeps the old prompt. `wim
  events` takes `set` on `approve` and `refuse`, checks it is one set before deciding, and its held
  rows carry `set`, `set_title`, `ci` and `pins`. The VS Code dialog is modal and lists the set,
  with "Approve only this one" when started from a row; its default button (Enter) is "Keep them
  held" and Escape cancels, so approving is always a deliberate click. A CI notice that pins its
  rule's ids is never in "approve all" (refusing the set covers it), and approving a breaker set
  keeps the pause on and says how to resume it. This closes the gap docs/security-teams.md named
  (the held view showed one item at a time).
- **With the signer, an agent cannot approve a held message.** On a device whose key file is
  encrypted (`wim signer`), approving, refusing or resuming held messages needs the signer's own
  confirmation: `wim held` and the events process (VS Code) ask the signer with a new `decide`
  request, the signer reads the held items from disk itself, shows them in the terminal it runs in
  (`--foreground`, a typed `y`) or in a native dialog, and on the person's yes signs a decision over
  exactly those ids, each bound to a digest of the item it showed. Sessions release or drop only
  what such a decision covers; an item that arrived later, a copy changed on disk and a replayed
  decision release nothing, and a resume lifts only a pause that started before it was signed. The
  asking command (or VS Code) shows a six-digit code that the signer shows too. The signer runs its
  dialog programs by absolute path, only when they are root's alone (never from `PATH`, also for the
  `--ask-gui` passphrase dialog, which now names the process that asked), ends every ask after 5
  minutes or when the asker goes away, waits after a decline before it asks again, refuses an id
  whose held copies differ in what it would show, takes a resume only for a roster device's breaker
  holds, and refuses every decision when an agent is among the processes that started it. Mark files
  (`held/<id>.approve`, `.refuse`, `.resume`, `control/resume-<peer>`) are refused while the keys
  are in the signer, and `wim doctor` lists any it finds; a locked or stopped signer takes no
  decision. The Claude Code pane's buttons then say to decide with `wim held` or VS Code, and VS
  Code waits up to 7 minutes for the answer. Without a signer nothing changes, and `wim doctor`
  advises running one. No wire or relay change (SECURITY-MODEL 7.1, 7.2 and 9; docs/design.md, the
  signer).
- **Close the downgrade window early.** `wim legacy-boxes refuse` makes a device refuse v0.1
  boxes now, as every device will from 1.0 (SPEC section 6b): it never sends one (a direct send
  to a device with no current prekey is refused with the reason, a broadcast, room send or card
  skips that device and `wim send` names it), and it drops every one it receives as
  `legacy_box`. A relay that withholds prekeys can no longer strip forward secrecy from that
  device's sends. Anyone may turn it on; `wim legacy-boxes accept` turns it off and is the
  person's alone (their own terminal and a typed `y`, as for `wim devices trust`), with no MCP
  tool or events op. `wim status` and `wim doctor` show it. Off by default until 1.0. No wire
  change.
- **A dropped v0.1 box is told and counted.** With `wim legacy-boxes refuse` on, a message
  dropped as `legacy_box` gives the session a local notice, once per sender device per session, that
  names the sender and carries none of the message, and `wim status` shows how many this device
  has dropped.
- **Stable addresses: take over an offline name on the same device.** `--take` with `--as
  <name>`, `WIM_TAKE=1` with `WIM_NAME` (also for `wim mcp`), and a `take` parameter on the MCP
  `rename` tool claim the offline session on this device that holds the name, from any
  directory, with its sid and resume secret: its queue, rooms, leases (same token), held items,
  receipts and history come with it, and one notice counts what came. Only on request: `rename`
  without `take` still answers `name_taken`, now with a hint. A name a live session holds, or a
  session of another kind, is refused with the reason, never answered with `name-N`. The client
  also saves the name a session asked for, so a session that got `name-N` is taken back under
  its name when it is free. The Claude Code plugin links the tab again after the model renames
  it. Since a peer's text can prompt a takeover, the tool asks agents to take only on the
  person's word, and `wim status` and `wim doctor` list every takeover of the last 24 hours.
  No wire or relay change.
- **Receipts only for messages this session sent.** A receipt for any other id is dropped and
  logged before it is kept or told: no event, no notice and no history line. At most four
  unknown ids are looked up in history at once, and the receipts kept for `send --wait` are
  bounded.

#### Other agents and finished notices

- **`wim hook <agent>`: other agents look again at turn end.** It is a turn-end hook for Gemini CLI,
  Antigravity CLI, Codex CLI, Cursor and Copilot CLI. When a turn ends and messages from devices you
  trust wait for that session, the hook asks the agent for one more turn. The request is a fixed
  line: how many messages wait, and to call the `inbox` tool. It never holds a peer's text, name or
  address. Each message is announced once per agent session. Held messages, untrusted devices,
  relayed text, CI notices and paused devices never wake it, and anything unclear lets the agent
  stop (exit 0 always). The hook counts only the `wim mcp` that the same agent session started,
  which `wim mcp` now records in its session directory (`ancestry.json`) while it runs. `wim setup`
  writes the hook entries, and [docs/peers.md](docs/peers.md) has them for each agent by hand.
  Gemini CLI and Antigravity CLI were checked live; the other three follow their documentation. An
  idle session still does not wake. The turn it asks for is a mesh turn: the session reads
  `busy-mesh` before the hook asks, so what the agent sends in it is derived, and without that mark
  there is no wake. Every turn end that lets the agent stop, aborted and failed turns included,
  reports the session idle, so `notify_when_idle` now fires for these agents, and an optional
  turn-start entry (`wim hook <agent> start`) shows it busy while it works.
- **`wim hook copilot` reads Copilot CLI's VS Code-compatible events too.** An entry configured as
  `Stop` or `UserPromptSubmit` gets snake_case payloads that name their event; the hook now wakes at
  that `Stop` and marks that `UserPromptSubmit` busy, as it does for `agentStop` and
  `userPromptSubmitted`.
- **The finished notice (`notify_when_idle`) is dependable on the client side.** An arm made while
  offline is sent at the next `ready`, and a new process of the session sends every open one at its
  first. A notice starts a turn only when the device that the armed address names is one the person
  trusts, the loop breaker does not pause it, and the breaker admits one more delivery from it,
  which it then counts; any other notice is spooled `quiet` (new spool fields `watched` and `quiet`)
  and waits for `inbox` or `wait`. A pause the notices trip holds through a restart of the session,
  though it holds no message. The notice names the address the agent armed. A session may have at
  most 16 open watches, as the relay allows: past that, `send` arms nothing more and says so in
  `watch_note`. The agent is told, quietly, when a watch lapses after 12 hours with no notice, and
  when the relay refuses an arm (`not_found`, `limited`), naming the address when it can tell which.
  `send` returns `watching: [{ to, until }]`, and with `notify_when_idle` and no text it only arms.
  `wim hook` counts finished notices this session asked for, with a fixed line of their own ("1
  notice this session asked for is waiting in worldinmotion..."), and the turn it asks for is a mesh
  turn as before. The wake rule moved to `wake.ts`, shared by the hook. Notice wakes are counted per
  device on their own and toward the total; past a limit they trip a cool-down on that device, which
  the person is told of. A session cannot watch its own address. A relay refusal is taken only for
  an arm in flight (or, with `of`, an open watch), one per arm. A damaged `watches.json` is left as
  it is, and arms are refused until it is removed. A channel push writes `busy-mesh` first, and
  pushes nothing when it cannot. SPEC section 8 and SECURITY-MODEL sections 5.4, 6.10, 7.1 to 7.3
  and 9 say so.
- **Relay: dependable idle notices.** A relay now sends the notice armed with `notify_idle` (MCP
  `send` with `notify_when_idle`) also when the watched session has been offline for 60 seconds
  without reconnecting, so a session whose agent crashed or closed is reported too, and says why it
  fired: `why` is `idle`, `ended` or `offline`. A notice that fires while the asking session is
  offline is kept, within the arm's 12 hours, and sent after that session's next `ready`. Each arm
  is answered with a new `idle.armed { of, exp }` frame, a refusal (`not_found`, `limited`) names
  the address in `of`, and a peer row carries `"presence": true` once its session has sent
  `presence` on its current connection. All of it is backward compatible: a 0.1.x client ignores
  `idle.armed` and the new keys, and a 0.2.0 client works with a 0.1.x relay unchanged, since no
  client frame gained a key. The SQL store adds a `fired` column to `idle` (schema 3, additive, so a
  relay rolled back to 0.1.x still runs on the database). The hosted relay has it from its next
  deploy (SPEC sections 8, 9 and 10).
- **The Claude Code plugin honours `quiet`, and only an armed notice wakes.** An item starts a turn
  only when it is a message, task, result or file, or an idle notice this session armed (it names
  the watched device), and is not `quiet`. Any other notice, one from before the watch was named, an
  item of an unknown kind or none, and one with a malformed `quiet` never start one. During a turn
  such an item is added to it, otherwise it waits in the `/wim` pane, under quiet notices, apart
  from relayed items, and for `inbox`. The client spools its own notices (unreadable or dropped
  messages, held receipts, claims, releases, renames, lost leases, pauses) `quiet`, and a held
  sender's message the person approves too, so the channel push skips them; the agent's ones, and
  notices from an older client, wait in the box for `inbox`. A waking notice starts one turn, as
  before. Every turn the plugin starts writes `busy-mesh` to the session's presence first, and when
  that write fails nothing is submitted: the items wait, and the plugin tries again on its next poll
  while the session is idle, or at the turn's end. A person's prompt that starts while a submit is
  pending no longer takes that submit's place, presence stays `busy-mesh` until the submit's turn
  starts, and pending submits are forgotten only after 30 seconds idle with nothing started.
  SendMessage with `notify_when_idle` and no message (or an empty one) only arms the watch, sends no
  text, and answers "worldinmotion will tell this session when `<to>` finishes". SECURITY-MODEL
  section 7.3 and the plugin README say so.
- **`wim wait-idle` and `wim send --wait-idle`, for scripts.** `wim wait-idle <address,...>` arms a
  finished notice for each address in a CLI session and waits, printing one line per notice (one
  JSON object per line with `--json`): exit 0 when every address has its notice (any one with
  `--any`), 1 when a watch is refused (this command's own address, past the 16 open watches, or an
  address the relay does not know; with `--any`, only once no address is left to wait for), and 2
  at `--timeout` (default and most 12h, a watch's life).
  `wim send <to> <text...> --wait-idle [--timeout 12h]` arms first, then sends, then waits the same
  way, so a session that finishes at once is not missed. A quiet notice (about a device you do not
  trust, or one the loop breaker pauses or limits) ends the wait too, and its line says it was
  quiet. A dropped connection does not end the wait (docs/peers.md, "Waiting from a script").

#### `wim agent`

- **`wim agent`, a peer that wakes on a message and runs one agent job** (new package
  `@worldinmotion/agent`). It runs a job only for a device id on its allow-list (from the signed
  roster, never a name) that the person also trusts, optionally behind a wake code checked in
  constant time (or left to the runner, so the worker's user never holds it), with an optional
  `<profile>:` prefix from a configured list. Each job goes through a runner command: one JSON
  request on stdin, the answer on stdout, exit codes for refused, busy and timed out, and a
  SIGTERM-then-SIGKILL timeout on its process group. Limits: task length, attempts per device per
  hour, one job at a time, a daily cap kept on disk (a request the runner refuses, or is busy for,
  gives its slot back). Replies are marked relayed; a room copy
  carries the answer only. The built-in runner (`wim agent runner`) uses the Claude Agent SDK with
  an API key, `claude-opus-5-5` at medium effort, read-only tools, and no settings, hooks or MCP
  servers from the machine (packages/agent/README.md, SECURITY-MODEL section 7.7).
- **A privileged runner for `wim agent`, with keyless Anthropic sign-in.** The worker runs as an
  unprivileged user and calls the privileged runner (`wim agent privileged`, behind a no-argument
  launcher) through one sudoers line that allows no arguments. The runner trusts nothing the worker
  says: each request carries the signed frame the relay delivered (RUNNER contract version 2), and
  the runner checks its signature against sender keys pinned in its root-only config
  (`/etc/wim-agent/privileged.json`), opens the box with the recipient device's keys, runs each
  frame once, and only then checks the wake code (from a root-only file or the privileged side's
  environment, in constant time) and the optional `name:` profile prefix. It refuses long or empty
  tasks, caps the day's jobs, refuses to start when memory is low or when its own code could be
  changed by anyone but root, and takes one job lock that a shell's `flock` on fd 9 shares. It then
  runs one Claude Agent SDK job as a third user with read-only tools (`Read`, `Grep`, `Glob` unless
  `unsafeTools` is set, then sandboxed), confined to its working directories and denied `/proc` and
  every runner path, the profile's model and effort (default `claude-opus-5-5`, `medium`), a turn
  cap and a timeout. The job holds no credential: the runner signs in itself (Workload Identity
  Federation through the Anthropic SDK's own token exchange, from an AWS STS, GCE metadata,
  impersonated GCP service account or file identity token, or an API key) and gives the job only a
  loopback proxy and a key that is good for that job alone, which the proxy compares as bytes in
  constant time. Every value it hands systemd-run (the scope's unit and slice, the ids, the command
  line) is checked against an allow-list first, and the job is refused on anything else. Of the
  job's stderr it logs only the worker's status lines, and keeps at most 500 characters of a line
  while it waits for the end. See `packages/agent/docs/privileged-runner.md`.
- **Sessions that keep no message text on disk** (`redactStoredText`, used by `wim agent`): spool
  files and history entries keep every field but the text, the loop breaker refuses what it would
  hold, and an untrusted device's item is held with its metadata only (a file without its key).

### Changed

- **The signer is `wim signer`** (`start`, `stop`, `status`, `lock`, `unlock`, `encrypt`,
  `decrypt`, `autostart`), so `wim agent` can name the agent worker. The old `wim agent start`,
  `status`, `lock`, `unlock`, `stop`, `encrypt`, `decrypt` and `autostart` still run the signer,
  with a note on stderr. `wim agent serve` runs the signer (with the note) when it is given no
  config path or any signer flag (`--foreground`, `--passphrase-stdin`, `--ask-gui`, `--keyring`,
  `--allow-agent-passphrase`); with a config path and none of those it is the worker.
  `wim signer autostart status` rewrites a login item written for another command line (an older
  `wim agent start`, or a moved `wim`) in place, keeping its passphrase source. The signer's state
  stays in `<WIM_HOME>/agent/`.

- **The first-run docs follow `wim setup`.** The README's Quick start is `npx worldinmotion setup`
  in a few lines; First run walks through `wim setup` and `wim setup <invite code>` on three
  machines, with the manual path under By hand; Other agents is one table of each agent's message
  delivery, what `wim setup` configures and how it was checked; a new section points to
  `wim agent`; and Security, in plain words covers trust that is never passed on, held sets,
  signed approvals and takeovers. The Claude Code plugin's README covers stable addresses
  (`WIM_NAME`, `WIM_TAKE`), and the VS Code extension's the welcome view and the held-set dialog.

### Fixed

- **A lease that expires goes to the session waiting for it.** When a lease's `until` and its
  waiter's wait ended within the same one-second relay sweep (always the case with the default
  60 s on both sides), the waiter was told `expired` and the lease was left free with nobody
  holding it. The relay now ends expired leases before expired waits, and hands the lease to a
  waiter whose wait had not passed at the lease's `until`. `lease.acquire` takes an optional
  `timeout`, how long to wait, apart from the lease's `ttl` (SPEC section 14); the MCP `lease`
  tool takes it as `wait_s`. Without it a wait lasts the `ttl`, as before. A relay older than this
  refuses the field, and the client asks again without it.
- **A session that lost a lease is told.** The client drops the token and writes a notice for the
  agent when the relay says the lease expired, when its `until` passes (also while offline), when
  a renew is refused and the relay no longer lists it as the holder, when a release is refused,
  and when it reconnects and `lease.list` shows that the lease ended while it was away. A re-acquire
  after the `until` is answered with the new grant (the client took the expiry notice before it as
  the answer). The `lease` tool's description tells agents to renew or check before every step a
  lease protects.
- **A new agent no longer inherits leases silently.** A same-project takeover writes one notice
  naming the leases that came with it, and keeps the relay's tokens for them. An acquire by the
  session that already holds the lease is answered `granted` with its token (it was `held`, naming
  the caller itself).
- **Expired lease tokens no longer pile up.** A token whose lease's `until` has passed is dropped,
  so a session whose leases all ended holds nothing and can end cleanly.

## [0.1.10] - 2026-11-07

### Added

- **CI rules can name a tag or branch pattern.** A rule's ref may end in one `*` and match every
  tag or branch under that prefix, the prefix itself included: `wim ci allow github <repo> --tag
  'v*' --workflow release.yml`, `wim ci allow gitlab <project> --tag 'v*'`, or `--ref
  'refs/heads/release/*'` for branches (SPEC section 18). There is no other glob syntax, and a
  rules file with any other spelling is refused. A device matches a notice's `ref` (and, for
  GitHub, the `workflow_ref` suffix, which must still be the token's own ref) by the prefix. The
  rule is tagged as spelled; for each verified GitHub token the relay tries the exact ref and
  every prefix of it followed by `*` (at most 256 hashes), so the device never names its patterns
  to the relay, which learns one only when a notice matches it. A pattern admits anyone who can
  push under its prefix: `allow` says so and how to protect the same refs at the provider (a
  GitHub ruleset targeting `v*` and `v*/**/*`, GitLab protected tags or branches; GitLab rules
  still need protected refs by default). Relays report `"ciPatterns": true` in `/v1/info`, and for
  a GitHub pattern `allow` warns, without refusing the rule, when the relay's `/v1/info` lacks it
  or cannot be read, since an older relay refuses notices under a pattern.
- **The CI senders get published, as `worldinmotion-notify`.** `release.yml` gains two jobs,
  `notify-github` and `notify-gitlab`, each off until a repository variable turns it on, which
  write the GitHub Action to its own repository for the GitHub Marketplace (tag `vX.Y.Z`) and the
  GitLab CI/CD component to its own project for the CI/CD Catalog (tag `X.Y.Z`, released by that
  project's own pipeline). `.github/scripts/notify-trees.mjs` builds both trees, with the
  release's own `wim.mjs` in the action, and refuses a file it does not list, another release's
  bundle, an expression in `action.yml` or a README link that would not resolve there. Each push
  uses a write credential held by a protected environment and read only by the push step. The
  READMEs now show only the published lines, `uses: distronode-corporation/worldinmotion-notify@<full
  commit sha> # vX.Y.Z` and `component: $CI_SERVER_FQDN/distronode-corporation/worldinmotion-notify/notify@X.Y.Z`,
  and say that neither resolves until a release publishes them.
- **`wim test`, a self-test inside wim.** It runs the real commands end to end on throwaway
  devices against a relay it starts in its own process on loopback (relay-node on an in-memory
  database), and removes all of it at the end, failures included. Fourteen steps: create, invite
  and join with the comparison code, trust both ways, ping both directions, send with routed,
  queued and delivered receipts, the offline queue, a held message from an untrusted device
  approved and then refused, rooms, a file, a lease, ask and reply, rename, the loop breaker
  tripped and resumed, `wim status` and `wim doctor` on a device not set up and on one in two
  meshes, and `wim mesh delete`. One row per step (pass, fail or skip, and the time), a summary
  line, exit 0 only when every step passed, and `--json` for CI. It plays the person for the
  person-only steps, on its own devices only; the isolation rules and what they guard are in
  SECURITY-MODEL section 7.6, each with a test against hostile input (the caller's real
  `WIM_HOME` and agent variables, a temporary directory inside the caller's state, existing state
  directories, symbolic links, any other relay address).
- **`wim test --full`, `--relay` and `--person`.** `--full` adds two sandbox steps: the signer
  (encrypt under a passphrase made for the run and never printed, start, lock, unlock, stop, its
  socket in the sandbox device's own directory; when TMPDIR is too long for a socket path, the
  run goes under `/tmp` instead, or is refused before it starts with "set TMPDIR to a shorter
  directory") and a CI notice from a test issuer that exists only inside the sandbox (held,
  approved, and the rule's ids pinned). `--relay <url>` is live
  mode: the same steps with a throwaway mesh on that relay (`wss://`, or `ws://` only on
  loopback), deleted at the end through `wim mesh delete` on pass, failure and Ctrl-C, with
  `--key-env NAME` for a relay that needs an operator key. A step the relay does not offer is a
  skip with the reason, and such skips do not fail the run; the summary line counts them.
  `--person` has a person type the person-only steps at their own terminal, and refuses to start
  under an agent's variables or piped input or output. Tests run live mode against relay-node in
  a process of its own.
- **worldinmotion: Run Self-Test in VS Code, and `/wim test` in Claude Code.** The VS Code command
  runs `wim test --json` with the extension's client under a progress notification (Cancel
  stops it, and the client still removes what it made), then says whether it passed, naming the
  first failed step (or that it was cancelled), with **Show Steps** for the **worldinmotion self-test** output, one row per
  step, the mark first; Cancel asks the client to stop with a line `stop` on its stdin, and kills
  it only after 10 seconds. `/wim test` runs the plugin's own client and prints the same rows; it
  passes on `--full` and `--relay <url>` only when the person typed them, and refuses `--person`
  and `--key-env` (from a chat, that could send any variable's value to any relay).
- **`wim test` cleans up after a run that was killed.** A line `stop` on a piped stdin stops a run
  like Ctrl-C, which a program can send where a kill would leave the run no chance to remove what
  it made (Windows). Each run's directory holds a mark file, and every run first removes
  `wim-test-*` directories under the same temporary directory whose mark is over 24 hours old,
  and on POSIX only those owned by you; nothing unmarked, younger, or reached through a link.
  Windows has no owner check, so there keep the temporary directory your own (the default, under
  your profile, is). One it cannot read or remove is skipped, never failing the run.

### Changed

- **`wim ci allow --tag` takes the tag name** (`--tag v1`, `--tag 'v*'`) instead of turning
  `--ref` into a tag: 0.1.9's `--ref v1 --tag` is refused (write `--tag v1`), never read as
  something else. `--ref` is unchanged: a branch name or a full ref, now also a pattern.
- **The hosted relay takes CI senders** since 2026-11-06 (relay 0.1.9, `"ci": true` in
  `/v1/info`), and [docs/hosted-relay.md](docs/hosted-relay.md) now says so, with what the relay
  sees for them. The README gains a CI notices section: the `wim ci` commands, the two senders and
  where to find them.
- A rule saved by 0.1.9 whose ref ends in `*` (which matched nothing then) is a ref pattern from 0.1.10.
- **relay-node loads `node:sqlite` when a relay starts**, not when the package is imported, so the
  client can bundle it for `wim test` without loading SQLite on every command.

### Fixed

- **A relay could start agent turns with idle notices nobody asked for.** The client took every
  relay `notice` frame, and the Claude Code plugin turns a notice into a turn of its own, so a
  hostile relay could start turns at will (SECURITY-MODEL section 5.4). Each arm of
  `notify_when_idle` (the `send` tool's, and the plugin's SendMessage through it) is now kept in
  the session's `watches.json`, written atomically: the address, when it was armed and when it
  lapses (12 hours). A notice is taken only for an armed address that has not lapsed, once, and
  the watch is closed; any other is dropped and logged. A re-arm renews the watch, a watch
  survives a restart that resumes the session, and an unreadable file reads as no watches. The
  relay decides how many arms a session holds (16), so the client refuses none: the file keeps
  the newest 64, and a watch the relay never fires lapses after its 12 hours, so a watch the
  relay did not keep blocks nothing. A watch also records the armed session's id, so its notice
  is taken after that session renames itself. When a watch cannot be recorded, the `send` result
  says so in `watch_note`, which the plugin's SendMessage passes on (SPEC section 8).
- **A recovery or invite code's show could read an empty proof.** The holder wrote its proof
  file in place, so a `wim recovery show` or `wim invite show` that read it in that moment sent
  an empty proof and was told no code was waiting while one was. The proof is now written under
  another name and renamed into place, and a reader that finds an empty or short proof is told
  nothing waits without connecting. Found by a macOS CI run.
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

[Unreleased]: https://github.com/distronode-corporation/worldinmotion/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/distronode-corporation/worldinmotion/releases/tag/v0.2.1
[0.2.0]: https://github.com/distronode-corporation/worldinmotion/releases/tag/v0.2.0
[0.1.10]: https://github.com/distronode-corporation/worldinmotion/releases/tag/v0.1.10
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
