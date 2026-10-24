// Property-based tests: each property holds for every input fast-check generates, not only for
// the examples in the other test files. They cover the code that reads bytes from the network or
// from a peer (JSON, frames, sealed messages, ULIDs, base64url) and the code that makes peer text
// safe to show (sanitizeForDisplay, frameForAgent).
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  b64u,
  canon,
  canonBytes,
  clientFrameSchema,
  frameForAgent,
  fromUtf8,
  hash,
  hasDuplicateKeys,
  isUlid,
  LIMITS,
  openMessage,
  parseClientFrame,
  parseJson,
  parseRecoverAuthFrame,
  parseRelayFrame,
  randomBytes,
  relayFrameSchema,
  sanitizeForDisplay,
  sha256,
  signObject,
  ulid,
  ulidTime,
  utf8,
  type SendFrame,
  type SendHeader,
} from "../src/index.ts";
import { device, mesh, T0, type Device } from "./helpers.ts";

// ---- generators ----

/** Any string of whole code points (never an unpaired surrogate). */
const text = fc.string({ unit: "binary", maxLength: 40 });

/** Any sequence of UTF-16 code units, unpaired surrogates included. */
const codeUnits = fc
  .array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 40 })
  .map((units) => String.fromCharCode(...units));

/** A value `canon` accepts: null, booleans, safe integers, strings, arrays and plain objects. */
const { canonValue } = fc.letrec((tie) => ({
  canonValue: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.constant(null),
    fc.boolean(),
    fc.maxSafeInteger(),
    text,
    fc.array(tie("canonValue"), { maxLength: 5 }),
    fc.dictionary(text, tie("canonValue"), { maxKeys: 5 }),
  ),
}));

/** Characters SPEC section 6a says must be escaped for display, mixed with ordinary text. */
const HIDDEN_SAMPLES = [
  "\u0000", "\u0007", "\u000B", "\u000D", "\u001B", "\u007F", "\u0085", "\u009B", "\u00AD", "\u061C",
  "\u180E", "\u200B", "\u200C", "\u200D", "\u200E", "\u200F", "\u2028", "\u2029", "\u202A", "\u202E",
  "\u2060", "\u2066", "\u2069", "\uFEFF", "\u{E0001}", "\u{E0041}", "\u{E007F}", "\u{E0100}", "\u{E01EF}",
  "\uD800", "\uDBFF", "\uDC00", "\uDFFF",
  // Other format and default-ignorable characters, variation selectors among them.
  "\u034F", "\u0600", "\u06DD", "\u115F", "\u17B4", "\u180B", "\u180F", "\u206A", "\u3164",
  "\uFE00", "\uFE06", "\uFE0E", "\uFE0F", "\uFFA0", "\uFFF0", "\uFFF9", "\uFFFB", "\u{110BD}",
  "\u{13430}", "\u{1BCA0}", "\u{1D173}", "\u{E0080}", "\u{E01F0}", "\u{E0FFF}",
];
const VISIBLE_SAMPLES = ["a", "Z", " ", "\t", "\n", "<", ">", "<<<wim", "é", "中", "😀", "👩", "💻", "\u{1F3FD}", "\u{1F600}\uFE0F", "\u2764\uFE0E", "1\uFE0F\u20E3"];
const mixedText = fc.oneof(
  text,
  codeUnits,
  fc.array(fc.constantFrom(...HIDDEN_SAMPLES, ...VISIBLE_SAMPLES), { maxLength: 30 }).map((parts) => parts.join("")),
);

/**
 * What must never reach a screen unescaped (SPEC section 6a): C0 and C1 controls other than tab
 * and newline, line and paragraph separators, every format character and default-ignorable code
 * point, and unpaired surrogates. The one exception is a single presentation selector (U+FE0E or
 * U+FE0F) directly after a character that can be drawn as an emoji.
 */
const MUST_ESCAPE =
  /(?![\t\n])\p{Cc}|\p{Zl}|\p{Zp}|(?![\uFE0E\uFE0F])[\p{Cf}\p{Default_Ignorable_Code_Point}]|(?<!\p{Emoji})[\uFE0E\uFE0F]|[\uD800-\uDFFF]/u;

const ESCAPE = /<U\+([0-9A-F]{4,6})>/g;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_TIME = 2 ** 48 - 1;

/** A string in the canonical ULID form: first digit 0 to 7, then 25 Crockford base32 digits. */
const ulidString = fc
  .tuple(fc.constantFrom(..."01234567"), fc.string({ unit: fc.constantFrom(...CROCKFORD), minLength: 25, maxLength: 25 }))
  .map(([first, rest]) => first + rest);

// ---- canonical JSON ----

/** `\uXXXX` for every code unit: the same JSON string, spelled differently. */
function escapeAll(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) out += `\\u${s.charCodeAt(i).toString(16).padStart(4, "0")}`;
  return `${out}"`;
}

describe("canon", () => {
  it("is valid JSON that parses back to the same value", () => {
    fc.assert(
      fc.property(canonValue, (value) => {
        const out = canon(value);
        expect(JSON.parse(out)).toEqual(value);
        const parsed = parseJson(out);
        expect(parsed.ok).toBe(true);
        // Canonical text is a fixed point: encoding what it decodes to gives the same bytes.
        expect(canon(parsed.ok ? parsed.value : undefined)).toBe(out);
        expect(fromUtf8(canonBytes(value))).toBe(out);
      }),
    );
  });

  it("writes object keys in UTF-16 code unit order, whatever the insertion order", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(text, canonValue), { selector: ([k]) => k, maxLength: 8 }),
        fc.infiniteStream(fc.nat()),
        (entries, picks) => {
          const shuffled = [...entries];
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = picks.next().value % (i + 1);
            [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
          }
          const a = Object.fromEntries(entries);
          const b = Object.fromEntries(shuffled);
          expect(canon(b)).toBe(canon(a));
          // Spelled out for one level: integer-like keys ("10", "9") sort as strings too, though
          // JavaScript enumerates them numerically.
          const keys = entries.map(([k]) => k).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
          expect(canon(a)).toBe(`{${keys.map((k) => `${JSON.stringify(k)}:${canon(a[k])}`).join(",")}}`);
        },
      ),
    );
  });

  it("throws a TypeError for an unpaired surrogate anywhere in a value", () => {
    const lone = fc
      .tuple(text, fc.integer({ min: 0xd800, max: 0xdfff }), text)
      .map(([before, unit, after]) => before + String.fromCharCode(unit) + after);
    fc.assert(
      fc.property(lone, fc.constantFrom("value", "key", "nested"), (s, where) => {
        const value = where === "value" ? s : where === "key" ? { [s]: 1 } : [{ a: [s] }];
        expect(() => canon(value)).toThrow(TypeError);
      }),
    );
  });

  it("throws a TypeError for a number that is not a safe integer", () => {
    const unsafe = fc.double().filter((n) => !Number.isSafeInteger(n));
    fc.assert(
      fc.property(unsafe, (n) => {
        expect(() => canon({ n })).toThrow(TypeError);
      }),
    );
  });
});

// ---- JSON parsing ----

/** Text near JSON: random code units, JSON, and JSON with one character inserted, deleted or replaced. */
const jsonish = fc.oneof(
  codeUnits,
  fc.json(),
  // Mostly invalid, sometimes not; an unterminated string is a common result.
  fc.tuple(fc.json(), fc.nat(), fc.constantFrom("", '"', "\\", "{", "}", "[", "]", ",", ":", "0")).map(
    ([json, at, c]) => json.slice(0, at % (json.length + 1)) + c + json.slice((at % (json.length + 1)) + (c === "" ? 1 : 0)),
  ),
);

describe("parseJson", () => {
  it("never throws, and refuses exactly what JSON.parse refuses plus duplicate keys", () => {
    fc.assert(
      fc.property(jsonish, (s) => {
        const result = parseJson(s);
        let valid = true;
        try {
          JSON.parse(s);
        } catch {
          valid = false;
        }
        if (!valid) expect(result).toEqual({ ok: false, reason: "not_json" });
        else if (!result.ok) expect(result.reason).toBe("duplicate_key");
      }),
    );
  });

  it("hasDuplicateKeys always returns, and throws a SyntaxError exactly when JSON.parse refuses the text", () => {
    fc.assert(
      fc.property(jsonish, (s) => {
        let valid = true;
        try {
          JSON.parse(s);
        } catch {
          valid = false;
        }
        if (valid) expect(hasDuplicateKeys(s)).toBe(parseJson(s).ok === false);
        else expect(() => hasDuplicateKeys(s)).toThrow(SyntaxError);
      }),
    );
  });

  it("accepts any JSON without repeated keys, compact or indented", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.constantFrom(undefined, 2, "\t"), (value, indent) => {
        const result = parseJson(JSON.stringify(value, null, indent));
        expect(result.ok).toBe(true);
        expect(result.ok ? result.value : undefined).toEqual(JSON.parse(JSON.stringify(value)));
      }),
    );
  });

  it("finds a repeated key at any depth, however the second copy is escaped", () => {
    const wrapper = fc.array(fc.constantFrom("array", "object"), { maxLength: 6 });
    fc.assert(
      fc.property(text, fc.jsonValue(), fc.jsonValue(), wrapper, (key, a, b, wraps) => {
        let s = `{${JSON.stringify(key)}:${JSON.stringify(a)},${escapeAll(key)}:${JSON.stringify(b)}}`;
        for (const w of wraps) s = w === "array" ? `[0,${s}]` : `{"k":${s},"z":[]}`;
        expect(parseJson(s)).toEqual({ ok: false, reason: "duplicate_key" });
      }),
    );
  });
});

// ---- frame parsers ----

const clientTypes = clientFrameSchema.options.flatMap((o) => [...o.shape.t.values]);
const relayTypes = relayFrameSchema.options.flatMap((o) => [...o.shape.t.values]);
const FRAME_REASONS = ["not_text", "too_large", "not_json", "duplicate_key", "unknown_type", "malformed"];

/** Frame-shaped text: a known or unknown `t`, with arbitrary other fields. */
const frameText = fc.oneof(
  codeUnits,
  fc.json(),
  fc
    .tuple(fc.constantFrom(...clientTypes, ...relayTypes, "", "__proto__", "constructor", "toString"), fc.dictionary(fc.string(), fc.jsonValue(), { maxKeys: 6 }))
    .map(([t, rest]) => JSON.stringify({ ...rest, t })),
  // Deep nesting under a known type: parsing must stay iterative or bounded.
  fc
    .tuple(fc.constantFrom("send", "auth", "deliver", "roster"), fc.integer({ min: 1, max: 5000 }))
    .map(([t, depth]) => `{"t":"${t}","x":${"[".repeat(depth)}${"]".repeat(depth)}}`),
);

const parsers: Array<[string, (s: string) => { ok: boolean; reason?: string }]> = [
  ["parseClientFrame", (s) => parseClientFrame(s)],
  ["parseClientFrame (preAuth)", (s) => parseClientFrame(s, { preAuth: true })],
  ["parseRecoverAuthFrame", (s) => parseRecoverAuthFrame(s)],
  ["parseRelayFrame", (s) => parseRelayFrame(s)],
];

describe("frame parsers", () => {
  it.each(parsers)("%s never throws and only returns a documented reason", (_name, parse) => {
    fc.assert(
      fc.property(frameText, (s) => {
        const result = parse(s);
        if (!result.ok) expect(FRAME_REASONS).toContain(result.reason);
      }),
    );
  });

  it.each(parsers)("%s refuses anything that is not a string as not_text", (_name, parse) => {
    fc.assert(
      fc.property(fc.anything().filter((v) => typeof v !== "string"), (v) => {
        expect(parse(v as string)).toEqual({ ok: false, reason: "not_text" });
      }),
      { numRuns: 30 },
    );
  });

  it("refuses an over-limit frame as too_large before reading it", () => {
    fc.assert(
      fc.property(fc.constantFrom(...parsers), fc.nat({ max: 64 }), ([name, parse], extra) => {
        const limit = name === "parseRelayFrame" ? LIMITS.receiveFrameBytes : name === "parseClientFrame" ? LIMITS.frameBytes : LIMITS.preAuthFrameBytes;
        // Not JSON at all, so only the size check can be what refuses it.
        expect(parse("{".repeat(limit + 1 + extra))).toEqual({ ok: false, reason: "too_large" });
      }),
      { numRuns: 20 },
    );
  });
});

// ---- sealed messages from an authenticated but hostile sender ----

const { members, chain } = mesh(["laptop", "server"]);
const [laptop, server] = members as [Device, Device];
const roster = chain.at(-1)!;
const laptopSid = ulid();
const serverSid = ulid();

const OPEN_REASONS = [
  "malformed", "wrong_mesh", "sender_revoked", "roster_behind", "unknown_sender", "recovery_sender",
  "bad_signature", "roster_fork", "not_addressed", "own_broadcast", "too_old", "too_new", "no_box",
  "decrypt_failed", "plaintext_malformed", "seq_kind_mismatch", "id_mismatch", "from_mismatch",
  "to_mismatch", "at_mismatch", "roster_mismatch",
];

function header(): SendHeader {
  return {
    t: "send",
    mesh: roster.mesh,
    id: ulid(),
    from: { device: laptop.id, session: "writer", sid: laptopSid },
    to: ["reviewer@server"],
    seq: 1,
    at: T0,
    roster: { seq: roster.seq, hash: hash(roster) },
  };
}

/** A send frame built from SPEC section 6 with noble primitives and signed by a real roster member. */
function craft(h: Record<string, unknown>, plaintext: Uint8Array, boxes?: Record<string, unknown>): SendFrame {
  const aad = sha256(canonBytes(h));
  const shared = x25519.getSharedSecret(laptop.keys.boxSec, server.keys.boxPub);
  const key = hkdf(nobleSha256, shared, utf8(roster.mesh), utf8(`wim/1 box ${laptop.id} ${server.id}`), 32);
  const nonce = randomBytes(24);
  const box = { n: b64u.encode(nonce), c: b64u.encode(xchacha20poly1305(key, nonce, aad).encrypt(plaintext)) };
  return signObject("send", { ...h, boxes: boxes ?? { [server.id]: box } }, laptop.keys.signSec) as SendFrame;
}

function open(frame: unknown) {
  return openMessage(frame, {
    roster,
    me: { deviceId: server.id, keys: server.keys, address: "reviewer@server", sid: serverSid },
    now: T0,
  });
}

function expectDocumented(result: ReturnType<typeof open>, plaintext?: Uint8Array): void {
  if (!result.ok) expect(OPEN_REASONS).toContain(result.reason);
  // Anything accepted is the one canonical encoding of what was decrypted.
  else if (plaintext !== undefined) expect(canonBytes(result.value)).toEqual(plaintext);
}

describe("openMessage", () => {
  const validBody = (h: SendHeader) => ({ v: 1, kind: "msg", id: h.id, from: h.from, to: h.to, at: h.at, roster: h.roster, text: "hi" });
  const bodyField = fc.constantFrom("v", "kind", "id", "from", "to", "at", "roster", "text", "reply_to", "status", "card", "file", "deadline", "relayed", "derived", "extra");

  it("never throws on any decrypted plaintext from a signed frame", () => {
    const plaintext = fc.oneof(
      fc.uint8Array({ maxLength: 200 }),
      codeUnits.map((s) => utf8(s)),
      fc.json().map((s) => utf8(s)),
      // A valid body with one field set to something arbitrary, canonically or loosely encoded.
      fc.tuple(bodyField, canonValue, fc.boolean()).map(([field, value, canonical]) => {
        const b: Record<string, unknown> = { ...validBody(header()), [field]: value };
        return canonical ? canonBytes(b) : utf8(JSON.stringify(b, null, 1));
      }),
    );
    fc.assert(
      fc.property(plaintext, (bytes) => {
        expectDocumented(open(craft(header(), bytes)), bytes);
      }),
    );
  });

  it("never throws when a signed frame's header or boxes hold arbitrary values", () => {
    const headerField = fc.constantFrom("t", "mesh", "id", "from", "to", "seq", "at", "roster", "extra");
    fc.assert(
      fc.property(headerField, canonValue, fc.option(fc.dictionary(fc.constantFrom(server.id, laptop.id, "x"), canonValue, { maxKeys: 2 })), (field, value, boxes) => {
        const h = { ...header(), [field]: value };
        const bytes = canonBytes(validBody(header()));
        expectDocumented(open(craft(h, bytes, boxes ?? undefined)));
      }),
    );
  });

  it("never throws on an arbitrary value in place of a frame", () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        expectDocumented(open(v));
      }),
    );
  });

  it("accepts a well-formed message whatever its text, and returns that text", () => {
    fc.assert(
      fc.property(text, (t) => {
        const h = header();
        const bytes = canonBytes({ ...validBody(h), text: t });
        const result = open(craft(h, bytes));
        expect(result.ok && result.value.text).toBe(t);
      }),
      { numRuns: 50 },
    );
  });
});

// ---- display and agent framing ----

describe("sanitizeForDisplay", () => {
  it("leaves no control, bidirectional, zero-width or tag character, and no unpaired surrogate", () => {
    fc.assert(
      fc.property(mixedText, (s) => {
        expect(sanitizeForDisplay(s)).not.toMatch(MUST_ESCAPE);
      }),
    );
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(mixedText, (s) => {
        const once = sanitizeForDisplay(s);
        expect(sanitizeForDisplay(once)).toBe(once);
      }),
    );
  });

  it("keeps tabs, newlines and visible text as they are", () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom(...VISIBLE_SAMPLES) }), (s) => {
        expect(sanitizeForDisplay(s)).toBe(s);
      }),
    );
  });

  it("escapes a hidden character as its own code point, and only hidden characters", () => {
    fc.assert(
      fc.property(mixedText.filter((s) => !s.includes("<")), (s) => {
        const out = sanitizeForDisplay(s);
        for (const [, hex] of out.matchAll(ESCAPE)) {
          const cp = Number.parseInt(hex!, 16);
          const c = cp >= 0xd800 && cp <= 0xdfff ? String.fromCharCode(cp) : String.fromCodePoint(cp);
          expect(s).toContain(c);
          // A visible letter, digit, mark, punctuation or symbol is never escaped. Variation
          // selectors are marks, but default-ignorable: they render as nothing.
          expect(c).not.toMatch(/^(?!\p{Default_Ignorable_Code_Point})[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u);
        }
      }),
    );
  });
});

describe("frameForAgent", () => {
  it("keeps any peer text inside its block: exactly three marker lines, and nothing hidden but emoji joiners", () => {
    const from = "writer@laptop";
    const id = ulid();
    const deviceId = device("laptop").id;
    fc.assert(
      fc.property(mixedText, fc.constantFrom(undefined, "msg", "task"), fc.boolean(), (t, kind, relayed) => {
        const framed = frameForAgent({ from, deviceId, at: T0, id, kind, text: t, relayed });
        const lines = framed.split("\n");
        expect(lines.filter((l) => l.includes("<<<wim"))).toHaveLength(3);
        expect(lines.at(-1)).toMatch(/^<<<wim-end [A-Za-z0-9_-]{16}>>>$/);
        const body = framed.slice(framed.indexOf(">>>\n", framed.indexOf("<<<wim-text")) + 4, framed.lastIndexOf("\n<<<wim-end"));
        expect(body.replaceAll("\u200D", "")).not.toMatch(MUST_ESCAPE);
      }),
    );
  });
});

// ---- ULIDs ----

describe("ulid", () => {
  it("issues strictly increasing ids whose time is the latest clock reading so far", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: MAX_TIME - 1000 }), { minLength: 1, maxLength: 20 }), (times) => {
        // The generator is process-wide, so earlier calls set a floor under the clock. This test
        // moves that floor close to 2^48, so it runs after every other test here that calls ulid().
        let previous = ulid(0);
        let latest = ulidTime(previous);
        for (const t of times) {
          const id = ulid(t);
          latest = Math.max(latest, t);
          expect(isUlid(id)).toBe(true);
          expect(id > previous).toBe(true);
          expect(ulidTime(id)).toBe(latest);
          previous = id;
        }
      }),
    );
  });

  it("refuses a time that is not an integer from 0 to 2^48 - 1", () => {
    const bad = fc.oneof(
      fc.double().filter((n) => !Number.isSafeInteger(n)),
      fc.integer({ max: -1 }),
      fc.integer({ min: MAX_TIME + 1, max: Number.MAX_SAFE_INTEGER }),
    );
    fc.assert(
      fc.property(bad, (t) => {
        expect(() => ulid(t)).toThrow(RangeError);
      }),
    );
  });
});

describe("ULID parsing", () => {
  it("reads the time of any canonical ULID as a 48-bit integer", () => {
    fc.assert(
      fc.property(ulidString, (s) => {
        expect(isUlid(s)).toBe(true);
        const t = ulidTime(s);
        expect(Number.isSafeInteger(t) && t >= 0 && t <= MAX_TIME).toBe(true);
        // An independent reading of the same ten digits.
        const expected = [...s.slice(0, 10)].reduce((acc, ch) => acc * 32n + BigInt(CROCKFORD.indexOf(ch)), 0n);
        expect(BigInt(t)).toBe(expected);
      }),
    );
  });

  it("accepts a string as a ULID exactly when ulidTime can read it", () => {
    const candidate = fc.oneof(
      codeUnits,
      ulidString,
      // Near misses: lower case, a letter Crockford leaves out, or the wrong length.
      ulidString.map((s) => s.toLowerCase()),
      fc.tuple(ulidString, fc.nat({ max: 25 }), fc.constantFrom("I", "L", "O", "U", "8", "-", " ")).map(([s, i, c]) => s.slice(0, i) + c + s.slice(i + 1)),
      ulidString.map((s) => s.slice(1)),
      ulidString.map((s) => `${s}0`),
    );
    fc.assert(
      fc.property(candidate, (s) => {
        let readable = true;
        try {
          ulidTime(s);
        } catch (e) {
          expect(e).toBeInstanceOf(TypeError);
          readable = false;
        }
        expect(isUlid(s)).toBe(readable);
      }),
    );
  });
});

// ---- base64url ----

describe("b64u", () => {
  it("round trips any bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 100 }), (bytes) => {
        expect(b64u.decode(b64u.encode(bytes))).toEqual(bytes);
      }),
    );
  });

  it("accepts only the one canonical encoding of any byte string", () => {
    const candidate = fc.oneof(
      fc.string({ unit: fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"), maxLength: 30 }),
      fc.string({ unit: fc.constantFrom(..."AQgw_-=+/ \né"), maxLength: 12 }),
      codeUnits,
    );
    fc.assert(
      fc.property(candidate, (s) => {
        let bytes: Uint8Array;
        try {
          bytes = b64u.decode(s);
        } catch (e) {
          expect(e).toBeInstanceOf(TypeError);
          return;
        }
        expect(b64u.encode(bytes)).toBe(s);
      }),
    );
  });
});
