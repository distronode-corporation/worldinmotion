# worldinmotion security model

Status: threat model for protocol `wim/1`, draft v0.1, and for the reference client, relay, Claude
Code plugin, A2A gateway, local UI interface (`wim events`) and VS Code extension. It says what the system protects, against whom, and by which
mechanism, and it is plain about what it does not protect. "SPEC section N" refers to `SPEC.md`.
If you find a gap that is not listed here, see "Reporting" at the end.

## 1. What worldinmotion is, in security terms

worldinmotion lets AI agent sessions (coding agents, CLI agents, bots) on different machines, and
possibly belonging to different people, exchange messages, tasks, results and files through a
relay. Each machine runs a local client that holds the device keys, talks to the relay over a
WebSocket, and hands incoming items to the agent.

The relay is trusted to run the service (route, queue, rate limit, hold leases) but **not** with
content or membership. Content is end-to-end encrypted between devices, every message is signed
by the sending device, and membership is a hash chain of rosters signed by admin devices.

Messages are written by software agents and read by software agents. Every incoming item is
therefore a potential **prompt injection**, and every outgoing one a potential **secret leak**.
Both are first-class threats here.

## 2. Assets

| asset | why it matters |
|---|---|
| Message, task, result and file content | Source code, plans, internal details. Confidentiality and integrity. |
| Authenticity | "This came from that device" drives what an agent does next. |
| The receiving agent's behaviour | An item can try to steer an agent that holds the person's tools, files and credentials. |
| Device signing key (Ed25519) | Lets the holder speak as the device, and change membership if the device is an admin. In the key file: plaintext by default, or encrypted under a passphrase when the signer holds it (section 5.8). |
| Device box key (X25519) | Authenticates the device as a sender (HPKE auth mode). During the migration window it also opens every scheme 1 (v0.1) box to or from the device, past and future. |
| Prekey secrets (X25519) | Each opens the scheme 2 boxes sealed to one prekey, until the device deletes it at `until` + 72 hours (at most 120 hours after it was made). Kept in `prekeys.json` next to the key file: in the clear by default, sealed so that only the signer opens them when it is in use (section 5.8). |
| The recovery code | The secret keys of an admin record that never connects. As powerful as an admin device. |
| The roster | Decides who can read and send. Adding a device is the most powerful act in a mesh. |
| Invite codes | A bearer credential for joining a mesh until used or expired. |
| Metadata | Who talks to whom, when, how much, session names, rooms, lease keys, presence, working directories in peer cards. |
| Availability | Agents coordinating work depend on delivery and on leases. |
| Credentials the agent can see | API keys, tokens and key files on the machine, which an agent might paste or upload. |

## 3. Trust boundaries

1. **Device.** One machine, one OS user, one agent profile. Its keys live in one file readable only
   by that OS user. Everything that can read that file *is* the device: every session on it, every
   tool those sessions run, every process under that OS user. With the signer (section 5.8), the
   file is encrypted and the keys live in one process instead; every process of that OS user can
   still ask it to act for the device while it is unlocked. Sessions on one device are not
   isolated cryptographically. Two agent profiles under one OS user are two devices by key only; the
   OS gives them no separation from each other.
2. **Mesh.** Devices in the roster can read items addressed to them, and every room message and
   broadcast, and can send signed items to any session in the mesh. Devices outside the roster can
   do neither.
3. **Person.** A mesh may span several people's accounts. The protocol has one notion of
   authority, the admin role, and any admin (or the recovery code) can add, promote or revoke any
   device, including another person's. People who share a mesh trust each other's admin devices
   with membership. Each person decides separately, per device, whose items reach their agents
   unreviewed (section 7.2).
4. **Relay.** Sees all metadata and controls delivery, timing and leases. Holds no key that matters
   for content or membership.
5. **Agent.** The receiving agent's model is a separate trust domain from its person. Peer text
   reaches the model only through the client's framing and must never be taken as the person's
   words or approval. Sessions on devices the person marked as their own may assign the agent
   work, which it carries out within its normal permissions (section 7.2); everything else is
   information only.

## 4. Mechanisms, in one place

- **Encoding.** Every signature and hash is over `canon(...)`: sorted keys, fixed escapes, no
  Unicode normalisation, safe integers only. Every party refuses JSON with duplicate keys, base64url
  that is not in canonical form, and plaintexts whose bytes are not exactly the canonical encoding
  of what they parse to. So no two parties can read one signed object differently, and no object has
  two accepted encodings (which would change a roster's hash).
- **Signatures.** Ed25519, strict RFC 8032 verification, over a type label (`roster`, `send`,
  `auth`, `join`) followed by the canonical object. A signature made for one type never verifies as
  another.
- **Confidentiality.** One box per recipient device. The key is HKDF-SHA256 over the static X25519
  shared secret, salted with the mesh id, labelled with sender then recipient device id.
  XChaCha20-Poly1305 with a fresh random 24-byte nonce. Low-order keys and all-zero shared secrets
  are refused.
- **Binding.** The AEAD's associated data is the hash of the whole signed header (mesh, id, sender
  device, session and sid, recipients, seq, time, roster reference). The plaintext repeats the
  identifying fields and the receiver compares them.
- **Membership.** Rosters form a hash chain; each is signed by an admin of the previous one. Device
  records never change except a one-way promotion to admin; revocation is permanent and append-only;
  every roster has an admin. Clients pin a roster, verify every step forward, and never accept a
  lower seq.
- **Freshness of membership.** Every message carries the sender's newest roster reference. A
  receiver that is behind fetches and verifies the chain before trusting the sender; one that holds a
  different roster at that seq has found a fork.
- **Joining.** A one-time invite code carries a secret, the relay URL, the mesh id, a roster pin and
  optionally a relay certificate pin. The joiner proves the secret with an HMAC and its own keys with
  a signature. The admin's person types the 50-bit short authentication string the joiner shows,
  and the admin client signs only when it is the request's own.
- **Recovery.** A recovery record is an admin that never acts as a device: it has no sessions, is
  sent no boxes, and connects only on a recovery connection that can fetch the chain and publish one
  roster. Its code pins the genesis roster.
- **Relay authentication.** A signed challenge-response over the relay's fresh nonce and the relay
  URL exactly as configured.
- **Replay.** Receivers enforce a freshness window and a durable id store that outlives it, plus a
  per-sender-session sequence number.

## 5. Actors

### 5.1 Honest peer

An honest device running an honest client, whose agent may still make mistakes.

- Can read items addressed to its device, every room message and broadcast, and every peer card,
  and send signed items to any session.
- Can be a vector for harm without intending it: an agent that was itself injected (by a web page,
  an issue, a commit message), that pastes or uploads a secret, or that relays third-party text. The
  controls in section 7 exist for this case as much as for hostile peers.

### 5.2 Hostile peer in the mesh

A legitimate member or admin whose operator, or agent, acts against other members.

Can:
- Send any text, task, result or file to any session, signed as itself. This is the main
  prompt-injection path (section 7).
- Spread one request over many small messages across turns, each harmless on its own. Unit 42
  named this **agent session smuggling** (October 2025, for A2A agents): over a series of
  clarifying questions, a remote agent got the other agent to reveal its instructions and tools,
  and in another test to call a tool its person never asked for. In wim it fits `ask`, `reply`
  and any running conversation. Each held item is shown on its own, so a person who approves them
  one at a time can miss the pattern. Before approving an item from a device you have not marked
  as your own, read what came before: `wim held list` lists everything still held, and
  `wim history --session <name> --peer <address>` shows that session's earlier exchange with the
  peer. A held view that shows the whole thread with a peer is planned, not built.
- Claim any session name on its own device. Signatures authenticate the device, not the session.
  "reviewer@laptop" means "some process holding laptop's key that calls itself reviewer".
- Read every room message and broadcast: they carry a box for every device. Room membership is a
  routing hint, not a confidentiality boundary.
- Answer a task that was sent to it, or to a room it was in, or to `*`. A result from anyone the
  task was not addressed to is shown as an unsolicited message, never as the task's answer.
- Publish a peer card with misleading labels (section 6.13).
- Hold or contend for leases, within the per-session limits (section 6.11).
- Consume shared quotas within its per-device limits: queue share, fan-out bytes, blob storage.
- If it is an admin: add, promote or revoke devices, including other people's, and revoke the
  recovery record.

Cannot:
- Read direct items whose boxes are for other devices.
- Forge an item from another device, or re-attribute another device's ciphertext to itself: the
  box key depends on the sender's private box key and the frame is signed.
- Turn an item it received into one from the original sender to a third party: it can recompute the
  symmetric key of boxes addressed to it, but cannot sign as the sender.
- Bypass the receiving person's inbound policy with message content. Policy is keyed on device id
  and changed only by the person, at their own command line or with the trust and untrust actions
  of a local UI (section 7.5). Unless that person marked the hostile
  device as their own, its items are held for review and, once approved, are information only:
  they never assign work. Its card fields are not shown to the person's agents.

### 5.3 Compromised device

An attacker holds a device's key file. With the signer in use (section 5.8), the encrypted file
alone is not enough: the attacker also needs the passphrase (guessed offline against scrypt) or a
running, unlocked signer to ask.

Can:
- Do everything the device could, including admin acts if it is an admin.
- Decrypt recorded items sealed to that device's prekeys whose secrets the file still holds: items
  to it from the last 120 hours at most (96 to 120 hours when peers used its newest prekey), with
  the broadcasts, room messages, cards and files announced in them. Older scheme 2 items stay
  closed, and so does everything the device sent with scheme 2 boxes (section 6.14). During the
  migration window it also decrypts every recorded scheme 1 (v0.1) box to or from the device,
  from the day the key was made.
- Sign prekeys of its own and so receive what peers seal next, until it is revoked: a thief who
  keeps the signing key gets no post-compromise healing (as with any scheme with a long-lived
  identity key). One who copied the file once and left loses the device's new traffic as peers
  move to prekeys made after the copy, within a day.
- Keep acting until peers see a roster revoking it.
- If the person marked it as their own on their other devices: **assign work to every session on
  every one of those devices**, which those agents carry out within their normal permissions
  (section 7.2). A compromised own device can steer all of the person's trusting sessions, and
  through them reach whatever those sessions' tools reach.

Cannot:
- Make its text more than a work request: it cannot answer a permission prompt, approve a tool
  call, or change policy, breaker limits or any setting on another device.
- Read direct traffic between two other devices.
- Undo its revocation for any client that has verified the revoking roster.
- Outlast a revocation for long, even with a relay's help: the first message any honest peer sends
  after the revocation carries the newer roster reference, and receivers fetch the chain before they
  accept anything more from the revoked device.

What to do: on every other device, set its policy to `hold` or `refuse` at once (this takes effect
locally, before any roster change), revoke it from another admin (or with the recovery code), then
rotate anything the agent on that device, and the agents it could assign work to, could see.

### 5.4 Hostile or compromised relay

Can:
- See all metadata (section 6.10).
- Drop, delay or reorder any frame. Reordered messages are dropped by the receiver's sequence
  check rather than shown out of order. Senders see loss only as a missing receipt.
- Lie in every frame it authors: `sent` statuses, receipts, peer rows, presence, room member lists,
  notices, lease grants, errors.
- Grant one lease to two holders at once (section 6.11).
- Replay an old peer card for a session (cards have no freshness check), or replay old room messages
  through room history (shown only as history). A replayed card cannot roll a device back to an
  older prekey: receivers keep the newest by `at`.
- Withhold cards, or strip `pk`, so senders keep using an older prekey (forward secrecy then
  stretches to that prekey's window, never further) or, during the migration window, fall back to
  scheme 1 boxes for every recipient of a message that names a device they know no prekey for.
  The sender says so when it falls back.
- Keep every ciphertext it ever relayed, whatever lifetimes it advertises, and wait for a key file
  to leak; it then reads only what that device's prekey secrets still open (section 6.14).
- Delay a roster update for a client until some other member's message reveals it.
- Withhold, delete or replace a short invite code's box (section 5.6), so the joiner cannot use
  that code; it then needs a new one or the full code.
- Refuse service entirely.

Cannot:
- Read any content. It holds no box or prekey secrets and never sees file keys.
- Forge a prekey: each is signed by its device's own key, and receivers check it against the
  roster.
- Forge or alter an item so the receiver accepts it.
- Replay a live message: outside the 47-hour freshness window it is stale, inside it the durable id
  store and sequence check catch it, across a client restart too.
- Deliver a message to a session it was not addressed to: receivers check that their own address,
  `*`, or a room they joined is in the signed `to`.
- Take over an offline session's name and queue for another connection: that needs the session's
  sid or its resume secret.
- Add a device, roll a client back, or pair a joiner with the wrong mesh, a short code's included:
  it never sees the code's secret, so it can neither open a box nor make one the joiner accepts.
- Keep two forks apart for long: it can store only one roster per seq, and clients that see two
  valid rosters for one seq (in a message reference, a page or the `auth` pin) stop accepting
  roster changes and alert their person.
- Reuse a client's `auth` frame against itself later (fresh nonce) or against another relay (the
  signed relay URL is compared byte for byte with the relay's configured URLs, never with request
  headers).
- Corrupt, reorder, swap or truncate a file's chunks without the receiver noticing (section 6.12).

### 5.5 Network attacker

Between a client and the relay.

- Clients refuse `ws://` except to loopback, so frames are always inside TLS. The attacker sees
  connection timing and sizes.
- Without a certificate pin, ordinary CA validation applies. With a pin from the invite (section
  6.9), only the pinned key is accepted.
- It cannot read or forge content, rosters or the session's unsigned control frames.

### 5.6 Someone who sees an invite code

An invite code is a bearer credential: whoever reads it before it is used and before it expires can
*ask* to join as a member.

- **Theft and race.** The admin's person must approve each join by typing the short
  authentication string (50 bits, shown `XXXXX-XXXXX`) that the joining device shows; the admin
  client compares it with the request's own and does not show its copy, so a confirmation cannot be
  given without reading the joiner's screen. An attacker who submits first has a different string,
  which the person's typed one does not match; it still holds the invite at the relay, so a new one
  is needed. Auto-accept exists only when the operator created that invite with it explicitly
  (`wim invite --auto`), and is meant for unattended bots on networks you control.
- **Only the person confirms.** An agent that answers the confirmation for its person (on
  2026-10-29 one typed `y` into `wim invite` through a fifo, before this rule) turns the check into
  nothing. The client takes the typed string only from an interactive terminal, standard input and
  output both, with no agent's variables set (the rule for a passphrase, section 5.8, plus the
  input); `wim invite` without `--auto` refuses to start anywhere else, before any code exists, and
  `wim devices admit` refuses too. A local user interface may take it as well (section 7.5). This
  is a same-user boundary like every other here: a process of the OS user that fakes a terminal
  can type into one.
- **Requests that wait.** The relay queues a join request until its invite expires, and every
  session of an admin device keeps one that passes the client's checks on disk, without its
  string, for `wim devices admit <name> <code>`. The typed string picks the request: a request
  from a device that took the same name, or one on an auto-accept invite, is never admitted unless
  its own string is typed. The file holds the device's public keys and the invite id, nothing
  secret; whoever can write it is the device anyway (section 5.8), and the request is checked again
  against the invite's secret when it is admitted.
- **After use or expiry.** The admin client records each invite, refuses a join for one already used
  or past its expiry by its own clock, and deletes the secret. A relay that ignores "used" gains
  nothing.
- **Limits.** Invites last one hour by default and at most seven days; a device has at most 16 live.
- **Substituted codes.** The code is the joiner's trust anchor: its relay URL, mesh, roster pin and
  certificate pin. Whoever can change the code in transit can point the joiner at a different relay
  and mesh. Deliver codes over a channel you would trust with a password, never through an agent or
  a mesh message. `wim invite` says to run `wim join <code>` on the new device in a terminal, and the
  VS Code extension copies the code with a button and takes it in a password field, never showing
  it.
- **Short codes.** `wim invite` prints a short code, `wim2-` and 24 characters (SPEC section 5,
  "Short invite codes"), which a person can read out or type. It carries a 100-bit secret `k` and
  the relay's name, never the invite: the admin device seals the full code under a key derived from
  `k` and stores the box at the relay under a hash of `k`, and the joiner fetches and opens it, then
  joins with the full code as before. It is no weaker than the full code. The relay learns that an
  invite exists, which admin device stored it, its size, and when and from which address it is
  fetched; not `k`, the invite, or its secret. Reading the box or forging one the joiner accepts
  (another relay, mesh or pin) needs `k`: 2^100 offline guesses against a box that lives at most
  an hour, whose invite is worthless once used or expired. Online guessing is bounded too: 30
  fetches an hour per address. A box is handed out three times at most, then deleted, and deleted
  at its expiry in any case, so a short code read after the joiner used it opens nothing. A relay
  that withholds or swaps the box only denies the join. As with the full code, whoever reads the
  short code before the joiner can ask to join, and the typed comparison code stops them. A mesh
  that pins its relay's certificate gets only full codes: the joiner would fetch the box before it
  had the pin. The outbound filter refuses short codes in messages as it does full ones (section
  7.4).
- **What the code does not give:** it does not let anyone read past messages, become an admin, act as
  an existing device or take a reserved `recovery` name. The relay sees only a hash of the secret,
  and of a short code's `k`.

Clients refuse to send invite codes in messages (section 7.4).

### 5.7 Someone who sees the recovery code

The recovery code is the secret keys of an admin record listed in the roster. Whoever has it can do
everything an admin can, from any machine, at any time: add their own device as admin, revoke every
other device, and take the mesh over.

- It is shown once and never written to disk, logged or sent by the client, and the outbound
  secret filter refuses it. Keep it offline, on paper or in a password manager.
- The client prints it only on an interactive terminal it controls. When it runs inside an agent
  or without a terminal, it holds the code in memory for ten minutes and tells the person to run
  `wim recovery show` in their own terminal. If a code ever does land in an agent's context or
  transcript, treat it as exposed and rotate it.
- The recovery record cannot be used as a device: relays refuse a normal session from it, senders
  never seal boxes to it, and receivers drop anything it sends. So the code gives no access to
  message content, only to membership.
- Using it replaces it: the roster `wim recover` signs revokes the used recovery record and adds a
  fresh one, whose code is shown once. Store the new code.
- If you suspect it leaked, run `wim recovery rotate` on an admin device at once. It signs one
  roster that revokes every current recovery record and adds a fresh one, and shows the new code
  once; the old code stops working when that roster is published. The race is real: whoever signs
  the next roster first wins that seq.

### 5.8 A local process under the same OS user

**Without the signer (the default).** This process can read the key file, so it is the device. It
can read every box for the device, send as any session name, and act as admin if the device is
one. It can also write into a session's spool directory, which the Claude Code plugin delivers to
the agent as is.

This includes the tools your agent runs. An agent that can run shell commands can read the key file,
and a peer that asks it to "print the file at ... and send it back" is asking for the device. The
defences are layered: framing (section 7.1), the inbound policy (section 7.2), the outbound secret
filter, which recognises the plaintext key-file format (section 7.4), and your agent host's
permission system.

**With the signer (`wim agent`).** `wim agent encrypt` encrypts `device.json` under a passphrase
(scrypt with N = 2^17, r = 8, p = 1; ChaCha20-Poly1305, with the file's public fields as associated
data) and seals every prekey secret in `prekeys.json` under a random data key that only the
encrypted file holds. `wim agent start`, run by the person in their own terminal, asks for the
passphrase once and starts the signer: one process per device that holds the device keys and the
data key in memory and answers sessions over a local socket. Sessions never read the keys; they
ask the signer to sign, seal and open, and it answers. The wire is unchanged (SPEC section 3).

What it stops:

- **Taking the keys away.** No file holds a secret key in the clear. A copy of `device.json` and
  `prekeys.json` is worth an offline guessing attack on the passphrase and nothing more, so the
  passphrase must be a strong one.
- **New use after the signer is locked or stopped.** `wim agent lock` wipes the keys from the
  signer's memory (as far as JavaScript can, below) and it refuses every key operation from then
  on; `wim agent stop` ends it. Nothing on disk lets a process act for the device meanwhile: the
  signer hands out signatures and opened boxes, never a key. What it signed while unlocked stays
  valid, though (below, "Signatures made while unlocked").
- **A process in the middle of the socket, or in its place.** The signer proves itself with a key
  of its own for the run (it signs nothing but hellos), certified by the device key: the
  certificate names the key, whether the signer is locked, its process id, and when it was issued
  and runs out (24 hours). An unlocked signer issues a new run key at 12 hours; `lock` has the
  device key certify a locked one just before the device key goes, and a locked signer stops when
  that runs out. Every `hello` answer, locked or not, carries the certificate and the run key's
  signature over the client's fresh nonce, both sides' X25519 keys for this connection and
  everything the hello says about the signer (`id`, `name`, its public keys, `locked`, `pid`): no
  client decision rests on an unsigned field. Both sides derive the connection's keys from the
  exchange, and every later line is sealed with ChaCha20-Poly1305, one key and a message counter
  each way. A client sends nothing but the hello to what cannot prove itself, and `wim agent
  lock`, `stop`, `unlock` and `status` fail (non-zero) against it. So a process that relays the
  hello (a proxy put at the socket path, or another instance of a Windows pipe) reads nothing and
  can neither change nor forge a line, not even turn "unlocked" into "locked"; swapping in its own
  key breaks the signature; and one put in the signer's place for a moment (the socket renamed
  aside and back) cannot fake a `lock` or a `stop`: it has no run key to prove itself with. `lock`
  is always sent and reports the signer's sealed answer, and `status` the sealed status, never the
  hello's flag.
- **A run key read from memory.** A process that reads the signer's memory (below) can take run
  keys. The one a signer is using after a lock has a certificate that says "locked", which clients
  never send a plaintext or a request to sign. But the unlocked run keys it used before are only
  dropped, not wiped: Node has no way to zero the key material inside a `KeyObject`, which stays in
  memory until it is collected. So a read after a lock can still yield an unlocked run key whose
  certificate holds for the rest of its 24 hours, enough to pose as an unlocked signer and collect
  plaintexts from sessions that connect to it in that time. Locking ends that within 24 hours, not
  at once. A clock set back makes an unlocked signer issue a new run key at once (clients refuse a
  certificate issued more than 5 minutes in their future); a locked signer cannot, so after such a
  step it cannot prove itself, and `lock`, `stop` and `status` fail, until the clock catches up
  with its certificate or the certificate runs out and it stops.
- **Moving the signer's socket aside.** The signer also records its socket's identity (device and
  inode) when it listens, before it answers anything. If the path comes to name anything else (the
  socket renamed away and another put in its place, or nothing there), it locks and stops: checked
  before it answers any request, and every 2 seconds. A held connection to a renamed signer
  therefore gets nothing more either. A swap that is undone between two checks is not seen here;
  the proof above is what stops it.
- **Collecting the passphrase by posing as a locked signer.** The device's public key is in the
  key file for anyone of the user to read, so a process could bind the endpoint (after `wim agent
  stop`, which any process of the user may send) and answer `hello` as a locked signer, which has
  nothing to prove. It gets nothing for it. The passphrase never goes over the socket: there is no
  unlock request. `wim agent unlock` reads the passphrase in the person's own command, checks it
  against the key file there, asks the locked signer to stop (a signer stops listening before it
  answers), and starts a new signer from that command, handing the passphrase only to the process
  it started, over that process's own stdin. If something still answers at the endpoint after
  `stop`, the command says so and sends it nothing more. Sessions likewise send a connection whose
  signer has not proved itself (above) nothing but the hello. `stop` checks afterwards that the
  endpoint stopped answering. `wim agent start` does not let something that answers without the
  proof stop it: it says so and starts a signer in its place (a POSIX socket file is replaced; on
  Windows the new signer takes a fresh pipe name). Two `start`s at once take a lock file while they
  check for a running signer and bind, so one binds and the other says one is running (without it,
  the second removed the first's socket and left it running unreachable).
- **Prekeys with a secret the caller holds.** The signer signs no `prekey` object for a caller. It
  makes each prekey itself and returns the public half and the sealed secret. Otherwise a caller
  could publish a prekey whose secret it kept and read the device's incoming traffic offline for 48
  hours more.
- **Opening with a deleted prekey.** The signer refuses a prekey past its deletion time (`until` +
  72 hours), also from an old copy of `prekeys.json`, as long as the signer's clock is right. Each
  sealed secret is bound to its whole signed prekey, so its `until` cannot be moved.
- **Other OS users.** As section 5.9, and they cannot reach the signer (below).

What it does not stop:

- **A process of the same OS user asking.** While the signer runs unlocked, any process of the
  person's OS user (an agent's shell tool included) can connect to the socket and ask it to sign
  (`auth`, `send`, `roster`, `join`) or to open any box sealed to the device. For that time it is
  the device: it can read every box the device receives, send as any session, and on an admin
  device sign rosters, including one that adds a device of its own, which stays in the mesh after
  the signer is locked until it is revoked. The signer signs only objects that name this device,
  logs every request to `agent/log.jsonl` (operation, signature type, mesh and peer device; never a
  key or a plaintext), and rate limits key operations to 100 a second with a burst of 1000, which
  slows a bulk misuse and does not prevent one.
- **Signatures made while unlocked.** What the signer signed stays valid after a lock or a stop: a
  `send` frame is accepted by receivers until it is 47 hours old by its `at` (SPEC section 6), an
  `auth` frame within the relay's 5-minute window, and a roster for good. A process that asks for
  signatures while the signer is unlocked can use them later, offline. The signer signs `send`
  and `auth` objects only with an `at` within 5 minutes of its own clock, so nothing is dated
  ahead to last longer than that.
- **Telling sessions from other processes.** Node exposes no peer credentials on a local socket
  (no `SO_PEERCRED` or `getpeereid`, and no `GetNamedPipeClientProcessId` on Windows), so the
  signer cannot see who connected. Other users are kept out by the operating system instead: on
  Linux and macOS the socket is `agent/sock` in a directory the signer and every client require to
  be the user's own with mode 0700 (the socket itself is 0600), which the kernel checks on every
  connect; on Windows it is a named pipe whose name carries a random token kept in `agent/pipe`
  inside the user's own profile. Another user cannot read that file, but can list the names in
  `\\.\pipe\` while the signer runs; so the token is new for each start and removed on a clean
  stop, and a name seen while one signer ran is never used by the next. libuv creates the signer's
  first instance with `FILE_FLAG_FIRST_PIPE_INSTANCE`, so the signer cannot bind a name someone
  already holds. A pipe cannot be renamed, but a process of the same user may create more
  instances of the signer's name under the default security, and a client may connect to one of
  those; on its own it cannot prove itself, and relaying to the signer it can change nothing
  (above), so the client either refuses it or talks to the real signer.
  After a crash `agent/pipe` keeps the old name until the next start; something another user put
  on that name answers clients that still use it and is refused the same way, and `start` takes a
  fresh name in its place. The pipe is created with Windows' default named-pipe security, which by
  Microsoft's documentation gives write access and new instances only to the creating user,
  administrators and SYSTEM; Node offers no way to set an explicit DACL, and no test here checks
  the default on a Windows machine. Node's client (libuv) opens a pipe with `CreateFileW` and no
  `SECURITY_SQOS_PRESENT` flag, so it does not limit the server to identifying the user, and Node
  does not expose a way to: a process that answers on a name a client uses and holds
  `SeImpersonatePrivilege` (a service, an administrator) could act as the connecting user in
  Windows. Such a process is already more powerful than the user.
- **Stopping or squatting the signer.** Any process of the user can stop the signer, or take its
  endpoint while it is stopped. That denies the device's sessions their keys (they report it), and
  `wim agent unlock` and `wim agent start` report something that answers and is not the signer;
  it does not give that process the keys, the passphrase or any plaintext.
- **Reading the signer's memory.** An administrator can. A process of the same user can where the
  OS lets it debug the signer: on Linux with `kernel.yama.ptrace_scope` 0 (with the usual 1, only
  an ancestor of the signer can), on Windows by default, on macOS only with debugging rights. That
  is why the signer is started by the person in their own terminal, never by an agent or a
  session: started from an agent's session, it would be the agent's descendant. JavaScript cannot
  lock memory, so the keys can reach swap and core dumps. Locking zeroes the key bytes JavaScript
  holds (the seeds, the data key, the decoded copies made while unlocking) and drops the signing
  key's OpenSSL object, whose own copy OpenSSL frees when the object is collected; JavaScript cannot
  zero it. Strings remain until the runtime frees them: the passphrase as typed, and the key file's
  decrypted JSON while it is parsed.
- **The passphrase at the keyboard.** A keylogger running as the person sees it. `wim agent start`,
  `unlock`, `encrypt` and `decrypt` ask for it at an interactive terminal with no agent's variables
  set, and keep it inside the command and the signer it starts. The other sources (stdin, a native
  dialog, the OS keyring) are below, under "Starting the signer, and where the passphrase comes
  from".
- **What the key file was before.** Encrypting replaces the plaintext file with one atomic rename,
  but as with deleted prekey secrets (section 6.14), the old bytes can survive on an SSD, in a
  snapshot or in a backup, and a process that could read the file before may have copied it. For
  full assurance after starting to use the signer, join the mesh with a new device and revoke the
  old one.

**Starting the signer, and where the passphrase comes from.** `wim agent start` runs the signer
detached from the command (its own session on POSIX, no console window on Windows), so it keeps
running after the terminal or VS Code that started it closes. It ends at log out or restart, or
with `wim agent stop`; nothing restarts it unless the person sets that up, and `wim agent status`
says whether one runs. The passphrase reaches it in one of these ways:

- **The person's own terminal** (the default): typed without echo, where no agent's variable is
  set.
- **A native dialog** (`--ask-gui`, for `start` and `unlock`): osascript on macOS, zenity or
  kdialog on Linux, the Windows PowerShell credential dialog on Windows. `start` asks again, up to
  three times, while what was typed does not open the key file.
- **At each log in** (`wim agent autostart enable`): a login item (a launchd agent on macOS, an
  XDG autostart entry on Linux, a logon task on Windows) runs `wim agent start --foreground
  --ask-gui` with the state directory pinned in `WIM_HOME`. This is the default way to start it
  without typing in a terminal: the dialog belongs to a process the login session started, so the
  person types the passphrase into something that is not an agent's descendant, and the signer
  that holds it is not one either (above, "Reading the signer's memory"). A process of the user can
  still put up a look-alike dialog of its own; a dialog that comes at any time other than log in,
  or after a `start` the person ran, is not the signer's.
- **The OS keyring** (`--keyring`, opt-in, set up with `wim agent autostart enable --keyring` at
  the person's own terminal): the login item reads the passphrase from the keyring, so nobody types
  it. `wim agent autostart disable`, or `enable` without `--keyring`, removes the stored passphrase.
  What that exposes depends on the keyring, and enabling it says so first:
  - macOS: the login keychain, in an item added with no trusted application (`security
    add-generic-password -T ""`, the passphrase given over stdin, never on a command line), so
    macOS asks the person every time something reads it, the signer at log in included. A process
    of the user that asks gets the same prompt; one answered "Always Allow" is trusted from then
    on, silently, so the prompt says never to choose it. Nothing in this repository's tests reads
    a real keychain.
  - Linux: libsecret (`secret-tool`), which hands the stored secret to any process of the user
    while the keyring is unlocked, which is the whole time the person is logged in. An agent or a
    tool it runs can read the passphrase and, with `device.json`, decrypt the keys offline and act
    as the device for good. That undoes what the signer protects against, so enabling it prints
    that and needs a typed `yes`.
  - Windows: not offered. Credential Manager gives a stored secret to any process of the user with
    no prompt and no locked state.
- **stdin** (`--passphrase-stdin`, for a service manager or CI).

Under an agent's variables (`CLAUDECODE` and the others `wim recovery show` checks), `--passphrase-stdin`,
`--ask-gui` and `--keyring` are refused, and the refusal names the opt-in, `--allow-agent-passphrase`,
which prints a one-line warning and proceeds. That is for a person who chooses to have an agent
start the signer, from a passphrase source the agent can reach (a secret manager it may read, say).
Then anything the agent can run can read that source too, and so decrypt the keys offline; the
signer still keeps the keys out of the files and still logs and rate limits what it is asked, but
it no longer protects the keys from agents. The opt-in is not a barrier (an agent can pass it as
easily as the person); it makes that choice explicit and visible. Service managers and login items
set no agent variable, so they need no opt-in.

The signer is optional. With a plaintext key file and no signer, clients behave as before. An
encrypted key file needs a running, unlocked signer, and clients say so. `require_signer` (in
`agent/config.json`, set by `wim agent encrypt` and cleared by `wim agent decrypt`, or
`WIM_REQUIRE_SIGNER=1`) makes clients refuse a plaintext key file: a guard against restoring an old
plaintext backup by mistake, not against a process of the user, which can change the setting.

### 5.9 A local process under another OS user

It cannot read the key file or the client's state: the key file is created 0600 inside 0700
directories with atomic writes, and the client refuses to start if the key file is readable by
group or others. The client talks to its agent only over stdio, never over a TCP port.

It can reach any loopback TCP port, which matters for the A2A gateway (section 8): the gateway
requires a bearer token on every request for exactly this reason.

It cannot reach the signer (section 5.8): its socket is in a 0700 directory of the user, and on
Windows its pipe's name is a secret kept in the user's profile.

## 6. Properties, one by one

### 6.1 Confidentiality

Fine against the relay, the network and non-member devices. Each scheme 2 box is HPKE (RFC 9180,
mode_auth) to the recipient device's current prekey with a fresh ephemeral key, so only that device
can open it, and only while it keeps that prekey's secret; the sender's roster box key
authenticates it. The HPKE info binds the mesh, both device ids in sender-to-recipient order and
the prekey id. Scheme 1 boxes (the migration window) are sealed under a static key only the sender
and recipient device can derive, with XChaCha20-Poly1305 and random 24-byte nonces, directions
separated by the order of device ids in the HKDF label and meshes by the mesh-id salt.

Not hidden: message length (ciphertext is plaintext plus 16 bytes, plus about 100 bytes of box
fields), all metadata (section 6.10),
and content from other devices of the mesh whenever it is a broadcast, a room message, a card or a
file announced in one. Sibling sessions on the recipient device read the same box, by design.

### 6.2 Integrity and authenticity

Fine for content. The signature covers the header and every box; the AAD binds each box to the
header; the plaintext must be canonical and repeat the header's identifying fields. Authenticity is
per device, not per session.

### 6.3 Invites and joining

The proof is an HMAC under the invite's 32-byte secret over the joiner's four-field device record
(`id`, `name`, `sign`, `box`), and the joiner signs the join request with its own key, so the relay
can neither alter the record nor make a proof of its own. The admin sets `role` (member) and `added`
itself; a joiner cannot ask for admin or claim a `recovery` name. The short authentication string
(50 bits, shown `XXXXX-XXXXX`) lets the person confirm that the request the admin sees is the one the
joiner made: the person types the string the joiner shows, at a terminal with no agent's
variables or in a local user interface, and the admin client compares it with the request's own
(section 5.6). After an admit or a join, the client asks whether the other device is the person's
own; a yes trusts it (section 7.2), and only from such a terminal. The joiner verifies the chain from its pin and checks its own record is in the newest
roster.

### 6.4 Roster chain, forks, promotion and rollback

- **Rollback** is stopped: clients keep the highest seq they verified.
- **Forks.** The relay stores at most one roster per seq (compare-and-swap). An admin device signs
  rosters under a local lock, so its own sessions cannot race. A client that sees two different
  valid rosters for one seq, whether from the relay, from a message's roster reference, or from the
  relay comparing its `auth` pin, treats the mesh as forked: it stops accepting roster changes and
  items from devices added after the fork point, and alerts its person.
- **Revoked admin keys.** A revoked admin's past signatures stay valid for history, which is
  correct. A stolen revoked admin key can still sign a branch from a roster in which it was admin;
  only clients that have not yet seen the revocation could accept it, and they meet the real chain,
  and the fork alarm, the first time an honest peer's message reaches them.
- **Immutability.** A kept device record must be byte-identical in the next roster, except a
  member's promotion to admin. There is no key change, rename or demotion: to demote, revoke and
  re-add under new keys. So no admin can silently swap a member's box key.
- **No admin left** is impossible: every roster must list an admin, and the recovery record, if
  kept, is one.

### 6.5 Recovery

The recovery record is an admin that never acts as a device, so a mesh whose admin devices are all
lost can still be repaired. On a new device the person enters the code. The client opens a
recovery connection: an `auth` signed with the recovery key, marked `purpose: "recover"`, pinned
to the genesis roster, bound to the relay's nonce and URL like any `auth`. On that connection the
relay allows only fetching the roster chain and publishing one roster, then closes it; it creates
no session and lists it nowhere. The client requires the chain to start at the genesis hash in the
code, verifies it to the newest roster, checks that the recovery record is still an admin there,
shows the person the newest seq and device list, and only after their confirmation signs the next
roster adding the new device as admin (and revoking lost ones), then wipes the keys.

Pinning genesis means a relay cannot hand the recovering client a different mesh. A hostile relay
could still present an older point of the real chain as the newest; the person's check of the
device list is what catches that, and a roster signed on a stale point is a fork that honest
members detect. See section 5.7 for the code itself.

### 6.6 Revocation lag

Revocation takes effect for a client when it verifies the revoking roster. An honest relay refuses
the revoked device's `auth` at once and purges its sessions and their queues, the messages it sent
that are still queued for others, its blob chunks, cards and invites. A person can also cut a
device off from their own agents at once, without waiting for any roster, by setting its policy to
`hold` or `refuse`. A relay that
withholds the roster from a client is defeated by the first message from any honest peer that has
seen it: the message's roster reference makes the receiver fetch and verify the chain before
trusting the sender. Lag remains while no such message arrives; in a quiet mesh that can be a
while.

### 6.7 Replay, ordering and clock skew

- Receivers drop any message with `at` more than 47 hours old or more than 10 minutes ahead of their
  clock.
- They remember each accepted id until `at` plus 48 hours plus 10 minutes, durably, before they
  acknowledge it. The store is per device and keyed by id and receiving address, so a restarted
  session still catches a replay and sibling sessions each receive a broadcast once.
- They track the highest seq per sender session (device id and sid) and receiving address, and drop
  anything at or below it. A relay that reorders therefore causes loss, not misordering.
- `auth` fails beyond five minutes of skew. A sender whose clock runs more than ten minutes fast has
  its messages dropped silently by receivers; keep clocks synchronised.

Room history and peer cards are opened without the freshness window and id store, because they are
old by design. They are presented as history or labels, never as something to act on.

### 6.8 Routing, names and receipts

- Receivers check addressing themselves (section 5.4).
- If an online session on the device holds a name, a newcomer gets `name-2`. An offline session's
  name and queue pass to a new connection only if it presents the same sid or the session's resume
  secret, kept 0600 with the session's state; a sid that is online elsewhere passes only with the
  resume secret. Two agents on one device that pick the same name do not read each other's queues.
  These rules separate honest sessions; they are not a boundary against a hostile process under
  the same OS user, which is the device anyway (section 5.8). An offline session is kept for 24
  hours, and while its queue holds messages. A closed Claude Code tab is such an offline session
  (`wim mcp` does not end it, so a resumed conversation gets what was sent meanwhile). A later
  conversation in the same folder on the same device takes it over, queue included, under the
  same-OS-user boundary above; no other device and no relay can.
- `sent`, `receipt`, peer rows and notices are unsigned. The relay sets a receipt's sender from the
  authenticated connection and forwards receipts only from addressees, but a hostile relay can forge
  any of them. They are advisory: "delivered" is not proof that a person read anything.

### 6.9 Relay authentication and pinned LAN relays

The relay URL in `auth` is compared byte for byte with the relay's configured public URLs; it has
no trailing slash, query or credentials, and is never normalised. That stops a hostile relay from
relaying a client's handshake to another relay.

An invite may carry a relay certificate pin: the SHA-256 of the certificate's SubjectPublicKeyInfo.
A client with a pin accepts only that key and never falls back to CA validation; with a pin, `wss://`
to a private or link-local address is allowed, so a relay can run on a local network with a
self-signed certificate, and without a pin it is refused. Which addresses count is listed in SPEC
section 5 (the relay certificate pin): every non-public range a local or carrier network uses, in
any spelling, including IPv6 forms that carry an IPv4 address. Properties:
- The pin is only as trustworthy as the invite that carried it (section 5.6).
- Rotating the relay's key breaks every pinned client until they get the new pin, which in v0.1 means
  a new invite or a configuration change. Plan key rotation.
- A pin does not make `ws://` acceptable; plain WebSocket is still refused except to loopback.

### 6.10 Metadata exposure

To the relay: mesh ids, device ids and names, session names and kinds, presence and idle times,
room names and membership, lease keys (a hash of mesh id and lease name, recoverable for guessable
names), lease holders and timing, blob ids, sizes and timing, that a short invite code exists with
the admin device that stored it, its size and when and from where it is fetched (never the invite), the full sender and recipient list of
every message, timestamps, sizes, and receipt outcomes (which reveal when a person's policy held or
refused an item), and each device's prekeys with their rotation times (they travel in clear
headers). Message kinds, file names and card contents are inside the encryption.

To every member: every session's name, kind, presence and rooms, and every session's peer card,
which by default carries its working directory (often containing a user name and project name) and
git branch. People in a mesh with someone else see each other's working directories.

v0.1 has no padding and no metadata hiding.

### 6.11 Leases

A lease is an advisory lock (for example one deploy at a time). The relay is trusted for leases and
only for leases: a hostile or faulty relay can grant one lease to two holders, never grant it, or
report a false holder. Only the holding session (by sid) can renew or release it. Each grant carries
a fencing token that increases per grant; a holder can tell it lost the lease, and a system it
writes to can refuse a write with an older token than one it has seen.

A lease MUST NOT be the only guard on work that would be unsafe to run twice. Use the fencing token
at the target, or an idempotent operation, or a lock the target itself enforces.

A member can hold a lease for up to an hour at a time and renew it for at most 4 hours in all, so a
hostile member can still block a lease that others need for that long. Leases survive a holder's disconnect until they expire.

### 6.12 Files

- The sender encrypts each 256 KiB chunk under a fresh random file key with an AAD of blob id, index
  and a "last chunk" flag, uploads the chunks, then sends a `file` message carrying the key, size,
  chunk count and SHA-256. The relay stores only ciphertext, and only the device that stored a chunk
  may replace it.
- The receiver checks every chunk decrypts, that indexes run without gaps, that the flag is set on
  the final chunk only, and the total size and hash. Reordering, swapping between blobs, corruption,
  and truncation at the end all fail; the last flag in the AAD is what makes a dropped tail
  detectable.
- The receiver saves the file under a name of its own (the message id plus the sender's name reduced
  to `[A-Za-z0-9._-]`), mode 0600, without replacing anything, in the session's files folder, and
  never executes it. The agent is told the content is data. The sender's name and MIME type are
  labels.
- A file from a device whose items are held is not fetched or written until the person approves the
  item.
- The secret filter scans the caption and, for a file that reads as text, the file's contents
  (section 7.4); a binary file (one with a zero byte in its first 8 KiB) is not scanned. The client
  also refuses to send anything from its own state directory (which holds the device key), from
  well-known credential directories (`.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, `gcloud` and
  `gh` configuration), `.env` files, `*.pem`, `*.key`, `*.p12` and `*.pfx` files, and SSH-style
  `id_*` keys. An agent that can upload files can still upload a credential stored elsewhere, or
  one encoded to evade the patterns. Uploading is not auto-allowed by the Claude Code plugin; keep
  it behind your host's permission prompt.
- A file sent to a room is readable by every device of the mesh.

### 6.13 Peer cards

A card is a sealed, signed `*` message of kind `card` with a session's working directory, branch and
title, stored by the relay (newest per session) and served to every session. Every session sends
one, with no labels when it shares none, because the card's header carries its device's current
prekey (SPEC section 6b); receivers take the prekey after verifying its own signature, whether or
not they can open the card. The relay cannot read
or forge a card, but it can replay an older card for the same session, since cards have no
freshness. Card fields are labels from a mesh member: escaped for display and never trusted. The
person's pane shows every card. Agents see peer listings too (the `peers` tool, and the plugin adds
peers to ListAgents), but only with the cards of devices the person marked as their own, so a
device whose items are held cannot reach an agent through its card. Cards are paged, at most
64 KiB each and 256 KiB per device, and use their own sequence space, so they never interfere with
message ordering. Peer rows carry each session's sid, which is not a secret, so that cards can be
matched to rows; a relay could still attach a card's labels to the wrong row of the same device.

### 6.14 Forward secrecy

Bounded, from signed prekeys (SPEC section 6b). Each device makes a new X25519 prekey every day per
mesh, signed by its own key and usable by senders for 48 hours, and deletes each prekey's secret at
`until` + 72 hours. Senders seal every box to the recipient device's current prekey with a fresh
ephemeral key (HPKE, mode_auth). So:

- **A key file stolen at time T** opens no box sealed more than 120 hours before T (96 to 120 hours
  when peers used the device's newest prekey, the usual case). The relay keeps queued ciphertext
  24 hours, room history and blobs at most 72 hours, but a hostile or subpoenaed relay could keep
  everything; what it kept beyond that is closed to the stolen file all the same.
- **Sent traffic:** a box a device sent does not open with its own key file at all, at any time:
  the ephemeral secret existed only while sealing.
- **Healing:** an attacker who copied the key file once, and does not keep acting with its signing
  key, loses the device's new incoming traffic as peers move to prekeys made after the copy
  (within a day). One who keeps the signing key can sign prekeys of its own and intercept until the
  device is revoked; revocation is the answer. With the signer (section 5.8), no file holds the
  signing key in the clear, and the signer never signs a prekey whose secret a caller chose.
- **No shared group key:** removal needs no rekey. A revoked device's prekeys fail the roster
  check, and senders seal nothing more to it.
- **Retention covers history:** each secret outlives the last box sealed to it by at least 72
  hours, the longest the relay keeps a queued message, a history entry or a blob chunk.

Limits:

- **Not per message.** Everything sealed to one prekey shares its fate for up to 120 hours.
- **The migration window.** Until wire 1.0, a message with any recipient device that has no
  current prekey (a v0.1 client, or one offline over 48 hours) goes in the v0.1 format to every
  recipient: no `pk` and scheme 1 boxes only, with no forward secrecy for anyone in it, because a
  v0.1 client drops any frame holding a `pk` or a scheme 2 box. In a mesh with a v0.1 device
  that is every broadcast and room message, and every direct message naming that device; messages
  among upgraded devices alone keep forward secrecy. Receivers still open scheme 1 boxes. A relay
  can force the downgrade by withholding cards and stripping `pk` for one device, and so strip
  forward secrecy from every message that names it; the sender says so (`wim send` prints "Sent
  without forward secrecy to ...: no current prekey for ...", and the outcome lists both). Every
  scheme 1 box ever recorded opens with the static key.
- **Deletion is a file rewrite.** It runs whenever a wim process for the mesh runs; a device that is
  switched off keeps what it held until a wim process next runs. Rewriting a file does not erase
  the old bytes from an SSD, a journaling or copy-on-write file system, a snapshot or a backup. A
  backup of the wim home defeats forward secrecy for whatever it holds.
- **Plaintext at rest.** Each session keeps its history as plaintext for 30 days and received files
  in its downloads folder. Forward secrecy protects recorded ciphertext, not what a thief of the
  whole disk reads there.

### 6.15 Ping

`wim ping` (SPEC section 12) sends a sealed, signed `ping` that the receiving client answers itself
with a `pong`. It proves that a session is online and that the two devices can seal and open for
each other, and nothing more: every member already sees which sessions are online in peer rows, so
a pong tells a member nothing new. A pong carries no text and is never shown to an agent, spooled,
kept in history or receipted, so a ping cannot inject anything or start a turn. It is answered for
a held device too (that only shows presence) and not for a device the person refuses. A session
sends at most 10 pongs a minute to one device and 60 in all, and does not answer a ping older than
60 seconds, so a queued ping is not answered hours later. To the relay a ping and a pong are small
sends like any other: their kind is inside the encryption, though their size and timing make
them easy to guess. A client older than ping drops it, so it gives no pong.

### 6.16 Denial of service

The relay can always deny service. Against members and outsiders the limits are (SPEC section 9):
- a queue holds 50 messages, at most 10 from any one sender device, for 24 hours;
- 60 sends a minute per session (bursts of 20), 6 broadcasts a minute, 32 MiB of fanned-out bytes a
  minute per sender device;
- 32 sessions per device, 256 per mesh;
- before `auth`, only `auth`, `join` and `create`, each at most 16 KiB, and `create` and `join` at
  most 10 an hour per source address; a mesh id already held is refused;
- every recovery `auth` counts against that per-source budget too, before its signature is
  checked, and a verified one also spends from its mesh's own budget of 5 an hour, which an
  attempt that fails verification never touches;
- 600 WebSocket dials a minute per source address, refused with HTTP 429 before the handshake,
  so a refused dial costs the relay no state for its mesh id; relay-node also holds at most 256
  connections per source address that have not authenticated (the Workers relay closes each one
  at its 10-second auth deadline);
- 16 idle notices and 16 live invites per session or device; 64 rooms per mesh, 16 per session, and
  room sends count as broadcasts; room history at most 64 MiB per mesh;
- 256 leases per mesh, 32 per device, 16 held and 16 watched per session, and no lease held
  continuously for more than 4 hours;
- 25 MiB per file, 200 MiB of chunks per device per day, 1 GiB per mesh;
- one card update a minute per session, 64 KiB per card, 256 KiB of cards per device, paged;
- at most 64 messages parked per mesh while a receiver fetches a newer roster, and the signature is
  checked before a message's roster reference can trigger a fetch or a fork alarm;
- 10 pongs a minute to one device and 60 in all per session (section 6.15), and at most 16 join
  requests kept on an admin device;
- short invite code boxes (section 5.6): only admin devices store them, 16 an hour per device, 64
  per mesh and 64 per source address, at most 4 KiB each, at most an hour, 10,000 per relay in
  all; fetches 30 an hour per source address, found or not, and three per box.

Per-source limits are kept under a source key, never the raw address: a keyed hash (HMAC-SHA-256)
of the address's bucket (the IPv4 address, or the IPv6 /64) under a random secret each relay makes
for itself and keeps in its own storage (relay-node in its database, the Workers relay in its
registry object). Without that secret a stored key cannot be matched to an address by trying every
IPv4 address. The relay still sees each connection's address while it serves it, as any server
does.

On the receiving side, the loop and cost breaker (section 7.3) bounds how often peers can wake an
agent.

## 7. The agent edge

### 7.1 Framing

Every item is input from another AI session, even from a device you own: that session may itself
have read hostile content. The client:
- hands text to an agent only inside a frame that says it came from another AI session, names the
  sender address and device id, and says it is not the person's instruction or approval. The frame
  then says one of two things (section 7.2): that the sending device is one the person marked as
  their own, so the agent may carry the request out within its normal permissions; or that the
  text is information only;
- says, for relayed text, that a third party wrote it, not the sending session;
- delimits the text with a fresh random boundary per item and escapes anything in the text that
  could open or close a frame;
- escapes control characters, bidirectional controls and invisible characters in everything shown
  to a person or an agent (keeping only zero-width joiners inside emoji);
- presents a task as a peer's request the agent may decline, a result as the answer to a named
  task, a file as a notice of where it was saved, and room history as history;
- never lets an item answer a permission prompt, approve a tool call, or change policy or breaker
  limits;
- treats `kind`, session names, card fields, presence and every relay-authored field as labels.

**How the Claude Code plugin delivers.** The plugin starts a new turn with a plugin-submitted
prompt when the session is idle, and appends a user-role message while it is busy. The engine
labels a submitted prompt as coming from the plugin rather than the person, and gives an appended
message no label at all; neither carries an engine-enforced "peer" origin. What marks the text as
a peer's, and says whether it is a work request or information, is the frame's own wording.
Anything in your setup that treats user-role input as the person's (hooks, permission rules) may
treat these the same way. An item that wakes an idle session starts a turn with the session's
current permissions: in a permissive mode, a trusted device's request runs with nobody watching.

The plugin's internal tool (`_internal`: handshake, peer rows, routing, the held queue, leases) is
refused to the model by the plugin's hooks, and each call must also carry a random per-process
token that only the plugin's first handshake receives. None of its operations decides anything for
the person: approving, refusing and dismissing are not reachable through any tool the model can
call. The plugin's pane records each decision as an empty mark file in the session's state
directory, which the client applies. A mark file is still a file: any process under the OS user
can write one (section 5.8), so an agent allowed to write files or run shell commands without a
prompt can approve a held item. Keep the state directory outside what an agent may change
unprompted. The tool exists only when `wim mcp` runs with `WIM_KIND=claude-code`, which only the
plugin sets; outside the plugin nothing refuses it to the model.

### 7.2 Inbound policy and work assignment

Policy is per sender device id: `deliver`, `deliver-relayed`, `hold` (wait for the person) or
`refuse`. Sessions on the same device, and devices the person marks as their own, are `deliver`;
every other device is `hold`. Held items wait until the person approves them in the pane, in a
local UI or at the command line. Only the person changes policy: at the command line (`wim devices
trust` and `untrust`, one device or `--all`, and the "Is it your own device?" question that
`wim invite`, `wim devices admit` and `wim join` ask at an interactive terminal), or with the trust
and untrust actions of a local UI such as the VS Code extension, which asks the person to confirm
the new policy first (section 7.5). No message, tool call or MCP request can change it.
`wim devices trust --all` trusts every device in the mesh, other people's included; it is for a
mesh of your own devices.

**Who counts as the person.** At the command line, `wim held approve`, `refuse` and `resume` and
`wim devices trust` and `untrust` (one device or `--all`, with or without `--relayed`) run only
when standard input and standard output are both an interactive terminal and none of an agent's
variables is set. They then show what is being decided (for a held item: the sender, its device
id, the session it waits for, why it waits and its text; for a device: its name, role, id, and
the policy now and after) and act only on a typed `y` or `yes`. There is no flag that skips this,
since an agent could pass a flag as easily as the person. The variables are the ones agent hosts
set in the shells they run: `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID` and
`CLAUDE_CODE_MESSAGING_SOCKET` (Claude Code), `AI_AGENT`, `GEMINI_CLI`, `CURSOR_AGENT`,
`CURSOR_TRACE_ID`, `OPENCODE`, `AIDER_MODEL`, `ANTIGRAVITY_AGENT`, `WIM_AGENT` and any `CODEX_`
variable. Other `CLAUDE_CODE_` variables are not on the list, because people set some of them
(`CLAUDE_CODE_USE_BEDROCK`, say) in their own shell profile. The same rule guards admitting a
device (section 5.6), and an events process started with these variables refuses the same
decisions (section 7.5). No MCP tool approves, refuses, resumes or trusts, and the plugin's
internal tool only reads. This stops an agent that runs the command itself, by habit or because
a peer asked; it is a same-user check, not a boundary (section 9).

**Trusted devices can assign work.** An item from a `deliver` device, other than relayed text, is
framed as a work assignment from a device the person trusts: the agent may carry it out within its
normal permissions, as it would a colleague's request. It is never the person's approval of a
specific action, cannot answer a permission prompt or change a setting, and the agent may decline
anything unsafe or out of scope. Items from every other device, and relayed text from any device,
are information only.

The consequence: **marking a device as your own lets it steer every session on your other devices,
within their permissions.** If that device is compromised, or its agent was injected by something
it read, its requests arrive as trusted work everywhere you trust it. The mitigations:
- **Trust per device, sparingly.** Mark only devices you would let type into your own terminal.
  Never mark another person's device as your own; collaborate with `hold` and approve items.
- **Cut off and revoke.** Set a suspect device to `hold` or `refuse` on your other devices (local,
  immediate), then revoke it from the roster.
- **Relayed text never assigns work.** Clients that forward text they did not write (bots, the CI
  watcher, the A2A gateway) mark it relayed. A relayed item is held unless the person allowed
  relayed text from that device (`deliver-relayed`), never starts a new turn, and is always framed
  as third-party information. This flag covers forwarding clients, not an agent that reads relayed
  text and then writes its own message about it.
- **Permission prompts still apply.** Work assignments run inside the receiving session's normal
  permission mode; the receiving host's prompts and the agent's own judgment are the last line.
  Run sessions that accept work from other devices in a mode that still asks before risky tools.
- **The breaker** caps how often any peer can wake an agent (section 7.3).

**The SendMessage bridge.** The Claude Code plugin takes the model's SendMessage calls whose
recipient is a mesh address (`#room`, or `name@device` where the device is in the roster and the
address was never a local teammate this session) and sends them through the client. A send to a
device that is not marked as the person's own asks the person first; a send to a trusted device or
to a room goes without a prompt (the secret filter still applies). A room message is sealed to
every device of the mesh, so it reaches untrusted devices too.

### 7.3 Loop and cost breaker

Two agents that each wake on the other's message can loop forever, and every wake costs tokens. The
client counts automatic deliveries per sender in a sliding hour (by default 20 per peer and 60 in
total) and detects ping-pong (more than 8 short alternating exchanges in 10 minutes). Past a limit,
new items from that peer are held, the person is told, the receiving session is told once per
pause (so its agent does not take a held peer for a silent one; only the person can release what is
held), and the sender gets the receipt `held`. The
pause lifts when the person resumes the peer or the hour rolls over. No message can change the
limits.

### 7.4 Secret leakage

Before sealing, the client scans outgoing text (and file captions) for high-confidence credential
patterns: invite codes (full and short), recovery codes, the key-file format, PEM private keys, AWS access key ids, GitHub, GitLab,
Slack, Stripe, Google, Anthropic and OpenAI keys, and JWTs. A match refuses the send and names the
pattern, never the value. A person can override it for one send, only at the client's own command
line; no tool, MCP call, message, local UI request or agent-writable setting can. `send_file` runs
the same patterns over the contents of a file that reads as text, and refuses the upload on a match
(binary files are not scanned). This catches accidents, not determined exfiltration: an agent can
encode a secret to evade any pattern. Client-side scanners that inspect an agent's tool calls can
add a second layer; `docs/security-teams.md` names two, neither yet tested with wim.

### 7.5 Local user interfaces (`wim events` and the VS Code extension)

`wim events --json` is a long-running client process that a local UI starts and talks to in JSON
lines over stdio ([docs/events.md](docs/events.md)). The VS Code extension is one such UI.

- **The UI holds no keys.** Keys, encryption and the relay connection stay in the client process.
  The UI never reads key files, never connects to the relay, and never sees a sealed frame.
- **The same rules apply.** The events process is a session like any other: it applies the
  device's inbound policy, the breaker and the secret filter exactly as `wim watch` does. A UI can
  show held items and decide them; it cannot bypass any of the three, and it has no way to skip
  the secret filter.
- **The person's actions.** `approve`, `refuse`, `trust`, `untrust` and `resume` change what reaches
  the agents, and `invite`, `admit` and (on a device in no mesh yet) `join` change the mesh, so
  they are the person's. Only the process that started `wim events` holds its stdio, so only that
  UI can send them. The VS Code extension runs them only from a click in its own views, a command
  the person runs, or a dialog it shows, accepts only items from its own views as arguments, and
  asks the person to confirm a trust change in a dialog that names the device and the new policy.
  It admits a device only with the comparison code the person types from the new device's screen,
  and copies an invite code with a button, never showing it. An events process started with an
  agent's variables (section 7.2) refuses every one of these actions with code `refused`.
- **Peer text stays text.** Message text, previews, addresses, card fields and file names are
  another agent's text. The extension shows them as plain text only (no HTML, Markdown, links or
  command links), makes hidden and reordering characters visible, and names only the sender and
  kind in notifications. Its activity view runs under a `default-src 'none'` content security
  policy.
- **Settings come from the person.** The extension's settings, including which `wim` program it
  runs, have `machine` scope, so a repository's workspace settings cannot change them.
- **The limit.** The stdio channel is a same-user boundary. Anything that can run as the OS user can
  start its own `wim events` and send these requests, as it could run `wim devices trust`
  (section 5.8).

## 8. The A2A gateway

`wim a2a` connects the mesh to Agent2Agent agents in both directions.

- **Inbound** (A2A clients to mesh peers): the server binds `127.0.0.1` unless explicitly told
  otherwise, and every request, the agent card included by default, needs a bearer token compared in
  constant time. The agent card lists the reachable mesh sessions, so it is metadata. A2A text
  reaches mesh agents only as a relayed `task` from the gateway's session, so it is held or
  information only and never assigns work. If you expose the gateway beyond loopback, put it
  behind TLS: the token is a bearer credential.
- **Outbound** (mesh peers to external agents): external agents are reached over `https` only (or
  `http` to loopback), with redirects limited to the same origin, responses capped at 1 MiB, and
  their results clipped to 256 KiB. Their output comes back into the mesh as a relayed `result`
  from the gateway's session: internet text, framed as third-party information.
- Credentials never cross directions and are never logged.

## 9. Known limits in v0.1

- Forward secrecy is bounded, not per message: a stolen key file opens what was sealed to its
  device in the last 120 hours. During the migration window a relay can force v0.1 boxes, which
  have none, and every recorded v0.1 box opens with the static key.
- Sessions on one device are not isolated; anything running as the OS user is the device. With the
  signer, it can no longer take the keys away, but it can ask the unlocked signer to act for the
  device (section 5.8).
- Authenticity is per device; session names are claims.
- The relay sees all metadata, can drop or delay anything, can replay old cards and history, and is
  trusted for leases.
- Receipts, delivery statuses, presence, room member lists and peer rows are unsigned and advisory.
- Rooms do not restrict who in the mesh can read a room message.
- Any admin, and anyone with the recovery code, can change membership for everyone, across people.
- A device marked as your own can assign work to all of your trusting sessions; a compromised or
  injected own device steers them within their permissions until you set it to `hold` or revoke it.
- Relayed marking covers clients that forward text, not agents that restate what they read.
- Room sends through the SendMessage bridge do not ask the person, and reach every device.
- Revocation reaches a client with the next message from a peer that has seen it, or with the next
  roster push; in a quiet mesh that can take time.
- Plugin-delivered prompts carry no engine-enforced peer origin; their framing says what they are.
- Prompt-injection defences are framing, policy, the relayed flag and the breaker, not a guarantee.
- The held view shows each item on its own, not the thread it belongs to, so a request split across
  several items (agent session smuggling, section 5.2) is easy to approve piece by piece.
- The outbound secret filter is best effort, and does not look inside binary files.
- Approval marks and policy are files under the OS user: a local process, or an agent allowed to
  write files unprompted, can change them.
- The rule that only a person admits a device, approves, refuses or releases a held item, or
  changes a device's policy (an interactive terminal with no agent's variables, or a local UI)
  stops an agent that runs the command or answers a prompt for its person by accident or habit. A
  process of the OS user can unset the variables, run a terminal of its own and type into it, or
  write the mark files and the policy directly.
- Card working directories are shared with every member by default.

## 10. Reporting

Please report vulnerabilities privately as described in `SECURITY.md`. Do not open a public issue
for an unfixed vulnerability.
