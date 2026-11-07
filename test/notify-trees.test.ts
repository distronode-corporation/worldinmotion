import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
// @ts-expect-error: plain JavaScript, run by release.yml with node as is
import { BUNDLE, buildTrees, cli, publishedReadme, TREES, VERSION, writeTrees } from "../.github/scripts/notify-trees.mjs";

// release.yml's notify-github and notify-gitlab jobs commit what notify-trees.mjs builds to the
// two worldinmotion-notify repositories, at a tag. These tests hold that tree to what each
// registry takes and to the sources in packaging/, here, because the jobs run only on a tag.
const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const version = (JSON.parse(read("package.json")) as { version: string }).version;
// The plugin's committed bundle: the same client build as the release's wim.mjs, which CI
// checks against a fresh build.
const bundle = join(root, "plugins/claude-code/dist/client.mjs");

type Tree = Map<string, Buffer>;
type Trees = Record<"github" | "gitlab", Tree>;
const build = (options: { root?: string; version?: unknown; bundle?: string } = {}): Trees =>
  buildTrees({ root, version, bundle, ...options }) as Trees;
const text = (tree: Tree, path: string) => tree.get(path)!.toString("utf8");

const scratch = mkdtempSync(join(tmpdir(), "wim-notify-trees-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
/** A copy of the files the trees read, which a test may then break. */
const fixture = () => {
  const dir = join(scratch, `repo-${n++}`);
  for (const path of ["LICENSE", "NOTICE", "packaging/github-action", "packaging/gitlab-component"]) {
    cpSync(join(root, path), join(dir, path), { recursive: true });
  }
  return dir;
};
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
};

describe("the trees", () => {
  const trees = build();

  it("hold exactly the files each registry needs, and no workflow", () => {
    expect([...trees.github.keys()]).toEqual(["LICENSE", "NOTICE", "README.md", "action.yml", "main.mjs", "notify.mjs", "wim.mjs"]);
    expect([...trees.gitlab.keys()]).toEqual([".gitlab-ci.yml", "LICENSE", "NOTICE", "README.md", "templates/notify.yml"]);
    expect(Object.keys(trees)).toEqual(["github", "gitlab"]);
  });

  it("bundle the release's own wim.mjs, byte for byte", () => {
    expect(trees.github.get("wim.mjs")!.equals(readFileSync(bundle))).toBe(true);
  });

  it("copy the action, the template and the licence files unchanged", () => {
    for (const [tree, path, from] of [
      ["github", "action.yml", "packaging/github-action/action.yml"],
      ["github", "main.mjs", "packaging/github-action/main.mjs"],
      ["github", "notify.mjs", "packaging/github-action/notify.mjs"],
      ["github", "LICENSE", "LICENSE"],
      ["github", "NOTICE", "NOTICE"],
      ["gitlab", "LICENSE", "LICENSE"],
      ["gitlab", "NOTICE", "NOTICE"],
      ["gitlab", "templates/notify.yml", "packaging/gitlab-component/templates/notify.yml"],
      ["gitlab", ".gitlab-ci.yml", "packaging/gitlab-component/.gitlab-ci.yml"],
    ] as const) {
      expect(text(trees[tree], path), `${tree}/${path}`).toBe(read(from));
    }
  });

  it("keep action.yml free of expressions, so the published action loads", () => {
    expect(text(trees.github, "action.yml")).not.toContain("${{");
  });

  it("publish the template with the inputs packaging/gitlab-component declares, pinned to this release", () => {
    const inputs = (yaml: string) => [...yaml.split("\n---\n")[0]!.matchAll(/^ {4}([a-z_]+):$/gm)].map((m) => m[1]);
    const published = text(trees.gitlab, "templates/notify.yml");
    expect(inputs(published)).toEqual(["recipient", "audience", "to", "stage", "success_text", "failure_text", "image", "wim_package", "tags"]);
    expect(inputs(published)).toEqual(inputs(read("packaging/gitlab-component/templates/notify.yml")));
    expect(published).toContain(`default: "worldinmotion@${version}"`);
  });

  it("give the component project one job, the release the Catalog takes, on an X.Y.Z tag only", () => {
    const ci = text(trees.gitlab, ".gitlab-ci.yml");
    expect([...ci.matchAll(/^([.\w-]+):/gm)].map((m) => m[1])).toEqual(["stages", "release"]);
    expect(ci).toMatch(/^ {2}release:\n {4}tag_name: \$CI_COMMIT_TAG\n/m);
    expect(ci).toMatch(/image: registry\.gitlab\.com\/gitlab-org\/cli:v[\d.]+@sha256:[0-9a-f]{64}\n/);
    const rule = new RegExp(/\$CI_COMMIT_TAG =~ \/(.*)\/\n/.exec(ci)![1]!);
    for (const tag of ["0.1.10", "1.0.0", "10.20.30"]) expect(rule.test(tag), tag).toBe(true);
    for (const tag of ["v0.1.10", "0.1", "01.1.1", "0.1.10-rc.1", "0.1.10\nx", "main"]) expect(rule.test(tag), tag).toBe(false);
  });

  it("publish each README with only the published lines", () => {
    const github = text(trees.github, "README.md");
    const gitlab = text(trees.gitlab, "README.md");
    for (const readme of [github, gitlab]) {
      expect(readme).not.toMatch(/unpublished|not published yet|packaging\/|does not resolve/i);
    }
    expect(github).toContain("      - uses: distronode-corporation/worldinmotion-notify@<full commit sha> # vX.Y.Z\n");
    expect(github).toContain("      id-token: write");
    expect(gitlab).toContain("  - component: $CI_SERVER_FQDN/distronode-corporation/worldinmotion-notify/notify@X.Y.Z\n");
    // In this repository, the same READMEs say plainly that the lines do not resolve yet.
    expect(read("packaging/github-action/README.md")).toContain("**Not published yet.**");
    expect(read("packaging/gitlab-component/README.md")).toContain("**Not published yet.**");
  });

  it("list each source folder whole, and take the bundle only from the command line", () => {
    for (const { source, files } of Object.values(TREES) as { source: string; files: [string, string | symbol][] }[]) {
      for (const [, from] of files) if (from !== BUNDLE) expect(existsSync(join(root, from as string)), from as string).toBe(true);
      expect(files.map(([path]) => path)).toEqual(files.map(([path]) => path).sort());
      expect(source).toMatch(/^packaging\//);
    }
  });
});

describe("publishedReadme", () => {
  const open = "<!-- unpublished -->";
  const close = "<!-- /unpublished -->";

  it("drops every unpublished block and its line ending, and keeps the rest as written", () => {
    expect(publishedReadme(`a\n${open}\nb\n${close}\nc\n${open}d${close}`, "x")).toBe("a\nc\n");
    expect(publishedReadme("no blocks [link](https://example.com) [here](#usage)\n", "x")).toBe("no blocks [link](https://example.com) [here](#usage)\n");
  });

  it("refuses markers that do not pair up", () => {
    expect(refusal(() => publishedReadme(`a ${close} b`, "x/README.md"))).toMatch(/^x\/README\.md: .* without an/);
    expect(refusal(() => publishedReadme(`${open} a ${close} ${close}`, "x"))).toMatch(/without an/);
    expect(refusal(() => publishedReadme(`${close} a ${open}`, "x"))).toMatch(/without an/);
    expect(refusal(() => publishedReadme(`a ${open} b`, "x"))).toMatch(/never closed/);
    expect(refusal(() => publishedReadme(`${open} a ${open} b ${close} ${close}`, "x"))).toMatch(/do not nest/);
  });

  it("refuses a link that only resolves in this repository", () => {
    for (const link of ["../../SPEC.md", "SPEC.md", "http://example.com", "/docs", ""]) {
      expect(refusal(() => publishedReadme(`see [it](${link})\n`, "x")), link).toMatch(/relative to this repository/);
    }
    // A relative link inside an unpublished block is dropped with it.
    expect(publishedReadme(`${open}[it](../SPEC.md)${close}`, "x")).toBe("");
  });
});

describe("buildTrees refuses", () => {
  it("a version that is not X.Y.Z", () => {
    for (const bad of ["v0.1.10", "0.1", "01.1.1", "0.1.10-rc.1", "0.1.10\n", " 0.1.10", "", undefined, 10, null]) {
      expect(refusal(() => build({ version: bad })), String(bad)).toMatch(/must be X\.Y\.Z/);
    }
    expect(VERSION.test(version)).toBe(true);
  });

  it("a missing bundle", () => {
    expect(refusal(() => build({ bundle: join(scratch, "nowhere.mjs") }))).toMatch(/does not exist/);
  });

  it("a bundle of another release, or one that is not a wim bundle", () => {
    const other = join(scratch, "other.mjs");
    writeFileSync(other, 'var GATEWAY_VERSION = "9.9.9";\nvar VERSION = "9.9.9";\n');
    expect(refusal(() => build({ bundle: other }))).toBe(`github/wim.mjs: the bundle is wim 9.9.9, not this release's ${version}`);
    const none = join(scratch, "none.mjs");
    writeFileSync(none, `console.log("${version}");\n`);
    expect(refusal(() => build({ bundle: none }))).toMatch(/not a wim client bundle \(0 VERSION/);
    const two = join(scratch, "two.mjs");
    writeFileSync(two, `var VERSION = "${version}";\nvar VERSION = "${version}";\n`);
    expect(refusal(() => build({ bundle: two }))).toMatch(/\(2 VERSION declarations/);
  });

  it("a file in a source folder that the tree does not list, or one it lists that is missing", () => {
    const extra = fixture();
    mkdirSync(join(extra, "packaging/github-action/.github/workflows"), { recursive: true });
    writeFileSync(join(extra, "packaging/github-action/.github/workflows/ci.yml"), "on: push\n");
    expect(refusal(() => build({ root: extra }))).toMatch(/^packaging\/github-action holds .*\.github\/workflows\/ci\.yml.*list a new file in TREES/);
    const missing = fixture();
    rmSync(join(missing, "packaging/gitlab-component/.gitlab-ci.yml"));
    expect(refusal(() => build({ root: missing }))).toMatch(/^packaging\/gitlab-component holds /);
  });

  it("an expression in action.yml", () => {
    const dir = fixture();
    const path = join(dir, "packaging/github-action/action.yml");
    writeFileSync(path, readFileSync(path, "utf8").replace("required: true", "required: true\n    default: ${{ github.actor }}"));
    expect(refusal(() => build({ root: dir }))).toMatch(/^github\/action\.yml: holds a \$\{\{ \}\} expression/);
  });

  it("a template that runs another release's wim", () => {
    const dir = fixture();
    const path = join(dir, "packaging/gitlab-component/templates/notify.yml");
    writeFileSync(path, readFileSync(path, "utf8").replace(`worldinmotion@${version}`, "worldinmotion@0.0.1"));
    expect(refusal(() => build({ root: dir }))).toBe(`gitlab/templates/notify.yml: wim_package does not default to worldinmotion@${version}`);
  });

  it("a README whose markers do not pair up", () => {
    const dir = fixture();
    const path = join(dir, "packaging/gitlab-component/README.md");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n<!-- unpublished -->\n`);
    expect(refusal(() => build({ root: dir }))).toMatch(/^gitlab\/README\.md: .* never closed/);
  });
});

describe("writeTrees", () => {
  it("writes both trees under a new directory and lists each file's sha256", () => {
    const out = join(scratch, "out");
    const lines = writeTrees(out, build()) as string[];
    expect(lines).toHaveLength(12);
    expect(lines[0]).toMatch(/^[0-9a-f]{64} {2}github\/LICENSE$/);
    expect(readdirSync(join(out, "gitlab/templates"))).toEqual(["notify.yml"]);
    expect(readFileSync(join(out, "github/wim.mjs")).equals(readFileSync(bundle))).toBe(true);
  });

  it("refuses a directory that already exists, and writes nothing into it", () => {
    const out = join(scratch, "exists");
    mkdirSync(out);
    expect(refusal(() => writeTrees(out, build()))).toMatch(/already exists/);
    expect(readdirSync(out)).toEqual([]);
  });
});

describe("the command line", () => {
  const io = () => ({ root, out: vi.fn(), err: vi.fn() });

  it("builds and writes, printing one line per file", () => {
    const sink = io();
    expect(cli([version, bundle, join(scratch, "cli-out")], sink)).toBe(0);
    expect(sink.out).toHaveBeenCalledTimes(12);
    expect(sink.err).not.toHaveBeenCalled();
  });

  it("prints a refusal as an error annotation, exits 1 and writes nothing", () => {
    const sink = io();
    const out = join(scratch, "cli-refused");
    expect(cli([`v${version}`, bundle, out], sink)).toBe(1);
    expect(sink.err).toHaveBeenCalledWith(expect.stringMatching(/^::error::the version is "v/));
    expect(existsSync(out)).toBe(false);
  });

  it("refuses any other number of arguments with its usage", () => {
    for (const args of [[], [version, bundle], [version, bundle, "out", "extra"]]) {
      const sink = io();
      expect(cli(args, sink)).toBe(2);
      expect(sink.err).toHaveBeenCalledWith(expect.stringMatching(/^usage: /));
    }
  });

  it("runs as release.yml runs it", { timeout: 30_000 }, () => {
    const out = join(scratch, "process-out");
    const script = join(root, ".github/scripts/notify-trees.mjs");
    const ok = spawnSync(process.execPath, [script, version, bundle, out], { encoding: "utf8", timeout: 25_000 });
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim().split("\n")).toHaveLength(12);
    const refused = spawnSync(process.execPath, [script, version, bundle, out], { encoding: "utf8", timeout: 25_000 });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/^::error::.* already exists/);
  });
});
