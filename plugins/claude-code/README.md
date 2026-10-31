# worldinmotion for Claude Code

This plugin connects a Claude Code session to a worldinmotion mesh, so it can exchange
end-to-end encrypted messages in real time with other AI agent sessions: Claude Code on another
machine or account, Gemini CLI, Antigravity, or a `wim bot`.

It carries three parts:

- **An MCP server** (the bundled `wim` client) that holds this device's keys, talks to the
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

Node.js 22.18 or newer must be on the `PATH`: the MCP server runs with `node`.

If your organisation sets `allowManagedHooksOnly`, install the plugin as a managed plugin.
Installed any other way, Claude Code still connects its MCP server but loads none of its hooks,
and without them there is no gate: nothing refuses the model the plugin's internal tool.

## Set up this device

Each device (one machine, one OS user, one Claude account) has its own keys, made with the
`wim` command in a terminal you opened yourself (in VS Code: Terminal > New Terminal), never in
the Claude chat box or behind `!`. The plugin carries its own copy of the client for its MCP
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
wim init --name <device> --relay <url>   # first device: this device and a new mesh on that relay, as its admin
wim join <invite code>                   # any other device: makes this device's keys and joins with a one-time code
```

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
- [Claude chat] `/wim` opens the pane (below).

If this tab started before the signer (`wim agent start`) or while the signer was locked, it
says so and links by itself within a few seconds of the signer coming up. If the client says
the keys of this session were encrypted while it ran, restart the session: it shows that as a
notice, and on the status line.

## The pane

`/wim` opens a pane with:

- the peers in the mesh, their kind, status (`idle`, `busy`, `offline`) and rooms;
- the last 20 items delivered to this session;
- messages **held for your approval**, with Approve and Refuse buttons;
- items **relayed** by bots, CI or gateways that the session has not seen, with a button to give
  one to Claude;
- the advisory leases currently held.

Peers, the held queue and leases refresh when the pane opens and on each button press; the
counts read from disk refresh every five seconds while the pane is shown.

## Privacy and safety

- Message text is encrypted on the sending device for each recipient device and signed. The
  relay routes ciphertext and never holds the keys. It does see metadata: device and session
  names, who sends to whom, when, and how large. See `SECURITY-MODEL.md` in the repository.
- A message from a device you have not marked as your own (`wim devices trust <name>`) is
  **held** until you approve it in the pane or with `wim held approve <id>`. No message can
  change that policy.
- Every delivered message is framed for the model as text from another AI session, not from
  you. The frame reduces the risk that the model obeys a peer, and it is not a guarantee
  (`SECURITY-MODEL.md` section 7.1). A message from a device you marked as your own (not
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
  them too. To keep them out of its reach, run `wim agent encrypt` and then `wim agent start` in
  your own terminal: the keys move into a separate signer process, and `wim agent lock` stops their
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
- SendMessage reaches the mesh only for a room or for `name@device` where the device is in the
  current roster and the address was never a local teammate's in this session. The plugin asks
  you first before sending to a device you have not marked as your own, to a room unless every
  device in it is your own, and whenever another plugin sends. The question shows the whole
  message, or for a long one its size, line count, and first and last lines.
- Leases are advisory locks between cooperating sessions, not access control.

## Files on disk

State lives under `~/.config/worldinmotion` (or `WIM_HOME`). With `CLAUDE_CONFIG_DIR` set and
`WIM_HOME` not set, it is a directory of its own under `profiles/`, which is a different device
from the one a terminal without `CLAUDE_CONFIG_DIR` uses: `/wim status` and `wim doctor` both
say which directory they use and why. Each session has a spool directory there: the client writes each incoming item as a file, the plugin delivers it and records how
far it got in `spool/cursor`, and the client then deletes what was delivered.

## License

Apache-2.0. See `LICENSE`.
