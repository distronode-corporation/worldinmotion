import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { loadConfig, type WorkerConfig } from "../src/config.ts";

/** Where test scratch directories go: `WIM_TEST_TMP` when set, else the system temp directory (honours TMPDIR). */
function scratchRoot(): string {
  return process.env["WIM_TEST_TMP"] || tmpdir();
}

/** A scratch directory, removed when the test that made it ends. Call only from inside a test. */
export async function scratchDir(): Promise<string> {
  const root = scratchRoot();
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "wim-agent-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A hand-wound clock. */
export function clock(start = Date.UTC(2026, 10, 8, 12, 0, 0)) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** Two device ids of the roster's shape. */
export const LAPTOP = "AAAAAAAAAAAAAAAAAAAAAA";
export const DESKTOP = "BBBBBBBBBBBBBBBBBBBBBB";
export const STRANGER = "CCCCCCCCCCCCCCCCCCCCCC";

/** A valid config, with `extra` merged over the top level. */
export function config(extra: Record<string, unknown> = {}): WorkerConfig {
  return loadConfig({
    senders: { devices: [LAPTOP, DESKTOP] },
    wake: { mode: "none" },
    runner: { command: "/bin/true" },
    limits: { ledgerPath: "/nonexistent/ledger.json" },
    ...extra,
  });
}
