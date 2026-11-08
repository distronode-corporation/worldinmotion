// The idle notice frames and fields a relay added in 0.2.0 (SPEC section 8), parsed by today's
// schemas and by a copy of 0.1.10's (v010-frames.ts). A 0.1.x client ignores every relay frame
// that does not parse (packages/client/src/wire.ts, `receive`, unchanged since 0.1.0), so each new
// frame must either parse there, its new keys kept and ignored, or not parse at all: never turn a
// frame 0.1.x took into one it drops. The frames are the exact shapes relay-core sends
// (packages/relay-core/test/idle-notices.test.ts and messages.test.ts pin them).

import { describe, expect, it } from "vitest";
import { parseClientFrame, parseRelayFrame, ulid } from "../src/index.ts";
import { mesh, T0 } from "./helpers.ts";
import * as v010 from "./v010-frames.ts";

const roster = mesh(["laptop"]).chain.at(-1)!;
const peer = { address: "writer@laptop", sid: ulid(), kind: "claude-code", status: "idle", since: T0, rooms: [] };
const marked = { ...peer, presence: true };

/** Frames a 0.2.0 relay sends that a 0.1.10 relay sent too, now with new keys. */
const widened: [string, Record<string, unknown>][] = [
  ["notice, idle", { t: "notice", kind: "idle", of: "reviewer@server", why: "idle" }],
  ["notice, ended", { t: "notice", kind: "idle", of: "reviewer@server", why: "ended" }],
  ["notice, offline", { t: "notice", kind: "idle", of: "reviewer@server", why: "offline" }],
  ["error, not_found", { t: "error", code: "not_found", message: "no such session", ref: "notify_idle", of: "x@laptop" }],
  ["error, limited", { t: "error", code: "limited", message: "too many idle notices armed", ref: "notify_idle", of: "root@admin" }],
  ["peer", { t: "peer", peer: marked }],
  ["peers", { t: "peers", peers: [marked, peer] }],
  ["ready", { t: "ready", sid: ulid(), name: "writer", cursor: 0, roster, more: false, peers: [marked] }],
];

describe("idle notice frames under 0.1.10's schemas and today's", () => {
  for (const [what, frame] of widened) {
    it(`a 0.1.x client takes the ${what} frame and keeps the new key as an unknown one`, () => {
      const text = JSON.stringify(frame);
      expect(v010.parseRelayFrame(text)).toEqual({ ok: true, value: frame });
      expect(parseRelayFrame(text)).toEqual({ ok: true, value: frame });
    });
  }

  it("a 0.1.x client ignores idle.armed, a type it does not know; today's client reads it", () => {
    const text = JSON.stringify({ t: "idle.armed", of: "reviewer@server", exp: T0 });
    expect(v010.parseRelayFrame(text)).toEqual({ ok: false, reason: "unknown_type" });
    expect(parseRelayFrame(text)).toEqual({ ok: true, value: { t: "idle.armed", of: "reviewer@server", exp: T0 } });
  });

  it("today's schemas still take each of those frames as a 0.1.x relay sends it, without the new keys", () => {
    const old = [
      { t: "notice", kind: "idle", of: "reviewer@server" },
      { t: "error", code: "not_found", message: "no such session", ref: "notify_idle" },
      { t: "peers", peers: [peer] },
      { t: "ready", sid: ulid(), name: "writer", cursor: 0, roster, more: false, peers: [peer] },
    ];
    for (const frame of old) {
      expect(v010.parseRelayFrame(JSON.stringify(frame)), frame.t).toEqual({ ok: true, value: frame });
      expect(parseRelayFrame(JSON.stringify(frame)), frame.t).toEqual({ ok: true, value: frame });
    }
  });

  it("adds no key to a client frame: a 0.1.x relay takes what a 0.2.0 client sends for idle notices and presence", () => {
    for (const frame of [{ t: "notify_idle", of: "reviewer@server" }, { t: "presence", status: "idle" }, { t: "presence", status: "busy" }, { t: "bye", ended: false }]) {
      const text = JSON.stringify(frame);
      expect(v010.parseClientFrame(text)).toEqual({ ok: true, value: frame });
      expect(parseClientFrame(text)).toEqual({ ok: true, value: frame });
    }
    // Both refuse a key they do not know in a client frame, so nothing new can slip in unnoticed.
    const extra = JSON.stringify({ t: "notify_idle", of: "reviewer@server", why: "idle" });
    expect(v010.parseClientFrame(extra)).toEqual({ ok: false, reason: "malformed" });
    expect(parseClientFrame(extra)).toEqual({ ok: false, reason: "malformed" });
  });
});
