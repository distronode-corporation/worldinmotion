import type {
  BucketRow,
  ChunkRow,
  ForkRow,
  HistoryRow,
  IdleRow,
  InviteRow,
  JoinRow,
  LeaseRow,
  MeshStore,
  MessageRow,
  QueueItem,
  RoomRow,
  RosterRow,
  SessionRow,
  WaiterRow,
  WatchRow,
} from "./store.ts";

export type SqlValue = string | number | null;
type SqlRow = Record<string, SqlValue>;

/**
 * The smallest synchronous SQL surface both hosts offer: Node's `DatabaseSync` (through
 * `prepare(sql).run/all/get`) and a Durable Object's `ctx.storage.sql.exec(sql, ...params)`.
 * Each call runs exactly one statement.
 */
export interface SqlDb {
  exec(sql: string, ...params: SqlValue[]): void;
  all(sql: string, ...params: SqlValue[]): SqlRow[];
  one(sql: string, ...params: SqlValue[]): SqlRow | undefined;
}

/*
 * Schema. One database holds many meshes, so every table leads with the mesh id. Migrations are
 * append-only: entry i is the list of statements that takes the schema from version i to i + 1,
 * and `wim_meta.schema` records how many have run.
 */
const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE rosters (mesh TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY (mesh, seq))`,
    `CREATE TABLE forks (mesh TEXT NOT NULL, at INTEGER NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
      signer TEXT NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL)`,
    `CREATE TABLE invites (mesh TEXT NOT NULL, id TEXT NOT NULL, device TEXT NOT NULL, exp INTEGER NOT NULL,
      pinSeq INTEGER NOT NULL, joiner TEXT, PRIMARY KEY (mesh, id))`,
    `CREATE TABLE joins (mesh TEXT NOT NULL, invite TEXT NOT NULL, device TEXT NOT NULL, body TEXT NOT NULL,
      exp INTEGER NOT NULL, PRIMARY KEY (mesh, invite))`,
    `CREATE TABLE sessions (mesh TEXT NOT NULL, sid TEXT NOT NULL, device TEXT NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL, since INTEGER NOT NULL, conn TEXT, ended INTEGER,
      resume TEXT NOT NULL, acked INTEGER NOT NULL, delivered INTEGER NOT NULL, nextCursor INTEGER NOT NULL,
      PRIMARY KEY (mesh, sid))`,
    `CREATE INDEX sessions_device ON sessions (mesh, device)`,
    `CREATE TABLE queue (mesh TEXT NOT NULL, sid TEXT NOT NULL, cur INTEGER NOT NULL, id TEXT NOT NULL,
      fromDevice TEXT NOT NULL, queuedAt INTEGER NOT NULL, bytes INTEGER NOT NULL, msg TEXT NOT NULL,
      PRIMARY KEY (mesh, sid, cur))`,
    `CREATE INDEX queue_age ON queue (mesh, queuedAt)`,
    `CREATE TABLE messages (mesh TEXT NOT NULL, id TEXT NOT NULL, sender TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (mesh, id))`,
    `CREATE TABLE message_rcpts (mesh TEXT NOT NULL, id TEXT NOT NULL, sid TEXT NOT NULL, PRIMARY KEY (mesh, id, sid))`,
    `CREATE TABLE idle (mesh TEXT NOT NULL, sub TEXT NOT NULL, target TEXT NOT NULL, exp INTEGER NOT NULL,
      PRIMARY KEY (mesh, sub, target))`,
    `CREATE TABLE buckets (mesh TEXT NOT NULL, bkey TEXT NOT NULL, tokens REAL NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (mesh, bkey))`,
    `CREATE TABLE rooms (mesh TEXT NOT NULL, room TEXT NOT NULL, created INTEGER NOT NULL, nextCursor INTEGER NOT NULL,
      PRIMARY KEY (mesh, room))`,
    `CREATE TABLE room_members (mesh TEXT NOT NULL, room TEXT NOT NULL, sid TEXT NOT NULL, PRIMARY KEY (mesh, room, sid))`,
    `CREATE TABLE room_history (mesh TEXT NOT NULL, room TEXT NOT NULL, cur INTEGER NOT NULL, at INTEGER NOT NULL,
      msg TEXT NOT NULL, PRIMARY KEY (mesh, room, cur))`,
    `CREATE TABLE leases (mesh TEXT NOT NULL, lkey TEXT NOT NULL, holder TEXT NOT NULL, token INTEGER NOT NULL,
      until INTEGER NOT NULL, granted INTEGER NOT NULL, PRIMARY KEY (mesh, lkey))`,
    `CREATE TABLE lease_waiters (mesh TEXT NOT NULL, lkey TEXT NOT NULL, sid TEXT NOT NULL, ttl INTEGER NOT NULL,
      exp INTEGER NOT NULL, PRIMARY KEY (mesh, lkey, sid))`,
    `CREATE TABLE lease_watches (mesh TEXT NOT NULL, lkey TEXT NOT NULL, sid TEXT NOT NULL, exp INTEGER NOT NULL,
      PRIMARY KEY (mesh, lkey, sid))`,
    `CREATE TABLE counters (mesh TEXT NOT NULL, name TEXT NOT NULL, v INTEGER NOT NULL, PRIMARY KEY (mesh, name))`,
    `CREATE TABLE chunks (mesh TEXT NOT NULL, blob TEXT NOT NULL, idx INTEGER NOT NULL, last INTEGER NOT NULL,
      n TEXT NOT NULL, data TEXT NOT NULL, bytes INTEGER NOT NULL, device TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (mesh, blob, idx))`,
    `CREATE INDEX chunks_age ON chunks (mesh, at)`,
    `CREATE TABLE cards (mesh TEXT NOT NULL, sid TEXT NOT NULL, msg TEXT NOT NULL, PRIMARY KEY (mesh, sid))`,
  ],
];

/** The schema version this code writes. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Brings a database up to the current schema. Idempotent; call it once per database before
 * constructing stores on it. Refuses a database written by a newer version.
 */
export function migrate(db: SqlDb): void {
  db.exec("CREATE TABLE IF NOT EXISTS wim_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
  const row = db.one("SELECT v FROM wim_meta WHERE k = 'schema'");
  const current = row === undefined ? 0 : Number(row["v"]);
  if (current > SCHEMA_VERSION) throw new Error(`relay database schema ${current} is newer than this relay (${SCHEMA_VERSION})`);
  for (let v = current; v < SCHEMA_VERSION; v++) {
    for (const sql of MIGRATIONS[v]!) db.exec(sql);
    db.exec("INSERT INTO wim_meta (k, v) VALUES ('schema', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", v + 1);
  }
}

/** How many meshes the database holds: one genesis roster each. */
export function meshCount(db: SqlDb): number {
  return Number(db.one("SELECT COUNT(*) AS n FROM rosters WHERE seq = 1")!["n"]);
}

/**
 * Deletes every row of one mesh, from every table that has a `mesh` column (relay-core's, and a
 * host's own tables keyed the same way). The schema stays.
 */
export function dropMesh(db: SqlDb, mesh: string): void {
  const tables = db.all(
    "SELECT m.name AS name FROM sqlite_master m WHERE m.type = 'table' AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) p WHERE p.name = 'mesh')",
  );
  for (const t of tables) db.exec(`DELETE FROM "${String(t["name"])}" WHERE mesh = ?`, mesh);
}

const str = (v: SqlValue | undefined): string => v as string;
const num = (v: SqlValue | undefined): number => Number(v);
const strOrNull = (v: SqlValue | undefined): string | null => (v === null ? null : (v as string));
const numOrNull = (v: SqlValue | undefined): number | null => (v === null ? null : Number(v));

const toSession = (r: SqlRow): SessionRow => ({
  sid: str(r["sid"]),
  device: str(r["device"]),
  name: str(r["name"]),
  kind: str(r["kind"]),
  status: str(r["status"]) as SessionRow["status"],
  since: num(r["since"]),
  conn: strOrNull(r["conn"]),
  ended: numOrNull(r["ended"]),
  resume: str(r["resume"]),
  acked: num(r["acked"]),
  delivered: num(r["delivered"]),
  nextCursor: num(r["nextCursor"]),
});
const toItem = (r: SqlRow): QueueItem => ({
  sid: str(r["sid"]),
  cur: num(r["cur"]),
  id: str(r["id"]),
  fromDevice: str(r["fromDevice"]),
  queuedAt: num(r["queuedAt"]),
  bytes: num(r["bytes"]),
  msg: str(r["msg"]),
});
const toInvite = (r: SqlRow): InviteRow => ({
  id: str(r["id"]),
  device: str(r["device"]),
  exp: num(r["exp"]),
  pinSeq: num(r["pinSeq"]),
  joiner: strOrNull(r["joiner"]),
});
const toRoster = (r: SqlRow): RosterRow => ({ seq: num(r["seq"]), hash: str(r["hash"]), json: str(r["json"]) });
const toJoin = (r: SqlRow): JoinRow => ({ invite: str(r["invite"]), device: str(r["device"]), body: str(r["body"]), exp: num(r["exp"]) });
const toIdle = (r: SqlRow): IdleRow => ({ sub: str(r["sub"]), target: str(r["target"]), exp: num(r["exp"]) });
const toHistory = (r: SqlRow): HistoryRow => ({ room: str(r["room"]), cur: num(r["cur"]), at: num(r["at"]), msg: str(r["msg"]) });
const toLease = (r: SqlRow): LeaseRow => ({
  key: str(r["lkey"]),
  holder: str(r["holder"]),
  token: num(r["token"]),
  until: num(r["until"]),
  granted: num(r["granted"]),
});
const LEASE_COLS = "lkey, holder, token, until, granted";
const toWaiter = (r: SqlRow): WaiterRow => ({
  key: str(r["lkey"]),
  sid: str(r["sid"]),
  ttl: num(r["ttl"]),
  exp: num(r["exp"]),
  seq: num(r["seq"]),
});
const toWatch = (r: SqlRow): WatchRow => ({ key: str(r["lkey"]), sid: str(r["sid"]), exp: num(r["exp"]) });
const toChunk = (r: SqlRow): ChunkRow => ({
  blob: str(r["blob"]),
  idx: num(r["idx"]),
  last: num(r["last"]) === 1,
  n: str(r["n"]),
  data: str(r["data"]),
  bytes: num(r["bytes"]),
  device: str(r["device"]),
  at: num(r["at"]),
});

const SESSION_COLS = "sid, device, name, kind, status, since, conn, ended, resume, acked, delivered, nextCursor";
const ITEM_COLS = "sid, cur, id, fromDevice, queuedAt, bytes, msg";
const INVITE_COLS = "id, device, exp, pinSeq, joiner";
const WAITER_COLS = "lkey, sid, ttl, exp, rowid AS seq";

/**
 * A `MeshStore` for one mesh on a SQL database shared by many meshes. Call `migrate(db)` once
 * before constructing any.
 */
export class SqlStore implements MeshStore {
  private readonly db: SqlDb;
  private readonly mesh: string;

  constructor(db: SqlDb, mesh: string) {
    this.db = db;
    this.mesh = mesh;
  }

  // Every statement is scoped to this mesh, which is always its first parameter.
  private run(sql: string, ...params: SqlValue[]): void {
    this.db.exec(sql, this.mesh, ...params);
  }

  private all(sql: string, ...params: SqlValue[]): SqlRow[] {
    return this.db.all(sql, this.mesh, ...params);
  }

  private one(sql: string, ...params: SqlValue[]): SqlRow | undefined {
    return this.db.one(sql, this.mesh, ...params);
  }

  private count(sql: string, ...params: SqlValue[]): number {
    return num(this.one(sql, ...params)!["n"]);
  }

  rosterHead(): number {
    return this.count("SELECT COALESCE(MAX(seq), 0) AS n FROM rosters WHERE mesh = ?");
  }

  getRoster(seq: number): RosterRow | undefined {
    const r = this.one("SELECT seq, hash, json FROM rosters WHERE mesh = ? AND seq = ?", seq);
    return r && toRoster(r);
  }

  rosterRange(from: number, limit: number): RosterRow[] {
    return this.all("SELECT seq, hash, json FROM rosters WHERE mesh = ? AND seq >= ? ORDER BY seq LIMIT ?", from, limit).map(toRoster);
  }

  insertRoster(row: RosterRow): boolean {
    const before = this.rosterCountAt(row.seq);
    this.run("INSERT OR IGNORE INTO rosters (mesh, seq, hash, json) VALUES (?, ?, ?, ?)", row.seq, row.hash, row.json);
    return this.rosterCountAt(row.seq) > before;
  }

  private rosterCountAt(seq: number): number {
    return this.count("SELECT COUNT(*) AS n FROM rosters WHERE mesh = ? AND seq = ?", seq);
  }

  addFork(row: ForkRow): void {
    this.run("INSERT INTO forks (mesh, at, seq, kind, signer, a, b) VALUES (?, ?, ?, ?, ?, ?, ?)", row.at, row.seq, row.kind, row.signer, row.a, row.b);
  }

  forks(): ForkRow[] {
    return this.all("SELECT at, seq, kind, signer, a, b FROM forks WHERE mesh = ? ORDER BY rowid").map((r) => ({
      at: num(r["at"]),
      seq: num(r["seq"]),
      kind: str(r["kind"]) as ForkRow["kind"],
      signer: str(r["signer"]),
      a: str(r["a"]),
      b: str(r["b"]),
    }));
  }

  getInvite(id: string): InviteRow | undefined {
    const r = this.one(`SELECT ${INVITE_COLS} FROM invites WHERE mesh = ? AND id = ?`, id);
    return r && toInvite(r);
  }

  putInvite(row: InviteRow): void {
    this.run(
      `INSERT INTO invites (mesh, ${INVITE_COLS}) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (mesh, id) DO UPDATE SET
       device = excluded.device, exp = excluded.exp, pinSeq = excluded.pinSeq, joiner = excluded.joiner`,
      row.id,
      row.device,
      row.exp,
      row.pinSeq,
      row.joiner,
    );
  }

  deleteInvite(id: string): void {
    this.run("DELETE FROM invites WHERE mesh = ? AND id = ?", id);
  }

  liveInviteCount(device: string, now: number): number {
    return this.count("SELECT COUNT(*) AS n FROM invites WHERE mesh = ? AND device = ? AND joiner IS NULL AND exp > ?", device, now);
  }

  expiredInvites(now: number): InviteRow[] {
    return this.all(`SELECT ${INVITE_COLS} FROM invites WHERE mesh = ? AND exp <= ? ORDER BY exp`, now).map(toInvite);
  }

  invitesBy(device: string): InviteRow[] {
    return this.all(`SELECT ${INVITE_COLS} FROM invites WHERE mesh = ? AND device = ?`, device).map(toInvite);
  }

  getJoin(invite: string): JoinRow | undefined {
    const r = this.one("SELECT invite, device, body, exp FROM joins WHERE mesh = ? AND invite = ?", invite);
    return r && toJoin(r);
  }

  putJoin(row: JoinRow): void {
    this.run(
      `INSERT INTO joins (mesh, invite, device, body, exp) VALUES (?, ?, ?, ?, ?) ON CONFLICT (mesh, invite) DO UPDATE SET
       device = excluded.device, body = excluded.body, exp = excluded.exp`,
      row.invite,
      row.device,
      row.body,
      row.exp,
    );
  }

  deleteJoin(invite: string): void {
    this.run("DELETE FROM joins WHERE mesh = ? AND invite = ?", invite);
  }

  joins(): JoinRow[] {
    return this.all("SELECT invite, device, body, exp FROM joins WHERE mesh = ? ORDER BY exp").map(toJoin);
  }

  getSession(sid: string): SessionRow | undefined {
    const r = this.one(`SELECT ${SESSION_COLS} FROM sessions WHERE mesh = ? AND sid = ?`, sid);
    return r && toSession(r);
  }

  putSession(s: SessionRow): void {
    this.run(
      `INSERT INTO sessions (mesh, ${SESSION_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (mesh, sid) DO UPDATE SET
       device = excluded.device, name = excluded.name, kind = excluded.kind, status = excluded.status,
       since = excluded.since, conn = excluded.conn, ended = excluded.ended, resume = excluded.resume,
       acked = excluded.acked, delivered = excluded.delivered, nextCursor = excluded.nextCursor`,
      s.sid,
      s.device,
      s.name,
      s.kind,
      s.status,
      s.since,
      s.conn,
      s.ended,
      s.resume,
      s.acked,
      s.delivered,
      s.nextCursor,
    );
  }

  deleteSession(sid: string): void {
    this.run("DELETE FROM sessions WHERE mesh = ? AND sid = ?", sid);
    this.run("DELETE FROM queue WHERE mesh = ? AND sid = ?", sid);
    this.run("DELETE FROM idle WHERE mesh = ? AND (sub = ? OR target = ?)", sid, sid);
    this.run("DELETE FROM room_members WHERE mesh = ? AND sid = ?", sid);
    this.run("DELETE FROM leases WHERE mesh = ? AND holder = ?", sid);
    this.run("DELETE FROM lease_waiters WHERE mesh = ? AND sid = ?", sid);
    this.run("DELETE FROM lease_watches WHERE mesh = ? AND sid = ?", sid);
    this.deleteCard(sid);
  }

  sessions(): SessionRow[] {
    return this.all(`SELECT ${SESSION_COLS} FROM sessions WHERE mesh = ? ORDER BY sid`).map(toSession);
  }

  sessionsOf(device: string): SessionRow[] {
    return this.all(`SELECT ${SESSION_COLS} FROM sessions WHERE mesh = ? AND device = ? ORDER BY sid`, device).map(toSession);
  }

  rekeySession(from: string, to: string): void {
    // Parameters after the mesh: the new sid, then the old one.
    const moves = [
      "UPDATE sessions SET sid = ?2 WHERE mesh = ?1 AND sid = ?3",
      "UPDATE queue SET sid = ?2 WHERE mesh = ?1 AND sid = ?3",
      "UPDATE messages SET sender = ?2 WHERE mesh = ?1 AND sender = ?3",
      "UPDATE message_rcpts SET sid = ?2 WHERE mesh = ?1 AND sid = ?3",
      "UPDATE idle SET sub = ?2 WHERE mesh = ?1 AND sub = ?3",
      "UPDATE idle SET target = ?2 WHERE mesh = ?1 AND target = ?3",
      "UPDATE room_members SET sid = ?2 WHERE mesh = ?1 AND sid = ?3",
      "UPDATE leases SET holder = ?2 WHERE mesh = ?1 AND holder = ?3",
      "UPDATE lease_waiters SET sid = ?2 WHERE mesh = ?1 AND sid = ?3",
      "UPDATE lease_watches SET sid = ?2 WHERE mesh = ?1 AND sid = ?3",
      "UPDATE cards SET sid = ?2 WHERE mesh = ?1 AND sid = ?3",
    ];
    for (const sql of moves) this.run(sql, to, from);
  }

  enqueue(item: QueueItem): void {
    this.run(
      `INSERT INTO queue (mesh, ${ITEM_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      item.sid,
      item.cur,
      item.id,
      item.fromDevice,
      item.queuedAt,
      item.bytes,
      item.msg,
    );
  }

  queue(sid: string, after: number): QueueItem[] {
    return this.all(`SELECT ${ITEM_COLS} FROM queue WHERE mesh = ? AND sid = ? AND cur > ? ORDER BY cur`, sid, after).map(toItem);
  }

  queueCount(sid: string): number {
    return this.count("SELECT COUNT(*) AS n FROM queue WHERE mesh = ? AND sid = ?", sid);
  }

  queueCountFrom(sid: string, fromDevice: string): number {
    return this.count("SELECT COUNT(*) AS n FROM queue WHERE mesh = ? AND sid = ? AND fromDevice = ?", sid, fromDevice);
  }

  dequeueThrough(sid: string, cur: number): void {
    this.run("DELETE FROM queue WHERE mesh = ? AND sid = ? AND cur <= ?", sid, cur);
  }

  expiredQueue(before: number): QueueItem[] {
    return this.all(`SELECT ${ITEM_COLS} FROM queue WHERE mesh = ? AND queuedAt <= ? ORDER BY queuedAt, rowid`, before).map(toItem);
  }

  dropQueueItem(sid: string, cur: number): void {
    this.run("DELETE FROM queue WHERE mesh = ? AND sid = ? AND cur = ?", sid, cur);
  }

  dropQueueFrom(device: string): void {
    this.run("DELETE FROM queue WHERE mesh = ? AND fromDevice = ?", device);
  }

  putMessage(row: MessageRow): void {
    this.run(
      "INSERT INTO messages (mesh, id, sender, at) VALUES (?, ?, ?, ?) ON CONFLICT (mesh, id) DO UPDATE SET sender = excluded.sender, at = excluded.at",
      row.id,
      row.sender,
      row.at,
    );
    this.run("DELETE FROM message_rcpts WHERE mesh = ? AND id = ?", row.id);
    for (const sid of row.rcpts) this.run("INSERT OR IGNORE INTO message_rcpts (mesh, id, sid) VALUES (?, ?, ?)", row.id, sid);
  }

  getMessage(id: string): MessageRow | undefined {
    const r = this.one("SELECT id, sender, at FROM messages WHERE mesh = ? AND id = ?", id);
    if (r === undefined) return undefined;
    const rcpts = this.all("SELECT sid FROM message_rcpts WHERE mesh = ? AND id = ? ORDER BY rowid", id).map((x) => str(x["sid"]));
    return { id: str(r["id"]), sender: str(r["sender"]), at: num(r["at"]), rcpts };
  }

  pruneMessages(before: number): void {
    this.run("DELETE FROM message_rcpts WHERE mesh = ?1 AND id IN (SELECT id FROM messages WHERE mesh = ?1 AND at <= ?2)", before);
    this.run("DELETE FROM messages WHERE mesh = ? AND at <= ?", before);
  }

  putIdle(row: IdleRow): void {
    this.run(
      "INSERT INTO idle (mesh, sub, target, exp) VALUES (?, ?, ?, ?) ON CONFLICT (mesh, sub, target) DO UPDATE SET exp = excluded.exp",
      row.sub,
      row.target,
      row.exp,
    );
  }

  idleFor(target: string): IdleRow[] {
    return this.all("SELECT sub, target, exp FROM idle WHERE mesh = ? AND target = ? ORDER BY sub", target).map(toIdle);
  }

  idleCount(sub: string): number {
    return this.count("SELECT COUNT(*) AS n FROM idle WHERE mesh = ? AND sub = ?", sub);
  }

  deleteIdle(sub: string, target: string): void {
    this.run("DELETE FROM idle WHERE mesh = ? AND sub = ? AND target = ?", sub, target);
  }

  pruneIdle(now: number): void {
    this.run("DELETE FROM idle WHERE mesh = ? AND exp <= ?", now);
  }

  getBucket(bkey: string): BucketRow | undefined {
    const r = this.one("SELECT bkey, tokens, at FROM buckets WHERE mesh = ? AND bkey = ?", bkey);
    return r && { bkey: str(r["bkey"]), tokens: num(r["tokens"]), at: num(r["at"]) };
  }

  putBucket(row: BucketRow): void {
    this.run(
      "INSERT INTO buckets (mesh, bkey, tokens, at) VALUES (?, ?, ?, ?) ON CONFLICT (mesh, bkey) DO UPDATE SET tokens = excluded.tokens, at = excluded.at",
      row.bkey,
      row.tokens,
      row.at,
    );
  }

  pruneBuckets(before: number): void {
    this.run("DELETE FROM buckets WHERE mesh = ? AND at <= ?", before);
  }

  getRoom(room: string): RoomRow | undefined {
    const r = this.one("SELECT room, created, nextCursor FROM rooms WHERE mesh = ? AND room = ?", room);
    return r && { room: str(r["room"]), created: num(r["created"]), nextCursor: num(r["nextCursor"]) };
  }

  putRoom(row: RoomRow): void {
    this.run(
      "INSERT INTO rooms (mesh, room, created, nextCursor) VALUES (?, ?, ?, ?) ON CONFLICT (mesh, room) DO UPDATE SET created = excluded.created, nextCursor = excluded.nextCursor",
      row.room,
      row.created,
      row.nextCursor,
    );
  }

  roomCount(): number {
    return this.count("SELECT COUNT(*) AS n FROM rooms WHERE mesh = ?");
  }

  pruneRooms(): void {
    this.run(
      `DELETE FROM rooms WHERE mesh = ?1
       AND NOT EXISTS (SELECT 1 FROM room_members m WHERE m.mesh = ?1 AND m.room = rooms.room)
       AND NOT EXISTS (SELECT 1 FROM room_history h WHERE h.mesh = ?1 AND h.room = rooms.room)`,
    );
  }

  members(room: string): string[] {
    return this.all("SELECT sid FROM room_members WHERE mesh = ? AND room = ? ORDER BY rowid", room).map((r) => str(r["sid"]));
  }

  roomsOf(sid: string): string[] {
    return this.all("SELECT room FROM room_members WHERE mesh = ? AND sid = ? ORDER BY room", sid).map((r) => str(r["room"]));
  }

  addMember(room: string, sid: string): void {
    this.run("INSERT OR IGNORE INTO room_members (mesh, room, sid) VALUES (?, ?, ?)", room, sid);
  }

  removeMember(room: string, sid: string): void {
    this.run("DELETE FROM room_members WHERE mesh = ? AND room = ? AND sid = ?", room, sid);
  }

  addHistory(row: HistoryRow, keep: number): void {
    this.run("INSERT INTO room_history (mesh, room, cur, at, msg) VALUES (?, ?, ?, ?, ?)", row.room, row.cur, row.at, row.msg);
    this.run(
      `DELETE FROM room_history WHERE mesh = ?1 AND room = ?2 AND cur NOT IN
       (SELECT cur FROM room_history WHERE mesh = ?1 AND room = ?2 ORDER BY cur DESC LIMIT ?3)`,
      row.room,
      keep,
    );
  }

  history(room: string, before: number, limit: number): HistoryRow[] {
    return this.all(
      "SELECT room, cur, at, msg FROM room_history WHERE mesh = ? AND room = ? AND cur < ? ORDER BY cur DESC LIMIT ?",
      room,
      before,
      limit,
    ).map(toHistory);
  }

  pruneHistory(before: number): void {
    this.run("DELETE FROM room_history WHERE mesh = ? AND at <= ?", before);
  }

  historyBytes(): number {
    return this.count("SELECT COALESCE(SUM(LENGTH(msg)), 0) AS n FROM room_history WHERE mesh = ?");
  }

  dropOldestHistory(): void {
    this.run("DELETE FROM room_history WHERE mesh = ?1 AND rowid = (SELECT rowid FROM room_history WHERE mesh = ?1 ORDER BY at, rowid LIMIT 1)");
  }

  getLease(key: string): LeaseRow | undefined {
    const r = this.one(`SELECT ${LEASE_COLS} FROM leases WHERE mesh = ? AND lkey = ?`, key);
    return r && toLease(r);
  }

  putLease(row: LeaseRow): void {
    this.run(
      `INSERT INTO leases (mesh, ${LEASE_COLS}) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (mesh, lkey) DO UPDATE SET
       holder = excluded.holder, token = excluded.token, until = excluded.until, granted = excluded.granted`,
      row.key,
      row.holder,
      row.token,
      row.until,
      row.granted,
    );
  }

  deleteLease(key: string): void {
    this.run("DELETE FROM leases WHERE mesh = ? AND lkey = ?", key);
  }

  leases(): LeaseRow[] {
    return this.all(`SELECT ${LEASE_COLS} FROM leases WHERE mesh = ? ORDER BY lkey`).map(toLease);
  }

  leasesHeldBy(sid: string): number {
    return this.count("SELECT COUNT(*) AS n FROM leases WHERE mesh = ? AND holder = ?", sid);
  }

  expiredLeases(now: number): LeaseRow[] {
    return this.all(`SELECT ${LEASE_COLS} FROM leases WHERE mesh = ? AND until <= ? ORDER BY until`, now).map(toLease);
  }

  nextToken(): number {
    this.run("INSERT INTO counters (mesh, name, v) VALUES (?, 'lease', 1) ON CONFLICT (mesh, name) DO UPDATE SET v = v + 1");
    return this.count("SELECT v AS n FROM counters WHERE mesh = ? AND name = 'lease'");
  }

  addWaiter(row: Omit<WaiterRow, "seq">): void {
    this.run("INSERT OR IGNORE INTO lease_waiters (mesh, lkey, sid, ttl, exp) VALUES (?, ?, ?, ?, ?)", row.key, row.sid, row.ttl, row.exp);
  }

  waiters(key: string): WaiterRow[] {
    return this.all(`SELECT ${WAITER_COLS} FROM lease_waiters WHERE mesh = ? AND lkey = ? ORDER BY rowid`, key).map(toWaiter);
  }

  deleteWaiter(key: string, sid: string): void {
    this.run("DELETE FROM lease_waiters WHERE mesh = ? AND lkey = ? AND sid = ?", key, sid);
  }

  waitsBy(sid: string): number {
    return this.count("SELECT COUNT(*) AS n FROM lease_waiters WHERE mesh = ? AND sid = ?", sid);
  }

  expiredWaiters(now: number): WaiterRow[] {
    return this.all(`SELECT ${WAITER_COLS} FROM lease_waiters WHERE mesh = ? AND exp <= ? ORDER BY rowid`, now).map(toWaiter);
  }

  putWatch(row: WatchRow): void {
    this.run(
      "INSERT INTO lease_watches (mesh, lkey, sid, exp) VALUES (?, ?, ?, ?) ON CONFLICT (mesh, lkey, sid) DO UPDATE SET exp = excluded.exp",
      row.key,
      row.sid,
      row.exp,
    );
  }

  watchesFor(key: string): WatchRow[] {
    return this.all("SELECT lkey, sid, exp FROM lease_watches WHERE mesh = ? AND lkey = ? ORDER BY rowid", key).map(toWatch);
  }

  watchesBy(sid: string): number {
    return this.count("SELECT COUNT(*) AS n FROM lease_watches WHERE mesh = ? AND sid = ?", sid);
  }

  deleteWatch(key: string, sid: string): void {
    this.run("DELETE FROM lease_watches WHERE mesh = ? AND lkey = ? AND sid = ?", key, sid);
  }

  pruneWatches(now: number): void {
    this.run("DELETE FROM lease_watches WHERE mesh = ? AND exp <= ?", now);
  }

  getChunk(blob: string, idx: number): ChunkRow | undefined {
    const r = this.one("SELECT blob, idx, last, n, data, bytes, device, at FROM chunks WHERE mesh = ? AND blob = ? AND idx = ?", blob, idx);
    return r && toChunk(r);
  }

  putChunk(row: ChunkRow): void {
    this.run(
      `INSERT INTO chunks (mesh, blob, idx, last, n, data, bytes, device, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (mesh, blob, idx) DO UPDATE SET last = excluded.last, n = excluded.n, data = excluded.data,
       bytes = excluded.bytes, device = excluded.device, at = excluded.at`,
      row.blob,
      row.idx,
      row.last ? 1 : 0,
      row.n,
      row.data,
      row.bytes,
      row.device,
      row.at,
    );
  }

  blobBytes(): number {
    return this.count("SELECT COALESCE(SUM(bytes), 0) AS n FROM chunks WHERE mesh = ?");
  }

  pruneChunks(before: number): void {
    this.run("DELETE FROM chunks WHERE mesh = ? AND at <= ?", before);
  }

  dropChunksFrom(device: string): void {
    this.run("DELETE FROM chunks WHERE mesh = ? AND device = ?", device);
  }

  putCard(sid: string, msg: string): void {
    this.run("INSERT INTO cards (mesh, sid, msg) VALUES (?, ?, ?) ON CONFLICT (mesh, sid) DO UPDATE SET msg = excluded.msg", sid, msg);
  }

  deleteCard(sid: string): void {
    this.run("DELETE FROM cards WHERE mesh = ? AND sid = ?", sid);
  }

  cards(): { sid: string; msg: string }[] {
    return this.all("SELECT sid, msg FROM cards WHERE mesh = ? ORDER BY sid").map((r) => ({ sid: str(r["sid"]), msg: str(r["msg"]) }));
  }
}
