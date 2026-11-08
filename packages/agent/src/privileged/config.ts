// The privileged runner's config: a root-owned JSON file, separate from the worker's config.
// It holds what the unprivileged peer must never see or choose: the profiles and their
// sign-in, the wake code's source, the job user, the lock and the limits.

import { z } from "zod";
import { PROFILE_NAME } from "../config.ts";

export const PRIVILEGED_CONFIG_PATH = "/etc/wim-agent/privileged.json";
export const PRIVILEGED_RUNNER_PATH = "/usr/local/sbin/wim-agent-privileged-runner";

/** The one sudoers line a deployment needs: the runner, no arguments at all (`""`). */
export function sudoersLine(peerUser: string): string {
  return `${peerUser} ALL=(root) NOPASSWD: ${PRIVILEGED_RUNNER_PATH} ""`;
}

/** Tools that read files and nothing else. Any other tool needs `unsafeTools: true`. */
export const READ_ONLY_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];

export const ANTHROPIC_AUDIENCE = "https://api.anthropic.com";

const absolute = z.string().regex(/^\/[^\0]*$/, "must be an absolute path");
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "must be an id of letters, digits, _ and -");
const unixUser = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/, "must be a user name");
const profileName = z.string().regex(PROFILE_NAME, "must be 1 to 32 of A-Z, a-z, 0-9, _ and -");
const seconds = (max: number) => z.number().int().min(1).max(max);

const Identity = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("aws-sts"), region: z.string().regex(/^[a-z0-9-]{1,32}$/), durationSeconds: z.number().int().min(60).max(3600).default(600) }),
  z.strictObject({ type: z.literal("gcp-metadata") }),
  z.strictObject({ type: z.literal("gcp-impersonate"), serviceAccount: z.string().regex(/^[^\s/@]+@[^\s/@]+$/, "must be a service account email") }),
  z.strictObject({ type: z.literal("file"), path: absolute }),
]);

const Auth = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("api-key"), keyFile: absolute }),
  z.strictObject({
    type: z.literal("wif"),
    organizationId: id,
    federationRuleId: id,
    serviceAccountId: id,
    workspaceId: id.optional(),
    audience: z.string().url().default(ANTHROPIC_AUDIENCE),
    identity: Identity,
  }),
]);

const Profile = z
  .strictObject({
    model: z.string().regex(/^[a-z0-9.-]{1,64}$/).default("claude-opus-5-5"),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
    maxTurns: z.number().int().min(1).max(500).default(20),
    tools: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)).max(64).default([...READ_ONLY_TOOLS]),
    unsafeTools: z.boolean().default(false),
    auth: Auth,
  })
  .refine((p) => p.unsafeTools || p.tools.every((t) => READ_ONLY_TOOLS.includes(t)), {
    message: `tools other than ${READ_ONLY_TOOLS.join(", ")} need "unsafeTools": true`,
  });

const WakeCode = z.union([z.strictObject({ file: absolute }), z.strictObject({ env: z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/) })]);

const Config = z
  .strictObject({
    v: z.literal(1),
    worker: z
      .strictObject({
        user: unixUser.default("wim-agent-worker"),
        home: absolute.default("/var/lib/wim-agent-worker"),
        cwd: absolute.optional(),
        additionalDirectories: z.array(absolute).max(16).default([]),
      })
      .default({ user: "wim-agent-worker", home: "/var/lib/wim-agent-worker", additionalDirectories: [] }),
    runDir: absolute.default("/run/wim-agent"),
    lock: z.strictObject({ path: absolute.default("/run/wim-agent/job.lock"), waitSeconds: z.number().int().min(0).max(86_400).default(900) }).default({ path: "/run/wim-agent/job.lock", waitSeconds: 900 }),
    minMemAvailableMb: z.number().int().min(0).default(900),
    timeoutSeconds: seconds(86_400).default(1800),
    killGraceSeconds: seconds(300).default(15),
    maxTaskChars: z.number().int().min(1).max(60_000).default(16_000),
    dailyJobs: z.number().int().min(0).default(50),
    statePath: absolute.default("/var/lib/wim-agent-privileged/state.json"),
    allowDevices: z.array(z.string().regex(/^[A-Za-z0-9_-]{16,64}$/)).optional(),
    allowLocal: z.boolean().default(false),
    wakeCode: WakeCode.optional(),
    defaultProfile: profileName,
    profiles: z.record(profileName, Profile),
  })
  .refine((c) => c.defaultProfile in c.profiles, { message: "defaultProfile must name a profile" });

export type PrivilegedConfig = z.infer<typeof Config> & { worker: { cwd: string } };
export type Profile = z.infer<typeof Profile>;
export type Auth = z.infer<typeof Auth>;
export type Identity = z.infer<typeof Identity>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Validates a parsed config; every problem is named with its path. */
export function parsePrivilegedConfig(raw: unknown): PrivilegedConfig {
  const r = Config.safeParse(raw);
  if (!r.success) {
    throw new ConfigError(r.error.issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`).join("; "));
  }
  const c = r.data;
  return { ...c, worker: { ...c.worker, cwd: c.worker.cwd ?? `${c.worker.home}/work` } };
}

export interface FileFacts {
  uid: number;
  mode: number;
}

export interface ConfigFs {
  readFile(path: string): Promise<string>;
  stat(path: string): Promise<FileFacts>;
}

/**
 * Refuses a file a non-root user could have written when we run as root: owned by root, no
 * group or other write bit. `secret` also refuses any group or other bit at all.
 */
export function rootOwnedProblem(facts: FileFacts, secret: boolean): string | undefined {
  if (facts.uid !== 0) return "it is not owned by root";
  if (secret && (facts.mode & 0o077) !== 0) return `it is readable by group or others (mode ${(facts.mode & 0o777).toString(8)})`;
  if ((facts.mode & 0o022) !== 0) return `it is writable by group or others (mode ${(facts.mode & 0o777).toString(8)})`;
  return undefined;
}

/** Reads and checks the config. As root, the file itself must be root-owned and not writable by others. */
export async function loadPrivilegedConfig(path: string, fs: ConfigFs, euid: number): Promise<PrivilegedConfig> {
  if (euid === 0) {
    const problem = rootOwnedProblem(await fs.stat(path), false);
    if (problem !== undefined) throw new ConfigError(`refusing ${path}: ${problem}`);
  }
  const text = await fs.readFile(path);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${path}: not valid JSON (${(error as Error).message})`);
  }
  return parsePrivilegedConfig(raw);
}
