import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyKit, findKit, KIT_ENTRIES } from "../src/kit.ts";

const POSIX = process.platform !== "win32";
const REPO_KIT = join(import.meta.dirname, "..");
let dir: string;

beforeAll(async () => {
  const base = process.env["WIM_TEST_TMP"] || tmpdir();
  await mkdir(base, { recursive: true });
  dir = await mkdtemp(join(base, "wim-agent-kit-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("the deployment kit", () => {
  it("is all there in the repository, under packages/agent", async () => {
    expect(await findKit([join(dir, "nowhere"), REPO_KIT])).toBe(REPO_KIT);
    expect(await findKit([join(dir, "nowhere")])).toBeUndefined();
    expect(KIT_ENTRIES).toContain("deploy");
  });

  it("is copied whole, modes kept, into a new directory", async () => {
    const to = join(dir, "out");
    const files = await copyKit(REPO_KIT, to);
    expect(files).toContain(join("docs", "deploy.md"));
    expect(files).toContain(join("deploy", "wim-agent-privileged-runner"));
    expect(files.filter((f) => f.startsWith("deploy")).length).toBeGreaterThan(5);
    if (POSIX) {
      const launcher = await stat(join(to, "deploy", "wim-agent-privileged-runner"));
      expect(launcher.mode & 0o111).not.toBe(0);
      expect((await stat(join(to, "docs", "deploy.md"))).mode & 0o111).toBe(0);
    }
  });

  it("writes into an empty directory, and never into one that holds anything", async () => {
    const empty = join(dir, "empty");
    await mkdir(empty);
    expect((await copyKit(REPO_KIT, empty)).length).toBeGreaterThan(0);
    const full = join(dir, "full");
    await mkdir(full);
    await writeFile(join(full, "mine"), "x");
    await expect(copyKit(REPO_KIT, full)).rejects.toThrow(/is not empty/);
    expect(await readdir(full)).toEqual(["mine"]);
  });

  it.skipIf(!POSIX)("keeps a file's own mode bits, not the umask's", async () => {
    const src = join(dir, "src");
    for (const e of KIT_ENTRIES) {
      const p = join(src, e);
      if (e === "deploy") {
        await mkdir(p, { recursive: true });
        await writeFile(join(p, "tool"), "#!/bin/sh\n");
        await chmod(join(p, "tool"), 0o750);
      } else {
        await mkdir(join(p, ".."), { recursive: true });
        await writeFile(p, "doc");
      }
    }
    await copyKit(src, join(dir, "modes"));
    expect((await stat(join(dir, "modes", "deploy", "tool"))).mode & 0o777).toBe(0o750);
  });
});
