import { describe, expect, it } from "vitest";
import {
  GITHUB_DEPLOYMENT_STATES,
  GITHUB_RUN_STATES,
  GITLAB_DEPLOYMENT_STATES,
  GITLAB_PIPELINE_STATES,
  loadConfig,
  sourceKey,
} from "../src/config.ts";

const gitlab = { type: "gitlab", project: "group/project" };

describe("loadConfig", () => {
  it("fills in the defaults", () => {
    const c = loadConfig({ statePath: "state.json", sources: [gitlab, { type: "github", owner: "octo", repo: "app" }] });
    expect(c.intervalSeconds).toBe(30);
    expect(c.announceOnStart).toBe(false);
    expect(c.sources[0]).toEqual({
      type: "gitlab",
      baseUrl: "https://gitlab.com",
      project: "group/project",
      room: "#ci",
      tokenEnv: "GITLAB_TOKEN",
    });
    expect(c.sources[1]).toEqual({ type: "github", owner: "octo", repo: "app", room: "#ci", tokenEnv: "GITHUB_TOKEN" });
  });

  it("parses JSON text, keeps explicit values and trims a trailing slash", () => {
    const c = loadConfig(
      JSON.stringify({
        statePath: "s.json",
        intervalSeconds: 10,
        announceOnStart: true,
        sources: [
          {
            type: "gitlab",
            baseUrl: "https://code.example.org/gitlab/",
            project: 278964,
            refs: ["main"],
            room: "#deploys",
            tokenEnv: "WIM_GITLAB",
          },
        ],
      }),
    );
    expect(c.sources[0]).toMatchObject({ baseUrl: "https://code.example.org/gitlab", project: 278964, refs: ["main"] });
    expect(c.intervalSeconds).toBe(10);
  });

  it("names a source by provider and project", () => {
    const c = loadConfig({ statePath: "s", sources: [gitlab, { type: "github", owner: "octo", repo: "app" }] });
    expect(c.sources.map(sourceKey)).toEqual(["gitlab:https://gitlab.com:group/project", "github:octo/app"]);
  });

  it("keeps state filters on both source types, and leaves them out by default", () => {
    const github = { type: "github", owner: "octo", repo: "app" };
    const c = loadConfig({
      statePath: "s",
      sources: [
        { ...gitlab, pipelineStates: ["success", "failed", "canceled", "manual"], deploymentStates: ["failed", "canceled", "blocked"] },
        { ...github, pipelineStates: ["failure", "cancelled"], deploymentStates: ["failure", "error"] },
        { type: "gitlab", project: "group/other" },
      ],
    });
    expect(c.sources[0]).toMatchObject({
      pipelineStates: ["success", "failed", "canceled", "manual"],
      deploymentStates: ["failed", "canceled", "blocked"],
    });
    expect(c.sources[1]).toMatchObject({ pipelineStates: ["failure", "cancelled"], deploymentStates: ["failure", "error"] });
    expect(c.sources[2]).not.toHaveProperty("pipelineStates");
    expect(c.sources[2]).not.toHaveProperty("deploymentStates");
  });

  it("accepts every state each source can post", () => {
    const c = loadConfig({
      statePath: "s",
      sources: [
        { ...gitlab, pipelineStates: [...GITLAB_PIPELINE_STATES], deploymentStates: [...GITLAB_DEPLOYMENT_STATES] },
        { type: "github", owner: "octo", repo: "app", pipelineStates: [...GITHUB_RUN_STATES], deploymentStates: [...GITHUB_DEPLOYMENT_STATES] },
      ],
    });
    expect(c.sources[0]?.pipelineStates).toEqual(["created", "running", "success", "failed", "canceled", "skipped", "manual"]);
    expect(c.sources[0]?.deploymentStates).toEqual(["created", "running", "success", "failed", "canceled", "skipped", "blocked"]);
    expect(c.sources[1]?.deploymentStates).toEqual(["queued", "pending", "waiting", "in_progress", "success", "failure", "error"]);
  });

  const github = { type: "github", owner: "octo", repo: "app" };
  const bad: Array<[string, unknown, string]> = [
    ["a GitHub run state on GitLab", { statePath: "s", sources: [{ ...gitlab, pipelineStates: ["success", "failure"] }] }, "sources.0.pipelineStates.1: Invalid option"],
    ["a pipeline state as a GitLab deployment state", { statePath: "s", sources: [{ ...gitlab, deploymentStates: ["manual"] }] }, "sources.0.deploymentStates.0: Invalid option"],
    ["a GitLab state on GitHub", { statePath: "s", sources: [{ ...github, pipelineStates: ["failed"] }] }, "sources.0.pipelineStates.0: Invalid option"],
    ["inactive as a GitHub deployment state", { statePath: "s", sources: [{ ...github, deploymentStates: ["inactive"] }] }, "sources.0.deploymentStates.0: Invalid option"],
    ["a non-string state", { statePath: "s", sources: [{ ...gitlab, pipelineStates: [3] }] }, "sources.0.pipelineStates.0"],
    ["a state that is not a list", { statePath: "s", sources: [{ ...gitlab, pipelineStates: "failed" }] }, "sources.0.pipelineStates"],
    ["empty pipelineStates", { statePath: "s", sources: [{ ...gitlab, pipelineStates: [] }] }, "sources.0.pipelineStates: must name at least one state"],
    ["empty GitHub deploymentStates", { statePath: "s", sources: [{ ...github, deploymentStates: [] }] }, "sources.0.deploymentStates: must name at least one state"],
    ["a non-object", 5, "(root):"],
    ["an unknown top-level key", { statePath: "s", sources: [gitlab], extra: 1 }, "Unrecognized key"],
    ["an unknown source key", { statePath: "s", sources: [{ ...gitlab, token: "x" }] }, "Unrecognized key"],
    ["a short interval", { statePath: "s", intervalSeconds: 5, sources: [gitlab] }, "intervalSeconds"],
    ["no sources", { statePath: "s", sources: [] }, "sources"],
    ["an unknown type", { statePath: "s", sources: [{ type: "jenkins" }] }, "sources.0.type"],
    ["plain http", { statePath: "s", sources: [{ ...gitlab, baseUrl: "http://gitlab.com" }] }, "must use https"],
    ["a non-URL", { statePath: "s", sources: [{ ...gitlab, baseUrl: "gitlab" }] }, "must be a URL"],
    ["credentials", { statePath: "s", sources: [{ ...gitlab, baseUrl: "https://u:p@gitlab.com" }] }, "credentials"],
    ["a query", { statePath: "s", sources: [{ ...gitlab, baseUrl: "https://gitlab.com/?a=1" }] }, "query"],
    ["a bad project", { statePath: "s", sources: [{ ...gitlab, project: "project" }] }, "group/project"],
    ["a bad env name", { statePath: "s", sources: [{ ...gitlab, tokenEnv: "glpat-123" }] }, "environment variable"],
    ["a bad owner", { statePath: "s", sources: [{ type: "github", owner: "-x", repo: "app" }] }, "owner"],
    ["empty refs", { statePath: "s", sources: [{ ...gitlab, refs: [] }] }, "refs"],
    ["a duplicate", { statePath: "s", sources: [gitlab, gitlab] }, "duplicate source gitlab:https://gitlab.com:group/project"],
  ];
  it.each(bad)("rejects %s", (_name, value, message) => {
    expect(() => loadConfig(value)).toThrow(message);
  });
});
