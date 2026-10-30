// Short invite codes (SPEC section 5): the admin device stores its sealed full code at the relay
// and prints `wim2-...`; the joiner resolves it through the relay and joins as before.

import { createInvite, formatShortCode, LIMITS, newShortKey, rdvId, sealRdv, SHORT_CODE_RELAY, type RelayFrame } from "@worldinmotion/protocol";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ClientError } from "../src/client.ts";
import { SetupError } from "../src/errors.ts";
import { runSetupEvents } from "../src/events.ts";
import { Home } from "../src/home.ts";
import { rdvUrl, resolveInvite, storeShortCode, type BoxFetcher } from "../src/shortcode.ts";
import type { Link } from "../src/wire.ts";
import { FS, makeMesh, RELAY, RelayHarness, run, said, sasOf, scratch, term, until } from "./helpers.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f().catch(() => undefined);
});

const MESH = "AAAAAAAAAAAAAAAAAAAAAA";
const full = (relay = RELAY) => createInvite({ relay, mesh: MESH, pin: { seq: 1, hash: "A".repeat(43) } }).code;

/** A fetcher that answers every URL with `status` and `body`, recording the URLs asked for. */
function answering(status: number, body: string | ((url: string) => string)): BoxFetcher & { urls: string[] } {
  const urls: string[] = [];
  const f = async (url: string) => {
    urls.push(url);
    return { status, text: async () => (typeof body === "string" ? body : body(url)) };
  };
  return Object.assign(f, { urls });
}

/** A short code whose box, sealed over `code`, the returned fetcher hands out. */
function stored(code: string, relay = RELAY): { short: string; fetcher: ReturnType<typeof answering> } {
  const k = newShortKey();
  const box = { v: 1, exp: Date.now() + 60_000, ...sealRdv(k, code) };
  return { short: formatShortCode(k, relay), fetcher: answering(200, JSON.stringify(box)) };
}

describe("resolveInvite", () => {
  it("passes a full code through, and opens a short one from its relay", async () => {
    const code = full();
    const none = answering(500, "");
    expect(await resolveInvite(code, none)).toBe(code);
    expect(none.urls).toEqual([]);
    const { short, fetcher } = stored(code);
    expect(await resolveInvite(` ${short.toLowerCase()} `, fetcher)).toBe(code);
    expect(fetcher.urls).toEqual([`http://127.0.0.1:4444/v1/rdv/${rdvId(short.slice(5, 29).replace(/-/g, ""))}`]);
    expect(rdvUrl("wss://relay.example/x", "ID")).toBe("https://relay.example/x/v1/rdv/ID");
  });

  it("refuses a mistyped short code before asking the relay", async () => {
    const f = answering(200, "");
    await expect(resolveInvite("wim2-AAAA", f)).rejects.toThrow(SetupError);
    await expect(resolveInvite("wim2-AAAA", f)).rejects.toThrow(/24 letters and digits/);
    expect(f.urls).toEqual([]);
  });

  it("says why a short code did not resolve, in the relay's terms", async () => {
    const short = formatShortCode(newShortKey(), RELAY);
    const cases: Array<[BoxFetcher, string, RegExp]> = [
      [async () => Promise.reject(new Error("ECONNREFUSED")), "unreachable", /could not read the short invite code from ws:\/\/127\.0\.0\.1:4444: ECONNREFUSED/],
      [answering(404, '{"error":"not found"}'), "not_found", /no invite under this short code/],
      [answering(429, "{}"), "limited", /too many short code lookups/],
      [answering(502, "bad gateway"), "relay_error", /not a box \(HTTP 502\)/],
      [answering(200, "x".repeat(16 * 1024 + 1)), "relay_error", /not a box \(HTTP 200\)/],
      [answering(200, "not json"), "rdv_malformed", /does not open \(rdv_malformed\)/],
      [answering(200, JSON.stringify({ v: 1, exp: 1, ...sealRdv(newShortKey(), full()) })), "rdv_wrong_id", /rdv_wrong_id/],
    ];
    for (const [fetcher, code, message] of cases) {
      const error = (await resolveInvite(short, fetcher).catch((e: unknown) => e)) as ClientError;
      expect(error, code).toBeInstanceOf(ClientError);
      expect([error.code, error.message], code).toEqual([code, expect.stringMatching(message)]);
    }
  });

  it("refuses a box that holds no invite, or one for another relay than the code names", async () => {
    const bad = stored("not an invite");
    await expect(resolveInvite(bad.short, bad.fetcher)).rejects.toThrow(/invalid invite code/);
    const elsewhere = stored(full("wss://other.example"));
    await expect(resolveInvite(elsewhere.short, elsewhere.fetcher)).rejects.toMatchObject({ code: "wrong_relay" });
    // The host part is compared without case.
    const hosted = full(SHORT_CODE_RELAY);
    const k = newShortKey();
    const box = JSON.stringify({ v: 1, exp: 1, ...sealRdv(k, hosted) });
    expect(await resolveInvite(`${formatShortCode(k, SHORT_CODE_RELAY)}@WORLDINMOTION.distronode.com`, answering(200, box))).toBe(hosted);
  });
});

describe("storeShortCode", () => {
  const link = (answer: RelayFrame | Error): Link & { sent: Record<string, unknown>[] } => {
    const sent: Record<string, unknown>[] = [];
    return {
      sent,
      request: async (frame: Record<string, unknown>) => {
        sent.push(frame);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    } as unknown as Link & { sent: Record<string, unknown>[] };
  };

  it("stores the box until the invite's expiry or an hour, whichever is first", async () => {
    const now = 1_760_000_000_000;
    const stored = link({ t: "rdv.stored", rdv: "x" } as RelayFrame);
    const made = await storeShortCode(stored, RELAY, full(), now + 10 * 60_000, now);
    expect(made).toEqual({ short: { code: expect.stringMatching(/^wim2-(?:[0-9A-Z]{4}-){5}[0-9A-Z]{4}@ws:\/\/127\.0\.0\.1:4444$/), exp: now + 10 * 60_000 } });
    expect(stored.sent[0]).toMatchObject({ t: "rdv.put", exp: now + 10 * 60_000 });
    const long = link({ t: "rdv.stored", rdv: "x" } as RelayFrame);
    expect(await storeShortCode(long, RELAY, full(), now + 7 * 86_400_000, now)).toMatchObject({ short: { exp: now + LIMITS.rdvLifetimeMs } });
  });

  it("gives the reason instead when the relay keeps no short codes, refuses one, or does not answer", async () => {
    const error = (code: string, message = "m") => link({ t: "error", code, message, ref: "rdv.put" } as RelayFrame);
    expect(await storeShortCode(error("unknown_type"), RELAY, full(), 2, 1)).toEqual({ shortRefused: "this relay does not keep short codes" });
    expect(await storeShortCode(error("unsupported"), RELAY, full(), 2, 1)).toEqual({ shortRefused: "this relay does not keep short codes" });
    expect(await storeShortCode(error("full", "this relay holds as many short invite codes as it can"), RELAY, full(), 2, 1)).toEqual({
      shortRefused: "the relay refused it: this relay holds as many short invite codes as it can",
    });
    expect(await storeShortCode(link(new Error("timed out")), RELAY, full(), 2, 1)).toEqual({ shortRefused: "the relay did not store it (timed out)" });
  });
});

describe("wim invite and wim join with a short code", () => {
  it("prints a short code the new device joins with, and the full code with --full", async () => {
    const relay = new RelayHarness({ rdv: true });
    const a = term(await scratch("sc-a"), relay);
    expect(await run(a, "init", "--name", "laptop", "--relay", RELAY, "--no-recovery")).toBe(0);
    const b = term(await scratch("sc-b"), relay, { fetch: relay.fetch });
    a.answers.push(() => sasOf(b));
    const inviting = run(a, "invite");
    await until(() => a.out.some((l) => l.includes("wim2-")));
    const short = /wim2-\S+/.exec(said(a))![0];
    expect(said(a)).not.toMatch(/wim1_/);
    expect(said(a)).toContain("A device on wim 0.1.5 or older needs a full code: `wim invite --full`.");
    expect(said(a)).not.toContain("The short code works until");
    expect(await run(b, "join", short, "--name", "server")).toBe(0);
    expect(await inviting).toBe(0);
    expect(said(b)).toMatch(/Joined mesh/);

    // --full: no box at the relay, and the full code.
    const c = term(await scratch("sc-c"), relay);
    a.answers.push(() => sasOf(c));
    const sent = relay.sentByClients.length;
    a.out.length = 0;
    const again = run(a, "invite", "--full");
    await until(() => a.out.some((l) => l.includes("wim1_")));
    expect(said(a)).not.toMatch(/wim2-|short code/);
    expect(relay.sentByClients.slice(sent).some((t) => t.includes('"rdv.put"'))).toBe(false);
    expect(await run(c, "join", /wim1_\S+/.exec(said(a))![0], "--name", "box")).toBe(0);
    expect(await again).toBe(0);
  }, 20_000);

  it("says when the short code ends before the invite, and refuses a short code nobody stored", async () => {
    const relay = new RelayHarness({ rdv: true });
    const a = term(await scratch("sc-long"), relay);
    expect(await run(a, "init", "--name", "laptop", "--relay", RELAY, "--no-recovery")).toBe(0);
    const stop = run(a, "invite", "--exp", "2h");
    await until(() => a.out.some((l) => l.includes("wim2-")));
    expect(said(a)).toMatch(/The short code works until \S+Z\./);
    a.stop.abort();
    expect(await stop).toBe(1);
    const b = term(await scratch("sc-none"), relay, { fetch: relay.fetch });
    expect(await run(b, "join", formatShortCode(newShortKey(), RELAY))).toBe(1);
    expect(said(b)).toMatch(/no invite under this short code/);
    // Nothing was made on the device for a code that did not resolve.
    expect(said(b)).not.toMatch(/This device is/);
    expect(await run(b, "join", "wim2-nope")).toBe(1);
    expect(said(b)).toMatch(/24 letters and digits/);
  }, 20_000);

  it("prints the full code with the reason on a relay that keeps no short codes", async () => {
    const relay = new RelayHarness();
    const a = term(await scratch("sc-old"), relay);
    expect(await run(a, "init", "--name", "laptop", "--relay", RELAY, "--no-recovery")).toBe(0);
    const stop = run(a, "invite");
    await until(() => a.out.some((l) => l.includes("wim1_")));
    expect(said(a)).toContain("This is the full code: no short code, because this relay does not keep short codes.");
    a.stop.abort();
    await stop;
  });
});

describe("wim events with a short code", () => {
  it("answers invite with the short code and the full one, and joins in setup mode with the short code", async () => {
    const relay = new RelayHarness({ rdv: true });
    const { mesh, devices } = await makeMesh(relay, ["admin"]);
    const { MeshSession } = await import("../src/client.ts");
    const { sessionOpts } = await import("./helpers.ts");
    const { runEvents } = await import("../src/events.ts");
    const { MeshFiles } = await import("../src/mesh.ts");
    const { admitPending } = await import("../src/admin.ts");
    const admin = await MeshSession.open({ ...sessionOpts(devices[0]!, mesh, relay, { name: "vscode", kind: "vscode" }), sessionKey: "events:vscode" });
    const lines: Record<string, any>[] = [];
    const input = new PassThrough();
    const stop = new AbortController();
    const running = runEvents({ session: admin, mesh: new MeshFiles(devices[0]!.home.meshDir(mesh), FS), env: FS, device: devices[0]!.device, version: "t", write: (l) => void lines.push(JSON.parse(l)), input, signal: stop.signal, now: Date.now, pollMs: 20, leasePollMs: 1000 });
    cleanup.push(async () => {
      stop.abort();
      await running;
      await admin.stop();
    });
    const ask = async (into: PassThrough, out: Record<string, any>[], id: string, op: string, args?: object) => {
      into.write(`${JSON.stringify({ v: 1, id, op, ...(args === undefined ? {} : { args }) })}\n`);
      await until(() => out.some((l) => l["type"] === "response" && l["id"] === id), 5000, `response ${id}`);
      return out.find((l) => l["type"] === "response" && l["id"] === id)!;
    };
    await until(() => lines.some((l) => l["type"] === "snapshot"));
    const made = await ask(input, lines, "i1", "invite", { exp: 7_200_000 });
    expect(made).toMatchObject({ ok: true, result: { code: expect.stringMatching(/^wim2-/), full: expect.stringMatching(/^wim1_/) } });
    const result = made["result"] as { code: string; exp: number };
    expect(result.exp).toBeLessThanOrEqual(Date.now() + LIMITS.rdvLifetimeMs);

    const home = new Home(await scratch("sc-setup"), { ...FS, uid: process.getuid?.() });
    const out: Record<string, any>[] = [];
    const setupIn = new PassThrough();
    const setupStop = new AbortController();
    const setup = runSetupEvents({ home, defaultName: "fresh", dialer: relay.dialer, version: "t", write: (l) => void out.push(JSON.parse(l)), input: setupIn, signal: setupStop.signal, now: Date.now, fetch: relay.fetch });
    cleanup.push(async () => {
      setupStop.abort();
      await setup;
    });
    // A mistyped short code is the person's input; one nobody stored is the relay's answer.
    expect(await ask(setupIn, out, "s1", "join", { code: "wim2-ABCD" })).toMatchObject({ ok: false, error: { code: "input", message: expect.stringMatching(/24 letters/) } });
    expect(await ask(setupIn, out, "s2", "join", { code: formatShortCode(newShortKey(), RELAY) })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/no invite under this short code/) } });
    expect(await home.loadDevice()).toBeUndefined();
    const joined = await ask(setupIn, out, "s3", "join", { code: result.code });
    expect(joined).toMatchObject({ ok: true, result: { device: { name: "fresh" } } });
    await admin.listPeers();
    await admin.settled();
    await admitPending(admin, "fresh", (joined["result"] as { code: string }).code, Date.now);
    await setup;
    expect(out.some((l) => l["type"] === "joined")).toBe(true);
  }, 20_000);
});
