// End to end, from config only: `wim agent init` writes the config on a fresh device, `wim agent
// serve` runs it as a real session on an in-process relay, and other devices' real sessions send it
// work. The runner is a real child process: first a stub that keeps a log of every request it is
// given, then the built-in SDK runner with the SDK's `query` replaced (no API call is ever made).
// Nothing here reaches a hosted relay or a network.

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAILY_CAP, NOT_ACCEPTED, runJob, TIMED_OUT } from "@worldinmotion/agent";
import type { Inbound, MeshSession } from "../src/client.ts";
import { MeshFiles, type Policy } from "../src/mesh.ts";
import { FS, makeMesh, openSession, RelayHarness, run, said, scratch, sleep, term, until, type TestDevice } from "./helpers.ts";

const CODE = "Wk4e2eWAKEcode77";
const TASK = "list the files in the work directory";
const AGENT_SRC = join(import.meta.dirname, "..", "..", "agent", "src");

let relay: RelayHarness;
let mesh: string;
let sender: TestDevice;
let worker: TestDevice;
let stranger: TestDevice;
let tools: string;
let codeFile: string;
let runsLog: string;
const open: MeshSession[] = [];

/** Every file under `dir` whose bytes contain `needle`. */
async function filesHolding(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      // A file written atomically can be renamed away between the listing and the read.
      else if (e.isFile() && (await fs.readFile(p).catch(() => Buffer.alloc(0))).includes(needle)) hits.push(p);
    }
  };
  await walk(dir);
  return hits;
}

async function setPolicy(on: TestDevice, of: TestDevice, level: Policy): Promise<void> {
  await new MeshFiles(on.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, policy: { ...c.policy, [of.device.id]: level } }));
}

async function runs(): Promise<{ id: string; profile: string; text: string; argv: string[]; frame?: unknown }[]> {
  const text = await fs.readFile(runsLog, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as { id: string; profile: string; text: string; argv: string[]; frame?: unknown });
}

/** A session on `d` that records each message it is handed. */
async function listener(d: TestDevice, name: string): Promise<{ s: MeshSession; got: Inbound[] }> {
  const s = await openSession(d, mesh, relay, { name, kind: "cli" });
  open.push(s);
  const got: Inbound[] = [];
  s.on("message", (m: Inbound) => {
    got.push(m);
    void s.take(m.cursor);
    // The worker's answers are relayed, so reading one opens this session's `derived` window and
    // the worker would (rightly) refuse its next task as information only. Each task here stands
    // for one a person sends, not one an agent writes after reading an answer; the window closes.
    (s as unknown as { derivedUntil: number }).derivedUntil = 0;
  });
  return { s, got };
}

beforeAll(async () => {
  relay = new RelayHarness();
  const made = await makeMesh(relay, ["laptop", "worker", "stranger"]);
  mesh = made.mesh;
  [sender, worker, stranger] = made.devices as [TestDevice, TestDevice, TestDevice];
  // What `wim agent doctor` tells each sender to do: let the worker's (relayed) answers through.
  await setPolicy(sender, worker, "deliver-relayed");
  await setPolicy(stranger, worker, "deliver-relayed");

  tools = await scratch("worker-tools");
  codeFile = join(tools, "wake-code");
  await fs.writeFile(codeFile, `${CODE}\n`, { mode: 0o600 });
  runsLog = join(tools, "runs.log");
  // The stub runner: logs each request (outside every WIM_HOME), then answers, fails or hangs.
  await fs.writeFile(
    join(tools, "stub-runner.mjs"),
    `import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
let s = "";
process.stdin.on("data", (c) => (s += c));
process.stdin.on("end", () => {
  const r = JSON.parse(s);
  appendFileSync(${JSON.stringify(runsLog)}, JSON.stringify({ ...r, argv: process.argv.slice(2) }) + "\\n");
  if (r.text.startsWith("hang")) {
    // Ignores SIGTERM, with a child in its process group that does not.
    process.on("SIGTERM", () => undefined);
    const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(${JSON.stringify(join(tools, "pids"))}, JSON.stringify([process.pid, kid.pid]));
    setInterval(() => {}, 1000);
    return;
  }
  process.stdout.write("done: " + r.text.length + " chars, profile " + (r.profile || "-"));
});
`,
  );
  // The built-in SDK runner, with the SDK's query standing in: it records what it was asked.
  await fs.writeFile(
    join(tools, "sdk-runner.mjs"),
    `import { appendFileSync } from "node:fs";
import { runnerMain } from ${JSON.stringify(join(AGENT_SRC, "sdk-runner.ts"))};
const query = async function* ({ prompt, options }) {
  appendFileSync(${JSON.stringify(join(tools, "sdk.log"))}, JSON.stringify({ prompt, model: options.model, effort: options.effort, tools: options.tools, permissionMode: options.permissionMode, settingSources: options.settingSources }) + "\\n");
  yield { type: "system", subtype: "init" };
  yield { type: "result", subtype: "success", is_error: false, result: "mocked answer", num_turns: 1, total_cost_usd: 0 };
};
process.exitCode = await runnerMain(process.argv.slice(2), { stdin: process.stdin, stdout: (t) => process.stdout.write(t), stderr: (l) => process.stderr.write(l + "\\n"), env: process.env, cwd: process.cwd(), query });
`,
  );
}, 60_000);

afterAll(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

/** `wim agent init` on the worker device, with the runner it will use as "this wim". */
async function init(name: string, runner: string, extra: string[]): Promise<string> {
  const dir = join(worker.root, name);
  await fs.mkdir(dir);
  const cfg = join(dir, "worker.json");
  const t = term(worker.root, relay, { wim: () => [process.execPath, join(tools, runner)] });
  expect(await run(t, "agent", "init", cfg, "--allow", sender.device.id, "--wake-file", codeFile, ...extra)).toBe(0);
  expect(said(t)).toContain(`  ${sender.device.id}  laptop`);
  return cfg;
}

/** Edits a written config the way a person would. */
async function edit(cfg: string, change: (c: Record<string, Record<string, unknown>>) => void): Promise<void> {
  const c = JSON.parse(await fs.readFile(cfg, "utf8")) as Record<string, Record<string, unknown>>;
  change(c);
  await fs.writeFile(cfg, JSON.stringify(c));
}

/** `wim agent serve`, until stopped; returns its address and log. */
async function serve(cfg: string): Promise<{ cfg: string; address: string; err: string[]; stop: () => Promise<number> }> {
  const t = term(worker.root, relay, {}, { ANTHROPIC_API_KEY: "test-key-not-real", PATH: process.env["PATH"] });
  const done = run(t, "agent", "serve", cfg, "--as", "agents");
  await until(() => said(t).includes("worker running as") || t.err.length > 0, 15_000, "the worker to start");
  expect(t.err.filter((l) => !l.startsWith("worker: "))).toEqual([]);
  const address = /worker running as (\S+) /.exec(said(t))![1]!;
  return {
    cfg,
    address,
    err: t.err,
    stop: async () => {
      t.stop.abort();
      return done;
    },
  };
}

const replyTo = (got: readonly Inbound[], id: string) => got.find((m) => m.reply_to === id);

describe("wim agent, end to end with a stub runner", () => {
  let w: Awaited<ReturnType<typeof serve>>;
  let me: Awaited<ReturnType<typeof listener>>;
  let room: Awaited<ReturnType<typeof listener>>;

  beforeAll(async () => {
    const cfg = await init("stub", "stub-runner.mjs", ["--room", "#agents", "--profiles", "a,b"]);
    w = await serve(cfg);
    me = await listener(sender, "asker");
    room = await listener(stranger, "watcher");
    await room.s.joinRoom("#agents");
  }, 60_000);
  afterAll(async () => {
    expect(await w.stop()).toBe(0);
  });

  it("a wake from an allowed device runs one job and replies, marked relayed, with a copy to the room", async () => {
    const before = (await runs()).length;
    const out = await me.s.send(w.address, `${CODE} b: ${TASK}`, { kind: "task" });
    await until(() => replyTo(me.got, out.id) !== undefined, 15_000, "the answer");
    const answer = replyTo(me.got, out.id)!;
    expect(answer.text).toBe(`done: ${TASK.length} chars, profile b`);
    expect(answer.relayed).toBe(true);
    expect(answer.status).toBe("done");
    const job = (await runs()).slice(before);
    // The code is checked and stripped before the runner sees the text; the profile is parsed.
    expect(job).toHaveLength(1);
    expect(job[0]).toMatchObject({ v: 2, id: out.id, from: { device: sender.device.id, address: me.s.address }, profile: "b", text: TASK, argv: ["agent", "runner", "--config", join(dirname(w.cfg), "runner.json")] });
    // The signed frame rides along (contract v2), so a runner can check the sender itself.
    expect(job[0]!.frame).toMatchObject({ id: out.id });
    // The room copy is the answer only: never the task, never the code.
    await until(() => room.got.some((m) => m.text.startsWith("done:")), 15_000, "the room copy");
    const copy = room.got.find((m) => m.text.startsWith("done:"))!;
    expect(copy.text).toBe(answer.text);
    expect(copy.text).not.toContain(CODE);
    expect(copy.text).not.toContain(TASK);
    expect(copy.relayed).toBe(true);
  });

  it("a task sent while the sender is still within its derived window is never run", async () => {
    const before = (await runs()).length;
    // Reading a relayed item (an answer) opens the window; the next send carries derived.
    me.s.informed();
    const out = await me.s.send(w.address, `${CODE} ${TASK}`, { kind: "task" });
    await until(() => w.err.some((l) => l.includes(out.id) && l.endsWith("derived")), 15_000, "the refusal");
    (me.s as unknown as { derivedUntil: number }).derivedUntil = 0;
    expect((await runs()).slice(before)).toEqual([]);
    expect(replyTo(me.got, out.id)).toBeUndefined();
  });

  it("a wrong code never runs, and the sender hears only 'not accepted'", async () => {
    const before = (await runs()).length;
    const out = await me.s.send(w.address, `Wk4e2eWAKEcode78 ${TASK}`, { kind: "task" });
    await until(() => replyTo(me.got, out.id) !== undefined, 15_000, "the refusal");
    expect(replyTo(me.got, out.id)!.text).toBe(NOT_ACCEPTED);
    // A message with no code at all, and an empty one after the code.
    const bare = await me.s.send(w.address, TASK, { kind: "task" });
    await until(() => replyTo(me.got, bare.id) !== undefined, 15_000, "the refusal");
    expect(replyTo(me.got, bare.id)!.text).toBe(NOT_ACCEPTED);
    // A profile the config does not list is refused like a wrong code.
    const prof = await me.s.send(w.address, `${CODE} c: ${TASK}`, { kind: "task" });
    await until(() => replyTo(me.got, prof.id) !== undefined, 15_000, "the refusal");
    expect(replyTo(me.got, prof.id)!.text).toBe(NOT_ACCEPTED);
    expect((await runs()).length).toBe(before);
  });

  it("a device not on the allow-list never runs and hears nothing, even under the sender's session name", async () => {
    const before = (await runs()).length;
    // The stranger is trusted by the worker's device and knows the code; it names its session
    // exactly as the allowed sender does. Only the signing device counts.
    const spoof = await listener(stranger, "asker");
    expect(spoof.s.address.split("@")[0]).toBe(me.s.address.split("@")[0]);
    const out = await spoof.s.send(w.address, `${CODE} ${TASK}`, { kind: "task" });
    await until(() => w.err.some((l) => l.includes(out.id) && l.includes("not_allowed")), 15_000, "the worker's log line");
    await sleep(200);
    expect(replyTo(spoof.got, out.id)).toBeUndefined();
    expect((await runs()).length).toBe(before);
  });

  it("a relayed item from the allowed device never runs: held by the client, then refused by the worker", async () => {
    const before = (await runs()).length;
    // The worker's device trusts the sender without --relayed: the client holds it.
    const held = await me.s.send(w.address, `${CODE} ${TASK}`, { kind: "task", relayed: true });
    await sleep(300);
    expect(w.err.some((l) => l.includes(held.id))).toBe(false);
    // With --relayed the client delivers it, and the worker itself refuses it.
    await setPolicy(worker, sender, "deliver-relayed");
    try {
      const out = await me.s.send(w.address, `${CODE} ${TASK}`, { kind: "task", relayed: true });
      await until(() => w.err.some((l) => l.includes(out.id) && l.includes("relayed")), 15_000, "the worker's log line");
      await sleep(200);
      expect(replyTo(me.got, out.id)).toBeUndefined();
    } finally {
      await setPolicy(worker, sender, "deliver");
    }
    expect((await runs()).length).toBe(before);
  });

  it("taking trust away stops the worker at once (senders.requireTrusted)", async () => {
    const before = (await runs()).length;
    await setPolicy(worker, sender, "refuse");
    try {
      const out = await me.s.send(w.address, `${CODE} ${TASK}`, { kind: "task" });
      await sleep(400);
      expect(replyTo(me.got, out.id)).toBeUndefined();
    } finally {
      await setPolicy(worker, sender, "deliver");
    }
    expect((await runs()).length).toBe(before);
  });

  it("a sender that trusts the worker without --relayed gets the answer held, not delivered", async () => {
    await setPolicy(sender, worker, "deliver");
    try {
      const out = await me.s.send(w.address, `${CODE} ${TASK}`, { kind: "task" });
      await until(async () => (await runs()).some((r) => r.id === out.id), 15_000, "the job");
      await sleep(400);
      expect(replyTo(me.got, out.id)).toBeUndefined();
    } finally {
      await setPolicy(sender, worker, "deliver-relayed");
    }
  });

  it("the worker's log and its whole WIM_HOME hold neither the code nor any task text", async () => {
    expect(w.err.join("\n")).not.toContain(CODE);
    expect(w.err.join("\n")).not.toContain(TASK);
    expect(await filesHolding(worker.root, CODE)).toEqual([]);
    expect(await filesHolding(worker.root, TASK)).toEqual([]);
  });
});

describe("wim agent, limits and the timeout kill", () => {
  it("task length, the daily cap and the per-sender rate", async () => {
    const cfg = await init("limits", "stub-runner.mjs", []);
    await edit(cfg, (c) => {
      c["limits"] = { ...c["limits"], maxTaskChars: 60, perSenderPerHour: 4, dailyJobs: 2 };
    });
    const w = await serve(cfg);
    const me = await listener(sender, "limits");
    try {
      const before = (await runs()).length;
      const ask = async (text: string): Promise<string> => {
        const out = await me.s.send(w.address, text, { kind: "task" });
        await until(() => replyTo(me.got, out.id) !== undefined, 15_000, "an answer");
        return replyTo(me.got, out.id)!.text;
      };
      expect(await ask(`${CODE} ${"x".repeat(60)}`)).toBe("declined: the task is over 60 characters");
      expect(await ask(`${CODE} one`)).toMatch(/^done:/);
      expect(await ask(`${CODE} two`)).toMatch(/^done:/);
      expect(await ask(`${CODE} three`)).toBe(DAILY_CAP);
      expect(await ask(`${CODE} four`)).toMatch(/^busy:/);
      expect((await runs()).length - before).toBe(2);
    } finally {
      expect(await w.stop()).toBe(0);
    }
  });

  // Windows has no process groups to signal: the runner's timeout there is a plain kill.
  it.skipIf(process.platform === "win32")("a job past its timeout gets SIGTERM, then SIGKILL, for its whole process group", async () => {
    const cfg = await init("timeout", "stub-runner.mjs", []);
    await edit(cfg, (c) => {
      c["runner"] = { ...c["runner"], timeoutSeconds: 0.5, killGraceSeconds: 0.3 };
    });
    await fs.rm(join(tools, "pids"), { force: true });
    const w = await serve(cfg);
    const me = await listener(sender, "slow");
    try {
      const out = await me.s.send(w.address, `${CODE} hang on`, { kind: "task" });
      await until(() => replyTo(me.got, out.id) !== undefined, 15_000, "the timeout");
      expect(replyTo(me.got, out.id)!.text).toBe(TIMED_OUT);
      expect(replyTo(me.got, out.id)!.status).toBe("timeout");
      const pids = JSON.parse(await fs.readFile(join(tools, "pids"), "utf8")) as number[];
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      await until(() => !pids.some(alive), 5000, "the runner's group to be gone");
    } finally {
      expect(await w.stop()).toBe(0);
    }
  });

  it.skipIf(process.platform === "win32")("a group member it may not signal (EPERM) is logged, and the job still ends as a timeout", async () => {
    // A runner started through sudo leaves root's processes in its group: the worker's SIGTERM
    // to the group fails with EPERM there, and it still sends SIGKILL after the grace.
    const sent: string[] = [];
    const log: string[] = [];
    const outcome = await runJob(
      { command: process.execPath, args: [join(tools, "stub-runner.mjs")], timeoutMs: 300, killGraceMs: 200, env: {} },
      { v: 2, id: "m-eperm", from: { device: sender.device.id, address: "x@y" }, profile: "", text: "hang" },
      {
        log: (l) => void log.push(l),
        killGroup: (pgid, signal) => {
          sent.push(signal);
          if (signal === "SIGTERM") throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
          process.kill(pgid, signal);
        },
      },
    );
    expect(outcome).toEqual({ kind: "timeout" });
    expect(sent).toEqual(["SIGTERM", "SIGKILL"]);
    expect(log.some((l) => l.includes("SIGTERM") && l.includes("EPERM"))).toBe(true);
  });
});

describe("wim agent, the built-in SDK runner with the SDK mocked", () => {
  it("runs the job through runnerMain: code stripped, read-only tools, no settings, the mocked answer back", async () => {
    const cfg = await init("sdk", "sdk-runner.mjs", ["--profiles", "a"]);
    const w = await serve(cfg);
    const me = await listener(sender, "sdk");
    try {
      const out = await me.s.send(w.address, `${CODE} a: ${TASK}`, { kind: "task" });
      await until(() => replyTo(me.got, out.id) !== undefined, 20_000, "the answer");
      expect(replyTo(me.got, out.id)!.text).toBe("mocked answer");
      const calls = (await fs.readFile(join(tools, "sdk.log"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      const call = calls.at(-1)!;
      expect(call["prompt"]).toContain(TASK);
      expect(call["prompt"]).not.toContain(CODE);
      expect(call["model"]).toBe("claude-opus-5-5");
      expect(call["effort"]).toBe("medium");
      expect(call["tools"]).toEqual(["Read", "Grep", "Glob"]);
      expect(call["permissionMode"]).toBe("dontAsk");
      expect(call["settingSources"]).toEqual([]);
      expect(w.err.join("\n")).not.toContain(CODE);
      expect(await filesHolding(worker.root, CODE)).toEqual([]);
    } finally {
      expect(await w.stop()).toBe(0);
    }
  });
});

describe("wim agent, the loop breaker", () => {
  it("a burst past the breaker is refused, and its text is never stored either", async () => {
    const cfg = await init("breaker", "stub-runner.mjs", []);
    const files = new MeshFiles(worker.home.meshDir(mesh), FS);
    const saved = (await files.loadConfig()).breaker;
    await files.updateConfig((c) => ({ ...c, breaker: { ...c.breaker, perPeerPerHour: 2, cooldownMinutes: 60 } }));
    const w = await serve(cfg);
    const me = await listener(sender, "burst");
    const BURST = "count to three, slowly";
    try {
      for (let i = 0; i < 5; i++) await me.s.send(w.address, `${CODE} ${BURST} ${i}`, { kind: "task" });
      await sleep(800);
      expect((await runs()).filter((r) => r.text.startsWith(BURST)).length).toBeLessThanOrEqual(2);
      expect(await filesHolding(worker.root, CODE)).toEqual([]);
      expect(await filesHolding(worker.root, BURST)).toEqual([]);
    } finally {
      expect(await w.stop()).toBe(0);
      await files.updateConfig((c) => ({ ...c, breaker: saved }));
    }
  });
});
