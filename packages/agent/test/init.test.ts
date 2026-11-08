import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { PLACEHOLDER, placeholders } from "../src/doctor.ts";
import { allowProblem, initNotes, privilegedTemplate, workerTemplate, type InitOptions } from "../src/init.ts";

const SELF = "S".repeat(22);
const LAPTOP = "L".repeat(22);
const DESK = "D".repeat(22);
const roster = [
  { id: SELF, name: "worker-box" },
  { id: LAPTOP, name: "laptop" },
  { id: DESK, name: "desk" },
];
const base: InitOptions = {
  mode: "direct",
  allow: [LAPTOP],
  roster,
  self: SELF,
  profiles: [],
  auth: "api-key",
  wim: ["/usr/bin/node", "/opt/wim/wim.mjs"],
  ledgerPath: "/var/lib/w/ledger.json",
  launcher: "/usr/local/sbin/runner",
};

describe("allowProblem", () => {
  it("takes roster ids", () => {
    expect(allowProblem(base)).toBeUndefined();
    expect(allowProblem({ ...base, allow: [] })).toBeUndefined();
  });
  it("refuses a name, with the id it belongs to", () => {
    expect(allowProblem({ ...base, allow: ["laptop"] })).toBe(`laptop is a device name; senders are allowed by id, never by name (a sender picks its own name): use ${LAPTOP}`);
  });
  it("refuses this device and an id the roster lacks", () => {
    expect(allowProblem({ ...base, allow: [SELF] })).toMatch(/is this device/);
    expect(allowProblem({ ...base, allow: ["Z".repeat(22)] })).toMatch(/not a device id in this mesh's roster/);
  });
});

describe("workerTemplate", () => {
  it("direct: runs this wim's own runner, and is a valid config as written", () => {
    const t = workerTemplate({ ...base, room: "#agents", profiles: ["a", "b"], wakeFile: "/home/w/.wake" });
    expect(t["runner"]).toMatchObject({ command: "/usr/bin/node", args: ["/opt/wim/wim.mjs", "agent", "runner"] });
    expect(placeholders(t)).toEqual([]);
    const c = loadConfig(t);
    expect(c.wake).toEqual({ mode: "local", codeFile: "/home/w/.wake" });
    expect(c.profiles).toEqual({ allowed: ["a", "b"], default: "a" });
    expect(c.replies.room).toBe("#agents");
    expect(c.limits).toMatchObject({ maxTaskChars: 16000, perSenderPerHour: 20, dailyJobs: 50 });
    expect(c.runner).toMatchObject({ timeoutSeconds: 1800, killGraceSeconds: 15 });
  });

  it("direct with no code and no senders: a placeholder to fill in", () => {
    const t = workerTemplate({ ...base, allow: [] });
    expect(t["wake"]).toEqual({ mode: "none" });
    expect(t["profiles"]).toBeUndefined();
    expect(placeholders(t)).toEqual(["senders.devices[0]"]);
  });

  it("privileged: sudo -n on the launcher with no message on argv, and the runner holds the code", () => {
    const t = workerTemplate({ ...base, mode: "privileged", profiles: ["a"] });
    const c = loadConfig(t);
    expect(c.runner.command).toBe("sudo");
    expect(c.runner.args).toEqual(["-n", "/usr/local/sbin/runner"]);
    expect(c.wake.mode).toBe("runner");
    // The runner parses the prefix, so the worker config names none.
    expect(c.profiles).toBeUndefined();
    expect(c.runner.passEnv).not.toContain("ANTHROPIC_API_KEY");
    // Longer than the privileged runner's lock wait and job, which answers its own timeout.
    expect(c.runner.timeoutSeconds).toBe(2760);
  });
});

describe("privilegedTemplate", () => {
  it("api-key profiles point at root-only key files", () => {
    const t = privilegedTemplate({ ...base, mode: "privileged", profiles: ["a", "b"] });
    expect(t).toEqual({
      profiles: { a: { auth: { type: "api-key", keyFile: "/etc/wim-agent/a.key" } }, b: { auth: { type: "api-key", keyFile: "/etc/wim-agent/b.key" } } },
      defaultProfile: "a",
      wakeCode: { file: "/etc/wim-agent/wake-code" },
      timeoutSeconds: 1800,
      maxTaskChars: 16000,
      dailyJobs: 50,
      allowDevices: [LAPTOP],
    });
  });
  it("wif leaves the federation ids to fill in; no profiles means one named default", () => {
    const t = privilegedTemplate({ ...base, mode: "privileged", auth: "wif", allow: [] });
    expect(t["defaultProfile"]).toBe("default");
    expect(t["allowDevices"]).toBeUndefined();
    expect(placeholders(t)).toEqual([
      "profiles.default.auth.organizationId",
      "profiles.default.auth.federationRuleId",
      "profiles.default.auth.serviceAccountId",
      "profiles.default.auth.identity.path",
    ]);
  });
});

describe("placeholders", () => {
  it("finds REPLACE-ME anywhere, including the top level", () => {
    expect(placeholders(PLACEHOLDER)).toEqual(["config"]);
    expect(placeholders({ a: [1, { b: `x-${PLACEHOLDER}` }], c: null, d: true })).toEqual(["a[1].b"]);
  });
});

describe("initNotes", () => {
  it("lists the other devices by id, and what is left", () => {
    const lines = initNotes(base, "w.json", ["senders.devices[0]"]);
    expect(lines).toContain(`  ${LAPTOP}  laptop`);
    expect(lines.join("\n")).not.toContain(SELF);
    expect(lines).toContain("Still to fill in: senders.devices[0].");
  });
  it("says how to add a device when there is none", () => {
    const lines = initNotes({ ...base, roster: [roster[0]!] }, "w.json", []);
    expect(lines[1]).toMatch(/no other device yet/);
    expect(lines.some((l) => l.startsWith("Still"))).toBe(false);
  });
});
