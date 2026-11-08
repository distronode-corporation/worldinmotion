// `wim events --json` (docs/events.md): JSON lines over stdio for a local UI. The process is a
// session of its own; the UI sees what the device's sessions do and acts through it, without
// ever touching keys or the relay itself.

import { hash, HOSTED_RELAY, isName, isRecoveryName, isUlid, LIMITS, parseInvite, sanitizeForDisplay } from "@worldinmotion/protocol";
import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { admitPending, createMesh, issueInvite, joinMesh } from "./admin.ts";
import { ClientError, MeshSession, type PeerRow } from "./client.ts";
import { noFollow, openNoFollow, type FsEnv } from "./fsx.ts";
import { History, parseEntry, type HistoryEntry } from "./history.ts";
import type { Device, Home } from "./home.ts";
import { Invites, PendingJoins } from "./joins.ts";
import { addersOf, joinApproval, MeshFiles, setDevicePolicy, trustLevel, type Adder } from "./mesh.ts";
import type { Dialer } from "./wire.ts";
import { SetupError } from "./errors.ts";
import { resolveInvite, type BoxFetcher } from "./shortcode.ts";
import { decideHeld, listAllHeld, resumeEverywhere, type HeldRow } from "./offline.ts";
import { loadCiRules, type CiRule } from "./cirules.ts";
import type { Verdict } from "./held.ts";
import { decisionFor, decisionsFor, NEEDS_SIGNER, type DecideRequest, type Decision, type DecisionVerdict } from "./decisions.ts";
import { pinsIds, setFields, setKey } from "./heldsets.ts";
import { listAllPauses } from "./pauses.ts";
import { policyLevel } from "./render.ts";
import { listSessions, SessionFiles } from "./session.ts";
import type { Platform } from "./platform.ts";
import { holdForShow, showPaths } from "./secretout.ts";
import { checkDialable } from "./wire.ts";

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
  /**
   * The agent variable in this process's environment, if any (`agentEnv`). Adding a device, and
   * deciding what reaches the agents, are the person's (SECURITY-MODEL sections 5.6 and 7.5), so
   * `invite`, `admit`, `approve`, `refuse`, `resume`, `trust` and `untrust` are refused when one is set.
   */
  agent?: string;
  /**
   * Asks this device's signer for a decision on held messages (decisions.ts requestDecision). Used
   * when the keys are in the signer: then an approve, refuse or resume goes ahead only signed.
   */
  decide?: (req: DecideRequest, stop?: AbortSignal) => Promise<Decision>;
};

type Row = Record<string, unknown>;

/** Runs `fn` (waiting for the person in the signer) without holding the request queue, then takes the queue's next turn. */
type Ask = <T>(fn: () => Promise<T>) => Promise<T>;

const Request = z.object({ v: z.literal(EVENTS_VERSION), id: z.string().min(1).max(200), op: z.string(), args: z.record(z.string(), z.unknown()).optional() });
const To = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
const Args = {
  snapshot: z.object({}),
  history: z.object({ session: z.string().optional(), peer: z.string().optional(), before: z.string().optional(), limit: z.number().int().min(1).max(500).optional() }),
  send: z.object({ to: To, text: z.string(), reply_to: z.string().optional(), kind: z.enum(["msg", "task"]).optional() }),
  send_file: z.object({ to: To, path: z.string().min(1) }),
  // `set`: the ids of the set the person was shown (a UI draws one set per sending device or CI
  // rule); the decision covers exactly those. Without it, `held` alone is decided.
  approve: z.object({ held: z.string(), set: z.array(z.string()).min(1).max(1000).optional() }),
  refuse: z.object({ held: z.string(), set: z.array(z.string()).min(1).max(1000).optional() }),
  trust: z.object({ device: z.string(), relayed: z.boolean().optional() }),
  untrust: z.object({ device: z.string() }),
  resume: z.object({ peer: z.string() }),
  invite: z.object({ exp: z.number().int().min(60_000).max(LIMITS.inviteMaxTtlMs).optional(), own: z.boolean().optional() }),
  admit: z.object({ device: z.string(), code: z.string().min(1).max(64) }),
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

/** JSON with every object's keys sorted, so two rows with the same fields compare equal. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
  );
}

/**
 * A held row as the UI sees it, `session` being the holding session's address: no text yet.
 * `set` is the set it is decided with (one per sending device or CI rule) and `set_title` who that
 * set is from; a CI notice adds what its job claimed (`ci`) and, when approving it pins its rule's
 * ids, those ids (`pins`): it is then approved only on its own, at the person's terminal.
 */
function heldRow(h: HeldRow, session: string, rules: readonly CiRule[]): Row {
  return {
    id: h.id,
    session,
    from: h.from,
    device: h.device,
    kind: h.kind,
    at: h.at,
    preview: h.preview,
    reason: h.reason,
    ...setFields(h, rules),
    ...(h.entry.file === undefined ? {} : { file: h.entry.file }),
    ...(h.pause === undefined ? {} : { pause: h.pause }),
  };
}

/** A paused peer as a breaker hold on disk shows it: the rule and the pause's end when the hold recorded them. */
function pausedFromHold(row: Row): Row {
  const pause = row["pause"] as { rule: string; until: number; auto: boolean } | undefined;
  return { peer: row["from"], at: row["at"], ...(pause === undefined ? {} : { reason: pause.rule, until: pause.until, auto: pause.auto }) };
}

/** A join request as the UI sees it: never its comparison code, which the person types from the new device. */
type JoinRow = { name: string; id: string; invite: string; at: number; exp: number; own: boolean };

/** Refuses a person's device action in an events process an agent started. */
function personOnly(agent: string | undefined, what: string): void {
  if (agent !== undefined) throw new RequestError("refused", `${what} is the person's: this events process runs with an agent's variables (${agent})`);
}

/** Runs the events process until stdin closes or the signal aborts. */
export async function runEvents(d: EventsDeps): Promise<void> {
  const s = d.session;
  const emit = (type: string, fields: Row = {}): void => d.write(JSON.stringify({ v: EVENTS_VERSION, type, at: d.now(), ...fields }));
  const myDevice = d.device.id;

  /** Who added each device, from the verified roster chain on disk; read again when the roster moves. */
  let adders: { hash: string; map: Map<string, Adder> } = { hash: "", map: new Map() };
  /**
   * The device rows, with who added each (`added_by`, `added_by_id`). The roster is read once, and
   * the adders are read for that same roster, so a roster that moves meanwhile cannot send a row
   * out without its adder.
   */
  async function deviceRows(): Promise<Row[]> {
    const roster = s.roster;
    const h = hash(roster);
    if (adders.hash !== h) adders = { hash: h, map: await addersOf(d.mesh, roster) };
    const map = adders.map;
    // Recovery records never act (SPEC section 4a), so a UI has nothing to show or decide for them.
    return roster.devices
      .filter((dev) => !isRecoveryName(dev.name))
      .map((dev) => {
        const by = map.get(dev.id);
        return { name: dev.name, id: dev.id, role: dev.role, policy: policyLevel(s.config, dev.id), self: dev.id === myDevice, ...(by === undefined ? {} : { added_by: by.name, added_by_id: by.id }) };
      });
  }
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
  let joins = new Map<string, string>();
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

  /** The join requests waiting on this device, as the UI sees them. */
  async function joinsNow(): Promise<JoinRow[]> {
    const rows = await new PendingJoins(d.mesh, d.env).list(s.roster, new Invites(d.mesh, d.env, d.now), d.now());
    return rows.map((r) => ({ name: r.name, id: r.id, invite: r.invite, at: r.at, exp: r.exp, own: r.own }));
  }
  const joinKey = (r: Row | JoinRow): string => `${r["invite"] as string}/${r["id"] as string}`;

  /** One pass at a time (the poll and an admit), so a request is announced once. */
  let joinsQueue: Promise<void> = Promise.resolve();
  function joinsPass(): Promise<void> {
    const run = joinsQueue.then(joinsPassNow);
    joinsQueue = run.catch(() => undefined);
    return run;
  }

  async function joinsPassNow(): Promise<void> {
    const rows = await joinsNow();
    const next = remember(rows, joinKey);
    for (const r of rows) if (!joins.has(joinKey(r))) emit("join", { op: "add", request: r });
    for (const [k, text] of joins) if (!next.has(k)) emit("join", { op: "remove", request: JSON.parse(text) as Row });
    joins = next;
  }

  /**
   * The signer's decision over `ids` when this device's keys are in it (the person confirms it in
   * the signer's own terminal or dialog); undefined when they are not, and nothing changes.
   */
  async function signed(ask: Ask, verdict: DecisionVerdict, ids: readonly string[], peer?: string): Promise<Decision[] | undefined> {
    if (d.device.keyring.kind !== "signer") return undefined;
    const decide = d.decide;
    if (decide === undefined) throw new RequestError("needs_signer", `${NEEDS_SIGNER}, and this process cannot ask it`);
    // Nothing to ask the person about: an approve or refuse of ids no session holds any more.
    const held = new Set((await listAllHeld(d.mesh, d.env)).map((r) => r.id));
    if (verdict !== "resume" && !ids.some((id) => held.has(id))) throw new RequestError("not_found", `no held message ${ids[0]!}`);
    // The person may take minutes: the request gives up its turn meanwhile (ask), so other requests
    // are answered; when this process stops, the ask is dropped (stopping) and nothing is decided.
    return ask(() => decisionsFor((chunk) => decide({ mesh: s.config.mesh, verdict, ids: chunk, ...(peer === undefined ? {} : { peer }) }, stopping.signal), ids));
  }

  /** Decides one held id wherever it is held; false when nothing held it. */
  async function decideOne(id: string, verdict: Verdict, decision: Decision | undefined): Promise<boolean> {
    // This process decides its own items itself (it can send the receipt); others on disk.
    const mine = (await s.held.get(id)) !== undefined;
    if (mine) await s.decide(id, verdict, decision);
    const others = await decideHeld(d.mesh, id, verdict, d.env, d.now, s.sid, decision);
    return mine || others > 0;
  }

  /**
   * Decides the set the person was shown: exactly those ids, all from one set, checked before any
   * is decided. `decided` lists the ids this request decided; `gone` the ids it was sent that were
   * no longer held, before the loop or decided elsewhere during it; an item that arrived after the
   * UI drew the set is not in `ids`, so it stays held. Approving never covers a notice that pins its
   * rule's ids (`kept`): that one is approved on its own, at the person's terminal.
   */
  async function decideSet(ask: Ask, held: string, ids: readonly string[], verdict: Verdict): Promise<Row> {
    if (!ids.includes(held) || !ids.every(isUlid)) throw new RequestError("input", "set must be the held ids shown, held among them");
    const rules = await loadCiRules(d.mesh.ciRulesPath).catch(() => []);
    const rows = await listAllHeld(d.mesh, d.env);
    const unique = [...new Set(ids)];
    const now = unique.flatMap((id) => rows.filter((r) => r.id === id).slice(0, 1));
    // The set is the one its ids still held are in: `held` itself may have been decided elsewhere.
    const first = now.find((r) => r.id === held) ?? now[0];
    if (first === undefined) throw new RequestError("not_found", `no held message ${held}`);
    const key = setKey(first, rules);
    const stranger = now.find((r) => setKey(r, rules) !== key);
    if (stranger !== undefined) throw new RequestError("input", `${stranger.id} is not held in the same set as ${held}: each set is decided on its own`);
    const decided: string[] = [];
    const gone = unique.filter((id) => !now.some((r) => r.id === id));
    const kept = now.filter((r) => verdict === "approve" && pinsIds(r)).map((r) => r.id);
    const go = now.filter((r) => !kept.includes(r.id));
    const decisions = go.length === 0 ? undefined : await signed(ask, verdict, go.map((r) => r.id));
    for (const r of go) {
      if (await decideIfHeld(r.id, verdict, decisionFor(decisions, r.id))) decided.push(r.id);
      else gone.push(r.id);
    }
    return { decided, kept, gone };
  }

  /** decideOne, with an item decided elsewhere meanwhile (not found) as false; any other error is thrown. */
  async function decideIfHeld(id: string, verdict: Verdict, decision: Decision | undefined): Promise<boolean> {
    try {
      return await decideOne(id, verdict, decision);
    } catch (error) {
      if (error instanceof ClientError && error.code === "not_found") return false;
      throw error;
    }
  }

  /** Every held item on this device, keyed by holding session and id. */
  async function heldNow(): Promise<Map<string, { sid: string; row: Row }>> {
    const out = new Map<string, { sid: string; row: Row }>();
    const rules = await loadCiRules(d.mesh.ciRulesPath).catch(() => []);
    for (const h of await listAllHeld(d.mesh, d.env)) {
      const address = await addressOf(h.sid);
      out.set(`${h.sid}/${h.id}`, { sid: h.sid, row: heldRow(h, address, rules) });
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
    const joinRows = await joinsNow();
    joins = remember(joinRows, joinKey);
    const devs = await deviceRows();
    devices = remember(devs, (r) => r["id"] as string);
    peers = remember(rows.map(sessionRow), (r) => r["address"] as string);
    leases = remember(leaseRows, (l) => l.name);
    // Running pauses on disk count as paused peers too (from before this process started, or in
    // another session), and so do breaker holds an older client wrote without a pause file.
    for (const p of await listAllPauses(d.mesh, d.env, d.now())) {
      if (!paused.has(p.from)) paused.set(p.from, { peer: p.from, at: p.at, reason: p.rule, until: p.until, auto: p.auto });
    }
    for (const h of held.values()) {
      const peer = h.row["from"] as string;
      if (h.row["reason"] === "breaker" && !paused.has(peer)) paused.set(peer, pausedFromHold(h.row));
    }
    synced = true;
    emit("snapshot", { devices: devs, sessions: rows.map(sessionRow), rooms: roomsOf(rows), leases: leaseRows, held: heldRows, breakers: [...paused.values()], joins: joinRows });
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
      const was = held.get(k);
      // A row that changed (its CI rule was removed or pinned: its set or its title) is sent again,
      // so the UI regroups or relabels it. Every field of a row is read from disk, none is relative
      // to now, so an unchanged row compares equal from pass to pass.
      if (was !== undefined && stableJson(was.row) === stableJson(h.row)) continue;
      emit("held", { op: "add", item: h.row });
      if (was !== undefined) continue;
      // Another local session's first breaker hold for a peer shows that peer as paused there.
      // This process's own breaker reports itself, with the reason.
      const pair = `${h.sid} ${h.row["from"] as string}`;
      if (h.row["reason"] === "breaker" && h.sid !== s.sid && !pausedIn.has(pair)) {
        pausedIn.add(pair);
        const { at: _at, ...row } = pausedFromHold(h.row);
        breaker({ ...row, state: "tripped" });
      }
    }
    for (const [k, h] of held) if (!next.has(k)) emit("held", { op: "remove", item: h.row });
    held = next;
  }

  async function poll(): Promise<void> {
    await follow(false);
    await heldPass();
    await joinsPass();
    devices = diff("device", await deviceRows(), (r) => r["id"] as string, devices, deviceGone);
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
  async function run(op: Op, a: any, ask: Ask): Promise<Row> {
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
        personOnly(d.agent, op === "approve" ? "approving a held message" : "refusing a held message");
        const i = a as { held: string; set?: string[] };
        if (!isUlid(i.held)) throw new RequestError("input", "held must be a held message id");
        const verdict = op === "approve" ? "approve" : "refuse";
        if (i.set !== undefined) return decideSet(ask, i.held, i.set, verdict);
        if (!(await decideOne(i.held, verdict, decisionFor(await signed(ask, verdict, [i.held]), i.held)))) throw new RequestError("not_found", `no held message ${i.held}`);
        return {};
      }
      case "trust":
      case "untrust": {
        personOnly(d.agent, "changing a device's trust");
        const name = (a as { device: string }).device;
        const target = s.roster.devices.find((x) => x.name === name);
        if (target === undefined) throw new RequestError("not_found", `no device named ${sanitizeForDisplay(name)}`);
        const policy = await setDevicePolicy(d.mesh, target.id, trustLevel(op, (a as { relayed?: boolean }).relayed === true));
        s.config = await d.mesh.loadConfig();
        devices = diff("device", await deviceRows(), (r) => r["id"] as string, devices, deviceGone);
        return { policy };
      }
      case "resume": {
        personOnly(d.agent, "releasing what the loop breaker held");
        const peer = (a as { peer: string }).peer;
        // What the pause holds now, for the signer to show: a resume releases only those.
        const device = peer.split("@")[1];
        const paused = (await listAllHeld(d.mesh, d.env)).filter((r) => r.reason === "breaker" && r.from.split("@")[1] === device).map((r) => r.id);
        // More than one decision takes holds in chunks; without a signer, one resume with none.
        let released = 0;
        for (const decision of (await signed(ask, "resume", [...new Set(paused)], peer)) ?? [undefined]) {
          released += (await s.resumePeer(peer, decision)) + (await resumeEverywhere(d.mesh, peer, d.env, d.now, s.sid, decision));
        }
        return { released };
      }
      case "invite": {
        personOnly(d.agent, "inviting a device");
        // Never `auto`: a UI's invite is always admitted by the person, with the code they type.
        // `own` is the person's answer in the UI's own dialog, kept in the record, never in the code.
        const i = a as z.infer<typeof Args.invite>;
        const made = await issueInvite(s, { ttlMs: i.exp ?? 3_600_000, auto: false, own: i.own === true, now: d.now, short: true });
        // With a short code, `code` is it and `exp` its end; `full` is the full code, for older devices.
        if (made.short === undefined) return { code: made.code, invite: made.inviteId, exp: made.exp };
        return { code: made.short.code, invite: made.inviteId, exp: made.short.exp, full: made.code };
      }
      case "admit": {
        personOnly(d.agent, "admitting a device");
        const i = a as z.infer<typeof Args.admit>;
        const decision = await admitPending(s, i.device, i.code, d.now);
        if (decision.outcome !== "admitted") throw new RequestError("refused", `could not admit ${sanitizeForDisplay(i.device)}: ${decision.reason!}`);
        await joinsPass();
        devices = diff("device", await deviceRows(), (r) => r["id"] as string, devices, deviceGone);
        // `trusted`: an own-device invite set `deliver` for it (the UI says how to undo that).
        return { device: i.device, trusted: decision.trusted === true };
      }
    }
  }

  async function handle(line: string, ask: Ask): Promise<void> {
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
      const result = await run(op, args.data as never, ask);
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
  joins = remember(await joinsNow(), joinKey);
  // Devices are part of the first snapshot, not changes before it: the baseline carries who added
  // each, so the first poll does not report every device as changed.
  devices = remember(await deviceRows(), (r) => r["id"] as string);
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

  /** Aborted once this process stops (stdin closed or the signal): asks still open are dropped. */
  const stopping = new AbortController();
  // Requests are answered in order, one at a time; a request waiting for the person in the signer
  // gives up its turn meanwhile (ask), and takes the next free turn for what it does after.
  let queue: Promise<void> = Promise.resolve();
  const inflight = new Set<Promise<void>>();
  /** The next turn: resolves once every earlier turn ended, with the function that ends this one. */
  const turn = (): Promise<() => void> => {
    let end!: () => void;
    const ended = new Promise<void>((resolve) => (end = resolve));
    const mine = queue.then(() => end);
    queue = queue.then(() => ended);
    return mine;
  };
  const lines = createInterface({ input: d.input });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    const job = turn().then(async (first) => {
      let end = first;
      const ask: Ask = async (fn) => {
        end();
        try {
          return await fn();
        } finally {
          end = await turn();
        }
      };
      try {
        await handle(line, ask);
      } finally {
        end();
      }
    });
    inflight.add(job);
    void job.then(() => inflight.delete(job));
  });
  const ended = new Promise<void>((resolve) => lines.once("close", resolve));
  const aborted = new Promise<void>((resolve) => (d.signal.aborted ? resolve() : d.signal.addEventListener("abort", () => resolve(), { once: true })));
  await Promise.race([ended, aborted]);
  // Asks still waiting for the person are dropped, so the requests in flight end now.
  stopping.abort();
  clearInterval(tick);
  clearInterval(leaseTick);
  lines.close();
  await Promise.all(inflight);
}

export type SetupDeps = {
  home: Home;
  /** The name a new device takes when the request names none (the CLI's, from the host name). */
  defaultName: string;
  dialer: Dialer;
  version: string;
  write: (line: string) => void;
  input: Readable;
  signal: AbortSignal;
  now: () => number;
  agent?: string;
  /** Reads a short invite code's box from its relay (`fetch`). */
  fetch: BoxFetcher;
  /** Where `wim recovery show` finds a held recovery code (secretout.ts `showPaths`). */
  platform: Platform;
  /** How long a new mesh's recovery code waits for `wim recovery show` (tests shorten it). */
  recoveryMs?: number;
};

const SetupArgs = z.object({ code: z.string().min(1).max(16 * 1024), name: z.string().optional() });
const CreateArgs = z.object({ name: z.string().optional(), relay: z.string().min(1).max(2048).optional() });
/** The client's own words for a relay that refuses a new mesh (cli.ts `createHere`); the relay's text is not repeated. */
const CREATE_REFUSED: Record<string, string> = {
  full: "the relay refused to create the mesh: it has reached its limit of new meshes. Choose another relay, or run your own (packages/relay-node)",
  unauthorized: "the relay refused to create the mesh: it is not accepting new meshes, or it needs an operator key, which only wim mesh create --key-env NAME in a terminal can pass",
};

/**
 * `wim events --json` on a device in no mesh yet (docs/events.md, setup mode): a `setup` event
 * instead of `hello`, and two requests. `join` is answered once the comparison code is known; the
 * outcome follows as a `joined` or `join_failed` event. `create` makes a mesh with this device as
 * its admin and holds the recovery code for `wim recovery show`, which the person runs in a
 * terminal of their own; `created` follows when the hold ends. After `joined` or `created` the
 * process ends, and the UI starts it again, now in the mesh.
 */
export async function runSetupEvents(d: SetupDeps): Promise<void> {
  const emit = (type: string, fields: Row = {}): void => d.write(JSON.stringify({ v: EVENTS_VERSION, type, at: d.now(), ...fields }));
  const known = await d.home.loadDevice();
  emit("setup", { version: d.version, device: known === undefined ? null : { name: known.name, id: known.id } });
  let joining = false;
  /** Set once a `create` starts, and never cleared after it made a mesh: this device is then in one. */
  let creating = false;
  /** A `create` under way, until its answer is written; stdin closing does not cut it short. */
  let making: Promise<unknown> | undefined;
  /** A recovery code's hold: the process ends only after it, even when stdin closes first. */
  let holding: Promise<void> | undefined;
  /** Run once the current request's answer is written. */
  let afterResponse: (() => void) | undefined;
  let finish!: () => void;
  const joined = new Promise<void>((resolve) => (finish = resolve));

  /** `create`: a mesh on `relay` (the hosted one by default), its recovery code held for `wim recovery show`. */
  async function create(a: z.infer<typeof CreateArgs>): Promise<Row> {
    personOnly(d.agent, "creating a mesh");
    if (joining || creating) throw new RequestError("busy", joining ? "a join is already waiting for an admin" : "a mesh is already being created on this device");
    const relay = a.relay ?? HOSTED_RELAY;
    creating = true;
    let made: { mesh: string; recoveryCode?: string } | undefined;
    try {
      // Checked before any key is made, so a wrong URL or name leaves no device behind.
      try {
        checkDialable(relay, undefined);
      } catch (error) {
        throw new RequestError("input", (error as Error).message);
      }
      const known = await d.home.loadDevice();
      const name = a.name ?? d.defaultName;
      if (known === undefined && !isName(name)) throw new RequestError("input", `invalid device name ${JSON.stringify(name)}: use 1 to 32 of a-z, 0-9 and -`);
      const device = known ?? (await d.home.createDevice(name));
      made = await createMesh({ home: d.home, device, relay, dialer: d.dialer, now: d.now }).catch((error: unknown) => {
        const own = error instanceof ClientError ? CREATE_REFUSED[error.code] : undefined;
        throw own === undefined ? error : new RequestError((error as ClientError).code, own);
      });
      const result = { device: { name: device.name, id: device.id }, mesh: `${made.mesh.slice(0, 4)}…`, relay: relayHost(relay) };
      // Answered once the code waits for `wim recovery show`, so the UI can open that terminal.
      const code = made.recoveryCode!;
      // Stopped while the mesh was made: nothing can collect the code now.
      if (d.signal.aborted) {
        emit("created", { mesh: result.mesh, recovery: "not_collected" });
        finish();
        return result;
      }
      return await new Promise<Row>((resolve, reject) => {
        holding = holdForShow(showPaths(d.home.root, d.platform), code, {
          ms: d.recoveryMs ?? LIMITS.recoveryShowWindowMs,
          signal: d.signal,
          platform: d.platform,
          onListening: () => resolve(result),
        }).then(
          (handed) => {
            emit("created", { mesh: result.mesh, recovery: handed ? "shown" : "not_collected" });
            finish();
          },
          (error: unknown) => {
            // Nothing holds the code: the mesh exists and its code is gone. The process ends
            // once this answer is written, as after `created`.
            afterResponse = finish;
            reject(new RequestError("error", `the mesh was created, but its recovery code could not be held for wim recovery show (${(error as Error).message}). Run wim recovery rotate in a terminal of your own for a new one`));
          },
        );
      });
    } catch (error) {
      // After a mesh was made, `creating` stays set: this device is in it now.
      if (made === undefined) creating = false;
      throw error;
    }
  }

  async function join(a: z.infer<typeof SetupArgs>): Promise<Row> {
    personOnly(d.agent, "joining a mesh");
    if (joining || creating) throw new RequestError("busy", joining ? "a join is already waiting for an admin" : "a mesh is being created on this device");
    // Read before any key is made, so a mistyped code leaves no device behind. A short code is
    // resolved through its relay (which counts the lookup), then read as a full one.
    joining = true;
    try {
      const code = await resolveInvite(a.code, d.fetch).catch((error: unknown) => {
        throw error instanceof SetupError ? new RequestError("input", error.message) : error;
      });
      try {
        parseInvite(code);
      } catch {
        throw new RequestError("input", "not an invite code (wim1_... or wim2-...)");
      }
      const device = (await d.home.loadDevice()) ?? (await d.home.createDevice(a.name ?? d.defaultName));
      return await new Promise<Row>((resolve, reject) => {
        let answered = false;
        joinMesh({
          home: d.home,
          device,
          code,
          dialer: d.dialer,
          now: d.now,
          showSas: (sas) => {
            answered = true;
            resolve({ device: { name: device.name, id: device.id }, code: sas });
          },
        }).then(
          async (done) => {
            const map = await addersOf(new MeshFiles(d.home.meshDir(done.mesh), d.home.env), done.roster);
            // `admitted_by`: the device whose approval this join was, the one a UI asks about first:
            // only when the invite code names it as the invite's maker. Otherwise `admitted_other`
            // names the device that admitted this one, which a UI asks about like any other.
            const { admitter, approver } = joinApproval(map, device.id, done.issuer);
            const others = done.roster.devices
              .filter((x) => x.id !== device.id && !isRecoveryName(x.name))
              .map((x) => {
                const adder = map.get(x.id);
                return { name: x.name, id: x.id, ...(adder === undefined ? {} : { added_by: adder.name, added_by_id: adder.id }) };
              });
            emit("joined", {
              mesh: `${done.mesh.slice(0, 4)}…`,
              ...(approver === undefined ? {} : { admitted_by: { name: approver.name, id: approver.id } }),
              ...(admitter === undefined || approver !== undefined ? {} : { admitted_other: { name: admitter.name, id: admitter.id, reason: done.issuer === undefined ? "no_issuer" : "not_issuer" } }),
              devices: others,
            });
            finish();
          },
          (error: unknown) => {
            joining = false;
            if (!answered) return reject(error);
            emit("join_failed", { message: sanitizeForDisplay((error as Error).message) });
          },
        );
      });
    } catch (error) {
      joining = false;
      throw error;
    }
  }

  async function handle(line: string): Promise<void> {
    let id: string | undefined;
    try {
      const raw = (() => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          throw new RequestError("input", "not JSON");
        }
      })();
      const req = Request.safeParse(raw);
      if (!req.success) throw new RequestError("input", "a request is { v: 1, id, op, args? }");
      id = req.data.id;
      const op = req.data.op;
      if (op !== "join" && op !== "create") throw new RequestError("setup", "this device is in no mesh yet: create or join one first");
      const args = (op === "join" ? SetupArgs : CreateArgs).safeParse(req.data.args ?? {});
      if (!args.success) throw new RequestError("input", args.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      const answer = op === "join" ? join(args.data as z.infer<typeof SetupArgs>) : (making = create(args.data));
      emit("response", { id, ok: true, result: await answer });
    } catch (error) {
      // The client's own errors before the code was shown (a dial that failed, the device already in that mesh) are `error`.
      const code = error instanceof RequestError ? error.code : "error";
      emit("response", { ...(id === undefined ? {} : { id }), ok: false, error: { code, message: sanitizeForDisplay((error as Error).message) } });
    }
    afterResponse?.();
  }

  let queue = Promise.resolve();
  const lines = createInterface({ input: d.input });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    queue = queue.then(() => handle(line));
  });
  const ended = new Promise<void>((resolve) => lines.once("close", resolve));
  const aborted = new Promise<void>((resolve) => (d.signal.aborted ? resolve() : d.signal.addEventListener("abort", () => resolve(), { once: true })));
  await Promise.race([ended, aborted, joined]);
  lines.close();
  // A mesh being made, and then its held recovery code, outlive stdin: only `wim recovery show`,
  // the code's window or the signal ends them.
  await making?.catch(() => undefined);
  await holding;
}
