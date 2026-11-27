// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

// Durable replay state shared by every session of one device (SPEC section 6, dedupe and seq):
// accepted message ids per receiving session until they can no longer be fresh, and the highest
// seq per sender session per receiving session.
//
// A receiving session is keyed by its session id (`receiverKey`), which the client chose and
// keeps across restarts and renames. Never by its address: the name in it is the one the relay
// assigned (`ready.name`, unsigned), so a relay that handed out another name, or a rename, would
// otherwise start an empty store and the same signed message would be accepted again while it is
// still fresh. Older clients keyed by address; `migrate` carries their entries over.

import { LIMITS, SeqTracker } from "@worldinmotion/protocol";
import { readJson, withLock, writeJson, type FsEnv } from "./fsx.ts";

type SeenFile = { v: 1; seen: Record<string, number> };

const key = (id: string, receiver: string): string => `${id} ${receiver}`;

/**
 * The replay key of a receiving session: its session id, behind a prefix no address can have (an
 * address is `name@device` and holds no space), so a migrated store never mixes the two kinds.
 */
export const receiverKey = (sid: string): string => `session ${sid}`;

/** `seen.json`: message id plus receiving session (`receiverKey`), to the time it may be forgotten. */
export class SeenStore {
  private readonly path: string;
  private readonly env: FsEnv;

  constructor(path: string, env: FsEnv) {
    this.path = path;
    this.env = env;
  }

  private async read(): Promise<Record<string, number>> {
    const raw = (await readJson(this.path)) as Partial<SeenFile> | undefined;
    return raw?.v === 1 && typeof raw.seen === "object" && raw.seen !== null ? raw.seen : {};
  }

  async has(id: string, receiver: string, now: number): Promise<boolean> {
    const until = (await this.read())[key(id, receiver)];
    return until !== undefined && until > now;
  }

  /** Records an accepted id, durably, under the device-wide lock; expired entries are dropped. */
  async add(id: string, receiver: string, until: number, now: number): Promise<void> {
    await this.claim([[id, receiver]], until, now, true);
  }

  /**
   * Carries the entries an older client recorded under the address `address` over to `receiver`,
   * under the device-wide lock, so upgrading opens no replay window: the session that last held
   * that address keeps every id it accepted there. The old entries stay until they expire (a
   * sibling of an older version may still read them). Writes only when something is carried.
   */
  async migrate(address: string, receiver: string, now: number): Promise<void> {
    const suffix = ` ${address}`;
    // Read first without the lock: a store with nothing of that address (every store after the
    // first open) costs no lock and no write.
    if (!Object.keys(await this.read()).some((k) => k.endsWith(suffix))) return;
    await withLock(`${this.path}.lock`, async () => {
      const seen = await this.read();
      let carried = false;
      for (const [k, t] of Object.entries(seen)) {
        if (t <= now || !k.endsWith(suffix)) continue;
        const moved = key(k.slice(0, -suffix.length), receiver);
        if ((seen[moved] ?? 0) >= t) continue;
        seen[moved] = t;
        carried = true;
      }
      if (carried) await writeJson(this.path, { v: 1, seen } satisfies SeenFile, this.env);
    }, this.env);
  }

  /**
   * Single use across every process of the device: under the device-wide lock, reads the file
   * again and records every pair only when none of them is held yet. False when one is, and then
   * nothing is written. Two sessions that check and then add would both pass the check (SPEC
   * section 18, step 7); a claim lets one of them through.
   */
  async claim(pairs: ReadonlyArray<readonly [id: string, receiver: string]>, until: number, now: number, force = false): Promise<boolean> {
    return withLock(`${this.path}.lock`, async () => {
      const seen = await this.read();
      if (!force && pairs.some(([id, receiver]) => (seen[key(id, receiver)] ?? 0) > now)) return false;
      const kept: Record<string, number> = {};
      for (const [k, t] of Object.entries(seen)) if (t > now) kept[k] = t;
      for (const [id, receiver] of pairs) kept[key(id, receiver)] = until;
      await writeJson(this.path, { v: 1, seen: kept } satisfies SeenFile, this.env);
      return true;
    }, this.env);
  }
}

/**
 * `touched`: when this device last recorded each row (receiving session, then sender session), by
 * its own clock. A row untouched for `dedupeRetentionMs` is retired: every message accepted under
 * it is past the freshness window by then, so no replay of one could be accepted again. A file
 * from an older client has no times, and its rows count from when this one first writes.
 */
type SeqFile = { v: 1; byAddress: Record<string, unknown>; touched?: Record<string, unknown> };

const row = (device: string, sid: string): string => JSON.stringify([device, sid]);

/** A row's recorded time, or `now` for one with none (an older client's, or junk). */
function stampOf(touched: unknown, k: string, now: number): number {
  const t = typeof touched === "object" && touched !== null ? (touched as Record<string, unknown>)[k] : undefined;
  return typeof t === "number" && Number.isFinite(t) ? t : now;
}

/** `seq.json`: one SeqTracker per receiving session (`receiverKey`; the field name is from when it was the address). */
export class SeqStore {
  private readonly trackers = new Map<string, SeqTracker>();
  /** When each row of `trackers` was last recorded, so a row this process holds keeps its age. */
  private readonly stamps = new Map<string, Record<string, number>>();

  private readonly path: string;
  private readonly env: FsEnv;

  constructor(path: string, env: FsEnv) {
    this.path = path;
    this.env = env;
  }

  private async read(): Promise<{ byAddress: Record<string, unknown>; touched: Record<string, unknown> }> {
    const raw = (await readJson(this.path)) as Partial<SeqFile> | undefined;
    if (raw?.v !== 1 || typeof raw.byAddress !== "object" || raw.byAddress === null) return { byAddress: {}, touched: {} };
    return { byAddress: raw.byAddress, touched: typeof raw.touched === "object" && raw.touched !== null ? raw.touched : {} };
  }

  private static load(json: unknown): SeqTracker {
    try {
      return SeqTracker.fromJSON(json);
    } catch {
      return new SeqTracker();
    }
  }

  /** Whether `seq` is new for this sender session at this receiver. Reads the file once per receiver. */
  async isNew(receiver: string, device: string, sid: string, seq: number): Promise<boolean> {
    let tracker = this.trackers.get(receiver);
    if (tracker === undefined) {
      const { byAddress, touched } = await this.read();
      tracker = SeqStore.load(byAddress[receiver]);
      this.trackers.set(receiver, tracker);
      // Only the times the file holds: a row without one counts from the next write, as in merge.
      const times: Record<string, number> = {};
      for (const [d, s] of tracker.toJSON().entries) {
        const t = stampOf(touched[receiver], row(d, s), Number.NaN);
        if (!Number.isNaN(t)) times[row(d, s)] = t;
      }
      this.stamps.set(receiver, times);
    }
    return seq > tracker.highest(device, sid);
  }

  /** Records `seq` at `now`, merging with what sibling sessions wrote for themselves. */
  async record(receiver: string, device: string, sid: string, seq: number, now: number): Promise<void> {
    await this.merge(receiver, now, (tracker) => {
      if (seq > tracker.highest(device, sid)) tracker.observe(device, sid, seq);
      return [row(device, sid)];
    });
  }

  /**
   * Carries what an older client tracked under the address `address` over to `receiver` (each
   * sender session's highest seq, where it is higher), as `SeenStore.migrate` does for ids. The
   * address's own tracker is left as it was.
   */
  async migrate(address: string, receiver: string, now: number): Promise<void> {
    // Nothing to carry (a store from this version, or a session that never received): no write.
    if ((await this.read()).byAddress[address] === undefined) return;
    await this.merge(receiver, now, (tracker, all) => {
      const carried: string[] = [];
      for (const [d, s, n] of SeqStore.load(all[address]).toJSON().entries) {
        if (n > tracker.highest(d, s)) {
          tracker.observe(d, s, n);
          carried.push(row(d, s));
        }
      }
      return carried;
    });
  }

  /**
   * Under the device-wide lock: the file's tracker for `receiver`, this process's, then `change`
   * (which names the rows it recorded at `now`), written back with every row in the file that is
   * still within the retention window.
   */
  private async merge(receiver: string, now: number, change: (tracker: SeqTracker, all: Record<string, unknown>) => string[]): Promise<void> {
    await withLock(`${this.path}.lock`, async () => {
      const { byAddress: all, touched } = await this.read();
      const tracker = SeqStore.load(all[receiver]);
      const retired = now - LIMITS.dedupeRetentionMs;
      // This process's rows keep the time they were recorded: one a sibling retired from the file
      // since is not brought back, and one still within the window keeps its age. A row read
      // without a time (only isNew loads rows untimed; every write times all it keeps) takes the
      // one a sibling has written for it since; gone from the file, a sibling retired it; still
      // there untimed, it counts from now.
      const held = this.stamps.get(receiver) ?? {};
      const kept: Record<string, number> = {};
      for (const [d, s, n] of this.trackers.get(receiver)?.toJSON().entries ?? []) {
        const k = row(d, s);
        const t = held[k] ?? stampOf(touched[receiver], k, tracker.highest(d, s) > 0 ? now : retired);
        if (t <= retired) continue;
        kept[k] = Math.max(t, stampOf(touched[receiver], k, t));
        if (n > tracker.highest(d, s)) tracker.observe(d, s, n);
      }
      const changed = new Set(change(tracker, all));
      const byAddress: Record<string, unknown> = {};
      const stamps: Record<string, Record<string, number>> = {};
      for (const [r, json] of Object.entries({ ...all, [receiver]: tracker.toJSON() })) {
        const rows = new SeqTracker();
        const times: Record<string, number> = {};
        for (const [d, s, n] of SeqStore.load(json).toJSON().entries) {
          const k = row(d, s);
          const t = r === receiver && changed.has(k) ? now : r === receiver && kept[k] !== undefined ? kept[k] : stampOf(touched[r], k, now);
          if (t <= retired) continue;
          rows.observe(d, s, n);
          times[k] = t;
        }
        if (r === receiver) {
          this.trackers.set(receiver, rows);
          this.stamps.set(receiver, times);
        }
        if (Object.keys(times).length === 0) continue;
        byAddress[r] = rows.toJSON();
        stamps[r] = times;
      }
      await writeJson(this.path, { v: 1, byAddress, touched: stamps } satisfies SeqFile, this.env);
    }, this.env);
  }
}
