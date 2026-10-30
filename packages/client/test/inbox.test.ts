// `wim inbox` marks read only what it printed: a closed pipe (`wim inbox | head`) leaves the rest
// unread, and `--peek` marks nothing. `print` in processIo reports a reader that went away.

import { spawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { processIo, written, type Proc } from "../src/io.ts";
import { makeMesh, openSession, RelayHarness, run, said, term, until } from "./helpers.ts";

const open: Array<{ stop(): Promise<unknown> }> = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

/** A device whose terminal inbox (cli@one) holds `texts`, unread, and a terminal on it. */
async function inboxWith(texts: string[]) {
  const relay = new RelayHarness();
  const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
  const t = term(devices[0]!.root, relay);
  // The first run registers cli@one with the relay, so sends to it queue.
  expect(await run(t, "inbox")).toBe(0);
  expect(said(t)).toContain("Nothing new for cli@one.");
  const peer = await openSession(devices[1]!, mesh, relay, { name: "peer" });
  open.push(peer);
  await peer.ready(3000);
  for (const text of texts) expect((await peer.send("cli@one", text)).results[0]!.status).toBe("queued");
  return { relay, root: devices[0]!.root, t };
}

/** What one `wim inbox` run printed, item by item, with a stdout that takes `takes` items and then closes. */
async function inboxRun(root: string, relay: RelayHarness, takes = Infinity, ...flags: string[]) {
  const printed: string[] = [];
  const t = term(root, relay, {
    print: async (line) => {
      if (printed.length >= takes) return false;
      printed.push(line);
      return true;
    },
  });
  expect(await run(t, "inbox", ...flags)).toBe(0);
  return { printed, t };
}

describe("wim inbox", () => {
  it("--peek prints everything and marks nothing; a plain run then prints and marks it", async () => {
    const { relay, root } = await inboxWith(["alpha", "beta"]);
    for (let i = 0; i < 2; i++) {
      const { printed } = await inboxRun(root, relay, Infinity, "--peek");
      expect(printed).toHaveLength(2);
      expect(printed[0]).toContain("alpha");
      expect(printed[1]).toContain("beta");
    }
    expect((await inboxRun(root, relay)).printed).toHaveLength(2);
    const after = await inboxRun(root, relay);
    expect(after.printed).toHaveLength(0);
    expect(said(after.t)).toContain("Nothing new for cli@one.");
  }, 30_000);

  it("marks read only what a closed pipe took, says how many stay unread, and the next run prints those", async () => {
    const { relay, root } = await inboxWith(["first", "second", "third"]);
    const cut = await inboxRun(root, relay, 1);
    expect(cut.printed).toHaveLength(1);
    expect(cut.printed[0]).toContain("first");
    expect(cut.t.err).toContain("wim: the output closed after 1 of 3 items; the other 2 stay unread.");

    // A reader that went away before the first item: nothing is marked.
    const none = await inboxRun(root, relay, 0);
    expect(none.t.err).toContain("wim: the output closed after 0 of 2 items; the other 2 stay unread.");

    const rest = await inboxRun(root, relay);
    expect(rest.printed).toHaveLength(2);
    expect(rest.printed[0]).toContain("second");
    expect(rest.printed[1]).toContain("third");
    expect(rest.t.err).toHaveLength(0);
    expect((await inboxRun(root, relay)).printed).toHaveLength(0);
  }, 30_000);

  it("without a print of its own, prints through out and marks everything read", async () => {
    const { relay, root, t } = await inboxWith(["only"]);
    t.out.length = 0;
    expect(await run(t, "inbox")).toBe(0);
    expect(said(t)).toContain("only");
    expect((await inboxRun(root, relay)).printed).toHaveLength(0);
  }, 30_000);

  it("--as the name of a live Claude Code session refuses, and registers no <name>-2 (issue #38)", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const tab = await openSession(devices[0]!, mesh, relay, { name: "distronode-2", kind: "claude-code" });
    open.push(tab);
    const watcher = await openSession(devices[1]!, mesh, relay, { name: "watcher" });
    open.push(watcher);
    const t = term(devices[0]!.root, relay);
    expect(await run(t, "inbox", "--as", "distronode-2")).toBe(1);
    expect(t.err.at(-1)).toBe(
      "wim: distronode-2@one is a claude-code session on this device (idle): its messages go to that session, not to a terminal. `wim history --session distronode-2` shows what it received; for a terminal session of your own, pick another name with --as <name>.",
    );
    expect(said(t)).not.toContain("Nothing new");
    // The throwaway registration ended at once: no distronode-2-2 lingers in peers.
    await until(async () => !(await watcher.listPeers()).some((p) => p.address.startsWith("distronode-2-")));
    // The same name for a terminal session of its own works as before once it is free.
    await tab.stop({ ended: true });
    open.splice(open.indexOf(tab), 1);
    const again = term(devices[0]!.root, relay);
    expect(await run(again, "inbox", "--as", "distronode-2")).toBe(0);
    expect(said(again)).toContain("Nothing new for distronode-2@one.");
  }, 30_000);

  it("lists --peek in its usage", async () => {
    const t = term("/nonexistent", new RelayHarness());
    expect(await run(t, "help", "inbox")).toBe(0);
    expect(t.out.at(-1)).toBe("wim inbox [--peek] [--as <name>]");
  });
});

/** A process stand-in whose stdout is `stdout`. */
function procWith(stdout: Writable): Proc {
  return {
    stdin: new PassThrough(),
    stdout,
    stderr: new PassThrough(),
    platform: "linux",
    pid: 7,
    ppid: 50,
    cwd: () => "/",
    once: () => undefined,
    on: () => undefined,
  } as unknown as Proc;
}

const machine = { homedir: () => "/h", hostname: () => "h", kill: () => undefined, wim: () => [] };

describe("print", () => {
  it("resolves true once stdout took the line", async () => {
    const out = new PassThrough();
    const io = processIo(procWith(out), machine);
    expect(await io.print!("one")).toBe(true);
    expect(await io.print!("two")).toBe(true);
    expect(out.read()?.toString()).toBe("one\ntwo\n");
  });

  it("resolves false for a write that fails (EPIPE), without an error thrown at the process", async () => {
    let writes = 0;
    const out = new Writable({
      write: (_chunk, _enc, done) => {
        writes++;
        done(writes === 1 ? null : Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      },
    });
    const io = processIo(procWith(out), machine);
    expect(await io.print!("taken")).toBe(true);
    expect(await io.print!("refused")).toBe(false);
    // The stream is destroyed after the error: later lines are refused without a write.
    expect(await io.print!("after")).toBe(false);
    expect(writes).toBe(2);
  });

  it("resolves false for a stdout that was ended or destroyed", async () => {
    const ended = new PassThrough();
    ended.end();
    expect(await written(ended, "x")).toBe(false);
    const destroyed = new PassThrough();
    destroyed.destroy();
    expect(await written(destroyed, "x")).toBe(false);
  });

  it("resolves false once the reader at the other end of a real pipe has gone", async () => {
    // The reader takes one chunk and exits, as `head -n 1` does.
    const child = spawn(process.execPath, ["-e", "process.stdin.once('data', () => process.exit(0))"], { stdio: ["pipe", "ignore", "ignore"] });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const io = processIo(procWith(child.stdin), machine);
    expect(await io.print!("first")).toBe(true);
    await exited;
    // A pipe may still take a write the kernel buffered before it saw the reader go; it refuses
    // one soon after, and nothing is thrown at this process.
    let refused = false;
    for (let i = 0; i < 50 && !refused; i++) refused = !(await io.print!(`line ${i}`));
    expect(refused).toBe(true);
    await until(() => child.stdin.destroyed);
  }, 20_000);
});
