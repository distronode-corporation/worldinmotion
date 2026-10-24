import { z } from "zod";
import { checkAgentUrl, hostHeaderName, isLoopbackHost, LOOPBACK_NAMES, normalizeHostName } from "./net.ts";

const positiveInt = z.number().int().positive();
/** SPEC.md section 2: session names are 1 to 32 characters of `[a-z0-9-]`. */
const sessionName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "must be a session name ([a-z0-9-], 1 to 32)");
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name");

const agentUrl = z.string().superRefine((raw, ctx) => {
  try {
    checkAgentUrl(raw);
  } catch (err) {
    ctx.addIssue({ code: "custom", message: (err as Error).message });
  }
});

const InboundSchema = z
  .strictObject({
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().min(0).max(65_535).default(41_241),
    /** Required, with `tls`, to bind anything other than loopback. */
    allowNonLoopback: z.boolean().default(false),
    /** PEM files for HTTPS. Required for a non-loopback bind. */
    tls: z.strictObject({ certPath: z.string().min(1), keyPath: z.string().min(1) }).optional(),
    /** Host names accepted in the Host header (DNS rebinding guard). Default the loopback names. */
    publicHosts: z
      .array(
        z
          .string()
          .refine((h) => hostHeaderName(normalizeHostName(h)) !== undefined, "must be a host name or IP address"),
      )
      .min(1)
      .optional(),
    /** The URL the agent card advertises, when a proxy sits in front. */
    publicUrl: z.url().optional(),
    /** The environment variable holding the bearer token A2A clients must send. */
    tokenEnv: envName,
    name: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    /** The peer a message goes to when it names none. */
    defaultTo: z.string().min(1).optional(),
    taskTimeoutSeconds: positiveInt.default(300),
    maxTasks: positiveInt.default(1000),
    taskTtlSeconds: positiveInt.default(3600),
    cardRequiresAuth: z.boolean().default(true),
  })
  .superRefine((c, ctx) => {
    if (!isLoopbackHost(c.host) && !c.allowNonLoopback) {
      ctx.addIssue({
        code: "custom",
        path: ["host"],
        message: "binding beyond loopback needs allowNonLoopback: true",
      });
    }
    if (!isLoopbackHost(c.host) && c.tls === undefined) {
      ctx.addIssue({ code: "custom", path: ["tls"], message: "binding beyond loopback needs tls" });
    }
    const hosts = (c.publicHosts ?? LOOPBACK_NAMES).map(normalizeHostName);
    if (c.publicUrl !== undefined && !hosts.includes(normalizeHostName(new URL(c.publicUrl).hostname))) {
      ctx.addIssue({
        code: "custom",
        path: ["publicUrl"],
        message: "its host must be one of publicHosts, or requests to it are refused",
      });
    }
    // A task must outlive its own deadline, or its result would have nowhere to land.
    if (c.taskTtlSeconds <= c.taskTimeoutSeconds) {
      ctx.addIssue({
        code: "custom",
        path: ["taskTtlSeconds"],
        message: "must be longer than taskTimeoutSeconds",
      });
    }
  });

const OutboundSchema = z.strictObject({
  agents: z
    .array(
      z.strictObject({
        name: sessionName,
        cardUrl: agentUrl,
        authHeaderEnv: envName.optional(),
      }),
    )
    .min(1),
  requestTimeoutSeconds: positiveInt.default(15),
  defaultDeadlineSeconds: positiveInt.default(300),
  maxDeadlineSeconds: positiveInt.default(3600),
  maxConcurrent: positiveInt.default(4),
});

const ConfigSchema = z
  .strictObject({
    inbound: InboundSchema.optional(),
    outbound: OutboundSchema.optional(),
  })
  .refine((c) => c.inbound !== undefined || c.outbound !== undefined, {
    message: "configure inbound, outbound, or both",
  });

export type GatewayConfig = z.infer<typeof ConfigSchema>;

/** Validates a parsed config file. Throws one readable line per problem. */
export function loadConfig(raw: unknown): GatewayConfig {
  const r = ConfigSchema.safeParse(raw);
  if (r.success) return r.data;
  const lines = r.error.issues.map((i) => `${i.path.length > 0 ? i.path.join(".") : "config"}: ${i.message}`);
  throw new Error(`invalid a2a config:\n${lines.join("\n")}`);
}
