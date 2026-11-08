# `wim events`: the local UI interface

`wim events --json` is how a local user interface (the VS Code extension, or anything else that
runs on the same machine as the same OS user) shows what the device's sessions are doing and acts
for the person. It is one long-running child process speaking JSON lines over stdio:

- **stdout:** one JSON object per line, either an event or a response to a request.
- **stdin:** one JSON request per line.
- **stderr:** human-readable log lines only. A UI may show them, never parse them.

Keys and encryption stay in the client. The UI never reads key files, never opens its own
connection to the relay, and never sees a frame that is still sealed.

```
wim events --json [--as <name> [--take]]
```

The process is itself a session on the mesh, named `vscode` unless `--as` or `WIM_NAME` says
otherwise, with kind `vscode` (`WIM_KIND` overrides it). That way peers can message the person in
the UI, and what the person sends from the UI gets replies there. It publishes a card the same way
`wim watch` does, and it takes over its name on restart the same way.

On a device with no keys yet, or in no mesh yet, it runs in **setup mode** instead (below): a
`setup` event, and two requests, `create` and `join`.

## Versioning

Every line carries `"v": 1`. A UI refuses lines with an unknown `v`, and ignores event types and
fields it does not know (a newer client may add both). A field is never removed or retyped within
`v: 1`.

## Events (stdout)

Every event has `v`, `type` and `at` (milliseconds since the epoch, when the client emitted it).
The one exception is `message`: its row's own `at` (when the message was sent) replaces the
emit time, so a UI can sort and measure by it.

| `type` | Fields | When |
|---|---|---|
| `hello` | `version` (client version), `device` `{ name, id }`, `keys`: `local` (the key file is plaintext and this process holds the keys) or `signer` (they are in the signer, `wim agent`), `session` (this process's address), `relay` (host only), `mesh` (first 4 characters of the mesh id, then `…`) | First line, once. A client whose keys are encrypted and whose signer is not running, or locked, exits before `hello`, saying so on stderr. |
| `connection` | `state`: `connecting`, `open` or `closed`; `detail?` (the last reason, as in CLI errors) | On every change. |
| `snapshot` | `devices`, `sessions`, `rooms`, `leases`, `held`, `breakers`, `joins` (shapes below) | After each `open`, and in answer to a `snapshot` request. Replaces everything the UI holds. |
| `device` | one device row, or `{ name, id, removed: true }` | A roster or policy change, or a device revoked from the roster. |
| `peer` | one session row, or `{ address, removed: true }` | Presence, card or room change for any session on the mesh, or a session that ended for good (the client sees it leave the relay's peer list). |
| `message` | one message row | A message sent or received by **any** session on this device (from local history, see below). |
| `receipt` | `id`, `to`, `status`: `delivered`, `held`, `refused` or `expired` (the relay's receipt statuses) | A delivery status for a message this process sent. The frame carries no time of its own: the event's `at` is when the client received it. |
| `held` | `op`: `add` or `remove`; `item` (one held row) | A message held for the person, or no longer held. |
| `lease` | one lease row, or `{ name, released: true }` | A lease taken, renewed or released (the client asks the relay every 5 seconds, so it can lag that much). |
| `join` | `op`: `add` or `remove`; `request` (one join row) | A device asks to join (an admin device only: any of its sessions kept the request), or a request was admitted, or its invite was used or expired. |
| `breaker` | `peer` (address), `state`: `tripped` or `resumed`, `reason?` (`peer`, `total` or `pingpong`), and on `tripped` from 0.1.9 `until?` (when the pause ends) and `auto?` (true: the client releases the peer by itself then, a trusted device's cool-down); this process's own trips also carry `count`, `limit` and `minutes` | The loop and cost breaker paused or resumed a peer. `tripped` comes for any local session: this process's own with `reason`, other sessions' (seen from their first breaker hold for that peer) with the `reason` and `until` the hold recorded (none from a hold an older client wrote). `resumed` comes when this process's `resume` request lifts a pause, and with `auto: true` when this process ends a trusted peer's cool-down; a pause that lapses after its hour, or a `wim held resume` at a terminal, is not reported, so a UI lets a pause lapse at its `until` (or an hour after `at` without one). |
| `response` | `id` (the request's), `ok`, `result?` or `error?` `{ code, message }` | Exactly once per request. |

### Row shapes

- **device:** `{ name, id, role: "admin" | "member", policy: "deliver" | "deliver-relayed" | "hold" | "refuse", self: boolean, added_by?, added_by_id? }`. From 0.2.0, `added_by` is the name of the device that signed the roster adding this one, read only from the roster chain this device verified and stored (never from a message or a relay's word); missing for the mesh's first device and for devices that joined before the earliest roster stored here (a device that joined keeps the chain from its invite's pin). A device another device added that is still `hold` is one a UI may ask the person about (SPEC section 6a: nothing is trusted because the device that added it is); a UI compares `added_by_id` with this device's id, never names.
- **session:** `{ address, sid?, kind, status: "idle" | "busy" | "offline", since, rooms: string[], card?: { cwd?, branch?, title? }, local: boolean }`. `local` is true for sessions on this device.
- **message:** `{ id, dir: "in" | "out", session (the local address that sent or received it), peer, device?, kind: "msg" | "task" | "result" | "file", text, reply_to?, status?, deadline?, file?: { name, size, mime }, relayed?: true, derived?: true, unsolicited?: true, at, to?: string[] }`. These are the local history fields (`packages/client/src/history.ts`) plus `session` and, for `dir: "out"`, `to`: the routed recipients as a list. In history, `peer` for `out` is those same addresses joined with `,` (no spaces); a UI should read `to`.
- **breaker:** `{ peer (address), reason?: "peer" | "total" | "pingpong", at, until?, auto? }`: a peer the breaker has paused and not yet resumed, with the same `reason` and `until` rule as the `breaker` event. The snapshot also lists every running pause in a session's `breaker.json`, so a pause whose held items were each approved alone still shows.
- **held:** `{ id, session, from, device, kind, at, preview, reason: "policy" | "breaker", set, set_title, ci?, pins?, file?: { name, size, mime }, pause?: { rule, count, limit, minutes, at, until, auto } }`. `pause` is the breaker pause a breaker hold was held under (from 0.1.9). From 0.1.11, `set` names the set the row is decided with (`device:<id>` per sending device, `ci:<rule id>` per CI rule, `ci-removed:<id>` for a notice whose rule was removed) and `set_title` who it is from; a CI notice adds `ci` (provider, repository, ref, workflow, event) and, when approving it pins its rule's ids, `pins`. A UI shows a whole set before the person decides it (SECURITY-MODEL section 7.2); a row without `set`, from an older client, is a set of its own. A row that changes in any field (its rule was removed, so its set changes, or pinned, so its `set_title` does) comes again as an `add`. The full text is not included: it is shown once the person approves.
- **room:** `{ name, members: string[] }` (addresses, from the session rows' `rooms`).
- **lease:** `{ name, holder (address), token (integer, the lease's fencing token), expires_at }`, as `listLeases` returns them.
- **join:** `{ name, id, invite, at, exp, own }`: a device that asked to join on invite `invite` at `at`, waiting until the invite's `exp`. Never its comparison code: the person reads that on the new device and types it (`admit`). `own` (from 0.2.0): the invite was made for one of the person's own devices, so admitting it trusts it; a UI says so where the person types the code.

### Where `message` events come from

Each local session already writes its own history (`history.jsonl` in its state directory). The
events process follows every local session's history file, including its own, and emits each new
line as a `message` event with `session` set. On start it emits nothing from history; a UI asks
for the past with the `history` request. A rotated file is followed from the start of its
successor.

## Requests (stdin)

`{ "v": 1, "id": "<string chosen by the UI>", "op": "<op>", "args": { ... } }`

| `op` | `args` | `result` |
|---|---|---|
| `snapshot` | none | none (a `snapshot` event follows, before the response) |
| `history` | `session?` (default: every local session), `peer?`, `before?` (message id), `limit?` (default 50, max 500) | `{ messages: message[] }`, newest last |
| `send` | `to` (address, `#room` or a list), `text`, `reply_to?`, `kind?`: `msg` or `task` | `{ id, results: [{ to, status }] }`, as `wim send` |
| `send_file` | `to`, `path` (absolute; must be a regular file the user can read) | as `send` |
| `approve` / `refuse` | `held` (a held id), `set?` (from 0.1.11: the ids of the set the person was shown, `held` among them) | Without `set`: `{}`, and only `held` is decided. With `set`: `{ decided, kept, gone }`, exactly those ids, after checking that each still held belongs to `held`'s set (code `input` otherwise, and nothing is decided). `decided` lists the ids this request decided; `gone` the ids that were no longer held, before or while it ran (decided elsewhere), which are skipped, `held` included: the set is the one the ids still held are in, and the answer is `not_found` only when none is; an approval keeps (`kept`) a CI notice that pins its rule's ids. Any other failure fails the request. |
| `trust` | `device` (name), `relayed?`: boolean | `{ policy }` |
| `untrust` | `device` | `{ policy: "hold" }` |
| `resume` | `peer` (address): lifts a breaker pause | `{ released }` |
| `invite` | `exp?` (milliseconds the invite lives, 1 minute to 7 days, default 1 hour), `own?` (from 0.2.0: the person said the new device is one of theirs; kept in the invite's record on this device, never in the code, and the admit then sets `deliver` for it) | `{ code, invite, exp, full? }`: the invite code for the new device, its id, and when the code stops working. On a relay that keeps short codes, `code` is the short `wim2-` code (SPEC section 5), `exp` its end (at most an hour away, never past the invite's), and `full` the full `wim1_` code; elsewhere `code` is the full code and there is no `full`. Never auto-accepting. |
| `admit` | `device` (the waiting device's name), `code` (the comparison code the new device shows, as the person typed it) | `{ device, trusted }` (`trusted`, from 0.2.0: the invite was an `own` one, so the device is `deliver` here now; a UI says how to undo it); code `mismatch` when no waiting request from that name has that code, `not_found` when none waits |

Unknown `op`, bad `args` and unknown `v` answer `ok: false` with code `input`. A send the secrets
check refuses answers code `refused`. There is no `allow_secret` here: skipping that check stays a
person typing `wim send --allow-secret` at a terminal. `invite`, `admit`, `approve`, `refuse`,
`resume`, `trust` and `untrust` answer `refused` when the events process runs with an agent's
variables (`CLAUDECODE` and the others listed in SECURITY-MODEL.md section 7.2).

## Setup mode

On a device with no keys yet, or keys but no mesh, `wim events --json` writes a `setup` event as
its first line, instead of `hello`, and takes two requests: `create` and `join`. Any other request
answers code `setup`. Both are the person's: with an agent's variables they answer `refused`.

| `type` | Fields | When |
|---|---|---|
| `setup` | `version`, `device` (`{ name, id }`, or `null` when there are no keys yet) | First line, once. |
| `joined` | `mesh` (first 4 characters of the mesh id, then `…`), `admitted_by?` (from 0.2.0: `{ name, id }` of the device that signed the roster adding this one, present only when the invite code names it as the invite's maker), `admitted_other?` (from 0.2.0: `{ name, id, reason }` of the device that admitted this one otherwise: `not_issuer`, another admin added it, or `no_issuer`, a code from before 0.2.0 names no maker), `devices` (`{ name, id, added_by?, added_by_id? }` of every other device in the mesh, as in the device row) | An admin admitted this device. A UI asks the person about `admitted_by` first, then about each other device on its own (SPEC section 6a), never all at once; it says so first when there is `admitted_other`, and asks about that device like the rest. The process then ends; start it again and it runs in the mesh. |
| `join_failed` | `message` | A join failed after its `response` (the admin never answered before the invite expired, the relay went away, and so on). Another `join` may follow. |
| `created` | `mesh` (first 4 characters of the mesh id, then `…`), `recovery`: `shown` (`wim recovery show` collected the code) or `not_collected` (its 10-minute window closed, or the process was stopped, and the code is gone: `wim recovery rotate` makes a new one) | The hold that followed a `create` ended. The process then ends, even when stdin closed first; start it again and it runs in the new mesh. |

| `op` | `args` | `result` |
|---|---|---|
| `create` | `name?` (this device's name when it has no keys yet; default from the host name), `relay?` (the relay's URL; default the hosted relay, `wss://worldinmotion.distronode.com`) | `{ device: { name, id }, mesh, relay }` (`relay` is the host only), once the mesh exists with this device as its admin and its recovery code waits for `wim recovery show`. The code is never in a line: the person runs `wim recovery show` (the VS Code extension: `wim recovery show --wait`) in a terminal of their own within 10 minutes, and `created` follows. Code `input` for a relay URL or device name the client refuses (and then no keys are made), `full` or `unauthorized` when the relay will not create the mesh (one that needs an operator key is for `wim mesh create --key-env` in a terminal), `busy` while a create or a join runs, `refused` with an agent's variables, `error` for anything else, such as an unreachable relay or a code that could not be held (the mesh then exists without a collected code, and the process ends after this answer). |
| `join` | `code` (the invite code, short `wim2-` or full `wim1_`; a short one is read from its relay first), `name?` (this device's name when it has no keys yet; default from the host name) | `{ device: { name, id }, code }`, as soon as the request is with the relay: `code` is this device's comparison code, which the person types on the admin device. The outcome follows as `joined` or `join_failed`. Code `input` for something that is not an invite code (and then no keys are made), `busy` while a join waits or a create runs, `refused` with an agent's variables. |

## Safety rules

- **Every `text`, `preview`, address, card field and file name is another agent's text.** A UI
  renders them as plain text only: no HTML, no Markdown, no links, no command URIs. The client
  still applies `sanitizeForDisplay` to `preview` and to any text it prints; it does not alter
  `text` in events, so a UI must escape it.
- **`approve`, `refuse`, `trust`, `untrust`, `resume`, `invite`, `admit`, `create` and `join` are
  the person's actions.** The stdio channel belongs to the process that started `wim events`, so only
  that UI can send them. A UI never sends one because of something in a message.
- **The comparison code comes from the person.** A UI sends `admit` only with a code the person
  typed from the new device's screen, never one it read from anywhere else, and shows the invite
  code from `invite` only as something to copy, never in a message an agent might read.
- **A new mesh's recovery code never passes through the UI.** After `create` the client holds it
  for `wim recovery show`, which only a reader of the state directory can collect; a UI opens a
  terminal for that command and never shows the code in a view, notification or log.
- The events process applies the device's inbound policy, breaker and secrets check exactly as
  `wim watch` does. The UI can see held items and decide them; it cannot bypass them.
