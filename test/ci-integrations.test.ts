import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GITLAB_TOKEN_VAR, RECIPIENT_VAR } from "../packages/client/src/cisend.ts";
import { isName } from "../packages/protocol/src/index.ts";
// @ts-expect-error: plain JavaScript, the action's entry point (GitHub runs it with node24 as is)
import { BUNDLES, defaultText, input, main, notifyArgs } from "../packaging/github-action/notify.mjs";

// packaging/github-action and packaging/gitlab-component are the two CI senders of SPEC section
// 18 as users install them: thin wrappers around `wim ci notify`, which the client's tests cover.
// These tests hold the wrappers to that command's contract.
const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const action = read("packaging/github-action/action.yml");
const template = read("packaging/gitlab-component/templates/notify.yml");

type Env = Record<string, string | undefined>;
const github: Env = {
  GITHUB_REPOSITORY: "acme/app",
  GITHUB_WORKFLOW: "CI",
  GITHUB_RUN_NUMBER: "42",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_REF_NAME: "main",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_RUN_ID: "123456",
};
const inputs = (values: Record<string, string>): Env => Object.fromEntries(Object.entries(values).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v]));

describe("the GitHub Action's inputs", () => {
  it("declares exactly the inputs notify.mjs reads, and runs it on node24", () => {
    const declared = [...action.matchAll(/^ {2}([a-z]+):$/gm)].map((m) => m[1]);
    expect(declared).toEqual(["recipient", "to", "text", "status"]);
    expect(action).toMatch(/^runs:\n {2}using: node24\n {2}main: notify\.mjs\n$/m);
  });

  it("reads INPUT_<NAME>, trimmed, and empty when unset", () => {
    expect(input({ INPUT_TO: "  build \n" }, "to")).toBe("build");
    expect(input({}, "recipient")).toBe("");
  });
});

describe("the GitHub Action's notice", () => {
  it("defaults to the workflow, run, ref, status and URL", () => {
    expect(defaultText(github, "failure")).toBe("acme/app: CI run 42 on main finished: failure. https://github.com/acme/app/actions/runs/123456");
    expect(defaultText({ ...github, GITHUB_RUN_ATTEMPT: "3" }, "")).toBe("acme/app: CI run 42 (attempt 3) on main finished. https://github.com/acme/app/actions/runs/123456");
  });

  it("still reads when GitHub's variables are missing", () => {
    expect(defaultText({}, "")).toBe(": workflow run ? on ? finished. https://github.com//actions/runs/");
  });

  it("passes every value as --name=value, so a text starting with - stays a value", () => {
    expect(notifyArgs({ ...github, ...inputs({ recipient: "wimci1_x", to: "build", text: "--to=evil" }) })).toEqual({
      args: ["ci", "notify", "--via=github", "--recipient=wimci1_x", "--to=build", "--text=--to=evil"],
    });
  });

  it("keeps a given text as written, and uses the default for a blank one", () => {
    const given = notifyArgs({ ...github, ...inputs({ recipient: "wimci1_x", to: "build", text: "  two\nlines " }) });
    expect(given).toEqual({ args: expect.arrayContaining(["--text=  two\nlines "]) });
    const blank = notifyArgs({ ...github, ...inputs({ recipient: "wimci1_x", to: "build", text: "  ", status: "success" }) });
    expect(blank).toEqual({ args: expect.arrayContaining([`--text=${defaultText(github, "success")}`]) });
  });

  it("asks for a recipient and a session instead of sending", () => {
    expect(notifyArgs(inputs({ to: "build" }))).toEqual({ warning: expect.stringContaining("no recipient") });
    expect(notifyArgs(inputs({ recipient: "wimci1_x" }))).toEqual({ warning: expect.stringContaining("no session") });
  });
});

describe("the GitHub Action never fails the job", () => {
  const env = { ...github, ...inputs({ recipient: "wimci1_x", to: "build" }) };

  it("runs the first bundle present with the notify arguments", () => {
    const run = vi.fn(() => ({}));
    const out = vi.fn();
    expect(main(env, { exists: (p: string) => p === BUNDLES[1], run, out })).toBe(0);
    expect(run).toHaveBeenCalledWith(BUNDLES[1], (notifyArgs(env) as { args: string[] }).args);
    expect(out).not.toHaveBeenCalled();
    main(env, { exists: () => true, run, out });
    expect(run).toHaveBeenLastCalledWith(BUNDLES[0], expect.any(Array));
  });

  it("warns, and exits 0, on a missing input, a missing bundle, or a wim that does not start", () => {
    const out = vi.fn();
    const run = vi.fn(() => ({ error: new Error("spawn ENOENT") }));
    expect(main(inputs({ to: "build" }), { exists: () => true, run, out })).toBe(0);
    expect(main(env, { exists: () => false, run, out })).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(main(env, { exists: () => true, run, out })).toBe(0);
    expect(out.mock.calls.map(([line]) => line)).toEqual([
      expect.stringMatching(/^::warning title=worldinmotion CI notice::not sent: no recipient/),
      "::warning title=worldinmotion CI notice::not sent: the wim bundle is missing from this copy of the action",
      "::warning title=worldinmotion CI notice::not sent: wim did not start (spawn ENOENT)",
    ]);
  });

  // The process as GitHub runs it, with the bundle this repository commits.
  const runAction = (extra: Env) =>
    spawnSync(process.execPath, [join(root, "packaging/github-action/notify.mjs")], {
      // The test runner's own environment (Windows needs SystemRoot and the like), less any
      // action inputs or GitHub variables it may carry.
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(INPUT_|GITHUB_|ACTIONS_)/.test(k))), ...github, ...extra },
      encoding: "utf8",
      timeout: 25_000,
    });

  it("as a process: a warning and exit 0 with no recipient", { timeout: 30_000 }, () => {
    const res = runAction(inputs({ to: "build" }));
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^::warning title=worldinmotion CI notice::not sent: no recipient/);
  });

  it("as a process: runs the committed bundle's `wim ci notify`, which refuses a bad code and exits 0", { timeout: 30_000 }, () => {
    const res = runAction({ GITHUB_ACTIONS: "true", ...inputs({ recipient: "wimci1_not-a-code", to: "build" }) });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("wim ci notify: not sent");
    expect(res.stderr).toContain("not a wimci1_ code");
  });
});

describe("the GitLab component", () => {
  it("declares the ID token under the one variable wim reads, with the audience input", () => {
    expect(GITLAB_TOKEN_VAR).toBe("WIM_CI_ID_TOKEN");
    expect(template).toContain(`  id_tokens:\n    ${GITLAB_TOKEN_VAR}:\n      aud: $[[ inputs.audience ]]\n`);
    expect(template).toContain(`    ${RECIPIENT_VAR}: $[[ inputs.recipient ]]\n`);
  });

  it("runs wim ci notify once per job, every value as --name=value", () => {
    const scripts = [...template.matchAll(/^ {4}- (.*)$/gm)].map((m) => m[1]);
    expect(scripts).toEqual(['npm exec --yes --package="$WIM_PACKAGE" -- wim ci notify --via=gitlab --to="$WIM_TO" --text="$WIM_TEXT"']);
  });

  it("has one job for a passed pipeline and one for a failed one, so exactly one sends", () => {
    const jobs = [...template.matchAll(/^([.\w-]+):\n/gm)].map((m) => m[1]);
    expect(jobs).toEqual(["spec", ".wim-notify", "wim-notify-success", "wim-notify-failure"]);
    expect(template).toMatch(/^wim-notify-success:\n {2}extends: \.wim-notify\n {2}when: on_success\n/m);
    expect(template).toMatch(/^wim-notify-failure:\n {2}extends: \.wim-notify\n {2}when: on_failure\n/m);
  });

  it("keeps the token's job small: no clone, cache, artifacts or defaults, a short timeout, never failing the pipeline", () => {
    for (const line of ["GIT_STRATEGY: none", "dependencies: []", "cache: []", "inherit:\n    default: false", "timeout: 5 minutes", "allow_failure: true", 'npm_config_ignore_scripts: "true"']) {
      expect(template).toContain(line);
    }
  });

  it("checks the session name with the protocol's name grammar", () => {
    const pattern = /^ {4}to:\n(?: {6}.*\n)*? {6}regex: (.*)$/m.exec(template)?.[1];
    const re = new RegExp(pattern!);
    for (const name of ["build", "a", "0-deploy", "a".repeat(32), "", "-x", "Build", "a".repeat(33), "a_b", "a@b"]) {
      expect(re.test(name), name).toBe(isName(name));
    }
  });

  it("pins wim to this repository's release, exactly", () => {
    const version = (JSON.parse(read("package.json")) as { version: string }).version;
    expect(template).toContain(`      default: "worldinmotion@${version}"\n`);
  });
});
