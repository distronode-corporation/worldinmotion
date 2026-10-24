import { describe, expect, it } from "vitest";
import { busyRetries, createFollowsLinks, defaultHome, dirProblem, keyFileProblem, pathFor, pidAlive } from "../src/platform.ts";

const file = { mode: 0o100600, uid: 1000, isFile: true, isSymlink: false };

describe("defaultHome", () => {
  it("prefers WIM_HOME", () => {
    expect(defaultHome({ WIM_HOME: "/x/y" }, "linux", "/home/u")).toBe("/x/y");
  });
  it("uses XDG_CONFIG_HOME, else ~/.config, on POSIX", () => {
    expect(defaultHome({ XDG_CONFIG_HOME: "/cfg" }, "linux", "/home/u")).toBe("/cfg/worldinmotion");
    expect(defaultHome({ WIM_HOME: "" }, "darwin", "/Users/u")).toBe("/Users/u/.config/worldinmotion");
  });
  it("uses APPDATA, else AppData/Roaming, on Windows", () => {
    expect(defaultHome({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", "C:\\Users\\u")).toBe("C:\\Users\\u\\AppData\\Roaming\\worldinmotion");
    expect(defaultHome({}, "win32", "C:\\Users\\u")).toBe("C:\\Users\\u\\AppData\\Roaming\\worldinmotion");
  });
  it("gives each CLAUDE_CONFIG_DIR its own profile", () => {
    const a = defaultHome({ CLAUDE_CONFIG_DIR: "/a" }, "linux", "/home/u");
    const b = defaultHome({ CLAUDE_CONFIG_DIR: "/b" }, "linux", "/home/u");
    expect(a).toMatch(/^\/home\/u\/\.config\/worldinmotion\/profiles\/[A-Za-z0-9_-]{12}$/);
    expect(a).not.toBe(b);
    expect(defaultHome({ CLAUDE_CONFIG_DIR: "" }, "linux", "/home/u")).toBe("/home/u/.config/worldinmotion");
  });
  it("picks the path module per platform", () => {
    expect(pathFor("win32").sep).toBe("\\");
    expect(pathFor("linux").sep).toBe("/");
  });
});

describe("keyFileProblem", () => {
  it("accepts a private regular file owned by this user", () => {
    expect(keyFileProblem(file, "linux", 1000)).toBeUndefined();
    expect(keyFileProblem(file, "darwin", undefined)).toBeUndefined();
  });
  it("refuses links, non-files, other owners and group or other bits", () => {
    expect(keyFileProblem({ ...file, isSymlink: true }, "linux", 1000)).toMatch(/symbolic link/);
    expect(keyFileProblem({ ...file, isFile: false }, "linux", 1000)).toMatch(/not a regular file/);
    expect(keyFileProblem(file, "linux", 1001)).toMatch(/another user/);
    expect(keyFileProblem({ ...file, mode: 0o100640 }, "linux", 1000)).toMatch(/mode 640/);
    expect(keyFileProblem({ ...file, mode: 0o100604 }, "darwin", 1000)).toMatch(/group or others/);
  });
  it("on Windows checks only that it is a plain file (permissions are ACLs there)", () => {
    expect(keyFileProblem({ ...file, mode: 0o100666 }, "win32", 5)).toBeUndefined();
    expect(keyFileProblem({ ...file, isSymlink: true }, "win32", 5)).toMatch(/symbolic link/);
  });
});

describe("dirProblem", () => {
  it("wants 0700 on POSIX and nothing on Windows", () => {
    expect(dirProblem(0o40700, "linux")).toBeUndefined();
    expect(dirProblem(0o40755, "linux")).toMatch(/chmod 700/);
    expect(dirProblem(0o40777, "win32")).toBeUndefined();
  });
});

describe("pidAlive", () => {
  it("reads signal 0", () => {
    expect(pidAlive(123, () => undefined)).toBe(true);
    expect(pidAlive(123, () => { throw Object.assign(new Error("x"), { code: "EPERM" }); })).toBe(true);
    expect(pidAlive(123, () => { throw Object.assign(new Error("x"), { code: "ESRCH" }); })).toBe(false);
    expect(pidAlive(0, () => undefined)).toBe(false);
    expect(pidAlive(1.5, () => undefined)).toBe(false);
  });
  it("retries busy files only on Windows", () => {
    expect(busyRetries("win32")).toBeGreaterThan(0);
    expect(busyRetries("linux")).toBe(0);
    expect(busyRetries("darwin")).toBe(0);
  });
  it("knows that only Windows creates a file through a link at the path", () => {
    expect(createFollowsLinks("win32")).toBe(true);
    expect(createFollowsLinks("linux")).toBe(false);
    expect(createFollowsLinks("darwin")).toBe(false);
  });
});
