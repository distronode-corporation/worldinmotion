// `wim ci allow|list|remove|notify` (SPEC section 18): the rules change only at the person's own
// terminal (the guard of `wim devices trust`), ids are pinned from the provider's public API when
// they can be, and `notify` exits 0 whatever happens.

import { b64u, ciRecipientCode, createPrekey, deviceIdFromSignPub, generateDeviceKeys, gitlabAudience, sha256, ulid, utf8 } from "@worldinmotion/protocol";
import { promises as fs, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { publicIds } from "../src/cicli.ts";
import { loadCiRules, saveCiRules, type CiRule } from "../src/cirules.ts";
import { GITLAB_TOKEN_VAR } from "../src/cisend.ts";
import { HeldBox } from "../src/held.ts";
import { MeshFiles } from "../src/mesh.ts";
import { SessionFiles } from "../src/session.ts";
import { Spool } from "../src/spool.ts";
import { FS, makeMesh, RelayHarness, run, said, term, type Term } from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000 });

/** A device in a mesh of its own, and a terminal on it whose fetch answers as `api` says. */
async function setup(api: (url: string) => Response | Promise<Response> = () => new Response("{}", { status: 404 }), env: Record<string, string> = {}) {
  const relay = new RelayHarness();
  const { mesh, devices } = await makeMesh(relay, ["desk"]);
  const d = devices[0]!;
  const files = new MeshFiles(d.home.meshDir(mesh), FS);
  const asked: string[] = [];
  const t = term(d.root, relay, { fetch: (async (url: string) => (asked.push(String(url)), api(String(url)))) as typeof fetch }, env);
  return { relay, mesh, d, files, t, asked };
}

const allowGithub = ["ci", "allow", "github", "Octo-Org/Deploys", "--ref", "main", "--workflow", "deploy.yml"];

describe("the person guard", () => {
  it("refuses allow, list and remove under an agent's variables or without an interactive terminal, before reading anything", async () => {
    const w = await setup();
    const terms: Array<[string, Term]> = [
      ["CLAUDECODE is set", term(w.d.root, w.relay, {}, { CLAUDECODE: "1" })],
      ["output is not an interactive terminal", term(w.d.root, w.relay, { isTTY: false })],
      ["input is not an interactive terminal", term(w.d.root, w.relay, { inputIsTTY: false })],
    ];
    for (const [why, t] of terms) {
      for (const argv of [allowGithub, ["ci", "list"], ["ci", "remove", "1"], ["ci", "allow", "nonsense"]]) {
        expect(await run(t, ...argv)).toBe(1);
        expect(said(t)).toContain(why);
        expect(said(t)).toContain("Open a terminal yourself");
      }
    }
    expect(await loadCiRules(w.files.ciRulesPath)).toEqual([]);
    expect(w.asked).toEqual([]);
  });

  it("changes nothing without a typed yes", async () => {
    const w = await setup();
    w.t.answers.push("n");
    expect(await run(w.t, ...allowGithub)).toBe(1);
    expect(said(w.t)).toContain("wim: nothing changed.");
    expect(await loadCiRules(w.files.ciRulesPath)).toEqual([]);
  });

  it("is offered by no MCP tool and no events action", () => {
    for (const file of ["mcp.ts", "events.ts"]) {
      const src = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      expect(src).not.toMatch(/cicli|saveCiRules|updateCiRules|pinRule|ci-rules/);
    }
  });
});

describe("wim ci allow", () => {
  it("pins a public GitHub repository's ids from the API and prints the recipient code", async () => {
    const w = await setup(() => Response.json({ id: 74, full_name: "Octo-Org/Deploys", owner: { id: 65 } }));
    w.t.answers.push("y");
    expect(await run(w.t, ...allowGithub, "--event", "push,pull_request_target", "--environment", "prod", "--hold")).toBe(0);
    expect(w.asked).toEqual(["https://api.github.com/repos/octo-org/deploys"]);
    const out = said(w.t);
    expect(out).toContain("ids were read from the provider's public API and are pinned");
    expect(out).toContain("a pull request from a fork can steer those runs");
    expect(out).toContain("permissions: id-token: write");
    expect(out).toMatch(/Recipient code for the job \(not a secret\): wimci1_\S+/);
    const [rule] = await loadCiRules(w.files.ciRulesPath);
    expect(rule).toMatchObject({ via: "github", repo: "octo-org/deploys", ref: "refs/heads/main", workflow: "deploy.yml", events: ["push", "pull_request_target"], environment: "prod", hold: true, pins: { repositoryId: "74", ownerId: "65" } });
    // The same rule again is refused.
    expect(await run(w.t, ...allowGithub, "--event", "push,pull_request_target", "--environment", "prod", "--hold")).toBe(1);
    expect(said(w.t)).toContain("this rule is already allowed");
  });

  it("leaves a private repository unpinned, and says the first notice is held", async () => {
    const w = await setup();
    w.t.answers.push("y");
    expect(await run(w.t, "ci", "allow", "github", "Octo-Org/Deploys", "--tag", "v1", "--workflow", "deploy.yml")).toBe(0);
    expect(said(w.t)).toContain("could not be read from the provider's public API");
    // A full ref is no pattern: no pattern lines and no look at the relay's info.
    expect(said(w.t)).not.toContain("This rule is a pattern");
    expect(w.asked).toEqual(["https://api.github.com/repos/octo-org/deploys"]);
    expect((await loadCiRules(w.files.ciRulesPath))[0]).toMatchObject({ ref: "refs/tags/v1" });
    expect((await loadCiRules(w.files.ciRulesPath))[0]!.pins).toBeUndefined();
  });

  it("prints a GitLab job's id_tokens audience and warns that its token is a bearer credential", async () => {
    const w = await setup(() => {
      throw new Error("offline");
    });
    w.t.answers.push("y");
    expect(await run(w.t, "ci", "allow", "gitlab", "Group/Sub/App", "--ref", "main", "--unprotected")).toBe(0);
    const out = said(w.t);
    expect(out).toContain("A GitLab token cannot be bound to one notice");
    expect(out).toContain(`${GITLAB_TOKEN_VAR}: { aud: ${gitlabAudience(w.mesh, w.d.device.id)} }`);
    expect(w.asked).toEqual([`https://gitlab.com/api/v4/projects/${encodeURIComponent("group/sub/app")}`]);
    expect((await loadCiRules(w.files.ciRulesPath))[0]).toMatchObject({ via: "gitlab", repo: "group/sub/app", unprotected: true });
    w.t.answers.push("y");
    expect(await run(w.t, "ci", "allow", "gitlab", "group/app", "--ref", "main")).toBe(0);
    expect((await loadCiRules(w.files.ciRulesPath))[1]).not.toHaveProperty("unprotected");
  });

  it("refuses what is not a rule", async () => {
    const w = await setup();
    const bad: Array<[string[], string]> = [
      [["ci", "allow"], "usage: wim ci allow github"],
      [["ci", "allow", "bitbucket", "a/b", "--ref", "main"], "usage: wim ci allow github"],
      [["ci", "allow", "github", "a/b", "extra", "--ref", "main"], "usage: wim ci allow github"],
      [["ci", "allow", "github", "nope", "--ref", "main", "--workflow", "d.yml"], "not a GitHub owner/repo: nope"],
      [["ci", "allow", "gitlab", "nope", "--ref", "main"], "not a GitLab group/project: nope"],
      [["ci", "allow", "github", "a/b", "--workflow", "d.yml"], "--ref or --tag is required"],
      [["ci", "allow", "github", "a/b", "--ref", "v1", "--tag", "v1", "--workflow", "d.yml"], "give one of --ref and --tag"],
      // 0.1.9's boolean --tag after --ref: refused. --tag takes the next word, so the workflow's
      // file is left over as an argument, and the command line is refused as a whole.
      [["ci", "allow", "github", "a/b", "--ref", "v1", "--tag", "--workflow", "d.yml"], "usage: wim ci allow github"],
      [["ci", "allow", "github", "a/b", "--workflow", "d.yml", "--tag", "--hold"], "--tag needs a tag name or a pattern ending in * (quoted: --tag 'v*')"],
      [["ci", "allow", "github", "a/b", "--ref=", "--workflow", "d.yml"], "--ref needs a branch name, a full ref or a pattern ending in * (quoted: --ref 'release/*')"],
      [["ci", "allow", "gitlab", "a/b", "--tag="], "--tag needs a tag name"],
      [["ci", "allow", "github", "a/b", "--ref=-x", "--workflow", "d.yml"], "--ref needs a branch name, a full ref or a pattern"],
      [["ci", "allow", "github", "a/b", "--tag", "v*.*", "--workflow", "d.yml"], "not a branch or tag name, or a pattern: refs/tags/v*.*"],
      [["ci", "allow", "github", "a/b", "--tag", "v?", "--workflow", "d.yml"], "not a branch or tag name, or a pattern"],
      [["ci", "allow", "gitlab", "a/b", "--ref", "release/[0-9]*"], "not a branch or tag name, or a pattern"],
      [["ci", "allow", "gitlab", "a/b", "--tag", "**"], "not a branch or tag name, or a pattern"],
      [["ci", "allow", "gitlab", "a/b", "--tag", `${"v".repeat(246)}*`], "the ref is longer than 255 characters"],
      [["ci", "allow", "gitlab", "a/b", "--ref", "main", "--workflow", "d.yml"], "--workflow and --event are for GitHub rules"],
      [["ci", "allow", "github", "a/b", "--ref", "main", "--workflow", "d.yml", "--unprotected"], "--unprotected is for GitLab rules"],
      [["ci", "allow", "github", "a/b", "--ref", "main"], "--workflow must name the workflow file"],
      [["ci", "allow", "github", "a/b", "--ref", "main", "--workflow", "../d.yml"], "--workflow must name the workflow file"],
      [["ci", "allow", "github", "a/b", "--ref", "main", "--workflow", "d.yml", "--event", "Push"], "--event takes GitHub event names"],
      [["ci", "allow", "github", "a/b", "--ref", "has space", "--workflow", "d.yml"], "not a branch or tag name, or a pattern: refs/heads/has space"],
    ];
    for (const [argv, why] of bad) {
      // Only this command's output: an earlier line must not satisfy a later case.
      w.t.out.length = 0;
      w.t.err.length = 0;
      expect(await run(w.t, ...argv)).toBe(1);
      expect(said(w.t), argv.join(" ")).toContain(why);
    }
    // A refused name is shown with its control characters made visible, never as a terminal escape.
    expect(await run(w.t, "ci", "allow", "gitlab", "a/b", "--tag", "v\u001b[2J*")).toBe(1);
    expect(said(w.t)).toContain("not a branch or tag name, or a pattern");
    expect(said(w.t)).not.toContain("\u001b");
    // There is no --branch: a branch is --ref.
    expect(await run(w.t, "ci", "allow", "gitlab", "a/b", "--branch", "main")).toBe(2);
    expect(said(w.t)).toContain("unknown flag --branch for wim ci");
    // A bare --tag at the end, 0.1.9's spelling, is a bad command line.
    expect(await run(w.t, "ci", "allow", "github", "a/b", "--ref", "v1", "--workflow", "d.yml", "--tag")).toBe(2);
    expect(said(w.t)).toContain("--tag needs a value");
    const many = Array.from({ length: 64 }, (_, i): CiRule => ({ id: ulid(), via: "github", repo: `o/r${i}`, ref: "refs/heads/main", workflow: "d.yml" }));
    await saveCiRules(w.files.ciRulesPath, many, FS);
    expect(await run(w.t, ...allowGithub)).toBe(1);
    expect(said(w.t)).toContain("already has 64 CI rules");
    expect(w.asked).toEqual([]);
  });
});

describe("wim ci allow with a ref pattern", () => {
  const info = (extra: Record<string, unknown> = {}) =>
    Response.json({ v: 1, software: "worldinmotion-relay", version: "0.1.10", create: "open", limits: { max_meshes: null, idle_mesh_days: null, blob_bytes_per_mesh_per_day: 1 }, offer: null, ci: true, ...extra });
  const release = ["ci", "allow", "github", "Octo-Org/Deploys", "--tag", "v*", "--workflow", "release.yml"];

  it("stores the pattern as spelled, tells the person to protect it with a GitHub ruleset, and asks the relay whether it checks patterns", async () => {
    const w = await setup((url) => (url.endsWith("/v1/info") ? info({ ciPatterns: true }) : new Response("{}", { status: 404 })));
    w.t.answers.push("y");
    expect(await run(w.t, ...release)).toBe(0);
    const out = said(w.t);
    expect(out).toContain("any job of that workflow file on a matching ref");
    expect(out).toContain('it takes every tag whose name starts with "v"');
    expect(out).toContain("targeting both v* and v*/**/*");
    expect(out).not.toContain("Warning:");
    expect(w.asked).toEqual(["https://api.github.com/repos/octo-org/deploys", "http://127.0.0.1:4444/v1/info"]);
    expect((await loadCiRules(w.files.ciRulesPath))[0]).toMatchObject({ via: "github", repo: "octo-org/deploys", ref: "refs/tags/v*", workflow: "release.yml" });
  });

  it("warns, and saves the rule anyway, when the relay's info lacks ciPatterns: true", async () => {
    for (const extra of [{}, { ciPatterns: false }]) {
      const w = await setup((url) => (url.endsWith("/v1/info") ? info(extra) : new Response("{}", { status: 404 })));
      w.t.answers.push("y");
      expect(await run(w.t, ...release)).toBe(0);
      expect(said(w.t)).toContain(`Warning: this device's relay does not say it checks ref patterns (its /v1/info lacks "ciPatterns": true)`);
      expect(said(w.t)).toContain("notices under this rule are refused until the relay is updated. Allowing it saves the rule all the same.");
      expect(await loadCiRules(w.files.ciRulesPath)).toHaveLength(1);
    }
  });

  it("warns that it could not check, and saves the rule anyway, when the relay's info cannot be read", async () => {
    const w = await setup(() => {
      throw new Error("offline");
    });
    w.t.answers.push("y");
    expect(await run(w.t, "ci", "allow", "github", "Octo-Org/Deploys", "--ref", "release/*", "--workflow", "release.yml")).toBe(0);
    expect(said(w.t)).toContain("Warning: whether this device's relay checks ref patterns could not be checked (its /v1/info could not be read)");
    expect(said(w.t)).toContain("a branch ruleset");
    expect((await loadCiRules(w.files.ciRulesPath))[0]).toMatchObject({ ref: "refs/heads/release/*" });
  });

  it("takes a full pattern by --ref too", async () => {
    const w = await setup();
    w.t.answers.push("y");
    expect(await run(w.t, "ci", "allow", "github", "o/r", "--ref", "refs/tags/*", "--workflow", "release.yml")).toBe(0);
    expect(said(w.t)).toContain("it takes every tag, so anyone who can push any tag can send");
    expect((await loadCiRules(w.files.ciRulesPath))[0]).toMatchObject({ ref: "refs/tags/*" });
  });

  it("never asks the relay for a GitLab pattern, which the relay does not filter, and names GitLab's protected tags", async () => {
    const w = await setup();
    w.t.answers.push("y");
    expect(await run(w.t, "ci", "allow", "gitlab", "Group/App", "--tag", "v*")).toBe(0);
    const out = said(w.t);
    expect(out).toContain("any job of that project on a matching ref");
    expect(out).toContain("Protected tags, with the wildcard v*.");
    expect(out).toContain("nothing from a matching tag is delivered until it is protected");
    expect(out).not.toContain("Warning:");
    expect(w.asked).toEqual([`https://gitlab.com/api/v4/projects/${encodeURIComponent("group/app")}`]);
    expect((await loadCiRules(w.files.ciRulesPath))[0]).toMatchObject({ via: "gitlab", ref: "refs/tags/v*" });
    w.t.answers.push("y");
    expect(await run(w.t, "ci", "allow", "gitlab", "group/app", "--ref", "refs/heads/release/*", "--unprotected")).toBe(0);
    expect(said(w.t)).toContain("This rule also takes unprotected refs (--unprotected)");
  });
});

describe("wim ci list and remove", () => {
  it("lists rules by number with the recipient code, and removes one after a typed yes", async () => {
    const w = await setup();
    expect(await run(w.t, "ci", "list")).toBe(0);
    expect(said(w.t)).toContain("No CI rules: this device takes no CI notices.");
    const rules: CiRule[] = [
      { id: ulid(), via: "github", repo: "o/a", ref: "refs/heads/main", workflow: "d.yml" },
      { id: ulid(), via: "gitlab", repo: "g/b", ref: "refs/heads/main" },
    ];
    await saveCiRules(w.files.ciRulesPath, rules, FS);
    w.t.out.length = 0;
    expect(await run(w.t, "ci", "list")).toBe(0);
    expect(w.t.out[0]).toMatch(/^1 {2}github {2}o\/a/);
    expect(w.t.out[1]).toMatch(/^2 {2}gitlab {2}g\/b/);
    const sign = b64u.encode(w.d.device.keyring.signPub);
    expect(w.t.out[2]).toContain(ciRecipientCode({ relay: (await w.files.loadConfig()).relay, mesh: w.mesh, sign }));
    for (const argv of [["ci", "remove"], ["ci", "remove", "0"], ["ci", "remove", "x"], ["ci", "remove", "1", "2"]]) {
      expect(await run(w.t, ...argv)).toBe(1);
      expect(said(w.t)).toContain("usage: wim ci remove <n>");
    }
    expect(await run(w.t, "ci", "remove", "3")).toBe(1);
    expect(said(w.t)).toContain("no CI rule 3");
    w.t.answers.push("n");
    expect(await run(w.t, "ci", "remove", "1")).toBe(1);
    w.t.answers.push("y");
    expect(await run(w.t, "ci", "remove", "1")).toBe(0);
    expect(await loadCiRules(w.files.ciRulesPath)).toEqual([rules[1]]);
  });

  it("changes the rules as they are once the person has answered, never a copy read before the prompt", async () => {
    const w = await setup();
    const a: CiRule = { id: ulid(), via: "github", repo: "o/a", ref: "refs/heads/main", workflow: "d.yml" };
    const b: CiRule = { id: ulid(), via: "gitlab", repo: "g/b", ref: "refs/heads/main" };
    const c: CiRule = { id: ulid(), via: "gitlab", repo: "g/c", ref: "refs/heads/main" };
    await saveCiRules(w.files.ciRulesPath, [a, b], FS);
    // Another terminal adds a rule while this one asks: the removal keeps it.
    w.t.answers.push(async () => (await saveCiRules(w.files.ciRulesPath, [a, b, c], FS), "y"));
    expect(await run(w.t, "ci", "remove", "1")).toBe(0);
    expect(await loadCiRules(w.files.ciRulesPath)).toEqual([b, c]);
    // Another terminal removes the very rule while this one asks: nothing is written back.
    w.t.answers.push(async () => (await saveCiRules(w.files.ciRulesPath, [c], FS), "y"));
    expect(await run(w.t, "ci", "remove", "1")).toBe(1);
    expect(said(w.t)).toContain("that CI rule was removed meanwhile");
    expect(await loadCiRules(w.files.ciRulesPath)).toEqual([c]);
    // An allow whose rule another terminal allowed meanwhile adds no second copy.
    w.t.answers.push(async () => {
      w.t.answers.push("y");
      expect(await run(w.t, ...allowGithub)).toBe(0);
      return "y";
    });
    expect(await run(w.t, ...allowGithub)).toBe(1);
    expect(said(w.t)).toContain("this rule is already allowed");
    expect((await loadCiRules(w.files.ciRulesPath)).filter((r) => r.repo === "octo-org/deploys")).toHaveLength(1);
  });

  it("still reads any other first word as the polling watcher's config path", async () => {
    const w = await setup();
    expect(await run(w.t, "ci", "missing-config.json")).toBe(1);
    expect(said(w.t)).toContain("missing-config.json");
    expect(await run(w.t, "ci")).toBe(1);
    expect(said(w.t)).toContain("a config file path is required");
  });
});

describe("approving a held CI notice from the command line", () => {
  it("shows that its rule holds every notice, and frames it as CI text on approval", async () => {
    const w = await setup();
    const rule: CiRule = { id: ulid(), via: "gitlab", repo: "g/b", ref: "refs/heads/main", hold: true };
    await saveCiRules(w.files.ciRulesPath, [rule], FS);
    const files = new SessionFiles(w.files, ulid(), FS);
    const id = ulid();
    const entry = { dir: "in" as const, peer: "ci:gitlab:g/b", id, kind: "msg" as const, at: Date.now(), text: "built", relayed: true as const, ci: { via: "gitlab" as const, repo: "g/b", ref: "refs/heads/main" } };
    await new HeldBox(files.heldDir, FS).add({ id, from: "ci:gitlab:g/b", device: "", kind: "msg", at: entry.at, preview: "built", rendered: "the CI frame", reason: "policy", entry, ci: { rule: rule.id } });
    w.t.answers.push("y");
    expect(await run(w.t, "held", "approve", id)).toBe(0);
    expect(said(w.t)).toContain("held     because its CI rule holds every notice");
    const [item] = await (await Spool.open(files.spoolDir, FS, 0)).unread();
    expect(item).toMatchObject({ id, rendered: "the CI frame", relayed: true, informs: true, device: "" });
  });
});

describe("wim ci notify", () => {
  const keys = generateDeviceKeys();
  const mesh = b64u.encode(sha256(utf8("ci cli mesh")).subarray(0, 16));
  const device = deviceIdFromSignPub(keys.signPub);
  const code = ciRecipientCode({ relay: "wss://relay.example", mesh, sign: b64u.encode(keys.signPub) });
  const prekey = createPrekey({ mesh, deviceId: device, signSec: keys.signSec, at: Date.now() - 60_000 }).prekey;
  const token = (aud: string) => [{ alg: "RS256", kid: "k" }, { aud }].map((p) => b64u.encode(utf8(JSON.stringify(p)))).join(".") + ".c2ln";
  const relayFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return Response.json(body["t"] === "ci.prekey" ? { t: "ci.prekey", prekey } : { t: "ci.sent", id: body["id"], status: "queued" });
  }) as unknown as typeof fetch;

  it("exits 0 when it sends, with the outcome on stdout; text may be the remaining words", async () => {
    const relay = new RelayHarness();
    const t = term("/nonexistent-home", relay, { fetch: relayFetch }, { GITLAB_CI: "true", [GITLAB_TOKEN_VAR]: token(gitlabAudience(mesh, device)) });
    expect(await run(t, "ci", "notify", "--recipient", code, "--to", "deploys", "pipeline", "passed")).toBe(0);
    expect(t.out).toEqual(["wim ci notify: sent to deploys, queued (it is offline now; kept up to 24 hours)."]);
    expect(await run(t, "ci", "notify", "--recipient", code, "--to", "deploys", "--via", "gitlab", "--text", "again")).toBe(0);
    expect(t.out).toHaveLength(2);
  });

  it("exits 0 when it refuses, with the reason on stderr", async () => {
    const relay = new RelayHarness();
    const t = term("/nonexistent-home", relay, {}, { GITLAB_CI: "true", [GITLAB_TOKEN_VAR]: token("sts.amazonaws.com") });
    expect(await run(t, "ci", "notify", "--recipient", code, "--to", "deploys", "--text", "x")).toBe(0);
    expect(t.err).toEqual(["wim ci notify: not sent: the ID token's audience is not one string starting with wimci1.; refusing to send it anywhere."]);
    expect(await run(t, "ci", "notify")).toBe(0);
    expect(t.err[1]).toContain("the recipient code is missing");
    expect(await run(t, "ci", "notify", "--to")).toBe(0);
    expect(t.err[2]).toBe("wim ci notify: not sent: --to needs a value.");
    expect(await run(t, "ci", "notify", "--bogus")).toBe(0);
    expect(t.err[3]).toMatch(/^wim ci notify: not sent: unknown flag --bogus for wim ci/);
    // Any other command still exits 2 on a bad command line.
    expect(await run(t, "ci", "list", "--to")).toBe(2);
  });
});

describe("publicIds", () => {
  it("takes ids only for exactly the repository asked, as positive integers", async () => {
    const answer = (body: unknown) => (async () => Response.json(body)) as unknown as typeof fetch;
    expect(await publicIds(answer({ id: 20, path_with_namespace: "G/App", namespace: { id: 11 } }), "gitlab", "g/app")).toEqual({ projectId: "20", namespaceId: "11" });
    expect(await publicIds(answer({ id: 20, path_with_namespace: "g/other", namespace: { id: 11 } }), "gitlab", "g/app")).toBeUndefined();
    expect(await publicIds(answer({ id: 74, full_name: "o/r" }), "github", "o/r")).toBeUndefined();
    expect(await publicIds(answer({ id: -1, full_name: "o/r", owner: { id: 2 } }), "github", "o/r")).toBeUndefined();
    expect(await publicIds(answer({ id: 74, owner: { id: 2 } }), "github", "o/r")).toBeUndefined();
    expect(await publicIds((async () => new Response("not json")) as unknown as typeof fetch, "github", "o/r")).toBeUndefined();
  });
});

// The scratch home of a notify test is never created: `notify` needs no device.
it("notify touches no state directory", async () => {
  await expect(fs.stat("/nonexistent-home")).rejects.toThrow();
});
