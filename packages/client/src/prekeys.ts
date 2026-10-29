// Prekeys on this device (SPEC section 6b): the device's own signed prekeys with their secrets,
// rotated daily and deleted on a fixed schedule, and the newest verified prekey of each peer
// device. Both files are per mesh and shared by every session of the device.

import { b64u, isVectorKey, LIMITS, prekeyDeleteAt, prekeySchema, prekeyUsable, verifyPrekey, type Keyring, type Prekey, type Roster } from "@worldinmotion/protocol";
import { readJson, withLock, writeJson, type FsEnv } from "./fsx.ts";
import type { Device } from "./home.ts";
import type { PrekeyEntry } from "./keyring.ts";

type Held = PrekeyEntry;
/** An entry holds `secret` (b64u, in the clear) or `sealed` (opened only by the signer). */
type OwnFile = { v: 1; keys: Array<{ prekey: Prekey; secret: string } | { prekey: Prekey; sealed: string }> };
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
    return parsed(raw?.v === 1 ? raw.keys : undefined, (k): Held => {
      const entry = k as { prekey?: unknown; secret?: unknown; sealed?: unknown };
      const prekey = prekeySchema.parse(entry.prekey);
      if (typeof entry.sealed === "string" && entry.sealed !== "") return { prekey, sealed: entry.sealed };
      return { prekey, secret: decode32(entry.secret) };
    });
  }

  /** Reads the file again: a sibling session may have rotated since. An unreadable file keeps what is held. */
  async reload(): Promise<void> {
    this.held = await this.read().catch(() => this.held);
  }

  /** One of this device's prekeys with its secret, while it is kept (never past its deletion time). */
  entry(id: string): PrekeyEntry | undefined {
    const now = this.now();
    return this.held.find((h) => h.prekey.id === id && prekeyDeleteAt(h.prekey) > now);
  }

  /**
   * The device's keyring for opening: a scheme 2 box opens with the entry of the prekey it names
   * (`key_expired` once that is deleted), a scheme 1 box with the device's box key.
   */
  opener(): Pick<Keyring, "open"> {
    const keyring = this.device.keyring;
    return {
      open: async (req) => {
        if (!("s" in req.box)) return keyring.open(req);
        const entry = this.entry(req.box.p);
        return entry === undefined ? "key_expired" : keyring.openPrekey(entry, req);
      },
    };
  }

  /** The newest prekey senders may use now: the one this device publishes. Its own, so only its time is checked. */
  current(): Prekey | undefined {
    const now = this.now();
    return this.held.filter((h) => prekeyUsable(h.prekey, now)).sort((a, b) => b.prekey.at - a.prekey.at)[0]?.prekey;
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
  async maintain(): Promise<boolean> {
    return withLock(`${this.path}.lock`, async () => {
      const now = this.now();
      const before = await this.read();
      const alive = before.filter((h) => prekeyDeleteAt(h.prekey) > now);
      // A signer seals any secret a process holding the plaintext keys left in the clear.
      const kept = await Promise.all(alive.map((h) => this.device.keyring.adopt(h)));
      const adopted = kept.some((h, i) => h !== alive[i]);
      const newest = kept.filter((h) => prekeyUsable(h.prekey, now)).sort((a, b) => b.prekey.at - a.prekey.at)[0];
      const rotate = newest === undefined || now - newest.prekey.at >= LIMITS.prekeyRotateMs;
      if (rotate) kept.push(await this.device.keyring.newPrekey(this.mesh, now));
      const next = kept.sort((a, b) => b.prekey.at - a.prekey.at).slice(0, LIMITS.prekeysKept);
      if (rotate || adopted || next.length !== before.length) {
        const file: OwnFile = { v: 1, keys: next.map((h) => ("sealed" in h ? { prekey: h.prekey, sealed: h.sealed } : { prekey: h.prekey, secret: b64u.encode(h.secret) })) };
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
    // Only a cache of public, signed objects: an unreadable file reads as empty, and cards refill it.
    const raw = (await readJson(this.path).catch(() => undefined)) as Partial<PeerFile> | undefined;
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

  /**
   * The prekey to seal to for each listed device that is in the roster and has a usable one now.
   * Each was verified when it was taken; the seal verifies it once more.
   */
  forSend(roster: Roster, ids: readonly string[]): Record<string, Prekey> {
    const now = this.now();
    const out: Record<string, Prekey> = {};
    for (const id of ids) {
      const pk = this.known.get(id);
      if (pk !== undefined && prekeyUsable(pk, now) && roster.devices.some((d) => d.id === id)) out[id] = pk;
    }
    return out;
  }
}
