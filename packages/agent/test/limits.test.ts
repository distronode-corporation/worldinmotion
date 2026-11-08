import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DailyLedger, RateLimit, utcDay } from "../src/limits.ts";
import { clock, scratchDir } from "./helpers.ts";

describe("RateLimit", () => {
  it("allows perHour per key in any rolling hour", () => {
    const c = clock();
    const r = new RateLimit(2, c.now);
    expect(r.take("a")).toBe(true);
    expect(r.take("a")).toBe(true);
    expect(r.take("a")).toBe(false);
    expect(r.take("b")).toBe(true);
    c.advance(3_600_000);
    expect(r.take("a")).toBe(true);
  });

  it("forgets keys whose attempts are all over an hour old", () => {
    const c = clock();
    const r = new RateLimit(1, c.now);
    r.take("old");
    c.advance(3_600_001);
    expect(r.take("new")).toBe(true);
    expect((r as unknown as { seen: Map<string, number[]> }).seen.has("old")).toBe(false);
  });
});

describe("DailyLedger", () => {
  it("counts jobs per UTC day on disk", async () => {
    const dir = await scratchDir();
    const path = join(dir, "state", "ledger.json");
    const c = clock(Date.UTC(2026, 10, 8, 23, 59, 0));
    const l = await DailyLedger.open(path, 2, c.now);
    expect(l.used).toBe(0);
    expect(await l.take()).toBe(true);
    expect(await l.take()).toBe(true);
    expect(await l.take()).toBe(false);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ day: "2026-11-08", jobs: 2 });
    // A restart keeps today's count.
    expect((await DailyLedger.open(path, 2, c.now)).used).toBe(2);
    c.advance(120_000);
    expect(l.used).toBe(0);
    expect(await l.take()).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ day: "2026-11-09", jobs: 1 });
  });

  it("treats a ledger it cannot read as today's cap reached", async () => {
    const dir = await scratchDir();
    const c = clock();
    for (const body of ["not json", "null", '{"day":"2026-11-08"}', '{"day":"2026-11-08","jobs":-1}', '{"day":"2026-11-08","jobs":1.5}', '{"day":1,"jobs":1}']) {
      const path = join(dir, "l.json");
      await writeFile(path, body);
      const l = await DailyLedger.open(path, 3, c.now);
      expect(l.used).toBe(3);
      expect(await l.take()).toBe(false);
    }
  });

  it("fails loudly when the ledger path is unreadable for another reason", async () => {
    const dir = await scratchDir();
    await mkdir(join(dir, "isdir"));
    await expect(DailyLedger.open(join(dir, "isdir"), 1, Date.now)).rejects.toThrow();
  });

  it("utcDay is the UTC date", () => {
    expect(utcDay(Date.UTC(2026, 0, 2, 23, 0, 0))).toBe("2026-01-02");
  });
});
