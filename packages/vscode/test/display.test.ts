import { isName, isRoom, sanitizeForDisplay, sessionAddressSchema } from "@worldinmotion/protocol";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ADDRESS_RE, clock, deviceOf, duration, isTarget, NAME_RE, nameOf, noIcons, notice, oneLine, ROOM_RE, size, stamp, visible } from "../src/display.ts";

describe("visible", () => {
  it("escapes the same characters as the protocol's sanitizeForDisplay, for every code point", () => {
    const chunk: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      chunk.push(String.fromCodePoint(cp));
      if (chunk.length === 4096 || cp === 0x10ffff) {
        const text = chunk.join("");
        expect(visible(text)).toBe(sanitizeForDisplay(text));
        chunk.length = 0;
      }
    }
  });

  it("keeps presentation selectors exactly where the protocol's sanitizeForDisplay does", () => {
    const parts = ["a", "1", "\u2764", "\u{1F600}", "\u200D", "\uFE00", "\uFE0E", "\uFE0F", "\u20E3", "\uD83D"];
    for (const a of parts) {
      for (const b of parts) {
        for (const c of parts) expect(visible(a + b + c), JSON.stringify(a + b + c)).toBe(sanitizeForDisplay(a + b + c));
      }
    }
    expect(visible("\u{1F600}\uFE0F\uFE0F")).toBe("\u{1F600}\uFE0F<U+FE0F>");
    expect(visible("\u2764\uFE0E")).toBe("\u2764\uFE0E");
  });

    it("escapes an unpaired surrogate but keeps a pair", () => {
    expect(visible("a\uD800b")).toBe("a<U+D800>b");
    expect(visible("\u{1F600}")).toBe("\u{1F600}");
  });

  it("keeps tabs and newlines, and makes bidirectional controls visible", () => {
    expect(visible("a\tb\nc\u202Ed")).toBe("a\tb\nc<U+202E>d");
  });
});

describe("oneLine", () => {
  it("folds whitespace and trims", () => {
    expect(oneLine("  a \n\t b  ")).toBe("a b");
  });
  it("truncates with an ellipsis", () => {
    expect(oneLine("abcdef", 4)).toBe(`abc${String.fromCharCode(0x2026)}`);
    expect(oneLine("abcd", 4)).toBe("abcd");
  });
});

describe("noIcons and notice", () => {
  it("breaks icon syntax", () => {
    expect(noIcons("$(zap) go $(x)")).toBe("$ (zap) go $ (x)");
  });
  it("breaks link syntax and icons and folds lines", () => {
    expect(notice("[click](command:evil)\n$(zap)")).toBe("[click] (command:evil) $ (zap)");
  });
  it("caps the length", () => {
    expect(notice("x".repeat(400)).length).toBe(300);
  });
});

describe("addresses", () => {
  it("splits name and device", () => {
    expect(deviceOf("a@b")).toBe("b");
    expect(deviceOf("#ops")).toBe("");
    expect(deviceOf("plain")).toBe("");
    expect(nameOf("a@b")).toBe("a");
    expect(nameOf("plain")).toBe("plain");
  });
  it("recognises targets in the client's grammar only", () => {
    expect(isTarget("coder@buildbox")).toBe(true);
    expect(isTarget("#ops")).toBe(true);
    expect(isTarget("[x](command:y)")).toBe(false);
    expect(isTarget("Coder@box")).toBe(false);
  });
});

describe("the name grammar", () => {
  // The extension keeps its own copy of the grammar: importing the protocol package would bundle
  // its crypto. These hold the copy to the protocol's on every edge of the grammar.
  const chars = ["a", "z", "0", "9", "-", "A", "_", ".", "@", "#", " ", "\u00e9", "\n"];
  const names = [
    "",
    ...chars.flatMap((a) => chars.map((b) => `${a}${b}`)),
    ...chars.map((c) => `a${c}z`),
    ...[31, 32, 33].flatMap((n) => ["a".repeat(n), `-${"a".repeat(n - 1)}`, `${"a".repeat(n - 1)}-`]),
  ];

  it("matches the protocol's names", () => {
    for (const n of names) expect(NAME_RE.test(n), JSON.stringify(n)).toBe(isName(n));
  });

  it("matches the protocol's addresses and rooms", () => {
    const parts = names.filter((_, i) => i % 3 === 0);
    for (const a of parts) {
      expect(ROOM_RE.test(`#${a}`), JSON.stringify(a)).toBe(isRoom(`#${a}`));
      expect(ROOM_RE.test(a), JSON.stringify(a)).toBe(isRoom(a));
      for (const b of parts) {
        const address = `${a}@${b}`;
        expect(ADDRESS_RE.test(address), JSON.stringify(address)).toBe(sessionAddressSchema.safeParse(address).success);
      }
    }
    expect(ADDRESS_RE.test("a@b@c")).toBe(sessionAddressSchema.safeParse("a@b@c").success);
  });

  it("is the pattern the sessionName setting declares", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      contributes: { configuration: { properties: Record<string, { pattern?: string }> } };
    };
    expect(pkg.contributes.configuration.properties["worldinmotion.sessionName"]!.pattern).toBe(NAME_RE.source);
  });
});

describe("formatting", () => {
  it("formats local times", () => {
    const at = new Date(2026, 0, 2, 3, 4, 5).getTime();
    expect(clock(at)).toBe("03:04:05");
    expect(stamp(at)).toBe("2026-01-02 03:04:05");
  });
  it("formats durations", () => {
    expect(duration(850)).toBe("850 ms");
    expect(duration(4200)).toBe("4.2 s");
    expect(duration(180_000)).toBe("3 min");
    expect(duration(7_200_000)).toBe("2 h");
  });
  it("formats sizes", () => {
    expect(size(512)).toBe("512 B");
    expect(size(3482)).toBe("3.4 KiB");
    expect(size(1_300_000)).toBe("1.2 MiB");
  });
});
