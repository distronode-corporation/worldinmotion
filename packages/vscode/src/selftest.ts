// "worldinmotion: Run Self-Test": runs `wim test --json` (the sandbox: a relay on loopback and
// throwaway devices, all removed at the end) with this window's client, under a progress
// notification the person can cancel, then shows one row per step in an output channel and the
// outcome in a message. No `vscode` import: the caller hands in the parts of the API it uses.

import { StringDecoder } from "node:string_decoder";
import { duration, oneLine } from "./display.ts";
import type { Command, SpawnFn } from "./process.ts";

export type SelfTestStep = { name: string; result: "pass" | "fail" | "skip"; ms: number; detail?: string; offered?: false };
export type SelfTestReport = { ok: boolean; passed: number; failed: number; skipped: number; ms: number; steps: SelfTestStep[] };

/** The longest `wim test --json` output read; the report is one line well under it. */
export const MAX_OUTPUT = 4 * 1024 * 1024;

const RESULTS = new Set(["pass", "fail", "skip"]);

/** The report `wim test --json` printed on its last line, or undefined when there is none. */
export function parseReport(stdout: string): SelfTestReport | undefined {
  const last = stdout.trim().split("\n").at(-1)!;
  let v: unknown;
  try {
    v = JSON.parse(last);
  } catch {
    return undefined;
  }
  const r = v as Partial<SelfTestReport> | null;
  if (r === null || typeof r !== "object" || typeof r.ok !== "boolean" || !Array.isArray(r.steps)) return undefined;
  const steps = r.steps.filter((s): s is SelfTestStep => typeof s?.name === "string" && RESULTS.has(s.result) && typeof s.ms === "number");
  if (steps.length !== r.steps.length) return undefined;
  const count = (x: SelfTestStep["result"]): number => steps.filter((s) => s.result === x).length;
  return { ok: r.ok, passed: count("pass"), failed: count("fail"), skipped: count("skip"), ms: typeof r.ms === "number" ? r.ms : 0, steps };
}

const MARK = { pass: "PASS", fail: "FAIL", skip: "skip" } as const;

/** The rows for the output channel: the mark first, so pass and fail read at a glance, then the summary. */
export function reportLines(r: SelfTestReport): string[] {
  const width = Math.max(...r.steps.map((s) => s.name.length));
  return [
    ...r.steps.map((s) => `${MARK[s.result]}  ${s.name.padEnd(width)}  ${duration(s.ms).padStart(6)}${s.detail === undefined ? "" : `  ${oneLine(s.detail, 300)}`}`),
    `${r.ok ? "PASSED" : "FAILED"}: ${r.steps.length} steps, ${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped, in ${duration(r.ms)}.`,
  ];
}

/** The one-line outcome for the message: the counts, and the first failed step when there is one. */
export function summary(r: SelfTestReport): string {
  const first = r.steps.find((s) => s.result === "fail");
  if (r.ok) return `worldinmotion: the self-test passed (${r.passed} of ${r.steps.length} steps, in ${duration(r.ms)}).`;
  return `worldinmotion: the self-test failed: ${r.failed} failed, ${r.skipped} skipped${first === undefined ? "" : `; first: ${oneLine(first.name, 80)}${first.detail === undefined ? "" : ` (${oneLine(first.detail, 160)})`}`}.`;
}

/** What a run came to: the report, or why there is none (the client's last stderr line). */
export type SelfTestOutcome = { report: SelfTestReport } | { error: string };

/** How long a cancelled client may take to remove what it made before it is killed. */
export const STOP_GRACE_MS = 10_000;

/**
 * Runs `command` (the client's `test --json`) to its end and reads its report. `cancelled` asks it
 * to stop with a line `stop` on its stdin, which works on every platform (a kill on Windows gives
 * it no chance to remove what it made); one that has not ended after `graceMs` is killed.
 */
export function runClient(command: Command, spawn: SpawnFn, cancelled: { onCancellationRequested(fn: () => void): unknown }, graceMs = STOP_GRACE_MS): Promise<SelfTestOutcome> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command.cmd, command.args, { cwd: command.cwd, env: command.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ error: `the client could not start: ${(error as Error).message}` });
      return;
    }
    const out = new StringDecoder("utf8");
    const err = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (b: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += out.write(b);
    });
    child.stderr!.on("data", (b: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += err.write(b);
    });
    child.stdin!.on("error", () => undefined);
    child.on("error", (e: Error) => resolve({ error: `the client could not start: ${e.message}` }));
    let grace: ReturnType<typeof setTimeout> | undefined;
    cancelled.onCancellationRequested(() => {
      child.stdin!.write("stop\n");
      child.stdin!.end();
      grace = setTimeout(() => void child.kill(), graceMs);
    });
    child.on("exit", (code: number | null) => {
      clearTimeout(grace);
      const report = parseReport(stdout + out.end());
      const why = (stderr + err.end()).trim().split("\n").at(-1)!;
      resolve(report !== undefined ? { report } : { error: why === "" ? `the client exited ${String(code)} with no report` : oneLine(why, 300) });
    });
  });
}

/** The parts of `vscode.window` the command uses. */
export type SelfTestWindow = {
  withProgress<T>(options: { location: number; title: string; cancellable: boolean }, task: (progress: unknown, token: { onCancellationRequested(fn: () => void): unknown }) => Promise<T>): PromiseLike<T>;
  showInformationMessage(message: string, ...items: string[]): PromiseLike<string | undefined>;
  showErrorMessage(message: string, ...items: string[]): PromiseLike<string | undefined>;
};

export type SelfTestDeps = {
  window: SelfTestWindow;
  /** `vscode.ProgressLocation.Notification`. */
  notification: number;
  channel: { appendLine(line: string): void; show(preserveFocus?: boolean): void };
  command: () => Command;
  spawn: SpawnFn;
};

export const SHOW = "Show Steps";

/** The command: the run under a progress notification, the rows in the channel, the outcome in a message. */
export async function runSelfTest(d: SelfTestDeps): Promise<void> {
  const outcome = await d.window.withProgress({ location: d.notification, title: "worldinmotion: running the self-test (throwaway devices and a relay on loopback)...", cancellable: true }, (_p, token) =>
    runClient(d.command(), d.spawn, token),
  );
  d.channel.appendLine(`self-test, ${new Date().toISOString()}`);
  if ("error" in outcome) {
    d.channel.appendLine(`no report: ${outcome.error}`);
    await d.window.showErrorMessage(`worldinmotion: the self-test did not finish: ${outcome.error}`);
    return;
  }
  for (const line of reportLines(outcome.report)) d.channel.appendLine(line);
  const shown = outcome.report.ok ? d.window.showInformationMessage(summary(outcome.report), SHOW) : d.window.showErrorMessage(summary(outcome.report), SHOW);
  if ((await shown) === SHOW) d.channel.show(true);
}
