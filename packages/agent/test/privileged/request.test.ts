import { describe, expect, it } from "vitest";
import { chooseProfile, EXIT, MAX_REQUEST_BYTES, parseRequest, Refusal, usableCode } from "../../src/privileged/request.ts";
import { request, requestFor, seal } from "./helpers.ts";
import { RUNNER_MAX_REQUEST_BYTES } from "../../src/runner.ts";

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
    const r = request();
    expect(parseRequest(buf(r))).toEqual(r);
  });
  it("reads a request of exactly the contract's limit, and refuses one byte more before parsing", () => {
    const frame = seal("x");
    const pad = (n: number) => {
      const base = JSON.stringify(requestFor(frame, ""));
      return Buffer.from(JSON.stringify(requestFor(frame, "x".repeat(n - base.length))));
    };
    expect(pad(MAX_REQUEST_BYTES).length).toBe(MAX_REQUEST_BYTES);
    expect(parseRequest(pad(MAX_REQUEST_BYTES)).v).toBe(2);
    expect(refusal(() => parseRequest(pad(MAX_REQUEST_BYTES + 1))).code).toBe(EXIT.refused);
    expect(MAX_REQUEST_BYTES).toBe(RUNNER_MAX_REQUEST_BYTES);
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
    ["version 1", request({ v: 1 })],
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
  it("takes the package's profile only when the signed text names the same one", () => {
    expect(chooseProfile("b: do it", "b", profiles, "a")).toEqual({ profile: "b", task: "do it" });
    expect(chooseProfile("do it", "a", profiles, "a")).toEqual({ profile: "a", task: "do it" });
  });
  it("refuses a package profile the signed text does not name, so a worker cannot pick one", () => {
    // No prefix means the default: a worker asking for another profile is refused.
    expect(refusal(() => chooseProfile("do it", "b", profiles, "a")).message).toMatch(/does not match the signed text/);
    expect(refusal(() => chooseProfile("do it", "z", profiles, "a")).code).toBe(EXIT.refused);
    expect(refusal(() => chooseProfile("a: do it", "b", profiles, "a")).message).toMatch(/does not match/);
  });
});
