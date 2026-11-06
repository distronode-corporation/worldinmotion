// A session on a mesh: the connection, the receiving checks and inbound policy, the spool, and
// everything a session can do (send, ask, rooms, leases, files, presence).

import {
  CI_ISSUERS,
  CLOSE,
  ciDedupeExpiry,
  dedupeExpiry,
  frameCiForAgent,
  isRecoveryName,
  isRoom,
  isVectorKey,
  leaseKey,
  LIMITS,
  openBlob,
  openMessageWith,
  relayDialUrl,
  rosterRef,
  sealBlob,
  sealMessageWith,
  sessionAddressSchema,
  signAuthWith,
  ulid,
  ulidTime,
  type BlobChunkFrame,
  type ErrorFrame,
  type Card,
  type CiClaims,
  type CiNotice,
  type FileInfo,
  type JwksFetch,
  type JoinBody,
  type LeaseFrame,
  type Prekey,
  type LeasesFrame,
  type Opened,
  type OpenRequest,
  type Peer,
  type Plaintext,
  type ReadyFrame,
  type RelayFrame,
  type Result,
  type ResultStatus,
  type RoomHistoryFrame,
  type RoomJoinedFrame,
  type Roster,
  type SendFrame,
  type PauseInfo,
  type SendResult,
  type SentFrame,
} from "@worldinmotion/protocol";
import { EventEmitter } from "node:events";
import { constants as fsConstants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Breaker, pauseNotice, pauseNoticeForAgent, pauseRule, releasedNotice, clock, type Pause } from "./breaker.ts";
import { cardFor, sameCard } from "./cards.ts";
import { checkCiNotice, CI_BREAKER, CI_PARKED_MAX, ciBucket, ciFrom, CiKeys, ciLabel, CiParked, ciPauseNotices, fetchJwks, jtiKey, noticeId } from "./cireceive.ts";
import { isPinned, readCiRules, rulesFrame, type CiPins, type CiRule } from "./cirules.ts";
import { mimeFor, saveReceived, secretsInFile, unsendable, wireFileName } from "./files.ts";
import { ensureDir, listDir, noFollow, openNoFollow, readJson, readText, removeFile, tryRemove, writeAtomic, writeJson, type FsEnv } from "./fsx.ts";
import { HeldBox, preview, takeMarks, type HeldItem, type Mark, type Verdict } from "./held.ts";
import { frameEntry, History, releasedFrame, type HistoryEntry } from "./history.ts";
import type { Device } from "./home.ts";
import { RosterBook, type MeshConfig, type MeshFiles, type Policy } from "./mesh.ts";
import { resumeEverywhere } from "./offline.ts";
import { PausedBy, readBreakerFile, savePauses, SentTo, type PausedByEntry, type PauseRow } from "./pauses.ts";
import type { Notifier } from "./notify.ts";
import { countDropped, droppedNotice, droppedPath, refusedLine, refusesLegacy, skippedNote } from "./legacyboxes.ts";
import { PeerPrekeys, PrekeyStore } from "./prekeys.ts";
import { isTrusted, noticeText, policyFor, policyLevel } from "./render.ts";
import { SeenStore, SeqStore } from "./replay.ts";
import { listSessions, newSessionState, SessionFiles, SessionKeys, type SessionState } from "./session.ts";
import { NeedsSigner } from "./keyring.ts";
import { PongBudget, type PingRow } from "./ping.ts";
import { Invites, PendingJoins, screenJoin } from "./joins.ts";
import { SignerError } from "./signer.ts";
import { Spool, type SpoolItem } from "./spool.ts";
import { Connection, errorFor, relayCode, relayText, WireError, type Dialer, type Link, type RelayQuote } from "./wire.ts";

/** How many times a delivered frame may fail for a reason of its own before it is let go. */
const FRAME_ATTEMPTS = 3;

/** The backoff before a held frame is brought again (inboundFailed): first, and at most. */
const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 5 * 60_000;

/** Error codes that are the machine's fault, not a frame's: retried, never given up on. */
const LOCAL_FAULTS: ReadonlySet<string> = new Set(["ENOSPC", "EDQUOT", "EIO", "EROFS", "EACCES", "EPERM", "EBUSY", "EMFILE", "ENFILE", "EAGAIN", "ENOTDIR", "EISDIR", "ENOENT", "ELOOP"]);

function localFault(error: unknown): boolean {
  return LOCAL_FAULTS.has(String((error as NodeJS.ErrnoException).code));
}

/**
 * Added to every refusal for a secret: how the person sends it anyway, and that it is theirs to
 * decide. The CLI, the MCP `send` tool and `wim events` all show it, so it names the one override
 * (`wim send --allow-secret`, a person at their own terminal: SECURITY-MODEL 7.4).
 */
export const SECRET_OVERRIDE =
  "If the person means to send it, the person runs the send themselves in a terminal they opened themselves: wim send <to> <text...> --allow-secret. An agent cannot skip this check.";

/** A refusal the caller should show as it is: a secret in the text, an unknown peer, a limit. */
export class ClientError extends Error {
  override readonly name = "ClientError";
  readonly code: string;
  /** Set when the message quotes the relay's own words (an `error` frame). */
  readonly quote: RelayQuote | undefined;

  constructor(message: string, code: string, quote?: RelayQuote) {
    super(message);
    this.code = code;
    this.quote = quote;
  }
}

/** A refusal that quotes a relay `error` frame: its message made safe, its code kept only when it reads as one. */
export function relayRefusal(what: string, frame: ErrorFrame): ClientError {
  const said = relayText(frame.message);
  return new ClientError(`${what}: ${said}`, relayCode(frame.code), { what, said });
}

/**
 * Whether a send's status means the message was taken (SPEC section 9): routed now, or queued, or
 * `held`, which the client reports for a routed or queued message that the recipient's loop breaker
 * holds (SPEC section 12, `pause`).
 */
export function accepted(status: string): boolean {
  return status === "routed" || status === "queued" || status === "held";
}

export type SessionOptions = {
  device: Device;
  mesh: MeshFiles;
  name: string;
  kind: string;
  /** A stable key (a Claude Code session id, `WIM_SESSION_KEY`) that takes back an earlier session. */
  sessionKey?: string;
  /**
   * Takes over the offline session on this device that holds `name`, from any directory
   * (`--take`, `WIM_TAKE=1`): refused while a live process holds the name (MeshSession.claimState).
   */
  take?: boolean;
  dialer: Dialer;
  env: FsEnv;
  now?: () => number;
  log?: (line: string) => void;
  random?: () => number;
  /** The working directory shown in this session's peer card. */
  cwd?: string;
  /** The user's home, for the credential paths `send_file` refuses. */
  userHome?: string;
  notifier?: Notifier;
  /** Milliseconds between housekeeping passes (spool sweep, presence, decisions). */
  tickMs?: number;
  /** How long a send waits for the relay's `sent`. */
  answerMs?: number;
  /** How long a message from a newer roster waits for the chain before it is parked. */
  rosterWaitMs?: number;
  /** Backoff base for reconnects. */
  reconnectMs?: number;
  /** Takes one-off sends handed over by `wim send` on this device (`wim watch` only). */
  handover?: boolean;
  /** Logs full relay URLs (`WIM_DEBUG=1`). */
  debug?: boolean;
  /** How CI providers' token keys are fetched (SPEC section 18). Default `fetchJwks`; tests pass their own. */
  jwksFetch?: JwksFetch;
  /**
   * The device's `legacy-boxes` file (legacyboxes.ts), read at each send and each open: when it
   * says `refuse`, no v0.1 box is sent or accepted (SPEC section 6b). Without one, the window.
   */
  legacyBoxesPath?: string;
};

export type PeerRow = Peer & { card?: Card };

/** A delivered item's verified fields, for in-process consumers. */
export type Inbound = HistoryEntry & { cursor: number };

/** What `post` sends: a message, or a ping, pong or pause of the client's own (SPEC section 12). */
type Outgoing = Omit<SendOptions, "kind"> & { kind?: SendOptions["kind"] | "ping" | "pong" | "pause"; pause?: PauseInfo };

/** Every address's status for a ping: the ones no roster device answers to, then the relay's. */
function pingResults(out: { local: SendResult[]; sent?: SentFrame }): SendResult[] {
  return [...out.local, ...(out.sent === undefined ? [] : out.sent.results)];
}

/** A ping's row for one address: the relay's status, and the round trip once its pong came back. */
function pingRow(address: string, results: readonly SendResult[], pongs: ReadonlyMap<string, number>): PingRow {
  const status = results.find((r) => r.to === address)!.status;
  const ms = pongs.get(address);
  return ms === undefined ? { to: address, status } : { to: address, status, ms };
}

export type SendOptions = {
  kind?: "msg" | "task" | "result" | "file";
  reply_to?: string;
  deadline?: number;
  status?: ResultStatus;
  file?: FileInfo;
  /** Only ever set by a person at the command line (SPEC section 6a). */
  allowSecrets?: boolean;
  /** A message id chosen in advance, so a waiter can be armed before the answer can arrive. */
  id?: string;
  /** The text was not written by this session (a model's output, CI logs, an external agent). */
  relayed?: boolean;
};

/**
 * During the migration window (SPEC section 6b), a send with any recipient device that has no
 * current prekey (a v0.1 client, or one offline for over 48 hours) goes in the v0.1 format for
 * every recipient, because a v0.1 client drops a frame holding a `pk` or a scheme 2 box.
 * `unprotected` then names every device that got a scheme 1 box, without forward secrecy, and
 * `no_prekey` the devices that caused it. Both are absent when every box was sealed to a prekey.
 *
 * On a device that refuses v0.1 boxes (`wim legacy-boxes refuse`), a direct send naming such a
 * device is refused instead, and a broadcast or room send skips it: `no_prekey` then names the
 * devices skipped, and `unprotected` is absent.
 */
export type SendOutcome = { id: string; results: SendRow[]; unprotected?: string[]; no_prekey?: string[] };

/**
 * One recipient's status for a send: the relay's, or `held` when the relay routed or queued it but
 * that session's loop breaker said it holds this device's messages (a `pause`, SPEC section 12).
 * `breaker` then names the rule, its numbers and when the pause ends; `relay` keeps the relay's own
 * status. A label like a receipt, never proof.
 */
export type SendRow = SendResult | { to: string; status: "held"; relay: "routed" | "queued"; breaker: HeldBreaker };

/** What a peer's breaker said when it paused this device: the rule, its numbers, and when it ends. */
export type HeldBreaker = Omit<PausedByEntry, "to" | "state" | "at">;

/** What a `held` row carries of a recorded `pause`: the rule, its numbers, and how it ends. */
function breakerOf(e: PausedByEntry): HeldBreaker {
  const { to: _to, state: _state, at: _at, ...breaker } = e;
  return breaker;
}

/** The running pause that the session at address `to` reported (paused-by.json's entries), as a `held` row carries it. */
export function pauseFrom(entries: Readonly<Record<string, PausedByEntry>>, to: string): HeldBreaker | undefined {
  const e = Object.values(entries).find((x) => x.to === to);
  return e === undefined ? undefined : breakerOf(e);
}

/** What a `held` send row means, for the agent and the person: which rule holds it there, and until when. */
export function heldSendLine(to: string, b: HeldBreaker): string {
  const after = b.auto
    ? `at ${clock(b.until)} its client delivers by itself up to its per-peer limit of what it held, and the rest waits for its person`
    : `what it holds waits for its person (the pause itself lifts at ${clock(b.until)})`;
  return `${to}: held there, not delivered: its loop breaker paused this device on ${pauseRule("this device", b)}; ${after}. Sending more now only adds to what it holds.`;
}

/** The notice for a `held` receipt: the message waits for the recipient device's person. */
export function heldReceiptLine(to: string, id: string): string {
  return `${to} is holding your message ${id}. It is not delivered now: it reaches that session if its person approves it on that device (/wim in Claude Code, the Held view in VS Code, or \`wim held approve ${id}\`), or, when its loop breaker holds it for a cool-down, possibly when that ends.`;
}

/**
 * The notice that tells the sending agent its message is held (issue #42). The `heldBy` notice is
 * the person's toast; this one reaches the model, once per recipient until something gets through.
 */
export function heldForAgentLine(to: string, id: string): string {
  return `${to} is holding your message ${id}: it is not delivered now. It gets through if the person on that device approves it, or, when that device's loop breaker holds it for a cool-down, possibly when the cool-down ends (a notice says which). Resending will not get it through sooner; if it cannot wait, tell your person.`;
}

/** The notice for a session the relay gave another name than the one it had or asked for. */
export function renamedLine(was: string, now: string): string {
  return `this session's address is ${now}, not ${was}: another session on this device holds that name. Give peers ${now}; messages sent to ${was} do not reach this session.`;
}

/** The notice for a session that got back the name it asked for, after the relay had given it `name-N`. */
export function reclaimedLine(was: string, now: string): string {
  return `this session's address is ${now} again, not ${was}: the name it asked for is free now. Give peers ${now}; messages sent to ${was} do not reach this session.`;
}

/**
 * The one notice after a claim (`--take`, the `rename` tool's `take`): the address taken over, and
 * what came with it. Held items stay the person's to decide.
 */
export function claimLine(address: string, c: { unread: number; held: number; leases: number }): string {
  const n = (k: number, one: string, many: string): string => `${k} ${k === 1 ? one : many}`;
  return `this session took over ${address}, an offline session on this device, with its queue, rooms, history and leases. With it came ${n(c.unread, "unread message", "unread messages")}, ${n(c.held, "held item", "held items")} and ${n(c.leases, "lease", "leases")}. Held items wait for the person on this device to approve or refuse (/wim, the Held view, or wim held list); a claim does not decide them.`;
}

/** What a person or an agent is told about a send that went without forward secrecy. */
export function unprotectedNote(unprotected: readonly string[], noPrekey: readonly string[]): string {
  return `Sent without forward secrecy to ${unprotected.join(", ")}: no current prekey for ${noPrekey.join(", ")} (a v0.1 client, or offline for over 48 hours), so the whole send went in the v0.1 format.`;
}

/**
 * The note a send's outcome carries about forward secrecy, if any: it went without (the window),
 * or it skipped devices with no prekey (a device that refuses v0.1 boxes). An outcome from a watch
 * that predates `no_prekey` has only `unprotected`.
 */
export function prekeyNote(o: { unprotected?: readonly string[]; no_prekey?: readonly string[] }): string | undefined {
  if (o.unprotected !== undefined) return unprotectedNote(o.unprotected, o.no_prekey ?? o.unprotected);
  return o.no_prekey === undefined ? undefined : skippedNote(o.no_prekey);
}

export type AskResult = { from: string; device: string; at: number; status: ResultStatus; text: string; id: string };

export type Delivered = {
  item: SpoolItem;
  plaintext?: Plaintext;
  fromAddress: string;
};

type TaskRecord = { from: string; at: number };
type SentTask = { at: number; any: boolean; addressees: string[] };

const CARD_EVERY_MS = 60_000;
export const PARKED_MAX = 64;
/** How long an answer to a handed-over send waits for the CLI that asked. */
export const ANSWER_KEEP_MS = 5 * 60_000;
const GROUP = (to: readonly string[]): boolean => to.some((a) => a === "*" || isRoom(a));
/** The agent hears that a peer session paused this device at most this often per session. */
const PAUSE_TELL_MS = 10 * 60_000;

/** Swallows a failure already reported to the caller of the promise it follows. */
const ignore = (): undefined => undefined;

/** A running pause's record: the address of the message that tripped it, the sending sessions told, and whether its notices went out. */
type PauseEntry = { from: string; told: Set<string>; announced: boolean };

/** A pause's numbers as `breaker` events and rows carry them. */
function breakerFields(p: Pause): { count: number; limit: number; minutes: number; until: number; auto: boolean } {
  return { count: p.count, limit: p.limit, minutes: p.minutes, until: p.until, auto: p.auto };
}

/** The notice for the agent when a peer session's breaker says it holds this device's messages. */
export function pausedThereLine(to: string, p: Extract<PauseInfo, { state: "paused" }>): string {
  const end = p.auto
    ? `until its client releases them by itself at ${clock(p.until)}, delivering up to its per-peer limit of what it held (the rest waits for its person)`
    : `until its person releases them; the pause itself lifts at ${clock(p.until)}`;
  return `${to}'s loop breaker paused messages from this device (${pauseRule("this device", p)}): what this device sends there is held, not delivered, ${end}. \`send\` reports \`held\` for ${to} until then. Sending more only adds to what it holds; if it cannot wait, tell your person.`;
}

/** A plaintext that is a message to someone: neither a card nor a ping, pong or pause (SPEC section 12). */
type Message = Exclude<Plaintext, { kind: "card" | "ping" | "pong" | "pause" }>;

/** A peer breaker's word that it holds this device's messages, or lifted that (SPEC section 12). */
type PauseMessage = Extract<Plaintext, { kind: "pause" }>;

/** A ping or a pong: answered or taken by the client itself, never spooled or shown to an agent. */
type Probe = Extract<Plaintext, { kind: "ping" | "pong" }>;

/** The verified fields of a received plaintext, as history and the agent frame read them. */
function entryOf(p: Message, from: string): HistoryEntry {
  return {
    dir: "in",
    peer: from,
    device: p.from.device,
    id: p.id,
    kind: p.kind,
    at: p.at,
    text: p.text ?? "",
    ...(p.reply_to === undefined ? {} : { reply_to: p.reply_to }),
    ...(p.kind === "result" ? { status: p.status } : {}),
    ...(p.kind === "task" && p.deadline !== undefined ? { deadline: p.deadline } : {}),
    ...(p.kind === "file" ? { file: { name: p.file.name, size: p.file.size, mime: p.file.mime } } : {}),
    ...(p.relayed === true ? { relayed: true as const } : {}),
    ...(p.derived === true ? { derived: true as const } : {}),
  };
}

/** The address under which token ids (`jti`) are kept: one store for the whole device. */
const CI_SEEN = "ci";

/**
 * Held CI notices per rule (finding 1 of the CI review): enough for the person to see and pin an
 * unpinned rule, and a page of a `--hold` rule's; past that a notice is dropped and logged.
 */
const CI_HELD_UNPINNED = 5;
const CI_HELD_PER_RULE = 20;

/** The person hears about held CI notices at most once an hour per rule. */
const CI_TELL_MS = 60 * 60_000;

/** How often notices parked for their provider's keys are checked again (refetches are once a minute anyway). */
const CI_PARKED_RETRY_MS = 60_000;

/**
 * Drop lines for CI notices per minute (finding 15 of the CI review): anyone holding a GitLab code
 * can make 60 drops a minute, so past these the drops are counted by reason, one line a minute.
 */
const CI_DROP_LINES = 10;
const CI_DROP_WINDOW_MS = 60_000;

/** One session on one mesh. */
export class MeshSession extends EventEmitter {
  readonly device: Device;
  readonly files: SessionFiles;
  state: SessionState;
  config!: MeshConfig;
  book!: RosterBook;
  spool!: Spool;
  readonly held: HeldBox;
  readonly history: History;
  readonly breaker: Breaker;
  /** The loop breaker's own bucket for CI notices, so CI never pauses a real peer (SECURITY-MODEL 7.3). */
  readonly ciBreaker: Breaker;
  readonly peers = new Map<string, PeerRow>();
  readonly receipts = new Map<string, Array<{ to: string; status: string }>>();
  private readonly cards = new Map<string, Card>();
  private readonly seen: SeenStore;
  private readonly seqs: SeqStore;
  private readonly o: SessionOptions;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly answerMs: number;
  private conn!: Connection;
  private inbound: Promise<void> = Promise.resolve();
  /** The connection on which a delivered frame waits for the signer; nothing more is acked on it. */
  private heldLink: Link | undefined;
  /** Whether this session said it must be restarted to use the signer (inboundFailed). */
  private toldRestart = false;
  /** Frames that failed for a reason of their own, by id: how many times (inboundFailed). */
  private readonly failures = new Map<string, number>();
  /** The pending drop that brings held frames again, and the backoff before the next one (retryLater). */
  private retryTimer: NodeJS.Timeout | undefined;
  private retryDelay = RETRY_FIRST_MS;
  /** Peer cards, opened one at a time in the order they came. */
  private cardsOpened: Promise<void> = Promise.resolve();
  /** Sends from seal to wire, one at a time, so frames leave in seq order (SPEC section 6). */
  private sending: Promise<void> = Promise.resolve();
  /** Spool writes, one at a time, so items are numbered and announced in order. */
  private delivering: Promise<void> = Promise.resolve();
  private ticker: NodeJS.Timeout | undefined;
  private ticking = false;
  private sentPresence: string | undefined;
  private askWaiters = new Map<string, (p: Plaintext & { kind: "result" }, from: string) => void>();
  private myCard: Card | undefined;
  private cardAt = 0;
  /** The prekey id the last card carried, so a rotation is published at once. */
  private cardPk: string | undefined;
  private prekeys!: PrekeyStore;
  private peerKeys!: PeerPrekeys;
  /**
   * Settles when the first `cards` page after `ready` has been read: peers' prekeys are known
   * then. Set by every `ready`, before any frame of that connection is handled or any send waits.
   */
  private cardsIn!: Promise<void>;
  private gotCards!: () => void;
  /** Sender devices already told about once: a message this device could no longer read. */
  private readonly unreadable = new Set<string>();
  /** Sender devices already told about once: a message dropped for its v0.1 box. */
  private readonly legacyTold = new Set<string>();
  private stopped = false;
  private derivedUntil = 0;
  private sweeping: Promise<void> = Promise.resolve();
  /** Relayed items an agent read through `inbox`, so they are not kept for later. */
  private readonly readRelayed = new Set<string>();
  /** How many pings this session answers (SPEC section 12). */
  private readonly pongBudget = new PongBudget();
  /** Per paused sender device: its pause's record (PauseEntry). Changed only with the breaker's pause, on the inbound queue. */
  private readonly pauseFrom = new Map<string, PauseEntry>();
  /** `breaker.json` writes, one at a time, each taking the rows when its turn comes. */
  private saving: Promise<void> = Promise.resolve();
  /** The last housekeeping pass, so `stop` waits for one under way. */
  private ticked: Promise<void> = Promise.resolve();
  /** A release the pass put on the inbound queue that has not run yet: at most one waits. */
  private releaseQueued = false;
  /** Deliveries counted since `breaker.json` was last written (the next pass writes them). */
  private countsChanged = false;
  /** Sessions still to hear that a pause they were told about was lifted (sent at the next pass). */
  private readonly pendingLifts = new Set<string>();
  /** The peer sessions this device's sessions sent to in the last hour, device-wide: a `pause` counts only from one. */
  readonly sentTo: SentTo;
  /** When the agent was last told that a peer device's session paused this device, by device. */
  private readonly pausedToldAt = new Map<string, number>();
  /** What peers' breakers said about this device's messages, device-wide (pauses.ts). */
  readonly pausedBy: PausedBy;
  /** Pings this session sent and still waits on, by id: each takes the pongs that answer it. */
  private readonly pongWaiters = new Map<string, (device: string, session: string) => void>();
  private readonly ciKeys: CiKeys;
  /** The `ci.rules` frame last sent on this connection, so an unchanged rules file is not sent again. */
  private ciSent: string | undefined;
  /** Whether a damaged rules file was already logged (housekeeping reads it every pass). */
  private ciDamaged = false;
  /** When the person was last told about held CI notices, per rule. */
  private readonly ciTold = new Map<string, number>();
  /** The paused CI buckets whose drops were logged since the breaker last tripped. */
  private readonly ciPausedLogged = new Set<string>();
  private readonly ciParked: CiParked;
  /** When parked CI notices are next checked again. */
  private ciParkedDue = 0;
  /** This minute's CI drop lines, and the drops past CI_DROP_LINES by reason. */
  private ciDrops = { since: 0, lines: 0, quiet: new Map<string, number>() };
  /** Delivery through MCP channel notifications instead of leaving items for the plugin. */
  push: ((item: SpoolItem) => Promise<void>) | undefined;
  /** Whether this session was opened by a claim (`take`): it took over an offline session's address. */
  takenOver = false;
  /** Whether the claim notice was written (claimNotice): once, at the first `ready`. */
  private claimTold = false;

  private constructor(o: SessionOptions, files: SessionFiles, state: SessionState) {
    super();
    this.o = o;
    this.device = o.device;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => undefined);
    this.answerMs = o.answerMs ?? 10_000;
    this.files = files;
    this.state = state;
    this.held = new HeldBox(files.heldDir, o.env);
    this.history = new History(files.historyPath, this.now);
    this.seen = new SeenStore(o.mesh.seenPath, o.env);
    this.seqs = new SeqStore(o.mesh.seqPath, o.env);
    this.breaker = new Breaker(() => this.config.breaker, this.now);
    this.ciBreaker = new Breaker(() => CI_BREAKER, this.now);
    this.pausedBy = new PausedBy(o.mesh.pausedByPath, o.env, this.now);
    this.sentTo = new SentTo(o.mesh.sentToPath, o.env, this.now);
    this.ciKeys = new CiKeys({ path: o.mesh.ciJwksPath, env: o.env, fetch: o.jwksFetch ?? fetchJwks, now: this.now });
    this.ciParked = new CiParked(files.ciParkedPath, o.env);
  }

  /**
   * Opens a session: with `take`, the one a claim finds (claimState); else the one `sessionKey`
   * names when its mapping is fresh and no live process holds it; else an earlier one from this
   * directory (sameProject); else a new one. Claims the session's liveness lock.
   */
  static async open(o: SessionOptions): Promise<MeshSession> {
    // An explicit claim comes first: the person asked for this name, not for the key's session.
    return MeshSession.opened(o, o.take === true ? await MeshSession.claimState(o) : undefined);
  }

  /**
   * A claim of the session named `o.name` (the MCP `rename` tool's `take`): opened, not started,
   * or undefined when no session on this device has that name. Refused as `claimState` refuses.
   */
  static async claim(o: SessionOptions): Promise<MeshSession | undefined> {
    const state = await MeshSession.claimState(o);
    return state === undefined ? undefined : MeshSession.opened(o, state);
  }

  /** `open` once a claim, if any, has found its session (`claimed`, its lock already taken). */
  private static async opened(o: SessionOptions, claimed: SessionState | undefined): Promise<MeshSession> {
    const now = o.now ?? Date.now;
    const keys = new SessionKeys(o.mesh, o.env, now);
    let state = claimed;
    const known = state !== undefined || o.sessionKey === undefined ? undefined : await keys.lookup(o.sessionKey);
    if (known !== undefined) {
      const kf = new SessionFiles(o.mesh, known.sid, o.env);
      const saved = await kf.load();
      // An ended session is only a tombstone at the relay; and taking the liveness lock is the
      // check that no other live process runs it.
      if (saved?.ended !== true && (await kf.claim())) {
        state = { ...(saved ?? { ...newSessionState(o.name, o.kind), sid: known.sid }), resume: known.resume, kind: o.kind };
      }
    }
    state ??= await MeshSession.sameProject(o);
    state ??= newSessionState(o.name, o.kind);
    if (o.cwd !== undefined) state = { ...state, cwd: o.cwd };
    const files = new SessionFiles(o.mesh, state.sid, o.env);
    // A new session's directory is new, so this claim cannot find another holder.
    await files.claim();
    // Whether this holder takes handed-over sends, so a one-off command neither hands a send to
    // a session that does not take them nor mistakes that session for a watch.
    await files.markHandover(o.handover === true);
    // The plugin's pane writes its marks here, so both exist from the start.
    await ensureDir(files.heldDir);
    await ensureDir(files.dismissDir);
    await files.save(state);
    if (o.sessionKey !== undefined) await keys.remember(o.sessionKey, state.sid, state.resume);
    const session = new MeshSession(o, files, state);
    session.takenOver = claimed !== undefined;
    await session.load();
    await session.settleDelivered();
    await session.restorePauses();
    return session;
  }

  /**
   * Same-project takeover (design.md, state on disk): an earlier session on this device that asked
   * for the same name from the same working directory, not ended and run by no live process, is
   * taken back with its sid and resume secret, so the relay hands over its name, queue and rooms
   * by proof. One that holds the name itself comes first; one the relay gave `name-N` asks for
   * `name` again. Sessions from another directory keep their name; this one then gets `name-N`.
   */
  private static async sameProject(o: SessionOptions): Promise<SessionState | undefined> {
    if (o.cwd === undefined) return undefined;
    const found: Array<{ files: SessionFiles; saved: SessionState }> = [];
    for (const sid of (await listSessions(o.mesh)).reverse()) {
      const files = new SessionFiles(o.mesh, sid, o.env);
      const saved = await files.load();
      if ((saved?.asked ?? saved?.name) !== o.name || saved!.cwd !== o.cwd || saved!.ended === true) continue;
      found.push({ files, saved: saved! });
    }
    // Stable: newest first within each group.
    found.sort((a, b) => Number(b.saved.name === o.name) - Number(a.saved.name === o.name));
    for (const { files, saved } of found) if (await files.claim()) return { ...saved, name: o.name, kind: o.kind };
    return undefined;
  }

  /**
   * A claim (`--take`, `WIM_TAKE=1`, the `rename` tool's `take`): the session on this device whose
   * saved name is `o.name`, from any directory, taken with its sid and resume secret, as the
   * same-project rule takes one (design.md, taking a session back). Only one that did not end, is
   * of this session's kind and whose liveness lock is free. While a live process holds the name,
   * or only a session of another kind has it, the claim is refused out loud: never a `name-N`,
   * never a replaced connection. Undefined when no session on this device has the name.
   */
  private static async claimState(o: SessionOptions): Promise<SessionState | undefined> {
    const address = `${o.name}@${o.device.name}`;
    const found: Array<{ files: SessionFiles; saved: SessionState }> = [];
    for (const sid of (await listSessions(o.mesh)).reverse()) {
      const files = new SessionFiles(o.mesh, sid, o.env);
      const saved = await files.load();
      if (saved?.name === o.name && saved.ended !== true) found.push({ files, saved });
    }
    const mine = found.find((f) => f.saved.kind === o.kind);
    if (mine === undefined) {
      if (found.length === 0) return undefined;
      throw new ClientError(`cannot take ${address}: it belongs to a session of another kind on this device (${found[0]!.saved.kind}), so messages for that name are its own`, "name_kind");
    }
    const live = `cannot take ${address}: a live session on this device holds it now. A claim takes only an offline name; this one is left as it is`;
    for (const f of found) if (f !== mine && (await f.files.isLiveElsewhere())) throw new ClientError(live, "name_live");
    if (!(await mine.files.claim())) throw new ClientError(live, "name_live");
    // The name asked for is now this one, so the same-project rule never hands it back as another.
    return { ...mine.saved, asked: o.name };
  }

  /**
   * Whether this session holds nothing anyone could miss: nothing unread or held, no lease, no
   * room, and nothing sent (receipts and results come back to its sid). Such a session may end
   * for good when another takes over its process (the `rename` tool's claim, the `hello` op).
   */
  async holdsNothing(): Promise<boolean> {
    const st = this.state;
    if (st.seq > 0 || st.rooms.length > 0 || Object.keys(st.leases).length > 0) return false;
    // Notices are this client's own lines (a `name-N`, say): nothing a peer sent.
    const unread = (await this.spool.unread()).filter((i) => i.kind !== "notice");
    return unread.length + (await this.held.list()).length === 0;
  }

  private async load(): Promise<void> {
    this.config = await this.o.mesh.loadConfig();
    this.book = await RosterBook.open(this.o.mesh);
    this.spool = await Spool.open(this.files.spoolDir, this.o.env, this.state.spool);
    this.prekeys = new PrekeyStore({ path: this.o.mesh.prekeysPath, env: this.o.env, device: this.device, mesh: this.config.mesh, now: this.now });
    // Store, rotate, delete: every process that opens the mesh runs the schedule once (SPEC section 6b).
    await this.prekeys.maintain();
    this.peerKeys = new PeerPrekeys({ path: this.o.mesh.peerPrekeysPath, env: this.o.env, now: this.now });
    await this.peerKeys.reload();
  }

  get mesh(): MeshFiles {
    return this.o.mesh;
  }

  get sid(): string {
    return this.state.sid;
  }

  /** This session's address: the name the relay assigned, at this device's roster name. */
  get address(): string {
    return this.state.address ?? `${this.state.name}@${this.device.name}`;
  }

  get roster(): Roster {
    return this.book.current;
  }

  get link(): Link | undefined {
    return this.conn?.current;
  }

  /** Connects and keeps reconnecting until `stop`. */
  start(): void {
    this.conn = new Connection({
      dialer: this.o.dialer,
      url: relayDialUrl(this.config.relay, this.config.mesh),
      ...(this.config.tls === undefined ? {} : { tlsPin: this.config.tls }),
      auth: (hello) =>
        signAuthWith(
          {
            relay: this.config.relay,
            mesh: this.config.mesh,
            nonce: hello.nonce,
            at: this.now(),
            session: { name: this.state.name, kind: this.state.kind, sid: this.state.sid, resume: this.state.resume },
            resume: { cursor: this.state.cursor },
            pin: this.book.ref,
          },
          this.device.keyring,
        ),
      onReady: (ready, link) => this.onReady(ready, link),
      onFrame: (f) => this.onFrame(f),
      onFatal: (reason) => {
        this.log(`wim: ${reason}`);
        this.emit("fatal", reason);
      },
      log: this.log,
      onState: (state, detail) => this.emit("connection", state, detail),
      random: this.o.random ?? Math.random,
      debug: this.o.debug === true,
      baseMs: this.o.reconnectMs ?? 500,
    });
    this.conn.start();
    this.ticker = setInterval(() => void this.tick(), this.o.tickMs ?? 1000);
  }

  /** Peer rows as this session knows them now (no relay round trip), cards attached as `listPeers` would. */
  knownPeers(): PeerRow[] {
    return [...this.peers.values()].map((p) => {
      const card = this.cards.get(`${this.pairOf(p.address).split("/")[0]!}/${p.sid}`);
      return card === undefined ? p : { ...p, card };
    });
  }

  /** Resolves once every frame received so far has been processed. */
  settled(): Promise<void> {
    return this.inbound;
  }

  /** Waits for the session to be connected. */
  ready(timeoutMs = 15_000): Promise<Link> {
    return this.conn.ready(timeoutMs);
  }

  /** Stops the session. `ended` tells the relay it is gone for good (its name and queue are freed). */
  async stop(opts: { ended?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.ticker);
    clearTimeout(this.retryTimer);
    this.conn?.stop({ ended: opts.ended === true });
    // A pass under way, what it queued, and the breaker's writes all land before the lock goes.
    await this.ticked;
    await this.inbound;
    await this.savePauses();
    if (opts.ended === true) this.state = { ...this.state, ended: true };
    await this.persist();
    await this.files.release();
  }

  private async save(change: Partial<SessionState>): Promise<void> {
    this.state = { ...this.state, ...change, spool: Math.max(this.state.spool, this.spool.highest) };
    await this.persist();
  }

  /** The session state's writes, one at a time; settled whatever the last one did. */
  private stateWrites: Promise<void> = Promise.resolve();

  /**
   * Writes the session's state as it is now, after every write asked for before it. Two writes in
   * flight can land in either order, and an older one landing last undid a newer field: the
   * `ended` that `stop({ ended: true })` writes, so the next command took that sid again and the
   * relay refused it as ended.
   */
  private persist(): Promise<void> {
    const state = this.state;
    const write = this.stateWrites.then(() => this.files.save(state));
    this.stateWrites = write.catch(ignore);
    return write;
  }

  // ---- connection ----

  private async onReady(ready: ReadyFrame, link: Link): Promise<void> {
    const roster = ready.roster;
    const pin = this.book.ref;
    // Walk forward from the pin; a relay that cannot show a valid chain is not believed.
    if (roster.seq > pin.seq) await this.walk(link, roster.seq);
    else if (roster.seq === pin.seq && rosterRef(roster).hash !== pin.hash) await this.forkFrom(roster, link);
    // A device keeps the name it joined with; the roster has no rename (SPEC section 4).
    const address = `${ready.name}@${this.device.name}`;
    // The address this session had, or for a new one the address it asked for.
    const was = this.state.address ?? `${this.state.name}@${this.device.name}`;
    // The name asked for is kept beside the one assigned, so a `name-N` is taken back as `name`.
    const asked = this.state.asked ?? this.state.name;
    await this.save({ name: ready.name, asked, address, cursor: Math.max(this.state.cursor, ready.cursor) });
    // The relay gave another name (another session on this device holds the one asked for): the
    // agent must learn its own address, or it gives peers one that does not reach it (issue #36).
    if (address !== was) this.noticeLater(this.address, ready.name === asked ? reclaimedLine(was, address) : renamedLine(was, address));
    if (this.takenOver && !this.claimTold) this.claimNotice(link);
    this.peers.clear();
    for (const p of ready.peers) this.peers.set(p.address, p);
    this.emit("peers");
    this.sentPresence = undefined;
    this.cardsIn = new Promise((resolve) => (this.gotCards = resolve));
    this.emit("ready", this.address);
    void this.sendCard(link, true);
    this.ciSent = undefined;
    void this.sendCiRules(link);
    this.retryParkedLater();
  }

  /**
   * Writes the claim notice once (claimLine). The relay sends what it queued for the session right
   * after `ready` and answers a later request only after that, so once the lease list is in, every
   * queued message is on the inbound queue; the count is taken when those are spooled.
   */
  private claimNotice(link: Link): void {
    this.claimTold = true;
    void link
      .request({ t: "lease.list" }, (f) => f.t === "leases", this.answerMs)
      .then(async (f) => {
        await this.inbound;
        const unread = (await this.spool.unread()).filter((i) => i.kind !== "notice").length;
        const held = (await this.held.list()).length;
        const leases = (f as LeasesFrame).leases.filter((l) => l.holder === this.address).length;
        await this.notice(this.address, claimLine(this.address, { unread, held, leases }));
      })
      .catch((e: unknown) => this.log(`wim: claim notice not written: ${(e as Error).message}`));
  }

  /**
   * Retries parked messages after the frames already queued. Each parked message's own failure is
   * kept to it (retryParked); anything else is logged. Never left as a rejection on the inbound
   * queue, where it would be unhandled, or skip the next frame's handler.
   */
  private retryParkedLater(): void {
    this.inbound = this.inbound.then(() => this.retryParked()).catch((e: unknown) => this.log(`wim: parked: ${(e as Error).message}`));
  }

  /** Fetches roster pages from the newest verified one until `upto` (or the relay's newest). */
  private async walk(link: Link, upto: number): Promise<void> {
    while (this.roster.seq < upto) {
      const page = (await link.request({ t: "roster.get", from: this.roster.seq }, (f) => f.t === "roster" || errorFor("roster.get")(f), this.answerMs)) as RelayFrame;
      if (page.t !== "roster") {
        const what = "the relay would not serve the roster chain";
        const said = relayText((page as ErrorFrame).message);
        throw new WireError(`${what}: ${said}`, "roster", { what, said });
      }
      const result = await this.book.accept(page.chain);
      if (!result.ok) {
        if (result.fork !== undefined) await this.alertFork(result.fork.a, result.fork.b, link);
        throw new WireError(`the relay served a roster chain that does not verify (${result.reason})`, "roster");
      }
      // A page that moved nothing forward ends the walk, so a relay cannot keep it looping.
      if (!page.more || !result.advanced) break;
    }
  }

  private async forkFrom(other: Roster, link: Link): Promise<void> {
    const result = await this.book.accept([other]);
    if (!result.ok && result.fork !== undefined) await this.alertFork(result.fork.a, result.fork.b, link);
  }

  private async alertFork(a: Roster, b: Roster, link: Link | undefined): Promise<void> {
    this.config = await this.o.mesh.loadConfig();
    try {
      link?.send({ t: "roster.fork", a, b });
    } catch {
      // Evidence is a courtesy to the relay; the person is told either way.
    }
    const line = `the mesh roster forked at seq ${a.seq}: two different valid rosters exist. No more roster changes are accepted, and messages from devices added after the fork are dropped. Check with the mesh's admins.`;
    this.log(`wim: ${line}`);
    await this.notice(this.address, line);
    await this.o.notifier?.notify("worldinmotion: the mesh roster forked; check the mesh");
  }

  private onFrame(f: RelayFrame): void {
    switch (f.t) {
      case "deliver": {
        // The connection it came on: only that one acks it (see ack).
        const via = this.link;
        this.inbound = this.inbound.then(() => this.handleDeliver(f.cursor, f.msg, via)).catch((e: unknown) => this.inboundFailed(e, f.msg.id));
        return;
      }
      case "roster":
        this.inbound = this.inbound.then(() => this.onRosterPush(f.chain)).catch((e: unknown) => this.log(`wim: roster: ${(e as Error).message}`));
        return;
      case "peers":
        this.peers.clear();
        for (const p of f.peers) this.peers.set(p.address, p);
        this.emit("peers");
        return;
      case "peer":
        if (f.peer.address !== this.address) this.peers.set(f.peer.address, f.peer);
        this.emit("peers");
        return;
      case "receipt": {
        const list = this.receipts.get(f.id) ?? [];
        list.push({ to: f.to, status: f.status });
        this.receipts.set(f.id, list);
        this.emit("receipt", f);
        void this.recordReceipt(f).catch((e: unknown) => this.log(`wim: receipt: ${(e as Error).message}`));
        return;
      }
      case "notice":
        this.noticeLater(f.of, `${f.of} is now idle (or has ended).`);
        return;
      case "join.request":
        // `wim invite` decides these as they come; every session of an admin device also keeps
        // one that passes the checks for `wim devices admit`, after the frames before it.
        this.emit("join", f.join);
        this.inbound = this.inbound.then(() => this.keepJoin(f.join)).catch((e: unknown) => this.log(`wim: join request not kept: ${(e as Error).message}`));
        return;
      // Cards (SPEC section 17) only annotate peer rows: never spooled, never a wake.
      case "cards": {
        for (const c of f.cards) this.takeCard(c);
        // Peers' prekeys from this page are known now (sends wait for the first page).
        this.gotCards();
        // Pages are in sid order; the next one starts after the last card of this one.
        const last = f.cards.at(-1);
        if (f.more && last !== undefined) this.sendIfOpen({ t: "cards.get", after: last.from.sid });
        return;
      }
      case "card":
        this.takeCard(f.msg);
        return;
      case "ci.deliver": {
        const via = this.link;
        this.inbound = this.inbound.then(() => this.handleCiDeliver(f.cursor, f.msg, via)).catch((e: unknown) => this.inboundFailed(e, f.msg.id));
        return;
      }
    }
  }

  /**
   * Keeps a join request for the person (SPEC section 5): only one for an invite this device
   * issued that passes every check a person is not needed for. Its comparison code is not kept:
   * the person types it from the new device's screen.
   */
  private keepJoin(body: JoinBody): Promise<void> {
    // Chained rather than awaited, so each decision sits in a plain function (see publishCard).
    return screenJoin(new Invites(this.o.mesh, this.o.env, this.now), this.roster, body, this.now()).then((screened) => {
      if (screened.outcome !== "ok") return undefined;
      return new PendingJoins(this.o.mesh, this.o.env).save(body, screened.record.exp, this.now()).then((fresh) => this.announceJoin(fresh, screened.device.name));
    });
  }

  /** Tells the person about a join request kept for the first time; one kept before is not news. */
  private announceJoin(fresh: boolean, name: string): Promise<void> | undefined {
    if (!fresh) return undefined;
    return this.o.notifier?.notify(`worldinmotion: a device named ${name} asks to join the mesh (wim devices pending)`);
  }

  /** Takes a prekey from a card or message header: known at once, written for siblings in the background. */
  private learn(pk: unknown): void {
    this.peerKeys.offer(pk, this.roster).catch((e: unknown) => this.log(`wim: prekey not stored: ${(e as Error).message}`));
  }

  /**
   * A card's header carries its device's prekey, known at once; its labels annotate the session's
   * peer row once it is opened, in the order cards came.
   */
  private takeCard(frame: SendFrame): void {
    this.learn(frame.pk);
    this.cardsOpened = this.cardsOpened
      .then(() => this.openFresh(frame, true))
      .then((opened) => this.annotate(opened))
      .catch((e: unknown) => this.log(`wim: peer card not read: ${(e as Error).message}`));
  }

  private annotate(opened: Result<Plaintext>): void {
    if (!opened.ok || opened.value.kind !== "card") return;
    // A card belongs to its sending session: device id and sid, never the relay's name label.
    const from = opened.value.from;
    const key = `${from.device}/${from.sid}`;
    // A card with no labels only carried its prekey (cards off, or no working directory).
    if (Object.keys(opened.value.card).length === 0) this.cards.delete(key);
    else this.cards.set(key, opened.value.card);
    this.emit("peers");
  }

  private async onRosterPush(chain: Roster[]): Promise<void> {
    const result = await this.book.accept(chain);
    if (!result.ok && result.reason === "gap" && this.link !== undefined) await this.walk(this.link, chain.at(-1)!.seq);
    else if (!result.ok && result.fork !== undefined) await this.alertFork(result.fork.a, result.fork.b, this.link);
    if (this.roster.revoked.includes(this.device.id)) this.emit("fatal", "this device was revoked from the mesh");
    await this.retryParked();
  }

  // ---- receiving ----

  private receiver() {
    return {
      deviceId: this.device.id,
      keyring: this.prekeys.opener(),
      address: this.address,
      sid: this.state.sid,
      rooms: this.state.rooms,
    };
  }

  private async open(msg: SendFrame, history = false) {
    // A device that refuses v0.1 boxes drops them as `legacy_box`, the reason 1.0 gives (SPEC section 6b).
    const legacy = !(await this.refusesLegacy());
    return openMessageWith(msg, { roster: this.roster, me: this.receiver(), now: this.now(), history, legacy });
  }

  /** Whether this device refuses v0.1 boxes now (`wim legacy-boxes`): read each time, so a change reaches a running session. */
  private async refusesLegacy(): Promise<boolean> {
    return this.o.legacyBoxesPath === undefined ? false : (await refusesLegacy(this.o.legacyBoxesPath)).refuse;
  }

  /**
   * Opens a frame; a box for a prekey this session has not read yet is tried again after a reload.
   * Rejects when the device's keyring cannot answer (the signer is locked or stopped): the frame
   * is then not acknowledged, and the relay delivers it again.
   */
  private async openFresh(msg: SendFrame, history = false) {
    return this.retryOpen(await this.open(msg, history), msg, history);
  }

  /**
   * Tried again after reading the device's prekeys afresh: a box for a prekey a sibling session
   * made since (`key_expired`), or one whose sealed secret this session holds from before the key
   * file was decrypted and encrypted again, under a new data key (`decrypt_failed`).
   */
  private retryOpen(first: Awaited<ReturnType<MeshSession["open"]>>, msg: SendFrame, history: boolean) {
    if (first.ok || (first.reason !== "key_expired" && first.reason !== "decrypt_failed")) return Promise.resolve(first);
    return this.prekeys.reload().then(() => this.open(msg, history));
  }

  /** Sends a frame if connected; while offline it is dropped (acks and receipts are not resent). */
  private sendIfOpen(frame: object): boolean {
    const link = this.link;
    if (link === undefined || !link.isOpen) return false;
    link.send(frame);
    return true;
  }

  /**
   * A delivered frame that could not be handled is not acknowledged. When the device's signer
   * could not answer (locked, stopped, slow), nothing more is acknowledged on this connection and
   * it is dropped: acks are cumulative, so acking a later frame would tell the relay this one was
   * taken. The next connection authenticates only once the signer answers, and the relay then
   * delivers everything after the last ack again.
   */
  /** How many times this frame has failed for a reason of its own, this one included (the last 64 frames are remembered). */
  private failedAgain(id: string): number {
    const n = (this.failures.get(id) ?? 0) + 1;
    this.failures.delete(id);
    this.failures.set(id, n);
    if (this.failures.size > 64) this.failures.delete(this.failures.keys().next().value!);
    return n;
  }

  private inboundFailed(error: unknown, id?: string): void {
    // The key file was encrypted under this session: no reconnect helps (this process will never
    // open it), so nothing more is acked on this connection and the person is told once to restart.
    if (error instanceof NeedsSigner) {
      this.heldLink = this.link;
      if (!this.toldRestart) {
        this.log(`wim: ${error.message}`);
        // Also where the person looks: the plugin shows it, `wim watch` prints it.
        this.noticeLater(this.address, error.message, true);
      }
      this.toldRestart = true;
      return;
    }
    this.log(`wim: inbound: ${(error as Error).message}`);
    // When the signer could not answer, or what answers is not the signer, nothing more is acked
    // on this connection and it goes now: the next one authenticates only once the real signer
    // answers, and the relay delivers this frame again then. Never given up on.
    if (error instanceof SignerError && (error.transient || error.code === "mismatch")) {
      this.heldLink = this.link;
      this.link?.close(CLOSE.bye, "the device's signer did not answer");
      return;
    }
    // A frame that fails for a reason of its own (a signer's `refused` or `bad_request`, a bad
    // file) the third time it comes is let go: logged, not held, so the next ack passes it. A
    // local fault (a full disk, an I/O error, a permission) is the machine's, not the frame's:
    // never counted, retried until it clears.
    if (id !== undefined && !localFault(error) && this.failedAgain(id) >= FRAME_ATTEMPTS) {
      this.log(`wim: inbound: giving up on message ${id} after ${FRAME_ATTEMPTS} attempts; it will not be delivered`);
      return;
    }
    // Otherwise nothing more is acked on this connection (a later ack would take this frame with
    // it), and the connection is dropped after a backoff, so the relay delivers it again.
    this.heldLink = this.link;
    this.retryLater();
  }

  /**
   * Drops the connection after the current backoff (1 s, doubling to 5 min, back to 1 s once a
   * frame is acked), so a held frame is delivered again without waiting for a reconnect.
   */
  private retryLater(): void {
    if (this.retryTimer !== undefined) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(RETRY_MAX_MS, delay * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.link?.close(CLOSE.bye, "trying a message that could not be handled again");
    }, delay);
    this.retryTimer.unref();
  }

  /**
   * Acks a frame on the connection it came on, `via`. Acks are cumulative, so a frame from an
   * earlier connection, handled after a reconnect, is not acked on the new one (it could ack past
   * a frame that failed); the relay delivers it again there, and dedupe drops the copy. Nothing
   * is acked on a connection on which a frame waits for the signer (inboundFailed).
   */
  private ack(cursor: number, via: Link | undefined): void {
    if (via !== this.link || via === this.heldLink) return;
    // The relay redelivers anything not acked, and dedupe drops the copy.
    if (!this.sendIfOpen({ t: "ack", cursor })) return;
    this.state = { ...this.state, cursor: Math.max(this.state.cursor, cursor) };
    this.retryDelay = RETRY_FIRST_MS;
  }

  private receipt(id: string, status: "delivered" | "held" | "refused"): void {
    this.sendIfOpen({ t: "receipt", id, to: this.address, status });
  }

  private async handleDeliver(cursor: number, msg: SendFrame, via: Link | undefined): Promise<void> {
    await this.check(msg);
    this.ack(cursor, via);
    await this.save({});
  }

  /** Runs a frame through the receiving checks on the inbound queue, one frame at a time. */
  receive(msg: SendFrame): Promise<"accepted" | "dropped" | "behind"> {
    const run = this.inbound.then(() => this.check(msg));
    this.inbound = run.then(() => undefined, () => undefined);
    return run;
  }

  /** The receiving checks of SPEC section 6, in order, then policy, the breaker and the spool. */
  private async check(msg: SendFrame, parked = false): Promise<"accepted" | "dropped" | "behind"> {
    let r = await this.openFresh(msg);
    if (!r.ok && r.reason === "roster_behind" && this.link !== undefined) {
      const before = this.roster.seq;
      await this.walk(this.link, msg.roster.seq).catch((e: unknown) => this.log(`wim: ${(e as Error).message}`));
      // Messages parked behind the old roster go first, in the order they came.
      if (!parked && this.roster.seq > before) await this.retryParked();
      r = await this.openFresh(msg);
    }
    if (!r.ok && r.reason === "roster_behind") {
      // Held until the chain can be verified: parked on disk, retried when the roster moves.
      if (!parked) {
        // At most 64 wait (revision 4): a flood from a relay withholding rosters drops the oldest.
        const waiting = (await listDir(this.files.behindDir)).sort();
        for (const name of waiting.slice(0, Math.max(0, waiting.length - (PARKED_MAX - 1)))) await removeFile(join(this.files.behindDir, name));
        await writeJson(join(this.files.behindDir, `${msg.id}.json`), msg, this.o.env);
      }
      return "behind";
    }
    if (!r.ok) {
      if (r.reason === "roster_fork" && this.link !== undefined) await this.probeFork(this.link, msg.roster.seq);
      if (r.reason === "key_expired") await this.unreadableFrom(msg);
      if (r.reason === "legacy_box") await this.legacyFrom(msg);
      this.log(`wim: dropped ${msg.id}: ${r.reason}`);
      return "dropped";
    }
    this.learn(msg.pk);
    const fork = this.book.fork;
    if (fork !== undefined && !fork.base.includes(msg.from.device)) {
      this.log(`wim: dropped ${msg.id}: its sender was added after the roster fork`);
      return "dropped";
    }
    const p = r.value;
    // A card is never a message: it comes only in card frames, so one delivered is dropped.
    if (p.kind === "card") return "dropped";
    // A device whose key is a published test-vector key is not believed (SPEC section 16): its secret is public.
    const sender = this.roster.devices.find((d) => d.id === msg.from.device)!;
    if ([sender.sign, sender.box].some(isVectorKey)) {
      this.log(`wim: dropped ${msg.id}: its sender holds a published test-vector key`);
      return "dropped";
    }
    const address = this.address;
    if (await this.seen.has(p.id, address, this.now())) return "dropped";
    if (!(await this.seqs.isNew(address, msg.from.device, msg.from.sid, msg.seq))) return "dropped";
    await this.accept(p);
    await this.seen.add(p.id, address, dedupeExpiry(p.at), this.now());
    await this.seqs.record(address, msg.from.device, msg.from.sid, msg.seq);
    return "accepted";
  }

  /**
   * A live message sealed to a prekey this device no longer holds (SPEC section 6b): deleted on
   * schedule, or lost with the prekey file. The relay offers no way to tell the sender, so the
   * session is told, once per sender device, and the message is dropped like any unreadable one.
   */
  private async unreadableFrom(msg: SendFrame): Promise<void> {
    if (this.unreadable.has(msg.from.device)) return;
    this.unreadable.add(msg.from.device);
    // Its signature verified before decryption was tried, so the sender is in the roster.
    const name = this.roster.devices.find((d) => d.id === msg.from.device)!.name;
    await this.notice(
      `${msg.from.session}@${name}`,
      `A message from ${msg.from.session}@${name} could not be read: it was sealed to a prekey this device no longer holds (deleted 72 hours after it expired, or lost with this device's prekey file). Ask the sender to send it again.`,
    );
  }

  /**
   * A message dropped for its v0.1 box, on a device that refuses them (SPEC section 6b): the
   * session is told once per sender device, naming the first address seen, with no text (none was
   * opened), and the device's count, which `wim status` shows, goes up by one. Keyed by the
   * verified device, not the address: the session name is the sender's to choose, so one device
   * could otherwise get a notice per name.
   */
  private async legacyFrom(msg: SendFrame): Promise<void> {
    if (!this.legacyTold.has(msg.from.device)) {
      this.legacyTold.add(msg.from.device);
      // Its signature verified before the box was looked at, so the sender is in the roster.
      const address = `${msg.from.session}@${this.roster.devices.find((d) => d.id === msg.from.device)!.name}`;
      await this.notice(address, droppedNotice(address));
    }
    // Only a device with the setting's file refuses v0.1 boxes, so the path is set.
    await countDropped(droppedPath(this.o.legacyBoxesPath!), this.o.env);
  }

  /** A message whose roster ref has our seq but another hash: ask the relay which roster it holds. */
  private async probeFork(link: Link, seq: number): Promise<void> {
    const page = await link.request({ t: "roster.get", from: seq }, (f) => f.t === "roster" || errorFor("roster.get")(f), this.answerMs).catch(() => undefined);
    if (page?.t === "roster") await this.forkFrom(page.chain[0]!, link);
  }

  /**
   * Checks parked messages again. One that fails (a locked signer, a full disk) stays parked for
   * the next retry (each ready and each roster change), and its failure is its own: it never
   * counts against the frame whose check started this retry.
   */
  private async retryParked(): Promise<void> {
    for (const name of await listDir(this.files.behindDir)) {
      const path = join(this.files.behindDir, name);
      const msg = (await readJson(path).catch(() => undefined)) as SendFrame | undefined;
      const outcome = msg === undefined ? "dropped" : await this.check(msg, true).catch((e: unknown) => this.parkedFailed(name, e));
      // Checked again on a later retry if it cannot be removed yet; a repeat is dropped as seen.
      if (outcome !== "behind") await tryRemove(path, this.o.env);
    }
  }

  /** A parked message that could not be checked now: logged, and left parked ("behind") for the next retry. */
  private parkedFailed(name: string, error: unknown): "behind" {
    this.log(`wim: parked message ${name} kept for the next retry: ${(error as Error).message}`);
    return "behind";
  }

  // ---- CI notices (SPEC section 18) ----

  /** The person's CI rules: undefined with no rules file; none when the file is damaged (logged once until it reads again). */
  private ciRulesNow(): Promise<CiRule[] | undefined> {
    return readCiRules(this.o.mesh.ciRulesPath).then(
      (rules) => {
        this.ciDamaged = false;
        return rules;
      },
      (e: unknown) => {
        if (!this.ciDamaged) this.log(`wim: ${(e as Error).message}; no CI notice is accepted until it is fixed`);
        this.ciDamaged = true;
        return [];
      },
    );
  }

  /**
   * Tells the relay this device's rule tags (`ci.rules`), which also marks this session as taking
   * CI notices: after `ready`, and whenever the rules file changes. A device with no rules file
   * sends nothing; one whose rules are all removed (or whose file is damaged) sends none, so the
   * relay forgets the old tags.
   */
  private async sendCiRules(link: Link): Promise<void> {
    const rules = await this.ciRulesNow();
    if (rules === undefined && this.ciSent === undefined) return;
    const frame = rulesFrame(rules ?? [], this.config.mesh, this.device.id);
    const text = JSON.stringify(frame);
    if (text === this.ciSent) return;
    try {
      link.send(frame);
      this.ciSent = text;
    } catch (error) {
      this.log(`wim: CI rules not sent: ${(error as Error).message}`);
    }
  }

  /**
   * A notice is always acknowledged once handled: one whose provider's keys cannot be fetched now
   * is parked locally and checked again later, so it never holds the ack stream (which would keep
   * every later message, a real peer's included, queued at the relay).
   */
  private async handleCiDeliver(cursor: number, msg: CiNotice, via: Link | undefined): Promise<void> {
    if ((await this.checkCi(msg)) === "unreachable") await this.parkCi(msg);
    this.ack(cursor, via);
    await this.save({});
  }

  private async parkCi(msg: CiNotice): Promise<void> {
    let full = false;
    await this.ciParked.update((parked) => {
      full = parked.length >= CI_PARKED_MAX;
      return full ? parked : [...parked, msg];
    });
    if (full) {
      this.logCiDrop("parked_full", `wim: dropped CI notice ${msg.id}: its provider's keys could not be fetched, and ${CI_PARKED_MAX} notices already wait for them`);
      return;
    }
    this.ciParkedDue = this.now() + CI_PARKED_RETRY_MS;
    this.log(`wim: CI notice ${msg.id}: its provider's keys could not be fetched; it is kept and checked again later`);
  }

  /**
   * Checks parked notices again (housekeeping, once a minute): delivered, dropped, or kept while
   * the keys are still out of reach, until the notice is too old to be delivered at all.
   */
  private async retryCiParked(): Promise<void> {
    if (this.now() < this.ciParkedDue) return;
    this.ciParkedDue = this.now() + CI_PARKED_RETRY_MS;
    const parked = await this.ciParked.list();
    if (parked.length === 0) return;
    const kept: CiNotice[] = [];
    const settled = new Set(parked.map((n) => n.id));
    for (const n of parked) {
      if (this.now() - n.at > LIMITS.messageMaxAgeMs) this.log(`wim: dropped CI notice ${n.id}: its provider's keys could not be fetched before it was too old`);
      else if ((await this.checkCi(n)) === "unreachable") kept.push(n);
    }
    // Notices parked while these were checked stay parked.
    await this.ciParked.update((now) => [...kept, ...now.filter((n) => !settled.has(n.id))]);
  }

  /** Logs a CI drop while this minute's lines last; past them it is only counted, by reason. */
  private logCiDrop(reason: string, line: string): void {
    this.flushCiDrops();
    if (this.ciDrops.lines < CI_DROP_LINES) {
      this.ciDrops.lines += 1;
      this.log(line);
      return;
    }
    this.ciDrops.quiet.set(reason, (this.ciDrops.quiet.get(reason) ?? 0) + 1);
  }

  /** Once the minute is over (checked on each drop and in housekeeping): one line for the uncounted drops, and new lines. */
  private flushCiDrops(): void {
    const now = this.now();
    if (now - this.ciDrops.since < CI_DROP_WINDOW_MS) return;
    const quiet = [...this.ciDrops.quiet];
    if (quiet.length > 0) {
      const total = quiet.reduce((n, [, c]) => n + c, 0);
      this.log(`wim: dropped ${total} more CI notices without a line in the last minute (${quiet.map(([r, c]) => `${r}: ${c}`).join(", ")})`);
    }
    this.ciDrops = { since: now, lines: 0, quiet: new Map() };
  }

  /** Opens a notice's box; one for a prekey a sibling session made since is tried again after a reload. */
  private async openCi(req: OpenRequest): Promise<Opened> {
    const first = await this.prekeys.opener().open(req);
    if (first !== "key_expired" && first !== "decrypt_failed") return first;
    await this.prekeys.reload();
    return this.prekeys.opener().open(req);
  }

  /**
   * The receiving checks of SPEC section 18, then single use, the rule's hold, the CI breaker and
   * the spool. `unreachable` when the notice names a key of a provider whose keys could not be
   * fetched: no verdict yet.
   */
  private async checkCi(raw: CiNotice): Promise<"unreachable" | undefined> {
    const now = this.now();
    const r = await checkCiNotice(raw, {
      me: { mesh: this.config.mesh, device: this.device.id, name: this.state.name },
      open: (req) => this.openCi(req),
      keys: this.ciKeys.lookup,
      rules: (await this.ciRulesNow()) ?? [],
      now,
    });
    if (!r.ok && r.reason === "unknown_key" && this.ciKeys.unreachable(CI_ISSUERS[raw.via])) return "unreachable";
    if (!r.ok) {
      this.logCiDrop(r.reason, `wim: dropped CI notice ${noticeId(raw)}: ${r.reason}`);
      return undefined;
    }
    const { notice, plaintext, claims, rule, pins } = r.value;
    // A token's id is single use on the whole device, a notice id per receiving address. Claimed
    // under the device-wide lock before the notice is delivered, so two sessions given one token
    // at once cannot both pass; a failure after the claim loses the notice, the safe side.
    const until = ciDedupeExpiry(notice.at, claims.exp);
    if (!(await this.seen.claim([[notice.id, this.address], [jtiKey(claims), CI_SEEN]], until, now))) {
      this.logCiDrop("seen", `wim: dropped CI notice ${notice.id}: seen before`);
      return undefined;
    }
    await this.acceptCi(notice, plaintext.text, claims, rule, pins);
    return undefined;
  }

  /**
   * A notice that passed every check: relayed CI text, information only. Held for the person when
   * its rule has no ids yet (approving it pins them), when the rule holds every notice, or when it
   * trips the CI breaker; otherwise it waits in the inbox and never starts a turn. Once the breaker
   * paused its repository (or all CI), later notices are dropped, and a rule holds at most a few,
   * so no repository can fill the held list or raise notices without limit.
   */
  private async acceptCi(notice: CiNotice, text: string, claims: CiClaims, rule: CiRule, pins: CiPins | undefined): Promise<void> {
    const label = ciLabel(claims, rule);
    const from = ciFrom(label);
    const entry: HistoryEntry = { dir: "in", peer: from, id: notice.id, kind: "msg", at: notice.at, text, relayed: true, ci: label };
    const item: Omit<HeldItem, "reason"> = {
      id: notice.id,
      from,
      device: "",
      kind: "msg",
      at: notice.at,
      preview: preview(text),
      rendered: frameCiForAgent({ id: notice.id, at: notice.at, text, label }),
      entry,
      ci: { rule: rule.id, ...(pins === undefined ? {} : { pins }) },
    };
    // Counted before any hold, held or delivered alike. Only the notice that trips the breaker is
    // held (with the pause notices); while it stays paused the rest are dropped, logged once a pause.
    const bucket = ciBucket(claims);
    const admitted = this.ciBreaker.admit(bucket, text.length);
    if (!admitted.ok && !admitted.newly) {
      if (!this.ciPausedLogged.has(bucket)) {
        this.ciPausedLogged.add(bucket);
        this.log(`wim: dropped CI notice ${notice.id}: CI notices from ${from} are paused; later ones are dropped without a line until the hour rolls over`);
      }
      return;
    }
    const reason = admitted.ok ? "policy" : "breaker";
    if (admitted.ok && pins === undefined && rule.hold !== true) return this.release(item, undefined);
    const cap = pins !== undefined ? CI_HELD_UNPINNED : CI_HELD_PER_RULE;
    if ((await this.held.list()).filter((h) => h.ci?.rule === rule.id).length >= cap) {
      this.logCiDrop("held_full", `wim: dropped CI notice ${notice.id}: ${cap} notices under its rule already wait for the person (wim held list)`);
      return;
    }
    if (!admitted.ok) {
      this.ciPausedLogged.clear();
      this.emit("breaker", { peer: from, state: "tripped", reason: admitted.reason });
    }
    return this.hold({ ...item, reason }, admitted.ok ? undefined : ciPauseNotices(from, admitted.reason as "peer" | "total"));
  }

  private fromAddress(p: Plaintext): string {
    const name = this.roster.devices.find((d) => d.id === p.from.device)!.name;
    return `${p.from.session}@${name}`;
  }

  private async accept(p: Exclude<Plaintext, { kind: "card" }>): Promise<void> {
    if (p.kind === "ping" || p.kind === "pong") return this.probe(p);
    if (p.kind === "pause") return this.pausedThere(p);
    const from = this.fromAddress(p);
    this.config = await this.o.mesh.loadConfig();
    const policy = policyFor(this.config, p.from.device, p.relayed === true);
    if (policy === "refuse") {
      this.receipt(p.id, "refused");
      return;
    }
    const unsolicited = p.kind === "result" && !(await this.solicited(p.reply_to, p.from.device, p.from.session));
    const entry: HistoryEntry = { ...entryOf(p, from), ...(unsolicited ? { unsolicited: true as const } : {}) };
    if (p.kind === "task") await this.recordTask(p.id, from, p.at);
    const held: Omit<HeldItem, "reason"> = {
      id: p.id,
      from,
      device: p.from.device,
      kind: p.kind,
      at: p.at,
      preview: preview(entry.text === "" && p.kind === "file" ? `file ${p.file.name}` : entry.text),
      rendered: "",
      entry,
      ...(p.kind === "file" ? { fileInfo: p.file } : {}),
    };
    // A file from a sender that is not delivered is not even fetched until the person approves.
    if (policy === "hold") return this.hold({ ...held, reason: "policy" });

    // A trusted peer whose cool-down ended is released first (this runs on the inbound queue, as
    // every release does), so what it held comes before this, and this is counted after it. A
    // copy of a message that release just delivered (its frame was not acknowledged) goes no further.
    if ((await this.releaseDue()).has(p.id)) return;
    const admitted = this.breaker.admit(p.from.device, entry.text.length, isTrusted(this.config, p.from.device));
    if (!admitted.ok) {
      const pause = admitted.pause;
      if (admitted.newly) {
        this.pauseFrom.set(pause.peer, { from, told: new Set(), announced: false });
        await this.savePauses();
        this.emit("breaker", { peer: from, state: "tripped", reason: pause.rule, ...breakerFields(pause) });
      }
      const record = this.pauseFrom.get(pause.peer)!;
      const under = { rule: pause.rule, count: pause.count, limit: pause.limit, minutes: pause.minutes, at: pause.at, until: pause.until, auto: pause.auto };
      // The notices go with the first hold that is written: one that failed leaves them for the next.
      await this.hold({ ...held, reason: "breaker", pause: under }, record.announced ? undefined : { person: pauseNotice(from, pause), agent: pauseNoticeForAgent(from, pause) });
      record.announced = true;
      // The sending session hears it too, once a pause, so its `send` reports `held` (SPEC section 12).
      this.tellPaused(pause, record, from, p.id);
      return;
    }
    this.countsChanged = true;
    const waiter = p.kind === "result" && !unsolicited ? this.askWaiters.get(p.reply_to) : undefined;
    if (waiter !== undefined && p.kind === "result") {
      // The asker is waiting in a tool call: hand it over there instead of waking the agent again.
      await this.history.append(entry);
      waiter(p, from);
      this.receipt(p.id, "delivered");
      return;
    }
    await this.release(held, p.kind === "file" ? p.file : undefined);
  }

  /**
   * A ping is answered here, by the client, with a pong to the session that sent it; a pong goes
   * to the ping this session is waiting on. Neither is spooled, kept in history, receipted or
   * shown to an agent (SPEC section 12). A device the person refuses gets no answer, and the
   * budget bounds how many pongs any device can draw.
   */
  private probe(p: Probe): Promise<void> {
    if (p.kind === "pong") return Promise.resolve(void this.pongWaiters.get(p.reply_to)?.(p.from.device, p.from.session));
    // The person's newest policy, as for any message.
    return this.o.mesh.loadConfig().then((config) => {
      this.config = config;
      if (policyLevel(config, p.from.device) === "refuse" || !this.pongBudget.allow(p.from.device, p.at, this.now())) return;
      const to = this.fromAddress(p);
      void this.post(to, undefined, { kind: "pong", reply_to: p.id }).catch((e: unknown) => this.log(`wim: no pong sent to ${to}: ${(e as Error).message}`));
    });
  }

  /** Fetches a file if there is one, renders the frame and puts the item in the spool. */
  /** `written`: what a release from held/ records once the item is in the spool (decideNow). */
  private async release(item: Omit<HeldItem, "reason">, file: FileInfo | undefined, written?: () => Promise<void>): Promise<void> {
    // A CI notice was framed when it arrived, and is always information only.
    if (item.ci !== undefined) {
      await this.deliver({ kind: item.kind, from: item.from, device: "", id: item.id, at: item.at, rendered: item.rendered, relayed: true, informs: true }, item.entry, written);
      return;
    }
    const entry = { ...item.entry };
    if (file !== undefined) entry.savedTo = await this.fetchFile(item.id, file).catch((e: unknown) => `(not saved: ${(e as Error).message})`);
    // The same trust decision as a release applied on disk (offline.ts).
    await this.deliver({ kind: item.kind, from: item.from, device: item.device, id: item.id, at: item.at, ...releasedFrame(this.config, item.device, entry) }, entry, written);
  }

  /** `pause`: the breaker tripped on this item, which the person and (once) the agent are told. */
  private async hold(item: HeldItem, pause?: { person: string; agent: string }): Promise<void> {
    await this.held.add(item);
    // No receipt is sent for a CI notice: its sender is gone, and the relay forwards none.
    if (item.ci === undefined) this.receipt(item.id, "held");
    const count = (await this.held.list()).length;
    if (item.ci !== undefined) return this.heldCi(item, item.ci.rule, count, pause);
    const line = pause?.person ?? `${count} message${count === 1 ? "" : "s"} held for the person's approval (latest from ${item.from}).`;
    await this.notice(item.from, line, count);
    if (pause !== undefined) await this.notice(item.from, pause.agent);
    await this.o.notifier?.notify(`worldinmotion: ${count} message${count === 1 ? "" : "s"} held for approval`);
    this.emit("held", item);
  }

  /**
   * Tells the person about a held CI notice: information only, so never a turn. The notices are
   * for the person (`forPerson`: a toast in the plugin, never pushed as a channel turn), at most
   * once an hour per rule, apart from a breaker's pause, which trips once per hour anyway.
   */
  private async heldCi(item: HeldItem, rule: string, count: number, pause: { person: string; agent: string } | undefined): Promise<void> {
    const told = this.ciTold.get(rule);
    if (pause !== undefined || told === undefined || this.now() - told >= CI_TELL_MS) {
      this.ciTold.set(rule, this.now());
      await this.notice(item.from, pause?.person ?? `${count} message${count === 1 ? "" : "s"} held for the person's approval (latest from ${item.from}).`, count, undefined, true);
      if (pause !== undefined) await this.notice(item.from, pause.agent, undefined, undefined, true);
      await this.o.notifier?.notify(`worldinmotion: ${count} message${count === 1 ? "" : "s"} held for approval`);
    }
    this.emit("held", item);
  }

  /**
   * Starts (or extends) the `derived` window (revision 8): for a while after the agent was handed
   * information it may not act on, what this session sends is marked as derived from it.
   */
  informed(items: ReadonlyArray<{ informs?: true }> = [{ informs: true }]): void {
    if (items.some((i) => i.informs === true)) this.derivedUntil = this.now() + LIMITS.derivedWindowMs;
  }

  /** Whether a send now is derived: during a turn a mesh item started, or inside the window. */
  private async isDerived(): Promise<boolean> {
    const presence = (await readText(this.files.presencePath))?.trim();
    return presence === "busy-mesh" || this.now() < this.derivedUntil;
  }

  /**
   * Puts an item in the spool (or pushes it as a channel notification) and records history. One
   * delivery at a time: deliveries start from the inbound queue, notices, the person's decisions
   * and resumes, and two that overlap would otherwise announce a higher item before a lower one.
   */
  private deliver(item: Omit<SpoolItem, "cursor">, entry: HistoryEntry | undefined, written?: () => Promise<void>): Promise<SpoolItem> {
    const run = this.delivering.then(() => this.deliverNow(item, entry, written));
    this.delivering = run.then(() => undefined, () => undefined);
    return run;
  }

  /** `afterWrite`: runs once the item is durably in the spool, before anything takes it from there. */
  private async deliverNow(item: Omit<SpoolItem, "cursor">, entry: HistoryEntry | undefined, afterWrite?: () => Promise<void>): Promise<SpoolItem> {
    this.informed([item]);
    const written = await this.spool.write(item);
    if (afterWrite !== undefined) await afterWrite();
    await this.save({});
    if (entry !== undefined) await this.history.append(entry);
    this.emit("item", written);
    // In-process consumers (bot, ci, a2a adapters) read the verified fields, not the rendered frame.
    // A CI notice is for the agent's inbox only: in-process consumers never act on it.
    if (entry !== undefined && entry.ci === undefined) this.emit("message", { ...entry, cursor: written.cursor } satisfies Inbound);
    // A relayed item must not start a turn, so it waits in the inbox instead of being pushed; a
    // notice for the person is not the model's either.
    if (this.push !== undefined && written.relayed !== true && written.forPerson !== true) {
      await this.push(written);
      await this.take(written.cursor);
    }
    return written;
  }

  /** A notice from a handler that does not wait for it: a failure to write it is logged. */
  private noticeLater(from: string, line: string, forPerson = false): void {
    void this.notice(from, line, undefined, undefined, forPerson).catch((e: unknown) => this.log(`wim: notice: ${(e as Error).message}`));
  }

  /**
   * A notice for the agent or the person, written to the spool like any item. `forPerson`: only
   * the person can act on it (restart this session).
   */
  async notice(from: string, line: string, held?: number, heldBy?: string, forPerson = false): Promise<void> {
    const item = { kind: "notice" as const, from, device: "", id: ulid(this.now()), at: this.now(), rendered: noticeText(line) };
    await this.deliver(
      { ...item, ...(held === undefined ? {} : { held }), ...(heldBy === undefined ? {} : { heldBy }), ...(forPerson ? { forPerson: true as const } : {}) },
      undefined,
    );
  }

  /**
   * Records a receipt in history. A `held` one is also a notice, so whoever sent the message (the
   * person through the plugin's toast, or the agent) learns that it waits for the recipient's
   * person and is not delivered. Branches before any await (see AgentServer.answerLine).
   */
  private recordReceipt(f: { id: string; to: string; status: string }): Promise<void> {
    const recorded = this.history.appendReceipt(f.id, { to: f.to, status: f.status, at: this.now() });
    // Something got through to that recipient: a later hold there is news again. (A pause it
    // reported is not over for that: the person there may have approved this one message alone.)
    if (f.status === "delivered") this.heldTold.delete(f.to);
    if (f.status !== "held") return recorded;
    // The agent is told once per recipient (not per message), so a peer that holds everything
    // cannot wake the sender over and over.
    const tell = !this.heldTold.has(f.to);
    this.heldTold.add(f.to);
    const person = recorded.then(() => this.notice(f.to, heldReceiptLine(f.to, f.id), undefined, f.to));
    return tell ? person.then(() => this.notice(f.to, heldForAgentLine(f.to, f.id))) : person;
  }

  /** Recipients whose `held` receipt the agent was told about, since the last `delivered` from each. */
  private readonly heldTold = new Set<string>();

  /** Marks spool items read up to `cursor`; the next sweep deletes them and sends receipts. */
  async take(cursor: number): Promise<void> {
    await this.spool.take(cursor);
    await this.sweep();
  }

  /** One sweep at a time: two at once could both copy a relayed item to its box, one after a dismiss. */
  private sweep(): Promise<void> {
    const run = this.sweeping.then(async () => {
      // Notices are the client's own, and CI notices (no device) get no receipt.
      for (const item of await this.spool.sweep(this.readRelayed)) if (item.kind !== "notice" && item.device !== "") this.receipt(item.id, "delivered");
    });
    this.sweeping = run.catch(() => undefined);
    return run;
  }

  // ---- housekeeping ----

  /** One housekeeping pass: sweep the spool, presence, decisions left by the CLI, the card. */
  tick(): Promise<void> {
    if (this.ticking || this.stopped) return Promise.resolve();
    this.ticked = this.tickNow();
    return this.ticked;
  }

  private async tickNow(): Promise<void> {
    this.ticking = true;
    try {
      await this.sweep();
      await this.readPresence();
      // The person's marks and the end of a cool-down change what is held and paused: on the
      // inbound queue, so neither interleaves with a message being admitted or held. Queued, not
      // waited for, so a slow frame never holds up this pass (the sweep and its receipts).
      for (const { id, verdict } of await this.held.takeMarks()) void this.onQueue(() => this.applyMark(id, verdict)).catch(ignore);
      this.queueRelease();
      if (this.link !== undefined) await this.flushLifts();
      if (this.countsChanged) await this.savePauses();
      const dismissed = (await takeMarks(this.files.dismissDir, ["dismiss"], this.o.env)).map((m) => m.id);
      if (dismissed.length > 0) {
        // A dismissal the box could not settle yet keeps its mark for the next pass.
        const { left } = await this.spool.dismissRelayed(dismissed);
        for (const id of left) await writeAtomic(join(this.files.dismissDir, `${id}.dismiss`), "", this.o.env);
      }
      for (const name of await listDir(this.files.controlDir)) {
        // A marker still being written is a temp file, and an answer is for the CLI to read.
        if (name.endsWith(".tmp")) continue;
        // An answer the CLI never collected (it timed out or was stopped) goes after 5 minutes.
        const done = /^send-([0-9A-Z]{26})\.done\.json$/.exec(name);
        if (done !== null) {
          if (ulidTime(done[1]!) < this.now() - ANSWER_KEEP_MS) await removeFile(join(this.files.controlDir, name));
          continue;
        }
        const m = /^resume-(.+)$/.exec(name);
        const req = /^send-([0-9A-Z]{26})\.json$/.exec(name);
        // A send request is only for a session that takes them; others leave it for the CLI.
        if (req !== null && this.o.handover !== true) continue;
        const path = join(this.files.controlDir, name);
        const body = req === null ? undefined : await readJson(path).catch(() => undefined);
        // Taking a request is removing it: one that cannot be removed yet is left for the next pass.
        if (!(await tryRemove(path, this.o.env))) continue;
        if (m !== null) void this.resumePeer(m[1]!).catch((e: unknown) => this.log(`wim: housekeeping: ${(e as Error).message}`));
        if (req !== null && this.o.handover === true) await this.handOverSend(req[1]!, body);
      }
      await this.book.reload();
      // Rotation and deletion on schedule; a new prekey goes out with the card below.
      if (this.now() >= this.prekeys.due) await this.prekeys.maintain();
      if (this.link !== undefined) await this.sendCard(this.link, false);
      if (this.link !== undefined) await this.sendCiRules(this.link);
      await this.retryCiParked();
      this.flushCiDrops();
    } catch (error) {
      this.log(`wim: housekeeping: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async readPresence(): Promise<void> {
    const read = (await readText(this.files.presencePath))?.trim();
    // `busy-mesh` (a turn the plugin started with a mesh item) is busy to the relay.
    const text = read === "busy-mesh" ? "busy" : read;
    if (text !== "busy" && text !== "idle") return;
    if (this.sentPresence === text) return;
    if (this.sendIfOpen({ t: "presence", status: text })) this.sentPresence = text;
  }

  /**
   * Sends this session's card after ready, when it changes (at most once a minute) and when the
   * device's prekey rotates. Every session sends one, empty when cards are off: its header is how
   * peers learn the device's prekey (SPEC section 6b). It carries the prekey even in a mesh with
   * v0.1 devices, which drop it (see keysFor).
   */
  private async sendCard(link: Link, force: boolean): Promise<void> {
    const pk = this.prekeys.current()?.id;
    const before = this.cardPk;
    const rotated = pk !== before;
    // Claimed before any await, so the housekeeping pass and `ready` do not both publish a
    // rotation; given back if the card is not sent (publishCard), so the next pass tries again.
    this.cardPk = pk;
    if (!force && !rotated && this.now() - this.cardAt < CARD_EVERY_MS) return;
    const card = this.o.cwd === undefined || !this.config.share_cards ? {} : await cardFor(this.o.cwd, this.config.share_cards === "full", this.o.userHome ?? homedir());
    this.publishCard(link, card, await this.cardFrame(force || rotated, card, await this.refusesLegacy()), before);
  }

  /**
   * The card frame to send, or undefined when the card is unchanged and nothing forces it. Not
   * async: the decision is taken before the seal (which may wait on the signer) and a seal that
   * fails comes back as its error, so no branch follows an await (see publishCard). A device that
   * refuses v0.1 boxes (`strict`) gives none to a device with no prekey: the card skips it.
   */
  private cardFrame(always: boolean, card: Card, strict: boolean): Promise<SendFrame | Error | undefined> {
    if (!always && sameCard(this.myCard, card)) return Promise.resolve(undefined);
    const ids = this.roster.devices.map((d) => d.id);
    return sealMessageWith({ ...this.sealBase(["*"]), ...this.keysFor(ids, true).keys, ...(strict ? { legacy: false } : {}), kind: "card", card, recipients: ids }).catch((error: unknown) => error as Error);
  }

  /**
   * The part of sendCard after its awaits, kept synchronous: V8 counts a branch that follows an
   * await in an async function by subtraction, and on Windows that count came out negative, so
   * the coverage gate reported a branch the tests do run as never taken.
   */
  private publishCard(link: Link, card: Card, frame: SendFrame | Error | undefined, before: string | undefined): void {
    if (frame === undefined) return;
    try {
      if (frame instanceof Error) throw frame;
      // A link that closed meanwhile throws too.
      link.send({ t: "card.set", msg: frame });
      // Recorded only once sent: a card that was not (a locked signer) goes again on the next pass.
      this.cardAt = this.now();
      this.myCard = card;
    } catch (error) {
      this.cardPk = before;
      this.log(`wim: peer card not sent: ${(error as Error).message}`);
    }
  }

  // ---- held messages ----

  /**
   * Runs `fn` on the inbound queue: after every frame received so far and before any received
   * later. What changes the breaker's pauses or what they hold runs here, so a release, a
   * person's decision and a message being admitted never interleave.
   */
  private onQueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.inbound.then(fn);
    this.inbound = run.then(ignore, ignore);
    return run;
  }

  /** The person's decision on a held message (the pane, `wim held`). Never reachable by a message. */
  decide(id: string, verdict: Verdict): Promise<void> {
    return this.onQueue(() => this.decideNow(id, verdict));
  }

  private async decideNow(id: string, verdict: Verdict): Promise<void> {
    const item = await this.held.get(id);
    if (item === undefined) throw new ClientError(`no held message ${id}`, "not_found");
    // Approving a notice that pins its rule's ids changes a rule: only `wim held approve` at the
    // person's terminal pins them (SPEC section 18), and the notice is released once they are.
    const pins = item.ci?.pins;
    if (verdict === "approve" && pins !== undefined && !isPinned((await this.ciRulesNow()) ?? [], item.ci!.rule, pins)) {
      throw new ClientError(`held CI notice ${id} pins its rule's ids: approve it with \`wim held approve ${id}\` in a terminal you opened yourself`, "person_only");
    }
    if (verdict === "refuse") {
      await this.held.remove(id);
      if (item.ci === undefined) this.receipt(id, "refused");
      return this.decided(item);
    }
    // Written to the spool before it leaves held/, so a process that stops in between loses
    // nothing: the next one finds it delivered (its mark, or the spool) and only takes it out of
    // held/ (settleDelivered), and one that cannot be delivered (a full disk) simply stays held.
    if (!(await this.held.wasDelivered(id))) await this.release(item, item.fileInfo, () => this.held.markDelivered(id));
    await this.decided(item);
    await this.held.settle(id);
  }

  /**
   * Finishes what an earlier process of this session left half done: an item that is in the spool
   * (or marked delivered) and still in held/ is taken out of held/, never delivered again, and a
   * delivered mark whose entry is gone is cleared.
   */
  private async settleDelivered(): Promise<void> {
    const unread = new Set((await this.spool.unread()).map((i) => i.id));
    for (const item of await this.held.list()) {
      if (!unread.has(item.id) && !(await this.held.wasDelivered(item.id))) continue;
      await this.decided(item);
      await this.held.settle(item.id);
    }
    for (const id of await this.held.deliveredMarks()) await this.held.settle(id);
  }

  /**
   * A held item was decided: its id is recorded as seen, so a copy the relay brings again (its
   * frame was not acknowledged) is dropped, never held or delivered a second time.
   */
  private decided(item: HeldItem): Promise<void> {
    return this.seen.add(item.id, this.address, dedupeExpiry(item.at), this.now());
  }

  /**
   * A one-off `wim send` handed to this live CLI session (a `wim watch`), so replies come back to
   * a session the person is reading. Only a session opened with `handover` takes these, and only
   * from the device's own state directory: the same person, at the same command line. A handed-over
   * send never skips the secrets check: `--allow-secret` sends directly, so it never travels in a file.
   */
  private async handOverSend(id: string, body: unknown): Promise<void> {
    const r = body as { to?: unknown; text?: unknown } | undefined;
    const answer = join(this.files.controlDir, `send-${id}.done.json`);
    try {
      if (typeof r?.to !== "string" || typeof r.text !== "string") throw new ClientError("malformed send request", "malformed");
      const out = await this.send(r.to, r.text);
      // Live addresses let the CLI suggest one for an address nobody answers to, and name a live
      // Claude Code tab on a device whose terminal inbox a send was queued for.
      const peers = [...this.peers.values()].filter((p) => p.status !== "offline");
      const live = peers.map((p) => p.address);
      const claude = peers.filter((p) => p.kind === "claude-code").map((p) => p.address);
      await writeJson(answer, { ok: true, ...out, live, claude }, this.o.env);
    } catch (error) {
      await writeJson(answer, { ok: false, error: (error as Error).message }, this.o.env);
    }
  }

  /** Lifts a breaker pause on a peer (by address) and releases what it held from that device. */
  resumePeer(peer: string): Promise<number> {
    return this.onQueue(() => this.resumeNow(peer));
  }

  private async resumeNow(peer: string): Promise<number> {
    const device = this.roster.devices.find((d) => d.name === peer.slice(peer.indexOf("@") + 1));
    if (device === undefined) return 0;
    this.breaker.resume(device.id);
    // The sessions told about the pause hear it lifted at the next pass, so their sends stop reporting `held`.
    for (const to of this.pauseFrom.get(device.id)?.told ?? []) this.pendingLifts.add(to);
    this.pauseFrom.delete(device.id);
    await this.savePauses();
    this.emit("breaker", { peer, state: "resumed" });
    let n = 0;
    for (const item of await this.held.list()) {
      if (item.device !== device.id || item.reason !== "breaker") continue;
      await this.decideNow(item.id, "approve");
      n++;
    }
    return n;
  }

  /**
   * A mark the person left in the pane: approve, refuse, or approve and resume (`resume`), which
   * also lifts the breaker's pause on the item's device and releases everything it held from
   * there, in this session and in the device's other sessions, as `wim held resume` does.
   */
  private async applyMark(id: string, mark: Mark): Promise<void> {
    if (mark !== "resume") return this.decideNow(id, mark);
    const item = await this.held.get(id);
    // A policy hold has no pause to lift: the item alone is approved.
    if (item?.reason !== "breaker" || (await this.resumeNow(item.from)) === 0) return this.decideNow(id, "approve");
    await resumeEverywhere(this.o.mesh, item.from, this.o.env, this.now, this.sid);
  }

  // ---- the loop breaker's pauses ----

  /** The running pauses of this session's breaker, with the address that tripped each and the sessions told. */
  pausedRows(): PauseRow[] {
    return this.rowsOf(this.breaker.pauses());
  }

  private rowsOf(pauses: Pause[]): PauseRow[] {
    return pauses.map((p) => {
      const { from, told } = this.pauseFrom.get(p.peer)!;
      return { ...p, from, told: [...told] };
    });
  }

  /**
   * Carries on what an earlier process of this session wrote: each pause that still holds
   * something keeps its end, a trusted peer's cool-down still releases (at the first pass, when it
   * ended meanwhile), the sessions told still hear a resume, a release in the last hour still makes
   * a second trip wait for the person, and lifts not yet sent go out. A pause that holds nothing
   * any more is not taken back (an older `wim held resume` released what it held without knowing
   * this file, and the counts start over anyway); its sessions hear it lifted.
   */
  private async restorePauses(): Promise<void> {
    const file = await readBreakerFile(this.files.breakerPath);
    const held = await this.held.list();
    for (const r of file.pauses) {
      const { from, told, ...pause } = r;
      if (!held.some((h) => h.reason === "breaker" && h.device === pause.peer && h.pause !== undefined && h.pause.at === pause.at)) {
        for (const to of told) this.pendingLifts.add(to);
        continue;
      }
      this.breaker.restore(pause);
      this.pauseFrom.set(pause.peer, { from, told: new Set(told), announced: true });
    }
    for (const [peer, at] of Object.entries(file.released)) this.breaker.restoreRelease(peer, at);
    for (const [peer, times] of Object.entries(file.counts)) this.breaker.restoreCounts(peer, times);
    for (const to of file.lifts) this.pendingLifts.add(to);
    await this.savePauses();
  }

  /**
   * Writes the pauses where `wim held list` reads them (it shows the running ones) and a later
   * process of this session takes them back: a cool-down that ended stays written until its
   * release has run, so a process that exits first leaves it for the next one. One write at a
   * time, each taking the rows when its turn comes, so an older picture never lands last.
   */
  private savePauses(): Promise<void> {
    const run = this.saving.then(() => {
      this.countsChanged = false;
      return savePauses(
        this.files.breakerPath,
        { pauses: this.rowsOf(this.breaker.kept()), released: this.breaker.releases(), lifts: [...this.pendingLifts], counts: this.breaker.counts() },
        this.o.env,
      );
    });
    this.saving = run.catch(ignore);
    return run;
  }

  /**
   * Releases every trusted peer whose cool-down has ended. On the inbound queue only (accept, and
   * the housekeeping pass through onQueue), so nothing is admitted or decided meanwhile.
   */
  private async releaseDue(): Promise<Set<string>> {
    const delivered = new Set<string>();
    for (;;) {
      const due = this.breaker.takeDue();
      if (due.length === 0) return delivered;
      const taken = due.map((p) => ({ p, record: this.pauseFrom.get(p.peer)! }));
      for (const { p } of taken) this.pauseFrom.delete(p.peer);
      await this.savePauses();
      for (const { p, record } of taken) await this.autoRelease(p, record, delivered);
    }
  }

  /** Puts a release on the inbound queue from the housekeeping pass, unless one already waits there. */
  private queueRelease(): void {
    if (this.releaseQueued) return;
    this.releaseQueued = true;
    void this.onQueue(() => {
      this.releaseQueued = false;
      return this.releaseDue();
    }).catch((e: unknown) => this.log(`wim: housekeeping: ${(e as Error).message}`));
  }

  /**
   * A trusted peer's cool-down ended: the breaker already lifted it. Of what it held under that
   * pause, oldest first, at most the per-peer limit is delivered, as a resume by the person would,
   * and counted as delivered; the rest waits for the person, as in 0.1.8. Nothing is delivered for
   * a device the person stopped trusting meanwhile, or one no longer in the roster (revoked). The
   * session is told either way. Never reachable by a message or a tool.
   */
  private async autoRelease(p: Pause, record: PauseEntry, delivered: Set<string>): Promise<void> {
    this.emit("breaker", { peer: record.from, state: "resumed", auto: true });
    this.config = await this.o.mesh.loadConfig();
    const still = isTrusted(this.config, p.peer) && this.roster.devices.some((d) => d.id === p.peer);
    const mine = (await this.held.list()).filter((h) => h.reason === "breaker" && h.device === p.peer && h.pause !== undefined && h.pause.at === p.at);
    // At most the per-peer limit, and no more than is left under the total.
    const out = mine.slice(0, still ? this.breaker.allowance() : 0);
    let released = 0;
    try {
      for (const item of out) {
        // Each is counted as it is delivered; one that fails stays held, and ends this release.
        // One that is gone (taken out of held/ by another process) is passed over.
        const done = await this.decideNow(item.id, "approve").then(
          () => true,
          (e: unknown) => {
            if ((e as ClientError).code !== "not_found") throw e;
            return false;
          },
        );
        if (!done) continue;
        this.breaker.count(p.peer, 1);
        delivered.add(item.id);
        released++;
      }
    } finally {
      this.countsChanged = true;
      await this.notice(record.from, releasedNotice(record.from, p, released, mine.length - released, still ? "limit" : "untrusted"));
    }
  }

  /**
   * Tells the session that sent `id` that this session's breaker holds its device's messages, once
   * a pause. Without waiting for the relay, like a pong; one that cannot be sent is tried again
   * with that session's next held message.
   */
  private tellPaused(pause: Pause, record: PauseEntry, to: string, id: string): void {
    if (record.told.has(to)) return;
    record.told.add(to);
    // A lift still owed from an earlier pause must not follow this one and clear its label.
    this.pendingLifts.delete(to);
    const info: PauseInfo = { state: "paused", rule: pause.rule, count: pause.count, limit: pause.limit, minutes: pause.minutes, until: pause.until, auto: pause.auto };
    // Written first, so a later process of this session still tells this one when the pause is lifted.
    void this.savePauses()
      .then(() => this.post(to, undefined, { kind: "pause", pause: info, reply_to: id }))
      .catch((e: unknown) => {
        record.told.delete(to);
        this.log(`wim: no pause sent to ${to}: ${(e as Error).message}`);
      });
  }

  /** Sends the lifts still owed; one that cannot be sent now stays for the next pass. */
  private async flushLifts(): Promise<void> {
    let sent = 0;
    for (const to of [...this.pendingLifts]) {
      const ok = await this.post(to, undefined, { kind: "pause", pause: { state: "lifted" } }).then(
        () => true,
        (e: unknown) => void this.log(`wim: no pause sent to ${to}: ${(e as Error).message}`),
      );
      if (ok !== true) continue;
      this.pendingLifts.delete(to);
      sent++;
    }
    if (sent > 0) await this.savePauses();
  }

  /**
   * A peer session's breaker holds this device's messages, or lifted that (SPEC section 12). A
   * pause is taken only from a session one of this device's sessions sent to in the last hour, a
   * lift from any session (it can only clear a label); either way only as a label: it changes what
   * a send to that session reports (`held`), never what is sent or delivered. The agent is told
   * when a pause starts, at most once in 10 minutes per peer session.
   */
  private async pausedThere(p: PauseMessage): Promise<void> {
    this.config = await this.o.mesh.loadConfig();
    if (policyLevel(this.config, p.from.device) === "refuse") return;
    const pair = `${p.from.device}/${p.from.session}`;
    const to = this.fromAddress(p);
    if (p.pause.state === "lifted") return this.pausedBy.note(pair, to, p.pause, this.now());
    // One that ended before it came (it waited in a queue) says nothing any more.
    if (p.pause.until <= this.now() || !(await this.sentTo.has(pair))) return;
    await this.pausedBy.note(pair, to, p.pause, this.now());
    // The agent hears it only from a device the person trusts, at most once in 10 minutes per
    // device; for any other the label is enough (the next send's `held` row and `held_note`).
    const last = this.pausedToldAt.get(p.from.device);
    if (!isTrusted(this.config, p.from.device) || (last !== undefined && this.now() - last < PAUSE_TELL_MS)) return;
    this.pausedToldAt.set(p.from.device, this.now());
    await this.notice(to, pausedThereLine(to, p.pause));
  }

  // ---- tasks ----

  private async tasks(): Promise<Record<string, TaskRecord>> {
    const raw = (await readJson(this.files.tasksPath).catch(() => undefined)) as Record<string, TaskRecord> | undefined;
    return typeof raw === "object" && raw !== null ? raw : {};
  }

  private async recordTask(id: string, from: string, at: number): Promise<void> {
    const cutoff = this.now() - 2 * LIMITS.taskDeadlineMaxMs;
    const kept = Object.fromEntries(Object.entries(await this.tasks()).filter(([, t]) => t.at > cutoff));
    await writeJson(this.files.tasksPath, { ...kept, [id]: { from, at } }, this.o.env);
  }

  /** Who may answer each task this session sent: `device/session` pairs, or anyone for `*`. */
  private async sentTasks(): Promise<Record<string, SentTask>> {
    const raw = (await readJson(this.files.sentTasksPath).catch(() => undefined)) as Record<string, SentTask> | undefined;
    return typeof raw === "object" && raw !== null ? raw : {};
  }

  private async recordSentTask(id: string, to: string[]): Promise<void> {
    const addressees = new Set<string>();
    for (const a of to) {
      if (isRoom(a)) {
        // A room's members at send time, as the peer rows list them.
        for (const p of this.peers.values()) if (p.rooms.includes(a)) addressees.add(this.pairOf(p.address));
      } else if (a !== "*") addressees.add(this.pairOf(a));
    }
    const cutoff = this.now() - 2 * LIMITS.taskDeadlineMaxMs;
    const kept = Object.fromEntries(Object.entries(await this.sentTasks()).filter(([, t]) => t.at > cutoff));
    await writeJson(this.files.sentTasksPath, { ...kept, [id]: { at: this.now(), any: to.includes("*"), addressees: [...addressees] } }, this.o.env);
  }

  private pairOf(address: string): string {
    const at = address.indexOf("@");
    const device = this.roster.devices.find((d) => d.name === address.slice(at + 1));
    return `${device?.id ?? "?"}/${address.slice(0, at)}`;
  }

  /** A result answers a task only from one of that task's addressees (revision 4, M3). */
  private async solicited(taskId: string, device: string, session: string): Promise<boolean> {
    const task = (await this.sentTasks())[taskId];
    return task !== undefined && (task.any || task.addressees.includes(`${device}/${session}`));
  }

  // ---- sending ----

  private sealBase(to: string[]) {
    return {
      roster: this.roster,
      sender: { deviceId: this.device.id, keyring: this.device.keyring },
      session: this.state.name,
      sid: this.state.sid,
      to,
      seq: this.state.seq + 1,
      at: this.now(),
    };
  }

  /**
   * What to seal with (SPEC section 6b): the newest usable prekey of each recipient device, this
   * device's own for its sibling sessions, and the own one again as the header's `pk`. `missing`
   * lists the recipient devices (recovery records aside, which get no box) with no usable prekey:
   * a v0.1 client, or one offline for over 48 hours.
   *
   * When any device is missing, a message goes in the v0.1 format for everyone: no `pk` and only
   * scheme 1 boxes. A v0.1 client parses the whole frame strictly and drops it for a `pk` or for
   * any scheme 2 box, its own box being a v0.1 one or not, so a mixed frame would never reach it.
   * One frame per format is not possible: the frame is signed over every box, and receivers drop
   * a second frame with the same id or seq as a replay. The send reports it as `unprotected`.
   *
   * A card always carries the prekeys (`card`): cards are how upgraded devices learn each other's
   * prekeys, and a downgraded card would leave a mixed mesh with no forward secrecy at all. A v0.1
   * client drops such a card, so it misses that session's labels and nothing else.
   *
   * A device that refuses v0.1 boxes (`strict`) never falls back either: it seals as from 1.0.
   */
  private keysFor(ids: readonly string[], card = false, strict = false): { keys: { prekeys: Record<string, Prekey>; prekey?: Prekey }; missing: string[] } {
    const own = this.prekeys.current();
    const prekeys = this.peerKeys.forSend(this.roster, ids);
    if (own !== undefined && ids.includes(this.device.id)) prekeys[this.device.id] = own;
    const acting = new Set(this.roster.devices.filter((d) => !isRecoveryName(d.name)).map((d) => d.id));
    const missing = ids.filter((id) => acting.has(id) && !Object.hasOwn(prekeys, id));
    if (missing.length > 0 && !card && !strict) return { keys: { prekeys: {} }, missing };
    return { keys: own === undefined ? { prekeys } : { prekeys, prekey: own }, missing };
  }

  /** Recipient device ids that a frame seals to without forward secrecy (scheme 1 boxes). */
  private legacyIds(frame: SendFrame): string[] {
    return Object.entries(frame.boxes)
      .filter(([, box]) => !("s" in box))
      .map(([id]) => id);
  }

  /** The device ids a send needs boxes for, and the addresses no device in the roster answers to. */
  private recipients(to: string[]): { ids: string[]; unknown: string[] } {
    if (GROUP(to)) return { ids: this.roster.devices.map((d) => d.id), unknown: [] };
    const ids = new Set<string>();
    const unknown: string[] = [];
    for (const a of to) {
      const device = this.roster.devices.find((d) => d.name === a.slice(a.indexOf("@") + 1));
      if (device === undefined) unknown.push(a);
      else ids.add(device.id);
    }
    return { ids: [...ids], unknown };
  }

  /** Validates addresses: `name@device`, `#room` or `*`, without repeats. */
  static parseTo(to: string | readonly string[]): string[] {
    const list = (typeof to === "string" ? to.split(",") : [...to]).map((a) => a.trim()).filter((a) => a !== "");
    if (list.length === 0) throw new ClientError("no recipient", "bad_address");
    for (const a of list) {
      if (a !== "*" && !isRoom(a) && !sessionAddressSchema.safeParse(a).success) {
        throw new ClientError(`not an address: ${JSON.stringify(a)} (use name@device, #room or *)`, "bad_address");
      }
    }
    return [...new Set(list)];
  }

  /** Seals and sends, then waits briefly for the relay's per-recipient statuses. */
  async send(toInput: string | readonly string[], text: string | undefined, opts: SendOptions = {}): Promise<SendOutcome> {
    return this.recordSend(await this.post(toInput, text, opts), text, opts);
  }

  /** What a sent message adds to the post: the breaker's count and history. Not async (see publishCard). */
  private recordSend(out: Awaited<ReturnType<MeshSession["post"]>>, text: string | undefined, opts: SendOptions): Promise<SendOutcome> {
    if (out.sent === undefined) return Promise.resolve({ id: out.id, results: out.local });
    const { id, routed, frame, missing, sent } = out;
    for (const a of routed) if (!isRoom(a) && a !== "*") this.breaker.noteSent(this.pairOf(a).split("/")[0]!, (text ?? "").length);
    const name = (d: string): string => this.roster.devices.find((r) => r.id === d)!.name;
    const unprotected = this.legacyIds(frame).map(name);
    // Missing devices were sealed scheme 1 boxes (the window) or skipped (a device that refuses them).
    const outcome: SendOutcome = {
      id,
      results: [...out.local, ...sent.results],
      ...(missing.length > 0 ? { ...(unprotected.length > 0 ? { unprotected } : {}), no_prekey: missing.map(name) } : {}),
    };
    return this.history.append({
      dir: "out",
      peer: routed.join(","),
      id,
      kind: opts.kind ?? "msg",
      at: frame.at,
      text: text ?? "",
      ...(opts.reply_to === undefined ? {} : { reply_to: opts.reply_to }),
      ...(opts.status === undefined ? {} : { status: opts.status }),
      ...(opts.file === undefined ? {} : { file: { name: opts.file.name, size: opts.file.size, mime: opts.file.mime } }),
      ...(opts.relayed === true ? { relayed: true as const } : {}),
    })
      // Bookkeeping only: the relay took the message, so a failure here never fails the send.
      .then(() => this.sentTo.note(this.sessionsOf(routed)).catch((e: unknown) => this.log(`wim: sent-to: ${(e as Error).message}`)))
      .then(() => this.heldRows(outcome));
  }

  /**
   * The peer sessions (`deviceId/session`) a send reached, as far as this session knows them: each
   * named session, each member of a named room, every other session for `*`. A `pause` counts
   * only from one of them, a room member's included.
   */
  private sessionsOf(routed: readonly string[]): string[] {
    const pairs = new Set<string>();
    for (const a of routed) {
      if (a === "*" || isRoom(a)) {
        for (const p of this.peers.values()) if (a === "*" || p.rooms.includes(a)) pairs.add(this.pairOf(p.address));
      } else pairs.add(this.pairOf(a));
    }
    return [...pairs];
  }

  /** Routed or queued rows whose session said its breaker holds this device's messages, reported as `held`. */
  private async heldRows(outcome: SendOutcome): Promise<SendOutcome> {
    const paused = await this.pausedBy.active();
    const results = outcome.results.map((r): SendRow => {
      const e = r.status === "routed" || r.status === "queued" ? paused[this.pairOf(r.to)] : undefined;
      if (e === undefined) return r;
      return { to: r.to, status: "held", relay: r.status as "routed" | "queued", breaker: breakerOf(e) };
    });
    return { ...outcome, results };
  }

  /**
   * Seals one frame, puts it on the wire and waits for the relay's `sent`. `local` holds the
   * addresses no roster device answers to; `sent` is absent when nothing was left to send. What a
   * message adds on top (history, the breaker's count) is `send`'s; pings and pongs go through
   * here alone.
   */
  private async post(
    toInput: string | readonly string[],
    text: string | undefined,
    opts: Outgoing,
  ): Promise<{ id: string; local: SendResult[]; sent?: undefined } | { id: string; local: SendResult[]; routed: string[]; frame: SendFrame; missing: string[]; sent: SentFrame }> {
    const to = MeshSession.parseTo(toInput);
    const { ids, unknown } = this.recipients(to);
    const local = unknown.map((a) => ({ to: a, status: "unknown" as const }));
    const id = opts.id ?? ulid(this.now());
    const routed = to.filter((a) => !unknown.includes(a));
    if (routed.length === 0) return { id, local };
    // From seal to wire, one send at a time: the seq is read when sealing and saved before the
    // frame goes out, so an overlapping send would reuse it or overtake it, and the receiver
    // would drop one as a replay.
    const { frame, missing, answer: answering } = await this.serially(async () => {
      const strict = await this.refusesLegacy();
      let sealed = await this.seal(id, routed, ids, text, opts, strict);
      const link = await this.ready(this.answerMs);
      if (sealed.missing.length > 0) {
        // A device with no prekey may only be unknown so far: read what sibling sessions learned
        // and the first cards page of this connection, then seal again (same id and seq).
        await this.peerKeys.reload();
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([this.cardsIn, new Promise<void>((resolve) => (timer = setTimeout(resolve, this.answerMs)))]);
        clearTimeout(timer);
        if (sealed.frame === undefined || Object.keys(this.peerKeys.forSend(this.roster, sealed.missing)).length > 0) sealed = await this.seal(id, routed, ids, text, opts, strict, true);
      }
      // Only a strict direct send that still waits on a prekey leaves no frame, and its last seal refused it.
      await this.save({ seq: sealed.frame!.seq });
      // Recorded before sending, so a quick answer already finds its task.
      if (opts.kind === "task") await this.recordSentTask(id, routed);
      return { frame: sealed.frame!, missing: sealed.missing, answer: this.sendFrame(link, sealed.frame!, id) };
    });
    const answer = await answering;
    if (answer.t === "error") throw relayRefusal("the relay refused the send", answer);
    return { id, local, routed, frame, missing, sent: answer as SentFrame };
  }

  /**
   * Pings sessions (`wim ping`, SPEC section 12) and waits up to `waitMs` for their pongs. Each
   * row is a pinged address with the relay's status for it and, when its pong came back, the round
   * trip in milliseconds. Only sessions: a ping is never sent to `*` or a room.
   */
  async ping(targets: string | readonly string[], waitMs: number): Promise<PingRow[]> {
    const to = MeshSession.parseTo(targets);
    if (to.some((a) => a === "*" || isRoom(a))) throw new ClientError("a ping names sessions (name@device), never * or a room", "bad_address");
    const id = ulid(this.now());
    const asked = new Map(to.map((a) => [this.pairOf(a), a]));
    const pongs = new Map<string, number>();
    const started = this.now();
    let answered!: () => void;
    const all = new Promise<void>((resolve) => (answered = resolve));
    // Until the relay says which pings it routed, every pinged session is waited on.
    let waiting: readonly string[] = to;
    const check = (): void => (waiting.every((a) => pongs.has(a)) ? answered() : undefined);
    this.pongWaiters.set(id, (device, session) => {
      const address = asked.get(`${device}/${session}`);
      if (address === undefined || pongs.has(address)) return;
      pongs.set(address, this.now() - started);
      check();
    });
    try {
      const results = pingResults(await this.post(to, undefined, { kind: "ping", id }));
      waiting = results.filter((r) => r.status === "routed").map((r) => r.to);
      check();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([all, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
      clearTimeout(timer);
      return to.map((a) => pingRow(a, results, pongs));
    } finally {
      this.pongWaiters.delete(id);
    }
  }

  private serially<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.sending.then(fn);
    this.sending = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Seals a message at the next seq; the secrets check and the protocol limits refuse here. On a
   * device that refuses v0.1 boxes (`strict`), a direct send naming a device with no prekey has no
   * frame until `last`, the seal after waiting for prekeys, which refuses it (SPEC section 6b,
   * from 1.0); a broadcast or room send skips such a device.
   */
  private async seal(id: string, routed: string[], ids: string[], text: string | undefined, opts: Outgoing, strict: boolean, last = false): Promise<{ frame?: SendFrame; missing: string[] }> {
    // A ping, pong or pause is the client's own, never written while handling anything (SPEC section 6a).
    const derived = opts.kind === "ping" || opts.kind === "pong" || opts.kind === "pause" ? false : await this.isDerived();
    const { keys, missing } = this.keysFor(ids, false, strict);
    if (strict && !GROUP(routed) && missing.length > 0) {
      if (!last) return { missing };
      throw new ClientError(refusedLine(missing.map((d) => this.roster.devices.find((r) => r.id === d)!.name)), "invalid");
    }
    try {
      const frame = await sealMessageWith({
        ...this.sealBase(routed),
        ...keys,
        ...(strict ? { legacy: false } : {}),
        id,
        kind: opts.kind ?? "msg",
        ...(text === undefined ? {} : { text }),
        ...(opts.reply_to === undefined ? {} : { reply_to: opts.reply_to }),
        ...(opts.deadline === undefined ? {} : { deadline: opts.deadline }),
        ...(opts.status === undefined ? {} : { status: opts.status }),
        ...(opts.file === undefined ? {} : { file: opts.file }),
        ...(opts.pause === undefined ? {} : { pause: opts.pause }),
        recipients: ids,
        ...(opts.relayed === true ? { relayed: true } : {}),
        ...(derived ? { derived: true } : {}),
        ...(opts.allowSecrets === true ? { allowSecrets: true } : {}),
      });
      return { frame, missing };
    } catch (error) {
      const message = (error as Error).message.replace(/^sealMessage: /, "");
      if (/secret/.test(message)) throw new ClientError(`refused: ${message}. ${SECRET_OVERRIDE}`, "secret");
      throw new ClientError(`refused: ${message}`, "invalid");
    }
  }

  /**
   * Puts a sealed frame on the wire and waits for `sent`. If the connection drops first, the
   * same frame goes again once reconnected: the relay accepts a repeat of an id from its own
   * sender, and receivers drop the copy by id.
   */
  private async sendFrame(link: Link, frame: SendFrame, id: string): Promise<RelayFrame> {
    const match = (f: RelayFrame): boolean => (f.t === "sent" && f.id === id) || errorFor(id)(f);
    try {
      return await link.request(frame, match, this.answerMs);
    } catch (error) {
      if ((error as WireError).code !== "closed") throw error;
      this.log(`wim: the connection dropped while sending ${id}; sending again after reconnecting`);
      return (await this.ready(this.answerMs)).request(frame, match, this.answerMs);
    }
  }

  /** Sends a task and waits for its result; `pending` when none arrives in time. */
  async ask(to: string, task: string, timeoutMs: number): Promise<{ result?: AskResult; pending?: true; task_id: string; results: SendRow[] }> {
    const id = ulid(this.now());
    let resolveResult!: (v: AskResult) => void;
    const got = new Promise<AskResult>((r) => (resolveResult = r));
    const waiter = (p: Plaintext & { kind: "result" }, from: string): void => resolveResult({ from, device: p.from.device, at: p.at, status: p.status, text: p.text, id: p.id });
    this.askWaiters.set(id, waiter);
    try {
      const sent = await this.send(to, task, { kind: "task", id });
      if (!sent.results.some((r) => accepted(r.status))) return { task_id: id, results: sent.results, pending: true };
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), timeoutMs)));
      const result = await Promise.race([got, timeout]);
      clearTimeout(timer);
      return result === undefined ? { task_id: id, results: sent.results, pending: true } : { task_id: id, results: sent.results, result };
    } finally {
      this.askWaiters.delete(id);
    }
  }

  /** Sends the result of a task this session received. */
  async reply(taskId: string, status: ResultStatus, text: string): Promise<SendOutcome> {
    const task = (await this.tasks())[taskId];
    if (task === undefined) throw new ClientError(`no task ${taskId} was received by this session`, "not_found");
    return this.send(task.from, text, { kind: "result", reply_to: taskId, status });
  }

  /** Arms one idle notice for each session address. */
  notifyWhenIdle(addresses: readonly string[]): void {
    for (const of of addresses) if (sessionAddressSchema.safeParse(of).success) this.sendIfOpen({ t: "notify_idle", of });
  }

  async rename(name: string): Promise<string> {
    const link = await this.ready();
    const me = this.roster.devices.find((d) => d.id === this.device.id)!;
    const want = `${name}@${me.name}`;
    const answer = (await link.request({ t: "rename", name }, (f) => (f.t === "peer" && f.peer.address === want) || errorFor("rename")(f), this.answerMs)) as RelayFrame;
    if (answer.t === "error") throw relayRefusal("rename refused", answer);
    await this.save({ name, asked: name, address: want });
    return want;
  }

  /**
   * Fresh peer rows from the relay. Card fields are shown to an agent only for devices the person
   * delivers from; the person's own pane (`forPane`) sees every card (revision 4, M1).
   */
  async listPeers(opts: { forPane?: boolean } = {}): Promise<PeerRow[]> {
    const link = await this.ready();
    const answer = (await link.request({ t: "peers" }, (f) => f.t === "peers", this.answerMs)) as RelayFrame & { t: "peers" };
    this.config = await this.o.mesh.loadConfig();
    return answer.peers.map((p) => {
      const device = this.pairOf(p.address).split("/")[0]!;
      const card = this.cards.get(`${device}/${p.sid}`);
      if (card === undefined) return p;
      const level = policyLevel(this.config, device);
      return opts.forPane === true || level === "deliver" || level === "deliver-relayed" ? { ...p, card } : p;
    });
  }

  /** How a SendMessage target would be treated (the plugin's `_internal` op `route`). */
  async route(to: string): Promise<{ mesh: boolean; policy: Policy | null }> {
    if (isRoom(to as unknown)) {
      // A room reaches every device, so it is `deliver` only if every acting device is.
      this.config = await this.o.mesh.loadConfig();
      const all = this.roster.devices.filter((d) => !isRecoveryName(d.name)).every((d) => {
        const level = policyLevel(this.config, d.id);
        return level === "deliver" || level === "deliver-relayed";
      });
      return { mesh: true, policy: all ? "deliver" : "hold" };
    }
    if (!sessionAddressSchema.safeParse(to).success) return { mesh: false, policy: null };
    const device = this.roster.devices.find((d) => d.name === to.slice(to.indexOf("@") + 1));
    if (device === undefined) return { mesh: false, policy: null };
    this.config = await this.o.mesh.loadConfig();
    return { mesh: true, policy: policyLevel(this.config, device.id) };
  }

  // ---- rooms ----

  async joinRoom(room: string): Promise<string[]> {
    if (!isRoom(room)) throw new ClientError(`not a room: ${JSON.stringify(room)} (use #name)`, "bad_address");
    const link = await this.ready();
    const answer = (await link.request({ t: "room.join", room }, (f) => (f.t === "room.joined" && f.room === room) || errorFor("room.join")(f), this.answerMs)) as RelayFrame;
    if (answer.t === "error") throw relayRefusal(`could not join ${room}`, answer);
    await this.save({ rooms: [...new Set([...this.state.rooms, room])] });
    return (answer as RoomJoinedFrame).members;
  }

  async leaveRoom(room: string): Promise<void> {
    if (!isRoom(room)) throw new ClientError(`not a room: ${JSON.stringify(room)} (use #name)`, "bad_address");
    const link = await this.ready();
    link.send({ t: "room.leave", room });
    await this.save({ rooms: this.state.rooms.filter((r) => r !== room) });
  }

  /** A room's recent messages, checked like any message but without freshness, shown as history. */
  async roomHistory(room: string, opts: { limit?: number; before?: number } = {}): Promise<{ items: string[]; more: boolean }> {
    if (!isRoom(room)) throw new ClientError(`not a room: ${JSON.stringify(room)} (use #name)`, "bad_address");
    const link = await this.ready();
    const frame = { t: "room.history", room, ...(opts.before === undefined ? {} : { before: opts.before }), limit: Math.min(LIMITS.roomHistoryPageMax, Math.max(1, opts.limit ?? 20)) };
    const answer = (await link.request(frame, (f) => (f.t === "room.history" && f.room === room) || errorFor("room.history")(f), this.answerMs)) as RelayFrame;
    if (answer.t === "error") throw relayRefusal(`no history for ${room}`, answer);
    const page = answer as RoomHistoryFrame;
    const top = Math.max(0, ...page.msgs.map((m) => m.msg.roster.seq));
    if (top > this.roster.seq) await this.walk(link, top).catch(() => undefined);
    const items: string[] = [];
    for (const { cursor, msg } of page.msgs) {
      const r = await this.openFresh(msg, true);
      if (!r.ok) continue;
      // A card is addressed to `*` only, and a ping or pong to sessions only (the plaintext
      // schema), so a room never holds one.
      const p = r.value as Message;
      const entry = entryOf(p, this.fromAddress(p));
      if (p.kind === "file") entry.savedTo = "(not fetched: an earlier file from room history)";
      items.push(`(room history, cursor ${cursor}: an earlier message, not a new one to act on)\n${frameEntry(entry)}`);
    }
    if (items.length > 0) this.informed();
    return { items, more: page.more };
  }

  // ---- leases ----

  private async leaseNames(): Promise<Record<string, string>> {
    const raw = (await readJson(this.o.mesh.leaseNamesPath).catch(() => undefined)) as Record<string, string> | undefined;
    return typeof raw === "object" && raw !== null ? raw : {};
  }

  private async keyFor(name: string): Promise<string> {
    const key = leaseKey(this.config.mesh, name);
    const names = await this.leaseNames();
    if (names[key] !== name) await writeJson(this.o.mesh.leaseNamesPath, { ...names, [key]: name }, this.o.env);
    return key;
  }

  async acquireLease(name: string, ttlMs: number, wait: boolean): Promise<LeaseFrame> {
    const key = await this.keyFor(name);
    const link = await this.ready();
    const answer = (await link.request(
      { t: "lease.acquire", key, ttl: ttlMs, ...(wait ? { wait: true } : {}) },
      (f) => f.t === "lease" && f.key === key,
      (wait ? ttlMs : 0) + (this.answerMs),
    )) as LeaseFrame;
    if (answer.status === "granted" && answer.token !== undefined) await this.save({ leases: { ...this.state.leases, [key]: answer.token } });
    return answer;
  }

  async renewLease(name: string, ttlMs: number): Promise<LeaseFrame> {
    const key = await this.keyFor(name);
    const token = this.state.leases[key];
    if (token === undefined) throw new ClientError(`this session does not hold the lease ${JSON.stringify(name)}`, "not_held");
    const link = await this.ready();
    return (await link.request({ t: "lease.renew", key, token, ttl: ttlMs }, (f) => f.t === "lease" && f.key === key, this.answerMs)) as LeaseFrame;
  }

  async releaseLease(name: string): Promise<LeaseFrame> {
    const key = await this.keyFor(name);
    const token = this.state.leases[key];
    if (token === undefined) throw new ClientError(`this session does not hold the lease ${JSON.stringify(name)}`, "not_held");
    const link = await this.ready();
    const answer = (await link.request({ t: "lease.release", key, token }, (f) => f.t === "lease" && f.key === key, this.answerMs)) as LeaseFrame;
    const { [key]: _gone, ...rest } = this.state.leases;
    await this.save({ leases: rest });
    return answer;
  }

  /** Current leases with plain names where this device knows them (else the key). */
  async listLeases(): Promise<Array<{ name: string; holder: string; expires_at: number; token: number }>> {
    const link = await this.ready();
    const answer = (await link.request({ t: "lease.list" }, (f) => f.t === "leases", this.answerMs)) as LeasesFrame;
    const names = await this.leaseNames();
    return answer.leases.map((l) => ({ name: names[l.key] ?? l.key, holder: l.holder, expires_at: l.until, token: l.token }));
  }

  // ---- files ----

  /** Uploads a file's encrypted chunks, then sends the `file` message that carries its key. */
  async sendFile(toInput: string | readonly string[], path: string, caption?: string): Promise<SendOutcome> {
    const full = await fs.realpath(resolve(path)).catch(() => undefined);
    if (full === undefined) throw new ClientError(`not a regular file: ${path}`, "not_found");
    const wimHome = resolve(this.o.mesh.dir, "..", "..");
    // Through links like the file itself, so a home reached by a link still guards its credential directories.
    const userHome = this.o.userHome ?? homedir();
    const why = unsendable(full, await fs.realpath(wimHome), await fs.realpath(userHome).catch(() => resolve(userHome)));
    if (why !== undefined) throw new ClientError(`refusing to send ${path}: ${why}`, "forbidden");
    // Opened once, refusing a link (so a path swapped for one after the check above fails), and
    // checked and read through that one handle. Non-blocking, so a FIFO is refused, not waited on
    // (Windows has neither flag nor FIFOs; `|` reads its missing O_NONBLOCK as 0).
    const flags = fsConstants.O_RDONLY | noFollow(fsConstants) | fsConstants.O_NONBLOCK;
    const handle = await openNoFollow(full, flags);
    if (handle === undefined) throw new ClientError(`not a regular file: ${path}`, "not_found");
    let bytes: Uint8Array;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new ClientError(`not a regular file: ${path}`, "not_found");
      if (stat.size > LIMITS.blobFileBytes) throw new ClientError(`the file is over ${LIMITS.blobFileBytes / 1024 / 1024} MiB`, "too_large");
      bytes = new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
    const secrets = secretsInFile(bytes);
    if (secrets.length > 0) throw new ClientError(`refusing to send ${path}: it appears to contain a secret (${secrets.join(", ")})`, "secret");
    const sealed = sealBlob(bytes);
    const link = await this.ready();
    for (const c of sealed.chunks) {
      const answer = (await link.request(
        { t: "blob.put", blob: sealed.blob, index: c.index, last: c.last, n: c.n, data: c.data },
        (f) => (f.t === "blob.stored" && f.blob === sealed.blob && f.index === c.index) || errorFor("blob.put")(f),
        this.answerMs * 3,
      )) as RelayFrame;
      if (answer.t === "error") throw relayRefusal("the relay did not store the file", answer);
    }
    const file: FileInfo = {
      blob: sealed.blob,
      name: wireFileName(basename(full)),
      size: sealed.size,
      mime: mimeFor(full),
      key: sealed.key,
      sha256: sealed.sha256,
      chunks: sealed.chunks.length,
    };
    return this.send(toInput, caption, { kind: "file", file });
  }

  /** Downloads, decrypts and checks a file, and saves it under a name of this client's choosing. */
  private async fetchFile(id: string, file: FileInfo): Promise<string> {
    const link = await this.ready(this.answerMs);
    const chunks: Array<{ index: number; last: boolean; n: string; data: string }> = [];
    for (let index = 0; index < file.chunks; index++) {
      const answer = (await link.request(
        { t: "blob.get", blob: file.blob, index },
        (f) => (f.t === "blob.chunk" && f.blob === file.blob && f.index === index) || errorFor("blob.get")(f),
        this.answerMs * 3,
      )) as RelayFrame;
      if (answer.t === "error") throw relayRefusal("the relay did not serve the file", answer);
      const c = answer as BlobChunkFrame;
      chunks.push({ index: c.index, last: c.last, n: c.n, data: c.data });
    }
    const opened = openBlob({ blob: file.blob, key: file.key, sha256: file.sha256, size: file.size, chunks });
    if (!opened.ok) throw new ClientError(opened.reason, opened.reason);
    return saveReceived(this.files.filesDir, id, file.name, opened.value);
  }

  // ---- reading ----

  /**
   * Unread items, marked read unless `peek`: relayed items kept after the plugin passed them
   * first, then the spool. For agents without push delivery, and for relayed items everywhere.
   */
  async inbox(peek: boolean): Promise<SpoolItem[]> {
    const kept = await this.spool.relayed();
    const items = [...kept, ...(await this.spool.unread())];
    if (!peek) await this.markRead(items);
    return items;
  }

  /**
   * Marks items an `inbox(true)` returned as read: the spool's up to the newest of them, and the
   * relayed ones out of the box. A caller that shows them one at a time (`wim inbox`) marks each
   * once it is shown, so what it could not show stays unread.
   */
  async markRead(items: readonly SpoolItem[]): Promise<void> {
    // Read here, so no sweep (this one or a concurrent pass) keeps them in the relayed box.
    for (const i of items) if (i.relayed === true) this.readRelayed.add(i.id);
    const newest = Math.max(0, ...items.map((i) => i.cursor));
    if (newest > this.spool.taken) await this.take(newest);
    // A pass that was already writing one to the box when the read began is undone here.
    await this.spool.dismissRelayed([...this.readRelayed]);
    this.informed(items);
  }

  /** The next unread item, waiting up to `timeoutMs`. Marks it read. */
  next(timeoutMs: number, onTick?: (elapsed: number) => void, tickMs = 30_000): Promise<SpoolItem | undefined> {
    const started = this.now();
    return new Promise((resolve, reject) => {
      // Set once the wait has its item, has failed or has run out: nothing is taken after that.
      let over = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        over = true;
        clearTimeout(timer);
        clearInterval(beat);
        this.off("item", onItem);
      };
      const fail = (error: unknown): void => {
        finish();
        reject(error);
      };
      // The oldest unread item, taken by the first look that sees one: a second item delivered
      // meanwhile stays unread for the next call.
      const takeFirst = (items: SpoolItem[]): void => {
        const first = items[0];
        if (over || first === undefined) return;
        finish();
        this.take(first.cursor).then(() => {
          this.informed([first]);
          resolve(first);
        }, reject);
      };
      const look = (): void => void this.spool.unread().then(takeFirst, fail);
      // The time counts from the end of the first look, so an item already unread is returned
      // however slow the look (a Windows runner) and however short the wait.
      const firstLook = (items: SpoolItem[]): void => {
        takeFirst(items);
        if (!over) timer = setTimeout(() => (finish(), resolve(undefined)), timeoutMs);
      };
      // An item's event starts a look. One at or below the cursor is not new: its event came after
      // a look already took it. With push set, items go to the channel instead.
      const onItem = (item: SpoolItem): void => {
        if (this.push === undefined && item.cursor > this.spool.taken) look();
      };
      const beat = setInterval(() => onTick?.(this.now() - started), tickMs);
      // Listening starts before the first look: an item written after that look listed the spool,
      // whose event came before a listener was there, would otherwise wait out the timeout unseen.
      this.on("item", onItem);
      void this.spool.unread().then(firstLook, fail);
    });
  }
}
