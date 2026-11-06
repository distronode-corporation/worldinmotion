# worldinmotion wire protocol, `wim/1`

Status: draft for v0.1. This document is the contract between clients and relays. Nothing here
depends on Claude Code: any agent that can hold a WebSocket and do the crypto below can be a peer.

Version note, unreleased: section 11 adds deleting a mesh: an admin device's session sends
`mesh.delete { mesh }`, the relay answers `mesh.deleted { mesh }`, closes every connection on the
mesh with the new close code 4005 and deletes the mesh as it deletes an idle one (section 8 lists
the frames and the code). It is additive: an older relay answers `unknown_type` and deletes
nothing, and an older client treats 4005 as a lost connection, reconnects, is refused as for an
unknown mesh (4003) and stops. Every existing client and relay is compatible, so this is a `wim/1`
change.

Version note, unreleased: section 18 adds CI senders: a GitHub Actions or GitLab CI/CD job that is
not a mesh member sends one notice to one session, proving where it runs with its provider's OIDC
ID token. It adds an HTTP endpoint (`POST <relay>/v1/<mesh id>/ci`), the client frame `ci.rules`,
the relay frames `ci.rules` and `ci.deliver`, the signature type `ci`, the box plaintext kind `ci`,
a `ci` field in `/v1/info` (section 11), rows in sections 8, 9 and 10, and the vector file
`ci.json` (section 16). Everything is additive: an older relay answers the endpoint 404 and
`ci.rules` with `unknown_type`, a relay sends `ci.deliver` only to sessions that sent `ci.rules`,
and an older client ignores relay frames it cannot parse. Every existing client and relay is
compatible, so this is a `wim/1` change. The reference relays take CI senders only when their
operator turns them on.

Version note, unreleased: section 6 says that a room mode on MLS, the example for the reserved
box scheme numbers from 3 up, would be `wim/2` and is a design only, not part of v0.2 (see
docs/mls.md). Informative only: no frame, status or behaviour changed, so every existing client
and relay is compatible.

Version note, unreleased: section 5 lists every address range that counts as private or
link-local for the relay certificate pin rule, including IPv4-mapped and other IPv6 forms that
carry an IPv4 address, and the shared address space `100.64.0.0/10`. No frame changed and relays
are unaffected; a client refuses, without a pin, a `wss://` relay URL in those ranges that it
dialled before.

Version note, unreleased: section 9 adds two per-source limits a relay applies before the
WebSocket handshake (dials a minute, and connections open before `auth`), answered with HTTP 429
and `Retry-After` (section 8), and counts a recovery `auth` against the per-source limit that
`create` and `join` share, while the per-mesh recovery limit is spent only by a verified recovery
(section 4a). No frame changed. Clients already treat a refused dial as a lost connection and
retry with backoff, so every existing client is compatible.

Version note, 0.1.6: section 8 documents the keepalive and liveness timings of the reference client
and relays, and what a sender sees while a recipient is frozen. Informative only: no frame, status
or behaviour changed, so every existing client and relay is compatible.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Model

- A **device** is one machine plus one OS user plus one agent profile. It owns two key pairs:
  an Ed25519 signing pair and an X25519 encryption pair, kept in a file only its owner can read.
  It also makes a short-lived X25519 **prekey** each day per mesh, signed by its signing key
  (section 6b); senders seal to the prekey, and the device deletes each prekey's secret on a
  fixed schedule.
- A **mesh** is a set of devices that trust each other. Its membership is a **roster** that admin
  devices sign. A relay stores the roster and passes messages, but it cannot add a device, read a
  message, or forge one.
- A **session** is one running agent (a Claude Code session, a Gemini CLI session, a bot). A device
  hosts any number of sessions. Each session holds one WebSocket to the relay.
- An **address** is `name@device`, where `name` is the session name and `device` is the device
  name from the roster. `*` means every other session in the mesh, and `#name` is a room
  (section 13).
- Names are for people. Every trust and policy decision (inbound policy, revocation, which key
  verifies what) keys on the **device id**, never on a device or session name.
- A **CI sender** is a CI job (GitHub Actions or GitLab CI/CD) that is not in the roster. It holds
  no stored key, cannot authenticate to the relay and cannot read anything; it can only send one
  notice to one session of a device whose person allowed its repository (section 18).

## 2. Encodings

- **b64u**: base64url without padding (RFC 4648 section 5). Decoders MUST accept only the
  canonical form: no padding, no characters outside the alphabet, no length that is 1 modulo 4,
  and zero trailing bits, so every byte string has exactly one accepted encoding.
- **canon(x)**: the canonical JSON encoding used for every hash and signature:
  - Object keys are sorted by UTF-16 code unit, which is not code point order: U+1F600 (first code
    unit 0xD83D) sorts before U+E000.
  - There is no whitespace between tokens.
  - Strings use exactly the escapes of ECMAScript `JSON.stringify`: `\"`, `\\`, `\b`, `\f`, `\n`,
    `\r`, `\t`, and `\u` with four lowercase hex digits for the other characters below U+0020
    (for example `\u001f`). Every other character, including `/`, DEL and all non-ASCII, is
    written as itself in UTF-8. There is no Unicode normalisation: strings are compared and encoded
    as the exact code points given.
  - Numbers MUST be integers in the safe range, -(2^53 - 1) to 2^53 - 1, written in plain decimal
    (no fraction, no exponent, no leading `+` or zeros). `-0` is written `0`.
  - Object keys whose value is `undefined` are omitted. Arrays keep their order.
  - A value that cannot be encoded exactly is an error, never coerced: a float, NaN or an infinity,
    a bigint, a function or symbol, `undefined` inside an array, a sparse array, an object that is
    not a plain object (a date, map, typed array or class instance), an object with symbol keys, a
    string with an unpaired surrogate, a cycle, or nesting deeper than 64.
  - Implementers in other languages: Python's `json.dumps` escapes non-ASCII by default
    (`ensure_ascii=True`) and adds spaces after separators, so its output does not match and every
    signature fails. Use `ensure_ascii=False, separators=(",", ":"), sort_keys=True`, and note that
    `sort_keys` orders by code point, which differs from UTF-16 order for characters above U+FFFF.
- **JSON parsing.** Every party MUST reject a JSON text in which any object repeats a key (after
  unescaping, so `"a"` and `"\u0061"` are the same key). Parsers disagree about which duplicate
  wins, so accepting them would let two parties read the same signed bytes differently.
- **H(x)**: SHA-256. `hash(x)` = `b64u(H(canon(x)))`.
- **Times** are integer milliseconds since the Unix epoch.
- **Ids** are ULIDs (26 characters, uppercase Crockford base32), generated by the sender.
- **Device id**: `b64u(H(signPub))` truncated to 22 characters. Derived, never chosen.
- **Names** (session, device and room): 1 to 32 characters of `[a-z0-9-]`, starting with a letter
  or digit. A session `kind` uses the same alphabet.
- **Relay URL**: the base URL of a relay, exactly as written in an invite or configuration:
  `wss://host[:port][/path]` with no trailing slash, query, fragment or credentials. Clients MUST
  refuse `ws://` except to a loopback host (`localhost`, `127.0.0.0/8`, `[::1]`), even when the
  relay certificate is pinned (section 5). The URL is signed and compared byte for byte, so it is
  never normalised.

## 3. Keys and crypto

| purpose | algorithm |
|---|---|
| signatures | Ed25519 (RFC 8032) over `UTF-8("wim/1 " + type + "\n") \|\| canonBytes(object without its sig field)`, where `type` is `roster`, `send`, `auth`, `join`, `prekey` or `ci` (a CI sender's one-time key, section 18) |
| box, scheme 2 | RFC 9180 HPKE, mode_auth, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305, single shot: to the recipient device's prekey, with a fresh ephemeral key, authenticated by the sender's roster box key; info = `"wim/1 box2 " + meshId + " " + senderDeviceId + " " + recipientDeviceId + " " + prekeyId` (UTF-8), AAD = `H(canon(header))` (section 6b) |
| box, scheme 1 (v0.1) | X25519 (RFC 7748) between the sender's and recipient's static box keys; HKDF-SHA256, salt = UTF-8 mesh id, info = `"wim/1 box " + senderDeviceId + " " + recipientDeviceId` (UTF-8), 32 bytes; XChaCha20-Poly1305, 24-byte random nonce, AAD = `H(canon(header))`. Only during the migration window (section 6b) |
| invite proof | HMAC-SHA256 keyed with the invite secret (section 5) |
| short authentication string | first 50 bits of `H(UTF-8("wim/1 sas ") \|\| canonBytes(join device record))` (section 5) |

- The type label gives each kind of signed object its own domain, so a signature made for one can
  never verify as another.
- Ed25519 verification MUST be strict RFC 8032: `S` < L, `R` and the public key `A` canonically
  encoded, and small-order public keys refused. A signature therefore has one accepted encoding.
- X25519 MUST refuse a low-order public key and an all-zero shared secret.

Scheme 2 boxes give bounded forward secrecy (section 6b): a key file stolen at time T opens no box
sealed more than 120 hours before T, and boxes the device sent not at all. Scheme 1 boxes, the
static-static box of v0.1, give none: a device key stolen later decrypts every recorded scheme 1
box to or from it. They are kept only for the migration window.

**Where the keys are kept is not part of the wire.** A client MAY hold its device keys and prekey
secrets in a separate process that signs, seals and opens for its sessions (the reference client's
`wim agent`, SECURITY-MODEL section 5.8), or in a hardware or OS key store. Every signature, box
and frame is byte for byte what this section and sections 6 and 6b define, so peers and relays
cannot tell, and nothing in this document changed when the reference client added its signer.

## 4. Roster

```json
{
  "mesh": "<mesh id>",
  "seq": 1,
  "prev": null,
  "devices": [
    { "id": "<device id>", "name": "laptop", "sign": "<b64u Ed25519 pub>", "box": "<b64u X25519 pub>",
      "role": "admin", "added": 1760000000000 }
  ],
  "revoked": [],
  "by": "<device id of the signer>",
  "at": 1760000000000,
  "sig": "<b64u Ed25519 signature, type roster>"
}
```

- The **mesh id** is 16 random bytes, b64u. The **genesis** roster has `seq` 1, `prev` null, no
  revoked ids, and lists the creating device first, with `role` `admin`; it is signed by that
  device. It MAY list one more device: the mesh's recovery record (section 4a), also an admin.
- Roster `n+1` is valid only if: `mesh` is unchanged, `seq` is `n+1`, `prev` = `hash(roster n)`
  (computed over the whole roster n, signature included), `by` names a device with `role` `admin`
  in roster `n` that is not revoked in roster `n`, and `sig` verifies with that device's `sign` key.
- Device names and ids are unique within a roster, and every `id` equals the device id derived from
  its `sign` key. A device kept from roster `n` MUST be byte-identical in roster `n+1`, with one
  exception: an admin MAY **promote** a member to `admin`, changing `role` and nothing else.
  wim/1 has no key change, rename or demotion (to demote, revoke the device and add it again under
  new keys). A device leaves `devices` only by being revoked: its id moves to `revoked`, which is
  append-only (earlier entries keep their order), and MUST NOT come back. Every roster MUST list at
  least one admin.
- Device names starting with `recovery` are reserved for recovery records (section 4a), which
  always have `role` `admin`. The creating device of a genesis roster MUST NOT use such a name, and
  a joiner cannot claim one (section 5).
- A **roster reference** is `{ "seq": n, "hash": hash(roster n) }`.
- Clients MUST verify the chain from a roster they already trust (their pinned roster) to the
  newest one, and MUST keep the highest `seq` they have verified and refuse any lower one.
  Relays MUST verify the chain too before storing a new roster (defence in depth, not trust).
- The relay keeps every roster version so that a client pinned at an old one can walk forward.
  It serves the chain in pages (section 8) of at most 64 rosters or 512 KiB.

**Forks.** Two different valid rosters with the same mesh and seq are a fork.

- A relay MUST store roster `n+1` only if it holds none for that seq yet (a compare-and-swap on
  `prev`). A second, different roster for the same seq gets `error { code: "roster_conflict" }`.
- A client that sees two different valid rosters with the same mesh and seq MUST treat the mesh as
  forked: it stops accepting rosters, and messages from devices added after the fork point, and
  alerts its person. It SHOULD send both rosters to the relay as evidence (`roster.fork { a, b }`).
- An admin device MUST serialise roster signing across its sessions, so only one writer signs at a
  time (for example with a lock file next to its key file).

## 4a. Recovery

A mesh whose only admin device is lost could never change its roster again. A recovery identity is
a second admin that never connects, held by the person instead of by a machine.

- At mesh creation the client SHOULD generate a recovery identity: a fresh key set and a device
  record named `recovery` with `role` `admin`, listed in the genesis roster next to the creating
  device. Its secret keys, with the hash of that genesis roster, are shown to the person once as
  the **recovery code**, and never stored on disk:

  ```
  wimrec1_<b64u(canon({ "mesh": "<mesh id>", "genesis": "<hash of roster 1>",
                        "sign": "<b64u Ed25519 secret seed>", "box": "<b64u X25519 secret>" }))>-<checksum>
  ```

  The checksum is the first 40 bits of `H(UTF-8(body))`, where `body` is the b64u text between
  `wimrec1_` and the last `-`, written as 8 Crockford base32 characters. Readers accept the
  checksum in either case and read `I` and `L` as `1` and `O` as `0`, and MUST refuse a code whose
  checksum does not match.
- The recovery code is as powerful as an admin device. The person should keep it offline (on paper
  or in a password manager); a client MUST NOT write it to disk, log it, or send it as a message,
  and the credential check of section 6a refuses it.
- **Showing it.** A client MUST show a recovery code only on an interactive terminal it controls.
  When its standard output is not a terminal, or it runs inside an agent (detected from the
  environment: `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `GEMINI_CLI`, any `CODEX_` variable,
  `CURSOR_AGENT`, `AIDER_` variables, or similar), it MUST NOT print the code. It tells the person to
  run `wim recovery show` in their own terminal within 10 minutes, and holds the code in memory
  only until then.
- **Recovery records never act.** A recovery record exists only to sign rosters during recovery.
  A relay MUST refuse a session `auth` from a device whose name starts with `recovery`
  (`error { code: "unauthorized" }`); the only way such a device connects is the recovery `auth`
  below. Senders MUST NOT seal boxes to such devices: a broadcast or
  room send skips them (and the box-for-every-device rule of section 6 excludes them), and naming
  one as a recipient is an error. Receivers MUST drop any send from them.
- **The recovery connection.** To fetch the chain and publish its roster, the recovering client
  answers `hello` with a recovery `auth`, signed (type `auth`) with the recovery key:

  ```json
  { "t": "auth", "v": 1, "purpose": "recover", "relay": "wss://relay.example", "mesh": "<mesh id>",
    "device": "<recovery record's device id>", "nonce": "<the hello nonce>", "at": 1760000000000,
    "pin": { "seq": 1, "hash": "<hash of roster 1>" }, "sig": "<b64u>" }
  ```

  It has no `session` and no `resume`, and `pin` is the genesis roster. The relay applies the
  relay, nonce and clock checks of section 8, requires `pin.hash` to be the hash of its roster 1,
  and accepts it only from a device that is in the current roster, not revoked, and named
  `recovery...`. It answers a verified recovery `auth` with `recover.ready { roster: <newest
  roster> }`. On that connection it then allows only `roster.get` and one `roster.publish`,
  answering every other frame with `error { code: "unauthorized" }`, and closes the connection
  after the publish with WebSocket close code 4000 ("recovered"). It never creates a session for
  it, queues nothing for it, and lists it in no peer row. Every recovery `auth` counts against the
  per-source limit that `create` and `join` count against (section 9), before its signature is
  checked. A verified recovery `auth` also spends from a limit of its own, 5 an hour per mesh; an
  attempt that fails verification does not, so it cannot use up the mesh's recoveries.
- **Using it.** On a new device the person runs recover with the code. The client rebuilds the
  recovery keys in memory and fetches the roster chain from genesis over a recovery connection
  (above). It MUST
  require that `hash(chain[0])` equals the code's `genesis` (and that the mesh ids agree), MUST walk
  and verify the whole chain to the newest roster, which must still list this recovery record as
  an admin. It MUST show the person the newest roster's seq and `at` time, its device list, and
  every device revoked since genesis (by the name it last had), advise checking with another
  member of the mesh when one is reachable, and wait for the person's confirmation. Only then does it sign roster `n+1` with the recovery key, adding the new device as
  `admin` and optionally revoking lost devices, publish it, and wipe the keys. Pinning genesis
  means a relay cannot hand the recovering client a different mesh to sign for.
- **Rotating it.** The recovered device SHOULD then add a fresh recovery record (named, for
  example, `recovery-2`), revoke the used one, and show the new code once.

## 5. Invites and joining

An admin device runs `invite` and gets a one-time code:

```
wim1_<b64u(canon({ "relay": "wss://relay.example", "mesh": "<mesh id>", "secret": "<b64u 32 random bytes>",
                   "pin": { "seq": 3, "hash": "<hash of roster 3>" }, "exp": 1760000000000,
                   "tls": "<optional: b64u SHA-256 of the relay certificate's SubjectPublicKeyInfo>" }))>
```

- `inviteId` = `b64u(H(UTF-8("wim/1 invite " + b64u(secret))))` truncated to 22 characters. The
  admin registers only the `inviteId`, `exp` and `pin` with the relay
  (`invite.create { invite, exp, pin }`, where `pin` is the same `{ seq, hash }` as in the code: the
  admin's newest roster when it made the invite). The relay answers `invite.created { invite }`
  and never sees the secret.
- `exp` defaults to one hour after creation and MUST be at most 7 days after it. A device has at
  most 16 live (unused, unexpired) invites.
- An invite code is a bearer credential for joining the mesh. It travels only over a channel the
  admin and the joiner already trust, and is never sent as a mesh message (section 6a).
- **Relay certificate pin.** An invite MAY carry `tls`, a pin: the b64u SHA-256 of the DER
  SubjectPublicKeyInfo of the relay's TLS certificate, exactly 43 characters. A client stores it
  with the relay URL. A client that has a pin for a relay MUST check that the presented
  certificate's SPKI hashes to it and MUST NOT fall back to ordinary CA validation; without a pin,
  ordinary CA validation applies. A client MUST refuse `wss://` to a private or link-local address
  without a pin, and with a pin it is allowed, which lets a relay run on a local network without a
  public certificate. A private or link-local address here is an IP literal in any of: IPv4
  `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10` (shared address space, RFC 6598), `169.254.0.0/16`,
  `172.16.0.0/12`, `192.0.0.0/24`, `192.168.0.0/16`, `198.18.0.0/15`; IPv6 `::/128`, `fc00::/7`,
  `fe80::/10`, `fec0::/10`, `64:ff9b:1::/48`; and an IPv6 address that carries an IPv4 address in
  one of the IPv4 ranges (IPv4-mapped `::ffff:0:0/96`, IPv4-compatible `::/96`, NAT64
  `64:ff9b::/96`, 6to4 `2002::/16`). The check applies to the address however it is spelled
  (`[::ffff:10.0.0.1]` and `[::ffff:a00:1]` are the same address). Loopback (`127.0.0.0/8`,
  `::1`, and their mapped forms) is not in the list. A host name is not resolved for this check.
  `ws://` is still refused except to loopback. The pin is stored per
  mesh, and a later invite MUST NOT replace it without the person confirming; wim/1 has no pin
  rotation other than re-inviting.

**The join request.** The joining device generates its keys, connects without authenticating and
sends:

```json
{ "t": "join", "mesh": "<mesh id>", "invite": "<inviteId>",
  "device": { "id": "<device id>", "name": "newbox", "sign": "<b64u>", "box": "<b64u>" },
  "nonce": "<this connection's hello nonce>", "proof": "<b64u>", "sig": "<b64u>" }
```

- `device` is exactly the four fields `id`, `name`, `sign` and `box`.
- `proof` = `b64u(HMAC-SHA256(secret, canonBytes(device)))` proves the joiner holds the invite.
- `nonce` is the `hello` nonce of the connection the join is sent on.
- `sig` is the joiner's own signature, type `join`, over
  `{ "t": "join", "mesh", "invite", "device", "nonce" }` (the frame without `proof` and `sig`),
  proving it holds the device's signing key. Because it covers the nonce, a captured join cannot
  be replayed on another connection; a re-sent join is signed again with the new connection's
  nonce. The relay MUST refuse a join whose `nonce` is not its `hello` nonce for that connection.
- The relay checks that `id` derives from `sign` and that `sig` verifies, that the invite exists, is
  unused and unexpired (else `error` with `invite_unknown`, `invite_used` or `invite_expired`), and
  forwards the body (without `t`) to the mesh's online admin sessions as `join.request { join }`,
  queueing it up to the invite's expiry when none is online.
- A connection that sent `join` MAY stay unauthenticated until the invite's expiry while it waits
  for approval; after `joined` it has the normal 10 seconds to close or authenticate. The same device
  may send its `join` again (for example after reconnecting) and gets `joined` again once the invite
  was used for it; a `join` from any other device on a used invite gets `invite_used`.
- A relay keeps at most one pending (unauthenticated, waiting) join connection per invite and 16
  per mesh. A further `join` on the same invite replaces the older pending connection only when it
  carries a valid signature from the same device; otherwise it is refused.

**The admin's decision.**

- The admin client MUST record each invite it issued, and MUST refuse a `join.request` for an invite
  it already used or whose `exp` has passed by its own clock. It MUST delete the secret once the
  invite is used or expired.
- It verifies `proof`, `sig` and the id derivation, checks the name is free, and refuses a name
  starting with `recovery` (section 4).
- It then MUST hold the request for its person, showing the device name and the device id, and
  have the person confirm the **short authentication string**: the first 50 bits of
  `H(UTF-8("wim/1 sas ") || canonBytes(device))` as 10 Crockford base32 characters, shown as
  `XXXXX-XXXXX`, which the joiner shows. The admin client signs only after the person confirms
  that the joiner's string is this request's. A client SHOULD have the person type the string the
  joiner shows and compare it itself (ignoring case, `-` and spaces, and reading `I` and `L` as
  `1` and `O` as `0`), and SHOULD NOT show its own copy: then a confirmation cannot be given
  without reading the joiner's screen, which a yes or no can. A client MUST take the confirmation
  only from its person, never from an agent: the reference client takes it only from an
  interactive terminal (standard input and output both terminals) with no agent's variables set
  (the list in section 4a), or from a local user interface (SECURITY-MODEL section 7.5). A client
  MAY accept without asking only for an invite its operator created with an explicit auto-accept
  option, recorded with the invite on the admin device and never in the code.
- **A request nobody is at yet.** The relay queues a `join.request` until the invite expires and
  sends it to each admin session that authenticates meanwhile, so an admin device need not be
  waiting for it. The reference client's sessions on an admin device keep each request that passes
  the checks above in a file next to the invite records (never its short authentication string),
  until the invite is used or expires, and the person admits one later by the string the joiner
  shows (`wim devices pending`, `wim devices admit <name> <code>`). The typed string picks the
  request: one whose string was not typed is never admitted this way, an auto-accept invite's
  included. None of this changes the wire.
- On acceptance it signs the next roster with the device added as `{ ...device, "role": "member",
  "added": <now> }` and publishes it (`roster.publish`). The relay verifies the chain, stores it
  (section 4, forks), marks the invite used, sends the new roster to every session, and sends
  `joined` to the waiting joiner with the roster chain from the invite's `pin.seq`, in pages.

**Finishing.**

- The joiner verifies the chain starting from the pinned hash in its code; a relay that serves any
  other roster fails that check. If `joined` says `more`, the joiner authenticates with that pin and
  walks the rest with `roster.get`. It MUST check that its own record is in the newest roster.
- An invite is single use. A second `join` on the same invite is refused, except from the device it
  admitted (above).

**Short invite codes.** A full invite code is about 350 characters, too long to read out or type,
so people paste it, and a pasted code passes through whatever holds the clipboard, an agent's
context included. The code is also the joiner's trust anchor (its relay, mesh, roster pin and
certificate pin; SECURITY-MODEL section 5.6), so the short code is not a weaker one: it names a
box at the relay that only its holder can find, open or forge.

```
wim2-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX[@<relay>]
```

- **The code.** `k` is 100 random bits written as 20 Crockford base32 characters (`0-9`, `A-Z`
  without `I L O U`), most significant first. The code is `wim2-` followed by `k` and a 4-character
  check, the first 20 bits of `H(UTF-8("wim/1 short code " + k))` in the same alphabet, shown in six
  groups of four. When the invite's relay is not the hosted relay `wss://worldinmotion.distronode.com`,
  `@` and the relay URL follow, without `wss://` (a `ws://` loopback URL is written in full).
  Readers accept any case, with or without the dashes or spaces between groups, read `I` and `L` as
  `1` and `O` as `0`, read `@<host>[:port][/path]` as `wss://<host>[:port][/path]`, and MUST refuse a
  code whose check does not match or whose relay is not a relay URL (section 2).
- **Derivations.** `rdv` = `b64u(H(UTF-8("wim/1 rdv id " + k)))` cut to 22 characters, the box's
  lookup id; `key` = HKDF-SHA256(UTF-8(`k`), salt empty, info `"wim/1 rdv key"`, 32 bytes). Here `k`
  is the 20 canonical upper-case characters.
- **The box.** The admin device makes the full invite as above, then seals UTF-8 of the full code
  with XChaCha20-Poly1305 under `key`, a random 24-byte nonce `n` and AAD = UTF-8(`"wim/1 rdv " +
  rdv`), giving `c` (at most 4 KiB). Once `invite.created` arrives it sends the authenticated frame
  `rdv.put { rdv, exp, n, c }` with `exp` the invite's expiry or one hour from now, whichever is
  first. The relay answers `rdv.stored { rdv }`, or `error` with `ref` `rdv.put`: `unauthorized` for a
  device that is not an admin, `malformed` for an `exp` that is past or more than an hour and 5 minutes away (the clock skew
  `auth` allows; the relay keeps the box at most an hour by its own clock),
  `limited` past a rate (16 an hour per device, 64 per mesh, 64 per source address), `full` when it
  holds 10,000 boxes, `rdv_exists` for an id it already holds, `unavailable` when its store cannot
  be reached, and `unsupported` (or, from a relay older than this, `unknown_type`) when it keeps no
  boxes.
- **Fetching.** The joiner reads the box from a relay-wide endpoint that needs no mesh id: `GET
  <relay>/v1/rdv/<rdv>`, the relay URL with `wss://` read as `https://` (`ws://` as `http://`). The
  relay answers 200 with `{ "v": 1, "rdv", "exp", "n", "c" }` and `Cache-Control: no-store`, 404
  when it holds no live box under that id, 400 for an id that is not 22 characters of base64url, and
  429 past 30 fetches an hour from one source address, found or not. It hands each box out at most
  3 times, deleting it with the third, and deletes it at `exp` in any case. The joiner opens the box
  with `key` (refusing one stored under another `rdv`), reads the full code from it and MUST check
  that its relay is the one the short code names (comparing without case). From then on it uses the
  full code exactly as above: every check of this section applies unchanged, the short
  authentication string included.
- **Not weaker.** The relay sees `rdv` and the box, never `k`. Reading the invite out of the box, or
  making a box the joiner would accept (another relay, mesh or pin), needs `k`: 2^100 guesses, each
  checked offline against `rdv` with one SHA-256, against a box that lives at most an hour and
  whose invite is worthless once used or expired. Online, 30 fetches an hour per address make
  guessing a live `rdv` hopeless too. A relay that withholds, replaces or swaps a box only denies the
  join. Whoever reads the short code can use the invite, as with the full code, and the short
  authentication string still stops them.
- **Pinned relays.** A client MUST NOT offer a short code for an invite that carries `tls`: the
  joiner, holding only the short code, would fetch the box before it had the pin. It shows the full
  code instead.
- **Compatibility.** Only a new frame and a new endpoint. A client that does not know `wim2-` uses
  the full code, which the admin device prints when asked (`wim invite --full`). An admin device on
  a relay that answers `rdv.put` with `unknown_type` or `unsupported` shows only the full code.

## 6. Messages

A session sends:

```json
{
  "t": "send",
  "mesh": "<mesh id>",
  "id": "<ULID>",
  "from": { "device": "<device id>", "session": "<name>", "sid": "<ULID>" },
  "to": ["reviewer@laptop"],
  "seq": 17,
  "at": 1760000000000,
  "roster": { "seq": 4, "hash": "<hash of roster 4>" },
  "pk": { "mesh": "...", "device": "...", "id": "...", "pub": "...", "at": 1759996400000, "until": 1760169200000, "sig": "..." },
  "boxes": { "<recipient device id>": { "s": 2, "p": "<prekey id>", "e": "<b64u ephemeral X25519 public key>", "c": "<b64u ciphertext>" } },
  "sig": "<b64u signature, type send>"
}
```

- The **header** is the send object without `boxes` and `sig`, whatever other fields it holds.
  `pk`, optional, is the sending device's current prekey (section 6b), so receivers learn it.
  During the migration window a message with any recipient device that has no current prekey
  carries no `pk` and only scheme 1 boxes (section 6b).
- Each box carries its **scheme**. Scheme 2, `{ "s": 2, "p", "e", "c" }`, is HPKE to the
  recipient device's prekey `p`, with the ephemeral public key `e` (section 6b). A box without `s`
  is scheme 1, the v0.1 box `{ "n", "c" }`: `XChaCha20-Poly1305(key(sender, recipient device),
  nonce, plaintext, AAD = H(canon(header)))`, accepted only during the migration window. Every
  scheme after 1 carries `s`; scheme numbers from 3 up are reserved (for example a room mode on
  MLS, which would be `wim/2`; it is a design only and not part of v0.2, see docs/mls.md), and a
  frame holding a box of an unknown scheme is malformed.
- `sig` signs the whole object without `sig` (boxes included) with the sender's device key.
- `roster` is a reference to the newest roster the sender has verified.
- There is one box per recipient **device**, not per session: sibling sessions on one device read
  the same box, and opening it changes no state, so every sibling and every redelivery opens it
  alike. A broadcast (`"to": ["*"]`) carries a box for every device in the roster, the sender's own
  device included (after the migration window: every such device that has a current prekey).
- `seq` 0 is reserved for peer cards (section 17), which have their own seq space. Otherwise `seq`
  increases by one per message from a session (`from.sid`), across all of its recipients,
  starting at 1 for each new sid.
- The **plaintext** is UTF-8 `canon` of (for `kind` `msg`; section 12 defines the other kinds):

```json
{ "v": 1, "kind": "msg", "id": "<same ULID>", "from": { "device": "...", "session": "...", "sid": "..." },
  "to": ["reviewer@laptop"], "at": 1760000000000, "roster": { "seq": 4, "hash": "..." },
  "text": "...", "reply_to": "<ULID, optional>", "relayed": true }
```

**Receiving.** A receiver MUST drop the message unless all of these hold, checked in this order:

1. The frame is well formed and its `mesh` is the receiver's mesh.
2. **Sender.** The sender device is not revoked in the receiver's roster. If the roster does not
   list it, and the header's `roster.seq` is higher than the receiver's newest verified roster, the
   sender may have joined since: the receiver MUST fetch (`roster.get`) and verify the chain up to
   that seq before going on, parking the message (at most 64 parked messages per mesh, dropping the
   oldest). Otherwise an unknown sender is dropped. A sender whose name starts with `recovery` is
   dropped (section 4a).
3. **Signature** against the sender's `sign` key. It is checked before anything else in the
   header is acted on, so a forged frame can neither trigger a roster fetch nor a fork alarm.
4. **Roster.** If the header's `roster.seq` is higher than the receiver's newest verified roster,
   the receiver MUST fetch and verify the chain up to that seq before going on, parking the message
   as above. If the seq is equal but the hash differs, the mesh is forked (section 4). A lower seq
   is fine.
5. **Addressing.** `to` contains the receiver's own current address, or it contains `*` or a room
   the receiving session is a member of and the message is not from the receiving session itself
   (same device and sid). History (section 13) keeps the receiving session's own messages.
6. **Freshness.** `at` is no more than 47 hours before the receiver's clock and no more than 10
   minutes after it.
7. **Decryption** of its device's box: a scheme 2 box with the secret of the prekey it names, and
   the sender's roster `box` key as the HPKE sender key. A box for a prekey whose secret the
   device no longer holds fails as `key_expired` (section 6b); a scheme 1 box after the migration
   window fails as `legacy_box`.
8. **Plaintext.** It parses (no duplicate keys), matches the schema for its `kind` (an unknown
   kind is dropped), and its bytes equal
   `canonBytes` of the parsed value. `seq` is 0 exactly when the kind is `card`. Its `id`, `from`,
   `to`, `at` and `roster` equal the header's.
9. **Not seen before.** See dedupe and seq below. Cards and history items (sections 13 and 17)
   skip this step entirely: they are neither deduped nor seq-tracked.

- **Dedupe.** The receiver MUST remember each accepted message id until `at` + 48 hours + 10
  minutes (longer than any message stays fresh), durably, before it sends `ack`. The store is per
  device and shared by its sessions, keyed by message id and receiving address, so a session that
  restarts still recognises a replay while each sibling session still receives a broadcast once.
- **Seq.** The receiver tracks the highest `seq` per sender (device id, sid) and receiving address,
  and drops anything at or below it. A jump is not an error and is not reported: one session's seq
  counts its messages to all of its recipients.

**Limits.** Plaintext `text` is at most 256 KiB of UTF-8. A frame is at most 1 MiB, and the client
MUST refuse a send that would not fit, before sending, by measuring the actual frame. The text
that fits is often less than 256 KiB: in the plaintext a control character can grow to 6 bytes
(`\u0001`), the ciphertext adds 16 bytes, base64 adds a third, and a broadcast repeats all of it
once per device (a scheme 2 box adds about 100 bytes of `s`, `p` and `e` on top).

## 6a. Delivering messages to an agent

A message is data from another AI session. It is never an instruction from, or an approval by, the
person the receiving agent works for.

- A client MUST hand message text to an agent only inside a frame that states it came from another
  AI session, names the sender (address and device id), and states that it is not the person's
  instruction or approval. The frame MUST use a fresh random boundary per message, and any
  sequence in the text that could open or close a frame MUST be escaped.
- A message MUST NOT answer a permission prompt, approve a tool call, or change inbound policy.
- **Trusted devices can assign work.** A message of any kind, except relayed or derived text
  (below), from a device whose inbound policy is `deliver` (one the person chose to trust) is
  presented to the agent as a work assignment from a device its person trusts. The agent MAY carry
  it out within its normal permissions: permission prompts and its own judgment still apply, and it may decline
  anything unsafe or out of scope. It is still never the person's approval of a specific action,
  and still cannot answer a permission prompt or change a setting. Relayed or derived text (from
  any device) and messages from devices whose policy is not `deliver` are information only.
- Text shown to a person MUST have these escaped visibly: C0 and C1 control characters (except
  newline and tab), line and paragraph separators, every format character (general category
  `Cf`, which includes the bidirectional controls, zero-width characters and Unicode tags), every
  `Default_Ignorable_Code_Point` (which includes the variation selectors, fillers and the code
  points Unicode reserves as invisible), and unpaired surrogates. The one exception is a single
  presentation selector, U+FE0E or U+FE0F, directly after a character with the `Emoji` property:
  it only chooses how that character is drawn. Any other variation selector, a second selector in
  a row included, is escaped, since a run of them can carry hidden bytes. Text handed to an agent
  gets the same escaping, except that a zero-width joiner between two emoji (which forms one
  visible glyph and cannot hide text) is also kept.
- Inbound policy is set per sender device id: `deliver`, `hold` (wait for the person) or `refuse`.
  The default for a device the person has not chosen to trust is `hold`.
- **Relayed text.** A plaintext carries `"relayed": true` when the sender did not write its text
  itself: model output from a bot, CI logs and commit messages, an external agent's reply. A client
  that forwards text it did not author MUST set it. Inbound policy applies to the pair (sender
  device, relayed): a relayed item from a `deliver` device is held unless the person allowed
  relayed items from that device (`deliver-relayed`). A client MUST NOT start a new agent turn for a
  relayed item; it MAY append it to a running turn's context or place it in the inbox. The frame
  handed to an agent says the text was written by a third party, not by the sending session.
- **Derived messages.** A plaintext carries `"derived": true` when its session wrote it while
  handling another agent's item. A client MUST set it on any message its session sends during an
  agent turn that a mesh item started, and within 10 minutes after it handed the agent an
  information-only item (relayed text, or an item from a device that is not `deliver`, including
  one the person approved) through delivery, the inbox, `wait` or history. A receiver presents a
  derived item as information only, whatever the sender's policy, and its frame says it was
  written while handling another agent's message. So work can be assigned one hop from a turn the
  person started, and no further.
- `kind`, session names and every relay-authored field (peer rows, `sent` results, notices) are
  unauthenticated labels: useful for display, never inputs to a trust decision.
- Before sealing, a client MUST refuse text that matches a high-confidence credential pattern, and
  report only the pattern's name. The patterns include at least: `wim1_` and `wim2-` invite codes, `wimrec1_`
  recovery codes, the key-file format, PEM private keys, AWS access key ids, GitHub tokens (`ghp_`, `gho_`, `ghs_`,
  `github_pat_`), GitLab `glpat-`, Slack `xox[abprs]-`, Stripe `sk_live_` and `rk_live_`, Google
  API keys (`AIza`), Anthropic `sk-ant-`, OpenAI `sk-proj-` and `sk-`, and JWTs.
- A client MAY let a person override that refusal for one send (for example an `allowSecrets`
  option), but only when the person asks for it directly at the client's own command line. The
  override MUST NOT be reachable by an agent: not through a tool or MCP interface, not through a
  message, and not through any setting an agent can change.
- Tasks, results and files (section 12) are messages too, and everything in this section applies
  to them. A task is a peer's request, never the person's instruction.

## 6b. Prekeys and forward secrecy

Each device seals nothing to its long-term box key any more. Instead it publishes a short-lived,
signed X25519 **prekey** per mesh, senders seal every box to the recipient device's current
prekey with a fresh ephemeral key, and the device deletes each prekey's secret on a fixed
schedule. Recorded ciphertext is then unreadable to a key file stolen after that schedule ran.

**The prekey object.**

```json
{ "mesh": "<mesh id>", "device": "<device id>", "id": "<prekey id>", "pub": "<b64u X25519 public key>",
  "at": 1760000000000, "until": 1760172800000, "sig": "<b64u signature, type prekey>" }
```

- `id` is `b64u(H(pub))` truncated to 22 characters. `at` is when the device made it and `until`
  the last moment a sender may seal to it: more than `at`, and at most 48 hours after it.
- `sig` is the device's own Ed25519 signature, type `prekey`, with its roster `sign` key. No admin
  signs a prekey and the roster does not change: a device rotates its prekeys on its own.
  Recovery records never publish one.
- **Verifying.** A receiver of a prekey MUST check, in this order: the shape, the mesh, that the
  device is in its newest verified roster (not revoked, not a recovery record), that `id` derives
  from `pub`, the signature, the window (`until` after `at`, at most 48 hours), that `pub` is not a
  low-order point, that `at` is at most 10 minutes ahead of its clock, and that its clock is at
  least 10 minutes before `until`. A client SHOULD also refuse a prekey whose `pub` is a test-vector
  key (section 16).

**Publishing.** A device publishes its current prekey in the header of what its sessions send, as
`pk` (section 6): in every `send` frame, and in each session's peer card (section 17), which the
relay stores and serves to every session after `ready` and pushes when it changes. So every
session sends a card, one with no labels when it shares none, and sends it again at once when the
device's prekey rotates. A receiver keeps, per peer device, the newest prekey that verifies, by
`at`: an older one (a replayed card) never replaces a newer one. No relay frame is added for
prekeys.

**Rotating and deleting (the device's schedule).**

| step | rule |
|---|---|
| store | prekey secrets are kept in a file next to the device's keys, readable only by its owner, shared by its sessions |
| rotate | a new prekey when no kept prekey passes the time checks, or the newest is 24 hours old; under a lock, so sibling sessions make one |
| delete | each secret at `until` + 72 hours (so at most 120 hours after `at`), by rewriting the file without it |
| cap | at most 8 prekeys kept |

Every process of the reference client that opens the mesh runs the schedule, and every running
session runs it again when the next rotation or deletion falls due.

- Retention covers delivery and history: a box sealed at the last moment a sender may use a
  prekey (`until` - 10 minutes) still opens 72 hours later, the longest a relay keeps a queued
  message, a history entry or a blob chunk (section 13).
- **Forward secrecy, bounded.** A box opens only while the recipient device keeps the prekey's
  secret, so a key file stolen at time T opens no box sealed more than 120 hours before T (96 to
  120 hours for a box sealed to the newest prekey of a device online every day). A box a device
  sent does not open with its own key file at all: the ephemeral secret existed only while
  sealing. A thief who copied the key file once loses the device's incoming traffic as peers move
  to prekeys made after the copy, within a day for a device that rotates daily.

**Sending.** A sender seals to the newest prekey of each recipient device that passes the checks
by its own clock, including the 10-minute margin before `until`. It MUST verify every prekey it
seals to as above, and seals its own device's box (for sibling sessions, in a broadcast) to its
own current prekey.

**The migration window.** Until wire version 1.0:

- A v0.1 client parses relay frames strictly, so it drops, silently, any frame holding a `send`
  frame with a `pk` or a scheme 2 box, even when its own box is scheme 1 (a `cards` page or room
  history page with one such message is dropped whole). A v0.1 relay refuses such frames as
  malformed, so relays upgrade first.
- So a message with any recipient device that has no current prekey (a v0.1 client, which
  publishes none, or a device offline for more than 48 hours) goes in the v0.1 format for every
  recipient: no `pk`, and a scheme 1 box for every device, those with a prekey included. That
  message has no forward secrecy for anyone in it. In a mesh with a v0.1 device this covers every
  broadcast and room message, and every direct message naming that device. It is one frame, not
  one per format: the signature covers every box, and receivers drop a second frame with the same
  id or seq. The reference client says so: `wim send` prints "Sent without forward secrecy to
  <every device in the send>: no current prekey for <the devices without one> ...", and the
  outcome lists both (`unprotected`, `no_prekey`). Before falling back, it reads the prekeys its
  sibling sessions learned and waits for the first `cards` page of its connection, at most the
  send's answer timeout.
- A message whose every recipient device has a current prekey is sealed as above (`pk`, scheme 2
  boxes), mesh with v0.1 devices or not.
- A peer card always carries `pk` and scheme 2 boxes for the devices with a prekey, since cards
  are how upgraded devices learn each other's prekeys. A v0.1 client drops it and misses that
  session's labels, and the labels of every card in a `cards` page it drops; nothing else.
- Receivers open scheme 1 boxes, so v0.1 senders, and messages queued or kept in history from
  before an upgrade, still read.
- A hostile relay can force the downgrade during the window by withholding cards and stripping
  `pk`: the sender then seals scheme 1 boxes to every recipient of the message and says so.

From 1.0, scheme 1 boxes are refused (`legacy_box`), senders never fall back to the static box, a
broadcast or room send carries a box for every device that has a current prekey, and a direct send
to a device without one is refused before it is sent.

**Failure modes.**

- **A stale prekey at the sender.** A sender that missed a rotation seals to an older prekey; that
  is fine while it passes the checks, because the device keeps every secret 72 hours past its
  `until`. A relay that withholds new cards can hold a sender on an older prekey, which weakens
  forward secrecy to that prekey's window, never further.
- **A recipient offline longer than the retention.** Nothing waits for it: the relay expires a
  queued message after 24 hours and sends the sender the `expired` receipt (section 7), which is
  sooner than any secret it needs is deleted. After 48 hours offline its last prekey has expired,
  and senders fall back (window) or refuse (after 1.0) at send time, so the sender is told then.
  A room history entry sealed to a prekey the device no longer holds fails as `key_expired` and
  is skipped, like any history entry that does not open.
- **Lost prekey secrets** (a key file restored without its prekey file): live boxes for the lost
  prekeys fail as `key_expired`. The device makes and publishes a new prekey at once. The reference
  client tells its person once per sender device. The relay has no frame to tell the sender.
- **Clock skew.** The 10-minute margins above match the message freshness window (section 6). A
  device whose clock runs more than 10 minutes fast has its prekeys refused as `not_yet`, as its
  messages are refused as `too_new`. A clock set back leaves the newest prekey in the future: the
  device rotates once, then uses the new one.
- **Revocation** is unchanged: senders seal only to devices in their newest verified roster, a
  revoked device's prekeys fail the roster check, and there is no group key to rotate.

## 7. Delivery

- On `send`, the relay checks `from` against the authenticated connection, the frame limits and the
  sender's rate limits, resolves each address and answers once with `sent`:

  ```json
  { "t": "sent", "id": "<ULID>", "results": [ { "to": "reviewer@laptop", "status": "routed" } ] }
  ```

  `status` is one of `routed` (pushed to an online session), `queued` (the session is offline;
  kept up to 24 hours), `unknown` (no such address), `ended` (the session said goodbye), `full`
  (the recipient's queue holds 50 messages, or 10 from this sender's device), `limited` (the
  sender is rate limited) or `invalid`. A send to `*` when no other session exists gets one row
  `{ "to": "*", "status": "unknown" }`; a send to an existing room with no other members adds no
  row for that room.
- Each recipient session has a queue with a monotonically increasing `cursor`. The relay sends
  `{ "t": "deliver", "cursor": 42, "msg": { ...the send object... } }`. Delivery is at least once.
  The client acknowledges with `{ "t": "ack", "cursor": 42 }` once it has stored the message and
  its id (section 6), and the relay deletes everything up to that cursor. The relay MUST refuse an
  `ack` beyond the highest cursor it delivered. `resume.cursor` in `auth` acts as an `ack` up to
  that cursor, capped at the highest cursor delivered. Dedupe makes delivery effectively once.
- After processing, the recipient client sends a receipt, which the relay forwards to the sender's
  session if online and drops otherwise:

  ```json
  { "t": "receipt", "id": "<ULID>", "to": "reviewer@laptop", "status": "delivered" }
  ```

  The relay sets `to` from the authenticated connection (the receipt sender's own address), forwards
  a receipt only from an addressee of that message, and remembers which session sent each `id` for
  24 hours so it can route the receipt back. `status` is `delivered` (accepted into the inbox or
  shown to the agent), `held` (waiting for the person's approval), `refused` (inbound policy) or
  `expired` (sent by the relay when a queued message reaches its 24 hours).
- Receipts and `sent` statuses are advisory. They MUST NOT be treated as proof that a person read
  or approved anything.
- Message order per sender session is preserved per recipient queue.
- When a roster revokes a device, the relay purges that device's sessions, the queues of its
  sessions, messages it sent that are still queued for others, its blob chunks and its invites.
- An offline session, with its name and queue, is kept for 24 hours after it went offline, and
  for as long as its queue is not empty. A session that said `bye` leaves a tombstone (so sends to
  it get `ended`) for 24 hours.

## 8. Connection

A client dials `<relay>/v1/<mesh id>`, where `<relay>` is the relay URL (section 2) from the invite
or configuration. One mesh lives behind each such URL, which lets a relay keep each mesh in its
own shard.

A relay MAY refuse a dial before the WebSocket handshake, and before it holds anything for the
mesh, when one source address dials too often or has too many connections open that have not
authenticated (section 9). It answers HTTP 429 with a `Retry-After` header (seconds) and a JSON
body `{ "error": "..." }`. A client treats that as a lost connection and retries with backoff.

All frames are JSON text messages with a `t` field. Unknown `t` values get an `error` and are
otherwise ignored. A connection that sends a malformed frame MAY be closed. Relays refuse unknown
keys in client frames, because they forward signed objects unchanged. Clients ignore unknown keys
in relay frames (forward compatibility), except inside the signed objects a relay forwards
(rosters, `deliver.msg`) and in plaintexts, which stay strict. Before `auth` succeeds a relay
accepts only `auth`, `join` and `create`, each at most 16 KiB; it MAY also answer `ping` with
`pong` then (a relay that answers keepalives without running its mesh logic does). A client accepts relay frames up to
1 MiB plus 4 KiB (room for the `deliver` envelope around a full send). `card.set` and `card`
frames are at most 64 KiB (section 17).

**Handshake.** The relay opens with `{ "t": "hello", "v": 1, "nonce": "<b64u 32 bytes>", "at": ... }`,
with a fresh nonce for every connection. The client answers within 10 seconds with:

```json
{ "t": "auth", "v": 1, "relay": "wss://relay.example", "mesh": "<mesh id>", "device": "<device id>",
  "nonce": "<the hello nonce>", "at": 1760000000000,
  "session": { "name": "reviewer", "kind": "claude-code", "sid": "<ULID>", "resume": "<b64u 32 bytes>" },
  "resume": { "cursor": 41 },
  "pin": { "seq": 4, "hash": "<hash of roster 4>" },
  "sig": "<b64u signature, type auth>" }
```

- `relay` is the relay URL exactly as written in the client's invite or configuration (without
  the `/v1/<mesh id>` path). The relay compares it byte for byte with its configured list of public
  URLs and never derives it from request headers, so a signed auth cannot be replayed to another
  relay. `at` MUST be within 5 minutes of the relay's clock. The device MUST be in the current
  roster and not revoked, and MUST NOT be a recovery record (name starting with `recovery`;
  `error { code: "unauthorized" }`); a recovery record connects only with the recovery `auth` of
  section 4a, which carries `"purpose": "recover"` and no `session`. A connection authenticates
  once.
- `sid` is a ULID the client generates for an agent session and keeps across reconnects. A later
  process of the same agent session MAY reuse the sid when it holds that session's resume secret,
  and then continues the session's persisted `seq`; any other process generates a new sid. A
  client MUST persist the next `seq` before it sends a frame that uses it, so a crash never reuses
  one. `kind`
  is a free label in the name alphabet (`claude-code`, `gemini-cli`, `bot`, `cli`).
- `session.resume` is 32 random bytes the client keeps with the agent's state. The relay stores
  `hash(resume)` with the session; it is what lets a later connection claim this session's name
  and queue.
- `pin` is the client's newest verified roster (mandatory). A relay that holds a different roster
  at that seq has seen a fork (section 4).
- **Names.** If an online session on the same device holds the name, the relay assigns the first
  free `name-2`, `name-3`, and so on. If only an offline session on the same device holds it, the
  new connection takes over that name and its queue only if `hash(session.resume)` matches the
  holder's (an agent restarting keeps its messages); a matching `sid` alone is not enough, since
  sids appear in peer rows. Otherwise it gets `name-N` too. A `rename` to an offline holder's name follows the same rule, so it is
  refused with `name_taken`. The relay answers with the name actually assigned.
- A `sid` that is already online on another connection is taken over by the new connection only
  when the resume proof also matches (`hash(session.resume)` equals the stored one); otherwise the
  new `auth` is refused with `unauthorized`.
- The relay answers `{ "t": "ready", "sid": "...", "name": "...", "cursor": <last acked>,
  "roster": <newest roster>, "more": <true when rosters exist between the pin and the newest>,
  "peers": [...] }` and then sends every queued message after `resume.cursor`. A client whose pin
  is more than one behind walks forward with `roster.get`.
- **Roster pages.** `roster.get { from }` asks for the chain starting at seq `from` (inclusive). The
  relay answers `roster { chain, more }` with at most 64 rosters or 512 KiB, oldest first; `more`
  says whether newer rosters follow. A newly published roster is pushed to every session as
  `roster { chain: [<it>], more: false }`.

**Client frames after `ready`:** `send`, `ack`, `receipt`, `presence { status: "busy" | "idle" }`,
`peers`, `rename { name }`, `notify_idle { of: "<address>" }`, `invite.create { invite, exp, pin }`
(admins), `roster.publish { roster }` (admins), `roster.get { from }`, `roster.fork { a, b }`,
`room.join { room }`, `room.leave { room }`, `room.history { room, before?, limit? }` (section 13),
`lease.acquire { key, ttl, wait? }`, `lease.renew { key, token, ttl }`, `lease.release { key, token }`,
`lease.list`, `lease.watch { key }` (section 14), `blob.put { blob, index, last, n, data }`,
`blob.get { blob, index }` (section 15), `card.set { msg }`, `cards.get { after? }` (section 17),
`rdv.put { rdv, exp, n, c }` (admins; section 5, short invite codes), `ci.rules { tags, gitlab }`
(section 18), `mesh.delete { mesh }` (admins; section 11), `ping`, and `bye { ended: true }` when the session is
ending for good (its name is freed, it leaves its rooms, its leases end, and later sends to it get
`ended`).

**Relay frames:** `hello`, `ready`, `sent`, `deliver`, `receipt`, `peers { peers }`,
`peer { peer }` (one row changed), `notice { kind: "idle", of: "<address>" }`,
`roster { chain, more }`, `join.request { join }` (to admins), `joined { chain, more }` (to a
joiner), `invite.created { invite }`, `recover.ready { roster }` (section 4a), `room.joined { room, members }`, `room.history { room, msgs, more }`,
`lease { key, status, holder?, until?, token? }`, `leases { leases }`, `blob.stored { blob, index }`,
`blob.chunk { blob, index, last, n, data }`, `cards { cards, more }`, `card { msg }` (section 17),
`rdv.stored { rdv }` (section 5), `ci.rules { count }` and `ci.deliver { cursor, msg }` (section
18), `mesh.deleted { mesh }` (section 11), `error { code, message, ref? }`, `pong`.

CI senders do not use the WebSocket: they make two HTTP requests to `<relay>/v1/<mesh id>/ci`
(section 18).

**Replies.** Besides the replies named elsewhere, the relay answers `create` with
`roster { chain: [<genesis>], more: false }`, `invite.create` with `invite.created { invite }`, and
`rename` and `room.leave` with the session's own `peer` row.

**Error codes** include `unknown_type`, `malformed`, `too_large`, `duplicate_key`, `unauthorized`,
`limited`, `roster_conflict`, `mesh_exists`, `full`, `name_taken`, `invite_used`, `room_limit`,
`lease_limit`, `blob_missing`, `blob_quota`, `invite_unknown`, `invite_expired`, `roster_invalid`,
`not_found`, for `rdv.put` `rdv_exists`, `unavailable` and `unsupported`, and for `mesh.delete`
`unsupported`. `ref` names what the
error refers to: a message id or the `t` of the refused frame.

**Close codes.** Connections close with these WebSocket close codes. The reference client stops
reconnecting after 4003, 4004, 4005 or 4009, since another attempt cannot succeed, and reconnects
with backoff after any other code.

| code | sent by | meaning |
|---|---|---|
| 1000 | either | a normal close, such as after `bye` or when a client stops |
| 1001 | relay | the mesh expired, or the connection sent nothing for too long |
| 1003 | relay | the client sent a binary frame |
| 4000 | relay | `recovered`: the recovery connection's roster was published (section 4a) |
| 4001 | relay | the connection did not authenticate in time (10 seconds, or a joiner's invite expired) |
| 4002 | client | the relay did not answer a `ping`; a relay never sends it |
| 4003 | relay | authentication was refused |
| 4004 | relay | this device was revoked from the roster |
| 4005 | relay | an admin deleted the mesh (`mesh.delete`, section 11) |
| 4008 | relay | a frame was malformed or too large |
| 4009 | relay | a newer connection took over this session or this join |
| 4029 | relay | a rate or count limit was hit |

**A peer row:** `{ "address": "reviewer@laptop", "sid": "<ULID>", "kind": "claude-code", "status": "idle" | "busy" | "offline", "since": ..., "rooms": ["#ops"] }`.
The `sid` is no secret (every recipient already sees it as `from.sid`); it lets a client match a
session's card (section 17) by device id and sid.

**Keepalives and liveness.** These timings are what the reference client and relays do; they are
informative, not requirements on other implementations.

- The client sends `{ "t": "ping" }` after 30 seconds without a frame from the relay. If the next
  30-second check still finds no frame (no `pong`), it closes with 4002 and reconnects. A relay
  that stops answering is noticed within 60 to 90 seconds.
- The Cloudflare relay closes an authenticated connection that sent nothing, not even a `ping`, for
  5 minutes (`STALE_MS`), with 1001 "no keepalive". The sweep runs on the mesh object's alarm,
  every minute while any socket is open (`HEARTBEAT_MS`), so the close comes 5 to 6 minutes after
  the client's last frame.
- The self-hosted relay (`relay-node`) sends a WebSocket protocol ping to every socket every 30
  seconds and terminates one that did not answer the previous ping, so a client that stopped
  answering is closed 30 to 60 seconds after its last pong.
- A client that closes its socket is taken offline at once, on either relay.

What a sender sees while a recipient's process is frozen (stopped, or its machine asleep) but its
TCP connection is still open: until the relay closes the socket, the recipient's peer row keeps
its last presence (`busy` or `idle`, not `offline`), and sends to it answer `routed`, not
`queued`. That is up to about 6 minutes on the Cloudflare relay and up to about 1 minute on the
self-hosted one. Nothing is lost: a routed message stays in the recipient's queue until its client
acknowledges the cursor (section 7), so the client receives it once it runs again, on the same
connection or after reconnecting. `routed` never meant read; a sender that needs to know waits for
the `delivered` receipt.

**Idle notices.** `notify_idle` asks for one `notice` the next time that session reports `idle` or
ends. It lapses after 12 hours, and a session may hold at most 16.

## 9. Limits (defaults; a relay MAY lower the relay-side ones)

| limit | default |
|---|---|
| frame size, client to relay | 1 MiB |
| frame size, relay to client | 1 MiB + 4 KiB |
| frame size before `auth` | 16 KiB |
| message text | 256 KiB |
| sends per session | 60 a minute, bursts of 20 |
| broadcast sends per session | 6 a minute |
| fanned-out bytes per sender device | 32 MiB a minute |
| queue per recipient session | 50 messages, at most 10 from any one sender device |
| queue lifetime | 24 hours |
| auth deadline after `hello` | 10 seconds |
| auth clock skew | 5 minutes |
| `create`, `join` and recovery `auth` per source address | 10 an hour, together, across every mesh on the relay |
| WebSocket dials per source address | 600 a minute, across every mesh on the relay |
| connections before `auth` per source address | 256 open at once |
| idle notices per session | 16, each lasting 12 hours |
| sessions per mesh | 256 |
| sessions per device | 32 |
| live invites per device | 16 |
| invite lifetime | 1 hour by default, at most 7 days |
| short invite code box (section 5) | at most 4 KiB, kept until the invite's expiry and at most 1 hour, handed out 3 times |
| `rdv.put` | 16 an hour per device, 64 per mesh, 64 per source address |
| box fetches (`GET /v1/rdv/<id>`) | 30 an hour per source address, found or not |
| boxes per relay | 10,000 |
| roster page | 64 rosters or 512 KiB |
| message freshness at the receiver | 47 hours old to 10 minutes ahead |
| message id memory at the receiver | `at` + 48 hours + 10 minutes |
| task deadline | at most 24 hours after `at` |
| rooms per mesh | 64 |
| rooms per session | 16 |
| room history | last 100 messages, kept 72 hours, 50 per page |
| lease time to live | 1 second to 1 hour |
| leases per mesh | 256 |
| leases held per session | 16 |
| lease watches per session | 16, each lasting 1 hour |
| file size | 25 MiB (100 chunks of 256 KiB) |
| blob chunks stored per device | 200 MiB a day |
| blob storage per mesh | 1 GiB |
| blob chunks stored per mesh | 1 GiB a day, all devices together |
| blob lifetime | 24 hours |
| `card.set` and `card` frames | 64 KiB |
| `card.set` per session | 1 a minute |
| card bytes per device | 256 KiB |
| `cards` page | 512 KiB |
| leases held per device | 32 |
| continuous hold of one lease | 4 hours |
| room history per mesh | 64 MiB |
| parked messages per mesh (`roster_behind`) | 64 |
| recovery code display window | 10 minutes |
| verified recovery connections per mesh | 5 an hour |
| pending join connections | 1 per invite, 16 per mesh |
| `derived` window after an information-only item | 10 minutes |
| prekey rotation | daily (a new one when the newest is 24 hours old) |
| prekey validity (`until` - `at`) | at most 48 hours |
| prekey secret kept | until `until` + 72 hours |
| senders stop using a prekey | 10 minutes before its `until` |
| prekeys kept per device and mesh | 8 |
| pongs a session sends | 10 a minute to one device, 60 a minute in all |
| oldest ping still answered | 60 seconds |
| CI request body (section 18) | 32 KiB |
| CI notice `text` | 4 KiB |
| CI ID token | 8 KiB |
| CI requests per source address | 60 a minute, per mesh |
| CI notices per counting key (a GitHub repository, or a device's GitLab share) | 60 a minute, bursts of 20 |
| CI queue per recipient session | 20 notices, at most 10 per counting key, apart from the 50 messages |
| CI rule tags per device | 64 |
| GitHub token ids (`jti`) a relay remembers per mesh | 4096 at once, each until the token's `exp` + 5 minutes |
| CI clock skew at the relay | 5 minutes |
| JWKS fetches for a `kid` not cached | 1 a minute per issuer |
| JWKS kept | 1 hour at a relay, 24 hours at a client |
| CI token lifetime (`exp` - `iat`) | at most 24 hours |
| CI notice id and token id memory at the receiver | the later of `at` + 48 hours + 10 minutes and `exp` + 10 minutes |

## 10. What the relay can and cannot see

It sees: mesh ids, device ids and names, session names, kinds and busy or idle status, who sends to
whom, when, and how large. It cannot see message text, cannot add or remove devices, cannot forge
or alter a message without the receiver dropping it, and cannot replay one past the receiver's
dedupe and freshness window. It can drop or delay messages. It can withhold a roster update from a
client for a while, but every message carries the sender's roster reference, so a receiver learns
of a newer roster from the first message sent after it and fetches the chain before trusting the
sender. A relay that serves two different rosters for one seq is caught when the forks meet
(section 4).

Room names and membership (section 13), lease keys and holders (section 14), blob sizes and
timing (section 15), that a short invite code exists, which admin device stored it, its size, and
when it is fetched and from where (section 5; never the code or the invite in it), and each
device's prekeys with their times of rotation (section 6b) are
relay-visible metadata; message kinds and file names and contents are not. A relay that records
ciphertext and later obtains a device's key file reads only what that device's prekey secrets
still open (section 6b).

CI senders (section 18) add to that, on a relay that takes them:

- **A GitHub notice's ID token, once.** The relay reads it in the `ci.send` request to verify it:
  so it sees, for that moment, every claim (repository and owner, their ids and visibility, the
  ref, workflow, event, commit sha, run ids, the actor's login and id, the environment). It stores
  none of them and never the token: it keeps a counting key (a hash of the repository's ids), a
  hash of the token's `jti` until the token expires, and nothing else from the token. The token
  also travels inside the sealed box, which is the copy the receiving device verifies.
- **Never a GitLab token.** A GitLab notice's token travels only inside the box, so the relay
  never sees its claims (which include the pipeline user's email address) and verifies nothing.
- **Each device's rule tags**: up to 64 hashes of (mesh, device, issuer, repository, ref), and
  whether the device takes GitLab notices. A tag hides only a repository name that cannot be
  guessed: one SHA-256 per candidate tests a name, and public repository names and
  `refs/heads/main` are easy to guess.
- **Which session takes CI notices**, which device and session each notice is for, its size and
  time, the counting key it was counted under, and which prekey it handed to a request from which
  source address (kept only as the keyed hash of section 9's per-source limits).

What a CI sender learns from the relay's answers: a GitHub sender, whose token the relay verified
for a repository the device has a rule for, learns whether the session it names exists and takes
CI notices, and whether it is online (`unknown`, `routed`, `queued`). Anyone who has a recipient
code learns, by `ci.prekey`, whether the device takes CI notices by each provider, and the
device's newest prekey; a GitLab send tells it only `queued` or `limited`, never a session name or
whether a session is online (section 18).

A relay cannot read a notice's text. It cannot alter or forge a GitHub notice (the one-time key
signs it and the token binds that key), nor a GitLab notice it never saw the token of. It can drop,
delay or replay a notice, and the receiver's freshness window and id store stop a replay.
Leases are different from everything else here: they are advisory, and the relay is trusted for
them. A hostile or faulty relay can grant one lease to two holders at once, so a lease MUST NOT be
the only thing protecting work that would be unsafe to run twice. The fencing token lets a holder,
and anything it writes to, tell an old grant from a newer one.

The threat model is in `SECURITY-MODEL.md`.

## 11. Mesh creation

`create` is the only unauthenticated write besides `join`: `{ "t": "create", "roster": <genesis> }`.
The relay verifies the genesis roster and refuses a mesh id it already holds with
`error { code: "mesh_exists" }`. A relay MAY require an operator key, sent as `"key"`, for
`create`, and MAY refuse `create` altogether; both answer `error { code: "unauthorized" }`. A
public relay SHOULD require the key. Creation SHOULD never be open by accident: the reference
relays refuse `create` unless their operator set a key or opened creation explicitly, and treat
an empty key as a misconfiguration that refuses `create`, never as no key.

A relay MAY cap how many meshes it holds; a `create` past the cap gets `error { code: "full" }`,
and meshes it already holds are unaffected. A relay MAY delete a mesh that no session has used
for a period it publishes (`/v1/info`, below): the mesh is then gone, with its rosters, queues,
rooms, leases and blobs, its devices get `unauthorized` ("unknown mesh"), and they must create a
new mesh.

**Deleting a mesh.** An admin device MAY have the relay delete its mesh, for every device in it, by
sending `mesh.delete { mesh }` on an authenticated session, where `mesh` is the connection's mesh
id.

- The relay refuses it with `error { code: "unauthorized" }` from a device that is not an admin in
  its newest roster, `malformed` for any other mesh id, and `unsupported` when it does not delete
  meshes (a relay older than this answers `unknown_type`). Before `auth` it is `unauthorized`, as
  every authenticated frame is, and a recovery connection (section 4a) cannot send it.
- Otherwise it answers `mesh.deleted { mesh }`, closes every connection on the mesh with close code
  4005 (sessions, joiners waiting for an admin and a recovery connection alike), and deletes the
  mesh as it deletes an idle one: its rosters, sessions, queues, rooms and their history, leases,
  blobs, cards, invites and waiting joins, CI rule tags and token ids, and its place in any mesh
  cap. A short invite code's box (section 5) is kept relay-wide, not per mesh, and still ends at
  its expiry. From then on the mesh does not exist: an `auth` for it gets `unauthorized` ("unknown
  mesh"), as after an idle mesh was deleted.
- Nothing but the session's `auth` authorises the request. The relay is trusted for availability
  (section 10) and can delete or withhold a mesh at any time, so this rule only keeps members other
  than admins from doing it. Any admin may delete the mesh for every device, other people's
  included, as any admin may revoke them.
- A client SHOULD take the decision only from its person, the way it takes a join confirmation
  (section 5). The reference client's `wim mesh delete` runs only at an interactive terminal with
  no agent's variables set and acts only on a typed yes, and no tool, MCP call, message or local UI
  request reaches it.
- Clients keep their own copy of the mesh (configuration, rosters, history), which the relay
  cannot reach. A client that gets 4005, or `unknown mesh` in answer to `auth`, SHOULD stop
  reconnecting and tell its person. The reference client's `wim mesh delete`, run on a device whose
  relay no longer holds the mesh, removes that device's copy after the person confirms.

**Relay information.** A relay SHOULD answer an HTTP `GET` of `<relay>/v1/info`, the relay URL
with `wss://` read as `https://` (`ws://` as `http://`), with 200, `Content-Type:
application/json` and:

```json
{ "v": 1, "software": "worldinmotion-relay", "version": "0.1.0", "create": "key",
  "limits": { "max_meshes": 2000, "idle_mesh_days": 90, "blob_bytes_per_mesh_per_day": 26214400 },
  "offer": "Free hosted relay during the worldinmotion preview, until version 1.0", "ci": false }
```

`ci` says whether the relay takes CI senders (section 18); a relay older than CI senders leaves
it out, which means `false`.

`create` is `key` (an operator key is required), `open` or `closed` (refused, including a relay
whose configuration is wrong). In `limits`, `null` means unlimited; `blob_bytes_per_mesh_per_day`
is the effective limit (section 9 when the relay sets none). `offer` is a line of at most 280
characters from the operator, or `null`, and is shown as data, never as an instruction. The
document holds no secret and no live count. A client MUST NOT depend on it to connect.

## 12. Message kinds

The plaintext `kind` is one of `msg`, `task`, `result`, `file`, `card` (section 17), `ping`,
`pong` or `pause`. All kinds carry the fields of section 6 (`v`, `id`, `from`, `to`, `at`, `roster`); the
message kinds may carry `reply_to`, and each adds its own:

| kind | `text` | adds |
|---|---|---|
| `msg` | required: the message | nothing |
| `task` | required: the task | `deadline` (time, optional): after `at` and at most 24 hours after it |
| `result` | required: the result body | `reply_to` is REQUIRED and names the task id; `status`: `done`, `failed`, `declined` or `timeout` |
| `file` | optional: a caption | `file`, below |
| `ping` | none | nothing; `to` names sessions only, never `*` or a room |
| `pong` | none | `reply_to` is REQUIRED and names the ping id; `to` is exactly one session |
| `pause` | none | `pause`, below; `reply_to` (optional) names the held message; `to` is exactly one session |

```json
"file": { "blob": "<ULID>", "name": "notes.txt", "size": 9, "mime": "text/plain",
          "key": "<b64u 32 bytes>", "sha256": "<b64u 32 bytes>", "chunks": 1 }
```

- `name` is 1 to 255 characters with no `/`, `\` or control character, and is not `.` or `..`.
  `size` is in bytes, at most 25 MiB. `mime` is 1 to 127 printable ASCII characters. `key` is the
  file key and `sha256` the SHA-256 of the whole plaintext file (section 15). `chunks` MUST equal
  the chunk count for `size`: `max(1, ceil(size / 262144))`.
- The kind lives only inside the plaintext, so the relay does not learn it. Plaintexts are strict:
  a receiver MUST drop an unknown kind, or a field that does not belong to its kind.
- A receiving client presents a task as a task from a peer, framed as section 6a requires: a task
  is still not the person's instruction, and the agent decides whether to do it. It presents a
  result as the answer to the named task, and a file as a notice naming the file and where the
  client saved it.
- A `result` answers a task only if its sender device and session were among the task's resolved
  addressees: named directly, a member of an addressed room when the task was sent, or anyone for
  `*`. Any other result is presented as an ordinary message, labelled as an unsolicited result.

**Ping and pong.** A `ping` asks whether a session is there; the receiving client answers it
itself, never an agent. Both are sealed and signed like every message, so one pong proves both
directions between two devices, encryption included: the pinging device sealed the ping and the
other opened it, and the other sealed the pong and the pinging device opened it.

- `ping` and `pong` carry no `text`, and no `relayed` or `derived`. A ping names one or more
  sessions in `to`; a pong is addressed to the one session that sent the ping, and its `reply_to` is
  the ping's id.
- A receiver runs every check of section 6, dedupe and seq included, then answers a ping with a
  pong, at once, unless: its person's inbound policy for the sender device is `refuse`; the ping's
  `at` is more than 60 seconds before its clock (it waited in a queue); or the receiving session
  has sent 10 pongs to that device, or 60 in all, in the last minute. It answers from the session
  that received the ping, as a new message of that session (its own next `seq`).
- A ping or pong is never spooled, kept in history, receipted (section 7) or shown to an agent,
  starts no agent turn, and counts against no breaker (SECURITY-MODEL section 7.3). Inbound policy
  `hold` does not hold it: the answer shows only that the session is online and that its device
  can open what is sealed to it, and every member already sees presence in peer rows.
- A pong counts only for a ping its session sent and still waits on, and only from a session that
  ping named; the client drops any other.
- A client older than these kinds drops them as `plaintext_malformed` (section 6, step 8), so a
  ping to it gets no pong. The sender cannot tell that from a session that is not reading.
- The reference client's `wim ping <address,...>` and `wim ping --all` ping sessions the relay
  lists as online (an offline one would only collect a queued ping), wait 5 seconds by default, and
  print one row per session and one per device.

**Pause.** A receiving client whose loop and cost breaker (SECURITY-MODEL section 7.3) paused a
sender device tells each session of that device that sends to it during the pause (directly, to a
room or to `*`), once per pause, with a `pause` addressed to that session; and, when the person
resumes the device before the pause ends, tells each session it told that the pause was lifted:

```json
"pause": { "state": "paused", "rule": "peer", "count": 121, "limit": 120, "minutes": 60,
           "until": 1793930000000, "auto": true }
"pause": { "state": "lifted" }
```

- `rule` is `peer` (the per-peer limit), `total` (the total limit) or `pingpong`. `count` is what
  the rule counted when it tripped and `limit` its limit, both whole numbers of at least 1;
  `minutes` (1 to 60) is the window the rule counts over. `until` is when the pause ends: after
  `at`, and at most an hour after it. `auto` is true when the receiving client then releases the
  sender by itself (a trusted device's cool-down, delivering at most the per-peer limit of what it
  held), false when that waits for its person.
- Like a ping or pong, a `pause` carries no `text`, `relayed` or `derived`, is written by the
  client itself and never by an agent, is never spooled, kept in history, receipted or shown to an
  agent as a message, starts no agent turn, and counts against no breaker. A receiver drops one
  from a device whose policy is `refuse`, and a `paused` from a session none of its device's
  sessions sent a message to in the last hour (directly, or as a member of a room or `*` it sent
  to). It takes a `lifted` from any session, since a lift can only clear a label.
- A `pause` is a label, like a receipt (section 7): advisory, never proof that anything was or was
  not delivered. A receiver uses it only for what it reports: until `until`, or a `lifted` from the
  same session, it MAY report a send to that session as `held` instead of the relay's `routed` or
  `queued`, with the rule and its numbers, and it SHOULD tell the sending agent once. A row for a
  room or `*` keeps the relay's status: one member's pause does not hold the room. It MUST NOT
  change what it sends, holds or delivers because of one, and a `pause` never lifts, shortens or
  resumes a pause on the device that receives it.
- A client older than this kind drops it as `plaintext_malformed` (section 6, step 8); its sends
  then report `routed` as before, and the `held` receipts still come.

## 13. Rooms

- A room address is `#` plus a name (`#ops`). Rooms exist per mesh and are created on first join.
- Client frames: `room.join { room }`, `room.leave { room }`, and
  `room.history { room, before?: <cursor>, limit?: <1 to 50> }`. Relay frames:
  `room.joined { room, members: [<address>] }` and
  `room.history { room, msgs: [ { cursor, msg } ], more }`: the messages just before `before` (or
  the newest), oldest first, with `more` saying whether older ones exist. A page never exceeds the
  relay frame limit (section 8); the relay returns fewer messages instead.
- Membership belongs to the session (by sid). It survives reconnects and a name takeover by proof
  (section 8). A session that says `bye` leaves its rooms.
- A send whose `to` contains a room is routed to every member session except the sender. A room
  send carries a box for every device in the roster, as a broadcast does: membership is a routing
  hint, not a confidentiality boundary inside a mesh. Receivers apply the rules of section 6, where
  "`to` contains a room the receiving session is a member of" counts as addressed. A room send
  counts as a broadcast for rate limits (6 a minute per session) and against the fan-out budget.
- The relay keeps each room's last 100 messages for 72 hours for `room.history`, and at most 64 MiB
  of history per mesh, dropping the oldest first. It never serves an entry older than 72 hours,
  even one a sweep has not deleted yet. 72 hours is also the longest a relay keeps a queued
  message, a history entry or a blob chunk: a relay MAY shorten those lifetimes, but never
  lengthen one past it. A device added after a message was sent has no box in it and cannot read
  it; that is expected. A device keeps every prekey secret at least 72 hours after the last box
  sealed to it (section 6b), so every history entry stays readable for as long as the relay keeps
  it. A client reading history
  applies every receiving check of section 6 except freshness and the dedupe store (history is
  older than the freshness window by design), and except the rule in step 5 that drops the
  receiving session's own `*` or room sends: history includes the reader's own messages, so a
  session reading a room sees both sides of the conversation. It MUST present what it reads as
  history, never as a new message, task or file to act on.
- Peer rows carry the session's `rooms`. Room names and membership are relay-visible metadata.
- A mesh has at most 64 rooms and a session is in at most 16. A join past either limit gets
  `error { code: "room_limit" }`.

## 14. Leases

A lease is an advisory lock that sessions of a mesh use to take turns (for example one deploy at
a time).

- The client names a lease; the relay sees only its key,
  `b64u(H(UTF-8("wim/1 lease " + meshId + " " + name)))` truncated to 22 characters. A short or
  guessable name can be recovered by trying candidates, so the key hides only hard-to-guess names.
- Client frames: `lease.acquire { key, ttl, wait? }` (`ttl` in milliseconds, 1 second to 1 hour),
  `lease.renew { key, token, ttl }`, `lease.release { key, token }`, `lease.list`, and
  `lease.watch { key }`.
- The relay answers with `lease { key, status, holder?, until?, token? }`, where `status` is
  `granted`, `held` (someone else holds it; `holder` and `until` are given), `released`, `expired`,
  `renewed` or `refused` (a bad token or ttl, or a limit). `lease.list` is answered with
  `leases { leases: [ { key, holder, until, token } ] }`.
- `token` is a fencing token: a counter that the relay increments on every grant, strictly
  increasing per key (a relay MAY use one counter for the whole mesh). A holder
  that lost its lease can tell, and a system the holder writes to can refuse a write that carries an
  older token than one it has seen. A key's token MUST never decrease, across relay restarts and
  migrations: the relay persists the counters.
- `lease.renew` and `lease.release` are accepted only from the holding session (its sid); the
  token alone is not authorisation.
- A lease may be held continuously, by acquire plus renewals, for at most 4 hours, measured from
  the grant. After that a
  renew is `refused`, and the holder must release and acquire again, going to the back of any wait
  queue.
- With `wait: true`, an acquire that finds the lease held is queued, first come first served, and
  answered `granted` when the lease frees, or `expired` if the waiter's own ttl passes first. A
  waiting acquire counts against the session's lease limit, and a waiter that goes offline loses
  its place.
- A lease ends at `until`, on `lease.release`, or when its holder session says `bye`. It does not
  end when the holder only disconnects: a network blip keeps it until `until`.
- `lease.watch` asks for one `lease { status: "released" | "expired" }` when the key next frees.
  A watch lapses after 1 hour.
- Leases are advisory and the relay is trusted for them (section 10).
- A mesh has at most 256 leases; a device holds at most 32, a session at most 16, and a session
  watches at most 16. A request past a limit gets `lease { status: "refused" }`.

## 15. Blobs

Files travel as encrypted chunks stored by the relay, announced by a `file` message (section 12).

- The sender picks a random 32-byte file key and a blob id (a ULID), splits the file into chunks of
  256 KiB numbered from 0 (the last may be shorter; an empty file is one empty chunk), and encrypts
  each with XChaCha20-Poly1305, a fresh 24-byte random nonce, and
  AAD = `UTF-8("wim/1 blob " + blob + " " + index + " " + (last ? "1" : "0"))`. The AAD binds each
  chunk to its blob, its position and whether it ends the file, so chunks cannot be reordered,
  moved between blobs, or dropped from the end without failing decryption.
- Client frames: `blob.put { blob, index, last, n, data }` (`n` the b64u nonce, `data` the b64u
  ciphertext) and `blob.get { blob, index }`. Relay frames: `blob.stored { blob, index }`,
  `blob.chunk { blob, index, last, n, data }`, and `error` with code `blob_missing` (no such
  chunk) or `blob_quota` (a storage limit).
- The relay stores chunks for 24 hours, keyed by mesh and blob id, readable by any session of the
  mesh. A blob is complete when a `last` chunk is stored and every lower index exists. A stored
  chunk may be replaced only by the device that stored it.
- After storing every chunk, the sender sends the `file` message carrying the key.
- The receiver fetches every chunk, decrypts each, checks that every chunk but the last is exactly
  256 KiB, that the indexes run from 0 to `chunks - 1` with `last` on the final one only, and that
  the total size and SHA-256 match the `file` message. Only then does it expose the file: written
  under a safe file name of its own choosing in its downloads folder, never executed.
- Limits: 25 MiB per file (100 chunks), 200 MiB of chunks stored per device per day, 1 GiB stored
  per mesh. A frame carrying a chunk is within the normal 1 MiB limit (a 256 KiB chunk in b64u is
  about 342 KiB).

## 16. Test vectors

`packages/protocol/vectors/` holds deterministic JSON fixtures that any implementation can check
itself against. They are generated from fixed seeds (no randomness at generation time) by
`npm run vectors -w @worldinmotion/protocol`, and a test regenerates them and requires the
committed files to match byte for byte, so they cannot drift from the code. The files are ASCII
JSON with two-space indentation and a trailing newline; any non-ASCII value appears as a JSON
escape.

| file | covers |
|---|---|
| `canon.json` | JSON inputs and their canon output (key order by UTF-16 code unit, escapes, non-ASCII, `-0`, no Unicode normalisation), and inputs that MUST be refused |
| `b64u.json` | encodings, and non-canonical inputs that MUST be refused |
| `keys.json` | fixed secrets to public keys and device ids |
| `sign.json` | for each signature type (`prekey` included), the object, the signed bytes and the signature; tampered cases that MUST fail |
| `box.json` | one scheme 1 box: keys, mesh id, header, nonce, shared secret, box key, AAD, plaintext and ciphertext |
| `roster.json` | a chain (genesis with a recovery record, a member add, a promotion, a revocation, a recovery add), its recovery code, and invalid successors with their failure reasons |
| `invite.json` | an invite code with a TLS pin, its secret and id, and a join with its proof, signature and short authentication string |
| `rdv.json` | a short invite code for `invite.json`'s code: `k`, the check, `rdv`, the box key, AAD, nonce and ciphertext, the relay's answer, spellings that read back, and codes that MUST be refused |
| `message.json` | a sealed send frame with a scheme 1 box, the plaintext one recipient opens, and tamper cases with their reasons |
| `ping.json` | a ping and its pong, each a whole frame sealed to the other device's prekey, with the plaintexts each side opens; ping and pong plaintexts that MUST be refused |
| `pause.json` | a `pause` with every field and one saying the pause was lifted, each a whole frame sealed to the paused device's prekey, with the plaintexts it opens; pause plaintexts that MUST be refused; and the kinds a client before `pause` knows, whose schema MUST refuse both |
| `prekey.json` | two signed prekeys with their secrets; one scheme 2 box by hand with every HPKE value (info, AAD, ephemeral secret, enc, shared secret, key, base nonce, ciphertext); a whole frame carrying `pk`, its plaintext, and tamper cases (`key_expired`, `decrypt_failed`, `bad_signature`) with the prekeys held; prekeys that MUST fail verification, with their reasons |
| `blob.json` | a 2-chunk file with a fixed key and nonces |
| `ci.json` | section 18: a recipient code, both audiences, a rule tag, a CI sender id and counting key; a GitHub and a GitLab notice sealed by hand (one-time key, `xk`, prekey, HPKE values, plaintext, the `ci` signature) with a fixture RSA issuer key and its JWKS; tokens that MUST be refused, with their reasons |

An implementation is conformant for a primitive only if it reproduces that primitive's vectors
exactly. The HPKE core is also checked against RFC 9180 Appendix A.2.3 (the same suite, mode_auth)
in `packages/protocol/test/hpke.test.ts`.

The vectors' secret keys are public. Clients SHOULD refuse any device or recovery key equal to
one of them; `VECTOR_SEED_PUBLIC_KEYS` lists their public keys, and `isVectorKey` checks one.

## 17. Peer cards

A card tells the other sessions of a mesh what a session is working on, for their peer listings.

- A card is a sealed message (section 6) whose plaintext has `kind` `card`, no `text`, and
  `card: { "cwd"?: <at most 512 characters>, "branch"?: <at most 255>, "title"?: <at most 120> }`.
  It is sealed to every roster device and addressed `"to": ["*"]`, like a broadcast; any other
  `to` is invalid. Its `seq` is always 0: cards have their own seq space and never collide with
  message seqs.
- The client sends it as `card.set { msg: <send frame> }` after `ready` and whenever a field
  changes, at most once a minute, and at once when its device's prekey rotates. Every session sends
  one, with an empty `card` when it shares no labels, because the card's header carries the
  device's current prekey as `pk` (section 6b). A receiver takes the `pk` whether or not it can
  open the card, and lists no labels for an empty card. The relay stores only the newest card per session, replacing the
  previous one, and never treats it as a message: no `deliver`, no queue, no receipts, no wake.
- After `ready` the relay sends `cards { cards: [<send frame>], more }` with the stored card of
  every session in the mesh that has not ended (online or offline), in pages of at most 512 KiB and
  never over the relay frame limit;
  when `more` is true the client asks for the next page with `cards.get { after: <the last card's
  sid> }` (`more` absent means false). It sends `card { msg }` to every session when a card
  changes. A session's card is deleted when the session ends or its device is
  revoked.
- A receiver opens a card as history (section 13: the checks of section 6 that history applies,
  since a card can be old), requires `kind` `card`, and uses it only to annotate the peer row of the
  sending session, matched by device id and `from.sid`. The relay cannot read or forge a card, but
  its contents are still labels from a mesh member, never trusted input: they are passed through
  the display escaping of section 6a and shown inside peer listings only, never to an agent as an
  instruction.
- `card.set` and `card` frames are at most 64 KiB, which limits how many devices a card can be
  sealed to. A device's stored cards total at most 256 KiB; a `card.set` past that gets
  `error { code: "limited" }`.

## 18. CI senders

A CI job can send one notice to one session of a device without being a mesh member and without
any stored key. It proves where it runs with the OpenID Connect ID token its provider gives the
job (GitHub Actions or GitLab CI/CD), and the person decides, on the receiving device only, which
repositories may send. A notice is relayed text (section 6a): information only, never a work
assignment, never the start of an agent turn.

The two providers differ in one way that shapes everything below. GitHub lets a job ask for a
token at run time with an audience it chooses, so the audience can name a one-time key that the
job then signs the notice with: a copied token is useless without that key. GitLab fixes a job's
token audience before the job runs, so no one-time key can be in it, and its token is a bearer
credential for the job's whole timeout. So a GitHub token is shown to the relay, which verifies
it and filters what reaches a device, while a GitLab token travels only inside the sealed box,
where the relay never sees it and the receiving device alone verifies it.

**The recipient code.** The receiving device's `wim ci allow` prints the code that goes in a CI
variable. It is not a secret.

```
wimci1_<b64u(canon({ "relay": "<relay URL>", "mesh": "<mesh id>", "sign": "<b64u Ed25519 public key of the device>" }))>
```

The device id is derived from `sign` (section 2), so the code names the device without trusting
anything the relay says. A sender MUST refuse a code whose `relay` is not a relay URL (section
2), whose `mesh` is not a mesh id, whose `sign` is not 32 bytes, or that holds any other key.

**The audience.** `otk` is the b64u of the sender's one-time Ed25519 public key.

| `via` | `aud` |
|---|---|
| `github` | `"wimci1." + b64u(H(UTF-8("wim/1 ci aud " + mesh + " " + device + " " + otk)))`, asked for at run time, one token per notice |
| `gitlab` | `"wimci1." + mesh + "." + device`, written in the job's `id_tokens:` |

A sender MUST check, before it transmits anything, that the token's `aud` is one string, starts
with `wimci1.`, and equals the audience above for the recipient code (and, for GitHub, the
one-time key it holds); otherwise it refuses and sends nothing. A token with any other audience
may be a credential that a cloud provider accepts. Receivers refuse an `aud` that is an array.

**The two requests.** The sender makes two HTTP `POST`s to `<relay>/v1/<mesh id>/ci`, the relay
URL with `wss://` read as `https://` (`ws://` as `http://`), each with a JSON body of at most 32
KiB and `content-type: application/json`. The relay answers each with JSON.

1. `{ "t": "ci.prekey", "device": "<device id>", "via": "github" | "gitlab" }`, answered 200 with
   `{ "t": "ci.prekey", "prekey": <prekey object> }`: the newest prekey (by `at`) carried in the
   stored cards of that device's sessions (section 17). The relay answers it only for a device in
   the roster that is not a recovery record and that takes CI notices by `via` (below). The sender
   MUST verify the prekey against the code's `sign` key as section 6b says, the roster check
   replaced by two: the prekey's `device` is the id derived from `sign`, and its `mesh` is the
   code's. So a relay cannot slip in a key of its own. A device offline for more than 48 hours has
   no usable prekey, and the sender reports that.
2. `ci.send`:

   ```json
   { "t": "ci.send", "mesh": "<mesh id>", "id": "<ULID>", "device": "<device id>", "to": "<session name>",
     "at": 1760000000000, "via": "github", "otk": "<b64u Ed25519 public key>", "xk": "<b64u X25519 public key>",
     "box": { "s": 2, "p": "<prekey id>", "e": "<b64u>", "c": "<b64u>" }, "sig": "<b64u, type ci>",
     "token": "<the GitHub ID token>" }
   ```

   A `gitlab` send carries no `otk`, `sig` or `token`. The relay answers 200 with
   `{ "t": "ci.sent", "id": "<ULID>", "status": "..." }`, where `status` is `routed`, `queued`,
   `unknown` (no session of that name on the device takes CI notices), `full` or `limited`. A
   `gitlab` send, whose sender the relay cannot verify, is answered only `queued` or `limited`:
   `queued` also when the notice was routed, when the session is unknown, when its CI queue is
   full and when its id was used before (the last three drop the notice), so a recipient code never
   tells which session names exist or which are online. `limited` is per device, so it tells
   neither.

- The **notice** is the `ci.send` object without `token`: what the relay stores and delivers.
  The **header** is the notice without `box` and `sig`.
- `sig` is the one-time key's Ed25519 signature, type `ci` (section 3), over the notice without
  `sig`. It covers the box, `xk`, `to` and `at`.
- `xk` is a fresh X25519 key per notice. The **CI sender id** is
  `b64u(H(UTF-8("wim/1 ci sender " + xk)))` cut to 22 characters. A receiver computes it from `xk`
  and never reads one from the frame, so a relay cannot make a notice open as a member's.
- `box` is a scheme 2 box (section 6b) to the prekey, with `xk`'s secret as the HPKE sender key
  and the CI sender id in the sender slot of the info string:
  `"wim/1 box2 " + mesh + " " + ciSenderId + " " + device + " " + prekeyId`. AAD is
  `H(canon(header))`, as for a message. Scheme 1 boxes are never used for CI notices.
- The **plaintext** is UTF-8 `canon` of
  `{ "v": 1, "kind": "ci", "id", "device", "to", "at", "text", "token" }`: `text` at most 4 KiB
  of UTF-8, `token` the ID token (for `github`, the same one the request carried), at most 8 KiB.
  It is strict like every plaintext (section 6, step 8), and its `id`, `device`, `to` and `at`
  equal the header's.

**Errors.** A refused request gets an HTTP error with `{ "t": "error", "code", "message" }`:

| status | `code` | when |
|---|---|---|
| 400 | `malformed` | the body does not parse, or a field is wrong |
| 403 | `unauthorized` | no such mesh; the device is not in the roster, is a recovery record, or does not take CI notices by `via`; the token fails any check; its rule tag is not the device's; its `jti` was used |
| 404 | `not_found` | the relay takes no CI senders (an older relay answers 404 too) |
| 413 | `too_large` | the body is over 32 KiB |
| 429 | `limited` | the source address is over the relay's limit for it, or over its CI budget in the mesh, or the mesh holds as many live `jti`s as it may (below); with `Retry-After` in seconds |

Every refusal in the 403 row gets the same answer, so a caller learns nothing about which check
failed.

**What the relay checks on `ci.send`.** First, before it touches any mesh state: the source
address's rate limit, the size and a strict parse (no unknown keys), and for `github` the token as
below by its own clock, with `aud` equal to the audience for (`mesh`, `device`, `otk`) and `sig`
verifying with `otk`. (The reference Workers relay does all of this in the Worker, so junk costs no
Durable Object request.) The source's rate limit there is the relay's dial limit (section 9), which
CI requests share with dials. Then, in the mesh: that it exists, the per-source CI budget, the device
(as for `ci.prekey`), that `mesh` is the mesh of the path and `at` is within 5 minutes of its
clock; for `github` that the rule tag computed from the verified claims is among the device's tags
and the token's `jti` was not used before in this mesh (it keeps `H(UTF-8(iss + " " + jti))` until
`exp` + 5 minutes); for `gitlab` there is nothing it can verify. Then the notice id must be new, the
session `to` on that device must exist, not have ended, and take CI notices; then the counting
key's rate and the CI queue; then the relay routes or queues the notice. For `gitlab` the counting
key's rate comes before the notice id and the session, and a used id, a missing session or a full
queue drops the notice after spending it, answered `queued` (above). It never stores the token.

**Verifying a token.** The relay (GitHub only) and the receiving client (both providers) check:

- The token is at most 8 KiB, a compact JWS of three canonical b64u parts. Its header and payload
  are JSON objects with no duplicate key. The header has `alg` exactly `RS256`, a string `kid`, an
  optional `typ` that is `JWT`, and none of `crit`, `jku`, `jwk`, `x5u` or `x5c`.
- `iss` is exactly `https://token.actions.githubusercontent.com` (`github`) or
  `https://gitlab.com` (`gitlab`). The key comes from that issuer's fixed JWKS URL,
  `https://token.actions.githubusercontent.com/.well-known/jwks` or
  `https://gitlab.com/oauth/discovery/keys`, never from a URL in the token: the JWK with that
  `kid`, `kty` `RSA`, `alg` absent or `RS256`, `use` absent or `sig`, a modulus of at least 2048
  bits and `e` 65537. The signature is RSASSA-PKCS1-v1_5 with SHA-256.
- `aud` is a string; `iat` and `exp` are integers (seconds) with `exp` after `iat` and at most 24
  hours after it; `nbf`, if present, is an integer; `jti` is a string. The claims the rule uses
  are strings: for GitHub `repository`, `repository_id`, `repository_owner_id`, `ref`,
  `workflow_ref`, `event_name`, `sha` and `run_id`; for GitLab `project_path`, `project_id`,
  `namespace_id`, `ref`, `ref_type` and `ref_protected` (also accepted as a boolean).
- A relay also checks the time by its own clock, with 5 minutes of skew: `exp` not passed, and
  `nbf` (or `iat`) not ahead. A client does not (below).
- JWKS: a relay keeps an issuer's keys at most an hour and a client at most 24 hours; for a `kid`
  it does not hold, either fetches the issuer's JWKS again at most once a minute per process (on
  the Workers relay, per isolate, so the relay as a whole may fetch more often). A JWKS answer is
  at most 64 KiB.

**Rule tags.** A relay cannot check a rule it does not hold, and without a check anyone with a
token from any repository could fill a person's queues. So every session of a device that has
rules sends, after `ready` and whenever the device's rules change, `ci.rules { tags, gitlab }`:
at most 64 tags, and `gitlab` true when the device takes GitLab notices. A tag is
`b64u(H(UTF-8("wim/1 ci rule ") || canonBytes({ "mesh", "device", "iss", "repo", "ref" })))` cut
to 22 characters, where `repo` is the lower-cased `repository` and `ref` the full ref. The frame
replaces the device's tags and GitLab setting (a session is its device, so any session may), and
marks the sending session as taking CI notices until it ends. The relay answers
`ci.rules { count }` (the number of tags it holds for the device) and purges the tags with the
device when it is revoked. A tag is a filter for queues and cost, not authority: the receiving
client checks the whole rule itself. GitLab rules have no tags, since the relay sees no GitLab
token to compare one with.

**Delivery.** The relay sends `{ "t": "ci.deliver", "cursor": 42, "msg": <notice> }`, from the
session's one queue and cursor, and the client acknowledges it with `ack` like a `deliver`. No
receipt is sent for a notice, and the relay forwards none. A relay sends `ci.deliver` only to a
session that sent `ci.rules`; queued notices go out in cursor order on reconnect, like messages.

**Limits.** CI requests count against the source address's dial limit (section 9), and in each
mesh against a per-source CI budget of 60 a minute. Notices are counted under
a **counting key**: for `github`, `"gh~" + b64u(H(UTF-8("wim/1 ci count " + iss + " " +
repository_owner_id + " " + repository_id)))` cut to 22 characters, so a renamed repository keeps
its count; for `gitlab`, `"gl~"` and the recipient device id, the device's one GitLab share. Each
key sends at most 60 notices a minute in bursts of 20. A session's CI queue holds at most 20
notices, at most 10 under one key, and is apart from its 50 messages, so CI never takes a real
peer's place. A relay remembers at most 4096 live `jti`s per mesh and answers `limited` past that.

**What the receiving client checks**, in this order, dropping the notice when a check fails:

1. The frame parses strictly; `mesh` is its mesh, `device` its own device id and `to` its session
   name.
2. It computes the CI sender id from `xk`, opens the box with the prekey's secret (section 6b,
   `key_expired` when it is gone), and checks the plaintext as above.
3. The token verifies as above, against JWKS the client fetches itself. When its key is not
   found because the issuer's JWKS could not be fetched (no answer, or not 200) and the client
   holds no fresh copy of that issuer's keys, the notice has no verdict yet: the client
   acknowledges it like any other, keeps it locally (at most 20 per session) and checks it again
   about once a minute, dropping it once `at` is 47 hours old. It never holds back its acks for a
   CI notice, which would keep a real peer's messages queued at the relay. With a fresh copy in
   hand, a `kid` the issuer does not serve is a drop.
4. `via` `github`: `iss` is GitHub's, `aud` is the audience for (`mesh`, `device`, `otk`), and
   `sig` verifies with `otk`. `via` `gitlab`: `iss` is `https://gitlab.com`, `aud` is
   `"wimci1." + mesh + "." + device`, and there is no `otk` or `sig`.
5. Time: `at` is at most 47 hours old and 10 minutes ahead (section 6), and lies within the
   token's own window, from `nbf` (or `iat`) minus 5 minutes to `exp` plus 5 minutes. The client
   never compares `exp` with its own clock, because a queued notice may arrive up to 24 hours
   after it was sent.
6. One of the person's rules matches (below). A notice whose token verifies but that matches no
   rule is dropped and logged, never held, so no repository can fill the held list.
7. Single use: the notice id and the pair (`iss`, `jti`) were not accepted before. They are kept,
   durably, until the later of `at` + 48 hours + 10 minutes and `exp` + 10 minutes, and claimed
   in one step under a lock the whole device shares, before the notice is delivered, so two
   sessions of one device given the same token accept it once.

**Rules** are the person's, on the receiving device only, and match exactly:

| | GitHub | GitLab |
|---|---|---|
| repository | lower-cased `repository` | lower-cased `project_path` |
| ref | `ref` | `ref_path`; when absent, `refs/heads/` or `refs/tags/` plus `ref` by `ref_type` |
| workflow | `workflow_ref` is `<repository>/.github/workflows/<file>@<ref>` (the repository part without case) | none |
| protection | none | `ref_protected` is `"true"` (or `true`), unless the rule allows unprotected refs |
| event | `pull_request_target` and `workflow_run` are refused unless the rule names the event; a rule that names events takes only those | none |
| environment | optional: `environment` equal | optional: `environment` equal and `environment_protected` `"true"` |
| ids | `repository_id` and `repository_owner_id` equal the pinned ones | `project_id` and `namespace_id` equal the pinned ones |

`workflow` (the display name) is never matched, since any workflow file can set it. Names can be
recycled, so a rule pins the repository's ids. For a public repository the client reads them from
the provider's public API when the rule is made. A rule whose ids could not be read (a private
repository) is kept unpinned: the first notice that matches it by name is held for the person,
showing the ids its token carries, and approving it pins them; nothing from that rule is
delivered before.

**Presenting.** A notice that passes is relayed text (section 6a): information only, never a
work assignment, never a new turn; it waits in the inbox and starts the `derived` window like any
information-only item. A held CI notice never starts a turn either: the client tells the person
about held CI notices at most once an hour per rule, by a notice for the person only. The frame says it is relayed CI text from the provider and repository,
with the workflow file, ref, short commit sha, event and run id from the verified token, written
by a CI job (anything that runs in that job), not by a person or a session. Claim values are
attacker-influenced strings: they get the escaping of section 6a and are cut to 200 characters. A
rule may hold every notice for the person instead. The loop and cost breaker counts notices in a
bucket of their own, per repository and for all CI together, apart from the limits for peers
(SECURITY-MODEL section 7.3): the notice that reaches a limit is held, and later ones are dropped
until the hour rolls over. A rule keeps at most 5 held notices while it is unpinned and 20 when it
holds every notice; past that a notice is dropped and logged, so no repository can fill the held
list.

**Who changes rules.** Only the person, at the client's own command line, under the rule of
section 5 for confirmations (an interactive terminal with no agent's variables, and a typed yes).
No tool, MCP call, message or local UI request can add a rule. The rules are a file under the OS
user (`ci-rules.json`), as the policy is, so a process of that user, or an agent allowed to write
files, can change them (SECURITY-MODEL section 9). A change re-reads the file under a lock after
the confirmation, so two commands never write back each other's stale copy. Approving a held
notice that pins a rule shows every other notice held under that rule with the ids it carries.

**What GitLab cannot have.** Anything that can read a GitLab job's variables (every line of its
script and every dependency it runs) can send one notice as that project until the job times out,
since the token is a bearer credential; a job should set a short `timeout:`. The relay sees no
GitLab token, so it cannot filter GitLab notices: anyone who has a recipient code can fill that
device's GitLab share (10 queued per session, 60 a minute), never its other queues. A device stops
GitLab notices by removing its GitLab rules. Each GitLab token sends one notice (the `jti` is
single use), so a job that sends two declares two `id_tokens`.

**The reference relays** take CI senders only when their operator turns them on
(`WIM_CI=1`), and report it as `"ci": true` in `/v1/info` (section 11). Off, a relay answers the
endpoint 404 and `ci.rules` with `unknown_type`, as an older relay does, and stores no tags and no
session mark. They fetch only GitHub's JWKS; no URL they fetch comes from a request.

**Compatibility.** An older relay answers the endpoint 404 (the sender reports that the relay
takes no CI senders) and `ci.rules` with `unknown_type`. An older client never sends `ci.rules`, so
it is never sent a notice; a session that sent it and then runs an older client ignores
`ci.deliver` frames, which do not parse there, and its next `ack` drops them.
