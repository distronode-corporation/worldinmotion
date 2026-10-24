import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { loadConfig, type GitLabSourceConfig } from "../src/config.ts";
import { GitLabWatcher, gitlabPhase } from "../src/gitlab.ts";
import { HttpClient } from "../src/http.ts";
import type { SourceState } from "../src/state.ts";
import {
  GL,
  apiServer,
  clock,
  glBridge,
  glDeployment,
  glDetail,
  glJob,
  glPipeline,
  recorder,
  type Reply,
} from "./helpers.ts";

const URL_ = "https://gitlab.com/group/project/-/pipelines";

async function setup(opts: { project?: string | number; refs?: string[]; announceOnStart?: boolean; seeded?: boolean } = {}) {
  const server = await apiServer();
  const t = clock();
  const rec = recorder();
  const state: SourceState = { seeded: opts.seeded ?? true, cursors: {}, pipelines: {}, deployments: {} };
  const http = new HttpClient({ fetch: server.fetch, headers: { "PRIVATE-TOKEN": "glpat-secret" }, timeoutMs: 2_000, now: t.now });
  const config = loadConfig({
    statePath: "unused",
    sources: [{ type: "gitlab", project: opts.project ?? "group/project", refs: opts.refs }],
  });
  const ctx = {
    http,
    state,
    post: (text: string) => rec.io.post("#ci", text),
    now: t.now,
    announceOnStart: opts.announceOnStart ?? false,
  };
  const watcher = new GitLabWatcher(config.sources[0] as GitLabSourceConfig, ctx);
  server.json(`${GL}/pipelines`, []);
  server.json(`${GL}/deployments`, []);
  const paths = () => server.seen.map((s) => s.path.replace(/\?.*$/, ""));
  return { server, t, rec, state, watcher, paths };
}

/** A jobs route that answers by `scope`. */
function jobs(byScope: Record<string, unknown[]>): (req: IncomingMessage) => Reply {
  return (req) => {
    const scope = new URL(req.url ?? "/", "http://local").searchParams.get("scope") ?? "";
    return { body: byScope[scope] ?? [] };
  };
}

describe("gitlabPhase", () => {
  it("folds queueing states into created and canceling into canceled", () => {
    for (const s of ["created", "waiting_for_resource", "preparing", "pending", "scheduled"]) expect(gitlabPhase(s)).toBe("created");
    expect(gitlabPhase("canceling")).toBe("canceled");
    for (const s of ["running", "success", "failed", "canceled", "skipped", "manual"]) expect(gitlabPhase(s)).toBe(s);
  });
});

describe("GitLabWatcher", () => {
  it("seeds silently, then reports a transition with its duration", async () => {
    const { server, rec, state, watcher, paths } = await setup({ seeded: false });
    server.json(`${GL}/pipelines`, [
      glPipeline(900, "running", "2026-10-24T11:50:00.000Z"),
      glPipeline(899, "success", "2026-10-24T10:00:00.000Z"),
      glPipeline(898, "failed", "2026-10-10T10:00:00.000Z"),
      glPipeline(950, "failed", "2026-10-24T11:51:00.000Z", { source: "parent_pipeline" }),
    ]);
    server.json(`${GL}/pipelines/900/bridges`, []);
    await watcher.poll();
    expect(rec.posts).toEqual([]);
    expect(state.seeded).toBe(true);
    // Only the recent pipeline's bridges are fetched while seeding; the old one is just stored.
    expect(paths()).toEqual([`${GL}/pipelines`, `${GL}/pipelines/900/bridges`, `${GL}/deployments`]);
    expect(Object.keys(state.pipelines).sort()).toEqual(["899", "900"]);
    expect(state.cursors.pipelines).toBe("2026-10-24T11:51:00.000Z");

    server.seen.length = 0;
    server.json(`${GL}/pipelines`, [glPipeline(900, "success", "2026-10-24T11:58:00.000Z")]);
    server.json(`${GL}/pipelines/900`, glDetail(900, "success", 720.4));
    server.set(`${GL}/pipelines/900/jobs`, jobs({}));
    await watcher.poll();
    expect(rec.texts()).toEqual([`gitlab group/project #900 main a91957a8 success after 12m ${URL_}/900`]);
    expect(server.seen[0]?.path).toBe(
      `${GL}/pipelines?order_by=updated_at&sort=desc&per_page=100&updated_after=2026-10-24T11%3A50%3A00.000Z`,
    );
    expect(server.seen[0]?.headers["private-token"]).toBe("glpat-secret");

    // An unchanged poll says nothing and asks for nothing more.
    server.seen.length = 0;
    await watcher.poll();
    expect(rec.posts).toHaveLength(1);
    expect(paths()).toEqual([`${GL}/pipelines`, `${GL}/deployments`]);
  });

  it("reports each transition once, with failed and manual jobs", async () => {
    const { server, rec, watcher } = await setup();
    const at = (m: number) => `2026-10-24T11:${String(m).padStart(2, "0")}:00.000Z`;
    for (const id of [901, 902, 903, 904]) server.json(`${GL}/pipelines/${id}/bridges`, []);
    server.set(`${GL}/pipelines/901/jobs`, jobs({ failed: [glJob(1, "test", "failed"), glJob(2, "lint", "failed")] }));
    server.set(`${GL}/pipelines/902/jobs`, jobs({ manual: [glJob(3, "deploy-prod", "manual")] }));
    server.set(`${GL}/pipelines/903/jobs`, jobs({}));

    const steps: Array<[unknown[], string[]]> = [
      [[glPipeline(901, "created", at(1))], [`gitlab group/project #901 main a91957a8 created ${URL_}/901`]],
      [[glPipeline(901, "pending", at(2))], []],
      [[glPipeline(901, "running", at(3))], [`gitlab group/project #901 main a91957a8 running ${URL_}/901`]],
      [[glPipeline(901, "running", at(4))], []],
      [
        [glPipeline(901, "failed", at(5)), glPipeline(902, "manual", at(5))],
        [
          `gitlab group/project #901 main a91957a8 failed after 12m (2 jobs failed: test, lint) ${URL_}/901`,
          `gitlab group/project #902 main a91957a8 manual (1 job waiting to be played: deploy-prod) ${URL_}/902`,
        ],
      ],
      [
        [glPipeline(903, "canceling", at(6)), glPipeline(904, "skipped", at(6))],
        [
          `gitlab group/project #903 main a91957a8 canceled ${URL_}/903`,
          `gitlab group/project #904 main a91957a8 skipped ${URL_}/904`,
        ],
      ],
      [[glPipeline(903, "canceled", at(7))], []],
    ];
    server.json(`${GL}/pipelines/901`, glDetail(901, "failed", null));
    // Unparseable timestamps and no duration: the line simply has no "after".
    server.json(`${GL}/pipelines/903`, { ...glDetail(903, "canceled", null), created_at: "never" });
    server.json(`${GL}/pipelines/904`, { ...glDetail(904, "skipped", null), created_at: "never" });
    for (const [list, expected] of steps) {
      rec.posts.length = 0;
      server.json(`${GL}/pipelines`, list);
      await watcher.poll();
      expect(rec.texts()).toEqual(expected);
    }
  });

  it("follows downstream bridges, so a green parent cannot hide a failed child", async () => {
    const { server, rec, state, watcher, paths } = await setup();
    server.json(`${GL}/pipelines`, [glPipeline(910, "running", "2026-10-24T11:50:00.000Z")]);
    server.json(`${GL}/pipelines/910/bridges`, [glBridge(5001, "docs", "running", { id: 950, status: "running" })]);
    await watcher.poll();
    expect(rec.texts()).toEqual([`gitlab group/project #910 main a91957a8 running ${URL_}/910`]);

    server.json(`${GL}/pipelines`, [glPipeline(910, "success", "2026-10-24T11:55:00.000Z")]);
    server.json(`${GL}/pipelines/910`, glDetail(910, "success", 300));
    server.set(`${GL}/pipelines/910/jobs`, jobs({}));
    await watcher.poll();
    expect(rec.texts()[1]).toBe(
      `gitlab group/project #910 main a91957a8 success after 5m (downstream still running: docs) ${URL_}/910`,
    );

    // The parent is finished and no longer listed; its child is still watched, and fails.
    server.json(`${GL}/pipelines`, []);
    server.json(`${GL}/pipelines/910/bridges`, [glBridge(5001, "docs", "success", { id: 950, status: "failed" })]);
    server.set("/gitlab.com/api/v4/projects/278964/pipelines/950/jobs", jobs({ failed: [glJob(7, "build", "failed")] }));
    await watcher.poll();
    expect(rec.texts()[2]).toBe(
      `gitlab group/project #910 main a91957a8 downstream docs #950 failed (1 job failed: build) ${URL_}/950`,
    );
    expect(state.pipelines["910"]?.children).toEqual({ "5001": { name: "docs", phase: "failed" } });

    // Nothing is left running, so the bridges are not asked again.
    server.seen.length = 0;
    await watcher.poll();
    expect(rec.posts).toHaveLength(3);
    expect(paths()).toEqual([`${GL}/pipelines`, `${GL}/deployments`]);
  });

  it("names failed, manual, canceled and never-created children", async () => {
    const { server, rec, watcher } = await setup();
    server.json(`${GL}/pipelines`, [glPipeline(920, "success", "2026-10-24T11:50:00.000Z")]);
    server.json(`${GL}/pipelines/920`, glDetail(920, "success", 60));
    server.set(`${GL}/pipelines/920/jobs`, jobs({ manual: [glJob(9, "release", "manual")] }));
    server.json(`${GL}/pipelines/920/bridges`, [
      glBridge(6001, "docs", "success", { id: 951, status: "failed" }),
      glBridge(6002, "e2e", "failed", null),
      glBridge(6003, "deploy", "success", { id: 952, status: "manual" }),
      glBridge(6004, "perf", "success", { id: 953, status: "canceled" }),
      glBridge(6005, "lint", "success", { id: 954, status: "success" }),
    ]);
    server.set("/gitlab.com/api/v4/projects/278964/pipelines/951/jobs", jobs({}));
    server.set("/gitlab.com/api/v4/projects/278964/pipelines/952/jobs", jobs({ manual: [glJob(10, "go-live", "manual")] }));
    await watcher.poll();
    expect(rec.texts()).toEqual([
      `gitlab group/project #920 main a91957a8 success after 1m (1 job waiting to be played: release) (downstream failed: docs, e2e) (downstream still running: deploy) ${URL_}/920`,
      `gitlab group/project #920 main a91957a8 downstream docs #951 failed ${URL_}/951`,
      `gitlab group/project #920 main a91957a8 downstream e2e failed ${URL_}/920`,
      `gitlab group/project #920 main a91957a8 downstream deploy #952 manual (1 job waiting to be played: go-live) ${URL_}/952`,
      `gitlab group/project #920 main a91957a8 downstream perf #953 canceled ${URL_}/953`,
    ]);
  });

  it("does not re-poll a finished parent whose child waits on a person, until the parent moves", async () => {
    const { server, rec, watcher, paths } = await setup();
    server.json(`${GL}/pipelines`, [glPipeline(960, "success", "2026-10-24T11:50:00.000Z")]);
    server.json(`${GL}/pipelines/960`, glDetail(960, "success", 60));
    server.set(`${GL}/pipelines/960/jobs`, jobs({}));
    server.json(`${GL}/pipelines/960/bridges`, [glBridge(7001, "deploy", "manual", { id: 970, status: "manual" })]);
    server.set("/gitlab.com/api/v4/projects/278964/pipelines/970/jobs", jobs({ manual: [glJob(11, "go-live", "manual")] }));
    await watcher.poll();
    expect(rec.texts()).toHaveLength(2);

    // The parent drops out of `updated_after`; a child waiting in `manual` is not re-fetched.
    server.json(`${GL}/pipelines`, []);
    for (let i = 0; i < 3; i++) {
      server.seen.length = 0;
      await watcher.poll();
      expect(paths()).toEqual([`${GL}/pipelines`, `${GL}/deployments`]);
    }

    // Playing the child moves the parent, which brings it back into the list.
    server.json(`${GL}/pipelines`, [glPipeline(960, "running", "2026-10-24T12:10:00.000Z")]);
    server.json(`${GL}/pipelines/960/bridges`, [glBridge(7001, "deploy", "running", { id: 970, status: "running" })]);
    await watcher.poll();
    expect(rec.texts()[2]).toBe(`gitlab group/project #960 main a91957a8 running ${URL_}/960`);
  });

  it("stops re-polling a child that has not moved for a day", async () => {
    const { server, t, watcher, paths } = await setup();
    server.json(`${GL}/pipelines`, [glPipeline(961, "success", "2026-10-24T11:50:00.000Z")]);
    server.json(`${GL}/pipelines/961`, glDetail(961, "success", 60));
    server.set(`${GL}/pipelines/961/jobs`, jobs({}));
    server.json(`${GL}/pipelines/961/bridges`, [glBridge(7002, "docs", "success", { id: 971, status: "pending" })]);
    await watcher.poll();
    server.json(`${GL}/pipelines`, []);

    // Still inside the bound: the stuck child is asked about on every poll.
    t.advance(23 * 3_600_000);
    server.seen.length = 0;
    await watcher.poll();
    expect(paths()).toEqual([`${GL}/pipelines`, `${GL}/pipelines/961/bridges`, `${GL}/deployments`]);

    // Past it: the entry is left alone (prune forgets it later).
    t.advance(2 * 3_600_000);
    server.seen.length = 0;
    await watcher.poll();
    expect(paths()).toEqual([`${GL}/pipelines`, `${GL}/deployments`]);
  });

  it("reports deployments, including ones blocked for approval", async () => {
    const { server, rec, state, watcher } = await setup({ seeded: false, refs: ["main"] });
    server.json(`${GL}/deployments`, [
      glDeployment(50, "running", "2026-10-24T11:55:00.000Z"),
      glDeployment(49, "success", "2026-10-01T11:55:00.000Z"),
      { ...glDeployment(48, "running", "2026-10-24T11:55:00.000Z"), ref: "dev" },
    ]);
    await watcher.poll();
    expect(rec.posts).toEqual([]);
    expect(Object.keys(state.deployments)).toEqual(["50"]);

    server.json(`${GL}/deployments`, [
      glDeployment(50, "success", "2026-10-24T11:58:00.000Z"),
      glDeployment(51, "blocked", "2026-10-24T11:58:00.000Z", false),
    ]);
    await watcher.poll();
    await watcher.poll();
    expect(rec.texts()).toEqual([
      "gitlab group/project deploy production #10 main a91957a8 success https://gitlab.com/group/project/-/jobs/1234",
      "gitlab group/project deploy production #11 main a91957a8 blocked, waiting for approval https://gitlab.com/group/project/-/environments",
    ]);
    expect(state.cursors.deployments).toBe("2026-10-24T11:58:00.000Z");
  });

  it("resolves a numeric project to its path once", async () => {
    const { server, rec, watcher } = await setup({ project: 278964 });
    const api = "/gitlab.com/api/v4/projects/278964";
    server.json(api, { id: 278964, path_with_namespace: "group/project", web_url: "https://gitlab.com/group/project" });
    server.json(`${api}/pipelines`, []);
    server.json(`${api}/deployments`, [glDeployment(60, "failed", "2026-10-24T11:58:00.000Z", false)]);
    expect(watcher.name).toBe("gitlab 278964");
    await watcher.poll();
    await watcher.poll();
    expect(rec.texts()).toEqual([
      "gitlab group/project deploy production #20 main a91957a8 failed https://gitlab.com/group/project/-/environments",
    ]);
    expect(server.seen.filter((s) => s.path === api)).toHaveLength(1);
  });

  it("announces recent state on start when asked, and filters refs", async () => {
    const { server, rec, watcher } = await setup({ seeded: false, announceOnStart: true, refs: ["main"] });
    server.json(`${GL}/pipelines`, [
      glPipeline(930, "running", "2026-10-24T11:50:00.000Z"),
      glPipeline(931, "running", "2026-10-24T11:50:00.000Z", { ref: "feature" }),
      glPipeline(932, "failed", "2026-10-24T09:00:00.000Z"),
    ]);
    server.json(`${GL}/pipelines/930/bridges`, []);
    await watcher.poll();
    expect(rec.texts()).toEqual([`gitlab group/project #930 main a91957a8 running ${URL_}/930`]);
  });

  it("does not record a line it failed to post, so the next poll retries it", async () => {
    const { server, rec, state, watcher } = await setup();
    const realPost = rec.io.post;
    let fail = true;
    (watcher as unknown as { ctx: { post: (t: string) => Promise<void> } }).ctx.post = async (text) => {
      if (fail) throw new Error("relay down");
      await realPost("#ci", text);
    };
    server.json(`${GL}/pipelines`, [glPipeline(940, "running", "2026-10-24T11:50:00.000Z")]);
    server.json(`${GL}/pipelines/940/bridges`, []);
    await expect(watcher.poll()).rejects.toThrow("relay down");
    expect(state.pipelines["940"]?.phase).toBe("");
    fail = false;
    await watcher.poll();
    expect(rec.texts()).toEqual([`gitlab group/project #940 main a91957a8 running ${URL_}/940`]);
  });

  it("rejects a response of the wrong shape", async () => {
    const { server, watcher } = await setup();
    server.json(`${GL}/pipelines`, { message: "not a list" });
    await expect(watcher.poll()).rejects.toThrow(/pipelines\?.* returned an unexpected shape/);
  });
});
