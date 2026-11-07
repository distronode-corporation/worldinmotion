// Idle-notice watches (SPEC section 8, SECURITY-MODEL section 5.4). A relay may lie in the
// notices it authors, and in the Claude Code plugin a notice starts a turn of its own, so a
// session takes a relay `notice` only for an address it armed itself, before the arm lapsed, and
// only once. Each arm is kept in the session's `watches.json`, so a later process of the session
// (a resume keeps the relay's row too) still takes the notice it asked for. One process holds a
// session, and every change runs after the one before it, so two notices for one arm cannot both
// be taken.

import { LIMITS } from "@worldinmotion/protocol";
import { readJson, writeJson, type FsEnv } from "./fsx.ts";

/** One armed notice: the address, when it was armed, and when it lapses. */
export type Watch = { of: string; at: number; until: number };

/** What an arm did: the addresses armed (renewed ones too), and those refused for the limit. */
export type Armed = { armed: string[]; refused: string[] };

function isWatch(x: unknown): x is Watch {
  const w = x as Partial<Watch> | null;
  return typeof w === "object" && w !== null && typeof w.of === "string" && Number.isSafeInteger(w.at) && Number.isSafeInteger(w.until);
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
   * Past the relay's limit of armed notices per session a new address is refused.
   */
  arm(addresses: readonly string[]): Promise<Armed> {
    return this.change((watches) => {
      const at = this.now();
      const out: Armed = { armed: [], refused: [] };
      for (const of of new Set(addresses)) {
        const kept = watches.filter((w) => w.of !== of);
        if (kept.length === watches.length && watches.length >= LIMITS.notifyIdlePerSession) {
          out.refused.push(of);
          continue;
        }
        watches = [...kept, { of, at, until: at + LIMITS.idleNoticeLifetimeMs }];
        out.armed.push(of);
      }
      return { watches, out };
    });
  }

  /** Takes the watch for `of`: true, and the watch is closed, when one was armed and has not lapsed. */
  take(of: string): Promise<boolean> {
    return this.change((watches) => {
      const kept = watches.filter((w) => w.of !== of);
      // A notice nobody asked for changes nothing, so it writes nothing either.
      return kept.length < watches.length ? { watches: kept, out: true } : { out: false };
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
