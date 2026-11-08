import { describe, expect, it } from "vitest";
import { ConfigError, loadPrivilegedConfig, parsePrivilegedConfig, PRIVILEGED_RUNNER_PATH, rootOwnedProblem, sudoersLine } from "../../src/privileged/config.ts";
import { minimal, WIF } from "./helpers.ts";

describe("sudoersLine", () => {
  it("allows the runner with no arguments at all", () => {
    expect(sudoersLine("wim-agent")).toBe(`wim-agent ALL=(root) NOPASSWD: ${PRIVILEGED_RUNNER_PATH} ""`);
  });
});

describe("parsePrivilegedConfig", () => {
  it("fills every default", () => {
    const c = parsePrivilegedConfig(minimal());
    expect(c.worker).toEqual({ user: "wim-agent-worker", home: "/var/lib/wim-agent-worker", cwd: "/var/lib/wim-agent-worker/work", additionalDirectories: [] });
    expect(c.lock).toEqual({ path: "/run/wim-agent/job.lock", waitSeconds: 900 });
    expect(c.minMemAvailableMb).toBe(900);
    expect(c.timeoutSeconds).toBe(1800);
    expect(c.maxTaskChars).toBe(16000);
    expect(c.dailyJobs).toBe(50);
    expect(c.allowLocal).toBe(false);
    expect(c.allowDevices).toBeUndefined();
    expect(c.wakeCode).toBeUndefined();
    const p = c.profiles["a"]!;
    expect(p).toMatchObject({ model: "claude-opus-5-5", effort: "medium", maxTurns: 20, tools: ["Read", "Grep", "Glob"], unsafeTools: false });
    expect(p.auth).toMatchObject({ audience: "https://api.anthropic.com", identity: { durationSeconds: 600 } });
  });

  it("keeps a worker cwd that is given", () => {
    expect(parsePrivilegedConfig(minimal({ worker: { user: "jobs", home: "/srv/j", cwd: "/srv/j/w" } })).worker.cwd).toBe("/srv/j/w");
  });

  it("takes every identity and the API key form", () => {
    const profiles = {
      a: { auth: { ...WIF, identity: { type: "gcp-metadata" } } },
      b: { auth: { ...WIF, identity: { type: "gcp-impersonate", serviceAccount: "worker@example.com" } } },
      c: { auth: { ...WIF, identity: { type: "file", path: "/var/run/token" } } },
      d: { auth: { type: "api-key", keyFile: "/etc/wim-agent/key" } },
    };
    expect(Object.keys(parsePrivilegedConfig(minimal({ profiles })).profiles)).toEqual(["a", "b", "c", "d"]);
  });

  it("takes a wake code from a file or an env var", () => {
    expect(parsePrivilegedConfig(minimal({ wakeCode: { file: "/etc/wim-agent/wake-code" } })).wakeCode).toEqual({ file: "/etc/wim-agent/wake-code" });
    expect(parsePrivilegedConfig(minimal({ wakeCode: { env: "WAKE" } })).wakeCode).toEqual({ env: "WAKE" });
  });

  it.each([
    ["an unknown key", minimal({ extra: 1 })],
    ["a missing default profile", minimal({ defaultProfile: "z" })],
    ["a relative path", minimal({ runDir: "run" })],
    ["a write tool without unsafeTools", minimal({ profiles: { a: { tools: ["Read", "Bash"], auth: WIF } } })],
    ["a bad profile name", minimal({ profiles: { "A B": { auth: WIF } }, defaultProfile: "A B" })],
    ["a wake code with both sources", minimal({ wakeCode: { file: "/x", env: "X" } })],
    ["version 2", minimal({ v: 2 })],
    ["not an object", null],
  ])("refuses %s", (_what, raw) => {
    expect(() => parsePrivilegedConfig(raw)).toThrow(ConfigError);
  });

  it("names the path of each problem", () => {
    expect(() => parsePrivilegedConfig(minimal({ timeoutSeconds: 0 }))).toThrow(/timeoutSeconds:/);
    expect(() => parsePrivilegedConfig(null)).toThrow(/\(top\):/);
  });

  it("takes write tools when unsafeTools says so", () => {
    const c = parsePrivilegedConfig(minimal({ profiles: { a: { tools: ["Read", "Bash"], unsafeTools: true, auth: WIF } } }));
    expect(c.profiles["a"]!.tools).toEqual(["Read", "Bash"]);
  });
});

describe("rootOwnedProblem", () => {
  it("passes a root file that only root writes", () => {
    expect(rootOwnedProblem({ uid: 0, mode: 0o100644 }, false)).toBeUndefined();
    expect(rootOwnedProblem({ uid: 0, mode: 0o100600 }, true)).toBeUndefined();
  });
  it("refuses another owner, a group or other write bit, and a readable secret", () => {
    expect(rootOwnedProblem({ uid: 1000, mode: 0o100600 }, false)).toMatch(/not owned by root/);
    expect(rootOwnedProblem({ uid: 0, mode: 0o100664 }, false)).toMatch(/writable by group or others \(mode 664\)/);
    expect(rootOwnedProblem({ uid: 0, mode: 0o100640 }, true)).toMatch(/readable by group or others \(mode 640\)/);
  });
});

describe("loadPrivilegedConfig", () => {
  const fs = (text: string, facts = { uid: 0, mode: 0o100644 }) => ({ readFile: async () => text, stat: async () => facts });

  it("reads a valid file as root", async () => {
    expect((await loadPrivilegedConfig("/c.json", fs(JSON.stringify(minimal())), 0)).defaultProfile).toBe("a");
  });
  it("refuses a file others could write, as root", async () => {
    await expect(loadPrivilegedConfig("/c.json", fs(JSON.stringify(minimal()), { uid: 0, mode: 0o100666 }), 0)).rejects.toThrow(/refusing \/c\.json/);
  });
  it("skips the owner check as a user", async () => {
    expect((await loadPrivilegedConfig("/c.json", fs(JSON.stringify(minimal()), { uid: 1000, mode: 0o100666 }), 1000)).v).toBe(1);
  });
  it("refuses text that is not JSON", async () => {
    await expect(loadPrivilegedConfig("/c.json", fs("{"), 1000)).rejects.toThrow(/not valid JSON/);
  });
});
