import { describe, expect, it } from "vitest";
import { MAX_ANSWER_BYTES, privilegedMain, type JobHandle, type JobSpec, type PrivilegedDeps } from "../../src/privileged/main.ts";
import { DEVICE, minimal, request, WIF } from "./helpers.ts";

const CODE = "wake-0123456789abcdef";
const SELF = ["/usr/bin/node", "/opt/wim.mjs", "worker", "privileged"];

interface Job {
  out?: string | Buffer;
  err?: string;
  code?: number | null;
  /** Never exits until killed. */
  hang?: boolean;
}

function harness(cfg: Record<string, unknown>, opts: { euid?: number; uid?: number; files?: Record<string, { text: string; uid?: number; mode?: number }>; job?: Job; lockBusy?: boolean; mem?: number; badState?: string; ancestorsRoot?: boolean } = {}) {
  const files = new Map<string, { text: string; uid: number; mode: number }>();
  files.set("/cfg.json", { text: JSON.stringify(cfg), uid: 0, mode: 0o100644 });
  for (const [p, f] of Object.entries(opts.files ?? {})) files.set(p, { text: f.text, uid: f.uid ?? 0, mode: f.mode ?? 0o100600 });
  if (opts.badState !== undefined) files.set("/var/lib/wim-agent-privileged/state.json", { text: opts.badState, uid: 0, mode: 0o100600 });
  const log: string[] = [];
  const out: Buffer[] = [];
  const specs: JobSpec[] = [];
  const kills: string[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const intervals: Array<() => void> = [];
  const ops: string[] = [];
  let signal: (() => void) | undefined;
  let released = 0;
  let stdin: Buffer = Buffer.from(JSON.stringify(request()));
  const euid = opts.euid ?? 0;
  const deps: PrivilegedDeps = {
    euid,
    uid: opts.uid ?? euid,
    readStdin: async () => stdin,
    configFs: {
      readFile: async (p) => {
        const f = files.get(p);
        if (f === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
        return f.text;
      },
      stat: async (p) => {
        const f = files.get(p);
        if (f === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
        return { uid: f.uid, mode: f.mode };
      },
    },
    brokerFs: {
      writeFile: async (p, d, mode) => void files.set(p, { text: d, uid: 0, mode }),
      chown: async (p, u, g) => void ops.push(`chown ${p} ${u}:${g}`),
      rename: async (a, b) => void (files.set(b, files.get(a)!), files.delete(a)),
      rm: async (p) => void (ops.push(`rm ${p}`), files.delete(p)),
    },
    mkdir: async (p, mode) => void ops.push(`mkdir ${p} ${mode.toString(8)}`),
    chown: async (p, u, g) => void ops.push(`chown ${p} ${u}:${g}`),
    lookupUser: async () => ({ uid: 990, gid: 991 }),
    acquireLock: async () => (opts.lockBusy === true ? null : { release: async () => void released++ }),
    memAvailableMb: async () => opts.mem,
    ancestorsAllRoot: async () => opts.ancestorsRoot ?? true,
    identity: { awsWebIdentityToken: async () => "aws.jwt", fetch: async () => ({ ok: true, status: 200, text: async () => "" }), readFile: async () => "" },
    startJob(spec) {
      specs.push(spec);
      const job = opts.job ?? {};
      let resolve!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolve = r));
      let onOut: (b: Buffer) => void = () => undefined;
      let onErr: (b: Buffer) => void = () => undefined;
      const handle: JobHandle = {
        onStdout: (cb) => void (onOut = cb),
        onStderr: (cb) => void (onErr = cb),
        exited,
        killGroup: (s) => {
          kills.push(s);
          if (s === "SIGKILL") resolve(null);
        },
      };
      queueMicrotask(() => {
        if (job.out !== undefined) onOut(Buffer.isBuffer(job.out) ? job.out : Buffer.from(job.out));
        if (job.err !== undefined) onErr(Buffer.from(job.err));
        if (job.hang !== true) resolve(job.code ?? 0);
      });
      return handle;
    },
    now: () => Date.UTC(2026, 10, 8, 12),
    pid: 4242,
    onSignal: (cb) => ((signal = cb), () => (signal = undefined)),
    setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimeout: () => undefined,
    setInterval: (fn) => (intervals.push(fn), "iv"),
    clearInterval: () => undefined,
    out: (d) => void out.push(d),
    err: (l) => void log.push(l),
    worker: { readStdin: async () => "", out: () => undefined, err: () => undefined, loadQuery: async () => () => (async function* () {})() },
  };
  const env: Record<string, string | undefined> = euid === 0 ? {} : { WIM_AGENT_PRIVILEGED_CONFIG: "/cfg.json" };
  return {
    deps,
    env,
    log,
    files,
    specs,
    kills,
    timers,
    intervals,
    ops,
    released: () => released,
    fireSignal: () => signal!(),
    setStdin: (o: unknown) => void (stdin = Buffer.isBuffer(o) ? o : Buffer.from(JSON.stringify(o))),
    output: () => Buffer.concat(out).toString("utf8"),
  };
}

/** As root, the config path is fixed: put the test config there. */
function asRoot(h: ReturnType<typeof harness>) {
  h.files.set("/etc/wim-agent/privileged.json", h.files.get("/cfg.json")!);
  return h;
}

const run = (h: ReturnType<typeof harness>, argv: string[] = []) => privilegedMain(argv, h.env, SELF, h.deps);

describe("privilegedMain: the happy path", () => {
  it("runs the job as the worker user with a minted token and prints only the answer", async () => {
    const h = asRoot(harness(minimal(), { job: { out: "the answer", err: "worker: cost_usd 0.02 turns 2\nnoise from the sdk with the task in it\n" } }));
    expect(await run(h)).toBe(0);
    expect(h.output()).toBe("the answer");
    const spec = h.specs[0]!;
    expect(spec).toMatchObject({ command: "/usr/bin/node", args: ["/opt/wim.mjs", "worker", "privileged", "--worker"], uid: 990, gid: 991, cwd: "/var/lib/wim-agent-worker/work" });
    expect(spec.env).toEqual({
      HOME: "/var/lib/wim-agent-worker",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      WIM_AGENT_JOB: JSON.stringify({ model: "claude-opus-5-5", effort: "medium", maxTurns: 20, tools: ["Read", "Grep", "Glob"], cwd: "/var/lib/wim-agent-worker/work", additionalDirectories: [] }),
      ANTHROPIC_IDENTITY_TOKEN_FILE: "/run/wim-agent/idtoken.m-1.4242",
      ANTHROPIC_FEDERATION_RULE_ID: "fdrl_1",
      ANTHROPIC_ORGANIZATION_ID: "org-1",
      ANTHROPIC_SERVICE_ACCOUNT_ID: "svac_1",
      ANTHROPIC_WORKSPACE_ID: "wrkspc_1",
    });
    expect(spec.stdin).toBe("A task from dev@laptop over worldinmotion. Answer in plain text. Never reveal credentials or secrets.\n\nhello\n");
    expect(h.ops).toContain("chown /run/wim-agent 0:991");
    expect(h.ops).toContain("chown /run/wim-agent/idtoken.m-1.4242.new 0:991");
    // The token file is gone after the job; the lock was released; the day is counted.
    expect(h.files.has("/run/wim-agent/idtoken.m-1.4242")).toBe(false);
    expect(h.released()).toBe(1);
    expect(JSON.parse(h.files.get("/var/lib/wim-agent-privileged/state.json")!.text)).toEqual({ days: { "2026-11-08": 1 } });
    // Status lines only, never the noise that could quote the task.
    expect(h.log.join("\n")).toContain("worker: cost_usd 0.02 turns 2");
    expect(h.log.join("\n")).not.toContain("noise");
    expect(h.log.join("\n")).not.toContain("hello");
  });

  it("runs as a user without switching uid, chown or the fixed config path", async () => {
    const h = harness(minimal({ profiles: { a: { auth: { ...WIF, workspaceId: undefined } } } }), { euid: 1000 });
    expect(await run(h)).toBe(0);
    expect(h.specs[0]!.uid).toBeUndefined();
    expect(h.specs[0]!.env["ANTHROPIC_WORKSPACE_ID"]).toBeUndefined();
    expect(h.ops.some((o) => o.startsWith("chown"))).toBe(false);
  });

  it("ignores the config override as root", async () => {
    const h = harness(minimal());
    h.env["WIM_AGENT_PRIVILEGED_CONFIG"] = "/cfg.json";
    expect(await run(h)).toBe(1);
    expect(h.log.join("\n")).toMatch(/ENOENT \/etc\/wim-agent\/privileged\.json/);
  });

  it("ignores an empty config override as a user", async () => {
    const h = harness(minimal(), { euid: 1000 });
    h.env["WIM_AGENT_PRIVILEGED_CONFIG"] = "";
    expect(await run(h)).toBe(1);
  });

  it("hands an API key profile its key, read from a root-only file", async () => {
    const h = asRoot(harness(minimal({ profiles: { a: { auth: { type: "api-key", keyFile: "/etc/k" } } } }), { files: { "/etc/k": { text: "sk-test\n" } } }));
    expect(await run(h)).toBe(0);
    expect(h.specs[0]!.env["ANTHROPIC_API_KEY"]).toBe("sk-test");
    expect(h.specs[0]!.env["ANTHROPIC_IDENTITY_TOKEN_FILE"]).toBeUndefined();
  });

  it("skips the key file's owner check as a user", async () => {
    const h = harness(minimal({ profiles: { a: { auth: { type: "api-key", keyFile: "/etc/k" } } } }), { euid: 1000, files: { "/etc/k": { text: "sk", uid: 1000, mode: 0o100644 } } });
    expect(await run(h)).toBe(0);
  });

  it("refuses a key file others can read", async () => {
    const h = asRoot(harness(minimal({ profiles: { a: { auth: { type: "api-key", keyFile: "/etc/k" } } } }), { files: { "/etc/k": { text: "sk", mode: 0o100644 } } }));
    expect(await run(h)).toBe(1);
    expect(h.log.join("\n")).toMatch(/refusing the API key file/);
  });

  it("refreshes the token on the broker's timer while the job runs", async () => {
    const h = asRoot(harness(minimal()));
    expect(await run(h)).toBe(0);
    expect(h.intervals.length).toBe(1);
  });

  it("logs a failed token refresh by name and keeps the job running", async () => {
    const h = asRoot(harness(minimal(), { job: { hang: true } }));
    const done = run(h);
    await new Promise((r) => setTimeout(r, 0));
    h.deps.identity.awsWebIdentityToken = async () => Promise.reject(new TypeError("role detail"));
    h.intervals[0]!();
    await new Promise((r) => setTimeout(r, 0));
    h.fireSignal();
    h.timers[1]!.fn();
    expect(await done).toBe(5);
    expect(h.log.join("\n")).toContain("token refresh failed: TypeError");
    expect(h.log.join("\n")).not.toContain("role detail");
  });

  it("fails, naming the error, when something unexpected breaks after the lock", async () => {
    const h = asRoot(harness(minimal()));
    h.deps.lookupUser = async () => Promise.reject(new Error("no such user wim-agent-worker"));
    expect(await run(h)).toBe(1);
    expect(h.log.join("\n")).toMatch(/failed: Error: no such user/);
    expect(h.released()).toBe(1);
  });

  it("truncates a long answer and says so", async () => {
    const h = asRoot(harness(minimal(), { job: { out: Buffer.alloc(MAX_ANSWER_BYTES + 10, 0x61) } }));
    expect(await run(h)).toBe(0);
    expect(h.output()).toMatch(/^a{61440}\n\n\[answer truncated by the privileged runner\]\n$/);
  });
});

describe("privilegedMain: senders, codes and profiles", () => {
  it("refuses a device off the allow-list and runs one on it", async () => {
    const off = asRoot(harness(minimal({ allowDevices: ["AAAAAAAAAAAAAAAAAAAAAA"] })));
    expect(await run(off)).toBe(3);
    expect(off.specs.length).toBe(0);
    const on = asRoot(harness(minimal({ allowDevices: [DEVICE] })));
    expect(await run(on)).toBe(0);
  });

  it("checks and strips the wake code from a root-only file, then reads the prefix after it", async () => {
    const h = asRoot(harness(minimal({ wakeCode: { file: "/etc/code" }, profiles: { a: { auth: WIF }, b: { auth: WIF, model: "claude-sonnet-5-5" } } }), { files: { "/etc/code": { text: `${CODE}\n` } } }));
    h.setStdin(request({ text: `${CODE} b: do it` }));
    expect(await run(h)).toBe(0);
    expect(h.specs[0]!.stdin).toMatch(/\n\ndo it\n$/);
    expect(JSON.parse(h.specs[0]!.env["WIM_AGENT_JOB"]!).model).toBe("claude-sonnet-5-5");
    expect(h.log.join("\n")).not.toContain(CODE);
  });

  it("refuses a missing or wrong code without starting a job", async () => {
    for (const text of ["do it", `${CODE.slice(0, -1)}X do it`]) {
      const h = asRoot(harness(minimal({ wakeCode: { file: "/etc/code" } }), { files: { "/etc/code": { text: CODE } } }));
      h.setStdin(request({ text }));
      expect(await run(h)).toBe(3);
      expect(h.specs.length).toBe(0);
      expect(h.log.join("\n")).toMatch(/no or wrong wake code/);
    }
  });

  it("takes the code from the root side's env", async () => {
    const h = asRoot(harness(minimal({ wakeCode: { env: "WAKE" } })));
    h.env["WAKE"] = CODE;
    h.setStdin(request({ text: `${CODE} do it` }));
    expect(await run(h)).toBe(0);
  });

  it("fails closed on an unusable or missing code", async () => {
    const h = asRoot(harness(minimal({ wakeCode: { env: "WAKE" } })));
    expect(await run(h)).toBe(1);
    expect(h.log.join("\n")).toMatch(/wake code is unusable/);
  });

  it("refuses a code file others can read", async () => {
    const h = asRoot(harness(minimal({ wakeCode: { file: "/etc/code" } }), { files: { "/etc/code": { text: CODE, mode: 0o100640 } } }));
    expect(await run(h)).toBe(1);
  });

  it("refuses a prefix off the list, an empty task and a long task", async () => {
    for (const [text, why] of [
      ["zz: do it", /profile prefix/],
      ["   ", /empty task/],
      ["x".repeat(8001), /over 8000 characters/],
    ] as const) {
      const h = asRoot(harness(minimal()));
      h.setStdin(request({ text }));
      expect(await run(h)).toBe(3);
      expect(h.log.join("\n")).toMatch(why);
    }
  });

  it("takes a local job only from root outside sudo, with allowLocal, skipping devices and the code", async () => {
    const cfg = minimal({ allowLocal: true, allowDevices: [DEVICE], wakeCode: { file: "/etc/code" } });
    const local = request({ from: { device: "local", address: "local@localhost" }, text: "nightly review" });
    const ok = asRoot(harness(cfg));
    ok.setStdin(local);
    expect(await run(ok)).toBe(0);

    const viaSudo = asRoot(harness(cfg));
    viaSudo.env["SUDO_UID"] = "999";
    viaSudo.setStdin(local);
    expect(await run(viaSudo)).toBe(3);

    const off = asRoot(harness(minimal()));
    off.setStdin(local);
    expect(await run(off)).toBe(3);

    // A wrapper that scrubbed SUDO_UID still leaves the peer among the ancestors.
    const scrubbed = asRoot(harness(cfg, { ancestorsRoot: false }));
    scrubbed.setStdin(local);
    expect(await run(scrubbed)).toBe(3);

    const notRoot = asRoot(harness(cfg, { uid: 999 }));
    notRoot.setStdin(local);
    expect(await run(notRoot)).toBe(3);

    const user = harness(cfg, { euid: 1000, uid: 0 });
    user.setStdin(local);
    expect(await run(user)).toBe(3);
  });
});

describe("privilegedMain: limits, lock, timeout", () => {
  it("is busy when memory is low, and ignores the floor when it is 0 or memory is unknown", async () => {
    const low = asRoot(harness(minimal(), { mem: 500 }));
    expect(await run(low)).toBe(4);
    expect(low.log.join("\n")).toMatch(/MemAvailable 500 MB is under 900/);
    expect(await run(asRoot(harness(minimal({ minMemAvailableMb: 0 }), { mem: 10 })))).toBe(0);
    expect(await run(asRoot(harness(minimal())))).toBe(0);
    expect(await run(asRoot(harness(minimal(), { mem: 2000 })))).toBe(0);
  });

  it("is busy when the lock stays held", async () => {
    const h = asRoot(harness(minimal(), { lockBusy: true }));
    expect(await run(h)).toBe(4);
    expect(h.specs.length).toBe(0);
  });

  it("is busy at the daily cap, and releases the lock", async () => {
    const h = asRoot(harness(minimal({ dailyJobs: 1 })));
    h.files.set("/var/lib/wim-agent-privileged/state.json", { text: JSON.stringify({ days: { "2026-11-08": 1 } }), uid: 0, mode: 0o100600 });
    expect(await run(h)).toBe(4);
    expect(h.released()).toBe(1);
  });

  it("does not count when the cap is off", async () => {
    const h = asRoot(harness(minimal({ dailyJobs: 0 })));
    expect(await run(h)).toBe(0);
    expect(h.files.has("/var/lib/wim-agent-privileged/state.json")).toBe(false);
  });

  it("drops yesterday's count", async () => {
    const h = asRoot(harness(minimal()));
    h.files.set("/var/lib/wim-agent-privileged/state.json", { text: JSON.stringify({ days: { "2026-11-07": 20 } }), uid: 0, mode: 0o100600 });
    expect(await run(h)).toBe(0);
    expect(JSON.parse(h.files.get("/var/lib/wim-agent-privileged/state.json")!.text)).toEqual({ days: { "2026-11-08": 1 } });
  });

  it.each([["{"], ["{}"], ["null"]])("fails on a damaged state file (%s) rather than resetting the count", async (text) => {
    const h = asRoot(harness(minimal(), { badState: text }));
    expect(await run(h)).toBe(1);
    expect(h.log.join("\n")).toMatch(/state file is damaged/);
  });

  it("times out: TERM to the group, KILL after the grace, exit 5", async () => {
    const h = asRoot(harness(minimal({ timeoutSeconds: 30, killGraceSeconds: 5 }), { job: { hang: true } }));
    const done = run(h);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.timers[0]!.ms).toBe(30_000);
    h.timers[0]!.fn();
    h.timers[0]!.fn();
    expect(h.kills).toEqual(["SIGTERM"]);
    expect(h.timers[1]!.ms).toBe(5000);
    h.timers[1]!.fn();
    expect(await done).toBe(5);
    expect(h.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(h.released()).toBe(1);
    expect(h.files.has("/run/wim-agent/idtoken.m-1.4242")).toBe(false);
  });

  it("stops the job on a signal (sudo relays the peer's TERM): exit 5", async () => {
    const h = asRoot(harness(minimal(), { job: { hang: true } }));
    const done = run(h);
    await new Promise((r) => setTimeout(r, 0));
    h.fireSignal();
    h.timers[1]!.fn();
    expect(await done).toBe(5);
  });

  it("fails when the job fails", async () => {
    const h = asRoot(harness(minimal(), { job: { code: 1, out: "partial" } }));
    expect(await run(h)).toBe(1);
    expect(h.output()).toBe("");
    expect(h.log.join("\n")).toMatch(/job exited 1/);
  });
});

describe("privilegedMain: argv and requests", () => {
  it("refuses any argument", async () => {
    const h = asRoot(harness(minimal()));
    expect(await run(h, ["--config", "/x"])).toBe(2);
  });

  it("refuses a malformed request with 2 and an oversized one with 3", async () => {
    const bad = asRoot(harness(minimal()));
    bad.setStdin(Buffer.from("nope"));
    expect(await run(bad)).toBe(2);
    const big = asRoot(harness(minimal()));
    big.setStdin(Buffer.alloc(70_000, 0x20));
    expect(await run(big)).toBe(3);
  });

  it("runs the worker mode for --worker", async () => {
    const h = harness(minimal(), { euid: 1000 });
    h.env["WIM_AGENT_JOB"] = "{";
    expect(await run(h, ["--worker"])).toBe(2);
  });
});
