import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

/** Where test scratch directories go: `WIM_TEST_TMP` when set, else the system temp directory (honours TMPDIR). */
function scratchRoot(): string {
  return process.env["WIM_TEST_TMP"] || tmpdir();
}

/**
 * Scratch directories live under the user's cache, never the shared system temp directory, and
 * are removed when the test that made them ends. Call only from inside a test.
 */
export async function scratchDir(): Promise<string> {
  const root = scratchRoot();
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "wim-ci-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A hand-wound clock, starting at a fixed instant. */
export function clock(start = Date.parse("2026-10-24T12:00:00Z")) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** What a route answers. A bare value is sent as a 200 JSON body. */
export interface Reply {
  status?: number;
  body?: unknown;
  /** Sent verbatim instead of `body`, for malformed responses. */
  raw?: string;
  headers?: Record<string, string>;
  /** Holds the response this long, for timeouts. */
  delayMs?: number;
}

export interface Seen {
  path: string;
  headers: IncomingHttpHeaders;
}

type Route = Reply | ((req: IncomingMessage) => Reply);

/** Captured before any test can stub the global. */
const realFetch = globalThis.fetch;

/**
 * A local stand-in for the GitLab and GitHub APIs. The injected `fetch` rewrites
 * `https://<host>/<path>` to `http://127.0.0.1:<port>/<host>/<path>`, so routes are keyed by
 * host plus path (query strings ignored) and the code under test keeps its real URLs.
 */
export async function apiServer() {
  const routes = new Map<string, Route>();
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    seen.push({ path: `${url.pathname}${url.search}`, headers: req.headers });
    const route = routes.get(url.pathname);
    const reply: Reply =
      route === undefined
        ? { status: 404, body: { message: "404 Not Found" } }
        : typeof route === "function"
          ? route(req)
          : route;
    const send = () => {
      const status = reply.status ?? 200;
      const headers = { "content-type": "application/json", ...reply.headers };
      res.writeHead(status, headers);
      res.end(status === 304 ? undefined : (reply.raw ?? JSON.stringify(reply.body ?? null)));
    };
    if (reply.delayMs === undefined) send();
    else setTimeout(send, reply.delayMs).unref();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const rewrite: typeof fetch = (input, init) => {
    const u = new URL(String(input));
    return realFetch(`http://127.0.0.1:${port}/${u.host}${u.pathname}${u.search}`, init);
  };
  return {
    fetch: rewrite,
    seen,
    /** Sets a route: a reply, or a function answering per request. */
    set(path: string, route: Route) {
      routes.set(path, route);
    },
    /** Sets a route that answers 200 with this JSON body. */
    json(path: string, body: unknown) {
      routes.set(path, { body });
    },
  };
}

/** A recording output. */
export function recorder() {
  const posts: Array<{ room: string; text: string }> = [];
  const logs: string[] = [];
  return {
    posts,
    logs,
    texts: () => posts.map((p) => p.text),
    io: {
      post: async (room: string, text: string) => {
        posts.push({ room, text });
      },
      log: (line: string) => {
        logs.push(line);
      },
    },
  };
}

export const GL = "/gitlab.com/api/v4/projects/group%2Fproject";
export const GH = "/api.github.com/repos/octo/app";
export const SHA = "a91957a858320c0e17f3a0eca7cfacbff50ea29a";
export const SHA2 = "2dc6aa325a317eda67812f05600bdf0fcdc70ab0";

/** A pipeline as `GET /projects/:id/pipelines` lists it. */
export function glPipeline(id: number, status: string, updatedAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    iid: id - 100,
    project_id: 278964,
    status,
    source: "push",
    ref: "main",
    sha: SHA,
    name: null,
    web_url: `https://gitlab.com/group/project/-/pipelines/${id}`,
    created_at: "2026-10-24T11:40:00.000Z",
    updated_at: updatedAt,
    ...extra,
  };
}

/** `GET /projects/:id/pipelines/:pipeline_id`. */
export function glDetail(id: number, status: string, duration: number | null) {
  return {
    ...glPipeline(id, status, "2026-10-24T11:52:00.000Z"),
    before_sha: "0000000000000000000000000000000000000000",
    tag: false,
    yaml_errors: null,
    user: { id: 1, username: "maintainer", name: "Maintainer" },
    started_at: "2026-10-24T11:40:05.000Z",
    finished_at: "2026-10-24T11:52:00.000Z",
    committed_at: null,
    duration,
    queued_duration: 0.01,
    coverage: null,
    detailed_status: { icon: `status_${status}`, text: status, label: status, group: status },
  };
}

/** A job as `GET /pipelines/:id/jobs` lists it. */
export function glJob(id: number, name: string, status: string) {
  return {
    id,
    status,
    stage: "test",
    name,
    ref: "main",
    tag: false,
    allow_failure: false,
    created_at: "2026-10-24T11:40:00.000Z",
    web_url: `https://gitlab.com/group/project/-/jobs/${id}`,
  };
}

/** A bridge as `GET /pipelines/:id/bridges` lists it. */
export function glBridge(id: number, name: string, status: string, downstream: { id: number; status: string } | null) {
  return {
    id,
    name,
    stage: "trigger",
    status,
    ref: "main",
    allow_failure: false,
    web_url: `https://gitlab.com/group/project/-/jobs/${id}`,
    pipeline: { id: 900, project_id: 278964, status: "running" },
    downstream_pipeline:
      downstream === null
        ? null
        : {
            id: downstream.id,
            sha: SHA,
            ref: "main",
            status: downstream.status,
            created_at: "2026-10-24T11:45:00.000Z",
            updated_at: "2026-10-24T11:50:00.000Z",
            web_url: `https://gitlab.com/group/project/-/pipelines/${downstream.id}`,
            project_id: 278964,
          },
  };
}

/** A deployment as `GET /projects/:id/deployments` lists it. */
export function glDeployment(id: number, status: string, updatedAt: string, deployable = true) {
  return {
    id,
    iid: id - 40,
    ref: "main",
    sha: SHA,
    status,
    created_at: "2026-10-24T11:50:00.000Z",
    updated_at: updatedAt,
    user: { id: 1, username: "maintainer" },
    environment: { id: 9, name: "production", external_url: "https://example.org" },
    deployable: deployable
      ? { id: 1234, status, stage: "deploy", name: "deploy", web_url: "https://gitlab.com/group/project/-/jobs/1234" }
      : null,
  };
}

/** A workflow run as `GET /repos/:o/:r/actions/runs` lists it. */
export function ghRun(id: number, status: string, conclusion: string | null, updatedAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: "CI",
    node_id: "WFR_kwLOAAAB",
    head_branch: "main",
    head_sha: SHA2,
    path: ".github/workflows/ci.yml",
    display_title: "Fix the thing",
    run_number: 57,
    event: "push",
    status,
    conclusion,
    workflow_id: 159038,
    url: `https://api.github.com/repos/octo/app/actions/runs/${id}`,
    html_url: `https://github.com/octo/app/actions/runs/${id}`,
    created_at: "2026-10-24T11:50:00Z",
    updated_at: updatedAt,
    run_attempt: 1,
    run_started_at: "2026-10-24T11:50:00Z",
    ...extra,
  };
}
