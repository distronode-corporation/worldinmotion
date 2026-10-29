// A session on a mesh: the connection, the receiving checks and inbound policy, the spool, and
// everything a session can do (send, ask, rooms, leases, files, presence).

import {
  CLOSE,
  dedupeExpiry,
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
  type FileInfo,
  type LeaseFrame,
  type Prekey,
  type LeasesFrame,
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
  type SendResult,
  type SentFrame,
} from "@worldinmotion/protocol";
import { EventEmitter } from "node:events";
import { constants as fsConstants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Breaker, pauseNotice } from "./breaker.ts";
import { cardFor, sameCard } from "./cards.ts";
import { mimeFor, saveReceived, secretsInFile, unsendable, wireFileName } from "./files.ts";
import { ensureDir, listDir, noFollow, openNoFollow, readJson, readText, removeFile, tryRemove, writeAtomic, writeJson, type FsEnv } from "./fsx.ts";
import { HeldBox, preview, takeMarks, type HeldItem, type Verdict } from "./held.ts";
import { frameEntry, History, type HistoryEntry } from "./history.ts";
import type { Device } from "./home.ts";
import { RosterBook, type MeshConfig, type MeshFiles, type Policy } from "./mesh.ts";
import type { Notifier } from "./notify.ts";
import { PeerPrekeys, PrekeyStore } from "./prekeys.ts";
import { noticeText, policyFor, policyLevel } from "./render.ts";
import { SeenStore, SeqStore } from "./replay.ts";
import { listSessions, newSessionState, SessionFiles, SessionKeys, type SessionState } from "./session.ts";
import { NeedsSigner } from "./keyring.ts";
import { SignerError } from "./signer.ts";
import { Spool, type SpoolItem } from "./spool.ts";
import { Connection, errorFor, relayCode, relayText, WireError, type Dialer, type Link, type RelayQuote } from "./wire.ts";

/** How many times a delivered frame may fail for a reason of its own before it is let go. */
const FRAME_ATTEMPTS = 3;

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

/** Whether a relay `sent` status means the message was taken (SPEC section 9): routed now, or queued. */
export function accepted(status: string): boolean {
  return status === "routed" || status === "queued";
}

export type SessionOptions = {
  device: Device;
  mesh: MeshFiles;
  name: string;
  kind: string;
  /** A stable key (a Claude Code session id, `WIM_SESSION_KEY`) that takes back an earlier session. */
  sessionKey?: string;
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
};

export type PeerRow = Peer & { card?: Card };

/** A delivered item's verified fields, for in-process consumers. */
export type Inbound = HistoryEntry & { cursor: number };

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
 */
export type SendOutcome = { id: string; results: SendResult[]; unprotected?: string[]; no_prekey?: string[] };

/** What a person or an agent is told about a send that went without forward secrecy. */
export function unprotectedNote(unprotected: readonly string[], noPrekey: readonly string[]): string {
  return `Sent without forward secrecy to ${unprotected.join(", ")}: no current prekey for ${noPrekey.join(", ")} (a v0.1 client, or offline for over 48 hours), so the whole send went in the v0.1 format.`;
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

/** The verified fields of a received plaintext, as history and the agent frame read them. */
function entryOf(p: Exclude<Plaintext, { kind: "card" }>, from: string): HistoryEntry {
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
  private stopped = false;
  private derivedUntil = 0;
  private sweeping: Promise<void> = Promise.resolve();
  /** Relayed items an agent read through `inbox`, so they are not kept for later. */
  private readonly readRelayed = new Set<string>();
  /** Delivery through MCP channel notifications instead of leaving items for the plugin. */
  push: ((item: SpoolItem) => Promise<void>) | undefined;

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
  }

  /**
   * Opens a session: the one `sessionKey` names when its mapping is fresh and no live process
   * holds it, else a new one. Claims the session's liveness lock.
   */
  static async open(o: SessionOptions): Promise<MeshSession> {
    const now = o.now ?? Date.now;
    const keys = new SessionKeys(o.mesh, o.env, now);
    let state: SessionState | undefined;
    const known = o.sessionKey === undefined ? undefined : await keys.lookup(o.sessionKey);
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
    // The plugin's pane writes its marks here, so both exist from the start.
    await ensureDir(files.heldDir);
    await ensureDir(files.dismissDir);
    await files.save(state);
    if (o.sessionKey !== undefined) await keys.remember(o.sessionKey, state.sid, state.resume);
    const session = new MeshSession(o, files, state);
    await session.load();
    return session;
  }

  /**
   * Same-project takeover (design.md, state on disk): an earlier session on this device with the
   * same name and working directory, not ended and run by no live process, is taken back with
   * its sid and resume secret, so the relay hands over its name, queue and rooms by proof.
   * Sessions from another directory keep their name; this one then gets `name-N`.
   */
  private static async sameProject(o: SessionOptions): Promise<SessionState | undefined> {
    if (o.cwd === undefined) return undefined;
    for (const sid of (await listSessions(o.mesh)).reverse()) {
      const files = new SessionFiles(o.mesh, sid, o.env);
      const saved = await files.load();
      if (saved?.name !== o.name || saved.cwd !== o.cwd || saved.ended === true) continue;
      if (await files.claim()) return { ...saved, kind: o.kind };
    }
    return undefined;
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
    this.conn?.stop({ ended: opts.ended === true });
    await this.inbound;
    if (opts.ended === true) this.state = { ...this.state, ended: true };
    await this.files.save(this.state);
    await this.files.release();
  }

  private async save(change: Partial<SessionState>): Promise<void> {
    this.state = { ...this.state, ...change, spool: Math.max(this.state.spool, this.spool.highest) };
    await this.files.save(this.state);
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
    await this.save({ name: ready.name, address, cursor: Math.max(this.state.cursor, ready.cursor) });
    this.peers.clear();
    for (const p of ready.peers) this.peers.set(p.address, p);
    this.emit("peers");
    this.sentPresence = undefined;
    this.cardsIn = new Promise((resolve) => (this.gotCards = resolve));
    this.emit("ready", this.address);
    void this.sendCard(link, true);
    this.retryParkedLater();
  }

  /**
   * Retries parked messages after the frames already queued. A failure takes the delivered-frame
   * path (inboundFailed): a signer that cannot answer holds acks and drops the connection, and the
   * parked files stay for the next ready. Never left as a rejection on the inbound queue, where it
   * would be unhandled, or skip the next frame's handler.
   */
  private retryParkedLater(): void {
    this.inbound = this.inbound.then(() => this.retryParked()).catch((e: unknown) => this.inboundFailed(e));
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
        return;
      }
      case "notice":
        void this.notice(f.of, `${f.of} is now idle (or has ended).`).catch((e: unknown) => this.log(`wim: notice: ${(e as Error).message}`));
        return;
      case "join.request":
        // Only `wim invite` acts on these; a session without a listener ignores them (a refusal).
        this.emit("join", f.join);
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
    }
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

  private open(msg: SendFrame, history = false) {
    return openMessageWith(msg, { roster: this.roster, me: this.receiver(), now: this.now(), history });
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
      if (!this.toldRestart) this.log(`wim: ${error.message}`);
      this.toldRestart = true;
      return;
    }
    this.log(`wim: inbound: ${(error as Error).message}`);
    // A frame that fails for a reason of its own (not the signer's) the third time it comes is let
    // go: logged, not held, so the next ack passes it. Holding it for good would stall the cursor
    // and bring everything after it again on every connection.
    if (id !== undefined && !(error instanceof SignerError) && this.failedAgain(id) >= FRAME_ATTEMPTS) {
      this.log(`wim: inbound: giving up on message ${id} after ${FRAME_ATTEMPTS} attempts; it will not be delivered`);
      return;
    }
    // Otherwise nothing more is acked on this connection: a later ack would take this frame with
    // it. The relay delivers it again on the next connection.
    this.heldLink = this.link;
    // When the signer could not answer, or what answers is not the signer, the connection goes
    // now: the next one authenticates only once the real signer answers. Any other failure keeps
    // it (a reconnect would only bring the same frame back at once).
    if (error instanceof SignerError && (error.transient || error.code === "mismatch")) this.link?.close(CLOSE.bye, "the device's signer did not answer");
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
    if (this.sendIfOpen({ t: "ack", cursor })) this.state = { ...this.state, cursor: Math.max(this.state.cursor, cursor) };
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

  /** A message whose roster ref has our seq but another hash: ask the relay which roster it holds. */
  private async probeFork(link: Link, seq: number): Promise<void> {
    const page = await link.request({ t: "roster.get", from: seq }, (f) => f.t === "roster" || errorFor("roster.get")(f), this.answerMs).catch(() => undefined);
    if (page?.t === "roster") await this.forkFrom(page.chain[0]!, link);
  }

  private async retryParked(): Promise<void> {
    for (const name of await listDir(this.files.behindDir)) {
      const path = join(this.files.behindDir, name);
      const msg = (await readJson(path).catch(() => undefined)) as SendFrame | undefined;
      const outcome = msg === undefined ? "dropped" : await this.check(msg, true);
      // Checked again on a later retry if it cannot be removed yet; a repeat is dropped as seen.
      if (outcome !== "behind") await tryRemove(path, this.o.env);
    }
  }

  private fromAddress(p: Plaintext): string {
    const name = this.roster.devices.find((d) => d.id === p.from.device)!.name;
    return `${p.from.session}@${name}`;
  }

  private async accept(p: Exclude<Plaintext, { kind: "card" }>): Promise<void> {
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

    const admitted = this.breaker.admit(p.from.device, entry.text.length);
    if (!admitted.ok) {
      const line = admitted.newly ? pauseNotice(from, admitted.reason as "peer", this.config.breaker) : undefined;
      if (admitted.newly) this.emit("breaker", { peer: from, state: "tripped", reason: admitted.reason });
      return this.hold({ ...held, reason: "breaker" }, line);
    }
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

  /** Fetches a file if there is one, renders the frame and puts the item in the spool. */
  private async release(item: Omit<HeldItem, "reason">, file: FileInfo | undefined): Promise<void> {
    const entry = { ...item.entry };
    if (file !== undefined) entry.savedTo = await this.fetchFile(item.id, file).catch((e: unknown) => `(not saved: ${(e as Error).message})`);
    // A device the person delivers from may assign work; relayed text and held senders only inform.
    const level = policyLevel(this.config, item.device);
    const trust = (level === "deliver" || level === "deliver-relayed") && entry.relayed !== true && entry.derived !== true ? "assign" : "inform";
    const rendered = frameEntry(entry, trust);
    const flags = { ...(entry.relayed ? { relayed: true as const } : {}), ...(trust === "inform" ? { informs: true as const } : {}) };
    await this.deliver({ kind: item.kind, from: item.from, device: item.device, id: item.id, at: item.at, rendered, ...flags }, entry);
  }

  private async hold(item: HeldItem, pauseLine?: string): Promise<void> {
    await this.held.add(item);
    this.receipt(item.id, "held");
    const count = (await this.held.list()).length;
    const line = pauseLine ?? `${count} message${count === 1 ? "" : "s"} held for the person's approval (latest from ${item.from}).`;
    await this.notice(item.from, line, count);
    await this.o.notifier?.notify(`worldinmotion: ${count} message${count === 1 ? "" : "s"} held for approval`);
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
  private deliver(item: Omit<SpoolItem, "cursor">, entry: HistoryEntry | undefined): Promise<SpoolItem> {
    const run = this.delivering.then(() => this.deliverNow(item, entry));
    this.delivering = run.then(() => undefined, () => undefined);
    return run;
  }

  private async deliverNow(item: Omit<SpoolItem, "cursor">, entry: HistoryEntry | undefined): Promise<SpoolItem> {
    this.informed([item]);
    const written = await this.spool.write(item);
    await this.save({});
    if (entry !== undefined) await this.history.append(entry);
    this.emit("item", written);
    // In-process consumers (bot, ci, a2a adapters) read the verified fields, not the rendered frame.
    if (entry !== undefined) this.emit("message", { ...entry, cursor: written.cursor } satisfies Inbound);
    // A relayed item must not start a turn, so it waits in the inbox instead of being pushed.
    if (this.push !== undefined && written.relayed !== true) {
      await this.push(written);
      await this.take(written.cursor);
    }
    return written;
  }

  /** A notice for the agent or the person, written to the spool like any item. */
  async notice(from: string, line: string, held?: number): Promise<void> {
    await this.deliver({ kind: "notice", from, device: "", id: ulid(this.now()), at: this.now(), rendered: noticeText(line), ...(held === undefined ? {} : { held }) }, undefined);
  }

  /** Marks spool items read up to `cursor`; the next sweep deletes them and sends receipts. */
  async take(cursor: number): Promise<void> {
    await this.spool.take(cursor);
    await this.sweep();
  }

  /** One sweep at a time: two at once could both copy a relayed item to its box, one after a dismiss. */
  private sweep(): Promise<void> {
    const run = this.sweeping.then(async () => {
      for (const item of await this.spool.sweep(this.readRelayed)) if (item.kind !== "notice") this.receipt(item.id, "delivered");
    });
    this.sweeping = run.catch(() => undefined);
    return run;
  }

  // ---- housekeeping ----

  /** One housekeeping pass: sweep the spool, presence, decisions left by the CLI, the card. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.sweep();
      await this.readPresence();
      for (const { id, verdict } of await this.held.takeMarks()) await this.decide(id, verdict).catch(() => undefined);
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
        if (m !== null) await this.resumePeer(m[1]!);
        if (req !== null && this.o.handover === true) await this.handOverSend(req[1]!, body);
      }
      await this.book.reload();
      // Rotation and deletion on schedule; a new prekey goes out with the card below.
      if (this.now() >= this.prekeys.due) await this.prekeys.maintain();
      if (this.link !== undefined) await this.sendCard(this.link, false);
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
    this.publishCard(link, card, await this.cardFrame(force || rotated, card), before);
  }

  /**
   * The card frame to send, or undefined when the card is unchanged and nothing forces it. Not
   * async: the decision is taken before the seal (which may wait on the signer) and a seal that
   * fails comes back as its error, so no branch follows an await (see publishCard).
   */
  private cardFrame(always: boolean, card: Card): Promise<SendFrame | Error | undefined> {
    if (!always && sameCard(this.myCard, card)) return Promise.resolve(undefined);
    const ids = this.roster.devices.map((d) => d.id);
    return sealMessageWith({ ...this.sealBase(["*"]), ...this.keysFor(ids, true).keys, kind: "card", card, recipients: ids }).catch((error: unknown) => error as Error);
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

  /** The person's decision on a held message (the pane, `wim held`). Never reachable by a message. */
  async decide(id: string, verdict: Verdict): Promise<void> {
    const item = await this.held.get(id);
    if (item === undefined) throw new ClientError(`no held message ${id}`, "not_found");
    await this.held.remove(id);
    if (verdict === "refuse") {
      this.receipt(id, "refused");
      return;
    }
    await this.release(item, item.fileInfo);
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
      // Live addresses let the CLI suggest one for an address nobody answers to.
      const live = [...this.peers.values()].filter((p) => p.status !== "offline").map((p) => p.address);
      await writeJson(answer, { ok: true, ...out, live }, this.o.env);
    } catch (error) {
      await writeJson(answer, { ok: false, error: (error as Error).message }, this.o.env);
    }
  }

  /** Lifts a breaker pause on a peer (by address) and releases what it held from that device. */
  async resumePeer(peer: string): Promise<number> {
    const device = this.roster.devices.find((d) => d.name === peer.slice(peer.indexOf("@") + 1));
    if (device === undefined) return 0;
    this.breaker.resume(device.id);
    this.emit("breaker", { peer, state: "resumed" });
    let n = 0;
    for (const item of await this.held.list()) {
      if (item.device !== device.id || item.reason !== "breaker") continue;
      await this.decide(item.id, "approve");
      n++;
    }
    return n;
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
   */
  private keysFor(ids: readonly string[], card = false): { keys: { prekeys: Record<string, Prekey>; prekey?: Prekey }; missing: string[] } {
    const own = this.prekeys.current();
    const prekeys = this.peerKeys.forSend(this.roster, ids);
    if (own !== undefined && ids.includes(this.device.id)) prekeys[this.device.id] = own;
    const acting = new Set(this.roster.devices.filter((d) => !isRecoveryName(d.name)).map((d) => d.id));
    const missing = ids.filter((id) => acting.has(id) && !Object.hasOwn(prekeys, id));
    if (missing.length > 0 && !card) return { keys: { prekeys: {} }, missing };
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
    const to = MeshSession.parseTo(toInput);
    const { ids, unknown } = this.recipients(to);
    const local = unknown.map((a) => ({ to: a, status: "unknown" as const }));
    const id = opts.id ?? ulid(this.now());
    const routed = to.filter((a) => !unknown.includes(a));
    if (routed.length === 0) return { id, results: local };
    // From seal to wire, one send at a time: the seq is read when sealing and saved before the
    // frame goes out, so an overlapping send would reuse it or overtake it, and the receiver
    // would drop one as a replay.
    const { frame, missing, answer: answering } = await this.serially(async () => {
      let sealed = await this.seal(id, routed, ids, text, opts);
      const link = await this.ready(this.answerMs);
      if (sealed.missing.length > 0) {
        // A device with no prekey may only be unknown so far: read what sibling sessions learned
        // and the first cards page of this connection, then seal again (same id and seq).
        await this.peerKeys.reload();
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([this.cardsIn, new Promise<void>((resolve) => (timer = setTimeout(resolve, this.answerMs)))]);
        clearTimeout(timer);
        if (Object.keys(this.peerKeys.forSend(this.roster, sealed.missing)).length > 0) sealed = await this.seal(id, routed, ids, text, opts);
      }
      await this.save({ seq: sealed.frame.seq });
      // Recorded before sending, so a quick answer already finds its task.
      if (opts.kind === "task") await this.recordSentTask(id, routed);
      return { frame: sealed.frame, missing: sealed.missing, answer: this.sendFrame(link, sealed.frame, id) };
    });
    const answer = await answering;
    if (answer.t === "error") throw relayRefusal("the relay refused the send", answer);
    const sent = answer as SentFrame;
    for (const a of routed) if (!isRoom(a) && a !== "*") this.breaker.noteSent(this.pairOf(a).split("/")[0]!, (text ?? "").length);
    await this.history.append({
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
    });
    const name = (d: string): string => this.roster.devices.find((r) => r.id === d)!.name;
    const unprotected = this.legacyIds(frame).map(name);
    return { id, results: [...local, ...sent.results], ...(unprotected.length > 0 ? { unprotected, no_prekey: missing.map(name) } : {}) };
  }

  private serially<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.sending.then(fn);
    this.sending = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Seals a message at the next seq; the secrets check and the protocol limits refuse here. */
  private async seal(id: string, routed: string[], ids: string[], text: string | undefined, opts: SendOptions): Promise<{ frame: SendFrame; missing: string[] }> {
    const derived = await this.isDerived();
    const { keys, missing } = this.keysFor(ids);
    try {
      const frame = await sealMessageWith({
        ...this.sealBase(routed),
        ...keys,
        id,
        kind: opts.kind ?? "msg",
        ...(text === undefined ? {} : { text }),
        ...(opts.reply_to === undefined ? {} : { reply_to: opts.reply_to }),
        ...(opts.deadline === undefined ? {} : { deadline: opts.deadline }),
        ...(opts.status === undefined ? {} : { status: opts.status }),
        ...(opts.file === undefined ? {} : { file: opts.file }),
        recipients: ids,
        ...(opts.relayed === true ? { relayed: true } : {}),
        ...(derived ? { derived: true } : {}),
        ...(opts.allowSecrets === true ? { allowSecrets: true } : {}),
      });
      return { frame, missing };
    } catch (error) {
      const message = (error as Error).message.replace(/^sealMessage: /, "");
      throw new ClientError(`refused: ${message}`, /secret/.test(message) ? "secret" : "invalid");
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
  async ask(to: string, task: string, timeoutMs: number): Promise<{ result?: AskResult; pending?: true; task_id: string; results: SendResult[] }> {
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
    await this.save({ name, address: want });
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
      // A card is addressed to `*` only (the plaintext schema), so a room never holds one.
      const p = r.value as Exclude<Plaintext, { kind: "card" }>;
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
    const items = await this.spool.unread();
    if (!peek) {
      // Read here, so no sweep (this one or a concurrent pass) keeps them in the relayed box.
      for (const i of items) if (i.relayed === true) this.readRelayed.add(i.id);
      if (items.length > 0) await this.take(items.at(-1)!.cursor);
      // A pass that was already writing one to the box when the read began is undone here.
      await this.spool.dismissRelayed([...kept.map((i) => i.id), ...this.readRelayed]);
    }
    if (!peek) this.informed([...kept, ...items]);
    return [...kept, ...items];
  }

  /** The next unread item, waiting up to `timeoutMs`. Marks it read. */
  async next(timeoutMs: number, onTick?: (elapsed: number) => void, tickMs = 30_000): Promise<SpoolItem | undefined> {
    const started = this.now();
    const first = (await this.spool.unread())[0];
    if (first !== undefined) {
      await this.take(first.cursor);
      this.informed([first]);
      return first;
    }
    return new Promise((resolve) => {
      const done = (item: SpoolItem | undefined): void => {
        clearTimeout(timer);
        clearInterval(beat);
        this.off("item", onItem);
        resolve(item);
      };
      // The first item only: the listener goes before anything is awaited, so a second item
      // delivered while this one is taken stays unread for the next call.
      // An item's event can arrive after the scan above already took it (the event follows the
      // write, and the scan can see the file first); one at or below the cursor is not new.
      const onItem = (item: SpoolItem): void => {
        if (this.push !== undefined || item.cursor <= this.spool.taken) return;
        this.off("item", onItem);
        void this.take(item.cursor).then(() => {
          this.informed([item]);
          done(item);
        });
      };
      const timer = setTimeout(() => done(undefined), timeoutMs);
      const beat = setInterval(() => onTick?.(this.now() - started), tickMs);
      this.on("item", onItem);
    });
  }
}
