// Everything that differs between Linux, macOS and Windows, behind functions that take the
// platform as a parameter. Tests pass each platform in turn, so every branch runs on any machine.

import { b64u, sha256, utf8 } from "@worldinmotion/protocol";
import { posix, win32 } from "node:path";

export type Platform = "linux" | "darwin" | "win32" | (string & {});

/** The path module for a platform: Windows paths use `\` and drive letters. */
export function pathFor(platform: Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/**
 * Where state lives (design.md, state on disk). `WIM_HOME` wins. Otherwise the XDG config dir
 * (or `%APPDATA%` on Windows), and under it a profile per `CLAUDE_CONFIG_DIR`, so two Claude
 * accounts for one OS user are two devices.
 */
export function defaultHome(env: Record<string, string | undefined>, platform: Platform, homedir: string): string {
  const path = pathFor(platform);
  const explicit = env["WIM_HOME"];
  if (explicit !== undefined && explicit !== "") return explicit;
  const config =
    platform === "win32"
      ? (env["APPDATA"] ?? path.join(homedir, "AppData", "Roaming"))
      : (env["XDG_CONFIG_HOME"] ?? path.join(homedir, ".config"));
  const base = path.join(config, "worldinmotion");
  const claude = env["CLAUDE_CONFIG_DIR"];
  if (claude === undefined || claude === "") return base;
  return path.join(base, "profiles", b64u.encode(sha256(utf8(claude))).slice(0, 12));
}

/** The fields of an `fs.Stats` the permission checks read. */
export type FileFacts = { mode: number; uid: number; isFile: boolean; isSymlink: boolean };

/**
 * Why a key file must not be used, or undefined when it is fine. On POSIX the file must be a
 * regular file owned by this user with no group or other permission bits. Windows has no mode
 * bits (permissions are ACLs), so there it must be a regular file that is not a link; the file
 * lives in the user's own profile directory, which other users cannot read by default.
 */
export function keyFileProblem(facts: FileFacts, platform: Platform, myUid: number | undefined): string | undefined {
  if (facts.isSymlink) return "it is a symbolic link";
  if (!facts.isFile) return "it is not a regular file";
  if (platform === "win32") return undefined;
  if (myUid !== undefined && facts.uid !== myUid) return "it is owned by another user";
  if ((facts.mode & 0o077) !== 0) return `it is readable by group or others (mode ${(facts.mode & 0o777).toString(8)}); run chmod 600 on it`;
  return undefined;
}

/** Same rule for a state directory: no group or other bits on POSIX. */
export function dirProblem(mode: number, platform: Platform): string | undefined {
  if (platform === "win32") return undefined;
  return (mode & 0o077) === 0 ? undefined : `mode ${(mode & 0o777).toString(8)} lets group or others in; run chmod 700 on it`;
}

/**
 * Whether a lock holder is gone. A lock file names its holder's pid; signal 0 checks that the
 * process exists without touching it, on every platform Node supports. EPERM means it exists
 * but belongs to someone else, so it is still alive.
 */
export function pidAlive(pid: number, kill: (pid: number, signal: 0) => void): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether an exclusive create (`open` with `wx`) goes through a symbolic link at the path and
 * creates the link's target. POSIX `O_EXCL` refuses any name that exists, a dangling link
 * included. Windows `CREATE_NEW` follows the link, so there a link at a lock path would make the
 * lock a file wherever the link points.
 */
export function createFollowsLinks(platform: Platform): boolean {
  return platform === "win32";
}

/**
 * Rename over an existing file. POSIX rename replaces atomically. On Windows a rename onto a
 * file that another process has open can fail with EPERM or EBUSY for a moment, so it is retried.
 */
export function renameRetries(platform: Platform): number {
  return platform === "win32" ? 10 : 0;
}
