// Durable replay state shared by every session of one device (SPEC section 6, dedupe and seq):
// accepted message ids per receiving address until they can no longer be fresh, and the
// highest seq per sender session per receiving address.

import { SeqTracker } from "@worldinmotion/protocol";
import { readJson, withLock, writeJson, type FsEnv } from "./fsx.ts";

type SeenFile = { v: 1; seen: Record<string, number> };

const key = (id: string, address: string): string => `${id} ${address}`;

/** `seen.json`: message id plus receiving address, to the time it may be forgotten. */
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

  async has(id: string, address: string, now: number): Promise<boolean> {
    const until = (await this.read())[key(id, address)];
    return until !== undefined && until > now;
  }

  /** Records an accepted id, durably, under the device-wide lock; expired entries are dropped. */
  async add(id: string, address: string, until: number, now: number): Promise<void> {
    await withLock(`${this.path}.lock`, async () => {
      const seen = await this.read();
      const kept: Record<string, number> = {};
      for (const [k, t] of Object.entries(seen)) if (t > now) kept[k] = t;
      kept[key(id, address)] = until;
      await writeJson(this.path, { v: 1, seen: kept } satisfies SeenFile, this.env);
    }, this.env);
  }
}

type SeqFile = { v: 1; byAddress: Record<string, unknown> };

/** `seq.json`: one SeqTracker per receiving address. */
export class SeqStore {
  private readonly trackers = new Map<string, SeqTracker>();

  private readonly path: string;
  private readonly env: FsEnv;

  constructor(path: string, env: FsEnv) {
    this.path = path;
    this.env = env;
  }

  private async read(): Promise<Record<string, unknown>> {
    const raw = (await readJson(this.path)) as Partial<SeqFile> | undefined;
    return raw?.v === 1 && typeof raw.byAddress === "object" && raw.byAddress !== null ? raw.byAddress : {};
  }

  private static load(json: unknown): SeqTracker {
    try {
      return SeqTracker.fromJSON(json);
    } catch {
      return new SeqTracker();
    }
  }

  /** Whether `seq` is new for this sender session at this address. Reads the file once per address. */
  async isNew(address: string, device: string, sid: string, seq: number): Promise<boolean> {
    let tracker = this.trackers.get(address);
    if (tracker === undefined) {
      tracker = SeqStore.load((await this.read())[address]);
      this.trackers.set(address, tracker);
    }
    return seq > tracker.highest(device, sid);
  }

  /** Records `seq`, merging with what sibling sessions wrote for their own addresses. */
  async record(address: string, device: string, sid: string, seq: number): Promise<void> {
    await withLock(`${this.path}.lock`, async () => {
      const all = await this.read();
      const tracker = SeqStore.load(all[address]);
      const mine = this.trackers.get(address);
      for (const [d, s, n] of mine?.toJSON().entries ?? []) if (n > tracker.highest(d, s)) tracker.observe(d, s, n);
      if (seq > tracker.highest(device, sid)) tracker.observe(device, sid, seq);
      this.trackers.set(address, tracker);
      await writeJson(this.path, { v: 1, byAddress: { ...all, [address]: tracker.toJSON() } } satisfies SeqFile, this.env);
    }, this.env);
  }
}
