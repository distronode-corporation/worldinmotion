// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// What Anthropic's plugin directory checks in plugins/claude-code, held here so a change that
// would stop or hold a submission fails on the pull request: the MCP server runs the client from
// npm at exactly the release version (the plugin carries no bundle), every file is small, the
// icon is a square PNG of 512 to 2048 px, and the manifest's links name files that exist.
const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const version = (JSON.parse(read("package.json")) as { version: string }).version;
const manifest = JSON.parse(read("plugins/claude-code/.claude-plugin/plugin.json")) as Record<string, unknown>;
const files = execFileSync("git", ["ls-files", "-z", "plugins/claude-code"], { cwd: root, encoding: "utf8" }).split("\0").filter((f) => f !== "");

describe("the Claude Code plugin, for the plugin directory", () => {
  it("runs its MCP server from npm at exactly the release version, through no file of its own", () => {
    const servers = (JSON.parse(read("plugins/claude-code/.mcp.json")) as { mcpServers: Record<string, unknown> }).mcpServers;
    expect(servers).toEqual({
      worldinmotion: { command: "npx", args: ["-y", `worldinmotion@${version}`, "mcp", "--kind", "claude-code"] },
    });
    // Every doc that shows the plugin's server command shows it as .mcp.json runs it.
    const server = (servers as { worldinmotion: { command: string; args: string[] } }).worldinmotion;
    const shown = [server.command, ...server.args].join(" ");
    expect(read("plugins/claude-code/README.md")).toContain(`\`${shown.replace(`@${version}`, "@<version>")}\``);
    for (const doc of ["plugins/claude-code/README.md", "docs/design.md", "packaging/README.md"]) {
      expect(read(doc), doc).not.toMatch(/worldinmotion@(<version>|X\.Y\.Z|\d+\.\d+\.\d+) mcp(?! --kind claude-code)/);
    }
    // The mod's /wim test runs the same pinned client.
    expect(read("plugins/claude-code/hooks/register.tsx")).toContain(`const CLIENT = ['npx', '-y', 'worldinmotion@${version}']`);
    expect(files.some((f) => f.endsWith(".mjs") || f.includes("/dist/"))).toBe(false);
  });

  it("answers no tool.check with allow: the directory refuses a mod that approves a call", () => {
    const mod = read("plugins/claude-code/hooks/register.tsx");
    expect(mod).toContain("on('tool.check'");
    expect(mod).not.toMatch(/['"`]?decision['"`]?\s*:\s*['"`]allow['"`]/);
  });

  it("keeps every file under 256 KiB, and the icon under 2 MiB", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.length).toBeLessThanOrEqual(512);
    const big = files.filter((f) => statSync(join(root, f)).size >= (f.endsWith(".png") ? 2 * 1024 * 1024 : 256 * 1024));
    expect(big).toEqual([]);
  });

  it("names a square PNG icon of 512 to 2048 px", () => {
    expect(manifest["icon"]).toBe("./assets/icon.png");
    const png = readFileSync(join(root, "plugins/claude-code/assets/icon.png"));
    expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(png.subarray(12, 16).toString("latin1")).toBe("IHDR");
    const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(512);
    expect(width).toBeLessThanOrEqual(2048);
  });

  it("links its documentation, support and privacy policy to files in this repository's main branch", () => {
    const base = "https://github.com/distronode-corporation/worldinmotion/blob/main/";
    for (const key of ["documentationUrl", "supportUrl", "privacyPolicyUrl"]) {
      const url = manifest[key];
      expect(typeof url === "string" && url.startsWith(base), key).toBe(true);
      expect(existsSync(join(root, (url as string).slice(base.length))), key).toBe(true);
    }
    expect(manifest["privacyPolicyUrl"]).toBe(`${base}PRIVACY.md`);
  });
});
