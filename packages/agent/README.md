# @worldinmotion/agent

`wim agent`: a worldinmotion peer that sleeps until a message arrives, decides whether the
sender may wake it, runs one agent job through a runner command, and replies with the answer.

- **Who may wake it** is a list of device ids from the signed roster, never names. By default the
  person's own trust for the device (`wim devices trust`) is needed too.
- **An optional wake code**: a shared secret the message must start with. The worker can check it
  itself, or leave it to the runner so the worker's OS user never holds it.
- **An optional profile prefix** (`a: ...`, `b: ...`) picks one of a configured set of accounts or
  settings.
- **One job at a time**, through a runner: any program that reads one JSON request on stdin and
  prints the answer (see [The runner contract](#the-runner-contract)). The package ships one, the
  built-in Claude Agent SDK runner, with read-only tools by default.
- **Limits**: task length, attempts per device per hour, jobs per day, a job timeout.
- **wim's loop and cost breaker** applies as for every session, and the worker never acts on
  relayed text (another model's output), so two agents cannot drive each other.
- **Replies are marked relayed**, like `wim bot`'s: a model wrote them, not the session. An
  optional room copy carries the answer only.
- **Nothing of a message on disk**: the worker's session keeps no message text in its spool,
  history or held items, and its log names ids, devices and reasons, never a text or a code.

Read [Security model](#security-model) before you run one.

## Setting it up

1. **Give the worker its own device.** Run it as its own OS user (see
   [Running it as its own user](#running-it-as-its-own-user)) and join the mesh from that user:
   `wim join <code>` once, approved on an admin device. A worker on a device of yours that is
   also used for other things shares that device's keys with everything else on it.
2. **List who may wake it.** On any device, `wim devices` prints `name  role  id  policy` rows.
   Put the ids (22 characters) of the devices allowed to wake the worker in `senders.devices`.
3. **Trust those devices on the worker's device**, from the worker's user:
   `wim devices trust <name>` for each, since `senders.requireTrusted` is on by default.
4. **Trust the worker's device for relayed text on each sending device**:
   `wim devices trust <worker device name> --relayed`. The worker's replies are marked relayed,
   and a device trusted only plainly holds relayed messages for approval, so without this the
   answers wait in `wim held` instead of arriving.
5. **Write a config** (below) and a runner config, and start it:

```sh
wim agent serve agent.json --as agents
```

The session is named `worker` unless `--as <name>` or `WIM_NAME` says otherwise. It runs until it
is stopped; its log goes to stderr. Then, from an allowed device:

```sh
wim send agents@<worker device> "list the TODO comments in src/"
```

`wim agent init` writes a starting config, `wim agent doctor` checks one, and
`wim agent run --once` runs one job from a request on stdin, without the mesh.

## Configuration

JSON. Unknown keys are refused, so a typo fails at startup. Times are in seconds.

```json
{
  "senders": { "devices": ["Xq3...22 characters...", "Lm9...22 characters..."] },
  "wake": { "mode": "local", "codeFile": "/etc/wim-agent/wake-code" },
  "profiles": { "allowed": ["a", "b"], "default": "a" },
  "runner": {
    "command": "/usr/local/bin/wim",
    "args": ["worker", "runner", "--config", "/etc/wim-agent/runner.json"]
  },
  "limits": { "ledgerPath": "/var/lib/wim-agent/ledger.json", "dailyJobs": 50 },
  "replies": { "refused": "generic", "room": "#agents" }
}
```

| key | default | meaning |
|---|---|---|
| `senders.devices` | required | Device ids (from `wim devices`) allowed to wake the worker. At least one. |
| `senders.requireTrusted` | `true` | Also require the person's trust for the device, read again for each message, so `wim devices untrust` stops the worker at once. |
| `wake.mode` | required | `local`: the worker reads the code, checks it in constant time and strips it. `runner`: the worker holds no code; the raw text goes to the runner, which checks it (and parses any profile prefix, which follows the code). `none`: no code; the allow-list is the only key. |
| `wake.codeFile`, `wake.codeEnv` | none | Where a `local` code is: exactly one of a file or an environment variable. The code is one word, no whitespace. |
| `profiles.allowed`, `profiles.default` | none | Profile names a task may start with as `<name>: `. Not allowed with `wake.mode` `runner`. |
| `runner.command` | required | The runner: an absolute path, or a name on `PATH`. |
| `runner.args` | `[]` | Fixed arguments. Nothing from a message is ever put on a command line. |
| `runner.timeoutSeconds` | `1800` | Longest a job may take. A task's own deadline wins when sooner. With the privileged runner, set it above that runner's lock wait plus its own timeout plus grace (`wim agent init` writes 2760), or a job still queued behind the lock is killed. |
| `runner.killGraceSeconds` | `15` | After the timeout, SIGTERM goes to the runner's process group, then SIGKILL this much later. |
| `runner.passEnv` | `PATH HOME LANG LC_ALL TZ TMPDIR ANTHROPIC_API_KEY` | The only environment variables the runner inherits. Never the wake code's. |
| `runner.logStderr` | `true` | Copy the runner's stderr to the worker's log, 500 characters a line at most. |
| `limits.ledgerPath` | required | A JSON file holding today's job count, so a restart does not reset the daily cap. |
| `limits.maxTaskChars` | `16000` | Longest message accepted. |
| `limits.perSenderPerHour` | `20` | Attempts per device in any rolling hour, refused ones too, so a code cannot be guessed at speed. |
| `limits.dailyJobs` | `50` | Jobs started per UTC day, across all senders. A job counts when it starts. |
| `replies.refused` | `generic` | What an allowed device hears when its code or profile is refused: `not accepted`, or nothing (`silent`). A device not on the list never hears anything. |
| `replies.room` | none | A room that also gets each answer. The copy is the answer only: never the task, the raw text or the code. |

### The message format

```
[<wake code> ][<profile>: ]<task>
```

- With `wake.mode` `local`, the first word must be the code.
- With profiles configured, a first word of profile shape followed by a colon and whitespace is a
  prefix. An allowed one is used; any other is refused rather than run under the default, so
  `c: ...` with a typo never runs on the wrong account. Text without one runs under the default.
  `see https://example.com` is not a prefix (no whitespace after the colon).

### What the sender hears

| case | reply (`msg`, or `result` with this status for a task) |
|---|---|
| device not on the list, not trusted, relayed text, a `result` or a `file` | nothing |
| over `maxTaskChars` | `declined: the task is over N characters` (`declined`) |
| wrong code or profile, or the runner exits 3 | `not accepted` (`declined`), or nothing with `silent` |
| no task after the code and prefix | `declined: the message holds no task` (`declined`) |
| over the hourly limit, another job running, or the runner exits 4 | `busy: ...` (`declined`) |
| the daily cap reached | `declined: today's job limit is reached` (`declined`) |
| the answer | the runner's stdout (`done`), cut at 64 KiB with a note |
| timeout, or the runner exits 5 | `the job timed out` (`timeout`) |
| any other exit | `the job failed; the worker's operator can see why in its log` (`failed`) |

## The runner contract

A runner is any program. The worker starts one per job, in its own process group:

- **Invocation**: `<runner.command> <runner.args...>`. No message content is ever on argv.
- **stdin**: one JSON object, UTF-8, at most 1 MiB + 8 KiB:

  ```json
  {"v":2,"id":"<message id>","from":{"device":"<device id>","address":"<name@device>"},"profile":"<prefix or empty>","text":"<task>","frame":{ "...": "the signed send frame" }}
  ```

  `text` is the raw text, wake code included, when the worker holds no code (`wake.mode`
  `runner`). `from.device` is the id that signed the message; `from.address` is the sender's
  chosen name, for display only. `frame` is the signed `send` frame the message arrived in
  (SPEC.md), so a runner that does not trust the worker (one under another OS user) can verify the
  signature against the roster, open the box with the device's keys and compare it with `text`,
  `id` and `from`, and keep its own replay record. It is absent for an item that has none.
- **stdout**: the answer, UTF-8, at most 64 KiB (the worker cuts a longer one and says so).
- **stderr**: log lines for the operator. Never put the task, a code or a key there.
- **Exit code**: `0` answered; `3` refused (bad code, profile or sender); `4` busy or
  rate-limited; `5` timed out; anything else failed.
- **Timeout**: the worker sends SIGTERM to the process group, then SIGKILL after
  `killGraceSeconds`. A runner started through `sudo` keeps root-owned processes the worker cannot
  signal (EPERM, logged); such a runner should enforce its own, shorter timeout and exit 5.

## The built-in runner

`wim agent runner` runs one job through the
[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). `wim` does not
carry the SDK (it is large, with a native Claude Code build per platform), so install it next to
`wim`:

```sh
npm install --global worldinmotion @anthropic-ai/claude-agent-sdk
```

For keyless authentication, profiles mapped to separate accounts and a code check under another
OS user, use the privileged runner instead (`wim agent privileged`, see
[docs/privileged-runner.md](docs/privileged-runner.md)).

From a checkout of this repository, `node packages/agent/src/bin.ts` (`wim-agent-runner`) is the
same runner.

It authenticates with an Anthropic API key from `ANTHROPIC_API_KEY` or `keyFile`. Its config
(`--config <file>`, optional):

| key | default | meaning |
|---|---|---|
| `model` | `claude-opus-5-5` | The model. |
| `effort` | `medium` | `low`, `medium`, `high`, `xhigh` or `max`. |
| `tools` | `read-only` | `read-only` (Read, Grep, Glob), `none`, or a list of Claude Code tool names. |
| `cwd` | the runner's directory | The directory the tools see. |
| `maxTurns` | `30` | Agent turns per job. |
| `maxBudgetUsd` | none | The SDK stops a job past this spend, by its own estimate. |
| `keyFile` | none | A file holding the API key, instead of `ANTHROPIC_API_KEY`. |
| `systemPrompt` | `""` | Added after the runner's fixed instructions, never instead of them. |
| `claudeCodePath` | none | A Claude Code executable to use instead of the one the SDK's platform package ships. |
| `profiles` | `{}` | `{ "<name>": { "model", "effort", "keyFile" } }` overrides. A request naming a profile not listed is refused (exit 3). |

Every job runs with no user, project or local settings, hooks, `CLAUDE.md` or MCP servers from
the machine (`settingSources: []`, `strictMcpConfig`), no saved session, and
`permissionMode: "dontAsk"`: a tool not listed is denied, never asked about, because nobody is
there to ask. Its environment is the key plus `PATH`, `HOME`, `LANG`, `TZ` and `TMPDIR`. The
prompt names the sender and tells the model the task came over the mesh, so it is a request, not
its operator's instructions.

### Turning tools on

`read-only` lets a message read anything under `cwd` that the runner's OS user can read, and
nothing else. Listing `Bash`, `Edit`, `Write` or any other tool that changes things means **any
allowed device, and anyone holding the code, can run commands or change files on this machine as
the runner's user**, and so can text the model reads while it works (a file, a web page, a tool's
output) that talks it into doing so. Turn them on only for a runner whose user owns nothing you
would mind losing, in a directory made for it, with `maxBudgetUsd` set.

## Running it as its own user

The worker and its runner should run as a user that exists for them: no login shell, no other
files, nothing in its home but the worker's state. `docs/deploy.md` is the full guide (a
privileged runner, sudoers, blocking cloud metadata endpoints). The short form, for the built-in
runner on Linux with systemd:

```sh
sudo useradd --system --home-dir /var/lib/wim-agent --shell /usr/sbin/nologin wim-agent
sudo install -d -o root -g root -m 0755 /etc/wim-agent
# worker.json and runner.json in /etc/wim-agent, root-owned, 0644; the key file 0640 root:wim-agent
sudo -u wim-agent env WIM_HOME=/var/lib/wim-agent/wim wim join <code>
```

```ini
# /etc/systemd/system/wim-agent.service
[Unit]
Description=wim agent (agent jobs)
After=network-online.target
Wants=network-online.target

[Service]
User=wim-agent
Group=wim-agent
StateDirectory=wim-agent
Environment=WIM_HOME=/var/lib/wim-agent/wim
Environment=HOME=/var/lib/wim-agent
ExecStart=/usr/local/bin/wim agent serve /etc/wim-agent/agent.json --as agents
Restart=on-failure
RestartSec=10
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryMax=2G
TasksMax=256

[Install]
WantedBy=multi-user.target
```

`StateDirectory` is the only writable path: the wim state, the ledger and the runner's own files.
A runner started through `sudo` needs `NoNewPrivileges` and every option that implies it off
(sudo is setuid; for a `User=` unit `LockPersonality`, `PrivateDevices`, `ProtectKernel*`,
`RestrictSUIDSGID` and others set it too): `deploy/systemd/wim-agent.service` lists them, and
`docs/deploy.md` covers that case.

## Security model

### Who can wake it

Only a device on `senders.devices`, checked against the device id whose key signed the message.
A sender chooses its session name and display name, so a message from `me@laptop` on a device not
on the list is ignored, and an allowed device is allowed whatever name it uses. With
`requireTrusted` (the default) the person must also trust the device on the worker's own device,
read for every message. A revoked device is out of the roster, so its messages never verify.

The wake code is a second key: someone with an allowed device (or its keys) also needs the code.
`perSenderPerHour` counts every attempt, so guessing is slow, and a wrong code gets the same
`not accepted` as a wrong profile. Prefer `wake.mode` `runner` with a runner under another OS
user that holds the code: then a compromise of the worker's user does not give the code away.

### What reaches the model

The task text is untrusted input from another session. Prompt injection is not prevented, only
contained: by default the model can read files under `cwd` and nothing else, has no network
tools, and its answer goes back only to the sender (and the room). It can still put what it read
into the answer, so do not point `cwd` at anything the allowed devices should not see. Relayed
text (another model's output) never starts a job, nor does a `result`, so two agents cannot loop
through the worker.

### Spend

Each job is capped by `maxTurns`, `maxBudgetUsd` (optional), `timeoutSeconds`, and per day by
`dailyJobs`, counted on disk before the job starts. Keep the key's own spend limit at the provider
too: the worker's caps are counts, not money.

### What is kept on disk

The worker's session is opened with `redactStoredText`: its spool files and history entries keep
ids, senders, devices, kinds and times but no text; a message the loop breaker would hold is
refused instead (the sender hears `busy` once a pause); a message from a device the person does
not trust is held for approval with its metadata only. Frames that arrive before the roster that
signs them are parked encrypted until it does. The daily ledger holds a date and a count. The log
holds ids, device ids, profiles, outcomes and timings.

### What the worker does not protect against

- A compromised allowed device: it can wake the worker within the limits (and with the code, if
  that device's person knows it).
- A runner that logs the task, or a tool set that lets the model act on the machine.
- The worker's own OS user being compromised: its device keys are there, so it can send as the
  worker. Run it as its own user, with nothing else to lose.
