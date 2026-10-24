# @worldinmotion/protocol

The `wim/1` wire protocol for worldinmotion: canonical encoding, device keys, signed rosters,
invites, end-to-end encrypted messages, the relay handshake, and schemas for every frame. Clients
and relays both build on it, so they agree on every byte. The contract it implements is
[`SPEC.md`](../../SPEC.md) at the repository root.

It has no Node-specific imports and runs in Node 22.18 or later, browsers and Cloudflare
Workers. Crypto is Ed25519, X25519, HKDF-SHA256 and XChaCha20-Poly1305 from the audited
`@noble` libraries; randomness comes from `crypto.getRandomValues`.

## API

| area | exports |
|---|---|
| encoding | `canon`, `canonBytes`, `b64u`, `sha256`, `hash`, `utf8`, `fromUtf8`, `fitsUtf8`, `bytesEqual`, `parseJson`, `hasDuplicateKeys` |
| ids and names | `ulid`, `ulidTime`, `isUlid`, `isName`, `isId22`, `deviceIdFromSignPub`, `randomBytes`, `isRelayUrl`, `relayDialUrl` |
| keys | `DeviceKeys`, `generateDeviceKeys`, `deviceKeysFromSecrets`, `encodeKeys`, `decodeKeys` |
| signing | `signObject(type, obj, sec)`, `verifyObject(type, obj, pub)`, `SignType` |
| rosters | `DeviceRecord`, `Roster`, `RosterRef`, `makeDeviceRecord`, `createGenesisRoster`, `nextRoster`, `verifyGenesisRoster`, `verifyNextRoster`, `verifyRosterChain`, `findDevice`, `rosterRef`, `detectFork`, `isRecoveryName`; `nextRoster` takes `add`, `revoke` and `promote` |
| recovery | `createRecoveryKeys`, `recoveryCode`, `createRecoveryIdentity`, `parseRecoveryCode`, `verifyRecoveryChain`, `recoverySummary` |
| test vectors | `VECTOR_SEED_PUBLIC_KEYS`, `isVectorKey` |
| invites and joining | `createInvite`, `parseInvite`, `InviteCode`, `inviteIdFromSecret`, `createJoin`, `verifyJoin`, `admitJoin`, `joinProof`, `verifyJoinProof`, `sasFor`, `spkiPin` |
| messages | `sealMessage` (kinds `msg`, `task`, `result`, `file`, `card`; `allowSecrets` for a person at the CLI only), `openMessage`, `Plaintext`, `MessageKind`, `Card`, `cardSchema`, `Receiver` |
| rooms and leases | `isRoom`, `roomName`, `roomSchema`, `leaseKey` |
| files | `sealBlob`, `openBlob`, `blobChunkCount`, `fileSchema`, `isFileName`, `FileInfo`, `BlobChunk` |
| replay | `checkFreshness`, `dedupeExpiry`, `SeqTracker` |
| agents and people | `frameForAgent`, `sanitizeForDisplay`, `findSecrets` |
| handshake | `signAuth`, `verifyAuth`, and for recovery `signRecoverAuth`, `verifyRecoverAuth`, `parseRecoverAuthFrame` |
| frames | a zod schema and type for every client and relay frame, `parseClientFrame`, `parseRelayFrame` |
| constants | `PROTOCOL`, `WIRE_VERSION`, `LIMITS`, `Result` |

Functions that check untrusted input (`verify*`, `openMessage`, `parse*Frame`, `checkFreshness`)
never throw: they return `{ ok: true, value }` or `{ ok: false, reason }` with a stable reason
string. Functions that build protocol objects throw on bad input, before anything is sent.

Every signature is domain separated by type (`roster`, `send`, `auth`, `join`). JSON with
duplicate keys is refused everywhere. Client frames are parsed strictly (unknown keys are refused,
since the relay forwards signed objects unchanged). Relay frames keep and ignore unknown keys, so
newer relays can add fields; signed objects inside them (rosters, delivered messages) stay strict.

## Test vectors

`vectors/` holds deterministic fixtures for every primitive (SPEC section 16), for checking
another implementation. `npm run vectors -w @worldinmotion/protocol` regenerates them, and the
test suite fails if the committed files differ from a fresh generation.

## Example

```ts
import { createGenesisRoster, findDevice, generateDeviceKeys, makeDeviceRecord, nextRoster, openMessage, sealMessage, ulid } from "@worldinmotion/protocol";

const laptop = generateDeviceKeys(), server = generateDeviceKeys(), now = Date.now();
const genesis = createGenesisRoster({ name: "laptop", keys: laptop, now });
const roster = nextRoster(genesis, { add: [makeDeviceRecord("server", server, "member", now)] }, { keys: laptop }, now);
const [me, peer] = [findDevice(roster, "laptop")!, findDevice(roster, "server")!];

const frame = sealMessage({ roster, sender: { deviceId: me.id, keys: laptop }, session: "writer", sid: ulid(),
  to: ["reviewer@server"], seq: 1, at: now, text: "please review", recipients: [peer.id] });
const result = openMessage(frame, { roster, now, me: { deviceId: peer.id, keys: server, address: "reviewer@server", sid: ulid() } });
if (result.ok) console.log(result.value.text); // "please review"
```

## License

Apache-2.0
