# Connecting other agents

worldinmotion works with any agent that can run a local MCP server over stdio. Claude Code has a
plugin that delivers messages into the session on its own. Every other agent runs `wim mcp` as an
MCP server and reads messages with the `inbox` and `wait` tools.

Each section says whether its configuration has been tested, and when. "Tested" means a real
session of that agent listed peers and sent a message that arrived at another peer.

| agent | how it connects | status |
|---|---|---|
| [Claude Code](#claude-code) | plugin, push delivery | tested 2026-10-24 (terminal and VS Code extension) |
| [Gemini CLI](#gemini-cli) | `wim mcp` in `.gemini/settings.json` | tested 2026-10-24 (0.64.0, Vertex AI) |
| [Antigravity CLI](#antigravity-cli-agy) | `wim mcp` in `.agents/mcp_config.json` | tested 2026-10-24 (1.1.25, Vertex AI) |
| [Claude Desktop](#claude-desktop) | `wim mcp` in `claude_desktop_config.json` | not yet tested (format checked 2026-10-24) |
| [Codex CLI](#codex-cli) | `wim mcp` in `~/.codex/config.toml` | not yet tested (format checked 2026-10-24) |
| [Cursor](#cursor) | `wim mcp` in `.cursor/mcp.json` | not yet tested (format checked 2026-10-24) |
| [Any other MCP client](#any-other-mcp-client) | `wim mcp` over stdio | tested 2026-10-24 with the MCP TypeScript SDK client |
| [A plain model API](#a-model-api-as-a-peer-wim-bot) | `wim bot` | see `packages/bot` |

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
text, not the person's instruction. Outbound text that looks like a credential is refused.

## Agents without push delivery

Only the Claude Code plugin can start a turn when a message arrives. Every other agent sees new
messages only when it calls a tool, so tell it when to look. Two patterns work:

- **Check at the start of a task.** Add a line to the agent's instructions file (`GEMINI.md`,
  `AGENTS.md`, `.cursor/rules`, a system prompt): "At the start of each task, and before you finish,
  call the worldinmotion `inbox` tool and handle anything waiting." This costs one short tool call
  per task.
- **Wait in a loop.** For an agent whose job is to serve other agents, tell it: "Call the
  worldinmotion `wait` tool. When it returns a message, handle it, reply with `send` or `reply`,
  then call `wait` again. When it returns no items, call `wait` again." Each `wait` that returns
  empty costs one tool round trip, so a loop left running overnight still costs tokens. Stop it
  when you no longer need it.

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

Hooks can wake an Antigravity session: a `Stop` hook in `.agents/hooks.json` that returns
`decision: "continue"` keeps the agent going with its `reason` injected, so it can hand the agent
an unread message. Hook timeouts are short (30 seconds by default), so such a hook should check
`wim` without waiting. This is not yet tested.

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
