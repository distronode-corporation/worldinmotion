# @worldinmotion/relay-node

A self-hosted worldinmotion relay: one Node process serving many meshes, with `node:http`, `ws`
and `node:sqlite`. The relay logic is `@worldinmotion/relay-core`; this package is its Node host,
the counterpart of `@worldinmotion/relay-cloudflare`, and behaves the same on the wire.

The relay is untrusted for message content: messages are end-to-end encrypted between devices,
and the relay only routes and queues them. Running your own relay is about availability and
metadata (who talks to whom, and when), not about who can read your messages.

## Requirements

Node 22.18 or newer (the relay runs its TypeScript sources directly), or Docker.

## A minimal secure first run

On one machine, listening on loopback only, with an operator key so nobody else can create
meshes on it:

```sh
npm ci                                    # from the repository root
umask 077
openssl rand -hex 32 > wim-create-key     # keep this file private
WIM_CREATE_KEY="$(cat wim-create-key)" node packages/relay-node/src/bin.ts
```

It prints `wim-relay listening on ws://127.0.0.1:8787` and how it answers `create`. In another
shell:

```sh
curl -s http://127.0.0.1:8787/healthz     # {"ok":true}
WIM_KEY="$(cat wim-create-key)" wim mesh create --relay ws://127.0.0.1:8787 --key-env WIM_KEY
```

Plain `ws://` is accepted only on loopback. To reach the relay from other machines, put it behind
a TLS proxy (below) or use LAN mode.

## Settings

Every setting is an environment variable, plus one argument.

| name | default | meaning |
|---|---|---|
| `WIM_RELAY_URLS` | `ws://<host>:<port>` on loopback, `wss://<LAN address>:<port>` in LAN mode | Comma-separated exact public base URLs clients dial, for example `wss://relay.example.com`. An `auth` signs this URL and the relay compares it byte for byte, so it must be spelled exactly as clients and invites spell it: `wss://` (or `ws://` to loopback only), no trailing slash, no query. Required for a relay that is not on loopback; the relay refuses to start without it, or with an entry that is not a relay URL. |
| `PORT` | `8787` | The port to listen on (`0` picks a free one). |
| `WIM_HOST` | `127.0.0.1`, or the LAN address in LAN mode | The address to bind. `0.0.0.0` binds every interface (the container does this). |
| `WIM_DB` | `wim-relay.db` | The SQLite database file. One database holds every mesh. Keep it on persistent storage: it holds the rosters, queues and leases. |
| `WIM_CREATE_KEY` | unset | The operator key a `create` must carry (clients pass it with `wim mesh create --key-env NAME`). |
| `WIM_OPEN_CREATE` | unset | `1` (or `true`) lets anyone create a mesh without a key. |
| `WIM_MAX_MESHES` | unset: no cap | The most meshes the relay holds (a whole number of 1 or more). A `create` past it is refused with `error { code: "full" }`; meshes it holds are unaffected. |
| `WIM_IDLE_MESH_DAYS` | unset: never | Delete a mesh no session has used for this many days (a whole number of 1 or more). See "Idle meshes are deleted" below. |
| `WIM_BLOB_BYTES_PER_MESH_PER_DAY` | 1 GiB (the protocol limit) | File bytes all devices of one mesh may store per day. |
| `WIM_BLOB_BYTES_PER_DEVICE_PER_DAY` | 200 MiB (the protocol limit) | File bytes one device may store per day. |
| `WIM_BLOB_BYTES_PER_MESH` | 1 GiB (the protocol limit) | File bytes one mesh may hold at once (files are kept 24 hours). |
| `WIM_OFFER` | unset | One line (at most 280 printable characters) about your service, published in `/v1/info`, for example `Free hosted relay during the preview`. |
| `WIM_TRUST_PROXY` | off | `1` (or `true`): take the client address for rate limits from the last `X-Forwarded-For` entry. Only behind a proxy you run, which appends that entry; otherwise clients could choose their own address. |
| `WIM_LAN` or `--lan` | off | LAN mode, below. |

### Who may create a mesh

Mesh creation is never open by accident:

- with `WIM_CREATE_KEY` set, `create` must carry that key;
- with `WIM_OPEN_CREATE=1`, anyone who can reach the relay may create a mesh;
- with neither, every `create` is refused (`error { code: "unauthorized" }`). The relay still
  serves meshes that already exist in its database.

An empty `WIM_CREATE_KEY` (for example from a secret pipe that wrote nothing) is a
misconfiguration, not "no key". So is setting both `WIM_CREATE_KEY` and `WIM_OPEN_CREATE=1`, or
`WIM_OPEN_CREATE` to anything but `1`, `true`, `0`, `false` or empty. A misconfigured relay
refuses every `create`, prints `configuration problem: ...` at start, and `/healthz` answers 503.
Messages name the setting, never its value.

### Guardrails for a relay others use

Every guardrail is off, or at the protocol's own limit, until you set it, so a private relay
needs none of them. A relay you offer to others can set:

- `WIM_MAX_MESHES`, a cap on meshes. The relay counts the meshes in its database, once per
  `create`.
- `WIM_IDLE_MESH_DAYS`, to delete meshes nobody uses.
- the `WIM_BLOB_BYTES_*` limits. They take a byte count, or a number with `KiB`, `MiB` or `GiB`
  (`25MiB`), and may only lower the protocol's limits, never raise them. A file chunk past a limit
  is refused with `error { code: "blob_quota" }`, and the message says which allowance ran out.

A value that is not valid is a configuration problem, as above: the relay refuses every `create`,
reports it in `/healthz`, and keeps the safe default for that setting.

Rate limits for `create`, `join` and recovery `auth` (10 an hour, together) are kept per client
address: per IPv4 address, and per /64 for IPv6, so a client cannot draw a fresh budget by moving
inside its /64. An IPv4-mapped IPv6 address (`::ffff:192.0.2.1`) counts as the IPv4 address.

Per address, too, the relay takes at most 600 WebSocket dials a minute and holds at most 256
connections that have not authenticated; past either it answers the upgrade with HTTP 429 and
`Retry-After`, before the handshake, and clients retry with backoff. A mesh id that was only
dialled is held in memory only while a socket is open on it.

The relay keeps those limits under a keyed hash of the address, never the address itself, made
under a random secret it creates in its database on first start (table `relay_node_secret`) and
keeps across restarts; there is nothing to configure.

### What the relay keeps, and for how long

The relay holds only ciphertext and the metadata it routes by. It deletes:

- **room history** 72 hours after each message (and keeps at most 100 messages per room, 64 MiB
  per mesh). An entry past 72 hours is never served, even before the sweep deletes it;
- **queued messages** for an offline session 24 hours after they were queued, with an `expired`
  receipt to the sender. An undelivered direct box never outlives the 72 hours below;
- **files** (blob chunks) 24 hours after they were stored.

72 hours is the ceiling for all three, matching the prekey retention of forward secrecy (SPEC
section 13): a relay may lower these lifetimes, never raise one past it. Expiry sweeps run every
second, over every mesh in the database, including meshes nobody has dialled since the relay
started (8 of those a second, in turn). One sweep deletes at most 256 history entries per mesh, so
a large backlog goes over several seconds and never blocks the relay for long.

**Upgrading from 0.1.1 or earlier**, which kept room history for 7 days: nothing to run. History
older than 72 hours is never served after the upgrade, and the sweeps delete it from the start: a
mesh in use loses up to 256 entries a second, and every other mesh as many on each pass over the
database (one pass takes about `meshes / 8` seconds).

### Idle meshes are deleted

With `WIM_IDLE_MESH_DAYS` set, the relay deletes every mesh that has had no authenticated session
for that many days: its rosters, queued messages, rooms, history, leases and files. The time
starts when the last session leaves (or, for meshes already in the database, when the relay
starts), and any session that connects resets it. A socket that never authenticates does not.
**An expired mesh is gone.** Its devices get "unknown mesh" and must create a new mesh and invite
each other again. The relay logs each deletion as an `expired` event.

A relay reachable from the internet should set `WIM_CREATE_KEY`. Without a key, anyone can make
meshes on your relay and fill your disk with them, within the per-address limit of 10 creates
and joins an hour.

## `/v1/info`

`GET <prefix>/v1/info` answers 200 with a small public JSON document that clients (for example
`wim doctor`) can show. It holds no secret and no live count:

```json
{ "v": 1, "software": "worldinmotion-relay", "version": "0.1.0", "create": "key",
  "limits": { "max_meshes": 2000, "idle_mesh_days": 90, "blob_bytes_per_mesh_per_day": 26214400 },
  "offer": "Free hosted relay during the preview" }
```

- `create` is `key`, `open` or `closed`, the last also for a relay whose settings are wrong.
- In `limits`, `null` means unlimited (`WIM_MAX_MESHES` or `WIM_IDLE_MESH_DAYS` unset), and
  `blob_bytes_per_mesh_per_day` is the effective value: the setting, or the protocol's 1 GiB.
- `offer` is `WIM_OFFER`, or `null`.

## `/v1/rdv/<id>`

`GET <prefix>/v1/rdv/<id>` hands out the box of a short invite code (SPEC section 5): 200 with
`{ "v": 1, "rdv", "exp", "n", "c" }`, 404 when there is none (never stored, expired, or already
fetched three times), 400 for an id that is not 22 characters of base64url, and 429 past 30
fetches an hour from one address. Answers carry `Cache-Control: no-store`. Admin devices store
boxes with the `rdv.put` frame; they live in the same database as the meshes, at most an hour
each and 10,000 at once, and the relay sweeps them with its other expiries.

## `/healthz`

`GET /healthz` answers 200 `{"ok":true}`, or 503 `{"ok":false,"error":"<reason>"}` when a create
setting or a guardrail is wrong (see above). A relay whose `WIM_RELAY_URLS` is missing (off loopback) or invalid
does not start at all, so it answers nothing. The container's `HEALTHCHECK` uses this endpoint.

Other paths answer 404 (except `/v1/info` and `/v1/rdv/<id>`, above). A WebSocket upgrade to `<prefix>/v1/<mesh id>` opens a connection to that
mesh; a mesh id that is not 16 bytes of canonical base64url is refused with 400, any other path
with 404, as the Cloudflare relay does.

## Behind a TLS proxy

For a relay on the internet, terminate TLS in a proxy you run (Caddy, nginx, a load balancer) and
forward WebSocket upgrades to the relay:

```sh
WIM_HOST=127.0.0.1 PORT=8787 WIM_DB=/var/lib/wim/wim-relay.db \
WIM_RELAY_URLS=wss://relay.example.com WIM_TRUST_PROXY=1 \
WIM_CREATE_KEY="$(cat /etc/wim/create-key)" \
node packages/relay-node/src/bin.ts
```

`WIM_RELAY_URLS` is the URL clients type, not the address the relay listens on. A relay URL may
carry a path (`wss://example.com/wim`); clients then dial `/wim/v1/<mesh id>`, and the relay
accepts the path with or without the prefix, so the proxy may strip it or not.

## LAN mode

For peers on one local network without a certificate authority:

```sh
WIM_CREATE_KEY="$(cat wim-create-key)" node packages/relay-node/src/bin.ts --lan
```

The relay binds the first non-internal IPv4 address (or `WIM_HOST`) and serves `wss://` with a
self-signed certificate. It never falls back to plain `ws://`. The key and certificate are kept
next to the database (`<WIM_DB>.key.pem` and `<WIM_DB>.cert.pem`, both mode 0600), created on the
first start and reused after, so LAN mode needs a database file. At start it prints:

```text
LAN relay URL: wss://192.168.1.20:8787
TLS pin (SPKI SHA-256, for the invite): <43 characters>
```

Clients do not validate the certificate against a CA; they pin the hash of its public key. Pass
the pin when creating or joining (`wim mesh create --relay wss://192.168.1.20:8787 --tls <pin>`);
invites carry it to the devices that join. Keep the two `.pem` files: a new key means a new pin,
and invites with the old pin stop working. In LAN mode every relay URL must be `wss://`.

## On a tailnet

Not yet tested on a tailnet. A relay for one person's devices can live on a private network such
as a Tailscale tailnet, so that only those devices can reach it. A private network alone is not
enough for the client: it accepts `ws://` only to loopback, so a relay on a tailnet still needs
`wss://`. Two ways to get it, both built from the sections above:

- **LAN mode on the tailnet address.** `--lan` binds the first non-internal IPv4 address it
  finds, which may be the machine's LAN address rather than its tailnet one, so name it with
  `WIM_HOST`:

  ```sh
  WIM_HOST="$(tailscale ip -4)" WIM_CREATE_KEY="$(cat wim-create-key)" \
  node packages/relay-node/src/bin.ts --lan
  ```

  Then create the mesh with the URL and pin it prints, as in [LAN mode](#lan-mode). The pin is
  what lets clients trust the relay's self-signed certificate.
- **Tailscale Serve in front of the relay.** Run the relay on loopback and let Tailscale give it a
  certificate for the machine's tailnet name, as in [Behind a TLS proxy](#behind-a-tls-proxy).
  Tailscale's documentation says Serve needs HTTPS certificates turned on for the tailnet and is
  reachable only inside it; it does not say whether it forwards WebSocket upgrades, which the
  relay needs:

  ```sh
  WIM_RELAY_URLS=wss://<machine>.<tailnet>.ts.net WIM_CREATE_KEY="$(cat wim-create-key)" \
  node packages/relay-node/src/bin.ts
  tailscale serve 8787
  ```

The relay is still untrusted for message content either way, and the tailnet adds no
cryptographic trust between devices: the signed roster does that. What the tailnet gives you is
who can reach the relay at all.

## Docker

Build the image from the repository root, then run it with a volume for the database:

```sh
docker build -f packages/relay-node/Dockerfile -t wim-relay .
docker run -p 8787:8787 -v wim-relay:/data \
  -e WIM_RELAY_URLS=wss://relay.example.com \
  -e WIM_CREATE_KEY="$(cat wim-create-key)" \
  wim-relay
```

The image runs as the unprivileged `node` user with `WIM_DB=/data/wim-relay.db`, `WIM_HOST=0.0.0.0`
and `PORT=8787`. Because it binds every interface, it needs `WIM_RELAY_URLS`, and like any relay
without a key or `WIM_OPEN_CREATE=1` it refuses `create`. The container serves plain `ws://`;
put a TLS proxy in front of it. Its health check calls `/healthz`, so a misconfigured relay shows
as unhealthy.

## Logs

The relay logs its start (URLs, how it answers `create`, any configuration problem, and in LAN
mode the pin) and operator events as JSON lines with the mesh id (`fork`, `revoked`). It never
logs message contents, which it cannot read anyway. A mesh id that was only dialled and never
created is kept in memory only while a socket is open on it and stores nothing on disk.

## Development

```sh
npx vitest run packages/relay-node    # from the repository root
```

The tests start real relays on loopback ports with databases under the system temp directory
(`TMPDIR`), or under `WIM_TEST_TMP` when it is set.
