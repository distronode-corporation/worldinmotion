import { describe, expect, it } from "vitest";
import { b64u, deviceIdFromSignPub, isId22, isName, isRoom, isUlid, randomBytes, sessionAddressSchema, sha256, ulid, ulidTime } from "../src/index.ts";

describe("ulid", () => {
  it("has the canonical shape and encodes the time", () => {
    const id = ulid(1760000000000);
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
    expect(ulidTime(id)).toBe(1760000000000);
  });

  it("is strictly increasing within a millisecond and across a clock step backwards", () => {
    const t = Date.now() + 10_000;
    const ids = Array.from({ length: 1000 }, () => ulid(t));
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
    const back = ulid(t - 5000);
    expect(back > ids.at(-1)!).toBe(true);
    expect(ulidTime(back)).toBe(t);
    const later = ulid(t + 1);
    expect(ulidTime(later)).toBe(t + 1);
    expect(isUlid(ulid())).toBe(true);
  });

  it("refuses times outside 48 bits", () => {
    for (const bad of [-1, 1.5, 2 ** 48, NaN]) expect(() => ulid(bad)).toThrow(RangeError);
  });

  it("isUlid accepts only the canonical form", () => {
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
    for (const bad of ["01arz3ndektsv4rrffq69g5fav", "81ARZ3NDEKTSV4RRFFQ69G5FAV", "01ARZ3NDEKTSV4RRFFQ69G5FA", "01ARZ3NDEKTSV4RRFFQ69G5FAI", 7]) {
      expect(isUlid(bad)).toBe(false);
    }
    expect(() => ulidTime("nope")).toThrow(TypeError);
  });
});

describe("names and ids", () => {
  it("isName follows SPEC section 2", () => {
    for (const good of ["a", "0", "laptop", "build-box-2", "a".repeat(32)]) expect(isName(good)).toBe(true);
    for (const bad of ["", "-a", "A", "a_b", "a.b", "a@b", "a".repeat(33), "caf\u00E9", 1, null]) {
      expect(isName(bad)).toBe(false);
    }
  });

  it("builds addresses and rooms from the same name grammar", () => {
    const names = ["a", "0", "build-box-2", "a".repeat(32), "", "-a", "A", "a_b", "a".repeat(33)];
    for (const n of names) {
      expect(isRoom(`#${n}`), n).toBe(isName(n));
      for (const d of names) expect(sessionAddressSchema.safeParse(`${n}@${d}`).success, `${n}@${d}`).toBe(isName(n) && isName(d));
    }
    expect(isRoom("ops")).toBe(false);
    expect(sessionAddressSchema.safeParse("a@b@c").success).toBe(false);
  });

  it("deviceIdFromSignPub truncates b64u(sha256(pub)) to 22 characters", () => {
    const pub = new Uint8Array(32).fill(7);
    const id = deviceIdFromSignPub(pub);
    expect(id).toBe(b64u.encode(sha256(pub)).slice(0, 22));
    expect(isId22(id)).toBe(true);
    expect(() => deviceIdFromSignPub(new Uint8Array(31))).toThrow(TypeError);
    expect(() => deviceIdFromSignPub("x" as unknown as Uint8Array)).toThrow(TypeError);
    expect(isId22("short")).toBe(false);
    expect(isId22(5)).toBe(false);
  });

  it("randomBytes returns fresh bytes and checks its length", () => {
    expect(randomBytes(0)).toHaveLength(0);
    const a = randomBytes(32);
    const b = randomBytes(32);
    expect(a).toHaveLength(32);
    expect(a).not.toEqual(b);
    for (const bad of [-1, 1.5, 65537]) expect(() => randomBytes(bad)).toThrow(RangeError);
  });
});
