# Deploying the wim agent on a Linux host

This guide takes a fresh Linux machine to a running agent: a wim session that sleeps until one of
your devices messages it, runs one Claude Agent SDK job, and replies. Everything is configuration:
the files you install come from `packages/agent/deploy/` in the release you install, and nothing
needs editing beyond the values marked `REPLACE_...` and the paths you choose to change.

> `wim worker` is a working name until the 0.2.1 release notes confirm it.

## What runs, and as whom

| Piece | User | Holds | Can reach |
|---|---|---|---|
| the peer, `wim worker serve` (`wim-agent.service`) | `wim-agent` | its wim device keys | the relay; one root program through sudo |
| the privileged runner (`wim worker privileged`, through `/usr/local/sbin/wim-agent-privileged-runner`) | root, per job | the model credential or the means to mint one; the wake code | the cloud metadata service |
| the worker (the Agent SDK job) | `wim-agent-worker` | a short-lived model token, for one job | the model API; read-only tools in its own directory |
| scheduled jobs (`wim-agent-job@<job>`) | root, then the worker | whatever `collect` and `post` need | as their scripts decide |

The split is the security model (README, SECURITY-MODEL section). In short:

- **The peer reads the network, so it holds nothing worth stealing.** No cloud credential (the
  metadata service is blocked for its uid), no model key, and no wake code: with `wake.mode`
  `"runner"` the raw text goes to the privileged runner, which checks the code itself.
- **The peer may run exactly one root program, with no arguments** (`deploy/sudoers/wim-agent`).
  The request travels on stdin as one JSON object (the runner contract), so nothing from a message
  ever reaches a command line, and the runner re-checks the sender, the code, the profile and the
  limits on its own.
- **The worker runs the model, so it gets the least**: its own user, read-only tools by default,
  no metadata service, and a token that expires minutes after the job.
- **All of it shares one capped slice** (`wim-agent.slice`), so a runaway job cannot starve the
  host, and one job lock, so a message and a scheduled job never run at once.

A simpler layout, one user and an API key with no privileged runner, is at the end
("Variant: no privileged runner"). Use it on a machine of your own where no cloud identity is at
stake.

## Requirements

- Linux with systemd, `sudo`, util-linux `flock` and `runuser`, and `nft` (nftables) or `iptables`.
- Node.js 22.18 or later, installed for every user (for example in `/usr/local/bin` or `/usr/bin`).
- At least 1.5 GB of memory free for the agent (the slice caps it at 1200 MB; the runner refuses
  to start a job when less than 900 MB is available).
- A wim mesh you already use on your own devices, and a terminal on one of them for the join.

Run every command below as root unless it says otherwise.

## 1. Install wim and the kit

`wim` is the one npm package, `worldinmotion`; the Agent SDK installs beside it, since `wim` does
not carry it. Install both root-owned, so neither agent user can change the code root runs:

```sh
npm install --global --prefix /usr/local worldinmotion@0.2.1 @anthropic-ai/claude-agent-sdk@0.3.310
find "$(npm root --global --prefix /usr/local)" -perm /022 -not -type l   # must print nothing
```

The kit is not in the npm package. Take it from the same release's tag, and check the commit
against the one the release page names:

```sh
git clone --quiet --depth 1 --branch v0.2.1 https://github.com/distronode-corporation/worldinmotion.git /usr/local/src/worldinmotion-0.2.1
git -C /usr/local/src/worldinmotion-0.2.1 rev-parse HEAD
KIT=/usr/local/src/worldinmotion-0.2.1/packages/agent/deploy
```

## 2. Create the two users

```sh
useradd --system --home-dir /var/lib/wim-agent --no-create-home --shell /usr/sbin/nologin wim-agent
useradd --system --home-dir /var/lib/wim-agent-worker --create-home --shell /usr/sbin/nologin wim-agent-worker
install -d -o wim-agent -g wim-agent -m 0700 /var/lib/wim-agent /var/lib/wim-agent/wim
install -d -o wim-agent-worker -g wim-agent-worker -m 0750 /var/lib/wim-agent-worker/work
install -d -o root -g wim-agent-worker -m 0750 /var/lib/wim-agent-worker/in
install -d -o root -g root -m 0700 /var/lib/wim-agent-privileged
```

Neither user may be in any other group, and neither gets a login shell or a password.

## 3. Close the metadata service to both users

On a cloud VM, any process that can reach the metadata address (169.254.169.254 on AWS, GCP and
Azure) can ask it for the instance's credentials. Only root needs it, to mint the worker's
short-lived token, so the peer and the worker are blocked by uid:

```sh
install -o root -g root -m 0755 "$KIT/wim-agent-imds-block" /usr/local/sbin/wim-agent-imds-block
wim-agent-imds-block apply wim-agent wim-agent-worker
wim-agent-imds-block verify wim-agent wim-agent-worker
```

`apply` uses nftables when `nft` exists (one table, `inet wim_agent_imds`) and iptables
otherwise, and also blocks AWS's IPv6 metadata address. Add any other address with
`--also <address>`. `verify` checks that the rule is in place and that a connection as each user
fails, then tries the address as root as a control: on a cloud VM it prints `control root reaches`;
if root cannot reach it either, the host has no metadata service and only the rule check means
anything.

The rules do not survive a reboot or a firewall reload by themselves, so both units run `apply`
again before they start (`ExecStartPre=`). You can check by hand at any time:

```sh
nft list table inet wim_agent_imds            # or: iptables -S OUTPUT | grep -- '--uid-owner'
runuser -u wim-agent -- curl -sS -m 3 -o /dev/null http://169.254.169.254/ && echo OPEN || echo blocked
```

Why not `IPAddressDeny=` in the unit: the root runner that sudo starts lives in the peer's cgroup
and needs the metadata service, so a cgroup rule would block it too. The uid match blocks exactly
the two users and nobody else.

## 4. Join the mesh as the peer

The peer is a device in your mesh, so it joins like any other: an invite on one of your own
devices, the join here, the comparison code typed on your device. Run both in terminals you opened
yourself.

On one of your own devices:

```sh
wim invite
```

Here, in your own terminal, as the peer user:

```sh
runuser -u wim-agent -- env HOME=/var/lib/wim-agent WIM_HOME=/var/lib/wim-agent/wim wim join <code> --name <device-name>
```

When it asks whether the device that admitted it, and then each other device, is "your own
device", answer **yes only for the devices that should be able to wake the agent**: the peer acts
only on devices it trusts (step 5), so this is the first half of the allow-list.

## 5. Choose who may wake it

List the devices, with their ids, from the peer:

```sh
runuser -u wim-agent -- env HOME=/var/lib/wim-agent WIM_HOME=/var/lib/wim-agent/wim wim devices list
```

The allow-list takes **device ids**, the 22-character keys from that list, never names: a session
or device name is chosen by whoever runs it. With `senders.requireTrusted` (the default) a device
must also be trusted by the peer itself (`wim devices trust`) at the moment its message arrives, so
untrusting a device stops it at once without a config change. To trust one you skipped in step 4,
or untrust one:

```sh
runuser -u wim-agent -- env HOME=/var/lib/wim-agent WIM_HOME=/var/lib/wim-agent/wim wim devices trust <device-name>
runuser -u wim-agent -- env HOME=/var/lib/wim-agent WIM_HOME=/var/lib/wim-agent/wim wim devices untrust <device-name>
```

On each device that will send to the agent, trust the agent's device for relayed text. Its
replies are marked relayed, and a device trusted only plainly holds relayed messages for approval,
so without this the answers wait in `wim held`:

```sh
wim devices trust <device-name> --relayed
```

## 6. Configure the peer

```sh
install -d -o root -g root -m 0755 /etc/wim-agent
install -o root -g root -m 0644 "$KIT/config/agent.json" /etc/wim-agent/agent.json
```

Edit `/etc/wim-agent/agent.json`: put the device ids in `senders.devices`. The example is the
privileged layout:

- `wake.mode` `"runner"`: the peer never holds the code; the runner checks it.
- `runner.command` `/usr/bin/sudo`, `runner.args` `["-n", "/usr/local/sbin/wim-agent-privileged-runner"]`:
  exactly the program the sudoers line allows, with no further arguments.
- `runner.passEnv` `["PATH", "LANG"]`: sudo resets the environment anyway.
- `runner.timeoutSeconds` a little above the runner's own `timeoutSeconds`, so the runner's
  timeout fires first and the sender hears "timed out" rather than a kill.
- `limits`: the task length, the per-sender attempts per hour (wrong codes count), and the jobs
  per UTC day. The ledger keeps the count across restarts.
- `replies.room`: optional, a room such as `#agents` that also gets each answer. A room copy
  carries the answer only, never the task or the code.

The file holds no secret in this layout, so it may be world-readable; it must not be writable by
either agent user.

## 7. Configure the privileged runner

```sh
install -o root -g root -m 0600 "$KIT/config/privileged.json" /etc/wim-agent/privileged.json
```

Edit `/etc/wim-agent/privileged.json`. The runner refuses the file when it is group- or
other-writable or has a key it does not know. The parts to fill:

- `allowDevices`: the same device ids, checked a second time on the root side.
- `wakeCode.file`: the wake code, if you want one (recommended). Make it long and random, and
  keep it only here and in your own password manager:

  ```sh
  umask 077; openssl rand -base64 24 | tr -d '\n' > /etc/wim-agent/wake-code
  ```

  A message must then start with the code. Remove the `wakeCode` key to rely on the allow-list
  alone.
- `profiles`: one per account or model setup a message may pick with a `<name>:` prefix, and
  `defaultProfile` for messages with none. Each profile's `auth` is one of:
  - `{"type": "api-key", "keyFile": "/etc/wim-agent/anthropic-key"}`: a key in a root-only file
    (`0600`). The worker gets it for the job only.
  - `{"type": "wif", ...}`: keyless Workload Identity Federation. The runner mints a short-lived
    identity token from the machine's own cloud identity, and the worker exchanges it for a
    short-lived model token, so no API key exists anywhere. `identity` is one of
    `{"type": "aws-sts", "region": "<region>"}`, `{"type": "gcp-metadata"}`,
    `{"type": "gcp-impersonate", "serviceAccount": "<email>"}` or `{"type": "file", "path": "<token file>"}`.
    Fill in `organizationId`, `federationRuleId`, `serviceAccountId` and `workspaceId` from your
    Claude Console's workload identity page (ids, not secrets).
- `tools`: `["Read", "Grep", "Glob"]` is read-only and the default. Adding `Bash`, `Edit`,
  `Write` or a network tool lets anyone who can wake the agent run that tool as the worker user,
  on this host, steered by text they wrote or by any file or page the job reads (prompt
  injection). Keep the worker's directories free of anything it should not see before you do.
- `allowLocal`: `true` only if you install scheduled jobs (step 10).

Install the root program the peer calls:

```sh
install -o root -g root -m 0755 "$KIT/wim-agent-privileged-runner" /usr/local/sbin/wim-agent-privileged-runner
```

It refuses any argument and runs `/usr/local/bin/wim worker privileged` with a fixed environment
(it keeps only sudo's own `SUDO_*` variables, which the runner uses to tell the peer from a local
job). Change `WIM_BIN` in it if your npm prefix is not `/usr/local`.

## 8. Allow the one sudo command

```sh
install -o root -g root -m 0440 "$KIT/sudoers/wim-agent" /etc/sudoers.d/wim-agent
visudo -cf /etc/sudoers.d/wim-agent
sudo -l -U wim-agent
```

`sudo -l` must list exactly one command,
`(root) NOPASSWD: /usr/local/sbin/wim-agent-privileged-runner ""`. The `""` forbids arguments.

## 9. Install the units and start

```sh
install -o root -g root -m 0644 "$KIT/systemd/wim-agent.slice" "$KIT/systemd/wim-agent.service" /etc/systemd/system/
install -o root -g root -m 0644 "$KIT/tmpfiles/wim-agent.conf" /etc/tmpfiles.d/wim-agent.conf
systemd-tmpfiles --create /etc/tmpfiles.d/wim-agent.conf
systemctl daemon-reload
systemctl enable --now wim-agent.service
journalctl -u wim-agent -f
```

The unit deliberately leaves out `NoNewPrivileges=yes` and every option that implies it for a
`User=` unit (`LockPersonality=`, `RestrictRealtime=`, `ProtectKernelTunables=`,
`SystemCallFilter=` and the others listed in the unit): each would stop sudo. Adjust the slice's
`MemoryMax=` and `CPUQuota=` to the machine.

## 10. Check it end to end

- `grep NoNewPrivs /proc/$(systemctl show -p MainPID --value wim-agent)/status` prints `0`.
- `wim-agent-imds-block verify wim-agent wim-agent-worker` passes.
- From an allowed device: `wim send agents@<device-name> "<code> what is in the work directory?" --wait 20m`
  gets an answer marked as relayed, within the timeout (`agents` is the unit's `--as` name).
- From an allowed device with a wrong code: "not accepted" (or nothing with `replies.refused`
  `"silent"`), and it counts against that device's hourly attempts.
- From a device not on the list: nothing at all, and the journal says only that a sender was
  refused. Log lines never contain the message text or the code.

## Scheduled jobs (optional)

A scheduled job collects inputs as root, has the worker analyse them through the same privileged
runner (same user, tools, limits, lock and daily cap), and posts the answer as root. The model
never sees the credentials `collect` and `post` use. `deploy/examples/jobs/repo-digest/` is a
complete example: a daily review of a repository's commits.

```sh
install -o root -g root -m 0755 "$KIT/wim-agent-job" /usr/local/sbin/wim-agent-job
install -o root -g root -m 0644 "$KIT/systemd/wim-agent-job@.service" "$KIT/systemd/wim-agent-job@.timer" /etc/systemd/system/
install -d -o root -g root -m 0755 /etc/wim-agent/jobs
cp -r "$KIT/examples/jobs/repo-digest" /etc/wim-agent/jobs/
chown -R root:root /etc/wim-agent/jobs; chmod -R go-w /etc/wim-agent/jobs
echo /srv/clones/project > /etc/wim-agent/jobs/repo-digest/repo   # a clone root keeps
systemctl daemon-reload
systemctl start wim-agent-job@repo-digest.service                  # one run now
systemctl enable --now wim-agent-job@repo-digest.timer
```

Set `"allowLocal": true` in `privileged.json` first: the wrapper sends from the `local` sender,
which the runner accepts only from root outside sudo. Start a job with `systemctl start`, never from
a shell, even a root one: the runner accepts `local` only when sudo set no `SUDO_UID` and every
process above it runs as root, which a root shell reached through `sudo` or `su` does not meet.

Each job is a directory, `/etc/wim-agent/jobs/<job>/`, with `job.conf` (`enabled=yes|no`, the
per-job kill switch, and `profile=`), `prompt.md`, and optional executable `collect` and `post`.
`collect` exiting 3 means "nothing new", and no model call is made. The wrapper refuses any of
those files when it is not owned by root or is group- or other-writable. A busy runner (the lock,
the memory floor or the daily cap) exits 75, which the unit counts as success; the next tick
retries. Give a job its own schedule with `systemctl edit wim-agent-job@<job>.timer`
(`[Timer]`, `OnCalendar=` to clear the default, then your own `OnCalendar=`).

The wrapper never holds the job lock itself: the runner takes it, so a message and a scheduled
job queue behind each other.

## Variant: no privileged runner

On a machine of your own with no cloud identity, the peer can run the package's built-in runner
directly, as one user with an API key:

- skip the worker user, the privileged runner, `privileged.json` and the sudoers file;
- in `agent.json`: `"runner": {"command": "/usr/local/bin/wim", "args": ["worker", "runner", "--config", "/etc/wim-agent/runner.json"]}`
  (the built-in runner; its `runner.json` is in the package README),
  `"wake": {"mode": "local", "codeFile": "/etc/wim-agent/wake-code"}` with the code file owned by
  `wim-agent` and `0400`, and `profiles` if you want a prefix;
- put the key in a file only `wim-agent` can read (`0400`), and name it as `keyFile` in
  `runner.json`;
- in the unit, with `systemctl edit wim-agent.service`, turn on the sandboxing that sudo ruled out:

  ```ini
  [Service]
  NoNewPrivileges=yes
  ProtectSystem=strict
  ReadWritePaths=/var/lib/wim-agent
  LockPersonality=yes
  RestrictRealtime=yes
  ProtectKernelTunables=yes
  ProtectKernelModules=yes
  ```

Here the peer does hold the key and the code, so a compromise of the peer process is a
compromise of both. Keep the metadata block (step 3) for `wim-agent` all the same.

## Stopping it

- One sender: untrust its device on the peer, or take its id off both allow-lists.
- Everyone: `systemctl stop wim-agent.service`. Scheduled jobs: `enabled=no` in a job's
  `job.conf`, or `systemctl disable --now wim-agent-job@<job>.timer`.
- Spend: the daily cap in both configs, and the spend limit on the model workspace the profiles
  use, which holds whatever happens on this host. With workload identity, archiving the
  federation rule in the Console stops new tokens; issued ones expire within minutes.

## Upgrading

```sh
npm install --global --prefix /usr/local worldinmotion@<version>
git clone --quiet --depth 1 --branch v<version> https://github.com/distronode-corporation/worldinmotion.git /usr/local/src/worldinmotion-<version>
diff -ru /usr/local/src/worldinmotion-0.2.1/packages/agent/deploy /usr/local/src/worldinmotion-<version>/packages/agent/deploy
```

Read the release notes and that diff, re-install the kit files that changed, then
`systemctl daemon-reload && systemctl restart wim-agent.service`.
