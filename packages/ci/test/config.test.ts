import { describe, expect, it } from "vitest";
import { loadConfig, sourceKey } from "../src/config.ts";

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

  const bad: Array<[string, unknown, string]> = [
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
