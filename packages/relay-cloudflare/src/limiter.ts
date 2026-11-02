import { DurableObject } from "cloudflare:workers";
import { LIMITS } from "@worldinmotion/protocol";
import type { Env } from "./config.ts";

const HOUR = 3_600_000;

/**
 * The pre-auth limit for one source address, spent by `create`, `join` and recovery `auth` and
 * shared by every mesh (SPEC section 9: 10 an hour per source address). A new mesh id is a new mesh Durable Object, so a limit kept in
 * one mesh's storage could not stop one address creating many meshes; relay-node keeps one
 * limiter for its whole process, and this is the same token bucket with one object per address,
 * named by the hashed address (never the raw one).
 *
 * The bucket refills completely within an hour, so an alarm an hour after the last use deletes it:
 * an idle address leaves nothing behind.
 */
export class SourceLimiter extends DurableObject<Env> {
  /** Spends one token if one is left. Returns whether the request may proceed. */
  take(): boolean {
    const perHour = LIMITS.createJoinPerSourcePerHour;
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS bucket (id INTEGER PRIMARY KEY CHECK (id = 0), tokens REAL NOT NULL, at INTEGER NOT NULL)");
    const now = Date.now();
    const row = sql.exec<{ tokens: number; at: number }>("SELECT tokens, at FROM bucket WHERE id = 0").toArray()[0];
    const tokens = row === undefined ? perHour : Math.min(perHour, row.tokens + ((now - row.at) * perHour) / HOUR);
    if (tokens < 1) return false;
    sql.exec("INSERT INTO bucket (id, tokens, at) VALUES (0, ?, ?) ON CONFLICT (id) DO UPDATE SET tokens = excluded.tokens, at = excluded.at", tokens - 1, now);
    // Not awaited: a Durable Object orders its own storage writes, and the output gate holds the
    // answer until they are durable.
    void this.ctx.storage.setAlarm(now + HOUR);
    return true;
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
