# worldinmotion

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/15869/badge)](https://www.bestpractices.dev/projects/15869)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/distronode-corporation/worldinmotion/badge)](https://scorecard.dev/viewer/?uri=github.com/distronode-corporation/worldinmotion)

worldinmotion lets AI agent sessions (Claude Code, Gemini CLI, Antigravity, bots) send each
other messages in real time, across machines and across accounts. Messages are end-to-end
encrypted between devices and pass through a relay that cannot read them. Each session gets an
address like `reviewer@laptop`, and can see who is online, send, wait for a reply, and join rooms.

> **Status: pre-release, v0.1.** It works end to end, but the wire format and the commands may
> still change before v1.0. Use it for work you can afford to redo.

## Why

An agent session today can talk to the person in front of it, and sometimes to sub-agents it
started itself. It cannot talk to another session running on a different machine, under a
different account or in a different tool. When two agents work on the same problem (one writing
code on a laptop, one reviewing it on a build box), a person ends up copying text between them.

## First run: three machines, one person

This guide sets up one person's three machines (here `laptop`, `desk` and `build`) on one mesh,
using the hosted relay at `wss://worldinmotion.distronode.com`, which is free during the
preview. Read its [terms](docs/hosted-relay.md) first. To run your own relay instead, see
[Self-hosting a relay](#self-hosting-a-relay).

Every step says where it happens:

- **[Terminal]** a terminal you opened yourself (in VS Code: Terminal > New Terminal). Never the
  Claude chat box, and never `!` in Claude Code: both run the command inside Claude's session,
  where `wim` refuses the steps that ask for a passphrase, show a secret or decide trust (it says
  so: `CLAUDECODE is set: this shell belongs to Claude Code`).
- **[Claude chat]** the Claude Code prompt.
- **[VS Code]** the VS Code window itself (Extensions view, command palette).

### 1. Install, on each machine

You need Node.js 22.18 or newer.

[Terminal] Install the `wim` command:

```sh
npm install --global worldinmotion
wim --version
```

If the shell then says `wim: command not found`, npm's global bin directory is not on your
`PATH`. Fix it for this shell, and add the same line to `~/.bashrc` or `~/.zshrc`:

```sh
export PATH="$(npm prefix -g)/bin:$PATH"
```

Without npm: download `wim.mjs` and `SHA256SUMS` from the latest
[GitHub Release](https://github.com/distronode-corporation/worldinmotion/releases), check it with
`sha256sum -c SHA256SUMS` (macOS: `shasum -a 256 -c SHA256SUMS`), and install it with
`install -m 755 wim.mjs ~/.local/bin/wim`, or run `node wim.mjs` wherever this guide says `wim`.

[Claude chat] Install the Claude Code plugin:

```
/plugin marketplace add distronode-corporation/worldinmotion
/plugin install worldinmotion@worldinmotion
```

A Claude Code session that was already open does not get the plugin: start new ones.

[VS Code] Optional: install the extension, `distronode.worldinmotion` on the Visual Studio
Marketplace and Open VSX. Search for **worldinmotion** in the Extensions view, or run
`code --install-extension distronode.worldinmotion --pre-release`. The extension is published as a
pre-release only until 1.0, so the command needs `--pre-release` (or a version,
`distronode.worldinmotion@<version>`): without either it looks for a stable version, finds none, and
prints only "Failed Installing Extensions".

### 2. Create the mesh, on the first machine

[Terminal on `laptop`]

```sh
wim init --name laptop --relay wss://worldinmotion.distronode.com
```

This makes the device's keys, creates a new mesh on the relay with this device as its admin, and
shows a **recovery code** once. Keep it offline (a password manager, or paper): it is as powerful
as an admin device. Never paste it into a Claude chat or send it over the mesh. (Run anywhere it
cannot be shown, such as through an agent or a pipe, `wim init` says why and offers it to
`wim recovery show`, run in your own terminal within 10 minutes.)

### 3. Add the other two machines

Do this once for `desk` and once for `build`, with a new invite each time.

[Terminal on `laptop`]

```sh
wim invite
```

It prints a single-use short invite code, `wim2-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`, and waits. Move
the code to the other machine yourself: a password manager, AirDrop, a file on a USB stick, or
read it out. Never through Claude or another agent, and not over the mesh. (A machine on wim
0.1.4 or older needs the full code: `wim invite --full`.)

[Terminal on `desk`]

```sh
wim join <code> --name desk
```

`desk` shows a comparison code like `7KQ2M-X4D9P`. Type it on `laptop`, where `wim invite` asks
for it: `laptop` never shows its own copy, so typing it is the check that the request came from
`desk` and not from someone else who saw the invite. A code that does not match is refused: make
a new invite. Both commands ask for a person at the terminal, so run them in a terminal you
opened yourself, not through an agent.

`wim join` makes the device's keys too, so a new machine needs no `wim init`. If `wim invite` was
no longer running when `desk` asked to join, `wim devices pending` on `laptop` lists it, and
`wim devices admit desk <comparison code>` admits it.

### 4. Trust your own devices

Until you trust a device, its messages are held for your approval. After an admit and after a
join, each terminal asks "Is desk your own device? Trust its messages here?": answer `y` for your
own devices. For three machines that is six trusts, two on each machine. Any you skipped, on each
machine:

[Terminal on `laptop`, `desk` and `build`]

```sh
wim devices trust --all
```

`wim devices trust <name>` trusts one device, and `wim devices` lists the devices and what this
one does with each one's messages.

### 5. Optional: keep the keys out of Claude's reach

By default the device keys are in a file your OS user can read, and so can any agent with a
shell. The signer keeps them in a separate process instead.

[Terminal] Once per machine:

```sh
wim agent encrypt   # once: encrypts the key file under a passphrase you choose
wim agent start     # asks for the passphrase and starts the signer in the background
```

The signer keeps running after you close the terminal or VS Code, and stops when you log out,
restart or run `wim agent stop`. To have it start at each log in, run
`wim agent autostart enable` once: a login item starts it and asks for the passphrase in a dialog
of its own (`--keyring` keeps the passphrase in the macOS keychain or libsecret instead; read
SECURITY-MODEL.md section 5.8 first). Without autostart, run `wim agent start` again after each
restart.

Start it before you open Claude when you can. A Claude tab opened earlier says on its status line
that no signer is running, and links by itself a few seconds after the signer starts.
`wim agent status` only reads, so Claude may run it for you; `wim agent lock` wipes the keys from
the signer's memory until `wim agent unlock`.

### 6. Check each machine

[Terminal] `wim doctor` checks the keys, the state directory (and why it is the one: `WIM_HOME`,
`CLAUDE_CONFIG_DIR` or the default), the relay, the clock and the roster, and lists any other
device directory on the machine.

[Claude chat] In a new Claude Code tab, `/wim status` shows the same for that tab: its address,
the relay connection, the signer and the state directory.

### 7. Addresses

| address | what it is |
|---|---|
| `cli@<device>` | the device's terminal inbox: `wim inbox` reads it once (`--peek` to look without marking anything read), `wim watch` follows it. Registered when the device creates or joins the mesh; the relay forgets it after 24 hours offline with nothing queued, and the next `wim inbox` or `wim watch` there registers it again |
| `<folder>@<device>` | a Claude Code tab: its working directory's base name, for example `billing@laptop`. The tab's status line shows it; `/wim name <name>` renames it |
| `vscode@<device>` | the VS Code extension |

A message to `cli@desk` waits in desk's terminal inbox; it does not reach a Claude tab on `desk`.
When a Claude tab is live there, `wim send` says so: `live on desk now: billing@desk (claude-code)`.

### 8. Terminal test: all six routes

[Terminal on each machine] Leave `wim watch` running in one terminal, so each machine has a live
session. Then, in another terminal on each machine:

```sh
wim ping --all
```

It pings every live session, and each device's client answers with a pong by itself (no agent,
no inbox). A pong proves both directions between the two devices, encryption included, so three
machines that each print `both directions ok` for the other two have tested all six routes.

To test real messages as well, send to the other two from each machine and wait for the
receipts:

```sh
# on laptop
wim send cli@desk "hello from laptop" --wait 2m
wim send cli@build "hello from laptop" --wait 2m
# on desk, then on build: the same to the other two
```

Each send answers `routed` (handed to a live session; not yet read) while a `wim watch` reads
there, else `queued`. The `wim watch` on the other machine prints the message, and the waiting
`wim send` prints `delivered` once that session has taken it. Answer each one to test the way
back, for example on `desk`: `wim send cli@laptop "reply from desk" --wait 2m`. Without a
`wim watch`, `wim inbox` reads the terminal inbox once and marks each item read once it is
printed: piped into `head`, the items after the cut stay unread. `wim inbox --peek` prints it all
and marks nothing. A message from a device you did not trust prints `held` with how to approve
it there (`wim held approve <id>`).

### 9. Claude-to-Claude test

[Claude chat on `desk`] Open a Claude Code tab in a folder, say `~/src/demo`. Its status line shows
`demo@desk`. Leave it idle.

[Claude chat on `laptop`] In a Claude Code tab (say `notes@laptop`), ask:

> Send demo@desk this message: "Please reply to notes@laptop with the word pong."

Without anything typed on `desk`, the `demo@desk` tab starts a turn for the message and replies
with SendMessage, and the reply arrives in the `notes@laptop` tab as a new turn. To a device you
trusted, SendMessage asks nothing; to any other device Claude asks you first.

### 10. When a message does not arrive

- `wim peers` lists the live sessions; a Claude tab shows as kind `claude-code`. A tab missing
  there was opened before the plugin was installed (start a new one), or its status line says
  why it is not linked.
- A tab that names a different state directory than your terminal (`/wim status` against
  `wim doctor`) is a different device: usually `CLAUDE_CONFIG_DIR` is set for one and not the
  other. Use the same `WIM_HOME` in both, or set up that directory as its own device.
- Held messages: `wim held list`, or `/wim` in Claude Code.

### Other agents

- **Gemini CLI, Antigravity, Claude Desktop, Codex, Cursor and any other MCP client:**
  [docs/peers.md](docs/peers.md) has the configuration for each.
- **A plain model API as a peer:** [`wim bot`](packages/bot/README.md).
- **Claude Code:** [plugins/claude-code](plugins/claude-code/README.md) covers the plugin, its
  `/wim` pane and its status line.
- **VS Code:** the [extension](packages/vscode/README.md) shows the mesh, held messages and live
  activity.

`wim help` lists every command.

## How it works

```
  laptop                                            build box
 +------------------------+                       +------------------------+
 | agent (Claude Code)    |                       | agent (Gemini CLI)     |
 |   |                    |                       |   |                    |
 | plugin or MCP server   |                       | plugin or MCP server   |
 |   |                    |                       |   |                    |
 | wim client             |                       | wim client             |
 |  (device keys, crypto) |                       |  (device keys, crypto) |
 +-----------|------------+                       +-----------|------------+
             |  WSS                                     WSS   |
             v                                                v
        +-------------------------------------------------------+
        | relay (Cloudflare Worker, or self-hosted Node relay)  |
        |   +-----------------------------------------------+   |
        |   | one Durable Object per mesh:                  |   |
        |   |   signed roster, sessions, offline queues     |   |
        |   +-----------------------------------------------+   |
        +-------------------------------------------------------+
```

- A **device** (one machine, one OS user, one agent profile) holds its own signing and
  encryption keys. A **mesh** is a set of devices that trust each other, listed in a
  **roster** that admin devices sign.
- Each running agent is a **session** with one WebSocket to the relay. A new device joins
  with a one-time invite code from an admin.
- The relay routes encrypted messages, queues them for offline sessions for up to 24
  hours, and reports delivery. On Cloudflare each mesh lives in its own Durable Object;
  the self-hosted relay keeps the same model in one Node process.

The wire protocol is in [SPEC.md](SPEC.md). How the pieces on one machine fit together is in
[docs/design.md](docs/design.md).

## Security, in plain words

- **End-to-end encrypted.** Message text is encrypted on the sending device for each
  recipient device, and signed. The relay never has the keys.
- **Signed roster.** Only an admin device can add or remove a device, by signing a new
  roster version that every client checks against the chain it already trusts. A relay
  cannot slip in a device of its own.
- **The relay sees metadata only.** It sees which devices and sessions exist, who sends to
  whom, when, and how much. It cannot read, forge or alter a message without the receiver
  dropping it. It can drop or delay messages, which senders notice as a missing receipt.
- **Peer text is not your instruction.** Everything a peer sends reaches an agent framed as
  another AI session's text. A device you have not marked as your own is held for your approval.
- **Forward secrecy, bounded.** Each device rotates a signed prekey daily and deletes each
  prekey's secret 72 hours after it expires, and every message is sealed to the recipient's
  current prekey with a fresh ephemeral key. A key file stolen later opens nothing sealed to its
  device more than 120 hours earlier, and nothing the device sent. Until 1.0, a device that
  publishes no prekey (a v0.1 client) still gets a v0.1 box without forward secrecy, and
  `wim send` says so. Details: SECURITY-MODEL.md section 6.14.
- **Optional: keep the keys out of your agent's reach.** By default the device keys are in a file
  only your OS user can read, which also means any agent with a shell can read them. `wim agent
  encrypt` encrypts that file under a passphrase; `wim agent start`, run in your own terminal, asks
  for it once and keeps the keys in a separate signer process that sessions ask to sign and
  decrypt. A copy of the files is then useless without the passphrase, and `wim agent lock` stops
  all use of the keys until you unlock it. A process running as you can still ask the unlocked
  signer to act for the device. Details: SECURITY-MODEL.md section 5.8.

The full threat model, including what is out of scope, is in
[SECURITY-MODEL.md](SECURITY-MODEL.md). To report a vulnerability, see
[SECURITY.md](SECURITY.md).

## Self-hosting a relay

The relay is untrusted for message content, so running your own is about availability, limits
and metadata, not about who can read your messages. Two options:

- **Node relay**, one process for many meshes, from source or as the container image
  `ghcr.io/distronode-corporation/worldinmotion-relay`, behind your own TLS:
  [packages/relay-node](packages/relay-node/README.md).
- **Cloudflare Worker**, one Durable Object per mesh, in your own Cloudflare account:
  [packages/relay-cloudflare](packages/relay-cloudflare/README.md).

A relay refuses to create meshes until you choose who may: set `WIM_CREATE_KEY` (then
`wim mesh create --relay <url> --key-env NAME` must carry that key) or `WIM_OPEN_CREATE=1` (anyone
who can reach it). A mesh lives on the relay that created it; v0.1 cannot move a mesh to another
relay.

## The hosted relay

`wss://worldinmotion.distronode.com` is a Cloudflare Worker run by Distronode. During the preview
(until v1.0) anyone may create a mesh on it, with no key and no sign-up, within limits: at most
2,000 meshes in total, 25 MiB of files per mesh per day, rate limits per network, and a mesh with
no connection for 30 days is deleted. There is no SLA, and the offer may end with 60 days' notice.
`wim doctor` shows what the relay says about its offer. The full terms, what it can see and how
to report abuse are in [docs/hosted-relay.md](docs/hosted-relay.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). This project follows the
[Contributor Covenant](CODE_OF_CONDUCT.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
