import { describe, expect, it } from "vitest";
import { MAX_ANSWER_BYTES, privilegedMain, type JobHandle, type JobSpec, type PrivilegedDeps } from "../../src/privileged/main.ts";
import type { ProxyOptions } from "../../src/privileged/proxy.ts";
import { DEVICE, device, minimal, RECIPIENT_CFG, recipientKeyFile, request, requestFor, seal, WIF } from "./helpers.ts";

const CODE = "wake-0123456789abcdef";
const SELF = ["/usr/bin/node", "/opt/wim.mjs", "agent", "privileged"];
const PEER = { uid: 995, gid: 995 };
const WORKER = { uid: 990, gid: 991 };
const STATE = "/var/lib/wim-agent-privileged/state.json";
const today = () => new Date().toISOString().slice(0, 10);

interface Job {
  out?: string | Buffer;
  err?: string;
  code?: number | null;
  /** Never exits until killed. */
  hang?: boolean;
}

type File = { text: string; uid: number; mode: number; link?: boolean };

function harness(cfg: Record<string, unknown>, opts: { euid?: number; uid?: number; files?: Record<string, Partial<File> & { text: string }>; job?: Job; lockBusy?: boolean; mem?: number; ancestorsRoot?: boolean; codeProblem?: string } = {}) {
  const euid = opts.euid ?? 0;
  const files = new Map<string, File>();
  const put = (p: string, f: Partial<File> & { text: string }) => files.set(p, { uid: 0, mode: 0o100600, ...f });
  put("/etc/wim-agent/privileged.json", { text: JSON.stringify(cfg), mode: 0o100644 });
  put("/cfg.json", { text: JSON.stringify(cfg), mode: 0o100644 });
  put(`${RECIPIENT_CFG.home}/device.json`, { text: recipientKeyFile(), uid: PEER.uid });
  for (const [p, f] of Object.entries(opts.files ?? {})) put(p, f);
  const log: string[] = [];
  const out: Buffer[] = [];
  const specs: JobSpec[] = [];
  const kills: string[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const proxies: Array<ProxyOptions & { closed: number }> = [];
  const dirs: string[] = [];
  let signal: (() => void) | undefined;
  let released = 0;
  let stdin: Buffer = Buffer.from(JSON.stringify(request()));
  const enoent = (p: string) => Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
  const deps: PrivilegedDeps = {
    euid,
    uid: opts.uid ?? euid,
    readStdin: async () => stdin,
    readFile: async (p, rule) => {
      const f = files.get(p);
      if (f === undefined) throw enoent(p);
      if (rule.owner !== undefined) {
        if (f.link === true) throw Object.assign(new Error(`ELOOP ${p}`), { code: "ELOOP" });
        if (f.uid !== rule.owner || (rule.secret && (f.mode & 0o077) !== 0) || (f.mode & 0o022) !== 0) throw Object.assign(new Error(`refusing ${p}`), { code: "EUNSAFE" });
      }
      return f.text;
    },
    writeFile: async (p, d, mode) => void files.set(p, { text: d, uid: 0, mode }),
    ensureDir: async (p) => void dirs.push(p),
    codeProblem: async () => opts.codeProblem,
    lookupUser: async (name) => (name === RECIPIENT_CFG.user ? PEER : WORKER),
    acquireLock: async () => (opts.lockBusy === true ? null : { release: async () => void released++ }),
    memAvailableMb: async () => opts.mem,
    ancestorsAllRoot: async () => opts.ancestorsRoot ?? true,
    identity: { awsWebIdentityToken: async () => "aws.jwt", fetch: async () => ({ ok: true, status: 200, text: async () => "" }), readFile: async () => "" },
    credentials: async () => ({
      oidcFederationProvider: (c: unknown) => c,
      TokenCache: class {
        readonly c: { identityTokenProvider: () => Promise<string> };
        constructor(c: never, onAdvisoryRefreshError?: (err: unknown) => void) {
          this.c = c;
          // As the SDK's cache does when a background refresh fails.
          onAdvisoryRefreshError!(new TypeError("refresh detail"));
        }
        async getToken() {
          return `access-for-${await this.c.identityTokenProvider()}`;
        }
      },
    }),
    fetch: (async () => new Response("")) as never,
    startProxy: async (o) => {
      const p = { ...o, closed: 0 };
      proxies.push(p);
      return { url: "http://127.0.0.1:4100", key: "wimjob-key", requests: () => 0, close: async () => void p.closed++ };
    },
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
    now: Date.now,
    onSignal: (cb) => ((signal = cb), () => (signal = undefined)),
    setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimeout: () => undefined,
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
    put,
    specs,
    kills,
    timers,
    proxies,
    dirs,
    released: () => released,
    fireSignal: () => signal!(),
    setStdin: (o: unknown) => void (stdin = Buffer.isBuffer(o) ? o : Buffer.from(JSON.stringify(o))),
    output: () => Buffer.concat(out).toString("utf8"),
    logs: () => log.join("\n"),
  };
}

type H = ReturnType<typeof harness>;
const run = (h: H, argv: string[] = []) => privilegedMain(argv, h.env, SELF, h.deps);
/** A request whose signed frame carries `text`. */
const say = (h: H, text: string, over: Record<string, unknown> = {}) => h.setStdin(requestFor(seal(text), text, over));

describe("privilegedMain: the happy path", () => {
  it("authenticates the frame, runs the job as the worker user behind the proxy, and prints only the answer", async () => {
    const h = harness(minimal(), { job: { out: "the answer", err: "worker: cost_usd 0.02 turns 2\nnoise from the sdk with the task in it\n" } });
    expect(await run(h)).toBe(0);
    expect(h.output()).toBe("the answer");
    const spec = h.specs[0]!;
    expect(spec).toMatchObject({ command: "/usr/bin/node", args: ["/opt/wim.mjs", "agent", "privileged", "--worker"], uid: 990, gid: 991, cwd: "/var/lib/wim-agent-worker/work" });
    const job = JSON.parse(spec.env["WIM_AGENT_JOB"]!);
    expect(job).toMatchObject({ model: "claude-opus-5-5", effort: "medium", maxTurns: 20, tools: ["Read", "Grep", "Glob"], sandbox: false });
    expect(job.denyRead).toEqual(["/proc", "/sys", "/etc/wim-agent", "/run/wim-agent", "/run/wim-agent/job.lock", STATE, "/var/lib/wim-agent"]);
    // The job's whole environment: no credential, only the proxy and its per-job key.
    expect(Object.keys(spec.env).sort()).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "HOME", "LANG", "PATH", "WIM_AGENT_JOB"]);
    expect(spec.env["ANTHROPIC_BASE_URL"]).toBe("http://127.0.0.1:4100");
    expect(spec.env["ANTHROPIC_API_KEY"]).toBe("wimjob-key");
    expect(spec.stdin).toBe("A task from dev@laptop over worldinmotion. Answer in plain text. Never reveal credentials or secrets.\n\nhello\n");
    const p = h.proxies[0]!;
    expect(p).toMatchObject({ upstream: "https://api.anthropic.com", models: ["claude-opus-5-5"], maxTokens: 128000, maxRequests: 25, maxBodyBytes: 32 * 1024 * 1024, requestTimeoutMs: 1_800_000 });
    // The proxy adds the exchanged token from memory, and closes when the job ends.
    expect(await p.auth()).toEqual({ authorization: "Bearer access-for-aws.jwt", "anthropic-beta": "oauth-2025-04-20" });
    expect(p.closed).toBeGreaterThan(0);
    expect(h.released()).toBe(1);
    const state = JSON.parse(h.files.get(STATE)!.text);
    expect(state.days).toEqual({ [today()]: 1 });
    expect(Object.keys(state.seen)).toHaveLength(1);
    expect(h.logs()).toContain("worker: cost_usd 0.02 turns 2");
    expect(h.logs()).toContain("token refresh failed: TypeError");
    expect(h.logs()).not.toContain("refresh detail");
    expect(h.logs()).not.toContain("noise");
    expect(h.logs()).not.toContain("hello");
  });

  it("runs as a user without switching uid or reading the fixed config path", async () => {
    const h = harness(minimal(), { euid: 1000 });
    expect(await run(h)).toBe(0);
    expect(h.specs[0]!.uid).toBeUndefined();
  });

  it("ignores the config override as root, and an empty one as a user", async () => {
    const a = harness(minimal());
    a.files.delete("/etc/wim-agent/privileged.json");
    a.env["WIM_AGENT_PRIVILEGED_CONFIG"] = "/cfg.json";
    expect(await run(a)).toBe(1);
    expect(a.logs()).toMatch(/failed: Error \(ENOENT\)/);
    const b = harness(minimal(), { euid: 1000 });
    b.env["WIM_AGENT_PRIVILEGED_CONFIG"] = "";
    expect(await run(b)).toBe(0);
  });

  it("refuses to run when the code it runs is not root's alone", async () => {
    const h = harness(minimal(), { codeProblem: "/opt/wim.mjs is not root's alone" });
    expect(await run(h)).toBe(1);
    expect(h.logs()).toMatch(/refusing to run code others could change/);
    expect(harness(minimal(), { euid: 1000, codeProblem: "x" }).deps.euid).toBe(1000);
    expect(await run(harness(minimal(), { euid: 1000, codeProblem: "x" }))).toBe(0);
  });

  it("gives an API key profile's key to the proxy, never to the job", async () => {
    const h = harness(minimal({ profiles: { a: { auth: { type: "api-key", keyFile: "/etc/k" } } } }), { files: { "/etc/k": { text: "sk-test\n" } } });
    expect(await run(h)).toBe(0);
    expect(await h.proxies[0]!.auth()).toEqual({ "x-api-key": "sk-test" });
    expect(JSON.stringify(h.specs[0]!.env)).not.toContain("sk-test");
    expect(JSON.parse(h.specs[0]!.env["WIM_AGENT_JOB"]!).denyRead).toContain("/etc/k");
  });

  it("refuses a key file others can read", async () => {
    const h = harness(minimal({ profiles: { a: { auth: { type: "api-key", keyFile: "/etc/k" } } } }), { files: { "/etc/k": { text: "sk", mode: 0o100644 } } });
    expect(await run(h)).toBe(1);
    expect(h.logs()).toMatch(/failed: Error \(EUNSAFE\)/);
  });

  it("reads an identity token file as root's file, and denies its directory to the job", async () => {
    const h = harness(minimal({ profiles: { a: { auth: { ...WIF, identity: { type: "file", path: "/run/tok/jwt" } } } } }));
    h.deps.identity.readFile = async () => "never used: the runner reads it securely";
    h.put("/run/tok/jwt", { text: "file.jwt", mode: 0o100644 });
    expect(await run(h)).toBe(0);
    expect(await h.proxies[0]!.auth()).toEqual({ authorization: "Bearer access-for-file.jwt", "anthropic-beta": "oauth-2025-04-20" });
    expect(JSON.parse(h.specs[0]!.env["WIM_AGENT_JOB"]!).denyRead).toContain("/run/tok/jwt");
    const bad = harness(minimal({ profiles: { a: { auth: { ...WIF, identity: { type: "file", path: "/run/tok/jwt" } } } } }));
    bad.put("/run/tok/jwt", { text: "file.jwt", uid: 1000 });
    expect(await run(bad)).toBe(1);
  });

  it("turns the sandbox on for a profile with write tools", async () => {
    const h = harness(minimal({ profiles: { a: { tools: ["Read", "Bash"], unsafeTools: true, auth: WIF } } }));
    expect(await run(h)).toBe(0);
    expect(JSON.parse(h.specs[0]!.env["WIM_AGENT_JOB"]!).sandbox).toBe(true);
  });

  it("truncates a long answer and says so", async () => {
    const h = harness(minimal(), { job: { out: Buffer.alloc(MAX_ANSWER_BYTES + 10, 0x61) } });
    expect(await run(h)).toBe(0);
    expect(h.output()).toMatch(/^a{61440}\n\n\[answer truncated by the privileged runner\]\n$/);
  });
});

describe("privilegedMain: who sent it", () => {
  it("refuses a request without a signed frame when senders are pinned", async () => {
    const h = harness(minimal());
    h.setStdin({ ...request(), frame: undefined });
    expect(await run(h)).toBe(3);
    expect(h.logs()).toMatch(/no signed frame/);
  });

  it("refuses a peer that forges from.device, or rewrites the text, or the id", async () => {
    const forger = device();
    const forged = seal("do it", { from: forger });
    const a = harness(minimal());
    a.setStdin(requestFor({ ...forged, from: { ...forged.from, device: DEVICE } }, "do it"));
    expect(await run(a)).toBe(3);
    expect(a.logs()).toMatch(/does not verify \(bad_signature\)/);
    expect(a.specs.length).toBe(0);
    for (const over of [{ text: "something else" }, { id: "01JB0000000000000000000000" }, { from: { device: forger.id, address: "dev@laptop" } }]) {
      const h = harness(minimal());
      const f = seal("do it");
      h.setStdin({ ...requestFor(f, "do it"), ...over });
      expect(await run(h)).toBe(3);
      expect(h.logs()).toMatch(/disagrees with its signed frame/);
    }
  });

  it("refuses a frame it has run before (a replay), and keeps that across runs", async () => {
    const f = seal("do it");
    const first = harness(minimal());
    first.setStdin(requestFor(f, "do it"));
    expect(await run(first)).toBe(0);
    const again = harness(minimal());
    again.put(STATE, { text: first.files.get(STATE)!.text });
    again.setStdin(requestFor(f, "do it"));
    expect(await run(again)).toBe(3);
    expect(again.logs()).toMatch(/run before/);
  });

  it("forgets seen ids past the freshness window", async () => {
    const h = harness(minimal());
    h.put(STATE, { text: JSON.stringify({ days: {}, seen: { OLDFRAME: 1, NEWFRAME: Date.now() } }) });
    expect(await run(h)).toBe(0);
    expect(Object.keys(JSON.parse(h.files.get(STATE)!.text).seen)).toContain("NEWFRAME");
    expect(Object.keys(JSON.parse(h.files.get(STATE)!.text).seen)).not.toContain("OLDFRAME");
  });

  it("reads the recipient's keys only from the peer user's own 0600 files, never through a symlink", async () => {
    const other = harness(minimal());
    other.put(`${RECIPIENT_CFG.home}/device.json`, { text: recipientKeyFile(), uid: 4242 });
    expect(await run(other)).toBe(1);
    const open = harness(minimal());
    open.put(`${RECIPIENT_CFG.home}/device.json`, { text: recipientKeyFile(), uid: PEER.uid, mode: 0o100644 });
    expect(await run(open)).toBe(1);
    const link = harness(minimal());
    link.put(`${RECIPIENT_CFG.home}/device.json`, { text: recipientKeyFile(), uid: PEER.uid, link: true });
    expect(await run(link)).toBe(1);
    expect(link.specs.length).toBe(0);
  });

  it("refuses an encrypted recipient key file clearly", async () => {
    const h = harness(minimal());
    h.put(`${RECIPIENT_CFG.home}/device.json`, { text: JSON.stringify({ v: 2 }), uid: PEER.uid });
    expect(await run(h)).toBe(3);
    expect(h.logs()).toMatch(/encrypted/);
  });

  it("fails when the prekey file cannot be read for a reason other than its absence", async () => {
    const h = harness(minimal());
    h.put(`${RECIPIENT_CFG.home}/meshes/${RECIPIENT_CFG.mesh}/prekeys.json`, { text: "{}", uid: 4242 });
    expect(await run(h)).toBe(1);
  });

  it("checks and strips the wake code from the signed text, then reads the prefix after it", async () => {
    const h = harness(minimal({ wakeCode: { file: "/etc/code" }, profiles: { a: { auth: WIF }, b: { auth: WIF, model: "claude-sonnet-5-5" } } }), { files: { "/etc/code": { text: `${CODE}\n` } } });
    say(h, `${CODE} b: do it`);
    expect(await run(h)).toBe(0);
    expect(h.specs[0]!.stdin).toMatch(/\n\ndo it\n$/);
    expect(JSON.parse(h.specs[0]!.env["WIM_AGENT_JOB"]!).model).toBe("claude-sonnet-5-5");
    expect(h.logs()).not.toContain(CODE);
  });

  it("refuses a missing or wrong code without starting a job", async () => {
    for (const text of ["do it", `${CODE.slice(0, -1)}X do it`]) {
      const h = harness(minimal({ wakeCode: { file: "/etc/code" } }), { files: { "/etc/code": { text: CODE } } });
      say(h, text);
      expect(await run(h)).toBe(3);
      expect(h.specs.length).toBe(0);
      expect(h.logs()).toMatch(/no or wrong wake code/);
    }
  });

  it("takes the code from the root side's env, and fails closed on an unusable one", async () => {
    const h = harness(minimal({ wakeCode: { env: "WAKE" } }));
    h.env["WAKE"] = CODE;
    say(h, `${CODE} do it`);
    expect(await run(h)).toBe(0);
    const none = harness(minimal({ wakeCode: { env: "WAKE" } }));
    expect(await run(none)).toBe(1);
    expect(none.logs()).toMatch(/wake code is unusable/);
  });

  it("refuses a prefix off the list, an empty task and a long task", async () => {
    for (const [text, why] of [
      ["zz: do it", /profile prefix/],
      ["   ", /empty task/],
      ["x".repeat(16001), /over 16000 characters/],
    ] as const) {
      const h = harness(minimal());
      say(h, text);
      expect(await run(h)).toBe(3);
      expect(h.logs()).toMatch(why);
    }
  });

  it("takes a local job only from root outside sudo, with allowLocal and no frame", async () => {
    const cfg = minimal({ allowLocal: true, wakeCode: { file: "/etc/code" } });
    const local = { v: 2, id: "nightly-1", from: { device: "local", address: "local@localhost" }, profile: "", text: "nightly review" };
    const ok = harness(cfg);
    ok.setStdin(local);
    expect(await run(ok)).toBe(0);
    expect(JSON.parse(ok.files.get(STATE)!.text).seen).toEqual({});
    // A secret file directly under / is denied by its own path, never by denying / itself.
    const top = harness(minimal({ senders: undefined, recipient: undefined, allowLocal: true, wakeCode: { file: "/wake" } }));
    top.setStdin(local);
    expect(await run(top)).toBe(0);
    expect(JSON.parse(top.specs[0]!.env["WIM_AGENT_JOB"]!).denyRead).toEqual(["/proc", "/sys", "/etc/wim-agent", "/run/wim-agent", "/run/wim-agent/job.lock", STATE, "/wake"]);

    const cases: Array<[H, unknown]> = [
      [harness(cfg), { ...local, frame: seal("x") }],
      [harness(cfg, { ancestorsRoot: false }), local],
      [harness(minimal()), local],
      [harness(cfg, { uid: 999 }), local],
      [harness(cfg, { euid: 1000, uid: 0 }), local],
    ];
    const viaSudo = harness(cfg);
    viaSudo.env["SUDO_UID"] = "999";
    cases.push([viaSudo, local]);
    for (const [h, req] of cases) {
      h.setStdin(req);
      expect(await run(h)).toBe(3);
    }
  });

  it("refuses a pinned-sender job when only local jobs are configured", async () => {
    const h = harness(minimal({ senders: undefined, recipient: undefined, allowLocal: true }));
    expect(await run(h)).toBe(3);
    expect(h.logs()).toMatch(/no senders are pinned/);
  });
});

describe("privilegedMain: limits, lock, timeout", () => {
  it("is busy when memory is low, and ignores the floor when it is 0 or memory is unknown", async () => {
    const low = harness(minimal(), { mem: 500 });
    expect(await run(low)).toBe(4);
    expect(low.logs()).toMatch(/MemAvailable 500 MB is under 900/);
    expect(await run(harness(minimal({ minMemAvailableMb: 0 }), { mem: 10 }))).toBe(0);
    expect(await run(harness(minimal()))).toBe(0);
    expect(await run(harness(minimal(), { mem: 2000 }))).toBe(0);
  });

  it("makes the run directory before it takes the lock, and is busy when the lock stays held", async () => {
    const h = harness(minimal(), { lockBusy: true });
    expect(await run(h)).toBe(4);
    expect(h.dirs).toEqual(["/run/wim-agent"]);
    expect(h.specs.length).toBe(0);
  });

  it("is busy at the daily cap, and releases the lock", async () => {
    const h = harness(minimal({ dailyJobs: 1 }));
    h.put(STATE, { text: JSON.stringify({ days: { [today()]: 1 } }) });
    expect(await run(h)).toBe(4);
    expect(h.released()).toBe(1);
  });

  it("counts but does not cap when the cap is off, and drops yesterday's count", async () => {
    const h = harness(minimal({ dailyJobs: 0 }));
    h.put(STATE, { text: JSON.stringify({ days: { "2026-01-01": 20, [today()]: 7 }, seen: {} }) });
    expect(await run(h)).toBe(0);
    expect(JSON.parse(h.files.get(STATE)!.text).days).toEqual({ [today()]: 8 });
  });

  it.each([["{"], ["{}"], ["null"], ['{"days":{"x":1}}'], ['{"days":{"2026-01-01":-1}}'], ['{"days":[]}'], ['{"days":{},"seen":{"a":"b"}}'], ['{"days":{},"extra":1}']])(
    "fails on a damaged state file (%s) rather than resetting the count",
    async (text) => {
      const h = harness(minimal());
      h.put(STATE, { text });
      expect(await run(h)).toBe(1);
      expect(h.logs()).toMatch(/state file is damaged/);
    },
  );

  it("refuses a state file someone else could have written", async () => {
    const h = harness(minimal());
    h.put(STATE, { text: JSON.stringify({ days: {} }), uid: 1000 });
    expect(await run(h)).toBe(1);
  });

  it("times out: TERM to the group, KILL after the grace, exit 5, the proxy closed", async () => {
    const h = harness(minimal({ timeoutSeconds: 30, killGraceSeconds: 5 }), { job: { hang: true } });
    const done = run(h);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.timers[0]!.ms).toBe(30_000);
    h.timers[0]!.fn();
    h.timers[0]!.fn();
    expect(h.kills).toEqual(["SIGTERM"]);
    expect(h.timers[1]!.ms).toBe(5000);
    h.timers[1]!.fn();
    expect(await done).toBe(5);
    expect(h.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(h.released()).toBe(1);
    expect(h.proxies[0]!.closed).toBeGreaterThan(0);
  });

  it("stops the job on a signal (sudo relays the peer's TERM): exit 5", async () => {
    const h = harness(minimal(), { job: { hang: true } });
    const done = run(h);
    await new Promise((r) => setTimeout(r, 20));
    h.fireSignal();
    h.timers[1]!.fn();
    expect(await done).toBe(5);
  });

  it("fails when the job fails, and when something unexpected breaks after the lock", async () => {
    const h = harness(minimal(), { job: { code: 1, out: "partial" } });
    expect(await run(h)).toBe(1);
    expect(h.output()).toBe("");
    expect(h.logs()).toMatch(/job exited 1/);
    const u = harness(minimal());
    u.deps.lookupUser = async (name) => (name === RECIPIENT_CFG.user ? PEER : Promise.reject(new Error("no such user wim-agent-worker")));
    expect(await run(u)).toBe(1);
    expect(u.logs()).toMatch(/failed: Error$/m);
    expect(u.released()).toBe(1);
  });

  it("logs an unexpected error by its name only, never its message (which can quote a token)", async () => {
    const h = harness(minimal());
    h.deps.lookupUser = async () => Promise.reject(new SyntaxError('Unexpected token "eyJhbGciOi" in JSON'));
    expect(await run(h)).toBe(1);
    expect(h.logs()).toMatch(/failed: SyntaxError$/m);
    expect(h.logs()).not.toContain("eyJ");
  });

  it("names our own config errors in full", async () => {
    const h = harness({ v: 1 });
    expect(await run(h)).toBe(1);
    expect(h.logs()).toMatch(/failed: .*defaultProfile/);
  });
});

describe("privilegedMain: argv and requests", () => {
  it("refuses any argument", async () => {
    expect(await run(harness(minimal()), ["--config", "/x"])).toBe(2);
  });

  it("refuses a malformed request with 2 and an oversized one with 3", async () => {
    const bad = harness(minimal());
    bad.setStdin(Buffer.from("nope"));
    expect(await run(bad)).toBe(2);
    const big = harness(minimal());
    big.setStdin(Buffer.alloc(2 * 1024 * 1024, 0x20));
    expect(await run(big)).toBe(3);
  });

  it("runs the worker mode for --worker", async () => {
    const h = harness(minimal(), { euid: 1000 });
    h.env["WIM_AGENT_JOB"] = "{";
    expect(await run(h, ["--worker"])).toBe(2);
  });
});
