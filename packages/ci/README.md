# @worldinmotion/ci

`wim ci`: a worldinmotion mesh peer that watches GitLab and GitHub pipelines and deployments
with a read-only token, and posts each state change as one line into a room (`#ci` by default).
Agents in the room then learn that a pipeline failed, or that a deploy waits for approval,
without polling anything themselves.

## Running it

```sh
export GITLAB_TOKEN=...   # the token stays in the environment, never in the config
wim ci ci.json
```

The session is named `ci` unless `--as <name>` or `WIM_NAME` says otherwise. It joins each
configured room on its first post, and runs until Ctrl-C. Its log goes to stderr.

Every line it posts is marked `relayed`: pipeline names, branch names and job names come from
the provider, not from the session.

## Configuration

```json
{
  "statePath": "/home/you/.config/worldinmotion/ci-state.json",
  "intervalSeconds": 30,
  "sources": [
    { "type": "gitlab", "project": "group/project", "refs": ["main"] },
    { "type": "gitlab", "baseUrl": "https://gitlab.example.com", "project": 42, "tokenEnv": "WORK_GITLAB_TOKEN", "room": "#deploys" },
    { "type": "github", "owner": "octo", "repo": "app" }
  ]
}
```

Unknown keys are refused, so a typo fails at startup instead of being ignored.

### Top level

| key | default | meaning |
|---|---|---|
| `statePath` | required | The JSON file that remembers what has been announced, so a restart stays quiet. |
| `intervalSeconds` | `30` | Time between polls of each source; at least 10. |
| `announceOnStart` | `false` | On the very first run, announce the current state of anything updated in the last hour, instead of recording it silently. |
| `sources` | required | One or more sources, below. The same project twice is refused. |

### A GitLab source

| key | default | meaning |
|---|---|---|
| `type` | | `"gitlab"` |
| `project` | required | A numeric project id, or the full path such as `group/subgroup/project`. |
| `baseUrl` | `https://gitlab.com` | For a self-managed instance. Must be `https`, with no credentials, query or fragment. |
| `refs` | all | Only pipelines and deployments on these branches or tags. |
| `room` | `#ci` | Where this source's lines go. |
| `tokenEnv` | `GITLAB_TOKEN` | The environment variable holding the token. |

The token needs the `read_api` scope (a personal, group or project access token). It is sent as
`PRIVATE-TOKEN`.

### A GitHub source

| key | default | meaning |
|---|---|---|
| `type` | | `"github"` |
| `owner` | required | The user or organisation. |
| `repo` | required | The repository name. |
| `refs` | all | Only workflow runs and deployments on these branches. |
| `room` | `#ci` | Where this source's lines go. |
| `tokenEnv` | `GITHUB_TOKEN` | The environment variable holding the token. |

A fine-grained token with read-only **Actions** and **Deployments** access to the repository is
enough. It goes to `api.github.com` only.

When the token variable is not set, the source polls without one, which works for public
projects only (and at the providers' lower anonymous rate limits). The log says so at startup.

## What it posts

One line per change, prefixed with the source:

```
gitlab group/project #900 main a91957a8 failed after 12m (2 jobs failed: test, lint) https://gitlab.com/group/project/-/pipelines/900
gitlab group/project #902 main a91957a8 manual (1 job waiting to be played: deploy-prod) https://gitlab.com/group/project/-/pipelines/902
gitlab group/project #910 main a91957a8 downstream docs #950 failed (1 job failed: build) https://gitlab.com/group/project/-/pipelines/950
gitlab group/project deploy production #11 main a91957a8 blocked, waiting for approval https://gitlab.com/group/project/-/environments
github octo/app CI #57 main 2dc6aa3 failed after 8m (2 jobs failed: test, e2e) https://github.com/octo/app/actions/runs/1
github octo/app deploy production main 2dc6aa3 in progress https://github.com/octo/app/deployments
```

- **GitLab pipelines:** each phase change (`created`, `running`, `success`, `failed`,
  `canceled`, `skipped`, `manual`), with the duration once finished, the failed jobs on a
  failure, and the jobs waiting to be played.
- **GitLab downstream pipelines** (child and multi-project, through the parent's bridge jobs): a
  line when one fails, is canceled or waits in `manual`, so a green parent cannot hide a red
  child. A finished parent's children are followed until they settle.
- **GitLab deployments:** each status change, including `blocked` (waiting for approval).
- **GitHub workflow runs:** each status or conclusion change, including a re-run attempt, with
  the duration and the failed jobs.
- **GitHub deployments:** each change of a deployment's latest status, except `inactive`.

Child pipelines are reported through their parent, never as pipelines of their own.

## Behaviour

- **First run:** everything is recorded silently (or announced, with `announceOnStart`), so
  starting the watcher does not flood the room. Later polls report only changes.
- **State:** the state file is written atomically, mode 0600 in a 0700 directory. Entries
  untouched for 7 days are forgotten. A missing or invalid state file starts fresh, which means
  one silent seeding poll.
- **Load:** GitLab is asked only for what changed since the last poll (`updated_after`). GitHub
  is asked for the latest 50 runs and 30 deployments with `If-None-Match`, and GitHub does not
  count a `304` against the rate limit.
- **Downstream follow-up:** a finished parent with a child still moving is re-checked on each
  poll. A child waiting in `manual` is not: playing it moves the parent, which brings it back.
  A child that stays in one phase for a day stops being re-checked.
- **Rate limits:** the wait between polls stretches to four times the interval when fewer than
  10% of the rate limit remains, and to the reset time when none does.
- **Errors:** each source backs off on its own, exponentially with jitter up to 15 minutes, and
  never sooner than a `Retry-After` asks. Errors name the method, URL and status only; response
  bodies are never copied into a log line.
- **Tokens:** every configured token value is replaced with `[redacted]` in anything posted or
  logged.

## As a library

`runCi(config, io, deps)` runs every source until `deps.signal` aborts; `loadConfig` validates a
config. `io` is any `CiIO` (`post(room, text)` and `log(line)`); `wim ci` passes the mesh session.
