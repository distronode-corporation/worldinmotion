/** Protocol identifier, also the prefix of every key-derivation, hashing and signing label. */
export const PROTOCOL = "wim/1";

/** Wire version carried in `hello`, `auth` and message plaintexts. */
export const WIRE_VERSION = 1;

const KiB = 1024;
const MiB = 1024 * KiB;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Default limits from SPEC sections 5, 6, 8 and 9. A relay may lower the relay-side ones. */
export const LIMITS = {
  /** Largest frame a client sends, in UTF-8 bytes of its JSON text. */
  frameBytes: MiB,
  /** Largest frame a client accepts: a full frame plus room for the `deliver` envelope. */
  receiveFrameBytes: MiB + 4 * KiB,
  /** Largest frame before `auth` succeeds (`auth`, `join`, `create`). */
  preAuthFrameBytes: 16 * KiB,
  /** Largest message `text`, in UTF-8 bytes. The frame limit may allow less (SPEC section 6). */
  textBytes: 256 * KiB,
  /** Sends per session per minute, sustained. */
  sendsPerMinute: 60,
  /** Sends per session allowed in a burst. */
  sendBurst: 20,
  /** Broadcast (`*`) sends per session per minute. */
  broadcastsPerMinute: 6,
  /** Bytes one sender device may fan out to recipient queues per minute. */
  fanoutBytesPerMinute: 32 * MiB,
  /** Messages held in one recipient session's queue. */
  queuePerSession: 50,
  /** Of those, messages from any one sender device. */
  queuePerSenderDevice: 10,
  /** How long a queued message is kept. */
  queueLifetimeMs: DAY,
  /** How long a client has to answer `hello` with `auth`. */
  authDeadlineMs: 10 * 1000,
  /** Largest difference between an `auth` frame's `at` and the relay clock. */
  authSkewMs: 5 * MINUTE,
  /** How long a `notify_idle` request stays armed. */
  idleNoticeLifetimeMs: 12 * HOUR,
  /** Armed `notify_idle` requests per session. */
  notifyIdlePerSession: 16,
  /** Sessions in one mesh. */
  sessionsPerMesh: 256,
  /** Sessions on one device. */
  sessionsPerDevice: 32,
  /** `create` and `join` frames per source address per hour. */
  createJoinPerSourcePerHour: 10,
  /** Unexpired, unused invites per admin device. */
  liveInvitesPerDevice: 16,
  /** Default invite lifetime. */
  inviteDefaultTtlMs: HOUR,
  /** Longest invite lifetime. */
  inviteMaxTtlMs: 7 * DAY,
  /** Rosters in one `roster` page. */
  rosterPageMax: 64,
  /** Bytes of rosters in one `roster` page. */
  rosterPageBytes: 512 * KiB,
  /** Rooms in one mesh. */
  roomsPerMesh: 64,
  /** Rooms one session may be in. */
  roomsPerSession: 16,
  /** Messages a relay keeps per room for `room.history`. */
  roomHistoryMessages: 100,
  /** How long a relay keeps room history. */
  roomHistoryLifetimeMs: 7 * DAY,
  /** Messages in one `room.history` page. */
  roomHistoryPageMax: 50,
  /** Shortest and longest lease time to live. */
  leaseTtlMinMs: 1000,
  leaseTtlMaxMs: HOUR,
  /** Leases in one mesh, held by one session, and watched by one session. */
  leasesPerMesh: 256,
  leasesPerSession: 16,
  leaseWatchesPerSession: 16,
  /** How long a `lease.watch` stays armed. */
  leaseWatchLifetimeMs: HOUR,
  /** Plaintext bytes per blob chunk (the last chunk may be shorter). */
  blobChunkBytes: 256 * KiB,
  /** Largest file, and so at most 100 chunks. */
  blobFileBytes: 25 * MiB,
  blobMaxChunks: 100,
  /** Chunk bytes one device may store per day, and bytes stored per mesh. */
  blobBytesPerDevicePerDay: 200 * MiB,
  blobBytesPerMesh: 1024 * MiB,
  /** Chunk bytes all devices of one mesh may store per day (a hosted relay lowers this). */
  blobBytesPerMeshPerDay: 1024 * MiB,
  /** How long a relay keeps blob chunks. */
  blobLifetimeMs: DAY,
  /** Largest `card.set` or `card` frame (SPEC section 17). */
  cardFrameBytes: 64 * KiB,
  /** Bytes of cards in one `cards` page, and stored card bytes per device. */
  cardsPageBytes: 512 * KiB,
  cardBytesPerDevice: 256 * KiB,
  /** Leases held by all sessions of one device. */
  leasesPerDevice: 32,
  /** Longest a lease may be held continuously (acquire plus renewals). */
  leaseMaxHoldMs: 4 * HOUR,
  /** Room history bytes per mesh; the oldest messages are dropped first. */
  roomHistoryBytesPerMesh: 64 * MiB,
  /** Messages a receiver parks while it fetches a newer roster (`roster_behind`), per mesh. */
  parkedPerMesh: 64,
  /** Longest time a recovery code waits in memory for `wim recovery show`. */
  recoveryShowWindowMs: 10 * MINUTE,
  /** After handing an agent an information-only item, how long its session's sends stay `derived`. */
  derivedWindowMs: 10 * MINUTE,
  /** Pending (unauthenticated, waiting) join connections per invite and per mesh. */
  pendingJoinsPerInvite: 1,
  pendingJoinsPerMesh: 16,
  /** Recovery connections per mesh per hour, in their own bucket. */
  recoveryPerMeshPerHour: 5,
  /** Longest time from a task's `at` to its `deadline`. */
  taskDeadlineMaxMs: DAY,
  /** A receiver drops a message whose `at` is older than this. */
  messageMaxAgeMs: 47 * HOUR,
  /** A receiver drops a message whose `at` is further ahead of its clock than this. */
  messageMaxFutureMs: 10 * MINUTE,
  /**
   * A receiver remembers an accepted message id until `at` plus this. It exceeds the accept window
   * (`messageMaxAgeMs` + `messageMaxFutureMs`), so an id is never forgotten while still acceptable.
   */
  dedupeRetentionMs: 48 * HOUR + 10 * MINUTE,
  /** A device publishes a new prekey when its newest is this old (SPEC section 6b). */
  prekeyRotateMs: DAY,
  /** `until - at` of a prekey: senders may seal to it this long. A longer window is refused. */
  prekeyLifetimeMs: 2 * DAY,
  /**
   * A device deletes a prekey's secret at `at` plus this, so nothing sealed to that prekey opens
   * afterwards, with any key file. Equal to the room history lifetime the relay keeps.
   */
  prekeyRetentionMs: 3 * DAY,
  /** Senders stop sealing to a prekey this long before its `until`, for clock skew. */
  prekeySendMarginMs: 10 * MINUTE,
  /** Signed prekeys a device keeps at once (rotation daily, retention 72 hours, plus one spare). */
  prekeysKept: 4,
} as const;

/** Outcome of a check that must not throw. `reason` is a stable, machine-readable string. */
export type Result<T = true> = { ok: true; value: T } | { ok: false; reason: string };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(reason: string): Result<T> {
  return { ok: false, reason };
}
