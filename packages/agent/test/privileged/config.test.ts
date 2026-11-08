import { describe, expect, it } from "vitest";
import { ConfigError, loadPrivilegedConfig, parsePrivilegedConfig, ownerProblem, PRIVILEGED_RUNNER_PATH, sudoersLine, type ReadRule } from "../../src/privileged/config.ts";
import { device, minimal, RECIPIENT_CFG, SENDER, SENDERS, WIF } from "./helpers.ts";

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
    expect(c.senders).toEqual(SENDERS);
    expect(c.apiUrl).toBe("https://api.anthropic.com");
    expect(c.wakeCode).toBeUndefined();
    const p = c.profiles["a"]!;
    expect(p).toMatchObject({ model: "claude-opus-5-5", effort: "medium", maxTurns: 20, maxTokens: 128000, tools: ["Read", "Grep", "Glob"], unsafeTools: false });
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

describe("senders, recipient and the API", () => {
  it("refuses a sender pinned under another device's id, an empty list, and a short key", () => {
    const other = device();
    expect(() => parsePrivilegedConfig(minimal({ senders: { [other.id]: { sign: SENDER.sign, box: SENDER.box } } }))).toThrow(/the one its sign key names/);
    expect(() => parsePrivilegedConfig(minimal({ senders: {} }))).toThrow(/at least one sender/);
    expect(() => parsePrivilegedConfig(minimal({ senders: { [SENDER.id]: { sign: "x", box: SENDER.box } } }))).toThrow(ConfigError);
  });
  it("refuses a runner that would take a job from anyone, and senders without a recipient", () => {
    expect(() => parsePrivilegedConfig(minimal({ senders: undefined, recipient: undefined }))).toThrow(/a runner that would take a job from anyone/);
    expect(parsePrivilegedConfig(minimal({ senders: undefined, recipient: undefined, allowLocal: true })).allowLocal).toBe(true);
    expect(() => parsePrivilegedConfig(minimal({ recipient: undefined }))).toThrow(/senders and recipient go together/);
    expect(() => parsePrivilegedConfig(minimal({ senders: undefined, allowLocal: true }))).toThrow(/go together/);
    expect(parsePrivilegedConfig(minimal()).recipient).toEqual(RECIPIENT_CFG);
  });
  it("takes https APIs, and plain http only on loopback for tests", () => {
    expect(parsePrivilegedConfig(minimal({ apiUrl: "http://127.0.0.1:8080" })).apiUrl).toBe("http://127.0.0.1:8080");
    for (const apiUrl of ["http://api.example.test", "https://api.example.test/v1", "ftp://x", "http://127.0.0.1:80/x"]) {
      expect(() => parsePrivilegedConfig(minimal({ apiUrl }))).toThrow(ConfigError);
    }
  });
});

describe("ownerProblem", () => {
  const file = (uid: number, mode: number) => ({ uid, mode, isFile: true });
  const rule = (owner: number | undefined, secret: boolean): ReadRule => ({ owner, secret });
  it("passes a file its owner alone writes, and skips the checks with no owner", () => {
    expect(ownerProblem(file(0, 0o100644), rule(0, false))).toBeUndefined();
    expect(ownerProblem(file(0, 0o100600), rule(0, true))).toBeUndefined();
    expect(ownerProblem({ uid: 5, mode: 0o40777, isFile: false }, rule(undefined, true))).toBeUndefined();
  });
  it("refuses another owner, a non-file, a group or other write bit, and a readable secret", () => {
    expect(ownerProblem(file(1000, 0o100600), rule(0, false))).toMatch(/not owned by uid 0/);
    expect(ownerProblem({ uid: 0, mode: 0o40755, isFile: false }, rule(0, false))).toMatch(/not a regular file/);
    expect(ownerProblem(file(0, 0o100664), rule(0, false))).toMatch(/writable by group or others \(mode 664\)/);
    expect(ownerProblem(file(0, 0o100640), rule(0, true))).toMatch(/readable by group or others \(mode 640\)/);
  });
});

describe("loadPrivilegedConfig", () => {
  const reader = (text: string) => {
    const rules: ReadRule[] = [];
    return { rules, read: async (_p: string, r: ReadRule) => (rules.push(r), text) };
  };
  it("asks for a root-owned file as root, and checks nothing as a user", async () => {
    const a = reader(JSON.stringify(minimal()));
    expect((await loadPrivilegedConfig("/c.json", a.read, 0)).defaultProfile).toBe("a");
    expect(a.rules).toEqual([{ owner: 0, secret: false }]);
    const b = reader(JSON.stringify(minimal()));
    await loadPrivilegedConfig("/c.json", b.read, 1000);
    expect(b.rules).toEqual([{ owner: undefined, secret: false }]);
  });
  it("refuses text that is not JSON without quoting it", async () => {
    await expect(loadPrivilegedConfig("/c.json", reader("{ secret").read, 1000)).rejects.toThrow(/^\/c\.json: not valid JSON$/);
  });
});
