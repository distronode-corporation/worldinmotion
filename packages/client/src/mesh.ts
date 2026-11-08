// One mesh on this device: mesh.json, the verified roster chain, and fork state.

import {
  detectFork,
  hash,
  isRelayUrl,
  rosterRef,
  rosterSchema,
  verifyGenesisRoster,
  verifyNextRoster,
  type Roster,
  type RosterRef,
} from "@worldinmotion/protocol";
import { join } from "node:path";
import { readJson, withLock, writeJson, type FsEnv } from "./fsx.ts";

/**
 * Inbound policy for a sender device (SPEC section 6a). `deliver-relayed` also delivers items the
 * sender marked `relayed` (text it did not write, such as a bot's model output); plain `deliver`
 * holds those.
 */
export type Policy = "deliver" | "deliver-relayed" | "hold" | "refuse";

/**
 * The loop breaker's counting limits (design.md, loop and cost breaker): wakes per sender device
 * and in total per sliding hour, and the ping-pong rule (more than `pingPongExchanges` alternating
 * short messages in 10 minutes).
 */
export type BreakerTier = { perPeerPerHour: number; totalPerHour: number; pingPong: boolean; pingPongExchanges: number };

/**
 * The loop breaker's limits, in mesh.json as `breaker`. They govern every automatic delivery,
 * which only a device the person trusts gets (policy `deliver` or `deliver-relayed`, and this
 * device's own sessions; any other device is held before the breaker counts it). A trip pauses
 * the peer for `cooldownMinutes`, after which the client releases it by itself, delivering at
 * most `perPeerPerHour` of what it held (SECURITY-MODEL section 7.3).
 */
export type BreakerLimits = BreakerTier & { cooldownMinutes: number };

/** The longest cool-down: an hour. */
export const COOLDOWN_MAX_MINUTES = 60;

/** What a new mesh.json gets, and what a file with no `breaker` at all reads as: the ceilings of 0.1.8, and a 10-minute cool-down. */
export const DEFAULT_BREAKER: BreakerLimits = { perPeerPerHour: 120, totalPerHour: 300, pingPong: true, pingPongExchanges: 32, cooldownMinutes: 10 };

/**
 * What a field missing or invalid in a WRITTEN `breaker` reads as: the values every mesh.json was
 * written with before 0.1.8 (which had no `pingPongExchanges`). A file is honoured as written, and
 * a gap in it never reads as the higher new default.
 */
const WRITTEN_BREAKER: BreakerTier = { perPeerPerHour: 20, totalPerHour: 60, pingPong: true, pingPongExchanges: 8 };

function positiveInt(v: unknown, fallback: number): number {
  return Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : fallback;
}

type BreakerFields = Partial<Record<keyof BreakerLimits, unknown>>;

const fields = (raw: unknown): BreakerFields => (typeof raw === "object" && raw !== null ? raw : {}) as BreakerFields;

/**
 * Reads a written `breaker`. Any key it does not know is ignored, never refused. A `trusted`
 * object, which drafts of 0.1.9 wrote for the devices the person trusts (the only ones the breaker
 * counts), is read only where it is stricter: a lower limit there is honoured, so a person's lowered
 * value is never raised, and nothing else in it changes anything.
 */
function parseBreaker(raw: unknown): BreakerLimits {
  if (raw === undefined) return DEFAULT_BREAKER;
  const b = fields(raw);
  const t = fields((b as { trusted?: unknown }).trusted);
  const stricter = (key: "perPeerPerHour" | "totalPerHour" | "pingPongExchanges", value: number): number => Math.min(value, positiveInt(t[key], value));
  return {
    perPeerPerHour: stricter("perPeerPerHour", positiveInt(b.perPeerPerHour, WRITTEN_BREAKER.perPeerPerHour)),
    totalPerHour: stricter("totalPerHour", positiveInt(b.totalPerHour, WRITTEN_BREAKER.totalPerHour)),
    pingPong: b.pingPong !== false,
    pingPongExchanges: stricter("pingPongExchanges", positiveInt(b.pingPongExchanges, WRITTEN_BREAKER.pingPongExchanges)),
    // A file written before 0.1.9 has none: the default cool-down, the one new behaviour it gets
    // (or the one a 0.1.9 draft wrote in `trusted`).
    cooldownMinutes: Math.min(positiveInt(b.cooldownMinutes, positiveInt(t.cooldownMinutes, DEFAULT_BREAKER.cooldownMinutes)), COOLDOWN_MAX_MINUTES),
  };
}

/** Fork state: the seq where two valid rosters met, and the devices that existed before it. */
export type ForkState = { seq: number; a: string; b: string; base: string[]; at: number };

export type MeshConfig = {
  v: 1;
  mesh: string;
  relay: string;
  /** This device's id. */
  device: string;
  /** The newest verified roster. Only ever moves forward. */
  pin: RosterRef;
  /** Inbound policy per sender device id (design.md, inbound policy). */
  policy: Record<string, Policy>;
  breaker: BreakerLimits;
  /** Peer cards: on (the directory's base name and branch), off, or `full` (the whole path). */
  share_cards: boolean | "full";
  /** b64u SHA-256 of the relay certificate's SPKI, from the invite (revision 3b). */
  tls?: string;
  fork?: ForkState;
};

function isPolicy(v: unknown): v is Policy {
  return v === "deliver" || v === "deliver-relayed" || v === "hold" || v === "refuse";
}

/** Reads mesh.json, refusing anything that is not one (a hand edit gone wrong fails loudly). */
export function parseMeshConfig(raw: unknown, path: string): MeshConfig {
  const c = raw as Partial<MeshConfig> | null;
  const bad = (what: string): never => {
    throw new Error(`${path}: ${what}`);
  };
  if (typeof c !== "object" || c === null || c.v !== 1) return bad("not a mesh file");
  if (typeof c.mesh !== "string" || typeof c.device !== "string") return bad("mesh or device missing");
  if (!isRelayUrl(c.relay)) return bad("relay is not a valid relay URL (wss://, or ws:// to loopback only)");
  if (typeof c.pin?.seq !== "number" || typeof c.pin.hash !== "string") return bad("pin missing");
  const policy: Record<string, Policy> = {};
  for (const [id, p] of Object.entries(c.policy ?? {})) if (isPolicy(p)) policy[id] = p;
  const breaker = parseBreaker(c.breaker);
  if (c.tls !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(c.tls)) return bad("tls is not a certificate pin");
  return {
    v: 1,
    mesh: c.mesh,
    relay: c.relay,
    device: c.device,
    pin: { seq: c.pin.seq, hash: c.pin.hash },
    policy,
    breaker,
    share_cards: c.share_cards === "full" ? "full" : c.share_cards !== false,
    ...(c.tls === undefined ? {} : { tls: c.tls }),
    ...(c.fork ? { fork: c.fork } : {}),
  };
}

/** Paths and locked read-modify-write of one mesh's files. */
export class MeshFiles {
  readonly dir: string;
  readonly env: FsEnv;
  constructor(dir: string, env: FsEnv) {
    this.dir = dir;
    this.env = env;
  }

  get configPath(): string {
    return join(this.dir, "mesh.json");
  }
  get rostersDir(): string {
    return join(this.dir, "rosters");
  }
  get invitesDir(): string {
    return join(this.dir, "invites");
  }
  /** Join requests this admin device keeps for its person (`wim devices pending`). */
  get joinsDir(): string {
    return join(this.dir, "joins");
  }
  get sessionsDir(): string {
    return join(this.dir, "sessions");
  }
  get keysDir(): string {
    return join(this.dir, "claude");
  }
  get seenPath(): string {
    return join(this.dir, "seen.json");
  }
  get seqPath(): string {
    return join(this.dir, "seq.json");
  }
  get leaseNamesPath(): string {
    return join(this.dir, "leases.json");
  }
  /** This device's prekeys and their secrets (SPEC section 6b), shared by its sessions. */
  get prekeysPath(): string {
    return join(this.dir, "prekeys.json");
  }
  /** The newest verified prekey of each peer device. */
  get peerPrekeysPath(): string {
    return join(this.dir, "peer-prekeys.json");
  }
  /** The person's CI sender rules (SPEC section 18): which repositories may send this device notices. */
  get ciRulesPath(): string {
    return join(this.dir, "ci-rules.json");
  }
  /** The CI providers' token keys this device fetched itself, kept at most 24 hours. */
  get ciJwksPath(): string {
    return join(this.dir, "ci-jwks.json");
  }
  /**
   * The peer sessions whose loop breaker said it holds this device's messages (a `pause`, SPEC
   * section 12), so every session of this device reports a send to them as `held`.
   */
  get pausedByPath(): string {
    return join(this.dir, "paused-by.json");
  }
  /** The peer sessions this device's sessions sent to in the last hour: a `pause` counts only from one (pauses.ts). */
  get sentToPath(): string {
    return join(this.dir, "sent-to.json");
  }
  /** The admin signing lock (SPEC section 4): one writer signs a roster at a time. */
  get rosterLock(): string {
    return join(this.dir, "roster.lock");
  }
  sessionDir(sid: string): string {
    return join(this.sessionsDir, sid);
  }

  async loadConfig(): Promise<MeshConfig> {
    const raw = await readJson(this.configPath);
    if (raw === undefined) throw new Error(`${this.configPath} does not exist`);
    return parseMeshConfig(raw, this.configPath);
  }

  async createConfig(config: MeshConfig, genesis: Roster[]): Promise<void> {
    for (const r of genesis) await this.saveRoster(r);
    await writeJson(this.configPath, config, this.env);
  }

  /** Applies `change` to mesh.json under a lock, so sessions and the CLI never lose each other's writes. */
  async updateConfig(change: (c: MeshConfig) => MeshConfig): Promise<MeshConfig> {
    return withLock(`${this.configPath}.lock`, async () => {
      const next = change(await this.loadConfig());
      await writeJson(this.configPath, next, this.env);
      return next;
    }, this.env);
  }

  async saveRoster(r: Roster): Promise<void> {
    await writeJson(join(this.rostersDir, `${r.seq}.json`), r, this.env);
  }

  async loadRoster(seq: number): Promise<Roster | undefined> {
    const raw = await readJson(join(this.rostersDir, `${seq}.json`));
    if (raw === undefined) return undefined;
    const parsed = rosterSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`${this.rostersDir}/${seq}.json is not a roster`);
    return parsed.data;
  }

  async saveForkEvidence(a: Roster, b: Roster): Promise<void> {
    await writeJson(join(this.rostersDir, `fork-${a.seq}.json`), { a, b }, this.env);
  }
}

export type AcceptResult =
  | { ok: true; advanced: boolean }
  | { ok: false; reason: string; fork?: { a: Roster; b: Roster } };

/**
 * The verified roster chain (SPEC section 4). It walks forward from the pinned roster only,
 * refuses anything lower than the newest it verified, and treats two valid rosters for one seq
 * as a fork: it then accepts no more rosters.
 */
export class RosterBook {
  private readonly files: MeshFiles;
  private head: Roster;
  private forked: ForkState | undefined;
  private constructor(files: MeshFiles, head: Roster, forked: ForkState | undefined) {
    this.files = files;
    this.head = head;
    this.forked = forked;
  }

  static async open(files: MeshFiles): Promise<RosterBook> {
    const config = await files.loadConfig();
    const head = await files.loadRoster(config.pin.seq);
    if (head === undefined || hash(head) !== config.pin.hash) {
      throw new Error(`${files.rostersDir}: the pinned roster ${config.pin.seq} is missing or does not match mesh.json`);
    }
    return new RosterBook(files, head, config.fork);
  }

  get current(): Roster {
    return this.head;
  }

  get ref(): RosterRef {
    return rosterRef(this.head);
  }

  get fork(): ForkState | undefined {
    return this.forked;
  }

  /** Catches up with rosters another process of this device verified and pinned since. */
  async reload(): Promise<void> {
    const config = await this.files.loadConfig();
    // A fork is never forgotten, even if this read raced the write that records it.
    this.forked ??= config.fork;
    if (config.pin.seq <= this.head.seq) return;
    const chain: Roster[] = [this.head];
    for (let seq = this.head.seq + 1; seq <= config.pin.seq; seq++) {
      const r = await this.files.loadRoster(seq);
      if (r === undefined) break;
      chain.push(r);
    }
    await this.accept(chain);
  }

  /**
   * Takes a chain page (oldest first). Each roster at or below the head must match what this
   * device stored, unless it proves a fork; each above it must be a valid successor. A page that
   * starts above head + 1 leaves a gap and is refused (`gap`); fetch from the head instead.
   */
  async accept(chain: readonly Roster[]): Promise<AcceptResult> {
    if (this.forked !== undefined) return { ok: false, reason: "forked" };
    let advanced = false;
    for (const r of chain) {
      if (r.seq <= this.head.seq) {
        const problem = await this.compareKnown(r);
        if (problem !== undefined) return problem;
        continue;
      }
      if (r.seq > this.head.seq + 1) return { ok: false, reason: "gap" };
      const step = verifyNextRoster(this.head, r);
      if (!step.ok) return { ok: false, reason: step.reason };
      await this.files.saveRoster(step.value);
      this.head = step.value;
      advanced = true;
    }
    if (advanced) {
      const ref = rosterRef(this.head);
      await this.files.updateConfig((c) => (c.pin.seq >= ref.seq ? c : { ...c, pin: ref }));
    }
    return { ok: true, advanced };
  }

  /** A roster at or below the head: fine if it is the one stored (or unknown here), else a mismatch or fork. */
  private async compareKnown(r: Roster): Promise<AcceptResult | undefined> {
    // One await for both cases: V8 miscounts the branch after an await inside a conditional.
    const mine = await (r.seq === this.head.seq ? Promise.resolve(this.head) : this.files.loadRoster(r.seq));
    if (mine === undefined || hash(mine) === hash(r)) return undefined;
    const fork = await this.proveFork(mine, r);
    return fork === undefined ? { ok: false, reason: "roster_mismatch" } : { ok: false, reason: "forked", fork };
  }

  /** Two different rosters at one seq prove a fork only when the other one is valid too. */
  private async proveFork(mine: Roster, other: Roster): Promise<{ a: Roster; b: Roster } | undefined> {
    const prev = other.seq === 1 ? undefined : await this.files.loadRoster(other.seq - 1);
    const valid = other.seq === 1 ? verifyGenesisRoster(other).ok : prev !== undefined && verifyNextRoster(prev, other).ok;
    if (!valid || !detectFork(mine, other)) return undefined;
    await this.markFork(mine, other, prev);
    return { a: mine, b: other };
  }

  private async markFork(a: Roster, b: Roster, base: Roster | undefined): Promise<void> {
    const state: ForkState = { seq: a.seq, a: hash(a), b: hash(b), base: base?.devices.map((d) => d.id) ?? [], at: Date.now() };
    this.forked = state;
    await this.files.saveForkEvidence(a, b);
    await this.files.updateConfig((c) => ({ ...c, fork: state }));
  }
}

/**
 * Sets a device's inbound policy (`wim devices trust|untrust`, the UI's trust actions). Policy
 * keys on the device id, never the name (SPEC section 1). Returns the level set.
 */
export async function setDevicePolicy(files: MeshFiles, deviceId: string, level: Policy): Promise<Policy> {
  await files.updateConfig((c) => ({ ...c, policy: { ...c.policy, [deviceId]: level } }));
  return level;
}

/** The level `trust` sets: `deliver`, or `deliver-relayed` when relayed text is trusted too. */
export function trustLevel(action: "trust" | "untrust", relayed: boolean): Policy {
  return action === "untrust" ? "hold" : relayed ? "deliver-relayed" : "deliver";
}

/** The device that signed the roster adding a device, as that roster's predecessor named it. */
export type Adder = { id: string; name: string };

/**
 * Who added each device of `head` (events `added_by`, `wim status`): the signer of the first
 * stored roster that lists it, walking back from the head while the roster before is stored here.
 * Read only from rosters this device verified (each signed by an admin of the one before), so no
 * message or relay frame can name an adder. Missing for the genesis's devices (nobody added them),
 * and for devices older than the earliest roster stored here (a joining device keeps the chain
 * from its invite's pin on).
 */
export async function addersOf(files: MeshFiles, head: Roster): Promise<Map<string, Adder>> {
  const out = new Map<string, Adder>();
  let cur = head;
  while (cur.seq > 1) {
    // Only the roster this one follows (its `prev` hash), naming its signer; anything else on disk
    // (missing, unreadable, another roster) ends the walk, and the devices before it read as unknown.
    const prev = await files.loadRoster(cur.seq - 1).catch(() => undefined);
    const by = prev !== undefined && hash(prev) === cur.prev ? prev.devices.find((d) => d.id === cur.by) : undefined;
    if (by === undefined) break;
    for (const d of cur.devices) if (!prev!.devices.some((p) => p.id === d.id)) out.set(d.id, { id: by.id, name: by.name });
    cur = prev!;
  }
  return out;
}

/**
 * Whose approval a join was (SPEC section 6a), for the joining device: the device that signed the
 * roster adding it (`admitter`) is the `approver` only when the invite code names it as the
 * invite's maker (`issuer`). Every admin receives a join request, so another admin, another
 * person's in a shared mesh, can add the device first; and a code from before 0.2.0 names no
 * maker. Either way there is no approver, and the admitter is asked about like any other device.
 */
export function joinApproval(adders: ReadonlyMap<string, Adder>, me: string, issuer: string | undefined): { admitter?: Adder; approver?: Adder } {
  const admitter = adders.get(me);
  if (admitter === undefined) return {};
  return admitter.id === issuer ? { admitter, approver: admitter } : { admitter };
}
