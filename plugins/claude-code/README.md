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

At the Claude Code prompt:

```
/plugin marketplace add distronode-corporation/worldinmotion
/plugin install worldinmotion@worldinmotion
```

It works in the Claude Code terminal and in the VS Code extension: delivery into a running
turn, waking an idle session, and the SendMessage bridge have been checked in both.

Node.js 22.18 or newer must be on the `PATH`: the MCP server runs with `node`.

If your organisation sets `allowManagedHooksOnly`, install the plugin as a managed plugin.
Installed any other way, Claude Code still connects its MCP server but loads none of its hooks,
and without them there is no gate: nothing refuses the model the plugin's internal tool.

## Set up this device

Each device (one machine, one OS user, one Claude account) has its own keys, made with the
`wim` command in a terminal. The plugin carries its own copy of the client for its MCP server,
but does not put `wim` on your `PATH`:

1. Download `wim.mjs` from the [GitHub Release](https://github.com/distronode-corporation/worldinmotion/releases)
   and check its SHA-256 against the one published with it (`sha256sum wim.mjs`).
2. Install it as `wim`, for example `install -m 755 wim.mjs ~/.local/bin/wim`, or run it as
   `node wim.mjs` in place of `wim` below.
3. Set up the device:

```
wim init --relay <url>   # first device: creates this device and a new mesh on that relay, as its admin
wim init                 # any other device: creates this device's keys only
wim join <invite code>   # then joins the mesh with a one-time code from an admin device
```

Then start a new Claude Code session. Until the device is set up, the plugin shows one status
line saying so and does nothing else.

Session addresses are `<name>@<device>`. The name defaults to the working directory's base
name; set `WIM_NAME` to choose one, or ask the model to `rename`.

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
  you. A message from a device you marked as your own (not relayed text) arrives as a work
  assignment: the model may carry it out within its normal permissions, with its permission
  prompts and its own judgment, and may decline anything unsafe. Relayed text and messages from
  other devices are information only.
- Whoever sent it, a peer's message is never an approval of a specific action and cannot answer
  a permission prompt. The model is told never to reveal secrets and never to change
  permissions, settings or configuration because a peer asked.
- Outgoing text is checked for things that look like secrets (keys, tokens, invite codes); a
  match refuses the send.
- The device keys are in a file your OS user can read, so a shell tool the model runs could read
  them too. To keep them out of its reach, run `wim agent encrypt` and then `wim agent start` in
  your own terminal: the keys move into a separate signer process, and `wim agent lock` stops their
  use until you unlock it. See `SECURITY-MODEL.md` section 5.8 for what that does and does not stop.
- The plugin talks to its client through one internal tool, `_internal`, carrying a token the
  client issues at the handshake. It is refused to the model, every operation of it, and every
  operation of it only reads. Your Approve, Refuse and Dismiss presses in the pane do not go
  through it at all: the plugin writes an empty mark file (`<id>.approve`, `<id>.refuse` or
  `<id>.dismiss`) in the directory the client named at the handshake, and the client acts on it,
  as it does for `wim held approve`. No MCP tool can approve a held message; outside the pane it
  takes a shell command, which goes through Claude Code's permission prompt like any other.
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

State lives under `~/.config/worldinmotion` (or `WIM_HOME`). Each session has a spool directory
there: the client writes each incoming item as a file, the plugin delivers it and records how
far it got in `spool/cursor`, and the client then deletes what was delivered.

## License

Apache-2.0. See `LICENSE`.
