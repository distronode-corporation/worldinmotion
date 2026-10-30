import { DurableObject } from "cloudflare:workers";
import { Rendezvous, type RdvGetAnswer, type RdvOutcome, type RdvPut } from "@worldinmotion/relay-core";
import type { Env } from "./config.ts";
import { doSqlDb } from "./sql.ts";

/** The rendezvous object's name: there is one for the whole Worker. */
export const RDV_NAME = "rdv";

/** The soonest the sweep alarm is set after now. */
const MIN_SWEEP_MS = 1_000;

/**
 * The relay-wide store for short invite codes (SPEC section 5): relay-core's `Rendezvous` over this
 * object's SQLite. Each mesh lives in its own object, and a joiner fetches a box with no mesh id,
 * so the boxes of every mesh live here, in one object for the whole Worker as `MeshRegistry` is.
 * A mesh object calls `put` for an admin's `rdv.put`; the Worker calls `get` for
 * `GET <prefix>/v1/rdv/<id>`. Both are rare (a few per added device), so one object is plenty.
 * The alarm deletes expired boxes and idle rate buckets, and is set for the next one due.
 */
export class RendezvousStore extends DurableObject<Env> {
  private readonly store: Rendezvous;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Rendezvous(doSqlDb(ctx.storage.sql));
  }

  put(put: RdvPut): RdvOutcome {
    const outcome = this.store.put(put, Date.now());
    this.arm();
    return outcome;
  }

  get(rdv: string, source: string): RdvGetAnswer {
    const answer = this.store.get(rdv, source, Date.now());
    this.arm();
    return answer;
  }

  override alarm(): void {
    this.store.sweep(Date.now());
    this.arm();
  }

  /**
   * Sets the alarm for the next thing the sweep will delete; with nothing held, none is set (a
   * running alarm is cleared by the runtime once it returns). Not awaited: a Durable Object orders
   * its own storage writes, and the output gate holds the answer until they are durable.
   */
  private arm(): void {
    const due = this.store.nextDue();
    if (due !== undefined) void this.ctx.storage.setAlarm(Math.max(due, Date.now() + MIN_SWEEP_MS));
  }
}
