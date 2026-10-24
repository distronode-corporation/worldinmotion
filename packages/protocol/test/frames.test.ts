import { describe, expect, it } from "vitest";
import {
  b64u,
  clientFrameSchema,
  createInvite,
  createJoin,
  generateDeviceKeys,
  hash,
  LIMITS,
  nextRoster,
  parseInvite,
  leaseKey,
  sealBlob,
  parseClientFrame,
  parseRelayFrame,
  randomBytes,
  relayFrameSchema,
  sealMessage,
  signAuth,
  ulid,
} from "../src/index.ts";
import { mesh, T0 } from "./helpers.ts";

const { admin, members, chain } = mesh(["laptop"]);
const laptop = members[0]!;
const roster = chain.at(-1)!;
const nonce = b64u.encode(randomBytes(32));
const send = sealMessage({
  roster,
  sender: { deviceId: laptop.id, keys: laptop.keys },
  session: "writer",
  sid: ulid(),
  to: ["reviewer@admin"],
  seq: 1,
  at: T0,
  text: "hi",
  recipients: [admin.id],
});
const auth = signAuth(
  {
    relay: "wss://relay.example",
    mesh: roster.mesh,
    nonce,
    at: T0,
    session: { name: "writer", kind: "cli", sid: ulid(), resume: b64u.encode(randomBytes(32)) },
    pin: { seq: 2, hash: hash(roster) },
  },
  laptop.keys,
);
const invite = createInvite({ relay: "wss://relay.example", mesh: roster.mesh, pin: { seq: 2, hash: hash(roster) }, now: T0 });
const { t: _t, ...join } = createJoin(parseInvite(invite.code), "newbox", generateDeviceKeys(), nonce);
const forkA = nextRoster(roster, { revoke: [laptop.id] }, admin, T0 + 1);
const forkB = nextRoster(roster, {}, admin, T0 + 1);
const peer = { address: "writer@laptop", sid: ulid(), kind: "claude-code", status: "idle", since: T0, rooms: ["#ops"] };
const blob = sealBlob(new Uint8Array([1, 2, 3]));
const chunk = blob.chunks[0]!;
const lkey = leaseKey(roster.mesh, "deploy");

/** For each frame type: a valid example and invalid variants. */
const clientCases: Array<[string, object, object[]]> = [
  [
    "auth",
    auth,
    [
      { ...auth, v: 2 },
      { ...auth, session: { ...auth.session, sid: "x" } },
      { ...auth, pin: 2 },
      { ...auth, session: { ...auth.session, resume: undefined } },
    ],
  ],
  [
    "send",
    send,
    [
      { ...send, seq: -1 },
      { ...send, to: ["Bad"] },
      { ...send, boxes: { short: send.boxes[admin.id] } },
      { ...send, mesh: undefined },
      { ...send, from: { device: laptop.id, session: "writer" } },
    ],
  ],
  ["ack", { t: "ack", cursor: 42 }, [{ t: "ack", cursor: -1 }, { t: "ack", cursor: 1.5 }, { t: "ack" }]],
  [
    "receipt",
    { t: "receipt", id: ulid(), to: "reviewer@laptop", status: "delivered" },
    [{ t: "receipt", id: ulid(), to: "*", status: "delivered" }, { t: "receipt", id: ulid(), to: "a@b", status: "lost" }],
  ],
  ["presence", { t: "presence", status: "busy" }, [{ t: "presence", status: "away" }]],
  ["peers", { t: "peers" }, [{ t: "peers", peers: [] }]],
  ["rename", { t: "rename", name: "reviewer-2" }, [{ t: "rename", name: "-x" }, { t: "rename", name: "a".repeat(33) }]],
  ["notify_idle", { t: "notify_idle", of: "reviewer@laptop" }, [{ t: "notify_idle", of: "*" }]],
  [
    "invite.create",
    { t: "invite.create", invite: invite.inviteId, exp: T0, pin: { seq: 2, hash: hash(roster) } },
    [{ t: "invite.create", invite: "x", exp: T0 }, { t: "invite.create", invite: invite.inviteId, exp: T0, pin: { seq: 0, hash: hash(roster) } }],
  ],
  ["roster.publish", { t: "roster.publish", roster }, [{ t: "roster.publish", roster: { ...roster, seq: 0 } }]],
  ["room.join", { t: "room.join", room: "#ops" }, [{ t: "room.join", room: "ops" }, { t: "room.join", room: "#Ops" }]],
  ["room.leave", { t: "room.leave", room: "#ops" }, [{ t: "room.leave" }]],
  [
    "room.history",
    { t: "room.history", room: "#ops", before: 10, limit: 50 },
    [{ t: "room.history", room: "#ops", limit: 51 }, { t: "room.history", room: "#ops", limit: 0 }, { t: "room.history", room: "#ops", before: -1 }],
  ],
  [
    "lease.acquire",
    { t: "lease.acquire", key: lkey, ttl: 1000, wait: true },
    [{ t: "lease.acquire", key: lkey, ttl: 999 }, { t: "lease.acquire", key: lkey, ttl: 3600001 }, { t: "lease.acquire", key: "deploy", ttl: 5000 }],
  ],
  ["lease.renew", { t: "lease.renew", key: lkey, token: 3, ttl: 3600000 }, [{ t: "lease.renew", key: lkey, token: 0, ttl: 5000 }]],
  ["lease.release", { t: "lease.release", key: lkey, token: 3 }, [{ t: "lease.release", key: lkey }]],
  ["lease.list", { t: "lease.list" }, [{ t: "lease.list", key: lkey }]],
  ["lease.watch", { t: "lease.watch", key: lkey }, [{ t: "lease.watch" }]],
  [
    "blob.put",
    { t: "blob.put", blob: blob.blob, ...chunk },
    [{ t: "blob.put", blob: blob.blob, ...chunk, index: 100 }, { t: "blob.put", blob: blob.blob, ...chunk, n: "short" }, { t: "blob.put", blob: "x", ...chunk }],
  ],
  ["blob.get", { t: "blob.get", blob: blob.blob, index: 0 }, [{ t: "blob.get", blob: blob.blob, index: -1 }]],
  ["roster.get", { t: "roster.get", from: 1 }, [{ t: "roster.get", from: 0 }, { t: "roster.get" }]],
  ["roster.fork", { t: "roster.fork", a: forkA, b: forkB }, [{ t: "roster.fork", a: forkA }]],
  ["ping", { t: "ping" }, [{ t: "ping", x: 1 }]],
  ["bye", { t: "bye", ended: true }, [{ t: "bye", ended: "yes" }, { t: "bye" }]],
  ["create", { t: "create", roster: chain[0], key: "operator-key" }, [{ t: "create", roster: chain[0], key: "" }]],
  [
    "join",
    { t: "join", ...join },
    [
      { t: "join", ...join, proof: "short" },
      { t: "join", ...join, mesh: undefined },
      { t: "join", ...join, sig: undefined },
      { t: "join", ...join, device: { ...join.device, role: "member" } },
    ],
  ],
];

const relayCases: Array<[string, object, object[]]> = [
  ["hello", { t: "hello", v: 1, nonce, at: T0 }, [{ t: "hello", v: 1, nonce: "abc", at: T0 }]],
  [
    "ready",
    { t: "ready", sid: ulid(), name: "writer", cursor: 0, roster, more: false, peers: [peer] },
    [
      { t: "ready", sid: ulid(), name: "writer", cursor: 0, roster, more: false, peers: [{ ...peer, status: "gone" }] },
      { t: "ready", sid: ulid(), name: "writer", cursor: 0, roster: chain, more: false, peers: [] },
      { t: "ready", sid: ulid(), name: "writer", cursor: 0, roster, peers: [] },
    ],
  ],
  [
    "sent",
    { t: "sent", id: ulid(), results: [{ to: "reviewer@laptop", status: "routed" }, { to: "*", status: "queued" }] },
    [{ t: "sent", id: ulid(), results: [{ to: "a@b", status: "lost" }] }],
  ],
  ["deliver", { t: "deliver", cursor: 42, msg: send }, [{ t: "deliver", cursor: 42, msg: { ...send, extra: 1 } }]],
  [
    "receipt",
    { t: "receipt", id: ulid(), to: "reviewer@laptop", status: "expired" },
    [{ t: "receipt", id: "x", to: "reviewer@laptop", status: "expired" }],
  ],
  [
    "peers",
    { t: "peers", peers: [peer] },
    [{ t: "peers", peers: [{ ...peer, address: "*" }] }, { t: "peers", peers: [{ ...peer, rooms: ["ops"] }] }, { t: "peers", peers: [{ ...peer, sid: "x" }] }],
  ],
  ["peer", { t: "peer", peer }, [{ t: "peer", peer: { ...peer, since: -1 } }]],
  ["notice", { t: "notice", kind: "idle", of: "reviewer@laptop" }, [{ t: "notice", kind: "busy", of: "a@b" }]],
  [
    "roster",
    { t: "roster", chain, more: true },
    [
      { t: "roster", chain: [{ ...roster, extra: 1 }], more: false },
      { t: "roster", chain: [], more: false },
      { t: "roster", chain: Array.from({ length: LIMITS.rosterPageMax + 1 }, () => roster), more: false },
      { t: "roster", roster },
    ],
  ],
  ["join.request", { t: "join.request", join }, [{ t: "join.request", join: { ...join, extra: 1 } }]],
  ["joined", { t: "joined", chain, more: false }, [{ t: "joined", chain: [], more: false }, { t: "joined", chain }]],
  [
    "error",
    { t: "error", code: "unknown_type", message: "no such frame", ref: "frob" },
    [{ t: "error", code: "", message: "x" }, { t: "error", code: "x", message: "m".repeat(4097) }],
  ],
  [
    "room.joined",
    { t: "room.joined", room: "#ops", members: ["writer@laptop", "reviewer@admin"] },
    [{ t: "room.joined", room: "#ops", members: ["*"] }],
  ],
  [
    "room.history",
    { t: "room.history", room: "#ops", msgs: [{ cursor: 3, msg: send }], more: false },
    [{ t: "room.history", room: "#ops", msgs: [{ cursor: 3, msg: { ...send, seq: -1 } }], more: false }, { t: "room.history", room: "#ops", msgs: [] }],
  ],
  [
    "lease",
    { t: "lease", key: lkey, status: "held", holder: "writer@laptop", until: T0, token: 7 },
    [{ t: "lease", key: lkey, status: "stolen" }, { t: "lease", key: lkey, status: "granted", token: 0 }],
  ],
  [
    "leases",
    { t: "leases", leases: [{ key: lkey, holder: "writer@laptop", until: T0, token: 1 }] },
    [{ t: "leases", leases: [{ key: lkey, holder: "writer@laptop", until: T0 }] }],
  ],
  ["blob.stored", { t: "blob.stored", blob: blob.blob, index: 0 }, [{ t: "blob.stored", blob: blob.blob }]],
  [
    "blob.chunk",
    { t: "blob.chunk", blob: blob.blob, ...chunk },
    [{ t: "blob.chunk", blob: blob.blob, ...chunk, last: "yes" }, { t: "blob.chunk", blob: blob.blob, ...chunk, data: "AAAA" }],
  ],
  ["recover.ready", { t: "recover.ready", roster }, [{ t: "recover.ready" }, { t: "recover.ready", roster: { ...roster, seq: 0 } }]],
  ["invite.created", { t: "invite.created", invite: invite.inviteId }, [{ t: "invite.created", invite: "x" }, { t: "invite.created" }]],
  // pong has no fields to get wrong; unknown keys are kept like on every relay frame.
  ["pong", { t: "pong" }, []],
];

describe("parseClientFrame", () => {
  for (const [t, valid, invalid] of clientCases) {
    it(`accepts a valid ${t} and refuses invalid ones`, () => {
      const parsed = parseClientFrame(JSON.stringify(valid));
      expect(parsed).toEqual({ ok: true, value: JSON.parse(JSON.stringify(valid)) });
      expect(clientFrameSchema.safeParse(valid).success).toBe(true);
      for (const bad of invalid) expect(parseClientFrame(JSON.stringify(bad)), JSON.stringify(bad)).toEqual({ ok: false, reason: "malformed" });
    });
  }

  it("refuses unknown keys on client frames", () => {
    expect(parseClientFrame(JSON.stringify({ ...send, note: 1 }))).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("parseRelayFrame", () => {
  for (const [t, valid, invalid] of relayCases) {
    it(`accepts a valid ${t} and refuses invalid ones`, () => {
      const parsed = parseRelayFrame(JSON.stringify(valid));
      expect(parsed).toEqual({ ok: true, value: JSON.parse(JSON.stringify(valid)) });
      expect(relayFrameSchema.safeParse(valid).success).toBe(true);
      for (const bad of invalid) expect(parseRelayFrame(JSON.stringify(bad)), JSON.stringify(bad)).toEqual({ ok: false, reason: "malformed" });
    });
  }

  it("keeps unknown keys on relay frames and relay rows, but not inside signed objects", () => {
    const ready = { t: "ready", sid: ulid(), name: "w", cursor: 3, roster, more: false, peers: [{ ...peer, region: "x" }], future: { a: 1 } };
    expect(parseRelayFrame(JSON.stringify(ready))).toEqual({ ok: true, value: ready });
    const sent = { t: "sent", id: ulid(), results: [{ to: "a@b", status: "routed", hint: 1 }], v2: true };
    expect(parseRelayFrame(JSON.stringify(sent))).toEqual({ ok: true, value: sent });
    expect(parseRelayFrame(JSON.stringify({ t: "pong", extra: 1 }))).toMatchObject({ ok: true });
  });
});

describe("frame parsing edge cases", () => {
  it("refuses non-text, oversize input, non-JSON, non-objects and unknown types", () => {
    for (const parse of [parseClientFrame, parseRelayFrame]) {
      expect(parse(5 as unknown as string)).toEqual({ ok: false, reason: "not_text" });
      expect(parse(" ".repeat(LIMITS.receiveFrameBytes) + "{}")).toEqual({ ok: false, reason: "too_large" });
      expect(parse(`{"t":"ping","s":"${"\u00E9".repeat(LIMITS.receiveFrameBytes / 2)}"}`)).toEqual({ ok: false, reason: "too_large" });
      expect(parse("{")).toEqual({ ok: false, reason: "not_json" });
      expect(parse("")).toEqual({ ok: false, reason: "not_json" });
      for (const text of ["null", "[]", "5", '"ping"', "{}", '{"t":5}']) {
        expect(parse(text), text).toEqual({ ok: false, reason: "malformed" });
      }
      for (const t of ["frob", "__proto__", "toString", "constructor"]) {
        expect(parse(JSON.stringify({ t })), t).toEqual({ ok: false, reason: "unknown_type" });
      }
    }
    // Client and relay types are separate sets.
    expect(parseClientFrame('{"t":"pong"}')).toEqual({ ok: false, reason: "unknown_type" });
    expect(parseRelayFrame('{"t":"ping"}')).toEqual({ ok: false, reason: "unknown_type" });
  });

  it("accepts frames up to the limit: 1 MiB from clients, 1 MiB plus 4 KiB from relays", () => {
    const pad = (head: string, size: number) => head + "a".repeat(size - head.length - 2) + '"}';
    const client = pad('{"t":"ping","pad":"', LIMITS.frameBytes);
    // Strict client frames refuse the padding key, but only after the size check passed.
    expect(parseClientFrame(client)).toEqual({ ok: false, reason: "malformed" });
    expect(parseClientFrame(client + " ")).toEqual({ ok: false, reason: "too_large" });
    const relay = pad('{"t":"error","code":"x","message":"m","pad":"', LIMITS.receiveFrameBytes);
    expect(parseRelayFrame(relay).ok).toBe(true);
    expect(parseRelayFrame(relay + " ")).toEqual({ ok: false, reason: "too_large" });
  });

  it("refuses duplicate keys anywhere in a frame", () => {
    expect(parseClientFrame('{"t":"ack","cursor":1,"cursor":2}')).toEqual({ ok: false, reason: "duplicate_key" });
    expect(parseRelayFrame('{"t":"pong","x":{"a":1,"a":1}}')).toEqual({ ok: false, reason: "duplicate_key" });
  });

  it("before auth, allows only auth, join and create, up to 16 KiB", () => {
    const pre = { preAuth: true };
    expect(parseClientFrame(JSON.stringify(auth), pre).ok).toBe(true);
    expect(parseClientFrame(JSON.stringify({ t: "join", ...join }), pre).ok).toBe(true);
    expect(parseClientFrame(JSON.stringify({ t: "create", roster: chain[0] }), pre).ok).toBe(true);
    expect(parseClientFrame(JSON.stringify(send), pre)).toEqual({ ok: false, reason: "unknown_type" });
    expect(parseClientFrame('{"t":"ping"}', pre)).toEqual({ ok: false, reason: "unknown_type" });
    const big = JSON.stringify({ t: "create", roster: chain[0], key: "k".repeat(LIMITS.preAuthFrameBytes) });
    expect(parseClientFrame(big, pre)).toEqual({ ok: false, reason: "too_large" });
  });
});

describe("card frames", () => {
  const card = sealMessage({
    roster,
    sender: { deviceId: laptop.id, keys: laptop.keys },
    session: "writer",
    sid: ulid(),
    to: ["*"],
    seq: 2,
    at: T0,
    kind: "card",
    card: { title: "on it" },
    recipients: roster.devices.map((d) => d.id),
  });

  it("parses card.set, cards and card", () => {
    expect(parseClientFrame(JSON.stringify({ t: "card.set", msg: card })).ok).toBe(true);
    expect(parseClientFrame(JSON.stringify({ t: "card.set", msg: card, extra: 1 }))).toEqual({ ok: false, reason: "malformed" });
    expect(parseRelayFrame(JSON.stringify({ t: "cards", cards: [card, send] })).ok).toBe(true);
    expect(parseRelayFrame(JSON.stringify({ t: "cards", cards: [{ ...card, seq: -1 }] }))).toEqual({ ok: false, reason: "malformed" });
    expect(parseRelayFrame(JSON.stringify({ t: "card", msg: card })).ok).toBe(true);
    expect(parseRelayFrame(JSON.stringify({ t: "card" }))).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses card frames over 64 KiB, before the schema", () => {
    const pad = "x".repeat(LIMITS.cardFrameBytes);
    expect(parseClientFrame(JSON.stringify({ t: "card.set", msg: card, pad }))).toEqual({ ok: false, reason: "too_large" });
    expect(parseRelayFrame(JSON.stringify({ t: "card", msg: card, pad }))).toEqual({ ok: false, reason: "too_large" });
    // Other frames keep the 1 MiB limit.
    expect(parseRelayFrame(JSON.stringify({ t: "pong", pad })).ok).toBe(true);
  });
});

it("invite.create without a pin still parses (the field was added later)", () => {
  expect(parseClientFrame(JSON.stringify({ t: "invite.create", invite: invite.inviteId, exp: T0 })).ok).toBe(true);
});
