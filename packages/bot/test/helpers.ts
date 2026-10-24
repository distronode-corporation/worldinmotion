import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
  const dir = await mkdtemp(join(root, "wim-bot-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A hand-wound clock. */
export function clock(start = Date.UTC(2026, 9, 24, 12, 0, 0)) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}
