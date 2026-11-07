// `wim test`: QA that runs inside wim itself (SECURITY-MODEL section 7.6). The sandbox mode starts
// a relay in this process on loopback (relay-node on an in-memory database), makes throwaway
// devices in a fresh temporary directory, and drives the real `wim` commands on them through a
// scripted terminal, playing the person for the person-only steps. Everything it made is removed
// at the end, failures included. `--full` adds the signer and a CI notice from a test issuer that
// exists only here; `--relay` runs the same steps with a throwaway mesh on a real relay, deleted at
// the end; `--person` has a person type the person-only steps.
//
// Isolation is the security property. The scripted terminal and its person exist only here and
// are reached only from `wim test`, never from another command, an MCP tool or an events request.
// Each device's environment is built from nothing (no WIM_HOME, CLAUDE_CONFIG_DIR or agent
// variable of the caller), each state directory must not exist before the run, and before every
// step every path is checked to be inside the run's own directory with no symbolic link on the
// way, and the relay to be the run's own on loopback. Nothing the caller's device holds is read
// or written: the command never even resolves that device's directory except to refuse a
// temporary directory inside it.

import { b64u, GITHUB_ISSUER, isRelayUrl, JWKS_URLS, randomBytes, utf8, type JwksFetch } from "@worldinmotion/protocol";
import { start, type RunningRelay } from "@worldinmotion/relay-node";
import type { webcrypto } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import type { CliIO } from "./cli.ts";
import { agentDir, agentEndpoint } from "./agentpath.ts";
import { MeshSession, type Inbound } from "./client.ts";
import { Home } from "./home.ts";
import { MeshFiles, type BreakerLimits } from "./mesh.ts";
import { agentEndpointFor, endpointProblem, homeChoice, SOCKET_PATH_MAX, type Platform } from "./platform.ts";
import { fetchRelayInfo, type RelayInfo } from "./relayinfo.ts";
import { cannotConfirm } from "./secretout.ts";
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

/** The file every run's directory holds, so a later run knows it is one (see `sweepStale`). */
export const SANDBOX_MARK = ".wim-test-sandbox";

/** How old a run's directory must be before a later run removes it as left behind. */
export const STALE_MS = 24 * 3_600_000;

/** What `sweepStale` uses of the file system, and whose entries it may remove (undefined: no owners, as on Windows). */
export type SweepOps = { lstat: typeof fs.lstat; rm: typeof fs.rm; uid: number | undefined };

const SWEEP_OPS: SweepOps = { lstat: fs.lstat, rm: fs.rm, uid: process.getuid?.() };

/**
 * Removes run directories left behind under `base` (a run whose process was killed, as on
 * Windows, cannot remove its own): only a real directory named `wim-test-*`, not a link, owned by
 * this user (on POSIX: /tmp is shared, and another user's is never ours to remove), holding the
 * run's mark file (a regular file, not a link) last written more than STALE_MS ago. Nothing else
 * is touched. Housekeeping, not a step: an entry that cannot be read or removed (gone already,
 * another run sweeping at once, not ours) is skipped, never fails the run. Returns what it removed.
 */
export async function sweepStale(base: string, now: number, ops: SweepOps = SWEEP_OPS): Promise<string[]> {
  const removed: string[] = [];
  for (const name of await fs.readdir(base).catch(() => [] as string[])) {
    if (!name.startsWith("wim-test-")) continue;
    const dir = join(base, name);
    const st = await ops.lstat(dir).catch(() => undefined);
    if (st === undefined || !st.isDirectory() || (ops.uid !== undefined && st.uid !== ops.uid)) continue;
    const mark = await ops.lstat(join(dir, SANDBOX_MARK)).catch(() => undefined);
    if (mark === undefined || !mark.isFile() || now - mark.mtimeMs < STALE_MS) continue;
    if (await ops.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).then(() => true, () => false)) removed.push(dir);
  }
  return removed;
}

/** The device the signer step runs its signer on. */
export const SIGNER_DEVICE = "sig";

/** Where a `--full` run goes when its temporary directory is too long for the signer's socket (POSIX). */
export const SHORT_TMP = "/tmp";

/**
 * Where a `--full` run makes its directory: `base`, unless the signer's socket under it
 * (`wim-test-XXXXXX/sig/agent/sock`, after symbolic links are resolved) would be over
 * SOCKET_PATH_MAX bytes, as under a long TMPDIR; then `fallback` when the socket fits there.
 * Otherwise refused before anything is made. Setting WIM_HOME is no help: each sandbox device
 * has its own. Windows names a pipe, not a path, so there `base` always fits.
 */
export async function runBase(base: string, platform: Platform, fallback = SHORT_TMP): Promise<string> {
  const fits = async (dir: string): Promise<boolean> => {
    const sock = agentEndpointFor(agentDir(join(await fs.realpath(dir), "wim-test-XXXXXX", SIGNER_DEVICE)), platform, "");
    return endpointProblem(sock, platform) === undefined;
  };
  if (await fits(base)) return base;
  if (await fits(fallback).catch(() => false)) return fallback;
  throw new SandboxError(`the temporary directory ${base} is too long for the signer's socket (at most ${SOCKET_PATH_MAX} bytes): set TMPDIR to a shorter directory`);
}

/** One run's own directory, devices and relay, and the checks made before every step. */
export class Sandbox {
  readonly root: string;
  private readonly dirs = new Map<string, string>();
  private relay: string | undefined;
  private live = false;

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
    await sweepStale(at, Date.now());
    const root = await fs.mkdtemp(join(at, "wim-test-"));
    await fs.writeFile(join(root, SANDBOX_MARK), "", { flag: "wx", mode: 0o600 });
    return new Sandbox(root);
  }

  /**
   * The run's relay: the sandbox's own, refused unless it is on loopback; or, in live mode, the
   * relay named, refused unless it is `wss://` (plain `ws://` only on loopback).
   */
  attach(url: string, live = false): void {
    if (live && !isRelayUrl(url)) throw new SandboxError(`a live relay must be a wss:// URL (plain ws:// only on loopback) with no trailing slash, not ${url}`);
    if (!live && !onLoopback(url)) throw new SandboxError(`the sandbox relay must be on loopback, not ${url}`);
    this.relay = url;
    this.live = live;
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
    if (this.relay === undefined || !(this.live ? isRelayUrl(this.relay) : onLoopback(this.relay))) throw new SandboxError(`the relay ${String(this.relay)} is not the sandbox's own`);
  }

  /** Removes everything the run made. */
  async remove(): Promise<void> {
    await fs.rm(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// Steps.

export type StepResult = "pass" | "fail" | "skip";
/** `offered: false`: skipped because the live relay does not offer what the step checks, which does not fail the run. */
export type StepRow = { name: string; result: StepResult; ms: number; detail?: string; offered?: false };

/** Thrown by a step the live relay does not offer (per its `/v1/info`): a skip with the reason, not a failure. */
export class NotOffered extends Error {}

/** Whether a run passed: no step failed, and every skip was one the live relay does not offer. */
export function passed(rows: readonly StepRow[]): boolean {
  return rows.every((r) => r.result === "pass" || r.offered === false);
}
export type Step = { name: string; run: () => Promise<void> };

/** The longest one step may take, and with `--person`, where a person types the answers. */
export const STEP_MS = 60_000;
export const PERSON_STEP_MS = 600_000;

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
      if (error instanceof NotOffered) {
        rows.push({ name: step.name, result: "skip", ms: Date.now() - t0, detail: error.message, offered: false });
        continue;
      }
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
  const notOffered = rows.filter((r) => r.offered === false).length;
  return [
    ...rows.map((r) => `  ${r.result.padEnd(4)}  ${r.name.padEnd(width)}  ${String(r.ms).padStart(6)} ms${r.detail === undefined ? "" : `  ${r.detail}`}`),
    `${passed(rows) ? "PASS" : "FAIL"}: ${rows.length} steps, ${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped${notOffered === 0 ? "" : ` (${notOffered} not offered by this relay, which does not fail the run)`}, in ${(ms / 1000).toFixed(1)} s.`,
  ];
}

/** One sandbox device: its name and state directory. */
type Dev = { name: string; dir: string };

/** A command still running (a `wim watch`, a `wim invite` waiting for a join). */
type Running = { term: Term; done: Promise<number> };

/** Where the sandbox's CI job asks for its ID token: a name that never resolves, answered in this process. */
export const TEST_TOKEN_URL = "http://id-token.wim-test.invalid/token";

/** The repository, ref and workflow of the sandbox's CI job. */
const CI_REPO = "wim-test/notices";

const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

/**
 * The CI test issuer (SPEC section 18): a throwaway RSA key made for one run. The sandbox relay,
 * and the sandbox device's session, are handed a key fetcher that serves only this key, as
 * GitHub's JWKS. It exists only in this module, only for the sandbox relay; a live relay fetches
 * GitHub's real keys and never sees it.
 */
export type TestIssuer = { jwksFetch: JwksFetch; mint(aud: string, now: number): Promise<string> };

export async function testIssuer(): Promise<TestIssuer> {
  const pair = (await crypto.subtle.generateKey({ ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as { n: string; e: string };
  const kid = b64u.encode(randomBytes(9));
  const jwks = JSON.stringify({ keys: [{ kty: "RSA", use: "sig", alg: "RS256", kid, n: pub.n, e: pub.e }] });
  const part = (v: unknown): string => b64u.encode(utf8(JSON.stringify(v)));
  return {
    // Only GitHub's JWKS URL is ever asked for; anything else gets nothing.
    jwksFetch: async (url) => (url === JWKS_URLS[GITHUB_ISSUER] ? { status: 200, text: async () => jwks } : { status: 404, text: async () => "" }),
    async mint(aud, now) {
      const iat = Math.floor(now / 1000) - 5;
      const claims = {
        iss: GITHUB_ISSUER,
        aud,
        jti: b64u.encode(randomBytes(12)),
        iat,
        nbf: iat - 5,
        exp: iat + 300,
        repository: CI_REPO,
        repository_id: "1001",
        repository_owner_id: "1000",
        ref: "refs/heads/main",
        workflow_ref: `${CI_REPO}/.github/workflows/notify.yml@refs/heads/main`,
        event_name: "push",
        sha: "0".repeat(40),
        run_id: "1",
      };
      const input = `${part({ alg: "RS256", kid, typ: "JWT" })}.${part(claims)}`;
      const sig = new Uint8Array(await crypto.subtle.sign(RSA, pair.privateKey, utf8(input) as Uint8Array<ArrayBuffer>));
      return `${input}.${b64u.encode(sig)}`;
    },
  };
}

/** How a run was asked for: `wim test [--full] [--relay <url> [--key-env NAME]] [--person]`. */
export type RunMode = {
  /** Every sandbox step, the signer's and the CI notice's included. */
  full: boolean;
  /** Live mode: a throwaway mesh on this relay instead of the sandbox's own relay. */
  live?: string;
  /** The variable holding the live relay's operator key, and its value, passed to the devices that create meshes. */
  keyEnv?: { name: string; value: string };
  /** A real person types the person-only steps in this terminal. */
  person: boolean;
};

/** One sandbox run: its devices, its relay, and the commands it runs on them. */
export class Run {
  readonly terms: Term[] = [];
  readonly sessions: MeshSession[] = [];
  readonly running: Running[] = [];
  box: Sandbox | undefined;
  relay: RunningRelay | undefined;
  /** What the relay says it offers (`/v1/info`). */
  info: RelayInfo | undefined;
  issuer: TestIssuer | undefined;
  readonly devs = new Map<string, Dev>();
  /** Mesh ids by role: the run's mesh, and device A's second one. */
  mesh = "";
  second = "";
  /** The meshes the run deleted; in live mode, every other one it made is deleted at the end. */
  readonly deleted = new Set<string>();
  /** How long a running command may take to print that it is ready. */
  readyMs = 15_000;
  /** The sandbox signer's passphrase: made here, typed by the script, never printed. */
  readonly passphrase = b64u.encode(randomBytes(24));

  readonly main: Main;
  readonly io: CliIO;
  readonly base: string;
  readonly real: readonly string[];
  readonly mode: RunMode;
  /** Where a `--full` run goes when `base` is too long for the signer's socket (see `runBase`). */
  readonly shortTmp: string;

  constructor(main: Main, io: CliIO, base: string, real: readonly string[], mode: RunMode, shortTmp = SHORT_TMP) {
    this.main = main;
    this.io = io;
    this.base = base;
    this.real = real;
    this.mode = mode;
    this.shortTmp = shortTmp;
  }

  check(): Promise<void> {
    return this.box?.check() ?? Promise.resolve();
  }

  /** The sandbox and its relay: one started here on loopback, or the live relay named, after reading its `/v1/info`. */
  async open(): Promise<void> {
    // The signer's socket must fit under the run's directory (only `--full` runs a signer).
    const base = this.mode.full ? await runBase(this.base, this.io.platform, this.shortTmp) : this.base;
    this.box = await Sandbox.open(base, this.real);
    if (this.mode.live !== undefined) {
      this.box.attach(this.mode.live, true);
      this.info = await fetchRelayInfo(this.mode.live, this.fetcher());
      need(this.info !== undefined, `the relay's /v1/info cannot be read at ${this.mode.live}: is it a worldinmotion relay?`);
      return;
    }
    this.issuer = await testIssuer();
    this.relay = await start({ db: ":memory:", port: 0, host: "127.0.0.1", log: () => undefined, ci: true, jwksFetch: this.issuer.jwksFetch });
    this.box.attach(this.relay.relayUrls[0]!);
    this.info = { v: 1, software: "worldinmotion-relay", version: "sandbox", create: "open", limits: { max_meshes: null, idle_mesh_days: null, blob_bytes_per_mesh_per_day: 0 }, offer: null, ci: true };
  }

  /** The run's fetch: only the relay's own origin. */
  fetcher(): typeof fetch {
    return sandboxFetch(`${this.box!.relayUrl.replace(/^ws/, "http")}/`, fetch);
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

  /** A terminal on `dev`: scripted, or with `--person` the person's own for every prompt. */
  term(dev: Dev, answers: readonly Answer[], extraEnv: Record<string, string> = {}, fetcher = this.fetcher()): Term {
    const key = this.mode.keyEnv === undefined ? {} : { [this.mode.keyEnv.name]: this.mode.keyEnv.value };
    const t = scriptedTerm({
      home: dev.dir,
      env: { ...deviceEnv(dev.dir), ...key, ...extraEnv },
      hostname: dev.name,
      platform: this.io.platform,
      uid: this.io.uid,
      pid: this.io.pid,
      now: this.io.now,
      dialer: sandboxDialer(this.box!.relayUrl, wsDialer),
      fetch: fetcher,
      // The signer's passphrase, typed without echo: it is never in any output.
      extra: { promptSecret: async () => this.passphrase },
    });
    t.answers.push(...answers);
    if (this.mode.person) personAt(t, dev.name, this.io);
    this.terms.push(t);
    return t;
  }

  /** Runs one command on `dev` to its end, answering its prompts with `answers`, or in the terminal `t`. */
  async cmd(dev: Dev, argv: readonly string[], answers: readonly Answer[] = [], t = this.term(dev, answers)): Promise<{ code: number; text: string }> {
    // Every command is tracked, so the end of a run waits for one a step left running.
    const done = this.main(argv, t.env, t.io);
    this.running.push({ term: t, done });
    const code = await done;
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
    const what = `\`wim ${argv.join(" ")}\` on ${dev.name}`;
    // A command that ends before it is ready fails the step at once, with what it said last.
    const first = await Promise.race([shows(term, ready, this.readyMs, what).then(() => undefined), r.done]).catch((error: unknown) => {
      throw new Error(`${(error as Error).message}: ${lastLine(said(term))}`);
    });
    need(first === undefined, `${what} exited ${String(first)} before it was ready: ${lastLine(said(term))}`);
    return r;
  }

  /** Stops a running command (Ctrl-C) and waits for it to end. */
  async stop(r: Running): Promise<void> {
    r.term.stop.abort();
    await r.done;
  }

  /**
   * A session of `dev` in the run's mesh, as an agent's MCP server runs one, for the steps the
   * command line has no command for (rooms, files, leases, ask and reply, rename, CI notices).
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
      // CI tokens are checked against the sandbox's test issuer only (sandbox mode alone runs the CI step).
      ...(this.issuer === undefined ? {} : { jwksFetch: this.issuer.jwksFetch }),
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

  /** `wim mesh create` (or `init --relay`) on `dev`, with the operator key's variable when there is one; the new mesh's id. */
  async create(dev: Dev, argv: readonly string[]): Promise<string> {
    const key = this.mode.keyEnv === undefined ? [] : ["--key-env", this.mode.keyEnv.name];
    return grab(await this.ok(dev, [...argv, "--relay", this.box!.relayUrl, ...key, "--no-recovery"]), /Created mesh (\S+) on/, "mesh id");
  }

  /** `wim mesh delete` of one of the run's meshes, from test-a, its admin. */
  async deleteMesh(id: string): Promise<void> {
    need((await this.ok(this.dev("test-a"), ["mesh", "delete", "--mesh", id], ["y"])).includes(`Deleted mesh ${id}`), `mesh ${id} was not deleted`);
    this.deleted.add(id);
  }

  /**
   * Every mesh the run made, read from what its commands printed: a create stopped after the
   * relay made the mesh (Ctrl-C, a step's time running out) still printed its id, so it is
   * still deleted.
   */
  made(): string[] {
    const ids = this.terms.flatMap((t) => [...said(t).matchAll(/^Created mesh (\S+) on /gm)].map((m) => m[1]!));
    return [...new Set(ids)].filter((id) => !this.deleted.has(id));
  }

  /**
   * The rows of the end of a run, which always run: in live mode the meshes the run made and did
   * not delete yet are deleted; then what still runs is stopped, the sandbox relay closed and the
   * sandbox removed.
   */
  async close(): Promise<StepRow[]> {
    const rows: StepRow[] = [];
    for (const t of this.terms) t.stop.abort();
    // A command a timed-out or stopped step left running (a mesh create the relay is answering)
    // ends first, so a mesh it made is in its output when the meshes to delete are read; one
    // that does not end within CLOSE_WAIT_MS is not waited for longer.
    await settledWithin([...this.running.map((r) => r.done), ...this.sessions.map((s) => s.stop({ ended: true }))], CLOSE_WAIT_MS);
    if (this.mode.live !== undefined) rows.push(await ending("delete the live meshes", async () => {
      // Each one is tried, whatever happened to the one before.
      const left = this.made();
      const failed: string[] = [];
      for (const id of left) await this.deleteMesh(id).catch((error: unknown) => void failed.push((error as Error).message));
      need(failed.length === 0, failed.join("; "));
    }));
    rows.push(await ending("remove the sandbox", async () => {
      await this.relay?.close();
      await this.box?.remove();
    }));
    return rows;
  }
}

/** How long the end of a run waits for commands still running. */
export const CLOSE_WAIT_MS = 30_000;

/** Resolves once every one of `work` has settled, or after `ms`, whichever is first. */
export function settledWithin(work: readonly Promise<unknown>[], ms: number): Promise<void> {
  let t: NodeJS.Timeout | undefined;
  const late = new Promise<void>((r) => (t = setTimeout(r, ms)));
  return Promise.race([Promise.allSettled(work).then(() => undefined), late]).finally(() => clearTimeout(t));
}

/** One row at the end of a run, from work that always runs. */
async function ending(name: string, work: () => Promise<void>): Promise<StepRow> {
  const t0 = Date.now();
  try {
    await work();
    return { name, result: "pass", ms: Date.now() - t0 };
  } catch (error) {
    return { name, result: "fail", ms: Date.now() - t0, detail: (error as Error).message };
  }
}

/**
 * `--person`: the sandbox device's prompts go to the person at this terminal. Each question is
 * shown with its device and what the step expects, and the person types the answer there, so the
 * real terminal checks are what a person-only step meets. What the device prints is shown too.
 */
function personAt(t: Term, device: string, io: CliIO): void {
  const show = (line: string): void => io.err(`[${device}] ${line}`);
  t.io.out = (line) => (t.out.push(line), show(line));
  t.io.err = (line) => (t.err.push(line), show(line));
  t.io.isTTY = io.isTTY;
  t.io.inputIsTTY = io.inputIsTTY;
  t.io.prompt = async (q) => {
    t.out.push(q);
    const a = t.answers.shift() ?? "";
    const expected = typeof a === "string" ? a : await a();
    return io.prompt(`[${device}] ${q}(the test expects: ${expected === "" ? "Enter" : expected}) `);
  };
}

/** Why `--person` cannot run here, or undefined: it needs the person's own interactive terminal. */
export function noPerson(env: Record<string, string | undefined>, io: { isTTY: boolean; inputIsTTY: boolean }): string | undefined {
  return cannotConfirm(env, io);
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

/** `text` as a regular expression that matches exactly it: every special character escaped, the backslash included. */
const literally = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The id of the held message from `from` in `wim held list` on `dev`. */
async function heldId(run: Run, dev: Dev, from: string): Promise<string> {
  const list = await run.ok(dev, ["held", "list"]);
  return grab(list, new RegExp(`^(\\S+)  ${literally(from)} -> `, "m"), `held message from ${from}`);
}

/** Limits that hold the second message from a peer in an hour, for an hour. */
const TRIP: BreakerLimits = { perPeerPerHour: 1, totalPerHour: 50, pingPong: false, pingPongExchanges: 8, cooldownMinutes: 60 };

/**
 * A CI notice from a job to a session of test-b (SPEC section 18), with the sandbox's test issuer
 * as GitHub: the person allows the repository (its ids cannot be read, so they are not pinned),
 * the job sends, the device holds the first notice, the person approves it, and that pins the
 * ids. A live relay checks real GitHub tokens, so there the step is not offered.
 */
export function ciStep(run: Run): Step {
  return {
    name: "a CI notice: held, approved, its rule pinned",
    run: async () => {
      if (run.mode.live !== undefined) {
        throw new NotOffered(run.info!.ci === true ? "a live relay checks real CI tokens; the test issuer exists only in the sandbox" : "this relay takes no CI notices (its /v1/info has no ci: true)");
      }
      const B = run.dev("test-b");
      const allowed = await run.ok(B, ["ci", "allow", "github", CI_REPO, "--ref", "main", "--workflow", "notify.yml"], ["y"]);
      need(allowed.includes("could not be read from the provider's public API"), "the rule was pinned before any notice");
      const code = grab(allowed, /Recipient code for the job \(not a secret\): (wimci1_\S+)/, "recipient code");
      const deploys = await run.session(B, "deploys");
      // The job: a terminal with no state directory, its ID token from the test issuer.
      const job = await run.device("ci-job", false);
      const tokens = (async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (`${url.origin}${url.pathname}` !== TEST_TOKEN_URL) return run.fetcher()(input, init);
        return Response.json({ value: await run.issuer!.mint(url.searchParams.get("audience")!, Date.now()) });
      }) as typeof fetch;
      const env = { GITHUB_ACTIONS: "true", ACTIONS_ID_TOKEN_REQUEST_URL: TEST_TOKEN_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "sandbox" };
      // The session tells the relay it takes CI notices (its `ci.rules`) once it is connected;
      // a round trip after that frame went out means the relay has handled it.
      await waitFor(() => (deploys as unknown as { ciSent: string | undefined }).ciSent, 15_000, "the session to tell the relay it takes CI notices");
      await deploys.listPeers();
      const sent = await run.cmd(job, ["ci", "notify", "--recipient", code, "--to", "deploys", "--text", "the build passed"], [], run.term(job, [], env, tokens));
      need(sent.text.includes("wim ci notify: sent to deploys"), `the notice was not sent: ${lastLine(sent.text)}`);
      const id = await waitFor(async () => /^(\S+) {2}ci:github:/m.exec(await run.ok(B, ["held", "list"]))?.[1], 15_000, "the held CI notice");
      await run.ok(B, ["held", "approve", id], ["y"]);
      need((await run.ok(B, ["ci", "list"])).includes("ids repositoryId=1001 ownerId=1000"), "approving the notice did not pin the rule's ids");
      await arrived(deploys, "the build passed");
    },
  };
}

/**
 * The signer on a device of its own: its keys encrypted under a
 * passphrase made here and never printed, a signer started in this process, locked, unlocked
 * (a restart with the passphrase) and stopped. Its socket (a fresh pipe name on Windows) is the
 * device's own, inside the run. A signer still running at the end is stopped with the run.
 */
export function signerStep(run: Run): Step {
  return {
    name: "the signer: encrypt, start, lock, unlock, stop",
    run: async () => {
      const sig = await run.device(SIGNER_DEVICE);
      await run.ok(sig, ["init", "--name", SIGNER_DEVICE]);
      need((await run.ok(sig, ["agent", "encrypt"])).includes("Encrypted"), "the keys were not encrypted");
      const running = /Signer running in the foreground \(pid \d+\) at (.+)\. Ctrl-C/;
      const first = await run.background(sig, ["agent", "start", "--foreground"], running);
      const at = grab(said(first.term), running, "signer endpoint");
      // The endpoint the device's own state names: a socket in it, or on Windows the pipe whose fresh name it keeps.
      need(at === (await agentEndpoint(sig.dir, { platform: run.io.platform, pid: run.io.pid, uid: run.io.uid }, false)), `the signer's endpoint ${at} is not the sandbox device's own`);
      need(/running \(pid \d+\), unlocked/.test(await run.ok(sig, ["agent", "status"])), "the signer is not running unlocked");
      need((await run.ok(sig, ["agent", "lock"])).includes("Signer locked"), "the signer did not lock");
      need(/running \(pid \d+\), locked/.test(await run.ok(sig, ["agent", "status"])), "the signer is not locked");
      const second = await run.background(sig, ["agent", "unlock", "--foreground"], running);
      need((await first.done) === 0, "the locked signer did not stop for the unlock");
      need(/running \(pid \d+\), unlocked/.test(await run.ok(sig, ["agent", "status"])), "the signer did not unlock");
      need((await run.ok(sig, ["agent", "stop"])).includes("Signer stopped."), "the signer did not stop");
      need((await second.done) === 0, "the signer did not end");
      need(!said(first.term).includes(run.passphrase) && !said(second.term).includes(run.passphrase), "the passphrase was printed");
    },
  };
}

/** The steps of a sandbox run. */
export function sandboxSteps(run: Run): Step[] {
  const A = (): Dev => run.dev("test-a");
  const B = (): Dev => run.dev("test-b");
  return [
    { name: run.mode.live === undefined ? "start the sandbox relay on loopback" : "read the live relay's /v1/info", run: () => run.open() },
    {
      name: "create the mesh",
      run: async () => {
        run.mesh = await run.create(await run.device("test-a"), ["init", "--name", "test-a"]);
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
    ...(run.mode.full ? [ciStep(run)] : []),
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
    ...(run.mode.full ? [signerStep(run)] : []),
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
        run.second = await run.create(A(), ["mesh", "create"]);
        const status = await run.ok(A(), ["status"]);
        for (const id of [run.mesh, run.second]) need(new RegExp(`Mesh ${id} on .*\\n  connected as`).test(status), `\`wim status\` did not check mesh ${id}`);
        await run.ok(A(), ["doctor"]);
      },
    },
    {
      name: "mesh delete",
      run: async () => {
        for (const id of [run.second, run.mesh]) await run.deleteMesh(id);
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
  full?: boolean;
  /** Live mode's relay URL (`--relay`). */
  relay?: string;
  /** `--key-env NAME`: the variable holding the live relay's operator key. */
  keyEnv?: string;
  /** `--person`: the person types the person-only steps. */
  person?: boolean;
  /** Where the sandbox goes (default: the system's temporary directory). */
  tmp?: string;
  /** Where a `--full` run goes when `tmp` is too long for the signer's socket (default: SHORT_TMP). */
  shortTmp?: string;
  /** The steps, for tests of the runner itself (default: `sandboxSteps`). */
  steps?: (run: Run) => Step[];
  stepMs?: number;
};

/**
 * What stops a run: Ctrl-C (or a kill the process can catch), or, when stdin is not a terminal,
 * a line `stop` on it. That is how a program that started `wim test` stops it on Windows, where
 * killing a process gives it no chance to remove what it made. Stdin is not read at a terminal,
 * nor with `--person`, whose prompts read it.
 */
export function stopSignal(io: CliIO, person: boolean): { signal: AbortSignal; close(): void } {
  const stop = new AbortController();
  const onAbort = (): void => stop.abort();
  io.signal.addEventListener("abort", onAbort, { once: true });
  if (io.signal.aborted) stop.abort();
  const lines = person || io.inputIsTTY ? undefined : createInterface({ input: io.stdin });
  lines?.on("line", (line) => {
    if (line.trim() === "stop") stop.abort();
  });
  return {
    signal: stop.signal,
    close: () => {
      io.signal.removeEventListener("abort", onAbort);
      lines?.close();
    },
  };
}

/** Why a run cannot start as asked, before anything is made; undefined when it can. */
function refusal(o: SelfTestOptions): string | undefined {
  if (o.keyEnv !== undefined && o.relay === undefined) return "--key-env is for live mode: wim test --relay <url> --key-env NAME";
  if (o.keyEnv !== undefined && (o.env[o.keyEnv] ?? "") === "") return `${o.keyEnv} is not set`;
  if (o.relay !== undefined && !isRelayUrl(o.relay)) return `a live relay must be a wss:// URL (plain ws:// only on loopback) with no trailing slash, not ${o.relay}`;
  const why = o.person === true ? noPerson(o.env, o.io) : undefined;
  return why === undefined ? undefined : `--person needs a person at their own interactive terminal: ${why}`;
}

/** `wim test`: runs the steps, prints one row each and a summary, and exits 0 only when the run passed (see `passed`). */
export async function selfTest(o: SelfTestOptions): Promise<number> {
  const refused = refusal(o);
  if (refused !== undefined) {
    o.io.err(`wim: ${refused}`);
    return 2;
  }
  const t0 = Date.now();
  const choice = homeChoice(o.env, o.io.platform, o.io.homedir);
  const mode: RunMode = {
    full: o.full === true,
    person: o.person === true,
    ...(o.relay === undefined ? {} : { live: o.relay }),
    ...(o.keyEnv === undefined ? {} : { keyEnv: { name: o.keyEnv, value: o.env[o.keyEnv]! } }),
  };
  const run = new Run(o.main, o.io, o.tmp ?? tmpdir(), [choice.root, choice.base], mode, o.shortTmp);
  // Ctrl-C on `wim test` stops what the sandbox devices run, too.
  const stopped = stopSignal(o.io, mode.person);
  const onAbort = (): void => run.terms.forEach((t) => t.stop.abort());
  stopped.signal.addEventListener("abort", onAbort, { once: true });
  // A person typing gets longer per step than the script.
  const rows = await runSteps((o.steps ?? sandboxSteps)(run), () => run.check(), stopped.signal, o.stepMs ?? (mode.person ? PERSON_STEP_MS : STEP_MS));
  stopped.signal.removeEventListener("abort", onAbort);
  stopped.close();
  rows.push(...(await run.close()));
  const ms = Date.now() - t0;
  const ok = passed(rows);
  const name = mode.live === undefined ? "sandbox" : "live";
  if (o.json) {
    const count = (r: StepResult): number => rows.filter((x) => x.result === r).length;
    o.io.out(JSON.stringify({ mode: name, full: mode.full, ...(mode.live === undefined ? {} : { relay: mode.live }), ok, passed: count("pass"), failed: count("fail"), skipped: count("skip"), ms, steps: rows }));
  } else {
    o.io.out(
      mode.live === undefined
        ? "wim test: the sandbox (a relay on loopback and throwaway devices in a temporary directory, all removed at the end)"
        : `wim test: live, on ${mode.live} (a throwaway mesh, deleted at the end, and throwaway devices in a temporary directory, removed at the end)`,
    );
    for (const line of report(rows, ms)) o.io.out(line);
  }
  return ok ? 0 : 1;
}
