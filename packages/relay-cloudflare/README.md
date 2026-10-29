# @worldinmotion/relay-cloudflare

The worldinmotion relay as a Cloudflare Worker with one Durable Object per mesh. The relay logic is
`@worldinmotion/relay-core`; this package is its Cloudflare host, the counterpart of
`@worldinmotion/relay-node`, and behaves the same on the wire.

## How it runs

- **Worker** (`src/worker.ts`). `GET /healthz` reads the configuration (no Durable Object) and
  answers 200 `{"ok":true}`, or 503 `{"ok":false,"error":"<reason>"}` when the relay cannot run
  or its create settings are wrong (see Configuration); the reason names a setting, never its
  value. `GET <prefix>/v1/<mesh id>` with a WebSocket upgrade goes to the mesh's Durable Object
  (`idFromName(meshId)`); a mesh id that is not 16 bytes of canonical base64url is a 400, a request
  without an upgrade a 426, anything else a 404. The dial path, the status codes, the source key
  and `/healthz` come from `@worldinmotion/relay-core`, so relay-node answers the same way. The
  Worker hashes `CF-Connecting-IP` into a 22-character source key and builds a fresh request for
  the object, so no client header, including a forged source key, ever reaches it.
- **`MeshDurableObject`**, one per mesh. It accepts sockets with the WebSocket Hibernation API and
  keeps each socket's relay connection state in its attachment. Everything else lives in the
  object's SQLite database, under relay-core's schema and migrations. When the runtime evicts an
  idle object, its sockets stay open; the next message builds a new `MeshRelay` from SQLite and
  from `ctx.getWebSockets()` with their attachments, and the sessions carry on, still online.
- **Nothing for a mesh that does not exist.** Anyone can dial any well-formed mesh id, so an object
  writes nothing to SQLite until a `create` succeeds: before that the relay runs over an in-memory
  store (relay-core stores nothing for a mesh that does not exist), and the mesh id rides in each
  socket's attachment. A successful `create` writes the schema, the `cf_host` row and the genesis
  roster. When the last socket of an object that never held a mesh closes, or its alarm closes it,
  the object deletes all of its storage. Objects left by an earlier version, with tables but no
  roster, are cleared the same way the next time they are dialled.
- **Alarm.** Expiry sweeps (`MeshRelay.tick`) run from the object's alarm, never a timer. It is armed
  for the next due expiry (a pre-auth deadline, a lease end, a queued message's lifetime, an
  invite's expiry and so on), and every 60 seconds while any socket is open.
- **Retention.** Room history is deleted 72 hours after each message, queued messages and files
  after 24 hours; 72 hours is the ceiling for all three (SPEC section 13). A history entry past
  72 hours is never served, even before the alarm deletes it. One alarm deletes at most 256
  history entries, so an object with a large backlog clears it over a few alarms a second apart
  and no alarm runs long.
- **`SourceLimiter`**, one per hashed client address: the `create` and `join` limit (10 an hour)
  across every mesh, as relay-node keeps one limiter per process. Addresses are counted per IPv4
  address and per IPv6 /64 (an IPv4-mapped IPv6 address counts as IPv4). An alarm deletes an idle
  bucket after an hour.
- **`MeshRegistry`**, one for the whole Worker: the mesh count for `WIM_MAX_MESHES`. A mesh object
  calls it only on a `create` (to reserve a place, and to give it back if that create fails) and
  when it deletes an expired mesh, never per message. It counts meshes created since it was added
  to the Worker; meshes made by an earlier version are not in the count.
- **Keepalives.** The object registers a WebSocket auto-response, so the runtime answers the
  client's `{"t":"ping"}` with `{"t":"pong"}` without waking the object, and Cloudflare bills it
  neither as a request nor as duration. An authenticated socket that sent nothing, not even a
  ping, for 5 minutes is closed (1001, "no keepalive") by the alarm, which reads the runtime's
  auto-response time for each socket. The alarm runs every minute while sockets are open, so a
  client that vanished without closing is taken offline within about 6 minutes; one that closes
  is noticed at once.

Frames over the protocol limits are refused by relay-core before it parses them: 16 KiB before
`auth`, 1 MiB after. Binary frames close the socket (1003).

## Configuration

| name | where | meaning |
|---|---|---|
| `WIM_RELAY_URLS` | `vars` | Comma-separated exact public base URLs clients dial, for example `wss://relay.example.com`. Required: an `auth` signs this URL and the relay compares it byte for byte, so the object refuses connections without a valid one, and `/healthz` answers 503. |
| `WIM_CREATE_KEY` | secret | The operator key `create` must carry. A public relay should set it. An empty value (for example from a secret pipe that wrote nothing) is a misconfiguration, not "no key": the relay refuses every `create`, logs a `config` event, and `/healthz` answers 503. |
| `WIM_OPEN_CREATE` | `vars` | `1` lets anyone create a mesh without a key. Setting it together with `WIM_CREATE_KEY`, or to anything but `1`, `true`, `0`, `false` or empty, is a misconfiguration (as above). |
| `WIM_MAX_MESHES` | `vars` | Unset: no cap. The most meshes the relay holds (a whole number of 1 or more), counted by `MeshRegistry`. A `create` past it gets `error { code: "full" }`; existing meshes are unaffected. |
| `WIM_IDLE_MESH_DAYS` | `vars` | Unset: never. Delete a mesh no session has used for this many days (below). |
| `WIM_BLOB_BYTES_PER_MESH_PER_DAY` | `vars` | Unset: 1 GiB (the protocol limit). File bytes all devices of one mesh may store per day. |
| `WIM_BLOB_BYTES_PER_DEVICE_PER_DAY` | `vars` | Unset: 200 MiB. File bytes one device may store per day. |
| `WIM_BLOB_BYTES_PER_MESH` | `vars` | Unset: 1 GiB. File bytes one mesh may hold at once. |
| `WIM_OFFER` | `vars` | Unset: none. One line, at most 280 printable characters, published in `/v1/info`. |

The byte limits take a byte count or a number with `KiB`, `MiB` or `GiB` (`25MiB`), and may only
lower the protocol's limits, never raise them; a chunk past one is refused with
`error { code: "blob_quota" }`. Any guardrail value that is not valid is a misconfiguration as
above: creation is refused, `/healthz` answers 503, and that setting keeps its safe default.

**Upgrading from 0.1.1 or earlier**, which kept room history for 7 days: nothing to run, and no
storage migration. After the deploy no object serves history older than 72 hours. An object
deletes its older history from its next alarm on: within a second of any dial, within a minute for
a mesh with a socket open, and otherwise when the alarm the old version armed fires, at most 4 days
after the deploy (when its oldest history entry turns 7 days old).

**Idle meshes are deleted** when `WIM_IDLE_MESH_DAYS` is set. When the last authenticated session
leaves a mesh, the object records the time and arms its alarm for the expiry; the next session
that connects cancels it. A socket that never authenticates neither starts nor stops the clock.
When it expires, the object closes any socket still on it (1001, "mesh expired"), deletes all of
its storage, gives its place in the mesh count back, and logs an `expired` event. **An expired
mesh is gone**: its devices get "unknown mesh" and must create a new mesh and invite each other
again.

## `/v1/info`

`GET <prefix>/v1/info` answers 200 with a small public JSON document, without touching a Durable
Object. It holds no secret and no live count:

```json
{ "v": 1, "software": "worldinmotion-relay", "version": "0.1.0", "create": "key",
  "limits": { "max_meshes": 2000, "idle_mesh_days": 90, "blob_bytes_per_mesh_per_day": 26214400 },
  "offer": "Free hosted relay during the preview" }
```

`create` is `key`, `open` or `closed` (also for a misconfigured relay). In `limits`, `null` means
unlimited, and `blob_bytes_per_mesh_per_day` is the effective value. `offer` is `WIM_OFFER`, or
`null`.

Mesh creation is never open by accident. With `WIM_CREATE_KEY` set, `create` needs the key; with
`WIM_OPEN_CREATE=1`, anyone may create; with neither (the template's default), every `create` is
refused with `unauthorized`, and the relay still serves meshes that already exist.

## Deploying your own relay

`wrangler.jsonc` here is a generic template with no account, route or domain. To deploy:

1. Copy it to a configuration of your own (for example `wrangler.production.jsonc`, kept out of
   version control or in your own repository) and add:
   - `"account_id": "<your account id>"`;
   - a custom domain or route, for example
     `"routes": [{ "pattern": "relay.example.com", "custom_domain": true }]`;
   - `WIM_RELAY_URLS` in `vars` set to the URL clients will dial, exactly as it appears in your
     invites (`wss://relay.example.com`, no trailing slash).
   Keep the `durable_objects` bindings and the `migrations` entries as they are: every class uses
   Durable Object SQLite (`new_sqlite_classes`), which cannot be changed after the first deploy.
   A relay deployed before `MeshRegistry` existed gets it from the `v2` migration on its next
   deploy; copy that binding and migration into your configuration if it does not inherit them.
2. Decide who may create meshes. Either set an operator key (recommended for a relay on the
   internet) with `npx wrangler secret put WIM_CREATE_KEY -c wrangler.production.jsonc`, which
   prompts for it, or add `"WIM_OPEN_CREATE": "1"` to `vars` for a relay anyone may create meshes
   on. With neither, the relay refuses every `create`. If a key ever arrives empty, the relay
   refuses `create` rather than opening it, and `/healthz` says so.
3. Deploy: `npx wrangler deploy -c wrangler.production.jsonc`.
4. Check: `curl https://relay.example.com/healthz` answers `{"ok":true}`. A 503 names the setting
   to fix. Then create a mesh with your key, and check that one without it is refused.

`observability` is off in the template. Turn it on in your own configuration if you want Workers
Logs; the relay logs only operator events (roster forks), never message contents, which it cannot
read anyway.

## Development

```sh
npm test --workspace=@worldinmotion/relay-cloudflare             # vitest inside workerd
npm run test:coverage --workspace=@worldinmotion/relay-cloudflare  # with istanbul coverage, 100% per file
npx wrangler dev --local                                           # from this directory, offline
```

The tests in `test-workers/` run inside the Workers runtime through `@cloudflare/vitest-plugin`,
over real WebSockets through the Worker, and cover eviction and recovery with the plugin's
`evictDurableObject`, alarms with `runDurableObjectAlarm`, and a clock the tests move. The root
vitest config runs in Node and excludes this package.
