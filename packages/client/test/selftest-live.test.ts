// `wim test` part two (SECURITY-MODEL section 7.6): `--full` (the signer and a CI notice from the
// sandbox's test issuer), live mode against a relay-node in a process of its own on loopback (the
// mesh deleted on pass, failure and Ctrl-C, a relay without CI a skip that does not fail the run,
// URLs that are not wss refused), and `--person`, refused under an agent's variables or piped I/O.

import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { GITHUB_ISSUER, JWKS_URLS } from "@worldinmotion/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { ciStep, Sandbox, selfTest, settledWithin, testIssuer, waitFor, type Run, type Step } from "../src/selftest.ts";
import { makeMesh, RelayHarness, run as runCli, scratch, term } from "./helpers.ts";

const BIN = join(import.meta.dirname, "..", "..", "relay-node", "src", "bin.ts");

const relays: ChildProcess[] = [];
afterEach(() => {
  for (const p of relays.splice(0)) p.kill();
});

/** A relay-node in a process of its own, on a free loopback port and an in-memory database. */
async function relayProcess(env: Record<string, string> = {}): Promise<{ url: string; proc: ChildProcess }> {
  const proc = spawn(process.execPath, [BIN], { env: { PATH: process.env["PATH"] ?? "", PORT: "0", WIM_DB: ":memory:", WIM_OPEN_CREATE: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  relays.push(proc);
  let log = "";
  const url = await new Promise<string>((resolve, reject) => {
    proc.stdout!.on("data", (b: Buffer) => {
      log += b.toString();
      const m = /listening on (ws:\/\/127\.0\.0\.1:\d+)/.exec(log);
      if (m !== null) resolve(m[1]!);
    });
    proc.on("exit", (code) => reject(new Error(`the relay exited ${code}: ${log}`)));
  });
  return { url, proc };
}

/** A caller's terminal and an environment pointing at a real-looking device. */
async function caller(env: Record<string, string> = {}) {
  const { devices } = await makeMesh(new RelayHarness(), ["real-one"]);
  return { t: term(await scratch("caller"), new RelayHarness()), env: { WIM_HOME: devices[0]!.root, ...env } };
}

/**
 * Steps that create a mesh on the live relay, keep a copy of its admin's state outside the
 * sandbox (to ask the relay afterwards whether the mesh is gone), then end as `end` says.
 */
function createThen(copy: string, end: (run: Run) => Promise<void>): (run: Run) => Step[] {
  return (run) => [
    { name: "open", run: () => run.open() },
    {
      name: "create",
      run: async () => {
        run.mesh = await run.create(await run.device("test-a"), ["init", "--name", "test-a"]);
        await fs.cp(run.dev("test-a").dir, copy, { recursive: true });
        await end(run);
      },
    },
  ];
}

/** Whether the relay still holds the mesh the copied admin state is in, asked by `wim status` there. */
async function meshGone(copy: string): Promise<boolean> {
  const t = term(copy, new RelayHarness());
  // The real dialer, to the relay process.
  delete (t.io as { dialer?: unknown }).dialer;
  await runCli(t, "status");
  return t.out.join("\n").includes("the relay does not know this mesh");
}

describe("wim test --full, the sandbox", { timeout: 480_000 }, () => {
  it("runs the signer and CI notice steps too, and passes", async () => {
    const { t, env } = await caller({ CLAUDECODE: "1" });
    const code = await main(["test", "--full", "--json"], env, t.io);
    // On a failure, the rows are in the message.
    expect(code, t.out.at(-1)).toBe(0);
    const out = JSON.parse(t.out.at(-1)!) as { mode: string; full: boolean; ok: boolean; steps: Array<{ name: string; result: string }> };
    expect(out).toMatchObject({ mode: "sandbox", full: true, ok: true });
    expect(out.steps.filter((s) => s.result !== "pass")).toEqual([]);
    expect(out.steps.map((s) => s.name)).toEqual(expect.arrayContaining(["a CI notice: held, approved, its rule pinned", "the signer: encrypt, start, lock, unlock, stop"]));
  });
});

describe("wim test --relay, live mode", { timeout: 480_000 }, () => {
  it("passes on a relay that gates creation with a key, deletes its meshes, and skips the CI step without failing", async () => {
    const { url } = await relayProcess({ WIM_OPEN_CREATE: "", WIM_CREATE_KEY: "an-operator-key-for-tests", WIM_CI: "1" });
    const { t, env } = await caller({ WIM_TEST_KEY: "an-operator-key-for-tests" });
    const code = await main(["test", "--full", "--relay", url, "--key-env", "WIM_TEST_KEY"], env, t.io);
    const out = t.out.join("\n");
    expect(code, out).toBe(0);
    expect(out).toMatch(/^ {2}skip {2}a CI notice: held, approved, its rule pinned .*the test issuer exists only in the sandbox$/m);
    expect(out).toMatch(/^ {2}pass {2}mesh delete/m);
    expect(out).toMatch(/^ {2}pass {2}delete the live meshes/m);
    expect(out).toMatch(/^PASS: 17 steps, 16 passed, 0 failed, 1 skipped \(1 not offered by this relay, which does not fail the run\)/m);
    expect(out).not.toContain("an-operator-key-for-tests");
  });

  it("deletes the mesh it made when a step fails, and skips a CI step on a relay without CI", async () => {
    const { url } = await relayProcess();
    const { t, env } = await caller();
    const copy = join(await scratch("copy"), "a");
    const code = await selfTest({
      main,
      env,
      io: t.io,
      json: false,
      relay: url,
      steps: (run) => [
        ...createThen(copy, async () => undefined)(run),
        {
          name: "ci",
          run: () => ciStep(run).run(),
        },
        { name: "breaks", run: () => Promise.reject(new Error("it broke")) },
      ],
    });
    expect(code).toBe(1);
    const out = t.out.join("\n");
    expect(out).toMatch(/^ {2}skip {2}ci .*this relay takes no CI notices/m);
    expect(out).toMatch(/^ {2}pass {2}delete the live meshes/m);
    expect(await meshGone(copy)).toBe(true);
  });

  it("deletes the mesh it made at Ctrl-C", async () => {
    const { url } = await relayProcess();
    const { t, env } = await caller();
    const stop = new AbortController();
    const copy = join(await scratch("copy"), "a");
    const code = await selfTest({
      main,
      env,
      io: { ...t.io, signal: stop.signal },
      json: false,
      relay: url,
      steps: createThen(copy, async () => {
        stop.abort();
        await new Promise(() => undefined);
      }),
    });
    expect(code).toBe(1);
    expect(t.out.join("\n")).toMatch(/^ {2}fail {2}create .*stopped$/m);
    expect(t.out.join("\n")).toMatch(/^ {2}pass {2}delete the live meshes/m);
    expect(await meshGone(copy)).toBe(true);
  });

  it("deletes a mesh whose create was still in flight at Ctrl-C", async () => {
    const { url } = await relayProcess();
    const { t, env } = await caller();
    const stop = new AbortController();
    let ran: Run | undefined;
    const code = await selfTest({
      main,
      env,
      io: { ...t.io, signal: stop.signal },
      json: false,
      relay: url,
      steps: (run) => [
        { name: "open", run: async () => {
          ran = run;
          await run.open();
        } },
        {
          name: "create, stopped",
          run: async () => {
            const a = await run.device("test-a");
            // Stopped while the create is still in flight: the end of the run waits for it, and
            // deletes the mesh it made.
            void run.create(a, ["init", "--name", "test-a"]).catch(() => undefined);
            stop.abort();
            await new Promise(() => undefined);
          },
        },
      ],
    });
    expect(code).toBe(1);
    expect(t.out.join("\n")).toMatch(/^ {2}pass {2}delete the live meshes/m);
    // The create ended (exit 130 at the stop) with the mesh made, and the end of the run deleted it.
    expect(ran!.deleted.size).toBe(1);
    expect(ran!.made()).toEqual([]);
  });

  it("says when the mesh could not be deleted (the relay went away)", async () => {
    const { url, proc } = await relayProcess();
    const { t, env } = await caller();
    const copy = join(await scratch("copy"), "a");
    const code = await selfTest({
      main,
      env,
      io: t.io,
      json: false,
      relay: url,
      steps: createThen(copy, async () => {
        const gone = new Promise((r) => proc.once("exit", r));
        proc.kill();
        await gone;
      }),
    });
    expect(code).toBe(1);
    expect(t.out.join("\n")).toMatch(/^ {2}fail {2}delete the live meshes /m);
  });

  it("fails the first step when the URL is no relay, and still removes the sandbox", async () => {
    const { t, env } = await caller();
    expect(await main(["test", "--relay", "ws://127.0.0.1:1", "--json"], env, t.io)).toBe(1);
    const out = JSON.parse(t.out.at(-1)!) as { mode: string; relay: string; steps: Array<{ name: string; result: string; detail?: string }> };
    expect(out).toMatchObject({ mode: "live", relay: "ws://127.0.0.1:1" });
    expect(out.steps[0]).toMatchObject({ name: "read the live relay's /v1/info", result: "fail" });
    expect(out.steps[0]!.detail).toContain("cannot be read at ws://127.0.0.1:1");
    expect(out.steps.slice(-2).map((r) => [r.name, r.result])).toEqual([["delete the live meshes", "pass"], ["remove the sandbox", "pass"]]);
  });

  it("refuses, before making anything, a relay that is not wss off loopback, and a key variable that is wrong", async () => {
    const { t, env } = await caller({ EMPTY_KEY: "" });
    for (const argv of [
      ["--relay", "ws://relay.example"],
      ["--relay", "wss://relay.example/"],
      ["--relay", "https://relay.example"],
      ["--key-env", "EMPTY_KEY"],
      ["--relay", "wss://relay.example", "--key-env", "EMPTY_KEY"],
      ["--relay", "wss://relay.example", "--key-env", "UNSET_KEY"],
    ]) {
      expect(await main(["test", ...argv], env, t.io)).toBe(2);
    }
    expect(t.err).toEqual([
      "wim: a live relay must be a wss:// URL (plain ws:// only on loopback) with no trailing slash, not ws://relay.example",
      "wim: a live relay must be a wss:// URL (plain ws:// only on loopback) with no trailing slash, not wss://relay.example/",
      "wim: a live relay must be a wss:// URL (plain ws:// only on loopback) with no trailing slash, not https://relay.example",
      "wim: --key-env is for live mode: wim test --relay <url> --key-env NAME",
      "wim: EMPTY_KEY is not set",
      "wim: UNSET_KEY is not set",
    ]);
    expect(t.out).toEqual([]);
  });

  it("checks the live relay before every step: wss or loopback only, and never one swapped in", async () => {
    const box = await Sandbox.open(await scratch("box"), []);
    expect(() => box.attach("ws://relay.example", true)).toThrow(/a live relay must be a wss:\/\/ URL/);
    box.attach("wss://relay.example", true);
    await box.check();
    (box as unknown as { relay: string }).relay = "ws://relay.example";
    await expect(box.check()).rejects.toThrow(/not the sandbox's own/);
    await box.remove();
  });
});

describe("the end of a run", () => {
  it("waits for commands still running, but not past its limit", async () => {
    let ended = false;
    await settledWithin([new Promise((r) => setTimeout(r, 20)).then(() => (ended = true)), Promise.reject(new Error("x"))], 5000);
    expect(ended).toBe(true);
    const t0 = Date.now();
    await settledWithin([new Promise(() => undefined)], 30);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("the CI test issuer", () => {
  it("serves its key only as GitHub's JWKS", async () => {
    const iss = await testIssuer();
    expect((await iss.jwksFetch(JWKS_URLS[GITHUB_ISSUER]!)).status).toBe(200);
    const other = await iss.jwksFetch("https://gitlab.com/oauth/discovery/keys");
    expect([other.status, await other.text()]).toEqual([404, ""]);
  });
});

describe("the signer step", { timeout: 60_000 }, () => {
  it("leaves no signer running when a step fails while one runs", async () => {
    const { t, env } = await caller();
    let signer: Promise<number> | undefined;
    const code = await selfTest({
      main,
      env,
      io: t.io,
      json: false,
      steps: (run) => [
        {
          name: "start a signer, then fail",
          run: async () => {
            await run.open();
            const sig = await run.device("sig");
            await run.ok(sig, ["init", "--name", "sig"]);
            await run.ok(sig, ["signer", "encrypt"]);
            signer = (await run.background(sig, ["signer", "start", "--foreground"], /Signer running in the foreground/)).done;
            throw new Error("it broke");
          },
        },
      ],
    });
    expect(code).toBe(1);
    // The run ended it: the foreground signer returned.
    await expect(signer).resolves.toBe(0);
  });
});

describe("wim test --person", { timeout: 60_000 }, () => {
  it("is refused under an agent's variables, and with piped input or output", async () => {
    const { t, env } = await caller();
    expect(await main(["test", "--person"], { ...env, CLAUDECODE: "1" }, t.io)).toBe(2);
    expect(await main(["test", "--person"], env, { ...t.io, inputIsTTY: false })).toBe(2);
    expect(await main(["test", "--person"], env, { ...t.io, isTTY: false })).toBe(2);
    expect(t.err).toEqual([
      "wim: --person needs a person at their own interactive terminal: CLAUDECODE is set: this shell belongs to Claude Code",
      "wim: --person needs a person at their own interactive terminal: this command's input is not an interactive terminal (it is piped or redirected)",
      "wim: --person needs a person at their own interactive terminal: this command's output is not an interactive terminal (it is piped or redirected)",
    ]);
  });

  it("asks the person at this terminal, showing the device, the question and what the step expects", async () => {
    const { t, env } = await caller();
    t.answers.push("y", "123-456", "");
    const typed: string[] = [];
    await selfTest({
      main,
      env,
      io: t.io,
      json: false,
      person: true,
      steps: (run) => [
        {
          name: "prompts",
          run: async () => {
            await run.open();
            const d = run.term(await run.device("test-a"), ["y", () => "123-456"]);
            d.io.out("a line");
            d.io.err("a problem");
            for (const q of ["Trust it? ", "Code: ", "More? "]) typed.push(await d.io.prompt(q));
            expect(d.out).toEqual(["a line", "Trust it? ", "Code: ", "More? "]);
          },
        },
      ],
    });
    expect(typed).toEqual(["y", "123-456", ""]);
    expect(t.err).toEqual(["[test-a] a line", "[test-a] a problem"]);
    expect(t.out.slice(0, 3)).toEqual(["[test-a] Trust it? (the test expects: y) ", "[test-a] Code: (the test expects: 123-456) ", "[test-a] More? (the test expects: Enter) "]);
  });
});
