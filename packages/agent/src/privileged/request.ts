// The RUNNER contract's request, read strictly, and the decisions that need the privileged
// side: who sent it, the wake code, and which profile runs it. Nothing here logs text.

import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** The contract's limit on the stdin request, in bytes. */
export const MAX_REQUEST_BYTES = 64 * 1024;

/** The sender a root caller outside sudo (a scheduled job) names when `allowLocal` is on. */
export const LOCAL_DEVICE = "local";

const Request = z.strictObject({
  v: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  from: z.strictObject({
    device: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    address: z.string().regex(/^[a-z0-9-]{1,32}@[a-z0-9.-]{1,64}$/),
  }),
  profile: z.string().max(16),
  text: z.string().refine((t) => !t.includes("\0"), "holds a NUL"),
});

export type ParsedRequest = z.infer<typeof Request>;

/** A decision that ends the run with a contract exit code; `reason` is safe to log (no text). */
export class Refusal extends Error {
  override readonly name = "Refusal";
  readonly code: number;
  constructor(code: number, reason: string) {
    super(reason);
    this.code = code;
  }
}

export const EXIT = { ok: 0, failed: 1, usage: 2, refused: 3, busy: 4, timeout: 5 } as const;

export function parseRequest(data: Buffer): ParsedRequest {
  if (data.length > MAX_REQUEST_BYTES) throw new Refusal(EXIT.refused, `request over ${MAX_REQUEST_BYTES} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch {
    throw new Refusal(EXIT.usage, "request is not UTF-8 JSON");
  }
  const r = Request.safeParse(raw);
  if (!r.success) throw new Refusal(EXIT.usage, `request is malformed at ${r.error.issues.map((i) => i.path.join(".") || "(top)").join(", ")}`);
  return r.data;
}

/** A usable wake code: at least 16 characters, no whitespace. Anything else fails closed. */
export function usableCode(code: string): boolean {
  return code.length >= 16 && !/\s/.test(code);
}

/**
 * The text after the wake code, or undefined when the text does not start with the code
 * followed by whitespace or its end. The first code-length bytes are always compared in full
 * (zero-padded when the text is shorter), so the time says nothing about how much of a guess
 * was right. The code's length is not secret.
 */
export function stripCode(text: string, code: string): string | undefined {
  const want = Buffer.from(code, "utf8");
  const got = Buffer.from(text, "utf8");
  const head = Buffer.alloc(want.length);
  got.copy(head, 0, 0, want.length);
  const same = timingSafeEqual(head, want);
  const rest = got.subarray(want.length);
  const boundary = rest.length === 0 || /^\s/.test(rest.subarray(0, 4).toString("utf8"));
  if (!same || got.length < want.length || !boundary) return undefined;
  return rest.toString("utf8");
}

// Anything shaped like a prefix (`word:` then whitespace or the end) is a profile choice and
// must be on the allow-list: `c: ...` is refused rather than run on the default profile.
const PREFIX = /^([A-Za-z0-9_-]{1,16}):(?=\s|$)/;

/** The profile and the task. `packageProfile` is what the worker parsed, if anything. */
export function chooseProfile(text: string, packageProfile: string, profiles: readonly string[], fallback: string): { profile: string; task: string } {
  let body = text.trim();
  let chosen: string | undefined;
  const m = PREFIX.exec(body);
  if (m !== null) {
    chosen = m[1]!;
    if (!profiles.includes(chosen)) throw new Refusal(EXIT.refused, "profile prefix not on the allow-list");
    body = body.slice(m[0].length).trim();
  }
  if (packageProfile !== "") {
    if (!profiles.includes(packageProfile)) throw new Refusal(EXIT.refused, "request profile not on the allow-list");
    if (chosen !== undefined && chosen !== packageProfile) throw new Refusal(EXIT.refused, "request profile and text prefix disagree");
    chosen = packageProfile;
  }
  return { profile: chosen ?? fallback, task: body };
}
