// The spool: inbound items for the agent as numbered files (design.md, the plugin contract). The
// plugin, the inbox tool or a channel push moves `spool/cursor`; this side then deletes what was
// taken and sends the `delivered` receipts.

import { join } from "node:path";
import { listDir, readJson, readText, tryRemove, whileBusy, writeAtomic, writeJson, type FsEnv } from "./fsx.ts";

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
};

const NAME = /^(\d{12})\.json$/;

export const itemName = (cursor: number): string => `${String(cursor).padStart(12, "0")}.json`;

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

  /**
   * The cursor: the file (read again while it is busy for a moment), and never less than what
   * this process last wrote, whatever a file system that is slow to show a rename says.
   */
  /** The highest cursor this process has taken, without reading the file. */
  get taken(): number {
    return this.written;
  }

  async cursor(): Promise<number> {
    return Math.max(this.written, cursorNumber(await whileBusy(() => readText(this.cursorPath), this.env.platform)));
  }

  async write(item: Omit<SpoolItem, "cursor">): Promise<SpoolItem> {
    const cursor = ++this.last;
    const full: SpoolItem = { cursor, ...item };
    await writeJson(join(this.dir, itemName(cursor)), full, this.env);
    return full;
  }

  /** Items not yet taken, oldest first. A file that does not parse is skipped. */
  async unread(): Promise<SpoolItem[]> {
    const after = await this.cursor();
    const out: SpoolItem[] = [];
    for (const name of await this.names()) {
      if (Number(NAME.exec(name)![1]) <= after) continue;
      const item = await this.read(name);
      if (item !== undefined) out.push(item);
    }
    return out;
  }

  private async read(name: string): Promise<SpoolItem | undefined> {
    const raw = (await readJson(join(this.dir, name)).catch(() => undefined)) as SpoolItem | undefined;
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
      const item = await this.read(name);
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

  /** Relayed items the cursor passed but nobody has read, oldest first. */
  async relayed(): Promise<SpoolItem[]> {
    const out: SpoolItem[] = [];
    for (const name of (await listDir(this.relayedDir)).filter((n) => NAME.test(n)).sort()) {
      const raw = (await readJson(join(this.relayedDir, name)).catch(() => undefined)) as SpoolItem | undefined;
      if (typeof raw?.rendered === "string") out.push(raw);
    }
    return out;
  }

  /** Removes relayed items from the box: the ones given, or all. Returns how many went. */
  async dismissRelayed(ids?: readonly string[]): Promise<number> {
    let n = 0;
    for (const item of await this.relayed()) {
      if (ids !== undefined && !ids.includes(item.id)) continue;
      if (await tryRemove(join(this.relayedDir, itemName(item.cursor)), this.env)) n++;
    }
    return n;
  }
}
