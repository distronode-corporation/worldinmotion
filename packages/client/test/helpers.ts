// Test helpers: scratch directories, an in-process relay (relay-core) behind a Dialer, and
// devices and meshes built through the real create, invite and join flows.

import { MemoryStore, MeshRelay, type Conn, type ConnState } from "@worldinmotion/relay-core";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMesh, decideJoin, issueInvite, joinMesh } from "../src/admin.ts";
import { MeshSession, type SessionOptions } from "../src/client.ts";
import type { FsEnv } from "../src/fsx.ts";
import type { Platform } from "../src/platform.ts";
import { Home, type Device } from "../src/home.ts";
import { MeshFiles } from "../src/mesh.ts";
import type { Dialer, WireSocket } from "../src/wire.ts";
import { main, type CliIO } from "../src/cli.ts";
import { PassThrough } from "node:stream";

/** Where test scratch directories go: `WIM_TEST_TMP` when set, else the system temp directory (honours TMPDIR). */
function scratchRoot(): string {
  return process.env["WIM_TEST_TMP"] || tmpdir();
}

export const RELAY = "ws://127.0.0.1:4444";
/** The real platform: tests that use real files run the client as it runs on this machine. */
export const FS: FsEnv = { platform: process.platform, pid: process.pid };

/** False on Windows, which has no POSIX mode bits: there a file's mode reads 666 whatever was asked. */
export const POSIX = process.platform !== "win32";

/**
 * A POSIX platform, for tests of the checks on real files' mode bits. On POSIX the test sets the
 * mode itself. Windows reports every file and directory as mode 666, so a client told it runs on
 * Linux reads them all as open to group and others.
 */
export const POSIX_VIEW: Platform = POSIX ? process.platform : "linux";

/**
 * A live process that is not this one, on every platform: this process's parent (the test
 * runner). Tests write it into lock files as "another process holds this".
 */
export const LIVE_PID = process.ppid;

const ROOT = join(scratchRoot(), "wim-client-tests");

/** A fresh directory under the scratch root. */
export async function scratch(prefix = "t"): Promise<string> {
  await fs.mkdir(ROOT, { recursive: true });
  return fs.mkdtemp(join(ROOT, `${prefix}-`));
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls until `check` is true, or fails after `ms`. */
export async function until(check: () => boolean | Promise<boolean>, ms = 3000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

type Socket = WireSocket & { deliver(text: string): void; shut(code: number, reason: string): void };

/** One in-process relay process: a MeshRelay per mesh id, reached through `dialer`. */
export class RelayHarness {
  readonly relays = new Map<string, { relay: MeshRelay; conns: Map<string, { conn: Conn; socket: Socket }>; states: Map<string, ConnState> }>();
  now: () => number = Date.now;
  /** When set, dials fail (the relay is unreachable). */
  down = false;
  /** Rewrites or drops (`undefined`) frames from the relay to the client. */
  toClient: ((text: string, connId: string) => string | undefined) | undefined;
  /** Rewrites or drops frames from the client to the relay. */
  toRelay: ((text: string, connId: string) => string | undefined) | undefined;
  readonly sentByClients: string[] = [];
  private next = 0;
  readonly createKey: string | undefined;

  constructor(opts: { createKey?: string } = {}) {
    this.createKey = opts.createKey;
  }

  private meshFor(mesh: string) {
    let m = this.relays.get(mesh);
    if (m !== undefined) return m;
    const conns = new Map<string, { conn: Conn; socket: Socket }>();
    const states = new Map<string, ConnState>();
    const store = new MemoryStore();
    const relay = new MeshRelay(
      { meshId: mesh, relayUrls: [RELAY], ...(this.createKey === undefined ? {} : { createKey: this.createKey }) },
      {
        store,
        now: () => this.now(),
        connections: () => [...conns.values()].map((c) => c.conn),
        getState: (c) => states.get(c.id),
        setState: (c, s) => void states.set(c.id, s),
        log: () => undefined,
      },
    );
    m = { relay, conns, states };
    this.relays.set(mesh, m);
    return m;
  }

  relay(mesh: string): MeshRelay {
    return this.meshFor(mesh).relay;
  }

  readonly dials: Array<{ url: string; tlsPin?: string }> = [];

  readonly dialer: Dialer = async (url, opts) => {
    this.dials.push({ url, ...opts });
    if (this.down) throw new Error("connect ECONNREFUSED");
    const m = /\/v1\/([A-Za-z0-9_-]+)$/.exec(url);
    if (m === null || !url.startsWith(RELAY)) throw new Error(`unexpected url ${url}`);
    const mesh = this.meshFor(m[1]!);
    const id = `c${++this.next}`;
    let onMessage: (t: string) => void = () => undefined;
    let onClose: (c: number, r: string) => void = () => undefined;
    let open = true;
    const shut = (code: number, reason: string): void => {
      if (!open) return;
      open = false;
      mesh.conns.delete(id);
      setImmediate(() => {
        mesh.relay.onClose(conn);
        onClose(code, reason);
      });
    };
    const socket: Socket = {
      send: (text) => {
        if (!open) return;
        this.sentByClients.push(text);
        const t = this.toRelay === undefined ? text : this.toRelay(text, id);
        // Frames sent before a close still arrive first, as on a real socket.
        if (t !== undefined) setImmediate(() => mesh.relay.onMessage(conn, t));
      },
      close: (code = 1000, reason = "") => shut(code, reason),
      onMessage: (cb) => void (onMessage = cb),
      onClose: (cb) => void (onClose = cb),
      deliver: (text) => {
        const t = this.toClient === undefined ? text : this.toClient(text, id);
        if (t !== undefined && open) setImmediate(() => onMessage(t));
      },
      shut,
    };
    const conn: Conn = { id, send: (text) => socket.deliver(text), close: (code, reason) => shut(code, reason) };
    // The relay greets on open; the client registers its handlers in the same tick. The connection
    // joins the relay's list in that same step, as on relay-node: listed before onOpen, it would
    // have no state yet, and a push to every connection in between would read it.
    setImmediate(() => {
      if (!open) return;
      mesh.conns.set(id, { conn, socket });
      mesh.relay.onOpen(conn, { source: "test" });
    });
    return socket;
  };

  /** Drops every connection to every mesh, like a network blip. */
  dropAll(code = 1006): void {
    for (const m of this.relays.values()) for (const { socket } of [...m.conns.values()]) socket.shut(code, "dropped");
  }

  /** Pushes a frame to every client connection of a mesh, as if the relay sent it. */
  inject(mesh: string, text: string): void {
    for (const { socket } of this.meshFor(mesh).conns.values()) socket.deliver(text);
  }

  tick(): void {
    for (const m of this.relays.values()) m.relay.tick(this.now());
  }
}

/** The roster seqs a mesh's files hold, in order. */
export async function rosterSeqs(files: MeshFiles): Promise<number[]> {
  return (await fs.readdir(files.rostersDir).catch(() => [] as string[]))
    .map((n) => /^(\d+)\.json$/.exec(n)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((x, y) => x - y);
}

export type TestDevice = { home: Home; device: Device; root: string };

export async function newDevice(name: string): Promise<TestDevice> {
  const root = await scratch(name);
  const home = new Home(root, { ...FS, uid: process.getuid?.() });
  const device = await home.createDevice(name);
  return { home, device, root };
}

export function sessionOpts(d: TestDevice, mesh: string, relay: RelayHarness, extra: Partial<SessionOptions> = {}): SessionOptions {
  return {
    device: d.device,
    mesh: new MeshFiles(d.home.meshDir(mesh), FS),
    name: "agent",
    kind: "mcp",
    dialer: relay.dialer,
    env: FS,
    tickMs: 20,
    answerMs: 2000,
    reconnectMs: 20,
    random: () => 0.5,
    ...extra,
  };
}

export async function openSession(d: TestDevice, mesh: string, relay: RelayHarness, extra: Partial<SessionOptions> = {}): Promise<MeshSession> {
  const s = await MeshSession.open(sessionOpts(d, mesh, relay, extra));
  s.start();
  await s.ready(3000);
  return s;
}

/** A mesh with an admin device and members, built with the real create, invite and join flows. */
export async function makeMesh(relay: RelayHarness, names: string[], opts: { trust?: boolean } = {}): Promise<{ mesh: string; devices: TestDevice[]; recoveryCode: string | undefined }> {
  const [first, ...rest] = names;
  const admin = await newDevice(first!);
  const made = await createMesh({ home: admin.home, device: admin.device, relay: RELAY, dialer: relay.dialer, now: () => relay.now() });
  const devices = [admin];
  const adminSession = await openSession(admin, made.mesh, relay, { name: "inviter", kind: "cli" });
  try {
    for (const name of rest) {
      const d = await newDevice(name);
      const inv = await issueInvite(adminSession, { ttlMs: 3_600_000, auto: true, now: () => relay.now() });
      const decided = new Promise<void>((resolve, reject) => {
        adminSession.once("join", (body) => {
          decideJoin(adminSession, body, async () => true, () => relay.now()).then((dec) => (dec.outcome === "admitted" ? resolve() : reject(new Error(dec.reason))), reject);
        });
      });
      await Promise.all([joinMesh({ home: d.home, device: d.device, code: inv.code, dialer: relay.dialer, now: () => relay.now(), showSas: () => undefined }), decided]);
      devices.push(d);
    }
  } finally {
    await adminSession.stop({ ended: true });
  }
  if (opts.trust !== false) {
    // Every device trusts every other, so messages are delivered rather than held.
    for (const d of devices) {
      const files = new MeshFiles(d.home.meshDir(made.mesh), FS);
      await files.updateConfig((c) => {
        const policy = { ...c.policy };
        for (const o of devices) if (o.device.id !== d.device.id) policy[o.device.id] = "deliver";
        return { ...c, policy };
      });
    }
  }
  return { mesh: made.mesh, devices, recoveryCode: made.recoveryCode };
}

export type Term = { io: CliIO; out: string[]; err: string[]; answers: string[]; stop: AbortController; env: Record<string, string | undefined> };

export function term(home: string, relay: RelayHarness, extra: Partial<CliIO> = {}, env: Record<string, string | undefined> = {}): Term {
  const out: string[] = [];
  const err: string[] = [];
  const answers: string[] = [];
  const stop = new AbortController();
  const io: CliIO = {
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
    prompt: async (q) => {
      out.push(q);
      return answers.shift() ?? "";
    },
    signal: stop.signal,
    cwd: home,
    homedir: home,
    hostname: "My Host.local",
    platform: process.platform,
    uid: process.getuid?.(),
    pid: process.pid,
    now: Date.now,
    dialer: relay.dialer,
    isTTY: true,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    fetch: (async () => {
      throw new Error("no network in tests");
    }) as typeof fetch,
    parentGone: () => false,
    ...extra,
  };
  return { io, out, err, answers, stop, env: { WIM_HOME: home, ...env } };
}

export const run = (t: Term, ...argv: string[]): Promise<number> => main(argv, t.env, t.io);
export const said = (t: Term): string => [...t.out, ...t.err].join("\n");

