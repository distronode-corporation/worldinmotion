// Runs in its own file because it drives the process-wide ULID state to its limits.
import { afterEach, expect, it, vi } from "vitest";
import { ulid, ulidTime } from "../src/index.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

// The only stubbed randomness in the suite: an all-ones random part is the one way to reach the
// overflow path, and real randomness reaches it with probability 2^-80.
function allOnesRandom(): void {
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(a: T): T => {
    new Uint8Array(a!.buffer).fill(0xff);
    return a;
  });
}

it("advances the time by one millisecond when the random part overflows", () => {
  allOnesRandom();
  const first = ulid(1000);
  expect(first.endsWith("ZZZZZZZZZZZZZZZZ")).toBe(true);
  vi.restoreAllMocks();
  const next = ulid(1000);
  expect(ulidTime(next)).toBe(1001);
  expect(next > first).toBe(true);
});

it("throws once the last millisecond is exhausted", () => {
  allOnesRandom();
  const max = 2 ** 48 - 1;
  expect(ulid(max).startsWith("7ZZZZZZZZZ")).toBe(true);
  expect(() => ulid(max)).toThrow(/exhausted/);
});
