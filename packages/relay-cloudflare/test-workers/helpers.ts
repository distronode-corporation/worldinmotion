import { env, runInDurableObject, SELF } from "cloudflare:test";
import { vi } from "vitest";
import {
  b64u,
  createGenesisRoster,
  deviceIdFromSignPub,
  generateDeviceKeys,
  makeDeviceRecord,
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
import { MeshDurableObject, REGISTRY_NAME, type Env } from "../src/index.ts";

const realNow = Date.now.bind(Date);

/**
 * A clock that runs at real speed plus a settable offset. The tests, the Worker and the Durable
 * Objects share one isolate, so the relay sees the same Date.now.
 */
export const clock = {
  offset: 0,
  install(): void {
    clock.offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + clock.offset);
  },
  advance(ms: number): void {
    clock.offset += ms;
  },
};

/** The stub of a mesh's Durable Object. */
export function meshStub(mesh: string) {
  return env.MESH.get(env.MESH.idFromName(mesh));
}

/** Real milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The relay URL wrangler.jsonc configures (the public placeholder). */
export const RELAY = "wss://relay.example.com";
export const ORIGIN = "https://relay.example.com";

export type Frame = Record<string, any>;

/** A fresh random mesh id, so tests never share a Durable Object. */
export function meshId(): string {
  return b64u.encode(randomBytes(16));
}

export type Dev = { name: string; id: string; keys: DeviceKeys; record: DeviceRecord };

export function dev(name: string, role: DeviceRecord["role"] = "member", added = Date.now()): Dev {
  const keys = generateDeviceKeys();
  return { name, id: deviceIdFromSignPub(keys.signPub), keys, record: makeDeviceRecord(name, keys, role, added) };
}

/** A real WebSocket to the relay Worker, through SELF.fetch, with a frame inbox. */
export class Socket {
  readonly frames: Frame[] = [];
  closed: { code: number; reason: string } | undefined;
  private waiters: (() => void)[] = [];
  readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (e) => {
      this.frames.push(JSON.parse(e.data as string) as Frame);
      this.wake();
    });
    ws.addEventListener("close", (e) => {
      this.closed = { code: e.code, reason: e.reason };
      this.wake();
    });
    ws.accept();
  }

  /** Opens a socket. Each gets its own client address unless `headers` names one. */
  static async open(mesh: string, headers: Record<string, string> = {}): Promise<Socket> {
    const ip = `2001:db8::${b64u.encode(randomBytes(3)).replace(/[^a-z0-9]/gi, "0")}`;
    const res = await SELF.fetch(`${ORIGIN}/v1/${mesh}`, { headers: { upgrade: "websocket", "cf-connecting-ip": ip, ...headers } });
    if (res.webSocket === null) throw new Error(`no upgrade: ${res.status} ${await res.text()}`);
    return new Socket(res.webSocket);
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  send(frame: unknown): void {
    this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  /**
   * Waits for the first unread frame matching `t` (a type, or a predicate; any frame when
   * omitted), removes it from the inbox and returns it.
   */
  async next(t?: string | ((f: Frame) => boolean), timeoutMs = 5000): Promise<Frame> {
    const end = realNow() + timeoutMs;
    const match = typeof t === "function" ? t : (f: Frame) => t === undefined || f["t"] === t;
    for (;;) {
      const i = this.frames.findIndex(match);
      if (i >= 0) return this.frames.splice(i, 1)[0]!;
      if (this.closed) throw new Error(`closed (${this.closed.code} ${this.closed.reason}) waiting for ${String(t ?? "a frame")}`);
      await this.wait(end);
    }
  }

  /** Waits for the server to close the socket. */
  async closedWith(timeoutMs = 5000): Promise<{ code: number; reason: string }> {
    const end = realNow() + timeoutMs;
    while (!this.closed) await this.wait(end);
    return this.closed;
  }

  private wait(end: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out")), Math.max(1, end - realNow()));
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Sends `frame` and waits for the answer of type `t`. */
  async ask(frame: unknown, t: string): Promise<Frame> {
    this.send(frame);
    return this.next(t);
  }

  close(): void {
    this.ws.close(1000, "done");
  }
}

/** One session of a device: authenticates on a socket and seals messages. */
export class Session {
  sock!: Socket;
  ready: Frame | undefined;
  seq = 0;
  readonly sid = ulid();
  readonly resume = b64u.encode(randomBytes(32));
  readonly mesh: string;
  readonly d: Dev;
  name: string;
  constructor(mesh: string, d: Dev, name: string) {
    this.mesh = mesh;
    this.d = d;
    this.name = name;
  }

  get address(): string {
    return `${this.name}@${this.d.name}`;
  }

  authFrame(nonce: string, roster: Roster, opts: { cursor?: number; pin?: { seq: number; hash: string } } = {}) {
    return signAuth(
      {
        relay: RELAY,
        mesh: this.mesh,
        nonce,
        at: Date.now(),
        session: { name: this.name, kind: "cli", sid: this.sid, resume: this.resume },
        resume: opts.cursor === undefined ? undefined : { cursor: opts.cursor },
        pin: opts.pin ?? rosterRef(roster),
      },
      this.d.keys,
    );
  }

  /** Authenticates on `sock` (a fresh socket by default) and waits for `ready`. */
  async connect(roster: Roster, opts: { sock?: Socket; nonce?: string; cursor?: number; pin?: { seq: number; hash: string } } = {}): Promise<Frame> {
    this.sock = opts.sock ?? (await Socket.open(this.mesh));
    const nonce = opts.nonce ?? ((await this.sock.next("hello"))["nonce"] as string);
    this.sock.send(this.authFrame(nonce, roster, opts));
    this.ready = await this.sock.next("ready");
    this.name = this.ready["name"] as string;
    return this.ready;
  }

  seal(roster: Roster, to: string[], recipients: string[], text = "hello"): SendFrame {
    return sealMessage({
      roster,
      sender: { deviceId: this.d.id, keys: this.d.keys },
      session: this.name,
      sid: this.sid,
      to,
      seq: ++this.seq,
      at: Date.now(),
      text,
      recipients,
    });
  }
}

/** Creates a mesh over the wire with a fresh admin device and returns its genesis roster. */
export async function createMesh(mesh = meshId(), extra: Record<string, unknown> = {}): Promise<{ mesh: string; admin: Dev; genesis: Roster; sock: Socket }> {
  const admin = dev("admin", "admin");
  const genesis = createGenesisRoster({ name: "admin", keys: admin.keys, now: Date.now(), meshId: mesh });
  const sock = await Socket.open(mesh);
  await sock.next("hello");
  const roster = await sock.ask({ t: "create", roster: genesis, ...extra }, "roster");
  if (roster["chain"][0]["seq"] !== 1) throw new Error("create failed");
  return { mesh, admin, genesis, sock };
}

/** The Worker's bindings without any variable, for tests that build their own environment. */
export const bindings = { MESH: env.MESH, SOURCES: env.SOURCES, REGISTRY: env.REGISTRY } satisfies Partial<Env>;

/** How many meshes the registry counts. */
export async function registered(): Promise<number> {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(REGISTRY_NAME));
  return runInDurableObject(stub, (_o, state) => {
    const t = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'meshes'").toArray();
    return t.length === 0 ? 0 : Number(state.storage.sql.exec("SELECT n FROM meshes").one()["n"]);
  });
}

/**
 * Sends `frame` (by default a valid `create` for a fresh mesh) on a fresh socket, handled by an
 * instance built with `vars` on top of the relay URL; returns the answer and the mesh id.
 */
export async function createWith(vars: Partial<Env>, frame?: (mesh: string) => unknown): Promise<{ answer: Frame; mesh: string }> {
  const mesh = meshId();
  const sock = await Socket.open(mesh);
  await sock.next("hello");
  const admin = dev("admin", "admin");
  const body = frame?.(mesh) ?? { t: "create", roster: createGenesisRoster({ name: "admin", keys: admin.keys, now: Date.now(), meshId: mesh }) };
  await runInDurableObject(meshStub(mesh), async (_o, state) => {
    const other = new MeshDurableObject(state, { ...bindings, WIM_RELAY_URLS: RELAY, ...vars });
    await other.webSocketMessage(state.getWebSockets()[0]!, JSON.stringify(body));
  });
  const answer = await sock.next();
  sock.close();
  return { answer, mesh };
}
