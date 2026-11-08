// The deployment kit: the systemd units, sudoers rule, metadata block, launcher, example configs
// and guides under packages/agent. The npm package `worldinmotion` carries it as agent-kit/ next
// to wim.mjs (packaging/npm/agent-kit.mjs copies it there for a release), and `wim agent init
// --kit <dir>` writes it out. The files are copied as they are, modes kept: the files a person
// installs are the files that were reviewed.

import { constants, promises as fs } from "node:fs";
import { dirname, join } from "node:path";

/** What the kit holds, relative to its root (packages/agent in the repository, agent-kit/ in the package). */
export const KIT_ENTRIES: readonly string[] = ["deploy", "docs/deploy.md", "docs/privileged-runner.md"];

/** The kit's root: the first candidate that holds every entry, or undefined. */
export async function findKit(candidates: readonly string[]): Promise<string | undefined> {
  for (const root of candidates) {
    const all = await Promise.all(KIT_ENTRIES.map((e) => fs.access(join(root, e)).then(() => true, () => false)));
    if (all.every(Boolean)) return root;
  }
  return undefined;
}

/**
 * Copies the kit from `from` into `to`, which must not exist yet or be empty, keeping each file's
 * mode (the launcher and scripts stay executable). Returns the files written, relative to `to`.
 */
export async function copyKit(from: string, to: string): Promise<string[]> {
  const there = await fs.readdir(to).catch(() => undefined);
  if (there !== undefined && there.length > 0) throw new Error(`${to} is not empty: the kit is written only into a new or empty directory`);
  const written: string[] = [];
  const copy = async (rel: string): Promise<void> => {
    const src = join(from, rel);
    const st = await fs.stat(src);
    if (st.isDirectory()) {
      // Relative names use "/" on every platform, as KIT_ENTRIES does.
      for (const name of (await fs.readdir(src)).sort()) await copy(`${rel}/${name}`);
      return;
    }
    const dst = join(to, rel);
    await fs.mkdir(dirname(dst), { recursive: true });
    await fs.copyFile(src, dst, constants.COPYFILE_EXCL);
    await fs.chmod(dst, st.mode & 0o777);
    written.push(rel);
  };
  for (const e of KIT_ENTRIES) await copy(e);
  return written;
}
