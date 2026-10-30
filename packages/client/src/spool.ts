// The spool: inbound items for the agent as numbered files (design.md, the plugin contract). The
// plugin, the inbox tool or a channel push moves `spool/cursor`; this side then deletes what was
// taken and sends the `delivered` receipts.

import { join } from "node:path";
import { listDir, readJson, readText, tryRemove, whileBusy, writeAtomic, writeJson, type FsEnv } from "./fsx.ts";
import { momentarilyBusy } from "./platform.ts";

export type SpoolKind = "msg" | "task" | "result" | "file" | "notice";

/** One spool file, exactly as the plugin parses it. */
export type SpoolItem = {
  cursor: number;
  kind: SpoolKind;
  from: string;
  device: string;
  id: string;
  at: number;
  rendered: string;
  /** On a notice about held messages: how many wait for the person. */
  held?: number;
  /** The sender did not write this text itself (revision 4, H1): never start a turn for it. */
  relayed?: true;
  /** Framed as information only; handing it to the agent starts the `derived` window. */
  informs?: true;
  /** A notice only the person can act on (restart this session): the plugin shows it, never starts a turn. */
  forPerson?: true;
};

const NAME = /^(\d{12})\.json$/;

export const itemName = (cursor: number): string => `${String(cursor).padStart(12, "0")}.json`;

/** An item file that is there but still busy after the bounded wait (Windows only). */
const BUSY = Symbol("busy");

/** The item number a cursor file names, or 0. Anything else in it is ignored. */
export function cursorNumber(text: string | undefined): number {
  const m = NAME.exec((text ?? "").trim());
  return m === null ? 0 : Number(m[1]);
}

export class Spool {
  /** The highest item number handed out so far, never reused. */
  private last: number;
  /** The take in progress, which the next one waits for. */
  private taking: Promise<void> = Promise.resolve();
  /** The highest cursor this process wrote: a read of the file never goes back past it. */
  private written = 0;
  /** Relayed items this process already copied to the box, so one it could not delete yet is not copied again. */
  private readonly boxed = new Set<string>();

  readonly dir: string;
  readonly relayedDir: string;
  private readonly env: FsEnv;

  constructor(dir: string, env: FsEnv, last: number) {
    this.dir = dir;
    // Beside the spool, not in it: the plugin lists only the spool directory.
    this.relayedDir = join(dir, "..", "relayed");
    this.env = env;
    this.last = last;
  }

  get cursorPath(): string {
    return join(this.dir, "cursor");
  }

  /** Opens a spool, numbering after the highest of `last`, any item on disk and the cursor. */
  static async open(dir: string, env: FsEnv, last: number): Promise<Spool> {
    const spool = new Spool(dir, env, last);
    const onDisk = (await spool.names()).map((n) => Number(NAME.exec(n)![1]));
    spool.last = Math.max(last, await spool.cursor(), ...onDisk);
    return spool;
  }

  get highest(): number {
    return this.last;
  }

  private async names(): Promise<string[]> {
    return (await listDir(this.dir)).filter((n) => NAME.test(n)).sort();
  }

  /** The highest cursor this process has taken, without reading the file. */
  get taken(): number {
    return this.written;
  }

  /**
   * The cursor: the file (read again while it is busy for a moment), and never less than what
   * this process last wrote, whatever a file system that is slow to show a rename says.
   */
  async cursor(): Promise<number> {
    return Math.max(this.written, cursorNumber(await whileBusy(() => readText(this.cursorPath), this.env.platform)));
  }

  async write(item: Omit<SpoolItem, "cursor">): Promise<SpoolItem> {
    const cursor = ++this.last;
    const full: SpoolItem = { cursor, ...item };
    await writeJson(join(this.dir, itemName(cursor)), full, this.env);
    return full;
  }

  /**
   * Items not yet taken, oldest first. A file that does not parse is skipped. The list stops
   * before an item that is still busy after a moment's wait (Windows), so nothing after it is
   * handed out and taken past it: it comes first on a later call.
   */
  async unread(): Promise<SpoolItem[]> {
    const after = await this.cursor();
    const out: SpoolItem[] = [];
    for (const name of await this.names()) {
      if (Number(NAME.exec(name)![1]) <= after) continue;
      const item = await this.read(join(this.dir, name));
      if (item === BUSY) break;
      if (item !== undefined) out.push(item);
    }
    return out;
  }

  /**
   * One item file: the item, undefined when it is gone or does not parse as one, or BUSY when
   * it is still busy after the bounded wait. A busy file is there but cannot be read yet.
   */
  private async read(path: string): Promise<SpoolItem | undefined | typeof BUSY> {
    let raw: SpoolItem | undefined;
    try {
      raw = (await whileBusy(() => readJson(path), this.env.platform)) as SpoolItem | undefined;
    } catch (error) {
      return momentarilyBusy((error as NodeJS.ErrnoException).code, this.env.platform) ? BUSY : undefined;
    }
    return typeof raw?.rendered === "string" && typeof raw.id === "string" ? raw : undefined;
  }

  /**
   * Marks everything up to `cursor` as taken. The cursor never moves back: one take at a time,
   * since two that overlap would both read the old cursor and the lower one could land last.
   */
  take(cursor: number): Promise<void> {
    const run = this.taking.then(async () => {
      if (cursor <= (await this.cursor())) return;
      await writeAtomic(this.cursorPath, itemName(cursor), this.env);
      this.written = cursor;
    });
    this.taking = run.catch(() => undefined);
    return run;
  }

  /**
   * Deletes taken items and returns them, so the caller can send their receipts. A relayed item
   * is kept in the relayed box instead: the plugin never starts a turn for one, so it stays
   * readable through `inbox` until an agent reads it or the person dismisses it.
   */
  async sweep(alreadyRead: ReadonlySet<string> = new Set()): Promise<SpoolItem[]> {
    const upto = await this.cursor();
    const gone: SpoolItem[] = [];
    for (const name of await this.names()) {
      if (Number(NAME.exec(name)![1]) > upto) break;
      const item = await this.read(join(this.dir, name));
      // One that cannot be read yet is neither boxed nor removed: the next pass deals with it.
      if (item === BUSY) continue;
      if (item?.relayed === true && !alreadyRead.has(item.id) && !this.boxed.has(name)) {
        await writeJson(join(this.relayedDir, name), item, this.env);
        this.boxed.add(name);
      }
      // One that cannot be deleted yet stays for the next pass, which sends its receipt then.
      if (!(await tryRemove(join(this.dir, name), this.env))) continue;
      if (item !== undefined) gone.push(item);
    }
    return gone;
  }

  /** Relayed items the cursor passed but nobody has read, oldest first. One still busy is left out this time. */
  async relayed(): Promise<SpoolItem[]> {
    return (await this.box()).items;
  }

  /** The box's readable items, and whether any item in it could not be read yet. */
  private async box(): Promise<{ items: SpoolItem[]; busy: boolean }> {
    const items: SpoolItem[] = [];
    let busy = false;
    for (const name of (await listDir(this.relayedDir)).filter((n) => NAME.test(n)).sort()) {
      const item = await this.read(join(this.relayedDir, name));
      if (item === BUSY) busy = true;
      else if (item !== undefined) items.push(item);
    }
    return { items, busy };
  }

  /**
   * Removes relayed items from the box: the ones given, or all. Returns how many went, and which
   * of the ids given may still be there: one that could not be removed yet, or any not found
   * while an item in the box could not be read yet. The caller asks again for those later.
   */
  async dismissRelayed(ids?: readonly string[]): Promise<{ removed: number; left: string[] }> {
    const { items, busy } = await this.box();
    let removed = 0;
    const left: string[] = [];
    for (const item of items) {
      if (ids !== undefined && !ids.includes(item.id)) continue;
      if (await tryRemove(join(this.relayedDir, itemName(item.cursor)), this.env)) removed++;
      else left.push(item.id);
    }
    if (busy) for (const id of ids ?? []) if (!items.some((i) => i.id === id)) left.push(id);
    return { removed, left };
  }
}
