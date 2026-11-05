import { promises as fs } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ClientOptions, Event } from "@sentry/core";
import {
  bakedDsn,
  crashEvent,
  CrashClient,
  CrashReporter,
  CRASH_REPORTS_FILE,
  fetchTransport,
  forcedOff,
  frameFile,
  frameFunction,
  isBug,
  parseFrame,
  readConsent,
  REPORT_TIMEOUT_MS,
  scrubText,
  type Facts,
  type ReporterOptions,
} from "../src/crash.ts";
import { CRASH_REPORT_TERMS, CRASH_SENT, main } from "../src/cli.ts";
import { SetupError } from "../src/errors.ts";
import { processIo, type Proc } from "../src/io.ts";
import { PassThrough } from "node:stream";
import { ClientError } from "../src/client.ts";
import { RelayHarness, run, scratch, term, until } from "./helpers.ts";

const DSN = "https://0123456789abcdef0123456789abcdef@o1.ingest.de.sentry.io/4500000000000001";

/** A `fetch` that answers every request with `status` and keeps what it was sent. */
function stubFetch(status = 200): { fetch: typeof fetch; calls: { url: string; body: string }[] } {
  const calls: { url: string; body: string }[] = [];
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const body = init!.body;
    calls.push({ url: String(url), body: typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array) });
    return new Response("{}", { status });
  }) as typeof fetch;
  return { fetch: fetcher, calls };
}

/** The items of a Sentry envelope: [header, payload] pairs after the envelope header. */
function envelope(body: string): { header: Record<string, unknown>; items: [Record<string, unknown>, Record<string, unknown>][] } {
  const lines = body.split("\n").filter((l) => l !== "");
  const header = JSON.parse(lines[0]!) as Record<string, unknown>;
  const items: [Record<string, unknown>, Record<string, unknown>][] = [];
  for (let i = 1; i < lines.length; i += 2) items.push([JSON.parse(lines[i]!), JSON.parse(lines[i + 1]!)]);
  return { header, items };
}

const KNOWN = { homedir: "/home/alice", hostname: "alice-laptop.corp.example" };

async function reporter(over: Partial<ReporterOptions> = {}, consent: string | null = "on\n"): Promise<{ r: CrashReporter; calls: { url: string; body: string }[]; made: ClientOptions[]; file: string }> {
  const dir = await scratch("crash");
  const file = join(dir, CRASH_REPORTS_FILE);
  if (consent !== null) await fs.writeFile(file, consent);
  const { fetch, calls } = stubFetch();
  const made: ClientOptions[] = [];
  const r = new CrashReporter({
    dsn: DSN,
    file,
    env: {},
    release: "worldinmotion@0.1.8",
    command: "mcp",
    platform: "linux",
    known: KNOWN,
    fetch,
    makeClient: (o) => {
      made.push(o);
      return new CrashClient(o);
    },
    ...over,
  });
  return { r, calls, made, file };
}

describe("readConsent", () => {
  it("is on or off only for exactly that word, and nothing for anything else", async () => {
    const dir = await scratch("consent");
    const file = join(dir, CRASH_REPORTS_FILE);
    expect(await readConsent(file)).toBeUndefined();
    for (const [text, want] of [
      ["on", "on"],
      ["on\n", "on"],
      ["  off\r\n", "off"],
      ["ON", undefined],
      ["yes", undefined],
      ["true", undefined],
      ["1", undefined],
      ["on on", undefined],
      ["", undefined],
      [`on${" ".repeat(20)}`, undefined],
      [`on\n${"x".repeat(1000)}`, undefined],
    ] as const) {
      await fs.writeFile(file, text);
      expect(await readConsent(file), JSON.stringify(text)).toBe(want);
    }
  });

  it("reads a directory, or anything it cannot read, as no answer and never throws", async () => {
    const dir = await scratch("consent");
    await fs.mkdir(join(dir, CRASH_REPORTS_FILE));
    expect(await readConsent(join(dir, CRASH_REPORTS_FILE))).toBeUndefined();
    expect(await readConsent(join(dir, "missing", "deeper", CRASH_REPORTS_FILE))).toBeUndefined();
  });
});

describe("bakedDsn", () => {
  it("takes only an https Sentry DSN with a key and a project", () => {
    expect(bakedDsn(DSN)).toBe(DSN);
    expect(bakedDsn(` ${DSN}\n`)).toBe(DSN);
    expect(bakedDsn("https://0123456789abcdef@sentry.example:9000/7")).toBe("https://0123456789abcdef@sentry.example:9000/7");
    for (const bad of [undefined, null, 7, "", "   ", "not a dsn", DSN.replace("https", "http"), "https://o1.ingest.de.sentry.io/1", "https://key:secret@o1.ingest.de.sentry.io/1", `${DSN}/extra`, "https://0123456789abcdef@evil.example/1?x=1", "https://NOTHEX0123456789@host/1"]) {
      expect(bakedDsn(bad), String(bad)).toBeUndefined();
    }
  });
});

describe("forcedOff", () => {
  it("names WIM_NO_CRASH_REPORTS or DO_NOT_TRACK when set, and nothing otherwise", () => {
    expect(forcedOff({})).toBeUndefined();
    expect(forcedOff({ WIM_NO_CRASH_REPORTS: "" })).toBeUndefined();
    expect(forcedOff({ WIM_NO_CRASH_REPORTS: "1" })).toBe("WIM_NO_CRASH_REPORTS");
    expect(forcedOff({ WIM_NO_CRASH_REPORTS: "0" })).toBe("WIM_NO_CRASH_REPORTS");
    expect(forcedOff({ DO_NOT_TRACK: "1" })).toBe("DO_NOT_TRACK");
    expect(forcedOff({ DO_NOT_TRACK: "true" })).toBe("DO_NOT_TRACK");
    expect(forcedOff({ DO_NOT_TRACK: "0" })).toBeUndefined();
    expect(forcedOff({ DO_NOT_TRACK: "" })).toBeUndefined();
    // No variable turns reporting on.
    expect(forcedOff({ WIM_CRASH_REPORTS: "on", SENTRY_DSN: DSN, WIM_SENTRY_DSN: DSN })).toBeUndefined();
  });
});

describe("isBug", () => {
  it("is JavaScript's own error types only", () => {
    for (const e of [new TypeError("x"), new RangeError("x"), new ReferenceError("x"), new SyntaxError("x"), new URIError("x"), new EvalError("x")]) expect(isBug(e)).toBe(true);
    class Mine extends TypeError {}
    for (const e of [new Error("x"), new Mine("x"), new SetupError("x"), new ClientError("x", "full"), new AggregateError([]), "TypeError: x", null, undefined, 3, { name: "TypeError", message: "x" }]) {
      expect(isBug(e)).toBe(false);
    }
  });

  it("is not a network failure or an operating system error", () => {
    expect(isBug(new TypeError("fetch failed"))).toBe(false);
    expect(isBug(Object.assign(new RangeError("x"), { errno: -2 }))).toBe(false);
    expect(isBug(new RangeError("fetch failed"))).toBe(true);
  });
});

describe("scrubText", () => {
  it("removes names, ids, addresses, paths, URLs, quoted text and keys", () => {
    const planted = [
      "/home/alice/projects/payroll/notes.md",
      String.raw`C:\Users\bob\AppData\Roaming\wim\device.json`,
      String.raw`\\fileserver\share\x`,
      "~/secret/plan.txt",
      "alice-laptop",
      "alice-laptop.corp.example",
      "Zx3kP9qLmN2vB7wT5yR1aQ",
      "01JFAKEHELD000000000000001",
      "reviewer@alice-laptop",
      "carol@example.com",
      "please deploy the payroll fix tonight",
      "wss://relay.example.org/v1/mesh/xyz",
      "relay.example.org",
      "10.1.2.3",
      "fe80::1",
      "2001:db8:0:0:0:0:2:1",
      "deadbeefcafebabe0011223344556677",
      "wim2-abcd-efgh-jklm-npqr-stuv-wxyz",
      "123456789",
    ];
    const text = `bad: /home/alice/projects/payroll/notes.md and C:\\Users\\bob\\AppData\\Roaming\\wim\\device.json and \\\\fileserver\\share\\x (~/secret/plan.txt) on alice-laptop (alice-laptop.corp.example), mesh Zx3kP9qLmN2vB7wT5yR1aQ id 01JFAKEHELD000000000000001 to reviewer@alice-laptop, mail carol@example.com, text "please deploy the payroll fix tonight", relay wss://relay.example.org/v1/mesh/xyz or relay.example.org at 10.1.2.3 / fe80::1 / 2001:db8:0:0:0:0:2:1, key deadbeefcafebabe0011223344556677, code wim2-abcd-efgh-jklm-npqr-stuv-wxyz, n=123456789 in wim.mjs at 12:30:45`;
    const out = scrubText(text, KNOWN);
    for (const p of planted) expect(out, p).not.toContain(p);
    expect(out).not.toMatch(/alice|bob|carol|payroll|example/i);
    // What a bug report needs is still there.
    expect(out).toContain("wim.mjs");
    expect(out).toContain("12:30:45");
    expect(out).toContain("<quoted>");
    expect(out).toContain("<path>");
  });

  it("keeps an engine's message readable", () => {
    expect(scrubText("Cannot read properties of undefined (reading 'roster')", KNOWN)).toBe("Cannot read properties of undefined (reading <quoted>)");
    expect(scrubText("x.map is not a function", KNOWN)).toBe("<host> is not a function");
    expect(scrubText("Invalid array length", KNOWN)).toBe("Invalid array length");
  });

  it("skips this machine's names when they are too short to match safely, or empty", () => {
    expect(scrubText("ab and / here", { homedir: "/", hostname: "ab" })).toBe("ab and <path> here");
    expect(scrubText("plain", { homedir: "", hostname: "" })).toBe("plain");
  });

  it("drops text that still reads as a credential, and cuts long text", () => {
    expect(scrubText("-----BEGIN RSA PRIVATE KEY----- leaked", KNOWN)).toBe("<removed>");
    const long = scrubText("word ".repeat(100), KNOWN);
    expect(long).toHaveLength(303);
    expect(long.endsWith("...")).toBe(true);
  });
});

describe("stack frames", () => {
  it("parses V8 lines with and without a function", () => {
    expect(parseFrame("    at MeshSession.open (/home/alice/wim.mjs:10:5)")).toEqual({ function: "MeshSession.open", filename: "/home/alice/wim.mjs", lineno: 10, colno: 5, in_app: true });
    expect(parseFrame("    at node:internal/process/task_queues:95:5")).toEqual({ function: "?", filename: "node:internal/process/task_queues", lineno: 95, colno: 5, in_app: false });
    expect(parseFrame("TypeError: boom")).toBeUndefined();
  });

  it("keeps Node's own module names and other files' base names only", () => {
    expect(frameFile(undefined)).toBe("?");
    expect(frameFile("node:internal/process/task_queues")).toBe("node:internal/process/task_queues");
    expect(frameFile("/home/alice/.npm/_npx/1/node_modules/worldinmotion/wim.mjs")).toBe("wim.mjs");
    expect(frameFile(String.raw`C:\Users\bob\wim\client.mjs`)).toBe("client.mjs");
    expect(frameFile("file:///home/alice/wim.mjs")).toBe("wim.mjs");
    expect(frameFile("eval at <anonymous> (/home/alice/x.js:1:1), <anonymous>")).toBe("?");
    expect(frameFile("node:../../home/alice")).toBe("?");
    expect(frameFile("/home/alice")).toBe("?");
    expect(frameFile("native")).toBe("?");
  });

  it("keeps identifier characters of a function name, at most 120", () => {
    expect(frameFunction(undefined)).toBe("?");
    expect(frameFunction("")).toBe("?");
    expect(frameFunction("Object.<anonymous>")).toBe("Object.<anonymous>");
    expect(frameFunction("async Promise.all [as x]")).toBe("async Promise.all [as x]");
    expect(frameFunction("eval (eval at <anonymous> (/home/alice/x.js:1:1)")).toBe("eval");
    expect(frameFunction("we\u0000ird\u202ename")).toBe("weirdname");
    expect(frameFunction("f".repeat(200))).toHaveLength(120);
  });
});

describe("crashEvent", () => {
  const facts: Facts = { release: "worldinmotion@0.1.8", command: "send", platform: "darwin", node: "24.1.0", known: KNOWN };

  it("copies only the allowlisted fields", () => {
    const full: Event = {
      event_id: "e1",
      timestamp: 5,
      user: { id: "alice", ip_address: "10.1.2.3" },
      server_name: "alice-laptop",
      breadcrumbs: [{ message: "sent hello to reviewer@alice-laptop" }],
      extra: { argv: ["send", "x"] },
      request: { url: "https://x.example" },
      modules: { a: "1" },
      contexts: { trace: { trace_id: "t", span_id: "s" }, app: { app_name: "x" } },
      tags: { mesh: "Zx3kP9qLmN2vB7wT5yR1aQ" },
      fingerprint: ["x"],
      exception: {
        values: [
          { type: "TypeError", value: "bad /home/alice/x", mechanism: { type: "generic", handled: true, data: { a: "1" } }, stacktrace: { frames: [{ filename: "/home/alice/wim.mjs", function: "f", lineno: 1, colno: 2, in_app: true, vars: { secret: "s" }, context_line: "const key = 1", abs_path: "/home/alice/wim.mjs" }] } },
          { type: "Error", value: "cause" },
        ],
      },
    };
    expect(crashEvent(full, facts, "command")).toEqual({
      type: undefined,
      event_id: "e1",
      timestamp: 5,
      platform: "node",
      level: "fatal",
      release: "worldinmotion@0.1.8",
      environment: "production",
      exception: { values: [{ type: "TypeError", value: "bad <path>", mechanism: { type: "wim.command", handled: false }, stacktrace: { frames: [{ filename: "wim.mjs", function: "f", lineno: 1, colno: 2, in_app: true }] } }] },
      tags: { command: "send" },
      contexts: { os: { name: "darwin" }, runtime: { name: "node", version: "24.1.0" } },
    });
  });

  it("fills what is missing and refuses a type or command that is not a plain word", () => {
    const sparse = crashEvent({ event_id: "e", timestamp: 1, exception: { values: [{ type: "Bad Type!", stacktrace: { frames: [{ function: "g" }] } }] } }, { ...facts, command: "Not A Command" }, "unhandledRejection");
    expect(sparse.level).toBe("error");
    expect(sparse.tags).toEqual({ command: "other" });
    expect(sparse.exception!.values).toEqual([{ type: "Error", value: "", mechanism: { type: "wim.unhandledRejection", handled: false }, stacktrace: { frames: [{ filename: "?", function: "g", in_app: false }] } }]);
    expect(crashEvent({ event_id: "e", timestamp: 1, exception: { values: [{}] } }, facts, "command").exception!.values![0]!.stacktrace).toEqual({ frames: [] });
    expect(crashEvent({ event_id: "e", timestamp: 1 }, facts, "command").exception).toEqual({ values: [] });
    const many = crashEvent({ event_id: "e", timestamp: 1, exception: { values: [{ type: "TypeError", stacktrace: { frames: Array.from({ length: 80 }, (_, i) => ({ function: `f${i}` })) } }] } }, facts, "command");
    expect(many.exception!.values![0]!.stacktrace!.frames).toHaveLength(50);
    expect(many.exception!.values![0]!.stacktrace!.frames!.at(-1)!.function).toBe("f79");
  });
});

describe("CrashClient", () => {
  it("builds exception events only", async () => {
    const c = new CrashClient({ integrations: [], stackParser: () => [], transport: fetchTransport(stubFetch().fetch, () => undefined) });
    expect((await c.eventFromException(new TypeError("x"))).exception!.values![0]!.type).toBe("TypeError");
    await expect(c.eventFromMessage()).rejects.toThrow(/exceptions only/);
  });
});

describe("CrashReporter: off", () => {
  it("sets nothing up and sends nothing without the person's yes", async () => {
    for (const consent of [null, "off", "", "yes", "ON", "on please"]) {
      const { r, calls, made } = await reporter({}, consent);
      expect(await r.report(new TypeError("boom"), "command")).toBe(false);
      expect(await r.allowed()).toEqual({ ok: false, why: "not-on" });
      expect(made, String(consent)).toHaveLength(0);
      expect(calls, String(consent)).toHaveLength(0);
    }
  });

  it("sets nothing up and sends nothing in a build without an address, whatever the file and the environment say", async () => {
    const { r, calls, made } = await reporter({ dsn: undefined, env: { SENTRY_DSN: DSN, WIM_SENTRY_DSN: DSN } });
    expect(await r.report(new TypeError("boom"), "command")).toBe(false);
    expect(await r.allowed()).toEqual({ ok: false, why: "no-address" });
    expect(made).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("sets nothing up and sends nothing while WIM_NO_CRASH_REPORTS or DO_NOT_TRACK is set, even with a yes", async () => {
    for (const env of [{ WIM_NO_CRASH_REPORTS: "1" }, { DO_NOT_TRACK: "1" }]) {
      const { r, calls, made } = await reporter({ env });
      expect(await r.report(new TypeError("boom"), "command")).toBe(false);
      expect(await r.allowed()).toEqual({ ok: false, why: "env" });
      expect(made).toHaveLength(0);
      expect(calls).toHaveLength(0);
    }
  });

  it("never reports an error that is not a bug, even with a yes", async () => {
    const { r, calls, made } = await reporter();
    for (const e of [new SetupError("not set up"), new ClientError("refused", "full"), new Error("x"), new TypeError("fetch failed"), "boom"]) {
      expect(await r.report(e, "command")).toBe(false);
    }
    expect(made).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("stops at once when the answer turns to off", async () => {
    const { r, calls, file } = await reporter();
    expect(await r.report(new TypeError("one"), "command")).toBe(true);
    await fs.writeFile(file, "off\n");
    expect(await r.report(new TypeError("two"), "command")).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe("CrashReporter: on", () => {
  it("sends one scrubbed event and nothing else", async () => {
    const { r, calls, made } = await reporter();
    const error = new TypeError(`Cannot read properties of undefined (reading 'roster') for "reviewer@alice-laptop" in /home/alice/.config/wim/meshes/Zx3kP9qLmN2vB7wT5yR1aQ/config.json via wss://relay.example.org`);
    error.stack = [
      `TypeError: ${error.message}`,
      "    at MeshSession.open (/home/alice/.npm/_npx/9/node_modules/worldinmotion/wim.mjs:120:7)",
      String.raw`    at C:\Users\bob\AppData\Local\wim\wim.mjs:3:4`,
      "    at eval (eval at <anonymous> (/home/alice/payroll.js:1:1), <anonymous>:1:1)",
      "    at node:internal/process/task_queues:95:5",
    ].join("\n");
    expect(await r.report(error, "command")).toBe(true);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ integrations: [], sendClientReports: false, maxBreadcrumbs: 0, attachStacktrace: false, dataCollection: { userInfo: false, stackFrameVariables: false, frameContextLines: 0 } });
    expect(made[0]!.beforeBreadcrumb!({ message: "x" })).toBeNull();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.startsWith("https://o1.ingest.de.sentry.io/api/4500000000000001/envelope/")).toBe(true);
    const body = calls[0]!.body;
    for (const leaked of ["alice", "bob", "payroll", "reviewer", "Zx3kP9qLmN2vB7wT5yR1aQ", "relay.example.org", "/home/", "C:\\", "config.json", homedir(), userInfo().username, hostname()]) {
      expect(body, leaked).not.toContain(leaked);
    }
    const { header, items } = envelope(body);
    expect(Object.keys(header).sort()).toEqual(["dsn", "event_id", "sdk", "sent_at", "trace"].filter((k) => k in header).sort());
    expect(header).not.toHaveProperty("user");
    expect(items).toHaveLength(1);
    const [itemHeader, event] = items[0]!;
    expect(itemHeader.type).toBe("event");
    expect(Object.keys(event).sort()).toEqual(["contexts", "environment", "event_id", "exception", "level", "platform", "release", "tags", "timestamp"]);
    expect(event).toMatchObject({ level: "fatal", platform: "node", release: "worldinmotion@0.1.8", environment: "production", tags: { command: "mcp" }, contexts: { os: { name: "linux" }, runtime: { name: "node", version: process.versions.node } } });
    const ex = (event.exception as { values: { type: string; value: string; mechanism: unknown; stacktrace: { frames: { filename: string; function: string }[] } }[] }).values;
    expect(ex).toHaveLength(1);
    expect(ex[0]!.type).toBe("TypeError");
    expect(ex[0]!.value).toBe("Cannot read properties of undefined (reading <quoted>) for <quoted> in <path> via <url>");
    expect(ex[0]!.mechanism).toEqual({ type: "wim.command", handled: false });
    // Sentry orders frames oldest first.
    expect(ex[0]!.stacktrace.frames.map((f) => [f.filename, f.function])).toEqual([
      ["node:internal/process/task_queues", "?"],
      ["?", "eval"],
      ["wim.mjs", "?"],
      ["wim.mjs", "MeshSession.open"],
    ]);
  });

  it("reuses its client for a second report and marks an unhandled rejection as one", async () => {
    const { r, calls, made } = await reporter();
    expect(await r.report(new RangeError("one"), "command")).toBe(true);
    expect(await r.report(new RangeError("two"), "unhandledRejection")).toBe(true);
    expect(made).toHaveLength(1);
    expect(calls).toHaveLength(2);
    const event = envelope(calls[1]!.body).items[0]![1] as { level: string; exception: { values: { mechanism: { type: string } }[] } };
    expect(event.level).toBe("error");
    expect(event.exception.values[0]!.mechanism.type).toBe("wim.unhandledRejection");
  });

  it("makes its own client when none is given", async () => {
    const { r, calls } = await reporter({ makeClient: undefined });
    expect(await r.report(new TypeError("x"), "command")).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe("CrashReporter: hostile network", () => {
  it("returns false when Sentry refuses, or the request fails, and never throws", async () => {
    const refused = stubFetch(429);
    const a = await reporter({ fetch: refused.fetch });
    expect(await a.r.report(new TypeError("x"), "command")).toBe(false);
    expect(refused.calls).toHaveLength(1);
    const b = await reporter({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    expect(await b.r.report(new TypeError("x"), "command")).toBe(false);
  });

  it("gives up after its timeout when the request never answers", async () => {
    const { r } = await reporter({ fetch: (() => new Promise(() => undefined)) as typeof fetch, timeoutMs: 50 });
    const started = Date.now();
    expect(await r.report(new TypeError("x"), "command")).toBe(false);
    expect(Date.now() - started).toBeLessThan(REPORT_TIMEOUT_MS);
  });
});

describe("wim crash-reports", () => {
  afterEach(() => {
    delete globalThis.__WIM_SENTRY_DSN__;
  });

  it("is off until a person turns it on, after reading what is sent; anyone can turn it off", async () => {
    const home = await scratch("cr");
    const t = term(home, new RelayHarness());
    const file = join(home, CRASH_REPORTS_FILE);
    expect(await run(t, "crash-reports")).toBe(0);
    expect(t.out).toEqual(["Crash reports are off.", expect.stringMatching(/^This build of wim sends none/)]);

    // No answer, or anything but yes, changes nothing.
    for (const answer of ["", "n", "no", "sure"]) {
      t.answers.push(answer);
      expect(await run(t, "crash-reports", "on")).toBe(1);
      expect(await readConsent(file)).toBeUndefined();
    }
    expect(t.out).toEqual(expect.arrayContaining([...CRASH_REPORT_TERMS, "Send crash reports? [y/N] "]));
    expect(t.err.at(-1)).toBe("wim: nothing changed.");

    t.out.length = 0;
    t.answers.push("y");
    expect(await run(t, "crash-reports", "on")).toBe(0);
    expect(await readConsent(file)).toBe("on");
    expect(t.out.slice(-2)).toEqual(["Crash reports are on. `wim crash-reports off` turns them off.", expect.stringMatching(/^This build of wim sends none/)]);
    expect(await run(t, "crash-reports", "status")).toBe(0);
    expect(t.out.at(-2)).toBe("Crash reports are on.");

    // In a build with an address, nothing more is said; with the environment saying no, that is said.
    globalThis.__WIM_SENTRY_DSN__ = DSN;
    t.out.length = 0;
    expect(await run(t, "crash-reports")).toBe(0);
    expect(t.out).toEqual(["Crash reports are on."]);
    const quiet = term(home, new RelayHarness(), {}, { DO_NOT_TRACK: "1" });
    expect(await run(quiet, "crash-reports")).toBe(0);
    expect(quiet.out).toEqual(["Crash reports are on.", "DO_NOT_TRACK is set, so none are sent from here."]);

    // An agent's shell can turn them off.
    const agent = term(home, new RelayHarness(), {}, { CLAUDECODE: "1" });
    expect(await run(agent, "crash-reports", "off")).toBe(0);
    expect(agent.out).toEqual(["Crash reports are off."]);
    expect(await readConsent(file)).toBe("off");
  });

  it("refuses to turn them on anywhere but a person's own terminal, before asking anything", async () => {
    const home = await scratch("cr");
    for (const t of [
      term(home, new RelayHarness(), {}, { CLAUDECODE: "1" }),
      term(home, new RelayHarness(), {}, { CODEX_SANDBOX: "seatbelt" }),
      term(home, new RelayHarness(), { isTTY: false }),
      term(home, new RelayHarness(), { inputIsTTY: false }),
    ]) {
      t.answers.push("y");
      expect(await run(t, "crash-reports", "on")).toBe(1);
      expect(t.err.at(-1)).toMatch(/run `wim crash-reports on` there/);
      expect(t.out).toEqual([]);
    }
    expect(await readConsent(join(home, CRASH_REPORTS_FILE))).toBeUndefined();
  });

  it("refuses an unknown action and any flag", async () => {
    const t = term(await scratch("cr"), new RelayHarness());
    expect(await run(t, "crash-reports", "maybe")).toBe(1);
    expect(t.err.at(-1)).toBe("wim: usage: wim crash-reports [status | on | off]");
    expect(await run(t, "crash-reports", "on", "--auto")).toBe(2);
  });
});

describe("main reports a bug that ends a command", () => {
  afterEach(() => {
    delete globalThis.__WIM_SENTRY_DSN__;
  });

  /** A terminal whose first line out throws a bug, as a broken command would. */
  async function buggy(consent: string | undefined, env: Record<string, string | undefined> = {}) {
    const home = await scratch("bug");
    if (consent !== undefined) await fs.writeFile(join(home, CRASH_REPORTS_FILE), consent);
    const { fetch, calls } = stubFetch();
    let thrown = false;
    const t = term(
      home,
      new RelayHarness(),
      {
        fetch,
        out: () => {
          if (!thrown) {
            thrown = true;
            throw new TypeError(`Cannot read properties of undefined (reading 'x') at ${home}`);
          }
        },
      },
      env,
    );
    return { t, calls };
  }

  it("sends nothing when the answer is not on, or the build has no address", async () => {
    globalThis.__WIM_SENTRY_DSN__ = DSN;
    for (const consent of [undefined, "off"]) {
      const { t, calls } = await buggy(consent);
      expect(await run(t, "version")).toBe(1);
      expect(t.err).toEqual([expect.stringMatching(/^wim: Cannot read properties/)]);
      expect(calls).toHaveLength(0);
    }
    delete globalThis.__WIM_SENTRY_DSN__;
    const { t, calls } = await buggy("on");
    expect(await run(t, "version")).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("sends one report and says so when the answer is on", async () => {
    globalThis.__WIM_SENTRY_DSN__ = DSN;
    const { t, calls } = await buggy("on");
    expect(await run(t, "version")).toBe(1);
    expect(t.err).toEqual([expect.stringMatching(/^wim: Cannot read properties/), CRASH_SENT]);
    expect(calls).toHaveLength(1);
    const event = envelope(calls[0]!.body).items[0]![1] as { release: string; tags: { command: string }; exception: { values: { value: string }[] } };
    expect(event.release).toMatch(/^worldinmotion@\d+\.\d+\.\d+$/);
    expect(event.tags.command).toBe("version");
    expect(event.exception.values[0]!.value).toBe("Cannot read properties of undefined (reading <quoted>) at <path>");
  });

  it("never reports a refusal or a set-up problem", async () => {
    globalThis.__WIM_SENTRY_DSN__ = DSN;
    const home = await scratch("bug");
    await fs.writeFile(join(home, CRASH_REPORTS_FILE), "on");
    const { fetch, calls } = stubFetch();
    const t = term(home, new RelayHarness(), { fetch });
    // No device yet: a SetupError.
    expect(await run(t, "peers")).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("reports a rejection nothing waited for, through the io's listener", async () => {
    globalThis.__WIM_SENTRY_DSN__ = DSN;
    const home = await scratch("bug");
    await fs.writeFile(join(home, CRASH_REPORTS_FILE), "on");
    const { fetch, calls } = stubFetch();
    const listeners: ((reason: unknown) => void)[] = [];
    const t = term(home, new RelayHarness(), { fetch, onUnexpected: (l) => void listeners.push(l) });
    expect(await main(["version"], t.env, t.io)).toBe(0);
    expect(listeners).toHaveLength(1);
    listeners[0]!(new SetupError("not a bug"));
    listeners[0]!(new TypeError("stray"));
    await until(() => calls.length === 1);
    const event = envelope(calls[0]!.body).items[0]![1] as { level: string; exception: { values: { mechanism: { type: string } }[] } };
    expect(event.exception.values[0]!.mechanism.type).toBe("wim.unhandledRejection");
  });
});

describe("processIo hands a stray rejection on", () => {
  it("to every listener, after saying it on stderr", () => {
    let handler: ((reason: unknown) => void) | undefined;
    const stderr = new PassThrough();
    const proc = {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr,
      platform: "linux",
      pid: 7,
      ppid: process.pid,
      cwd: () => "/",
      once: () => undefined,
      on: (_e: string, cb: (r: unknown) => void) => void (handler = cb),
    } as unknown as Proc;
    const io = processIo(proc, { homedir: () => "/h", hostname: () => "h", kill: () => undefined, wim: () => [] });
    const heard: unknown[][] = [[], []];
    io.onUnexpected!((r) => void heard[0]!.push(r));
    io.onUnexpected!((r) => void heard[1]!.push(r));
    const stray = new TypeError("stray");
    handler!(stray);
    expect(heard).toEqual([[stray], [stray]]);
    expect(String(stderr.read())).toBe("wim: unexpected error: stray\n");
  });
});
