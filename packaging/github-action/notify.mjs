// The GitHub Action's entry point: reads the action's inputs and runs `wim ci notify` once.
//
// It never fails the job it reports on, like `wim ci notify` itself: every outcome is one line
// in the job's log and exit code 0. A missing input or a missing bundle is a warning annotation,
// not a failure.
//
// The bundle it runs is `wim.mjs` beside this file in the action's own repository, or, in the
// worldinmotion repository, the Claude Code plugin's committed bundle (the same client build,
// checked against a fresh build in CI). No step downloads code at run time.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Where the bundle may be, in order: the action's own repository, then the worldinmotion repository. */
export const BUNDLES = [
  fileURLToPath(new URL("./wim.mjs", import.meta.url)),
  fileURLToPath(new URL("../../plugins/claude-code/dist/client.mjs", import.meta.url)),
];

/**
 * One input as GitHub passes it to a JavaScript action (`INPUT_<NAME>`), trimmed.
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 */
export function input(env, name) {
  return (env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
}

/**
 * The default notice: the workflow, run, ref, status and the run's URL, from GitHub's variables.
 * The receiving session also sees the verified claims (repository, workflow file, ref, commit,
 * event, run id) beside it, so this line is for reading at a glance.
 * @param {Record<string, string | undefined>} env
 * @param {string} status
 */
export function defaultText(env, status) {
  const repo = env["GITHUB_REPOSITORY"] ?? "";
  const attempt = env["GITHUB_RUN_ATTEMPT"];
  const run = `run ${env["GITHUB_RUN_NUMBER"] ?? "?"}${attempt !== undefined && attempt !== "1" ? ` (attempt ${attempt})` : ""}`;
  const head = `${repo}: ${env["GITHUB_WORKFLOW"] ?? "workflow"} ${run} on ${env["GITHUB_REF_NAME"] ?? "?"}`;
  const url = `${env["GITHUB_SERVER_URL"] ?? "https://github.com"}/${repo}/actions/runs/${env["GITHUB_RUN_ID"] ?? ""}`;
  return `${head} ${status === "" ? "finished" : `finished: ${status}`}. ${url}`;
}

/**
 * The arguments for `wim ci notify`, or the warning that replaces it. Values go as `--name=value`
 * so a text that starts with `-` stays a value.
 * @param {Record<string, string | undefined>} env
 * @returns {{ args: string[] } | { warning: string }}
 */
export function notifyArgs(env) {
  const recipient = input(env, "recipient");
  const to = input(env, "to");
  if (recipient === "") return { warning: "no recipient: set the action's `recipient` input to the code `wim ci allow github` printed" };
  if (to === "") return { warning: "no session: set the action's `to` input to the receiving session's name" };
  const given = env["INPUT_TEXT"] ?? "";
  const text = given.trim() === "" ? defaultText(env, input(env, "status")) : given;
  return { args: ["ci", "notify", "--via=github", `--recipient=${recipient}`, `--to=${to}`, `--text=${text}`] };
}

/**
 * Runs the action. Always returns 0.
 * @param {Record<string, string | undefined>} env
 * @param {{ exists: (path: string) => boolean, run: (bundle: string, args: string[]) => { error?: Error }, out: (line: string) => void }} io
 */
export function main(env, io) {
  const plan = notifyArgs(env);
  if ("warning" in plan) {
    io.out(`::warning title=worldinmotion CI notice::not sent: ${plan.warning}`);
    return 0;
  }
  const bundle = BUNDLES.find((path) => io.exists(path));
  if (bundle === undefined) {
    io.out("::warning title=worldinmotion CI notice::not sent: the wim bundle is missing from this copy of the action");
    return 0;
  }
  const result = io.run(bundle, plan.args);
  if (result.error !== undefined) io.out(`::warning title=worldinmotion CI notice::not sent: wim did not start (${result.error.message})`);
  return 0;
}

// Run as the action's entry point (not when a test imports this file).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.env, {
    exists: existsSync,
    run: (bundle, args) => spawnSync(process.execPath, [bundle, ...args], { stdio: "inherit", env: process.env }),
    out: (line) => console.log(line),
  });
}
