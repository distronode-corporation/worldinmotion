/*
 * The relay's durable state for one mesh, behind a synchronous interface. Both backends a relay
 * runs on (Node's `node:sqlite` and Durable Object SQLite) are synchronous, so the relay never
 * awaits its own state and every frame is handled to completion before the next.
 *
 * Everything that must survive a restart or a Durable Object hibernation lives here. The only
 * other state is the small per-connection object in `ConnState` (see relay.ts).
 */

/** One stored roster version: its seq, `hash(roster)`, and the roster as JSON text. */
export type RosterRow = { seq: number; hash: string; json: string };

/**
 * Evidence that the mesh forked. `kind` `evidence` holds two full rosters sent with `roster.fork`;
 * `pin` holds the relay's hash and a client's pinned hash for the same seq (an `auth` pin that
 * did not match).
 */
export type ForkRow = { at: number; seq: number; kind: "evidence" | "pin"; signer: string; a: string; b: string };

/**
 * A registered invite. The relay knows only its id and expiry. `pinSeq` is the relay's newest
 * roster seq when the invite was registered, where the `joined` chain starts. `joiner` is the
 * device id that used it, or null while unused.
 */
export type InviteRow = { id: string; device: string; exp: number; pinSeq: number; joiner: string | null };

/** A join waiting for an admin's decision: the joining device id and the body forwarded to admins. */
export type JoinRow = { invite: string; device: string; body: string; exp: number };

/**
 * A session. `conn` is the id of the connection holding it, or null while it is offline. `ended`
 * is when it said `bye { ended: true }` (a tombstone, so later sends get `ended`), or null.
 * `resume` is `hash(session.resume)`. Cursors: `acked` is the last acknowledged, `delivered` the
 * highest sent on any connection, `nextCursor` the one the next queued message gets.
 */
export type SessionRow = {
  sid: string;
  device: string;
  name: string;
  kind: string;
  status: "idle" | "busy";
  since: number;
  conn: string | null;
  ended: number | null;
  resume: string;
  acked: number;
  delivered: number;
  nextCursor: number;
};

/** A message waiting in a recipient session's queue, kept as the send frame's JSON text. */
export type QueueItem = {
  sid: string;
  cur: number;
  id: string;
  fromDevice: string;
  queuedAt: number;
  bytes: number;
  msg: string;
};

/** Which session sent a message, and which sessions it was addressed to, for routing receipts. */
export type MessageRow = { id: string; sender: string; at: number; rcpts: string[] };

/** An armed `notify_idle`: `sub` wants one notice when `target` next reports idle or ends. */
export type IdleRow = { sub: string; target: string; exp: number };

/** A token bucket: `tokens` left as of time `at`. */
export type BucketRow = { bkey: string; tokens: number; at: number };

/** A room (`#name`). `nextCursor` numbers its history and never goes back, even after pruning. */
export type RoomRow = { room: string; created: number; nextCursor: number };

/** One message kept for `room.history`. */
export type HistoryRow = { room: string; cur: number; at: number; msg: string };

/**
 * A held lease: `holder` is a session id, `token` its fencing token, `until` when it ends, and
 * `granted` when this holder got it (renewals keep it, so a continuous hold can be capped).
 */
export type LeaseRow = { key: string; holder: string; token: number; until: number; granted: number };

/** A session waiting for a lease, first come first served (`seq`), giving up at `exp`. */
export type WaiterRow = { key: string; sid: string; ttl: number; exp: number; seq: number };

/** A `lease.watch`: one notice when `key` next frees, until `exp`. */
export type WatchRow = { key: string; sid: string; exp: number };

/** One stored blob chunk, its size in ciphertext bytes, the device that stored it, and when. */
export type ChunkRow = { blob: string; idx: number; last: boolean; n: string; data: string; bytes: number; device: string; at: number };

export interface MeshStore {
  /** The newest roster seq, or 0 when the mesh does not exist. */
  rosterHead(): number;
  getRoster(seq: number): RosterRow | undefined;
  /** Rosters with seq >= `from`, oldest first, at most `limit`. */
  rosterRange(from: number, limit: number): RosterRow[];
  /** Stores a roster only if none exists at its seq yet (the compare-and-swap). */
  insertRoster(row: RosterRow): boolean;
  addFork(row: ForkRow): void;
  forks(): ForkRow[];

  getInvite(id: string): InviteRow | undefined;
  putInvite(row: InviteRow): void;
  deleteInvite(id: string): void;
  /** Unused invites registered by `device` that expire after `now`. */
  liveInviteCount(device: string, now: number): number;
  /** Invites with `exp <= now`. */
  expiredInvites(now: number): InviteRow[];
  invitesBy(device: string): InviteRow[];

  getJoin(invite: string): JoinRow | undefined;
  putJoin(row: JoinRow): void;
  deleteJoin(invite: string): void;
  joins(): JoinRow[];

  getSession(sid: string): SessionRow | undefined;
  /** Inserts or replaces a session by sid. */
  putSession(row: SessionRow): void;
  /**
   * Deletes a session with everything keyed by it: its queue, idle subscriptions (both ways),
   * room memberships, leases it holds, lease waits and watches, and its card.
   */
  deleteSession(sid: string): void;
  sessions(): SessionRow[];
  sessionsOf(device: string): SessionRow[];
  /**
   * Moves a session to a new sid: its row, queue, receipt routes, idle subscriptions, rooms,
   * leases, lease waits and watches, and its card.
   */
  rekeySession(from: string, to: string): void;

  enqueue(item: QueueItem): void;
  /** Queued items for `sid` with cursor > `after`, oldest first. */
  queue(sid: string, after: number): QueueItem[];
  queueCount(sid: string): number;
  queueCountFrom(sid: string, fromDevice: string): number;
  /** Deletes the items of `sid` with cursor <= `cur`. */
  dequeueThrough(sid: string, cur: number): void;
  /** Items queued at or before `before`, oldest first. */
  expiredQueue(before: number): QueueItem[];
  dropQueueItem(sid: string, cur: number): void;
  /** Deletes every queued item sent by `device`, in every queue. */
  dropQueueFrom(device: string): void;

  putMessage(row: MessageRow): void;
  getMessage(id: string): MessageRow | undefined;
  /** Forgets messages recorded at or before `before`. */
  pruneMessages(before: number): void;

  /** Inserts or refreshes a subscription (one per subscriber and target). */
  putIdle(row: IdleRow): void;
  idleFor(target: string): IdleRow[];
  idleCount(sub: string): number;
  deleteIdle(sub: string, target: string): void;
  /** Deletes subscriptions with `exp <= now`. */
  pruneIdle(now: number): void;

  getBucket(bkey: string): BucketRow | undefined;
  putBucket(row: BucketRow): void;
  /** Deletes buckets last touched at or before `before`. */
  pruneBuckets(before: number): void;

  getRoom(room: string): RoomRow | undefined;
  putRoom(row: RoomRow): void;
  roomCount(): number;
  /** Deletes rooms that have no members and no history left. */
  pruneRooms(): void;
  /** Member session ids, in join order. */
  members(room: string): string[];
  /** The rooms a session is in, sorted. */
  roomsOf(sid: string): string[];
  addMember(room: string, sid: string): void;
  removeMember(room: string, sid: string): void;
  /** Appends to a room's history and keeps only its newest `keep` entries. */
  addHistory(row: HistoryRow, keep: number): void;
  /** Up to `limit` entries with cursor < `before`, newest first. */
  history(room: string, before: number, limit: number): HistoryRow[];
  /** Deletes history recorded at or before `before`. */
  pruneHistory(before: number): void;
  /** Bytes of history kept for the whole mesh. */
  historyBytes(): number;
  /** Deletes the mesh's oldest history entry (any room). */
  dropOldestHistory(): void;

  getLease(key: string): LeaseRow | undefined;
  putLease(row: LeaseRow): void;
  deleteLease(key: string): void;
  leases(): LeaseRow[];
  leasesHeldBy(sid: string): number;
  /** Leases with `until <= now`. */
  expiredLeases(now: number): LeaseRow[];
  /** The next fencing token. One counter for the whole mesh, so tokens rise for every key. */
  nextToken(): number;
  /** Queues a wait, unless this session already waits for this key. */
  addWaiter(row: Omit<WaiterRow, "seq">): void;
  /** Waiters for `key`, first come first served. */
  waiters(key: string): WaiterRow[];
  deleteWaiter(key: string, sid: string): void;
  waitsBy(sid: string): number;
  /** Waiters with `exp <= now`. */
  expiredWaiters(now: number): WaiterRow[];
  putWatch(row: WatchRow): void;
  watchesFor(key: string): WatchRow[];
  watchesBy(sid: string): number;
  deleteWatch(key: string, sid: string): void;
  /** Deletes watches with `exp <= now`. */
  pruneWatches(now: number): void;

  getChunk(blob: string, idx: number): ChunkRow | undefined;
  /** Inserts or replaces a chunk by blob and index. */
  putChunk(row: ChunkRow): void;
  /** Bytes of every chunk stored for the mesh. */
  blobBytes(): number;
  /** Deletes chunks stored at or before `before`. */
  pruneChunks(before: number): void;
  dropChunksFrom(device: string): void;

  /** The newest peer card (a sealed send frame as JSON) per session, replacing any older one. */
  putCard(sid: string, msg: string): void;
  deleteCard(sid: string): void;
  /** Every stored card, by session id. */
  cards(): { sid: string; msg: string }[];
}
