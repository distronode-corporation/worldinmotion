import { z } from "zod";

/** A room name; every source posts to `#ci` unless it says otherwise. */
const Room = z.string().min(1).default("#ci");

/** Names of environment variables only: the token itself never goes in a config file. */
const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name");

const Refs = z.array(z.string().min(1)).min(1).optional();

/** An https base URL with no credentials, query or fragment, so nothing secret can ride in it. */
const BaseUrl = z
  .string()
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "must be a URL" });
      return;
    }
    if (url.protocol !== "https:") ctx.addIssue({ code: "custom", message: "must use https" });
    if (url.username !== "" || url.password !== "") {
      ctx.addIssue({ code: "custom", message: "must not carry credentials; use tokenEnv" });
    }
    if (url.search !== "" || url.hash !== "") {
      ctx.addIssue({ code: "custom", message: "must not have a query or fragment" });
    }
  })
  .transform((value) => value.replace(/\/+$/, ""))
  .default("https://gitlab.com");

const GitLabSource = z.strictObject({
  type: z.literal("gitlab"),
  baseUrl: BaseUrl,
  /** A numeric project id, or the full path such as `group/subgroup/project`. */
  project: z.union([
    z.number().int().positive(),
    z.string().regex(/^[\w.-]+(\/[\w.-]+)+$/, "must be a numeric id or a group/project path"),
  ]),
  refs: Refs,
  room: Room,
  tokenEnv: EnvName.default("GITLAB_TOKEN"),
});

const GitHubSource = z.strictObject({
  type: z.literal("github"),
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/, "must be a GitHub owner name"),
  repo: z.string().regex(/^[A-Za-z0-9._-]+$/, "must be a GitHub repository name"),
  refs: Refs,
  room: Room,
  tokenEnv: EnvName.default("GITHUB_TOKEN"),
});

const ConfigSchema = z
  .strictObject({
    /** The JSON file that remembers what has been announced, so a restart stays quiet. */
    statePath: z.string().min(1),
    intervalSeconds: z.number().min(10).default(30),
    /** Announce the current state of recently updated pipelines on the very first run. */
    announceOnStart: z.boolean().default(false),
    sources: z.array(z.discriminatedUnion("type", [GitLabSource, GitHubSource])).min(1),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.sources.forEach((source, i) => {
      const key = sourceKey(source);
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", path: ["sources", i], message: `duplicate source ${key}` });
      }
      seen.add(key);
    });
  });

export type CiConfig = z.infer<typeof ConfigSchema>;
export type SourceConfig = CiConfig["sources"][number];
export type GitLabSourceConfig = Extract<SourceConfig, { type: "gitlab" }>;
export type GitHubSourceConfig = Extract<SourceConfig, { type: "github" }>;

/** A stable identity for a source, used as its key in the state file. */
export function sourceKey(source: SourceConfig): string {
  return source.type === "gitlab"
    ? `gitlab:${source.baseUrl}:${String(source.project)}`
    : `github:${source.owner}/${source.repo}`;
}

/** Validates a config given as JSON text or as an already parsed value. */
export function loadConfig(json: unknown): CiConfig {
  const value = typeof json === "string" ? (JSON.parse(json) as unknown) : json;
  const parsed = ConfigSchema.safeParse(value);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`invalid ci config:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
