// Prekeys on this device (SPEC section 6b): the device's own signed prekeys with their secrets,
// rotated daily and deleted on a fixed schedule, and the newest verified prekey of each peer
// device. Both files are per mesh and shared by every session of the device.

import { b64u, createPrekey, isVectorKey, LIMITS, prekeyDeleteAt, prekeySchema, verifyPrekey, type Prekey, type Roster } from "@worldinmotion/protocol";
import { readJson, withLock, writeJson, type FsEnv } from "./fsx.ts";
import type { Device } from "./home.ts";

type Held = { prekey: Prekey; secret: Uint8Array };
type OwnFile = { v: 1; keys: Array<{ prekey: Prekey; secret: string }> };
type PeerFile = { v: 1; prekeys: Record<string, Prekey> };

function decode32(text: unknown): Uint8Array {
  const bytes = b64u.decode(text as string);
  if (bytes.length !== 32) throw new TypeError("not 32 bytes");
  return bytes;
}

/** Entries of a JSON file's list that parse; anything else (a hand edit, another version) is skipped. */
function parsed<T>(list: unknown, parse: (item: unknown) => T): T[] {
  return (Array.isArray(list) ? list : []).flatMap((item) => {
    try {
      return [parse(item)];
    } catch {
      return [];
    }
  });
}

/**
 * `prekeys.json`: this device's prekeys and their secrets (mode 0600, like the key file). A secret
 * is deleted, by rewriting the file without it, at its prekey's `until` + 72 hours. Rotation and
 * deletion run under the file's lock, so sibling sessions never make two prekeys for one day.
 */
export class PrekeyStore {
  private held: Held[] = [];
  private readonly path: string;
  private readonly env: FsEnv;
  private readonly device: Device;
  private readonly mesh: string;
  private readonly now: () => number;

  constructor(opts: { path: string; env: FsEnv; device: Device; mesh: string; now: () => number }) {
    this.path = opts.path;
    this.env = opts.env;
    this.device = opts.device;
    this.mesh = opts.mesh;
    this.now = opts.now;
  }

  private async read(): Promise<Held[]> {
    const raw = (await readJson(this.path)) as Partial<OwnFile> | undefined;
    return parsed(raw?.v === 1 ? raw.keys : undefined, (k) => {
      const entry = k as { prekey?: unknown; secret?: unknown };
      return { prekey: prekeySchema.parse(entry.prekey), secret: decode32(entry.secret) };
    });
  }

  /** Reads the file again: a sibling session may have rotated since. */
  async reload(): Promise<void> {
    this.held = await this.read();
  }

  /** The secret of one of this device's prekeys, while it is kept (never past its deletion time). */
  secret(id: string): Uint8Array | undefined {
    const now = this.now();
    return this.held.find((h) => h.prekey.id === id && prekeyDeleteAt(h.prekey) > now)?.secret;
  }

  /** The newest prekey senders may use now: the one this device publishes. */
  current(roster: Roster): Prekey | undefined {
    const now = this.now();
    return this.held
      .filter((h) => verifyPrekey(h.prekey, roster, now).ok)
      .sort((a, b) => b.prekey.at - a.prekey.at)[0]?.prekey;
  }

  /** When `maintain` next has work: the newest prekey's rotation time, or the next deletion. */
  get due(): number {
    const newest = Math.max(...this.held.map((h) => h.prekey.at));
    return Math.min(newest + LIMITS.prekeyRotateMs, ...this.held.map((h) => prekeyDeleteAt(h.prekey)));
  }

  /**
   * Store, rotate, delete (SPEC section 6b): drops every secret past its deletion time, makes a new
   * prekey when none is usable or the newest is a day old, and keeps at most 8. Returns whether a
   * new prekey was made, so the caller publishes it.
   */
  async maintain(roster: Roster): Promise<boolean> {
    return withLock(`${this.path}.lock`, async () => {
      const now = this.now();
      const before = await this.read();
      const kept = before.filter((h) => prekeyDeleteAt(h.prekey) > now);
      const newest = kept.filter((h) => verifyPrekey(h.prekey, roster, now).ok).sort((a, b) => b.prekey.at - a.prekey.at)[0];
      const rotate = newest === undefined || now - newest.prekey.at >= LIMITS.prekeyRotateMs;
      if (rotate) kept.push(createPrekey({ mesh: this.mesh, deviceId: this.device.id, signSec: this.device.keys.signSec, at: now }));
      const next = kept.sort((a, b) => b.prekey.at - a.prekey.at).slice(0, LIMITS.prekeysKept);
      if (rotate || next.length !== before.length) {
        const file: OwnFile = { v: 1, keys: next.map((h) => ({ prekey: h.prekey, secret: b64u.encode(h.secret) })) };
        await writeJson(this.path, file, this.env);
      }
      this.held = next;
      return rotate;
    }, this.env);
  }
}

/**
 * `peer-prekeys.json`: the newest verified prekey of each peer device, learned from the `pk` of
 * cards and messages. A prekey is kept only when it verifies against the roster and is newer than
 * the one known, so a relay replaying an old card cannot roll a device back to an older prekey.
 */
export class PeerPrekeys {
  private known = new Map<string, Prekey>();
  private readonly path: string;
  private readonly env: FsEnv;
  private readonly now: () => number;

  constructor(opts: { path: string; env: FsEnv; now: () => number }) {
    this.path = opts.path;
    this.env = opts.env;
    this.now = opts.now;
  }

  private async read(): Promise<Map<string, Prekey>> {
    const raw = (await readJson(this.path)) as Partial<PeerFile> | undefined;
    // Object() reads a missing or non-object `prekeys` as empty.
    const list = parsed(Object.values(Object(raw?.v === 1 ? raw.prekeys : undefined)), (pk) => prekeySchema.parse(pk));
    return new Map(list.map((pk) => [pk.device, pk]));
  }

  /** Reads what sibling sessions and earlier processes learned. */
  async reload(): Promise<void> {
    for (const pk of (await this.read()).values()) this.keep(pk);
  }

  private keep(pk: Prekey): boolean {
    const had = this.known.get(pk.device);
    if (had !== undefined && had.at >= pk.at) return false;
    this.known.set(pk.device, pk);
    return true;
  }

  /**
   * Takes a prekey from a card or a message header. Kept, and written for sibling sessions, when it
   * verifies (signed by its device, current roster, not expired), is not a published test-vector
   * key, and is newer than the one known for that device.
   */
  async offer(raw: unknown, roster: Roster): Promise<boolean> {
    const checked = verifyPrekey(raw, roster, this.now());
    if (!checked.ok || isVectorKey(checked.value.pub) || !this.keep(checked.value)) return false;
    await withLock(`${this.path}.lock`, async () => {
      const merged = await this.read();
      for (const pk of this.known.values()) if ((merged.get(pk.device)?.at ?? -1) < pk.at) merged.set(pk.device, pk);
      await writeJson(this.path, { v: 1, prekeys: Object.fromEntries(merged) } satisfies PeerFile, this.env);
    }, this.env);
    return true;
  }

  /** The prekey to seal to for each listed device that has a usable one now. */
  forSend(roster: Roster, ids: readonly string[]): Record<string, Prekey> {
    const now = this.now();
    const out: Record<string, Prekey> = {};
    for (const id of ids) {
      const pk = this.known.get(id);
      if (pk !== undefined && verifyPrekey(pk, roster, now).ok) out[id] = pk;
    }
    return out;
  }
}
