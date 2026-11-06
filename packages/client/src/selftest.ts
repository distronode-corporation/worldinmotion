// `wim test`: QA that runs inside wim itself (SECURITY-MODEL section 7.6). The sandbox mode starts
// a relay in this process on loopback (relay-node on an in-memory database), makes throwaway
// devices in a fresh temporary directory, and drives the real `wim` commands on them through a
// scripted terminal, playing the person for the person-only steps. Everything it made is removed
// at the end, failures included.
//
// Isolation is the security property. The scripted terminal and its person exist only here and
// are reached only from `wim test`, never from another command, an MCP tool or an events request.
// Each device's environment is built from nothing (no WIM_HOME, CLAUDE_CONFIG_DIR or agent
// variable of the caller), each state directory must not exist before the run, and before every
// step every path is checked to be inside the run's own directory with no symbolic link on the
// way, and the relay to be the run's own on loopback. Nothing the caller's device holds is read
// or written: the command never even resolves that device's directory except to refuse a
// temporary directory inside it.

import { start, type RunningRelay } from "@worldinmotion/relay-node";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import type { CliIO } from "./cli.ts";
import { MeshSession, type Inbound } from "./client.ts";
import { Home } from "./home.ts";
import { MeshFiles, type BreakerLimits } from "./mesh.ts";
import { homeChoice } from "./platform.ts";
import { wsDialer, type Dialer } from "./wire.ts";

/** `main` from cli.ts, passed in so this module does not import the CLI it is part of. */
export type Main = (argv: readonly string[], env: Record<string, string | undefined>, io: CliIO) => Promise<number>;

/** A refusal of the sandbox's isolation rules. */
export class SandboxError extends Error {}

// The scripted terminal.

/**
 * An answer to a prompt: a line, or one read when the question comes (a code another terminal
 * printed), or work another terminal does while the prompt is open before the line comes.
 */
export type Answer = string | (() => string | Promise<string>);

/** A terminal a script types into: what the command printed, and the answers its prompts get, in order. */
export type Term = { io: CliIO; out: string[]; err: string[]; answers: Answer[]; stop: AbortController; env: Record<string, string | undefined> };

/** What a scripted terminal is made of. `extra` overrides any part of its io. */
export type TermSpec = {
  home: string;
  env: Record<string, string | undefined>;
  hostname: string;
  platform: CliIO["platform"];
  uid: number | undefined;
  pid: number;
  now: () => number;
  dialer: Dialer;
  fetch: typeof fetch;
  extra?: Partial<CliIO>;
};

/**
 * A scripted interactive terminal for one device: stdin and stdout are terminals, so a person's
 * steps are allowed, and each prompt takes the next answer (an empty line when none is left,
 * which every prompt reads as no). The prompt's question is recorded in `out`.
 */
export function scriptedTerm(spec: TermSpec): Term {
  const out: string[] = [];
  const err: string[] = [];
  const answers: Answer[] = [];
  const stop = new AbortController();
  const io: CliIO = {
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
    prompt: async (q) => {
      out.push(q);
      const a = answers.shift() ?? "";
      return typeof a === "string" ? a : a();
    },
    signal: stop.signal,
    cwd: spec.home,
    homedir: spec.home,
    hostname: spec.hostname,
    platform: spec.platform,
    uid: spec.uid,
    pid: spec.pid,
    now: spec.now,
    dialer: spec.dialer,
    isTTY: true,
    inputIsTTY: true,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    fetch: spec.fetch,
    parentGone: () => false,
    ...spec.extra,
  };
  return { io, out, err, answers, stop, env: spec.env };
}

/** Everything a terminal printed, in one string. */
export const said = (t: Term): string => [...t.out, ...t.err].join("\n");

// The isolation rules.

/** Whether `path` is `root` or inside it. */
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Whether `url` is a plain WebSocket URL on the IPv4 loopback address. */
export function onLoopback(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "ws:" && u.hostname === "127.0.0.1";
}

/**
 * Refuses `path` unless it is inside `root`, `root` is its own real path, and nothing between
 * them is a symbolic link. A part that does not exist yet ends the walk: nothing below it exists.
 */
export async function noLinks(root: string, path: string): Promise<void> {
  if ((await fs.realpath(root)) !== root) throw new SandboxError(`the sandbox ${root} is reached through a symbolic link`);
  if (!inside(root, path)) throw new SandboxError(`${path} is outside the sandbox ${root}`);
  let at = root;
  for (const part of relative(root, path).split(sep).filter((p) => p !== "")) {
    at = join(at, part);
    const st = await fs.lstat(at).catch(() => undefined);
    if (st === undefined) return;
    if (st.isSymbolicLink()) throw new SandboxError(`${at} is a symbolic link`);
  }
}

/**
 * A sandbox device's environment, built from nothing: its own state directory, and crash reports
 * off. No variable of the caller's reaches it (WIM_HOME, CLAUDE_CONFIG_DIR, an agent's).
 */
export function deviceEnv(dir: string): Record<string, string> {
  return { WIM_HOME: dir, WIM_NO_CRASH_REPORTS: "1" };
}

/** A dialer that reaches only `relayUrl`'s meshes. */
export function sandboxDialer(relayUrl: string, real: Dialer): Dialer {
  return (url, opts) => (url.startsWith(`${relayUrl}/`) ? real(url, opts) : Promise.reject(new SandboxError(`refusing to dial ${url}: only the sandbox relay ${relayUrl} is reached`)));
}

/** A fetch that reaches only the sandbox relay's HTTP side (`base`, ending in a slash). */
export function sandboxFetch(base: string, real: typeof fetch): typeof fetch {
  return ((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    return url.startsWith(base) ? real(input, init) : Promise.reject(new SandboxError(`refusing to fetch ${url}: only the sandbox relay ${base} is reached`));
  }) as typeof fetch;
}

/** One run's own directory, devices and relay, and the checks made before every step. */
export class Sandbox {
  readonly root: string;
  private readonly dirs = new Map<string, string>();
  private relay: string | undefined;

  private constructor(root: string) {
    this.root = root;
  }

  /**
   * Makes a fresh directory under `base`. Refused when `base` is inside the caller's state
   * directory or the config directory that holds every profile's (`real`), so the run never
   * writes there.
   */
  static async open(base: string, real: readonly string[]): Promise<Sandbox> {
    const at = await fs.realpath(base);
    for (const r of real) {
      const resolved = await fs.realpath(r).catch(() => resolve(r));
      if (inside(resolved, at)) throw new SandboxError(`the temporary directory ${at} is inside this device's state ${resolved}: set TMPDIR to another directory`);
    }
    return new Sandbox(await fs.mkdtemp(join(at, "wim-test-")));
  }

  /** The run's relay: refused unless it is on loopback. */
  attach(url: string): void {
    if (!onLoopback(url)) throw new SandboxError(`the sandbox relay must be on loopback, not ${url}`);
    this.relay = url;
  }

  get relayUrl(): string {
    return this.relay!;
  }

  /** A new device's state directory, made now. Refused when anything is at its path already. */
  async device(name: string): Promise<string> {
    const dir = join(this.root, name);
    await noLinks(this.root, dir);
    await fs.mkdir(dir, { mode: 0o700 }).catch((error: unknown) => {
      throw new SandboxError(`refusing the state directory ${dir}: ${(error as Error).message}`);
    });
    this.dirs.set(name, dir);
    return dir;
  }

  /** A device's state directory that the run never makes (a device not set up). Refused when anything is there. */
  async absent(name: string): Promise<string> {
    const dir = join(this.root, name);
    if (await fs.lstat(dir).then(() => true, () => false)) throw new SandboxError(`refusing the state directory ${dir}: it already exists`);
    this.dirs.set(name, dir);
    return dir;
  }

  /** The checks made before every step: every path inside the run's directory, the relay the run's own. */
  async check(): Promise<void> {
    for (const dir of this.dirs.values()) await noLinks(this.root, dir);
    if (this.relay === undefined || !onLoopback(this.relay)) throw new SandboxError(`the relay ${String(this.relay)} is not the sandbox's own`);
  }

  /** Removes everything the run made. */
  async remove(): Promise<void> {
    await fs.rm(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// Steps.

export type StepResult = "pass" | "fail" | "skip";
export type StepRow = { name: string; result: StepResult; ms: number; detail?: string };
export type Step = { name: string; run: () => Promise<void> };

/** The longest one step may take. */
export const STEP_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls `get` until it gives a value, or fails after `ms`. */
export async function waitFor<T>(get: () => T | undefined | Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** Resolves once `t` printed something `re` matches, or fails after `ms`. */
function shows(t: Term, re: RegExp, ms: number, what: string): Promise<true> {
  return waitFor(() => (re.test(said(t)) ? true : undefined), ms, what);
}

/** Fails a step unless `ok`. */
export function need(ok: boolean, what: string): void {
  if (!ok) throw new Error(what);
}

/** The first group `re` finds in `text`, or a step failure naming `what`. */
export function grab(text: string, re: RegExp, what: string): string {
  const m = re.exec(text);
  if (m === null) throw new Error(`no ${what} in the output`);
  return m[1]!;
}

/** Rejects after `ms`, or once `signal` is aborted (Ctrl-C), unless `p` settles first. */
function within(p: Promise<void>, ms: number, signal: AbortSignal): Promise<void> {
  let reject!: (error: Error) => void;
  const late = new Promise<void>((_, r) => (reject = r));
  const t = setTimeout(() => reject(new Error(`timed out after ${ms / 1000} s`)), ms);
  const onAbort = (): void => reject(new Error("stopped"));
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([p, late]).finally(() => {
    clearTimeout(t);
    signal.removeEventListener("abort", onAbort);
  });
}

/**
 * Runs `steps` in order, `before` ahead of each (the isolation checks). After a failure, or once
 * `signal` is aborted, the rest are skipped: each step builds on the ones before it.
 */
export async function runSteps(steps: readonly Step[], before: () => Promise<void>, signal: AbortSignal, ms = STEP_MS): Promise<StepRow[]> {
  const rows: StepRow[] = [];
  let failed = false;
  for (const step of steps) {
    if (failed || signal.aborted) {
      rows.push({ name: step.name, result: "skip", ms: 0, detail: signal.aborted ? "stopped" : "an earlier step failed" });
      continue;
    }
    const t0 = Date.now();
    try {
      await within(before().then(step.run), ms, signal);
      rows.push({ name: step.name, result: "pass", ms: Date.now() - t0 });
    } catch (error) {
      failed = true;
      rows.push({ name: step.name, result: "fail", ms: Date.now() - t0, detail: (error as Error).message });
    }
  }
  return rows;
}

/** The table `wim test` prints: one row per step, then the summary line. */
export function report(rows: readonly StepRow[], ms: number): string[] {
  const width = Math.max(...rows.map((r) => r.name.length));
  const count = (r: StepResult): number => rows.filter((x) => x.result === r).length;
  return [
    ...rows.map((r) => `  ${r.result.padEnd(4)}  ${r.name.padEnd(width)}  ${String(r.ms).padStart(6)} ms${r.detail === undefined ? "" : `  ${r.detail}`}`),
    `${count("fail") === 0 && count("skip") === 0 ? "PASS" : "FAIL"}: ${rows.length} steps, ${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped, in ${(ms / 1000).toFixed(1)} s.`,
  ];
}

/** One sandbox device: its name and state directory. */
type Dev = { name: string; dir: string };

/** A command still running (a `wim watch`, a `wim invite` waiting for a join). */
type Running = { term: Term; done: Promise<number> };

/** One sandbox run: its devices, its relay, and the commands it runs on them. */
export class Run {
  readonly terms: Term[] = [];
  readonly sessions: MeshSession[] = [];
  readonly running: Running[] = [];
  box: Sandbox | undefined;
  relay: RunningRelay | undefined;
  readonly devs = new Map<string, Dev>();
  /** Mesh ids by role: the run's mesh, and device A's second one. */
  mesh = "";
  second = "";
  /** How long a running command may take to print that it is ready. */
  readyMs = 15_000;

  readonly main: Main;
  readonly io: CliIO;
  readonly base: string;
  readonly real: readonly string[];

  constructor(main: Main, io: CliIO, base: string, real: readonly string[]) {
    this.main = main;
    this.io = io;
    this.base = base;
    this.real = real;
  }

  check(): Promise<void> {
    return this.box?.check() ?? Promise.resolve();
  }

  async open(): Promise<void> {
    this.box = await Sandbox.open(this.base, this.real);
    this.relay = await start({ db: ":memory:", port: 0, host: "127.0.0.1", log: () => undefined });
    this.box.attach(this.relay.relayUrls[0]!);
  }

  async device(name: string, made = true): Promise<Dev> {
    const dir = made ? await this.box!.device(name) : await this.box!.absent(name);
    const dev = { name, dir };
    this.devs.set(name, dev);
    return dev;
  }

  dev(name: string): Dev {
    return this.devs.get(name)!;
  }

  term(dev: Dev, answers: readonly Answer[]): Term {
    const url = this.box!.relayUrl;
    const t = scriptedTerm({
      home: dev.dir,
      env: deviceEnv(dev.dir),
      hostname: dev.name,
      platform: this.io.platform,
      uid: this.io.uid,
      pid: this.io.pid,
      now: this.io.now,
      dialer: sandboxDialer(url, wsDialer),
      fetch: sandboxFetch(`${url.replace(/^ws:/, "http:")}/`, fetch),
    });
    t.answers.push(...answers);
    this.terms.push(t);
    return t;
  }

  /** Runs one command on `dev` to its end, answering its prompts with `answers`, or in the terminal `t`. */
  async cmd(dev: Dev, argv: readonly string[], answers: readonly Answer[] = [], t = this.term(dev, answers)): Promise<{ code: number; text: string }> {
    const code = await this.main(argv, t.env, t.io);
    return { code, text: said(t) };
  }

  /** Runs `argv` on `dev` and fails the step unless it exits 0. */
  async ok(dev: Dev, argv: readonly string[], answers: readonly Answer[] = []): Promise<string> {
    const r = await this.cmd(dev, argv, answers);
    need(r.code === 0, `\`wim ${argv.join(" ")}\` on ${dev.name} exited ${r.code}: ${lastLine(r.text)}`);
    return r.text;
  }

  /** Starts a command that keeps running, such as `wim watch`, and waits for `ready` in its output. */
  async background(dev: Dev, argv: readonly string[], ready: RegExp, answers: readonly Answer[] = []): Promise<Running> {
    const term = this.term(dev, answers);
    const r = { term, done: this.main(argv, term.env, term.io) };
    this.running.push(r);
    await shows(term, ready, this.readyMs, `\`wim ${argv.join(" ")}\` on ${dev.name}`).catch((error: unknown) => {
      throw new Error(`${(error as Error).message}: ${lastLine(said(term))}`);
    });
    return r;
  }

  /** Stops a running command (Ctrl-C) and waits for it to end. */
  async stop(r: Running): Promise<void> {
    r.term.stop.abort();
    await r.done;
  }

  /**
   * A session of `dev` in the run's mesh, as an agent's MCP server runs one, for the steps the
   * command line has no command for (rooms, files, leases, ask and reply, rename).
   */
  async session(dev: Dev, name: string): Promise<MeshSession> {
    const env = { platform: this.io.platform, pid: this.io.pid };
    const home = new Home(dev.dir, { ...env, uid: this.io.uid });
    const s = await MeshSession.open({
      device: await home.requireDevice(),
      mesh: new MeshFiles(home.meshDir(this.mesh), env),
      name,
      kind: "mcp",
      dialer: sandboxDialer(this.box!.relayUrl, wsDialer),
      env,
      now: this.io.now,
      // The file checks read the person's home directory; here that is the device's own.
      userHome: dev.dir,
    });
    this.sessions.push(s);
    s.start();
    await s.ready(15_000);
    return s;
  }

  /** The mesh.json of `dev`'s copy of the run's mesh. */
  meshFiles(dev: Dev): MeshFiles {
    const env = { platform: this.io.platform, pid: this.io.pid };
    return new MeshFiles(new Home(dev.dir, { ...env, uid: this.io.uid }).meshDir(this.mesh), env);
  }

  /** Stops what still runs, closes the relay, and removes the sandbox. */
  async close(): Promise<void> {
    for (const t of this.terms) t.stop.abort();
    await Promise.allSettled([...this.running.map((r) => r.done), ...this.sessions.map((s) => s.stop({ ended: true }))]);
    await this.relay?.close();
    await this.box?.remove();
  }
}

const lastLine = (text: string): string => text.trim().split("\n").at(-1)!;

/** The comparison code a `wim join` printed, once it has. */
const sasIn = (t: Term): Promise<string> => waitFor(() => /Its comparison code is (\S+)\./.exec(said(t))?.[1], 15_000, "the comparison code");

/**
 * Joins `name` to the run's mesh through device A's invite, the person typing the comparison code
 * on A. Both trust questions are answered no: trust is a step of its own.
 */
async function joinThroughInvite(run: Run, name: string): Promise<string> {
  const a = run.dev("test-a");
  const joiner = await run.device(name);
  // The person reads the code on the joining device's screen and types it on A.
  const joinTerm = run.term(joiner, ["n"]);
  const invite = await run.background(a, ["invite"], /On the new device, in a terminal/, [() => sasIn(joinTerm), "n"]);
  // The short code, which the joining device resolves through the relay's rendezvous.
  const code = grab(said(invite.term), /never through an agent\):\n {2}(\S+)/, "invite code");
  const joined = await run.cmd(joiner, ["join", code, "--name", name], [], joinTerm);
  need(joined.code === 0, `\`wim join\` on ${name} exited ${joined.code}: ${lastLine(joined.text)}`);
  need((await invite.done) === 0, `\`wim invite\` on test-a failed: ${lastLine(said(invite.term))}`);
  need(said(invite.term).includes(`Admitted ${name}.`), "test-a did not say it admitted the device");
  return grab(joined.text, /Joined mesh (\S+)\./, "joined mesh");
}

/** The first unread item of `s` whose text has `text`, once it arrived. */
function arrived(s: MeshSession, text: string): Promise<{ rendered: string }> {
  return waitFor(async () => (await s.spool.unread()).find((i) => i.rendered.includes(text)), 15_000, `${JSON.stringify(text)} at ${s.address}`);
}

/** The id of the held message from `from` in `wim held list` on `dev`. */
async function heldId(run: Run, dev: Dev, from: string): Promise<string> {
  const list = await run.ok(dev, ["held", "list"]);
  return grab(list, new RegExp(`^(\\S+)  ${from.replace(/[.@-]/g, "\\$&")} -> `, "m"), `held message from ${from}`);
}

/** Limits that hold the second message from a peer in an hour, for an hour. */
const TRIP: BreakerLimits = { perPeerPerHour: 1, totalPerHour: 50, pingPong: false, pingPongExchanges: 8, cooldownMinutes: 60 };

/** The steps of a sandbox run. */
export function sandboxSteps(run: Run): Step[] {
  const A = (): Dev => run.dev("test-a");
  const B = (): Dev => run.dev("test-b");
  return [
    { name: "start the sandbox relay on loopback", run: () => run.open() },
    {
      name: "create the mesh",
      run: async () => {
        const text = await run.ok(await run.device("test-a"), ["init", "--name", "test-a", "--relay", run.box!.relayUrl, "--no-recovery"]);
        run.mesh = grab(text, /Created mesh (\S+) on/, "mesh id");
      },
    },
    {
      name: "invite, join, comparison code, admit",
      run: async () => need((await joinThroughInvite(run, "test-b")) === run.mesh, "test-b joined another mesh"),
    },
    {
      name: "trust both ways",
      run: async () => {
        need((await run.ok(A(), ["devices", "trust", "test-b"], ["y"])).includes("Messages from test-b are delivered"), "test-a did not trust test-b");
        need((await run.ok(B(), ["devices", "trust", "test-a"], ["y"])).includes("Messages from test-a are delivered"), "test-b did not trust test-a");
      },
    },
    {
      name: "ping both directions",
      run: async () => {
        const wa = await run.background(A(), ["watch", "--as", "qa"], /Watching as/);
        const wb = await run.background(B(), ["watch", "--as", "qa"], /Watching as/);
        need((await run.ok(A(), ["ping", "qa@test-b"])).includes("pong in"), "no pong from qa@test-b");
        need((await run.ok(B(), ["ping", "qa@test-a"])).includes("pong in"), "no pong from qa@test-a");
        await run.stop(wa);
        await run.stop(wb);
      },
    },
    {
      name: "send and receive, with receipts",
      run: async () => {
        const wb = await run.background(B(), ["watch"], /Watching as/);
        const sent = await run.ok(A(), ["send", "cli@test-b", "hello from test-a", "--wait", "15s"]);
        need(sent.includes("cli@test-b: routed"), "the send was not routed");
        need(sent.includes("cli@test-b: delivered"), "no delivered receipt");
        await shows(wb.term, /hello from test-a/, 15_000, "the message at test-b");
        await run.stop(wb);
      },
    },
    {
      name: "the offline queue and reconnect",
      run: async () => {
        need((await run.ok(A(), ["send", "cli@test-b", "while you were away"])).includes("cli@test-b: queued"), "the send to an offline session was not queued");
        need((await run.ok(B(), ["inbox"])).includes("while you were away"), "test-b did not get the queued message when it came back");
      },
    },
    {
      name: "held from an untrusted device: approve, then refuse",
      run: async () => {
        await joinThroughInvite(run, "test-c");
        const C = run.dev("test-c");
        await run.ok(C, ["send", "cli@test-b", "first from test-c"]);
        need(!(await run.ok(B(), ["inbox"])).includes("first from test-c"), "a message from an untrusted device was delivered");
        await run.ok(B(), ["held", "approve", await heldId(run, B(), "cli@test-c")], ["y"]);
        need((await run.ok(B(), ["inbox"])).includes("first from test-c"), "the approved message was not delivered");
        await run.ok(C, ["send", "cli@test-b", "second from test-c"]);
        await run.ok(B(), ["inbox"]);
        await run.ok(B(), ["held", "refuse", await heldId(run, B(), "cli@test-c")], ["y"]);
        need((await run.ok(B(), ["held", "list"])).includes("Nothing is held."), "the refused message is still held");
        need(!(await run.ok(B(), ["inbox"])).includes("second from test-c"), "the refused message was delivered");
      },
    },
    {
      name: "rooms, a file, a lease, ask and reply, rename",
      run: async () => {
        const a = await run.session(A(), "qa-a");
        const b = await run.session(B(), "qa-b");
        // The agent on test-b answers every task it gets.
        b.on("message", (m: Inbound) => {
          if (m.kind === "task") void b.reply(m.id, "done", "42");
        });
        await a.joinRoom("#qa");
        need((await b.joinRoom("#qa")).includes("qa-a@test-a"), "the room does not list qa-a");
        await a.send("#qa", "to the room");
        await arrived(b, "to the room");
        const dir = join(run.box!.root, "files");
        await fs.mkdir(dir);
        await fs.writeFile(join(dir, "hello.txt"), "a small file");
        await a.sendFile("qa-b@test-b", join(dir, "hello.txt"));
        const saved = grab((await arrived(b, "hello.txt")).rendered, /saved to (\S+)\./, "saved file");
        need(inside(run.box!.root, saved) && (await fs.readFile(saved, "utf8")) === "a small file", "the file did not arrive intact in the sandbox");
        need((await a.acquireLease("qa", 60_000, false)).status === "granted", "the lease was not granted");
        need((await b.acquireLease("qa", 60_000, false)).status === "held", "a held lease was granted twice");
        await a.releaseLease("qa");
        need((await b.acquireLease("qa", 60_000, false)).status === "granted", "a released lease was not granted");
        need((await a.ask("qa-b@test-b", "what is 6 times 7", 15_000)).result?.text === "42", "the task got no reply");
        need((await a.rename("qa-renamed")) === "qa-renamed@test-a", "the rename did not take");
        need((await b.listPeers()).some((p) => p.address === "qa-renamed@test-a"), "the other device does not see the new name");
      },
    },
    {
      name: "the loop breaker: trip, then resume",
      run: async () => {
        // A session of its own, so the step counts from nothing: the breaker counts per session.
        await run.meshFiles(B()).updateConfig((c) => ({ ...c, breaker: TRIP }));
        await run.ok(B(), ["inbox", "--as", "brk"]);
        await run.ok(A(), ["send", "brk@test-b", "breaker one"]);
        await run.ok(A(), ["send", "brk@test-b", "breaker two"]);
        const first = await run.ok(B(), ["inbox", "--as", "brk"]);
        need(first.includes("breaker one") && !first.includes("breaker two"), "the breaker did not hold the second message");
        need((await run.ok(B(), ["held", "list"])).includes("paused  cli@test-a's device -> brk"), "`wim held list` shows no pause");
        need((await run.ok(B(), ["held", "resume", "cli@test-a"], ["y"])).includes("released 1"), "the resume released nothing");
        need((await run.ok(B(), ["inbox", "--as", "brk"])).includes("breaker two"), "the released message was not delivered");
      },
    },
    {
      name: "status and doctor on a device not set up",
      run: async () => {
        const fresh = await run.device("test-fresh", false);
        for (const command of ["status", "doctor"]) {
          const r = await run.cmd(fresh, [command]);
          need(r.code === 1 && r.text.includes("wim init") && !r.text.includes("ENOENT"), `\`wim ${command}\` on a device not set up: ${lastLine(r.text)}`);
        }
      },
    },
    {
      name: "status and doctor on a device in two meshes",
      run: async () => {
        run.second = grab(await run.ok(A(), ["mesh", "create", "--relay", run.box!.relayUrl, "--no-recovery"]), /Created mesh (\S+) on/, "mesh id");
        const status = await run.ok(A(), ["status"]);
        for (const id of [run.mesh, run.second]) need(new RegExp(`Mesh ${id} on .*\\n  connected as`).test(status), `\`wim status\` did not check mesh ${id}`);
        await run.ok(A(), ["doctor"]);
      },
    },
    {
      name: "mesh delete",
      run: async () => {
        for (const id of [run.second, run.mesh]) need((await run.ok(A(), ["mesh", "delete", "--mesh", id], ["y"])).includes(`Deleted mesh ${id}`), `mesh ${id} was not deleted`);
        need((await run.ok(A(), ["status"])).includes("in no mesh yet"), "test-a still has a mesh");
      },
    },
  ];
}

export type SelfTestOptions = {
  main: Main;
  env: Record<string, string | undefined>;
  io: CliIO;
  json: boolean;
  /** Where the sandbox goes (default: the system's temporary directory). */
  tmp?: string;
  /** The steps, for tests of the runner itself (default: `sandboxSteps`). */
  steps?: (run: Run) => Step[];
  stepMs?: number;
};

/** `wim test`: runs the sandbox steps, prints one row each and a summary, and exits 0 only when all passed. */
export async function selfTest(o: SelfTestOptions): Promise<number> {
  const t0 = Date.now();
  const choice = homeChoice(o.env, o.io.platform, o.io.homedir);
  const run = new Run(o.main, o.io, o.tmp ?? tmpdir(), [choice.root, choice.base]);
  // Ctrl-C on `wim test` stops what the sandbox devices run, too.
  const onAbort = (): void => run.terms.forEach((t) => t.stop.abort());
  o.io.signal.addEventListener("abort", onAbort, { once: true });
  const rows = await runSteps((o.steps ?? sandboxSteps)(run), () => run.check(), o.io.signal, o.stepMs);
  const c0 = Date.now();
  try {
    await run.close();
    rows.push({ name: "remove the sandbox", result: "pass", ms: Date.now() - c0 });
  } catch (error) {
    rows.push({ name: "remove the sandbox", result: "fail", ms: Date.now() - c0, detail: (error as Error).message });
  }
  o.io.signal.removeEventListener("abort", onAbort);
  const ms = Date.now() - t0;
  const ok = rows.every((r) => r.result === "pass");
  if (o.json) {
    const count = (r: StepResult): number => rows.filter((x) => x.result === r).length;
    o.io.out(JSON.stringify({ mode: "sandbox", ok, passed: count("pass"), failed: count("fail"), skipped: count("skip"), ms, steps: rows }));
  } else {
    o.io.out("wim test: the sandbox (a relay on loopback and throwaway devices in a temporary directory, all removed at the end)");
    for (const line of report(rows, ms)) o.io.out(line);
  }
  return ok ? 0 : 1;
}
