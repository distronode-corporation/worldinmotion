import { X509Certificate } from "node:crypto";
import { createServer as createHttps } from "node:https";
import { createServer as createHttp } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { b64u, CLOSE, generateDeviceKeys, signAuth, ulid, type HelloFrame } from "@worldinmotion/protocol";
import { checkDialable, Connection, errorFor, isPrivateAddress, Link, pinnedConnect, spkiHash, WireError, wsDialer, type Dialer, type WireSocket } from "../src/wire.ts";
import { selfSignedCert } from "@worldinmotion/relay-node";
import { sleep, until } from "./helpers.ts";

const NONCE = b64u.encode(new Uint8Array(32).fill(1));
const HELLO = JSON.stringify({ t: "hello", v: 1, nonce: NONCE, at: 1 });

/** A scripted socket: the test plays the relay. */
function fake(script: (sent: string, sock: Scripted) => void = () => undefined) {
  const socks: Scripted[] = [];
  const dialer: Dialer = async () => {
    const s = new Scripted(script);
    socks.push(s);
    setImmediate(() => s.push(HELLO));
    return s;
  };
  return { dialer, socks };
}

class Scripted implements WireSocket {
  sent: string[] = [];
  closedWith: number | undefined;
  private msg: (t: string) => void = () => undefined;
  private shut: (c: number, r: string) => void = () => undefined;
  private readonly script: (sent: string, sock: Scripted) => void;
  constructor(script: (sent: string, sock: Scripted) => void) {
    this.script = script;
  }
  send(text: string): void {
    this.sent.push(text);
    this.script(text, this);
  }
  close(code = 1000, reason = ""): void {
    if (this.closedWith !== undefined) return;
    this.closedWith = code;
    setImmediate(() => this.shut(code, reason));
  }
  onMessage(cb: (t: string) => void): void {
    this.msg = cb;
  }
  onClose(cb: (c: number, r: string) => void): void {
    this.shut = cb;
  }
  push(text: string): void {
    setImmediate(() => this.msg(text));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("checkDialable", () => {
  it("refuses ws:// off loopback and private wss:// without a pin", () => {
    expect(() => checkDialable("ws://example.com", undefined)).toThrow('refusing relay URL "ws://example.com": ws:// is only for a loopback relay (127.0.0.1, [::1] or localhost); use wss://');
    expect(() => checkDialable("ws://127.0.0.1:1", undefined)).not.toThrow();
    expect(() => checkDialable("wss://relay.example", undefined)).not.toThrow();
    expect(() => checkDialable("wss://192.168.1.5", undefined)).toThrow('refusing relay URL "wss://192.168.1.5": a private or link-local relay needs a pinned certificate');
    expect(() => checkDialable("wss://192.168.1.5", "p".repeat(43))).not.toThrow();
    expect(() => checkDialable("ws://192.168.1.5", "p".repeat(43))).toThrow(/wss/);
  });
  it("classifies private and link-local literals", () => {
    for (const h of ["10.0.0.1", "172.16.0.1", "172.31.9.9", "192.168.0.1", "169.254.1.1", "[fd00::1]", "[fc12::1]", "[fe80::1]", "fe80::1"]) expect(isPrivateAddress(h)).toBe(true);
    for (const h of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "[2001:db8::1]", "relay.example", "127.0.0.1"]) expect(isPrivateAddress(h)).toBe(false);
  });
  it("classifies every non-public range, in any spelling the URL parser leaves", () => {
    // The hostname a wss:// URL carries, as the client reads it.
    const host = (u: string): string => new URL(u).hostname;
    const nonPublic = [
      // Shared (carrier-grade NAT), "this network", IETF protocol assignments, benchmarking.
      "100.64.0.1", "100.127.255.254", "0.0.0.0", "0.1.2.3", "192.0.0.8", "198.18.0.1", "198.19.255.1",
      // IPv4 numbers in other notations are normalised by the URL parser.
      host("wss://0x0a.0.0.1"), host("wss://167772161"),
      // IPv4-mapped, in the dotted and the hex spelling (the URL parser turns the first into the second).
      "[::ffff:10.0.0.1]", host("wss://[::ffff:10.0.0.1]"), host("wss://[0:0:0:0:0:ffff:c0a8:1]"), "[::ffff:100.64.0.1]",
      // IPv4-compatible, NAT64 (well-known prefix to a private address, and the local-use prefix), 6to4.
      "[::10.0.0.1]", host("wss://[::192.168.0.1]"), "[64:ff9b::10.0.0.1]", host("wss://[64:ff9b::a9fe:1]"), "[64:ff9b:1::1]", "[2002:a00:1::1]",
      // Unspecified, site-local, and the full eight-group form; a zone index is ignored.
      "[::]", "[fec0::1]", "[fd00:0:0:0:0:0:0:1]", "fe80::1%eth0", "[FE80::1]",
    ];
    for (const h of nonPublic) expect(isPrivateAddress(h), h).toBe(true);
    const publicOrLoopback = [
      "100.63.255.255", "100.128.0.1", "192.0.1.1", "192.0.2.1", "198.17.0.1", "198.20.0.1", "1.0.0.1",
      "[::ffff:8.8.8.8]", host("wss://[::ffff:8.8.8.8]"), "[64:ff9b::8.8.8.8]", "[64:ff9b:2::1]", "[2002:808:808::1]", "[::8.8.8.8]",
      // A first group that only starts with the same letters is not in the range.
      "[fd::1]", "[fe8::1]", "[fc0::1]", "[2001:db8:0:0:0:0:0:1]",
      // Loopback is unchanged: a pin is not required for it (ws:// to it is handled by the URL rule).
      "127.0.0.1", "[::1]", "[::ffff:127.0.0.1]", host("wss://[::ffff:127.0.0.1]"),
    ];
    for (const h of publicOrLoopback) expect(isPrivateAddress(h), h).toBe(false);
    expect(() => checkDialable("wss://[::ffff:10.0.0.1]", undefined)).toThrow(/needs a pinned certificate/);
    expect(() => checkDialable("wss://100.64.0.1", undefined)).toThrow(/needs a pinned certificate/);
    expect(() => checkDialable("wss://[64:ff9b::10.0.0.1]", "p".repeat(43))).not.toThrow();
    expect(() => checkDialable("wss://[::ffff:127.0.0.1]", undefined)).not.toThrow();
  });
});

describe("Link", () => {
  it("ignores a hostile relay frame instead of throwing, and keeps handling later frames", async () => {
    // A value whose length cannot convert to a primitive once made parseRelayFrame throw inside
    // receive, so a hostile relay could raise an uncaught error in the client. It must be dropped.
    const { dialer, socks } = fake((sent, sock) => {
      if ((JSON.parse(sent) as { t: string }).t === "ping") {
        sock.push(JSON.stringify({ t: "deliver", cursor: 1, msg: { mesh: { valueOf: 1, toString: 1 } } }));
        sock.push(JSON.stringify({ t: "pong" }));
      }
    });
    const { link } = await Link.open(dialer, "ws://x");
    const seen: string[] = [];
    link.on((f) => seen.push(f.t));
    expect((await link.request({ t: "ping" }, (f) => f.t === "pong", 500)).t).toBe("pong");
    expect(seen).toEqual(["pong"]);
    link.close();
  });

  it("waits for hello, answers requests, ignores bad frames, and fails waiters on close", async () => {
    const { dialer, socks } = fake((sent, sock) => {
      const f = JSON.parse(sent) as { t: string };
      if (f.t === "ping") {
        sock.push("not json");
        sock.push(JSON.stringify({ t: "pong" }));
      }
    });
    const { link, hello } = await Link.open(dialer, "ws://x");
    expect(hello.nonce).toBe(NONCE);
    const seen: string[] = [];
    link.on((f) => seen.push(f.t));
    expect((await link.request({ t: "ping" }, (f) => f.t === "pong", 500)).t).toBe("pong");
    await expect(link.wait(() => false, 10)).rejects.toThrow(/did not answer/);
    const pending = link.wait(() => false, 5000);
    socks[0]!.close(4100, "bye");
    await expect(pending).rejects.toThrow(/closed the connection \(4100 bye\)/);
    expect(await link.closed).toEqual({ code: 4100, reason: "bye" });
    expect(link.isOpen).toBe(false);
    expect(() => link.send({ t: "ping" })).toThrow(/not connected/);
    await expect(link.wait(() => true, 10)).rejects.toThrow(/not connected/);
    expect(() => link.request({ t: "ping" }, () => true, 10)).toThrow(/not connected/);
    link.close();
    expect(seen).toEqual(["pong"]);
  });

  it("closes when hello never comes, and labels close reasons", async () => {
    const socks: Scripted[] = [];
    const dialer: Dialer = async () => {
      const s = new Scripted(() => undefined);
      socks.push(s);
      return s;
    };
    await expect(Link.open(dialer, "ws://x", { timeoutMs: 10 })).rejects.toThrow(/did not answer/);
    expect(socks[0]!.closedWith).toBe(1000);
    const { dialer: d2, socks: s2 } = fake();
    const { link } = await Link.open(d2, "ws://x", { tlsPin: "p" });
    s2[0]!.close(1006);
    expect(await link.closed).toEqual({ code: 1006, reason: "" });
    expect(errorFor("x")({ t: "error", code: "a", message: "m", ref: "x" } as never)).toBe(true);
    expect(new WireError("m", "c").code).toBe("c");
  });
});

function auth(hello: HelloFrame) {
  return signAuth(
    {
      relay: "ws://127.0.0.1:1",
      mesh: b64u.encode(new Uint8Array(16)),
      nonce: hello.nonce,
      at: 1,
      session: { name: "a", kind: "cli", sid: ulid(), resume: NONCE },
      pin: { seq: 1, hash: NONCE },
    },
    generateDeviceKeys(),
  );
}

const READY = (roster: unknown) => JSON.stringify({ t: "ready", sid: ulid(), name: "a", cursor: 0, roster, more: false, peers: [] });

describe("Connection", () => {
  const roster = {
    mesh: b64u.encode(new Uint8Array(16)),
    seq: 1,
    prev: null,
    devices: [],
    revoked: [],
    by: "A".repeat(22),
    at: 1,
    sig: b64u.encode(new Uint8Array(64)),
  };

  it("authenticates, replays early frames after onReady, reconnects with backoff, and stops", async () => {
    let attempt = 0;
    const { dialer, socks } = fake((sent, sock) => {
      const f = JSON.parse(sent) as { t: string };
      if (f.t === "auth") {
        sock.push(READY(roster));
        sock.push(JSON.stringify({ t: "pong" }));
      }
    });
    const frames: string[] = [];
    const logs: string[] = [];
    const readies: number[] = [];
    const conn = new Connection({
      dialer: async (url, o) => {
        attempt++;
        if (attempt === 2) throw new Error("refused");
        return dialer(url, o);
      },
      url: "ws://x",
      tlsPin: "p",
      auth,
      onReady: async () => {
        readies.push(attempt);
        await sleep(5);
      },
      onFrame: (f) => frames.push(f.t),
      onFatal: () => undefined,
      log: (l) => logs.push(l),
      baseMs: 5,
      maxMs: 20,
      random: () => 0,
    });
    expect(conn.backoff(0)).toBe(3);
    expect(conn.backoff(10)).toBe(10);
    await expect(conn.ready(5)).rejects.toThrow(/not connected/);
    conn.start();
    const link = await conn.ready(1000);
    expect(conn.current).toBe(link);
    expect(await conn.ready(1)).toBe(link);
    await until(() => frames.includes("pong"));
    socks[0]!.close(1006);
    await until(() => readies.length === 2, 2000, "reconnect");
    expect(logs.some((l) => l.includes("refused"))).toBe(true);
    await conn.ready(1000);
    conn.stop({ ended: true });
    expect(socks.at(-1)!.sent.at(-1)).toBe('{"t":"bye","ended":true}');
    conn.stop();
    expect(conn.current).toBeUndefined();
  });

  it("gives up on fatal close codes and reports refused auth", async () => {
    const { dialer, socks } = fake((sent, sock) => {
      if ((JSON.parse(sent) as { t: string }).t === "auth") {
        sock.push(JSON.stringify({ t: "error", code: "unauthorized", message: "no", ref: "auth" }));
        sock.close(4003, "unauthorized");
      }
    });
    const fatal: string[] = [];
    const logs: string[] = [];
    const conn = new Connection({ dialer, url: "ws://x", auth, onReady: async () => undefined, onFrame: () => undefined, onFatal: (r) => fatal.push(r), log: (l) => logs.push(l), baseMs: 1 });
    conn.start();
    await until(() => fatal.length === 1);
    expect(fatal[0]).toMatch(/refused this device's authentication \(unauthorized\)/);
    expect(logs.some((l) => /refused auth \(unauthorized\)/.test(l))).toBe(true);
    await expect(conn.ready(10)).rejects.toThrow(fatal[0]);
    expect(socks.length).toBe(1);
  });

  it("closes a link that stops answering pings, and stops cleanly mid-connect", async () => {
    let answered = 0;
    const { dialer, socks } = fake((sent, sock) => {
      const f = JSON.parse(sent) as { t: string };
      if (f.t === "auth") sock.push(READY(roster));
      if (f.t === "ping" && answered++ === 0) sock.push(JSON.stringify({ t: "pong" }));
    });
    const conn = new Connection({ dialer, url: "ws://x", auth, onReady: async () => undefined, onFrame: () => undefined, onFatal: () => undefined, log: () => undefined, heartbeatMs: 20, baseMs: 1000 });
    conn.start();
    await conn.ready(1000);
    await until(() => socks[0]!.closedWith === CLOSE.pingTimeout, 2000, "heartbeat close");
    conn.stop();

    const late = fake((sent, sock) => {
      if ((JSON.parse(sent) as { t: string }).t === "auth") sock.push(READY(roster));
    });
    let stopMe: () => void = () => undefined;
    const c2 = new Connection({ dialer: late.dialer, url: "ws://x", auth, onReady: async () => stopMe(), onFrame: () => undefined, onFatal: () => undefined, log: () => undefined });
    stopMe = () => c2.stop();
    c2.start();
    await until(() => late.socks[0]?.closedWith !== undefined);

    const slow = fake();
    const c3 = new Connection({ dialer: slow.dialer, url: "ws://x", auth, onReady: async () => undefined, onFrame: () => undefined, onFatal: () => undefined, log: () => undefined });
    c3.start();
    c3.stop();
    await until(() => slow.socks[0]?.closedWith !== undefined);
  });

  it("drops a link whose bye cannot be sent", async () => {
    const { dialer, socks } = fake((sent, sock) => {
      if ((JSON.parse(sent) as { t: string }).t === "auth") sock.push(READY(roster));
    });
    const conn = new Connection({ dialer, url: "ws://x", auth, onReady: async () => undefined, onFrame: () => undefined, onFatal: () => undefined, log: () => undefined });
    conn.start();
    const link = await conn.ready(1000);
    socks[0]!.send = () => {
      throw new Error("gone");
    };
    void link;
    conn.stop({ ended: false });
  });
});

describe("wsDialer", () => {
  it("talks to a plain loopback server", async () => {
    const server = createHttp();
    const wss = new WebSocketServer({ server });
    wss.on("connection", (ws) => {
      ws.send(HELLO);
      ws.send(Buffer.from("binary"), { binary: true });
      ws.on("message", (d) => ws.send(d.toString()));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const { link } = await Link.open(wsDialer, `ws://127.0.0.1:${port}`);
    expect((await link.request({ t: "pong" }, (f) => f.t === "pong", 1000)).t).toBe("pong");
    link.close();
    await link.closed;
    await expect(wsDialer(`ws://127.0.0.1:1`, {})).rejects.toThrow();
    wss.close();
    server.close();
  });

  it("checks a pinned certificate instead of the CA, and the CA without a pin", async () => {
    // Made in this process: the openssl CLI blocked a test process for about 30 s on Windows CI.
    const made = selfSignedCert(["relay.lan"], new Date());
    const cert = Buffer.from(made.cert);
    const server = createHttps({ key: made.key, cert });
    const wss = new WebSocketServer({ server });
    wss.on("connection", (ws) => ws.send(HELLO));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `wss://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pin = spkiHash(new X509Certificate(cert));
    const { link } = await Link.open(wsDialer, url, { tlsPin: pin });
    link.close();
    await expect(wsDialer(url, { tlsPin: "A".repeat(43) })).rejects.toThrow(/does not match the pin/);
    await expect(wsDialer(url, {})).rejects.toThrow(/self-signed|certificate/);
    // A socket that never presents a certificate is refused too.
    const fakeSocket = { once: (_e: string, cb: () => void) => setImmediate(cb), getPeerX509Certificate: () => undefined, destroy: vi.fn() };
    pinnedConnect("x", (() => fakeSocket) as never)({});
    await until(() => fakeSocket.destroy.mock.calls.length === 1);
    wss.close();
    server.close();
  });
});
