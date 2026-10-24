import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { BACKOFF_MS, clientCommand, clientCwd, EventsProcess, LineSplitter, MAX_LINE, REQUEST_TIMEOUT_MS, RequestError, STABLE_MS, type Child, type SpawnFn, type Timers } from "../src/process.ts";
import type { WimEvent } from "../src/protocol.ts";
import { flush } from "./helpers.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-wim.mjs", import.meta.url));

describe("LineSplitter", () => {
  it("splits across chunks, strips CR, skips blank lines, and keeps UTF-8 split across chunks", () => {
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(l), () => lines.push("DROP"));
    const euro = Buffer.from("€", "utf8");
    s.push(Buffer.from("ab"));
    s.push(Buffer.from("c\r\n\n  \nx"));
    s.push(euro.subarray(0, 1));
    s.push(Buffer.concat([euro.subarray(1), Buffer.from("\n")]));
    expect(lines).toEqual(["abc", `x${"€"}`]);
  });

  it("drops an overlong line once and resumes after its newline", () => {
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(l), () => lines.push("DROP"), 4);
    s.push(Buffer.from("12345"));
    s.push(Buffer.from("678"));
    s.push(Buffer.from("90123"));
    s.push(Buffer.from("\nok\n"));
    expect(lines).toEqual(["DROP", "ok"]);
    expect(MAX_LINE).toBeGreaterThan(1024 * 1024);
  });
});

class FakeChild extends EventEmitter implements Child {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: string[] = [];
  killed = false;
  constructor() {
    super();
    this.stdin.on("data", (c: Buffer) => this.written.push(...c.toString("utf8").split("\n").filter((l) => l !== "")));
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  line(o: unknown): void {
    this.stdout.write(`${JSON.stringify(o)}\n`);
  }
  requests(): { id: string; op: string; args: unknown; v: number }[] {
    return this.written.map((l) => JSON.parse(l) as { id: string; op: string; args: unknown; v: number });
  }
}

class ManualTimers implements Timers {
  readonly queue: { fn: () => void; ms: number; handle: number }[] = [];
  private next = 1;
  setTimeout(fn: () => void, ms: number): unknown {
    const handle = this.next++;
    this.queue.push({ fn, ms, handle });
    return handle;
  }
  clearTimeout(handle: unknown): void {
    const i = this.queue.findIndex((t) => t.handle === handle);
    if (i >= 0) this.queue.splice(i, 1);
  }
  /** Runs the oldest timer with this delay. */
  fire(ms: number): void {
    const i = this.queue.findIndex((t) => t.ms === ms);
    if (i < 0) throw new Error(`no timer for ${ms} ms in ${JSON.stringify(this.queue.map((t) => t.ms))}`);
    this.queue.splice(i, 1)[0]!.fn();
  }
}

function harness(over: { command?: () => { cmd: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }; spawn?: SpawnFn } = {}) {
  const children: FakeChild[] = [];
  const events: WimEvent[] = [];
  const states: string[] = [];
  const logs: string[] = [];
  const timers = new ManualTimers();
  let clock = 1000;
  const spawn = vi.fn<SpawnFn>(() => {
    const c = new FakeChild();
    children.push(c);
    return c;
  });
  const proc = new EventsProcess({
    command: over.command ?? (() => ({ cmd: "wim", args: ["events", "--json"], env: { A: "1" }, cwd: "/work" })),
    onEvent: (e) => events.push(e),
    onState: (s, d) => states.push(d === undefined ? s : `${s}: ${d}`),
    log: (l) => logs.push(l),
    spawn: over.spawn ?? spawn,
    timers,
    now: () => clock,
  });
  return { proc, children, events, states, logs, timers, spawn, advance: (ms: number) => (clock += ms) };
}

describe("EventsProcess", () => {
  it("spawns the command once and delivers events, logging bad lines and stderr", async () => {
    const h = harness();
    h.proc.start();
    h.proc.start();
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.spawn).toHaveBeenCalledWith("wim", ["events", "--json"], { cwd: "/work", env: { A: "1" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const c = h.children[0]!;
    // Running: a request reaches the child.
    void h.proc.request("snapshot").catch(() => undefined);
    await flush();
    expect(c.requests().map((r) => r.op)).toEqual(["snapshot"]);
    c.line({ v: 1, type: "connection", at: 1, state: "open" });
    c.line({ v: 1, type: "weather", at: 1 });
    c.line({ v: 9, type: "connection", at: 1, state: "open" });
    c.stderr.write("warming up\n");
    await flush();
    expect(h.events).toEqual([{ type: "connection", at: 1, state: "open" }]);
    expect(h.logs).toContain("ignored a line from wim events: unsupported version 9");
    expect(h.logs).toContain("warming up");
    expect(h.states).toEqual(["starting"]);
  });

  it("matches responses to requests by id", async () => {
    const h = harness();
    h.proc.start();
    const c = h.children[0]!;
    const ok = h.proc.request("history", { limit: 5 });
    const bad = h.proc.request("approve", { held: "x" });
    const plain = h.proc.request("snapshot");
    await flush();
    const [r1, r2, r3] = c.requests();
    expect(r1).toEqual({ v: 1, id: "r1", op: "history", args: { limit: 5 } });
    expect(r3).toEqual({ v: 1, id: "r3", op: "snapshot", args: {} });
    c.line({ v: 1, type: "response", at: 1, id: r2!.id, ok: false, error: { code: "not_found", message: "no held message x" } });
    c.line({ v: 1, type: "response", at: 1, id: r1!.id, ok: true, result: { messages: [] } });
    c.line({ v: 1, type: "response", at: 1, id: r3!.id, ok: true });
    c.line({ v: 1, type: "response", at: 1, id: "stray", ok: true });
    await expect(ok).resolves.toEqual({ messages: [] });
    await expect(plain).resolves.toEqual({});
    const err = await bad.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestError);
    expect(err).toMatchObject({ code: "not_found", message: "no held message x" });
    expect(h.logs).toContain('a response to no pending request ("stray")');
    expect(h.timers.queue).toEqual([]);
  });

  it("times a request out", async () => {
    const h = harness();
    h.proc.start();
    const p = h.proc.request("send", {}, 500);
    h.timers.fire(500);
    await expect(p).rejects.toMatchObject({ code: "timeout", message: "no answer to send within 0.5 s" });
    const q = h.proc.request("send");
    h.timers.fire(REQUEST_TIMEOUT_MS);
    await expect(q).rejects.toMatchObject({ code: "timeout" });
  });

  it("refuses a request while not running", async () => {
    const h = harness();
    await expect(h.proc.request("snapshot")).rejects.toMatchObject({ code: "closed" });
  });

  it("restarts with backoff after an exit, failing what was pending, and resets after a stable run", async () => {
    const h = harness();
    h.proc.start();
    const p = h.proc.request("snapshot");
    h.children[0]!.stderr.write("wim: this device is not set up: run `wim init` first\n");
    await flush();
    h.children[0]!.emit("exit", 2, null);
    await expect(p).rejects.toMatchObject({ code: "closed", message: "the wim events process exited with code 2: wim: this device is not set up: run `wim init` first" });
    // Not running until the restart: a request is refused at once.
    await expect(h.proc.request("snapshot")).rejects.toMatchObject({ code: "closed", message: "the wim events process is not running" });
    expect(h.states).toEqual(["starting", "exited: exited with code 2: wim: this device is not set up: run `wim init` first"]);
    expect(h.logs).toContain("restarting in 1 s");
    h.timers.fire(BACKOFF_MS[0]!);
    expect(h.children.length).toBe(2);
    h.children[1]!.emit("exit", null, "SIGTERM");
    expect(h.states.at(-1)).toBe("exited: stopped by SIGTERM");
    h.timers.fire(BACKOFF_MS[1]!);
    for (let i = 2; i < BACKOFF_MS.length + 1; i += 1) {
      h.children[i]!.emit("exit", 1, null);
      h.timers.fire(BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]!);
    }
    // A process that stayed up long enough starts the backoff again from the first step.
    h.advance(STABLE_MS);
    h.children.at(-1)!.emit("exit", 1, null);
    h.timers.fire(BACKOFF_MS[0]!);
    // Output from a replaced process is ignored.
    h.children[0]!.line({ v: 1, type: "connection", at: 1, state: "open" });
    h.children[0]!.stderr.write("old\n");
    await flush();
    expect(h.events).toEqual([]);
    expect(h.logs).not.toContain("old");
  });

  it("treats a spawn error as an exit, once", () => {
    const h = harness();
    h.proc.start();
    const c = h.children[0]!;
    c.emit("error", new Error("spawn wim ENOENT"));
    c.emit("exit", -2, null);
    expect(h.logs).toContain("could not run wim: spawn wim ENOENT");
    expect(h.states).toEqual(["starting", "exited: spawn wim ENOENT"]);
    c.stdin.emit("error", new Error("EPIPE"));
    expect(h.logs).toContain("stdin: EPIPE");
  });

  it("retries when the command cannot be built or spawn throws", () => {
    let fail = true;
    const h = harness({
      command: () => {
        if (fail) throw new Error("bad session name");
        return { cmd: "wim", args: [], env: {}, cwd: "/" };
      },
    });
    h.proc.start();
    expect(h.states).toEqual(["starting", "exited: bad session name"]);
    fail = false;
    h.timers.fire(BACKOFF_MS[0]!);
    expect(h.children.length).toBe(1);

    const t = harness({
      spawn: () => {
        throw new Error("EINVAL");
      },
    });
    t.proc.start();
    expect(t.states).toEqual(["starting", "exited: EINVAL"]);
  });

  it("stops without restarting, and restarts on request", async () => {
    const h = harness();
    h.proc.stop();
    h.proc.start();
    const c = h.children[0]!;
    const p = h.proc.request("snapshot");
    h.proc.stop();
    await expect(p).rejects.toMatchObject({ code: "closed", message: "the wim events process stopped" });
    expect(c.killed).toBe(true);
    expect(c.stdin.writableEnded).toBe(true);
    c.emit("exit", 0, null);
    expect(h.timers.queue).toEqual([]);
    h.proc.restart();
    expect(h.children.length).toBe(2);
    h.children[1]!.emit("exit", 1, null);
    expect(h.timers.queue.length).toBe(1);
    h.proc.stop();
    expect(h.timers.queue).toEqual([]);
  });

  it("drops overlong stdout and stderr lines", async () => {
    const c = new FakeChild();
    const logs: string[] = [];
    const proc = new EventsProcess({ command: () => ({ cmd: "wim", args: [], env: {}, cwd: "/" }), onEvent: () => undefined, onState: () => undefined, log: (l) => logs.push(l), spawn: () => c, timers: new ManualTimers(), maxLine: 8 });
    proc.start();
    c.stdout.write("0123456789");
    c.stderr.write("0123456789");
    await flush();
    expect(logs).toEqual(["starting wim ", "dropped a stdout line longer than 8 bytes", "dropped a long stderr line"]);
  });

  it("runs the fake client end to end with the real spawn and timers", async () => {
    const events: WimEvent[] = [];
    const proc = new EventsProcess({
      command: () => ({ cmd: process.execPath, args: [FIXTURE, "events", "--json", "--as", "unit"], env: { PATH: process.env.PATH }, cwd: process.cwd() }),
      onEvent: (e) => events.push(e),
      onState: () => undefined,
      log: () => undefined,
    });
    proc.start();
    await vi.waitFor(() => expect(events.some((e) => e.type === "snapshot")).toBe(true));
    const r = (await proc.request("history", { peer: "coder@buildbox" })) as { messages: unknown[] };
    expect(r.messages.length).toBe(2);
    await expect(proc.request("nope")).rejects.toMatchObject({ code: "input" });
    proc.stop();
  });
});

describe("clientCommand", () => {
  const base = { extensionPath: "/ext", wimPath: "", sessionName: "vscode", execPath: "/electron", env: { HOME: "/h", ELECTRON_RUN_AS_NODE: "0" }, cwd: "/work/app" };

  it("runs the bundled client on VS Code's Node", () => {
    expect(clientCommand(base)).toEqual({
      cmd: "/electron",
      // The bundled client sits under the extension, in this OS's path form.
      args: [join("/ext", "dist", "wim.mjs"), "events", "--json", "--as", "vscode"],
      env: { HOME: "/h", ELECTRON_RUN_AS_NODE: "1" },
      cwd: "/work/app",
    });
  });

  it("runs a script wimPath on VS Code's Node and anything else as an executable", () => {
    expect(clientCommand({ ...base, wimPath: " /opt/wim.MJS " }).args[0]).toBe("/opt/wim.MJS");
    expect(clientCommand({ ...base, wimPath: "/opt/wim.cjs" }).cmd).toBe("/electron");
    expect(clientCommand({ ...base, wimPath: "/usr/local/bin/wim", sessionName: "ui-2" })).toEqual({
      cmd: "/usr/local/bin/wim",
      args: ["events", "--json", "--as", "ui-2"],
      env: { HOME: "/h" },
      cwd: "/work/app",
    });
  });

  it("refuses a session name outside the client's grammar", () => {
    expect(() => clientCommand({ ...base, sessionName: "Bad Name" })).toThrow(/worldinmotion.sessionName must be/);
    expect(() => clientCommand({ ...base, sessionName: "--json" })).toThrow();
  });
});

describe("clientCwd", () => {
  it("is the first local workspace folder, else the home directory", () => {
    const file = (fsPath: string) => ({ scheme: "file", fsPath });
    expect(clientCwd([file("/work/app"), file("/work/other")], "/home/me")).toBe("/work/app");
    expect(clientCwd(undefined, "/home/me")).toBe("/home/me");
    expect(clientCwd([], "/home/me")).toBe("/home/me");
    // A remote folder is not a path on this machine.
    expect(clientCwd([{ scheme: "vscode-remote", fsPath: "/srv/app" }], "/home/me")).toBe("/home/me");
  });
});
