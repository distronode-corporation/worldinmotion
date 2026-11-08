import { promises as fs } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { acquireLock, ancestorsAllRoot, codeProblem, FLOCK_BUSY, lookupUser, memAvailableMb, readAll, secureDir, secureRead, secureWrite, startJob, systemDeps } from "../../src/privileged/system.ts";

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

describe("ancestorsAllRoot", () => {
  async function tree(name: string, procs: Record<number, { ppid: number; uid: number }>): Promise<string> {
    const root = join(dir, name);
    for (const [pid, p] of Object.entries(procs)) {
      await fs.mkdir(join(root, pid), { recursive: true });
      await fs.writeFile(join(root, pid, "status"), `Name:\tx\nPPid:\t${p.ppid}\nUid:\t${p.uid}\t${p.uid}\t${p.uid}\t${p.uid}\n`);
    }
    return root;
  }
  it("is true when only root runs above us, up to pid 1 or a top with no parent", async () => {
    expect(await ancestorsAllRoot(30, await tree("p1", { 30: { ppid: 20, uid: 0 }, 20: { ppid: 1, uid: 0 }, 1: { ppid: 0, uid: 0 } }))).toBe(true);
    expect(await ancestorsAllRoot(30, await tree("p2", { 30: { ppid: 7, uid: 1000 }, 7: { ppid: 0, uid: 0 } }))).toBe(true);
  });
  it("is false with a non-root ancestor (a peer calling sudo), an unreadable link, or a loop", async () => {
    expect(await ancestorsAllRoot(30, await tree("p3", { 30: { ppid: 20, uid: 0 }, 20: { ppid: 10, uid: 0 }, 10: { ppid: 1, uid: 998 }, 1: { ppid: 0, uid: 0 } }))).toBe(false);
    expect(await ancestorsAllRoot(30, await tree("p4", { 30: { ppid: 20, uid: 0 } }))).toBe(false);
    expect(await ancestorsAllRoot(30, await tree("p5", { 30: { ppid: 5, uid: 0 }, 5: { ppid: 6, uid: 0 }, 6: { ppid: 5, uid: 0 } }))).toBe(false);
  });
  it.runIf(linux && process.getuid!() !== 0)("is false for this test run, whose user is not root", async () => {
    expect(await ancestorsAllRoot(process.pid)).toBe(false);
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

const me = () => ({ uid: process.getuid!(), gid: process.getgid!() });

describe.runIf(linux)("secureRead", () => {
  it("reads a file its owner alone writes, checking the opened file", async () => {
    const f = join(dir, "r.json");
    await fs.writeFile(f, "ok", { mode: 0o600 });
    expect(await secureRead(f, { owner: me().uid, secret: true })).toBe("ok");
    expect(await secureRead(f, { owner: undefined, secret: true })).toBe("ok");
  });
  it("refuses a symlink, another owner, a readable secret and a writable file", async () => {
    const f = join(dir, "r2.json");
    await fs.writeFile(f, "ok", { mode: 0o644 });
    await fs.symlink(f, join(dir, "link.json"));
    await expect(secureRead(join(dir, "link.json"), { owner: me().uid, secret: false })).rejects.toThrow(/ELOOP/);
    await expect(secureRead(f, { owner: me().uid + 1, secret: false })).rejects.toThrow(/not owned by uid/);
    await expect(secureRead(f, { owner: me().uid, secret: true })).rejects.toMatchObject({ code: "EUNSAFE" });
    await fs.chmod(f, 0o666);
    await expect(secureRead(f, { owner: me().uid, secret: false })).rejects.toThrow(/writable by group or others/);
    await expect(secureRead(join(dir, "none.json"), { owner: undefined, secret: false })).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe.runIf(linux)("secureWrite", () => {
  it("writes through a fresh temporary file with the mode and owner, then renames it", async () => {
    const f = join(dir, "state.json");
    await secureWrite(f, "one", 0o600, me());
    await secureWrite(f, "two", 0o600, undefined);
    expect(await fs.readFile(f, "utf8")).toBe("two");
    expect((await fs.stat(f)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(dir)).filter((n) => n.startsWith("state.json."))).toEqual([]);
  });
  it("replaces a symlink planted at the target instead of writing through it", async () => {
    const victim = join(dir, "victim");
    await fs.writeFile(victim, "keep");
    const f = join(dir, "planted.json");
    await fs.symlink(victim, f);
    await secureWrite(f, "new", 0o600, undefined);
    expect(await fs.readFile(victim, "utf8")).toBe("keep");
    expect((await fs.lstat(f)).isSymbolicLink()).toBe(false);
  });
  it("cleans up its temporary file when the write fails", async () => {
    const f = join(dir, "fail.json");
    await expect(secureWrite(f, "x", 0o600, { uid: 0, gid: 0 })).rejects.toThrow(/EPERM/);
    expect((await fs.readdir(dir)).filter((n) => n.startsWith("fail.json"))).toEqual([]);
  });
});

describe.runIf(linux)("secureDir", () => {
  it("makes a missing directory and sets its owner and mode through a handle", async () => {
    const d = join(dir, "sd", "inner");
    await secureDir(d, 0o750, me());
    expect((await fs.stat(d)).mode & 0o777).toBe(0o750);
    await secureDir(d, 0o700, undefined);
  });
  it("only checks a shared directory: never changes its owner or mode", async () => {
    const shared = join(dir, "shared");
    await fs.mkdir(shared, { mode: 0o750 });
    await fs.chmod(shared, 0o750);
    await secureDir(shared, 0o700, me(), false);
    expect((await fs.stat(shared)).mode & 0o777).toBe(0o750);
    const made = join(dir, "shared-new");
    await secureDir(made, 0o755, me(), false);
    expect((await fs.stat(made)).isDirectory()).toBe(true);
    await fs.chmod(shared, 0o770);
    await expect(secureDir(shared, 0o700, me(), false)).rejects.toMatchObject({ code: "EUNSAFE" });
  });
  it("refuses a symlink, a file, another owner, and a directory others can write", async () => {
    const real = join(dir, "real-dir");
    await fs.mkdir(real);
    await fs.symlink(real, join(dir, "dir-link"));
    await expect(secureDir(join(dir, "dir-link"), 0o750, me())).rejects.toThrow(/not a directory/);
    await fs.writeFile(join(dir, "a-file"), "");
    await expect(secureDir(join(dir, "a-file"), 0o750, undefined)).rejects.toThrow(/EEXIST|not a directory/);
    await expect(secureDir(real, 0o750, { uid: me().uid + 1, gid: me().gid })).rejects.toThrow(/not its owner's alone/);
    await fs.chmod(real, 0o777);
    await expect(secureDir(real, 0o750, me())).rejects.toMatchObject({ code: "EUNSAFE" });
  });
});

describe.runIf(linux)("codeProblem", () => {
  it("passes code that root alone can change, and names the first path anyone else could", async () => {
    expect(await codeProblem(["/usr/bin/env"])).toBeUndefined();
    const mine = join(dir, "bin.mjs");
    await fs.writeFile(mine, "");
    expect(await codeProblem(["/usr/bin/env", mine])).toMatch(new RegExp(`${mine} is not root's alone`));
  });
});

describe.runIf(linux)("acquireLock on a planted symlink", () => {
  it("refuses to open the lock through a symlink", async () => {
    const target = join(dir, "elsewhere");
    await fs.symlink(target, join(dir, "sym.lock"));
    await expect(acquireLock(join(dir, "sym.lock"), 0)).rejects.toThrow(/ELOOP/);
  });
});

describe.runIf(linux)("systemDeps", () => {
  it("binds every dependency to the real system", async () => {
    const d = systemDeps();
    expect(d.euid).toBe(process.geteuid!());
    expect(d.uid).toBe(process.getuid!());

    const f = join(dir, "a.txt");
    await d.writeFile(f, "one", 0o640);
    expect(await d.readFile(f, { owner: undefined, secret: false })).toBe("one");
    await d.ensureDir(join(dir, "m", "n"), 0o750);
    await fs.chmod(join(dir, "m", "n"), 0o750);
    await d.checkDir(join(dir, "m", "n"));
    expect((await fs.stat(join(dir, "m", "n"))).mode & 0o777).toBe(0o750);
    expect((await fs.stat(join(dir, "m", "n"))).isDirectory()).toBe(true);
    expect(await d.codeProblem()).toEqual(process.getuid!() === 0 ? expect.anything() : expect.stringMatching(/is not root's alone/));

    expect(await d.lookupUser(userInfo().username)).toEqual(me());
    const lock = await d.acquireLock(join(dir, "d.lock"), 0);
    await lock!.release();
    expect(await d.memAvailableMb()).toBeGreaterThan(0);
    expect(await d.ancestorsAllRoot()).toBe(process.getuid!() === 0);
    expect(await d.startJob(spec("process.exit(0)")).exited).toBe(0);
    expect(d.now()).toBeGreaterThan(0);

    await fs.writeFile(join(dir, "tok"), "t");
    expect(await d.identity.readFile(join(dir, "tok"))).toBe("t");
    expect(await (await d.identity.fetch("data:text/plain,hi", { headers: {} })).text()).toBe("hi");
    expect(await (await d.fetch("data:text/plain,up")).text()).toBe("up");
    expect(typeof d.identity.awsWebIdentityToken).toBe("function");
    expect(typeof (await d.credentials()).oidcFederationProvider).toBe("function");
    const proxy = await d.startProxy({ upstream: "https://x.test", auth: async () => ({}), models: [], maxTokens: 1, maxRequests: 1, maxBodyBytes: 1, requestTimeoutMs: 1, fetch: d.fetch as never, log: () => undefined });
    await proxy.close();

    const seen: string[] = [];
    const off = d.onSignal(() => seen.push("sig"));
    process.emit("SIGHUP" as never);
    off();
    process.emit("SIGHUP" as never);
    expect(seen).toEqual(["sig"]);

    let fired = 0;
    d.clearTimeout(d.setTimeout(() => fired++, 1));
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

  it.runIf(process.getuid!() !== 0)("as root, writes and directories must be root's (refused here, where we are not)", async () => {
    const d = systemDeps(0);
    expect(d.euid).toBe(0);
    await expect(d.writeFile(join(dir, "root.json"), "x", 0o600)).rejects.toThrow(/EPERM/);
    await fs.mkdir(join(dir, "mine"), { recursive: true });
    await expect(d.ensureDir(join(dir, "mine"), 0o700)).rejects.toMatchObject({ code: "EUNSAFE" });
    await expect(d.ensureDir(join(dir, "mine"), 0o750, 991)).rejects.toMatchObject({ code: "EUNSAFE" });
    await expect(d.checkDir(join(dir, "mine"))).rejects.toMatchObject({ code: "EUNSAFE" });
  });
});
