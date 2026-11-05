// Crash reports: off unless the person turned them on, and then only from a release build.
//
// OFF UNLESS BOTH OF THESE HOLD, AND NOTHING IS SET UP OR SENT OTHERWISE:
//   1. the build has an address. The release workflow bundles `wim` with WIM_SENTRY_DSN, which
//      scripts/bundle.mjs writes into the bundle in place of `globalThis.__WIM_SENTRY_DSN__`. Run
//      from source, a fork's build, the Claude Code plugin's committed bundle and every CI build
//      have none, so they never report. No environment variable supplies one: the address is
//      read from that one global, never from SENTRY_DSN or anything else in the environment;
//   2. the person said yes: `$WIM_HOME/crash-reports` holds exactly `on`, written by `wim
//      crash-reports on`, which only a person at their own terminal can run (requirePerson) and
//      which asks first, with no as the default. No file, `off`, or anything else is no.
// WIM_NO_CRASH_REPORTS or DO_NOT_TRACK in the environment turns reporting off whatever the file
// says (the VS Code extension sets the first when VS Code's telemetry is off); nothing in the
// environment can turn it on.
//
// The answer is read when an error happens, not at start, so a command that never fails reads
// nothing, a Sentry client exists only for a report that is going to be sent, and `wim
// crash-reports off` stops a running `wim mcp` from reporting at once.
//
// What is reported: an error a bug causes (one of JavaScript's own TypeError, RangeError,
// ReferenceError, SyntaxError, URIError or EvalError, isBug) that ends a command or that no code
// was waiting for (an unhandled rejection). A refusal, a set-up problem or a relay or network
// failure is not a crash and is never reported.
//
// What a report holds (crashEvent builds it from an allowlist, so a field nobody listed is never
// sent): the error's type, its message after scrubText, the stack's function names, file base
// names and line and column numbers, the wim release, the command name, the OS family and the
// Node version. No breadcrumbs, user, host name, request, environment, arguments, paths or
// working directory; Sentry's own data collection is turned off as well.

import { promises as fs } from "node:fs";
import { Client, createStackParser, createTransport, Scope, eventFromUnknownInput, type BaseTransportOptions, type ClientOptions, type DataCollection, type ErrorEvent, type Event, type EventHint, type StackFrame, type Transport, type TransportMakeRequestResponse } from "@sentry/core";
import { findSecrets } from "@worldinmotion/protocol";
import type { Platform } from "./platform.ts";

declare global {
  /** The crash-report address, written in by the release bundle; undefined in every other build. */
  var __WIM_SENTRY_DSN__: string | undefined;
}

/** The answer's file, in the state directory. */
export const CRASH_REPORTS_FILE = "crash-reports";

/** The person's answer: `on`, `off`, or none (never asked, or a file that says neither). */
export type Consent = "on" | "off" | undefined;

/** The longest answer file read; anything longer is no answer. */
const CONSENT_MAX_BYTES = 16;

/** How long a report may take to leave before the command ends anyway. */
export const REPORT_TIMEOUT_MS = 3000;

/** The answer kept at `path`. A file that cannot be read, or says anything but on or off, is none. */
export async function readConsent(path: string): Promise<Consent> {
  let text: string;
  try {
    const handle = await fs.open(path, "r");
    try {
      const buf = Buffer.alloc(CONSENT_MAX_BYTES + 1);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      if (bytesRead > CONSENT_MAX_BYTES) return undefined;
      text = buf.subarray(0, bytesRead).toString("utf8").trim();
    } finally {
      await handle.close();
    }
  } catch {
    // Missing, a directory, unreadable: no answer, and never a failed command.
    return undefined;
  }
  return text === "on" || text === "off" ? text : undefined;
}

/** The address a build carries, when it is one: an https Sentry DSN with a key and a project. */
export function bakedDsn(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const dsn = value.trim();
  return /^https:\/\/[0-9a-f]{16,64}@[a-z0-9.-]+(:\d{1,5})?\/\d{1,20}$/.test(dsn) ? dsn : undefined;
}

/** The environment variable that turns reporting off here, if one does. */
export function forcedOff(env: Record<string, string | undefined>): string | undefined {
  if ((env["WIM_NO_CRASH_REPORTS"] ?? "") !== "") return "WIM_NO_CRASH_REPORTS";
  const dnt = env["DO_NOT_TRACK"] ?? "";
  return dnt !== "" && dnt !== "0" ? "DO_NOT_TRACK" : undefined;
}

/** JavaScript's own error types, the ones a bug throws. A subclass is an error of the code's own. */
const BUG_TYPES: readonly ErrorConstructor[] = [TypeError, RangeError, ReferenceError, SyntaxError, URIError, EvalError];

/**
 * Whether `error` is a bug: one of BUG_TYPES itself, and not the TypeError that `fetch` throws for
 * a network failure or an error from the operating system (an `errno`).
 */
export function isBug(error: unknown): error is Error {
  if (typeof error !== "object" || error === null) return false;
  const proto: unknown = Object.getPrototypeOf(error);
  if (!BUG_TYPES.some((type) => type.prototype === proto)) return false;
  const e = error as Error & { errno?: unknown };
  return e.errno === undefined && !(proto === TypeError.prototype && e.message === "fetch failed");
}

/** What scrubText removes besides the patterns: this machine's own names. */
export type Known = { homedir: string; hostname: string };

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** File names that end like a domain but are code: kept by the domain rule. */
const CODE_FILE = /\.(?:[cm]?js|tsx?|json)$/i;

/**
 * `text` with everything that could name a person, a machine, a mesh or what was said replaced by
 * a placeholder, cut to 300 characters. In this order: anything quoted (names, addresses and
 * message text are quoted when an error repeats them); URLs; file paths of every platform; this
 * machine's home directory, user name and host name wherever else they appear; addresses
 * (`name@device`, email); IP addresses; domain names; ids, keys, codes and tokens (any run of 16
 * or more letters, digits, `-`, `_`, `+`, `/` or `=`); numbers of 6 or more digits. Text that
 * still looks like a credential (protocol's findSecrets) is dropped whole.
 */
export function scrubText(text: string, known: Known): string {
  let out = text
    .replace(/"[^"]*"|'[^']*'|`[^`]*`|\u201c[^\u201d]*\u201d/g, "<quoted>")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>]*/gi, "<url>")
    .replace(/\b[a-z]:[\\/][^\s<>]*/gi, "<path>")
    .replace(/\\\\[^\s<>]+/g, "<path>")
    .replace(/(^|[\s(=:,[{])~?\/[^\s<>),\]}]*/g, "$1<path>");
  const user = known.homedir.split(/[\\/]/).filter((p) => p !== "").at(-1) ?? "";
  for (const [literal, mark] of [
    [known.homedir, "<home>"],
    [known.hostname, "<host>"],
    // split always has a first part.
    [known.hostname.split(".")[0]!, "<host>"],
    [user, "<user>"],
  ] as const) {
    if (literal.length >= 3) out = out.replace(new RegExp(escape(literal), "gi"), mark);
  }
  out = out
    .replace(/[\w.+-]+@[\w.-]+/g, "<address>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>")
    .replace(/\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\b/gi, (m) => (m.includes("::") || m.split(":").length > 3 ? "<ip>" : m))
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi, (m) => (CODE_FILE.test(m) ? m : "<host>"))
    .replace(/[A-Za-z0-9+/=_-]{16,}/g, "<id>")
    .replace(/\d{6,}/g, "<n>");
  if (findSecrets(out).length > 0) return "<removed>";
  return out.length > 300 ? `${out.slice(0, 300)}...` : out;
}

/**
 * A frame's file as a report keeps it: Node's own modules by name (`node:internal/...`), a code
 * file by its base name (`wim.mjs`), and anything else as `?`, so a directory, which could be a
 * user's name, never is.
 */
export function frameFile(filename: string | undefined): string {
  if (filename === undefined) return "?";
  if (/^node:[\w-]+(?:\/[\w-]+)*$/.test(filename)) return filename;
  const base = filename.split(/[\\/]/).at(-1)!;
  return /^[\w.-]{1,64}\.(?:[cm]?js|tsx?)$/.test(base) ? base : "?";
}

/** A frame's function name as a report keeps it: identifier characters only, at most 120. */
export function frameFunction(name: string | undefined): string {
  const kept = (name ?? "").replace(/\(.*$/, "").replace(/[^\w$.<> [\]]/g, "").trim().slice(0, 120);
  return kept === "" ? "?" : kept;
}

/** One line of a V8 stack: `at fn (file:line:col)` or `at file:line:col`. */
export function parseFrame(line: string): StackFrame | undefined {
  const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
  if (m === null) return undefined;
  const filename = m[2]!;
  return { function: m[1] ?? "?", filename, lineno: Number(m[3]), colno: Number(m[4]), in_app: !filename.startsWith("node:") };
}

const stackParser = createStackParser([90, parseFrame]);

/** The facts a report carries besides the error. */
export type Facts = { release: string; command: string; platform: Platform; node: string; known: Known };

/** How the error reached the reporter: it ended a command, or nothing was waiting for it. */
export type Where = "command" | "unhandledRejection";

/**
 * The event as sent: rebuilt from `event` field by field, so only what is named here leaves the
 * machine, with every string scrubbed again. Anything else the SDK put in (breadcrumbs, extra,
 * contexts, user, request, modules, server_name) is dropped by not being copied.
 */
export function crashEvent(event: Event, facts: Facts, where: Where): ErrorEvent {
  const values = (event.exception?.values ?? []).slice(0, 1).map((v) => ({
    type: /^[A-Za-z]{1,40}$/.test(v.type ?? "") ? v.type! : "Error",
    value: scrubText(v.value ?? "", facts.known),
    mechanism: { type: where === "command" ? "wim.command" : "wim.unhandledRejection", handled: false },
    stacktrace: {
      frames: (v.stacktrace?.frames ?? []).slice(-50).map((f) => ({
        filename: frameFile(f.filename),
        function: frameFunction(f.function),
        ...(f.lineno === undefined ? {} : { lineno: f.lineno }),
        ...(f.colno === undefined ? {} : { colno: f.colno }),
        in_app: f.in_app === true,
      })),
    },
  }));
  return {
    type: undefined,
    event_id: event.event_id!,
    timestamp: event.timestamp!,
    platform: "node",
    level: where === "command" ? "fatal" : "error",
    release: facts.release,
    environment: "production",
    exception: { values },
    tags: { command: /^[a-z][a-z0-9-]{0,20}$/.test(facts.command) ? facts.command : "other" },
    contexts: { os: { name: facts.platform }, runtime: { name: "node", version: facts.node } },
  };
}

/** Sentry's data collection, every category off. */
const NO_DATA_COLLECTION: DataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
  frameContextLines: 0,
};

/** A Sentry client with nothing installed: no integrations, so no global handlers and no breadcrumbs. */
export class CrashClient extends Client<ClientOptions> {
  constructor(options: ClientOptions) {
    super(options);
  }

  eventFromException(exception: unknown): PromiseLike<Event> {
    return Promise.resolve(eventFromUnknownInput(this, this._options.stackParser, exception));
  }

  /** Never used: a report is only ever an exception. */
  eventFromMessage(): PromiseLike<Event> {
    return Promise.reject(new Error("crash reports carry exceptions only"));
  }
}

/** The HTTP request a report makes, over the given `fetch`; `delivered` hears of each 2xx answer. */
export function fetchTransport(fetcher: typeof fetch, delivered: () => void, timeoutMs = REPORT_TIMEOUT_MS): (options: BaseTransportOptions) => Transport {
  return (options) =>
    createTransport(options, async (request): Promise<TransportMakeRequestResponse> => {
      const res = await fetcher(options.url, {
        method: "POST",
        body: request.body as string | Uint8Array<ArrayBuffer>,
        headers: { "Content-Type": "application/x-sentry-envelope" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status >= 200 && res.status < 300) delivered();
      return { statusCode: res.status, headers: { "x-sentry-rate-limits": res.headers.get("x-sentry-rate-limits"), "retry-after": res.headers.get("retry-after") } };
    });
}

/** The `where` report() passed with the event. */
const whereOf = (hint: EventHint): Where => ((hint.data as { where: Where }).where);

/** What a reporter is told about where it runs. */
export type ReporterOptions = {
  /** The build's address (bakedDsn of `globalThis.__WIM_SENTRY_DSN__`), or undefined. */
  dsn: string | undefined;
  /** `$WIM_HOME/crash-reports`. */
  file: string;
  env: Record<string, string | undefined>;
  release: string;
  command: string;
  platform: Platform;
  known: Known;
  fetch: typeof fetch;
  /** How long a report may take (REPORT_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Makes the Sentry client; `new CrashClient` (tests count the calls). */
  makeClient?: (options: ClientOptions) => Client;
};

/**
 * Reports bugs for one command, when allowed: `report` checks the address, the environment and the
 * person's answer, in that order, each time, and only then makes a client. Never throws.
 */
export class CrashReporter {
  private readonly o: ReporterOptions;
  private client: Client | undefined;

  constructor(o: ReporterOptions) {
    this.o = o;
  }

  /** Whether reporting is allowed right now, and if not, why not. */
  async allowed(): Promise<{ ok: true } | { ok: false; why: "no-address" | "env" | "not-on" }> {
    if (this.o.dsn === undefined) return { ok: false, why: "no-address" };
    if (forcedOff(this.o.env) !== undefined) return { ok: false, why: "env" };
    if ((await readConsent(this.o.file)) !== "on") return { ok: false, why: "not-on" };
    return { ok: true };
  }

  /**
   * Sends one report of `error` when it is a bug and reporting is allowed, waiting at most
   * REPORT_TIMEOUT_MS. True when Sentry took it (a 2xx answer).
   */
  async report(error: unknown, where: Where): Promise<boolean> {
    if (!isBug(error)) return false;
    if (!(await this.allowed()).ok) return false;
    const client = this.clientFor();
    const before = this.delivered;
    client.captureException(error, { data: { where } }, new Scope());
    await client.flush(this.o.timeoutMs ?? REPORT_TIMEOUT_MS);
    return this.delivered > before;
  }

  private delivered = 0;

  private clientFor(): Client {
    if (this.client !== undefined) return this.client;
    const facts: Facts = { release: this.o.release, command: this.o.command, platform: this.o.platform, node: process.versions.node, known: this.o.known };
    const options: ClientOptions = {
      dsn: this.o.dsn!,
      release: this.o.release,
      environment: "production",
      integrations: [],
      stackParser,
      transport: fetchTransport(this.o.fetch, () => void this.delivered++, this.o.timeoutMs),
      sendClientReports: false,
      dataCollection: NO_DATA_COLLECTION,
      maxBreadcrumbs: 0,
      beforeBreadcrumb: () => null,
      attachStacktrace: false,
      enhanceFetchErrorMessages: false,
      sampleRate: 1,
      beforeSend: (event, hint) => crashEvent(event, facts, whereOf(hint)),
    };
    this.client = (this.o.makeClient ?? ((opts) => new CrashClient(opts)))(options);
    this.client.init();
    return this.client;
  }
}
