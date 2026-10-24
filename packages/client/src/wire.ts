// The connection to a relay: one socket (`Link`) with frame waiters, and a reconnecting
// `Connection` that authenticates, resumes and backs off with jitter (SPEC section 8).

import {
  CLOSE,
  isRelayUrl,
  LIMITS,
  parseRelayFrame,
  sanitizeForDisplay,
  spkiPin,
  type AuthFrame,
  type ErrorFrame,
  type HelloFrame,
  type ReadyFrame,
  type RelayFrame,
} from "@worldinmotion/protocol";
import { isIP } from "node:net";
import * as tls from "node:tls";
import WebSocket from "ws";

/** What the client needs from a socket, so tests can plug a relay in without a network. */
export interface WireSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
}

export type Dialer = (url: string, opts: { tlsPin?: string }) => Promise<WireSocket>;

/**
 * A refusal that quotes text the relay wrote: what this client says, and the relay's words,
 * already made safe with `relayText`. An MCP host labels the quote as the relay's.
 */
export type RelayQuote = { what: string; said: string };

export class WireError extends Error {
  override readonly name = "WireError";
  readonly code: string;
  readonly quote: RelayQuote | undefined;

  constructor(message: string, code: string, quote?: RelayQuote) {
    super(message);
    this.code = code;
    this.quote = quote;
  }
}

/** How much of a relay-authored string is kept. */
export const RELAY_TEXT_MAX = 200;

/**
 * Text a relay wrote (a close reason, an error frame's message), as the client may show or log
 * it: cut to RELAY_TEXT_MAX characters, controls and invisible characters escaped visibly, and
 * on one line. The relay is not trusted (SECURITY-MODEL 7.1).
 */
export function relayText(text: string): string {
  const chars = [...text];
  const cut = chars.length > RELAY_TEXT_MAX ? `${chars.slice(0, RELAY_TEXT_MAX).join("")}…` : text;
  return sanitizeForDisplay(cut).replace(/\n/g, "<U+000A>").replace(/\t/g, " ");
}

/** A relay-chosen error code, kept only when it reads as one (lower case and `_`), else `relay_error`. */
export function relayCode(code: string): string {
  return /^[a-z][a-z_]{0,63}$/.test(code) ? code : "relay_error";
}

/**
 * The relay's reasons for refusing `auth` that this client knows (protocol `verifyAuth` and
 * relay-core), each with what the person can do about it. Any other text from the relay is not
 * repeated.
 */
const AUTH_REFUSALS: ReadonlyMap<string, string> = new Map([
  ["wrong_relay", "the relay is configured for a different URL than the one this mesh uses; use the exact URL the relay prints at start-up"],
  ["clock_skew", "this device's clock is too far from the relay's; correct the clock and try again"],
  ["wrong_device", "the relay holds a different key for this device id"],
  ["bad_signature", "the relay could not verify this device's signature against the roster"],
  ["wrong_nonce", "the authentication answered another connection's challenge"],
  ["malformed", "the relay could not read this client's authentication"],
  ["unknown mesh", "the relay does not know this mesh; check the relay URL"],
  ["the device is not in the roster", "this device is not in the relay's roster (it may have been revoked)"],
  ["recovery records do not connect", "a recovery record cannot connect as a device"],
  ["the pinned roster is newer than any this relay holds", "this device knows a newer roster than the relay holds"],
]);

/** The person-facing reason for an `auth` refusal the client knows; undefined for any other text. */
export function authRefusal(f: ErrorFrame): string | undefined {
  return AUTH_REFUSALS.get(f.message);
}

/**
 * A relay URL as a refusal may show it: the scheme and host, never credentials or the path, and
 * at most four characters of a mesh id (as `redactUrl` keeps for logs).
 */
function shownRelay(relay: string): string {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)(?:[^/?#@]*@)?([^/?#]*)/.exec(relay);
  if (m === null) return "the relay URL";
  const mesh = /\/v1\/([A-Za-z0-9_-]{4})/.exec(relay);
  return `${JSON.stringify(sanitizeForDisplay(`${m[1]}${m[2]}`))}${mesh === null ? "" : ` (mesh ${mesh[1]}…)`}`;
}

/** Why `isRelayUrl` refuses a URL, in the order it checks. */
function whyNotRelay(relay: string): string {
  if (!/^wss?:\/\//.test(relay)) return "use wss:// (ws:// only to a loopback address)";
  if (/^wss?:\/\/[^/?#]*@/.test(relay)) return "a relay URL carries no user name or password";
  if (/[?#]/.test(relay)) return "a relay URL has no query or fragment";
  if (/\s/.test(relay)) return "a relay URL has no spaces";
  if (relay.endsWith("/")) return "remove the trailing slash";
  if (relay.length > 2048) return "it is over 2048 characters";
  if (relay.startsWith("ws://") && URL.canParse(relay)) return "ws:// is only for a loopback relay (127.0.0.1, [::1] or localhost); use wss://";
  return "it is not a valid URL";
}

/** True for an IP literal in a private or link-local range (RFC 1918, RFC 4193, 169.254/16, fe80::/10). */
export function isPrivateAddress(host: string): boolean {
  const h = host.startsWith("[") ? host.slice(1, -1).toLowerCase() : host.toLowerCase();
  if (isIP(h) === 4) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (isIP(h) === 6) return /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  return false;
}

/**
 * Refuses a relay URL the client must not dial (SPEC section 2 and revision 3b): anything but
 * `wss://`, `ws://` other than to loopback, and `wss://` to a private or link-local address
 * unless the relay's certificate is pinned.
 */
export function checkDialable(relay: string, tlsPin: string | undefined): void {
  if (!isRelayUrl(relay)) throw new WireError(`refusing relay URL ${shownRelay(relay)}: ${whyNotRelay(relay)}`, "bad_url");
  const host = new URL(relay).hostname;
  if (relay.startsWith("wss://") && isPrivateAddress(host) && tlsPin === undefined) {
    throw new WireError(`refusing relay URL ${shownRelay(relay)}: a private or link-local relay needs a pinned certificate`, "needs_pin");
  }
}

/** b64u SHA-256 of a certificate's SubjectPublicKeyInfo, the form a pin takes. */
export function spkiHash(cert: { publicKey: { export(o: { type: "spki"; format: "der" }): Buffer } }): string {
  return spkiPin(new Uint8Array(cert.publicKey.export({ type: "spki", format: "der" })));
}

/**
 * A `tls.connect` that accepts exactly the pinned key. Ordinary CA validation is off only here,
 * and the pin is checked as soon as the handshake ends, before the WebSocket upgrade completes.
 */
export function pinnedConnect(pin: string, connect: typeof tls.connect = tls.connect) {
  return (options: tls.ConnectionOptions): tls.TLSSocket => {
    const socket = connect({ ...options, rejectUnauthorized: false });
    socket.once("secureConnect", () => {
      const cert = socket.getPeerX509Certificate();
      if (cert === undefined || spkiHash(cert) !== pin) socket.destroy(new WireError("the relay certificate does not match the pin", "pin_mismatch"));
    });
    return socket;
  };
}

/** The production dialer, on the `ws` package (pure JavaScript, so it bundles). */
export const wsDialer: Dialer = (url, opts) =>
  new Promise((resolve, reject) => {
    const options: WebSocket.ClientOptions = { maxPayload: LIMITS.receiveFrameBytes, handshakeTimeout: 15_000, perMessageDeflate: false };
    if (opts.tlsPin !== undefined) {
      (options as { createConnection?: unknown }).createConnection = pinnedConnect(opts.tlsPin);
    }
    const ws = new WebSocket(url, options);
    // The relay's hello can arrive in the same packet as the upgrade, before the caller has its
    // handler in place, so text frames are buffered until it does.
    const early: string[] = [];
    let deliver: ((text: string) => void) | undefined;
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      if (deliver === undefined) early.push(text);
      else deliver(text);
    });
    ws.once("open", () => {
      resolve({
        send: (text) => ws.send(text),
        close: (code, reason) => ws.close(code, reason),
        onMessage: (cb) => {
          deliver = cb;
          for (const text of early.splice(0)) cb(text);
        },
        onClose: (cb) => ws.once("close", (code, reason) => cb(code, reason.toString())),
      });
    });
    // Kept for the socket's whole life: an `error` event with no listener would crash the
    // process. Before open it fails the dial; after it, the close that follows does the work.
    ws.on("error", reject);
  });

type Waiter = { match: (f: RelayFrame) => boolean; resolve: (f: RelayFrame) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/** One open socket to a relay: frames in, frames out, and waiters for answers. */
export class Link {
  private readonly waiters = new Set<Waiter>();
  private readonly listeners: Array<(f: RelayFrame) => void> = [];
  private isClosed = false;
  /** Resolves with the close code and reason once the socket is gone. */
  readonly closed: Promise<{ code: number; reason: string }>;

  private readonly socket: WireSocket;

  private constructor(socket: WireSocket) {
    this.socket = socket;
    let done!: (v: { code: number; reason: string }) => void;
    this.closed = new Promise((resolve) => (done = resolve));
    socket.onClose((code, reason) => {
      this.isClosed = true;
      for (const w of this.waiters) {
        clearTimeout(w.timer);
        const what = `the relay closed the connection (${code})`;
        const quote = reason === "" ? undefined : { what, said: relayText(reason) };
        w.reject(new WireError(quote === undefined ? what : `the relay closed the connection (${code} ${quote.said})`, "closed", quote));
      }
      this.waiters.clear();
      done({ code, reason });
    });
  }

  /** Dials and waits for the relay's `hello`. */
  static async open(dialer: Dialer, url: string, opts: { tlsPin?: string; timeoutMs?: number } = {}): Promise<{ link: Link; hello: HelloFrame }> {
    const socket = await dialer(url, opts.tlsPin === undefined ? {} : { tlsPin: opts.tlsPin });
    const link = new Link(socket);
    // The waiter is armed before frames flow, since a socket may hand over buffered ones at once.
    const waiting = link.wait((f) => f.t === "hello", opts.timeoutMs ?? 10_000);
    socket.onMessage((text) => link.receive(text));
    try {
      const hello = (await waiting) as HelloFrame;
      return { link, hello };
    } catch (error) {
      link.close();
      throw error;
    }
  }

  get isOpen(): boolean {
    return !this.isClosed;
  }

  private receive(text: string): void {
    const parsed = parseRelayFrame(text);
    // Frames that do not parse are ignored: the relay is not trusted to send good ones.
    if (!parsed.ok) return;
    const frame = parsed.value;
    for (const w of [...this.waiters]) {
      if (!w.match(frame)) continue;
      this.waiters.delete(w);
      clearTimeout(w.timer);
      w.resolve(frame);
    }
    for (const cb of this.listeners) cb(frame);
  }

  on(cb: (f: RelayFrame) => void): void {
    this.listeners.push(cb);
  }

  send(frame: object): void {
    if (this.isClosed) throw new WireError("not connected to the relay", "closed");
    this.socket.send(JSON.stringify(frame));
  }

  /** The next frame that `match` accepts, within `timeoutMs`. */
  wait(match: (f: RelayFrame) => boolean, timeoutMs: number): Promise<RelayFrame> {
    if (this.isClosed) return Promise.reject(new WireError("not connected to the relay", "closed"));
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(w);
          reject(new WireError("the relay did not answer in time", "timeout"));
        }, timeoutMs),
      };
      this.waiters.add(w);
    });
  }

  /** Sends a frame and waits for its answer; the waiter is armed first, so no answer is missed. */
  request(frame: object, match: (f: RelayFrame) => boolean, timeoutMs: number): Promise<RelayFrame> {
    const answer = this.wait(match, timeoutMs);
    try {
      this.send(frame);
    } catch (error) {
      answer.catch(() => undefined);
      throw error;
    }
    return answer;
  }

  close(code: number = CLOSE.bye, reason = ""): void {
    if (!this.isClosed) this.socket.close(code, reason);
  }
}

/**
 * A dial URL for logs that hosts keep (an MCP host saves stderr): the relay host and the first
 * four characters of the mesh id, never the whole id.
 */
export function redactUrl(url: string): string {
  const m = /^(wss?:\/\/[^/]+)(?:\/.*)?\/v1\/([A-Za-z0-9_-]{4})[A-Za-z0-9_-]*$/.exec(url);
  return m === null ? "the relay" : `${m[1]} (mesh ${m[2]}…)`;
}

/** An `error` frame that refers to `ref`. */
export const errorFor = (ref: string) => (f: RelayFrame): boolean => f.t === "error" && f.ref === ref;

/** Close codes after which reconnecting cannot help. */
export const FATAL_CLOSE: ReadonlyMap<number, string> = new Map([
  [CLOSE.unauthorized, "the relay refused this device's authentication"],
  [CLOSE.revoked, "this device was revoked from the mesh"],
  [CLOSE.replaced, "another connection took over this session"],
]);

export type ConnectionOptions = {
  dialer: Dialer;
  url: string;
  tlsPin?: string;
  /** Signs the `auth` answer to this connection's `hello`. */
  auth: (hello: HelloFrame) => AuthFrame;
  /** Runs once per successful `ready`, before any other frame of that connection is handled. */
  onReady: (ready: ReadyFrame, link: Link, hello: HelloFrame) => Promise<void>;
  onFrame: (f: RelayFrame) => void;
  onFatal: (reason: string) => void;
  log: (line: string) => void;
  random?: () => number;
  baseMs?: number;
  maxMs?: number;
  /** A ping goes out after this long without traffic; no answer within it again drops the link. */
  heartbeatMs?: number;
  /** Log the full dial URL (with the mesh id); otherwise only the host and a mesh id prefix. */
  debug?: boolean;
  /** Each change of connection state, with the reason for a close. */
  onState?: (state: "connecting" | "open" | "closed", detail?: string) => void;
};

/**
 * A session's connection: dials, authenticates with `resume`, and on any loss reconnects with
 * exponential backoff and jitter until stopped or refused for good.
 */
export class Connection {
  private link: Link | undefined;
  private stopped = false;
  private attempt = 0;
  private readyWaiters: Array<{ resolve: (l: Link) => void; reject: (e: Error) => void }> = [];
  private retry: NodeJS.Timeout | undefined;
  private beat: NodeJS.Timeout | undefined;
  private lastFrame = 0;
  private fatal: WireError | undefined;
  /** Why the relay refused this connection's `auth`, in this client's words. */
  private refusal: string | undefined;
  private byeOnStop: { ended: boolean } | undefined;

  private readonly o: ConnectionOptions;

  constructor(o: ConnectionOptions) {
    this.o = o;
  }

  get current(): Link | undefined {
    return this.link;
  }

  start(): void {
    void this.connect();
  }

  /** The ready link, waiting up to `timeoutMs` for one. */
  ready(timeoutMs: number): Promise<Link> {
    // A link that closed a moment ago is not ready: wait for the reconnect instead.
    if (this.link?.isOpen === true) return Promise.resolve(this.link);
    if (this.fatal !== undefined) return Promise.reject(this.fatal);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== waiter);
        reject(new WireError("not connected to the relay", "offline"));
      }, timeoutMs);
      const waiter = {
        resolve: (l: Link): void => {
          clearTimeout(timer);
          resolve(l);
        },
        reject: (e: Error): void => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.readyWaiters.push(waiter);
    });
  }

  /** Delay before the next attempt: exponential, capped, with jitter in the upper half. */
  backoff(attempt: number): number {
    const base = this.o.baseMs ?? 500;
    const cap = Math.min(this.o.maxMs ?? 30_000, base * 2 ** attempt);
    return Math.round(cap / 2 + (this.o.random ?? Math.random)() * (cap / 2));
  }

  private async connect(): Promise<void> {
    let link: Link | undefined;
    this.refusal = undefined;
    this.o.log(`wim: connecting to ${this.o.debug === true ? this.o.url : redactUrl(this.o.url)} (attempt ${this.attempt + 1})`);
    this.o.onState?.("connecting");
    try {
      const opened = await Link.open(this.o.dialer, this.o.url, this.o.tlsPin === undefined ? {} : { tlsPin: this.o.tlsPin });
      link = opened.link;
      const hello = opened.hello;
      if (this.stopped) return link.close();
      // Frames that arrive while onReady runs are replayed in order afterwards.
      const early: RelayFrame[] = [];
      let live = false;
      link.on((f) => {
        this.lastFrame = Date.now();
        if (live) this.o.onFrame(f);
        else if (f.t !== "ready") early.push(f);
      });
      const ready = (await link.request(this.o.auth(hello), (f) => f.t === "ready" || errorFor("auth")(f), 10_000)) as RelayFrame;
      if (ready.t !== "ready") {
        this.refusal = authRefusal(ready as ErrorFrame);
        throw new WireError(`the relay refused auth${this.refusal === undefined ? ` (${relayCode((ready as ErrorFrame).code)})` : `: ${this.refusal}`}`, "auth");
      }
      await this.o.onReady(ready, link, hello);
      if (this.stopped) {
        // Stopped while connecting: a requested bye still goes out before the close.
        if (this.byeOnStop !== undefined) link.send({ t: "bye", ended: this.byeOnStop.ended });
        return link.close(CLOSE.bye, "stopped");
      }
      this.attempt = 0;
      this.link = link;
      this.armHeartbeat(link);
      live = true;
      for (const f of early) this.o.onFrame(f);
      this.o.log(`wim: connected as ${ready.name} (sid ${ready.sid})`);
      this.o.onState?.("open");
      for (const w of this.readyWaiters.splice(0)) w.resolve(link);
      const closed = await link.closed;
      this.link = undefined;
      const detail = `connection closed (code ${closed.code}${closed.reason === "" ? "" : `, ${relayText(closed.reason)}`})`;
      this.o.log(`wim: ${detail}`);
      this.o.onState?.("closed", detail);
      this.lost(closed.code, closed.reason);
    } catch (error) {
      link?.close();
      const closed = link === undefined ? undefined : await link.closed;
      this.o.log(`wim: connection failed: ${(error as Error).message}`);
      this.o.onState?.("closed", `connection failed: ${(error as Error).message}`);
      this.lost(closed?.code ?? 0, closed?.reason ?? "");
    }
  }

  private armHeartbeat(link: Link): void {
    const every = this.o.heartbeatMs ?? 30_000;
    clearInterval(this.beat);
    this.lastFrame = Date.now();
    let pinged = false;
    this.beat = setInterval(() => {
      const quiet = Date.now() - this.lastFrame;
      if (quiet < every) {
        pinged = false;
        return;
      }
      if (pinged) {
        this.o.log("wim: no answer to ping; dropping the connection");
        return link.close(CLOSE.pingTimeout, "no answer to ping");
      }
      pinged = true;
      // A closed link clears this timer in the same turn as its close, before it can fire.
      link.send({ t: "ping" });
    }, every);
  }

  private lost(code: number, reason: string): void {
    clearInterval(this.beat);
    if (this.stopped) return;
    const fatal = FATAL_CLOSE.get(code);
    if (fatal !== undefined) {
      // A refused `auth` says why in this client's words; otherwise the relay's reason is quoted.
      const said = this.refusal ?? (reason === "" ? undefined : relayText(reason));
      const message = said === undefined ? fatal : `${fatal} (${said})`;
      this.fatal = new WireError(message, "fatal", said === undefined || this.refusal !== undefined ? undefined : { what: fatal, said });
      for (const w of this.readyWaiters.splice(0)) w.reject(this.fatal);
      this.o.log(`wim: not reconnecting: ${message}`);
      this.o.onFatal(message);
      return;
    }
    // The first retry after a loss is immediate; repeated failures back off.
    const delay = this.attempt === 0 ? 0 : this.backoff(this.attempt - 1);
    this.attempt++;
    this.o.log(`wim: reconnecting in ${delay} ms`);
    this.retry = setTimeout(() => void this.connect(), delay);
  }

  /** Stops for good. With `bye`, tells the relay the session ended (its name and queue are freed). */
  stop(bye?: { ended: boolean }): void {
    this.stopped = true;
    this.byeOnStop = bye;
    clearTimeout(this.retry);
    clearInterval(this.beat);
    const link = this.link;
    this.link = undefined;
    if (link === undefined) return;
    if (bye !== undefined) {
      try {
        link.send({ t: "bye", ended: bye.ended });
      } catch {
        // Already gone: nothing to tell.
      }
    }
    link.close(CLOSE.bye, "bye");
  }
}
