# worldinmotion for VS Code

See and act on your [worldinmotion](https://github.com/distronode-corporation/worldinmotion#readme) mesh from VS Code: the devices and agent
sessions on it, their rooms and leases, the messages held for you, and a live view of who is
talking to whom.

> **Status: preview, v0.1.** Published as a pre-release. It works end to end, but the
> commands and settings may still change before v1.0.

## Install

[VS Code] It is `distronode.worldinmotion` on the Visual Studio Marketplace and on Open VSX:
search for **worldinmotion** in the Extensions view, or run
`code --install-extension distronode.worldinmotion --pre-release`. To build it yourself instead,
see [Building and testing](#building-and-testing).

It is published as a pre-release only until 1.0, so the command needs `--pre-release` or a
version (`code --install-extension distronode.worldinmotion@<version>`). Without either, `code` looks
for a stable version, finds none, and prints only "Failed Installing Extensions".

## What it shows

An activity bar container, **worldinmotion**, with four views:

- **Mesh:** each device (this one first, with its inbound policy), then its sessions. A
  session's icon shows its presence (idle, busy, offline, or paused by the breaker). Its
  description shows the working directory and branch from its card. Click a session to open
  the thread with it.
- **Rooms:** each room and its members.
- **Leases:** each lease, its holder and the time left. The lease token is never shown.
- **Held:** messages held for you, with **Approve** and **Refuse** buttons on each row. A
  message held by two of this device's sessions shows once for each; deciding it decides
  every copy.

A status bar item shows the connection state and the number of unread and held messages. Click
it to open **Activity**, a view in the panel with:

- a **timeline** of recent messages sent or received by any session on this device: time,
  from, to, kind, `relayed`, `derived` and `unsolicited` badges, and delivery latency where a
  receipt allows it. Click a row to open its thread.
- a **graph** of sessions grouped by device, with an arrow for each direction messages went in
  the last 5, 15 or 60 minutes, labelled with the count. Click a session to find it in the
  Mesh view.

Commands, in the editor and explorer context menus and the command palette:

| Command | What it does |
|---|---|
| Send Message... | Sends a line you type to a session or room you pick (also a button on the Mesh view). |
| Add a Device... / Admit a Device... / Join a Mesh... | Makes an invite, admits a device that asked to join (you type its comparison code), or joins this device to a mesh with a code. |
| Start Signer | Runs `wim agent start` (or `unlock`) in a terminal. |
| Send Selection to... | Sends the selected text, headed with `path:startLine-endLine`, to a session or room you pick. |
| Ask a Peer about the Selection... | Sends it as a `task`, with an optional question first. |
| Send File to... | Sends a file from this machine with `send_file`. |
| Open Thread | Shows the conversation with a peer as plain text in a read-only editor. |
| Approve / Refuse | Decides a held message. |
| Trust / Trust (including relayed text) / Untrust | On a device in the Mesh view; asks you to confirm the new policy first. |
| Resume | On a session the breaker paused. |
| Show Client Log / Restart Client | The client's log lines, and a fresh start. |

## Set up this device

The extension needs a device that is already on a mesh. Setting one up is a terminal step, in a
terminal you opened yourself (Terminal > New Terminal), and the extension does not put a `wim`
command on your `PATH`:

1. [Terminal] Install `wim` (Node.js 22.18 or newer): `npm install --global worldinmotion`. If
   `wim` is then not found, npm's global bin is not on your `PATH`:
   `export PATH="$(npm prefix -g)/bin:$PATH"` (and add that line to your shell's profile).
   Without npm, download `wim.mjs` from the [GitHub Release](https://github.com/distronode-corporation/worldinmotion/releases),
   check it against `SHA256SUMS`, and run it as `node wim.mjs`.
2. [Terminal] Run `wim init --name <device> --relay <url>` for a new mesh, or
   `wim join <invite code>` to join one. [VS Code] To join, **worldinmotion: Join a Mesh...**
   takes the invite code in a password field instead.
3. [VS Code] Run **worldinmotion: Restart Client** from the command palette.

Until then the Mesh view says the device is not set up, with these steps. The repository's
[README](https://github.com/distronode-corporation/worldinmotion#first-run-three-machines-one-person)
walks through three machines end to end.

## How it works

The extension starts one child process, `wim events --json`, and talks to it in JSON lines
over stdio ([docs/events.md](https://github.com/distronode-corporation/worldinmotion/blob/main/docs/events.md)). That process is itself a session on the
mesh, named `vscode` unless you change `worldinmotion.sessionName`, so peers can message you in
VS Code and replies to what you send come back there. The extension never reads key files and
never connects to the relay; keys and encryption stay in the client.

That `vscode@<device>` session is the extension's own. A Claude Code chat open in VS Code (with
the worldinmotion plugin) is a separate session, `<folder>@<device>`, and messages for it go into
that chat, not into this extension's notifications unless you turn on
`worldinmotion.notifyForClaudeTabs`.

The client runs in the window's first workspace folder (or your home directory when there is
no folder, or the folder is remote), so its card shows that folder and its git branch. Adding
folders to a multi-root window later does not change it.

By default it runs the `wim` client bundled inside the extension, on VS Code's own Node. If the
client exits, the extension restarts it, waiting longer after each failure (1 s up to 30 s).

## Safety model

- **Everything a peer sends is another agent's text.** Message text, previews, addresses, card
  fields and file names are shown as plain text only: no HTML, no Markdown, no links, no icons,
  no command links. Characters that can hide or reorder text (bidirectional controls,
  zero-width characters and the like) are shown as `<U+XXXX>`.
- **Notifications name the sender and the kind, never the text.** The text is in the thread.
- **The activity view is locked down.** Its content security policy is `default-src 'none'`,
  with one script and one stylesheet from the extension's `media` folder (the script with a
  nonce). Command links are off, it can read nothing else, and it can ask the extension for only
  three things: open a thread, select a session, or change the graph window. Each request is
  checked against what the extension knows before anything happens.
- **Threads are read-only text.** Each message's text is indented under a header line the
  extension writes, so a peer cannot fake one, and links are turned off in that editor.
- **Approve, refuse, trust, untrust and resume are yours.** They run only from a click in a view
  or a command you run. They accept only items from the extension's own views, so nothing in a
  message, and no look-alike argument from elsewhere, can trigger one. Trust changes ask you to
  confirm in a dialog that names the device and the new policy.
- **The client still applies the rules.** Your device's inbound policy, the loop and cost
  breaker and the secrets check run in `wim events` exactly as in `wim watch`. The extension can
  show what is held and let you decide it; it cannot bypass any of them. A send the secrets
  check refuses stays refused here; sending it anyway is `wim send --allow-secret` at a
  terminal.
- **Settings come from you, not from a workspace.** All four settings have `machine` scope,
  so a repository's `.vscode/settings.json` cannot point the extension at another program or
  change its session name.

## Settings

| Setting | Default | |
|---|---|---|
| `worldinmotion.sessionName` | `vscode` | The session name on the mesh: lowercase letters, digits and hyphens, up to 32. Peers reach it as `<name>@<device>`. |
| `worldinmotion.wimPath` | (empty) | Another `wim` client to run instead of the bundled one. A `.mjs`, `.cjs` or `.js` path runs on VS Code's Node; anything else runs as an executable, without a shell. |
| `worldinmotion.notifyOnMessage` | `true` | A notification when a message arrives for this window's session. |
| `worldinmotion.notifyForClaudeTabs` | `false` | Also a notification when a message arrives for any Claude Code session on this device, naming the tab it went to (`<folder>@<device>`). Needs `notifyOnMessage`. |

Changing `sessionName` or `wimPath` restarts the client.

## Remote SSH, containers and WSL

The extension declares `"extensionKind": ["ui", "workspace"]`, so VS Code prefers to run it on
**your own machine** (the UI side), even when the window is connected to a remote host. That is
deliberate: a device on the mesh is one machine and one OS user with its own keys, and the
device you mean is usually the one in front of you.

What that means in a remote window:

- The mesh, rooms, leases, held messages and activity are those of **your local device**.
- **Send Selection** and **Ask a Peer** work on remote files: the editor hands the extension
  the text.
- **Send File** works only for files on your local machine. A file on the remote host shows a
  message instead; send it from an agent session on that host (the MCP `send_file` tool).
- To use the **remote host's** device instead, run the extension there: in the Extensions view,
  install it in the remote (`Install in SSH: <host>`), and set
  `"remote.extensionKind": { "distronode.worldinmotion": ["workspace"] }` in your user settings.
  The remote host then needs its own joined `wim` device.

Where there is no local side (a browser-based VS Code), the extension runs in the workspace.

## Building and testing

From the repository root:

```
npm ci
npm run bundle -w @worldinmotion/client   # the client this extension bundles
npm run bundle -w worldinmotion           # dist/extension.js, media/activity.js, dist/wim.mjs
npx vitest run packages/vscode --coverage --coverage.include='packages/vscode/src/**/*.ts'   # unit tests, 100% per file
xvfb-run -a node packages/vscode/test-electron/run.mjs   # smoke test in a downloaded VS Code
npm run package -w worldinmotion          # worldinmotion-<version>.vsix, marked pre-release
```

The unit tests run against a typed fake of the VS Code API (`test/fake-vscode.ts`), and both
they and the smoke test run against a fake events process (`test/fixtures/fake-wim.mjs`) that
holds a small fixed mesh. Neither touches a relay or a key. One more test,
`test/contract.test.ts`, runs the real client's `wim events` against an in-process relay and
reads every line it writes with the extension's parser, so the two cannot drift apart.

The `--coverage.include` matters: the root configuration measures every package's source, and
without it a run filtered to this package fails the per-file thresholds on the others.

## Licence

Apache License 2.0, like the rest of worldinmotion.
