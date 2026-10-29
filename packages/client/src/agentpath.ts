// Where the signer (`wim agent`) lives on disk: its private directory under the state directory,
// its endpoint (a Unix socket, or a named pipe on Windows), its log and its settings.

import { b64u, randomBytes } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { SetupError } from "./errors.ts";
import { ensureDir, readJson, readText, writeAtomic, writeJson, type FsEnv } from "./fsx.ts";
import { agentDirProblem, agentEndpointFor, endpointProblem, type Platform } from "./platform.ts";

export type AgentEnv = FsEnv & { uid: number | undefined };

/** The signer's directory: `agent/` under the state directory, mode 0700. */
export function agentDir(root: string): string {
  return join(root, "agent");
}

export function agentLogPath(root: string): string {
  return join(agentDir(root), "log.jsonl");
}

function settingsPath(root: string): string {
  return join(agentDir(root), "config.json");
}

/**
 * The signer's endpoint. `create` (a signer starting, under the start lock) makes the directory
 * and, on Windows, a fresh pipe token: pipe names are global and listable, so a name is never
 * reused after a signer stops, and one that was seen cannot be taken over for the next start.
 * Otherwise undefined means no signer was ever set up here (or the last one stopped cleanly). Throws a SetupError when
 * the directory is not private, so nothing connects through a directory another user controls.
 */
export async function agentEndpoint(root: string, env: AgentEnv, create: boolean): Promise<string | undefined> {
  const dir = agentDir(root);
  if (create) await ensureDir(dir);
  let stat;
  try {
    stat = await fs.lstat(dir);
  } catch {
    return undefined;
  }
  const token = env.platform === "win32" ? await pipeToken(join(dir, "pipe"), env, create) : "";
  if (token === undefined) return undefined;
  const endpoint = agentEndpointFor(dir, env.platform, token);
  const tooLong = endpointProblem(endpoint, env.platform);
  if (tooLong !== undefined) throw new SetupError(tooLong);
  const problem = agentDirProblem({ mode: stat.mode, uid: stat.uid, isDirectory: stat.isDirectory(), isSymlink: stat.isSymbolicLink() }, env.platform, env.uid);
  if (problem !== undefined) throw new SetupError(`refusing to use ${dir}: ${problem}`);
  return endpoint;
}

/** The random part of the pipe name: the kept one, or with `create` a new one, written in its place. */
async function pipeToken(path: string, env: FsEnv, create: boolean): Promise<string | undefined> {
  if (!create) return (await readText(path))?.trim();
  const token = b64u.encode(randomBytes(16));
  await writeAtomic(path, token, env);
  return token;
}

/** The lock a starting signer holds while it checks for a running one and binds, so two cannot both bind. */
export function startLockPath(root: string): string {
  return join(agentDir(root), "start.lock");
}

/**
 * After a signer stops: on Windows its pipe token goes, unless a newer signer already wrote its
 * own (clients then find no endpoint rather than a stale name). A POSIX socket file is removed by
 * Node when the server closes.
 */
export async function retireEndpoint(root: string, env: AgentEnv, endpoint: string): Promise<void> {
  if (env.platform !== "win32") return;
  if ((await agentEndpoint(root, env, false)) === endpoint) await fs.rm(join(agentDir(root), "pipe"), { force: true });
}

/** The device-wide signer settings (`agent/config.json`). */
export type AgentSettings = { require_signer?: boolean };

export async function readAgentSettings(root: string): Promise<AgentSettings> {
  const raw = (await readJson(settingsPath(root))) as AgentSettings | undefined;
  return { require_signer: raw?.require_signer === true };
}

export async function writeAgentSettings(root: string, settings: AgentSettings, env: FsEnv): Promise<void> {
  await writeJson(settingsPath(root), settings, env);
}

/**
 * What the signer does with its endpoint's file before and after it listens, and how it tells its
 * own endpoint from anything else at that path (`id`: undefined when nothing is there).
 */
export type EndpointFiles = {
  clear: (endpoint: string) => Promise<void>;
  secure: (endpoint: string) => Promise<void>;
  id: (endpoint: string) => Promise<string | undefined>;
};

/**
 * POSIX: a stale socket file from a signer that died is removed before listening, the new socket
 * is made 0600 (inside the 0700 directory), and its inode is its identity: a socket renamed away,
 * or another put in its place, has another (or none). A Windows pipe is no file and cannot be
 * renamed; its name is fresh for each start (agentEndpoint).
 */
export function endpointFiles(platform: Platform): EndpointFiles {
  if (platform === "win32") return { clear: async () => undefined, secure: async () => undefined, id: async () => "pipe" };
  return {
    clear: (endpoint) => fs.rm(endpoint, { force: true }),
    secure: (endpoint) => fs.chmod(endpoint, 0o600),
    id: (endpoint) => fs.lstat(endpoint, { bigint: true }).then((s) => `${s.dev}:${s.ino}`, () => undefined),
  };
}
