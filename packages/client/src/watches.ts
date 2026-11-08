// Idle-notice watches (SPEC section 8, SECURITY-MODEL section 5.4). A relay may lie in the
// notices it authors, and a notice can start an agent turn, so a session takes a relay `notice`
// only for an address it armed itself, before the arm lapsed, and only once. Each arm is kept in
// the session's `watches.json`, so a later process of the session (a resume keeps the relay's row
// too) still takes the notice it asked for, and an arm made while offline is sent at the next
// `ready`. One process holds a session, and every change runs after the one before it, so two
// notices for one arm cannot both be taken.

import { LIMITS } from "@worldinmotion/protocol";
import { readJson, writeJson, type FsEnv } from "./fsx.ts";

/**
 * One armed notice: the address, the relay's session id for it when this session knew one (a
 * session that renames itself is still the one armed), when it was armed, and when it lapses.
 */
export type Watch = { of: string; sid?: string; at: number; until: number };

/** What an arm did: the watches it opened or renewed, and the addresses refused past the limit. */
export type Armed = { watching: Watch[]; refused: string[] };

/**
 * How many entries the file keeps: the open watches (at most LIMITS.notifyIdlePerSession, the
 * relay's limit) and lapsed ones not yet reported. Past it the oldest go, which are lapsed ones.
 */
export const WATCHES_KEPT = 4 * LIMITS.notifyIdlePerSession;

function isWatch(x: unknown): x is Watch {
  const w = x as Partial<Watch> | null;
  return typeof w === "object" && w !== null && typeof w.of === "string" && (w.sid === undefined || typeof w.sid === "string") && Number.isSafeInteger(w.at) && Number.isSafeInteger(w.until);
}

export class Watches {
  private readonly path: string;
  private readonly env: FsEnv;
  private readonly now: () => number;
  /** The last change, so changes run one at a time. */
  private changing: Promise<unknown> = Promise.resolve();

  constructor(path: string, env: FsEnv, now: () => number) {
    this.path = path;
    this.env = env;
    this.now = now;
  }

  /**
   * Every watch in the file, lapsed ones too, and whether the file is damaged: there but unreadable,
   * not JSON, or holding anything but watches. A damaged file reads as no watches, the safe side
   * (no notice is taken), and is never written over: an arm is refused until the person fixes it.
   */
  private async read(): Promise<{ watches: Watch[]; damaged: boolean }> {
    let raw: unknown;
    try {
      raw = await readJson(this.path);
    } catch {
      return { watches: [], damaged: true };
    }
    if (raw === undefined) return { watches: [], damaged: false };
    const list = (raw as { watches?: unknown } | null)?.watches;
    return Array.isArray(list) && list.every(isWatch) ? { watches: list, damaged: false } : { watches: [], damaged: true };
  }

  /**
   * The watches that have not lapsed, read after every change asked for before it: a notice
   * taken first is not listed as open.
   */
  open(): Promise<Watch[]> {
    return this.change((watches) => {
      const now = this.now();
      return { out: watches.filter((w) => w.until > now) };
    });
  }

  /** The watches that have not lapsed. */
  async list(): Promise<Watch[]> {
    const now = this.now();
    return (await this.read()).watches.filter((w) => w.until > now);
  }

  /**
   * Records an arm for each address: a renewed watch in place of any for the same address or the
   * same session (one session has one watch, so a re-arm after a rename replaces the old
   * address's), or a new one while fewer than the relay's limit are open. Past that an address is
   * refused here, as the relay would refuse it.
   */
  arm(arms: ReadonlyArray<{ of: string; sid?: string }>): Promise<Armed> {
    return this.change((watches, damaged) => {
      if (damaged) throw new Error(`${this.path} is damaged; it is left as it is (remove it to arm again)`);
      const at = this.now();
      const watching: Watch[] = [];
      const refused: string[] = [];
      for (const { of, sid } of arms) {
        const same = (w: Watch): boolean => w.of === of || (sid !== undefined && w.sid === sid);
        const renews = watches.some((w) => same(w) && w.until > at);
        if (!renews && watches.filter((w) => w.until > at).length >= LIMITS.notifyIdlePerSession) {
          refused.push(of);
          continue;
        }
        const watch: Watch = { of, ...(sid === undefined ? {} : { sid }), at, until: at + LIMITS.idleNoticeLifetimeMs };
        watches = [...watches.filter((w) => !same(w)), watch];
        watching.push(watch);
      }
      return { watches: watching.length === 0 ? undefined : watches.slice(-WATCHES_KEPT), out: { watching, refused } };
    });
  }

  /**
   * Takes the open watch for `of`, or, when there is none, the one for the session `sid` (the
   * relay's id for `of` now, after a rename): the watch, which is closed, or undefined when none
   * was armed or it lapsed.
   */
  take(of: string, sid?: string): Promise<Watch | undefined> {
    return this.change((watches) => {
      const now = this.now();
      const exact = watches.findIndex((w) => w.of === of && w.until > now);
      const i = exact !== -1 || sid === undefined ? exact : watches.findIndex((w) => w.sid === sid && w.until > now);
      // A notice nobody asked for changes nothing, so it writes nothing either.
      return i === -1 ? { out: undefined } : { watches: watches.filter((_, n) => n !== i), out: watches[i] };
    });
  }

  /** Closes the open watch for `of` (the relay refused its arm): true when there was one. */
  drop(of: string): Promise<boolean> {
    return this.change((watches) => {
      const now = this.now();
      const kept = watches.filter((w) => !(w.of === of && w.until > now));
      return kept.length === watches.length ? { out: false } : { watches: kept, out: true };
    });
  }

  /** Removes the watches that lapsed with no notice and returns them, so the agent can be told once. */
  lapse(): Promise<Watch[]> {
    return this.change((watches) => {
      const now = this.now();
      const lapsed = watches.filter((w) => w.until <= now);
      return lapsed.length === 0 ? { out: [] } : { watches: watches.filter((w) => w.until > now), out: lapsed };
    });
  }

  /**
   * Reads the watches, changes them and writes them back atomically (when `f` gives a new list),
   * after every change asked for before it.
   */
  private change<T>(f: (watches: Watch[], damaged: boolean) => { watches?: Watch[]; out: T }): Promise<T> {
    const run = this.changing.then(async () => {
      const read = await this.read();
      const { watches, out } = f(read.watches, read.damaged);
      if (watches !== undefined) await writeJson(this.path, { v: 1, watches }, this.env);
      return out;
    });
    this.changing = Promise.allSettled([run]);
    return run;
  }
}
