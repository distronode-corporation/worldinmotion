// `wim agent` at the command line: encrypt, start (foreground and detached), status, lock,
// unlock, stop and decrypt, and who may type the passphrase.

import { PassThrough } from "node:stream";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { agentEndpoint } from "../src/agentpath.ts";
import { spawnDetached, wimCommand } from "../src/agentcli.ts";
import { GUI_AGAIN, GUI_ASK, keyringAccount, NO_KEYRING, type Programs, type RunResult } from "../src/autostart.ts";
import { processIo, type Proc } from "../src/io.ts";
import { handHello, keysOf, makeMesh, newDevice, RELAY, RelayHarness, run, said, scratch, term, until, type Term } from "./helpers.ts";
import type { Channel } from "../src/channel.ts";
import type { DeviceKeys } from "@worldinmotion/protocol";
import type { CliIO } from "../src/cli.ts";

const PASS = "pass phrase";
const relay = new RelayHarness();
const running: Array<Promise<number>> = [];
const terms: Term[] = [];

afterEach(async () => {
  // Every signer a test started is stopped through the CLI, then awaited.
  for (const t of terms.splice(0)) await run(t, "agent", "stop");
  await Promise.all(running.splice(0));
});

/** A terminal on `root` with a small scrypt cost; `answers` are what stdin gives. */
function at(root: string, extra: Partial<CliIO> = {}, env: Record<string, string | undefined> = {}, ...answers: string[]): Term {
  const t = term(root, relay, { agentKdfN: 1024, ...extra }, env);
  t.answers.push(...answers);
  return t;
}

/** Starts a foreground signer on `root` and waits until it listens. */
async function foreground(root: string): Promise<Term> {
  const t = at(root, {}, {}, PASS);
  running.push(run(t, "agent", "start", "--foreground", "--passphrase-stdin"));
  terms.push(at(root));
  await until(() => said(t).includes("Signer running"), undefined, "the signer to listen");
  return t;
}

/** A stand-in for the detached child: `wim agent serve` run in this process. */
function inProcess(root: string): CliIO["startAgent"] {
  return async (passphrase) => {
    const child = at(root, {}, {}, passphrase);
    const done = run(child, "agent", "serve");
    running.push(done);
    const line = (): string | undefined => child.out.find((l) => /^(ready|error) /.test(l));
    await until(() => line() !== undefined, undefined, "the serve line");
    return line()!;
  };
}

/**
 * A process at `at` that knows the device's public key (the key file says it), answers every
 * request as a locked signer would but with nothing to prove, and records what it was sent.
 */
async function impostor(d: { home: { readKeyFile(): Promise<unknown> } }, at: string) {
  const file = (await d.home.readKeyFile()) as { sealed: { signPub: string } };
  const signPub = file.sealed.signPub;
  const lines: string[] = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    socket.on("data", (chunk: string) => {
      for (const line of chunk.split("\n").filter((l) => l !== "")) {
        lines.push(line);
        const { i } = JSON.parse(line) as { i: number };
        socket.write(`${JSON.stringify({ i, r: { id: "x", name: "imp", signPub, boxPub: signPub, locked: true, pid: 1 } })}\n`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(at, () => r()));
  return {
    lines,
    get ops(): string[] {
      return lines.map((l) => (JSON.parse(l) as { op: string }).op);
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * A process at `at` holding the device's real keys (a test can): it proves itself like the signer,
 * says it is `locked` or not, answers every request with `{}`, and keeps listening after `stop`.
 */
async function stubbornSigner(keys: DeviceKeys, locked: boolean, at: string) {
  const ops: string[] = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    let channel: Channel | undefined;
    let buf = "";
    socket.on("data", (d: string) => {
      buf += d;
      for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (channel === undefined) {
          const { i, a } = JSON.parse(line) as { i: number; a: { nonce: string; epub: string } };
          ops.push("hello");
          const made = handHello(keys, a, { locked });
          socket.write(`${JSON.stringify({ i, r: made.hello })}\n`);
          channel = made.channel;
          continue;
        }
        const req = JSON.parse(channel.open(JSON.parse(line).x)!) as { i: number; op: string };
        ops.push(req.op);
        socket.write(`${JSON.stringify({ x: channel.seal(JSON.stringify({ i: req.i, r: {} })) })}\n`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(at, () => r()));
  return { ops, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("wim agent", () => {
  it("encrypts, runs, locks, unlocks, stops and decrypts, keeping the device's identity", async () => {
    const d = await newDevice("cli");
    const t = at(d.root, {}, {}, PASS);
    expect(await run(t, "agent", "status")).toBe(3);
    expect(said(t)).toMatch(/\(plaintext\)\nsigner: not running\. Start it with `wim agent start` in a terminal you opened yourself \(not one an agent runs\), or have it start at each log in: `wim agent autostart enable`\./);
    expect(await run(t, "agent", "encrypt", "--passphrase-stdin")).toBe(0);
    expect(said(t)).toMatch(/Encrypted .*wim agent start/);
    expect(await fs.readFile(d.home.devicePath, "utf8")).not.toMatch(/signSec/);
    expect(await run(at(d.root), "doctor")).toBe(1);

    const fg = await foreground(d.root);
    const s = at(d.root);
    expect(await run(s, "agent", "status")).toBe(0);
    expect(said(s)).toMatch(/\(encrypted\); the signer is required\nsigner: running \(pid \d+\), unlocked \(verified\), device cli \(.{22}\)\nsince .*: no operations; refused 0, rate limited 0\nlog: /);
    const doc = at(d.root);
    expect(await run(doc, "doctor")).toBe(0);
    expect(said(doc)).toContain("keys held by the signer (wim agent)");

    const lock = at(d.root);
    expect(await run(lock, "agent", "lock")).toBe(0);
    expect(said(lock)).toMatch(/Signer locked/);
    const st = at(d.root);
    await run(st, "agent", "status");
    expect(said(st)).toMatch(/locked \(verified\), device cli.*\n.*lock 1/);
    // Locking again: the locked signer still proves itself, and says it is locked already.
    const relock = at(d.root);
    expect(await run(relock, "agent", "lock")).toBe(0);
    expect(said(relock)).toMatch(/locked already \(verified\)/);
    const restart = at(d.root);
    expect(await run(restart, "agent", "start")).toBe(0);
    expect(said(restart)).toMatch(/already running at .*, locked \(verified\): `wim agent unlock` restarts it/);
    // A wrong passphrase is caught here, and the locked signer is left as it was.
    const wrong = at(d.root, {}, {}, "not it");
    expect(await run(wrong, "agent", "unlock", "--passphrase-stdin")).toBe(1);
    expect(said(wrong)).toMatch(/does not open/);
    expect(said(fg)).not.toContain("Signer stopped.");
    // Unlocking restarts it: the locked one stops, a new one starts from this command.
    const right = at(d.root, {}, {}, PASS);
    running.push(run(right, "agent", "unlock", "--foreground", "--passphrase-stdin"));
    await until(() => said(right).includes("Signer running"), undefined, "the new signer");
    // The old signer's command ends on its own schedule: another process, in effect.
    await until(() => said(fg).includes("Signer stopped."), undefined, "the old signer to end");
    const again = at(d.root);
    expect(await run(again, "agent", "unlock")).toBe(0);
    expect(said(again)).toContain("The signer is not locked.");

    // Decrypting needs the signer stopped.
    expect(await run(at(d.root, {}, {}, PASS), "agent", "decrypt", "--passphrase-stdin")).toBe(1);
    const stop = at(d.root);
    expect(await run(stop, "agent", "stop")).toBe(0);
    expect(said(stop)).toContain("Signer stopped.");
    expect(await Promise.all(running.splice(0))).toEqual([0, 0]);
    terms.splice(0);

    const back = at(d.root, {}, {}, PASS);
    expect(await run(back, "agent", "decrypt", "--passphrase-stdin")).toBe(0);
    expect(said(back)).toMatch(/Decrypted/);
    expect((await d.home.loadDevice())!.id).toBe(d.device.id);
  });

  it("starts a detached signer, which reports a wrong passphrase instead of running", async () => {
    const d = await newDevice("bg");
    await run(at(d.root, {}, {}, PASS), "agent", "encrypt", "--passphrase-stdin");
    const bad = at(d.root, { startAgent: inProcess(d.root) }, {}, "wrong one");
    expect(await run(bad, "agent", "start", "--passphrase-stdin")).toBe(1);
    expect(said(bad)).toMatch(/does not open/);
    const t = at(d.root, { startAgent: inProcess(d.root) }, {}, PASS);
    expect(await run(t, "agent", "start", "--passphrase-stdin")).toBe(0);
    terms.push(at(d.root));
    expect(said(t)).toMatch(/Signer started \(pid \d+\)/);
    expect(said(t)).toContain("It keeps running after you close this terminal or VS Code; it stops at log out, restart or `wim agent stop`.");
    const again = at(d.root);
    expect(await run(again, "agent", "start")).toBe(0);
    expect(said(again)).toMatch(/already running at .* \(verified: it proved it is this device's signer\)/);
    // A second serve on the same endpoint says why it cannot run.
    const second = at(d.root, {}, {}, PASS);
    expect(await run(second, "agent", "serve")).toBe(1);
    expect(second.out.find((l) => l !== "")).toMatch(/^error a signer is already running/);
  });

  it("lock, stop and unlock fail loudly against an impostor that claims to be locked, and send it no passphrase", async () => {
    const d = await newDevice("imp");
    await run(at(d.root, {}, {}, PASS), "agent", "encrypt", "--passphrase-stdin");
    const endpoint = (await agentEndpoint(d.root, d.home.env, true))!;
    const imp = await impostor(d, endpoint);
    try {
      for (const [args, input] of [[["unlock", "--passphrase-stdin"], PASS], [["lock"], ""], [["stop"], ""]] as const) {
        const t = at(d.root, {}, {}, input);
        expect(await run(t, "agent", ...args), args[0]).toBe(1);
        expect(said(t)).toMatch(/could not prove it is this device's signer/);
        expect(said(t)).not.toMatch(/Signer (stopped|locked|unlocked)/);
      }
      // Each command asked for its hello and nothing more.
      expect(imp.ops).toEqual(["hello", "hello", "hello"]);
      expect(imp.lines.join("\n")).not.toContain(PASS);
    } finally {
      await imp.close();
    }
  });

  it("stop and unlock report something that still answers after a stop it acknowledged", async () => {
    const d = await newDevice("stays");
    await run(at(d.root, {}, {}, PASS), "agent", "encrypt", "--passphrase-stdin");
    const endpoint = (await agentEndpoint(d.root, d.home.env, true))!;
    for (const locked of [false, true]) {
      const stays = await stubbornSigner(keysOf(d.device), locked, endpoint);
      try {
        const t = at(d.root, {}, {}, PASS);
        expect(await run(t, "agent", ...(locked ? ["unlock", "--passphrase-stdin"] : ["stop"]))).toBe(1);
        expect(said(t)).toMatch(/still answers after it was asked to stop/);
        expect(stays.ops).toEqual(["hello", "stop"]);
      } finally {
        await stays.close();
      }
    }
  });

  it("a brief swap of the socket cannot fake a stop or a lock (independent re-review, N1)", async () => {
    const d = await newDevice("swap");
    await run(at(d.root, {}, {}, PASS), "agent", "encrypt", "--passphrase-stdin");
    await foreground(d.root);
    const endpoint = (await agentEndpoint(d.root, d.home.env, false))!;
    // The attack: the real socket moved aside (on Windows, the pipe token pointed elsewhere), an
    // impostor that answers `hello` as locked and `stop` in its place, the CLI run, then the swap undone.
    const tokenPath = join(d.root, "agent", "pipe");
    const saved = process.platform === "win32" ? await fs.readFile(tokenPath, "utf8") : "";
    const aside = `${endpoint}.real`;
    const target = process.platform === "win32" ? (await agentEndpoint(d.root, d.home.env, true))! : endpoint;
    if (process.platform !== "win32") await fs.rename(endpoint, aside);
    const imp = await impostor(d, target);
    try {
      const stop = at(d.root);
      expect(await run(stop, "agent", "stop")).toBe(1);
      expect(said(stop)).not.toContain("Signer stopped.");
      const lock = at(d.root);
      expect(await run(lock, "agent", "lock")).toBe(1);
      expect(said(lock)).not.toMatch(/locked already|Signer locked/);
      expect(imp.ops).toEqual(["hello", "hello"]);
    } finally {
      await imp.close();
      if (process.platform === "win32") await fs.writeFile(tokenPath, saved);
      else await fs.rename(aside, endpoint).catch(() => undefined);
    }
  });

  it("start takes the place of something that answers at the endpoint but cannot prove it is this device's signer (re-review, N3)", async () => {
    const d = await newDevice("fake");
    await run(at(d.root, {}, {}, PASS), "agent", "encrypt", "--passphrase-stdin");
    const endpoint = (await agentEndpoint(d.root, d.home.env, true))!;
    const imp = await impostor(d, endpoint);
    try {
      const t = at(d.root, {}, {}, PASS);
      running.push(run(t, "agent", "start", "--foreground", "--passphrase-stdin"));
      terms.push(at(d.root));
      await until(() => said(t).includes("Signer running"), undefined, "the signer to start past the impostor");
      expect(said(t)).toMatch(/cannot prove it is this device's signer; starting a signer in its place/);
      const st = at(d.root);
      expect(await run(st, "agent", "status")).toBe(0);
      expect(said(st)).toMatch(/unlocked \(verified\)/);
    } finally {
      await imp.close();
    }
  });

  it("two signers starting at once: one binds, the other says one is running", async () => {
    const d = await newDevice("race");
    await run(at(d.root, {}, {}, PASS), "agent", "encrypt", "--passphrase-stdin");
    const one = at(d.root, {}, {}, PASS);
    const two = at(d.root, {}, {}, PASS);
    const runs = [run(one, "agent", "serve"), run(two, "agent", "serve")];
    running.push(...runs);
    terms.push(at(d.root));
    const line = (t: Term): string | undefined => t.out.find((l) => /^(ready|error) /.test(l));
    await until(() => line(one) !== undefined && line(two) !== undefined, undefined, "both to say how it went");
    expect([line(one), line(two)].filter((l) => l!.startsWith("ready "))).toHaveLength(1);
    expect([line(one), line(two)].filter((l) => l!.startsWith("error a signer is already running"))).toHaveLength(1);
    // The one that bound is reachable and answers as this device's signer.
    const st = at(d.root);
    expect(await run(st, "agent", "status")).toBe(0);
    expect(said(st)).toMatch(/unlocked \(verified\)/);
  });

  it("starts only on an encrypted key file, and only in the background where it can", async () => {
    const empty = at(await scratch("none"));
    expect(await run(empty, "agent", "start")).toBe(1);
    expect(said(empty)).toMatch(/run `wim init` first/);
    const d = await newDevice("plain");
    const plain = at(d.root);
    expect(await run(plain, "agent", "start")).toBe(1);
    expect(said(plain)).toMatch(/not encrypted: run `wim agent encrypt` first/);
    await run(at(d.root, {}, {}, PASS), "agent", "encrypt", "--passphrase-stdin");
    const noSpawn = at(d.root, {}, {}, PASS);
    expect(await run(noSpawn, "agent", "start", "--passphrase-stdin")).toBe(1);
    expect(said(noSpawn)).toMatch(/use --foreground/);
    const wrong = at(d.root, {}, {}, "wrong one");
    expect(await run(wrong, "agent", "start", "--foreground", "--passphrase-stdin")).toBe(1);
    expect(said(wrong)).toMatch(/does not open/);
  });

  it("asks for the passphrase only at an interactive terminal not driven by an agent", async () => {
    const d = await newDevice("ask");
    const asked: string[] = [];
    const secret = (answers: string[]): CliIO["promptSecret"] => async (q) => {
      asked.push(q);
      return answers.shift() ?? "";
    };
    const mismatch = at(d.root, { promptSecret: secret(["first passphrase", "second passphrase"]) });
    expect(await run(mismatch, "agent", "encrypt")).toBe(1);
    expect(said(mismatch)).toMatch(/differ; nothing was changed/);
    expect(asked).toEqual(["New passphrase for this device's keys: ", "Again: "]);
    const short = at(d.root, { promptSecret: secret(["short"]) });
    expect(await run(short, "agent", "encrypt")).toBe(1);
    expect(said(short)).toMatch(/at least 8 characters/);
    const none = at(d.root, { promptSecret: secret([""]) });
    expect(await run(none, "agent", "encrypt")).toBe(1);
    expect(said(none)).toMatch(/no passphrase given/);
    for (const [extra, env] of [
      [{ promptSecret: secret([PASS]) }, { CLAUDECODE: "1" }],
      [{ promptSecret: secret([PASS]), isTTY: false }, {}],
      [{}, {}],
    ] as Array<[Partial<CliIO>, Record<string, string>]>) {
      const t = at(d.root, extra, env);
      expect(await run(t, "agent", "encrypt")).toBe(1);
      expect(said(t)).toMatch(/only in your own interactive terminal/);
    }
    const ok = at(d.root, { promptSecret: secret([PASS, PASS]) });
    expect(await run(ok, "agent", "encrypt")).toBe(0);
    const twice = at(d.root, { promptSecret: secret([PASS, PASS]) });
    expect(await run(twice, "agent", "encrypt")).toBe(1);
    expect(said(twice)).toMatch(/already encrypted/);
  });

  it("lock, stop, unlock and status when no signer runs; usage", async () => {
    const d = await newDevice("idle");
    const lock = at(d.root);
    expect(await run(lock, "agent", "lock")).toBe(3);
    expect(said(lock)).toContain("No signer is running.");
    expect(await run(at(d.root), "agent", "stop")).toBe(0);
    const unlock = at(d.root, {}, {}, PASS);
    expect(await run(unlock, "agent", "unlock", "--passphrase-stdin")).toBe(1);
    expect(said(unlock)).toMatch(/no signer is running/);
    const empty = at(await scratch("none"));
    expect(await run(empty, "agent", "status")).toBe(3);
    expect(said(empty)).toMatch(/\(no key file\)/);
    const usage = at(d.root);
    expect(await run(usage, "agent")).toBe(1);
    expect(said(usage)).toMatch(/usage: wim agent start/);
    const help = at(d.root);
    expect(await run(help, "help", "agent")).toBe(0);
    expect(said(help)).toMatch(/wim agent start \[--foreground\] \[--passphrase-stdin \| --ask-gui \| --keyring\] \[--allow-agent-passphrase\]\nwim agent status/);
    expect(said(help)).toMatch(/\nwim agent autostart enable \[--keyring\] \| wim agent autostart disable \| wim agent autostart status$/);
    const flag = at(d.root);
    expect(await run(flag, "agent", "start", "--forground")).toBe(2);
    expect(said(flag)).toMatch(/did you mean --foreground/);
    const decryptPlain = at(d.root, {}, {}, PASS);
    expect(await run(decryptPlain, "agent", "decrypt", "--passphrase-stdin")).toBe(1);
    expect(said(decryptPlain)).toMatch(/not encrypted/);
  });

  it("encrypts at the full scrypt cost by default; Ctrl-C stops a foreground signer", async () => {
    const d = await newDevice("full");
    const t = term(d.root, relay);
    t.answers.push(PASS);
    expect(await run(t, "agent", "encrypt", "--passphrase-stdin")).toBe(0);
    expect(JSON.parse(await fs.readFile(d.home.devicePath, "utf8"))).toMatchObject({ kdf: { N: 2 ** 17 } });
    const fg = term(d.root, relay);
    fg.answers.push(PASS);
    const done = run(fg, "agent", "start", "--foreground", "--passphrase-stdin");
    await until(() => said(fg).includes("Signer running"), 10_000, "the signer to listen");
    // With the key file gone, status still reaches the signer (it cannot check whose keys it holds).
    await fs.rename(d.home.devicePath, `${d.home.devicePath}.away`);
    const st = at(d.root);
    expect(await run(st, "agent", "status")).toBe(0);
    expect(said(st)).toMatch(/\(no key file\); the signer is required\nsigner: running/);
    await fs.rename(`${d.home.devicePath}.away`, d.home.devicePath);
    fg.stop.abort();
    expect(await done).toBe(0);
    expect(said(fg)).toContain("Signer stopped.");
  });

  it("a foreground signer told to stop while it was starting stops once it has started", async () => {
    const d = await newDevice("early");
    await run(at(d.root, {}, {}, PASS), "agent", "encrypt", "--passphrase-stdin");
    const t = at(d.root, {}, {}, PASS);
    // Ctrl-C before the signer has bound: the abort event is long gone when it gets there.
    t.stop.abort();
    expect(await run(t, "agent", "start", "--foreground", "--passphrase-stdin")).toBe(0);
    expect(said(t)).toMatch(/Signer running[\s\S]*Signer stopped\./);
    const st = at(d.root);
    expect(await run(st, "agent", "status")).toBe(3);
  });

  it("WIM_REQUIRE_SIGNER refuses a plaintext key file", async () => {
    const d = await newDevice("req");
    const t = at(d.root, {}, { WIM_REQUIRE_SIGNER: "1" });
    expect(await run(t, "doctor")).toBe(1);
    expect(said(t)).toMatch(/requires the signer/);
  });
});

describe("spawnDetached", () => {
  const script = (body: string): string[] => [process.execPath, "-e", body];

  it("hands the child the passphrase and returns its first line, even in pieces", async () => {
    const line = await spawnDetached(
      script(`let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write("ready ");setTimeout(()=>process.stdout.write(s.trim().length+"\\nmore\\n"),50)})`),
      "secret",
    );
    expect(line).toBe("ready 6");
  });

  it("reads the line a child writes just before it exits", async () => {
    // A signer that cannot start writes `error <why>` and exits at once: the line is not lost.
    expect(await spawnDetached(script(`process.stdout.write("error the passphrase does not open this key file\\n",()=>process.exit(1))`), "x")).toBe("error the passphrase does not open this key file");
  });

  it("fails when the child exits first or cannot start", async () => {
    await expect(spawnDetached(script("process.exit(4)"), "x")).rejects.toThrow(/exited before it was ready \(code 4\)/);
    await expect(spawnDetached(["wim-no-such-program-here"], "x")).rejects.toThrow(/ENOENT/);
  });

  it("wimCommand is this Node running this program", () => {
    expect(wimCommand()[0]).toBe(process.execPath);
  });
});

/** The real prompts of processIo over a stdin that is already closed (`< /dev/null`, an empty pipe). */
function closedStdin(): Pick<CliIO, "prompt" | "promptSecret"> {
  const stdin = new PassThrough();
  stdin.end();
  const proc: Proc = { stdin, stdout: new PassThrough(), stderr: new PassThrough(), platform: process.platform, pid: 1, ppid: process.pid, cwd: () => "/", once: () => undefined, on: () => undefined };
  const io = processIo(proc, { homedir: () => "/h", hostname: () => "h", kill: () => undefined, wim: () => [] });
  return { prompt: io.prompt, promptSecret: io.promptSecret! };
}

/** The real prompts of processIo over a stdin that holds `text` and then ends. */
function stdinWith(text: string): Pick<CliIO, "prompt" | "promptSecret"> {
  const stdin = new PassThrough();
  stdin.end(text);
  const proc: Proc = { stdin, stdout: new PassThrough(), stderr: new PassThrough(), platform: process.platform, pid: 1, ppid: process.pid, cwd: () => "/", once: () => undefined, on: () => undefined };
  const io = processIo(proc, { homedir: () => "/h", hostname: () => "h", kill: () => undefined, wim: () => [] });
  return { prompt: io.prompt, promptSecret: io.promptSecret! };
}

describe("prompts on a stdin that closes before a line", () => {
  it("take a last line that has no newline (printf 'pass' | wim ...)", async () => {
    expect(await stdinWith("correct horse").prompt("")).toBe("correct horse");
    expect(await stdinWith("correct horse").promptSecret!("Passphrase: ")).toBe("correct horse");
    const d = await newDevice("nonl");
    const t = at(d.root, stdinWith("correct horse battery"));
    expect(await run(t, "agent", "encrypt", "--passphrase-stdin")).toBe(0);
    expect(await fs.readFile(d.home.devicePath, "utf8")).not.toMatch(/signSec/);
  });

  it("give an empty answer instead of never settling", async () => {
    const io = closedStdin();
    expect(await io.prompt("Question? ")).toBe("");
    expect(await io.promptSecret!("Passphrase: ")).toBe("");
  });

  it("a passphrase read so is none given (exit 1), and a confirmation read so is a no", async () => {
    const d = await newDevice("eof");
    const t = at(d.root, closedStdin());
    expect(await run(t, "agent", "encrypt", "--passphrase-stdin")).toBe(1);
    expect(said(t)).toMatch(/no passphrase given/);
    expect(await fs.readFile(d.home.devicePath, "utf8")).toMatch(/signSec/);
    const relay = new RelayHarness();
    const { recoveryCode } = await makeMesh(relay, ["lost"]);
    const r = term(await scratch("eof-recover"), relay, closedStdin());
    expect(await run(r, "recover", recoveryCode!, "--relay", RELAY, "--revoke", "lost")).toBe(1);
    expect(said(r)).toMatch(/recovery cancelled; nothing was signed/);
  });
});

describe("processIo for wim agent", () => {
  it("asks for a secret without echoing it, and starts the signer through wim's own command", async () => {
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    let err = "";
    stderr.on("data", (d: Buffer) => (err += d.toString()));
    const proc: Proc = { stdin, stdout: new PassThrough(), stderr, platform: process.platform, pid: 1, ppid: process.pid, cwd: () => "/", once: () => undefined, on: () => undefined };
    let asked: string[] = [];
    const io = processIo(proc, {
      homedir: () => "/h",
      hostname: () => "h",
      kill: () => undefined,
      wim: () => {
        asked = [process.execPath, "-e", `process.stdout.write("ready "+process.argv.slice(1).join(" ")+"\\n")`];
        return asked;
      },
    });
    const answer = io.promptSecret!("Passphrase: ");
    stdin.write("hunter2 hunter2\n");
    expect(await answer).toBe("hunter2 hunter2");
    expect(err).toBe("Passphrase: \n");
    expect(await io.startAgent!("x")).toBe("ready agent serve");
    expect(asked[0]).toBe(process.execPath);
  });
});

/** Programs for `platform` that answer each call with `answer` and record it. */
function fakePrograms(platform: string, answer: (cmd: string, args: readonly string[], input: string | undefined) => RunResult): { programs: Programs; calls: Array<{ cmd: string; args: readonly string[]; input: string | undefined }> } {
  const calls: Array<{ cmd: string; args: readonly string[]; input: string | undefined }> = [];
  return {
    calls,
    programs: {
      platform,
      wim: ["/usr/bin/node", "/opt/wim.mjs"],
      run: async (cmd, args, input) => {
        calls.push({ cmd, args, input });
        return answer(cmd, args, input);
      },
    },
  };
}

const hexOf = (s: string): string => Buffer.from(s, "utf8").toString("hex");
const typed = (...answers: string[]): CliIO["promptSecret"] => async () => answers.shift() ?? "";

/** An encrypted device under `name`. */
async function encrypted(name: string) {
  const d = await newDevice(name);
  expect(await run(at(d.root, {}, {}, PASS), "agent", "encrypt", "--passphrase-stdin")).toBe(0);
  return d;
}

describe("where the passphrase comes from", () => {
  it("refuses stdin, the dialog and the keyring under an agent, naming the opt-in", async () => {
    const d = await encrypted("agentpass");
    const { programs } = fakePrograms("linux", () => ({ code: 0, stdout: `${PASS}\n`, stderr: "" }));
    for (const source of ["--passphrase-stdin", "--ask-gui", "--keyring"]) {
      const t = at(d.root, { programs }, { CLAUDECODE: "1" }, PASS);
      expect(await run(t, "agent", "start", "--foreground", source)).toBe(1);
      expect(said(t)).toMatch(new RegExp(`CLAUDECODE is set, so an agent is running this command, and ${source} is refused there.*add --allow-agent-passphrase \\(SECURITY-MODEL 5\\.8\\)`));
    }
    const codex = at((await newDevice("codex")).root, {}, { CODEX_SANDBOX: "seatbelt" }, PASS);
    expect(await run(codex, "agent", "encrypt", "--passphrase-stdin")).toBe(1);
    expect(said(codex)).toMatch(/CODEX_SANDBOX is set/);
  });

  it("takes stdin under an agent with --allow-agent-passphrase, and warns once", async () => {
    const d = await encrypted("optin");
    const t = at(d.root, {}, { CLAUDECODE: "1" }, PASS);
    running.push(run(t, "agent", "start", "--foreground", "--passphrase-stdin", "--allow-agent-passphrase"));
    terms.push(at(d.root));
    await until(() => said(t).includes("Signer running"), undefined, "the signer to listen");
    expect(t.err).toEqual([expect.stringMatching(/^wim: warning: --allow-agent-passphrase: CLAUDECODE is set, so an agent runs this command; .*defeats the signer's protection against agents \(SECURITY-MODEL 5\.8\)$/)]);
    // Without an agent's variables the opt-in changes nothing and says nothing.
    const plain = at(d.root, {}, {}, PASS);
    expect(await run(plain, "agent", "start", "--passphrase-stdin", "--allow-agent-passphrase")).toBe(0);
    expect(plain.err).toEqual([]);
  });

  it("takes one source at a time, each only for the commands it is for", async () => {
    const d = await encrypted("which");
    const two = at(d.root, {}, {}, PASS);
    expect(await run(two, "agent", "start", "--passphrase-stdin", "--ask-gui")).toBe(1);
    expect(said(two)).toContain("use one of --passphrase-stdin, --ask-gui, not several");
    for (const [args, why] of [
      [["encrypt", "--ask-gui"], "--ask-gui is for wim agent start, unlock"],
      [["status", "--keyring"], "--keyring is for wim agent start, unlock, autostart"],
      [["lock", "--passphrase-stdin"], "--passphrase-stdin is for wim agent start, unlock, encrypt, decrypt"],
      [["--keyring"], "--keyring is for wim agent start, unlock, autostart"],
    ] as Array<[string[], string]>) {
      const t = at(d.root);
      expect(await run(t, "agent", ...args)).toBe(1);
      expect(said(t)).toContain(why);
    }
    const none = at(d.root);
    expect(await run(none, "agent", "start", "--ask-gui")).toBe(1);
    expect(said(none)).toContain("this program cannot run a passphrase dialog, a keyring or a login item");
  });

  it("--ask-gui asks in a dialog, again while what was typed does not open the keys", async () => {
    const d = await encrypted("gui");
    const typedIn = ["not it", "still not", PASS];
    const asked = fakePrograms("linux", () => ({ code: 0, stdout: `${typedIn.shift()}\n`, stderr: "" }));
    const t = at(d.root, { programs: asked.programs });
    running.push(run(t, "agent", "start", "--foreground", "--ask-gui"));
    terms.push(at(d.root));
    await until(() => said(t).includes("Signer running"), undefined, "the signer to listen");
    expect(asked.calls.map((c) => c.args.at(-1))).toEqual([`--text=${GUI_ASK}`, `--text=${GUI_AGAIN}`, `--text=${GUI_AGAIN}`]);
    await run(at(d.root), "agent", "stop");
    await Promise.all(running.splice(0));
    terms.splice(0);

    const never = fakePrograms("darwin", () => ({ code: 0, stdout: "wrong\n", stderr: "" }));
    const no = at(d.root, { programs: never.programs });
    expect(await run(no, "agent", "start", "--foreground", "--ask-gui")).toBe(1);
    expect(said(no)).toContain("the passphrase did not open this device's keys in 3 tries");
    expect(never.calls.map((c) => c.cmd)).toEqual(["osascript", "osascript", "osascript"]);
    const cancel = at(d.root, { programs: fakePrograms("win32", () => ({ code: 1, stdout: "", stderr: "" })).programs });
    expect(await run(cancel, "agent", "start", "--ask-gui")).toBe(1);
    expect(said(cancel)).toContain("the passphrase prompt was cancelled");
  });

  it("unlock --ask-gui asks once and restarts the locked signer", async () => {
    const d = await encrypted("guiunlock");
    const fg = await foreground(d.root);
    expect(await run(at(d.root), "agent", "lock")).toBe(0);
    const asked = fakePrograms("linux", () => ({ code: 0, stdout: `${PASS}\n`, stderr: "" }));
    const u = at(d.root, { programs: asked.programs });
    running.push(run(u, "agent", "unlock", "--foreground", "--ask-gui"));
    await until(() => said(u).includes("Signer running"), undefined, "the new signer");
    await until(() => said(fg).includes("Signer stopped."), undefined, "the old signer to end");
    expect(asked.calls).toHaveLength(1);
  });

  it("--keyring reads the stored passphrase; Windows has no keyring here", async () => {
    const d = await encrypted("keyread");
    const win = at(d.root, { programs: fakePrograms("win32", () => ({ code: 0, stdout: "", stderr: "" })).programs });
    expect(await run(win, "agent", "start", "--keyring")).toBe(1);
    expect(said(win)).toContain(NO_KEYRING);
    const ring = fakePrograms("linux", () => ({ code: 0, stdout: hexOf(PASS), stderr: "" }));
    const t = at(d.root, { programs: ring.programs });
    running.push(run(t, "agent", "start", "--foreground", "--keyring"));
    terms.push(at(d.root));
    await until(() => said(t).includes("Signer running"), undefined, "the signer to listen");
    expect(ring.calls).toEqual([{ cmd: "secret-tool", args: ["lookup", "service", "worldinmotion-signer", "account", keyringAccount(d.root)], input: undefined }]);
  });
});

describe("wim agent autostart", () => {
  it("installs a login item that asks in a dialog, reports it and removes it", async () => {
    const plain = await newDevice("asplain");
    const p0 = fakePrograms("linux", () => ({ code: 0, stdout: "", stderr: "" }));
    const refused = at(plain.root, { programs: p0.programs });
    expect(await run(refused, "agent", "autostart", "enable")).toBe(1);
    expect(said(refused)).toMatch(/is not encrypted: run `wim agent encrypt` first/);

    const d = await encrypted("asgui");
    const { programs, calls } = fakePrograms("linux", () => ({ code: 0, stdout: "", stderr: "" }));
    const off = at(d.root, { programs });
    expect(await run(off, "agent", "autostart", "status")).toBe(3);
    expect(said(off)).toContain("autostart: off. `wim agent autostart enable` starts the signer at each log in.");
    const on = at(d.root, { programs });
    expect(await run(on, "agent", "autostart", "enable")).toBe(0);
    const where = join(d.root, ".config", "autostart", `worldinmotion-signer-${keyringAccount(d.root)}.desktop`).replace(/\\/g, "/");
    const shown = on.out.find((l) => l.startsWith("Installed a login item: "))!.slice("Installed a login item: ".length);
    expect(shown.replace(/\\/g, "/")).toBe(where);
    expect(await fs.readFile(shown, "utf8")).toContain("agent start --foreground --ask-gui");
    expect(said(on)).toContain("asks for the passphrase in a dialog of its own");
    // Enabling the dialog removes a passphrase an earlier --keyring stored.
    expect(calls.map((c) => [c.cmd, ...c.args])).toEqual([["secret-tool", "clear", "service", "worldinmotion-signer", "account", keyringAccount(d.root)]]);
    expect(said(on)).toContain("It does not start a signer now");
    const st = at(d.root, { programs });
    expect(await run(st, "agent", "autostart", "status")).toBe(0);
    expect(said(st)).toContain(`autostart: on (it asks for the passphrase in a dialog): ${shown}`);
    const rm = at(d.root, { programs });
    expect(await run(rm, "agent", "autostart", "disable")).toBe(0);
    expect(said(rm)).toContain("Removed the login item");
    expect(calls.map((c) => c.args[0])).toEqual(["clear", "clear"]);
    const again = at(d.root, { programs });
    expect(await run(again, "agent", "autostart", "disable")).toBe(0);
    expect(said(again)).toContain("No login item starts the signer here.");
    const usage = at(d.root, { programs });
    expect(await run(usage, "agent", "autostart")).toBe(1);
    expect(said(usage)).toContain("usage: wim agent autostart enable [--keyring]");
    const none = at(d.root);
    expect(await run(none, "agent", "autostart", "status")).toBe(1);
    expect(said(none)).toContain("this program cannot run");
  });

  it("--keyring on Linux warns, needs a typed yes and the right passphrase, then stores it", async () => {
    const d = await encrypted("asring");
    const { programs, calls } = fakePrograms("linux", () => ({ code: 0, stdout: "", stderr: "" }));
    const no = at(d.root, { programs, promptSecret: typed(PASS) }, {}, "no");
    expect(await run(no, "agent", "autostart", "enable", "--keyring")).toBe(1);
    expect(said(no)).toMatch(/WARNING: your keyring \(libsecret\) gives this passphrase to any program you run/);
    expect(said(no)).toContain("nothing was stored or installed");
    const wrong = at(d.root, { programs, promptSecret: typed("not it") }, {}, "yes");
    expect(await run(wrong, "agent", "autostart", "enable", "--keyring")).toBe(1);
    expect(said(wrong)).toContain("that passphrase does not open this device's keys; nothing was stored or installed");
    expect(calls).toEqual([]);
    const yes = at(d.root, { programs, promptSecret: typed(PASS) }, {}, " yes ");
    expect(await run(yes, "agent", "autostart", "enable", "--keyring")).toBe(0);
    expect(calls).toEqual([{ cmd: "secret-tool", args: ["store", "--label=worldinmotion-signer", "service", "worldinmotion-signer", "account", keyringAccount(d.root)], input: hexOf(PASS) }]);
    expect(said(yes)).toContain("Stored the passphrase in the keyring.");
    expect(said(yes)).toContain("At each log in it starts the signer with the passphrase from the keyring.");
    const st = at(d.root, { programs });
    expect(await run(st, "agent", "autostart", "status")).toBe(0);
    expect(said(st)).toContain("autostart: on (the passphrase comes from the keyring)");
    // Back to the dialog: the stored passphrase goes, and the item asks again.
    const back = at(d.root, { programs });
    expect(await run(back, "agent", "autostart", "enable")).toBe(0);
    expect(calls.at(-1)).toEqual({ cmd: "secret-tool", args: ["clear", "service", "worldinmotion-signer", "account", keyringAccount(d.root)], input: undefined });
    const now = at(d.root, { programs });
    expect(await run(now, "agent", "autostart", "status")).toBe(0);
    expect(said(now)).toContain("autostart: on (it asks for the passphrase in a dialog)");
  });

  it("--keyring is set up only at the person's own terminal; macOS needs no yes; Windows has none", async () => {
    const d = await encrypted("asmac");
    const mac = fakePrograms("darwin", () => ({ code: 0, stdout: "", stderr: "" }));
    for (const [extra, env] of [
      [{ promptSecret: typed(PASS) }, { CLAUDECODE: "1" }],
      [{ promptSecret: typed(PASS), isTTY: false }, {}],
      [{}, {}],
    ] as Array<[Partial<CliIO>, Record<string, string>]>) {
      const t = at(d.root, { programs: mac.programs, ...extra }, env);
      expect(await run(t, "agent", "autostart", "enable", "--keyring")).toBe(1);
      expect(said(t)).toContain("the passphrase goes into the keyring only from your own interactive terminal");
    }
    const ok = at(d.root, { programs: mac.programs, promptSecret: typed(PASS) });
    expect(await run(ok, "agent", "autostart", "enable", "--keyring")).toBe(0);
    expect(said(ok)).toContain("Never choose Always Allow");
    expect(ok.out).not.toContain("Type yes to store it anyway: ");
    expect(mac.calls.map((c) => c.args[0])).toEqual(["delete-generic-password", "-i", "find-generic-password"]);
    const shown = ok.out.find((l) => l.startsWith("Installed a login item: "))!.slice("Installed a login item: ".length);
    expect(shown.replace(/\\/g, "/")).toMatch(/\/Library\/LaunchAgents\/worldinmotion\.signer\.[0-9a-f]{16}\.plist$/);
    expect(await fs.readFile(shown, "utf8")).toContain("<string>--keyring</string>");
    const win = at(d.root, { programs: fakePrograms("win32", () => ({ code: 0, stdout: "", stderr: "" })).programs, promptSecret: typed(PASS) });
    expect(await run(win, "agent", "autostart", "enable", "--keyring")).toBe(1);
    expect(said(win)).toContain(NO_KEYRING);
  });
});
