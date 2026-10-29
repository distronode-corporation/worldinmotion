import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import {
  b64u,
  canonBytes,
  hash,
  LIMITS,
  nextRoster,
  openMessage,
  randomBytes,
  sealBlob,
  sealMessage,
  sha256,
  signObject,
  ulid,
  utf8,
  type LegacyBox,
  type Roster,
  type SendFrame,
  type SendHeader,
} from "../src/index.ts";
import { clone, device, mesh, T0, type Device } from "./helpers.ts";

const { admin, members, chain } = mesh(["laptop", "server"]);
const [laptop, server] = members as [Device, Device];
const roster = chain.at(-1)!;
const everyone = [admin, laptop, server];
const allIds = everyone.map((d) => d.id);
const laptopSid = ulid();
const serverSid = ulid();

function seal(over: Partial<Parameters<typeof sealMessage>[0]> = {}): SendFrame {
  return sealMessage({
    roster,
    sender: { deviceId: laptop.id, keys: laptop.keys },
    session: "writer",
    sid: laptopSid,
    to: ["reviewer@server"],
    seq: 1,
    at: T0,
    text: "hello",
    recipients: [server.id],
    ...over,
  });
}

function open(frame: unknown, me: Device, over: { address?: string; sid?: string; roster?: Roster; now?: number } = {}) {
  return openMessage(frame, {
    roster: over.roster ?? roster,
    me: { deviceId: me.id, keys: me.keys, address: over.address ?? `reviewer@${me.name}`, sid: over.sid ?? serverSid },
    now: over.now ?? T0,
  });
}

function header(over: Partial<SendHeader> = {}): SendHeader {
  return {
    t: "send",
    mesh: roster.mesh,
    id: ulid(),
    from: { device: laptop.id, session: "writer", sid: laptopSid },
    to: ["reviewer@server"],
    seq: 1,
    at: T0,
    roster: { seq: roster.seq, hash: hash(roster) },
    ...over,
  };
}

function body(h: SendHeader, over: Record<string, unknown> = {}) {
  return { v: 1, kind: "msg", id: h.id, from: h.from, to: h.to, at: h.at, roster: h.roster, text: "hi", ...over };
}

/**
 * Builds a send frame directly from SPEC section 6 with noble primitives, independent of
 * sealMessage. Used to check interoperability and to make frames sealMessage refuses to make.
 */
function craft(sender: Device, h: SendHeader, plaintext: Uint8Array, to: Device[]): SendFrame {
  const aad = sha256(canonBytes(h));
  const boxes: SendFrame["boxes"] = {};
  for (const r of to) {
    const shared = x25519.getSharedSecret(sender.keys.boxSec, r.keys.boxPub);
    const key = hkdf(nobleSha256, shared, utf8(h.mesh), utf8(`wim/1 box ${sender.id} ${r.id}`), 32);
    const nonce = randomBytes(24);
    boxes[r.id] = { n: b64u.encode(nonce), c: b64u.encode(xchacha20poly1305(key, nonce, aad).encrypt(plaintext)) };
  }
  return signObject("send", { ...h, boxes }, sender.keys.signSec) as SendFrame;
}

describe("seal and open", () => {
  it("round trips a unicast message", () => {
    const replyTo = ulid();
    const frame = seal({ reply_to: replyTo });
    expect(frame).toMatchObject({ mesh: roster.mesh, roster: { seq: roster.seq, hash: hash(roster) } });
    expect(frame.from).toEqual({ device: laptop.id, session: "writer", sid: laptopSid });
    expect(Object.keys(frame.boxes)).toEqual([server.id]);
    expect(b64u.decode((frame.boxes[server.id] as LegacyBox).n)).toHaveLength(24);
    expect(open(frame, server)).toEqual({
      ok: true,
      value: {
        v: 1,
        kind: "msg",
        id: frame.id,
        from: frame.from,
        to: frame.to,
        at: T0,
        roster: frame.roster,
        text: "hello",
        reply_to: replyTo,
      },
    });
    expect(open(JSON.parse(JSON.stringify(frame)), server).ok).toBe(true);
  });

  it("round trips a 3-device broadcast, sibling sessions sharing one box", () => {
    const frame = seal({ to: ["*"], recipients: allIds, text: "to everyone \u{1F600}" });
    expect(Object.keys(frame.boxes).sort()).toEqual([...allIds].sort());
    for (const me of everyone) {
      const result = open(frame, me, { address: `any@${me.name}` });
      expect(result.ok && result.value.text).toBe("to everyone \u{1F600}");
    }
    // Two sessions on the server device read the very same box.
    const a = open(frame, server, { address: "one@server", sid: ulid() });
    const b = open(clone(frame), server, { address: "two@server", sid: ulid() });
    expect(a).toEqual(b);
    // The sending session does not receive its own broadcast; its sibling on the same device does.
    expect(open(frame, laptop, { address: "writer@laptop", sid: laptopSid })).toEqual({ ok: false, reason: "own_broadcast" });
    expect(open(frame, laptop, { address: "other@laptop", sid: ulid() }).ok).toBe(true);
  });

  it("delivers a broadcast that also names this session", () => {
    const frame = seal({ to: ["*", "writer@laptop"], recipients: allIds });
    expect(open(frame, laptop, { address: "writer@laptop", sid: laptopSid }).ok).toBe(true);
  });

  it("interoperates with a frame built directly from the spec", () => {
    const h = header();
    expect(open(craft(laptop, h, canonBytes(body(h)), [server]), server)).toMatchObject({ ok: true, value: { text: "hi" } });
  });

  it("uses a distinct key per direction", () => {
    const frame = seal({ recipients: [server.id, laptop.id] });
    expect(frame.boxes[server.id]!.c).not.toBe(frame.boxes[laptop.id]!.c);
    expect(open(frame, laptop, { address: "reviewer@server" }).ok).toBe(true);
  });

  it("accepts a sender that saw an older roster", () => {
    const extra = device("extra");
    const newer = nextRoster(roster, { add: [extra.record] }, admin, T0 + 100);
    expect(open(seal(), server, { roster: newer }).ok).toBe(true);
  });
});

describe("roster checks", () => {
  const extra = device("extra");
  const newer = nextRoster(roster, { add: [extra.record] }, admin, T0 + 100);

  it("asks for the chain when the sender saw a newer roster", () => {
    expect(open(seal({ roster: newer }), server)).toEqual({ ok: false, reason: "roster_behind" });
  });

  it("reports a fork when the same seq has a different hash", () => {
    const fork = nextRoster(roster, { add: [device("other").record] }, admin, T0 + 100);
    expect(open(seal({ roster: newer }), server, { roster: fork })).toEqual({ ok: false, reason: "roster_fork" });
  });

  it("drops a sender the receiver's roster revokes, or does not know", () => {
    const revoked = nextRoster(roster, { revoke: [laptop.id] }, admin, T0 + 100);
    expect(open(seal(), server, { roster: revoked })).toEqual({ ok: false, reason: "sender_revoked" });
    const outsider = device("outsider");
    const h = header({ from: { device: outsider.id, session: "x", sid: ulid() } });
    expect(open(craft(outsider, h, canonBytes(body(h)), [server]), server)).toEqual({ ok: false, reason: "unknown_sender" });
  });

  it("drops a frame for another mesh", () => {
    expect(open({ ...seal(), mesh: mesh().chain[0]!.mesh }, server)).toEqual({ ok: false, reason: "wrong_mesh" });
  });
});

describe("addressing and freshness", () => {
  it("drops a message not addressed to this session", () => {
    expect(open(seal(), server, { address: "other@server" })).toEqual({ ok: false, reason: "not_addressed" });
  });

  it("drops a message older than 47 hours or more than 10 minutes ahead", () => {
    const frame = seal();
    expect(open(frame, server, { now: T0 + LIMITS.messageMaxAgeMs }).ok).toBe(true);
    expect(open(frame, server, { now: T0 + LIMITS.messageMaxAgeMs + 1 })).toEqual({ ok: false, reason: "too_old" });
    expect(open(frame, server, { now: T0 - LIMITS.messageMaxFutureMs }).ok).toBe(true);
    expect(open(frame, server, { now: T0 - LIMITS.messageMaxFutureMs - 1 })).toEqual({ ok: false, reason: "too_new" });
  });
});

describe("tampering", () => {
  const frame = seal({ recipients: [server.id, admin.id] });

  it("refuses a changed header field", () => {
    for (const changed of [
      { ...frame, seq: 2 },
      { ...frame, to: ["other@server", "reviewer@server"] },
      { ...frame, from: { ...frame.from, session: "mallory" } },
      { ...frame, from: { ...frame.from, sid: ulid() } },
      { ...frame, roster: { seq: 1, hash: hash(chain[0]) } },
    ]) {
      expect(open(changed, server)).toEqual({ ok: false, reason: "bad_signature" });
    }
  });

  it("refuses a box swapped between devices, even when re-signed", () => {
    const swapped = { ...frame, boxes: { [server.id]: frame.boxes[admin.id]!, [admin.id]: frame.boxes[server.id]! } };
    expect(open(swapped, server)).toEqual({ ok: false, reason: "bad_signature" });
    expect(open(signObject("send", swapped, laptop.keys.signSec), server)).toEqual({ ok: false, reason: "decrypt_failed" });
  });

  it("refuses altered ciphertext and nonce", () => {
    const box = frame.boxes[server.id] as LegacyBox;
    const c = b64u.decode(box.c);
    c[0]! ^= 1;
    const n = b64u.decode(box.n);
    n[0]! ^= 1;
    for (const altered of [{ ...box, c: b64u.encode(c) }, { ...box, n: b64u.encode(n) }]) {
      const tampered = { ...frame, boxes: { ...frame.boxes, [server.id]: altered } };
      expect(open(tampered, server)).toEqual({ ok: false, reason: "bad_signature" });
      expect(open(signObject("send", tampered, laptop.keys.signSec), server)).toEqual({ ok: false, reason: "decrypt_failed" });
    }
  });

  it("refuses a header changed and re-signed, because the box AAD no longer matches", () => {
    expect(open(signObject("send", { ...frame, seq: 9 }, laptop.keys.signSec), server)).toEqual({
      ok: false,
      reason: "decrypt_failed",
    });
  });

  it("refuses the wrong sender key and a forged signature", () => {
    const impostor = device("laptop");
    const withKey = (field: "sign" | "box"): Roster => ({
      ...roster,
      devices: roster.devices.map((d) => (d.id === laptop.id ? { ...d, [field]: impostor.record[field] } : d)),
    });
    const refTo = (r: Roster) => header({ roster: { seq: r.seq, hash: hash(r) } });
    // The receiver's roster holds a different signing key for the sender.
    const signSwapped = withKey("sign");
    const h1 = refTo(signSwapped);
    expect(open(craft(laptop, h1, canonBytes(body(h1)), [server]), server, { roster: signSwapped })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(open(signObject("send", frame, impostor.keys.signSec), server)).toEqual({ ok: false, reason: "bad_signature" });
    // A signature of another type over the same object is refused.
    expect(open(signObject("auth", frame, laptop.keys.signSec), server)).toEqual({ ok: false, reason: "bad_signature" });
    // Right signing key, different box key for the sender: the box does not open.
    const boxSwapped = withKey("box");
    const h2 = refTo(boxSwapped);
    expect(open(craft(laptop, h2, canonBytes(body(h2)), [server]), server, { roster: boxSwapped })).toEqual({
      ok: false,
      reason: "decrypt_failed",
    });
  });

  it("refuses a frame without a box for this device", () => {
    const h = header();
    expect(open(craft(laptop, h, canonBytes(body(h)), [admin]), server)).toEqual({ ok: false, reason: "no_box" });
  });

  it("refuses a plaintext that does not match its header, even signed with the real key", () => {
    const h = header();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ id: ulid() }, "id_mismatch"],
      [{ from: { ...h.from, session: "other" } }, "from_mismatch"],
      [{ from: { ...h.from, sid: ulid() } }, "from_mismatch"],
      [{ from: { ...h.from, device: server.id } }, "from_mismatch"],
      [{ to: ["*"] }, "to_mismatch"],
      [{ to: ["reviewer@server", "x@y"] }, "to_mismatch"],
      [{ at: T0 + 1 }, "at_mismatch"],
      [{ roster: { seq: 1, hash: h.roster.hash } }, "roster_mismatch"],
      [{ roster: { seq: h.roster.seq, hash: hash(chain[0]) } }, "roster_mismatch"],
    ];
    for (const [over, reason] of cases) {
      expect(open(craft(laptop, h, canonBytes(body(h, over)), [server]), server), reason).toEqual({ ok: false, reason });
    }
  });

  it("refuses a malformed, duplicated or non-canonical plaintext", () => {
    const h = header();
    const canonical = new TextDecoder().decode(canonBytes(body(h)));
    const plaintexts = [
      utf8("not json"),
      canonBytes(body(h, { v: 2 })),
      canonBytes(body(h, { kind: "other" })),
      canonBytes(body(h, { extra: true })),
      canonBytes(body(h, { text: "x".repeat(LIMITS.textBytes + 1) })),
      utf8(canonical.replace("{", '{"text":"evil",')),
      utf8(canonical.replace("{", "{ ")),
      utf8(JSON.stringify(body(h))),
    ];
    for (const p of plaintexts) {
      expect(open(craft(laptop, h, p, [server]), server), new TextDecoder().decode(p).slice(0, 40)).toEqual({
        ok: false,
        reason: "plaintext_malformed",
      });
    }
    expect(open(craft(laptop, h, new Uint8Array([0xff]), [server]), server)).toEqual({ ok: false, reason: "decrypt_failed" });
  });

  it("refuses malformed frames", () => {
    expect(open(null, server)).toEqual({ ok: false, reason: "malformed" });
    expect(open({ ...frame, extra: 1 }, server)).toEqual({ ok: false, reason: "malformed" });
    expect(open({ ...frame, boxes: {} }, server)).toEqual({ ok: false, reason: "malformed" });
    const { roster: _r, ...noRoster } = frame;
    expect(open(noRoster, server)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("limits and input checks", () => {
  const extra = device("extra");
  const four = nextRoster(roster, { add: [extra.record] }, admin, T0 + 100);

  it("accepts text of exactly 256 KiB and refuses one byte more", () => {
    const max = "a".repeat(LIMITS.textBytes);
    expect(open(seal({ text: max }), server).ok).toBe(true);
    expect(() => seal({ text: max + "a" })).toThrow(/262144/);
    expect(() => seal({ text: "\u00e9".repeat(LIMITS.textBytes / 2 + 1) })).toThrow(RangeError);
    expect(() => seal({ text: 5 as unknown as string })).toThrow(RangeError);
  });

  it("refuses a broadcast whose frame would be over 1 MiB", () => {
    const text = "a".repeat(200 * 1024);
    expect(() => seal({ to: ["*"], recipients: allIds, text })).not.toThrow();
    expect(() => seal({ roster: four, to: ["*"], recipients: [...allIds, extra.id], text })).toThrow(/over 1048576 bytes/);
  });

  it("refuses text that looks like it carries a credential", () => {
    expect(() => seal({ text: "my key is AKIAIOSFODNN7EXAMPLE ok" })).toThrow(/aws_access_key_id/);
    // The error names the pattern, never the secret itself.
    let message = "";
    try {
      seal({ text: "AKIAIOSFODNN7EXAMPLE" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/aws_access_key_id/);
    expect(message).not.toMatch(/IOSFODNN/);
  });

  it("refuses bad recipients", () => {
    expect(() => seal({ recipients: [] })).toThrow(/at least one recipient/);
    expect(() => seal({ recipients: "x" as unknown as string[] })).toThrow(/at least one recipient/);
    expect(() => seal({ recipients: [server.id, server.id] })).toThrow(/duplicate recipient/);
    expect(() => seal({ recipients: [extra.id] })).toThrow(/not a current device/);
    expect(() => seal({ to: ["*"], recipients: [server.id] })).toThrow(/every device/);
    const zeroBox: Roster = { ...roster, devices: roster.devices.map((d) => (d.id === server.id ? { ...d, box: b64u.encode(new Uint8Array(32)) } : d)) };
    // A low-order box key is refused by X25519 rather than producing a predictable key.
    expect(() => seal({ roster: zeroBox })).toThrow();
  });

  it("refuses malformed input before sealing", () => {
    expect(() => seal({ sender: { deviceId: server.id, keys: laptop.keys } })).toThrow(/does not match/);
    expect(() => seal({ roster: chain[0]! })).toThrow(/sender is not a current device/);
    expect(() => seal({ session: "Bad Name" })).toThrow(/from.session/);
    expect(() => seal({ sid: "nope" })).toThrow(/from.sid/);
    expect(() => seal({ to: [] })).toThrow(/to/);
    expect(() => seal({ seq: -1 })).toThrow(/seq/);
    expect(() => seal({ id: "nope" })).toThrow(/id/);
    expect(() => seal({ at: 1.5 })).toThrow(TypeError);
    expect(() => seal({ text: "\uD800" })).toThrow(/surrogate/);
  });
});

describe("message kinds", () => {
  const blob = sealBlob(utf8("file body"));
  const file = { blob: blob.blob, name: "notes.txt", size: blob.size, mime: "text/plain", key: blob.key, sha256: blob.sha256, chunks: 1 };

  it("round trips a task with a deadline, a result and a file", () => {
    const task = seal({ kind: "task", text: "run the tests", deadline: T0 + 3600_000 });
    expect(open(task, server)).toMatchObject({ ok: true, value: { kind: "task", deadline: T0 + 3600_000, text: "run the tests" } });
    expect(open(seal({ kind: "task", text: "no deadline" }), server)).toMatchObject({ ok: true, value: { kind: "task" } });
    const result = seal({ kind: "result", text: "all green", reply_to: task.id, status: "done" });
    expect(open(result, server)).toMatchObject({ ok: true, value: { kind: "result", status: "done", reply_to: task.id } });
    const sent = seal({ kind: "file", file, text: undefined });
    const opened = open(sent, server);
    expect(opened).toMatchObject({ ok: true, value: { kind: "file", file } });
    expect(opened.ok && "text" in opened.value).toBe(false);
    expect(open(seal({ kind: "file", file, text: "the notes" }), server)).toMatchObject({ ok: true, value: { text: "the notes" } });
  });

  it("validates each kind's fields before sealing", () => {
    expect(() => seal({ kind: "task", text: "t", deadline: T0 })).toThrow(/deadline/);
    expect(() => seal({ kind: "task", text: "t", deadline: T0 + LIMITS.taskDeadlineMaxMs + 1 })).toThrow(/deadline/);
    expect(seal({ kind: "task", text: "t", deadline: T0 + LIMITS.taskDeadlineMaxMs }).t).toBe("send");
    expect(() => seal({ kind: "result", text: "r", status: "done" })).toThrow(/reply_to/);
    expect(() => seal({ kind: "result", text: "r", reply_to: ulid() })).toThrow(/status/);
    expect(() => seal({ kind: "result", text: "r", reply_to: ulid(), status: "maybe" as "done" })).toThrow(/status/);
    expect(() => seal({ kind: "file", text: undefined })).toThrow(/file/);
    expect(() => seal({ kind: "file", file: { ...file, name: "../etc/passwd" } })).toThrow(/file.name/);
    expect(() => seal({ kind: "msg", text: "m", deadline: T0 + 1 })).toThrow(TypeError);
    expect(() => seal({ kind: "other" as "msg", text: "m" })).toThrow(/kind/);
    expect(() => seal({ kind: "task", text: undefined })).toThrow(RangeError);
  });

  it("refuses an unknown kind or misplaced fields on open", () => {
    const h = header();
    for (const over of [{ kind: "note" }, { kind: "result", status: "done" }, { kind: "msg", status: "done" }, { kind: "task", deadline: T0 }]) {
      expect(open(craft(laptop, h, canonBytes(body(h, over)), [server]), server), JSON.stringify(over)).toEqual({
        ok: false,
        reason: "plaintext_malformed",
      });
    }
  });
});

describe("rooms", () => {
  it("delivers a room send to members and not to others or the sender", () => {
    const frame = seal({ to: ["#ops"], recipients: allIds });
    expect(open(frame, server, { address: "reviewer@server" })).toEqual({ ok: false, reason: "not_addressed" });
    const member = { address: "reviewer@server", rooms: ["#ops"] };
    expect(openMessage(frame, { roster, now: T0, me: { deviceId: server.id, keys: server.keys, sid: serverSid, ...member } }).ok).toBe(true);
    expect(
      openMessage(frame, { roster, now: T0, me: { deviceId: server.id, keys: server.keys, sid: serverSid, address: "a@server", rooms: ["#dev"] } }),
    ).toEqual({ ok: false, reason: "not_addressed" });
    expect(
      openMessage(frame, { roster, now: T0, me: { deviceId: laptop.id, keys: laptop.keys, sid: laptopSid, address: "writer@laptop", rooms: ["#ops"] } }),
    ).toEqual({ ok: false, reason: "own_broadcast" });
  });

  it("opens old room history without the freshness check when asked", () => {
    const frame = seal({ to: ["#ops"], recipients: allIds });
    const me = { deviceId: server.id, keys: server.keys, sid: serverSid, address: "reviewer@server", rooms: ["#ops"] };
    const later = T0 + 6 * 24 * 3600_000;
    expect(openMessage(frame, { roster, now: later, me })).toEqual({ ok: false, reason: "too_old" });
    expect(openMessage(frame, { roster, now: later, me, history: true }).ok).toBe(true);
    expect(openMessage({ ...frame, seq: 2 }, { roster, now: later, me, history: true })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("includes the reader's own room and broadcast sends in history, and nothing else changes", () => {
    const me = { deviceId: laptop.id, keys: laptop.keys, sid: laptopSid, address: "writer@laptop", rooms: ["#ops"] };
    for (const to of [["#ops"], ["*"]]) {
      const frame = seal({ to, recipients: allIds, text: "my own proposal" });
      // Live, the sending session never receives its own send; read back as history, it is there.
      expect(openMessage(frame, { roster, now: T0, me })).toEqual({ ok: false, reason: "own_broadcast" });
      expect(openMessage(frame, { roster, now: T0, me, history: true })).toMatchObject({ ok: true, value: { text: "my own proposal" } });
      // Every other check still applies to the reader's own messages.
      expect(openMessage({ ...frame, seq: 9 }, { roster, now: T0, me, history: true })).toEqual({ ok: false, reason: "bad_signature" });
      expect(openMessage(frame, { roster, now: T0, me: { ...me, rooms: [] }, history: true })).toEqual(
        to[0] === "*" ? expect.objectContaining({ ok: true }) : { ok: false, reason: "not_addressed" },
      );
    }
  });

  it("needs a box for every device, as a broadcast does", () => {
    expect(() => seal({ to: ["#ops"], recipients: [server.id] })).toThrow(/every device/);
  });
});

describe("allowSecrets", () => {
  it("lets a person send text that looks like a credential, and nothing else changes", () => {
    const text = "the test key is AKIA" + "IOSFODNN7EXAMPLE";
    expect(() => seal({ text })).toThrow(/aws_access_key_id/);
    expect(open(seal({ text, allowSecrets: true }), server)).toMatchObject({ ok: true, value: { text } });
    expect(() => seal({ text, allowSecrets: false })).toThrow(/aws_access_key_id/);
  });
});

describe("peer cards", () => {
  const card = { cwd: "/home/me/project", branch: "main", title: "fixing the login bug" };

  it("seals a card to every device and opens it as history", () => {
    const frame = seal({ kind: "card", card, text: undefined, to: ["*"], recipients: allIds });
    const opened = openMessage(frame, { roster, now: T0 + 30 * 24 * 3600_000, history: true, me: { deviceId: server.id, keys: server.keys, sid: serverSid, address: "reviewer@server" } });
    expect(opened).toMatchObject({ ok: true, value: { kind: "card", card } });
    expect(opened.ok && "text" in opened.value).toBe(false);
    expect(open(seal({ kind: "card", card: {}, text: undefined, to: ["*"], recipients: allIds }), server).ok).toBe(true);
  });

  it("refuses a card with text, to anything but *, over-long fields, secrets or over 64 KiB", () => {
    const ok = { kind: "card" as const, card, to: ["*"], recipients: allIds };
    expect(() => seal({ ...ok, text: "hi" })).toThrow(TypeError);
    expect(() => seal({ ...ok, text: undefined, to: ["reviewer@server"], recipients: [server.id] })).toThrow(/to/);
    expect(() => seal({ ...ok, text: undefined, to: ["*", "reviewer@server"] })).toThrow(/to/);
    expect(() => seal({ ...ok, text: undefined, card: { cwd: "x".repeat(513) } })).toThrow(/card.cwd/);
    expect(() => seal({ ...ok, text: undefined, card: { branch: "x".repeat(256) } })).toThrow(/card.branch/);
    expect(() => seal({ ...ok, text: undefined, card: { title: "x".repeat(121) } })).toThrow(/card.title/);
    expect(() => seal({ ...ok, text: undefined, card: { title: "ghp_" + "Ab3".repeat(12) } })).toThrow(/github_token/);
    expect(seal({ ...ok, text: undefined, card: { cwd: "x".repeat(512), branch: "y".repeat(255), title: "z".repeat(120) } }).t).toBe("send");
    // The 64 KiB card frame limit: a mesh of many devices makes the frame too big.
    let big = roster;
    for (let i = 0; i < 70; i++) big = nextRoster(big, { add: [device(`d${i}`).record] }, admin, T0 + 200 + i);
    const allBig = big.devices.map((d) => d.id);
    expect(() => seal({ ...ok, roster: big, text: undefined, recipients: allBig, card: { cwd: "x".repeat(512) } })).toThrow(/over 65536/);
  });
});

describe("revision 4 receive rules", () => {
  it("round trips relayed text, and keeps it out when not set", () => {
    expect(open(seal({ relayed: true }), server)).toMatchObject({ ok: true, value: { relayed: true } });
    const plain = open(seal({ relayed: false }), server);
    expect(plain.ok && "relayed" in plain.value).toBe(false);
    const h = header();
    expect(open(craft(laptop, h, canonBytes(body(h, { relayed: false })), [server]), server)).toEqual({ ok: false, reason: "plaintext_malformed" });
  });

  it("never boxes to recovery records, and drops what they send", () => {
    const rec = device("recovery", "admin");
    const withRec = nextRoster(roster, { add: [rec.record] }, admin, T0 + 100);
    // A broadcast skips the recovery record, whether or not the caller lists it.
    const all = withRec.devices.map((d) => d.id);
    const frame = seal({ roster: withRec, to: ["*"], recipients: all });
    expect(Object.keys(frame.boxes)).not.toContain(rec.id);
    expect(Object.keys(seal({ roster: withRec, to: ["*"], recipients: allIds }).boxes)).toHaveLength(3);
    expect(() => seal({ roster: withRec, recipients: [rec.id] })).toThrow(/recovery record/);
    // A send signed by the recovery record is dropped.
    const h = header({ from: { device: rec.id, session: "x", sid: ulid() }, roster: { seq: withRec.seq, hash: hash(withRec) } });
    expect(open(craft(rec, h, canonBytes(body(h)), [server]), server, { roster: withRec })).toEqual({ ok: false, reason: "recovery_sender" });
  });

  it("parks an unknown sender that names a newer roster, but checks a known sender's signature first", () => {
    const outsider = device("outsider");
    const h = header({ from: { device: outsider.id, session: "x", sid: ulid() }, roster: { seq: roster.seq + 1, hash: h0() } });
    expect(open(craft(outsider, h, canonBytes(body(h)), [server]), server)).toEqual({ ok: false, reason: "roster_behind" });
    // A forged frame from a known sender naming a newer roster fails on its signature, so it cannot
    // make the receiver fetch rosters or raise a fork alarm.
    const forged = { ...seal(), roster: { seq: roster.seq + 1, hash: h0() } };
    expect(open(forged, server)).toEqual({ ok: false, reason: "bad_signature" });
    expect(open({ ...seal(), roster: { seq: roster.seq, hash: h0() } }, server)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("gives cards seq 0 and refuses a mismatch between seq 0 and kind", () => {
    const card = seal({ kind: "card", card: { title: "t" }, text: undefined, to: ["*"], recipients: allIds, seq: 9 });
    expect(card.seq).toBe(0);
    const h = header({ seq: 0 });
    expect(open(craft(laptop, h, canonBytes(body(h)), [server]), server)).toEqual({ ok: false, reason: "seq_kind_mismatch" });
    const hc = header({ seq: 3, to: ["*"] });
    const cardBody = { v: 1, kind: "card", id: hc.id, from: hc.from, to: hc.to, at: hc.at, roster: hc.roster, card: {} };
    expect(open(craft(laptop, hc, canonBytes(cardBody), [server]), server, { address: "x@server" })).toEqual({ ok: false, reason: "seq_kind_mismatch" });
  });
});

function h0(): string {
  return b64u.encode(sha256(utf8("some other roster")));
}

describe("derived messages", () => {
  it("round trips derived on every text kind, and keeps it out when not set", () => {
    expect(open(seal({ derived: true }), server)).toMatchObject({ ok: true, value: { derived: true } });
    expect(open(seal({ kind: "task", text: "t", derived: true, relayed: true }), server)).toMatchObject({
      ok: true,
      value: { kind: "task", derived: true, relayed: true },
    });
    const plain = open(seal({ derived: false }), server);
    expect(plain.ok && "derived" in plain.value).toBe(false);
    const h = header();
    expect(open(craft(laptop, h, canonBytes(body(h, { derived: false })), [server]), server)).toEqual({ ok: false, reason: "plaintext_malformed" });
  });
});
