import { DurableObject } from "cloudflare:workers";
import { b64u, randomBytes } from "@worldinmotion/protocol";
import type { Env } from "./config.ts";

/** The registry object's name: there is one for the whole Worker. */
export const REGISTRY_NAME = "registry";

/**
 * How many meshes the relay holds, for the `WIM_MAX_MESHES` cap. A mesh object calls it only on
 * a `create` (`reserve` first, `release` if that create then fails) and when it deletes an
 * expired mesh (`release`), never per message. It counts meshes created since it was added; a
 * mesh created by an earlier version is not counted, and the count never goes below zero.
 *
 * It also keeps the relay's secret for source keys (`sourceSecret`), which each Worker isolate
 * reads once.
 */
export class MeshRegistry extends DurableObject<Env> {
  private count(): number {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS meshes (id INTEGER PRIMARY KEY CHECK (id = 0), n INTEGER NOT NULL)");
    const row = sql.exec<{ n: number }>("SELECT n FROM meshes WHERE id = 0").toArray()[0];
    return row === undefined ? 0 : row.n;
  }

  private set(n: number): void {
    this.ctx.storage.sql.exec("INSERT INTO meshes (id, n) VALUES (0, ?) ON CONFLICT (id) DO UPDATE SET n = excluded.n", n);
  }

  /** Counts one more mesh if fewer than `max` are held (`null`: no cap). Returns whether it did. */
  reserve(max: number | null): boolean {
    const n = this.count();
    if (max !== null && n >= max) return false;
    this.set(n + 1);
    return true;
  }

  /**
   * The secret source keys are made under: 32 random bytes (base64url), made on first use and
   * kept for good, so every isolate keys an address the same way and no operator has to set one.
   */
  sourceSecret(): string {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS secrets (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    sql.exec("INSERT INTO secrets (k, v) VALUES ('source', ?) ON CONFLICT (k) DO NOTHING", b64u.encode(randomBytes(32)));
    return sql.exec<{ v: string }>("SELECT v FROM secrets WHERE k = 'source'").one().v;
  }

  /** One mesh fewer: a reservation that did not create, or a mesh that was deleted. */
  release(): void {
    this.set(Math.max(0, this.count() - 1));
  }
}
