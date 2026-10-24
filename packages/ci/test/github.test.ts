import { describe, expect, it } from "vitest";
import { loadConfig, type GitHubSourceConfig } from "../src/config.ts";
import { GitHubWatcher, githubPhase } from "../src/github.ts";
import { HttpClient } from "../src/http.ts";
import type { SourceState } from "../src/state.ts";
import { GH, SHA2, apiServer, clock, ghRun, recorder } from "./helpers.ts";

const RUNS = "https://github.com/octo/app/actions/runs";

async function setup(opts: { refs?: string[]; seeded?: boolean } = {}) {
  const server = await apiServer();
  const t = clock();
  const rec = recorder();
  const state: SourceState = { seeded: opts.seeded ?? true, cursors: {}, pipelines: {}, deployments: {} };
  const http = new HttpClient({
    fetch: server.fetch,
    headers: { Authorization: "Bearer ghp_secret" },
    timeoutMs: 2_000,
    now: t.now,
    etag: true,
  });
  const config = loadConfig({ statePath: "unused", sources: [{ type: "github", owner: "octo", repo: "app", refs: opts.refs }] });
  const watcher = new GitHubWatcher(config.sources[0] as GitHubSourceConfig, {
    http,
    state,
    post: (text) => rec.io.post("#ci", text),
    now: t.now,
    announceOnStart: false,
  });
  server.json(`${GH}/actions/runs`, { total_count: 0, workflow_runs: [] });
  server.json(`${GH}/deployments`, []);
  const runs = (...r: unknown[]) => server.json(`${GH}/actions/runs`, { total_count: r.length, workflow_runs: r });
  const paths = () => server.seen.map((s) => s.path.replace(/\?.*$/, ""));
  return { server, rec, state, watcher, runs, paths };
}

/** A deployment as `GET /repos/:o/:r/deployments` lists it. */
function deployment(id: number, createdAt: string, ref = "main") {
  return {
    id,
    node_id: "DE_kwDO",
    sha: SHA2,
    ref,
    task: "deploy",
    payload: {},
    original_environment: "production",
    environment: "production",
    description: null,
    creator: { login: "octocat" },
    created_at: createdAt,
    updated_at: createdAt,
    statuses_url: `https://api.github.com/repos/octo/app/deployments/${id}/statuses`,
  };
}

function status(state: string, logUrl: string) {
  return {
    id: 1,
    state,
    description: "",
    environment: "production",
    target_url: logUrl,
    log_url: logUrl,
    environment_url: "",
    created_at: "2026-10-24T11:59:00Z",
  };
}

describe("githubPhase", () => {
  it("reads a status, or a conclusion once completed", () => {
    expect(githubPhase({ status: "queued", conclusion: null })).toBe("queued");
    expect(githubPhase({ status: "requested", conclusion: null })).toBe("queued");
    expect(githubPhase({ status: "pending", conclusion: null })).toBe("queued");
    expect(githubPhase({ status: "in_progress", conclusion: null })).toBe("running");
    expect(githubPhase({ status: "waiting", conclusion: null })).toBe("waiting");
    expect(githubPhase({ status: "completed", conclusion: "success" })).toBe("success");
    expect(githubPhase({ status: "completed", conclusion: null })).toBe("completed");
  });
});

describe("GitHubWatcher", () => {
  it("seeds silently, uses ETags, and reports a failure with its jobs", async () => {
    const { server, rec, state, watcher, paths } = await setup({ seeded: false });
    let etag = 'W/"r1"';
    let body: unknown = {
      total_count: 4,
      workflow_runs: [
        ghRun(1, "in_progress", null, "2026-10-24T11:55:00Z"),
        ghRun(2, "completed", "success", "2026-10-24T09:00:00Z"),
        ghRun(3, "completed", "failure", "2026-10-01T09:00:00Z"),
        ghRun(4, "queued", null, "2026-10-24T11:55:00Z", { head_branch: null }),
      ],
    };
    server.set(`${GH}/actions/runs`, (req) =>
      req.headers["if-none-match"] === etag ? { status: 304 } : { body, headers: { etag } },
    );
    await watcher.poll();
    expect(rec.posts).toEqual([]);
    expect(Object.keys(state.pipelines).sort()).toEqual(["1", "2", "4"]);
    expect(server.seen[0]?.headers.authorization).toBe("Bearer ghp_secret");

    server.seen.length = 0;
    await watcher.poll();
    expect(server.seen[0]?.headers["if-none-match"]).toBe('W/"r1"');
    expect(rec.posts).toEqual([]);

    etag = 'W/"r2"';
    body = { total_count: 1, workflow_runs: [ghRun(1, "completed", "failure", "2026-10-24T11:58:00Z")] };
    server.json(`${GH}/actions/runs/1/jobs`, {
      total_count: 4,
      jobs: [
        { id: 11, name: "test", status: "completed", conclusion: "failure" },
        { id: 12, name: "lint", status: "completed", conclusion: "success" },
        { id: 13, name: "e2e", status: "completed", conclusion: "timed_out" },
        { id: 14, name: "later", status: "queued", conclusion: null },
      ],
    });
    server.seen.length = 0;
    await watcher.poll();
    expect(rec.texts()).toEqual([`github octo/app CI #57 main 2dc6aa3 failed after 8m (2 jobs failed: test, e2e) ${RUNS}/1`]);
    expect(paths()).toEqual([`${GH}/actions/runs`, `${GH}/actions/runs/1/jobs`, `${GH}/deployments`]);
  });

  it("reports re-runs, waits, and every conclusion once", async () => {
    const { server, rec, watcher, runs } = await setup({ refs: ["main"] });
    server.json(`${GH}/actions/runs/6/jobs`, { total_count: 0, jobs: [] });
    const steps: Array<[unknown[], string[]]> = [
      [
        [ghRun(5, "waiting", null, "2026-10-24T11:51:00Z"), ghRun(9, "queued", null, "2026-10-24T11:51:00Z", { head_branch: "dev" })],
        [`github octo/app CI #57 main 2dc6aa3 waiting for approval ${RUNS}/5`],
      ],
      [[ghRun(5, "waiting", null, "2026-10-24T11:52:00Z")], []],
      [[ghRun(5, "completed", "success", "2026-10-24T11:53:00Z")], [`github octo/app CI #57 main 2dc6aa3 success after 3m ${RUNS}/5`]],
      [
        [ghRun(5, "in_progress", null, "2026-10-24T11:54:00Z", { run_attempt: 2 })],
        [`github octo/app CI #57 (attempt 2) main 2dc6aa3 running ${RUNS}/5`],
      ],
      [
        [
          ghRun(6, "completed", "timed_out", "2026-10-24T11:55:00Z", { name: null, run_started_at: undefined }),
          ghRun(7, "completed", "cancelled", "2026-10-24T11:55:00Z"),
          ghRun(8, "completed", "startup_failure", "2026-10-24T11:55:00Z", { updated_at: "unknown" }),
          ghRun(10, "completed", null, "2026-10-24T11:55:00Z"),
        ],
        [
          `github octo/app workflow #57 main 2dc6aa3 timed out after 5m ${RUNS}/6`,
          `github octo/app CI #57 main 2dc6aa3 cancelled after 5m ${RUNS}/7`,
          `github octo/app CI #57 main 2dc6aa3 failed to start ${RUNS}/8`,
          `github octo/app CI #57 main 2dc6aa3 completed after 5m ${RUNS}/10`,
        ],
      ],
    ];
    for (const [list, expected] of steps) {
      rec.posts.length = 0;
      runs(...list);
      await watcher.poll();
      expect(rec.texts()).toEqual(expected);
    }
  });

  it("reports deployment statuses until they settle", async () => {
    const { server, rec, state, watcher, paths } = await setup({ seeded: false, refs: ["main"] });
    server.json(`${GH}/deployments`, [
      deployment(70, "2026-10-24T11:58:00Z"),
      deployment(69, "2026-10-24T08:00:00Z"),
      deployment(68, "2026-10-01T08:00:00Z"),
      deployment(67, "2026-10-24T11:58:00Z", "dev"),
    ]);
    server.json(`${GH}/deployments/70/statuses`, []);
    await watcher.poll();
    expect(rec.posts).toEqual([]);
    expect(state.deployments).toEqual({
      "70": { phase: "created", touched: expect.any(Number) },
      "69": { phase: "inactive", touched: expect.any(Number) },
    });

    const steps: Array<[unknown[], string[]]> = [
      [[], []],
      [[status("in_progress", "")], ["github octo/app deploy production main 2dc6aa3 in progress https://github.com/octo/app/deployments"]],
      [[status("in_progress", "")], []],
      [[status("queued", "")], ["github octo/app deploy production main 2dc6aa3 queued https://github.com/octo/app/deployments"]],
      [
        [status("failure", `${RUNS}/5`)],
        [`github octo/app deploy production main 2dc6aa3 failed ${RUNS}/5`],
      ],
    ];
    for (const [statuses, expected] of steps) {
      rec.posts.length = 0;
      server.json(`${GH}/deployments/70/statuses`, statuses);
      await watcher.poll();
      expect(rec.texts()).toEqual(expected);
    }
    // Settled, so its statuses are not asked again.
    server.seen.length = 0;
    await watcher.poll();
    expect(paths()).toEqual([`${GH}/actions/runs`, `${GH}/deployments`]);
  });

  it("records an inactive status without a line", async () => {
    const { server, rec, state, watcher } = await setup();
    server.json(`${GH}/deployments`, [deployment(71, "2026-10-24T11:58:00Z")]);
    server.json(`${GH}/deployments/71/statuses`, [status("inactive", "")]);
    await watcher.poll();
    expect(rec.posts).toEqual([]);
    expect(state.deployments["71"]?.phase).toBe("inactive");
    expect(SHA2.slice(0, 7)).toBe("2dc6aa3");
  });
});
