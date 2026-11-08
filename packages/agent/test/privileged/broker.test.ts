import { describe, expect, it } from "vitest";
import { REFRESH_MS, TokenBroker, type BrokerFs } from "../../src/privileged/broker.ts";

function fakeFs() {
  const files = new Map<string, { data: string; mode: number; owner?: string }>();
  const ops: string[] = [];
  const fs: BrokerFs = {
    writeFile: async (p, data, mode) => void (ops.push(`write ${p}`), files.set(p, { data, mode })),
    chown: async (p, u, g) => void (ops.push(`chown ${p} ${u}:${g}`), (files.get(p)!.owner = `${u}:${g}`)),
    rename: async (a, b) => void (ops.push(`rename ${a} ${b}`), files.set(b, files.get(a)!), files.delete(a)),
    rm: async (p) => void (ops.push(`rm ${p}`), files.delete(p)),
  };
  return { fs, files, ops };
}

function timers() {
  const t = { fn: undefined as (() => void) | undefined, ms: 0, cleared: undefined as unknown };
  return {
    t,
    setInterval: (fn: () => void, ms: number) => ((t.fn = fn), (t.ms = ms), "timer-1"),
    clearInterval: (x: unknown) => void (t.cleared = x),
  };
}

describe("TokenBroker", () => {
  it("writes a fresh token 0640 to the worker's group, refreshes it on a timer, and removes it", async () => {
    const { fs, files, ops } = fakeFs();
    const tm = timers();
    let n = 0;
    const b = new TokenBroker({ path: "/run/w/idtoken", gid: 990, chown: true, fs, log: () => undefined, mint: async () => `jwt-${++n}`, ...tm });
    await b.start();
    expect(files.get("/run/w/idtoken")).toEqual({ data: "jwt-1", mode: 0o640, owner: "0:990" });
    expect(ops).toEqual(["write /run/w/idtoken.new", "chown /run/w/idtoken.new 0:990", "rename /run/w/idtoken.new /run/w/idtoken"]);
    expect(tm.t.ms).toBe(REFRESH_MS);
    tm.t.fn!();
    await b.stop();
    expect(n).toBe(2);
    expect(tm.t.cleared).toBe("timer-1");
    expect(files.size).toBe(0);
  });

  it("does not chown when told not to (not root)", async () => {
    const { fs, ops } = fakeFs();
    const b = new TokenBroker({ path: "/p", gid: 1, chown: false, fs, log: () => undefined, mint: async () => "t", ...timers() });
    await b.start();
    expect(ops.some((o) => o.startsWith("chown"))).toBe(false);
  });

  it("fails the start when the first mint fails", async () => {
    const { fs } = fakeFs();
    const b = new TokenBroker({ path: "/p", gid: 1, chown: false, fs, log: () => undefined, mint: async () => Promise.reject(new Error("no role")), ...timers() });
    await expect(b.start()).rejects.toThrow("no role");
  });

  it("logs a failed refresh by error name only and keeps the last token", async () => {
    const { fs, files } = fakeFs();
    const tm = timers();
    const lines: string[] = [];
    let first = true;
    const mint = async () => {
      if (first) return ((first = false), "good");
      throw new TypeError("secret detail");
    };
    const b = new TokenBroker({ path: "/p", gid: 1, chown: false, fs, log: (l) => lines.push(l), mint, ...tm });
    await b.start();
    tm.t.fn!();
    await b.stop();
    expect(lines).toEqual(["token refresh failed: TypeError"]);
    expect(files.has("/p")).toBe(false);
  });
});
