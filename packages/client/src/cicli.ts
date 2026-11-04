// `wim ci allow|list|remove|notify` (SPEC section 18). The first three are the person's alone:
// the same guard as `wim devices trust` (an interactive terminal, no agent's variables, a typed
// yes), and no MCP tool, message or local UI request reaches them. `notify` is the CI job's side.

import { b64u, ciRecipientCode, gitlabAudience, sanitizeForDisplay, ulid } from "@worldinmotion/protocol";
import { checkRule, CI_RULES_MAX, EVENT_NAME, fullRef, GITHUB_REPO, GITLAB_REPO, loadCiRules, PRIVILEGED_EVENTS, ruleLine, saveCiRules, WORKFLOW_FILE, type CiPins, type CiRule } from "./cirules.ts";
import { ciNotify, GITLAB_TOKEN_VAR } from "./cisend.ts";
import { SetupError } from "./errors.ts";
import type { Device } from "./home.ts";
import type { MeshFiles } from "./mesh.ts";
import { confirmTyped, requirePerson } from "./secretout.ts";

/** The subcommands; any other first word is still the polling watcher's config path (`wim ci <config.json>`). */
export const CI_ACTIONS: readonly string[] = ["allow", "list", "remove", "notify"];

export type CiCliIO = {
  out: (line: string) => void;
  err: (line: string) => void;
  prompt: (question: string) => Promise<string>;
  isTTY: boolean;
  inputIsTTY: boolean;
  fetch: typeof fetch;
  now: () => number;
};

export type CiCli = {
  env: Record<string, string | undefined>;
  io: CiCliIO;
  positional: readonly string[];
  flags: ReadonlyMap<string, string | true>;
  mesh: () => Promise<{ device: Device; files: MeshFiles }>;
};

const value = (c: CiCli, name: string): string | undefined => {
  const v = c.flags.get(name);
  return typeof v === "string" ? v : undefined;
};
const on = (c: CiCli, name: string): boolean => c.flags.get(name) === true;

/** Runs `wim ci <action>`. */
export async function ciCommand(c: CiCli): Promise<number> {
  const action = c.positional[0];
  if (action === "notify") return notify(c);
  if (action === "allow") return allow(c);
  if (action === "list") return list(c);
  return remove(c);
}

/**
 * `wim ci notify`: always exit 0, so a notice never fails the job it reports on. The outcome is
 * one line: on stdout when the relay took the notice, on stderr otherwise.
 */
async function notify(c: CiCli): Promise<number> {
  const text = value(c, "text") ?? (c.positional.length > 1 ? c.positional.slice(1).join(" ") : undefined);
  const req = {
    ...(value(c, "recipient") === undefined ? {} : { recipient: value(c, "recipient")! }),
    ...(value(c, "to") === undefined ? {} : { to: value(c, "to")! }),
    ...(text === undefined ? {} : { text }),
    ...(value(c, "via") === undefined ? {} : { via: value(c, "via")! }),
  };
  const out = await ciNotify(req, { env: c.env, fetch: c.io.fetch, now: c.io.now });
  (out.sent ? c.io.out : c.io.err)(out.line);
  return 0;
}

/** The recipient code for this device in this mesh: what goes in the CI variable. Not a secret. */
async function recipient(files: MeshFiles, device: Device): Promise<{ code: string; mesh: string }> {
  const config = await files.loadConfig();
  return { code: ciRecipientCode({ relay: config.relay, mesh: config.mesh, sign: b64u.encode(device.keyring.signPub) }), mesh: config.mesh };
}

/**
 * The repository's ids from the provider's public API, when it is public; undefined for a private
 * one (or any failure), whose first matching notice is then held so the person's approval pins them.
 */
export async function publicIds(fetcher: typeof fetch, via: "github" | "gitlab", repo: string): Promise<CiPins | undefined> {
  const url = via === "github" ? `https://api.github.com/repos/${repo}` : `https://gitlab.com/api/v4/projects/${encodeURIComponent(repo)}`;
  try {
    const res = await fetcher(url, { headers: { accept: "application/json", "user-agent": "worldinmotion-wim" }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (res.status !== 200) return undefined;
    const body = (await res.json()) as Record<string, unknown>;
    const owner = (via === "github" ? body["owner"] : body["namespace"]) as { id?: unknown } | undefined;
    const name = via === "github" ? body["full_name"] : body["path_with_namespace"];
    const ids = [body["id"], owner?.id];
    if (typeof name !== "string" || name.toLowerCase() !== repo || !ids.every((n) => Number.isSafeInteger(n) && (n as number) > 0)) return undefined;
    const [a, b] = ids.map(String) as [string, string];
    return via === "github" ? { repositoryId: a, ownerId: b } : { projectId: a, namespaceId: b };
  } catch {
    return undefined;
  }
}

const ALLOW_USAGE = "usage: wim ci allow github <owner/repo> --ref <branch> --workflow <file.yml> [--tag] [--event <name,...>] [--environment <name>] [--hold]\n       wim ci allow gitlab <group/project> --ref <branch> [--tag] [--unprotected] [--environment <name>] [--hold]";

/** The rule `wim ci allow` describes, checked; refuses flags that do not apply to the provider. */
function ruleFrom(c: CiCli): CiRule {
  const [, via, rawRepo] = c.positional;
  if ((via !== "github" && via !== "gitlab") || rawRepo === undefined || c.positional.length > 3) throw new SetupError(ALLOW_USAGE);
  const repo = rawRepo.toLowerCase();
  if (!(via === "github" ? GITHUB_REPO : GITLAB_REPO).test(repo)) throw new SetupError(`not a ${via === "github" ? "GitHub owner/repo" : "GitLab group/project"}: ${sanitizeForDisplay(rawRepo)}`);
  const refName = value(c, "ref");
  if (refName === undefined) throw new SetupError(`--ref is required\n${ALLOW_USAGE}`);
  const base = {
    id: ulid(c.io.now()),
    repo,
    ref: fullRef(refName, on(c, "tag")),
    ...(value(c, "environment") === undefined ? {} : { environment: value(c, "environment")! }),
    ...(on(c, "hold") ? { hold: true as const } : {}),
  };
  if (via === "gitlab") {
    if (c.flags.has("workflow") || c.flags.has("event")) throw new SetupError("--workflow and --event are for GitHub rules");
    return checkRule({ ...base, via, ...(on(c, "unprotected") ? { unprotected: true as const } : {}) });
  }
  if (c.flags.has("unprotected")) throw new SetupError("--unprotected is for GitLab rules");
  const workflow = value(c, "workflow");
  if (workflow === undefined || !WORKFLOW_FILE.test(workflow)) throw new SetupError(`--workflow must name the workflow file under .github/workflows/ (deploy.yml)\n${ALLOW_USAGE}`);
  const events = value(c, "event")?.split(",");
  if (events !== undefined && !events.every((e) => EVENT_NAME.test(e))) throw new SetupError("--event takes GitHub event names, comma-separated (push,workflow_dispatch)");
  return checkRule({ ...base, via, workflow, ...(events === undefined ? {} : { events }) });
}

/** What the person reads before allowing a rule. */
function allowLines(rule: CiRule, pins: CiPins | undefined): string[] {
  const who = rule.via === "github" ? "any job of that workflow file on that ref" : "any job of that project on that ref";
  return [
    "Allowing CI notices to this device:",
    `  ${ruleLine({ ...rule, ...(pins === undefined ? {} : { pins }) } as CiRule)}`,
    `Then ${who} (and anything that job runs) can send your sessions information-only notices. They never assign work and never wake a session.`,
    pins === undefined
      ? "The repository's ids could not be read from the provider's public API (a private repository, or no network): the first matching notice is held for you, showing the ids its token carries, and approving it with `wim held approve <id>` pins them."
      : "The repository's ids were read from the provider's public API and are pinned: a recycled name cannot send.",
    ...(rule.via === "github" && rule.events?.some((e) => PRIVILEGED_EVENTS.includes(e)) === true
      ? ["This rule names pull_request_target or workflow_run: a pull request from a fork can steer those runs."]
      : []),
    ...(rule.via === "gitlab"
      ? ["A GitLab token cannot be bound to one notice: anything that can read the job's variables can send one notice as that project until the job times out (set a short timeout:)."]
      : []),
  ];
}

/** A rule's terms, without its id and pins: two rules with the same terms are one. */
const ruleKey = (r: CiRule): string => JSON.stringify({ ...r, id: "", pins: undefined });

/** `wim ci allow`: the person adds a rule. */
async function allow(c: CiCli): Promise<number> {
  requirePerson(c.env, c.io, `wim ci allow ${c.positional.slice(1).join(" ")}`);
  const rule = ruleFrom(c);
  const { device, files } = await c.mesh();
  const rules = await loadCiRules(files.ciRulesPath);
  if (rules.length >= CI_RULES_MAX) throw new SetupError(`this device already has ${CI_RULES_MAX} CI rules; remove one first (wim ci list)`);
  if (rules.some((r) => ruleKey(r) === ruleKey(rule))) throw new SetupError("this rule is already allowed (wim ci list)");
  const pins = await publicIds(c.io.fetch, rule.via, rule.repo);
  if (!(await confirmTyped(c.io, allowLines(rule, pins), "Allow it?"))) return 1;
  await saveCiRules(files.ciRulesPath, [...rules, checkRule({ ...rule, ...(pins === undefined ? {} : { pins }) } as CiRule)], files.env);
  const { code, mesh } = await recipient(files, device);
  c.io.out("Allowed. Sessions of this device that are running tell the relay now; others when they next start.");
  c.io.out(`Recipient code for the job (not a secret): ${code}`);
  if (rule.via === "github") {
    c.io.out("In the job: `permissions: id-token: write`, then `wim ci notify --recipient <code> --to <session> --text <text>`.");
  } else {
    c.io.out(`In the job: \`id_tokens: { ${GITLAB_TOKEN_VAR}: { aud: ${gitlabAudience(mesh, device.id)} } }\` and a short \`timeout:\`, then \`wim ci notify --recipient <code> --to <session> --text <text>\`.`);
  }
  return 0;
}

/** `wim ci list`: the person's rules, numbered, and this device's recipient code. */
async function list(c: CiCli): Promise<number> {
  requirePerson(c.env, c.io, "wim ci list");
  const { device, files } = await c.mesh();
  const rules = await loadCiRules(files.ciRulesPath);
  if (rules.length === 0) c.io.out("No CI rules: this device takes no CI notices.");
  rules.forEach((r, i) => c.io.out(`${i + 1}  ${ruleLine(r)}`));
  c.io.out(`Recipient code (not a secret): ${(await recipient(files, device)).code}`);
  return 0;
}

/** `wim ci remove <n>`: the person removes a rule (`wim ci list` numbers them). */
async function remove(c: CiCli): Promise<number> {
  requirePerson(c.env, c.io, `wim ci remove ${c.positional.slice(1).join(" ")}`);
  const n = Number(c.positional[1]);
  if (!Number.isSafeInteger(n) || n < 1 || c.positional.length !== 2) throw new SetupError("usage: wim ci remove <n> (the number `wim ci list` shows)");
  const { files } = await c.mesh();
  const rules = await loadCiRules(files.ciRulesPath);
  const rule = rules[n - 1];
  if (rule === undefined) throw new SetupError(`no CI rule ${n} (wim ci list)`);
  if (!(await confirmTyped(c.io, ["Removing this CI rule:", `  ${ruleLine(rule)}`, "Its notices are dropped from now on; held ones stay held."], "Remove it?"))) return 1;
  await saveCiRules(files.ciRulesPath, rules.filter((r) => r !== rule), files.env);
  c.io.out("Removed. Sessions of this device that are running tell the relay now; others when they next start.");
  return 0;
}
