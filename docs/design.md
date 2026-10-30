# Design: client, tools and the Claude Code plugin

SPEC.md defines the wire. This document defines the pieces on one machine: where state lives, the
MCP tools every agent sees, and the file contract between the client and the Claude Code plugin.
Packages are written against it; change it here first.

## Packages

| package | what it is |
|---|---|
| `packages/protocol` | encodings, crypto, schemas, rosters, invites, sealing (no I/O) |
| `packages/relay-core` | the per-mesh relay state machine behind a storage interface (no I/O) |
| `packages/relay-node` | a self-hosted relay: `ws` + `node:sqlite`, one process for many meshes, Dockerfile |
| `packages/relay-cloudflare` | the relay as a Worker with one Durable Object per mesh (WebSocket Hibernation, DO SQLite) |
| `packages/client` | the `wim` CLI and library: device keys, the connection, inbox, policy, and the MCP server (`wim mcp`) |
| `packages/bot` | `wim bot`: a model API (Bedrock, Vertex Gemini, Ollama) as a peer with no tools, capped by tokens and cost |
| `packages/ci` | `wim ci`: watches GitLab and GitHub pipelines and deployments with a read-only token and posts state changes into a room |
| `packages/a2a` | `wim a2a`: a gateway between the mesh and Agent2Agent (A2A) agents, in both directions |
| `packages/vscode` | the VS Code extension: the mesh, rooms, leases, held messages and live activity, through `wim events` ([events.md](events.md)) |
| `plugins/claude-code` | the Claude Code plugin: a mod, `.mcp.json` running the bundled client, a skill |

## State on disk

`WIM_HOME` defaults to `$XDG_CONFIG_HOME/worldinmotion` (`~/.config/worldinmotion`), or
`%APPDATA%\worldinmotion` on Windows. When `CLAUDE_CONFIG_DIR` is set and `WIM_HOME` is not, the
default is `<that base>/profiles/<first 12 chars of b64u(H(CLAUDE_CONFIG_DIR))>`, so two Claude
accounts on one OS user are two devices.

```
$WIM_HOME/
  device.json            0600  device keys (protocol encodeKeys) + device name; or, after
                               `wim agent encrypt`, version 2: the public keys and name in the
                               clear and the secret keys and a data key encrypted (scrypt,
                               ChaCha20-Poly1305) under the passphrase
  agent/                 0700  the signer (`wim agent`), when one was ever started here
    sock                 0600  its Unix socket (Windows: a named pipe `\\.\pipe\wim-agent-<token>`)
    pipe                 0600  Windows only: the pipe's random token
    config.json          0600  `require_signer`: refuse a plaintext key file
    log.jsonl            0600  one line per request: operation, type, mesh, peer device, outcome
    autostart.log              what the login item (`wim agent autostart`) prints, errors included
  meshes/<mesh>/
    mesh.json            0600  relay URL, pinned roster {seq, hash}, my device id, policy
    rosters/<seq>.json         every verified roster
    invites/<inviteId>.json 0600  issued invites: secret, exp, auto-accept flag, used
    seen.json                  dedupe ids with expiry (H3), per device, shared by sessions (locked writes)
    seq.json                   SeqTracker state (M3)
    prekeys.json         0600  this device's prekeys and their secrets: rotated daily, each secret
                               deleted at until + 72 h (SPEC section 6b), shared by sessions (locked writes);
                               each secret in the clear (`secret`) or, with the signer, sealed under the
                               key file's data key (`sealed`), which only the signer opens
    peer-prekeys.json          the newest verified prekey of each peer device (public, a cache)
    sessions/<sid>/
      session.json             name, kind, resume secret (0600), cursor, rooms
      spool/                   inbound items for the agent (see below)
      spool/cursor             last item name the agent has taken
      relayed/                 relayed items, beside the spool: shown to the person, never a turn
      presence                 "busy", "busy-mesh" or "idle", written by the plugin
      held/                    messages held for the person's approval (and approve/refuse marks)
      dismiss/                 dismiss marks for relayed items
      files/                   received files (safe names)
      live.lock                the pid of the process running the session now
      handover                 the same pid while that process takes handed-over sends (`wim watch`)
      control/                 sends handed to that watch by one-off `wim send`s, and its answers
    roster.lock                admin signing lock (H1)
```

All writes are atomic (write a temp file in the same directory, fsync, rename). Directories are
0700. A client that finds `device.json` readable by group or others refuses to start.

**Taking a session back.** A new session reuses an earlier session's sid and resume secret, so
the relay hands over its name, queue and rooms by proof, in two cases only: the agent names it
through a stable key (the Claude Code session id from the `_internal` op `hello`, or `WIM_SESSION_KEY`, mapped in
`meshes/<mesh>/claude/`, 7 days), or the earlier session on this device has the same name and the
same working directory in its `session.json`, did not end (`bye { ended: true }`), and no live
process holds its liveness lock. A session from another directory keeps its name, and the new one
gets `name-N`. `wim mcp` ends its session cleanly (`bye { ended: true }`) when stdin closes, on
SIGINT, SIGTERM or SIGHUP, and when its parent process goes away (checked every 5 seconds).

## The signer (`wim agent`)

Optional, and off until `wim agent encrypt`. The ssh-agent model: one process per device holds the
device keys and the data key that seals prekey secrets, and sessions ask it for every operation
that needs a secret key. What it does and does not protect is SECURITY-MODEL section 5.8.

- `wim agent encrypt` encrypts `device.json` (version 2), seals every mesh's prekey secrets and sets
  `require_signer`. A session already running keeps the plaintext keys it read; once it reads a
  sealed prekey it cannot open, it acknowledges nothing more on that connection and says once that
  it needs a restart, and the relay delivers those messages again to the restarted session. The
  key file is replaced by one atomic rename, so the identity survives an interruption; a prekey
  left in the clear is sealed by the signer on the next schedule. A session that read sealed
  prekeys before a `decrypt` and a new `encrypt` (a new data key) reads the file again when a box
  does not open, and opens it then.
  `wim agent decrypt` (signer stopped) writes the same keys back in the clear, opens the sealed
  prekeys and clears `require_signer`.
- `wim agent start` asks for the passphrase and starts `wim agent serve` detached from the
  terminal; the child reads the passphrase on stdin and prints `ready <pid> <endpoint>` or
  `error <why>`. Detached, it keeps running after the terminal or VS Code closes, and ends at log
  out, restart or `wim agent stop`; the command says so, and `wim agent status` says where to
  start one when none runs. The passphrase comes from the person's interactive terminal (no
  agent's variable set), or from `--passphrase-stdin` (a service manager, CI), `--ask-gui` (a
  native dialog: osascript, zenity or kdialog, the Windows PowerShell credential dialog; `start`
  asks again up to three times while it does not open the key file) or `--keyring` (opt-in, below).
  Under an agent's variables those three are refused unless `--allow-agent-passphrase` is given,
  which warns on stderr and proceeds: an agent that can read the passphrase's source can decrypt
  the keys (SECURITY-MODEL 5.8). It checks for a running signer and binds under `agent/start.lock`, so two starts
  never both bind. On Windows each start writes a new pipe token to `agent/pipe` and a clean stop
  removes it. Every command checks that what answers proves itself (a locked signer does too), and
  `start` takes the place of something that cannot.
  `--foreground` runs it in the command itself, for systemd, launchd or CI. Nothing starts it
  unless the person sets that up: the passphrase needs the person, and a signer started from an
  agent's session would be that agent's descendant, which an OS may let it debug.
- `wim agent autostart enable` installs a login item for the state directory (pinned as
  `WIM_HOME`) that runs `wim agent start --foreground --ask-gui` at each log in: a launchd agent
  (`~/Library/LaunchAgents/worldinmotion.signer.<id>.plist`), an XDG autostart entry
  (`$XDG_CONFIG_HOME/autostart/worldinmotion-signer-<id>.desktop`; XDG rather than a systemd user
  unit, because the dialog needs the desktop session's display), or a Windows logon task
  (`worldinmotion signer <id>`, created by `schtasks` from a task definition, no time limit, run
  through a hidden Windows PowerShell). `<id>` is 16 hex characters of the state directory's
  SHA-256. What the item prints, errors included, is appended to `agent/autostart.log` (launchd's
  `StandardOutPath` and `StandardErrorPath`; `sh` in the XDG entry; PowerShell's `*>>` in the
  task), so a start that fails before the signer runs says why. The person types the passphrase
  into a dialog the login session started. It installs
  only; `wim agent start` starts one now. `disable`, and `enable` without `--keyring`, remove any
  stored passphrase (`disable` the item too);
  `status` says whether one is installed and where it gets the passphrase.
  `enable --keyring` (only at the person's own terminal) stores the passphrase, checked against
  the key file and hex-encoded, in the macOS login keychain (an item trusting no application, so
  every read prompts) or libsecret (`secret-tool`, after a warning and a typed `yes`: any process
  of the user can read it while the keyring is unlocked), and the item then runs `--keyring`
  instead of `--ask-gui`. Not offered on Windows. SECURITY-MODEL 5.8 has the trade-offs.
- `wim agent status`, `lock` and `stop` talk to the running signer. A lock is for good: `wim agent
  unlock` reads the passphrase, checks it against the key file, asks the locked signer to stop
  and starts a new one (`--foreground` as for `start`). The passphrase never goes over the socket,
  and the command sends nothing more to something that still answers after `stop`.
- A session's device: a plaintext key file gives a keyring in the process, as before (refused when
  `require_signer` is set or `WIM_REQUIRE_SIGNER=1`). An encrypted one gives a keyring that calls
  the signer; with no signer, or a locked one, the command says which `wim agent` command to run.
- The socket speaks JSON lines: `{ "i", "op", "a" }`, answered `{ "i", "r" }` or
  `{ "i", "e": { "code", "message" } }`.
- `hello`: the client sends a nonce and an X25519 key. The signer, locked or not, answers with
  what it is (`id`, `name`, `signPub`, `boxPub`, `locked`, `pid`), its own X25519 key, its run
  key's certificate, and the run key's signature over `wim-agent/2 hello\n`, the nonce, both
  X25519 keys and those fields in canonical JSON: nothing the client acts on travels unsigned.
  The certificate is the device key's signature over `wim-agent/2 signer\n` and the canonical
  `{ pub, locked, issued, expires, pid }`; it holds for 24 hours. An unlocked signer issues a new
  run key at 12 hours, or at once when its certificate is from the clock's future (a clock set
  back); `lock` issues a locked one before the device key goes, and a locked signer
  stops when that runs out. The client checks the certificate against the key file's public part,
  that it is current and matches the hello's `locked` and `pid`, and the signature; it sends
  nothing more to what fails. From then on each line on that connection is `{ "x" }`, the JSON
  sealed with ChaCha20-Poly1305 under keys both sides derive with HKDF from the exchange, a
  counter as nonce each way. A connection to a signer that proved it is locked carries only
  `status`, `lock` and `stop`.
- The other operations: `status`, `sign` (auth, send, roster, join; only objects that name this
  device; `auth` and `send` only with an `at` within 5 minutes of the signer's clock; never a
  prekey), `seal`, `open` (scheme 1), `open2` (scheme 2, with the sealed prekey entry; refused past
  its deletion time), `prekey` (makes one, dated within 5 minutes of the signer's clock: public
  half and sealed secret), `adopt` (seals a clear prekey secret of this device's), `lock` (answers
  `{ was }`, whether it was locked already, sealed: `wim agent lock` reports that, never the
  hello's flag), `stop` (the signer stops listening before it answers, then closes every connection
  without waiting for its client). Before answering any request, and every 2 seconds, the signer
  checks that its endpoint still names its own socket (device and inode); if not, it locks and
  stops. Key operations are rate limited (100 a second, burst 1000). Requests on one connection
  are answered in order, and a client keeps each connection's calls to itself, so a connection
  that closes late fails only its own.
- A signer that is locked or gone makes a send fail with the reason. A delivered message that
  cannot be handled is not acknowledged, and nothing later is acknowledged on that connection
  (acks are cumulative); a frame is only ever acked on the connection it came on.
  - The signer could not answer (locked, gone, slow), or what answers is not the signer: the
    session drops the connection at once; the next one authenticates once the signer answers,
    and the relay delivers everything after the last ack again. Never given up on.
  - A local fault (`ENOSPC`, `EDQUOT`, `EIO`, `EROFS`, `EACCES`, `EPERM`, `EBUSY`, `EMFILE`,
    `ENFILE`, `EAGAIN`, `ENOTDIR`, `EISDIR`, `ENOENT`, `ELOOP`): the session drops the connection after a backoff (1 s, doubling to 5
    minutes, back to 1 s at the next ack), so the frame comes again. Never given up on.
  - Anything else, the frame's own (including the signer's `refused` or `bad_request` for it):
    the same backoff, and on its third failure the frame is let go with a log line, so one bad
    frame cannot stall the cursor for good.
  - A parked message that fails when retried stays parked for the next retry (each ready and each
    roster change); its failure is its own and never counts against another frame.

## The MCP server (`wim mcp`)

One process per agent session, started by the agent over stdio. It connects to the mesh named by
`WIM_MESH` (or the only mesh), with session name `WIM_NAME` or the working directory's base name,
and `kind` from `WIM_KIND` (default `mcp`; the Claude Code plugin sets `claude-code`).

Tools (few and short, to keep the per-request cost down):

| tool | input | does |
|---|---|---|
| `peers` | `{ all? }` | lists sessions: address, kind, status, rooms. One line each. Long-offline sessions without a card are left out unless `all`. |
| `send` | `{ to, text, reply_to?, notify_when_idle? }` | sends a message. `to` is an address, `#room`, `*`, or a list. Returns the per-recipient status. |
| `ask` | `{ to, task, timeout_s? }` | sends a `task` and waits (up to `timeout_s`, default 110, max 300) for its `result`; returns the result, or `pending` with the task id so the agent can pick the result up later from `inbox`. |
| `reply` | `{ task_id, status, text }` | sends the `result` for a task you received. |
| `inbox` | `{ peek? }` | returns unread items (messages, tasks, results, files) and marks them read unless `peek`. For agents without push delivery. |
| `wait` | `{ timeout_s? }` | blocks until the next item arrives (default 110 s, at most 300 s), then returns it, sending MCP progress notifications while it waits. |
| `rooms` | `{ action: "join" \| "leave" \| "list" \| "history", room?, limit? }` | room membership and history. |
| `lease` | `{ action: "acquire" \| "renew" \| "release" \| "list", name?, ttl_s?, wait? }` | advisory locks. `name` is the plain lease name; the client hashes it. |
| `send_file` | `{ to, path, caption? }` | encrypts and uploads a file (at most 25 MiB), then sends the `file` message. |
| `history` | `{ peer?, limit?, before? }` | past items, newest last (see History). |
| `rename` | `{ name }` | changes this session's name. |

Waits default to 110 seconds because agents treat long tool calls differently: Claude Code moves
an MCP call still running after 120 seconds into a background task, and Antigravity ends one at
180 seconds unless its configuration raises `timeoutSeconds`. Clients that can be woken another
way (the Claude Code plugin, channels) never need `wait`.

Every item the agent reads is rendered with `frameForAgent` (SPEC section 6a). Outbound text goes
through `findSecrets` first; a match refuses the send and names the pattern, never the value.

`send` returns `{ id, results: [{ to, status }] }` (the relay's `sent` statuses), or an error result
naming the reason when the secrets check or a limit refuses it. `peers` returns one line per peer,
address first.

The plugin's own calls go through one internal tool, `_internal { op, args?, token? }`, described
as "Internal to the worldinmotion plugin. Do not call." and offered only with `WIM_KIND=claude-code`
(Claude Code cannot hide a tool from the model, so there is one, and the plugin's `tool.check`
refuses it to the model). `hello` returns a random `token`, once per process; every other op must
carry it, and a second `hello` must carry it too. Each op answers JSON (structuredContent, or one
text block of JSON):

| op | args | output |
|---|---|---|
| `hello` | `{ claudeSessionId }` | `{ spool, sid, address, token, held, dismiss }`, where `held` and `dismiss` are the absolute paths of the session's mark directories (below); an error result when the device is not set up |
| `peers` | `{ forPane? }` | `{ peers: [{ address, kind, status, rooms, cwd?, branch? }] }` (card fields of untrusted devices only with `forPane`) |
| `route` | `{ to }` | `{ mesh, policy }`: whether `to` is a mesh address, and its device's policy (`deliver` for a room only when every device is) |
| `held` | `{}` | `{ held: [{ id, from, kind, at, preview }] }` |
| `leases` | `{}` | `{ leases: [{ name, holder, expires_at }] }` (`expires_at` in ms; `name` is the plain name when this device knows it, else the key) |
| (no op) | | The person's decisions are never an op: the plugin's pane writes an empty mark file, `<held>/<id>.approve`, `<held>/<id>.refuse` or `<dismiss>/<id>.dismiss` (a relayed item), and the session applies it on its next housekeeping pass. Only regular files named exactly `<ULID>.approve`, `.refuse` or `.dismiss` count; links are ignored |

## Inbound policy

Per sender device id: `deliver`, `hold` or `refuse`, stored in `mesh.json`. Defaults: a device the
person marked as their own (`wim devices trust <name>`) is `deliver`; any other device is `hold`.
A held item waits in `held/` with a receipt `held`; the person approves (the pane, `wim held
approve <id>`) and it moves to the spool. No message can change policy.

## What peers see of a session

Every session publishes a peer card (SPEC section 17) that every mesh member sees in its peer
listings: by default the working directory's base name and the git branch, for example
`cwd=billing branch=fix-refunds`. Cards are end-to-end encrypted to the mesh's devices, so the
relay cannot read them, but every member can. `share_cards` in `mesh.json` sets what is shared:
`true` (the default, base name and branch), `"full"` (the whole path) or `false` (a card with no
labels). One-off CLI commands publish no labels either. Every session still sends a card, because
its header carries the device's current prekey (SPEC section 6b); a card with no labels shows
nothing in listings. Logs keep less: connection lines on stderr name the relay
host and only the first four characters of the mesh id (the full URL with `WIM_DEBUG=1`).

## Loop and cost breaker

Two agents that each wake on the other's message can loop forever, and every wake costs tokens.
The client counts automatic deliveries per sender address in a sliding hour. Defaults: 20 wakes
per peer per hour and 60 in total. Past either limit, new items from that peer go to `held/`
instead of the spool, a `notice` tells the person ("worldinmotion paused <peer>: 20 messages in
an hour; /wim to resume"), and the sender gets the receipt `held`. A held peer resumes when the
person approves (the pane, `wim held resume <peer>`) or after the hour rolls over, whichever is
first. A ping-pong detector also pauses a pair early: more than 8 alternating exchanges in
10 minutes in which every message is under 200 characters. Limits live in `mesh.json`
(`breaker: { perPeerPerHour, totalPerHour, pingPong }`), and no message can change them.

## History

Every item delivered or sent is appended to `sessions/<sid>/history.jsonl` (0600, one JSON object
a line: direction, from or to, id, kind, at, text). Files rotate at 10 MiB and are kept 30 days.
The `history` tool (`{ peer?, limit? (default 20, max 200), before? }`) returns past items,
rendered with `frameForAgent`, so an agent can re-read a conversation after its context was
compacted. History is local only and never leaves the machine.

Receipts for what a session sent are recorded there too, as lines of their own (`{ "t": "receipt",
id, to, status, at }`, which older readers skip), when they reach the session. The relay forwards a
receipt only to a sending session that is online and drops it otherwise (SPEC section 7), so a
command that sends and goes offline (`wim send`) learns nothing unless it waits: `wim send --wait
30s` stays connected that long and prints each recipient's receipt. While it waits it holds the
CLI session's name like any running command: only a session whose `handover` file names the
process holding `live.lock` counts as a `wim watch`, so a second `wim send` meanwhile sends on a
throwaway session of its own instead of handing over, and `wim watch` and `wim inbox` say the name
is busy (try again, or `--as` another name). `wim history` and the
`history` tool show a sent item's receipts with it.

What each status means, as the CLI, the `send` tool and the plugin word it: `routed`, handed to a
live session; `queued`, that session is offline and the relay keeps it 24 hours. Neither means
delivered or read. Receipts: `delivered`, the recipient session took the item (its client's spool
sweep, or a waiting `ask`); `held`, it waits for the approval of that device's person (`/wim` in
Claude Code, the Held view in VS Code, or `wim held approve <id>`); `refused`, that device's inbound
policy; `expired`, nothing took it within 24 hours. None means a person or an agent read it. A
`held` receipt also becomes a notice in the sending session's spool (with `heldBy`), which the
Claude Code plugin shows as a toast instead of a turn.

## Distribution

- `wim` is bundled with esbuild into one file, `wim.mjs` (Node >= 22.18, no install step), attached
  to every GitHub Release with its SHA-256, and the same bundle is the plugin's `dist/client.mjs`.
- Platforms: Linux, macOS and Windows. Platform differences (key-file permissions, which on Windows
  are ACLs and not mode bits; paths; file locking) live in one module that takes the platform as a
  parameter, so its tests cover every platform on any machine.

## The plugin contract (spool)

- On `session.start` the mod calls `_internal { op: "hello", args: { claudeSessionId } }`. The
  server answers `{ spool, sid, address, token, held, dismiss }`: the absolute spool path for this
  session, the token every later op carries, and the mark directories (see the op table above).
- The server writes each inbound item as `spool/<cursor zero-padded to 12 digits>.json`:
  `{ "cursor": 42, "kind": "msg" | "task" | "result" | "file" | "notice", "from": "<address>",
  "device": "<device id>", "id": "<ULID>", "at": <ms>, "rendered": "<frameForAgent output>" }`,
  with four optional fields. A `notice` item carries `held: <count>` when it reports messages
  waiting for approval, or `heldBy: "<address>"` when a message this session sent is held for the
  approval of that address's person (a `held` receipt); the plugin shows either as a toast and
  does not pass it to the model.
  `relayed: true` marks text the sender passed on from a bot, CI or gateway: it never starts a
  turn. `informs: true` marks an item framed as information only; handing it to the agent starts
  the client's `derived` window, during which what the session sends is marked as derived from it. Delivery is at least once (a reload
  mid-delivery can repeat an item); the rendered frame carries the message id so an agent can tell.
- The mod polls `spool/` every 250 ms with `$.fs`, delivers items in order (`$.session.append`
  while the session is busy, `$.prompt.submit` while idle), and writes the newest delivered name to
  `spool/cursor`. The server deletes items at or below the cursor and only then sends the receipt
  `delivered`.
- Items appended after the turn's last model request began are re-delivered by `$.prompt.submit`
  on `turn.complete`, once (the mod tracks them in `$.state`).
- The mod writes `presence` from `turn.start`/`turn.complete` on the main loop: `idle`, `busy`, or
  `busy-mesh` for a turn a mesh item started. The server watches it, sends `presence` frames
  (`busy-mesh` is `busy` to the relay), fires `notify_when_idle` notices, and marks what the session
  sends during a `busy-mesh` turn as derived.

## Claude Code integration

- **SendMessage bridge.** A `tool.call` hook on `SendMessage` (the tool validates `to` before
  `session.send` runs, so only `tool.call` sees a `name@device` recipient; see spikes S7) takes any send whose `to` starts with `#`, or
  contains `@` and is not a local teammate (`$.agent.list()`; Claude Code teammates are addressed
  `name@team` too), sends it through the client (inside the hook, via MCP, self-allowed by `tool.check`),
  and answers `{ isDelivered }` with the relay's status. Other sends pass to the engine.
- **ListAgents.** A `tool.call` hook on `ListAgents` appends the mesh's peers to the result, marked
  `kind: worldinmotion`.
- **Pane.** `/wim` opens a pane: peers (status, rooms), the last messages, the held queue with
  approve and refuse, and current leases.
- **Push via channels (opt-in).** With `WIM_CHANNEL=1` and Claude Code started with the
  development-channels flag, the server declares the `claude/channel` capability and pushes each
  item as a channel notification instead of using the spool.

## Other peers
- **Any MCP client** (Gemini CLI, Antigravity, Claude Desktop, Codex, Cursor): add `wim mcp` as a
  stdio MCP server; the agent uses `inbox` and `wait`. `docs/peers.md` has tested configuration for
  each.
- **`wim bot`:** see [`packages/bot`](../packages/bot/README.md).
- **CI and deploy bot:** `wim ci` polls a GitLab or GitHub project's pipelines and deployments
  with a read-only token and posts state changes into a room (default `#ci`).
- **Phone notifications:** the client sends a short, content-free line ("1 message held for
  approval") through a configured provider. The one provider is `command`, set in
  `$WIM_HOME/notify.json` as `{ "provider": "command", "command": ["<program>", "<args>..."] }`: it
  runs the program without a shell, with the text as its last argument, at most once a minute by
  default. `wim notify-test` sends a test line.
- **A2A gateway:** `wim a2a` exposes mesh peers as Agent2Agent agents on a local port (agent cards
  and JSON-RPC `message/send`), and relays A2A tasks as `task` messages.
