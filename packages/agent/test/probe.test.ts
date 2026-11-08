import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lookupUser, probe, serviceNoNewPrivs, type ExecFile, type Spawn } from "../src/probe.ts";

const POSIX = process.platform !== "win32";
// Root reads and writes everything, so the "no" cases only hold for an ordinary user.
const ROOT = POSIX && process.getuid!() === 0;

let dir: string;
beforeAll(async () => {
  const base = process.env["WIM_TEST_TMP"] || tmpdir();
  await mkdir(base, { recursive: true });
  dir = await mkdtemp(join(base, "wim-agent-probe-"));
});
afterAll(async () => {
  await chmod(join(dir, "locked"), 0o700).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

/** A child that prints `out` and closes, or errors, as a real one would. */
function fakeSpawn(behave: (child: EventEmitter & { stdout: PassThrough; kill: (s: string) => boolean }) => void, seen?: unknown[]): Spawn {
  return ((command: string, args: readonly string[], options: unknown) => {
    seen?.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: () => true });
    setImmediate(() => behave(child));
    return child as unknown as ChildProcess;
  }) as Spawn;
}

describe("probe, for real, as this user", () => {
  it("reads a readable file, and says missing for none", async () => {
    const f = join(dir, "readable");
    await writeFile(f, "x");
    expect(await probe(undefined, { op: "read", path: f })).toBe("yes");
    expect(await probe(undefined, { op: "read", path: join(dir, "absent") })).toBe("missing");
  });

  it.skipIf(!POSIX || ROOT)("cannot read a file with no read bit, nor write a read-only directory", async () => {
    const f = join(dir, "secret");
    await writeFile(f, "x");
    await chmod(f, 0o000);
    expect(await probe(undefined, { op: "read", path: f })).toBe("no");
    const ro = join(dir, "locked");
    await mkdir(ro);
    await chmod(ro, 0o500);
    expect(await probe(undefined, { op: "write", path: ro })).toBe("no");
  });

  it("writes a writable directory and says missing for none", async () => {
    expect(await probe(undefined, { op: "write", path: dir })).toBe("yes");
    expect(await probe(undefined, { op: "write", path: join(dir, "nope", "x") })).toBe("missing");
  });

  it.skipIf(!POSIX)("says error for a path the kernel refuses in another way", async () => {
    // A path through a file: ENOTDIR, neither denied nor missing.
    const f = join(dir, "plain");
    await writeFile(f, "x");
    expect(await probe(undefined, { op: "read", path: join(f, "below") })).toBe("error");
  });

  it("connects to a listening port and not to a closed one", async () => {
    const server = createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    expect(await probe(undefined, { op: "connect", host: "127.0.0.1", port, timeoutMs: 2000 })).toBe("yes");
    await new Promise<void>((r) => server.close(() => r()));
    expect(await probe(undefined, { op: "connect", host: "127.0.0.1", port, timeoutMs: 2000 })).toBe("no");
  });

  it("gives up on a connection that never answers", async () => {
    // A TEST-NET address routes nowhere: the connect hangs until the probe's own timeout.
    expect(await probe(undefined, { op: "connect", host: "192.0.2.1", port: 80, timeoutMs: 50 })).toBe("no");
  });

  it.skipIf(!POSIX)("runs as a given uid and gid (its own here; root runs it as any user)", async () => {
    const me = { name: "me", uid: process.getuid!(), gid: process.getgid!() };
    expect(await probe(me, { op: "write", path: dir })).toBe("yes");
  });
});

describe("probe, its failures", () => {
  it("passes the op, an empty environment and the uid to the child", async () => {
    const seen: unknown[] = [];
    const a = await probe({ name: "u", uid: 1234, gid: 99 }, { op: "read", path: "/x" }, { node: "node-bin", spawn: fakeSpawn((c) => (c.stdout.end("no"), setImmediate(() => c.emit("close", 0))), seen) });
    expect(a).toBe("no");
    const call = seen[0] as { command: string; args: string[]; options: Record<string, unknown> };
    expect(call.command).toBe("node-bin");
    expect(call.args[2]).toBe(JSON.stringify({ op: "read", path: "/x" }));
    expect(call.options).toMatchObject({ env: {}, uid: 1234, gid: 99 });
  });

  it("is error when the spawn throws (another uid without root)", async () => {
    const spawn = (() => {
      throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
    }) as Spawn;
    expect(await probe({ name: "u", uid: 1, gid: 1 }, { op: "read", path: "/x" }, { spawn })).toBe("error");
  });

  it("is error when the child fails to start, prints something else, or hangs", async () => {
    expect(await probe(undefined, { op: "read", path: "/x" }, { spawn: fakeSpawn((c) => c.emit("error", new Error("ENOENT"))) })).toBe("error");
    expect(await probe(undefined, { op: "read", path: "/x" }, { spawn: fakeSpawn((c) => (c.stdout.end("maybe"), setImmediate(() => c.emit("close", 0)))) })).toBe("error");
    let killed = false;
    const hang = fakeSpawn((c) => {
      c.kill = () => ((killed = true), true);
    });
    expect(await probe(undefined, { op: "read", path: "/x" }, { spawn: hang, limitMs: 20 })).toBe("error");
    expect(killed).toBe(true);
  });

  it("settles once: a close after the timeout changes nothing", async () => {
    let child: (EventEmitter & { stdout: PassThrough }) | undefined;
    const spawn = fakeSpawn((c) => (child = c));
    expect(await probe(undefined, { op: "read", path: "/x" }, { spawn, limitMs: 10 })).toBe("error");
    child!.emit("close", 0);
  });
});

describe("lookupUser", () => {
  it.skipIf(!POSIX)("finds this user by name with the real id(1)", async () => {
    const { userInfo } = await import("node:os");
    const me = userInfo();
    expect(await lookupUser(me.username)).toEqual({ name: me.username, uid: me.uid, gid: me.gid });
  });

  it("asks the real id(1) on every platform (where there is none, the answer is undefined)", async () => {
    expect(await lookupUser("wim-no-such-user")).toBeUndefined();
  });

  it("is undefined for an unknown user, a failed id, or an odd answer", async () => {
    const answers: Record<string, [Error | null, string]> = { "-u": [null, "1001\n"], "-g": [new Error("no such user"), ""] };
    const exec: ExecFile = (_f, args, cb) => {
      const [err, out] = answers[args[0]!]!;
      cb(err, out);
    };
    expect(await lookupUser("someone", exec)).toBeUndefined();
    answers["-g"] = [null, "1001\n"];
    expect(await lookupUser("someone", exec)).toEqual({ name: "someone", uid: 1001, gid: 1001 });
    answers["-u"] = [null, "not a number"];
    expect(await lookupUser("someone", exec)).toBeUndefined();
  });

  it("never hands id(1) a name a user cannot have", async () => {
    const exec: ExecFile = () => {
      throw new Error("must not run");
    };
    for (const bad of ["-u", "Root", "a b", "x".repeat(40), "", "../etc"]) expect(await lookupUser(bad, exec)).toBeUndefined();
  });
});

describe("serviceNoNewPrivs", () => {
  const exec = (answer: [Error | null, string], seen?: string[][]): ExecFile => (_f, args, cb) => {
    seen?.push([...args]);
    cb(answer[0], answer[1]);
  };
  const status = (nnp: string) => async (path: string) => {
    expect(path).toBe("/proc/321/status");
    return `Name:\tnode\nNoNewPrivs:\t${nnp}\nSeccomp:\t0\n`;
  };

  it("reads the main process's flag", async () => {
    const seen: string[][] = [];
    expect(await serviceNoNewPrivs("wim-agent.service", exec([null, "321\n"], seen), status("0"))).toEqual({ pid: 321, value: "0" });
    expect(seen[0]).toEqual(["show", "--property", "MainPID", "--value", "--", "wim-agent.service"]);
    expect(await serviceNoNewPrivs("wim-agent.service", exec([null, "321\n"]), status("1"))).toEqual({ pid: 321, value: "1" });
  });

  it("says why when it cannot", async () => {
    const never = async () => {
      throw new Error("must not read");
    };
    expect(await serviceNoNewPrivs("bad name;", exec([null, "1"]), never)).toEqual({ skip: '"bad name;" is not a unit name' });
    expect(await serviceNoNewPrivs("w.service", exec([new Error("ENOENT"), ""]), never)).toEqual({ skip: "systemctl did not answer (no systemd here?)" });
    expect(await serviceNoNewPrivs("w.service", exec([null, "0\n"]), never)).toEqual({ skip: "w.service is not running" });
    expect(await serviceNoNewPrivs("w.service", exec([null, "x"]), never)).toEqual({ skip: "w.service is not running" });
    const gone = async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    expect(await serviceNoNewPrivs("w.service", exec([null, "321"]), gone)).toEqual({ skip: "the status of w.service's process 321 cannot be read here" });
    expect(await serviceNoNewPrivs("w.service", exec([null, "321"]), async () => "Name:\tx\n")).toEqual({ skip: "the status of w.service's process 321 cannot be read here" });
  });

  it("runs the real systemctl and /proc without failing, on every platform", async () => {
    const r = await serviceNoNewPrivs("wim-agent-test-none.service");
    expect("skip" in r).toBe(true);
    // /proc for real: this test process stands in for the unit's main process (Linux only has it).
    const self = await serviceNoNewPrivs("w.service", exec([null, String(process.pid)]));
    if (process.platform === "linux") {
      expect(self).toMatchObject({ pid: process.pid });
      expect(["0", "1"]).toContain((self as { value: string }).value);
    } else expect("skip" in self).toBe(true);
  });
});
