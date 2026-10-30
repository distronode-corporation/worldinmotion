import { describe, expect, it, vi } from "vitest";
import { clock } from "../src/display.ts";
import { counterparts, toNotify, edges, groups, heldKey, MESSAGE_CAP, PAUSE_MS, RECEIPT_CAP, Store, TEXT_CHARS, timeline } from "../src/state.ts";
import { device, heldRow, hello, mesh, message, NOW, session } from "./helpers.ts";
import type { WimEvent } from "../src/protocol.ts";

describe("Store: events", () => {
  it("starts empty and records hello and connection", () => {
    const s = new Store();
    expect(s.self).toBeUndefined();
    expect(s.connection).toEqual({ state: "starting" });
    s.apply(hello());
    expect(s.self).toBe("vscode@laptop");
    expect(s.hello).not.toHaveProperty("keys");
    s.apply({ ...hello(), keys: "signer" } as WimEvent);
    expect(s.hello?.keys).toBe("signer");
    s.apply({ type: "connection", at: NOW, state: "closed", detail: "relay gone" });
    expect(s.connection).toEqual({ state: "closed", detail: "relay gone" });
    s.apply({ type: "connection", at: NOW, state: "open" });
    expect(s.connection).toEqual({ state: "open" });
  });

  it("replaces everything on a snapshot", () => {
    const s = mesh();
    expect([...s.devices.keys()]).toEqual(["laptop", "buildbox"]);
    expect(s.sessions.size).toBe(4);
    expect(s.rooms.get("#ops")).toEqual(["reviewer@laptop", "coder@buildbox"]);
    expect(s.leases.has("deploy")).toBe(true);
    expect(s.held.has(heldKey(heldRow("h1")))).toBe(true);
    s.apply({ type: "snapshot", at: NOW, devices: [], sessions: [], rooms: [], leases: [], held: [], breakers: [{ peer: "x@y", at: NOW }], joins: [] });
    expect(s.devices.size + s.sessions.size + s.rooms.size + s.leases.size + s.held.size).toBe(0);
    expect(s.breakers.has("x@y")).toBe(true);
  });

  it("updates and removes devices", () => {
    const s = mesh();
    s.apply({ type: "device", at: NOW, device: device("buildbox", { policy: "deliver" }) });
    expect(s.devices.get("buildbox")!.policy).toBe("deliver");
    s.apply({ type: "device-removed", at: NOW, name: "buildbox", id: "dev-buildbox" });
    expect(s.devices.has("buildbox")).toBe(false);
  });

  it("keeps rooms in step with peer events", () => {
    const s = mesh();
    s.apply({ type: "peer", at: NOW, session: session("coder@buildbox", { rooms: ["#dev"] }) });
    expect(s.rooms.get("#ops")).toEqual(["reviewer@laptop"]);
    expect(s.rooms.get("#dev")).toEqual(["coder@buildbox"]);
    s.apply({ type: "peer-removed", at: NOW, address: "reviewer@laptop" });
    expect(s.rooms.has("#ops")).toBe(false);
    expect(s.sessions.has("reviewer@laptop")).toBe(false);
  });

  it("counts unread only for live messages to its own session, once each", () => {
    const s = mesh();
    s.apply({ type: "message", at: NOW, message: message("a") });
    s.apply({ type: "message", at: NOW, message: message("a") });
    s.apply({ type: "message", at: NOW, message: message("b", { session: "reviewer@laptop" }) });
    s.apply({ type: "message", at: NOW, message: message("c", { dir: "out" }) });
    s.addHistory([message("d")]);
    expect(s.unread).toBe(1);
    expect(s.messages.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
    const fn = vi.fn();
    s.onChange(fn);
    s.markRead();
    expect(s.unread).toBe(0);
    s.markRead();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("keeps messages in time order and drops the oldest past the cap", () => {
    const s = new Store();
    s.addHistory([message("late", { at: NOW + 10 }), message("early", { at: NOW })]);
    expect(s.messages.map((m) => m.id)).toEqual(["early", "late"]);
    s.addHistory(Array.from({ length: MESSAGE_CAP }, (_, i) => message(`m${i}`, { at: NOW + 100 + i })));
    expect(s.messages.length).toBe(MESSAGE_CAP);
    expect(s.messages[0]!.id).toBe("m0");
    // A dropped message may be added again.
    s.addHistory([message("early", { at: NOW + 5000 })]);
    expect(s.messages.at(-1)!.id).toBe("early");
  });

  it("keeps receipts, bounded", () => {
    const s = new Store();
    s.apply({ type: "receipt", at: NOW + 40, id: "m", to: "a@b", status: "delivered" });
    s.apply({ type: "receipt", at: NOW + 90, id: "m", to: "c@d", status: "held" });
    expect(s.latency(message("m", { dir: "out", at: NOW }))).toEqual([
      { to: "a@b", status: "delivered", ms: 40 },
      { to: "c@d", status: "held", ms: 90 },
    ]);
    expect(s.latency(message("m", { dir: "out", at: NOW + 1000 }))[0]!.ms).toBe(0);
    expect(s.latency(message("none"))).toEqual([]);
    for (let i = 0; i < RECEIPT_CAP; i += 1) s.apply({ type: "receipt", at: NOW, id: `r${i}`, to: "a@b", status: "delivered" });
    expect(s.receipts.size).toBe(RECEIPT_CAP);
    expect(s.receipts.has("m")).toBe(false);
  });

  it("adds and removes held items and leases", () => {
    const s = mesh();
    s.apply({ type: "held", at: NOW, op: "add", item: heldRow("h2") });
    s.apply({ type: "held", at: NOW, op: "remove", item: heldRow("h1") });
    expect([...s.held.values()].map((h) => h.id)).toEqual(["h2"]);
    s.apply({ type: "lease", at: NOW, lease: { name: "x", holder: "a@b", token: 1, expires_at: 1 } });
    s.apply({ type: "lease-released", at: NOW, name: "deploy" });
    expect([...s.leases.keys()]).toEqual(["x"]);
  });

  it("keeps one held row per local session: deciding one copy leaves the other", () => {
    // `wim events` reports a message held by two local sessions as two rows (one per session).
    const s = mesh({ held: [heldRow("x", { session: "agent@laptop" }), heldRow("x", { session: "vscode@laptop" })] });
    expect(s.held.size).toBe(2);
    s.apply({ type: "held", at: NOW, op: "remove", item: heldRow("x", { session: "agent@laptop" }) });
    expect([...s.held.values()]).toEqual([heldRow("x", { session: "vscode@laptop" })]);
    s.apply({ type: "held", at: NOW, op: "add", item: heldRow("x", { session: "agent@laptop" }) });
    expect(s.held.size).toBe(2);
  });

  it("tracks breaker pauses, which lapse after an hour", () => {
    const s = mesh();
    s.apply({ type: "breaker", at: NOW, peer: "coder@buildbox", state: "tripped", reason: "pingpong" });
    s.apply({ type: "breaker", at: NOW, peer: "reviewer@laptop", state: "tripped" });
    expect(s.pause("coder@buildbox", NOW + 1)).toEqual({ peer: "coder@buildbox", reason: "pingpong", at: NOW });
    expect(s.pause("reviewer@laptop", NOW + 1)).toEqual({ peer: "reviewer@laptop", at: NOW });
    expect(s.pause("coder@buildbox", NOW + PAUSE_MS)).toBeUndefined();
    s.apply({ type: "breaker", at: NOW, peer: "coder@buildbox", state: "resumed" });
    expect(s.pause("coder@buildbox", NOW + 1)).toBeUndefined();
  });

  it("keeps waiting join requests and setup mode, and a reset forgets both", () => {
    const s = mesh({ joins: [{ name: "a", id: "d1", invite: "i1", at: 1, exp: 2 }] });
    expect([...s.joins.keys()]).toEqual(["i1/d1"]);
    s.apply({ type: "join", at: NOW, op: "add", request: { name: "b", id: "d2", invite: "i1", at: 1, exp: 2 } });
    s.apply({ type: "join", at: NOW, op: "remove", request: { name: "a", id: "d1", invite: "i1", at: 1, exp: 2 } });
    expect([...s.joins.keys()]).toEqual(["i1/d2"]);
    s.apply({ type: "setup", at: NOW, version: "1" });
    expect(s.setup).toEqual({});
    s.apply({ type: "setup", at: NOW, version: "1", device: { name: "x", id: "y" } });
    expect(s.setup).toEqual({ device: { name: "x", id: "y" } });
    s.reset();
    expect(s.setup).toBeUndefined();
    expect(s.joins.size).toBe(0);
  });

  it("resets for a new process, and marks an exit as closed", () => {
    const s = mesh();
    s.apply({ type: "message", at: NOW, message: message("a") });
    s.exited("exited with code 1");
    expect(s.connection).toEqual({ state: "closed", detail: "exited with code 1" });
    expect(s.sessions.size).toBe(4);
    const fn = vi.fn();
    const off = s.onChange(fn);
    s.reset();
    expect(fn).toHaveBeenCalledWith(undefined);
    off();
    expect(s.hello).toBeUndefined();
    expect(s.sessions.size + s.messages.length + s.unread).toBe(0);
  });
});

describe("Store: queries", () => {
  it("lists this device first, then others, including devices only sessions name", () => {
    const s = mesh();
    s.apply({ type: "peer", at: NOW, session: session("ghost@attic") });
    expect(s.deviceNames()).toEqual(["laptop", "attic", "buildbox"]);
    expect(s.sessionsOn("laptop").map((x) => x.address)).toEqual(["reviewer@laptop", "vscode@laptop"]);
  });

  it("sorts device names without a hello", () => {
    const s = new Store();
    s.apply({ type: "peer", at: NOW, session: session("a@zed") });
    s.apply({ type: "peer", at: NOW, session: session("b@amber") });
    expect(s.deviceNames()).toEqual(["amber", "zed"]);
  });

  it("offers live sessions other than itself, then rooms", () => {
    const s = mesh();
    s.apply({ type: "peer", at: NOW, session: session("solo@buildbox", { rooms: ["#one"], kind: "bot" }) });
    expect(s.targets()).toEqual([
      { target: "coder@buildbox", detail: "claude-code, idle, main" },
      { target: "reviewer@laptop", detail: "claude-code, busy, review" },
      { target: "solo@buildbox", detail: "bot, idle" },
      { target: "#one", detail: "1 member" },
      { target: "#ops", detail: "2 members" },
    ]);
  });

  it("lists thread peers from sessions, rooms and messages", () => {
    const s = mesh();
    s.addHistory([message("a", { peer: "far@away" }), message("b", { dir: "out", peer: "x@y,z@w" })]);
    expect(s.threadPeers()).toEqual(["#ops", "coder@buildbox", "far@away", "reviewer@laptop", "tester@buildbox", "x@y", "z@w"]);
  });
});

describe("counterparts", () => {
  it("is the sender for in, and the to list (or the joined peer) for out", () => {
    expect(counterparts(message("a"))).toEqual(["coder@buildbox"]);
    expect(counterparts(message("a", { dir: "out", to: ["p@q"], peer: "ignored" }))).toEqual(["p@q"]);
    expect(counterparts(message("a", { dir: "out", peer: "p@q,r@s," }))).toEqual(["p@q", "r@s"]);
  });
});

describe("timeline", () => {
  it("shows newest first, with badges, receipts, escaped text and files", () => {
    const s = mesh();
    const bidi = String.fromCharCode(0x202e);
    s.addHistory([
      message("in1", { at: NOW, relayed: true, derived: true, unsolicited: true, text: `hi${bidi}\nthere` }),
      message("out1", { dir: "out", session: "vscode@laptop", peer: "a@b,c@d", to: ["a@b", "c@d"], at: NOW + 1000 }),
      message("out2", { dir: "out", peer: "a@b", status: "done", at: NOW + 2000 }),
      message("f", { kind: "file", file: { name: "x.txt", size: 3, mime: "text/plain" }, at: NOW + 3000 }),
      message("o3", { dir: "out", peer: "", at: NOW + 4000 }),
      message("long", { text: "y".repeat(1000), at: NOW + 5000 }),
    ]);
    s.apply({ type: "receipt", at: NOW + 1250, id: "out1", to: "a@b", status: "delivered" });
    const rows = timeline(s, 10, clock);
    expect(rows.map((r) => r.key.split("\n")[1])).toEqual(["long", "o3", "f", "out2", "out1", "in1"]);
    expect(rows[0]!.text.length).toBe(TEXT_CHARS);
    expect(rows[1]!.peer).toBe("");
    expect(rows[2]!.text).toBe("x.txt (3 bytes)");
    expect(rows[3]!.status).toBe("done");
    expect(rows[4]).toMatchObject({ from: "vscode@laptop", to: "a@b, c@d", status: "delivered in 250 ms", peer: "a@b" });
    expect(rows[5]).toMatchObject({ from: "coder@buildbox", to: "vscode@laptop", badges: ["relayed", "derived", "unsolicited"], text: "hi<U+202E> there", status: "" });
    expect(timeline(s, 2, clock).length).toBe(2);
  });
});

describe("edges and groups", () => {
  it("counts each message once per pair within the window", () => {
    const s = mesh();
    s.addHistory([
      // Seen by both local sessions: once sent, once received.
      message("x", { dir: "out", session: "reviewer@laptop", to: ["vscode@laptop"], at: NOW - 1000 }),
      message("x", { dir: "in", session: "vscode@laptop", peer: "reviewer@laptop", at: NOW - 1000 }),
      message("y", { dir: "in", at: NOW - 500 }),
      message("z", { dir: "in", at: NOW - 400 }),
      message("old", { dir: "in", at: NOW - 10_000 }),
      message("future", { dir: "in", at: NOW + 10_000 }),
      message("r", { dir: "out", session: "vscode@laptop", to: ["#ops"], at: NOW - 100 }),
    ]);
    const list = edges(s, NOW, 5000);
    expect(list).toEqual([
      { from: "coder@buildbox", to: "vscode@laptop", count: 2 },
      { from: "reviewer@laptop", to: "vscode@laptop", count: 1 },
      { from: "vscode@laptop", to: "#ops", count: 1 },
    ]);
    expect(groups(s, list)).toEqual([
      { device: "laptop", nodes: ["reviewer@laptop", "vscode@laptop"] },
      { device: "#", nodes: ["#ops"] },
      { device: "buildbox", nodes: ["coder@buildbox"] },
    ]);
  });

  it("sorts equal counts by name, and groups without a hello", () => {
    const s = new Store();
    s.addHistory([message("a", { session: "b@x", peer: "q@y", at: NOW }), message("b", { session: "a@x", peer: "q@y", at: NOW }), message("c", { session: "a@x", peer: "p@y", at: NOW })]);
    const list = edges(s, NOW, 1000);
    expect(list.map((e) => `${e.from}>${e.to}`)).toEqual(["p@y>a@x", "q@y>a@x", "q@y>b@x"]);
    expect(groups(s, list).map((g) => g.device)).toEqual(["x", "y"]);
  });
});

describe("toNotify", () => {
  it("picks an incoming message for this window's own session only", () => {
    const s = mesh();
    const ev = (over: Parameters<typeof message>[1]) => ({ type: "message" as const, at: NOW, message: message("m", over) });
    expect(toNotify(s, ev({}))).toEqual(message("m"));
    expect(toNotify(s, ev({ dir: "out" }))).toBeUndefined();
    expect(toNotify(s, ev({ session: "reviewer@laptop" }))).toBeUndefined();
    expect(toNotify(s, hello())).toBeUndefined();
  });

  it("with claudeTabs, also picks one for a Claude Code session on this device, and nothing else", () => {
    const s = mesh();
    const ev = (over: Parameters<typeof message>[1]) => ({ type: "message" as const, at: NOW, message: message("m", over) });
    // reviewer@laptop is a local claude-code session; coder@buildbox is on another device.
    expect(toNotify(s, ev({ session: "reviewer@laptop" }), true)).toEqual(message("m", { session: "reviewer@laptop" }));
    expect(toNotify(s, ev({ session: "reviewer@laptop", dir: "out" }), true)).toBeUndefined();
    expect(toNotify(s, ev({ session: "coder@buildbox" }), true)).toBeUndefined();
    expect(toNotify(s, ev({ session: "gone@laptop" }), true)).toBeUndefined();
    s.apply({ type: "peer", at: NOW, session: { address: "bot@laptop", kind: "bot", status: "idle", since: NOW, rooms: [], local: true } });
    expect(toNotify(s, ev({ session: "bot@laptop" }), true)).toBeUndefined();
    expect(toNotify(s, ev({}), true)).toEqual(message("m"));
  });
});
