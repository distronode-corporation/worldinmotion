import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Duplex } from "node:stream";
import { networkInterfaces } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { CLOSE, isRelayUrl, LIMITS } from "@worldinmotion/protocol";
import {
  dropMesh,
  healthz,
  isInfoPath,
  meshCount,
  MeshRelay,
  migrate,
  parseDialPath,
  parseRdvPath,
  RDV_HEADERS,
  relayInfo,
  Rendezvous,
  sourceKey,
  SqlStore,
  type Conn,
  type ConnState,
  type Limits,
  type SqlDb,
} from "@worldinmotion/relay-core";
import { WebSocketServer, type WebSocket } from "ws";
import { lanAddress, lanCert } from "./tls.ts";

export type StartConfig = {
  /** SQLite database path; one database holds every mesh. */
  db: string;
  /** Port to listen on (0 picks a free one). */
  port: number;
  /** Address to bind. Default 127.0.0.1, or the LAN address in LAN mode. */
  host?: string;
  /**
   * The exact public base URLs clients use. Default: `ws://<host>:<port>` for a loopback host, or
   * `wss://<host>:<port>` in LAN mode. A relay behind a TLS proxy must set them.
   */
  relayUrls?: string[];
  /** When set, `create` must carry this operator key. */
  createKey?: string;
  /**
   * When set, every `create` is refused with this message. Without it or `createKey`, anyone may
   * create a mesh: that is the default here, for embedding and tests, but the `wim-relay` command
   * (`configFromEnv`) opens creation only when `WIM_OPEN_CREATE=1` says so.
   */
  createRefused?: string;
  /**
   * A configuration problem (no secret in it). The relay logs it at start and `/healthz` answers
   * 503 with it; the relay still serves the meshes it holds.
   */
  problem?: string;
  /** The most meshes this relay holds; a `create` past it is refused with `full`. Default: no cap. */
  maxMeshes?: number;
  /**
   * Days a mesh may go without an authenticated session before the relay deletes it, with all of
   * its state. Default: never.
   */
  idleMeshDays?: number;
  /** One line about the service for `/v1/info`. */
  offer?: string;
  /** Read the client address from the last `X-Forwarded-For` entry (only behind a proxy you run). */
  trustProxy?: boolean;
  /** Serve wss with a self-signed certificate kept next to the database, for peers on a LAN. */
  lan?: boolean;
  limits?: Partial<Limits>;
  /** How often expiry sweeps run. Default 1 second. */
  tickMs?: number;
  /** How often idle sockets are pinged; one that missed the last ping is dropped. Default 30 seconds. */
  heartbeatMs?: number;
  /** Where log lines go. Default console.log. */
  log?: (line: string) => void;
};

export type RunningRelay = {
  port: number;
  relayUrls: string[];
  /** In LAN mode, the certificate's SPKI pin for invites (`tls`). */
  pin: string | undefined;
  /**
   * How many meshes this process holds in memory: each mesh that exists and was used since start,
   * plus each dialled mesh id that still has a socket open. A mesh id that was only dialled is
   * dropped with its last socket.
   */
  loadedMeshes(): number;
  close(): Promise<void>;
};

type Socket = { conn: Conn; ws: WebSocket; state: ConnState | undefined; alive: boolean };
/** `idle`: whether the idle table holds a row for this mesh, once known (idle expiry only). */
type Mesh = { relay: MeshRelay; sockets: Map<string, Socket>; idle?: boolean };

const DAY = 86_400_000;

/** Stored meshes not held in memory that one tick sweeps (see `sweepStored`). */
export const STORED_SWEEP_MESHES = 8;

/** node:sqlite behind the relay's minimal SQL surface. */
export function sqlDb(db: DatabaseSync): SqlDb {
  return {
    exec: (sql, ...params) => void db.prepare(sql).run(...params),
    all: (sql, ...params) => db.prepare(sql).all(...params) as ReturnType<SqlDb["all"]>,
    one: (sql, ...params) => db.prepare(sql).get(...params) as ReturnType<SqlDb["one"]>,
  };
}

/**
 * The path of a request target, or "" for one the URL parser refuses (`//` reads as a host-less
 * authority and throws), which every route then answers as not found rather than crashing.
 */
export function pathOf(target: string): string {
  try {
    return new URL(target, "http://relay").pathname;
  } catch {
    return "";
  }
}

/** The parts of `process` that `runUntilSignal` uses, so a test can pass its own. */
export type SignalTarget = { once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown; exit(code: number): unknown };

/** Closes the relay cleanly (sessions offline, database closed) on SIGINT or SIGTERM, then exits. */
export function runUntilSignal(relay: RunningRelay, proc: SignalTarget): void {
  const stop = () => void relay.close().then(() => proc.exit(0));
  proc.once("SIGINT", stop);
  proc.once("SIGTERM", stop);
}

/** Starts a relay serving many meshes from one database. Resolves once it is listening. */
export async function start(config: StartConfig): Promise<RunningRelay> {
  const log = config.log ?? console.log;
  const lan = config.lan === true;
  const host = config.host ?? (lan ? lanAddress(networkInterfaces()) : "127.0.0.1");
  for (const url of config.relayUrls ?? []) {
    if (!isRelayUrl(url)) throw new Error(`invalid relay URL: ${url}`);
    if (lan && !url.startsWith("wss://")) throw new Error("LAN mode serves wss only; every relay URL must be wss://");
  }
  if (config.relayUrls === undefined && !lan && !isRelayUrl(`ws://${host}`)) {
    throw new Error("set relayUrls (WIM_RELAY_URLS) for a relay that is not on loopback");
  }
  if (lan && config.db === ":memory:") throw new Error("LAN mode keeps its TLS key next to the database, so it needs a database file");

  const raw = new DatabaseSync(config.db);
  raw.exec("PRAGMA journal_mode = WAL");
  const db = sqlDb(raw);
  migrate(db);

  // LAN mode never falls back to plain ws: without a certificate it does not start.
  const tls = lan ? lanCert(config.db, [host, "localhost"], new Date()) : undefined;
  const server: Server = tls ? createHttpsServer({ key: tls.key, cert: tls.cert }) : createHttpServer();
  const health = healthz(config.problem);
  const info = relayInfo({ ...config, limits: config.limits ?? {} });
  // Short invite codes' boxes (SPEC section 5), for every mesh this process serves.
  const rendezvous = new Rendezvous(db, config.limits ?? {});
  const sourceOf = (req: IncomingMessage): string => {
    const forwarded = config.trustProxy === true ? req.headers["x-forwarded-for"] : undefined;
    // The last entry is the one the trusted proxy appended; earlier ones are the client's word.
    const addr = typeof forwarded === "string" ? forwarded.split(",").at(-1)!.trim() : req.socket.remoteAddress!;
    return sourceKey(addr);
  };
  server.on("request", (req, res) => {
    const get = req.method === "GET";
    const path = pathOf(req.url!);
    const rdv = get ? parseRdvPath(path) : undefined;
    if (rdv !== undefined) {
      const answer = rdv.ok ? rendezvous.get(rdv.rdv, sourceOf(req), Date.now()) : { status: rdv.status, body: { error: rdv.error } };
      res.writeHead(answer.status, RDV_HEADERS);
      res.end(JSON.stringify(answer.body));
      return;
    }
    const answer =
      get && req.url === "/healthz"
        ? health
        : get && isInfoPath(path)
          ? { status: 200, body: info }
          : { status: 404, body: { error: "not found" } };
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.body));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, host, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  const relayUrls = config.relayUrls ?? [`${lan ? "wss" : "ws"}://${host}:${port}`];

  const meshes = new Map<string, Mesh>();

  // Idle expiry: a row per existing mesh with no authenticated session, holding since when. The
  // table is keyed by mesh, so `dropMesh` deletes a mesh's row with the rest of its state. Meshes
  // the database already holds start their idle time now.
  const idleDays = config.idleMeshDays;
  if (idleDays !== undefined) {
    db.exec("CREATE TABLE IF NOT EXISTS relay_node_idle (mesh TEXT PRIMARY KEY, since INTEGER NOT NULL)");
    db.exec("INSERT INTO relay_node_idle (mesh, since) SELECT mesh, ? FROM rosters WHERE seq = 1 ON CONFLICT (mesh) DO NOTHING", Date.now());
  }
  /** After an event: records when an existing mesh became idle, or that it is in use again. */
  const track = (id: string, mesh: Mesh): void => {
    if (idleDays === undefined || !mesh.relay.exists()) return;
    const idle = !mesh.relay.active();
    if (mesh.idle === idle) return;
    if (idle) db.exec("INSERT INTO relay_node_idle (mesh, since) VALUES (?, ?) ON CONFLICT (mesh) DO NOTHING", id, Date.now());
    else db.exec("DELETE FROM relay_node_idle WHERE mesh = ?", id);
    mesh.idle = idle;
  };
  /** Deletes every mesh idle for longer than `idleDays`; any socket still on it is before auth. */
  const expireIdle = (days: number, now: number): void => {
    for (const row of db.all("SELECT mesh FROM relay_node_idle WHERE since <= ?", now - days * DAY)) {
      const id = String(row["mesh"]);
      for (const s of meshes.get(id)?.sockets.values() ?? []) {
        s.ws.removeAllListeners("close");
        s.ws.close(CLOSE.goingAway, "mesh expired");
      }
      meshes.delete(id);
      dropMesh(db, id);
      log(JSON.stringify({ event: "expired", mesh: id, idleDays: days }));
    }
  };

  // One create and join budget per address across every mesh this process serves (a new mesh
  // id is a new relay instance, so a per-mesh limit would not stop a flood of creates).
  const HOUR = 3_600_000;
  const perHour = config.limits?.createJoinPerSourcePerHour ?? LIMITS.createJoinPerSourcePerHour;
  const sources = new Map<string, { tokens: number; at: number }>();
  const allowSource = (source: string, now: number): boolean => {
    const b = sources.get(source);
    const tokens = b === undefined ? perHour : Math.min(perHour, b.tokens + ((now - b.at) * perHour) / HOUR);
    if (tokens < 1) return false;
    sources.set(source, { tokens: tokens - 1, at: now });
    return true;
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.frameBytes });
  let next = 0;

  // The mesh id is valid (parseDialPath checked it) and so are the relay URLs (checked above), so
  // the MeshRelay constructor has nothing left to refuse.
  const relayFor = (id: string, sockets: Map<string, Socket>): MeshRelay =>
    new MeshRelay(
      { meshId: id, relayUrls, createKey: config.createKey, createRefused: config.createRefused, limits: config.limits },
      {
        store: new SqlStore(db, id),
        now: () => Date.now(),
        connections: () => [...sockets.values()].map((s) => s.conn),
        getState: (c) => sockets.get(c.id)!.state,
        setState: (c, st) => void (sockets.get(c.id)!.state = st),
        log: (event, fields) => log(JSON.stringify({ event, mesh: id, ...fields })),
        allowSource,
        admitMesh: () => config.maxMeshes === undefined || meshCount(db) < config.maxMeshes,
        rdvPut: (put, answer) => answer(rendezvous.put(put, Date.now())),
      },
    );
  const meshFor = (id: string): Mesh => {
    const known = meshes.get(id);
    if (known) return known;
    const sockets = new Map<string, Socket>();
    const mesh = { relay: relayFor(id, sockets), sockets };
    meshes.set(id, mesh);
    return mesh;
  };

  // A mesh is held in memory only once a socket dials it, so a mesh nobody dialled since start
  // would keep its expired queue, history and files until someone did. Each tick also sweeps a
  // few of those stored meshes in turn (by mesh id, wrapping around), through a relay built for
  // that sweep and dropped after it. With the per-mesh history bound, one tick stays short.
  let sweptThrough = "";
  const sweepStored = (now: number): void => {
    const rows = db.all("SELECT mesh FROM rosters WHERE seq = 1 AND mesh > ? ORDER BY mesh LIMIT ?", sweptThrough, STORED_SWEEP_MESHES);
    for (const row of rows) {
      const id = String(row["mesh"]);
      if (!meshes.has(id)) relayFor(id, new Map()).tick(now);
    }
    sweptThrough = rows.length < STORED_SWEEP_MESHES ? "" : String(rows.at(-1)!["mesh"]);
  };

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const dial = parseDialPath(pathOf(req.url!));
    if (!dial.ok) {
      const body = JSON.stringify({ error: dial.error });
      const reason = dial.status === 400 ? "Bad Request" : "Not Found";
      socket.end(`HTTP/1.1 ${dial.status} ${reason}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
      return;
    }
    const meshId = dial.meshId;
    const mesh = meshFor(meshId);
    const source = sourceOf(req);
    wss.handleUpgrade(req, socket, head, (ws) => {
      const id = `${++next}`;
      const entry: Socket = {
        ws,
        state: undefined,
        alive: true,
        conn: { id, send: (text) => ws.send(text), close: (code, reason) => ws.close(code, reason) },
      };
      mesh.sockets.set(id, entry);
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) ws.close(CLOSE.textOnly, "text frames only");
        else mesh.relay.onMessage(entry.conn, data.toString("utf8"));
        track(meshId, mesh);
      });
      ws.on("pong", () => void (entry.alive = true));
      ws.on("close", () => {
        mesh.relay.onClose(entry.conn);
        mesh.sockets.delete(id);
        track(meshId, mesh);
        // A mesh id that was only dialled (never created) leaves nothing behind with its last socket.
        if (mesh.sockets.size === 0 && !mesh.relay.exists()) meshes.delete(meshId);
      });
      mesh.relay.onOpen(entry.conn, { source });
      track(meshId, mesh);
    });
  });

  const tick = setInterval(() => {
    const now = Date.now();
    // Expired meshes go first, so their sockets are closed as expired rather than swept.
    if (idleDays !== undefined) expireIdle(idleDays, now);
    for (const m of meshes.values()) m.relay.tick(now);
    sweepStored(now);
    rendezvous.sweep(now);
    for (const [k, b] of sources) if (b.at <= now - HOUR) sources.delete(k);
  }, config.tickMs ?? 1000);
  const heartbeat = setInterval(() => {
    for (const m of meshes.values()) {
      for (const s of m.sockets.values()) {
        if (!s.alive) s.ws.terminate();
        else {
          s.alive = false;
          s.ws.ping();
        }
      }
    }
  }, config.heartbeatMs ?? 30_000);

  log(`wim-relay listening on ${relayUrls.join(", ")}`);
  if (config.problem !== undefined) log(`configuration problem: ${config.problem}; creating meshes is refused until it is fixed`);
  else if (config.createRefused !== undefined) log("creating meshes is closed: set WIM_CREATE_KEY, or WIM_OPEN_CREATE=1 to let anyone create one");
  else if (config.createKey !== undefined) log("creating a mesh needs the operator key (WIM_CREATE_KEY)");
  else log("creating meshes is open to anyone");
  if (tls) log(`LAN relay URL: ${relayUrls[0]}\nTLS pin (SPKI SHA-256, for the invite): ${tls.pin}`);

  return {
    port,
    relayUrls,
    pin: tls?.pin,
    loadedMeshes: () => meshes.size,
    close: async () => {
      clearInterval(tick);
      clearInterval(heartbeat);
      // Sessions go offline now, while the database is still open; the late close events are ignored.
      for (const m of meshes.values()) {
        for (const s of m.sockets.values()) {
          s.ws.removeAllListeners("close");
          m.relay.onClose(s.conn);
          s.ws.terminate();
        }
      }
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      raw.close();
    },
  };
}
