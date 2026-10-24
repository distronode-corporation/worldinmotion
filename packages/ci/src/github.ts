import { z } from "zod";
import type { GitHubSourceConfig } from "./config.ts";
import { between, formatDuration, jobList, refAllowed } from "./format.ts";
import type { HttpClient } from "./http.ts";
import { modeFor, parseBody, tooOld, type Watcher, type WatcherContext } from "./watcher.ts";

export const GITHUB_API = "https://api.github.com";

// Only the fields the watcher reads; the API returns many more, which are ignored.
const Run = z.object({
  id: z.number(),
  name: z.string().nullish(),
  run_number: z.number(),
  run_attempt: z.number().default(1),
  head_branch: z.string().nullable(),
  head_sha: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  run_started_at: z.string().optional(),
});

const Runs = z.object({ workflow_runs: z.array(Run) });

const Jobs = z.object({ jobs: z.array(z.object({ name: z.string(), conclusion: z.string().nullable() })) });

const Deployment = z.object({
  id: z.number(),
  ref: z.string(),
  sha: z.string(),
  environment: z.string(),
  created_at: z.string(),
});

const Status = z.object({ state: z.string(), log_url: z.string().nullish() });

type Run = z.infer<typeof Run>;

/** Conclusions whose failed jobs are worth naming. */
const FAILED = new Set(["failure", "timed_out"]);

/** Deployment states after which nothing more is worth polling for. */
const DEPLOY_DONE = new Set(["success", "failure", "error", "inactive"]);

/** How the phases read in a line; anything else reads as itself. */
const WORDS: Record<string, string> = {
  failure: "failed",
  timed_out: "timed out",
  startup_failure: "failed to start",
  action_required: "needs action",
  waiting: "waiting for approval",
  in_progress: "in progress",
};

/** A run's status, or its conclusion once it has completed. */
export function githubPhase(run: Pick<Run, "status" | "conclusion">): string {
  if (run.status === "completed") return run.conclusion ?? "completed";
  if (run.status === "in_progress") return "running";
  if (run.status === "queued" || run.status === "requested" || run.status === "pending") return "queued";
  return run.status;
}

/** Watches one GitHub repository's workflow runs and deployments. */
export class GitHubWatcher implements Watcher {
  readonly name: string;
  readonly http: HttpClient;
  private readonly api: string;
  private readonly source: GitHubSourceConfig;
  private readonly ctx: WatcherContext;

  constructor(source: GitHubSourceConfig, ctx: WatcherContext) {
    this.source = source;
    this.ctx = ctx;
    this.http = ctx.http;
    this.name = `github ${source.owner}/${source.repo}`;
    this.api = `${GITHUB_API}/repos/${source.owner}/${source.repo}`;
  }

  async poll(): Promise<void> {
    await this.runs();
    await this.deployments();
    this.ctx.state.seeded = true;
  }

  private async get<T>(schema: z.ZodType<T>, path: string): Promise<T> {
    const url = `${this.api}${path}`;
    return parseBody(schema, await this.http.getJson(url), url);
  }

  private async runs(): Promise<void> {
    const st = this.ctx.state;
    const { workflow_runs: runs } = await this.get(Runs, "/actions/runs?per_page=50");
    for (const r of runs) {
      const branch = r.head_branch ?? "";
      if (!refAllowed(branch, this.source.refs) || tooOld(this.ctx, r.updated_at)) continue;
      const key = String(r.id);
      const phase = `${r.run_attempt}:${githubPhase(r)}`;
      if (st.pipelines[key]?.phase === phase) continue;
      if (modeFor(this.ctx, r.updated_at) === "announce") await this.ctx.post(await this.runLine(r, branch));
      st.pipelines[key] = {
        phase,
        updatedAt: r.updated_at,
        ref: branch,
        sha: r.head_sha,
        webUrl: r.html_url,
        children: {},
        touched: this.ctx.now(),
      };
    }
  }

  private async runLine(r: Run, branch: string): Promise<string> {
    const phase = githubPhase(r);
    const attempt = r.run_attempt > 1 ? ` (attempt ${r.run_attempt})` : "";
    const parts = [`${this.name} ${r.name ?? "workflow"} #${r.run_number}${attempt} ${branch} ${r.head_sha.slice(0, 7)}`];
    parts.push(WORDS[phase] ?? phase);
    if (r.status === "completed") {
      const ms = between(r.run_started_at ?? r.created_at, r.updated_at);
      if (ms !== undefined) parts.push(`after ${formatDuration(ms)}`);
    }
    if (r.status === "completed" && FAILED.has(phase)) {
      const { jobs } = await this.get(Jobs, `/actions/runs/${r.id}/jobs?filter=latest&per_page=100`);
      const failed = jobs.filter((j) => FAILED.has(j.conclusion ?? "")).map((j) => j.name);
      if (failed.length > 0) parts.push(`(${jobList(failed, "failed")})`);
    }
    parts.push(r.html_url);
    return parts.join(" ");
  }

  private async deployments(): Promise<void> {
    const st = this.ctx.state;
    const list = await this.get(z.array(Deployment), "/deployments?per_page=30");
    for (const d of list) {
      if (!refAllowed(d.ref, this.source.refs) || tooOld(this.ctx, d.created_at)) continue;
      const key = String(d.id);
      const known = st.deployments[key];
      if (known !== undefined && DEPLOY_DONE.has(known.phase)) continue;
      const mode = modeFor(this.ctx, d.created_at);
      if (mode === "skip") {
        // Settled long before this watcher started; never poll its statuses.
        st.deployments[key] = { phase: "inactive", touched: this.ctx.now() };
        continue;
      }
      // Newest first, so the first entry is the current state.
      const [status] = await this.get(z.array(Status), `/deployments/${d.id}/statuses?per_page=1`);
      const phase = status?.state ?? "created";
      if (known?.phase === phase) continue;
      if (mode === "announce" && status !== undefined && phase !== "inactive") {
        const url = status.log_url || `https://github.com/${this.source.owner}/${this.source.repo}/deployments`;
        const sha = d.sha.slice(0, 7);
        await this.ctx.post(`${this.name} deploy ${d.environment} ${d.ref} ${sha} ${WORDS[phase] ?? phase} ${url}`);
      }
      st.deployments[key] = { phase, touched: this.ctx.now() };
    }
  }
}
