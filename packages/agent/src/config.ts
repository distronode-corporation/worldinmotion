import { z } from "zod";

const positiveInt = z.number().int().positive();

/** A wim device id as the roster lists it (`wim devices`): never a display or session name. */
const DeviceId = z.string().regex(/^[A-Za-z0-9_-]{22}$/, "a 22-character device id from `wim devices`, not a name");

/** A profile (account) name a message may start with, as `<name>:`. */
export const PROFILE_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const ProfileName = z.string().regex(PROFILE_NAME, "1 to 32 of A-Z, a-z, 0-9, _ and -");

/** An environment variable name. */
const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "an environment variable name");

/** What the runner may see of the worker's environment unless the config says otherwise. */
export const DEFAULT_PASS_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "ANTHROPIC_API_KEY"];

const ConfigSchema = z
  .strictObject({
    /** Who may wake the worker. */
    senders: z.strictObject({
      /**
       * Device ids, from the signed roster (`wim devices`). A sender's session or display name is
       * chosen by the sender, so it is never checked; the device id is the key that signed the item.
       */
      devices: z.array(DeviceId).min(1),
      /**
       * Also require the person's own trust for the device (`wim devices trust`), read again for
       * each message, so taking trust away stops the worker at once. On by default.
       */
      requireTrusted: z.boolean().default(true),
    }),
    /** The optional wake code: a shared secret a message must start with. */
    wake: z
      .strictObject({
        /**
         * `local`: the code is read here (from `codeFile` or `codeEnv`), checked in constant time
         * and stripped before the runner sees the text. `runner`: the worker never holds the code;
         * the raw text goes to the runner, which checks it (and parses any profile prefix, which
         * sits after the code). `none`: no code; the device allow-list is the only key.
         */
        mode: z.enum(["local", "runner", "none"]),
        codeFile: z.string().min(1).optional(),
        codeEnv: EnvName.optional(),
      })
      .refine((w) => w.mode !== "local" || (w.codeFile === undefined) !== (w.codeEnv === undefined), {
        message: "wake.mode local needs exactly one of wake.codeFile and wake.codeEnv",
      })
      .refine((w) => w.mode === "local" || (w.codeFile === undefined && w.codeEnv === undefined), {
        message: "wake.codeFile and wake.codeEnv are only read when wake.mode is local",
      }),
    /** Profiles (accounts) a task may name with a `<name>:` prefix. Absent: no prefix is parsed. */
    profiles: z
      .strictObject({
        allowed: z.array(ProfileName).min(1),
        /** Used when the task names none. */
        default: ProfileName,
      })
      .refine((p) => p.allowed.includes(p.default), { message: "profiles.default must be one of profiles.allowed" })
      .optional(),
    /** The command that runs one job (README, "The runner contract"). */
    runner: z.strictObject({
      /** An absolute path, or a name looked up on PATH. `wim worker init` writes the built-in runner's. */
      command: z.string().min(1),
      /** Fixed arguments. Nothing from a message is ever put on the command line. */
      args: z.array(z.string()).default([]),
      timeoutSeconds: z.number().positive().max(86_400).default(1800),
      /** After the timeout: SIGTERM to the runner's process group, then SIGKILL this much later. */
      killGraceSeconds: z.number().nonnegative().max(600).default(15),
      /** The only environment variables the runner inherits from the worker. */
      passEnv: z.array(EnvName).default(DEFAULT_PASS_ENV),
      /** Copy the runner's stderr to the worker's log (capped per line). */
      logStderr: z.boolean().default(true),
    }),
    limits: z.strictObject({
      /** The JSON file that holds today's job count, so a restart does not reset the daily cap. */
      ledgerPath: z.string().min(1),
      /** Longest task accepted, in characters, counted on the text as it arrives. */
      maxTaskChars: positiveInt.max(60_000).default(16_000),
      /** Attempts (accepted or not) per sender device in any rolling hour, so a code cannot be guessed. */
      perSenderPerHour: positiveInt.default(20),
      /** Jobs started per UTC day, across all senders. */
      dailyJobs: positiveInt.default(50),
    }),
    replies: z
      .strictObject({
        /**
         * What an allowed device hears when its message is refused (bad code or profile, or the
         * runner's exit 3): a fixed "not accepted", or nothing. A device not on the allow-list
         * never hears anything.
         */
        refused: z.enum(["generic", "silent"]).default("generic"),
        /** A room that also gets a copy of each answer: the answer only, never the task or code. */
        room: z.string().regex(/^#[a-z0-9-]{1,32}$/, "a room such as #agents").optional(),
      })
      .default({ refused: "generic" }),
  })
  .refine((c) => c.profiles === undefined || c.wake.mode !== "runner", {
    message: "with wake.mode runner the profile prefix follows the code, so the runner parses it: remove profiles",
  })
  .refine((c) => c.wake.codeEnv === undefined || !c.runner.passEnv.includes(c.wake.codeEnv), {
    message: "runner.passEnv must not pass the wake code's variable to the runner",
  });

export type WorkerConfig = z.infer<typeof ConfigSchema>;

/** Validates a parsed JSON config, with every problem on one line each. */
export function loadConfig(raw: unknown): WorkerConfig {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.length === 0 ? "config" : i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid worker config:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
