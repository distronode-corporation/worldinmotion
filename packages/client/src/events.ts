// `wim events --json` (docs/events.md): JSON lines over stdio for a local UI. The process is a
// session of its own; the UI sees what the device's sessions do and acts through it, without
// ever touching keys or the relay itself.

import { isRecoveryName, isUlid, sanitizeForDisplay } from "@worldinmotion/protocol";
import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { ClientError, MeshSession, type PeerRow } from "./client.ts";
import { noFollow, openNoFollow, type FsEnv } from "./fsx.ts";
import { History, parseEntry, type HistoryEntry } from "./history.ts";
import type { Device } from "./home.ts";
import { setDevicePolicy, trustLevel, type MeshFiles } from "./mesh.ts";
import { decideHeld, listAllHeld, resumeEverywhere, type HeldRow } from "./offline.ts";
import { policyLevel } from "./render.ts";
import { listSessions, SessionFiles } from "./session.ts";

export const EVENTS_VERSION = 1;

/** Bytes read from one history file in one pass; the rest waits for the next pass. */
export const FOLLOW_READ_MAX = 1024 * 1024;

/** Extra entries asked of each session for a `history` page, for entries at the cut's own time. */
const TIE_SLACK = 16;

const READ_FLAGS = constants.O_RDONLY | noFollow(constants);

/** Opens a history file for reading, never through a link; undefined when it is missing or a link. */
const openHistory = (path: string) => openNoFollow(path, READ_FLAGS);

export type EventsDeps = {
  /** Opened, not yet started: listeners go on before the first frame can arrive. */
  session: MeshSession;
  mesh: MeshFiles;
  env: FsEnv;
  device: Device;
  version: string;
  /** One line of stdout. */
  write: (line: string) => void;
  input: Readable;
  signal: AbortSignal;
  now: () => number;
  /** How often history files and held items are polled (500 ms). */
  pollMs?: number;
  /** How often leases are asked for while connected (5 s; each is a relay round trip). */
  leasePollMs?: number;
};

type Row = Record<string, unknown>;

const Request = z.object({ v: z.literal(EVENTS_VERSION), id: z.string().min(1).max(200), op: z.string(), args: z.record(z.string(), z.unknown()).optional() });
const To = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
const Args = {
  snapshot: z.object({}),
  history: z.object({ session: z.string().optional(), peer: z.string().optional(), before: z.string().optional(), limit: z.number().int().min(1).max(500).optional() }),
  send: z.object({ to: To, text: z.string(), reply_to: z.string().optional(), kind: z.enum(["msg", "task"]).optional() }),
  send_file: z.object({ to: To, path: z.string().min(1) }),
  approve: z.object({ held: z.string() }),
  refuse: z.object({ held: z.string() }),
  trust: z.object({ device: z.string(), relayed: z.boolean().optional() }),
  untrust: z.object({ device: z.string() }),
  resume: z.object({ peer: z.string() }),
} as const;

type Op = keyof typeof Args;

class RequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The relay URL without its path: what a UI may show of where the mesh lives. */
export function relayHost(relay: string): string {
  return new URL(relay).host;
}

/** A held row as the UI sees it, `session` being the holding session's address: no text yet. */
function heldRow(h: HeldRow, session: string): Row {
  return {
    id: h.id,
    session,
    from: h.from,
    device: h.device,
    kind: h.kind,
    at: h.at,
    preview: h.preview,
    reason: h.reason,
    ...(h.entry.file === undefined ? {} : { file: h.entry.file }),
  };
}

/** Runs the events process until stdin closes or the signal aborts. */
export async function runEvents(d: EventsDeps): Promise<void> {
  const s = d.session;
  const emit = (type: string, fields: Row = {}): void => d.write(JSON.stringify({ v: EVENTS_VERSION, type, at: d.now(), ...fields }));
  const myDevice = d.device.id;

  const deviceRows = (): Row[] =>
    // Recovery records never act (SPEC section 4a), so a UI has nothing to show or decide for them.
    s.roster.devices.filter((dev) => !isRecoveryName(dev.name)).map((dev) => ({ name: dev.name, id: dev.id, role: dev.role, policy: policyLevel(s.config, dev.id), self: dev.id === myDevice }));
  const sessionRow = (p: PeerRow): Row => ({
    address: p.address,
    sid: p.sid,
    kind: p.kind,
    status: p.status,
    since: p.since,
    rooms: p.rooms,
    ...(p.card === undefined ? {} : { card: p.card }),
    local: p.address.endsWith(`@${d.device.name}`),
  });
  const roomsOf = (rows: PeerRow[]): Row[] => {
    const rooms = new Map<string, string[]>();
    for (const p of rows) for (const r of p.rooms) rooms.set(r, [...(rooms.get(r) ?? []), p.address]);
    return [...rooms.entries()].sort().map(([name, members]) => ({ name, members }));
  };

  // ---- state the diffs compare against ----
  let devices = new Map<string, string>();
  let peers = new Map<string, string>();
  let held = new Map<string, { sid: string; row: Row }>();
  let leases = new Map<string, string>();
  /** Per session: the history file being followed (by inode) and how far it was read. */
  const followed = new Map<string, { ino: bigint; offset: number }>();
  /** Whether a snapshot went out since the last connection change: peer changes count only then. */
  let synced = false;
  /** Peers paused and not yet resumed, as the `breaker` events reported them. */
  const paused = new Map<string, Row>();
  const breaker = (b: Row): void => {
    const { state: _state, ...row } = b;
    if (b["state"] === "tripped" && !paused.has(b["peer"] as string)) paused.set(b["peer"] as string, { ...row, at: d.now() });
    if (b["state"] === "resumed") paused.delete(b["peer"] as string);
    emit("breaker", b);
  };
  const addresses = new Map<string, string>();

  const remember = <T>(rows: T[], key: (r: T) => string): Map<string, string> => new Map(rows.map((r) => [key(r), JSON.stringify(r)]));

  /** Every held item on this device, keyed by holding session and id. */
  async function heldNow(): Promise<Map<string, { sid: string; row: Row }>> {
    const out = new Map<string, { sid: string; row: Row }>();
    for (const h of await listAllHeld(d.mesh, d.env)) {
      const address = await addressOf(h.sid);
      out.set(`${h.sid}/${h.id}`, { sid: h.sid, row: heldRow(h, address) });
    }
    return out;
  }

  async function snapshot(): Promise<void> {
    // Offline, the snapshot is what this session last knew; it never waits for the relay.
    const online = s.link?.isOpen === true;
    const rows = online ? await s.listPeers({ forPane: true }).catch(() => s.knownPeers()) : s.knownPeers();
    const leaseRows = online ? await s.listLeases().catch(() => []) : [];
    held = await heldNow();
    const heldRows = [...held.values()].map((h) => h.row);
    const devs = deviceRows();
    devices = remember(devs, (r) => r["id"] as string);
    peers = remember(rows.map(sessionRow), (r) => r["address"] as string);
    leases = remember(leaseRows, (l) => l.name);
    // Breaker holds already on disk count as paused peers too (from before this process started).
    for (const h of held.values()) {
      const peer = h.row["from"] as string;
      if (h.row["reason"] === "breaker" && !paused.has(peer)) paused.set(peer, { peer, at: h.row["at"] });
    }
    synced = true;
    emit("snapshot", { devices: devs, sessions: rows.map(sessionRow), rooms: roomsOf(rows), leases: leaseRows, held: heldRows, breakers: [...paused.values()] });
  }

  /** Emits rows that are new or changed since the last look, and `removed` for rows now gone. */
  function diff(kind: string, rows: Row[], key: (r: Row) => string, last: Map<string, string>, gone: (old: Row) => Row): Map<string, string> {
    const next = new Map<string, string>();
    for (const r of rows) {
      const k = key(r);
      const text = JSON.stringify(r);
      next.set(k, text);
      if (last.get(k) !== text) emit(kind, r);
    }
    for (const [k, text] of last) if (!next.has(k)) emit(kind, { ...gone(JSON.parse(text) as Row), removed: true });
    return next;
  }
  const deviceGone = (r: Row): Row => ({ name: r["name"], id: r["id"] });
  const peerGone = (r: Row): Row => ({ address: r["address"] });

  /** A history entry as a message row: `to` lists an outgoing message's recipients. */
  const messageRow = (e: HistoryEntry, session: string): Row => ({ ...e, session, ...(e.dir === "out" ? { to: e.peer.split(",") } : {}) });

  // ---- message events: follow every local session's history ----
  /** A local session's address, from its state (the name the relay last assigned). */
  async function addressOf(sid: string): Promise<string> {
    const known = addresses.get(sid);
    if (known !== undefined) return known;
    const state = await new SessionFiles(d.mesh, sid, d.env).load();
    const address = state?.address ?? `${state?.name ?? "?"}@${d.device.name}`;
    // An address learnt from `ready` is final for the session; a guess is asked again later.
    if (state?.address !== undefined) addresses.set(sid, address);
    return address;
  }

  /** Emits the whole lines of `handle` from `start`, at most FOLLOW_READ_MAX bytes; returns the new offset. */
  async function readLines(handle: FileHandle, start: number, size: number, sid: string): Promise<number> {
    const buf = Buffer.alloc(Math.min(size - start, FOLLOW_READ_MAX));
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    // Only whole lines: a line still being written is read on the next pass.
    const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a) + 1;
    if (end === 0) {
      // A full pass with no line end in it is not a history line: skip it. What follows up to the
      // next line end then reads as a damaged line, and is skipped too.
      return bytesRead === FOLLOW_READ_MAX ? start + bytesRead : start;
    }
    const address = await addressOf(sid);
    for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
      const entry = parseEntry(line);
      if (entry !== undefined) emit("message", messageRow(entry, address));
    }
    return start + end;
  }

  /** The rest of a history file that was rotated away since the last pass, found by its inode. */
  async function drainRotated(files: SessionFiles, was: { ino: bigint; offset: number }, sid: string): Promise<void> {
    for (const name of await fs.readdir(files.dir)) {
      if (!/^history-[0-9A-Z]{26}\.jsonl$/.test(name)) continue;
      const handle = await openHistory(join(files.dir, name));
      if (handle === undefined) continue;
      try {
        const st = await handle.stat({ bigint: true });
        if (st.ino === was.ino && Number(st.size) > was.offset) await readLines(handle, was.offset, Number(st.size), sid);
      } finally {
        await handle.close();
      }
    }
  }

  async function followOne(sid: string, initial: boolean): Promise<void> {
    const files = new SessionFiles(d.mesh, sid, d.env);
    const handle = await openHistory(files.historyPath);
    if (handle === undefined) return;
    try {
      const st = await handle.stat({ bigint: true });
      const size = Number(st.size);
      const was = followed.get(sid);
      // At start nothing is replayed; a file seen first later is read from its beginning.
      if (initial) return void followed.set(sid, { ino: st.ino, offset: size });
      let start = 0;
      // Another inode is the successor after a rotation: what was left in the old file comes first.
      if (was !== undefined && was.ino !== st.ino) await drainRotated(files, was, sid);
      // The same file, unless it was cut shorter in place.
      else if (was !== undefined && was.offset <= size) start = was.offset;
      followed.set(sid, { ino: st.ino, offset: start === size ? start : await readLines(handle, start, size, sid) });
    } finally {
      await handle.close();
    }
  }

  async function follow(initial: boolean): Promise<void> {
    // One session's damaged or unreadable history never stops the others' in the same pass.
    for (const sid of await listSessions(d.mesh)) await followOne(sid, initial).catch(() => undefined);
  }

  async function heldPass(): Promise<void> {
    const next = await heldNow();
    // Pairs of (session, peer) already paused, so one pause is reported once.
    const pausedIn = new Set([...held.values()].filter((o) => o.row["reason"] === "breaker").map((o) => `${o.sid} ${o.row["from"] as string}`));
    for (const [k, h] of next) {
      if (held.has(k)) continue;
      emit("held", { op: "add", item: h.row });
      // Another local session's first breaker hold for a peer shows that peer as paused there.
      // This process's own breaker reports itself, with the reason.
      const pair = `${h.sid} ${h.row["from"] as string}`;
      if (h.row["reason"] === "breaker" && h.sid !== s.sid && !pausedIn.has(pair)) {
        pausedIn.add(pair);
        breaker({ peer: h.row["from"], state: "tripped" });
      }
    }
    for (const [k, h] of held) if (!next.has(k)) emit("held", { op: "remove", item: h.row });
    held = next;
  }

  async function poll(): Promise<void> {
    await follow(false);
    await heldPass();
    devices = diff("device", deviceRows(), (r) => r["id"] as string, devices, deviceGone);
  }

  async function leasePass(): Promise<void> {
    if (s.link === undefined) return;
    const rows = await s.listLeases();
    const next = remember(rows, (l) => l.name);
    for (const l of rows) if (leases.get(l.name) !== JSON.stringify(l)) emit("lease", l);
    for (const name of leases.keys()) if (!next.has(name)) emit("lease", { name, released: true });
    leases = next;
  }

  // ---- requests ----
  async function history(a: z.infer<typeof Args.history>): Promise<Row> {
    const want = a.limit ?? 50;
    const sessions: Array<{ address: string; history: History }> = [];
    for (const sid of await listSessions(d.mesh)) {
      const address = await addressOf(sid);
      if (a.session !== undefined && a.session !== address) continue;
      sessions.push({ address, history: new History(new SessionFiles(d.mesh, sid, d.env).historyPath, d.now) });
    }
    const shown = (e: HistoryEntry): boolean => a.peer === undefined || e.peer.split(",").includes(a.peer);
    // The page ends just before `before`: its time bounds what each session is asked for.
    let until: number | undefined;
    for (const { history: h } of a.before === undefined ? [] : sessions) {
      const cut = await h.find(a.before!);
      if (cut !== undefined && shown(cut)) {
        until = cut.at;
        break;
      }
    }
    // Each session gives at most a page (plus entries at the cut's own time), never its whole file.
    const ask = { limit: want + TIE_SLACK, max: want + TIE_SLACK, ...(until === undefined ? {} : { before: until + 1 }), ...(a.peer === undefined ? {} : { peer: a.peer }) };
    const all: HistoryEntry[] = [];
    for (const { address, history: h } of sessions) for (const e of await h.query(ask)) all.push(messageRow(e, address) as HistoryEntry);
    // A stable sort keeps each file's own order for entries with the same time.
    all.sort((x, y) => x.at - y.at);
    const cut = a.before === undefined ? -1 : all.findIndex((e) => e.id === a.before);
    const upto = cut === -1 ? all : all.slice(0, cut);
    return { messages: upto.slice(-want) };
  }

  // `a` was validated against Args[op], so each branch reads it as that shape.
  async function run(op: Op, a: any): Promise<Row> {
    switch (op) {
      case "snapshot":
        await snapshot();
        return {};
      case "history":
        return history(a as z.infer<typeof Args.history>);
      case "send": {
        const i = a as z.infer<typeof Args.send>;
        return s.send(i.to, i.text, { ...(i.reply_to === undefined ? {} : { reply_to: i.reply_to }), ...(i.kind === undefined ? {} : { kind: i.kind }) });
      }
      case "send_file": {
        const i = a as z.infer<typeof Args.send_file>;
        if (!isAbsolute(i.path)) throw new RequestError("input", "path must be absolute");
        return s.sendFile(i.to, i.path);
      }
      case "approve":
      case "refuse": {
        const id = (a as { held: string }).held;
        if (!isUlid(id)) throw new RequestError("input", "held must be a held message id");
        const verdict = op === "approve" ? "approve" : "refuse";
        // This process decides its own items itself (it can send the receipt); others on disk.
        const mine = (await s.held.get(id)) !== undefined;
        if (mine) await s.decide(id, verdict);
        const others = await decideHeld(d.mesh, id, verdict, d.env, d.now, s.sid);
        if (!mine && others === 0) throw new RequestError("not_found", `no held message ${id}`);
        return {};
      }
      case "trust":
      case "untrust": {
        const name = (a as { device: string }).device;
        const target = s.roster.devices.find((x) => x.name === name);
        if (target === undefined) throw new RequestError("not_found", `no device named ${sanitizeForDisplay(name)}`);
        const policy = await setDevicePolicy(d.mesh, target.id, trustLevel(op, (a as { relayed?: boolean }).relayed === true));
        s.config = await d.mesh.loadConfig();
        devices = diff("device", deviceRows(), (r) => r["id"] as string, devices, deviceGone);
        return { policy };
      }
      case "resume": {
        const peer = (a as { peer: string }).peer;
        const released = (await s.resumePeer(peer)) + (await resumeEverywhere(d.mesh, peer, d.env, d.now, s.sid));
        return { released };
      }
    }
  }

  async function handle(line: string): Promise<void> {
    let id: string | undefined;
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new RequestError("input", "not JSON");
      }
      const req = Request.safeParse(raw);
      if (!req.success) {
        id = typeof (raw as { id?: unknown } | null)?.id === "string" ? (raw as { id: string }).id : undefined;
        throw new RequestError("input", "a request is { v: 1, id, op, args? }");
      }
      id = req.data.id;
      if (!Object.hasOwn(Args, req.data.op)) throw new RequestError("input", `unknown op ${req.data.op}`);
      const op = req.data.op as Op;
      const args = Args[op].safeParse(req.data.args ?? {});
      if (!args.success) throw new RequestError("input", args.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      const result = await run(op, args.data as never);
      emit("response", { id, ok: true, result });
    } catch (error) {
      const code = error instanceof RequestError ? error.code : error instanceof ClientError ? (error.code === "secret" ? "refused" : error.code === "bad_address" ? "input" : error.code) : "error";
      emit("response", { ...(id === undefined ? {} : { id }), ok: false, error: { code, message: (error as Error).message } });
    }
  }

  // ---- wiring ----
  emit("hello", {
    version: d.version,
    device: { name: d.device.name, id: d.device.id },
    // Where the device keys are: in this process (`local`), or in the signer (`signer`).
    keys: d.device.keyring.kind,
    session: s.address,
    relay: relayHost(s.config.relay),
    mesh: `${s.config.mesh.slice(0, 4)}…`,
  });
  s.on("connection", (state: string, detail?: string) => {
    synced = false;
    emit("connection", { state, ...(detail === undefined ? {} : { detail }) });
    if (state === "open") void snapshot().catch(() => undefined);
  });
  s.on("peers", () => {
    // Rows that arrive with `ready` belong to the snapshot that follows `open`, not to changes.
    if (!synced) return;
    peers = diff("peer", s.knownPeers().map(sessionRow), (r) => r["address"] as string, peers, peerGone);
  });
  s.on("receipt", (f: { id: string; to: string; status: string }) => emit("receipt", { id: f.id, to: f.to, status: f.status }));
  s.on("breaker", (b: Row) => breaker(b));

  await follow(true);
  held = await heldNow();
  // Devices are part of the first snapshot, not changes before it.
  devices = remember(deviceRows(), (r) => r["id"] as string);
  s.start();

  let busy = false;
  const tick = setInterval(() => {
    if (busy) return;
    busy = true;
    void poll()
      .catch(() => undefined)
      .finally(() => (busy = false));
  }, d.pollMs ?? 500);
  const leaseTick = setInterval(() => void leasePass().catch(() => undefined), d.leasePollMs ?? 5000);

  // Requests are answered in order, one at a time.
  let queue = Promise.resolve();
  const lines = createInterface({ input: d.input });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    queue = queue.then(() => handle(line));
  });
  const ended = new Promise<void>((resolve) => lines.once("close", resolve));
  const aborted = new Promise<void>((resolve) => (d.signal.aborted ? resolve() : d.signal.addEventListener("abort", () => resolve(), { once: true })));
  await Promise.race([ended, aborted]);
  clearInterval(tick);
  clearInterval(leaseTick);
  lines.close();
  await queue;
}
