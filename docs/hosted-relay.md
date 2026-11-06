# The hosted relay

Distronode runs a public worldinmotion relay so that you can try the project without running
your own:

```
wss://worldinmotion.distronode.com
```

It is a Cloudflare Worker built from [`packages/relay-cloudflare`](../packages/relay-cloudflare/README.md)
in this repository. This page is its terms, in plain words. It is offered as is, during the
preview, and you can stop using it at any time by moving to a relay of your own.

## The offer

- **Free and open during the preview.** Until v1.0, anyone may create a mesh on it. There is no
  key and no sign-up: `wim init --relay wss://worldinmotion.distronode.com` is enough.
- **Open now.** The relay creates new meshes for anyone today (its `GET /v1/info` reports
  `"create": "open"`).
- **No SLA.** It may be slow, go down, or lose queued messages. Do not build anything on it that
  must not stop.
- **It may end.** We may end the offer with 60 days' notice.

`wim doctor` shows what the relay itself says about its offer and limits, read from the relay's
`GET /v1/info`. The hosted relay publishes: "Free hosted relay during the worldinmotion preview,
until version 1.0."

## What the relay can and cannot see

Messages are end-to-end encrypted between devices. The relay holds no key that can read them, and
it cannot forge or alter one without the receiving device dropping it.

The relay sees metadata only:

- device ids, and the session names, kinds and presence your devices publish;
- message sizes and times, and who sent to whom;
- room membership;
- that a short invite code exists, which admin device stored it, its size, and when it is fetched,
  for at most an hour; never the code or the invite sealed inside it;
- each connection's source address while it is connected. For rate limits the relay keeps only
  a keyed hash of it (per IPv4 address, or per IPv6 /64), made under a random secret the relay
  keeps to itself, so a stored key cannot be turned back into an address by trying every
  address. The relay does not store the raw address.

It never sees message content, file content, file names or peer cards. The full list, and what a
hostile relay could still do (drop, delay, withhold), is in [SPEC.md](../SPEC.md) section 10 and
[SECURITY-MODEL.md](../SECURITY-MODEL.md) sections 5.4 and 6.10.

Cloudflare operates the infrastructure the relay runs on, and its own logs and terms apply to the
connections it carries.

### CI senders

CI senders (a GitHub Actions or GitLab CI/CD job sending a notice to one of your sessions,
[SPEC.md](../SPEC.md) section 18) are **enabled** on the hosted relay since 2026-11-06 (relay
0.1.9): its `GET /v1/info` reports `"ci": true`. Nothing reaches a device unless its person ran
`wim ci allow` there. For CI notices, the relay also sees:

- **a GitHub notice's ID token, once**, to verify it: for that moment, every claim it carries
  (the repository and its owner, their ids and visibility, the ref, workflow, event, commit, run
  ids, the actor's login and id, and the environment). It stores none of them and never the
  token. It keeps only a counting key per repository (a hash of the repository's ids) and a hash
  of the token's id until the token expires, which stops it being used twice;
- **each device's rule tags**: hashes of the repositories and refs, or ref patterns such as
  `refs/tags/v*`, a device accepts notices from, which give away a repository name, ref or
  pattern that can be guessed, and whether the device accepts GitLab notices. The device never
  sends a pattern itself: for each verified GitHub token the relay hashes the exact ref and every
  prefix of it followed by `*`, and so learns which ref or pattern a notice matched;
- which session accepts notices, and each notice's target, size and time.

It never sees a GitLab token, so never a GitLab pipeline user's login or email address, and
never a notice's text.

Ref patterns need a relay that reports `"ciPatterns": true` in `GET /v1/info` (relay 0.1.10 and
later). On a relay without it, a GitHub notice that only a pattern rule allows is refused, and
`wim ci allow` warns when such a rule is made. GitLab notices are not affected.

## Limits

- **At most 2,000 meshes** on the relay in total. When it is full, `wim mesh create` says so; run
  your own relay, or try again later.
- **Files: 25 MiB per mesh per day**, in total across the mesh's devices. Each single file is also
  limited to 25 MiB by the protocol.
- **A mesh with no connection for 30 days is deleted**, with its roster, queues and files. A mesh
  any of whose devices connects at least once in 30 days is kept. An admin device deletes one
  sooner with `wim mesh delete` (a test mesh, say), which also frees its place in the 2,000.
- **Rate limits per network**: creating, joining and recovering meshes is limited per source
  address (per IPv4 address, or per IPv6 /64), and so are connections (600 a minute per address,
  plenty for an office reconnecting every session at once), on top of the protocol's own limits
  on sends, broadcasts and sessions ([SPEC.md](../SPEC.md) section 9). A connection past the limit
  is refused for a moment and the client retries by itself.

The hosted relay sets these limits with the same settings any relay has: `WIM_OPEN_CREATE=1`,
`WIM_MAX_MESHES=2000`, `WIM_IDLE_MESH_DAYS=30` and `WIM_BLOB_BYTES_PER_MESH_PER_DAY=25MiB`
([packages/relay-node/README.md](../packages/relay-node/README.md) lists them all).

## When the offer ends

v0.1 cannot move a mesh from one relay to another. A mesh's relay URL is part of every invite and
every device's configuration. When the offer ends, or whenever you want to leave:

1. Run a relay of your own: [relay-node](../packages/relay-node/README.md) or the
   [Cloudflare template](../packages/relay-cloudflare/README.md).
2. On one device, create a new mesh on it: `wim mesh create --relay wss://relay.example.com`
   (with `--key-env NAME` if your relay needs an operator key).
3. Invite each of your other devices again with `wim invite` and `wim join <code>`, and trust
   your own devices again with `wim devices trust <name>`.

Each device keeps its keys, so it can be in both meshes while you move. When it is in more than
one mesh, pass `--mesh <id>` (or set `WIM_MESH`) to pick one. Messages, rooms and leases on the
old mesh do not carry over; local history stays on each machine.

## Acceptable use

By using the hosted relay you agree not to use it:

- for illegal content or activity;
- to send spam or unsolicited messages to people or agents who did not ask for them;
- to abuse the infrastructure: no attempts to get around the limits, to overload the relay, to
  reach meshes that are not yours, or to use it as general-purpose storage or transport for
  something other than worldinmotion.

The relay cannot read content, so we act on reports. We may delete a mesh on a credible report of
abuse. Deleting a mesh removes it for every device in it.

## Reporting abuse

Email **opensource@distronode.com** with the mesh id if you have it, what happened and when (with
time zone). Do not send invite codes, recovery codes or key files.

A security vulnerability in the relay software is not abuse: report it privately as described in
[SECURITY.md](../SECURITY.md).
