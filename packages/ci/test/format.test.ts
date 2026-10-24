import { describe, expect, it } from "vitest";
import { between, formatDuration, jobList, refAllowed } from "../src/format.ts";

describe("format", () => {
  it("formats durations", () => {
    expect(formatDuration(-5)).toBe("0s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(12 * 60_000)).toBe("12m");
    expect(formatDuration(65 * 60_000)).toBe("1h 5m");
    expect(formatDuration(120 * 60_000)).toBe("2h");
  });

  it("lists jobs, deduplicated and capped at five", () => {
    expect(jobList(["test"], "failed")).toBe("1 job failed: test");
    expect(jobList(["test", "lint", "test"], "failed")).toBe("2 jobs failed: test, lint");
    expect(jobList(["a", "b", "c", "d", "e", "f", "g"], "failed")).toBe("7 jobs failed: a, b, c, d, e and 2 more");
  });

  it("measures between timestamps", () => {
    expect(between("2026-10-24T11:00:00Z", "2026-10-24T11:12:00Z")).toBe(720_000);
    expect(between(null, "2026-10-24T11:12:00Z")).toBeUndefined();
    expect(between("2026-10-24T11:00:00Z", undefined)).toBeUndefined();
    expect(between("2026-10-24T11:00:00Z", "soon")).toBeUndefined();
  });

  it("filters refs", () => {
    expect(refAllowed("main", undefined)).toBe(true);
    expect(refAllowed("main", ["main"])).toBe(true);
    expect(refAllowed("dev", ["main"])).toBe(false);
  });
});
