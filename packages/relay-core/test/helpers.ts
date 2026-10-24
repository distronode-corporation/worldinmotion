import { DatabaseSync } from "node:sqlite";
import {
  b64u,
  createGenesisRoster,
  deviceIdFromSignPub,
  generateDeviceKeys,
  makeDeviceRecord,
  nextRoster,
  randomBytes,
  rosterRef,
  sealMessage,
  signAuth,
  ulid,
  type DeviceKeys,
  type DeviceRecord,
  type Roster,
  type SendFrame,
} from "@worldinmotion/protocol";
import { MemoryStore, MeshRelay, migrate, SqlStore, type Conn, type ConnState, type MeshStore, type RelayConfig, type RelayHost, type SqlDb } from "../src/index.ts";

export const RELAY = "wss://relay.example";
export const T0 = Date.UTC(2026, 9, 24, 12, 0, 0);
export const MESH = b64u.encode(new Uint8Array(16).fill(7));

export type StoreKind = "memory" | "sql";
export const KINDS: StoreKind[] = ["memory", "sql"];

/**
 * node:sqlite behind the minimal SqlDb surface, as relay-node wires it. It refuses numbered
 * parameters the way Node 22's node:sqlite does, so the store's statements are held to what
 * the oldest supported Node can run, on any Node.
 */
export function sqlDb(db: DatabaseSync): SqlDb {
  const prepare = (sql: string) => {
    if (/\?\d/.test(sql)) throw new Error(`column index out of range (a numbered parameter in: ${sql})`);
    return db.prepare(sql);
  };
  return {
    exec: (sql, ...params) => void prepare(sql).run(...params),
    all: (sql, ...params) => prepare(sql).all(...params) as Record<string, string | number | null>[],
    one: (sql, ...params) => prepare(sql).get(...params) as Record<string, string | number | null> | undefined,
  };
}

export function makeStore(kind: StoreKind, mesh = MESH): MeshStore {
  if (kind === "memory") return new MemoryStore();
  const db = sqlDb(new DatabaseSync(":memory:"));
  migrate(db);
  return new SqlStore(db, mesh);
}

export type Dev = { name: string; id: string; keys: DeviceKeys; record: DeviceRecord };

export function dev(name: string, role: DeviceRecord["role"] = "member", added = T0): Dev {
  const keys = generateDeviceKeys();
  return { name, id: deviceIdFromSignPub(keys.signPub), keys, record: makeDeviceRecord(name, keys, role, added) };
}

/** A fake socket: records what the relay sends and whether it closed it. */
export class FakeConn implements Conn {
  readonly sent: string[] = [];
  closed: { code: number; reason: string } | undefined;
  /** The nonce of this connection's `hello`. */
  nonce = "";
  readonly id: string;
  private readonly onClosed: (c: FakeConn) => void;
  constructor(id: string, onClosed: (c: FakeConn) => void) {
    this.id = id;
    this.onClosed = onClosed;
  }
  send(text: string): void {
    this.sent.push(text);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.onClosed(this);
  }
  frames(): Record<string, any>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, any>);
  }
  /** Frames sent since the last call. */
  take(): Record<string, any>[] {
    const out = this.frames();
    this.sent.length = 0;
    return out;
  }
  of(t: string): Record<string, any>[] {
    return this.frames().filter((f) => f["t"] === t);
  }
  last(t?: string): Record<string, any> {
    const all = t === undefined ? this.frames() : this.of(t);
    return all.at(-1)!;
  }
}

/** A host around one MeshRelay: fake connections, a hand-wound clock, saved connection states. */
export class Harness {
  now = T0;
  readonly conns = new Map<string, FakeConn>();
  readonly states = new Map<string, ConnState>();
  readonly logs: { event: string; fields: Record<string, unknown> }[] = [];
  relay: MeshRelay;
  readonly store: MeshStore;
  readonly config: Partial<RelayConfig>;
  /** Host hooks beyond the ones the harness provides (for example `admitMesh`). */
  readonly extra: Partial<RelayHost>;
  private next = 0;

  constructor(store: MeshStore, config: Partial<RelayConfig> = {}, extra: Partial<RelayHost> = {}) {
    this.store = store;
    this.config = config;
    this.extra = extra;
    this.relay = this.build();
  }

  build(): MeshRelay {
    return new MeshRelay(
      { meshId: MESH, relayUrls: [RELAY], ...this.config },
      {
        store: this.store,
        now: () => this.now,
        connections: () => this.conns.values(),
        getState: (c) => this.states.get(c.id),
        setState: (c, s) => void this.states.set(c.id, JSON.parse(JSON.stringify(s)) as ConnState),
        log: (event, fields) => void this.logs.push({ event, fields }),
        ...this.extra,
      },
    );
  }

  /** Drops the relay instance and builds a new one from the store and saved states (hibernation). */
  hibernate(): void {
    this.relay = this.build();
  }

  open(source = "src-1"): FakeConn {
    const c = new FakeConn(`c${++this.next}`, (x) => this.conns.delete(x.id));
    this.conns.set(c.id, c);
    this.relay.onOpen(c, { source });
    c.nonce = (JSON.parse(c.sent[0]!) as { nonce: string }).nonce;
    return c;
  }

  /** The client side hung up. */
  drop(c: FakeConn): void {
    this.conns.delete(c.id);
    this.relay.onClose(c);
  }

  sendFrame(c: FakeConn, frame: unknown): void {
    this.relay.onMessage(c, typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  advance(ms: number): void {
    this.now += ms;
    this.relay.tick(this.now);
  }
}

/** One client session: a device, a sid, a resume secret, and its connection. */
export class Client {
  conn!: FakeConn;
  name: string;
  seq = 0;
  ready: Record<string, any> | undefined;
  readonly sid: string;
  readonly resume: string;
  readonly h: Harness;
  readonly d: Dev;

  constructor(h: Harness, d: Dev, name: string, opts: { sid?: string; resume?: string } = {}) {
    this.h = h;
    this.d = d;
    this.name = name;
    this.sid = opts.sid ?? ulid();
    this.resume = opts.resume ?? b64u.encode(randomBytes(32));
  }

  get address(): string {
    return `${this.name}@${this.d.name}`;
  }

  authFrame(nonce: string, opts: { cursor?: number; pin?: { seq: number; hash: string }; at?: number; relay?: string } = {}) {
    return signAuth(
      {
        relay: opts.relay ?? RELAY,
        mesh: MESH,
        nonce,
        at: opts.at ?? this.h.now,
        session: { name: this.name, kind: "cli", sid: this.sid, resume: this.resume },
        resume: opts.cursor === undefined ? undefined : { cursor: opts.cursor },
        pin: opts.pin ?? rosterRef(roster(this.h)),
      },
      this.d.keys,
    );
  }

  /** Opens a connection and authenticates. Returns the frames after `hello`. */
  connect(opts: { cursor?: number; pin?: { seq: number; hash: string } } = {}): Record<string, any>[] {
    this.conn = this.h.open();
    const hello = this.conn.take()[0]!;
    this.h.sendFrame(this.conn, this.authFrame(hello["nonce"] as string, opts));
    const frames = this.conn.take();
    this.ready = frames.find((f) => f["t"] === "ready");
    if (this.ready) this.name = this.ready["name"] as string;
    return frames;
  }

  seal(to: string[], opts: { text?: string; recipients?: string[]; id?: string; r?: Roster; at?: number } = {}): SendFrame {
    const r = opts.r ?? roster(this.h);
    const broadcast = to.includes("*") || to.some((a) => a.startsWith("#"));
    const recipients =
      opts.recipients ??
      (broadcast
        ? r.devices.map((d) => d.id)
        : [...new Set(to.map((a) => r.devices.find((d) => d.name === a.split("@")[1])?.id).filter((x): x is string => x !== undefined))]);
    return sealMessage({
      roster: r,
      sender: { deviceId: this.d.id, keys: this.d.keys },
      session: this.name,
      sid: this.sid,
      to,
      seq: ++this.seq,
      at: opts.at ?? this.h.now,
      id: opts.id,
      text: opts.text ?? "hello",
      recipients: recipients.length > 0 ? recipients : [this.d.id],
    });
  }

  /** Seals and sends; returns the `sent` answer. */
  send(to: string[], opts: Parameters<Client["seal"]>[1] = {}): Record<string, any> {
    const f = this.seal(to, opts);
    this.h.sendFrame(this.conn, f);
    return this.conn.last();
  }

  /** Sends a frame and returns only the frames that answer it (earlier pushes are discarded). */
  frame(frame: unknown): Record<string, any>[] {
    this.conn.take();
    this.h.sendFrame(this.conn, frame);
    return this.conn.take();
  }
}

/** The newest roster the relay holds. */
export function roster(h: Harness): Roster {
  return JSON.parse(h.store.getRoster(h.store.rosterHead())!.json) as Roster;
}

export type World = { h: Harness; admin: Dev; members: Dev[]; chain: Roster[]; root: Client };

/**
 * A mesh created over the wire: the admin creates it, connects as session `root`, and publishes a
 * roster adding each member device.
 */
export function world(kind: StoreKind, memberNames: string[] = [], config: Partial<RelayConfig> = {}): World {
  const h = new Harness(makeStore(kind), config);
  const admin = dev("admin", "admin");
  const genesis = createGenesisRoster({ name: "admin", keys: admin.keys, now: T0, meshId: MESH });
  const c = h.open();
  h.sendFrame(c, { t: "create", roster: genesis, ...(config.createKey ? { key: config.createKey } : {}) });
  const chain = [genesis];
  const root = new Client(h, admin, "root");
  root.connect();
  const members: Dev[] = [];
  for (const name of memberNames) {
    const m = dev(name);
    members.push(m);
    const next = nextRoster(chain.at(-1)!, { add: [m.record] }, admin, T0);
    chain.push(next);
    root.frame({ t: "roster.publish", roster: next });
  }
  return { h, admin, members, chain, root };
}

/** Publishes a roster through the admin's root session. */
export function publish(w: World, change: { add?: DeviceRecord[]; revoke?: string[] }, signer: Dev = w.admin): Roster {
  const next = nextRoster(w.chain.at(-1)!, change, signer, w.h.now);
  w.chain.push(next);
  w.root.frame({ t: "roster.publish", roster: next });
  return next;
}
