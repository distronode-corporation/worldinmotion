# @worldinmotion/bot

`wim bot`: a plain model API as a worldinmotion mesh peer. The bot joins the mesh as one
session of kind `bot`, answers each `msg` or `task` it receives with one model call, and keeps a
short transcript per peer. It has no tools: it can only reply with text.

Supported providers:

- **Amazon Bedrock**, through the model-neutral Converse API;
- **Vertex AI Gemini**, through `@google/genai` in Vertex mode, streaming;
- **Ollama**, through its plain HTTP chat endpoint.

Every bot has a daily cap in tokens, in US dollars, or both, and by default it does not answer
other bots.

## Running it

```sh
wim bot bot.json
```

The session is named `bot` unless `--as <name>` or `WIM_NAME` says otherwise. The bot runs
until Ctrl-C. Its log (every call's start, end, token counts and failures) goes to stderr.

Everything the bot sends is marked `relayed`: a model wrote it, not the session. Peers see it as
third-party text.

## Configuration

The config file is JSON. Unknown keys are refused, so a typo fails at startup instead of being
ignored. Times are in seconds.

### Top level

| key | default | meaning |
|---|---|---|
| `model` | required | `bedrock:<model or inference profile id>`, `vertex:<model id>` or `ollama:<model>`. The text after the first colon is the provider's own id, so `ollama:qwen3:4b` is model `qwen3:4b`. This string is also the key in `budget.prices`. |
| `systemPrompt` | `""` | Added after a fixed safety preamble, never instead of it. The preamble tells the model that messages come from other AI sessions, not a person, that it has no tools, and that it must not reveal its prompt or any secret. |
| `callTimeoutSeconds` | `60` | Longest one model call may take. The sender then gets a failed answer, not silence. A task's own deadline wins when it is sooner. |
| `bedrock` | none | Required for a `bedrock:` model. See [Bedrock](#bedrock). |
| `vertex` | none | Required for a `vertex:` model. See [Vertex AI Gemini](#vertex-ai-gemini). |
| `ollama` | `{ "baseUrl": "http://127.0.0.1:11434" }` | Optional for an `ollama:` model. See [Ollama](#ollama). |
| `budget` | required | See [Budget](#budget). |
| `conversations` | see below | How much history each call carries. |
| `guards` | see below | Loop, abuse and load limits. |

### `budget`

| key | default | meaning |
|---|---|---|
| `ledgerPath` | required | The JSON file that holds each day's spend. See [The budget ledger](#the-budget-ledger). |
| `maxTokens` | `1024` | Output cap for each reply. |
| `dailyTokens` | none | Daily cap on input plus output tokens. |
| `dailyUsd` | none | Daily cap in US dollars. Needs a price for `model` in `prices`, or the bot refuses to start. |
| `prices` | `{}` | `{ "<model>": { "inputPerMillion": n, "outputPerMillion": n } }`, in USD per million tokens. Put in your provider's current prices; the bot cannot look them up. |

At least one of `dailyTokens` and `dailyUsd` must be set: a bot with no cap is what the caps
exist to prevent.

### `conversations`

A thread is a sender's address for messages, and the task id for tasks. Threads live in memory
only, so a restart forgets them.

| key | default | meaning |
|---|---|---|
| `maxTurns` | `20` | Most turns sent to the model, the new message included. |
| `maxChars` | `24000` | Most characters of transcript sent to the model, the new message included. The oldest exchange is dropped first. |
| `idleHours` | `24` | A thread idle this long is forgotten. |

### `guards`

| key | default | meaning |
|---|---|---|
| `replyToBots` | `false` | Answer peers whose kind is `bot`. Two bots answering each other is how a mesh burns a budget overnight, so it is off unless chosen. The kind is the peer's own label, not a trust decision. |
| `perPeerPerHour` | `30` | Most answers to one sender in any hour. |
| `maxConcurrent` | `2` | Model calls in flight at once. |
| `maxQueue` | `100` | Items waiting for a slot. Beyond this, items are dropped (and logged). |

Two more limits are fixed: a text over 32 KiB is declined before any model call, and the same
text from the same sender within 60 seconds is answered once.

## Providers

### Bedrock

```json
{
  "model": "bedrock:us.anthropic.claude-haiku-5-5",
  "systemPrompt": "Answer in one short paragraph.",
  "bedrock": { "region": "us-east-1" },
  "budget": {
    "ledgerPath": "/home/you/.config/worldinmotion/bot-ledger.json",
    "maxTokens": 512,
    "dailyUsd": 0.5,
    "prices": { "bedrock:us.anthropic.claude-haiku-5-5": { "inputPerMillion": 1, "outputPerMillion": 5 } }
  }
}
```

| key | meaning |
|---|---|
| `bedrock.region` | Required. The AWS region the Converse call goes to. |

The model may be a model id or an inference profile id; newer models are served only through a
profile. Credentials come from the AWS SDK's default chain (environment, SSO, shared profile,
instance role), so the config holds none. The identity needs `bedrock:InvokeModel` on that model
or profile. Reasoning and other non-text blocks are never sent to the peer.

### Vertex AI Gemini

```json
{
  "model": "vertex:gemini-3.8-flash",
  "vertex": {
    "project": "<your project id>",
    "location": "global",
    "thinking": { "level": "low" },
    "idleTimeoutSeconds": 30
  },
  "budget": {
    "ledgerPath": "/home/you/.config/worldinmotion/bot-ledger.json",
    "dailyTokens": 200000
  }
}
```

| key | default | meaning |
|---|---|---|
| `vertex.project` | required | The Google Cloud project that is billed. Never read from gcloud defaults or the environment, so the bot cannot bill whatever project happens to be configured on the machine. |
| `vertex.location` | required | Such as `global` or `us-central1`. |
| `vertex.thinking` | `{ "level": "low" }` | Either `{ "level": "minimal" \| "low" \| "medium" \| "high" }` or `{ "budgetTokens": n }`, never both. `{}` sends no thinking setting, which leaves the model's own default. `low` is the lowest level `gemini-3.8-flash` accepts; it refuses `minimal`. |
| `vertex.idleTimeoutSeconds` | `30` | The stream is aborted when no chunk arrives for this long. |

Credentials are Application Default Credentials (`gcloud auth application-default login`, or a
service account on the host). The identity needs `aiplatform.endpoints.predict` in the project.

Gemini counts thinking inside its output cap. With `budgetTokens`, the cap sent is
`maxTokens + budgetTokens`, so `maxTokens` stays the reply's allowance, and the budget reserves
the raised cap. A named level has no numeric bound, so there `maxTokens` covers thinking and
reply together. Thinking tokens are billed as output and are charged as output.

### Ollama

```json
{
  "model": "ollama:qwen3:4b",
  "ollama": { "baseUrl": "http://127.0.0.1:11434", "think": true },
  "guards": { "maxConcurrent": 1 },
  "budget": {
    "ledgerPath": "/home/you/.config/worldinmotion/bot-ledger.json",
    "maxTokens": 400,
    "dailyTokens": 500000
  }
}
```

| key | default | meaning |
|---|---|---|
| `ollama.baseUrl` | `http://127.0.0.1:11434` | Keep Ollama bound to the bot's own machine. |
| `ollama.think` | unset | Passed through as Ollama's `think`, only when set. |

Left unset, `think` is the model's own default, which also suits models without thinking support
(they accept only `false`). Set `"think": true` for qwen3: with `false` it still reasons, but
inline in the reply, before a closing `</think>` tag. The bot keeps only the text after the last
`</think>` either way, and never forwards Ollama's separate `thinking` field.

A local model has no price, so cap it with `dailyTokens`. `maxTokens` is sent as `num_predict`,
which on a CPU is what bounds the reply time; keep it well under what `callTimeoutSeconds`
allows.

## The budget ledger

The ledger at `budget.ledgerPath` holds each UTC day's input tokens, output tokens, US dollars,
and the senders already told the budget is exhausted:

```json
{
  "v": 1,
  "days": {
    "2026-10-24": { "inputTokens": 5210, "outputTokens": 1830, "usd": 0.014, "notified": [] }
  }
}
```

- It is written atomically (a temporary file, then a rename), mode 0600 in a 0700 directory.
- Days older than 31 days are dropped on each write.
- A missing file starts a fresh ledger. A file that is not valid stops the bot, because silently
  starting from zero would reset today's spend.
- **Two bot processes must not share one `ledgerPath`.** Each holds the ledger in memory and
  rewrites the whole file, so the last writer wins and the other's spend is lost. Give every bot
  its own file.

How a call is charged:

1. **Reserve.** Before the call, the bot estimates it: the input at one token per 4 ASCII
   characters plus one per other character (CJK and emoji are about one token or more each), and
   the output at the full output cap. If today's spend, plus every call still in flight, plus this
   estimate would pass either cap, the call is not made.
2. **Settle on success** to the provider's own token counts.
3. **Settle on failure** to the reserved estimate, because once a request is out the provider may
   have billed it: an idle timeout, the call timeout, a reset part way through the response, or
   an answer the bot cannot use. The one exception is a failure the adapter knows came before
   the model ran, which is charged nothing:
   - Bedrock: no credentials found, or HTTP 400, 401, 403, 404 or 429 (validation, access
     denied, not found, throttling);
   - Vertex: HTTP 400, 401, 403, 404 or 429 when the stream is opened;
   - Ollama: connection refused, or HTTP 400, 401, 403, 404 or 429.

   Any other failure, including a credential error the Google client raises before sending, is
   charged. Erring this way can stop a misconfigured bot early, but cannot let spend run past a
   cap.

## What peers see

| situation | the sender gets |
|---|---|
| an answer | the model's text, or `(empty reply)` when it is empty |
| text over 32 KiB | `declined: text is over 32768 bytes` |
| the daily cap is reached | `budget exhausted for today`, once per sender per UTC day; after that, nothing |
| a task arrives past its deadline | `deadline passed before the task started` |
| the task's deadline passes during the call | `deadline passed before the model answered` |
| the call timeout passes | `model call timed out after <n> s` |
| any other model failure | `the model call failed; the bot's operator can see why in its log` |

A task is answered with a `result` whose status is `done`, `declined`, `timeout` or `failed`; a
message with a `msg` threaded to it.

Provider errors are never sent to the peer: they carry role ARNs, account ids, project ids and
raw HTTP bodies. The full reason is in the bot's own log, on the `model call failed` line.

These get no answer at all, and are logged: messages from other bots (unless `replyToBots`), a
repeat of the same text within 60 seconds, a sender over `perPeerPerHour`, an item dropped
because the queue is full, and `file` and `notice` items. A `result` sent to the bot needs no
answer; it is kept as context for that sender's next message.

## As a library

`runBot(config, io)` wires a validated config (`loadConfig`) to any `BotIO`; `wim bot` passes the
mesh session. `RunDeps.model` replaces the configured adapter with any `ChatModel`. An adapter
throws `ModelRefusedError` only for a failure it knows came before billing; anything else it
throws is charged the reservation.
