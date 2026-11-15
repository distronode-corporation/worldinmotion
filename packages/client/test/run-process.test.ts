// `wim run`'s real process layer: the agent as a child process with pipes, on every platform CI runs.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acpAgent } from "../src/agentsetup.ts";
import { MeshFiles } from "../src/mesh.ts";
import { delay, POLL_MS, runHosted, spawnPlan, startAcpAgent } from "../src/run.ts";
import { Clock } from "./acp-fake.ts";
import { FS, scratch } from "./helpers.ts";

const node = process.execPath;
const here = { env: process.env, cwd: process.cwd(), platform: process.platform };

/** A minimal ACP agent in a real child process: it answers initialize and session/new, and exits when its input ends. */
const AGENT = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  for (let nl = buf.indexOf("\\n"); nl !== -1; nl = buf.indexOf("\\n")) {
    const m = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    const result = m.method === "initialize" ? { protocolVersion: 1, agentCapabilities: {} } : { sessionId: "real-1" };
    if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\r\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`;

describe("wim run: the agent's process", () => {
  it("a plain file runs directly; npm's Windows shims run through the shell, quoted", () => {
    expect(spawnPlan("/usr/bin/gemini", ["--acp"], "linux")).toEqual({ command: "/usr/bin/gemini", args: ["--acp"], shell: false });
    expect(spawnPlan("C:\\Program Files\\agy\\agy.exe", ["acp"], "win32")).toEqual({ command: "C:\\Program Files\\agy\\agy.exe", args: ["acp"], shell: false });
    expect(spawnPlan("C:\\Users\\me\\AppData\\Roaming\\npm\\gemini.CMD", ["--acp"], "win32")).toEqual({ command: '"C:\\Users\\me\\AppData\\Roaming\\npm\\gemini.CMD"', args: ["--acp"], shell: true });
    expect(spawnPlan("C:\\tools\\copilot.bat", ["--acp", "--stdio"], "win32").shell).toBe(true);
    // Only Windows needs the shell for these.
    expect(spawnPlan("/opt/x/gemini.cmd", [], "darwin").shell).toBe(false);
  });

  it("runs a real ACP agent over its stdio until Ctrl-C, then closes its input and it exits", async () => {
    const root = await scratch("w2a-proc");
    const clock = new Clock();
    const stop = new AbortController();
    const out: string[] = [];
    const err: string[] = [];
    let child: ReturnType<typeof startAcpAgent> | undefined;
    const done = runHosted({
      agent: acpAgent("gemini")!,
      start: () => (child = startAcpAgent(node, ["-e", AGENT], here)),
      mesh: new MeshFiles(join(root, "meshes", "m1"), FS),
      meshId: "m1",
      home: root,
      wim: [node, "wim.mjs"],
      fsEnv: FS,
      cwd: root,
      now: Date.now,
      delay: clock.delay,
      signal: stop.signal,
      out: (l) => void out.push(l),
      err: (l) => void err.push(l),
      debug: false,
      version: "0.0.0-test",
    });
    await clock.waiting(POLL_MS);
    expect(out[0]).toMatch(/^wim run: Gemini CLI runs as a hosted session/);
    stop.abort();
    expect(await done).toBe(0);
    expect(await child!.exited).toBe("exit code 0");
    expect(err).toEqual([]);
  });

  it("says when the program cannot be started, and how a killed one ended", async () => {
    const missing = startAcpAgent(join(await scratch("w2a-none"), "no-such-agent"), [], here);
    expect(await missing.exited).toMatch(/^it could not be started: /);
    // A process that never started has no group: kill falls back to the child itself.
    missing.kill();
    const stuck = startAcpAgent(node, ["-e", "setInterval(() => {}, 1000)"], here);
    stuck.kill();
    expect(await stuck.exited).toMatch(/^(signal SIGTERM|exit code 1)$/);
    // Its group is gone now: a second kill finds none and falls back too.
    stuck.kill();
    const plain = startAcpAgent(node, ["-e", "setInterval(() => {}, 1000)"], { ...here, platform: "win32" });
    plain.kill();
    expect(await plain.exited).toMatch(/^(signal SIGTERM|exit code 1)$/);
  });

  it.skipIf(process.platform === "win32")("kills the agent's whole process group: a child it started goes too", async () => {
    const parent = `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(c.pid); setInterval(() => {}, 1000);`;
    const agent = startAcpAgent(node, ["-e", parent], here);
    const pid = await new Promise<number>((resolve) => agent.stdout.once("data", (b: Buffer) => resolve(Number(b.toString().trim()))));
    agent.kill();
    await agent.exited;
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive()).toBe(false);
  });

  it("delay waits without keeping the process alive", async () => {
    await delay(1);
  });
});
