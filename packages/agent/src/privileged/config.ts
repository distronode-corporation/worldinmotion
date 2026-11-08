// The privileged runner's config: a root-owned JSON file, separate from the worker's config.
// It holds what the unprivileged peer must never see or choose: the profiles and their
// sign-in, the wake code's source, the job user, the lock and the limits.

import { z } from "zod";
import { PROFILE_NAME } from "../config.ts";
import { pinMatches } from "./frame.ts";

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
const key32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "a 32-byte key in base64url");

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
    /** The highest max_tokens a request may ask for (the Agent SDK asks for 128000). */
    maxTokens: z.number().int().min(1).max(1_000_000).default(128_000),
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
    /**
     * The senders who may wake a job, by device id, with their public keys pinned here. `wim agent
     * init <dir>/agent.json --mode privileged --allow <ids>` writes them, and `recipient`, from the
     * signed roster. The runner checks each frame's signature against these keys itself, so a
     * compromised peer cannot claim another sender.
     */
    senders: z
      .record(z.string().regex(/^[A-Za-z0-9_-]{22}$/), z.strictObject({ sign: key32, box: key32 }))
      .refine((s) => Object.entries(s).every(([id, k]) => pinMatches(id, k.sign)), { message: "each sender's id must be the one its sign key names" })
      .refine((s) => Object.keys(s).length > 0, { message: "at least one sender" })
      .optional(),
    /** The receiving session: its device's key files (owned by the peer user), mesh and address. */
    recipient: z
      .strictObject({
        home: absolute,
        mesh: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        address: z.string().regex(/^[a-z0-9-]{1,32}@[a-z0-9-]{1,32}$/),
        user: unixUser,
      })
      .optional(),
    /** The API the proxy forwards to. */
    apiUrl: z.string().regex(/^https:\/\/[^/\s]+$|^http:\/\/127\.0\.0\.1:\d+$/, "https://host, or http://127.0.0.1:port for a test").default("https://api.anthropic.com"),
    allowLocal: z.boolean().default(false),
    wakeCode: WakeCode.optional(),
    defaultProfile: profileName,
    profiles: z.record(profileName, Profile),
  })
  .refine((c) => c.defaultProfile in c.profiles, { message: "defaultProfile must name a profile" })
  .refine((c) => c.senders !== undefined || c.allowLocal, { message: "set senders, or allowLocal for local jobs only: a runner that would take a job from anyone does not start" })
  .refine((c) => (c.senders === undefined) === (c.recipient === undefined), { message: "senders and recipient go together" });

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

/** Who must own a file the runner reads, and whether it is a secret (no group or other bits at all). */
export interface ReadRule {
  /** The owner's uid; undefined skips the owner and mode checks (a non-root trial). */
  owner: number | undefined;
  secret: boolean;
}

/**
 * Reads a file without following a symlink, checking the owner and mode of the file it opened
 * (not of a path that could be swapped in between).
 */
export interface SecureRead {
  (path: string, rule: ReadRule): Promise<string>;
}

/** Why a file's owner and mode are not acceptable, or undefined when they are. */
export function ownerProblem(facts: { uid: number; mode: number; isFile: boolean }, rule: ReadRule): string | undefined {
  if (rule.owner === undefined) return undefined;
  if (!facts.isFile) return "it is not a regular file";
  if (facts.uid !== rule.owner) return `it is not owned by uid ${rule.owner}`;
  if (rule.secret && (facts.mode & 0o077) !== 0) return `it is readable by group or others (mode ${(facts.mode & 0o777).toString(8)})`;
  if ((facts.mode & 0o022) !== 0) return `it is writable by group or others (mode ${(facts.mode & 0o777).toString(8)})`;
  return undefined;
}

/** Reads and checks the config. As root, the file must be root-owned, not a symlink, and not writable by others. */
export async function loadPrivilegedConfig(path: string, read: SecureRead, euid: number): Promise<PrivilegedConfig> {
  const text = await read(path, { owner: euid === 0 ? 0 : undefined, secret: false });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // The parser's message quotes the text; the config is not secret, but keep one rule for all.
    throw new ConfigError(`${path}: not valid JSON`);
  }
  return parsePrivilegedConfig(raw);
}
