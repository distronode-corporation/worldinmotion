// The four tree views: Mesh (devices, then their sessions), Rooms, Leases and Held. Every label,
// description and tooltip is a plain string; peer text goes through `oneLine` or `visible` and
// `noIcons`, so it is never read as Markdown, a link or an icon.

import * as vscode from "vscode";
import { deviceOf, duration, nameOf, noIcons, oneLine, size, stamp, visible } from "./display.ts";
import type { Policy } from "./protocol.ts";
import { heldKey, type Store } from "./state.ts";

export type DeviceNode = { kind: "device"; name: string };
export type SessionNode = { kind: "session"; address: string };
export type RoomNode = { kind: "room"; name: string };
export type MemberNode = { kind: "member"; room: string; address: string };
export type LeaseNode = { kind: "lease"; name: string };
export type HeldNode = { kind: "held"; session: string; id: string };
export type Node = DeviceNode | SessionNode | RoomNode | MemberNode | LeaseNode | HeldNode;

/**
 * Every node handed to VS Code comes from here, and the same key always gives the same object.
 * A command that acts for the person accepts only nodes from this set, so another extension
 * cannot invent one by passing a look-alike object to `executeCommand`.
 */
export class Nodes {
  private readonly byKey = new Map<string, Node>();
  private readonly issued = new WeakSet<object>();

  private get<N extends Node>(key: string, make: () => N): N {
    let n = this.byKey.get(key);
    if (n === undefined) {
      n = make();
      this.byKey.set(key, n);
      this.issued.add(n);
    }
    return n as N;
  }

  device(name: string): DeviceNode {
    return this.get(`d\n${name}`, () => ({ kind: "device", name }));
  }
  session(address: string): SessionNode {
    return this.get(`s\n${address}`, () => ({ kind: "session", address }));
  }
  room(name: string): RoomNode {
    return this.get(`r\n${name}`, () => ({ kind: "room", name }));
  }
  member(room: string, address: string): MemberNode {
    return this.get(`m\n${room}\n${address}`, () => ({ kind: "member", room, address }));
  }
  lease(name: string): LeaseNode {
    return this.get(`l\n${name}`, () => ({ kind: "lease", name }));
  }
  /** A held row: one message held by two local sessions is two rows. */
  held(session: string, id: string): HeldNode {
    return this.get(`h\n${heldKey({ session, id })}`, () => ({ kind: "held", session, id }));
  }

  /** `x` if it is a node this extension issued with the given kind. */
  ours<K extends Node["kind"]>(x: unknown, kind: K): Extract<Node, { kind: K }> | undefined {
    return typeof x === "object" && x !== null && this.issued.has(x) && (x as Node).kind === kind ? (x as Extract<Node, { kind: K }>) : undefined;
  }
}

export const POLICY_LABEL: Record<Policy, string> = {
  deliver: "trusted",
  "deliver-relayed": "trusted, relayed text too",
  hold: "held for you",
  refuse: "refused",
};

const POLICY_ICON: Record<Policy, string> = {
  deliver: "pass",
  "deliver-relayed": "pass-filled",
  hold: "inbox",
  refuse: "circle-slash",
};

/** A plain-string tooltip, with icon syntax broken in case a hover renders it. */
function lines(...parts: (string | undefined)[]): string {
  return noIcons(parts.filter((p) => p !== undefined).join("\n"));
}

/** One provider per view; `refresh` redraws it from the store. */
abstract class View implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  protected readonly store: Store;
  protected readonly nodes: Nodes;
  protected readonly now: () => number;

  constructor(store: Store, nodes: Nodes, now: () => number) {
    this.store = store;
    this.nodes = nodes;
    this.now = now;
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  abstract getChildren(node?: Node): Node[];
  abstract getTreeItem(node: Node): vscode.TreeItem;

  getParent(_node: Node): Node | undefined {
    return undefined;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

export class MeshView extends View {
  getChildren(node?: Node): Node[] {
    if (node === undefined) return this.store.deviceNames().map((d) => this.nodes.device(d));
    if (node.kind === "device") return this.store.sessionsOn(node.name).map((s) => this.nodes.session(s.address));
    return [];
  }

  override getParent(node: Node): Node | undefined {
    return node.kind === "session" ? this.nodes.device(deviceOf(node.address)) : undefined;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node.kind === "device" ? this.deviceItem(node) : this.sessionItem(node as SessionNode);
  }

  private deviceItem(node: DeviceNode): vscode.TreeItem {
    const row = this.store.devices.get(node.name);
    const item = new vscode.TreeItem(noIcons(oneLine(node.name, 64)), vscode.TreeItemCollapsibleState.Expanded);
    item.id = `device:${node.name}`;
    if (row === undefined) {
      item.description = "not in the roster";
      item.iconPath = new vscode.ThemeIcon("question");
      item.contextValue = "device.unknown";
      item.tooltip = lines(`Device ${visible(node.name)}`, "Sessions name this device, but the roster you hold does not list it.");
      return item;
    }
    const parts = [row.self ? "this device" : POLICY_LABEL[row.policy], row.role === "admin" ? "admin" : undefined];
    item.description = parts.filter((p) => p !== undefined).join(", ");
    item.iconPath = new vscode.ThemeIcon(row.self ? "vm" : POLICY_ICON[row.policy]);
    item.contextValue = row.self ? "device.self" : "device";
    item.tooltip = lines(
      `Device ${visible(row.name)}${row.self ? " (this device)" : ""}`,
      `Role: ${row.role}`,
      row.self ? undefined : `Inbound policy: ${row.policy} (${POLICY_LABEL[row.policy]})`,
      `Id: ${visible(row.id)}`,
    );
    return item;
  }

  private sessionItem(node: SessionNode): vscode.TreeItem {
    const s = this.store.sessions.get(node.address);
    const item = new vscode.TreeItem(noIcons(oneLine(nameOf(node.address), 64)), vscode.TreeItemCollapsibleState.None);
    item.id = `session:${node.address}`;
    item.command = { command: "worldinmotion.openThread", title: "Open Thread", arguments: [node] };
    if (s === undefined) {
      item.description = "gone";
      item.iconPath = new vscode.ThemeIcon("circle-outline");
      item.contextValue = "session";
      return item;
    }
    const pause = this.store.pause(s.address, this.now());
    const self = s.address === this.store.self;
    const where = [s.card?.cwd, s.card?.branch].filter((x) => x !== undefined && x !== "").map((x) => oneLine(x!, 80));
    item.description = noIcons([pause === undefined ? undefined : "paused", self ? "this window" : undefined, ...where].filter((x) => x !== undefined).join(" · "));
    item.iconPath =
      pause !== undefined
        ? new vscode.ThemeIcon("debug-pause", new vscode.ThemeColor("list.warningForeground"))
        : s.status === "idle"
          ? new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("testing.iconPassed"))
          : s.status === "busy"
            ? new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.yellow"))
            : new vscode.ThemeIcon("circle-outline", new vscode.ThemeColor("disabledForeground"));
    item.contextValue = pause === undefined ? "session" : "session.paused";
    item.tooltip = lines(
      visible(s.address),
      `Kind: ${visible(s.kind)}`,
      `Status: ${s.status} since ${stamp(s.since)}`,
      s.rooms.length > 0 ? `Rooms: ${s.rooms.map(visible).join(", ")}` : undefined,
      s.card?.title === undefined ? undefined : `Title: ${visible(s.card.title)}`,
      s.card?.cwd === undefined ? undefined : `Directory: ${visible(s.card.cwd)}`,
      s.card?.branch === undefined ? undefined : `Branch: ${visible(s.card.branch)}`,
      pause === undefined ? undefined : `Paused by the breaker${pause.reason === undefined ? "" : ` (${pause.reason})`} at ${stamp(pause.at)}`,
    );
    return item;
  }
}

export class RoomsView extends View {
  getChildren(node?: Node): Node[] {
    if (node === undefined) return [...this.store.rooms.keys()].sort().map((r) => this.nodes.room(r));
    if (node.kind === "room") return [...(this.store.rooms.get(node.name) ?? [])].sort().map((a) => this.nodes.member(node.name, a));
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "room") {
      const members = this.store.rooms.get(node.name) ?? [];
      const item = new vscode.TreeItem(noIcons(oneLine(node.name, 64)), vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `room:${node.name}`;
      item.description = `${members.length} ${members.length === 1 ? "member" : "members"}`;
      item.iconPath = new vscode.ThemeIcon("comment-discussion");
      item.contextValue = "room";
      item.command = { command: "worldinmotion.openThread", title: "Open Thread", arguments: [node] };
      return item;
    }
    const m = node as MemberNode;
    const s = this.store.sessions.get(m.address);
    const item = new vscode.TreeItem(noIcons(oneLine(m.address, 80)), vscode.TreeItemCollapsibleState.None);
    item.id = `member:${m.room}:${m.address}`;
    item.description = s?.status ?? "";
    item.iconPath = new vscode.ThemeIcon("account");
    item.contextValue = "member";
    return item;
  }
}

export class LeasesView extends View {
  getChildren(node?: Node): Node[] {
    if (node !== undefined) return [];
    return [...this.store.leases.keys()].sort().map((l) => this.nodes.lease(l));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const name = (node as LeaseNode).name;
    const l = this.store.leases.get(name);
    const item = new vscode.TreeItem(noIcons(oneLine(name, 64)), vscode.TreeItemCollapsibleState.None);
    item.id = `lease:${name}`;
    item.iconPath = new vscode.ThemeIcon("lock");
    item.contextValue = "lease";
    if (l === undefined) return item;
    const left = l.expires_at - this.now();
    item.description = noIcons(`${oneLine(l.holder, 64)}, ${left > 0 ? `${duration(left)} left` : "expired"}`);
    // The token is the holder's proof of the lease; it is not shown.
    item.tooltip = lines(`Lease ${visible(name)}`, `Held by ${visible(l.holder)}`, `Expires at ${stamp(l.expires_at)}`);
    return item;
  }
}

export class HeldView extends View {
  getChildren(node?: Node): Node[] {
    if (node !== undefined) return [];
    return [...this.store.held.values()].sort((a, b) => a.at - b.at).map((h) => this.nodes.held(h.session, h.id));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const held = node as HeldNode;
    const h = this.store.held.get(heldKey(held));
    const id = `held:${held.session}:${held.id}`;
    if (h === undefined) {
      const gone = new vscode.TreeItem("(decided)", vscode.TreeItemCollapsibleState.None);
      gone.id = id;
      return gone;
    }
    const item = new vscode.TreeItem(noIcons(`${oneLine(h.from, 80)} (${h.kind})`), vscode.TreeItemCollapsibleState.None);
    item.id = id;
    item.description = noIcons(h.file === undefined ? oneLine(h.preview, 120) : oneLine(h.file.name, 120));
    item.iconPath = new vscode.ThemeIcon(h.reason === "breaker" ? "debug-pause" : "mail");
    item.contextValue = "held";
    item.tooltip = lines(
      `From ${visible(h.from)} on device ${visible(h.device)}`,
      `For ${visible(h.session)}, ${h.kind}, ${stamp(h.at)}`,
      h.reason === "breaker" ? "Held because the breaker paused this peer." : "Held by this device's policy for the sending device.",
      h.file === undefined ? undefined : `File: ${visible(h.file.name)}, ${size(h.file.size)}, ${visible(h.file.mime)}`,
      "",
      "Preview (another agent's text):",
      visible(h.preview),
    );
    return item;
  }
}
