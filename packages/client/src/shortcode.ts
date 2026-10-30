// Short invite codes (SPEC section 5). The admin device seals its full invite code under a key from
// a fresh 100-bit secret, stores the box at the relay and prints `wim2-...`; the joining device
// fetches the box by a hash of that secret, opens it, and joins with the full code exactly as
// before. The relay never sees the secret.

import {
  formatShortCode,
  isShortCode,
  LIMITS,
  newShortKey,
  openRdv,
  parseInvite,
  parseJson,
  parseShortCode,
  rdvId,
  sealRdv,
  type RelayFrame,
} from "@worldinmotion/protocol";
import { ClientError, relayRefusal } from "./client.ts";
import { SetupError } from "./errors.ts";
import { errorFor, type Link } from "./wire.ts";

/** The largest box answer read; a box is at most 4 KiB of ciphertext, about 5.5 KiB as text. */
export const RDV_ANSWER_MAX_BYTES = 16 * 1024;

/** The part of `fetch` a joiner uses to read a box. */
export type BoxFetcher = (url: string, init: { signal: AbortSignal; redirect: "error"; headers: Record<string, string> }) => Promise<{ status: number; text(): Promise<string> }>;

/** Where a box lives: the relay URL with `wss://` read as `https://` (`ws://` as `http://`), then `/v1/rdv/<id>`. */
export function rdvUrl(relay: string, rdv: string): string {
  return `${relay.replace(/^ws/, "http")}/v1/rdv/${rdv}`;
}

/** A short code, the time it stops working, or why there is none. */
export type ShortOutcome = { short: { code: string; exp: number } } | { shortRefused: string };

/**
 * Stores `fullCode` at the relay as a short code's box, on the admin's authenticated link, until
 * the invite's expiry or an hour from `now`, whichever is first. Never throws: a relay that keeps
 * no short codes (one older than them answers `unknown_type`), refuses this one, or does not
 * answer gives a reason instead, and the caller shows the full code.
 */
export async function storeShortCode(link: Link, relay: string, fullCode: string, inviteExp: number, now: number): Promise<ShortOutcome> {
  const k = newShortKey();
  const box = sealRdv(k, fullCode);
  const exp = Math.min(inviteExp, now + LIMITS.rdvLifetimeMs);
  const answer = await link
    .request({ t: "rdv.put", ...box, exp }, (f) => (f.t === "rdv.stored" && f.rdv === box.rdv) || errorFor("rdv.put")(f), 10_000)
    .catch((error: unknown) => error as Error);
  return shortOutcome(answer, formatShortCode(k, relay), exp);
}

function shortOutcome(answer: RelayFrame | Error, code: string, exp: number): ShortOutcome {
  if (answer instanceof Error) return { shortRefused: `the relay did not store it (${answer.message})` };
  if (answer.t !== "error") return { short: { code, exp } };
  if (answer.code === "unknown_type" || answer.code === "unsupported") return { shortRefused: "this relay does not keep short codes" };
  return { shortRefused: relayRefusal("the relay refused it", answer).message };
}

/**
 * The full invite code for what a person typed or pasted: a full `wim1_` code as it is (`joinMesh`
 * reads it), or a short `wim2-` code resolved through its relay. Throws a SetupError for a code
 * that is not one (a typing mistake), and a ClientError when the relay has no box for it or its
 * box does not open.
 */
export async function resolveInvite(code: string, fetcher: BoxFetcher, opts: { timeoutMs?: number } = {}): Promise<string> {
  if (!isShortCode(code)) return code;
  const short = readShort(code);
  const url = rdvUrl(short.relay, rdvId(short.k));
  const read = await fetcher(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000), redirect: "error", headers: { accept: "application/json" } })
    .then(async (res) => ({ status: res.status, body: await res.text() }))
    .catch((error: unknown) => error as Error);
  return openAnswer(short, read);
}

function readShort(code: string): { k: string; relay: string } {
  try {
    return parseShortCode(code);
  } catch (error) {
    throw new SetupError((error as Error).message);
  }
}

/** The full code inside the relay's answer, checked: it must open with `k` and name the same relay. */
function openAnswer(short: { k: string; relay: string }, read: { status: number; body: string } | Error): string {
  if (read instanceof Error) throw new ClientError(`could not read the short invite code from ${short.relay}: ${read.message}`, "unreachable");
  if (read.status === 404) {
    throw new ClientError("the relay has no invite under this short code: it was used, it expired, it was mistyped, or the relay keeps no short codes. Ask the admin device for a new one", "not_found");
  }
  if (read.status === 429) throw new ClientError("the relay refused: too many short code lookups from this address. Wait a while and try again", "limited");
  if (read.status !== 200 || read.body.length > RDV_ANSWER_MAX_BYTES) throw new ClientError(`the relay's answer to the short code is not a box (HTTP ${read.status})`, "relay_error");
  const json = parseJson(read.body);
  const opened = openRdv(short.k, json.ok ? json.value : undefined);
  if (!opened.ok) throw new ClientError(`the relay's box for this short code does not open (${opened.reason}). Ask the admin device for a new code`, opened.reason);
  // Whoever sealed the box holds k, so it is the admin's; a box naming another relay is still refused.
  if (parseInvite(opened.value).relay.toLowerCase() !== short.relay.toLowerCase()) {
    throw new ClientError("the short code's invite is for another relay than the one the code names", "wrong_relay");
  }
  return opened.value;
}
