// Decisions on held messages, signed by the signer (`wim agent`) once the person confirmed them
// there. With an encrypted key file, an approve, refuse or resume reaches a session only as one of
// these: the signer read the items from disk itself, showed them to the person in its own terminal
// or dialog, and signed exactly those ids, each bound to a digest of the item it showed. A mark file
// any process can write is refused. Without a signer nothing here is used (SECURITY-MODEL 7.2).

import { b64u, canonBytes, isId22, isUlid, sanitizeForDisplay, sha256, utf8 } from "@worldinmotion/protocol";
import { sign as edSign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { agentEndpoint, type AgentEnv } from "./agentpath.ts";
import { ed25519Public } from "./channel.ts";
import { SetupError } from "./errors.ts";
import { preview, type HeldItem } from "./held.ts";
import { SignerClient } from "./signer.ts";

/** What a decision does: release (`approve`), drop (`refuse`), or release and lift the breaker's pause on `peer` (`resume`). */
export type DecisionVerdict = "approve" | "refuse" | "resume";

export type DecisionItem = { id: string; digest: string };

/** One held copy of an item as the signer read it, with the name of the session holding it. */
export type HeldCopy = { item: HeldItem; session: string };

/** A decision as the signer signed it. */
export type Decision = {
  v: 1;
  /** The device whose signer signed it: a session takes only its own device's. */
  device: string;
  mesh: string;
  verdict: DecisionVerdict;
  /** For `resume`: the address whose device's pause is lifted. */
  peer?: string;
  /** Every held copy the person was shown: its id and the digest of the item as it was read. */
  items: DecisionItem[];
  at: number;
  /** A fresh ULID: the decision's own name, and its file's. */
  n: string;
  sig: string;
};

/**
 * How long a decision is good for after the signer signed it: as long as a message can be (SPEC
 * section 6, 47 hours, with room), so one left for a session that is not running still applies
 * when it next runs. A replay releases nothing new either way: it names ids, each bound to a digest
 * of its item, and a decided id is never held again.
 */
export const DECISION_TTL_MS = 48 * 60 * 60_000;

/** How far into the future a decision's time may be (the signer's clock against the session's). */
export const DECISION_SKEW_MS = 5 * 60_000;

/** How long a client waits for the person to answer the signer (its dialog or terminal). */
export const DECIDE_WAIT_MS = 6 * 60_000;

/**
 * At most this many ids in one decision: the most a UI may send in one set (`wim events`), so a set
 * is always one decision. More (a resume of a long pause, a large set at the command line) is asked
 * in chunks of this size (decisionsFor), each its own confirmation.
 */
export const MAX_DECISION_IDS = 1000;

/** The signed bytes' label: no other signature of the device's key (SPEC section 3, design.md) uses it. */
const LABEL = "wim-agent/2 held-decision\n";

const ulidSchema = z.string().refine(isUlid, "expected a ULID");
const digestSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "expected a digest");

export const decisionSchema = z.strictObject({
  v: z.literal(1),
  device: z.string().refine(isId22, "expected a device id"),
  mesh: z.string().max(64),
  verdict: z.enum(["approve", "refuse", "resume"]),
  peer: z.string().min(1).max(200).optional(),
  items: z.array(z.strictObject({ id: ulidSchema, digest: digestSchema })).max(MAX_DECISION_IDS * 8),
  at: z.int().min(0),
  n: ulidSchema,
  sig: z.string().max(200),
});

/** A digest of a held item as it is on disk: a decision releases a copy only while it is unchanged. */
export function heldDigest(item: HeldItem): string {
  return b64u.encode(sha256(canonBytes(item)));
}

function signedBytes(body: Omit<Decision, "sig">): Uint8Array {
  return new Uint8Array(Buffer.concat([utf8(LABEL), canonBytes(body)]));
}

/** Signs a decision with the device key (the signer, after the person confirmed it). */
export function signDecision(body: Omit<Decision, "sig">, signKey: KeyObject): Decision {
  return { ...body, sig: b64u.encode(edSign(null, signedBytes(body), signKey)) };
}

/**
 * The decision in `raw` if it is one this session may act on: well formed, for this device and
 * mesh, signed by the device's key, and current. Otherwise why not, for the log.
 */
export function checkDecision(raw: unknown, o: { signPub: Uint8Array; device: string; mesh: string; now: number }): Decision | { refused: string } {
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success) return { refused: "it is not a decision" };
  const d = parsed.data as Decision;
  if (d.device !== o.device || d.mesh !== o.mesh) return { refused: "it is for another device or mesh" };
  if (d.verdict === "resume" && d.peer === undefined) return { refused: "a resume names no peer" };
  const { sig, ...body } = d;
  let good = false;
  try {
    good = verify(null, signedBytes(body), ed25519Public(o.signPub), b64u.decode(sig));
  } catch {
    good = false;
  }
  if (!good) return { refused: "its signature is not this device's signer's" };
  if (o.now - d.at > DECISION_TTL_MS) return { refused: `it is more than ${DECISION_TTL_MS / 3_600_000} hours old` };
  if (d.at - o.now > DECISION_SKEW_MS) return { refused: "it is dated in the future" };
  return d;
}

/** Whether a decision covers this held copy: its id, with the digest of the item as the person was shown it. */
export function covers(d: Decision, item: HeldItem): boolean {
  const digest = heldDigest(item);
  return d.items.some((i) => i.id === item.id && i.digest === digest);
}

/** What a client asks the signer to decide. The signer reads the items itself; `ids` only names them. */
export type DecideRequest = { mesh: string; verdict: DecisionVerdict; ids: readonly string[]; peer?: string };

/**
 * Asks this device's signer for a decision, on a connection of its own (the person may take
 * minutes, and a connection answers in order). The signer shows the items in its own terminal or
 * dialog and signs only what the person confirms there; every refusal is thrown as a SetupError in
 * the signer's words.
 */
export async function requestDecision(o: { root: string; env: AgentEnv; signPub: Uint8Array }, req: DecideRequest): Promise<Decision> {
  const client = new SignerClient({ endpoint: () => agentEndpoint(o.root, o.env, false), expect: o.signPub });
  try {
    const r = await client.call("decide", { mesh: req.mesh, verdict: req.verdict, ids: [...req.ids], ...(req.peer === undefined ? {} : { peer: req.peer }) }, DECIDE_WAIT_MS);
    return r["decision"] as Decision;
  } catch (error) {
    throw new SetupError(`${NEEDS_SIGNER}: ${(error as Error).message}`);
  } finally {
    client.close();
  }
}

/** `ids` in chunks of at most MAX_DECISION_IDS, in order; one empty chunk for none (a resume of an empty pause). */
export function idChunks(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += MAX_DECISION_IDS) out.push(ids.slice(i, i + MAX_DECISION_IDS));
  return out.length === 0 ? [[]] : out;
}

/**
 * The signer's decisions over `ids`: one per chunk, asked in order, so no request carries more ids
 * than the signer takes. A refusal of any chunk is thrown, and nothing is decided.
 */
export async function decisionsFor(ask: (ids: readonly string[]) => Promise<Decision>, ids: readonly string[]): Promise<Decision[]> {
  const out: Decision[] = [];
  for (const chunk of idChunks(ids)) out.push(await ask(chunk));
  return out;
}

/**
 * Of a device's decisions, the one that names `id`; the first when none does (it covers nothing of
 * that id, so nothing is decided by it). Undefined without decisions (no signer).
 */
export function decisionFor(ds: readonly Decision[] | undefined, id: string): Decision | undefined {
  return ds === undefined ? undefined : (ds.find((d) => d.items.some((i) => i.id === id)) ?? ds[0]);
}

/** A device's way to ask its signer for decisions (the events process's `decide`). */
export function decider(o: { root: string; env: AgentEnv; signPub: Uint8Array }): (req: DecideRequest) => Promise<Decision> {
  return (req) => requestDecision(o, req);
}

/** The start of every refusal a decision gets from the signer side. */
export const NEEDS_SIGNER = "this device's keys are in the signer, so a decision on held messages needs the signer to confirm it with you";

/** Said when an unsigned decision (a mark file) is refused. */
export function unsignedRefusal(what: string): string {
  return `refused an unsigned ${what}: this device's keys are in the signer, so a decision on held messages is taken only with the signer's confirmation (\`wim held\` in your own terminal, or VS Code). A file anything can write is not one`;
}

/** How many items the signer lists one by one; the rest are counted. */
const SHOWN = 10;

/**
 * What the signer shows the person before it signs: what the decision does, then each item it
 * read from disk itself (never text the asking process sent), its sender, sessions, kind, time
 * and first line. The first lines say to decline anything the person did not just ask for.
 */
export function decisionView(req: DecideRequest, copies: readonly HeldCopy[]): string[] {
  const ids = [...new Set(copies.map((c) => c.item.id))];
  const n = ids.length === 1 ? "1 held message" : `${ids.length} held messages`;
  const what =
    req.verdict === "approve"
      ? `Approve ${n}: they are delivered to your agents.`
      : req.verdict === "refuse"
        ? `Refuse ${n}: they are dropped, never delivered.`
        : `Resume ${sanitizeForDisplay(req.peer!)}: lift the loop breaker's pause on its device and release ${n}.`;
  const lines = ["worldinmotion signer: a process on this computer asks you to decide on held messages.", "Confirm only if you just asked for this yourself (wim held, VS Code). If you did not, choose Cancel.", what];
  for (const [i, id] of ids.slice(0, SHOWN).entries()) {
    const mine = copies.filter((c) => c.item.id === id);
    const r = mine[0]!.item;
    lines.push(`${i + 1}. from ${sanitizeForDisplay(r.from)} to ${mine.map((c) => sanitizeForDisplay(c.session)).join(", ")}, ${r.kind}, ${new Date(r.at).toISOString()}: ${preview(r.entry.text, 100)}`);
  }
  if (ids.length > SHOWN) lines.push(`... and ${ids.length - SHOWN} more.`);
  lines.push(`mesh ${req.mesh}`);
  return lines;
}
