// `wim agent init`: the starting configs, with REPLACE-ME wherever only the person knows the
// value. Senders are taken by device id from the roster, never by name: a name is the sender's
// own choice, and a name given here is refused with the id it belongs to.

import { PLACEHOLDER } from "./doctor.ts";

export type InitMode = "direct" | "privileged";
export type AuthMode = "api-key" | "wif";

export interface InitOptions {
  mode: InitMode;
  /** What `--allow` named: device ids (a name is refused). Empty: a placeholder. */
  allow: readonly string[];
  /** The roster's devices, to check `allow` against and to list for the person. */
  roster: readonly { id: string; name: string }[];
  /** This device's id: never a sender of its own work. */
  self: string;
  room?: string;
  /** Profiles a task may name as `<name>:`; the first is the default. Empty: no prefix. */
  profiles: readonly string[];
  auth: AuthMode;
  /** A file holding the wake code (direct mode; the peer reads it). Unset: no code here. */
  wakeFile?: string;
  /** The command line that runs this wim: [node, wim.mjs] from a bundle. */
  wim: readonly string[];
  ledgerPath: string;
  /** The privileged runner's launcher (sudoers allows exactly it). */
  launcher: string;
}

/** The limits `init` writes: one job at a time, and a 15 s grace between SIGTERM and SIGKILL. */
export const LIMITS = { maxTaskChars: 16_000, perSenderPerHour: 20, dailyJobs: 50, timeoutSeconds: 1800 } as const;

/** The peer's timeout in front of the privileged runner: its lock wait and job time, and a minute. */
export const PRIVILEGED_PEER_TIMEOUT = 900 + LIMITS.timeoutSeconds + 60;

/** Why `allow` cannot be used as given, in one line, or undefined. */
export function allowProblem(o: Pick<InitOptions, "allow" | "roster" | "self">): string | undefined {
  for (const a of o.allow) {
    if (a === o.self) return `${a} is this device: list the devices that send this worker work`;
    if (o.roster.some((d) => d.id === a)) continue;
    const byName = o.roster.filter((d) => d.name === a);
    if (byName.length > 0) return `${a} is a device name; senders are allowed by id, never by name (a sender picks its own name): use ${byName.map((d) => d.id).join(" or ")}`;
    return `${a} is not a device id in this mesh's roster (\`wim devices\`)`;
  }
  return undefined;
}

/** The worker config `init` writes, as plain JSON. */
export function workerTemplate(o: InitOptions): Record<string, unknown> {
  const privileged = o.mode === "privileged";
  // The privileged runner holds the code, and the profile prefix follows it, so it parses both.
  const wake = privileged ? { mode: "runner" } : o.wakeFile === undefined ? { mode: "none" } : { mode: "local", codeFile: o.wakeFile };
  return {
    senders: { devices: o.allow.length === 0 ? [PLACEHOLDER] : [...o.allow], requireTrusted: true },
    wake,
    ...(privileged || o.profiles.length === 0 ? {} : { profiles: { allowed: [...o.profiles], default: o.profiles[0] } }),
    runner: privileged
      ? // The privileged runner waits for its lock (up to 900 s) and then runs the job (up to 1800 s)
        // and answers a timeout itself (exit 5); the peer's own limit only catches a runner that hangs.
        { command: "sudo", args: ["-n", o.launcher], timeoutSeconds: PRIVILEGED_PEER_TIMEOUT, killGraceSeconds: 15, passEnv: ["PATH", "LANG", "TZ"] }
      : { command: o.wim[0], args: [...o.wim.slice(1), "agent", "runner"], timeoutSeconds: LIMITS.timeoutSeconds, killGraceSeconds: 15 },
    limits: { ledgerPath: o.ledgerPath, maxTaskChars: LIMITS.maxTaskChars, perSenderPerHour: LIMITS.perSenderPerHour, dailyJobs: LIMITS.dailyJobs },
    replies: { refused: "generic", ...(o.room === undefined ? {} : { room: o.room }) },
  };
}

/** The privileged runner's config `init --mode privileged` writes, for root to install. */
export function privilegedTemplate(o: InitOptions): Record<string, unknown> {
  const names = o.profiles.length === 0 ? ["default"] : o.profiles;
  const auth = (name: string) =>
    o.auth === "api-key"
      ? { type: "api-key", keyFile: `/etc/wim-agent/${name}.key` }
      : { type: "wif", organizationId: PLACEHOLDER, federationRuleId: PLACEHOLDER, serviceAccountId: PLACEHOLDER, identity: { type: "file", path: PLACEHOLDER } };
  return {
    profiles: Object.fromEntries(names.map((n) => [n, { auth: auth(n) }])),
    defaultProfile: names[0],
    wakeCode: { file: "/etc/wim-agent/wake-code" },
    timeoutSeconds: LIMITS.timeoutSeconds,
    maxTaskChars: LIMITS.maxTaskChars,
    dailyJobs: LIMITS.dailyJobs,
    ...(o.allow.length === 0 ? {} : { allowDevices: [...o.allow] }),
  };
}

/** The lines `init` prints: the roster to choose from, by id, and what is left to do. */
export function initNotes(o: InitOptions, path: string, left: readonly string[]): string[] {
  const others = o.roster.filter((d) => d.id !== o.self);
  return [
    `Wrote ${path}.`,
    ...(others.length === 0 ? ["This mesh has no other device yet: `wim invite` adds one, and its id goes in senders.devices."] : ["Devices in this mesh (allow by id; names are the sender's choice):", ...others.map((d) => `  ${d.id}  ${d.name}`)]),
    ...(left.length === 0 ? [] : [`Still to fill in: ${left.join(", ")}.`]),
    `Then \`wim agent doctor ${path}\` checks the install, and \`wim agent serve ${path}\` starts it.`,
  ];
}
