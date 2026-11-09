// The person's CI sender rules (SPEC section 18): which repositories, refs and workflows may send
// this device notices. They live in `ci-rules.json` beside the mesh config, change only through
// `wim ci allow|remove` and a held notice's approval at the person's own terminal, and are matched
// exactly, a ref pattern by its prefix. The relay only ever learns a hash of each GitHub rule's
// repository and ref (its tag).

import { CI_REF_MAX, ciRefMatches, ciRuleRefSchema, ciRuleTag, GITHUB_ISSUER, isCiRefPattern, isCiRuleRef, parseJson, sanitizeForDisplay, type CiClaims } from "@worldinmotion/protocol";
import { z } from "zod";
import { readText, withLock, writeJson, type FsEnv } from "./fsx.ts";

/** At most this many rules (the relay holds at most 64 tags per device). */
export const CI_RULES_MAX = 64;

/** The events a fork can steer on the default branch's ref: refused unless a rule names them. */
export const PRIVILEGED_EVENTS: readonly string[] = ["pull_request_target", "workflow_run"];

const id = z.string().regex(/^[0-9]{1,20}$/);
// A full ref or a ref pattern (one trailing `*`), as the protocol defines them; any other spelling
// makes the whole file invalid (SPEC section 18).
const ref = ciRuleRefSchema;
const environment = z.string().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]+$/);
const ruleId = z.string().regex(/^[0-9A-Z]{26}$/);

/** `owner/repo`, lower-cased. */
export const GITHUB_REPO = /^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/;
/** `group/subgroup/project`, lower-cased. */
export const GITLAB_REPO = /^[a-z0-9_.-]{1,255}(\/[a-z0-9_.-]{1,255}){1,20}$/;
/** A workflow file directly under `.github/workflows/`. */
export const WORKFLOW_FILE = /^[A-Za-z0-9_.-]{1,200}\.ya?ml$/;
/** A GitHub event name. */
export const EVENT_NAME = /^[a-z_]{1,64}$/;

const githubRule = z.strictObject({
  id: ruleId,
  via: z.literal("github"),
  repo: z.string().regex(GITHUB_REPO),
  ref,
  workflow: z.string().regex(WORKFLOW_FILE),
  events: z.array(z.string().regex(EVENT_NAME)).min(1).max(16).optional(),
  environment: environment.optional(),
  hold: z.literal(true).optional(),
  pins: z.strictObject({ repositoryId: id, ownerId: id }).optional(),
});

const gitlabRule = z.strictObject({
  id: ruleId,
  via: z.literal("gitlab"),
  repo: z.string().regex(GITLAB_REPO),
  ref,
  unprotected: z.literal(true).optional(),
  environment: environment.optional(),
  hold: z.literal(true).optional(),
  pins: z.strictObject({ projectId: id, namespaceId: id }).optional(),
});

const ruleSchema = z.discriminatedUnion("via", [githubRule, gitlabRule]);
const fileSchema = z.strictObject({ v: z.literal(1), rules: z.array(ruleSchema).max(CI_RULES_MAX) });

export type GithubRule = z.infer<typeof githubRule>;
export type GitlabRule = z.infer<typeof gitlabRule>;
export type CiRule = z.infer<typeof ruleSchema>;
/** The ids a rule pins: a GitHub repository's and owner's, or a GitLab project's and namespace's. */
export type CiPins = Record<string, string>;

/** Checks a rule before it is written; throws a readable error for anything the file would refuse. */
export function checkRule(rule: CiRule): CiRule {
  const parsed = ruleSchema.safeParse(rule);
  if (!parsed.success) throw new TypeError(`invalid CI rule: ${parsed.error.issues[0]!.path.join(".")}: ${parsed.error.issues[0]!.message}`);
  return parsed.data;
}

/**
 * The rules on disk, or undefined when there is no file. Throws on a file that is not exactly a
 * rules file: the command line shows that, and a session then allows nothing.
 */
export async function readCiRules(path: string): Promise<CiRule[] | undefined> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  const json = parseJson(text);
  const parsed = json.ok ? fileSchema.safeParse(json.value) : undefined;
  if (parsed?.success !== true) throw new Error(`${path}: not a valid CI rules file`);
  return parsed.data.rules;
}

/** The rules on disk; none when there is no file. Throws like `readCiRules`. */
export async function loadCiRules(path: string): Promise<CiRule[]> {
  return (await readCiRules(path)) ?? [];
}

/** Writes the rules (0600, atomically). */
export async function saveCiRules(path: string, rules: readonly CiRule[], env: FsEnv): Promise<void> {
  await writeJson(path, fileSchema.parse({ v: 1, rules }), env);
}

/**
 * Changes the rules on disk under their own lock: reads them again, hands them to `change` (which
 * may throw to refuse), and writes what it returns. Every change to `ci-rules.json` goes through
 * here, after the person's confirmation, so two commands in two terminals never write back a list
 * the other changed in the meantime.
 */
export async function updateCiRules(path: string, env: FsEnv, change: (rules: CiRule[]) => CiRule[]): Promise<void> {
  await withLock(`${path}.lock`, async () => saveCiRules(path, change(await loadCiRules(path)), env), env);
}

/** Which flag of `wim ci allow` names the ref: `--ref` or `--tag`. */
export type RefFlag = "ref" | "tag";

/**
 * The full ref or ref pattern a person means: `--tag 'v*'` is `refs/tags/v*` (a tag name, never a
 * full ref), and `--ref` keeps a full ref or pattern (`refs/heads/release/*`) as it is and reads a
 * bare name as a branch (`--ref main`, `--ref 'release/*'`). Not checked here: `refRefusal` says
 * what is wrong with one.
 */
export function ruleRef(flag: RefFlag, name: string): string {
  if (flag === "tag") return `refs/tags/${name}`;
  return name.startsWith("refs/") ? name : `refs/heads/${name}`;
}

/**
 * What git refuses in a ref that the rule grammar takes (git check-ref-format): a rule for one can
 * never match a real token, so it would do nothing. For a pattern, its prefix: a sequence there is
 * in every ref it matches, but its last part goes on past the `*`, so only a trailing `/` and a
 * part ending in `.lock` or `.` count for a full ref alone. Undefined when git takes it.
 */
export function gitRefRefusal(ref: string): string | undefined {
  const pattern = isCiRefPattern(ref);
  const name = pattern ? ref.slice(0, -1) : ref;
  const parts = name.split("/");
  const done = pattern ? parts.slice(0, -1) : parts;
  const seq = [":", "..", "~", "^", "@{", "//"].find((bad) => name.includes(bad));
  if (seq !== undefined) return `it holds ${seq}`;
  if (!pattern && name.endsWith("/")) return "it ends in /";
  if (!pattern && name.endsWith(".")) return "it ends in .";
  if (parts.some((p) => p.startsWith("."))) return "a part of it starts with .";
  if (done.some((p) => p.endsWith(".lock"))) return "a part of it ends in .lock";
  return undefined;
}

/**
 * Why `wim ci allow` cannot save a rule for `ref`, for the person; undefined when it is a full ref
 * or a ref pattern that git takes and that the terminal shows as it is. A ref that display
 * escaping would change (a format or default-ignorable character, shown as `<U+...>`) is refused
 * too: the protection advice for a pattern (patternLines) would name the escaped text, so a person
 * who copied it would protect another name and leave the rule's refs open. Rules already on disk
 * are read as before: this is only the check before one is saved.
 */
export function refRefusal(ref: string): string | undefined {
  if (!isCiRuleRef(ref)) {
    if ([...ref].length > CI_REF_MAX) return `the ref is longer than ${CI_REF_MAX} characters: ${sanitizeForDisplay([...ref].slice(0, 64).join(""))}...`;
    return `not a branch or tag name, or a pattern: ${sanitizeForDisplay(ref)}. A pattern ends in one * (--tag 'v*', --ref 'release/*'); a name holds no whitespace, control character, ?, [ or \\, and no * anywhere else`;
  }
  const git = gitRefRefusal(ref);
  if (git !== undefined) return `not a ref git accepts: ${sanitizeForDisplay(ref)}: ${git}, so no token could ever carry it. A name holds no :, .., ~, ^, @{ or //, no part starts with . or ends in .lock, and it does not end in / or .`;
  if (sanitizeForDisplay(ref) !== ref) return `the ref holds a character the terminal shows escaped: ${sanitizeForDisplay(ref)}. A rule for it could not be shown, or protected at the provider, as it is`;
  return undefined;
}

/** What a ref pattern's rule takes, in words, and how to protect the same refs at the provider. Empty for a full ref. */
export function patternLines(rule: CiRule): string[] {
  if (!isCiRefPattern(rule.ref)) return [];
  const tag = rule.ref.startsWith("refs/tags/");
  const kind = tag ? "tag" : "branch";
  const prefix = sanitizeForDisplay(rule.ref.slice(tag ? "refs/tags/".length : "refs/heads/".length, -1));
  const lines = [
    prefix === ""
      ? `This rule is a pattern: it takes every ${kind}, so anyone who can push any ${kind} can send.`
      : `This rule is a pattern: it takes every ${kind} whose name starts with "${prefix}" (that name itself included, and names with / in them), so anyone who can push such a ${kind} can send.`,
  ];
  if (rule.via === "github") {
    // A ruleset target is fnmatch: its * stops at /, and /**/ spans any depth.
    lines.push(`Protect the same ${kind}s at GitHub with a ${kind} ruleset (Settings, Rules, Rulesets) that restricts creating, updating and deleting them, targeting both ${prefix}* and ${prefix}*/**/* (a ruleset's * does not match /).`);
  } else {
    lines.push(
      `Protect the same ${kind}s at GitLab: Settings, Repository, Protected ${tag ? "tags" : "branches"}, with the wildcard ${prefix}*.`,
      rule.unprotected === true
        ? `This rule also takes unprotected refs (--unprotected): until they are protected, anyone who can push a matching ${kind} can send.`
        : `This rule takes only refs GitLab marks protected: nothing from a matching ${kind} is delivered until it is protected.`,
    );
  }
  return lines;
}

/** The ids a verified token carries, as a rule pins them. */
export function claimIds(c: CiClaims): CiPins {
  return c.via === "github" ? { repositoryId: c.repositoryId, ownerId: c.ownerId } : { projectId: c.projectId, namespaceId: c.namespaceId };
}

function samePins(a: CiPins, b: CiPins): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/**
 * Whether a GitHub `workflow_ref` is `<repository>/.github/workflows/<file>@<ref>`, where `<ref>` is
 * the token's own `ref` exactly: the rule's ref (full or pattern) is then checked on that ref.
 */
function workflowMatches(workflowRef: string, repository: string, file: string, ref: string): boolean {
  const head = workflowRef.slice(0, repository.length);
  return head.toLowerCase() === repository.toLowerCase() && workflowRef.slice(repository.length) === `/.github/workflows/${file}@${ref}`;
}

/** Whether a rule matches a verified token by everything but the ids (SPEC section 18, the rules table). */
export function matchesByName(rule: CiRule, c: CiClaims): boolean {
  if (rule.via === "github") {
    if (c.via !== "github") return false;
    if (c.repository.toLowerCase() !== rule.repo || !ciRefMatches(rule.ref, c.ref)) return false;
    if (!workflowMatches(c.workflowRef, c.repository, rule.workflow, c.ref)) return false;
    const eventOk = rule.events === undefined ? !PRIVILEGED_EVENTS.includes(c.event) : rule.events.includes(c.event);
    return eventOk && (rule.environment === undefined || c.environment === rule.environment);
  }
  if (c.via !== "gitlab") return false;
  if (c.projectPath.toLowerCase() !== rule.repo || !ciRefMatches(rule.ref, c.ref)) return false;
  if (!c.refProtected && rule.unprotected !== true) return false;
  return rule.environment === undefined || (c.environment === rule.environment && c.environmentProtected === true);
}

/**
 * The rule a notice falls under. `pinned`: a rule with these ids pinned matched. Otherwise a rule
 * with no ids yet matched by name: the notice is held for the person, whose approval pins `ids`.
 * Undefined when nothing matches (a rule pinned to other ids does not).
 */
export function matchRule(rules: readonly CiRule[], c: CiClaims): { rule: CiRule; pinned: true } | { rule: CiRule; pinned: false; ids: CiPins } | undefined {
  const byName = rules.filter((r) => matchesByName(r, c));
  const ids = claimIds(c);
  const pinned = byName.find((r) => r.pins !== undefined && samePins(r.pins, ids));
  if (pinned !== undefined) return { rule: pinned, pinned: true };
  const open = byName.find((r) => r.pins === undefined);
  return open === undefined ? undefined : { rule: open, pinned: false, ids };
}

/** What a device tells the relay about its rules (SPEC section 18, `ci.rules`). */
export function rulesFrame(rules: readonly CiRule[], mesh: string, device: string): { t: "ci.rules"; tags: string[]; gitlab: boolean } {
  const tags = new Set<string>();
  for (const r of rules) if (r.via === "github") tags.add(ciRuleTag({ mesh, device, iss: GITHUB_ISSUER, repo: r.repo, ref: r.ref }));
  return { t: "ci.rules", tags: [...tags], gitlab: rules.some((r) => r.via === "gitlab") };
}

/**
 * Pins ids into a rule, as the person's approval of a held notice does. Throws when the rule is
 * gone, or already pinned to other ids (then the notice comes from another repository that has
 * the name now). Returns the rules to write; unchanged when the same ids are already pinned.
 */
export function pinRule(rules: readonly CiRule[], ruleId: string, ids: CiPins): CiRule[] {
  const rule = rules.find((r) => r.id === ruleId);
  if (rule === undefined) throw new Error("the rule this notice matched was removed; nothing to pin");
  if (rule.pins !== undefined && !samePins(rule.pins, ids)) {
    throw new Error("the rule this notice matched is already pinned to other ids: this notice comes from another repository with the same name");
  }
  return rules.map((r) => (r.id === ruleId ? checkRule({ ...r, pins: ids } as CiRule) : r));
}

/** Whether `ruleId` is pinned to exactly `ids` now. */
export function isPinned(rules: readonly CiRule[], ruleId: string, ids: CiPins): boolean {
  const rule = rules.find((r) => r.id === ruleId);
  return rule?.pins !== undefined && samePins(rule.pins, ids);
}

/** One rule on one line, for `wim ci list` and the confirmations. */
export function ruleLine(r: CiRule): string {
  const parts = [r.via, r.repo, r.ref];
  if (r.via === "github") parts.push(`workflow ${r.workflow}`, r.events === undefined ? "events: all but pull_request_target, workflow_run" : `events ${r.events.join(",")}`);
  if (r.via === "gitlab") parts.push(r.unprotected === true ? "protected or not" : "protected refs only");
  if (r.environment !== undefined) parts.push(`environment ${r.environment}`);
  parts.push(r.pins === undefined ? "ids not pinned yet (the first notice is held for you)" : `ids ${Object.entries(r.pins).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  if (r.hold === true) parts.push("every notice held");
  return parts.join("  ");
}
