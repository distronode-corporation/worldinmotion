# Connecting other agents

worldinmotion is built for any agent that can run a local MCP server over stdio, and is tested
with the agents the table below marks as tested. Claude Code has a plugin that delivers messages
into the session on its own. Every other agent runs `wim mcp` as an MCP server and reads messages
with the `inbox` and `wait` tools.

Each section says whether its configuration has been tested, and when. "Tested" means a real
session of that agent listed peers and sent a message that arrived at another peer.

The delivery column uses three labels:

- **push:** a message lands in the running turn, or starts a new turn in an idle session.
- **turn:** when a turn ends with messages waiting, the agent is told to read them and takes one
  more turn. `wim hook` does this for Gemini CLI, Antigravity CLI, Codex CLI, Cursor and Copilot
  CLI (see [Waking at turn end](#waking-at-turn-end-wim-hook)).
- **pull:** the agent sees messages only when it calls `inbox` or `wait` (see
  [Agents without push delivery](#agents-without-push-delivery)).

Only Claude Code wakes an idle session. With `wim hook`, five other agents look again at the end
of a turn.

| agent | how it connects | delivery | status |
|---|---|---|---|
| [Claude Code](#claude-code) | plugin | push | tested 2026-10-24 (terminal and VS Code extension) |
| [Gemini CLI](#gemini-cli) | `wim mcp` in `.gemini/settings.json` | pull, turn with `wim hook` | tested 2026-10-24 (0.64.0, Vertex AI) |
| [Antigravity CLI](#antigravity-cli-agy) | `wim mcp` in `.agents/mcp_config.json` | pull, turn with `wim hook` | tested 2026-10-24 (1.1.25, Vertex AI) |
| [Claude Desktop](#claude-desktop) | `wim mcp` in `claude_desktop_config.json` | pull | not yet tested (format checked 2026-10-24) |
| [Codex CLI](#codex-cli) | `wim mcp` in `~/.codex/config.toml` | pull, turn with `wim hook` | not yet tested (format checked 2026-10-24) |
| [Cursor](#cursor) | `wim mcp` in `.cursor/mcp.json` | pull, turn with `wim hook` | not yet tested (format checked 2026-10-24) |
| [Any other MCP client](#any-other-mcp-client) | `wim mcp` over stdio | pull | tested 2026-10-24 with the MCP TypeScript SDK client |
| [A plain model API](#a-model-api-as-a-peer-wim-bot) | `wim bot` | answers each message as it arrives | see `packages/bot` |

## Before you start

1. [Terminal] Install `wim` (Node.js 22.18 or later) with `npm install --global worldinmotion`.
   If `wim` is then not found, npm's global bin is not on your `PATH`:
   `export PATH="$(npm prefix -g)/bin:$PATH"`, and add that line to your shell's profile. The
   package is one file, `wim.mjs`; the examples below run it as `node /path/to/wim.mjs`, with
   `/path/to/wim.mjs` the absolute path npm installed it at:
   `"$(npm prefix -g)/lib/node_modules/worldinmotion/wim.mjs"` on Linux and macOS,
   `%APPDATA%\npm\node_modules\worldinmotion\wim.mjs` on Windows (`npm prefix -g` prints the
   prefix). Use the absolute path: most agents do not expand `~` or `$(...)` in their config.
   Without npm, get `wim.mjs` from the GitHub Release, check it against the release's
   `SHA256SUMS`, and put it somewhere stable, for example
   `~/.local/share/worldinmotion/wim.mjs`.
2. [Terminal] Add this machine to your mesh once, from a terminal you opened yourself (not
   through an agent): `wim join <code>` with an invite code from a device already in the mesh
   (`wim invite`). For a new mesh, run `wim init --relay wss://relay.example.com` on the first
   device (see the [first-run guide](../README.md#first-run-three-machines-one-person)). The
   relay URL is `wss://` with no trailing slash, and must match one of the relay's
   `WIM_RELAY_URLS` exactly; the client refuses `https://`, and accepts `ws://` only to loopback.
   `wim doctor` checks the result.
3. Add the MCP server to your agent as shown below, then start a new session. A session started
   before the device was set up, or before its signer (`wim agent start`), keeps trying and joins
   the mesh by itself once it can.

Every agent session gets its own address, `name@device`. The name comes from `WIM_NAME`, or the
working directory's base name when `WIM_NAME` is not set.

### Environment variables for `wim mcp`

| variable | meaning | default |
|---|---|---|
| `WIM_HOME` | where this device's keys and state live | `~/.config/worldinmotion` (`$XDG_CONFIG_HOME/worldinmotion` when that is set), `%APPDATA%\worldinmotion` on Windows; with `CLAUDE_CONFIG_DIR` set, a profile directory under it (below) |
| `WIM_NAME` | the session's name, the part before `@` | the working directory's base name |
| `WIM_KIND` | a label other peers see in `peers` (`gemini-cli`, `antigravity`, `codex`, ...). Never set it to `claude-code` (below) | `mcp` |
| `WIM_MESH` | which mesh, when this device is in more than one | the only mesh |
| `WIM_SESSION_KEY` | a stable key that lets a restarted agent take its earlier session back (name, queue, rooms) | none |
| `WIM_TAKE` | `1`: take over the offline session on this device that holds `WIM_NAME` (its queue, held items and leases), from any directory; refused while a live session holds it | off |

Set these in the server's `env` block, not only in your shell. Some agents (Gemini CLI, for one)
remove variables from the environment they pass to MCP servers.

**Never set `WIM_KIND=claude-code` yourself.** That value is reserved for the Claude Code plugin:
it makes `wim mcp` offer the plugin's internal tool, `_internal`, and only the plugin's hooks
refuse that tool to the model. Outside the plugin nothing refuses it, so the model can call it.

**One device, one state directory.** An agent and a terminal see the same keys only when they
resolve the same state directory. When `CLAUDE_CONFIG_DIR` is set and `WIM_HOME` is not, the
default is a per-profile directory, `<base>/profiles/<12 characters derived from
CLAUDE_CONFIG_DIR>`, so each Claude account is its own device. The Claude Code plugin's MCP server
runs with Claude Code's environment, so run `wim init`, `wim join` and `wim doctor` in a terminal
with the same `WIM_HOME`, and the same `CLAUDE_CONFIG_DIR` when one is set. Otherwise the terminal
writes keys to one directory and the agent looks in another, and reports that the device is not
set up. `wim doctor` prints the state directory it uses and why, and lists the other device
directories it finds; in Claude Code, `/wim status` prints the plugin's.

### The tools

| tool | use it to |
|---|---|
| `peers` | list sessions: address, kind, status, rooms |
| `send` | send a message to an address, a `#room`, `*`, or a list |
| `ask` | send a task and wait for its result |
| `reply` | answer a task you received |
| `inbox` | read unread messages, tasks, results and files without waiting |
| `wait` | block until the next item arrives, then return it |
| `rooms`, `lease`, `send_file`, `history`, `rename` | rooms, advisory locks, files, past messages, renaming this session |

Everything a peer sends reaches the agent wrapped in a frame that says it is another AI session's
text. This reduces the risk that the agent obeys a peer, and it is not a guarantee
(SECURITY-MODEL.md section 7.1). Outbound text that matches common credential formats is refused.
That check is best effort: an encoded or unusual secret gets through (SECURITY-MODEL.md section
7.4).

## Agents without push delivery

Only the Claude Code plugin can start a turn when a message arrives (push delivery). Every other
agent has pull delivery: it sees new messages only when it calls a tool, so tell it when to look.
Two patterns work:

- **Check at the start of a task.** Add a line to the agent's instructions file (`GEMINI.md`,
  `AGENTS.md`, `.cursor/rules`, a system prompt): "At the start of each task, and before you finish,
  call the worldinmotion `inbox` tool and handle anything waiting." This costs one short tool call
  per task.
- **Wait in a loop.** For an agent whose job is to serve other agents, tell it: "Call the
  worldinmotion `wait` tool. When it returns a message, handle it, reply with `send` or `reply`,
  then call `wait` again. When it returns no items, call `wait` again." Each `wait` that returns
  empty costs one tool round trip, so a loop left running overnight still costs tokens. Stop it
  when you no longer need it.
- **Look again at turn end.** For Gemini CLI, Antigravity CLI, Codex CLI, Cursor and Copilot CLI,
  `wim hook` gives the agent one more turn when messages arrived while it worked (see
  [Waking at turn end](#waking-at-turn-end-wim-hook)).

`wait` blocks for up to 110 seconds by default (`timeout_s`, at most 300). The default sits under
the shortest limit among common agents: Claude Code moves an MCP call still running after
120 seconds into a background task, and some hosts end a tool call sooner still (see the per-agent
notes below). While it waits, `wait` sends an MCP progress notification every 30 seconds to clients
that asked for progress, which keeps idle timers from firing. If your agent's tool timeout is
shorter than 110 seconds and you cannot raise it, tell the agent to pass a smaller `timeout_s`.

## Claude Code

Tested 2026-10-24 in the terminal and in the VS Code extension.

```
/plugin marketplace add distronode-corporation/worldinmotion
/plugin install worldinmotion@worldinmotion
```

The plugin runs `wim mcp` for you, delivers messages into the session as they arrive (while it
works and while it is idle), and adds the mesh's peers to `ListAgents` and `SendMessage`. You do
not need `wait` or `inbox`. Its [README](../plugins/claude-code/README.md) covers setup and the
`/wim` pane.

## Gemini CLI

Tested 2026-10-24 with Gemini CLI 0.64.0 on Vertex AI: a headless session listed peers with
`peers` and sent a message with `send`, and the message arrived.

Add the server to `.gemini/settings.json` in your project (or `~/.gemini/settings.json` for every
project):

```json
{
  "mcpServers": {
    "worldinmotion": {
      "command": "node",
      "args": ["/path/to/wim.mjs", "mcp"],
      "env": {
        "WIM_HOME": "/home/you/.config/worldinmotion",
        "WIM_NAME": "gemini",
        "WIM_KIND": "gemini-cli"
      },
      "trust": true,
      "includeTools": ["peers", "inbox", "wait", "history"],
      "timeout": 180000
    }
  }
}
```

- `timeout` is in milliseconds. Gemini CLI's default is 600,000 (10 minutes), so any value above
  the `wait` you plan to use works; 180,000 is the tested value.
- `trust: true` lets the server's tools run without a confirmation prompt, and `includeTools`
  limits the agent to the read-only tools, so `trust` covers only those. Keep it that way unless
  you need more: with every tool trusted, a peer's text could lead the agent to upload a file with
  `send_file` or message the mesh without asking.
- **Opt in to `send`** when the agent should answer peers unattended: add `"send"` (and `"reply"`
  for tasks) to `includeTools`. Do not add `send_file` to a trusted server. (The tested run above
  used `trust: true` with no `includeTools` list.)
- Headless mode (`gemini -p`) cannot show a prompt and treats it as a denial, so headless use
  needs either `trust: true` or a policy rule that allows the tools it calls.
- `env` is required, not optional: Gemini CLI removes sensitive-looking variables from the
  environment it gives MCP servers, so pass what `wim mcp` needs explicitly.

**Vertex AI (tested).** Sign in with Application Default Credentials and select Vertex:

```bash
unset GEMINI_API_KEY GOOGLE_API_KEY   # an API key in the environment takes precedence
export GOOGLE_GENAI_USE_VERTEXAI=true
export GOOGLE_CLOUD_PROJECT=<your project id>
export GOOGLE_CLOUD_LOCATION=global
gemini
```

The principal behind your credentials needs the Vertex AI User role on that project.

**Gemini API key (not yet tested).** Set `GEMINI_API_KEY` instead of the three Vertex variables.
Since 2026-06-18 Gemini CLI serves paid API keys, Vertex AI and enterprise licences; consumer
accounts moved to Antigravity CLI.

**Headless.** In a folder Gemini CLI has not been told to trust, headless mode refuses to run.
Set `GEMINI_CLI_TRUST_WORKSPACE=true` for a headless run in a folder you trust:

```bash
GEMINI_CLI_TRUST_WORKSPACE=true gemini -p "Call the worldinmotion peers tool, then send reviewer@laptop the text 'hello'."
```

This example sends, so it needs `send` in `includeTools`.

## Antigravity CLI (`agy`)

Tested 2026-10-24 with `agy` 1.1.25 on Vertex AI (Application Default Credentials): a headless run
listed peers with `peers` and sent a message with `send` (status `routed`), and the message
arrived at the other peer.

Add the server to `.agents/mcp_config.json` in your workspace (or `~/.gemini/config/mcp_config.json`
for every workspace):

```json
{
  "mcpServers": {
    "worldinmotion": {
      "command": "node",
      "args": ["/path/to/wim.mjs", "mcp"],
      "env": {
        "WIM_HOME": "/home/you/.config/worldinmotion",
        "WIM_NAME": "agy",
        "WIM_KIND": "antigravity"
      },
      "timeoutSeconds": 330
    }
  }
}
```

- **Raise `timeoutSeconds`.** Antigravity ends a tool call after 180 seconds by default, so a
  300-second `wait` fails without it. A positive value replaces both the 300-second start-up limit
  and the 180-second per-call limit; 330 covers the longest `wait`.
- To limit the tools the agent sees, add `"enabledTools": ["peers", "inbox", "wait", "history"]`
  (and `"send"` when it should send).

**Vertex AI with Application Default Credentials (tested):**

```bash
gcloud auth application-default login
export AGY_ADC_AUTH=true
export GOOGLE_CLOUD_PROJECT=<your project id>
export GOOGLE_CLOUD_QUOTA_PROJECT=<your project id>
export GOOGLE_CLOUD_LOCATION=global
agy
```

**Headless needs a permission rule.** MCP tools run in Ask mode by default. In print mode (`agy -p`)
there is no prompt, so the call is soft-denied: the run still exits 0, the JSON output lists
`"denied_actions": [{"action": "mcp", ...}]`, and nothing is sent. We saw exactly this on the first
test run. Allow the wim tools in `~/.gemini/antigravity-cli/settings.json` (rule syntax from the
Antigravity permissions documentation; these rules, including the per-tool form
`mcp(<server>/<tool>)`, are not yet tested):

```json
{
  "permissions": {
    "allow": [
      "mcp(worldinmotion/peers)",
      "mcp(worldinmotion/inbox)",
      "mcp(worldinmotion/wait)",
      "mcp(worldinmotion/history)"
    ]
  }
}
```

These rules allow the read-only tools only. Add `"mcp(worldinmotion/send)"` when the agent should
message your peers without asking, and only for an agent you would let do that unattended. Do not
allow `send_file` or `mcp(worldinmotion/*)`: an injected agent could then upload any file it can
read without a prompt.

`--dangerously-skip-permissions` also works, but it approves every tool, including shell commands
and file writes. It also means that a work request from a device you trust runs with nobody
watching (see [SECURITY-MODEL.md](../SECURITY-MODEL.md) section 7.1). Prefer the rules.

```bash
agy -p "Call the worldinmotion peers tool, then send reviewer@laptop the text 'hello'." --output-format json
```

This example sends, so it needs the `send` rule.

To have Antigravity look again at the end of a turn, add the `Stop` hook in
[Waking at turn end](#waking-at-turn-end-wim-hook).

## Claude Desktop

Not yet tested (configuration format checked against the official MCP documentation, 2026-10-24).

Open Settings, then Developer, then Edit Config. The file is:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "worldinmotion": {
      "command": "node",
      "args": ["/path/to/wim.mjs", "mcp"],
      "env": {
        "WIM_NAME": "desktop",
        "WIM_KIND": "claude-desktop"
      }
    }
  }
}
```

On Windows, write the path with escaped backslashes, for example
`"C:\\Users\\you\\worldinmotion\\wim.mjs"`. Quit Claude Desktop completely and start it again to
load the change. If the server does not appear, read `mcp-server-worldinmotion.log` in
`~/Library/Logs/Claude` (macOS) or `%APPDATA%\Claude\logs` (Windows); `wim mcp` logs its
connection there. Claude Desktop asks before each tool call unless you allow the tool.

## Codex CLI

Not yet tested (configuration format checked against the official Codex documentation, 2026-10-24).

Add a table to `~/.codex/config.toml` (or `.codex/config.toml` in a project; Codex reads that only
for projects you have trusted). The CLI, the IDE extension and the desktop app share this file.

```toml
[mcp_servers.worldinmotion]
command = "node"
args = ["/path/to/wim.mjs", "mcp"]
tool_timeout_sec = 150

[mcp_servers.worldinmotion.env]
WIM_NAME = "codex"
WIM_KIND = "codex"
```

- **Raise `tool_timeout_sec`.** Codex's default is 60 seconds, which ends a default `wait`
  (110 seconds) early. 150 covers the default; use 330 if the agent may pass `timeout_s: 300`.
- `startup_timeout_sec` defaults to 10 seconds, which is enough: `wim mcp` answers its first
  request well within a second when the relay is reachable.
- `default_tools_approval_mode` (`auto`, `prompt`, `writes`, `approve`) and per-tool
  `[mcp_servers.worldinmotion.tools.<tool>] approval_mode` control the prompts.

The same server from the command line:

```bash
codex mcp add worldinmotion --env WIM_NAME=codex --env WIM_KIND=codex -- node /path/to/wim.mjs mcp
```

## Cursor

Not yet tested (configuration format checked against the official Cursor documentation, 2026-10-24).

Add the server to `.cursor/mcp.json` in your project, or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "worldinmotion": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/wim.mjs", "mcp"],
      "env": {
        "WIM_NAME": "cursor",
        "WIM_KIND": "cursor"
      }
    }
  }
}
```

Cursor asks for approval before each MCP tool call unless the tool is allowed by your run mode.
Its documentation does not state a tool-call time limit, so test a `wait` once; if it is cut off,
tell the agent to pass a smaller `timeout_s`.

## Any other MCP client

Tested 2026-10-24 with the MCP TypeScript SDK's stdio client (`@modelcontextprotocol/sdk`, no model
involved): the client started `wim mcp`, listed the 11 tools, called `peers`, sent a message that
arrived at the other peer (status `routed`), read an empty `inbox`, and called `wait`. A `wait`
with nothing to deliver returned "No new items in 5 s." after 5 seconds, as a normal result, not an
error. A `wait` running when another peer sent a message returned that message, framed, as its
result. A 40-second `wait` sent one progress notification, at 30 seconds.

What a client needs:

- **Command:** `node /path/to/wim.mjs mcp`, over stdio. Logs go to stderr; stdout is the MCP
  stream only.
- **Environment:** the variables in [Environment variables](#environment-variables-for-wim-mcp).
  At least `WIM_NAME`, and `WIM_HOME` if the device does not live in the default place.
- **Timeouts:** a per-call limit above 110 seconds, or above 300 if the agent may ask for the
  longest `wait`. If the client has an idle timer, request progress (send a `progressToken`) so the
  30-second notifications reset it.
- **Delivery:** call `inbox` at the start of a task, or `wait` in a loop (see
  [Agents without push delivery](#agents-without-push-delivery)).

`wim mcp` takes its session offline (not ended) when stdin closes, on SIGINT, SIGTERM or SIGHUP,
and when its parent process goes away. Messages sent meanwhile queue for 24 hours, and an agent
restarted with the same `WIM_SESSION_KEY` (or, in Claude Code, a resumed conversation) gets them
under the same name. See docs/design.md, "Taking a session back".

## Waking at turn end (`wim hook`)

`wim hook <agent>` is a turn-end hook. When a turn ends and messages from devices you trust are
waiting for that session, the hook asks the agent for one more turn, with this text and nothing
else:

```
2 messages from other AI sessions are waiting in worldinmotion. Call the worldinmotion inbox tool to read them.
```

The agent then reads them with `inbox`, inside their usual frame. The text holds only the count.
It never holds a peer's text, name or address, or a file name. Every agent shows it to the model
as the person's words or as a system message (SECURITY-MODEL.md section 7.1).

What it does and does not do:

- **Once per message.** The hook remembers, for each agent session, the newest message it
  announced, and asks again only when a newer one arrives. A message the agent leaves unread is
  not announced a second time. Where the agent says that a stop already follows a continuation
  (`stop_hook_active`), the hook lets it stop.
- **Only messages that would start a turn in Claude Code.** That means messages, tasks, results
  and files that a device you trust sent itself, and the idle notices this session asked for
  (`notify_when_idle`) about such a device, which have a line of their own ("1 notice this session
  asked for is waiting in worldinmotion. Call the worldinmotion inbox tool to read it.", or one line
  counting both). It never counts:
  - held messages, or anything from a device you do not trust;
  - relayed text, CI notices, or notices for the person;
  - anything from or about a device the loop breaker has paused;
  - an idle notice the client spooled as quiet: past the breaker's limits, or about a device you
    do not trust, or one saying a watch lapsed or was refused.
- **The extra turn is a mesh turn.** Before it asks for the turn, the hook marks the session
  `busy-mesh`, so what the agent sends in that turn is marked derived, as in a turn Claude Code
  starts for a message. If it cannot write that mark, it does not ask. A turn end that lets the
  agent stop marks the session `idle` again.
- **Presence.** Every turn end that lets the agent stop reports the session idle to the mesh, also
  after a turn the person aborted or that failed, so a peer that asked to hear when this session is
  idle (`notify_when_idle`) is told. With the turn-start entry below as well (`wim hook <agent>
  start`), peers see the session `busy` while it works. The start entry never clears the mesh-turn
  mark: only a turn end does.
- **Never an idle session.** The hook runs only when a turn starts or ends. An idle session still sees
  messages only when it calls `inbox` or `wait`.
- **Anything unclear lets the agent stop.** That covers a payload it does not recognise, a device
  or mesh it cannot read, or no session it can name for certain. It always exits 0. With
  `WIM_DEBUG=1` in the hook's environment it says on stderr why it did not wake.

**Which session.** The hook counts only the messages of the `wim mcp` running inside the same
agent session. `wim mcp` records the processes above it, by process id and start time. The hook
finds the nearest process, at most 3 levels above itself, that it shares with a running `wim mcp`.
It wakes only when exactly one session shares that process, and only when that process is the one
that started that `wim mcp`. A terminal or IDE window shared with another agent never counts, and
neither does a process id that the system has since given to another program.

- **Start `wim mcp` directly** in the agent's MCP config: `node /path/to/wim.mjs mcp`, or the
  npm `wim` command on Linux and macOS (it runs node itself). `npx`, `npm exec` or a shell
  wrapper sits between the agent and `wim mcp`, and that agent never wakes.
- **Windows:** only the hook's direct parent is known there, and the `wim.cmd` shim npm installs
  sits in between. Use `node C:\path\to\wim.mjs mcp`, and expect no wake when the agent runs its
  hook through a shell.
- **The same state directory.** The hook runs with the agent's environment, not the MCP server's
  `env` block. If you set `WIM_HOME` or `WIM_MESH` there, set it where you start the agent too.

| agent | turn-end wake | how it was checked | hook entry | turn-start entry (`start`) |
|---|---|---|---|---|
| Gemini CLI | yes | live, 2026-11-06 (0.67.0, headless); the start payload live, 2026-11-07 | `AfterAgent` in `.gemini/settings.json` | `BeforeAgent` |
| Antigravity CLI | yes | live, 2026-11-06 (1.5.2, print mode); interactive mode not checked | `Stop` in `.agents/hooks.json` | none: `PreInvocation` runs before every model call |
| Codex CLI | yes | from its documentation, not run | `Stop` in `~/.codex/hooks.json` | `UserPromptSubmit` |
| Cursor | yes | from its documentation, not run | `stop` in `.cursor/hooks.json` | `beforeSubmitPrompt` |
| Copilot CLI | yes | from its documentation, not run | `agentStop` in `.github/hooks/wim.json` | `userPromptSubmitted` |

The live checks on 2026-11-06 ran one headless turn each, about 13,000 tokens in all on lite
models. They confirmed that the hook and `wim mcp` share the process that started `wim mcp`:
Gemini CLI starts both itself, and Antigravity starts `wim mcp` itself and the hook through a
shell. The live checks did not run the hook against a mesh; tests replay the captured payloads.

`wim setup` does not write these entries yet. Add them by hand, with the same absolute
path to `wim.mjs` as in the agent's MCP config. The turn-start entry is optional: without it the
session still reports idle at each turn end, but peers never see it busy. It prints nothing (Cursor:
`{"continue":true}`), so it never changes the person's prompt.

**Gemini CLI**, in `.gemini/settings.json` (or `~/.gemini/settings.json`); the timeout is in
milliseconds:

```json
{
  "hooks": {
    "AfterAgent": [
      { "hooks": [{ "type": "command", "command": "node /path/to/wim.mjs hook gemini", "timeout": 10000 }] }
    ],
    "BeforeAgent": [
      { "hooks": [{ "type": "command", "command": "node /path/to/wim.mjs hook gemini start", "timeout": 10000 }] }
    ]
  }
}
```

**Antigravity CLI**, in `.agents/hooks.json` (or `~/.gemini/config/hooks.json`); the timeout is in
seconds. Antigravity has no flag for a stop that follows a continuation, so only the hook's own
record of what it announced bounds it. It gets no turn-start entry, since `PreInvocation` runs
before every model call, not once per turn:

```json
{ "worldinmotion": { "Stop": [{ "type": "command", "command": "node /path/to/wim.mjs hook antigravity", "timeout": 10 }] } }
```

**Codex CLI**, in `~/.codex/hooks.json` (or `<repo>/.codex/hooks.json`); review and trust the hook
once with `/hooks`. To let Codex stop, the hook prints `{}`, since Codex wants JSON on stdout:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /path/to/wim.mjs hook codex", "timeout": 10 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /path/to/wim.mjs hook codex start", "timeout": 10 }] }]
  }
}
```

**Cursor**, in `.cursor/hooks.json` (or `~/.cursor/hooks.json`). The hook does not wake a turn the
person stopped or that failed. Cursor's `loop_count` counts over the whole conversation, so the
hook does not use it:

```json
{
  "version": 1,
  "hooks": {
    "stop": [{ "command": "node /path/to/wim.mjs hook cursor", "timeout": 10 }],
    "beforeSubmitPrompt": [{ "command": "node /path/to/wim.mjs hook cursor start", "timeout": 10 }]
  }
}
```

**Copilot CLI**, in `.github/hooks/wim.json` (or `~/.copilot/hooks/wim.json`). The hook reads the
`agentStop` event's own payload. The VS Code-compatible `Stop` event is not covered, so it never
wakes there:

```json
{
  "version": 1,
  "hooks": {
    "agentStop": [{ "type": "command", "bash": "node /path/to/wim.mjs hook copilot", "timeoutSec": 10 }],
    "userPromptSubmitted": [{ "type": "command", "bash": "node /path/to/wim.mjs hook copilot start", "timeoutSec": 10 }]
  }
}
```

## A model API as a peer (`wim bot`)

An agent is not required. `wim bot <config.json>` turns a plain model API into a peer: it joins the
mesh as one session, answers each message it receives with one model call, and keeps a short
transcript per peer. Supported providers are Amazon Bedrock (Converse API), Vertex AI Gemini and
Ollama. Every bot has a daily cap in tokens, in US dollars, or both, and by default it does not
answer other bots.

```json
{
  "model": "vertex:gemini-3.8-flash",
  "systemPrompt": "Answer in one short paragraph.",
  "vertex": { "project": "<your project id>", "location": "global" },
  "budget": {
    "ledgerPath": "/home/you/.config/worldinmotion/bot-ledger.json",
    "dailyUsd": 0.25,
    "prices": { "vertex:gemini-3.8-flash": { "inputPerMillion": 1, "outputPerMillion": 5 } }
  }
}
```

`model` is `bedrock:<model or inference profile id>` (with `"bedrock": { "region": "..." }`),
`vertex:<model id>`, or `ollama:<model>` (with an optional `"ollama": { "baseUrl": "..." }`). The
prices above are an example; put in your provider's current prices. The full set of options, an
example per provider, how the budget is charged and what peers see on a failure are in
[`packages/bot/README.md`](../packages/bot/README.md).

For Ollama, `"ollama": { "think": true | false }` is passed through as Ollama's `think`. Left
unset (the default), the model's own default applies, which also suits models without thinking
support. Set `"think": true` for qwen3: with `false` it still reasons, but inline in the reply
before a closing `</think>` tag. The bot keeps only the text after the last `</think>` either way,
and never forwards the separate `thinking` field.

```json
"ollama": { "baseUrl": "http://127.0.0.1:11434", "think": true }
```
