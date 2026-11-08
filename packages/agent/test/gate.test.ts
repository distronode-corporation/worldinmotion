import * as crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { codeMatches, parseProfile, stripCode } from "../src/gate.ts";

vi.mock("node:crypto", async (orig) => {
  const real = await orig<typeof import("node:crypto")>();
  return { ...real, timingSafeEqual: vi.fn(real.timingSafeEqual) };
});

describe("codeMatches", () => {
  it("matches the code only", () => {
    expect(codeMatches("s3cret", "s3cret")).toBe(true);
    expect(codeMatches("s3cre", "s3cret")).toBe(false);
    expect(codeMatches("s3cretX", "s3cret")).toBe(false);
    expect(codeMatches("S3cret", "s3cret")).toBe(false);
    expect(codeMatches("", "")).toBe(false);
  });

  it("compares fixed-length digests in constant time, whatever the lengths given", () => {
    const tse = vi.mocked(crypto.timingSafeEqual);
    tse.mockClear();
    codeMatches("x", "a much longer wake code");
    codeMatches("a much longer wake code than the code", "short");
    expect(tse).toHaveBeenCalledTimes(2);
    for (const [a, b] of tse.mock.calls) {
      expect((a as Buffer).length).toBe(32);
      expect((b as Buffer).length).toBe(32);
    }
  });
});

describe("stripCode", () => {
  it("takes the first word as the code and returns the rest", () => {
    expect(stripCode("  s3cret   b: do it  ", "s3cret")).toEqual({ ok: true, rest: "b: do it" });
    expect(stripCode("s3cret\ndo it", "s3cret")).toEqual({ ok: true, rest: "do it" });
    expect(stripCode("s3cret", "s3cret")).toEqual({ ok: true, rest: "" });
  });

  it("refuses a wrong, glued or missing code", () => {
    expect(stripCode("wrong do it", "s3cret")).toEqual({ ok: false });
    expect(stripCode("s3cretdo it", "s3cret")).toEqual({ ok: false });
    expect(stripCode("do s3cret it", "s3cret")).toEqual({ ok: false });
    expect(stripCode("", "s3cret")).toEqual({ ok: false });
  });
});

describe("parseProfile", () => {
  const allowed = ["a", "b"];
  it("takes an allowed prefix", () => {
    expect(parseProfile("b: list files", allowed, "a")).toEqual({ ok: true, profile: "b", task: "list files" });
    expect(parseProfile("a:\nlist", allowed, "a")).toEqual({ ok: true, profile: "a", task: "list" });
    expect(parseProfile("b:", allowed, "a")).toEqual({ ok: true, profile: "b", task: "" });
  });

  it("uses the default when there is no prefix", () => {
    expect(parseProfile("list files", allowed, "a")).toEqual({ ok: true, profile: "a", task: "list files" });
    expect(parseProfile("see https://example.com", allowed, "a")).toEqual({ ok: true, profile: "a", task: "see https://example.com" });
    expect(parseProfile("b:c list", allowed, "a")).toEqual({ ok: true, profile: "a", task: "b:c list" });
    expect(parseProfile("a.b: list", allowed, "a")).toEqual({ ok: true, profile: "a", task: "a.b: list" });
  });

  it("refuses a prefix that is not allowed, rather than run it under the default", () => {
    expect(parseProfile("c: list files", allowed, "a")).toEqual({ ok: false });
    expect(parseProfile("B: list files", allowed, "a")).toEqual({ ok: false });
  });
});
