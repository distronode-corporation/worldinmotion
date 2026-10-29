// Where the signer listens and who may reach it. Node cannot ask a Unix socket who connected, so
// the checks are on the directory (POSIX) and on the pipe's secret name (Windows). Each platform's
// branch runs on every machine through the platform parameter.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentDir, agentEndpoint, endpointFiles, readAgentSettings, writeAgentSettings } from "../src/agentpath.ts";
import { fsOps } from "../src/fsx.ts";
import { agentDirProblem, agentEndpointFor, endpointProblem, SOCKET_PATH_MAX } from "../src/platform.ts";
import { FS, POSIX, POSIX_VIEW, scratch } from "./helpers.ts";

const ENV = { ...FS, uid: process.getuid?.() };
const realLink = fsOps.link;
afterEach(() => {
  fsOps.link = realLink;
});

describe("agentDirProblem", () => {
  const dir = { mode: 0o40700, uid: 501, isDirectory: true, isSymlink: false };
  it("wants a real, private directory of this user on POSIX; Windows checks only links and kind", () => {
    expect(agentDirProblem(dir, "linux", 501)).toBeUndefined();
    expect(agentDirProblem(dir, "darwin", undefined)).toBeUndefined();
    expect(agentDirProblem({ ...dir, isSymlink: true }, "win32", 501)).toMatch(/symbolic link/);
    expect(agentDirProblem({ ...dir, isDirectory: false }, "linux", 501)).toMatch(/not a directory/);
    expect(agentDirProblem({ ...dir, uid: 0 }, "linux", 501)).toMatch(/another user/);
    expect(agentDirProblem({ ...dir, mode: 0o40755 }, "linux", 501)).toMatch(/chmod 700/);
    expect(agentDirProblem({ ...dir, mode: 0o40777, uid: 0 }, "win32", 501)).toBeUndefined();
  });
});

describe("agentEndpointFor and endpointProblem", () => {
  it("is a socket in the directory on POSIX and a token-named pipe on Windows", () => {
    expect(agentEndpointFor("/h/agent", "linux", "")).toBe("/h/agent/sock");
    expect(agentEndpointFor("C:\\h\\agent", "win32", "tok")).toBe("\\\\.\\pipe\\wim-agent-tok");
  });

  it("refuses a socket path macOS could not bind", () => {
    const long = `/${"d".repeat(SOCKET_PATH_MAX)}`;
    expect(endpointProblem(long, "darwin")).toMatch(/set WIM_HOME to a shorter directory/);
    expect(endpointProblem("/short/sock", "linux")).toBeUndefined();
    expect(endpointProblem(`\\\\.\\pipe\\${"x".repeat(200)}`, "win32")).toBeUndefined();
  });
});

describe("agentEndpoint", () => {
  it("is undefined until a signer made its directory, then stable", async () => {
    const root = await scratch("ep");
    expect(await agentEndpoint(root, ENV, false)).toBeUndefined();
    const made = await agentEndpoint(root, ENV, true);
    expect(made).toBeDefined();
    expect(await agentEndpoint(root, ENV, false)).toBe(made);
    if (POSIX) expect((await fs.stat(agentDir(root))).mode & 0o777).toBe(0o700);
  });

  it("on Windows keeps a random pipe token in the directory, made once", async () => {
    const root = await scratch("ep");
    const win = { ...ENV, platform: "win32" as const };
    await fs.mkdir(agentDir(root), { recursive: true, mode: 0o700 });
    expect(await agentEndpoint(root, win, false)).toBeUndefined();
    const first = await agentEndpoint(root, win, true);
    expect(first).toMatch(/^\\\\\.\\pipe\\wim-agent-[A-Za-z0-9_-]{22}$/);
    expect(await agentEndpoint(root, win, false)).toBe(first);
    expect(await agentEndpoint(root, win, true)).toBe(first);
  });

  it("takes the token another signer wrote first when two start at once", async () => {
    const root = await scratch("ep");
    const win = { ...ENV, platform: "win32" as const };
    fsOps.link = async (_existing, path) => {
      await fs.writeFile(path, "theirs");
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    };
    expect(await agentEndpoint(root, win, true)).toBe("\\\\.\\pipe\\wim-agent-theirs");
  });

  it("refuses a directory others can enter, and a socket path too long to bind", async () => {
    const root = await scratch("ep");
    await agentEndpoint(root, ENV, true);
    if (POSIX) await fs.chmod(agentDir(root), 0o755);
    await expect(agentEndpoint(root, { ...ENV, platform: POSIX_VIEW }, false)).rejects.toThrow(/refusing to use .*chmod 700/);
    const deep = join(await scratch("ep"), "x".repeat(SOCKET_PATH_MAX));
    await expect(agentEndpoint(deep, { ...ENV, platform: POSIX_VIEW }, true)).rejects.toThrow(/shorter directory/);
  });
});

describe("endpointFiles", () => {
  it("POSIX clears a stale socket file and makes the new one private; a Windows pipe has no file", async () => {
    const dir = await scratch("ef");
    const path = join(dir, "sock");
    await fs.writeFile(path, "stale");
    await endpointFiles("win32").clear(path);
    await endpointFiles("win32").secure(path);
    expect(await fs.readFile(path, "utf8")).toBe("stale");
    await fs.chmod(path, 0o644);
    await endpointFiles("linux").secure(path);
    if (POSIX) expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    await endpointFiles("linux").clear(path);
    await expect(fs.stat(path)).rejects.toThrow();
  });
});

describe("agent settings", () => {
  it("require_signer is off unless written as true", async () => {
    const root = await scratch("st");
    expect(await readAgentSettings(root)).toEqual({ require_signer: false });
    await writeAgentSettings(root, { require_signer: true }, FS);
    expect(await readAgentSettings(root)).toEqual({ require_signer: true });
    await fs.writeFile(join(agentDir(root), "config.json"), JSON.stringify({ require_signer: "yes" }));
    expect(await readAgentSettings(root)).toEqual({ require_signer: false });
  });
});
