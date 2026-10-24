import { describe, expect, it } from "vitest";
import { TtlStore } from "../src/store.ts";
import { clock } from "./helpers.ts";

function store(max = 2, evictable = (v: { done: boolean }) => v.done) {
  const c = clock();
  return { c, s: new TtlStore<{ done: boolean }>({ max, ttlMs: 1000, now: c.now, evictable }) };
}

describe("TtlStore", () => {
  it("stores, finds and lists entries", () => {
    const { s } = store();
    expect(s.add("a", { done: false })).toBe(true);
    expect(s.get("a")).toEqual({ done: false });
    expect(s.get("nope")).toBeUndefined();
    expect(s.values()).toEqual([{ done: false }]);
    expect(s.size).toBe(1);
  });

  it("expires entries after their time to live, and touch restarts it", () => {
    const { c, s } = store();
    s.add("a", { done: false });
    s.add("b", { done: false });
    c.advance(600);
    s.touch("a");
    s.touch("unknown");
    c.advance(600);
    expect(s.get("b")).toBeUndefined();
    expect(s.get("a")).toEqual({ done: false });
    c.advance(1000);
    expect(s.values()).toEqual([]);
  });

  it("evicts the oldest evictable entry when full, and refuses when none may go", () => {
    const { s } = store();
    s.add("a", { done: false });
    s.add("b", { done: true });
    expect(s.add("c", { done: false })).toBe(true);
    expect(s.get("b")).toBeUndefined();
    expect(s.add("d", { done: false })).toBe(false);
    expect(s.size).toBe(2);
  });

  it("makes room from expired entries first", () => {
    const { c, s } = store();
    s.add("a", { done: false });
    s.add("b", { done: false });
    c.advance(1000);
    expect(s.add("c", { done: false })).toBe(true);
    expect(s.size).toBe(1);
  });
});
