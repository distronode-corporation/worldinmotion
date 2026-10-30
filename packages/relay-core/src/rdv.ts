import { LIMITS } from "@worldinmotion/protocol";
import type { Limits } from "./relay.ts";
import type { SqlDb } from "./sql-store.ts";

const HOUR = 3_600_000;

/** A checked `rdv.put` (SPEC section 5), as `MeshRelay` hands it to the host. */
export type RdvPut = { rdv: string; exp: number; n: string; c: string; source: string };

/** What the store did with a put. Anything but `stored` reaches the client as an `error`. */
export type RdvOutcome = "stored" | "exists" | "limited" | "full" | "unavailable";

/** The answer to `GET <relay>/v1/rdv/<rdv>`, as a host sends it. */
export type RdvGetAnswer =
  | { status: 200; body: { v: 1; rdv: string; exp: number; n: string; c: string } }
  | { status: 404 | 429; body: { error: string } };

/**
 * The relay-wide store behind short invite codes (SPEC section 5): boxes the admin devices of any
 * mesh put, fetched by lookup id with no mesh id, so it cannot live in a mesh's own shard.
 * relay-node keeps one over its database; relay-cloudflare keeps one in a Durable Object of its
 * own. Like `MeshRelay` it has no I/O and no clock: the host passes `now`.
 *
 * A box lives until its `exp` (at most an hour; `MeshRelay` checks that) and is deleted with its
 * last allowed fetch. Puts and fetches are rate limited per source address, and the relay holds
 * a bounded number of boxes in all. The store keeps the box, its expiry and its fetch count, and
 * nothing about which mesh or device put it.
 */
export class Rendezvous {
  readonly limits: Limits;
  private readonly db: SqlDb;

  constructor(db: SqlDb, limits: Partial<Limits> = {}) {
    this.db = db;
    this.limits = { ...LIMITS, ...limits };
    db.exec("CREATE TABLE IF NOT EXISTS rdv (id TEXT PRIMARY KEY, exp INTEGER NOT NULL, n TEXT NOT NULL, c TEXT NOT NULL, gets INTEGER NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS rdv_buckets (k TEXT PRIMARY KEY, tokens REAL NOT NULL, at INTEGER NOT NULL)");
  }

  /** Stores a box, unless its source is over its rate, the relay is full, or the id is taken. */
  put(p: RdvPut, now: number): RdvOutcome {
    const L = this.limits;
    if (!this.take(`put:${p.source}`, L.rdvPutsPerSourcePerHour, now)) return "limited";
    if (Number(this.db.one("SELECT COUNT(*) AS n FROM rdv WHERE exp > ?", now)!["n"]) >= L.rdvBoxesPerRelay) return "full";
    if (this.db.one("SELECT id FROM rdv WHERE id = ? AND exp > ?", p.rdv, now) !== undefined) return "exists";
    // An expired box the sweep has not reached yet is replaced.
    this.db.exec(
      "INSERT INTO rdv (id, exp, n, c, gets) VALUES (?, ?, ?, ?, 0) ON CONFLICT (id) DO UPDATE SET exp = excluded.exp, n = excluded.n, c = excluded.c, gets = 0",
      p.rdv,
      p.exp,
      p.n,
      p.c,
    );
    return "stored";
  }

  /**
   * Hands out a live box, counting the fetch and deleting the box with the last one allowed. Every
   * fetch, found or not, spends from its source's hourly budget first.
   */
  get(rdv: string, source: string, now: number): RdvGetAnswer {
    if (!this.take(`get:${source}`, this.limits.rdvGetsPerSourcePerHour, now)) return { status: 429, body: { error: "too many requests from this address; try again later" } };
    const row = this.db.one("SELECT exp, n, c, gets FROM rdv WHERE id = ? AND exp > ?", rdv, now);
    if (row === undefined) return { status: 404, body: { error: "not found" } };
    const gets = Number(row["gets"]) + 1;
    if (gets >= this.limits.rdvGetsPerBox) this.db.exec("DELETE FROM rdv WHERE id = ?", rdv);
    else this.db.exec("UPDATE rdv SET gets = ? WHERE id = ?", gets, rdv);
    return { status: 200, body: { v: 1, rdv, exp: Number(row["exp"]), n: String(row["n"]), c: String(row["c"]) } };
  }

  /** Deletes expired boxes, and buckets unused for an hour (they have refilled by then). */
  sweep(now: number): void {
    this.db.exec("DELETE FROM rdv WHERE exp <= ?", now);
    this.db.exec("DELETE FROM rdv_buckets WHERE at <= ?", now - HOUR);
  }

  /** The first time `sweep` has something to delete, or undefined when the store is empty. */
  nextDue(): number | undefined {
    const box = this.db.one("SELECT MIN(exp) AS due FROM rdv")!["due"]!;
    const bucket = this.db.one("SELECT MIN(at) + ? AS due FROM rdv_buckets", HOUR)!["due"]!;
    // MIN over no rows is NULL, and NULL plus a number stays NULL.
    const dues = [box, bucket].filter((v) => v !== null).map(Number);
    return dues.length === 0 ? undefined : Math.min(...dues);
  }

  /** Spends one token of an hourly bucket (full when unused). Returns whether one was left. */
  private take(key: string, perHour: number, now: number): boolean {
    const row = this.db.one("SELECT tokens, at FROM rdv_buckets WHERE k = ?", key);
    const tokens = row === undefined ? perHour : Math.min(perHour, Number(row["tokens"]) + ((now - Number(row["at"])) * perHour) / HOUR);
    if (tokens < 1) return false;
    this.db.exec("INSERT INTO rdv_buckets (k, tokens, at) VALUES (?, ?, ?) ON CONFLICT (k) DO UPDATE SET tokens = excluded.tokens, at = excluded.at", key, tokens - 1, now);
    return true;
  }
}
