// The privileged runner end to end with real processes, files and flock(1): a stub worker
// stands in for the Agent SDK job, so no model is ever called.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privilegedMain } from "../../src/privileged/main.ts";
import { systemDeps } from "../../src/privileged/system.ts";
import { DEVICE, request } from "./helpers.ts";

const CODE = "wake-0123456789abcdef";
let dir: string;
let stub: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(join(process.env["WIM_TEST_TMP"] || tmpdir(), "wim-priv-e2e-"));
  await fs.mkdir(join(dir, "work"));
  await fs.writeFile(join(dir, "source-token"), "id.jwt\n");
  // The stub worker: what the job sees (prompt, options, token file, environment), as JSON.
  stub = join(dir, "stub-worker.mjs");
  await fs.writeFile(
    stub,
    `import { readFileSync } from "node:fs";
if (process.argv[2] !== "--worker") process.exit(9);
let prompt = ""; process.stdin.on("data", (d) => (prompt += d)).on("end", () => {
  if (prompt.includes("hang")) { setTimeout(() => {}, 60000); return; }
  const tokenFile = process.env.ANTHROPIC_IDENTITY_TOKEN_FILE;
  process.stderr.write("worker: cost_usd 0 turns 1\\n");
  process.stdout.write(JSON.stringify({ prompt, job: JSON.parse(process.env.WIM_AGENT_JOB), token: readFileSync(tokenFile, "utf8"), keys: Object.keys(process.env).sort() }));
});`,
  );
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeConfig(extra: Record<string, unknown> = {}): Promise<string> {
  const path = join(dir, "privileged.json");
  const cfg = {
    v: 1,
    worker: { user: userInfo().username, home: dir, cwd: join(dir, "work") },
    runDir: join(dir, "run"),
    lock: { path: join(dir, "job.lock"), waitSeconds: 0 },
    statePath: join(dir, "state", "state.json"),
    minMemAvailableMb: 0,
    allowDevices: [DEVICE],
    wakeCode: { file: join(dir, "wake-code") },
    defaultProfile: "a",
    profiles: {
      a: { auth: { type: "wif", organizationId: "org", federationRuleId: "rule", serviceAccountId: "sa", workspaceId: "ws", identity: { type: "file", path: join(dir, "source-token") } } },
      b: { model: "claude-sonnet-5-5", effort: "high", auth: { type: "wif", organizationId: "org", federationRuleId: "rule", serviceAccountId: "sa", identity: { type: "file", path: join(dir, "source-token") } } },
    },
    ...extra,
  };
  await fs.writeFile(path, JSON.stringify(cfg));
  await fs.writeFile(join(dir, "wake-code"), `${CODE}\n`, { mode: 0o600 });
  return path;
}

async function runOnce(text: string, cfgPath: string): Promise<{ code: number; out: string; err: string[] }> {
  const deps = systemDeps();
  const out: Buffer[] = [];
  const err: string[] = [];
  deps.readStdin = async () => Buffer.from(JSON.stringify(request({ text })));
  deps.out = (b) => void out.push(b);
  deps.err = (l) => void err.push(l);
  const code = await privilegedMain([], { WIM_AGENT_PRIVILEGED_CONFIG: cfgPath }, [process.execPath, stub], deps);
  return { code, out: Buffer.concat(out).toString("utf8"), err };
}

describe.runIf(process.platform === "linux" && process.geteuid!() !== 0)("privileged runner, real processes", () => {
  it("checks the code, picks the profile, mints the token file and runs the job with only its variables", async () => {
    const cfg = await writeConfig();
    const r = await runOnce(`${CODE} b: summarise the tree`, cfg);
    expect(r.code).toBe(0);
    const seen = JSON.parse(r.out) as { prompt: string; job: { model: string; effort: string }; token: string; keys: string[] };
    expect(seen.prompt).toMatch(/\n\nsummarise the tree\n$/);
    expect(seen.prompt).not.toContain(CODE);
    expect(seen.job).toMatchObject({ model: "claude-sonnet-5-5", effort: "high" });
    expect(seen.token).toBe("id.jwt");
    expect(seen.keys).toEqual([
      "ANTHROPIC_FEDERATION_RULE_ID",
      "ANTHROPIC_IDENTITY_TOKEN_FILE",
      "ANTHROPIC_ORGANIZATION_ID",
      "ANTHROPIC_SERVICE_ACCOUNT_ID",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "HOME",
      "LANG",
      "PATH",
      "WIM_AGENT_JOB",
    ]);
    // The token file is gone once the job ends; the day was counted.
    expect(await fs.readdir(join(dir, "run"))).toEqual([]);
    expect(JSON.parse(await fs.readFile(join(dir, "state", "state.json"), "utf8")).days).toEqual({ [new Date().toISOString().slice(0, 10)]: 1 });
    expect(r.err.join("\n")).not.toContain(CODE);
  });

  it("refuses a wrong code with 3 and starts nothing", async () => {
    const r = await runOnce("not-the-code do it", await writeConfig());
    expect(r.code).toBe(3);
    expect(r.out).toBe("");
  });

  it("is busy (4) while another holder, such as a scheduled job's flock on fd 9, has the lock", async () => {
    const cfg = await writeConfig();
    const shell = spawn("bash", ["-c", `exec 9>"$0"; flock 9; echo held; sleep 30`, join(dir, "job.lock")], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise((r) => shell.stdout.once("data", r));
    try {
      expect((await runOnce(`${CODE} do it`, cfg)).code).toBe(4);
    } finally {
      shell.kill("SIGKILL");
      await new Promise((r) => shell.once("exit", r));
    }
  });

  it("times out a job that hangs, ending its process group: 5", async () => {
    const cfg = await writeConfig({ timeoutSeconds: 1, killGraceSeconds: 1 });
    const started = Date.now();
    expect((await runOnce(`${CODE} hang`, cfg)).code).toBe(5);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await fs.readdir(join(dir, "run"))).toEqual([]);
  }, 10_000);

});
