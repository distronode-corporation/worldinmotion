# The privileged runner

`wim agent` runs as an unprivileged user and hands each accepted message to a runner command
(the RUNNER contract in the package README). The privileged runner is the runner to use when the
job's credentials, or the wake code, must stay out of the worker's reach:

- the **peer** (the `wim agent` process) runs as one user, for example `wim-agent`. It holds the
  wim device keys and nothing else;
- the **privileged runner** runs as root, started by the peer through one sudoers line. It
  authenticates the sender itself, reads the wake code, signs in to the API and enforces the
  limits;
- the **job** runs as a third user, for example `wim-agent-worker`, with read-only tools by
  default. It reaches the API only through a loopback proxy the runner owns, and holds no
  credential.

The runner does not trust the peer. A compromised peer can withhold a message, or offer one
again, but it cannot make the runner accept text that a pinned sender did not sign, read the wake
code, or get a credential.

## Calling it

The runner takes no arguments at all. sudo enforces that with the empty-string form:

```
wim-agent ALL=(root) NOPASSWD: /usr/local/sbin/wim-agent-privileged-runner ""
```

`sudoersLine(peerUser)` returns exactly this line. The launcher at that path must be a root-owned
script that refuses any argument and runs `wim agent privileged` by absolute paths in a clean
environment, keeping sudo's `SUDO_*` variables:

```sh
#!/bin/sh
[ "$#" -eq 0 ] || exit 2
exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 HOME=/root \
  ${SUDO_UID+SUDO_UID="$SUDO_UID"} ${SUDO_USER+SUDO_USER="$SUDO_USER"} \
  /usr/bin/node /usr/lib/node_modules/worldinmotion/wim.mjs agent privileged
```

- Name node by its absolute path. Keep `secure_path` set in sudoers (the default on most
  distributions), so nothing the peer controls is on `PATH`.
- Run the bundled `wim.mjs`, never the package's TypeScript sources: Node does not strip types
  under `node_modules`.
- The runner refuses to start when node, the bundle, or any directory above them could be
  written by anyone but root. A code tree the peer could change would let it change what root
  runs.

The runner reads one RUNNER request (version 2) on stdin, writes the answer on stdout and exits
with the contract's codes:

| exit | meaning |
|---|---|
| 0 | answered |
| 3 | refused: no signed frame, a frame that does not verify, a replayed frame, a wrong wake code, a profile prefix that is not allowed, a task that is empty or too long |
| 4 | busy: the job lock stayed held, memory is under the floor, or today's cap is reached |
| 5 | timed out, or stopped by a signal (sudo relays the peer's TERM) |
| 2 | bad arguments or a malformed request |
| 1 | failed: config, sign-in or job error |

Its log lines (stderr) carry the message id, the sender's device id, the verdict and numbers.
They never carry the message text, the task, the code or a credential. An unexpected error is
logged by its name only, because a parser's message can quote what it read. The job's own
stderr is dropped except its `worker:` status lines (cost and turns), because an SDK error can
quote the task.

Set the worker's runner to the launcher and leave the wake code unset in the worker
(`wake.mode` `runner`). The worker then sends the raw text, and the runner checks the code.

## Who sent it

Each request carries the signed `send` frame the relay delivered (`frame`). The runner verifies it
with the protocol's own checks, and with keys pinned in its config, never the peer's roster:

- the signature, against the sender's pinned sign key. The device id must be the one that key
  names, so a pin cannot claim another device;
- the mesh, that the frame is addressed to `recipient.address`, and freshness (47 hours back,
  10 minutes ahead);
- the box, opened with the recipient device's own keys. As root the runner reads the peer's key
  file and prekey file, refusing them unless they are regular files owned by `recipient.user`,
  mode 0600, and not symlinks. Their contents are still untrusted: a swapped key only makes a
  message unreadable. It can never make a forged one accepted, because the signature is checked
  against the pinned key;
- that it is a `msg` or `task` the sender wrote itself (not relayed).

The text the job sees is the text the sender signed. The request's own `id`, `from.device` and
`text` must agree with the frame, or the request is refused.

Each frame runs once. The runner keeps the ids it has run in its root-only state file, under the
job lock, for as long as the freshness check would still accept the frame.

The privileged runner needs the peer's device key file in plaintext (version 1, not encrypted
with `wim signer encrypt`), because it opens the box itself. With an encrypted key file it
refuses every message, and says why.

## Configuration

`/etc/wim-agent/privileged.json`, owned by root, not a symlink, and not writable by group or
others (refused otherwise). Unknown keys are refused. As a non-root user (for trials),
`WIM_AGENT_PRIVILEGED_CONFIG` can name another file; as root it is ignored.

```json
{
  "v": 1,
  "worker": { "user": "wim-agent-worker", "home": "/var/lib/wim-agent-worker" },
  "runDir": "/run/wim-agent",
  "lock": { "path": "/run/wim-agent/job.lock", "waitSeconds": 900 },
  "minMemAvailableMb": 900,
  "timeoutSeconds": 1800,
  "maxTaskChars": 16000,
  "dailyJobs": 50,
  "senders": {
    "<device id>": { "sign": "<sign key>", "box": "<box key>" }
  },
  "recipient": { "home": "/var/lib/wim-agent/.wim", "mesh": "<mesh id>", "address": "agents@<device>", "user": "wim-agent" },
  "wakeCode": { "file": "/etc/wim-agent/wake-code" },
  "defaultProfile": "a",
  "profiles": {
    "a": {
      "model": "claude-opus-5-5",
      "effort": "medium",
      "auth": {
        "type": "wif",
        "organizationId": "<organization id>",
        "federationRuleId": "<federation rule id>",
        "serviceAccountId": "<service account id>",
        "workspaceId": "<workspace id>",
        "identity": { "type": "aws-sts", "region": "<region>" }
      }
    }
  }
}
```

| key | default | meaning |
|---|---|---|
| `worker.user`, `worker.home`, `worker.cwd` | `wim-agent-worker`, `/var/lib/wim-agent-worker`, `<home>/work` | The job's user, its `HOME` and working directory. `worker.additionalDirectories` lists more directories the job may read. |
| `runDir` | `/run/wim-agent` | The runner's own directory, root-owned and made before the lock is taken. |
| `lock.path`, `lock.waitSeconds` | `/run/wim-agent/job.lock`, `900` | One job at a time on the host. The lock is a BSD `flock`, the same one a shell takes with `exec 9>"$LOCK"; flock -w 900 9`, so scheduled jobs and messages queue behind each other. It is never opened through a symlink. A lock directory outside `runDir` is made if missing, otherwise only checked (a directory, root's, no group or other write) and never re-owned, so it can be one the scheduled jobs share with their own group and mode. Needs util-linux `flock`. |
| `minMemAvailableMb` | `900` | Busy (4) when `MemAvailable` is under this; `0` turns it off. |
| `timeoutSeconds`, `killGraceSeconds` | `1800`, `15` | The job gets TERM at the timeout, then KILL after the grace. Keep the worker's own timeout longer than `lock.waitSeconds + timeoutSeconds + killGraceSeconds`. |
| `maxTaskChars` | `16000` | Longer tasks are refused (3). |
| `dailyJobs` | `50` | Jobs per UTC day, all senders; `0` turns the cap off. |
| `statePath` | `/var/lib/wim-agent-privileged/state.json` | The day's count and the frames already run: root-owned, mode 0600, in a root-only directory, written through a fresh `O_EXCL`/`O_NOFOLLOW` file. A damaged file fails the run rather than reset the counts. |
| `senders` | none | The senders who may wake a job: device id to `{ "sign", "box" }`, the device's public keys from the signed roster. `wim agent init <dir>/agent.json --mode privileged --allow <ids> [--peer-user <user>] [--as <name>]` writes `senders` and `recipient` for you. |
| `recipient` | none | The receiving session: `home` (the peer's wim state directory), `mesh`, `address`, and `user` (the peer user, who must own the key files). Required with `senders`. |
| `allowLocal` | `false` | Accept `from.device` `"local"` with no frame, for a scheduled job on the same host. Only from a root caller outside sudo: `SUDO_UID` unset (the guard; sudo always sets it, so the launcher must keep it), and every ancestor process root (a second check, not a sufficient one). Such a job skips the sender check and the wake code. |
| `wakeCode` | none | `{ "file": path }` (root-owned, mode 0600) or `{ "env": NAME }` (set only for the privileged side; sudo resets the environment, so a file is what works through sudo). At least 16 characters, no whitespace; anything else fails closed. |
| `apiUrl` | `https://api.anthropic.com` | Where the proxy sends the job's requests. |
| `defaultProfile`, `profiles` | required | The profile names a message may use as a `name:` prefix after the code. A prefix-shaped word that is not a profile is refused, never run under the default. |

The runner refuses to start without `senders` or `allowLocal`: one that would take a job from
anyone does not run.

### Profiles

| key | default | meaning |
|---|---|---|
| `model` | `claude-opus-5-5` | The only model the job may ask for. |
| `effort` | `medium` | `low`, `medium`, `high`, `xhigh` or `max`. |
| `maxTurns` | `20` | The SDK's turn cap. The proxy allows this many API requests plus 5. |
| `maxTokens` | `128000` | The highest `max_tokens` a request may ask for. |
| `tools` | `["Read", "Grep", "Glob"]` | The only tools the job has. Anything else needs `"unsafeTools": true`. |
| `auth` | required | `wif` (below) or `{ "type": "api-key", "keyFile": path }` (root-owned, mode 0600). |

**About tools.** The default tools read files and nothing else. They read only inside the job's
working directory and `worker.additionalDirectories`: the SDK is told to refuse reads anywhere
else, and denies outright `/proc`, `/sys`, `/etc/wim-agent`, the runner's directories, the peer's
wim directory and each secret file the config names. These rules are proven against the real
SDK. Without them, Grep reads `/proc/self/environ` and Read reads any file the worker user can.

Turning on `Bash`, `Write`, `Edit` or a web tool lets text that arrived in a message make the job
act on the host as the worker user. Every pinned sender, and anyone who can put text in front of
them, could then cause that. With `unsafeTools`, commands run in the SDK's sandbox (bubblewrap
on Linux), with the same paths denied. If the sandbox is not available, the job fails rather
than run unsandboxed. Do it only for a worker user that can reach nothing you mind losing.

## The job's sign-in: a loopback proxy

The job never holds a credential. For each job the runner:

1. signs in itself. A `wif` profile exchanges an identity token for an Anthropic access token
   with the Anthropic SDK's own exchange (the jwt-bearer grant at `/v1/oauth/token`) and its
   token cache, which refreshes before expiry. An `api-key` profile reads its key from a
   root-only file. Either way the credential stays in the runner's memory. Every mint and
   exchange has a time limit;
2. starts an HTTP proxy on `127.0.0.1`, on a random port, with a random key for this job;
3. gives the job `ANTHROPIC_BASE_URL` (the proxy) and `ANTHROPIC_API_KEY` (the job's key), and
   nothing else from its sign-in.

The proxy checks the job's key in constant time and accepts only `POST /v1/messages` and
`/v1/messages/count_tokens` (the calls the Agent SDK makes). It caps each body, refuses any
model but the profile's and any `max_tokens` over the profile's ceiling, and stops after the
request allowance. It then replaces the job's key with the real credential. It logs the path,
the status and the count, never a header or a body. It closes when the job ends.

The job can read its own key in its environment (`/proc/self/environ`, through anything that
reads files). That is acceptable only because the key is worth nothing outside the proxy: it
works only from this host, only on those two calls, within the job's limits, and only until the
job ends.

| `identity.type` | where the identity token comes from |
|---|---|
| `aws-sts` | AWS STS `GetWebIdentityToken` for the instance role, through `@aws-sdk/client-sts` (an optional peer dependency; older AWS CLIs lack the call). `durationSeconds` defaults to 600. |
| `gcp-metadata` | The GCE metadata server's identity token for the default service account. |
| `gcp-impersonate` | `generateIdToken` for `serviceAccount`, signed in with the metadata server's access token. |
| `file` | A file that something else keeps fresh, such as a projected token. It must be owned by root and not writable by others. |

`audience` defaults to `https://api.anthropic.com` and must match the federation rule.

### Keep the cloud role away from the peer and the job

On a cloud VM the instance role, or a container's task role, is one HTTP call away for any local
user. Block every metadata and credential address for the peer and worker users by uid, and
re-assert the rules at boot, before the peer starts:

```sh
for u in wim-agent wim-agent-worker; do
  for a in 169.254.169.254 169.254.170.2 169.254.170.23; do
    iptables -C OUTPUT -m owner --uid-owner "$u" -d "$a" -j REJECT 2>/dev/null \
      || iptables -I OUTPUT -m owner --uid-owner "$u" -d "$a" -j REJECT
  done
  for a in fd00:ec2::254 fd00:ec2::23 fd20:ce::254; do
    ip6tables -C OUTPUT -m owner --uid-owner "$u" -d "$a" -j REJECT 2>/dev/null \
      || ip6tables -I OUTPUT -m owner --uid-owner "$u" -d "$a" -j REJECT
  done
done
```

Use uid rules, not `IPAddressDeny=` on the peer's systemd unit: the runner is started through
sudo inside the peer's cgroup and needs the metadata server itself. For the same reason the
peer's unit cannot set `NoNewPrivileges=yes`, because sudo needs it off.
