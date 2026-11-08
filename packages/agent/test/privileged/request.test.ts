import { describe, expect, it } from "vitest";
import { chooseProfile, EXIT, MAX_REQUEST_BYTES, parseRequest, Refusal, stripCode, usableCode } from "../../src/privileged/request.ts";
import { request } from "./helpers.ts";

const buf = (o: unknown) => Buffer.from(JSON.stringify(o));

function refusal(fn: () => unknown): Refusal {
  try {
    fn();
  } catch (error) {
    if (error instanceof Refusal) return error;
    throw error;
  }
  throw new Error("no refusal");
}

describe("parseRequest", () => {
  it("reads the contract's object", () => {
    expect(parseRequest(buf(request()))).toEqual(request());
  });
  it("refuses an oversized request as refused, before parsing", () => {
    expect(refusal(() => parseRequest(Buffer.alloc(MAX_REQUEST_BYTES + 1, 0x20))).code).toBe(EXIT.refused);
  });
  it("refuses bytes that are not UTF-8 or not JSON as a bad request", () => {
    expect(refusal(() => parseRequest(Buffer.from([0xff, 0xfe]))).code).toBe(EXIT.usage);
    expect(refusal(() => parseRequest(Buffer.from("{"))).code).toBe(EXIT.usage);
  });
  it.each([
    ["an extra key", request({ extra: 1 })],
    ["version 2", request({ v: 2 })],
    ["a bad id", request({ id: "a b" })],
    ["a bad device", request({ from: { device: "x y", address: "a@b" } })],
    ["an extra from key", request({ from: { device: "d", address: "a@b", name: "x" } })],
    ["a NUL in the text", request({ text: "a\0b" })],
    ["not an object", 7],
  ])("refuses %s, naming where but never the text", (_what, raw) => {
    const r = refusal(() => parseRequest(buf(raw)));
    expect(r.code).toBe(EXIT.usage);
    expect(r.message).not.toContain("a\0b");
  });
  it("names (top) for a request that is not an object", () => {
    expect(refusal(() => parseRequest(buf(7))).message).toMatch(/\(top\)/);
  });
});

describe("usableCode", () => {
  it("wants 16 or more characters and no whitespace", () => {
    expect(usableCode("0123456789abcdef")).toBe(true);
    expect(usableCode("0123456789abcde")).toBe(false);
    expect(usableCode("0123456789 abcdef")).toBe(false);
  });
});

describe("stripCode", () => {
  const code = "wake-0123456789abcdef";
  it("strips the code and keeps the rest", () => {
    expect(stripCode(`${code} b: do it`, code)).toBe(" b: do it");
    expect(stripCode(`${code}\ndo it`, code)).toBe("\ndo it");
    expect(stripCode(code, code)).toBe("");
  });
  it("refuses a wrong code, a short text, no code and a code run on into a word", () => {
    expect(stripCode(`wake-0123456789abcdeX do it`, code)).toBeUndefined();
    expect(stripCode("wake", code)).toBeUndefined();
    expect(stripCode("do it", code)).toBeUndefined();
    expect(stripCode(`${code}x do it`, code)).toBeUndefined();
  });
  it("refuses a text that is the code's prefix padded with NULs", () => {
    expect(stripCode("wake-0123456789abcde", "wake-0123456789abcde\0")).toBeUndefined();
  });
  it("handles multibyte text after the code", () => {
    expect(stripCode(`${code}　中`, code)).toBe("　中");
  });
});

describe("chooseProfile", () => {
  const profiles = ["a", "b"];
  it("defaults when there is no prefix", () => {
    expect(chooseProfile("  do it ", "", profiles, "a")).toEqual({ profile: "a", task: "do it" });
  });
  it("takes an allowed prefix and strips it", () => {
    expect(chooseProfile(" b: do it", "", profiles, "a")).toEqual({ profile: "b", task: "do it" });
    expect(chooseProfile("b:", "", profiles, "a")).toEqual({ profile: "b", task: "" });
  });
  it("refuses a prefix-shaped word that is not a profile", () => {
    expect(refusal(() => chooseProfile("c: do it", "", profiles, "a")).code).toBe(EXIT.refused);
  });
  it("leaves a colon that is not a prefix in the task", () => {
    expect(chooseProfile("time is 10:30", "", profiles, "a")).toEqual({ profile: "a", task: "time is 10:30" });
    expect(chooseProfile("http://x", "", profiles, "a")).toEqual({ profile: "a", task: "http://x" });
  });
  it("uses the package's profile when it agrees or there is no prefix", () => {
    expect(chooseProfile("do it", "b", profiles, "a")).toEqual({ profile: "b", task: "do it" });
    expect(chooseProfile("b: do it", "b", profiles, "a")).toEqual({ profile: "b", task: "do it" });
  });
  it("refuses a package profile off the list, or one that disagrees with the prefix", () => {
    expect(refusal(() => chooseProfile("do it", "z", profiles, "a")).code).toBe(EXIT.refused);
    expect(refusal(() => chooseProfile("a: do it", "b", profiles, "a")).message).toMatch(/disagree/);
  });
});
