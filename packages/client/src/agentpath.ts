// Where the signer (`wim agent`) lives on disk: its private directory under the state directory,
// its endpoint (a Unix socket, or a named pipe on Windows), its log and its settings.

import { b64u, randomBytes } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { SetupError } from "./errors.ts";
import { ensureDir, readJson, readText, writeJson, writeNew, type FsEnv } from "./fsx.ts";
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
 * The signer's endpoint. `create` (the signer starting) makes the directory and, on Windows, the
 * pipe token; otherwise undefined means no signer was ever set up here. Throws a SetupError when
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

/** The random part of the pipe name, made once (by the first signer) and kept. */
async function pipeToken(path: string, env: FsEnv, create: boolean): Promise<string | undefined> {
  const kept = (await readText(path))?.trim();
  if (kept !== undefined || !create) return kept;
  // Two signers starting at once: one write wins, and both read what it wrote.
  await writeNew(path, b64u.encode(randomBytes(16)), env).catch(() => undefined);
  return (await readText(path))!.trim();
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

/** What the signer does with its endpoint's file before and after it listens. */
export type EndpointFiles = { clear: (endpoint: string) => Promise<void>; secure: (endpoint: string) => Promise<void> };

/**
 * POSIX: a stale socket file from a signer that died is removed before listening, and the new
 * socket is made 0600 (inside the 0700 directory). A Windows pipe is no file: nothing to do.
 */
export function endpointFiles(platform: Platform): EndpointFiles {
  if (platform === "win32") return { clear: async () => undefined, secure: async () => undefined };
  return { clear: (endpoint) => fs.rm(endpoint, { force: true }), secure: (endpoint) => fs.chmod(endpoint, 0o600) };
}
