import { z } from "zod";
import type { GitLabSourceConfig } from "./config.ts";
import { between, formatDuration, jobList, refAllowed } from "./format.ts";
import type { HttpClient } from "./http.ts";
import type { PipelineEntry } from "./state.ts";
import { modeFor, parseBody, tooOld, type Mode, type Watcher, type WatcherContext } from "./watcher.ts";

// Only the fields the watcher reads; the API returns many more, which are ignored.
const Pipeline = z.object({
  id: z.number(),
  status: z.string(),
  ref: z.string(),
  sha: z.string(),
  web_url: z.string(),
  updated_at: z.string(),
  source: z.string().optional(),
});

const PipelineDetail = z.object({
  /** Seconds; null until the pipeline finishes. */
  duration: z.number().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const Job = z.object({ name: z.string() });

const Bridge = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  /** Null until the downstream pipeline has been created. */
  downstream_pipeline: z
    .object({ id: z.number(), project_id: z.number(), status: z.string(), web_url: z.string() })
    .nullable(),
});

const Deployment = z.object({
  id: z.number(),
  iid: z.number(),
  ref: z.string(),
  sha: z.string(),
  status: z.string(),
  updated_at: z.string(),
  environment: z.object({ name: z.string() }),
  deployable: z.object({ web_url: z.string() }).nullish(),
});

const Project = z.object({ path_with_namespace: z.string(), web_url: z.string() });

type Bridge = z.infer<typeof Bridge>;

/** Phases that end a pipeline. `manual` is not one: something is waiting on a person. */
const TERMINAL = new Set(["success", "failed", "canceled", "skipped"]);

/** Downstream phases worth a line of their own: a failure, or a person needed. */
const CHILD_REPORT = new Set(["failed", "canceled", "manual"]);

/**
 * How long a finished parent's still-moving children are re-fetched without any of them
 * changing. A child that sits in one phase for longer (stuck in `created`, say) is left alone
 * rather than costing one request per poll until the entry is pruned a week later.
 */
const REPOLL_MS = 24 * 3_600_000;

/** Seconds of overlap on `updated_after`, so a clock skew or an equal timestamp loses nothing. */
const OVERLAP_MS = 60_000;

/**
 * GitLab's statuses folded into the phases a person cares about: the queueing states all read
 * as `created`, and `canceling` already counts as `canceled`.
 */
export function gitlabPhase(status: string): string {
  switch (status) {
    case "waiting_for_resource":
    case "preparing":
    case "pending":
    case "scheduled":
      return "created";
    case "canceling":
      return "canceled";
    default:
      return status;
  }
}

interface Seen {
  id: number;
  phase: string;
  ref: string;
  sha: string;
  webUrl: string;
  updatedAt: string;
}

interface ChildSeen {
  key: string;
  name: string;
  phase: string;
  downstream: Bridge["downstream_pipeline"];
}

/** Watches one GitLab project's pipelines, their downstream bridges, and its deployments. */
export class GitLabWatcher implements Watcher {
  readonly name: string;
  readonly http: HttpClient;
  private readonly api: string;
  private info: { path: string; webUrl: string } | undefined;
  private readonly source: GitLabSourceConfig;
  private readonly ctx: WatcherContext;

  constructor(source: GitLabSourceConfig, ctx: WatcherContext) {
    this.source = source;
    this.ctx = ctx;
    this.http = ctx.http;
    this.api = `${source.baseUrl}/api/v4/projects/${encodeURIComponent(String(source.project))}`;
    this.name = `gitlab ${String(source.project)}`;
    if (typeof source.project === "string") {
      this.info = { path: source.project, webUrl: `${source.baseUrl}/${source.project}` };
    }
  }

  async poll(): Promise<void> {
    const info = await this.project();
    const prefix = `gitlab ${info.path}`;
    await this.pipelines(prefix);
    await this.deployments(prefix, info.webUrl);
    this.ctx.state.seeded = true;
  }

  /** A numeric project id is resolved to its path once, for readable lines. */
  private async project(): Promise<{ path: string; webUrl: string }> {
    if (this.info === undefined) {
      const p = parseBody(Project, await this.http.getJson(this.api), this.api);
      this.info = { path: p.path_with_namespace, webUrl: p.web_url };
    }
    return this.info;
  }

  private async get<T>(schema: z.ZodType<T>, path: string, query: Record<string, string>): Promise<T> {
    const url = `${this.api}${path}?${new URLSearchParams(query).toString()}`;
    return parseBody(schema, await this.http.getJson(url), url);
  }

  private query(cursor: string | undefined): Record<string, string> {
    const q: Record<string, string> = { order_by: "updated_at", sort: "desc", per_page: "100" };
    if (cursor !== undefined) q.updated_after = new Date(Date.parse(cursor) - OVERLAP_MS).toISOString();
    return q;
  }

  private async pipelines(prefix: string): Promise<void> {
    const st = this.ctx.state;
    const list = await this.get(z.array(Pipeline), "/pipelines", this.query(st.cursors.pipelines));
    const listed = new Set<string>();
    for (const p of list) {
      // Child pipelines are reported through their parent's bridges.
      if (p.source === "parent_pipeline") continue;
      if (!refAllowed(p.ref, this.source.refs) || tooOld(this.ctx, p.updated_at)) continue;
      listed.add(String(p.id));
      const seen = { id: p.id, phase: gitlabPhase(p.status), ref: p.ref, sha: p.sha, webUrl: p.web_url, updatedAt: p.updated_at };
      await this.pipeline(prefix, seen, modeFor(this.ctx, p.updated_at));
    }
    // A parent can be finished, and so absent from `updated_after`, while a child still runs.
    // A child waiting in `manual` is not re-fetched: playing it moves the parent, which then
    // comes back through `updated_after`.
    const since = this.ctx.now() - REPOLL_MS;
    for (const [id, e] of Object.entries(st.pipelines)) {
      if (listed.has(id) || e.touched < since || !hasMovingChild(e)) continue;
      await this.pipeline(prefix, { id: Number(id), ...e }, "announce");
    }
    setCursor(st.cursors, "pipelines", list.map((p) => p.updated_at));
  }

  private async pipeline(prefix: string, p: Seen, mode: Mode): Promise<void> {
    const now = this.ctx.now();
    const key = String(p.id);
    const st = this.ctx.state;
    const e: PipelineEntry = (st.pipelines[key] ??= {
      phase: "",
      updatedAt: "",
      ref: p.ref,
      sha: p.sha,
      webUrl: p.webUrl,
      children: {},
      touched: now,
    });
    if (e.updatedAt === p.updatedAt && e.phase === p.phase && !hasActiveChild(e)) return;
    if (mode === "skip") {
      Object.assign(e, { phase: p.phase, updatedAt: p.updatedAt, touched: now });
      return;
    }
    const children = (await this.bridges(p.id)).map(
      (b): ChildSeen => ({
        key: String(b.id),
        name: b.name,
        phase: gitlabPhase(b.downstream_pipeline?.status ?? b.status),
        downstream: b.downstream_pipeline,
      }),
    );
    const head = `${prefix} #${p.id} ${p.ref} ${p.sha.slice(0, 8)}`;
    if (e.phase !== p.phase) {
      if (mode === "announce") await this.ctx.post(`${head} ${await this.describe(p, children)} ${p.webUrl}`);
      e.phase = p.phase;
      e.touched = now;
    }
    for (const c of children) {
      if (e.children[c.key]?.phase === c.phase) continue;
      if (mode === "announce" && CHILD_REPORT.has(c.phase)) await this.ctx.post(await this.childLine(head, p, c));
      e.children[c.key] = { name: c.name, phase: c.phase };
      e.touched = now;
    }
    e.updatedAt = p.updatedAt;
  }

  private bridges(id: number): Promise<Bridge[]> {
    return this.get(z.array(Bridge), `/pipelines/${id}/bridges`, { per_page: "100" });
  }

  /** `(2 jobs failed: test, lint)` for a pipeline's failed or manual jobs, or nothing when none. */
  private async jobs(api: string, pipeline: number, scope: "failed" | "manual"): Promise<string[]> {
    const url = `${api}/pipelines/${pipeline}/jobs?scope=${scope}&per_page=100`;
    const names = parseBody(z.array(Job), await this.http.getJson(url), url).map((j) => j.name);
    if (names.length === 0) return [];
    return [`(${jobList(names, scope === "failed" ? "failed" : "waiting to be played")})`];
  }

  /** The phase plus whatever explains it: duration, failed jobs, manual jobs, downstream trouble. */
  private async describe(p: Seen, children: ChildSeen[]): Promise<string> {
    const parts = [p.phase];
    if (TERMINAL.has(p.phase)) {
      const d = await this.get(PipelineDetail, `/pipelines/${p.id}`, {});
      const ms = d.duration !== null ? d.duration * 1000 : between(d.created_at, d.updated_at);
      if (ms !== undefined) parts.push(`after ${formatDuration(ms)}`);
    }
    if (p.phase === "failed") parts.push(...(await this.jobs(this.api, p.id, "failed")));
    if (p.phase === "manual" || p.phase === "success") {
      parts.push(...(await this.jobs(this.api, p.id, "manual")));
    }
    if (TERMINAL.has(p.phase)) {
      const failed = children.filter((c) => c.phase === "failed").map((c) => c.name);
      if (failed.length > 0) parts.push(`(downstream failed: ${failed.join(", ")})`);
      const going = children.filter((c) => !TERMINAL.has(c.phase)).map((c) => c.name);
      if (going.length > 0) parts.push(`(downstream still running: ${going.join(", ")})`);
    }
    return parts.join(" ");
  }

  private async childLine(head: string, p: Seen, c: ChildSeen): Promise<string> {
    const ds = c.downstream;
    if (ds === null) return `${head} downstream ${c.name} ${c.phase} ${p.webUrl}`;
    const parts = [`${head} downstream ${c.name} #${ds.id} ${c.phase}`];
    if (c.phase !== "canceled") {
      const api = `${this.source.baseUrl}/api/v4/projects/${ds.project_id}`;
      parts.push(...(await this.jobs(api, ds.id, c.phase === "failed" ? "failed" : "manual")));
    }
    parts.push(ds.web_url);
    return parts.join(" ");
  }

  private async deployments(prefix: string, webUrl: string): Promise<void> {
    const st = this.ctx.state;
    const list = await this.get(z.array(Deployment), "/deployments", this.query(st.cursors.deployments));
    for (const d of list) {
      if (!refAllowed(d.ref, this.source.refs) || tooOld(this.ctx, d.updated_at)) continue;
      const key = String(d.id);
      if (st.deployments[key]?.phase === d.status) continue;
      if (modeFor(this.ctx, d.updated_at) === "announce") {
        const what = d.status === "blocked" ? "blocked, waiting for approval" : d.status;
        const url = d.deployable?.web_url ?? `${webUrl}/-/environments`;
        await this.ctx.post(
          `${prefix} deploy ${d.environment.name} #${d.iid} ${d.ref} ${d.sha.slice(0, 8)} ${what} ${url}`,
        );
      }
      st.deployments[key] = { phase: d.status, touched: this.ctx.now() };
    }
    setCursor(st.cursors, "deployments", list.map((d) => d.updated_at));
  }
}

function hasActiveChild(e: PipelineEntry): boolean {
  return Object.values(e.children).some((c) => !TERMINAL.has(c.phase));
}

/** A child that can change without anyone acting: neither finished nor waiting on a person. */
function hasMovingChild(e: PipelineEntry): boolean {
  return Object.values(e.children).some((c) => !TERMINAL.has(c.phase) && c.phase !== "manual");
}

/** Moves a cursor to the newest server timestamp seen, never backwards. */
function setCursor(cursors: Record<string, string>, name: string, stamps: string[]): void {
  for (const s of stamps) {
    const best = cursors[name];
    if (best === undefined || Date.parse(s) > Date.parse(best)) cursors[name] = s;
  }
}
