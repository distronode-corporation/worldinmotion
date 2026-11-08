// The job itself, run as the unprivileged worker user: one Claude Agent SDK query. It gets the
// prompt on stdin and its options in WIM_AGENT_JOB, and its sign-in only as the variables the
// SDK reads (Workload Identity Federation's, or an API key). Its stdout is the answer; its stderr
// carries `worker:` status lines, the only ones the privileged side passes on.

import { z } from "zod";

const JobOptions = z.strictObject({
  model: z.string(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  maxTurns: z.number().int().min(1),
  tools: z.array(z.string()),
  cwd: z.string(),
  additionalDirectories: z.array(z.string()),
  /** Absolute paths the job's file tools may never read (the runner's own files, /proc, /sys). */
  denyRead: z.array(z.string().regex(/^\//)),
  /** Run commands in the SDK's sandbox (bubblewrap on Linux), with the same paths denied. */
  sandbox: z.boolean(),
});
export type JobOptions = z.infer<typeof JobOptions>;

/** The part of the SDK's `query` this uses; the SDK is an optional peer, loaded on demand. */
export type Query = (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<Record<string, unknown>>;

export interface WorkerIO {
  env: Record<string, string | undefined>;
  uid: number;
  readStdin(): Promise<string>;
  out(text: string): void;
  err(line: string): void;
  loadQuery(): Promise<Query>;
}

export async function loadSdkQuery(): Promise<Query> {
  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as { query: Query };
  return sdk.query;
}

/** The options the SDK gets: the profile's tools only, nothing asked, no settings or saved sessions. */
export function sdkOptions(job: JobOptions, env: Record<string, string>, abortController: AbortController): Record<string, unknown> {
  return {
    model: job.model,
    effort: job.effort,
    maxTurns: job.maxTurns,
    // `tools` is the base set the model sees; `allowedTools` lets those run without a prompt,
    // and dontAsk denies anything else instead of waiting for a person who is not there.
    tools: job.tools,
    allowedTools: job.tools,
    permissionMode: "dontAsk",
    cwd: job.cwd,
    additionalDirectories: job.additionalDirectories,
    settingSources: [],
    persistSession: false,
    // The file tools read nothing outside the working directories, and never the denied paths,
    // whatever the model asks for (Read refuses /proc on its own; Grep and Glob do not).
    settings: {
      permissions: {
        deny: job.denyRead.flatMap((p) => [`Read(/${p})`, `Read(/${p}/**)`]),
        blockReadsOutsideWorkingDirectories: true,
      },
    },
    ...(job.sandbox
      ? { sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, filesystem: { denyRead: job.denyRead } } }
      : {}),
    // Replaces the child's environment entirely (the SDK does not merge it).
    env,
    abortController,
  };
}

/** Variables the worker passes on to the SDK's child; nothing else from its own environment. */
// The API key here is the runner's per-job proxy key, good only on its loopback proxy while the
// job runs; ANTHROPIC_BASE_URL points at that proxy. No real credential reaches the job.
const PASS = ["HOME", "PATH", "LANG", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"];

export async function workerMain(io: WorkerIO): Promise<number> {
  if (io.uid === 0) {
    io.err("worker: refusing to run a job as root");
    return 2;
  }
  let raw: unknown = null;
  try {
    raw = JSON.parse(io.env["WIM_AGENT_JOB"] ?? "null");
  } catch {
    // Reported below with every other malformed value.
  }
  const parsed = JobOptions.safeParse(raw);
  if (!parsed.success) {
    io.err("worker: WIM_AGENT_JOB is missing or malformed");
    return 2;
  }
  const env: Record<string, string> = {};
  for (const k of PASS) {
    const v = io.env[k];
    if (v !== undefined) env[k] = v;
  }
  const prompt = await io.readStdin();
  const query = await io.loadQuery();
  let code = 1;
  try {
    for await (const m of query({ prompt, options: sdkOptions(parsed.data, env, new AbortController()) })) {
      if (m["type"] !== "result") continue;
      const text = typeof m["result"] === "string" ? m["result"] : String(m["subtype"]);
      io.out(text);
      io.err(`worker: cost_usd ${String(m["total_cost_usd"])} turns ${String(m["num_turns"])}`);
      code = m["is_error"] === true ? 1 : 0;
    }
  } catch (error) {
    // The SDK throws after an error result (max turns, say); the result line already went out.
    // One line, cut short: an SDK error can quote the prompt.
    io.err(`worker: error ${(error as Error).name}`);
    code = 1;
  }
  return code;
}
