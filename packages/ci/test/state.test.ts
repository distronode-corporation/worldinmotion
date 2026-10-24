import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KEEP_MS, StateStore } from "../src/state.ts";
import { clock, scratchDir } from "./helpers.ts";

const entry = (touched: number) => ({
  phase: "success",
  updatedAt: "2026-10-24T11:00:00Z",
  ref: "main",
  sha: "abc",
  webUrl: "https://gitlab.com/group/project/-/pipelines/1",
  children: { "7": { name: "docs", phase: "running" } },
  touched,
});

describe("StateStore", () => {
  it("starts empty when the file is missing, and round-trips atomically with 0600", async () => {
    const dir = await scratchDir();
    const path = join(dir, "nested", "state.json");
    const t = clock();
    const logs: string[] = [];
    const store = await StateStore.open(path, t.now, (l) => logs.push(l));
    const s = store.source("gitlab:x");
    expect(s).toEqual({ seeded: false, cursors: {}, pipelines: {}, deployments: {} });
    expect(store.source("gitlab:x")).toBe(s);
    s.seeded = true;
    s.pipelines["1"] = entry(t.now());
    s.deployments["2"] = { phase: "success", touched: t.now() };
    await Promise.all([store.save(), store.save()]);
    expect(logs).toEqual([]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readdir(join(dir, "nested"))).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    const again = await StateStore.open(path, t.now, () => undefined);
    expect(again.source("gitlab:x")).toEqual(s);
  });

  it("prunes entries untouched for seven days", async () => {
    const dir = await scratchDir();
    const path = join(dir, "state.json");
    const t = clock();
    const store = await StateStore.open(path, t.now, () => undefined);
    const s = store.source("github:octo/app");
    s.pipelines.old = entry(t.now() - KEEP_MS - 1);
    s.pipelines.edge = entry(t.now() - KEEP_MS);
    s.deployments.old = { phase: "success", touched: 0 };
    s.deployments.fresh = { phase: "success", touched: t.now() };
    await store.save();
    const saved = JSON.parse(await readFile(path, "utf8")) as { sources: Record<string, { pipelines: object; deployments: object }> };
    expect(Object.keys(saved.sources["github:octo/app"]?.pipelines ?? {})).toEqual(["edge"]);
    expect(Object.keys(saved.sources["github:octo/app"]?.deployments ?? {})).toEqual(["fresh"]);
  });

  it("starts fresh, saying so, from an invalid or unreadable file", async () => {
    const dir = await scratchDir();
    const logs: string[] = [];
    const bad = join(dir, "bad.json");
    await writeFile(bad, "{not json");
    expect((await StateStore.open(bad, Date.now, (l) => logs.push(l))).source("k").seeded).toBe(false);
    const wrong = join(dir, "wrong.json");
    await writeFile(wrong, JSON.stringify({ version: 2, sources: {} }));
    await StateStore.open(wrong, Date.now, (l) => logs.push(l));
    const directory = join(dir, "adir");
    await mkdir(directory);
    await StateStore.open(directory, Date.now, (l) => logs.push(l));
    expect(logs[0]).toBe(`ci: state ${bad} is not valid; starting fresh`);
    expect(logs[1]).toBe(`ci: state ${wrong} is not valid; starting fresh`);
    expect(logs[2]).toMatch(/^ci: cannot read state .*adir \(EISDIR.*\); starting fresh$/);
  });

  it("keeps saving after a failed write", async () => {
    const dir = await scratchDir();
    const blocker = join(dir, "file");
    await writeFile(blocker, "");
    const store = await StateStore.open(join(blocker, "state.json"), Date.now, () => undefined);
    await expect(store.save()).rejects.toThrow();
    await expect(store.save()).rejects.toThrow();
  });
});
