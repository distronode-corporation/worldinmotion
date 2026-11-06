# worldinmotion CI notice (GitHub Action)

Sends one information-only notice to one [worldinmotion](https://github.com/distronode-corporation/worldinmotion)
session when a job finishes. The job proves where it runs with its own GitHub ID token, so there
is no secret to store. The receiving device decides which repositories may send, and the notice
never starts work in the session that receives it. The protocol is SPEC section 18.

This folder is the action as it will be published on its own. Until then it runs from this
repository, at a commit you pin.

## On the receiving device

At your own terminal (not through an agent), allow the repository, the branch or tag and the
workflow file that may send, and note the code it prints (`wim ci allow` lists the other options:
events, environments, holding every notice):

```sh
wim ci allow github <owner>/<repo> --ref main --workflow ci.yml
wim ci allow github <owner>/<repo> --tag 'v*' --workflow release.yml
```

A name ending in `*` is a pattern: `--tag 'v*'` takes every tag starting with `v`. Protect the
same tags or branches with a ruleset, since anyone who can push one can send; `allow` prints the
ruleset targets to use.

The code starts with `wimci1_`. It names the relay, the mesh and the device, and it is not a
secret: put it in a repository or organization variable such as `WIM_CI_RECIPIENT`.

## In the workflow

```yaml
jobs:
  build:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      id-token: write   # the notice is proven with the job's ID token
    steps:
      # ... the job's own steps ...
      - uses: distronode-corporation/worldinmotion/packaging/github-action@<full commit sha>
        if: always()
        with:
          recipient: ${{ vars.WIM_CI_RECIPIENT }}
          to: build
          status: ${{ job.status }}
```

| Input | Required | What it is |
|---|---|---|
| `recipient` | yes | The `wimci1_` code from `wim ci allow github`. |
| `to` | yes | The session that gets the notice (1 to 32 of `a-z`, `0-9` and `-`). |
| `text` | no | The notice, at most 4 KiB. The default names the workflow, its run, the ref, the status and the run's URL. |
| `status` | no | The outcome the default text reports; pass `${{ job.status }}`. |

The receiving session also sees, beside the text, what the token proves: the repository, the
workflow file, the ref, the commit, the event and the run id.

## What it does, and does not do

- It runs `wim ci notify` from the client bundle shipped with the action, so the commit you pin
  is the code that runs. It downloads nothing at run time.
- It asks GitHub for a token whose audience names a one-time key, signs the notice with that key,
  and seals it to the device. A copied token is useless without the key.
- It never fails your job. Every outcome is one line in the log; a missing input is a warning.
- `pull_request_target` and `workflow_run` runs are refused by the device unless its rule names
  the event.
- Your job's Node.js version does not matter: GitHub runs the action on its own Node.js 24.
