import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Budget, estimateTokens, utcDay, type BudgetOptions } from "../src/budget.ts";
import { clock, scratchDir } from "./helpers.ts";

const PRICES = { "bedrock:m": { inputPerMillion: 1, outputPerMillion: 5 } };

async function open(over: Partial<BudgetOptions> = {}) {
  const dir = await scratchDir();
  const c = clock();
  const options: BudgetOptions = {
    path: join(dir, "state", "ledger.json"),
    modelId: "bedrock:m",
    prices: PRICES,
    now: c.now,
    ...over,
  };
  return { budget: await Budget.open(options), options, c, dir };
}

describe("helpers", () => {
  it("formats a UTC day and estimates 4 ASCII characters per token, across all the texts", () => {
    expect(utcDay(Date.UTC(2026, 0, 2, 23, 59))).toBe("2026-01-02");
    expect(estimateTokens()).toBe(0);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("123456789")).toBe(3);
    expect(estimateTokens("12345", "6789")).toBe(3);
    expect(estimateTokens("ab", "é")).toBe(2);
  });

  it("does not under-reserve text that is not Latin", () => {
    // About one token per CJK character or emoji in current tokenizers, not one per four.
    expect(estimateTokens("漢字かな交じり文".repeat(100))).toBeGreaterThanOrEqual(800);
    expect(estimateTokens("🙂".repeat(100))).toBeGreaterThanOrEqual(100);
  });
});

describe("Budget", () => {
  it("refuses at startup a USD cap with no price for the model", async () => {
    await expect(open({ dailyUsd: 1, modelId: "vertex:unpriced" })).rejects.toThrow(
      "no price for vertex:unpriced, but a daily USD cap is set",
    );
  });

  it("allows an unpriced model under a token cap and charges it nothing in USD", async () => {
    const { budget } = await open({ dailyTokens: 100, modelId: "ollama:free" });
    expect(budget.cost({ inputTokens: 1000, outputTokens: 1000 })).toBe(0);
    await budget.record({ inputTokens: 10, outputTokens: 5 });
    expect(budget.today()).toEqual({ inputTokens: 10, outputTokens: 5, usd: 0, notified: [] });
  });

  it("enforces the daily token cap, counting calls in flight", async () => {
    const { budget } = await open({ dailyTokens: 100 });
    expect(budget.canSpend({ inputTokens: 50, outputTokens: 50 })).toBe(true);
    expect(budget.canSpend({ inputTokens: 51, outputTokens: 50 })).toBe(false);
    const r = budget.reserve({ inputTokens: 30, outputTokens: 30 });
    expect(r).not.toBeNull();
    expect(budget.reserve({ inputTokens: 30, outputTokens: 30 })).toBeNull();
    await budget.settle(r!, { inputTokens: 20, outputTokens: 10 });
    expect(budget.today().inputTokens + budget.today().outputTokens).toBe(30);
    expect(budget.canSpend({ inputTokens: 35, outputTokens: 35 })).toBe(true);
  });

  it("enforces the daily USD cap from the price table, counting calls in flight", async () => {
    const { budget } = await open({ dailyUsd: 0.01 });
    // 1000 in at $1/M + 1000 out at $5/M = $0.006
    expect(budget.cost({ inputTokens: 1000, outputTokens: 1000 })).toBeCloseTo(0.006);
    const r = budget.reserve({ inputTokens: 1000, outputTokens: 1000 });
    expect(r).not.toBeNull();
    expect(budget.canSpend({ inputTokens: 1000, outputTokens: 1000 })).toBe(false);
    await budget.settle(r!, { inputTokens: 1000, outputTokens: 0 });
    expect(budget.today().usd).toBeCloseTo(0.001);
    expect(budget.canSpend({ inputTokens: 1000, outputTokens: 1000 })).toBe(true);
  });

  it("has no limit when neither cap is set", async () => {
    const { budget } = await open();
    expect(budget.canSpend({ inputTokens: 1e9, outputTokens: 1e9 })).toBe(true);
  });

  it("starts each UTC day from zero and notifies each sender once per day", async () => {
    const { budget, c } = await open({ dailyTokens: 10 });
    await budget.record({ inputTokens: 10, outputTokens: 0 });
    expect(budget.canSpend({ inputTokens: 1, outputTokens: 0 })).toBe(false);
    expect(await budget.markNotified("a@x")).toBe(true);
    expect(await budget.markNotified("a@x")).toBe(false);
    expect(await budget.markNotified("b@x")).toBe(true);

    c.set(Date.UTC(2026, 9, 25, 0, 0, 0));
    expect(budget.today()).toEqual({ inputTokens: 0, outputTokens: 0, usd: 0, notified: [] });
    expect(budget.canSpend({ inputTokens: 1, outputTokens: 0 })).toBe(true);
    expect(await budget.markNotified("a@x")).toBe(true);
  });

  it("persists the ledger atomically and reloads it", async () => {
    const { budget, options } = await open({ dailyTokens: 1000 });
    await budget.record({ inputTokens: 3, outputTokens: 4 });
    await budget.markNotified("a@x");
    const raw = JSON.parse(await readFile(options.path, "utf8")) as unknown;
    expect(raw).toEqual({
      v: 1,
      days: { "2026-10-24": { inputTokens: 3, outputTokens: 4, usd: 0.000023, notified: ["a@x"] } },
    });
    // No temp file is left next to the ledger.
    expect(await readdir(join(options.path, ".."))).toEqual(["ledger.json"]);
    const again = await Budget.open(options);
    expect(again.today().inputTokens).toBe(3);
  });

  it("orders concurrent writes so the newest totals win", async () => {
    const { budget, options } = await open();
    await Promise.all([
      budget.record({ inputTokens: 1, outputTokens: 0 }),
      budget.record({ inputTokens: 1, outputTokens: 0 }),
      budget.record({ inputTokens: 1, outputTokens: 0 }),
    ]);
    const again = await Budget.open(options);
    expect(again.today().inputTokens).toBe(3);
  });

  it("drops days older than 31 days when writing", async () => {
    const { budget, options, c } = await open();
    await budget.record({ inputTokens: 1, outputTokens: 0 });
    c.advance(31 * 86_400_000);
    await budget.record({ inputTokens: 2, outputTokens: 0 });
    c.advance(86_400_000);
    await budget.record({ inputTokens: 3, outputTokens: 0 });
    const raw = JSON.parse(await readFile(options.path, "utf8")) as { days: Record<string, unknown> };
    expect(Object.keys(raw.days)).toEqual(["2026-11-24", "2026-11-25"]);
  });

  it("rejects a write that fails and keeps writing afterwards", async () => {
    const { budget, options, dir } = await open();
    // A file where the ledger's directory should be makes mkdir fail.
    await writeFile(join(dir, "state"), "not a dir");
    await expect(budget.record({ inputTokens: 1, outputTokens: 0 })).rejects.toThrow();
    await import("node:fs/promises").then((fs) => fs.rm(join(dir, "state")));
    await budget.record({ inputTokens: 1, outputTokens: 0 });
    expect((await Budget.open(options)).today().inputTokens).toBe(2);
  });

  it("refuses to start from a ledger that is not JSON or not valid", async () => {
    const dir = await scratchDir();
    const path = join(dir, "ledger.json");
    const base = { path, modelId: "bedrock:m", prices: PRICES, now: clock().now };
    await writeFile(path, "{oops");
    await expect(Budget.open(base)).rejects.toThrow(`ledger ${path} is not JSON; refusing to start`);
    await writeFile(path, JSON.stringify({ v: 2, days: {} }));
    await expect(Budget.open(base)).rejects.toThrow(`ledger ${path} is not valid; refusing to start`);
  });

  it("refuses to start when the ledger cannot be read for a reason other than absence", async () => {
    const dir = await scratchDir();
    await mkdir(join(dir, "ledger.json"));
    await expect(
      Budget.open({ path: join(dir, "ledger.json"), modelId: "m", prices: {}, now: clock().now }),
    ).rejects.toThrow(/EISDIR/);
  });
});
