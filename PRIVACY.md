# Privacy policy

This policy covers worldinmotion: the `wim` client, the Claude Code plugin, the VS Code
extension, and the public relay that Distronode Corporation runs at
`wss://worldinmotion.distronode.com` (the hosted relay). It says what each one stores, what it
sends and to whom, and for how long. The code is in this repository, so you can check every line
of it there.

## In short

- There is no account and no sign-up. Distronode does not collect your name, email address or
  any other contact detail to use worldinmotion.
- There is no telemetry. The client, the plugin and the extension send no usage data.
- Message text and files are end-to-end encrypted between devices. The relay cannot read them.
- Crash reports are off unless you turn them on yourself.
- Distronode does not sell data, and shares none for advertising.

## What stays on your device

The client keeps its state in a directory on your machine, `~/.config/worldinmotion` by default
(`%APPDATA%\worldinmotion` on Windows; `wim doctor` names the one it uses). It holds:

- the device's keys, the mesh's roster and your settings, kept until you delete them;
- each session's history of what it sent and received, including message text, in
  `sessions/<sid>/history.jsonl`. A history file rotates at 10 MiB, and rotated files are kept
  for 30 days;
- messages waiting to be read, removed once a session reads them;
- items held for your approval, kept until you approve or refuse them;
- files you received, kept until you delete them.

Deleting the state directory removes all of it. The private keys, the history, the waiting and
held items and the received files never leave your machine, except as encrypted messages to the
devices you send to. What the client does publish, through the relay, is listed in the next
section: your device's public keys, the session names, kinds and presence your devices publish,
and the metadata of what you send.

What your agents read is also seen by each agent's own model provider, under that provider's
terms. That is between you and the provider: worldinmotion does not send it there.

## What the relay sees and keeps

Every mesh uses one relay. If you run your own relay, Distronode receives nothing from your
mesh. If you use the hosted relay, it is a Cloudflare Worker that Distronode runs, and its terms
are in [docs/hosted-relay.md](docs/hosted-relay.md).

The relay sees metadata, never content:

- device ids, and the session names, kinds and presence your devices publish;
- message sizes and times, who sent to whom, and room membership;
- that a short invite code exists, its size and when it is fetched, never the code itself;
- each connection's source address while it is connected. For rate limits it keeps only a keyed
  hash of the address, never the address itself;
- for CI notices, if you allow them: the facts listed in docs/hosted-relay.md, under CI senders.
  It stores none of a GitHub token's claims, and never the token.

It never sees message text, file contents, file names or peer cards.

How long the relay keeps things:

- A sealed message for an offline session is queued for at most 24 hours. A sealed file is kept
  for at most 24 hours.
- A room's history, sealed for its members, is kept for at most 72 hours (the last 100
  messages).
- A short invite box is kept for at most an hour.
- The hosted relay deletes a mesh that has had no connection for 30 days, with its roster,
  queues and files. An admin device can delete a mesh sooner with `wim mesh delete`.

Cloudflare operates the infrastructure the hosted relay runs on, and its own logs and terms
apply to the connections it carries.

## Crash reports (only if you turn them on)

Crash reports are off by default, and nothing turns them on except you running
`wim crash-reports on` in your own terminal. An agent cannot turn them on through that command.
When they are on, a bug that ends a command sends one report to Distronode's Sentry organisation
in the European Union (de.sentry.io). There are at most 5 reports per process.

A report holds:

- the error's type and its message after scrubbing;
- the stack's function names, file names, and line and column numbers;
- the wim version, the command name, the OS family and the Node version.

It holds no message text, files, keys, codes, ids, addresses, room names, user name, host name,
paths, relay URL, arguments or environment variables. Sentry sees the connection's IP address,
as any server does, and the project is set not to store it. `wim crash-reports off` stops
reports at once. The repository README, under Crash reports (opt in), lists every field and
every scrubbing rule.

## The Claude Code plugin

On its first start, the plugin downloads the `worldinmotion` package from the npm registry, at
the exact version the plugin pins, and runs it from npm's cache. If npm has since pruned or
cleared its cache, the next start downloads the same version again. npm sees that download under
its own terms, as with any package you install. After that, the plugin's client connects to the
relay your mesh uses. On a device where you have run `wim ci allow`, it also fetches GitHub's or
GitLab's public token keys, to check CI notices. Beyond that relay traffic (which reaches
Distronode only when your mesh uses the hosted relay), it sends Distronode nothing unless you turn
crash reports on.

## Who receives data

- **The relay you choose**, for routing. For the hosted relay, that is Distronode, on
  Cloudflare.
- **Sentry (EU)**, for crash reports, only after you turn them on.
- **The npm registry**, which serves the plugin's download.

Distronode shares nothing else with anyone, except where the law requires it.

## Contact

Write to **opensource@distronode.com** with any question about this policy or your data. To
report abuse of the hosted relay, follow docs/hosted-relay.md, under Reporting abuse.

Changes to this policy are made in this file, and its history is in the repository.
