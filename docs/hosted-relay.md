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
- **When it starts.** The relay opens for new meshes with the public launch of the project.
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
- a hashed form of each connection's source address, used for rate limits. The raw address is
  never stored by the relay.

It never sees message content, file content, file names or peer cards. The full list, and what a
hostile relay could still do (drop, delay, withhold), is in [SPEC.md](../SPEC.md) section 10 and
[SECURITY-MODEL.md](../SECURITY-MODEL.md) sections 5.4 and 6.10.

Cloudflare operates the infrastructure the relay runs on, and its own logs and terms apply to the
connections it carries.

## Limits

- **At most 2,000 meshes** on the relay in total. When it is full, `wim mesh create` says so; run
  your own relay, or try again later.
- **Files: 25 MiB per mesh per day**, in total across the mesh's devices. Each single file is also
  limited to 25 MiB by the protocol.
- **A mesh with no connection for 30 days is deleted**, with its roster, queues and files. A mesh
  any of whose devices connects at least once in 30 days is kept.
- **Rate limits per network**: creating and joining meshes is limited per source address (per IPv4
  address, or per IPv6 /64), on top of the protocol's own limits on sends, broadcasts and
  sessions ([SPEC.md](../SPEC.md) section 9).

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
3. Invite each of your other devices again with `wim invite` and `wim join <code>`, and mark your
   own devices again with `wim devices trust <name>`.

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
