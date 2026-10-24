import { describe, expect, it } from "vitest";
import { historyRows, parseLine, type Parsed } from "../src/protocol.ts";
import { device, heldRow, message, session } from "./helpers.ts";

const line = (o: Record<string, unknown>): Parsed => parseLine(JSON.stringify({ v: 1, at: 5, ...o }));
const ev = (o: Record<string, unknown>) => {
  const p = line(o);
  if (p.kind !== "event") throw new Error(`not an event: ${JSON.stringify(p)}`);
  return p.event;
};
const invalid = (o: Record<string, unknown>) => {
  const p = line(o);
  expect(p.kind).toBe("invalid");
  return (p as { reason: string }).reason;
};

describe("parseLine: framing", () => {
  it("refuses a line that is not JSON or not an object", () => {
    expect(parseLine("{")).toEqual({ kind: "invalid", reason: "not JSON" });
    expect(parseLine("[1]")).toEqual({ kind: "invalid", reason: "not a JSON object" });
    expect(parseLine("null")).toEqual({ kind: "invalid", reason: "not a JSON object" });
  });

  it("refuses any v other than 1", () => {
    expect(parseLine(JSON.stringify({ v: 2, type: "hello" }))).toEqual({ kind: "invalid", reason: "unsupported version 2" });
    expect(parseLine(JSON.stringify({ type: "hello" }))).toEqual({ kind: "invalid", reason: "unsupported version undefined" });
  });

  it("refuses a missing type and a missing or bad at", () => {
    expect(parseLine(JSON.stringify({ v: 1 }))).toEqual({ kind: "invalid", reason: "type is not a string" });
    expect(invalid({ type: "connection", state: "open", at: "now" })).toBe("connection: at is not a number");
    expect(invalid({ type: "connection", state: "open", at: Number.POSITIVE_INFINITY })).toBe("connection: at is not a number");
  });

  it("ignores an unknown event type", () => {
    expect(line({ type: "weather" })).toEqual({ kind: "ignored", type: "weather" });
  });
});

describe("parseLine: responses", () => {
  it("parses ok with and without a result", () => {
    expect(line({ type: "response", id: "r1", ok: true, result: { a: 1 } })).toEqual({ kind: "response", response: { id: "r1", ok: true, result: { a: 1 } } });
    expect(line({ type: "response", id: "r1", ok: true })).toEqual({ kind: "response", response: { id: "r1", ok: true, result: {} } });
  });
  it("parses an error", () => {
    expect(line({ type: "response", id: "r2", ok: false, error: { code: "input", message: "bad" } })).toEqual({
      kind: "response",
      response: { id: "r2", ok: false, error: { code: "input", message: "bad" } },
    });
  });
  it("refuses a response without an id, ok or error object", () => {
    expect(invalid({ type: "response", ok: false, error: { code: "input", message: "bad" } })).toBe("response: id is not a string");
    expect(invalid({ type: "response", id: "r", ok: "yes" })).toBe("response: ok is not a boolean");
    expect(invalid({ type: "response", id: "r", ok: false, error: [] })).toBe("response: error is not an object");
  });
});

describe("parseLine: events", () => {
  it("parses hello", () => {
    expect(ev({ type: "hello", version: "1", device: { name: "d", id: "i" }, session: "a@d", relay: "r", mesh: "m", extra: 1 })).toEqual({
      type: "hello",
      at: 5,
      version: "1",
      device: { name: "d", id: "i" },
      session: "a@d",
      relay: "r",
      mesh: "m",
    });
  });

  it("parses connection with and without detail, and refuses an unknown state", () => {
    expect(ev({ type: "connection", state: "closed", detail: "gone" })).toEqual({ type: "connection", at: 5, state: "closed", detail: "gone" });
    expect(ev({ type: "connection", state: "open" })).toEqual({ type: "connection", at: 5, state: "open" });
    expect(invalid({ type: "connection", state: "half" })).toBe("connection: state is not one of connecting, open, closed");
    expect(invalid({ type: "connection", state: "open", detail: 3 })).toBe("connection: detail is not a string");
  });

  it("parses a full snapshot, copying only known fields", () => {
    const s = ev({
      type: "snapshot",
      devices: [{ ...device("a"), extra: true }],
      sessions: [
        { ...session("x@a", { sid: "s1", card: { cwd: "/w", branch: "main", title: "T" } }), extra: 1 },
        { ...session("y@a"), card: {} },
      ],
      rooms: [{ name: "#r", members: ["x@a"] }],
      leases: [{ name: "l", holder: "x@a", token: 7, expires_at: 9 }],
      held: [heldRow("h", { file: { name: "f", size: 1, mime: "text/plain" } })],
      breakers: [{ peer: "x@a", reason: "pingpong", at: 3 }, { peer: "y@a", at: 4 }],
    });
    expect(s).toMatchObject({ type: "snapshot", at: 5 });
    if (s.type !== "snapshot") throw new Error("snapshot");
    expect(s.devices).toEqual([device("a")]);
    expect(s.sessions[0]).toEqual(session("x@a", { sid: "s1", card: { cwd: "/w", branch: "main", title: "T" } }));
    expect(s.sessions[1]).toEqual(session("y@a", { card: {} }));
    expect(s.rooms).toEqual([{ name: "#r", members: ["x@a"] }]);
    expect(s.leases).toEqual([{ name: "l", holder: "x@a", token: 7, expires_at: 9 }]);
    expect(s.held[0]!.file).toEqual({ name: "f", size: 1, mime: "text/plain" });
    expect(s.breakers).toEqual([{ peer: "x@a", reason: "pingpong", at: 3 }, { peer: "y@a", at: 4 }]);
  });

  it("refuses a snapshot with a bad list or row", () => {
    const base = { type: "snapshot", devices: [], sessions: [], rooms: [], leases: [], held: [], breakers: [] };
    expect(invalid({ ...base, devices: {} })).toBe("snapshot: devices is not a list");
    expect(invalid({ ...base, devices: [1] })).toBe("snapshot: device is not an object");
    expect(invalid({ ...base, devices: [{ ...device("a"), self: "yes" }] })).toBe("snapshot: self is not a boolean");
    expect(invalid({ ...base, sessions: [{ ...session("a@b"), rooms: [1] }] })).toBe("snapshot: rooms is not a list of strings");
    expect(invalid({ ...base, sessions: [{ ...session("a@b"), rooms: "x" }] })).toBe("snapshot: rooms is not a list of strings");
    expect(invalid({ ...base, sessions: [{ ...session("a@b"), card: "x" }] })).toBe("snapshot: card is not an object");
    expect(invalid({ ...base, held: [{ ...heldRow("h"), file: { name: "f", size: "1", mime: "m" } }] })).toBe("snapshot: size is not a number");
    expect(invalid({ ...base, breakers: [{ peer: "a@b", reason: "boredom", at: 1 }] })).toBe("snapshot: reason is not one of peer, total, pingpong");
  });

  it("parses device and its removal", () => {
    expect(ev({ type: "device", ...device("a") })).toEqual({ type: "device", at: 5, device: device("a") });
    expect(ev({ type: "device", name: "a", id: "i", removed: true })).toEqual({ type: "device-removed", at: 5, name: "a", id: "i" });
  });

  it("parses peer and its removal", () => {
    expect(ev({ type: "peer", ...session("a@b") })).toEqual({ type: "peer", at: 5, session: session("a@b") });
    expect(ev({ type: "peer", address: "a@b", removed: true })).toEqual({ type: "peer-removed", at: 5, address: "a@b" });
  });

  it("parses a message with every optional field, keeping only true flags", () => {
    const full = message("m", {
      dir: "out",
      device: "d",
      reply_to: "p",
      status: "done",
      deadline: 7,
      file: { name: "f", size: 2, mime: "m" },
      relayed: true,
      derived: true,
      unsolicited: true,
      to: ["a@b", "c@d"],
    });
    expect(ev({ type: "message", ...full })).toEqual({ type: "message", at: NOW_OF(full), message: full });
    expect(ev({ type: "message", ...message("n"), relayed: false })).toEqual({ type: "message", at: NOW_OF(message("n")), message: message("n") });
    expect(invalid({ type: "message", ...message("n"), to: "a@b" })).toBe("message: to is not a list of strings");
  });

  it("parses receipt and refuses an unknown status", () => {
    expect(ev({ type: "receipt", id: "m", to: "a@b", status: "delivered" })).toEqual({ type: "receipt", at: 5, id: "m", to: "a@b", status: "delivered" });
    expect(invalid({ type: "receipt", id: "m", to: "a@b", status: "queued" })).toBe("receipt: status is not one of delivered, held, refused, expired");
  });

  it("parses held add and remove", () => {
    expect(ev({ type: "held", op: "add", item: heldRow("h") })).toEqual({ type: "held", at: 5, op: "add", item: heldRow("h") });
    expect(invalid({ type: "held", op: "add", item: null })).toBe("held: held is not an object");
  });

  it("parses lease and its release", () => {
    // The client sends the token as the relay's integer (protocol frames.ts leaseTokenSchema).
    expect(ev({ type: "lease", name: "l", holder: "a@b", token: 3, expires_at: 1 })).toEqual({ type: "lease", at: 5, lease: { name: "l", holder: "a@b", token: 3, expires_at: 1 } });
    expect(invalid({ type: "lease", name: "l", holder: "a@b", token: "3", expires_at: 1 })).toBe("lease: token is not a number");
    expect(ev({ type: "lease", name: "l", released: true })).toEqual({ type: "lease-released", at: 5, name: "l" });
  });

  it("parses breaker with and without a reason", () => {
    expect(ev({ type: "breaker", peer: "a@b", state: "tripped", reason: "total" })).toEqual({ type: "breaker", at: 5, peer: "a@b", state: "tripped", reason: "total" });
    expect(ev({ type: "breaker", peer: "a@b", state: "resumed" })).toEqual({ type: "breaker", at: 5, peer: "a@b", state: "resumed" });
  });
});

/** A message event's `at` is the message's own: the client spreads the row after the event's. */
function NOW_OF(m: { at: number }): number {
  return m.at;
}

describe("historyRows", () => {
  it("reads the messages of a history result", () => {
    expect(historyRows({ messages: [message("a")] })).toEqual([message("a")]);
    expect(historyRows({})).toEqual([]);
    expect(historyRows(null)).toEqual([]);
    expect(() => historyRows({ messages: [{ id: 1 }] })).toThrow("id is not a string");
  });
});
