/**
 * An in-memory map with a size cap and a time to live, for A2A tasks the gateway is tracking.
 * Each entry lives `ttlMs` after its last update. When the map is full, expired entries go first,
 * then the oldest entry `evictable` allows; if none may go, `add` refuses.
 */
export class TtlStore<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly evictable: (value: T) => boolean;

  constructor(opts: {
    max: number;
    ttlMs: number;
    now: () => number;
    evictable: (value: T) => boolean;
  }) {
    this.max = opts.max;
    this.ttlMs = opts.ttlMs;
    this.now = opts.now;
    this.evictable = opts.evictable;
  }

  /** Returns false, and stores nothing, when the store is full of entries it may not evict. */
  add(id: string, value: T): boolean {
    this.sweep();
    if (this.entries.size >= this.max) {
      const victim = [...this.entries].find(([, e]) => this.evictable(e.value));
      if (victim === undefined) return false;
      this.entries.delete(victim[0]);
    }
    this.entries.set(id, { value, expiresAt: this.now() + this.ttlMs });
    return true;
  }

  get(id: string): T | undefined {
    const e = this.entries.get(id);
    if (e === undefined) return undefined;
    if (e.expiresAt <= this.now()) {
      this.entries.delete(id);
      return undefined;
    }
    return e.value;
  }

  /** Restarts an entry's time to live. Unknown ids are ignored. */
  touch(id: string): void {
    const e = this.entries.get(id);
    if (e !== undefined) e.expiresAt = this.now() + this.ttlMs;
  }

  values(): T[] {
    this.sweep();
    return [...this.entries.values()].map((e) => e.value);
  }

  get size(): number {
    return this.entries.size;
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, e] of this.entries) if (e.expiresAt <= t) this.entries.delete(id);
  }
}
