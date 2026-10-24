import { describe, expect, it } from "vitest";
import { checkFreshness, dedupeExpiry, LIMITS, SeqTracker, ulid } from "../src/index.ts";
import { device, T0 } from "./helpers.ts";

describe("checkFreshness", () => {
  it("accepts from 47 hours old to 10 minutes ahead, inclusive", () => {
    expect(checkFreshness(T0, T0)).toEqual({ ok: true, value: true });
    expect(checkFreshness(T0 - LIMITS.messageMaxAgeMs, T0).ok).toBe(true);
    expect(checkFreshness(T0 - LIMITS.messageMaxAgeMs - 1, T0)).toEqual({ ok: false, reason: "too_old" });
    expect(checkFreshness(T0 + LIMITS.messageMaxFutureMs, T0).ok).toBe(true);
    expect(checkFreshness(T0 + LIMITS.messageMaxFutureMs + 1, T0)).toEqual({ ok: false, reason: "too_new" });
  });

  it("remembers ids longer than they stay acceptable", () => {
    expect(dedupeExpiry(T0)).toBe(T0 + 48 * 3600_000 + 10 * 60_000);
    // The last moment a message with this `at` is still fresh is before its id may be forgotten.
    expect(T0 + LIMITS.messageMaxAgeMs).toBeLessThan(dedupeExpiry(T0));
  });
});

describe("SeqTracker", () => {
  const a = device("a").id;
  const b = device("b").id;
  const sid = ulid();

  it("reports ok and duplicates per device and session, ignoring jumps", () => {
    const t = new SeqTracker();
    expect(t.observe(a, sid, 1)).toBe("ok");
    expect(t.observe(a, sid, 2)).toBe("ok");
    expect(t.observe(a, sid, 2)).toBe("dup");
    expect(t.observe(a, sid, 1)).toBe("dup");
    expect(t.observe(a, sid, 5)).toBe("ok");
    expect(t.observe(a, sid, 4)).toBe("dup");
    // Another session, and the same sid on another device, are tracked separately.
    const other = ulid();
    expect(t.observe(a, other, 3)).toBe("ok");
    expect(t.observe(b, sid, 1)).toBe("ok");
    expect(t.highest(a, sid)).toBe(5);
    expect(t.highest(b, ulid())).toBe(0);
  });

  it("round trips through JSON", () => {
    const t = new SeqTracker();
    t.observe(a, sid, 3);
    t.observe(b, sid, 1);
    const json = JSON.parse(JSON.stringify(t)) as unknown;
    expect(json).toEqual({ v: 1, entries: [[a, sid, 3], [b, sid, 1]] });
    const back = SeqTracker.fromJSON(json);
    expect(back.observe(a, sid, 3)).toBe("dup");
    expect(back.observe(a, sid, 4)).toBe("ok");
    expect(back.toJSON()).toEqual({ v: 1, entries: [[a, sid, 4], [b, sid, 1]] });
  });

  it("refuses bad input", () => {
    const t = new SeqTracker();
    expect(() => t.observe(a, sid, 0)).toThrow(RangeError);
    expect(() => t.observe(a, sid, 1.5)).toThrow(RangeError);
    expect(() => t.observe(5 as unknown as string, sid, 1)).toThrow(TypeError);
    expect(() => t.observe(a, null as unknown as string, 1)).toThrow(TypeError);
    for (const bad of [null, 5, {}, { v: 2, entries: [] }, { v: 1 }, { v: 1, entries: "x" }]) {
      expect(() => SeqTracker.fromJSON(bad), JSON.stringify(bad)).toThrow(/not a tracker/);
    }
    expect(() => SeqTracker.fromJSON({ v: 1, entries: [[a, sid]] })).toThrow(/bad row/);
    expect(() => SeqTracker.fromJSON({ v: 1, entries: ["row"] })).toThrow(/bad row/);
    expect(() => SeqTracker.fromJSON({ v: 1, entries: [[a, sid, -1]] })).toThrow(RangeError);
  });
});
