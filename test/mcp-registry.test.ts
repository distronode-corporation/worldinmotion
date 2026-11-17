import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// server.json is the MCP Registry entry that release.yml's registry job publishes once the npm
// job has published the same version. The registry verifies the npm package by its `mcpName`,
// and installs it with the arguments listed here, so these are checked on every change rather
// than first on a tag.
const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const json = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;

type Package = {
  registryType: string;
  registryBaseUrl: string;
  identifier: string;
  version: string;
  runtimeHint: string;
  transport: unknown;
  packageArguments: { type: string; value: string }[];
  runtimeArguments?: unknown;
  environmentVariables: { name: string; isRequired: boolean; isSecret: boolean }[];
};

const server = json("server.json") as {
  $schema: string;
  name: string;
  description: string;
  version: string;
  repository: { url: string; source: string; id: string };
  packages: Package[];
};
const pkg = json("packaging/npm/package.json");

describe("the MCP Registry entry (server.json)", () => {
  it("names the server the published npm package claims with mcpName", () => {
    expect(pkg.mcpName).toBe(server.name);
    expect(server.name).toBe("io.github.distronode-corporation/worldinmotion");
    expect(json("package.json").mcpName).toBeUndefined();
  });

  it("uses a dated registry schema and a description within the registry's 100 characters", () => {
    expect(server.$schema).toMatch(/^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/);
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it("is this release, for the npm package of the same version", () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toHaveLength(1);
    const [npm] = server.packages;
    expect(npm!.registryType).toBe("npm");
    expect(npm!.registryBaseUrl).toBe("https://registry.npmjs.org");
    expect(npm!.identifier).toBe(pkg.name);
    expect(npm!.version).toBe(pkg.version);
  });

  it("starts `wim mcp` over stdio, with no --kind", () => {
    // `wim mcp` with no kind runs as kind `mcp`. `--kind claude-code` is the Claude Code plugin's
    // alone: it offers the plugin's internal tool, which only the plugin's hooks refuse to the
    // model (docs/peers.md).
    const [npm] = server.packages;
    expect(npm!.runtimeHint).toBe("npx");
    expect(npm!.transport).toEqual({ type: "stdio" });
    expect(npm!.packageArguments).toEqual([{ type: "positional", value: "mcp" }]);
    expect(npm!.runtimeArguments).toBeUndefined();
    expect(JSON.stringify(server)).not.toContain("--kind");
    expect(pkg.bin).toEqual({ wim: "wim.mjs" });
  });

  it("offers only optional, non-secret variables that `wim mcp` reads", () => {
    const [npm] = server.packages;
    expect(npm!.environmentVariables.map((v) => v.name)).toEqual(["WIM_NAME", "WIM_HOME"]);
    for (const v of npm!.environmentVariables) {
      expect(v.isRequired).toBe(false);
      expect(v.isSecret).toBe(false);
      expect(read("docs/peers.md")).toContain(`| \`${v.name}\` |`);
    }
  });

  it("names this repository", () => {
    expect(server.repository).toEqual({ url: "https://github.com/distronode-corporation/worldinmotion", source: "github", id: "1432216316" });
  });
});

describe("the Glama listing (glama.json)", () => {
  it("names the schema and the maintainers by GitHub login, and stays out of the npm package", () => {
    expect(json("glama.json")).toEqual({ $schema: "https://glama.ai/mcp/schemas/server.json", maintainers: ["distronode-com"] });
    expect(pkg.files).not.toContain("glama.json");
  });
});

describe("the registry job in release.yml", () => {
  const release = read(".github/workflows/release.yml");
  const job = release.slice(release.indexOf("\n  registry:\n"), release.indexOf("\n  marketplace:\n"));

  it("runs after npm, and checks npm serves the version with its mcpName first", () => {
    expect(job).toContain("needs: [guard, npm]");
    expect(job).toContain(".mcpName // empty");
    expect(job.indexOf(".mcpName // empty")).toBeLessThan(job.indexOf("login github-oidc"));
  });

  it("pins mcp-publisher by version and SHA-256, the same as ci.yml's server-json job", () => {
    const ci = read(".github/workflows/ci.yml");
    const pins = (text: string) => [
      text.match(/MCP_PUBLISHER_VERSION: (\d+\.\d+\.\d+)\n/)?.[1],
      text.match(/MCP_PUBLISHER_SHA256: ([0-9a-f]{64})\n/)?.[1],
    ];
    expect(pins(job)[0]).toBeDefined();
    expect(pins(job)[1]).toBeDefined();
    expect(pins(ci)).toEqual(pins(job));
    // CONTRIBUTING's local gate downloads the same binary.
    const contributing = read("CONTRIBUTING.md");
    expect(contributing).toContain(`/download/v${pins(job)[0]}/mcp-publisher_linux_amd64.tar.gz`);
    expect(contributing).toContain(`echo "${pins(job)[1]}  mcp-publisher.tar.gz" | sha256sum -c -`);
    expect(job).toContain('sha256sum -c -');
  });

  it("signs in with GitHub OIDC, holding only contents: read and id-token: write", () => {
    expect(job).toContain("login github-oidc");
    const permissions = job.slice(job.indexOf("permissions:"), job.indexOf("env:"));
    expect(permissions.match(/^ {6}[a-z-]+: \w+/gm)).toEqual(["      contents: read", "      id-token: write"]);
    expect(job).not.toContain("secrets.");
  });
});
