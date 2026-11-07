// Static checks on the safety model: peer text is never turned into HTML, Markdown, links or
// command URIs, and settings that choose what runs cannot come from a workspace.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const src = join(pkg, "src");
const files = readdirSync(src, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ f, code: readFileSync(join(src, f), "utf8") }));
const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as {
  extensionKind: string[];
  contributes: {
    configuration: { properties: Record<string, { scope: string }> };
    menus: Record<string, { command: string; when?: string; group?: string }[]>;
    commands: { command: string }[];
    viewsWelcome: { view: string; contents: string; when: string }[];
  };
};

describe("source", () => {
  it("has files to check", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const { f, code } of files) {
    it(`${f} never builds HTML, Markdown, links or command URIs from text`, () => {
      for (const banned of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /MarkdownString/, /isTrusted/, /supportHtml/, /\beval\(/, /new Function\(/, /["'`]command:/, /enableCommandUris: true/]) {
        expect(code).not.toMatch(banned);
      }
    });
  }
});

describe("manifest", () => {
  it("keeps every setting out of workspace settings", () => {
    for (const [key, p] of Object.entries(manifest.contributes.configuration.properties)) expect([key, p.scope]).toEqual([key, "machine"]);
  });

  it("prefers the person's own machine", () => {
    expect(manifest.extensionKind).toEqual(["ui", "workspace"]);
  });

  it("has welcome content that is static text, whose only links run this extension's own setup commands", () => {
    const welcome = manifest.contributes.viewsWelcome;
    expect(welcome.map((w) => [w.view, w.when])).toEqual([["worldinmotion.mesh", "worldinmotion.state == 'setup'"]]);
    const contents = welcome[0]!.contents;
    // Links are Markdown in this one place, which VS Code renders from the manifest; nothing in
    // src can change it, and it holds no placeholder a value could fill.
    const links = [...contents.matchAll(/\[([^\]]*)\]\(([^)]*)\)/g)].map((m) => [m[1], m[2]]);
    expect(links).toEqual([
      ["Create a Mesh", "command:worldinmotion.createMesh"],
      ["Join with a Code", "command:worldinmotion.joinMesh"],
    ]);
    const registered = new Set(manifest.contributes.commands.map((c) => c.command));
    for (const [, target] of links) expect(registered.has(target!.slice("command:".length))).toBe(true);
    expect(contents.replace(/\[[^\]]*\]\([^)]*\)/g, "")).not.toMatch(/[[\]()<>`$%{}]|https?:|command:/);
  });

  it("offers trust, untrust and resume only on a node the person clicked", () => {
    const palette = manifest.contributes.menus.commandPalette!.map((m) => [m.command, m.when]);
    for (const c of ["trust", "trustRelayed", "untrust", "resume"]) expect(palette).toContainEqual([`worldinmotion.${c}`, "false"]);
  });
});
