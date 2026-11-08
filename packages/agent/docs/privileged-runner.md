# The privileged runner

`wim agent` runs as an unprivileged user and hands each accepted message to a runner command
(the RUNNER contract in the package README). The privileged runner is the runner to use when the
job's credentials, or the wake code, must stay out of the worker's reach:

- the **peer** (the `wim agent` process) runs as one user, for example `wim-agent`. It holds the
  wim device keys and nothing else;
- the **privileged runner** runs as root, started by the peer through one sudoers line. It reads
  the wake code, signs the job in and enforces the limits;
- the **job** runs as a third user, for example `wim-agent-worker`, with read-only tools by
  default, and gets only a short-lived Anthropic sign-in.

No one of the three holds both the message channel and the cloud credentials.

## Calling it

The runner takes no arguments at all. sudo enforces that with the empty-string form:

```
wim-agent ALL=(root) NOPASSWD: /usr/local/sbin/wim-agent-privileged-runner ""
```

The launcher at that path refuses any argument and execs `wim agent privileged`.
`sudoersLine(peerUser)` returns exactly this line. The runner reads one RUNNER request on
stdin, writes the answer on stdout and exits with the contract's codes:

| exit | meaning |
|---|---|
| 0 | answered |
| 3 | refused: the sender device is not allowed, the wake code is missing or wrong, the profile prefix is not allowed, the task is empty or too long |
| 4 | busy: the job lock stayed held, memory is under the floor, or today's cap is reached |
| 5 | timed out, or stopped by a signal (sudo relays the peer's TERM) |
| 2 | bad arguments or a malformed request |
| 1 | failed: config, sign-in or job error |

Its log lines (stderr) carry the message id, the sender's device id, the verdict and numbers.
They never carry the message text, the task or the code. The job's own stderr is dropped except
its `worker:` status lines (cost and turns), because an SDK error can quote the task.

Set the worker's runner to the launcher and leave the wake code unset in the worker
(`wake.mode` `runner`). The worker then sends the raw text, and the runner checks the code.

## Configuration

`/etc/wim-agent/privileged.json`, owned by root and not writable by group or others (refused
otherwise). Unknown keys are refused. As a non-root user (for trials), `WIM_AGENT_PRIVILEGED_CONFIG`
can name another file; as root it is ignored.

```json
{
  "v": 1,
  "worker": { "user": "wim-agent-worker", "home": "/var/lib/wim-agent-worker" },
  "runDir": "/run/wim-agent",
  "lock": { "path": "/run/wim-agent/job.lock", "waitSeconds": 900 },
  "minMemAvailableMb": 900,
  "timeoutSeconds": 900,
  "maxTaskChars": 8000,
  "dailyJobs": 20,
  "allowDevices": ["<device id from wim devices>"],
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
| `runDir` | `/run/wim-agent` | Where token files live, `root:<worker's group>` 0750. The peer user must not be in that group. |
| `lock.path`, `lock.waitSeconds` | `/run/wim-agent/job.lock`, `900` | One job at a time on the host. The lock is a BSD `flock`, the same one a shell takes with `exec 9>"$LOCK"; flock -w 900 9`, so scheduled jobs and messages queue behind each other. Needs util-linux `flock`. |
| `minMemAvailableMb` | `900` | Busy (4) when `MemAvailable` is under this; `0` turns it off. |
| `timeoutSeconds`, `killGraceSeconds` | `900`, `15` | The job's process group gets TERM at the timeout, then KILL after the grace. Keep the worker's own timeout longer than `lock.waitSeconds` plus this. |
| `maxTaskChars` | `8000` | Longer tasks are refused (3). |
| `dailyJobs` | `20` | Jobs per UTC day, all senders; `0` turns the cap off. Counted under the lock in `statePath`. A damaged state file fails the run rather than resetting the count. |
| `allowDevices` | none | Device ids (never names) the runner accepts, checked again here behind the worker's own list. |
| `allowLocal` | `false` | Accept `from.device` `"local"` from a root caller outside sudo (sudo always sets `SUDO_UID`), for a scheduled job on the same host. Such a job skips `allowDevices` and the wake code. |
| `wakeCode` | none | `{ "file": path }` (root-owned, mode 0600) or `{ "env": NAME }` (set only for the privileged side; sudo resets the environment, so a file is what works through sudo). At least 16 characters, no whitespace; anything else fails closed. |
| `defaultProfile`, `profiles` | required | The profile names a message may use as a `name:` prefix after the code. A prefix-shaped word that is not a profile is refused, never run under the default. |

### Profiles

| key | default | meaning |
|---|---|---|
| `model` | `claude-opus-5-5` | The model the job runs. |
| `effort` | `medium` | `low`, `medium`, `high`, `xhigh` or `max`. |
| `maxTurns` | `20` | The SDK's turn cap. |
| `tools` | `["Read", "Grep", "Glob"]` | The only tools the job has. Anything else needs `"unsafeTools": true`. |
| `auth` | required | `wif` (below) or `{ "type": "api-key", "keyFile": path }`. |

**About tools.** With the default three, the job can read files under its working directory and
the listed directories, and nothing else. It cannot run commands, write files or reach the
network. Turning on `Bash`, `Write`, `Edit` or a web tool lets text that arrived in a message
make the job act on the host as the worker user. Every sender on the allow-list, and anyone
who can put text in front of them, could then cause that. Do it only for a worker user that
can reach nothing you mind losing.

**About API keys.** An API key profile reads the key from a root-only file and passes it to the
job, so the job holds the key for as long as it runs. Prefer Workload Identity Federation.

## Workload Identity Federation (keyless)

A `wif` profile names an Anthropic federation rule and how this host proves who it is:

| `identity.type` | where the identity token comes from |
|---|---|
| `aws-sts` | AWS STS `GetWebIdentityToken` for the instance role, through `@aws-sdk/client-sts` (an optional peer dependency; older AWS CLIs lack the call). `durationSeconds` defaults to 600. |
| `gcp-metadata` | The GCE metadata server's identity token for the default service account. |
| `gcp-impersonate` | `generateIdToken` for `serviceAccount`, signed in with the metadata server's access token. |
| `file` | A file that something else keeps fresh, such as a projected token. |

`audience` defaults to `https://api.anthropic.com` and must match the federation rule.

The runner mints a token into a file in `runDir`, mode 0640, readable by the worker's group
only. It gives the job `ANTHROPIC_IDENTITY_TOKEN_FILE`, `ANTHROPIC_FEDERATION_RULE_ID`,
`ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID` and, when set,
`ANTHROPIC_WORKSPACE_ID`. The SDK exchanges the token itself. Every 240 seconds the runner
writes a fresh token, because an exchange may use a token only once. The refresh is a timer
in the runner's own process, not a background shell. Nothing outlives the job or holds the
caller's pipes open, and the file is removed when the job ends.

### Keep the cloud role away from the peer and the job

On a cloud VM the instance role is one HTTP call away for any local user. Block the metadata
address for the peer and worker users by uid, and re-assert the rule at boot, before the peer
starts:

```sh
for u in wim-agent wim-agent-worker; do
  iptables  -C OUTPUT -m owner --uid-owner "$u" -d 169.254.169.254 -j REJECT 2>/dev/null \
    || iptables  -I OUTPUT -m owner --uid-owner "$u" -d 169.254.169.254 -j REJECT
  ip6tables -C OUTPUT -m owner --uid-owner "$u" -d fd00:ec2::254 -j REJECT 2>/dev/null \
    || ip6tables -I OUTPUT -m owner --uid-owner "$u" -d fd00:ec2::254 -j REJECT
done
```

Use a uid rule, not `IPAddressDeny=` on the peer's systemd unit: the runner is started through
sudo inside the peer's cgroup and needs the metadata server itself. For the same reason the
peer's unit cannot set `NoNewPrivileges=yes`, because sudo needs it off.
