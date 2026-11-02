import { describe, expect, it } from "vitest";
import { b64u, bytesEqual, canon, canonBytes, fitsUtf8, fromUtf8, hash, hmacSha256, sha256, utf8 } from "../src/index.ts";

describe("canon", () => {
  it("encodes scalars", () => {
    expect(canon(null)).toBe("null");
    expect(canon(true)).toBe("true");
    expect(canon(false)).toBe("false");
    expect(canon(0)).toBe("0");
    expect(canon(-0)).toBe("0");
    expect(canon(-42)).toBe("-42");
    expect(canon(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
    expect(canon(Number.MIN_SAFE_INTEGER)).toBe("-9007199254740991");
    expect(canon("hi")).toBe('"hi"');
  });

  it("sorts keys by UTF-16 code unit at every level", () => {
    expect(canon({ b: 1, a: 2, A: 3, _: 4, "1": 5 })).toBe('{"1":5,"A":3,"_":4,"a":2,"b":1}');
    expect(canon({ z: { y: 1, x: [{ d: 1, c: 2 }] }, a: [] })).toBe('{"a":[],"z":{"x":[{"c":2,"d":1}],"y":1}}');
    // U+1F600 sorts before U+E000: its first UTF-16 code unit is 0xD83D. Code point order would
    // put it last, which is the mistake this guards against.
    expect(canon({ "\u{1F600}": 1, "\uE000": 2 })).toBe('{"\u{1F600}":1,"\uE000":2}');
  });

  it("keeps array order and omits undefined object values", () => {
    expect(canon([3, 1, 2])).toBe("[3,1,2]");
    expect(canon({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canon(Object.assign(Object.create(null) as object, { k: "v" }))).toBe('{"k":"v"}');
  });

  it("escapes strings like JSON.stringify and keeps non-ASCII as is", () => {
    expect(canon('q"b\\s/\n\r\t\b\f\u0001\u001f')).toBe('"q\\"b\\\\s/\\n\\r\\t\\b\\f\\u0001\\u001f"');
    expect(canon("caf\u00E9 \u{1F600}")).toBe('"caf\u00E9 \u{1F600}"');
    expect(canon({ "k\n": 1 })).toBe('{"k\\n":1}');
  });

  it("allows the same object twice when it is not a cycle", () => {
    const shared = { x: 1 };
    expect(canon([shared, shared])).toBe('[{"x":1},{"x":1}]');
  });

  it("refuses every value it cannot encode exactly", () => {
    const bad: unknown[] = [
      1.5,
      NaN,
      Infinity,
      -Infinity,
      2 ** 53,
      1e21,
      10n,
      undefined,
      () => 1,
      Symbol("s"),
      new Date(0),
      new Map(),
      new Uint8Array(1),
      [undefined],
      // eslint-disable-next-line no-sparse-arrays
      [1, , 2],
      "\uD800",
      "a\uDC00b",
      { "\uD800": 1 },
      { [Symbol("k")]: 1 },
      { a: 0.1 },
    ];
    for (const value of bad) expect(() => canon(value), String(typeof value)).toThrow(TypeError);
  });

  it("refuses cycles and excessive depth", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => canon(cyclic)).toThrow(/cyclic/);
    let deep: unknown = 1;
    for (let i = 0; i < 65; i++) deep = [deep];
    expect(() => canon(deep)).toThrow(/nesting/);
    let ok: unknown = 1;
    for (let i = 0; i < 64; i++) ok = { a: ok };
    expect(canon(ok).length).toBeGreaterThan(0);
  });

  it("canonBytes is the UTF-8 of canon", () => {
    expect(fromUtf8(canonBytes({ b: "\u00E9", a: 1 }))).toBe('{"a":1,"b":"\u00E9"}');
  });
});

describe("b64u", () => {
  it("round trips every length and matches RFC 4648 vectors", () => {
    const vectors: Array<[string, string]> = [
      ["", ""],
      ["f", "Zg"],
      ["fo", "Zm8"],
      ["foo", "Zm9v"],
      ["foob", "Zm9vYg"],
      ["fooba", "Zm9vYmE"],
      ["foobar", "Zm9vYmFy"],
    ];
    for (const [text, enc] of vectors) {
      expect(b64u.encode(utf8(text))).toBe(enc);
      expect(fromUtf8(b64u.decode(enc))).toBe(text);
    }
    const all = new Uint8Array(256).map((_, i) => i);
    for (let n = 0; n <= all.length; n++) {
      const bytes = all.subarray(0, n);
      expect(b64u.decode(b64u.encode(bytes))).toEqual(bytes);
    }
    expect(b64u.encode(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
  });

  it("refuses invalid input", () => {
    for (const bad of ["Z", "Zm9vY", "Zg==", "Zm+v", "Zm/v", "Zm9 ", "\u00E9a", "\u{1F600}aa", "Zh", "Zm9"]) {
      expect(() => b64u.decode(bad), bad).toThrow(TypeError);
    }
    expect(() => b64u.decode(42 as unknown as string)).toThrow(/not a string/);
  });
});

describe("hashing and bytes", () => {
  it("hmacSha256 matches the RFC 4231 vector", () => {
    const mac = hmacSha256(utf8("Jefe"), utf8("what do ya want for nothing?"));
    expect(Buffer.from(mac).toString("hex")).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  it("sha256 matches the FIPS 180-2 vector", () => {
    expect(b64u.encode(sha256(utf8("abc")))).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
  });

  it("hash is b64u(sha256(canon(x))) and ignores key order", () => {
    expect(hash({ a: 1, b: 2 })).toBe(hash({ b: 2, a: 1 }));
    expect(hash({ a: 1 })).toBe(b64u.encode(sha256(utf8('{"a":1}'))));
    expect(hash({ a: 1 })).toHaveLength(43);
  });

  it("bytesEqual compares content", () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });

  it("fitsUtf8 counts bytes, not code units", () => {
    expect(fitsUtf8("abc", 3)).toBe(true);
    expect(fitsUtf8("abcd", 3)).toBe(false);
    expect(fitsUtf8("\u00E9\u00E9", 3)).toBe(false);
    expect(fitsUtf8("\u00E9", 2)).toBe(true);
  });

  it("fromUtf8 refuses invalid UTF-8", () => {
    expect(() => fromUtf8(new Uint8Array([0xff]))).toThrow();
    expect(fromUtf8(utf8("\uFEFFx"))).toBe("\uFEFFx");
  });
});
