import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DailyLedger } from "../src/limits.ts";
import type { RunnerOutcome, RunnerRequest, RunnerSpec } from "../src/runner.ts";
import { BUSY, DAILY_CAP, FAILED, NO_TASK, NOT_ACCEPTED, NOT_ACCEPTED_DERIVED, readCode, runWorker, TIMED_OUT, TRUNCATED_NOTE, Worker, type WorkerItem, type WorkerIO } from "../src/worker.ts";
import { clock, config, DESKTOP, LAPTOP, scratchDir, STRANGER } from "./helpers.ts";

const CODE = "Zq7-wake-91";

type Sent = { to: string; text: string; opts: { reply_to: string; kind: string; status?: string } };

function fakeIO(failSend = false) {
  const sent: Sent[] = [];
  const posts: Array<{ room: string; text: string }> = [];
  let cb: ((item: WorkerItem) => void) | undefined;
  const io: WorkerIO = {
    onItem: (f) => void (cb = f),
    send: async (to, text, opts) => {
      if (failSend) throw new Error("relay gone");
      sent.push({ to, text, opts });
    },
    post: async (room, text) => void posts.push({ room, text }),
  };
  return { io, sent, posts, deliver: (i: WorkerItem) => cb!(i) };
}

let n = 0;
function item(extra: Partial<WorkerItem> = {}): WorkerItem {
  n++;
  return { kind: "msg", id: `id${n}`, from: "me@laptop", device: LAPTOP, text: "list the files", relayed: false, trusted: true, ...extra };
}

async function make(extra: Record<string, unknown> = {}, opts: { outcome?: RunnerOutcome | ((req: RunnerRequest) => Promise<RunnerOutcome>); code?: string; cap?: number; failSend?: boolean } = {}) {
  const dir = await scratchDir();
  const c = clock();
  const logs: string[] = [];
  const runs: Array<{ spec: RunnerSpec; req: RunnerRequest }> = [];
  const { limits, ...rest } = extra as { limits?: Record<string, unknown> };
  const cfg = config({ ...rest, limits: { ledgerPath: join(dir, "ledger.json"), dailyJobs: opts.cap ?? 20, ...limits } });
  const { io, sent, posts, deliver } = fakeIO(opts.failSend);
  const outcome = opts.outcome ?? { kind: "answered", answer: "the answer", truncated: false };
  const worker = new Worker({
    config: cfg,
    io,
    ledger: await DailyLedger.open(cfg.limits.ledgerPath, cfg.limits.dailyJobs, c.now),
    ...(opts.code === undefined ? {} : { code: opts.code }),
    env: { PATH: "/bin", HOME: "/home/w", ANTHROPIC_API_KEY: "k", WAKE: CODE, OTHER: "x" },
    now: c.now,
    log: (l) => logs.push(l),
    run: async (spec, req, deps) => {
      runs.push({ spec, req });
      deps.stderr?.("runner said");
      return typeof outcome === "function" ? outcome(req) : outcome;
    },
  });
  worker.start();
  const send = async (i: WorkerItem) => {
    deliver(i);
    await worker.idle();
  };
  return { worker, sent, posts, logs, runs, send, clock: c, dir };
}

describe("who may wake it", () => {
  it("runs a job for an allowed, trusted device and replies to its address", async () => {
    const w = await make();
    await w.send(item());
    expect(w.runs).toHaveLength(1);
    expect(w.runs[0]!.req).toEqual({ v: 2, id: `id${n}`, from: { device: LAPTOP, address: "me@laptop" }, profile: "", text: "list the files" });
    expect(w.sent).toEqual([{ to: "me@laptop", text: "the answer", opts: { reply_to: `id${n}`, kind: "msg" } }]);
  });

  it("ignores a device that is not on the allow-list, even under an allowed device's name", async () => {
    const w = await make();
    // The address (name@device) is the sender's choice; only the signing device id counts.
    await w.send(item({ device: STRANGER, from: "me@laptop" }));
    await w.send(item({ device: undefined }));
    expect(w.runs).toEqual([]);
    expect(w.sent).toEqual([]);
    expect(w.logs.join("\n")).toContain(`from device ${STRANGER}: not_allowed`);
    expect(w.logs.join("\n")).toContain("from device -: no_device");
  });

  it("passes the signed frame to the runner untouched", async () => {
    const w = await make();
    const frame = { v: 1, id: "f", sig: "s", boxes: { x: "y" } };
    await w.send(item({ frame }));
    expect(w.runs[0]!.req.frame).toBe(frame);
    await w.send(item());
    expect(w.runs[1]!.req).not.toHaveProperty("frame");
  });

  it("runs for an allowed device whatever address it uses", async () => {
    const w = await make();
    await w.send(item({ device: DESKTOP, from: "someone-else@desktop" }));
    expect(w.runs[0]!.req.from).toEqual({ device: DESKTOP, address: "someone-else@desktop" });
  });

  it("needs the person's trust too, unless the config says not", async () => {
    const w = await make();
    await w.send(item({ trusted: false }));
    expect(w.runs).toEqual([]);
    expect(w.logs.at(-1)).toContain("untrusted");
    const v = await make({ senders: { devices: [LAPTOP], requireTrusted: false } });
    await v.send(item({ trusted: false }));
    expect(v.runs).toHaveLength(1);
  });

  it("never runs relayed or derived text, results or files", async () => {
    const w = await make();
    await w.send(item({ relayed: true }));
    await w.send(item({ kind: "result" }));
    await w.send(item({ kind: "file" }));
    await w.send(item({ derived: true }));
    expect(w.runs).toEqual([]);
    // Only the derived one hears why, as a generic refusal; with silent refusals not even that.
    expect(w.sent.map((s) => s.text)).toEqual([NOT_ACCEPTED_DERIVED]);
    const q = await make({ replies: { refused: "silent" } });
    await q.send(item({ derived: true }));
    expect(q.sent).toEqual([]);
    expect(w.logs.map((l) => l.split(": ").at(-1))).toEqual(["relayed", "kind", "kind", "derived"]);
  });
});

describe("the wake code", () => {
  it("local: checks and strips it, so the runner never sees it", async () => {
    const w = await make({ wake: { mode: "local", codeEnv: "WAKE" } }, { code: CODE });
    await w.send(item({ text: `${CODE} list the files` }));
    expect(w.runs[0]!.req.text).toBe("list the files");
    expect(JSON.stringify(w.runs[0])).not.toContain(CODE);
    expect(w.runs[0]!.spec.env).not.toHaveProperty("WAKE");
  });

  it("local: refuses a wrong or missing code with the generic reply, or silently", async () => {
    const w = await make({ wake: { mode: "local", codeEnv: "WAKE" } }, { code: CODE });
    await w.send(item({ text: "wrong list the files" }));
    await w.send(item({ text: "list the files" }));
    expect(w.runs).toEqual([]);
    expect(w.sent.map((s) => s.text)).toEqual([NOT_ACCEPTED, NOT_ACCEPTED]);
    expect(w.logs.join("\n")).not.toContain(CODE);
    const s = await make({ wake: { mode: "local", codeEnv: "WAKE" }, replies: { refused: "silent" } }, { code: CODE });
    await s.send(item({ text: "wrong task" }));
    expect(s.sent).toEqual([]);
  });

  it("runner: passes the raw text, code and all, with no profile", async () => {
    const w = await make({ wake: { mode: "runner" } });
    await w.send(item({ text: `${CODE} b: list` }));
    expect(w.runs[0]!.req).toMatchObject({ profile: "", text: `${CODE} b: list` });
    // An empty-looking text still goes: only the runner can judge it.
    await w.send(item({ text: "   " }));
    expect(w.runs).toHaveLength(2);
  });

  it("needs the code at construction in local mode", async () => {
    await expect(make({ wake: { mode: "local", codeEnv: "WAKE" } })).rejects.toThrow("needs the wake code");
    await expect(make({ wake: { mode: "local", codeEnv: "WAKE" } }, { code: "" })).rejects.toThrow("needs the wake code");
  });
});

describe("profiles", () => {
  const profiles = { allowed: ["a", "b"], default: "a" };
  it("parses an allowed prefix after the code and defaults without one", async () => {
    const w = await make({ wake: { mode: "local", codeEnv: "WAKE" }, profiles }, { code: CODE });
    await w.send(item({ text: `${CODE} b: list` }));
    await w.send(item({ text: `${CODE} list` }));
    expect(w.runs.map((r) => [r.req.profile, r.req.text])).toEqual([
      ["b", "list"],
      ["a", "list"],
    ]);
  });

  it("refuses a prefix that is not allowed", async () => {
    const w = await make({ profiles });
    await w.send(item({ text: "c: list" }));
    expect(w.runs).toEqual([]);
    expect(w.sent[0]!.text).toBe(NOT_ACCEPTED);
    expect(w.logs.at(-1)).toContain("profile");
  });

  it("declines a message that holds no task", async () => {
    const w = await make({ profiles });
    await w.send(item({ text: "b:" }));
    const l = await make({ wake: { mode: "local", codeEnv: "WAKE" } }, { code: CODE });
    await l.send(item({ text: CODE }));
    expect([...w.sent, ...l.sent].map((s) => s.text)).toEqual([NO_TASK, NO_TASK]);
    expect([...w.runs, ...l.runs]).toEqual([]);
  });
});

describe("limits", () => {
  it("declines a task over maxTaskChars", async () => {
    const w = await make({ limits: { maxTaskChars: 10 } });
    await w.send(item({ text: "x".repeat(11) }));
    expect(w.sent[0]!.text).toBe("declined: the task is over 10 characters");
    expect(w.runs).toEqual([]);
  });

  it("counts every attempt per device per hour, refused ones too", async () => {
    const w = await make({ wake: { mode: "local", codeEnv: "WAKE" }, limits: { perSenderPerHour: 2 } }, { code: CODE });
    await w.send(item({ text: "guess1 x" }));
    await w.send(item({ text: "guess2 x" }));
    await w.send(item({ text: `${CODE} x` }));
    expect(w.runs).toEqual([]);
    expect(w.sent.map((s) => s.text)).toEqual([NOT_ACCEPTED, NOT_ACCEPTED, BUSY]);
    // Another device has its own allowance; an hour later this one has its back.
    await w.send(item({ device: DESKTOP, text: `${CODE} x` }));
    w.clock.advance(3_600_000);
    await w.send(item({ text: `${CODE} x` }));
    expect(w.runs).toHaveLength(2);
  });

  it("caps jobs per day, on disk", async () => {
    const w = await make({}, { cap: 1 });
    await w.send(item());
    await w.send(item());
    expect(w.runs).toHaveLength(1);
    expect(w.sent.map((s) => s.text)).toEqual(["the answer", DAILY_CAP]);
  });

  it("runs one job at a time and tells the second sender it is busy", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = await make({}, { outcome: async () => (await gate, { kind: "answered", answer: "done", truncated: false }) });
    w.worker.handle(item());
    const second = w.worker.handle(item({ device: DESKTOP }));
    await second;
    expect(w.sent.map((s) => s.text)).toEqual([BUSY]);
    release();
    await w.worker.idle();
    expect(w.runs).toHaveLength(1);
    expect(w.sent.map((s) => s.text)).toEqual([BUSY, "done"]);
    // Free again once the first job ended.
    await w.send(item());
    expect(w.runs).toHaveLength(2);
  });

  it("uses the runner timeout and spec from the config, and only passEnv", async () => {
    const w = await make({ runner: { command: "/opt/r", args: ["--x"], timeoutSeconds: 30, killGraceSeconds: 2, passEnv: ["PATH", "NOPE"] } });
    await w.send(item());
    expect(w.runs[0]!.spec).toEqual({ command: "/opt/r", args: ["--x"], timeoutMs: 30_000, killGraceMs: 2000, env: { PATH: "/bin" } });
  });

  it("ends a task's job by its deadline when that is sooner, and skips one already past", async () => {
    const w = await make({ runner: { command: "/opt/r", timeoutSeconds: 30 } });
    await w.send(item({ kind: "task", deadline: w.clock.now() + 5000 }));
    expect(w.runs[0]!.spec.timeoutMs).toBe(5000);
    await w.send(item({ kind: "task", deadline: w.clock.now() + 60_000 }));
    expect(w.runs[1]!.spec.timeoutMs).toBe(30_000);
    await w.send(item({ kind: "task", deadline: w.clock.now() }));
    expect(w.runs).toHaveLength(2);
    expect(w.sent.at(-1)).toMatchObject({ text: "deadline passed before the job started", opts: { kind: "result", status: "timeout" } });
  });
});

describe("outcomes", () => {
  it.each([
    [{ kind: "refused" } as const, NOT_ACCEPTED, "declined"],
    [{ kind: "busy" } as const, BUSY, "declined"],
    [{ kind: "timeout" } as const, TIMED_OUT, "timeout"],
    [{ kind: "failed", code: 1, signal: null } as const, FAILED, "failed"],
    [{ kind: "answered", answer: "", truncated: false } as const, "(empty answer)", "done"],
    [{ kind: "answered", answer: "long", truncated: true } as const, `long${TRUNCATED_NOTE}`, "done"],
  ])("%o is answered as a result", async (outcome, text, status) => {
    const w = await make({}, { outcome });
    await w.send(item({ kind: "task" }));
    expect(w.sent).toEqual([{ to: "me@laptop", text, opts: { reply_to: `id${n}`, kind: "result", status } }]);
  });

  it("keeps a runner's refusal silent when configured", async () => {
    const w = await make({ replies: { refused: "silent" } }, { outcome: { kind: "refused" } });
    await w.send(item());
    expect(w.sent).toEqual([]);
  });

  it("logs the job, the runner's stderr and failures, never the text", async () => {
    const w = await make({}, { outcome: { kind: "failed", code: 2, signal: null } });
    await w.send(item({ text: "a secret task" }));
    expect(w.logs).toContain("runner: runner said");
    expect(w.logs.some((l) => /job id\d+ failed ms=0 code=2 signal=null/.test(l))).toBe(true);
    expect(w.logs.join("\n")).not.toContain("a secret task");
    const q = await make({ runner: { command: "/r", logStderr: false } });
    await q.send(item());
    expect(q.logs.some((l) => l.startsWith("runner:"))).toBe(false);
  });

  it("logs a reply that could not be sent", async () => {
    const w = await make({}, { failSend: true });
    await w.send(item());
    expect(w.logs.at(-1)).toMatch(/reply to id\d+ not sent: relay gone/);
  });

  it("logs an unexpected failure and goes on", async () => {
    const w = await make({}, { outcome: async () => Promise.reject(new Error("boom")) });
    await w.send(item());
    expect(w.logs.at(-1)).toMatch(/^worker: id\d+: boom$/);
    await w.send(item({ device: DESKTOP }));
    expect(w.runs).toHaveLength(2);
  });
});

describe("room copies", () => {
  it("carry the answer only: never the task, the raw text or the code", async () => {
    const w = await make({ wake: { mode: "local", codeEnv: "WAKE" }, replies: { room: "#agents" } }, { code: CODE, outcome: { kind: "answered", answer: "42 files", truncated: true } });
    await w.send(item({ text: `${CODE} count the secret files` }));
    expect(w.posts).toEqual([{ room: "#agents", text: "42 files" }]);
    expect(JSON.stringify(w.posts)).not.toContain(CODE);
    expect(JSON.stringify(w.posts)).not.toContain("count the secret files");
  });

  it("are not sent for a refusal or a failure", async () => {
    const w = await make({ replies: { room: "#agents" } }, { outcome: { kind: "failed", code: 1, signal: null } });
    await w.send(item());
    expect(w.posts).toEqual([]);
  });

  it("log a copy that could not be posted", async () => {
    const w = await make({ replies: { room: "#agents" } });
    (w.worker as unknown as { o: { io: WorkerIO } }).o.io.post = () => Promise.reject(new Error("not in room"));
    await w.send(item());
    expect(w.logs.at(-1)).toMatch(/room copy of id\d+ not sent: not in room/);
  });
});

describe("readCode", () => {
  const read = async (p: string) => (p === "/code" ? `  ${CODE}\n` : p === "/blank" ? "\n" : "two words");
  it("reads a trimmed code from a file or a variable", async () => {
    expect(await readCode({ mode: "local", codeFile: "/code" }, {}, read)).toBe(CODE);
    expect(await readCode({ mode: "local", codeEnv: "WAKE" }, { WAKE: CODE }, read)).toBe(CODE);
    expect(await readCode({ mode: "runner" }, {}, read)).toBeUndefined();
  });
  it("refuses an empty code or one with whitespace inside", async () => {
    await expect(readCode({ mode: "local", codeFile: "/blank" }, {}, read)).rejects.toThrow("(/blank) is empty or holds whitespace");
    await expect(readCode({ mode: "local", codeFile: "/x" }, {}, read)).rejects.toThrow("holds whitespace");
    await expect(readCode({ mode: "local", codeEnv: "WAKE" }, {}, read)).rejects.toThrow("(WAKE) is empty");
  });
});

describe("runWorker", () => {
  it("reads the code and the ledger, starts, and says so without the code", async () => {
    const dir = await scratchDir();
    const codeFile = join(dir, "code");
    await writeFile(codeFile, CODE);
    const logs: string[] = [];
    const { io, sent, deliver } = fakeIO();
    const worker = await runWorker(config({ wake: { mode: "local", codeFile }, limits: { ledgerPath: join(dir, "l.json") } }), io, {
      log: (l) => logs.push(l),
      env: {},
      run: async () => ({ kind: "answered", answer: "ok", truncated: false }),
      runDeps: {},
    });
    expect(logs).toEqual(["worker: listening; 2 allowed device(s), wake code local, 0 of 50 jobs used today"]);
    deliver(item({ text: `${CODE} go` }));
    await worker.idle();
    expect(sent.map((s) => s.text)).toEqual(["ok"]);
    expect(logs.join("\n")).not.toContain(CODE);
  });

  it("has working defaults: clock, stderr log, process env, real runner", async () => {
    const dir = await scratchDir();
    const { io, sent, deliver } = fakeIO();
    const stderr = process.stderr.write;
    const lines: string[] = [];
    process.stderr.write = ((s: string) => (lines.push(s), true)) as typeof process.stderr.write;
    try {
      const worker = await runWorker(config({ runner: { command: process.execPath, args: ["-e", "process.stdout.write('real')"] }, limits: { ledgerPath: join(dir, "l.json") } }), io);
      deliver(item());
      await worker.idle();
    } finally {
      process.stderr.write = stderr;
    }
    expect(sent.map((s) => s.text)).toEqual(["real"]);
    expect(lines[0]).toContain("worker: listening");
  });
});
