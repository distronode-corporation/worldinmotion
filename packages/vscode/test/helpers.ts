// Builders for rows and events in the `wim events` shapes, so each test states only what it needs.

import type { DeviceRow, HeldRow, MessageRow, SessionRow, WimEvent } from "../src/protocol.ts";
import { Store } from "../src/state.ts";

export const NOW = 1_800_000_000_000;

export function device(name: string, over: Partial<DeviceRow> = {}): DeviceRow {
  return { name, id: `dev-${name}`, role: "member", policy: "hold", self: false, ...over };
}

export function session(address: string, over: Partial<SessionRow> = {}): SessionRow {
  return { address, kind: "claude-code", status: "idle", since: NOW - 1000, rooms: [], local: false, ...over };
}

export function message(id: string, over: Partial<MessageRow> = {}): MessageRow {
  return { id, dir: "in", session: "vscode@laptop", peer: "coder@buildbox", kind: "msg", text: `text ${id}`, at: NOW, ...over };
}

export function heldRow(id: string, over: Partial<HeldRow> = {}): HeldRow {
  return { id, session: "vscode@laptop", from: "coder@buildbox", device: "buildbox", kind: "msg", at: NOW, preview: "preview", reason: "policy", ...over };
}

export function hello(): WimEvent {
  return { type: "hello", at: NOW, version: "1.0.0", device: { name: "laptop", id: "dev-laptop" }, session: "vscode@laptop", relay: "relay.example", mesh: "abcd" };
}

/** A store after hello, open and a snapshot of two devices and three sessions. */
export function mesh(extra: Partial<Extract<WimEvent, { type: "snapshot" }>> = {}): Store {
  const s = new Store();
  s.apply(hello());
  s.apply({ type: "connection", at: NOW, state: "open" });
  s.apply({
    type: "snapshot",
    at: NOW,
    devices: [device("laptop", { self: true, role: "admin", policy: "deliver" }), device("buildbox")],
    sessions: [
      session("vscode@laptop", { kind: "vscode", local: true }),
      session("reviewer@laptop", { status: "busy", local: true, rooms: ["#ops"], card: { cwd: "/home/me/app", branch: "review" } }),
      session("coder@buildbox", { rooms: ["#ops"], card: { cwd: "/srv/app", branch: "main", title: "Coder" } }),
      session("tester@buildbox", { status: "offline" }),
    ],
    rooms: [{ name: "#ops", members: ["reviewer@laptop", "coder@buildbox"] }],
    leases: [{ name: "deploy", holder: "coder@buildbox", token: 987654321, expires_at: NOW + 120_000 }],
    held: [heldRow("h1")],
    breakers: [],
    ...extra,
  });
  return s;
}

/** Lets pending promise callbacks run. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise<void>((r) => setImmediate(r));
}
