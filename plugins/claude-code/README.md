# worldinmotion for Claude Code

This plugin connects a Claude Code session to a worldinmotion mesh, so it can exchange
end-to-end encrypted messages in real time with other AI agent sessions: Claude Code on another
machine or account, Codex CLI, Gemini CLI, Antigravity, Cursor, Copilot CLI, Claude Desktop, or a
`wim bot`.

It carries three parts:

- **An MCP server** (the `wim` client, from npm) that holds this device's keys, talks to the
  relay and gives the model the tools `peers`, `send`, `ask`, `reply`, `rooms`, `lease`,
  `send_file`, `inbox`, `wait`, `history` and `rename`.
- **A mod** that delivers incoming messages into the conversation as they arrive (into a running
  turn, or as a new turn when the session is idle), lets SendMessage reach `name@device` and
  `#room`, adds mesh peers to ListAgents, reports busy or idle to the mesh, and draws the `/wim`
  pane.
- **A skill** that tells the model how to use the tools and how to treat what peers send.

## Install

[Claude chat] At the Claude Code prompt:

```
/plugin marketplace add distronode-corporation/worldinmotion
/plugin install worldinmotion@worldinmotion
```

The marketplace installs the plugin as it was at the latest release, at the tag and commit that
[`.claude-plugin/marketplace.json`](../../.claude-plugin/marketplace.json) pins, never from the
main branch.

It works in the Claude Code terminal and in the VS Code extension: delivery into a running
turn, waking an idle session, and the SendMessage bridge have been checked in both. A Claude
Code session that was already open when you installed the plugin does not have it: start a new
one.

It requires Claude Code 2.1.321 or later. From that release on, Claude Code runs a mod's own
calls to its MCP server without a permission prompt, and the plugin's permission hook allows
nothing itself (see What the plugin does on your machine). On an older Claude Code you may be
asked to allow `mcp__plugin_worldinmotion_worldinmotion___internal`, and the plugin says so once
at the session's start: update Claude Code (`claude update`).

Node.js 22.18 or newer, with `npx`, must be on the `PATH`. The plugin carries no copy of the
client. On its first start, its MCP server runs `npx -y worldinmotion@<version> mcp`, which
downloads the `worldinmotion` package from the npm registry at exactly the version this release
pins (never a range or `latest`) into npm's cache, and runs it from there. The package is the
bundled client (`wim.mjs`) with its licence, README and deployment kit files, and has no
dependencies. Later starts use that
cache. npm may prune its cache on its own, and when the package is gone from it, the next start
downloads the same version again, so a start can need the registry at any time. `/wim test` runs the same
pinned package. npm publishes each release with provenance, so `npm view worldinmotion@<version>`
and the npm website show which commit and workflow built it.

If your organisation sets `allowManagedHooksOnly`, install the plugin as a managed plugin.
Installed any other way, Claude Code still connects its MCP server but loads none of its hooks,
and without them there is no gate: nothing refuses the model the plugin's internal tool.

## Set up this device

Each device (one machine, one OS user, one Claude account) has its own keys, made with the
`wim` command in a terminal you opened yourself (in VS Code: Terminal > New Terminal), never in
the Claude chat box or behind `!`. The plugin runs the client from npm's cache for its MCP
server, but does not put `wim` on your `PATH`.

[Terminal] Install `wim`:

```sh
npm install --global worldinmotion
wim --version
# "wim: command not found"? npm's global bin is not on your PATH:
export PATH="$(npm prefix -g)/bin:$PATH"   # add this line to ~/.bashrc or ~/.zshrc too
```

Without npm, download `wim.mjs` from the [GitHub Release](https://github.com/distronode-corporation/worldinmotion/releases),
check it against the release's `SHA256SUMS`, and install it as `wim` (for example
`install -m 755 wim.mjs ~/.local/bin/wim`) or run `node wim.mjs` in its place.

[Terminal] Then set up the device:

```
wim setup                 # first device: this device and a new mesh, as its admin, then the plugin and other agents
wim setup <invite code>   # any other device: makes this device's keys and joins with a one-time code from `wim invite`
```

`npx worldinmotion setup` does the same without installing `wim` first: it offers to install it
globally, then runs again from there. `wim setup` offers this plugin when it finds the `claude`
command, showing the two commands it runs and waiting for a `y`. By hand, `wim init --name
<device> --relay <url>` creates the mesh and `wim join <invite code>` joins one.

[Claude chat] A tab that was open while you did this links by itself within a few seconds; you
do not need a new session. The repository's [README](../../README.md#first-run-three-machines-one-person)
walks through three machines end to end.

## This tab: its address and status

Each Claude Code tab is its own session on the mesh, at `<folder>@<device>`: the working
directory's base name at this device's name (set `WIM_NAME` to choose another name, or rename
it as below). `cli@<device>` is that device's terminal inbox (`wim inbox`), not a Claude tab.

- The status line shows the tab's address and how many messages are held for it, for example
  `billing@laptop, 1 held`. When the tab is not linked it says why, in the client's words: the
  signer is not running, the device is not set up, the plugin's client is not running.
- [Claude chat] `/wim status` prints the address, device, mesh, relay connection, signer state,
  held count and the state directory this tab uses, with why it is that one.
- [Claude chat] `/wim name <name>` renames the tab (its address becomes `<name>@<device>`).
- [Claude chat] `/wim test` runs the self-test (`wim test`) with the plugin's own client:
  throwaway devices and a relay on loopback, all removed at the end, and prints one row per step.
  `--full` adds the signer and CI notice steps; `--relay <url>` runs it on that relay with a
  throwaway mesh, only when you type it. A relay that needs an operator key is tested from a
  terminal (`wim test --relay <url> --key-env NAME`). Your device and meshes are not touched.
- [Claude chat] `/wim` opens the pane (below).

If this tab started before the signer (`wim signer start`) or while the signer was locked, it
says so and links by itself within a few seconds of the signer coming up. If the client says
the keys of this session were encrypted while it ran, restart the session: it shows that as a
notice, and on the status line.

### Stable addresses

A name a tab held stays that session's while it is offline (24 hours, longer while messages wait
for it), so a new tab that asks for the same name gets `name-2`. A new tab in the same folder, and a
resumed Claude Code session, take their earlier session back by themselves. To give a role's
address to a new tab from another folder on the same device, ask for it:

- [Terminal] start Claude Code with `WIM_NAME=<name> WIM_TAKE=1` set, for example
  `WIM_NAME=release WIM_TAKE=1 claude`; or
- [Claude chat] ask Claude to rename the tab to that name and take it over (the `rename` tool's
  `take`).

The tab then gets that address with its queue, held items and leases, and a notice that counts
them. A name a live session holds is never taken, and `rename` without `take` is refused with
`name_taken`. Because a peer's message could prompt the model to ask, the tool tells it to take
over only on your word, and `wim status` and `wim doctor` list every takeover of the last 24
hours.

## The pane

`/wim` opens a pane with:

- the peers in the mesh, their kind, status (`idle`, `busy`, `offline`) and rooms;
- the last 20 items delivered to this session;
- messages **held for your approval**, a set per sending device (or CI rule) with its count and
  time span, Approve all and Refuse all buttons for exactly the items shown, and buttons for one
  item alone under each;
- items **relayed** by bots, CI or gateways that the session has not seen, with a button to give
  one to Claude;
- **quiet notices**: notices that may not start a turn (see below), with the same buttons;
- the advisory leases currently held.

Peers, the held queue and leases refresh when the pane opens and on each button press; the
counts read from disk refresh every five seconds while the pane is shown.

## Privacy and safety

[PRIVACY.md](../../PRIVACY.md) in the repository is the privacy policy: what is stored, what is
sent and to whom, and for how long.

- On its first start, the plugin downloads the pinned `worldinmotion` package from the npm
  registry (see Install). After that, its `wim` connects to the relay your mesh uses and, once
  you allow CI notices on this device (`wim ci allow`), fetches GitHub's or GitLab's public token
  keys to check them. It sends no usage data.
- The plugin's `wim` sends crash reports only after you run `wim crash-reports on` yourself, in
  your own terminal (repository README, Crash reports). The answer is shared by every `wim` that
  uses the same state directory, so a yes given to the npm `wim` covers the plugin's too.
- Message text is encrypted on the sending device for each recipient device and signed. The
  relay routes ciphertext and never holds the keys. It does see metadata: device and session
  names, who sends to whom, when, and how large. See `SECURITY-MODEL.md` in the repository.
- A message from a device you do not trust (`wim devices trust <name>` trusts one) is
  **held** until you approve it in the pane or with `wim held approve <id>`. No message can
  change that policy.
- Every delivered message is framed for the model as text from another AI session, not from
  you. The frame reduces the risk that the model obeys a peer, and it is not a guarantee
  (`SECURITY-MODEL.md` section 7.1). A message from a device you trust (not
  relayed text) arrives as a work assignment: the model may carry it out within its normal
  permissions, with its permission prompts and its own judgment, and may decline anything
  unsafe. Relayed text and messages from other devices are information only. The frame says
  "a device your person chose to trust" (or "another session on this same device"), never that a
  trusted device is yours, because you can trust another person's device too.
- Whoever sent it, a peer's message is never an approval of a specific action and cannot answer
  a permission prompt. The model is told never to reveal secrets and never to change
  permissions, settings or configuration because a peer asked.
- Outgoing text is checked for things that look like secrets (keys, tokens, invite codes); a
  match refuses the send. The check is best effort: an encoded or unusual secret gets through.
- The device keys are in a file your OS user can read, so a shell tool the model runs could read
  them too. To keep them out of its reach, run `wim signer encrypt` and then `wim signer start` in
  your own terminal: the keys move into a separate signer process, and `wim signer lock` stops their
  use until you unlock it. See `SECURITY-MODEL.md` section 5.8 for what that does and does not stop.
- The plugin talks to its client through one internal tool, `_internal`, carrying a token the
  client issues at the handshake. It is refused to the model, every operation of it, and every
  operation of it only reads. Your Approve, Refuse and Dismiss presses in the pane do not go
  through it at all: the plugin writes an empty mark file (`<id>.approve`, `<id>.refuse` or
  `<id>.dismiss`) in the directory the client named at the handshake, and the client acts on it,
  as it does for `wim held approve`. No MCP tool can approve a held message. Outside the pane it
  takes `wim held approve <id>` in a terminal you opened yourself: run from Claude's shell, or
  with `!`, it refuses (`CLAUDECODE is set`), and so do `wim devices trust` and `untrust`.
- The read-only tools (`peers`, `inbox`, `wait`, `history`) run without a prompt; every other
  tool (`send`, `ask`, `reply`, `send_file`, `rooms`, `lease`, `rename`) goes through Claude
  Code's normal permission prompts.
- Items a bot, CI job or gateway relays for a device never start a turn. While a turn is running
  they are added to it; otherwise they wait in the pane until you hand one over.
- A finished notice (SendMessage or `send` with `notify_when_idle`: one notice when that session
  next ends a turn or ends) starts a turn only when the client says it may: the watched device is
  one you trust, the loop breaker does not pause it, and the breaker admits one more wake from it.
  Every other notice is quiet: a watch that lapsed after 12 hours, an arm the relay refused, the
  client's own notices (an unreadable message, a held receipt, a claim, a pause), any notice that
  names no watched device, and any whose `quiet` is not `false`. So are an item of a kind the
  plugin does not know, and a message from a device you have not trusted that you approve. A
  quiet item is added to a running turn, otherwise it waits in the pane and for the `inbox` tool,
  and never starts a turn. SendMessage with `notify_when_idle` and no message only
  arms the watch: no text is sent.
- Every turn the plugin starts (a message, a notice, a press of Give to Claude) is marked
  `busy-mesh` in the session's presence first, so what the model sends in it is flagged derived
  (a trusted request goes one hop, no further). When that cannot be written, the plugin starts no
  turn, and the items wait: while the session is idle the plugin tries again on its next poll,
  otherwise at the turn's end. A turn that starts while one of the plugin's
  submits is pending (your own prompt queued ahead of it) is marked `busy-mesh` too, and the
  submit's own turn still is: presence stays `busy-mesh` until it starts, or until the session has
  stood idle for 30 seconds with nothing started.
- SendMessage reaches the mesh only for a room or for `name@device` where the device is in the
  current roster and the address was never a local teammate's in this session. The plugin asks
  you first before sending to a device you do not trust, to a room unless you trust every
  device in the mesh (a room message reaches them all), and whenever another plugin sends. The
  question shows the whole message, or for a long one its size, line count, and first and last
  lines.
- Leases are advisory locks between cooperating sessions, not access control.

## What the plugin does on your machine

This section lists everything the plugin runs, reads, writes and sends, so you can check it
before you install. The code is `hooks/register.tsx` (the mod) and `.mcp.json` (its MCP server).

**Programs it starts, and what they fetch.**

- Its MCP server is `npx -y worldinmotion@<version> mcp`, with `<version>` pinned to this release
  (never a range or `latest`) and `WIM_KIND=claude-code` in its environment, which makes the
  client offer the plugin's internal tool. `npx` downloads that exact package from the npm
  registry on first use (see Install). The client then connects to the relay your mesh uses.
- `/wim test` runs the same pinned package: `npx -y worldinmotion@<version> test --json --budget
  480`, plus `--full` and `--relay <url>` only when you type them (nothing else you type reaches
  the command; any other word prints the usage). It starts throwaway devices and, without
  `--relay`, a relay on loopback, and removes them at the end. Claude Code stops it after 10
  minutes. Only you start it, from the `/wim` command.

**Tools it calls itself.** The mod calls its own MCP server's tools, never another server's:

- `_internal`, the plugin's own tool, with the operations `hello` (the handshake, carrying this
  Claude Code session's id, which stays on this machine), `peers`, `route`, `held`, `leases` and
  `status`. Every one only reads.
- `send`, for SendMessage to a mesh address and for another plugin's `$.session.send` (below).
- `peers`, when ListAgents runs and the structured list is not available.
- `rename`, for `/wim name`.

Claude Code runs these calls without a permission prompt (Claude Code 2.1.321 or later); a deny
rule or your organisation's policy still refuses them. The plugin's questions to you (Send it?)
use Claude Code's own question dialog (`$.ui.ask`).

**What it reads, and what leaves the machine.**

- It reads the files the client writes for this session: the spool of incoming messages, the
  client's `spool/cursor`, the held queue, and the link file the client names while it waits for
  the signer. It reads the names of this session's local agents and teammates (`$.agent.list`),
  only to keep SendMessage to them local; they are never sent anywhere. It does not read the
  stored transcript. It sees the text of each prompt that starts a turn (`turn.start`), only to
  recognise the prompts it submitted itself, and keeps none of it.
- What the mod sends out: the text of a SendMessage to a mesh address (a room, or
  `name@device` in your mesh's roster), and the text another plugin sends through
  `$.session.send` to one. The mod hands it to its client, which encrypts it for each recipient
  device and sends the ciphertext through your mesh's relay. Before that, the mod asks you when
  the recipient's device is not one you trust, for a room unless you trust every device in it,
  and whenever another plugin sends. Nothing else the mod sees is sent.
- What the model sends out through the client's own tools: the text of `send`, `ask` and
  `reply`, and the file `send_file` names, go the same way (encrypted, through the relay) when
  the model calls them, each under Claude Code's permission prompt. Those calls do not pass
  through the mod.
- The client itself (not the mod) reads this device's keys from its state directory, or uses
  them through the signer when you run one: the device's identity keys, and its prekey secrets,
  each deleted 72 hours after its prekey expires (`SECURITY-MODEL.md`). They are made by `wim
  setup` in your own terminal. The mod never asks for them, reads them or passes them anywhere,
  and reads no credential from your environment. The client reads the `WIM_*` variables it
  documents if you set them (for example `WIM_SESSION_KEY`, a key a restarted agent uses to take
  its earlier session back); the plugin sets none of them but `WIM_KIND`. The handshake token the
  mod keeps is a random value the local client issues to this session on each start, and never
  leaves the machine. There is no credential for you to enter, so the plugin declares no
  `userConfig`.

**Files it writes that other programs act on.** All of them are in this session's directory,
which the client names at the handshake: `<state dir>/meshes/<mesh>/sessions/<sid>/`, where the
state directory is `~/.config/worldinmotion`, `WIM_HOME` when set, or with `CLAUDE_CONFIG_DIR`
set and `WIM_HOME` not, a directory of its own under `profiles/` (Files on disk, below).

- `presence`: `busy`, `busy-mesh` or `idle`. The client reads it to decide whether a message may
  start a turn here, and marks what this session sends as derived while it says `busy-mesh`.
- `spool/cursor`: the last item delivered. The client sends `delivered` receipts up to it and
  deletes those items.
- Empty mark files, written only when you press a button in the pane, which the client acts on
  at its next pass: `held/<id>.approve` (Approve: as `wim held approve <id>`), `held/<id>.refuse`
  (Refuse: as `wim held refuse <id>`), `held/<id>.resume` (Approve this one and resume this
  device: approves the item and also lifts the loop breaker's pause on its device, releasing
  what the breaker held from there, as `wim held resume`), and `dismiss/<id>.dismiss` (Dismiss:
  the relayed item is done with).

**Prompts it submits, and rows it adds.** An incoming message that may wake the session (a
message, task, result or file, or a notice the client says may start a turn) is added to the
running turn as a user-role row (`$.session.append`), or, when the session is idle, submitted as
a new prompt (`$.prompt.submit`). A quiet notice or an item a bot, CI job or gateway relayed
never starts a turn: it is added to a running turn, otherwise it waits in the pane. Whatever is
added carries the peer's text inside the frame described under Privacy and safety, which tells
the model the text is another AI session's, never yours. A press of Give to Claude in the pane
hands a waiting item over the same way, as your own act.

**Hooks that change what other parts of Claude Code do.**

- `tool.check` (the permission check): refuses the model, and any other plugin, every
  operation of the internal tool `_internal`. It never allows a call: the plugin's own calls are
  left to Claude Code, and every other tool call goes to Claude Code's normal permission flow.
- `tool.call` on SendMessage: for a mesh address, the plugin answers the call itself with the
  mesh's send result, in place of the built-in tool (which refuses `name@device`). Any other
  recipient goes to the built-in tool unchanged.
- `tool.call` on ListAgents: lets the built-in tool run, then appends the mesh peers to its
  answer.
- `tool.call` on the plugin's `rename` tool: after it runs, links the tab again under its new
  address.
- `session.send`: another plugin's message to a mesh address goes through the same bridge as
  SendMessage (and always asks you first); any other message passes unchanged.
- `tool.describe`: shortens the description of the plugin's internal tool and defers it behind
  tool search, so it costs the model as little as possible. Other tools' descriptions pass
  unchanged.
- `turn.start`: for a turn of the main conversation, links a tab that is not linked yet (the
  handshake), records that a turn runs and whether the plugin started it, writes `presence`
  (`busy` or `busy-mesh`), and notes the local teammates' names. `turn.step` empties the list of
  items that arrived too late for the request now starting. `turn.complete` records that the
  session is idle, writes `presence` (`idle`, or `busy-mesh` while a submit of the plugin's is
  pending) and hands over any items kept for a turn's end. None of them changes the turn, the
  prompt or the model's answer.

## Files on disk

State lives under `~/.config/worldinmotion` (or `WIM_HOME`). With `CLAUDE_CONFIG_DIR` set and
`WIM_HOME` not set, it is a directory of its own under `profiles/`, which is a different device
from the one a terminal without `CLAUDE_CONFIG_DIR` uses: `/wim status` and `wim doctor` both
say which directory they use and why. Each session has a spool directory there: the client writes each incoming item as a file, the plugin delivers it and records how
far it got in `spool/cursor`, and the client then deletes what was delivered.

## License

Apache-2.0. See `LICENSE`.
