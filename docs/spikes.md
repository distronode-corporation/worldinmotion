# Spikes: what Claude Code lets a plugin do

Before building the Claude Code plugin, each primitive it depends on was tried against a real
interactive Claude Code session (v2.1.310, Linux) with a throwaway probe plugin loaded through
`claude --plugin-dir`. The probe carried a hooks module (a "mod"), a stdio MCP server and a skill.
These are the results the plugin design rests on. Re-run them when Claude Code changes the mod API.

| # | question | result |
|---|---|---|
| S1 | Can a mod start a turn in an idle session? | **Yes.** `$.prompt.submit({ text })` from a `$.clock.every` callback starts a turn. The model reads it as "The `<plugin>` plugin sent a message: ..." followed by a note that the plugin, not the person, submitted it. In the test, the gap from the file landing to the turn starting was about a second (one poll period). |
| S2 | Can a mod hand the model a message while a turn is running? | **Yes, two ways.** `$.session.append({ message: { type: "user", content: [text] } })` stores a meta user row that the model reads at its next request inside the running turn (for example, right after the tool that was running returns). A `classic.PostToolUse` hook that adds `additionalContext` also works, but only once a tool finishes, and the model sees it labelled as hook output. Append is the one to use. An appended row does **not** wake an idle session, so the plugin uses append while busy and submit while idle. |
| S2b | Can a mod deliver into its own session through `$.session.send`? | **No.** A send addressed to the session's own id is refused ("no live session on this machine has id ..."). |
| S3 | Can a mod call its own MCP server without spending tokens or raising prompts? | **Tokens: yes.** The model never sees these calls. **Prompts: it depends where the call is made.** A call made inside a hook dispatch goes through the mod's own `tool.check` hook, which can allow it: the call's `tool_use_id` starts with `toolu_plugin_`, which a model's call never does. A call made from a `$.clock` callback skips the mod's own `tool.check` and raises a normal permission prompt unless a permission rule allows the tool. |
| S3b | Can a mod poll the file system from a timer without prompts? | **Yes.** `$.fs.list` and `$.fs.read` on an absolute path, and `$.fs.write` of a small cursor file, ran from a `$.clock.every` callback with no prompt and no permission rule. `$.fs` has no delete. |
| S4 | Can one plugin carry a mod, an MCP server and a skill? | **Yes.** `.claude-plugin/plugin.json`, `hooks/hooks.json` naming a `register.ts`, `.mcp.json` with `${CLAUDE_PLUGIN_ROOT}` in the server path, and `skills/<name>/SKILL.md` load together and pass `claude plugin validate`. The plugin's MCP server is named `plugin:<plugin>:<server>`, and its tools are `mcp__plugin_<plugin>_<server>__<tool>`. The validator requires any helper that receives `$` to be a top-level function. |
| S5 | Do Durable Objects work on the relay's Cloudflare account? | **Expected yes**, from the account's plan and the Durable Objects API answering. To be proven by the first deploy. |
| S7 | Can the model's own SendMessage tool reach a remote `name@device`? | **Only through `tool.call`.** The SendMessage tool validates `to` before any `session.send` hook runs and refuses `name@device` ("to must be a bare teammate name"). A `tool.call` hook on `SendMessage` runs before that validation: it can take the call and answer `{ result, text }` without `next`, and the model reads the answer as the tool's result. |
| S6 | Two Claude accounts on one machine through `CLAUDE_CONFIG_DIR` | **Not run.** It needs a second interactive login. The acceptance test uses two machines on two accounts instead, which covers the same path. |

## What this means for the plugin

- **SendMessage bridge:** a `tool.call` hook on `SendMessage` (not `session.send`) takes calls whose
  `to` is a mesh address and answers them itself; `session.send` stays hooked only for other
  plugins' `$.session.send` calls.

- **Inbound:** the local client (the MCP server process) writes each verified message to a spool
  directory for its session. The mod polls that directory with `$.fs` once a second and delivers
  each new file with `$.session.append` while the session is busy and `$.prompt.submit` while it is
  idle. It writes the name of the last file it delivered to a cursor file, and the client deletes
  everything up to it.
- **Handshake:** on `session.start` the mod calls the MCP server once (inside the hook, so its own
  `tool.check` allows it) to learn the spool path for this session.
- **Busy and idle:** `turn.start` and `turn.complete` hooks with no `agentId` (the main loop only)
  track state and report presence. A message appended in the last moments of a turn may not be read
  until the next turn, so on `turn.complete` the mod re-delivers, with `$.prompt.submit`, anything it
  appended after the turn's last model request started.
- **Framing:** an appended row has no label, so the text the mod writes always starts with a header
  saying it is a message from another AI session through worldinmotion, not from the person.
- **Hooks see the mod's own MCP calls:** `classic.PostToolUse` fires for them too, so any hook that
  acts on tool results skips calls whose `tool_use_id` starts with `toolu_plugin_`.
- **Module state resets on reload:** a hot reload runs `register` again and clears the module's own
  variables, so durable values (the cursor, the spool path) live in files or `$.state`.
