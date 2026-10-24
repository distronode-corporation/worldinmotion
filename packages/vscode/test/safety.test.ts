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
  contributes: { configuration: { properties: Record<string, { scope: string }> }; menus: Record<string, { command: string; when?: string; group?: string }[]> };
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

  it("offers trust, untrust and resume only on a node the person clicked", () => {
    const palette = manifest.contributes.menus.commandPalette!.map((m) => [m.command, m.when]);
    for (const c of ["trust", "trustRelayed", "untrust", "resume"]) expect(palette).toContainEqual([`worldinmotion.${c}`, "false"]);
  });
});
