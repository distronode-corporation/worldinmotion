// Two wire contracts have one home each, in @worldinmotion/protocol: the result statuses and the
// WebSocket close codes. This file fails when a package grows its own copy again, when the one
// package that cannot import protocol (the bot) drifts from it, or when SPEC.md stops listing a
// close code.

import type { ResultStatus as BotResultStatus } from "@worldinmotion/bot";
import { CLOSE, RESULT_STATUSES, type ResultStatus } from "@worldinmotion/protocol";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { FATAL_CLOSE } from "../src/wire.ts";

const repo = join(import.meta.dirname, "..", "..", "..");

/** Every `.ts`/`.tsx` file under `dir`, as `[path relative to the repo with / separators, lines]`. */
function sources(dir: string): Array<[string, string[]]> {
  const out: Array<[string, string[]]> = [];
  for (const entry of readdirSync(join(repo, dir), { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    out.push([relative(repo, path).split(sep).join("/"), readFileSync(path, "utf8").split("\n")]);
  }
  return out;
}

/** `file:line` for every line matching `pattern` in the given source trees. */
function hits(dirs: string[], pattern: RegExp): string[] {
  return dirs.flatMap((dir) => sources(dir).flatMap(([file, lines]) => lines.flatMap((line, i) => (pattern.test(line) ? [`${file}:${i + 1}`] : []))));
}

describe("result statuses", () => {
  it("are protocol's list, which the zod schema and the agent framing use", () => {
    expect([...RESULT_STATUSES]).toEqual(["done", "failed", "declined", "timeout"]);
  });

  it("are spelled out in one place per package that cannot import protocol, and nowhere else", () => {
    // A line that names all four statuses is a copy of the list.
    const all = RESULT_STATUSES.map((s) => `(?=.*["']${s}["'])`).join("");
    const copies = hits(["packages/protocol/src", "packages/client/src", "packages/a2a/src", "packages/bot/src", "packages/vscode/src", "plugins/claude-code/hooks"], new RegExp(all));
    expect(copies.sort()).toEqual([
      // The bot's own type, pinned to protocol's by the next test.
      expect.stringMatching(/^packages\/bot\/src\/bot\.ts:\d+$/),
      // RESULT_STATUSES itself.
      expect.stringMatching(/^packages\/protocol\/src\/message\.ts:\d+$/),
    ]);
  });

  it("in the bot (which does not depend on protocol) are protocol's", () => {
    expectTypeOf<BotResultStatus>().toEqualTypeOf<ResultStatus>();
  });
});

describe("close codes", () => {
  it("are written as protocol's CLOSE names in the client and relay-core, never as numbers", () => {
    const bare = /close\(\s*\d|code\s*[!=]==?\s*\d{3,4}\b|\[\s*\d{4}\s*,|\bconst CLOSE\b/;
    expect(hits(["packages/client/src", "packages/relay-core/src"], bare)).toEqual([]);
  });

  it("give the client's own ping timeout a code no relay sends", () => {
    const { pingTimeout, ...others } = CLOSE;
    expect(Object.values(others)).not.toContain(pingTimeout);
    expect(new Set(Object.values(CLOSE)).size).toBe(Object.keys(CLOSE).length);
    expect([...FATAL_CLOSE.keys()]).not.toContain(pingTimeout);
  });

  it("are each listed in SPEC.md section 8", () => {
    const spec = readFileSync(join(repo, "SPEC.md"), "utf8");
    const section = spec.slice(spec.indexOf("## 8. Connection"), spec.indexOf("## 9. "));
    const listed = [...section.matchAll(/^\| (\d{4}) \| (relay|client|either) \|/gm)].map((m) => Number(m[1]));
    expect(listed).toEqual(Object.values(CLOSE).sort((a, b) => a - b));
    expect(section).toMatch(new RegExp(`^\\| ${CLOSE.pingTimeout} \\| client \\|`, "m"));
  });
});
