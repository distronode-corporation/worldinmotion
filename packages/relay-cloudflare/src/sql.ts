import type { Limits, SqlDb, SqlValue } from "@worldinmotion/relay-core";

type Row = Record<string, SqlValue>;

/**
 * Durable Object SQLite behind relay-core's minimal synchronous SQL surface. `exec` runs one
 * statement and drops its cursor, `all` reads every row, `one` the first row or undefined (the
 * cursor's own `one()` throws unless exactly one row matches, which is not the contract).
 *
 * relay-core never stores blobs, so no column holds an ArrayBuffer and the narrowing to
 * `SqlValue` is exact.
 */
export function doSqlDb(sql: SqlStorage): SqlDb {
  return {
    exec: (query, ...params) => void sql.exec(query, ...params),
    all: (query, ...params) => sql.exec<Row>(query, ...params).toArray(),
    one: (query, ...params) => sql.exec<Row>(query, ...params).toArray()[0],
  };
}

const DAY = 86_400_000;

/**
 * When the relay's next store-held expiry falls due, or undefined when nothing in the store
 * expires. Each line mirrors one sweep in `MeshRelay.tick`, which deletes rows "at or before" a
 * cutoff, so a due time here is the first moment that sweep removes something.
 *
 * This reads relay-core's tables directly because `MeshStore` has no "next due" query. A table
 * relay-core adds later that this list misses is still swept, on the heartbeat while sockets are
 * open and on the first tick after one connects; it only waits longer while the mesh is idle.
 */
export function nextStoreDue(db: SqlDb, mesh: string, L: Limits): number | undefined {
  const Q = L.queueLifetimeMs;
  const queries: [string, ...SqlValue[]][] = [
    // A tombstone is deleted a queue lifetime after `bye`.
    ["SELECT MIN(ended) + ? AS due FROM sessions WHERE mesh = ? AND ended IS NOT NULL", Q, mesh],
    // An abandoned session goes once it has been offline a queue lifetime and its queue is empty,
    // so it is due no earlier than its newest queued item's expiry.
    [
      `SELECT MIN(MAX(s.since, COALESCE((SELECT MAX(q.queuedAt) FROM queue q WHERE q.mesh = s.mesh AND q.sid = s.sid), 0))) + ? AS due
        FROM sessions s WHERE s.mesh = ? AND s.ended IS NULL AND s.conn IS NULL`,
      Q,
      mesh,
    ],
    ["SELECT MIN(queuedAt) + ? AS due FROM queue WHERE mesh = ?", Q, mesh],
    ["SELECT MIN(at) + ? AS due FROM messages WHERE mesh = ?", Q, mesh],
    ["SELECT MIN(exp) AS due FROM idle WHERE mesh = ?", mesh],
    ["SELECT MIN(exp) AS due FROM invites WHERE mesh = ?", mesh],
    ["SELECT MIN(exp) AS due FROM lease_waiters WHERE mesh = ?", mesh],
    ["SELECT MIN(until) AS due FROM leases WHERE mesh = ?", mesh],
    ["SELECT MIN(exp) AS due FROM lease_watches WHERE mesh = ?", mesh],
    ["SELECT MIN(at) + ? AS due FROM room_history WHERE mesh = ?", L.roomHistoryLifetimeMs, mesh],
    ["SELECT MIN(at) + ? AS due FROM chunks WHERE mesh = ?", L.blobLifetimeMs, mesh],
    // Buckets are pruned a day after their last use (the slowest one refills within a day).
    ["SELECT MIN(at) + ? AS due FROM buckets WHERE mesh = ?", DAY, mesh],
  ];
  let due: number | undefined;
  for (const [query, ...params] of queries) {
    // MIN over no rows is NULL, and NULL plus a number stays NULL.
    const v = db.one(query, ...params)!["due"]!;
    if (v !== null && (due === undefined || Number(v) < due)) due = Number(v);
  }
  return due;
}
