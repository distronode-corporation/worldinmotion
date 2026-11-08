import { promises as fs } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { acquireLock, FLOCK_BUSY, lookupUser, memAvailableMb, readAll, startJob, systemDeps } from "../../src/privileged/system.ts";

let dir: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(join(process.env["WIM_TEST_TMP"] || tmpdir(), "wim-priv-"));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const linux = process.platform === "linux";

describe.runIf(linux)("lookupUser", () => {
  it("reads this user's uid and primary gid from id", async () => {
    expect(await lookupUser(userInfo().username)).toEqual({ uid: process.getuid!(), gid: process.getgid!() });
  });
  it("refuses a user that does not exist", async () => {
    await expect(lookupUser("no-such-user-wim-test")).rejects.toThrow(/no such user/);
  });
  it("refuses output that is not a number", async () => {
    const run = ((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => cb(null, "x\n")) as never;
    await expect(lookupUser("u", run)).rejects.toThrow(/no such user u/);
  });
});

describe.runIf(linux)("acquireLock", () => {
  it("holds the lock after flock(1) exits, makes a second taker wait and give up, and releases on close", async () => {
    const path = join(dir, "job.lock");
    const first = await acquireLock(path, 0);
    expect(first).not.toBeNull();
    expect(await acquireLock(path, 0)).toBeNull();
    await first!.release();
    const again = await acquireLock(path, 0);
    expect(again).not.toBeNull();
    await again!.release();
  });
  it("is the same lock a shell takes with flock on fd 9", async () => {
    const path = join(dir, "shell.lock");
    const { spawn } = await import("node:child_process");
    const shell = spawn("bash", ["-c", `exec 9>"$0"; flock 9; echo held; sleep 5`, path], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise((r) => shell.stdout.once("data", r));
    expect(await acquireLock(path, 0)).toBeNull();
    shell.kill("SIGKILL");
    await new Promise((r) => shell.once("exit", r));
    const mine = await acquireLock(path, 1);
    expect(mine).not.toBeNull();
    await mine!.release();
  });
  it("throws when flock fails for another reason, or cannot start", async () => {
    await expect(acquireLock(join(dir, "x.lock"), 0, "false")).rejects.toThrow(/flock exited 1/);
    await expect(acquireLock(join(dir, "y.lock"), 0, join(dir, "no-flock"))).rejects.toThrow(/ENOENT/);
  });
  it("uses 75 for busy", () => {
    expect(FLOCK_BUSY).toBe(75);
  });
});

describe("memAvailableMb", () => {
  it.runIf(linux)("reads /proc/meminfo in MB", async () => {
    expect(await memAvailableMb()).toBeGreaterThan(0);
  });
  it("is undefined without the line or the file", async () => {
    const p = join(dir, "meminfo");
    await fs.writeFile(p, "MemTotal:  100 kB\n");
    expect(await memAvailableMb(p)).toBeUndefined();
    await fs.writeFile(p, "MemAvailable:    2048000 kB\n");
    expect(await memAvailableMb(p)).toBe(2000);
    expect(await memAvailableMb(join(dir, "none"))).toBeUndefined();
  });
});

const node = process.execPath;
const spec = (script: string, over: Record<string, unknown> = {}) => ({ command: node, args: ["-e", script], cwd: dir, env: { PATH: process.env["PATH"]! }, stdin: "the prompt", ...over });

describe.runIf(linux)("startJob", () => {
  it("feeds stdin, streams stdout and stderr, and reports the exit code", async () => {
    const h = startJob(spec(`let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write("got "+s);process.stderr.write("worker: x\\n");process.exit(3)})`));
    const out: string[] = [];
    const err: string[] = [];
    h.onStdout((b) => out.push(b.toString()));
    h.onStderr((b) => err.push(b.toString()));
    expect(await h.exited).toBe(3);
    expect(out.join("")).toBe("got the prompt");
    expect(err.join("")).toBe("worker: x\n");
  });
  it("runs in its own process group, which killGroup ends", async () => {
    const h = startJob(spec(`require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:"ignore"});setTimeout(()=>{},60000)`));
    await new Promise((r) => setTimeout(r, 200));
    h.killGroup("SIGKILL");
    expect(await h.exited).toBeNull();
    h.killGroup("SIGTERM");
  });
  it("switches to the uid and gid it is given (our own, as a user)", async () => {
    const h = startJob(spec(`process.stdout.write(process.getuid()+":"+process.getgid())`, { uid: process.getuid!(), gid: process.getgid!() }));
    const out: string[] = [];
    h.onStdout((b) => out.push(b.toString()));
    expect(await h.exited).toBe(0);
    expect(out.join("")).toBe(`${process.getuid!()}:${process.getgid!()}`);
  });
  it("reports 127 when the command cannot start", async () => {
    expect(await startJob(spec("", { command: join(dir, "missing") })).exited).toBe(127);
  });
  it("survives a job that never reads its input", async () => {
    expect(await startJob(spec("process.exit(0)", { stdin: "x".repeat(1 << 20) })).exited).toBe(0);
  });
});

describe("readAll", () => {
  it("reads to the end, at most max bytes", async () => {
    expect((await readAll(Readable.from([Buffer.from("abc"), Buffer.from("def"), Buffer.from("ghi")]), 4)).toString()).toBe("abcd");
    expect((await readAll(Readable.from([Buffer.from("ab")]), 4)).toString()).toBe("ab");
  });
  it("rejects on a stream error", async () => {
    const s = new PassThrough();
    const p = readAll(s, 4);
    s.destroy(new Error("broken"));
    await expect(p).rejects.toThrow("broken");
  });
});

describe.runIf(linux)("systemDeps", () => {
  it("binds every dependency to the real system", async () => {
    const d = systemDeps();
    expect(d.euid).toBe(process.geteuid!());
    expect(d.uid).toBe(process.getuid!());
    expect(d.pid).toBe(process.pid);

    const f = join(dir, "a.txt");
    await d.brokerFs.writeFile(f, "one", 0o640);
    expect((await fs.stat(f)).mode & 0o777).toBe(0o640);
    expect(await d.configFs.readFile(f)).toBe("one");
    expect(await d.configFs.stat(f)).toEqual({ uid: process.getuid!(), mode: (await fs.stat(f)).mode });
    expect((await d.configFs.stat(dir)).mode).toBe(0o777);
    await d.brokerFs.chown(f, process.getuid!(), process.getgid!());
    await d.chown(f, process.getuid!(), process.getgid!());
    await d.brokerFs.rename(f, `${f}.2`);
    await d.brokerFs.rm(`${f}.2`);
    await d.brokerFs.rm(`${f}.2`);
    await d.mkdir(join(dir, "m", "n"), 0o750);
    expect((await fs.stat(join(dir, "m", "n"))).isDirectory()).toBe(true);

    expect(await d.lookupUser(userInfo().username)).toEqual({ uid: process.getuid!(), gid: process.getgid!() });
    const lock = await d.acquireLock(join(dir, "d.lock"), 0);
    await lock!.release();
    expect(await d.memAvailableMb()).toBeGreaterThan(0);
    expect(await d.startJob(spec("process.exit(0)")).exited).toBe(0);
    expect(d.now()).toBeGreaterThan(0);

    await fs.writeFile(join(dir, "tok"), "t");
    expect(await d.identity.readFile(join(dir, "tok"))).toBe("t");
    expect(await (await d.identity.fetch("data:text/plain,hi", { headers: {} })).text()).toBe("hi");
    expect(typeof d.identity.awsWebIdentityToken).toBe("function");

    const seen: string[] = [];
    const off = d.onSignal(() => seen.push("sig"));
    process.emit("SIGHUP" as never);
    off();
    process.emit("SIGHUP" as never);
    expect(seen).toEqual(["sig"]);

    let fired = 0;
    d.clearTimeout(d.setTimeout(() => fired++, 1));
    d.clearInterval(d.setInterval(() => fired++, 1));
    await new Promise((r) => setTimeout(r, 10));
    expect(fired).toBe(0);

    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const ewrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    d.out(Buffer.from("answer"));
    d.err("line");
    d.worker.out("text");
    d.worker.err("wline");
    expect(write.mock.calls.map((c) => String(c[0]))).toEqual(["answer", "text\n"]);
    expect(ewrite.mock.calls.map((c) => String(c[0]))).toEqual(["line\n", "wline\n"]);
    write.mockRestore();
    ewrite.mockRestore();

    const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
    Object.defineProperty(process, "stdin", { configurable: true, get: () => Readable.from([Buffer.from("in")]) });
    try {
      expect((await d.readStdin(10)).toString()).toBe("in");
      expect(await d.worker.readStdin()).toBe("in");
    } finally {
      Object.defineProperty(process, "stdin", stdin);
    }
    expect(d.worker.loadQuery).toBeTypeOf("function");
  });
});
