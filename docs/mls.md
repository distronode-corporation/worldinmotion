# MLS for rooms: a design, not a plan for v0.2

**Status: design only.** MLS is not part of v0.2, and nothing in this document is built. Rooms keep
today's scheme: every room message carries a box sealed to each device's prekey (SPEC sections 6b
and 13). This document records what an MLS room mode would need, so that a later decision to build
one starts from the design rather than from the code.

MLS is the IETF standard for encrypted group messaging (RFC 9420, with its architecture in RFC
9750). The words used here: a **member** holds one **leaf** in a group's ratchet tree; a
**commit** changes the group and starts a new **epoch**; a **KeyPackage** is what a device
publishes so others can add it; a **Welcome** is what an added device reads to join.

## Why not now

Today's rooms work with devices that go offline, and removal needs no rekey: a revoked device's
prekeys fail the roster check, and senders seal nothing more to it (SECURITY-MODEL section 6.14).

MLS would add real group semantics: room membership would become a confidentiality boundary
inside a mesh, and post-compromise security would come from regular key updates. No user has
asked for either, and rooms are a small part of the product.

The cost is not the amount of code. Three design problems set it, one per section below: MLS needs one
mutable state per member, offline members need eviction, and history behaves differently. A
fourth, the library, is in [Library](#library).

## What would change

| | rooms today | an MLS room |
|---|---|---|
| who can read a room message | every device in the mesh (membership is a routing hint) | only the room's member devices |
| removal | revoke from the roster; nothing to rekey | revoke from the roster, then a Remove commit before anyone sends again |
| a stolen device (its key files and state) | opens what was sealed to the device in the last 120 hours | opens the epochs the stolen state still holds, and later ones until a commit removes the device |
| a device offline for days | reads what is queued (24 hours) and room history (72 hours) | catches up from the commit log within 72 hours; after that it is evicted, rejoins, and reads nothing from the gap |
| history after rejoining | 72 hours of room history | none from before its Welcome (see [History](#history)) |
| per-message cost | one box per device | one ciphertext for the room, plus commits |

## The device engine

**The problem.** An MLS member's state changes with every commit it processes and every message it
sends: sending advances that member's key ratchet inside the epoch. wim runs one process per
session, and several sessions share one device. If each session held the device's MLS state, two
of them would process the same commit or send under the same leaf from diverging copies. That
forks the group, or reuses message keys that receivers have already moved past.

The three projects read for this document agree on the rule. agent-connect's spec says that
copying an instance's whole state "makes a second runtime on one leaf, which breaks the group"
(SPEC section 9.4). Marmot's multi-device notes (an idea, not yet in its spec) say "MLS state is
never copied between devices".
SLIM's `crates/mls` writes the group state to storage after every encrypt, so that a restarted
sender "resumes at the correct generation instead of ... reusing keys the receivers have already
ratcheted past".

**The design.** One leaf per device per room, held by the device's signer (`wim agent`, see
[design.md](design.md#the-signer-wim-agent)). Sessions never hold MLS state. They ask the signer
to encrypt a room message and to open one, as they already ask it to sign and to open boxes.

- **The signer becomes required for MLS rooms.** A pluggable signer in the session does not
  help: the epoch secrets live in the group state, not in the signing key. A device with no
  signer can still use rooms in today's scheme.
- **Every state change is written before its effect goes out.** That covers processing a commit,
  merging the device's own commit, joining from a Welcome and each encrypt. agent-connect's
  ADR-004 shows why a separate store is not enough: a crash between the MLS store's write and the
  client's record lost the message for good, because the redelivered frame then failed on a key
  already used. Its fix is a journal written in the same transaction as the MLS state, keyed by
  the message and bound to its hash, so a redelivery returns the recorded result.
- **One leaf per session was considered and rejected.** Sessions start and end all day, so every
  session start would be a commit for everyone. Session names are also claims, not identities
  (SECURITY-MODEL section 5.2), so a per-session leaf would authenticate nothing more.
- **The leaf's credential is the roster entry.** A leaf names its device id and carries the
  device's signing key, and every receiver checks it against the signed roster. agent-connect
  checks each leaf's certificate against its identity and refuses a second leaf for an instance
  it already has (its security review, "MLS usage"). SLIM, in its enforcing mode, drops a message
  whose source name is not the one its MLS sender's identity gives.
- **One cipher suite, pinned, with no negotiation.** agent-connect has exactly one suite and no
  negotiation code. For wim, `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` matches the X25519 and
  Ed25519 keys devices already have. SLIM defaults to P-256 so that browser WebCrypto peers can
  join, which wim does not need. No post-quantum suite: the review reports that IANA has assigned
  none yet (not checked here).

## The commit log

**The relay as sequencer.** MLS needs every member to apply the same commits in the same order. A
Durable Object per mesh (and the one process of the self-hosted relay) is a natural single
sequencer. agent-connect's delivery rules (its SPEC section 8.3) are the model to follow:

- The relay accepts a commit only for the room's current epoch and only from a member, then moves
  the epoch on. A commit for an older epoch gets a conflict answer naming the current one.
- It fans a commit out to the membership as it was before the commit, so a removed device learns
  of its removal, and an added device gets only its Welcome.
- A device merges its own commit only when the relay confirms it. On a timeout it resends the same
  bytes under the same id. While its commit is pending it sends no application messages.
- Application messages from the previous epoch are accepted for exactly one epoch, attributed to
  their sender as it was in that epoch.

Marmot shows the alternative. Its relays (Nostr) have no order, so every client runs a
convergence algorithm that picks one branch and may rewind up to 5 commits (its
`protocol-core/convergence.md`). wim avoids that by letting the relay order commits. The price is
that the relay is trusted for order, as it already is for delivery: it can drop or delay anything
(SECURITY-MODEL section 9).

**A forked view is the relay attack to plan for.** A hostile relay can send different commits to
different members. A comparison of the epoch between devices would detect it, but agent-connect's
review SR-01 shows a trap: a short code derived from the epoch can be chosen by whoever makes the
last commit, by trying commits (it measured about 9.7 core-hours for a 42-bit code). Its fix
(its #67) mixes a nonce from each side through commit-then-reveal. Any human comparison
code for an MLS room needs the same construction. wim's invite comparison code is not derived
from MLS and is not affected.

**Who may commit what.**

- **Adds and removes follow the roster.** A commit may add only devices in the current signed
  roster, and every receiver refuses one that adds anything else. A device revoked from the
  roster is removed from every MLS room by the next commit, and no member sends in an epoch that
  still holds a revoked leaf.
- **Updates** come from any member for its own leaf, on a schedule (agent-connect: 24 hours or
  about 1,000 messages, at a random threshold per instance).
- **A device may remove itself.** Leaving a room is a self-remove, committed by the next member
  that sends.

**Retention.** The relay keeps each room's commits for the eviction window below and no longer.
That fits the existing rule that the relay keeps nothing longer than 72 hours (SPEC section 13).

## Eviction

**The problem.** A member that misses one commit can read nothing after it. Laptops sleep for days,
and the relay queue holds 24 hours. RFC 9750 (section 8.2.2) recommends that applications "evict
clients that are idle for too long", and RFC 9420 (section 16.6) says applications "SHOULD have
mechanisms for evicting group members that are offline for too long". Without eviction, a stolen
laptop that was offline for weeks could catch up through a retained commit log. That would be worse
than today's 120-hour bound.

**The design.**

- **Window.** A device whose leaf has sent no commit for 72 hours (a scheduled Update counts) is
  removed by the next member that commits. Every member can check that from the commit log. Online
  devices update at least daily, so only devices that were away are removed. 72 hours matches the
  relay's longest retention, so any device not yet evicted can still fetch every commit it missed.
- **Rejoining.** A returning device publishes a fresh KeyPackage, signed with its device key and
  checked against the roster, as it publishes prekeys today. Any online member re-adds it. SLIM's
  `rejoin_member` does this in one commit, a Remove of the stale leaf plus an Add of the new
  KeyPackage, for "a participant [that] rejoins with a stale MLS epoch". agent-connect does the
  same after a queue overflow: the member "MUST NOT assume it is in sync" and re-syncs by rejoining.
- **Liveness, not safety.** A relay can withhold a KeyPackage and keep a device out. It can
  already drop that device's messages, so this adds no new power.
- **The person is told.** An evicted device's sessions say that the room's history before the
  rejoin is not readable on this device, rather than showing a silent gap.

## History

**Today.** A returning device reads up to 72 hours of room history, because each device keeps
every prekey secret at least 72 hours after the last box sealed to it (SPEC section 13). A device
added after a message was sent cannot read it, which is expected.

**With MLS,** a device reads only the epochs it holds secrets for. A device that joins, or rejoins
after eviction, reads nothing from before its Welcome. Marmot states the same limit in its
`protocol-core/retained-history.md`: its decryption window "is not a complete
offline-message-history guarantee", and applications that need long-term history "need a
separate protocol mechanism".

Three options, in order of preference:

1. **Accept the gap and say so** in the first version. It is the honest default, and no secret
   leaves the device that holds it.
2. **A history bundle from the member that re-adds the device,** as Matrix's MSC4268 does for
   megolm keys (merged April 2026): the inviter encrypts the keys for past messages and sends a
   pointer only to the invitee's verified devices. MSC4268's own security section names the cost.
   A bundle is far more sensitive than one message. The recipient takes the sender's word for who
   wrote each old message, so clients should label it ("Alice shared this message"). A recipient
   accepts a bundle only together with the invite from the same person.
3. **Keep history in today's scheme** (per-device boxes) and use MLS only for live messages. It
   doubles the sending cost and keeps two schemes in one room, so it is the last choice.

**Releasing old secrets.** Marmot ties each retained secret to a function and a release condition,
and forbids keeping material "merely because an implementation stores a whole-state snapshot". wim
should do the same. agent-connect's SR-61 is the example of getting it wrong: after its removal, a
member's store still held the last epoch's private keys, until the fix (its #72) deleted every
row of the group.

## Library

wim ships as one JavaScript file with no dependencies (`wim.mjs`), so the MLS library must bundle
into it.

- **ts-mls** is pure TypeScript and bundles. It has one maintainer and no professional audit. Its
  advisory GHSA-gwp3-968w-m7gv (high, published 2026-08-28, fixed in 1.6.4) is the exact property
  MLS exists to give: "Commit with a single Remove omits the UpdatePath, letting a removed member
  decrypt subsequent epochs".
- **OpenMLS** (Rust, used by agent-connect at 0.9.1) and **mls-rs** (Rust, used by SLIM) do not
  bundle into one JavaScript file.

So ts-mls would sit behind an adapter, with an interoperability test in CI against OpenMLS. That
test must include the case the advisory names: remove a member with a single Remove, then check
that the removed member cannot read the next epoch in either implementation. A security-marketed
tool resting on an unaudited library that had that bug is a reason in itself to wait.

## Wire and compatibility

- Box scheme numbers from 3 up are reserved (SPEC section 6). An MLS room needs new relay frames
  (commits, KeyPackages, Welcomes, the epoch conflict answer), so it is `wim/2` under the wire rule
  in CONTRIBUTING.md. Relay storage changes stay additive.
- It would be opt-in per room. A room without it keeps today's scheme, and a device that does not
  support it keeps reading every other room.
- SPEC section 13 and SECURITY-MODEL section 9 ("Rooms do not restrict who in the mesh can read a
  room message") change only for MLS rooms.

## When to build it

All of these, not any one:

- someone asks for rooms whose membership is a confidentiality boundary;
- the signer is reliable enough to be required for those rooms;
- ts-mls has an outside audit, or the OpenMLS interoperability test above is in CI first;
- this design has been reviewed against RFC 9420 by someone other than its author.

## Sources

Read on 2026-10-31. Each was used as described above; nothing from them was run.

- **agent-connect** ([mbocevski/agent-connect](https://github.com/mbocevski/agent-connect) at
  `b4106db`): `docs/security-review-v0.md` (SR-01, SR-61, "MLS usage", "Group mode"), `SPEC.md`
  sections 8.3 and 9.4, `docs/groups.md` ("Replicas"), `docs/adr/004-processing-journal.md`.
- **AGNTCY SLIM** ([agntcy/slim](https://github.com/agntcy/slim) at `ac27c98`):
  `crates/mls/src/mls.rs` (`persist_if_enabled`, `encrypt_message`, `rejoin_member`, the default suite) and
  `crates/session/src/mls_state.rs` (ordered processing of numbered commits from a moderator).
- **Marmot** ([marmot-protocol/marmot](https://github.com/marmot-protocol/marmot) at `fa07461`):
  `protocol-core/convergence.md`, `protocol-core/retained-history.md`, and `ideas/multi-device.md`
  (an idea document, not yet part of its spec).
- **Matrix MSC4268**, [Sharing room keys for past messages](https://github.com/matrix-org/matrix-spec-proposals/pull/4268)
  (merged 2026-04-08): the bundle format, the receiving client's rules and the security
  considerations.
- **RFC 9420** section 16.6 and **RFC 9750** section 8.2.2 (eviction of idle members).
- **ts-mls** advisory [GHSA-gwp3-968w-m7gv](https://github.com/LukaJCB/ts-mls/security/advisories/GHSA-gwp3-968w-m7gv).
