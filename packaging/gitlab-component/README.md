# worldinmotion CI notice (GitLab CI/CD component)

Sends one information-only notice to one [worldinmotion](https://github.com/distronode-corporation/worldinmotion)
session when a pipeline finishes. The job proves where it runs with a GitLab ID token, so there
is no secret to store. The receiving device decides which projects may send, and the notice
never starts work in the session that receives it. The protocol is SPEC section 18.

The component is published in the GitLab CI/CD Catalog from the project
[distronode-corporation/worldinmotion-notify](https://gitlab.com/distronode-corporation/worldinmotion-notify),
one version `X.Y.Z` per worldinmotion release.
<!-- unpublished -->

**Not published yet.** This folder is that project's source (`templates/notify.yml` and its own
`.gitlab-ci.yml`, whose `release` job lists each tag in the Catalog): worldinmotion's release
workflow writes it there. Until the first release that does, the `component:` line below does
not resolve.
<!-- /unpublished -->

## On the receiving device

At your own terminal (not through an agent), allow the project and the branch or tag that may
send (a protected one, unless you add `--unprotected`), and note the two values it prints:

```sh
wim ci allow gitlab <group>/<project> --ref main
wim ci allow gitlab <group>/<project> --tag 'v*'
```

A name ending in `*` is a pattern: `--tag 'v*'` takes every tag starting with `v`. Protect the
same wildcard under Settings, Repository, Protected tags (or branches): the rule takes only
protected refs unless it has `--unprotected`.

- the **recipient code**, starting with `wimci1_`, which names the relay, the mesh and the device;
- the **audience**, `wimci1.<mesh>.<device>`, which the job's ID token must carry.

Neither is a secret.

## In the pipeline

```yaml
include:
  - component: $CI_SERVER_FQDN/distronode-corporation/worldinmotion-notify/notify@X.Y.Z
    inputs:
      recipient: wimci1_...
      audience: wimci1.<mesh>.<device>
      to: build
```

`X.Y.Z` is an exact version, such as the latest in the Catalog: each one runs the `wim` of the
worldinmotion release with the same number. On a self-managed GitLab, the project must be
mirrored there under the same path.

| Input | Default | What it is |
|---|---|---|
| `recipient` | (required) | The `wimci1_` code from `wim ci allow gitlab`. |
| `audience` | (required) | The audience it printed. GitLab fixes a token's audience before the job runs, so it is an input. |
| `to` | (required) | The session that gets the notice. |
| `stage` | `.post` | The stage both jobs run in. |
| `success_text`, `failure_text` | the project, pipeline, ref and pipeline URL | The notice for each outcome. CI/CD variables in it are expanded. |
| `image` | `node:24-alpine` | Needs Node.js 22.18 or newer and npm. |
| `wim_package` | `worldinmotion@<this release>` | Where `wim` comes from, at an exact version. |
| `tags` | `[]` | Runner tags; the jobs do not inherit the pipeline's `default:`. |

## What it does, and does not do

- It adds two jobs: `wim-notify-success` (every earlier job passed) and `wim-notify-failure` (one
  failed). Exactly one runs, with its own ID token, so one token sends one notice.
- The token travels only inside the box sealed to the device. The relay never sees it, so it
  never sees the pipeline user's details either; the receiving device verifies it.
- Anything that runs in the job could read the token until the job times out, so the jobs run as
  little as possible: no clone, no cache, no artifacts, nothing from `default:`, install scripts
  off, and a 5 minute timeout.
- The jobs never fail the pipeline (`allow_failure: true`); `wim ci notify` reports every
  outcome as one line in the job log.
- To send only on failure, turn the other job off in your pipeline:
  `wim-notify-success: { rules: [ { when: never } ] }`.
