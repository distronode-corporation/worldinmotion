// The checks on a message's text: the wake code and the profile prefix.

import { createHash, timingSafeEqual } from "node:crypto";
import { PROFILE_NAME } from "./config.ts";

/**
 * Whether `given` is the wake code, in time that depends on neither value: both are hashed to 32
 * bytes first, so neither the length nor the first differing byte shows in the timing.
 */
export function codeMatches(given: string, code: string): boolean {
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(code, "utf8").digest();
  return timingSafeEqual(a, b) && code !== "";
}

/**
 * Splits a message into its wake code (the first word) and the rest, and checks the code. The
 * code is followed by whitespace or the end of the text; the rest is returned trimmed, without it.
 */
export function stripCode(text: string, code: string): { ok: true; rest: string } | { ok: false } {
  const trimmed = text.trimStart();
  const end = trimmed.search(/\s/);
  const word = end === -1 ? trimmed : trimmed.slice(0, end);
  if (!codeMatches(word, code)) return { ok: false };
  return { ok: true, rest: end === -1 ? "" : trimmed.slice(end).trim() };
}

export type ProfileParse = { ok: true; profile: string; task: string } | { ok: false };

/**
 * Reads an optional `<profile>:` prefix. A first word of profile shape followed by a colon and
 * whitespace (or the end) is a prefix: an allowed one is taken, any other is refused rather than
 * run under the default, so a typo never runs a task on the wrong account. Text that does not
 * start with such a prefix runs under the default.
 */
export function parseProfile(text: string, allowed: readonly string[], fallback: string): ProfileParse {
  const m = /^([^\s:]+):(?:\s+|$)/.exec(text);
  if (m === null || !PROFILE_NAME.test(m[1]!)) return { ok: true, profile: fallback, task: text };
  if (!allowed.includes(m[1]!)) return { ok: false };
  return { ok: true, profile: m[1]!, task: text.slice(m[0].length) };
}
