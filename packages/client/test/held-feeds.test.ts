// Issue #159, the pure parts: which held items are feed lines, when one expires, what the policy
// does now with what it held, the held-feed limits in mesh.json, trust of this device itself, and
// the warning `wim ci` prints at start.

import { ulid } from "@worldinmotion/protocol";
import { describe, expect, it } from "vitest";
import { ciTrustLines } from "../src/ciwarn.ts";
import type { PeerRow } from "../src/client.ts";
import { expiredFeedLines, expiryText, feedOf, isFeedLine, policyNow, sessionOf, type Reviewed } from "../src/feeds.ts";
import { DEFAULT_BREAKER, DEFAULT_HELD_FEEDS, heldFeedLimits, parseMeshConfig, trustLevel, type MeshConfig } from "../src/mesh.ts";

const HOUR = 3_600_000;

const line = (over: Partial<Reviewed> = {}, entry: Partial<Reviewed["entry"]> = { relayed: true }): Reviewed => ({
  id: ulid(),
  from: "ci@one",
  device: "D1",
  kind: "msg",
  at: 0,
  reason: "policy",
  ...over,
  entry,
});

const config = (policy: MeshConfig["policy"] = {}, over: Partial<MeshConfig> = {}): MeshConfig => ({
  v: 1,
  mesh: "m",
  relay: "wss://relay.example",
  device: "SELF",
  pin: { seq: 1, hash: "h" },
  policy,
  breaker: DEFAULT_BREAKER,
  share_cards: true,
  ...over,
});

describe("feed lines", () => {
  it("are relayed plain messages that answer nothing, held by policy, never a task, a reply, a CI notice or a breaker hold", () => {
    expect(isFeedLine(line())).toBe(true);
    expect(isFeedLine(line({}, {}))).toBe(false);
    expect(isFeedLine(line({}, { relayed: true, reply_to: ulid() }))).toBe(false);
    expect(isFeedLine(line({ kind: "task" }))).toBe(false);
    expect(isFeedLine(line({ kind: "result" }))).toBe(false);
    expect(isFeedLine(line({ kind: "file" }))).toBe(false);
    expect(isFeedLine(line({ reason: "breaker" }))).toBe(false);
    expect(isFeedLine(line({ device: "", ci: { rule: ulid() } }))).toBe(false);
  });

  it("belong to the feed of their device id and session, whatever the device is called", () => {
    expect(sessionOf("ci@one")).toBe("ci");
    expect(feedOf({ device: "D1", from: "ci@one" })).toBe("D1 ci");
    expect(feedOf({ device: "D1", from: "ci@renamed" })).toBe("D1 ci");
    expect(feedOf({ device: "D2", from: "ci@one" })).not.toBe(feedOf({ device: "D1", from: "ci@one" }));
  });

  it("expire once older than the bound, or with `keep` newer held in their feed, oldest first", () => {
    const limits = { maxAgeHours: 24, keep: 2 };
    const now = 100 * HOUR;
    const old = line({ at: now - 25 * HOUR });
    const fresh = [1, 2, 3].map((h) => line({ at: now - h * HOUR }));
    // Same millisecond: the id orders them, so the one with the lower id is the older.
    const [lo, hi] = [ulid(), ulid()].sort();
    const tie = [line({ id: hi!, at: now - 4 * HOUR, from: "other@one" }), line({ id: lo!, at: now - 4 * HOUR, from: "other@one" }), line({ at: now - 1, from: "other@one" })];
    const notFeed = line({ at: 0, kind: "task" });
    const out = expiredFeedLines([...fresh, old, notFeed, ...tie], limits, now);
    expect(out.map((i) => i.id)).toEqual([old.id, lo, fresh[2]!.id]);
    // At the bound exactly a line is still in time; a single feed under `keep` loses nothing else.
    expect(expiredFeedLines([line({ at: now - 24 * HOUR })], limits, now)).toEqual([]);
    expect(expiredFeedLines([], DEFAULT_HELD_FEEDS, now)).toEqual([]);
  });

  it("say their bound in words", () => {
    expect(expiryText(DEFAULT_HELD_FEEDS)).toBe("older than 24 hours, or more than 20 newer held from the same feed");
    expect(expiryText({ maxAgeHours: 1, keep: 3 })).toBe("older than 1 hour, or more than 3 newer held from the same feed");
  });
});

describe("what the policy does now with a held item", () => {
  const inRoster = (d: string): boolean => d !== "GONE";
  it("delivers relayed text only under deliver-relayed, plain text under deliver, and drops under refuse", () => {
    const relayed = line({ device: "D1" });
    const plain = line({ device: "D1" }, {});
    expect(policyNow(relayed, config({ D1: "deliver" }), inRoster)).toBe("hold");
    expect(policyNow(relayed, config({ D1: "deliver-relayed" }), inRoster)).toBe("deliver");
    expect(policyNow(plain, config({ D1: "deliver" }), inRoster)).toBe("deliver");
    expect(policyNow(plain, config({}), inRoster)).toBe("hold");
    expect(policyNow(plain, config({ D1: "refuse" }), inRoster)).toBe("refuse");
  });

  it("treats this device's own relayed text as held until the person trusts it with --relayed", () => {
    const own = line({ device: "SELF", from: "ci@here" });
    expect(policyNow(own, config({}), inRoster)).toBe("hold");
    expect(policyNow(line({ device: "SELF" }, {}), config({}), inRoster)).toBe("deliver");
    expect(policyNow(own, config({ SELF: "deliver-relayed" }), inRoster)).toBe("deliver");
    // A hold written for this device reads as deliver: its relayed text stays held.
    expect(policyNow(own, config({ SELF: "hold" }), inRoster)).toBe("hold");
  });

  it("never looks again at a breaker hold, a CI notice, or a device no longer in the roster", () => {
    const all = config({ D1: "deliver-relayed", GONE: "deliver-relayed" });
    expect(policyNow(line({ reason: "breaker" }), all, inRoster)).toBe("hold");
    expect(policyNow(line({ device: "", ci: { rule: ulid() } }), all, inRoster)).toBe("hold");
    expect(policyNow(line({ device: "GONE" }), all, inRoster)).toBe("hold");
  });
});

describe("held-feed limits in mesh.json", () => {
  const raw = (extra: Record<string, unknown>) => ({ v: 1, mesh: "m", relay: "wss://relay.example", device: "SELF", pin: { seq: 1, hash: "h" }, ...extra });
  it("read as the defaults when absent or invalid, field by field", () => {
    expect(parseMeshConfig(raw({}), "mesh.json").heldFeeds).toBeUndefined();
    expect(heldFeedLimits(parseMeshConfig(raw({}), "mesh.json"))).toEqual(DEFAULT_HELD_FEEDS);
    expect(parseMeshConfig(raw({ heldFeeds: { maxAgeHours: 6 } }), "mesh.json").heldFeeds).toEqual({ maxAgeHours: 6, keep: 20 });
    expect(heldFeedLimits({ heldFeeds: { maxAgeHours: 0, keep: -1 } as never })).toEqual(DEFAULT_HELD_FEEDS);
    expect(heldFeedLimits({ heldFeeds: { maxAgeHours: "48", keep: 2.5 } as never })).toEqual(DEFAULT_HELD_FEEDS);
    expect(heldFeedLimits({ heldFeeds: "soon" as never })).toEqual(DEFAULT_HELD_FEEDS);
    expect(heldFeedLimits({ heldFeeds: { maxAgeHours: 2, keep: 5 } })).toEqual({ maxAgeHours: 2, keep: 5 });
  });
});

describe("trusting this device itself", () => {
  it("never holds its own sessions: untrust goes back to deliver", () => {
    expect(trustLevel("trust", true, true)).toBe("deliver-relayed");
    expect(trustLevel("trust", false, true)).toBe("deliver");
    expect(trustLevel("untrust", true, true)).toBe("deliver");
    expect(trustLevel("untrust", false)).toBe("hold");
    expect(trustLevel("trust", true)).toBe("deliver-relayed");
  });
});

describe("the warning wim ci prints at start", () => {
  const peer = (address: string, rooms: string[]): PeerRow => ({ address, kind: "mcp", status: "idle", since: 0, rooms });
  it("names each member whose device would hold its lines, with the command for that device", () => {
    const peers = [peer("ci@here", ["#ci"]), peer("hub@here", ["#ci"]), peer("a@mac", ["#ci", "#ops"]), peer("b@mac", ["#ci"]), peer("c@lap", ["#ops"]), peer("x@far", ["#other"])];
    const lines = ciTrustLines("ci@here", ["#ci", "#ops", "#ci"], peers, config({}, { device: "SELF" }), DEFAULT_HELD_FEEDS);
    expect(lines).toEqual([
      "wim: warning: wim ci posts relayed text (what CI providers wrote), and a session holds relayed text unless its device trusts the sending device with --relayed:",
      "  #ci: hub@here (this device) holds them. Here, run: wim devices trust here --relayed",
      "  #ci: a@mac, b@mac hold them unless mac trusts here with --relayed. On mac, run: wim devices trust here --relayed",
      "  #ops: a@mac holds them unless mac trusts here with --relayed. On mac, run: wim devices trust here --relayed",
      "  #ops: c@lap holds them unless lap trusts here with --relayed. On lap, run: wim devices trust here --relayed",
      "Lines held anyway expire by themselves after 24 hours (heldFeeds in mesh.json), or once 20 newer ones wait; the person clears the rest with wim held refuse --from ci@here.",
    ]);
  });

  it("leaves out this device's members once it delivers relayed text, and says nothing with no one to hold", () => {
    const trusted = config({ SELF: "deliver-relayed" }, { device: "SELF" });
    expect(ciTrustLines("ci@here", ["#ci"], [peer("hub@here", ["#ci"]), peer("hub2@here", ["#ci"])], trusted, DEFAULT_HELD_FEEDS)).toEqual([]);
    expect(ciTrustLines("ci@here", ["#ci"], [peer("ci@here", ["#ci"])], config(), DEFAULT_HELD_FEEDS)).toEqual([]);
    const two = ciTrustLines("ci@here", ["#ci"], [peer("hub@here", ["#ci"]), peer("hub2@here", ["#ci"])], config({}, { device: "SELF" }), { maxAgeHours: 1, keep: 3 });
    expect(two[1]).toBe("  #ci: hub@here, hub2@here (this device) hold them. Here, run: wim devices trust here --relayed");
    expect(two[2]).toBe("Lines held anyway expire by themselves after 1 hour (heldFeeds in mesh.json), or once 3 newer ones wait; the person clears the rest with wim held refuse --from ci@here.");
  });

  it("shows a peer's address escaped", () => {
    const lines = ciTrustLines("ci@here", ["#ci"], [peer("a\u0007@mac", ["#ci"])], config(), DEFAULT_HELD_FEEDS);
    expect(lines[1]).toContain("a<U+0007>@mac");
  });
});
