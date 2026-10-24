// Peer cards (revision 3b, section 17): a session's working directory and git branch, sealed to
// every device and shown next to its peer row. Read from files only; no git subprocess.

import { cardSchema, sanitizeForDisplay, type Card } from "@worldinmotion/protocol";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readText } from "./fsx.ts";

export type { Card };

/** The card field limits, as the protocol's card schema states them (SPEC section 17). */
const limit = (field: keyof Card): number => cardSchema.shape[field].unwrap().maxLength!;
export const CARD_LIMITS = { cwd: limit("cwd"), branch: limit("branch"), title: limit("title") } as const;

/** The branch checked out at `cwd`, from `.git/HEAD` in it or the nearest parent, or undefined. */
export async function readBranch(cwd: string): Promise<string | undefined> {
  let dir = resolve(cwd);
  for (;;) {
    const dotGit = join(dir, ".git");
    let head = await readText(join(dotGit, "HEAD")).catch(() => undefined);
    if (head === undefined) {
      // A worktree or submodule has a `.git` file naming the real git directory.
      const pointer = await readText(dotGit).catch(() => undefined);
      const m = pointer === undefined ? null : /^gitdir: (.+)$/m.exec(pointer);
      if (m !== null) {
        const gitdir = isAbsolute(m[1]!.trim()) ? m[1]!.trim() : join(dir, m[1]!.trim());
        head = await readText(join(gitdir, "HEAD")).catch(() => undefined);
      }
    }
    if (head !== undefined) {
      const text = head.trim();
      const ref = /^ref: refs\/heads\/(.+)$/.exec(text);
      if (ref !== null) return ref[1]!.slice(0, CARD_LIMITS.branch);
      return /^[0-9a-f]{7,64}$/.test(text) ? `detached ${text.slice(0, 12)}` : undefined;
    }
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/**
 * This session's card: its working directory (the base name, or the whole path when the mesh
 * shares cards in `full`) and branch, cut to the protocol limits. A session started in the home
 * directory shows no directory: its base name is usually the OS user name.
 */
export async function cardFor(cwd: string, full: boolean, home: string): Promise<Card> {
  const branch = await readBranch(cwd);
  const shown = full ? cwd : basename(resolve(cwd));
  return { ...(resolve(cwd) === resolve(home) ? {} : { cwd: shown.slice(0, CARD_LIMITS.cwd) }), ...(branch === undefined ? {} : { branch }) };
}

export function sameCard(a: Card | undefined, b: Card): boolean {
  return a !== undefined && a.cwd === b.cwd && a.branch === b.branch && a.title === b.title;
}

/** A card's fields for display in a peer row: sanitized, never trusted. */
export function cardLabel(card: Card | undefined): string {
  if (card === undefined) return "";
  const parts: string[] = [];
  if (card.cwd !== undefined) parts.push(`cwd=${sanitizeForDisplay(card.cwd).replace(/\s/g, "_")}`);
  if (card.branch !== undefined) parts.push(`branch=${sanitizeForDisplay(card.branch).replace(/\s/g, "_")}`);
  if (card.title !== undefined) parts.push(`title=${JSON.stringify(sanitizeForDisplay(card.title))}`);
  return parts.join(" ");
}
