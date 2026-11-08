import { describe, expect, it } from "vitest";
import { DEFAULT_PASS_ENV, loadConfig } from "../src/config.ts";
import { LAPTOP } from "./helpers.ts";

const base = {
  senders: { devices: [LAPTOP] },
  wake: { mode: "none" },
  runner: { command: "/usr/local/bin/runner" },
  limits: { ledgerPath: "/var/lib/w/ledger.json" },
};

describe("loadConfig", () => {
  it("fills the defaults", () => {
    const c = loadConfig(base);
    expect(c.senders.requireTrusted).toBe(true);
    expect(c.runner).toEqual({ command: "/usr/local/bin/runner", args: [], timeoutSeconds: 900, killGraceSeconds: 15, passEnv: DEFAULT_PASS_ENV, logStderr: true });
    expect(c.limits).toEqual({ ledgerPath: "/var/lib/w/ledger.json", maxTaskChars: 8000, perSenderPerHour: 10, dailyJobs: 20 });
    expect(c.replies).toEqual({ refused: "generic" });
    expect(c.profiles).toBeUndefined();
  });

  it("takes a local code from exactly one of a file and a variable", () => {
    expect(loadConfig({ ...base, wake: { mode: "local", codeFile: "/etc/w/code" } }).wake.codeFile).toBe("/etc/w/code");
    expect(loadConfig({ ...base, wake: { mode: "local", codeEnv: "WAKE" } }).wake.codeEnv).toBe("WAKE");
    expect(() => loadConfig({ ...base, wake: { mode: "local" } })).toThrow("exactly one of wake.codeFile and wake.codeEnv");
    expect(() => loadConfig({ ...base, wake: { mode: "local", codeFile: "/x", codeEnv: "WAKE" } })).toThrow("exactly one");
    expect(() => loadConfig({ ...base, wake: { mode: "runner", codeEnv: "WAKE" } })).toThrow("only read when wake.mode is local");
  });

  it("refuses names where device ids belong", () => {
    expect(() => loadConfig({ ...base, senders: { devices: ["laptop"] } })).toThrow("senders.devices.0: a 22-character device id");
    expect(() => loadConfig({ ...base, senders: { devices: [] } })).toThrow("senders.devices");
  });

  it("checks profiles", () => {
    const c = loadConfig({ ...base, profiles: { allowed: ["a", "b"], default: "a" } });
    expect(c.profiles).toEqual({ allowed: ["a", "b"], default: "a" });
    expect(() => loadConfig({ ...base, profiles: { allowed: ["a"], default: "b" } })).toThrow("profiles.default must be one of profiles.allowed");
    expect(() => loadConfig({ ...base, profiles: { allowed: ["a b"], default: "a b" } })).toThrow("profiles.allowed.0");
    expect(() => loadConfig({ ...base, wake: { mode: "runner" }, profiles: { allowed: ["a"], default: "a" } })).toThrow("the runner parses it");
  });

  it("never passes the wake code's variable to the runner", () => {
    expect(() => loadConfig({ ...base, wake: { mode: "local", codeEnv: "WAKE" }, runner: { command: "r", passEnv: ["PATH", "WAKE"] } })).toThrow("must not pass the wake code's variable");
    expect(loadConfig({ ...base, wake: { mode: "local", codeEnv: "WAKE" } }).runner.passEnv).not.toContain("WAKE");
  });

  it("refuses unknown keys and bad values, one line each", () => {
    let message = "";
    try {
      loadConfig({ ...base, extra: 1, replies: { room: "agents" }, runner: { command: "" } });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message.split("\n")[0]).toBe("invalid worker config:");
    expect(message).toContain("config: Unrecognized key");
    expect(message).toContain("replies.room: a room such as #agents");
    expect(message).toContain("runner.command");
    expect(() => loadConfig(null)).toThrow("invalid worker config");
  });
});
