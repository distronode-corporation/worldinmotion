import { DurableObject } from "cloudflare:workers";
import { CLOSE, fitsUtf8, LIMITS, parseClientFrame, parseRecoverAuthFrame } from "@worldinmotion/protocol";
import { MemoryStore, MeshRelay, migrate, SqlStore, type Conn, type ConnState, type RdvOutcome, type SqlDb } from "@worldinmotion/relay-core";
import { relayConfig, type CfRelayConfig, type Env } from "./config.ts";
import { RDV_NAME } from "./rdv.ts";
import { REGISTRY_NAME } from "./registry.ts";
import { json } from "./route.ts";
import { doSqlDb, nextStoreDue } from "./sql.ts";

/** Headers only the Worker sets on its request to this object (it strips any client copy). */
export const SOURCE_HEADER = "x-wim-source";
export const MESH_HEADER = "x-wim-mesh";

/** How often the alarm runs while any socket is open, on top of the due expiries. */
export const HEARTBEAT_MS = 60_000;
/** The soonest an alarm is set after now, so a row a sweep cannot clear never spins the alarm. */
export const MIN_ALARM_MS = 1_000;
/**
 * The client's keepalive, byte for byte as packages/client/src/wire.ts sends it
 * (`JSON.stringify({ t: "ping" })`), and the relay's answer, byte for byte as relay-core sends it.
 * The runtime answers it without waking the object (WebSocket auto-response).
 */
export const PING = '{"t":"ping"}';
export const PONG = '{"t":"pong"}';
/**
 * An authenticated socket that sent nothing, not even a ping, for this long is closed as dead (a
 * client that vanished without closing). Clients ping after 30 seconds of quiet.
 */
export const STALE_MS = 5 * 60_000;

const DAY = 86_400_000;

/**
 * What a socket carries through hibernation: the relay connection id (stable for the socket's
 * life), the mesh id it dialled, and relay-core's `ConnState`. All are small JSON, well under the
 * 2 KiB attachment limit.
 */
export type Attachment = { id: string; mesh: string; state: ConnState };

type SocketConn = Conn & { ws: WebSocket };

/**
 * One mesh. The relay itself is relay-core's `MeshRelay`, a state machine with no I/O; this object
 * gives it Durable Object SQLite as its store, hibernatable WebSockets as its connections, the
 * sockets' attachments as its per-connection state, and an alarm as its clock.
 *
 * Nothing the relay needs lives only in memory. When the runtime evicts the object while sockets
 * stay open (hibernation), the next event constructs a fresh instance, which rebuilds `MeshRelay`
 * from SQLite and from `ctx.getWebSockets()` with each socket's attachment, and carries on.
 *
 * Anyone can dial any well-formed mesh id, so an object writes nothing to SQLite until its mesh
 * exists. Until then the relay runs over an in-memory store, which stays empty because relay-core
 * stores nothing for a mesh that does not exist; the mesh id the object serves rides in each
 * socket's attachment. A `create` that succeeds moves the genesis roster into SQLite with the
 * `cf_host` row, and from then on the object is an ordinary persisted mesh. Once no socket is
 * left on an object that never held a mesh, it deletes all of its storage, so a dial-only id
 * leaves nothing behind.
 */
export class MeshDurableObject extends DurableObject<Env> {
  private readonly db: SqlDb;
  private relayInstance: MeshRelay | undefined;
  /** The store behind the relay while the mesh does not exist (see the class comment). */
  private memory: MemoryStore | undefined;
  /** The mesh id this object serves: from SQLite once the mesh exists, else from the dial. */
  private meshId = "";
  /** The mesh id held in SQLite, once found (a mesh, once it exists, never stops existing). */
  private saved: string | undefined;
  private readonly conns = new WeakMap<WebSocket, SocketConn>();
  /** When each socket last sent a frame the object saw, since this instance woke. */
  private readonly seen = new WeakMap<WebSocket, number>();
  private readonly woke = Date.now();
  /** The configuration the relay was built with. */
  private settings!: CfRelayConfig;
  /** Since when no session has been online (idle expiry only): undefined until read, null for in use. */
  private idleSince: number | null | undefined;
  // Events run one at a time, in arrival order. A pre-auth `create`, `join` or recovery `auth`
  // awaits the source limiter (another object), and the runtime delivers further events during
  // that await.
  private queue: Promise<void> = Promise.resolve();
  /**
   * The answer to the frame's `rdv.put`, if it made one: the relay-wide store is another object,
   * so the event awaits it before it ends, and the answer goes out in the event's turn.
   */
  private rdvPending: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = doSqlDb(ctx.storage.sql);
    // Keepalives cost nothing: the runtime answers them while the object sleeps.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  override async fetch(request: Request): Promise<Response> {
    const mesh = request.headers.get(MESH_HEADER);
    const source = request.headers.get(SOURCE_HEADER);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket" || mesh === null || source === null) {
      return json(400, { error: "expected a WebSocket upgrade from the relay Worker" });
    }
    // The object's name is the mesh id, so the dial names the mesh this object serves.
    this.meshId ||= mesh;
    let relay: MeshRelay;
    try {
      relay = this.relay();
    } catch (err) {
      console.error(JSON.stringify({ event: "config", mesh, error: (err as Error).message }));
      return json(500, { error: "relay not configured" });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    this.seen.set(server, Date.now());
    // Synchronous from accept to onOpen, so no other event ever sees the socket without its state.
    server.serializeAttachment({ id: crypto.randomUUID(), mesh, state: null });
    relay.onOpen(this.conn(server), { source });
    await this.serial(() => this.settle());
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.serial(async () => {
      this.meshId ||= attachment(ws).mesh;
      const conn = this.conn(ws);
      // Frames are JSON text (SPEC section 8); binary frames are refused as relay-node does.
      if (typeof message !== "string") {
        ws.close(CLOSE.textOnly, "text frames only");
        this.relay().onClose(conn);
      } else {
        this.seen.set(ws, Date.now());
        const relay = this.relay();
        const reserved = await this.precheck(ws, message);
        relay.onMessage(conn, message);
        await this.rdvPending;
        // A place reserved in the mesh count for a create that did not create is given back.
        if (!this.persistIfCreated() && reserved) await this.registry().release();
      }
      await this.settle();
    });
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.serial(async () => {
      this.meshId ||= attachment(ws).mesh;
      this.relay().onClose(this.conn(ws));
      await this.settle();
    });
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.webSocketClose(ws);
  }

  override async alarm(): Promise<void> {
    await this.serial(async () => {
      const [ws] = this.ctx.getWebSockets();
      if (ws !== undefined) this.meshId ||= attachment(ws).mesh;
      // An object that never held a mesh and has no socket left has nothing to sweep.
      if (this.savedMesh() !== undefined || ws !== undefined) {
        const relay = this.relay();
        const now = Date.now();
        if (this.savedMesh() !== undefined) this.trackIdle();
        if (typeof this.idleSince === "number" && this.idleSince + this.settings.idleMeshDays! * DAY <= now) return this.expire();
        this.sweepStale(relay, now);
        relay.tick(now);
      }
      await this.settle(true);
    });
  }

  // ---- the relay ----

  /** The answer `allowSource` gives for the frame being handled, decided before the relay runs. */
  private allowed = false;
  /** The answer `admitMesh` gives: whether the registry counted this create (decided before it runs). */
  private admitted = false;

  /**
   * The relay, built on first use after construction (so once per wake) and again after a
   * `create` moved the mesh into SQLite. Throws when the Worker environment has no valid
   * `WIM_RELAY_URLS`: the relay refuses to run without it.
   */
  private relay(): MeshRelay {
    if (this.relayInstance === undefined) {
      const config = relayConfig(this.env);
      this.settings = config;
      if (config.problem !== undefined) console.error(JSON.stringify({ event: "config", error: config.problem, create: "refused" }));
      const saved = this.savedMesh();
      // A persisted mesh brings its schema up to date on every wake, as relay-node does at start.
      if (saved !== undefined) migrate(this.db);
      // Without a saved mesh, the event's dial or socket attachment named the mesh.
      this.meshId = saved ?? this.meshId;
      this.memory = saved === undefined ? new MemoryStore() : undefined;
      const meshId = this.meshId;
      this.relayInstance = new MeshRelay(
        { meshId, relayUrls: config.relayUrls, createKey: config.createKey, createRefused: config.createRefused, limits: config.limits },
        {
          store: this.memory ?? new SqlStore(this.db, meshId),
          now: () => Date.now(),
          // Every live socket with its attachment, so the new instance's reconcile keeps their
          // sessions online.
          connections: () => this.ctx.getWebSockets().map((ws) => this.conn(ws)),
          getState: (c) => attachment((c as SocketConn).ws).state,
          setState: (c, state) => {
            const ws = (c as SocketConn).ws;
            const { id, mesh } = attachment(ws);
            ws.serializeAttachment({ id, mesh, state } satisfies Attachment);
          },
          log: (event, fields) => console.log(JSON.stringify({ event, mesh: meshId, ...fields })),
          allowSource: () => this.allowed,
          admitMesh: () => this.admitted,
          rdvPut: (put, answer) => {
            const stub = this.env.RDV.get(this.env.RDV.idFromName(RDV_NAME));
            // A store that cannot be reached is answered too, so the client falls back at once. An
            // answer that cannot be sent (the socket closed meanwhile) is dropped, never left as a
            // rejection for the next event to trip on.
            this.rdvPending = stub
              .put(put)
              .then(answer, () => answer("unavailable" satisfies RdvOutcome))
              .catch(() => undefined);
          },
        },
      );
    }
    return this.relayInstance;
  }

  /**
   * The mesh this object holds in SQLite, or undefined when it holds none: no tables yet, or the
   * tables and `cf_host` row an earlier version wrote on every dial, with no roster behind them.
   */
  private savedMesh(): string | undefined {
    if (this.saved !== undefined) return this.saved;
    const tables = this.db.one("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('cf_host', 'rosters')")!;
    if (tables["n"] !== 2) return undefined;
    const row = this.db.one("SELECT h.v AS mesh FROM cf_host h JOIN rosters r ON r.mesh = h.v AND r.seq = 1 WHERE h.k = 'mesh'");
    this.saved = row === undefined ? undefined : String(row["mesh"]);
    return this.saved;
  }

  /**
   * After a frame: if it created the mesh, writes relay-core's schema, the `cf_host` row (so a
   * later wake with no request knows the mesh id) and the genesis roster to SQLite, and drops the
   * in-memory relay so the next event builds one over SQLite. The in-memory store holds nothing
   * else: relay-core writes nothing for a mesh before it exists.
   */
  private persistIfCreated(): boolean {
    if (this.memory === undefined || this.memory.rosterHead() === 0) return false;
    migrate(this.db);
    this.db.exec("CREATE TABLE IF NOT EXISTS cf_host (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.db.exec("INSERT INTO cf_host (k, v) VALUES ('mesh', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", this.meshId);
    new SqlStore(this.db, this.meshId).insertRoster(this.memory.getRoster(1)!);
    this.saved = this.meshId;
    this.memory = undefined;
    this.relayInstance = undefined;
    return true;
  }

  /**
   * Before the relay handles a frame, decides what it will ask the host. For a pre-auth frame the
   * relay counts against the source limit (a well-formed `create`, `join` or recovery `auth`), it
   * spends a token in the source's limiter object (`allowed`). For an allowed `create` that may
   * make a mesh here, it then reserves a place in the registry's mesh count (`admitted`), the one
   * registry call a create makes. Returns whether a place was reserved, so a create that fails
   * can give it back.
   */
  private async precheck(ws: WebSocket, text: string): Promise<boolean> {
    this.allowed = false;
    this.admitted = false;
    const st = attachment(ws).state;
    if (st.phase !== "pre" || !fitsUtf8(text, LIMITS.preAuthFrameBytes)) return false;
    const parsed = parseClientFrame(text, { preAuth: true });
    // A recovery `auth` has its own shape, so the frame parse fails on it (as in relay-core).
    const counted = parsed.ok ? parsed.value.t !== "auth" : parseRecoverAuthFrame(text).ok;
    if (!counted) return false;
    const limiter = this.env.SOURCES.get(this.env.SOURCES.idFromName(st.source));
    this.allowed = await limiter.take();
    if (!this.allowed || !parsed.ok || parsed.value.t !== "create" || this.savedMesh() !== undefined || this.settings.createRefused !== undefined) return false;
    this.admitted = await this.registry().reserve(this.settings.maxMeshes ?? null);
    return this.admitted;
  }

  private registry() {
    return this.env.REGISTRY.get(this.env.REGISTRY.idFromName(REGISTRY_NAME));
  }

  // ---- idle meshes and dead sockets ----

  /**
   * Records, for idle expiry, when the mesh lost its last session (a `cf_host` row `idle`), or
   * that it is in use again. Writes only when that changes.
   */
  private trackIdle(): void {
    const relay = this.relay();
    if (this.settings.idleMeshDays === undefined) return;
    if (this.idleSince === undefined) {
      const row = this.db.one("SELECT v FROM cf_host WHERE k = 'idle'");
      this.idleSince = row === undefined ? null : Number(row["v"]);
    }
    const active = relay.active();
    if (active && this.idleSince !== null) {
      this.db.exec("DELETE FROM cf_host WHERE k = 'idle'");
      this.idleSince = null;
    } else if (!active && this.idleSince === null) {
      this.idleSince = Date.now();
      this.db.exec("INSERT INTO cf_host (k, v) VALUES ('idle', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", String(this.idleSince));
    }
  }

  /**
   * Deletes a mesh no session has used for `WIM_IDLE_MESH_DAYS`: closes any socket still before
   * auth on it, deletes all storage, and gives its place in the mesh count back.
   */
  private async expire(): Promise<void> {
    const relay = this.relay();
    for (const ws of this.ctx.getWebSockets()) {
      relay.onClose(this.conn(ws));
      ws.close(CLOSE.goingAway, "mesh expired");
    }
    await this.ctx.storage.deleteAll();
    await this.registry().release();
    console.log(JSON.stringify({ event: "expired", mesh: this.meshId, idleMeshDays: this.settings.idleMeshDays }));
    this.relayInstance = undefined;
    this.memory = undefined;
    this.saved = undefined;
    this.idleSince = undefined;
  }

  /**
   * Closes authenticated sockets that sent nothing for `STALE_MS`: no frame the object saw (or
   * since it woke, after a hibernation), and no ping the runtime answered for it.
   */
  private sweepStale(relay: MeshRelay, now: number): void {
    for (const ws of this.ctx.getWebSockets()) {
      const phase = attachment(ws).state.phase;
      if (phase === "pre" || phase === "closed") continue;
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      if (now - Math.max(this.seen.get(ws) ?? this.woke, pinged) <= STALE_MS) continue;
      ws.close(CLOSE.goingAway, "no keepalive");
      relay.onClose(this.conn(ws));
    }
  }

  private conn(ws: WebSocket): SocketConn {
    let conn = this.conns.get(ws);
    if (conn === undefined) {
      conn = {
        id: attachment(ws).id,
        ws,
        send: (text) => ws.send(text),
        close: (code, reason) => ws.close(code, reason),
      };
      this.conns.set(ws, conn);
    }
    return conn;
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const run = this.queue.then(fn);
    // A failed event must not block the ones after it; the failure still reaches its caller.
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ---- storage and the alarm ----

  /**
   * After every event: an object that never held a mesh and has no live socket left deletes all
   * of its storage (any alarm, and the tables an earlier version wrote on every dial); otherwise
   * the alarm is armed.
   */
  private async settle(exact = false): Promise<void> {
    if (this.savedMesh() === undefined) {
      if (this.ctx.getWebSockets().every((ws) => attachment(ws).state.phase === "closed")) return this.ctx.storage.deleteAll();
    } else this.trackIdle();
    await this.arm(exact);
  }

  /**
   * Arms the alarm for the next thing due: a pre-auth deadline on an open socket, a store expiry,
   * or the heartbeat while any socket is open. After an event it only ever moves the alarm
   * earlier (cheap, and an early alarm just finds less to do); after the alarm itself (`exact`)
   * it sets the precise next time. Nothing pending leaves no alarm: a running alarm is cleared by
   * the runtime once it returns.
   */
  private async arm(exact: boolean): Promise<void> {
    const now = Date.now();
    const relay = this.relay();
    // Only a persisted mesh has store expiries; the in-memory store of one that does not exist is empty.
    let due = (this.savedMesh() === undefined ? undefined : nextStoreDue(this.db, this.meshId, relay.limits)) ?? Infinity;
    if (typeof this.idleSince === "number") due = Math.min(due, this.idleSince + this.settings.idleMeshDays! * DAY);
    const sockets = this.ctx.getWebSockets();
    if (sockets.length > 0) due = Math.min(due, now + HEARTBEAT_MS);
    for (const ws of sockets) {
      const st = attachment(ws).state;
      if (st.phase === "pre") due = Math.min(due, st.deadline);
    }
    // Nothing pending: the alarm that just ran is already cleared, and an older one is harmless.
    if (due === Infinity) return;
    due = Math.max(due, now + MIN_ALARM_MS);
    const current = await this.ctx.storage.getAlarm();
    if (exact || current === null || due < current) await this.ctx.storage.setAlarm(due);
  }
}

function attachment(ws: WebSocket): Attachment {
  return ws.deserializeAttachment() as Attachment;
}
