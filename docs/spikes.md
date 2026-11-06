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

## Wake at turn end: other agents (2026-11-06)

Only Claude Code wakes on a message today. A planned `wim hook <agent>` would run at an agent's
turn end and, when trusted peers have messages waiting, tell the agent how many there are and that
it should call the `inbox` tool. It never carries peer text or peer-chosen names. These spikes
record what such a hook can rely on in each agent.

Gemini CLI and Antigravity CLI were run live on Vertex AI (Application Default Credentials, a
lite model, a throwaway home directory) with a probe hook that saved its input and answered a
fixed line. Codex CLI, Cursor and Copilot CLI are **docs only, not run**: everything for them
comes from their official documentation as read on 2026-11-06.

Each agent is asked the same five questions:

1. Can a hook at turn end make the agent take another turn, and with what output?
2. How is the hook's text labelled for the model?
3. What is the loop guard, and how many continuations does it allow?
4. Is there a supported way to wake an IDLE session (no turn running)?
5. Where and how is the hook configured, and what is the timeout?

| agent | version | how | turn-end wake | output | label | loop guard | idle wake |
|---|---|---|---|---|---|---|---|
| Gemini CLI | 0.67.0 | live, headless | yes | `AfterAgent` `{"decision":"deny","reason":…}` | a plain user message | `stop_hook_active`; no hook cap below the session's turn budget | none |
| Antigravity CLI | 1.4.7 | live, headless and interactive | yes | `Stop` `{"decision":"continue","reason":…}` | a system message, framed as not sent by the user | none in the input; a hard cap of 10 (observed, undocumented) | internal only, not reachable |
| Codex CLI | not stated | docs only, not run | yes | `Stop` `{"decision":"block","reason":…}` | a new user prompt | `stop_hook_active`; no cap documented | app-server `turn/start`, for threads that app-server runs |
| Cursor | not stated | docs only, not run | yes | `stop` `{"followup_message":…}` | the next user message | `loop_count`; `loop_limit`, default 5 | none documented |
| Copilot CLI | not stated | docs only, not run | yes | `agentStop` `{"decision":"block","reason":…}` | the next turn's prompt (label not stated) | `stop_hook_active`; a hard cap of 8 | none documented |

The captured hook inputs are in `test/fixtures/hooks/<agent>/`, with paths and ids replaced by
placeholders.

### Gemini CLI (0.67.0, live)

- **Wake.** Yes. An `AfterAgent` hook that prints `{"decision":"deny","reason":"<text>"}` (or exits 2
  with the text on stderr) makes Gemini CLI send `<text>` as a new request in the same prompt. In
  the test the hook asked for three continuations and got three.
- **Label.** None. The text goes to the model as a plain `user` message, exactly as written. In
  the session transcript the row is `type: "user"` with the reason as its content, and the
  person's original prompt kept only as its display text. The model cannot tell it from the person.
- **Loop guard.** `stop_hook_active` is `false` on the first call and `true` on every call made
  after a continuation. There is no separate cap on hook continuations: each one is a new request
  inside the same prompt and draws on that prompt's turn budget (100 in the source; not run to
  the limit). A hook that always denies loops until that budget runs out.
- **Idle.** No hook or command starts a turn in an idle interactive session. `gemini --acp`
  serves the Agent Client Protocol to the client that launched it, not to a session already running
  in a terminal.
- **Config.** `hooks.AfterAgent[].hooks[]` in `settings.json` (`~/.gemini/settings.json`, or
  `.gemini/settings.json` in the project), each `{ "type": "command", "command": …, "timeout": … }`.
  The timeout is in milliseconds, default 60,000. Hooks are on by default.
- **Input.** `prompt` stays the person's original prompt on every call. `prompt_response` grows
  across continuations and in the test held repeated fragments of earlier output, so a hook must
  not parse it.

### Antigravity CLI (1.4.7, live)

- **Wake.** Yes. A `Stop` hook that prints `{"decision":"continue","reason":"<text>"}` re-enters
  the loop. It worked in print mode (`agy -p`) and in an interactive session.
- **Label.** A system message that tells the model the person did not send it:

  ```
  The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.

  <SYSTEM_MESSAGE>
  Stop hook blocked termination: <text>
  </SYSTEM_MESSAGE>
  ```

  The framing gives the text the weight of a system instruction, so it must carry nothing a peer
  wrote.
- **Loop guard.** The input has no `stop_hook_active`. `executionNum` counts the calls in one
  prompt (0, 1, 2, …). With a hook that always answered `continue`, the run stopped after 10
  continuations: the hook was called an 11th time (`executionNum` 10), its `continue` was ignored,
  and the run ended normally. The cap is not in the documentation.
- **Idle.** No supported way. The binary has an `agentapi` subcommand (`send-message`,
  `new-conversation`, `get-conversation-metadata`) that `agy --help` does not list and the public
  documentation does not describe. Run from outside the agent it refuses (`ANTIGRAVITY_LS_ADDRESS
  is not set`), and pointed at the session's local port it asks for a CSRF token. Neither a hook's
  environment nor an MCP server's carries these: a hook sees only `ANTIGRAVITY_CONVERSATION_ID`,
  and an MCP server sees no `ANTIGRAVITY_*` variable at all.
- **Config.** `~/.gemini/config/hooks.json` (every workspace) or `.agents/hooks.json` (one
  workspace), keyed by a hook name: `{ "<name>": { "Stop": [{ "type": "command", "command": …,
  "timeout": … }] } }`. The timeout is in seconds, default 30. Hooks in
  `~/.gemini/antigravity-cli/settings.json` are not loaded.
- **Input.** The real payload differs from the documentation: it is camelCase, carries
  `conversationId`, `lastUserInput`, `modelName`, `transcriptPath` and `workspacePaths`, and the
  `terminationReason` for a reply with no tool call is `NO_TOOL_CALL` (the documentation's example
  is `model_stop`). `fullyIdle` was `true` on every call in the test.
- `PostInvocation` can also force the loop on (`terminationBehavior: "force_continue"`); not tried.

### Codex CLI (docs only, not run)

- **Wake.** Yes. A `Stop` hook prints `{"decision":"block","reason":"<text>"}` or exits 2 with the
  text on stderr. Plain text on stdout is invalid for `Stop`.
- **Label.** The documentation says Codex "creates a new continuation prompt that acts as a new
  user prompt" with the reason as its text.
- **Loop guard.** `stop_hook_active` in the input ("whether this turn was already continued by
  `Stop`"). No cap is documented.
- **Idle.** `codex app-server` (JSON-RPC over stdio, documented) has `turn/start`, which adds user
  input to a thread and starts a turn, and `turn/steer`, which adds input to a turn in progress.
  Both act on threads that app-server process runs or resumes. The documentation does not describe
  reaching a session that is running in a separate terminal UI.
- **Config.** `~/.codex/hooks.json` or `[hooks]` in `~/.codex/config.toml`, and the same files under
  `<repo>/.codex/`. Hooks are on by default, but each non-managed hook must be reviewed and trusted
  first (`/hooks`). The timeout is in seconds, default 600.

### Cursor (docs only, not run)

Cursor's agent runs in a desktop app, so it was not run here.

- **Wake.** Yes. A `stop` hook prints `{"followup_message":"<text>"}`, and Cursor "will automatically
  submit it as the next user message".
- **Label.** The next user message.
- **Loop guard.** `loop_count` in the input counts the follow-ups already made in the conversation.
  `loop_limit` on the hook caps them, default 5; `null` removes the cap.
- **Idle.** None documented.
- **Config.** `~/.cursor/hooks.json` or `<project>/.cursor/hooks.json` (also enterprise and team
  levels): `{ "version": 1, "hooks": { "stop": [{ "command": …, "timeout": …, "loop_limit": … }] } }`.
  The timeout is in seconds; the default is given only as the platform default. The documentation
  does not say whether `stop` runs in the Cursor CLI.

### Copilot CLI (docs only, not run)

- **Wake.** Yes. An `agentStop` hook prints `{"decision":"block","reason":"<text>"}`, which "forces
  another agent turn using `reason` as the prompt".
- **Label.** The documentation calls it the prompt for the next turn and says nothing more.
- **Loop guard.** `stop_hook_active` in the input, and a hard cap: "After 8 consecutive `block`
  continuations, the CLI overrides the hook and ends the turn anyway."
- **Idle.** None for an outside caller. A `notification` hook's `additionalContext` "is injected into
  the session as a prepended user message" and "can trigger further agent processing if the session
  is idle", but that hook runs only when the CLI raises a notification.
- **Config.** `.github/hooks/*.json` in the repository, or `~/.copilot/hooks/*.json`
  (`$COPILOT_HOME/hooks/` when set): `{ "version": 1, "hooks": { "agentStop": [{ "type": "command",
  "bash": …, "timeoutSec": … }] } }`. The timeout is in seconds, default 30.

### What this means for `wim hook`

- **The wording is read as the person (Gemini CLI, Codex, Cursor) or as the system (Antigravity).**
  Nowhere is it labelled as a hook. The hook's text must therefore be fixed and self-describing: a
  count of waiting messages, the fact that they come from other AI sessions, and the instruction to
  call `inbox`. Never peer text, never a peer-chosen name.
- **Block only for news.** Every agent will keep continuing as long as the hook asks, up to a cap of
  5, 8, 10 or about 100 depending on the agent. The hook should continue only when there are
  messages it has not yet announced for that session, and remember what it announced, rather
  than rely on `stop_hook_active` (Antigravity has none).
- **One session key per agent:** `session_id` (Gemini CLI, Codex), `conversationId` or the
  `ANTIGRAVITY_CONVERSATION_ID` variable (Antigravity), `conversation_id` (Cursor), `sessionId`
  (Copilot CLI).
- **Input field names differ** (snake_case for Gemini CLI, Codex and Cursor; camelCase for
  Antigravity and Copilot CLI), and Antigravity's real payload differs from its documentation, so
  the hook's contract tests replay the captured fixtures rather than the documented shapes.
- **An idle session still does not wake.** A turn-end hook only fires when a turn ends. None of the
  agents has a documented way for an outside process to start a turn in a session already running
  in a terminal; Codex app-server reaches only threads it runs itself. Idle sessions stay pull.
