// Idle-notice watches (SPEC section 8, SECURITY-MODEL section 5.4). A relay may lie in the
// notices it authors, and in the Claude Code plugin a notice starts a turn of its own, so a
// session takes a relay `notice` only for an address it armed itself, before the arm lapsed, and
// only once. Each arm is kept in the session's `watches.json`, so a later process of the session
// (a resume keeps the relay's row too) still takes the notice it asked for. One process holds a
// session, and every change runs after the one before it, so two notices for one arm cannot both
// be taken.

import { LIMITS } from "@worldinmotion/protocol";
import { readJson, writeJson, type FsEnv } from "./fsx.ts";

/**
 * One armed notice: the address, the relay's session id for it when this session knew one (a
 * session that renames itself is still the one armed), when it was armed, and when it lapses.
 */
export type Watch = { of: string; sid?: string; at: number; until: number };

/**
 * How many watches the file keeps; past it the oldest go. The relay holds at most
 * LIMITS.notifyIdlePerSession arms and refuses the rest (each refusal also drops its watch here),
 * so only arms the relay already let go of without a notice can push a live one out: those it
 * fired while this session was offline, or fired under a new name nobody knew.
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

  /** The watches that have not lapsed. A missing, damaged or unreadable file reads as none, the safe side. */
  async list(): Promise<Watch[]> {
    const raw = (await readJson(this.path).catch(() => undefined)) as { watches?: unknown } | null | undefined;
    const now = this.now();
    return (Array.isArray(raw?.watches) ? raw.watches.filter(isWatch) : []).filter((w) => w.until > now);
  }

  /**
   * Records an arm for each address: a new watch, or a renewed one for an address already armed.
   * The relay decides the limit: an arm it refuses is dropped again (`drop`).
   */
  arm(arms: ReadonlyArray<{ of: string; sid?: string }>): Promise<void> {
    return this.change((watches) => {
      const at = this.now();
      for (const { of, sid } of arms) watches = [...watches.filter((w) => w.of !== of), { of, ...(sid === undefined ? {} : { sid }), at, until: at + LIMITS.idleNoticeLifetimeMs }];
      return { watches: watches.slice(-WATCHES_KEPT), out: undefined };
    });
  }

  /** Drops the watch for `of`, an arm the relay refused. */
  drop(of: string): Promise<void> {
    return this.change((watches) => ({ watches: watches.filter((w) => w.of !== of), out: undefined }));
  }

  /**
   * Takes the watch for `of`, or for the session `sid` (the relay's id for `of` now, after a
   * rename): true, and the watch is closed, when one was armed and has not lapsed.
   */
  take(of: string, sid?: string): Promise<boolean> {
    return this.change((watches) => {
      const i = watches.findIndex((w) => w.of === of || (sid !== undefined && w.sid === sid));
      // A notice nobody asked for changes nothing, so it writes nothing either.
      return i === -1 ? { out: false } : { watches: watches.filter((_, n) => n !== i), out: true };
    });
  }

  /**
   * Reads the watches, changes them and writes them back atomically (when `f` gives a new list),
   * after every change asked for before it.
   */
  private change<T>(f: (watches: Watch[]) => { watches?: Watch[]; out: T }): Promise<T> {
    const run = this.changing.then(async () => {
      const { watches, out } = f(await this.list());
      if (watches !== undefined) await writeJson(this.path, { v: 1, watches }, this.env);
      return out;
    });
    this.changing = Promise.allSettled([run]);
    return run;
  }
}
