import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import * as index from "../src/index.ts";
import { MAX_BACKOFF_MS, MAX_WAIT_MS, backoff, defaultSleep, pace, redactor, runCi, type CiDeps } from "../src/run.ts";
import { GH, GL, apiServer, clock, ghRun, glPipeline, recorder, scratchDir } from "./helpers.ts";

const GL_TOKEN = "glpat-Zx81secretSecret";
const GH_TOKEN = "ghp_9secretSecretSecret";

/**
 * A sleep that works in rounds: once every source's loop is waiting, the clock advances by the
 * longest wait, `between` runs, and the loops go on, until `rounds` rounds have passed.
 */
function stopAfter(rounds: number, t: ReturnType<typeof clock>, between?: (n: number) => void, sources = 1) {
  const stop = new AbortController();
  const waits: number[] = [];
  let parked: Array<() => void> = [];
  let round = 0;
  const sleep: NonNullable<CiDeps["sleep"]> = (ms) =>
    new Promise<void>((resolve) => {
      waits.push(ms);
      parked.push(resolve);
      if (parked.length < sources) return;
      round += 1;
      t.advance(Math.max(...waits.slice(-sources)));
      between?.(round);
      if (round >= rounds) stop.abort();
      const wake = parked;
      parked = [];
      for (const w of wake) w();
    });
  return { stop, waits, sleep };
}

async function setup(sources: unknown[], extra: Record<string, unknown> = {}) {
  const dir = await scratchDir();
  const server = await apiServer();
  const t = clock();
  const rec = recorder();
  const config = loadConfig({ statePath: join(dir, "ci", "state.json"), sources, ...extra });
  const env = { GITLAB_TOKEN: GL_TOKEN, GITHUB_TOKEN: GH_TOKEN };
  return { dir, server, t, rec, config, env };
}

const gitlab = { type: "gitlab", project: "group/project" };
const github = { type: "github", owner: "octo", repo: "app", room: "#gh" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runCi", () => {
  it("watches every source, posts to each room, and stays quiet after a restart", async () => {
    const { server, t, rec, config, env } = await setup([gitlab, github]);
    server.json(`${GL}/pipelines`, [glPipeline(900, "running", "2026-10-24T11:50:00.000Z")]);
    server.json(`${GL}/pipelines/900/bridges`, []);
    server.json(`${GL}/deployments`, []);
    server.json(`${GH}/actions/runs`, { total_count: 1, workflow_runs: [ghRun(1, "in_progress", null, "2026-10-24T11:55:00Z")] });
    server.json(`${GH}/deployments`, []);
    const first = stopAfter(2, t, (n) => {
      if (n === 1) {
        server.json(`${GL}/pipelines`, [glPipeline(900, "failed", "2026-10-24T11:59:00.000Z")]);
        server.json(`${GL}/pipelines/900`, { id: 900, duration: 125, created_at: "x", updated_at: "y" });
        server.json(`${GL}/pipelines/900/jobs`, []);
        server.json(`${GH}/actions/runs`, { total_count: 1, workflow_runs: [ghRun(1, "completed", "success", "2026-10-24T11:58:00Z")] });
      }
    }, 2);
    await runCi(config, rec.io, { fetch: server.fetch, now: t.now, sleep: first.sleep, env, signal: first.stop.signal });
    expect([...rec.posts].sort((a, b) => a.room.localeCompare(b.room))).toEqual([
      { room: "#ci", text: "gitlab group/project #900 main a91957a8 failed after 2m https://gitlab.com/group/project/-/pipelines/900" },
      { room: "#gh", text: "github octo/app CI #57 main 2dc6aa3 success after 8m https://github.com/octo/app/actions/runs/1" },
    ]);
    expect(first.waits).toEqual([30_000, 30_000, 30_000, 30_000]);
    expect(rec.logs).toEqual([]);
    const saved = JSON.parse(await readFile(config.statePath, "utf8")) as { sources: Record<string, { seeded: boolean }> };
    expect(Object.keys(saved.sources)).toEqual(["gitlab:https://gitlab.com:group/project", "github:octo/app"]);
    expect(JSON.stringify(saved)).not.toContain("secret");

    // A restart reads the state back: the same view of the world announces nothing.
    rec.posts.length = 0;
    const again = stopAfter(1, t, undefined, 2);
    await runCi(config, rec.io, { fetch: server.fetch, now: t.now, sleep: again.sleep, env, signal: again.stop.signal });
    expect(rec.posts).toEqual([]);
  });

  it("backs off with jitter on 5xx, honours 429 Retry-After, and recovers", async () => {
    const { server, t, rec, config, env } = await setup([gitlab]);
    const replies = [
      { status: 502 },
      { status: 503 },
      { status: 429, headers: { "retry-after": "600" } },
      { body: [] },
    ];
    let n = 0;
    server.set(`${GL}/pipelines`, () => replies[Math.min(n++, replies.length - 1)] ?? { body: [] });
    server.json(`${GL}/deployments`, []);
    const run = stopAfter(5, t);
    await runCi(config, rec.io, { fetch: server.fetch, now: t.now, sleep: run.sleep, env, signal: run.stop.signal, random: () => 0 });
    expect(run.waits).toEqual([30_000, 60_000, 600_000, 30_000, 30_000]);
    expect(rec.logs).toEqual([
      `ci: gitlab group/project: GET https://gitlab.com/api/v4/projects/group%2Fproject/pipelines?order_by=updated_at&sort=desc&per_page=100 returned 502; retrying in 30s`,
      `ci: gitlab group/project: GET https://gitlab.com/api/v4/projects/group%2Fproject/pipelines?order_by=updated_at&sort=desc&per_page=100 returned 503; retrying in 1m`,
      `ci: gitlab group/project: GET https://gitlab.com/api/v4/projects/group%2Fproject/pipelines?order_by=updated_at&sort=desc&per_page=100 returned 429; retrying in 10m`,
    ]);
  });

  it("slows down when the rate limit runs low", async () => {
    const { server, t, rec, config, env } = await setup([github], { intervalSeconds: 60 });
    server.set(`${GH}/actions/runs`, { body: { total_count: 0, workflow_runs: [] } });
    server.set(`${GH}/deployments`, {
      body: [],
      headers: { "x-ratelimit-remaining": "20", "x-ratelimit-limit": "5000", "x-ratelimit-reset": "0" },
    });
    const run = stopAfter(1, t);
    await runCi(config, rec.io, { fetch: server.fetch, now: t.now, sleep: run.sleep, env, signal: run.stop.signal });
    expect(run.waits).toEqual([240_000]);
  });

  it("logs timeouts and malformed JSON, and never leaks a token anywhere", async () => {
    const { server, t, rec, config, env } = await setup([gitlab, github], { announceOnStart: true });
    server.set(`${GL}/pipelines`, { raw: `{"token": "${GL_TOKEN}"` });
    server.set(`${GH}/actions/runs`, { body: {}, delayMs: 1_000 });
    const run = stopAfter(2, t, () => {
      // A ref that happens to contain a token is still redacted from the posted line.
      server.json(`${GL}/pipelines`, [glPipeline(901, "running", "2026-10-24T12:00:00.000Z", { ref: `x${GL_TOKEN}` })]);
      server.json(`${GL}/pipelines/901/bridges`, []);
      server.json(`${GL}/deployments`, []);
    }, 2);
    await runCi(config, rec.io, {
      fetch: server.fetch,
      now: t.now,
      sleep: run.sleep,
      env,
      signal: run.stop.signal,
      requestTimeoutMs: 50,
      random: () => 0.5,
    });
    const everything = JSON.stringify({ posts: rec.posts, logs: rec.logs });
    expect(everything).not.toContain(GL_TOKEN);
    expect(everything).not.toContain(GH_TOKEN);
    expect(rec.logs).toContain(
      "ci: gitlab group/project: GET https://gitlab.com/api/v4/projects/group%2Fproject/pipelines?order_by=updated_at&sort=desc&per_page=100 returned malformed JSON; retrying in 45s",
    );
    expect(rec.logs).toContain(
      "ci: github octo/app: GET https://api.github.com/repos/octo/app/actions/runs?per_page=50 timed out after 0s; retrying in 45s",
    );
    expect(rec.texts()).toContain(
      "gitlab group/project #901 x[redacted] a91957a8 running https://gitlab.com/group/project/-/pipelines/901",
    );
    // The tokens did go where they belong: the request headers.
    expect(server.seen.find((s) => s.path.startsWith(GL))?.headers["private-token"]).toBe(GL_TOKEN);
    expect(server.seen.find((s) => s.path.startsWith(GH))?.headers.authorization).toBe(`Bearer ${GH_TOKEN}`);
  });

  it("redacts a token from a failing fetch's own error and a non-Error rejection", async () => {
    const { t, rec, config, env } = await setup([gitlab, github]);
    const run = stopAfter(1, t, undefined, 2);
    const fetchStub: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("github")) return Promise.reject(new Error(`connect refused for ${GH_TOKEN}`));
      const body = url.includes("/pipelines?") ? [glPipeline(903, "running", "2026-10-24T11:59:00.000Z")] : [];
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const io = { ...rec.io, post: () => Promise.reject(`relay said ${GL_TOKEN}`) };
    config.announceOnStart = true;
    await runCi(config, io, { fetch: fetchStub, now: t.now, sleep: run.sleep, env, signal: run.stop.signal });
    expect(rec.logs.join("\n")).toContain("failed: connect refused for [redacted]");
    expect(rec.logs.join("\n")).toContain("ci: gitlab group/project: relay said [redacted]; retrying in");
    expect(JSON.stringify(rec.logs)).not.toContain(GH_TOKEN);
    expect(JSON.stringify(rec.logs)).not.toContain(GL_TOKEN);
  });

  it("posts nothing on a first run, then everything new; announceOnStart posts at once", async () => {
    const { server, t, rec, config, env } = await setup([gitlab], { announceOnStart: true });
    server.json(`${GL}/pipelines`, [glPipeline(902, "running", "2026-10-24T11:50:00.000Z")]);
    server.json(`${GL}/pipelines/902/bridges`, []);
    server.json(`${GL}/deployments`, []);
    const run = stopAfter(1, t);
    await runCi(config, rec.io, { fetch: server.fetch, now: t.now, sleep: run.sleep, env, signal: run.stop.signal });
    expect(rec.texts()).toEqual(["gitlab group/project #902 main a91957a8 running https://gitlab.com/group/project/-/pipelines/902"]);
  });

  it("says when a token is missing and sends no auth header", async () => {
    const { server, t, rec, config } = await setup([gitlab, github]);
    server.json(`${GL}/pipelines`, []);
    server.json(`${GL}/deployments`, []);
    server.json(`${GH}/actions/runs`, { total_count: 0, workflow_runs: [] });
    server.json(`${GH}/deployments`, []);
    const run = stopAfter(1, t, undefined, 2);
    await runCi(config, rec.io, { fetch: server.fetch, now: t.now, sleep: run.sleep, env: { GITLAB_TOKEN: "" }, signal: run.stop.signal });
    expect(rec.logs).toEqual([
      "ci: gitlab group/project: GITLAB_TOKEN is not set; polling without a token (public projects only)",
      "ci: github octo/app: GITHUB_TOKEN is not set; polling without a token (public projects only)",
    ]);
    expect(server.seen.every((s) => s.headers.authorization === undefined && s.headers["private-token"] === undefined)).toBe(true);
    expect(server.seen.find((s) => s.path.startsWith(GH))?.headers["user-agent"]).toBe("worldinmotion-ci");
  });

  it("logs a state file it cannot save, and prunes old entries when it can", async () => {
    const { dir, server, t, rec, env } = await setup([gitlab]);
    server.json(`${GL}/pipelines`, []);
    server.json(`${GL}/deployments`, []);
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "");
    const blocked = loadConfig({ statePath: join(blocker, "state.json"), sources: [gitlab] });
    const run = stopAfter(1, t);
    await runCi(blocked, rec.io, { fetch: server.fetch, now: t.now, sleep: run.sleep, env, signal: run.stop.signal });
    expect(rec.logs.filter((l) => l.startsWith("ci: cannot save state: "))).toHaveLength(1);

    const path = join(dir, "old.json");
    const old = { phase: "success", updatedAt: "2026-10-01T00:00:00Z", ref: "main", sha: "a", webUrl: "u", children: {}, touched: 0 };
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        sources: { "gitlab:https://gitlab.com:group/project": { seeded: true, cursors: {}, pipelines: { "1": old }, deployments: {} } },
      }),
    );
    const again = stopAfter(1, t);
    await runCi(loadConfig({ statePath: path, sources: [gitlab] }), rec.io, {
      fetch: server.fetch,
      now: t.now,
      sleep: again.sleep,
      env,
      signal: again.stop.signal,
    });
    expect(await readFile(path, "utf8")).not.toContain('"touched": 0');
  });

  it("uses the global fetch, process.env and a real clock by default", async () => {
    const { server, rec, config } = await setup([{ ...gitlab, tokenEnv: "WIM_CI_TEST_UNSET_TOKEN" }]);
    server.json(`${GL}/pipelines`, []);
    server.json(`${GL}/deployments`, []);
    vi.stubGlobal("fetch", server.fetch);
    const err = await runCi(config, rec.io, {
      sleep: async () => {
        throw new Error("stop here");
      },
    }).catch((e: unknown) => e);
    expect((err as Error).message).toBe("stop here");
    expect(rec.logs[0]).toContain("WIM_CI_TEST_UNSET_TOKEN is not set");
    expect(server.seen.length).toBe(2);
  });
});

describe("runCi stopping", () => {
  it("stops quietly when a request is cut short, using the default sleep", async () => {
    const { t, rec, config, env } = await setup([gitlab]);
    const stop = new AbortController();
    const fetchStub: typeof fetch = async (_input, init) => {
      stop.abort();
      expect(init?.signal?.aborted).toBe(true);
      return Promise.reject(new DOMException("This operation was aborted", "AbortError"));
    };
    await runCi(config, rec.io, { fetch: fetchStub, now: t.now, env, signal: stop.signal });
    expect(rec.logs).toEqual([]);
    expect(JSON.parse(await readFile(config.statePath, "utf8"))).toMatchObject({ version: 1 });
  });
});

describe("loop helpers", () => {
  it("paces by the rate limit", () => {
    expect(pace(30_000, {}, 0)).toBe(30_000);
    expect(pace(30_000, { remaining: 0, resetAt: 90_000 }, 0)).toBe(90_000);
    expect(pace(30_000, { remaining: 0, resetAt: 10_000 }, 0)).toBe(30_000);
    expect(pace(30_000, { remaining: 0, resetAt: 10 * MAX_WAIT_MS }, 0)).toBe(MAX_WAIT_MS);
    expect(pace(30_000, { remaining: 0 }, 0)).toBe(120_000);
    expect(pace(30_000, { remaining: 9 }, 0)).toBe(120_000);
    expect(pace(30_000, { remaining: 10 }, 0)).toBe(30_000);
    expect(pace(30_000, { remaining: 499, limit: 5000 }, 0)).toBe(120_000);
    expect(pace(30_000, { remaining: 500, limit: 5000 }, 0)).toBe(30_000);
  });

  it("backs off exponentially with jitter, capped", () => {
    expect(backoff(30_000, 1, undefined, () => 0)).toBe(30_000);
    expect(backoff(30_000, 1, undefined, () => 1)).toBe(60_000);
    expect(backoff(30_000, 3, undefined, () => 0.5)).toBe(180_000);
    expect(backoff(30_000, 20, undefined, () => 1)).toBe(MAX_BACKOFF_MS);
    expect(backoff(30_000, 1, 5 * MAX_WAIT_MS, () => 0)).toBe(MAX_WAIT_MS);
  });

  it("redacts every secret and ignores empty ones", () => {
    const r = redactor(["abc", "", "xyz"]);
    expect(r("abc-xyz-abc")).toBe("[redacted]-[redacted]-[redacted]");
    expect(redactor([])("plain")).toBe("plain");
  });

  it("sleeps, and wakes early when stopped", async () => {
    const stop = new AbortController();
    const started = Date.now();
    await defaultSleep(5, stop.signal);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4);
    const sleeping = defaultSleep(60_000, stop.signal);
    stop.abort();
    await sleeping;
  });

  it("exports the public surface", () => {
    expect(typeof index.runCi).toBe("function");
    expect(typeof index.loadConfig).toBe("function");
    expect(typeof index.GitLabWatcher).toBe("function");
    expect(index.GITHUB_API).toBe("https://api.github.com");
  });
});
