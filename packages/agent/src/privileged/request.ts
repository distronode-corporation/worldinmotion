// The RUNNER contract's request, read strictly, and the decisions that need the privileged
// side: who sent it, the wake code, and which profile runs it. Nothing here logs text.

import { z } from "zod";
import { parseProfile } from "../gate.ts";
import { RUNNER_EXIT, RUNNER_MAX_REQUEST_BYTES } from "../runner.ts";

/** The contract's limit on the stdin request, in bytes: the one constant both sides import. */
export const MAX_REQUEST_BYTES = RUNNER_MAX_REQUEST_BYTES;

/** The sender a root caller outside sudo (a scheduled job) names when `allowLocal` is on. */
export const LOCAL_DEVICE = "local";

const Request = z.strictObject({
  v: z.literal(2),
  id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  from: z.strictObject({
    device: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    address: z.string().regex(/^[a-z0-9-]{1,32}@[a-z0-9.-]{1,64}$/),
  }),
  profile: z.string().max(32),
  text: z.string().refine((t) => !t.includes("\0"), "holds a NUL"),
  /** The signed send frame the relay delivered (contract v2), verified by the runner itself. */
  frame: z.unknown().optional(),
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

/** The contract's codes, plus 1 (failed) and 2 (bad argv or request), which the worker reads as failed. */
export const EXIT = { ...RUNNER_EXIT, failed: 1, usage: 2 } as const;

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

/** The profile and the task. `packageProfile` is what the worker parsed, if anything. */
export function chooseProfile(text: string, packageProfile: string, profiles: readonly string[], fallback: string): { profile: string; task: string } {
  const parsed = parseProfile(text.trim(), profiles, fallback);
  if (!parsed.ok) throw new Refusal(EXIT.refused, "profile prefix not on the allow-list");
  const prefixed = parsed.task !== text.trim();
  if (packageProfile !== "") {
    if (!profiles.includes(packageProfile)) throw new Refusal(EXIT.refused, "request profile not on the allow-list");
    if (prefixed && parsed.profile !== packageProfile) throw new Refusal(EXIT.refused, "request profile and text prefix disagree");
    return { profile: packageProfile, task: parsed.task.trim() };
  }
  return { profile: parsed.profile, task: parsed.task.trim() };
}
