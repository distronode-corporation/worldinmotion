// The extension's model of the mesh: a pure store fed by `wim events` lines, with the queries
// the views need. No `vscode` import, so all of it runs under plain tests.

import { deviceOf, duration, nameOf, oneLine, visible } from "./display.ts";
import type {
  BreakerReason,
  BreakerRow,
  DeviceRow,
  HeldRow,
  JoinRow,
  KeysAt,
  LeaseRow,
  MessageRow,
  ReceiptStatus,
  SessionRow,
  WimEvent,
} from "./protocol.ts";

/** A breaker pause lapses after an hour, and the client does not report that (docs/events.md). */
export const PAUSE_MS = 60 * 60 * 1000;
export const MESSAGE_CAP = 1000;
export const RECEIPT_CAP = 2000;
/** Timeline rows show the start of a message; the thread shows all of it. */
export const TEXT_CHARS = 300;

/**
 * The key of a held row: each local session holds its own copy of a message, so one message
 * held by two sessions is two rows, and deciding one copy leaves the other.
 */
export function heldKey(h: { session: string; id: string }): string {
  return `${h.session}\n${h.id}`;
}

/** The key of a waiting join request: one device on one invite. */
export function joinKey(j: { invite: string; id: string }): string {
  return `${j.invite}/${j.id}`;
}

export type ConnectionState = "starting" | "connecting" | "open" | "closed";
export type Hello = { version: string; device: { name: string; id: string }; keys?: KeysAt; session: string; relay: string; mesh: string };
export type Receipt = { to: string; status: ReceiptStatus; at: number };

export class Store {
  hello: Hello | undefined;
  connection: { state: ConnectionState; detail?: string } = { state: "starting" };
  readonly devices = new Map<string, DeviceRow>();
  readonly sessions = new Map<string, SessionRow>();
  readonly rooms = new Map<string, string[]>();
  readonly leases = new Map<string, LeaseRow>();
  /** Held rows by `heldKey`. */
  readonly held = new Map<string, HeldRow>();
  readonly breakers = new Map<string, BreakerRow>();
  readonly receipts = new Map<string, Receipt[]>();
  /** Devices waiting to join, by `invite/id` (an admin device only). */
  readonly joins = new Map<string, JoinRow>();
  /** Set while the events process runs in setup mode: this device is in no mesh yet. */
  setup: { device?: { name: string; id: string } } | undefined;
  messages: MessageRow[] = [];
  unread = 0;
  private readonly seen = new Set<string>();
  private readonly listeners = new Set<(ev: WimEvent | undefined) => void>();

  /** Calls `fn` after every change, with the event that caused it (undefined for a local change). */
  onChange(fn: (ev: WimEvent | undefined) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(ev?: WimEvent): void {
    for (const fn of this.listeners) fn(ev);
  }

  /** This process's own session address, once `hello` has arrived. */
  get self(): string | undefined {
    return this.hello?.session;
  }

  /** A new events process is starting: nothing from the previous one still holds. */
  reset(): void {
    this.hello = undefined;
    this.setup = undefined;
    this.connection = { state: "starting" };
    for (const m of [this.devices, this.sessions, this.rooms, this.leases, this.held, this.breakers, this.receipts, this.joins]) m.clear();
    this.messages = [];
    this.seen.clear();
    this.unread = 0;
    this.changed();
  }

  /** The events process exited; the views keep what they had, marked as closed. */
  exited(detail: string): void {
    this.connection = { state: "closed", detail };
    this.changed();
  }

  apply(ev: WimEvent): void {
    switch (ev.type) {
      case "hello":
        this.hello = { version: ev.version, device: ev.device, ...(ev.keys === undefined ? {} : { keys: ev.keys }), session: ev.session, relay: ev.relay, mesh: ev.mesh };
        break;
      case "connection":
        this.connection = ev.detail === undefined ? { state: ev.state } : { state: ev.state, detail: ev.detail };
        break;
      case "snapshot":
        this.replace(this.devices, ev.devices, (d) => d.name);
        this.replace(this.sessions, ev.sessions, (s) => s.address);
        this.rooms.clear();
        for (const r of ev.rooms) this.rooms.set(r.name, [...r.members]);
        this.replace(this.leases, ev.leases, (l) => l.name);
        this.replace(this.held, ev.held, heldKey);
        this.replace(this.breakers, ev.breakers, (b) => b.peer);
        this.replace(this.joins, ev.joins, joinKey);
        break;
      case "join":
        if (ev.op === "add") this.joins.set(joinKey(ev.request), ev.request);
        else this.joins.delete(joinKey(ev.request));
        break;
      case "setup":
        this.setup = ev.device === undefined ? {} : { device: ev.device };
        break;
      case "device":
        this.devices.set(ev.device.name, ev.device);
        break;
      case "device-removed":
        this.devices.delete(ev.name);
        break;
      case "peer":
        this.sessions.set(ev.session.address, ev.session);
        this.placeInRooms(ev.session.address, ev.session.rooms);
        break;
      case "peer-removed":
        this.sessions.delete(ev.address);
        this.placeInRooms(ev.address, []);
        break;
      case "message":
        if (this.add(ev.message) && ev.message.dir === "in" && ev.message.session === this.self) this.unread += 1;
        break;
      case "receipt": {
        const list = this.receipts.get(ev.id) ?? [];
        list.push({ to: ev.to, status: ev.status, at: ev.at });
        this.receipts.set(ev.id, list);
        if (this.receipts.size > RECEIPT_CAP) this.receipts.delete(this.receipts.keys().next().value!);
        break;
      }
      case "held":
        if (ev.op === "add") this.held.set(heldKey(ev.item), ev.item);
        else this.held.delete(heldKey(ev.item));
        break;
      case "lease":
        this.leases.set(ev.lease.name, ev.lease);
        break;
      case "lease-released":
        this.leases.delete(ev.name);
        break;
      case "breaker":
        if (ev.state === "tripped") this.breakers.set(ev.peer, ev.reason === undefined ? { peer: ev.peer, at: ev.at } : { peer: ev.peer, reason: ev.reason, at: ev.at });
        else this.breakers.delete(ev.peer);
        break;
    }
    this.changed(ev);
  }

  private replace<T>(map: Map<string, T>, rows: T[], key: (row: T) => string): void {
    map.clear();
    for (const row of rows) map.set(key(row), row);
  }

  /** Keeps the room lists in step with one session's `rooms`, dropping rooms left empty. */
  private placeInRooms(address: string, rooms: string[]): void {
    for (const [name, members] of this.rooms) {
      const rest = members.filter((m) => m !== address);
      if (rest.length === 0) this.rooms.delete(name);
      else this.rooms.set(name, rest);
    }
    for (const name of rooms) this.rooms.set(name, [...(this.rooms.get(name) ?? []), address]);
  }

  /** Adds a message unless this session already has it; keeps the newest MESSAGE_CAP. */
  private add(m: MessageRow): boolean {
    const key = `${m.session}\n${m.id}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    let i = this.messages.length;
    while (i > 0 && this.messages[i - 1]!.at > m.at) i -= 1;
    this.messages.splice(i, 0, m);
    while (this.messages.length > MESSAGE_CAP) {
      const old = this.messages.shift()!;
      this.seen.delete(`${old.session}\n${old.id}`);
    }
    return true;
  }

  /** Merges the answer to a `history` request. Past messages do not count as unread. */
  addHistory(messages: MessageRow[]): void {
    for (const m of messages) this.add(m);
    this.changed();
  }

  markRead(): void {
    if (this.unread === 0) return;
    this.unread = 0;
    this.changed();
  }

  /** The breaker pause on `peer`, unless it has lapsed. */
  pause(peer: string, now: number): { reason?: BreakerReason; at: number } | undefined {
    const b = this.breakers.get(peer);
    return b !== undefined && now < b.at + PAUSE_MS ? b : undefined;
  }

  /** Device names for the Mesh tree: the roster, plus any device a session names but the roster lacks. */
  deviceNames(): string[] {
    const names = new Set(this.devices.keys());
    for (const address of this.sessions.keys()) names.add(deviceOf(address));
    return [...names].sort(selfFirst(this.hello?.device.name));
  }

  sessionsOn(device: string): SessionRow[] {
    return [...this.sessions.values()].filter((s) => deviceOf(s.address) === device).sort((a, b) => a.address.localeCompare(b.address));
  }

  /** What the person can send to: live sessions other than this one, then rooms. */
  targets(): { target: string; detail: string }[] {
    const live = [...this.sessions.values()]
      .filter((s) => s.status !== "offline" && s.address !== this.self)
      .sort((a, b) => a.address.localeCompare(b.address))
      .map((s) => ({ target: s.address, detail: [s.kind, s.status, s.card?.branch].filter((x) => x !== undefined).join(", ") }));
    const rooms = [...this.rooms.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, members]) => ({ target: name, detail: `${members.length} ${members.length === 1 ? "member" : "members"}` }));
    return [...live, ...rooms];
  }

  /** Every peer a thread can be opened with: sessions, rooms and anyone in recent messages. */
  threadPeers(): string[] {
    const peers = new Set<string>();
    for (const s of this.sessions.keys()) if (s !== this.self) peers.add(s);
    for (const r of this.rooms.keys()) peers.add(r);
    for (const m of this.messages) for (const p of counterparts(m)) peers.add(p);
    return [...peers].sort();
  }

  /** Delivery receipts for an outgoing message, with the latency each one allows. */
  latency(m: MessageRow): { to: string; status: ReceiptStatus; ms: number }[] {
    return (this.receipts.get(m.id) ?? []).map((r) => ({ to: r.to, status: r.status, ms: Math.max(0, r.at - m.at) }));
  }
}

/** Sorts device names with this device first, then by name. */
export function selfFirst(self: string | undefined): (a: string, b: string) => number {
  const rank = (d: string): number => Number(d !== self);
  return (a, b) => rank(a) - rank(b) || a.localeCompare(b);
}

/**
 * The message to tell the person about, if `ev` is one: an incoming message for this window's own
 * session, and with `claudeTabs` also one for any Claude Code session on this device (a tab's
 * address is `<folder>@<device>`, so the person learns which tab it went to).
 */
export function toNotify(store: Store, ev: WimEvent, claudeTabs = false): MessageRow | undefined {
  if (ev.type !== "message" || ev.message.dir !== "in") return undefined;
  const m = ev.message;
  if (m.session === store.self) return m;
  const tab = store.sessions.get(m.session);
  return claudeTabs && tab?.local === true && tab.kind === "claude-code" ? m : undefined;
}

/** The other side of a message: its sender, or its recipients. */
export function counterparts(m: MessageRow): string[] {
  if (m.dir === "in") return [m.peer];
  return m.to ?? m.peer.split(",").filter((p) => p !== "");
}

export type TimelineRow = {
  key: string;
  time: string;
  from: string;
  to: string;
  kind: string;
  badges: string[];
  status: string;
  text: string;
  /** What a click opens: the thread with this peer, as seen from this local session. */
  peer: string;
  session: string;
};

/** Newest first, at most `limit` rows, peer text escaped; the webview sets each as textContent. */
export function timeline(store: Store, limit: number, clock: (at: number) => string): TimelineRow[] {
  return store.messages
    .slice(-limit)
    .reverse()
    .map((m) => {
      const others = counterparts(m);
      const receipts = m.dir === "out" ? store.latency(m) : [];
      const status = receipts.length > 0 ? receipts.map((r) => `${r.status} in ${duration(r.ms)}`).join(", ") : (m.status ?? "");
      return {
        key: `${m.session}\n${m.id}`,
        time: clock(m.at),
        from: visible(m.dir === "in" ? m.peer : m.session),
        to: visible(m.dir === "in" ? m.session : others.join(", ")),
        kind: m.kind,
        badges: [m.relayed && "relayed", m.derived && "derived", m.unsolicited && "unsolicited"].filter((b): b is string => typeof b === "string"),
        status: visible(status),
        text: oneLine(m.file === undefined ? m.text : `${m.file.name} (${m.file.size} bytes)`, TEXT_CHARS),
        peer: others[0] ?? "",
        session: m.session,
      };
    });
}

export type Edge = { from: string; to: string; count: number };

/**
 * Message counts between sessions over the last `windowMs`. A message seen by two local
 * sessions (sent by one, received by the other) counts once.
 */
export function edges(store: Store, now: number, windowMs: number): Edge[] {
  const counted = new Set<string>();
  const counts = new Map<string, Edge>();
  for (const m of store.messages) {
    if (m.at < now - windowMs || m.at > now) continue;
    const pairs = m.dir === "in" ? [[m.peer, m.session] as const] : counterparts(m).map((p) => [m.session, p] as const);
    for (const [from, to] of pairs) {
      const once = `${m.id}\n${from}\n${to}`;
      if (counted.has(once)) continue;
      counted.add(once);
      const key = `${from}\n${to}`;
      const edge = counts.get(key) ?? { from, to, count: 0 };
      edge.count += 1;
      counts.set(key, edge);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/** Graph nodes grouped by device: every session that is online or on an edge. Rooms group as `#`. */
export function groups(store: Store, list: Edge[]): { device: string; nodes: string[] }[] {
  const nodes = new Set<string>();
  for (const s of store.sessions.values()) if (s.status !== "offline") nodes.add(s.address);
  for (const e of list) {
    nodes.add(e.from);
    nodes.add(e.to);
  }
  const byDevice = new Map<string, string[]>();
  for (const n of nodes) {
    const device = n.startsWith("#") ? "#" : deviceOf(n);
    byDevice.set(device, [...(byDevice.get(device) ?? []), n]);
  }
  const order = selfFirst(store.hello?.device.name);
  return [...byDevice.entries()]
    .sort(([a], [b]) => order(a, b))
    .map(([device, list]) => ({ device, nodes: list.sort((a, b) => nameOf(a).localeCompare(nameOf(b))) }));
}
