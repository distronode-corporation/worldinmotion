import {
  b64u,
  bytesEqual,
  clientFrameSchema,
  CLOSE,
  detectFork,
  fitsUtf8,
  hash,
  isRecoveryName,
  isRoom,
  LIMITS,
  parseClientFrame,
  parseJson,
  parseRecoverAuthFrame,
  randomBytes,
  relayDialUrl,
  utf8,
  verifyAuth,
  verifyGenesisRoster,
  verifyJoin,
  verifyNextRoster,
  verifyRecoverAuth,
  WIRE_VERSION,
  type AuthFrame,
  type BlobPutFrame,
  type ClientFrame,
  type CreateFrame,
  type JoinFrame,
  type Peer,
  type RdvPutFrame,
  type RecoverAuthFrame,
  type Roster,
  type SendFrame,
  type SendResult,
} from "@worldinmotion/protocol";
import type { RdvOutcome, RdvPut } from "./rdv.ts";
import type { LeaseRow, MeshStore, RoomRow, SessionRow } from "./store.ts";

/** One client connection, as the host's transport presents it. */
export type Conn = {
  /** Unique among the host's open connections, and stable across a hibernation. */
  id: string;
  send(text: string): void;
  close(code: number, reason: string): void;
};

/**
 * Everything the relay knows about a connection, kept by the host beside the socket (a Durable
 * Object stores it as the WebSocket attachment). It is small and JSON-serialisable, so a relay
 * instance can be dropped at any moment and rebuilt from the store plus these objects.
 */
export type ConnState = {
  /** `recover`: a recovery record's connection (SPEC 4a), which may only read and publish rosters. */
  phase: "pre" | "authed" | "recover" | "closed";
  /** The `hello` nonce this connection's `auth` must sign. */
  nonce: string;
  /** When a connection that has not authenticated is closed (ms), or 0 once authenticated. */
  deadline: number;
  /** The host's key for the client's source address (for example a hashed IP), for rate limits. */
  source: string;
  /** The invite id a joining connection waits on, or null. */
  join: string | null;
  sid: string | null;
  device: string | null;
  name: string | null;
};

export type Limits = { -readonly [K in keyof typeof LIMITS]: number };

export type RelayConfig = {
  meshId: string;
  /** The relay's exact public base URLs; an `auth` must name one of them byte for byte. */
  relayUrls: readonly string[];
  /** When set, `create` must carry this operator key. */
  createKey?: string;
  /**
   * When set, every `create` is refused with this message, whatever key it carries: a relay
   * whose operator did not open creation, or whose creation settings are wrong (see
   * `createRule`). Without it or `createKey`, anyone may create a mesh.
   */
  createRefused?: string;
  /** Lower relay-side limits than the protocol defaults. */
  limits?: Partial<Limits>;
};

export type RelayHost = {
  store: MeshStore;
  now(): number;
  /** Every open connection on this mesh, including ones restored after a hibernation. */
  connections(): Iterable<Conn>;
  getState(conn: Conn): ConnState | undefined;
  setState(conn: Conn, state: ConnState): void;
  /** Operational events worth an operator's attention (forks, revocation purges). */
  log(event: string, fields: Record<string, unknown>): void;
  /**
   * The `create` and `join` limit per source address. A new mesh id means a new relay instance,
   * so a limit kept in one mesh's store cannot stop one address creating many meshes: a host that
   * serves several meshes passes a limiter shared by all of them. Without one, the relay keeps the
   * limit in this mesh's store.
   */
  allowSource?(source: string, now: number): boolean;
  /**
   * Whether the relay may hold one more mesh (a cap across every mesh the host serves), asked
   * only for a valid `create` of a mesh that does not exist yet. Without it, there is no cap.
   */
  admitMesh?(): boolean;
  /**
   * The relay-wide store for short invite codes (SPEC section 5, `Rendezvous`), handed an
   * `rdv.put` the relay has checked and the function that answers it. A host whose store is in
   * another object answers once that object has, which may be after this call returns. Without
   * it, `rdv.put` is answered `unsupported`.
   */
  rdvPut?(put: RdvPut, answer: (outcome: RdvOutcome) => void): void;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The longest any relay keeps a room history entry, a queued message or a blob chunk. It is the
 * protocol's room history lifetime (72 hours, the prekey retention that forward secrecy
 * promises). Relay-side limits may lower each of those lifetimes but never raise one past this.
 * Peer cards are not covered: the relay keeps a session's newest card while the session exists,
 * and clients re-seal cards themselves.
 */
export const RETENTION_MS: number = LIMITS.roomHistoryLifetimeMs;

/**
 * The most room history rows one sweep (`tick`) deletes per mesh. History is bounded (100 per
 * room, 64 MiB per mesh), so this only matters when much expires at once, as on the first sweep
 * after the retention shrank from 7 days: the backlog then goes over a few sweeps, each short
 * enough for a Durable Object alarm, and expired rows are never served in the meantime.
 */
export const HISTORY_SWEEP_BATCH = 256;

/** The lifetimes of relay-held ciphertext, which `RETENTION_MS` caps. */
const RETAINED = ["roomHistoryLifetimeMs", "queueLifetimeMs", "blobLifetimeMs"] as const;

// Every client frame type the protocol defines, so a pre-auth `send` can be told apart from a
// type that does not exist at all (the first is `unauthorized`, the second `unknown_type`).
const CLIENT_TYPES: ReadonlySet<string> = new Set(clientFrameSchema.options.map((o) => o.shape.t.value));

// Parse failures that have an error code of their own; everything else is `malformed`.
const PARSE_CODES: Record<string, string> = {
  duplicate_key: "duplicate_key",
  unknown_type: "unknown_type",
  too_large: "too_large",
};

type Target = { to: string; session: SessionRow };

/** The `error` code and message for each way the relay-wide store refuses an `rdv.put`. */
const RDV_REFUSALS: Record<Exclude<RdvOutcome, "stored">, [string, string]> = {
  exists: ["rdv_exists", "a short invite code with that id is already stored"],
  limited: ["limited", "too many short invite codes from this address for now; try again later"],
  full: ["full", "this relay holds as many short invite codes as it can; try again later"],
  unavailable: ["unavailable", "the relay could not store the short invite code"],
};
type LeaseStatus = "granted" | "held" | "released" | "expired" | "renewed" | "refused";

/**
 * The relay for one mesh: a state machine with no I/O. The host feeds it connection events and a
 * clock and gives it a store; it answers by calling `send` and `close` on connections.
 */
export class MeshRelay {
  readonly limits: Limits;
  private readonly config: RelayConfig;
  private readonly host: RelayHost;
  private readonly store: MeshStore;
  private cached: Roster | undefined;

  constructor(config: RelayConfig, host: RelayHost) {
    if (config.relayUrls.length === 0) throw new TypeError("MeshRelay: at least one relay URL");
    // relayDialUrl validates both the URL spelling and the mesh id, and throws on either.
    for (const url of config.relayUrls) relayDialUrl(url, config.meshId);
    this.config = config;
    this.host = host;
    this.limits = { ...LIMITS, ...config.limits };
    for (const k of RETAINED) this.limits[k] = Math.min(this.limits[k], RETENTION_MS);
    this.store = host.store;
    this.reconcile();
  }

  /**
   * Whether this mesh exists: it has a genesis roster. Until it does, the relay writes nothing to
   * the store except the `create` that makes it, so a host can drop (or never persist) the state
   * of a mesh id that was only dialled.
   */
  exists(): boolean {
    return this.store.rosterHead() > 0;
  }

  /**
   * Whether an authenticated (or recovery) connection is open on this mesh. A host measures how
   * long a mesh has been idle from the moment this turns false.
   */
  active(): boolean {
    for (const c of this.host.connections()) {
      const phase = this.host.getState(c)!.phase;
      if (phase === "authed" || phase === "recover") return true;
    }
    return false;
  }

  // ---- connection events ----

  /** A new connection. `source` is the host's rate-limit key for the client's address. */
  onOpen(conn: Conn, opts: { source: string }): void {
    const now = this.host.now();
    const nonce = b64u.encode(randomBytes(32));
    this.host.setState(conn, {
      phase: "pre",
      nonce,
      deadline: now + this.limits.authDeadlineMs,
      source: opts.source,
      join: null,
      sid: null,
      device: null,
      name: null,
    });
    this.emit(conn, { t: "hello", v: WIRE_VERSION, nonce, at: now });
  }

  onMessage(conn: Conn, text: string): void {
    const st = this.host.getState(conn);
    if (st === undefined || st.phase === "closed") return;
    if (st.phase === "pre") this.preAuth(conn, st, text);
    else if (st.phase === "recover") this.recovering(conn, st, text);
    else this.authed(conn, st, text);
  }

  onClose(conn: Conn): void {
    const st = this.host.getState(conn);
    if (st === undefined || st.phase === "closed") return;
    this.host.setState(conn, { ...st, phase: "closed" });
    // A disconnect is not an end: the session keeps its name, queue, rooms and leases.
    if (st.phase === "authed") this.goOffline(this.store.getSession(st.sid!)!);
  }

  /** Expiry sweeps. Call about once a second. */
  tick(now: number): void {
    const L = this.limits;
    for (const conn of this.host.connections()) {
      const st = this.host.getState(conn)!;
      if (st.phase !== "pre" || st.deadline > now) continue;
      if (st.join !== null) this.error(conn, "invite_expired", "the invite expired before an admin answered", "join");
      this.shut(conn, st, CLOSE.authTimeout, "auth timeout");
    }

    // Sessions first, so a sender gone for a day no longer receives receipts below.
    for (const s of this.store.sessions()) {
      const tombstoneDone = s.ended !== null && s.ended <= now - L.queueLifetimeMs;
      const abandoned = s.ended === null && s.conn === null && s.since <= now - L.queueLifetimeMs;
      if (tombstoneDone || (abandoned && this.store.queueCount(s.sid) === 0)) this.store.deleteSession(s.sid);
    }

    for (const item of this.store.expiredQueue(now - L.queueLifetimeMs)) {
      this.store.dropQueueItem(item.sid, item.cur);
      const m = this.store.getMessage(item.id)!;
      const sender = this.connFor(this.store.getSession(m.sender));
      const rcpt = this.store.getSession(item.sid)!;
      if (sender) this.emit(sender, { t: "receipt", id: item.id, to: this.address(rcpt), status: "expired" });
    }
    this.store.pruneMessages(now - L.queueLifetimeMs);
    this.store.pruneIdle(now);
    for (const inv of this.store.expiredInvites(now)) {
      this.store.deleteInvite(inv.id);
      this.store.deleteJoin(inv.id);
    }

    // Waiters whose own ttl passed give up before an expiring lease could be handed to them.
    for (const w of this.store.expiredWaiters(now)) {
      this.store.deleteWaiter(w.key, w.sid);
      this.leaseTo(this.store.getSession(w.sid), w.key, "expired");
    }
    for (const l of this.store.expiredLeases(now)) this.free(l, "expired", now);
    this.store.pruneWatches(now);

    this.store.pruneHistory(now - L.roomHistoryLifetimeMs, HISTORY_SWEEP_BATCH);
    this.store.pruneRooms();
    this.store.pruneChunks(now - L.blobLifetimeMs);
    // The slowest bucket (blob bytes per device) refills completely within a day.
    this.store.pruneBuckets(now - DAY);
  }

  // ---- before auth ----

  private preAuth(conn: Conn, st: ConnState, text: string): void {
    if (!fitsUtf8(text, this.limits.preAuthFrameBytes)) {
      this.error(conn, "too_large", "frames before auth are limited in size");
      return this.shut(conn, st, CLOSE.protocol, "too large");
    }
    const parsed = parseClientFrame(text, { preAuth: true });
    // A recovery `auth` has its own shape (no session, a genesis pin), so a session `auth` parse fails on it.
    const recover = parsed.ok ? undefined : parseRecoverAuthFrame(text);
    if (recover?.ok) return this.recoverAuth(conn, st, recover.value);
    if (!parsed.ok) {
      if (parsed.reason === "unknown_type") {
        const t = peekType(text);
        if (CLIENT_TYPES.has(t)) return this.error(conn, "unauthorized", "authenticate first", t);
        return this.error(conn, "unknown_type", "unknown frame type", t);
      }
      this.error(conn, PARSE_CODES[parsed.reason] ?? "malformed", parsed.reason);
      return this.shut(conn, st, CLOSE.protocol, "malformed");
    }
    const f = parsed.value;
    if (f.t === "auth") return this.auth(conn, st, f);
    if (!this.allowSource(st)) {
      this.error(conn, "limited", "too many create or join requests from this address", f.t);
      return this.shut(conn, st, CLOSE.limited, "limited");
    }
    if (f.t === "create") return this.create(conn, f);
    this.join(conn, st, f as JoinFrame);
  }

  /**
   * A recovery record's `auth` (SPEC 4a): relay, nonce and clock checks, a genesis pin, and a
   * current recovery record as the device. It opens no session; the connection may then only read
   * the chain and publish one roster. It has its own budget per mesh (`recoveryPerMeshPerHour`)
   * and is not counted against the per-source create and join budget. A mesh that does not exist
   * is refused before the budget is touched, so the attempt stores nothing.
   */
  private recoverAuth(conn: Conn, st: ConnState, f: RecoverAuthFrame): void {
    const refuse = (code: string, message: string, close: number) => {
      this.error(conn, code, message, "auth");
      this.shut(conn, st, close, code);
    };
    if (!this.exists()) return refuse("unauthorized", "unknown mesh", CLOSE.unauthorized);
    // Recovery has its own budget per mesh, apart from the per-source create and join budget.
    const L = this.limits;
    const now = this.host.now();
    const level = this.level("recover", L.recoveryPerMeshPerHour, L.recoveryPerMeshPerHour / HOUR, now);
    if (level < 1) return refuse("limited", "too many recovery attempts for this mesh", CLOSE.limited);
    this.spend("recover", level, 1, now);
    const genesis = JSON.parse(this.store.getRoster(1)!.json) as Roster;
    const v = verifyRecoverAuth(f, { roster: this.roster(), genesis }, { relay: this.config.relayUrls, nonce: st.nonce, now, skewMs: L.authSkewMs });
    if (!v.ok) return refuse("unauthorized", v.reason, CLOSE.unauthorized);
    this.host.setState(conn, { ...st, phase: "recover", deadline: 0, device: f.device });
    this.emit(conn, { t: "recover.ready", roster: this.roster() });
  }

  private recovering(conn: Conn, st: ConnState, text: string): void {
    if (!fitsUtf8(text, this.limits.frameBytes)) return this.error(conn, "too_large", "frame is too large");
    const parsed = parseClientFrame(text);
    if (!parsed.ok) return this.error(conn, PARSE_CODES[parsed.reason] ?? "malformed", parsed.reason);
    const f = parsed.value;
    if (f.t === "roster.get") return this.rosterGet(conn, f.from);
    if (f.t !== "roster.publish") return this.error(conn, "unauthorized", "a recovery connection only reads and publishes rosters", f.t);
    this.publish(conn, st.device!, f.roster, this.host.now());
    this.shut(conn, this.host.getState(conn)!, CLOSE.recovered, "recovered");
  }

  private create(conn: Conn, f: CreateFrame): void {
    if (this.config.createRefused !== undefined) return this.error(conn, "unauthorized", this.config.createRefused, "create");
    const key = this.config.createKey;
    if (key !== undefined && !bytesEqual(utf8(f.key ?? ""), utf8(key))) {
      return this.error(conn, "unauthorized", "this relay needs an operator key to create a mesh", "create");
    }
    if (f.roster.mesh !== this.config.meshId) return this.error(conn, "malformed", "the roster is for another mesh", "create");
    const v = verifyGenesisRoster(f.roster);
    if (!v.ok) return this.error(conn, "roster_invalid", v.reason, "create");
    if (this.exists()) return this.error(conn, "mesh_exists", "a mesh with this id already exists", "create");
    if (this.host.admitMesh?.() === false) {
      return this.error(conn, "full", "this relay holds as many meshes as it accepts; try again later", "create");
    }
    // The relay handles one frame at a time, so nothing can insert a genesis between the
    // `exists()` check above and this insert.
    this.store.insertRoster({ seq: 1, hash: hash(v.value), json: JSON.stringify(v.value) });
    this.cached = v.value;
    this.emit(conn, { t: "roster", chain: [v.value], more: false });
  }

  private join(conn: Conn, st: ConnState, f: JoinFrame): void {
    const now = this.host.now();
    if (f.mesh !== this.config.meshId || !this.exists()) return this.error(conn, "unauthorized", "unknown mesh", "join");
    // The join is signed over this connection's hello nonce, so a captured join cannot be replayed elsewhere.
    const v = verifyJoin(f, undefined, st.nonce);
    if (!v.ok) return this.error(conn, "malformed", v.reason, "join");
    const body = v.value;
    const inv = this.store.getInvite(body.invite);
    if (inv === undefined) return this.error(conn, "invite_unknown", "no such invite", "join");
    if (inv.exp <= now) return this.error(conn, "invite_expired", "the invite has expired", "join");
    if (this.roster().revoked.includes(body.device.id)) return this.error(conn, "unauthorized", "this device was revoked", "join");
    // An invite belongs to the first device that joined with it; only that device may ask again.
    if (inv.joiner !== null && inv.joiner !== body.device.id) return this.error(conn, "invite_used", "the invite was already used", "join");
    const pending = this.store.getJoin(inv.id);
    if (pending !== undefined && pending.device !== body.device.id) {
      return this.error(conn, "invite_used", "another device is already joining with this invite", "join");
    }
    // Waiting connections are capped per invite and per mesh. A fresh join signed by the same
    // device replaces its older waiting connections rather than piling up beside them.
    const waiting = [...this.host.connections()].filter((c) => {
      const s = this.host.getState(c)!;
      return c.id !== conn.id && s.phase === "pre" && s.join !== null;
    });
    const same = waiting.filter((c) => this.host.getState(c)!.join === inv.id);
    if (waiting.length - same.length >= this.limits.pendingJoinsPerMesh) {
      return this.error(conn, "limited", "too many joins are waiting in this mesh", "join");
    }
    for (const c of same.slice(0, Math.max(0, same.length - this.limits.pendingJoinsPerInvite + 1))) {
      this.shut(c, this.host.getState(c)!, CLOSE.replaced, "replaced by a newer join");
    }
    if (inv.joiner !== null) {
      // The joined device missed `joined`: it gets the answer again, then authenticates.
      this.host.setState(conn, { ...st, join: inv.id, deadline: now + this.limits.authDeadlineMs });
      return this.emit(conn, { t: "joined", ...this.page(inv.pinSeq) });
    }
    this.store.putJoin({ invite: inv.id, device: body.device.id, body: JSON.stringify(body), exp: inv.exp });
    // A joiner waits for a person's decision, so its deadline is the invite's expiry.
    this.host.setState(conn, { ...st, join: inv.id, deadline: inv.exp });
    const request = JSON.stringify({ t: "join.request", join: body });
    for (const c of this.adminConns()) c.send(request);
  }

  private auth(conn: Conn, st: ConnState, f: AuthFrame): void {
    const now = this.host.now();
    const refuse = (code: string, message: string) => {
      this.error(conn, code, message, "auth");
      this.shut(conn, st, code === "limited" ? CLOSE.limited : CLOSE.unauthorized, code);
    };
    if (f.mesh !== this.config.meshId || !this.exists()) return refuse("unauthorized", "unknown mesh");
    const roster = this.roster();
    // By id only: the roster lists current devices, so a revoked device is not found.
    const device = roster.devices.find((d) => d.id === f.device);
    if (device === undefined) return refuse("unauthorized", "the device is not in the roster");
    // A recovery record only signs a roster from its offline code; it never connects (SPEC 4a).
    if (isRecoveryName(device.name)) return refuse("unauthorized", "recovery records do not connect");
    const v = verifyAuth(f, b64u.decode(device.sign), { relay: this.config.relayUrls, nonce: st.nonce, now, skewMs: this.limits.authSkewMs });
    if (!v.ok) return refuse("unauthorized", v.reason);
    if (f.pin.seq > roster.seq) return refuse("unauthorized", "the pinned roster is newer than any this relay holds");
    const pinned = this.store.getRoster(f.pin.seq)!;
    if (pinned.hash !== f.pin.hash) {
      const fork = { at: now, seq: f.pin.seq, kind: "pin" as const, signer: f.device, a: pinned.hash, b: f.pin.hash };
      this.store.addFork(fork);
      this.host.log("fork", fork);
    }

    const claim = this.claim(f, now);
    if (typeof claim === "string") return refuse(claim === "limited" ? "limited" : "unauthorized", claim);
    const row = claim;
    row.kind = f.session.kind;
    row.resume = hash(f.session.resume);
    row.conn = conn.id;
    row.status = "idle";
    row.since = now;
    // A resume cursor acknowledges what the client already holds, never more than was delivered.
    const through = Math.min(f.resume?.cursor ?? 0, row.delivered);
    if (through > row.acked) {
      this.store.dequeueThrough(row.sid, through);
      row.acked = through;
    }
    const queued = this.store.queue(row.sid, row.acked);
    for (const item of queued) row.delivered = Math.max(row.delivered, item.cur);
    this.store.putSession(row);
    this.host.setState(conn, { ...st, phase: "authed", deadline: 0, join: null, sid: row.sid, device: row.device, name: row.name });

    this.emit(conn, {
      t: "ready",
      sid: row.sid,
      name: row.name,
      cursor: row.acked,
      roster,
      more: roster.seq > f.pin.seq + 1,
      peers: this.peerRows(row.sid),
    });
    this.sendCards(conn);
    for (const item of queued) conn.send(deliverText(item.cur, item.msg));
    if (device.role === "admin") {
      for (const j of this.store.joins()) if (j.exp > now) conn.send(`{"t":"join.request","join":${j.body}}`);
    }
    this.pushPeer(row);
  }

  /**
   * Finds or creates the session an `auth` claims (SPEC section 8, names). Returns the row to
   * bring online, or the reason for refusing.
   */
  private claim(f: AuthFrame, now: number): SessionRow | string {
    const { sid, name } = f.session;
    const own = this.store.getSession(sid);
    if (own !== undefined) {
      if (own.device !== f.device || own.ended !== null) return "the session id is not available";
      // A sid is visible to every recipient and in peer rows, so it never proves a claim alone:
      // reclaiming a session, online or offline, needs its resume secret.
      if (own.resume !== hash(f.session.resume)) return "the session id is not available without its resume secret";
      if (own.conn !== null) {
        // The same process reconnecting before its old socket was noticed as gone.
        const old = this.connFor(own)!;
        this.shut(old, this.host.getState(old)!, CLOSE.replaced, "replaced by a new connection");
      }
      return { ...own, name: this.freeName(f.device, name, sid) };
    }
    const live = this.store.sessionsOf(f.device).filter((s) => s.ended === null);
    const holder = live.find((s) => s.name === name);
    if (holder !== undefined && holder.conn === null && holder.resume === hash(f.session.resume)) {
      // An agent restarting with its resume secret keeps its name, queue, rooms and leases.
      this.store.rekeySession(holder.sid, sid);
      return { ...holder, sid };
    }
    const meshLive = this.store.sessions().filter((s) => s.ended === null).length;
    if (live.length >= this.limits.sessionsPerDevice || meshLive >= this.limits.sessionsPerMesh) return "limited";
    return {
      sid,
      device: f.device,
      name: this.freeName(f.device, name, sid),
      kind: f.session.kind,
      status: "idle",
      since: now,
      conn: null,
      ended: null,
      resume: "",
      acked: 0,
      delivered: 0,
      nextCursor: 1,
    };
  }

  /** `name`, or the first free `name-2`, `name-3`, ... on the device (ignoring session `self`). */
  private freeName(device: string, name: string, self: string): string {
    const taken = new Set(
      this.store
        .sessionsOf(device)
        .filter((s) => s.ended === null && s.sid !== self)
        .map((s) => s.name),
    );
    let candidate = name;
    for (let k = 2; taken.has(candidate); k++) {
      const suffix = `-${k}`;
      candidate = name.slice(0, 32 - suffix.length) + suffix;
    }
    return candidate;
  }

  // ---- after auth ----

  private authed(conn: Conn, st: ConnState, text: string): void {
    if (!fitsUtf8(text, this.limits.frameBytes)) return this.error(conn, "too_large", "frame is too large");
    const parsed = parseClientFrame(text);
    if (!parsed.ok) {
      const ref = parsed.reason === "unknown_type" ? peekType(text) : undefined;
      return this.error(conn, PARSE_CODES[parsed.reason] ?? "malformed", parsed.reason, ref);
    }
    const f: ClientFrame = parsed.value;
    if (f.t === "card.set" && !fitsUtf8(text, this.limits.cardFrameBytes)) return this.error(conn, "too_large", "card is too large", f.t);
    const s = this.store.getSession(st.sid!)!;
    const now = this.host.now();
    switch (f.t) {
      case "auth":
      case "create":
      case "join":
        return this.error(conn, "unauthorized", "this connection is already authenticated", f.t);
      case "send":
        return this.send(conn, s, f, now);
      case "ack":
        return this.ack(conn, s, f.cursor);
      case "receipt":
        return this.receipt(conn, s, f.id, f.status);
      case "presence":
        return this.presence(s, f.status, now);
      case "peers":
        return this.emit(conn, { t: "peers", peers: this.peerRows(s.sid) });
      case "rename":
        return this.rename(conn, st, s, f.name);
      case "notify_idle":
        return this.notifyIdle(conn, s, f.of, now);
      case "invite.create":
        return this.inviteCreate(conn, s, f.invite, f.exp, f.pin, now);
      case "roster.publish":
        return this.publish(conn, s.device, f.roster, now);
      case "roster.get":
        return this.rosterGet(conn, f.from);
      case "roster.fork":
        return this.forkEvidence(conn, s, f.a, f.b, now);
      case "room.join":
        return this.roomJoin(conn, s, f.room, now);
      case "room.leave":
        return this.roomLeave(conn, s, f.room);
      case "room.history":
        return this.roomHistory(conn, f.room, f.before, f.limit);
      case "lease.acquire":
        return this.leaseAcquire(conn, s, f.key, f.ttl, f.wait === true, now);
      case "lease.renew":
        return this.leaseRenew(conn, s, f.key, f.token, f.ttl, now);
      case "lease.release":
        return this.leaseRelease(conn, s, f.key, f.token, now);
      case "lease.list":
        return this.leaseList(conn, now);
      case "lease.watch":
        return this.leaseWatch(conn, s, f.key, now);
      case "blob.put":
        return this.blobPut(conn, s, f, now);
      case "blob.get":
        return this.blobGet(conn, f.blob, f.index);
      case "card.set":
        return this.cardSet(conn, s, f.msg, now);
      case "cards.get":
        return this.sendCards(conn, f.after);
      case "rdv.put":
        return this.rdvPut(conn, st, s, f, now);
      case "ping":
        return this.emit(conn, { t: "pong" });
      case "bye":
        return this.bye(conn, st, s, f.ended, now);
    }
  }

  // ---- messages ----

  private send(conn: Conn, s: SessionRow, f: SendFrame, now: number): void {
    const L = this.limits;
    if (f.from.device !== s.device || f.from.sid !== s.sid || f.from.session !== s.name) {
      return this.error(conn, "unauthorized", "from does not match this connection", f.id);
    }
    if (f.mesh !== this.config.meshId) return this.error(conn, "malformed", "wrong mesh", f.id);
    const prior = this.store.getMessage(f.id);
    if (prior !== undefined && prior.sender !== s.sid) return this.error(conn, "malformed", "message id already used", f.id);

    // A room send fans out like a broadcast, so it shares the broadcast rate (SPEC section 13).
    const everyone = f.to.includes("*");
    const broadcast = everyone || f.to.some(isRoom);
    const sends = this.level(`send:${s.sid}`, L.sendBurst, L.sendsPerMinute / MINUTE, now);
    const casts = broadcast ? this.level(`bcast:${s.sid}`, L.broadcastsPerMinute, L.broadcastsPerMinute / MINUTE, now) : 1;
    if (sends < 1 || casts < 1) {
      return this.emit(conn, { t: "sent", id: f.id, results: f.to.map((to) => ({ to, status: "limited" })) });
    }
    this.spend(`send:${s.sid}`, sends, 1, now);
    if (broadcast) this.spend(`bcast:${s.sid}`, casts, 1, now);

    // Resolve addresses; each session receives a message once however often `to` reaches it.
    const results: SendResult[] = [];
    const targets: Target[] = [];
    const rooms = new Map<string, RoomRow>();
    const seen = new Set<string>([s.sid]);
    const reach = (r: SessionRow, to: string) => {
      if (seen.has(r.sid)) return;
      seen.add(r.sid);
      targets.push({ to, session: r });
    };
    for (const to of f.to) {
      if (to === "*") continue;
      if (isRoom(to)) {
        const room = this.store.getRoom(to);
        if (room === undefined) results.push({ to, status: "unknown" });
        else {
          rooms.set(to, room);
          for (const sid of this.store.members(to)) {
            const m = this.store.getSession(sid)!;
            reach(m, this.address(m));
          }
        }
        continue;
      }
      const r = this.resolve(to);
      if (typeof r === "string") results.push({ to, status: r });
      // An explicit address may name the sender itself; only `*` and rooms skip it.
      else if (r.sid === s.sid) targets.push({ to, session: r });
      else reach(r, to);
    }
    if (everyone) {
      const before = targets.length;
      for (const other of this.store.sessions()) if (other.ended === null) reach(other, this.address(other));
      if (targets.length === before) results.push({ to: "*", status: "unknown" });
    }

    let accepted: Target[] = [];
    for (const t of targets) {
      const r = t.session;
      if (!Object.hasOwn(f.boxes, r.device)) results.push({ to: t.to, status: "invalid" });
      else if (this.store.queueCount(r.sid) >= L.queuePerSession || this.store.queueCountFrom(r.sid, s.device) >= L.queuePerSenderDevice) {
        results.push({ to: t.to, status: "full" });
      } else accepted.push(t);
    }

    const msg = JSON.stringify(f);
    const bytes = utf8(msg).length;
    let stored = true;
    if (accepted.length > 0) {
      // The byte budget is counted after fan-out: a broadcast costs its size once per recipient.
      const fanKey = `fan:${s.device}`;
      const budget = this.level(fanKey, L.fanoutBytesPerMinute, L.fanoutBytesPerMinute / MINUTE, now);
      const cost = bytes * accepted.length;
      if (budget < cost) {
        for (const t of accepted) results.push({ to: t.to, status: "limited" });
        accepted = [];
        stored = false;
      } else this.spend(fanKey, budget, cost, now);
    }

    if (stored) {
      for (const room of rooms.values()) {
        this.store.addHistory({ room: room.room, cur: room.nextCursor, at: now, msg }, L.roomHistoryMessages);
        this.store.putRoom({ ...room, nextCursor: room.nextCursor + 1 });
      }
      // The mesh's history is capped in bytes too; the oldest entries go first, whatever the room.
      while (rooms.size > 0 && this.store.historyBytes() > L.roomHistoryBytesPerMesh) this.store.dropOldestHistory();
    }
    if (accepted.length > 0) {
      const rcpts = new Set(prior?.rcpts);
      for (const t of accepted) rcpts.add(t.session.sid);
      this.store.putMessage({ id: f.id, sender: s.sid, at: now, rcpts: [...rcpts] });
    }
    for (const t of accepted) {
      const r = this.store.getSession(t.session.sid)!;
      const cur = r.nextCursor++;
      this.store.enqueue({ sid: r.sid, cur, id: f.id, fromDevice: s.device, queuedAt: now, bytes, msg });
      const c = this.connFor(r);
      if (c) {
        c.send(deliverText(cur, msg));
        r.delivered = cur;
      }
      this.store.putSession(r);
      results.push({ to: t.to, status: c ? "routed" : "queued" });
    }
    this.emit(conn, { t: "sent", id: f.id, results });
  }

  private ack(conn: Conn, s: SessionRow, cursor: number): void {
    if (cursor > s.delivered) return this.error(conn, "malformed", "ack beyond the highest delivered cursor", "ack");
    if (cursor <= s.acked) return;
    this.store.dequeueThrough(s.sid, cursor);
    this.store.putSession({ ...s, acked: cursor });
  }

  private receipt(conn: Conn, s: SessionRow, id: string, status: "delivered" | "held" | "refused" | "expired"): void {
    if (status === "expired") return this.error(conn, "malformed", "only the relay sends expired receipts", "receipt");
    const m = this.store.getMessage(id);
    // Receipts are advisory, so one the relay cannot route is dropped without an answer.
    if (m === undefined || !m.rcpts.includes(s.sid)) return;
    const sender = this.connFor(this.store.getSession(m.sender));
    if (sender) this.emit(sender, { t: "receipt", id, to: this.address(s), status });
  }

  // ---- sessions ----

  private presence(s: SessionRow, status: "busy" | "idle", now: number): void {
    if (s.status !== status) {
      const row = { ...s, status, since: now };
      this.store.putSession(row);
      this.pushPeer(row);
    }
    if (status === "idle") this.fireIdle(s, now);
  }

  private rename(conn: Conn, st: ConnState, s: SessionRow, name: string): void {
    // An offline holder keeps its name too: only its own resume secret may claim it, at auth.
    const holder = this.store.sessionsOf(s.device).find((o) => o.ended === null && o.name === name && o.sid !== s.sid);
    if (holder !== undefined) return this.error(conn, "name_taken", "a session on this device holds that name", "rename");
    const row = { ...s, name };
    this.store.putSession(row);
    this.host.setState(conn, { ...st, name });
    this.emit(conn, { t: "peer", peer: this.peerRow(row) });
    this.pushPeers();
  }

  private notifyIdle(conn: Conn, s: SessionRow, of: string, now: number): void {
    const target = this.resolve(of);
    if (typeof target === "string") return this.error(conn, "not_found", "no such session", "notify_idle");
    const armed = this.store.idleFor(target.sid).some((r) => r.sub === s.sid);
    if (!armed && this.store.idleCount(s.sid) >= this.limits.notifyIdlePerSession) {
      return this.error(conn, "limited", "too many idle notices armed", "notify_idle");
    }
    this.store.putIdle({ sub: s.sid, target: target.sid, exp: now + this.limits.idleNoticeLifetimeMs });
  }

  private fireIdle(target: SessionRow, now: number): void {
    for (const sub of this.store.idleFor(target.sid)) {
      this.store.deleteIdle(sub.sub, sub.target);
      const c = sub.exp > now ? this.connFor(this.store.getSession(sub.sub)) : undefined;
      if (c) this.emit(c, { t: "notice", kind: "idle", of: this.address(target) });
    }
  }

  private bye(conn: Conn, st: ConnState, s: SessionRow, ended: boolean, now: number): void {
    this.shut(conn, st, CLOSE.bye, "bye");
    if (!ended) return this.goOffline(s);
    // An ended session stays as a tombstone so later sends get `ended`; its name is free, it
    // leaves its rooms and its leases end.
    this.store.dequeueThrough(s.sid, Number.MAX_SAFE_INTEGER);
    this.store.deleteCard(s.sid);
    for (const room of this.store.roomsOf(s.sid)) this.store.removeMember(room, s.sid);
    this.releaseAll(s.sid, now);
    this.store.putSession({ ...s, conn: null, ended: now, since: now });
    this.fireIdle(s, now);
    this.pushPeers();
  }

  private goOffline(s: SessionRow): void {
    const row = { ...s, conn: null, since: this.host.now() };
    this.store.putSession(row);
    this.pushPeer(row);
  }

  // ---- invites and rosters ----

  private inviteCreate(conn: Conn, s: SessionRow, id: string, exp: number, pin: { seq: number; hash: string } | undefined, now: number): void {
    const L = this.limits;
    if (!this.isAdmin(s.device)) return this.error(conn, "unauthorized", "only admin devices create invites", "invite.create");
    if (exp <= now || exp > now + L.inviteMaxTtlMs) return this.error(conn, "malformed", "exp must be in the next 7 days", "invite.create");
    if (this.store.getInvite(id) !== undefined) return this.error(conn, "invite_used", "that invite id is already registered", "invite.create");
    if (this.store.liveInviteCount(s.device, now) >= L.liveInvitesPerDevice) {
      return this.error(conn, "limited", "too many live invites for this device", "invite.create");
    }
    // The pin in the code is where the joiner's chain must start, so `joined` starts there too.
    // Without one (an older client) the newest roster is the best guess.
    const pinned = pin === undefined ? undefined : this.store.getRoster(pin.seq);
    if (pin !== undefined && pinned?.hash !== pin.hash) {
      return this.error(conn, "roster_invalid", "the pin names no roster this relay holds", "invite.create");
    }
    this.store.putInvite({ id, device: s.device, exp, pinSeq: pin?.seq ?? this.store.rosterHead(), joiner: null });
    this.emit(conn, { t: "invite.created", invite: id });
  }

  private rosterGet(conn: Conn, from: number): void {
    if (from > this.store.rosterHead()) return this.error(conn, "malformed", "no roster at that seq", "roster.get");
    this.emit(conn, { t: "roster", ...this.page(from) });
  }

  private publish(conn: Conn, device: string, roster: Roster, now: number): void {
    if (!this.isAdmin(device)) return this.error(conn, "unauthorized", "only admin devices publish rosters", "roster.publish");
    const prevRow = this.store.getRoster(roster.seq - 1);
    if (prevRow === undefined) return this.error(conn, "roster_invalid", "no roster precedes it", "roster.publish");
    const prev = JSON.parse(prevRow.json) as Roster;
    const v = verifyNextRoster(prev, roster);
    if (!v.ok) return this.error(conn, "roster_invalid", v.reason, "roster.publish");
    const next = v.value;
    const h = hash(next);
    // The insert is the compare-and-swap: the first valid roster for a seq wins (SPEC section 4).
    if (!this.store.insertRoster({ seq: next.seq, hash: h, json: JSON.stringify(next) })) {
      const held = this.store.getRoster(next.seq)!;
      if (held.hash === h) return this.emit(conn, { t: "roster", ...this.page(next.seq) });
      // A second valid roster for a held seq is a fork, and the relay is the first to see it.
      this.store.addFork({ at: now, seq: next.seq, kind: "evidence", signer: next.by, a: held.json, b: JSON.stringify(next) });
      this.host.log("fork", { seq: next.seq, signer: next.by, source: "roster.publish" });
      return this.error(conn, "roster_conflict", "a different roster holds that seq", "roster.publish");
    }
    this.cached = next;
    this.afterRoster(prev, next, now);
  }

  private afterRoster(prev: Roster, next: Roster, now: number): void {
    const push = JSON.stringify({ t: "roster", chain: [next], more: false });
    for (const c of this.authedConns()) c.send(push);

    const known = new Set(prev.devices.map((d) => d.id));
    for (const d of next.devices) {
      if (known.has(d.id)) continue;
      const pending = this.store.joins().find((j) => j.device === d.id);
      if (pending === undefined) continue;
      const inv = this.store.getInvite(pending.invite)!;
      this.store.putInvite({ ...inv, joiner: d.id });
      this.store.deleteJoin(inv.id);
      const joined = JSON.stringify({ t: "joined", ...this.page(inv.pinSeq) });
      for (const c of this.host.connections()) {
        const st = this.host.getState(c)!;
        if (st.phase !== "pre" || st.join !== inv.id) continue;
        c.send(joined);
        // The joiner now authenticates with the chain it was sent, under the normal deadline.
        this.host.setState(c, { ...st, deadline: now + this.limits.authDeadlineMs });
      }
    }

    const revoked = next.revoked.slice(prev.revoked.length);
    for (const id of revoked) this.purge(id, now);
    if (revoked.length > 0) this.pushPeers();
  }

  /**
   * A revoked device loses its sessions (with their queues, rooms, leases and waits), the
   * messages and blob chunks it stored, and its invites.
   */
  private purge(device: string, now: number): void {
    const sessions = this.store.sessionsOf(device);
    for (const s of sessions) {
      const c = this.connFor(s);
      if (c) this.shut(c, this.host.getState(c)!, CLOSE.revoked, "device revoked");
      this.releaseAll(s.sid, now);
      this.store.deleteSession(s.sid);
    }
    this.store.dropQueueFrom(device);
    this.store.dropChunksFrom(device);
    for (const inv of this.store.invitesBy(device)) {
      this.store.deleteInvite(inv.id);
      this.store.deleteJoin(inv.id);
    }
    this.host.log("revoked", { device, sessions: sessions.length });
  }

  private forkEvidence(conn: Conn, s: SessionRow, a: Roster, b: Roster, now: number): void {
    // Two rosters prove a fork only if both are valid where they claim to sit in the chain.
    const valid = (r: Roster): boolean => {
      if (r.seq === 1) return verifyGenesisRoster(r).ok;
      const prev = this.store.getRoster(r.seq - 1);
      return prev !== undefined && verifyNextRoster(JSON.parse(prev.json) as Roster, r).ok;
    };
    if (a.mesh !== this.config.meshId || !detectFork(a, b) || !valid(a) || !valid(b)) {
      return this.error(conn, "malformed", "not evidence of a fork in this mesh", "roster.fork");
    }
    this.store.addFork({ at: now, seq: a.seq, kind: "evidence", signer: s.device, a: JSON.stringify(a), b: JSON.stringify(b) });
    this.host.log("fork", { seq: a.seq, signer: s.device, source: "roster.fork" });
  }

  // ---- rooms ----

  private roomJoin(conn: Conn, s: SessionRow, room: string, now: number): void {
    const L = this.limits;
    const mine = this.store.roomsOf(s.sid);
    if (!mine.includes(room)) {
      const exists = this.store.getRoom(room) !== undefined;
      if (mine.length >= L.roomsPerSession || (!exists && this.store.roomCount() >= L.roomsPerMesh)) {
        return this.error(conn, "room_limit", "too many rooms", "room.join");
      }
      if (!exists) this.store.putRoom({ room, created: now, nextCursor: 1 });
      this.store.addMember(room, s.sid);
      this.pushPeer(s);
    }
    const members = this.store.members(room).map((sid) => this.address(this.store.getSession(sid)!));
    this.emit(conn, { t: "room.joined", room, members });
  }

  private roomLeave(conn: Conn, s: SessionRow, room: string): void {
    if (this.store.roomsOf(s.sid).includes(room)) {
      this.store.removeMember(room, s.sid);
      this.pushPeer(s);
    }
    // There is no room.left frame; the session's own peer row confirms its rooms.
    this.emit(conn, { t: "peer", peer: this.peerRow(s) });
  }

  private roomHistory(conn: Conn, room: string, before: number | undefined, limit: number | undefined): void {
    const max = Math.min(limit ?? this.limits.roomHistoryPageMax, this.limits.roomHistoryPageMax);
    // Rows past the retention that a sweep has not reached yet are never served.
    const since = this.host.now() - this.limits.roomHistoryLifetimeMs;
    const rows = this.store.history(room, before ?? Number.MAX_SAFE_INTEGER, max, since);
    // A page also has to fit in one relay frame, so it stops early when the messages are large.
    const parts: string[] = [];
    let bytes = 0;
    let oldest = Number.MAX_SAFE_INTEGER;
    for (const h of rows) {
      if (parts.length > 0 && bytes + h.msg.length > this.limits.frameBytes) break;
      bytes += h.msg.length;
      parts.unshift(`{"cursor":${h.cur},"msg":${h.msg}}`);
      oldest = h.cur;
    }
    // An empty page has nothing older than `before` (the store returned no row before it).
    const more = parts.length > 0 && this.store.history(room, oldest, 1, since).length > 0;
    conn.send(`{"t":"room.history","room":${JSON.stringify(room)},"msgs":[${parts.join(",")}],"more":${more}}`);
  }

  // ---- leases ----

  private ttlOk(ttl: number): boolean {
    return ttl >= this.limits.leaseTtlMinMs && ttl <= this.limits.leaseTtlMaxMs;
  }

  private leaseAcquire(conn: Conn, s: SessionRow, key: string, ttl: number, wait: boolean, now: number): void {
    const L = this.limits;
    if (!this.ttlOk(ttl)) return this.lease(conn, { key, status: "refused" });
    this.expireDue(key, now);
    const held = this.store.getLease(key);
    const busy = this.store.leasesHeldBy(s.sid) + this.store.waitsBy(s.sid) >= L.leasesPerSession;
    const deviceFull = this.deviceLeases(s.device) >= L.leasesPerDevice;
    if (held !== undefined) {
      if (!wait || held.holder === s.sid) {
        const holder = this.address(this.store.getSession(held.holder)!);
        return this.lease(conn, { key, status: "held", holder, until: held.until });
      }
      if (busy) return this.lease(conn, { key, status: "refused" });
      // Answered later: `granted` when it frees, or `expired` if this wait's ttl passes first.
      return this.store.addWaiter({ key, sid: s.sid, ttl, exp: now + ttl });
    }
    if (busy || deviceFull || this.store.leases().length >= L.leasesPerMesh) return this.lease(conn, { key, status: "refused" });
    this.grant(s, key, ttl, now);
  }

  private grant(s: SessionRow, key: string, ttl: number, now: number): void {
    const token = this.store.nextToken();
    const until = now + ttl;
    this.store.putLease({ key, holder: s.sid, token, until, granted: now });
    this.leaseTo(s, key, "granted", { holder: this.address(s), until, token });
  }

  private leaseRenew(conn: Conn, s: SessionRow, key: string, token: number, ttl: number, now: number): void {
    this.expireDue(key, now);
    const l = this.store.getLease(key);
    // The holder's sid is the authorisation (the token is only for fencing), and a continuous hold
    // is capped: past it the holder releases and acquires again, behind anyone waiting.
    const tooLong = l !== undefined && now + ttl > l.granted + this.limits.leaseMaxHoldMs;
    if (l === undefined || l.holder !== s.sid || l.token !== token || !this.ttlOk(ttl) || tooLong) return this.lease(conn, { key, status: "refused" });
    this.store.putLease({ ...l, until: now + ttl });
    this.lease(conn, { key, status: "renewed", until: now + ttl, token });
  }

  private leaseRelease(conn: Conn, s: SessionRow, key: string, token: number, now: number): void {
    this.expireDue(key, now);
    const l = this.store.getLease(key);
    if (l === undefined || l.holder !== s.sid || l.token !== token) return this.lease(conn, { key, status: "refused" });
    this.lease(conn, { key, status: "released", token });
    this.free(l, "released", now);
  }

  private leaseList(conn: Conn, now: number): void {
    const leases = this.store
      .leases()
      .filter((l) => l.until > now)
      .map((l) => ({ key: l.key, holder: this.address(this.store.getSession(l.holder)!), until: l.until, token: l.token }));
    this.emit(conn, { t: "leases", leases });
  }

  private leaseWatch(conn: Conn, s: SessionRow, key: string, now: number): void {
    const armed = this.store.watchesFor(key).some((w) => w.sid === s.sid);
    if (!armed && this.store.watchesBy(s.sid) >= this.limits.leaseWatchesPerSession) return this.lease(conn, { key, status: "refused" });
    this.store.putWatch({ key, sid: s.sid, exp: now + this.limits.leaseWatchLifetimeMs });
  }

  /** Ends a lease whose `until` has passed, so it is free before anyone is answered about it. */
  private expireDue(key: string, now: number): void {
    const l = this.store.getLease(key);
    if (l !== undefined && l.until <= now) this.free(l, "expired", now);
  }

  /** Ends a lease: tells the holder (on expiry) and the watchers, then hands it to the first waiter still waiting. */
  private free(l: LeaseRow, why: "released" | "expired", now: number): void {
    this.store.deleteLease(l.key);
    if (why === "expired") this.leaseTo(this.store.getSession(l.holder), l.key, "expired", { token: l.token });
    for (const w of this.store.watchesFor(l.key)) {
      this.store.deleteWatch(w.key, w.sid);
      if (w.exp > now) this.leaseTo(this.store.getSession(w.sid), l.key, why);
    }
    for (const w of this.store.waiters(l.key)) {
      this.store.deleteWaiter(w.key, w.sid);
      const waiter = this.store.getSession(w.sid);
      if (w.exp <= now) {
        this.leaseTo(waiter, l.key, "expired");
        continue;
      }
      // A waiter that went offline loses its place: nobody would learn of the grant.
      if (this.connFor(waiter) === undefined) continue;
      if (this.deviceLeases(waiter!.device) >= this.limits.leasesPerDevice) {
        this.leaseTo(waiter, l.key, "refused");
        continue;
      }
      this.grant(waiter!, l.key, w.ttl, now);
      break;
    }
  }

  /** Leases held by all sessions of a device. */
  private deviceLeases(device: string): number {
    const sids = new Set(this.store.sessionsOf(device).map((s) => s.sid));
    return this.store.leases().filter((l) => sids.has(l.holder)).length;
  }

  /** Ends every lease a session holds, handing each to its next waiter. */
  private releaseAll(sid: string, now: number): void {
    for (const l of this.store.leases()) if (l.holder === sid) this.free(l, "released", now);
  }

  private leaseTo(s: SessionRow | undefined, key: string, status: LeaseStatus, extra: Record<string, unknown> = {}): void {
    const c = this.connFor(s);
    if (c) this.lease(c, { key, status, ...extra });
  }

  private lease(conn: Conn, fields: { key: string; status: LeaseStatus } & Record<string, unknown>): void {
    this.emit(conn, { t: "lease", ...fields });
  }

  // ---- blobs ----

  private blobPut(conn: Conn, s: SessionRow, f: BlobPutFrame, now: number): void {
    const L = this.limits;
    const existing = this.store.getChunk(f.blob, f.index);
    if (existing !== undefined && existing.device !== s.device) {
      return this.error(conn, "unauthorized", "another device stored this chunk", "blob.put");
    }
    // Canonical base64url without padding decodes to exactly floor(length * 3 / 4) bytes.
    const bytes = Math.floor((f.data.length * 3) / 4);
    const replaced = existing === undefined ? 0 : existing.bytes;
    const dayKey = `blob:${s.device}`;
    const day = this.level(dayKey, L.blobBytesPerDevicePerDay, L.blobBytesPerDevicePerDay / DAY, now);
    if (this.store.blobBytes() - replaced + bytes > L.blobBytesPerMesh || day < bytes) {
      return this.error(conn, "blob_quota", "blob storage limit reached", "blob.put");
    }
    // The whole mesh's daily allowance, shared by its devices (a hosted relay sets it low).
    const meshDay = this.level("blob:mesh", L.blobBytesPerMeshPerDay, L.blobBytesPerMeshPerDay / DAY, now);
    if (meshDay < bytes) return this.error(conn, "blob_quota", "this mesh's daily file allowance is used up; it refills over the day", "blob.put");
    this.spend("blob:mesh", meshDay, bytes, now);
    this.spend(dayKey, day, bytes, now);
    this.store.putChunk({ blob: f.blob, idx: f.index, last: f.last, n: f.n, data: f.data, bytes, device: s.device, at: now });
    this.emit(conn, { t: "blob.stored", blob: f.blob, index: f.index });
  }

  private blobGet(conn: Conn, blob: string, index: number): void {
    const c = this.store.getChunk(blob, index);
    if (c === undefined) return this.error(conn, "blob_missing", "no such chunk", "blob.get");
    this.emit(conn, { t: "blob.chunk", blob, index, last: c.last, n: c.n, data: c.data });
  }

  // ---- short invite codes ----

  /**
   * Checks an `rdv.put` (SPEC section 5) and hands it to the relay-wide store: only an admin
   * device, an expiry within the next hour, and per-device and per-mesh hourly budgets, spent
   * before the store's own per-source budget and count cap.
   */
  private rdvPut(conn: Conn, st: ConnState, s: SessionRow, f: RdvPutFrame, now: number): void {
    const L = this.limits;
    if (this.host.rdvPut === undefined) return this.error(conn, "unsupported", "this relay keeps no short invite codes", "rdv.put");
    if (!this.isAdmin(s.device)) return this.error(conn, "unauthorized", "only admin devices store short invite codes", "rdv.put");
    // The admin's clock may run ahead by as much as `auth` allows; the box still ends within the
    // hour by this relay's clock.
    if (f.exp <= now || f.exp > now + L.rdvLifetimeMs + L.authSkewMs) return this.error(conn, "malformed", "exp must be in the next hour", "rdv.put");
    const exp = Math.min(f.exp, now + L.rdvLifetimeMs);
    const deviceKey = `rdv:${s.device}`;
    const device = this.level(deviceKey, L.rdvPutsPerDevicePerHour, L.rdvPutsPerDevicePerHour / HOUR, now);
    const mesh = this.level("rdv:mesh", L.rdvPutsPerMeshPerHour, L.rdvPutsPerMeshPerHour / HOUR, now);
    if (device < 1 || mesh < 1) return this.error(conn, "limited", "too many short invite codes for now; try again later", "rdv.put");
    this.spend(deviceKey, device, 1, now);
    this.spend("rdv:mesh", mesh, 1, now);
    this.host.rdvPut({ rdv: f.rdv, exp, n: f.n, c: f.c, source: st.source }, (outcome) => this.rdvAnswer(conn, f.rdv, outcome));
  }

  /** Answers an `rdv.put` with the store's outcome, unless the connection has closed meanwhile. */
  private rdvAnswer(conn: Conn, rdv: string, outcome: RdvOutcome): void {
    if (this.host.getState(conn)?.phase !== "authed") return;
    if (outcome === "stored") return this.emit(conn, { t: "rdv.stored", rdv });
    const [code, message] = RDV_REFUSALS[outcome];
    this.error(conn, code, message, "rdv.put");
  }

  // ---- peer cards ----

  /**
   * Stores a session's newest card (SPEC section 17). A card is never a message: it is not
   * queued, delivered, receipted, or counted against message limits; it only annotates peer rows.
   */
  private cardSet(conn: Conn, s: SessionRow, msg: SendFrame, now: number): void {
    if (msg.from.device !== s.device || msg.from.sid !== s.sid || msg.from.session !== s.name) {
      return this.error(conn, "unauthorized", "from does not match this connection", "card.set");
    }
    if (msg.mesh !== this.config.meshId || msg.to.length !== 1 || msg.to[0] !== "*") {
      return this.error(conn, "malformed", "a card is sealed to the whole mesh", "card.set");
    }
    // Clients send a card at most once a minute; a burst of two leaves room for a reconnect.
    const key = `card:${s.sid}`;
    const level = this.level(key, 2, 1 / MINUTE, now);
    if (level < 1) return this.error(conn, "limited", "too many card updates", "card.set");
    const text = JSON.stringify(msg);
    // Cards are small labels; one device cannot fill the mesh's card pages with its sessions.
    const siblings = new Set(this.store.sessionsOf(s.device).map((o) => o.sid));
    siblings.delete(s.sid);
    let deviceBytes = text.length;
    for (const c of this.store.cards()) if (siblings.has(c.sid)) deviceBytes += c.msg.length;
    if (deviceBytes > this.limits.cardBytesPerDevice) return this.error(conn, "limited", "too many card bytes for this device", "card.set");
    this.spend(key, level, 1, now);
    this.store.putCard(s.sid, text);
    const push = `{"t":"card","msg":${text}}`;
    for (const c of this.authedConns()) if (this.host.getState(c)!.sid !== s.sid) c.send(push);
  }

  /**
   * One `cards` page: the stored cards of sessions after sid `after`, in sid order, within the
   * page byte limit (at least one card), with `more` when the client should ask with `cards.get`.
   */
  private sendCards(conn: Conn, after = ""): void {
    const cards = this.store
      .cards()
      .filter((c) => c.sid > after)
      .sort((a, b) => Number(a.sid > b.sid) - Number(a.sid < b.sid));
    const parts: string[] = [];
    let bytes = 0;
    for (const card of cards) {
      if (parts.length > 0 && bytes + card.msg.length > this.limits.cardsPageBytes) break;
      parts.push(card.msg);
      bytes += card.msg.length;
    }
    conn.send(`{"t":"cards","cards":[${parts.join(",")}],"more":${parts.length < cards.length}}`);
  }

  // ---- helpers ----

  /** Marks sessions offline whose connection is gone (the host restarted without them). */
  private reconcile(): void {
    const open = new Set<string>();
    for (const c of this.host.connections()) open.add(c.id);
    for (const s of this.store.sessions()) {
      if (s.conn !== null && !open.has(s.conn)) this.store.putSession({ ...s, conn: null, since: this.host.now() });
    }
  }

  /** The newest roster. Cached; the store is the truth, so a fresh instance reads it back. */
  private roster(): Roster {
    this.cached ??= JSON.parse(this.store.getRoster(this.store.rosterHead())!.json) as Roster;
    return this.cached;
  }

  private isAdmin(device: string): boolean {
    return this.roster().devices.some((d) => d.id === device && d.role === "admin");
  }

  /** One page of the chain from seq `from`: at most 64 rosters or 512 KiB, at least one. */
  private page(from: number): { chain: Roster[]; more: boolean } {
    const rows = this.store.rosterRange(from, this.limits.rosterPageMax);
    const chain: Roster[] = [];
    let bytes = 0;
    for (const row of rows) {
      // Roster JSON is ASCII (names, ids and base64url), so its length is its size in bytes.
      if (chain.length > 0 && bytes + row.json.length > this.limits.rosterPageBytes) break;
      bytes += row.json.length;
      chain.push(JSON.parse(row.json) as Roster);
    }
    return { chain, more: chain.at(-1)!.seq < this.store.rosterHead() };
  }

  /** A session's address, `name@device`, with the device name from the current roster. */
  private address(s: SessionRow): string {
    return `${s.name}@${this.roster().devices.find((d) => d.id === s.device)!.name}`;
  }

  /** The live session at `name@device`, or the `sent` status for an address that has none. */
  private resolve(address: string): SessionRow | "unknown" | "ended" {
    const at = address.indexOf("@");
    const name = address.slice(0, at);
    const device = this.roster().devices.find((d) => d.name === address.slice(at + 1));
    if (device === undefined) return "unknown";
    const named = this.store.sessionsOf(device.id).filter((s) => s.name === name);
    return named.find((s) => s.ended === null) ?? (named.length > 0 ? "ended" : "unknown");
  }

  private peerRow(s: SessionRow): Peer {
    return {
      address: this.address(s),
      sid: s.sid,
      kind: s.kind,
      status: s.conn === null ? "offline" : s.status,
      since: s.since,
      rooms: this.store.roomsOf(s.sid),
    };
  }

  /** Every live session except `self`. */
  private peerRows(self: string): Peer[] {
    return this.store
      .sessions()
      .filter((s) => s.ended === null && s.sid !== self)
      .map((s) => this.peerRow(s));
  }

  /** Tells every other online session that one row changed. */
  private pushPeer(s: SessionRow): void {
    const text = JSON.stringify({ t: "peer", peer: this.peerRow(s) });
    for (const c of this.authedConns()) if (this.host.getState(c)!.sid !== s.sid) c.send(text);
  }

  /** Sends every online session the whole list, for changes a single row cannot express. */
  private pushPeers(): void {
    for (const c of this.authedConns()) this.emit(c, { t: "peers", peers: this.peerRows(this.host.getState(c)!.sid!) });
  }

  private *authedConns(): Generator<Conn> {
    for (const c of this.host.connections()) if (this.host.getState(c)!.phase === "authed") yield c;
  }

  private *adminConns(): Generator<Conn> {
    for (const c of this.authedConns()) if (this.isAdmin(this.host.getState(c)!.device!)) yield c;
  }

  /** The open connection holding a session, if any. */
  private connFor(s: SessionRow | undefined): Conn | undefined {
    if (s === undefined || s.conn === null) return undefined;
    for (const c of this.host.connections()) if (c.id === s.conn) return c;
    return undefined;
  }

  private allowSource(st: ConnState): boolean {
    const L = this.limits;
    const key = `src:${st.source}`;
    const now = this.host.now();
    if (this.host.allowSource) return this.host.allowSource(st.source, now);
    const level = this.level(key, L.createJoinPerSourcePerHour, L.createJoinPerSourcePerHour / HOUR, now);
    if (level < 1) return false;
    this.spend(key, level, 1, now);
    return true;
  }

  /** A token bucket's level now: full when never used, refilled at `perMs` up to `cap`. */
  private level(key: string, cap: number, perMs: number, now: number): number {
    const row = this.store.getBucket(key);
    return row === undefined ? cap : Math.min(cap, row.tokens + (now - row.at) * perMs);
  }

  private spend(key: string, level: number, cost: number, now: number): void {
    this.store.putBucket({ bkey: key, tokens: level - cost, at: now });
  }

  private shut(conn: Conn, st: ConnState, code: number, reason: string): void {
    this.host.setState(conn, { ...st, phase: "closed" });
    conn.close(code, reason);
  }

  private emit(conn: Conn, frame: Record<string, unknown>): void {
    conn.send(JSON.stringify(frame));
  }

  private error(conn: Conn, code: string, message: string, ref?: string): void {
    this.emit(conn, { t: "error", code, message, ref });
  }
}

/** The `deliver` envelope around a stored send frame, built without re-encoding the frame. */
function deliverText(cursor: number, msg: string): string {
  return `{"t":"deliver","cursor":${cursor},"msg":${msg}}`;
}

/** The `t` of a frame the protocol parsed far enough to call its type unknown (so a string). */
function peekType(text: string): string {
  const parsed = parseJson(text) as { ok: true; value: { t: string } };
  return parsed.value.t.slice(0, 128);
}
