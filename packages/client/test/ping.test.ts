// `wim ping` (SPEC section 12): the receiving client answers a ping itself with a pong, never an
// agent; nothing is spooled, kept in history or receipted; refused devices get no answer and the
// budget bounds how many pongs a device can draw.

import { afterEach, describe, expect, it } from "vitest";
import { ClientError, MeshSession } from "../src/client.ts";
import { setDevicePolicy } from "../src/mesh.ts";
import { PING, pingReport, PongBudget } from "../src/ping.ts";
import { makeMesh, openSession, RelayHarness, run, said, sleep, term, until } from "./helpers.ts";

const open: MeshSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

async function session(...args: Parameters<typeof openSession>): Promise<MeshSession> {
  const s = await openSession(...args);
  open.push(s);
  return s;
}

/** The send frames clients gave the relay (cards, in `card.set`, are not among them). */
function sendsOf(relay: RelayHarness): string[] {
  return relay.sentByClients.filter((t) => t.startsWith('{"t":"send"'));
}

describe("the pong budget", () => {
  it("answers a fresh ping, and refuses stale ones and floods per device and in total", () => {
    const b = new PongBudget();
    const t = 1_000_000;
    expect(b.allow("d1", t - PING.freshMs - 1, t)).toBe(false);
    for (let i = 0; i < PING.perDevicePerMinute; i++) expect(b.allow("d1", t, t)).toBe(true);
    expect(b.allow("d1", t, t)).toBe(false);
    // A minute later the device has its budget back.
    expect(b.allow("d1", t + 60_000, t + 60_000)).toBe(true);
    // The total over every device.
    const total = new PongBudget();
    for (let i = 0; i < PING.perSessionPerMinute; i++) expect(total.allow(`d${i % 20}`, t, t)).toBe(true);
    expect(total.allow("fresh", t, t)).toBe(false);
  });
});

describe("the ping report", () => {
  it("prints a row per session and a verdict per device", () => {
    const lines = pingReport(
      [
        { to: "cli@desk", status: "routed", ms: 42 },
        { to: "agent@desk", status: "routed" },
        { to: "bot@server", status: "queued" },
        { to: "x@server", status: "offline" },
        { to: "ghost@nowhere", status: "unknown" },
      ],
      "ping@laptop",
      2000,
    );
    expect(lines[0]).toBe("Pinged from ping@laptop:");
    expect(lines).toContain("  cli@desk       pong in 42 ms");
    expect(lines.join("\n")).toMatch(/agent@desk {5}no pong in 2 s \(an older client/);
    expect(lines.join("\n")).toMatch(/bot@server {5}offline: the relay queued it/);
    expect(lines.join("\n")).toMatch(/x@server {7}offline, not pinged/);
    expect(lines.join("\n")).toMatch(/ghost@nowhere {2}unknown/);
    expect(lines).toContain("  desk     both directions ok (1 of 2 answered)");
    expect(lines).toContain("  server   no answer");
    expect(lines).toContain("  nowhere  no answer");
  });
});

describe("ping and pong", () => {
  it("is answered by the client itself: a round trip both ways, nothing spooled, kept or receipted", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"], { trust: false });
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const b2 = await session(devices[1]!, mesh, relay, { name: "b2" });
    const sibling = await session(devices[0]!, mesh, relay, { name: "a2" });
    const rows = await a.ping(["b@two", "b2@two", "a2@one"], 3000);
    expect(rows.map((r) => [r.to, r.status, typeof r.ms])).toEqual([
      ["b@two", "routed", "number"],
      ["b2@two", "routed", "number"],
      ["a2@one", "routed", "number"],
    ]);
    await sleep(50);
    // Held devices answer too (a ping shows only that a session is online), and nothing reached the agents.
    for (const s of [b, b2, sibling]) {
      expect(await s.spool.unread()).toEqual([]);
      expect(await s.held.list()).toEqual([]);
      expect(await s.history.query({ limit: 10 })).toEqual([]);
    }
    expect(await a.history.query({ limit: 10 })).toEqual([]);
    expect(relay.sentByClients.some((t) => t.includes('"t":"receipt"'))).toBe(false);
    // A ping names sessions only.
    await expect(a.ping("*", 100)).rejects.toThrow(ClientError);
    await expect(a.ping("#room", 100)).rejects.toThrow(/never \* or a room/);
    // An address no roster device answers to is not sent at all.
    const before = sendsOf(relay).length;
    expect(await a.ping("x@nowhere", 100)).toEqual([{ to: "x@nowhere", status: "unknown" }]);
    expect(sendsOf(relay).length).toBe(before);
  }, 20_000);

  it("gets no pong from a device the person refuses, from an older client, or for a stale ping", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"], { trust: false });
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    await setDevicePolicy(b.mesh, devices[0]!.device.id, "refuse");
    expect(await a.ping("b@two", 150)).toEqual([{ to: "b@two", status: "routed" }]);
    // An older client drops the unknown kind: no pong. Here its deliveries never arrive.
    const c = await session(devices[2]!, mesh, relay, { name: "c" });
    relay.toClient = (text) => (text.includes('"t":"deliver"') && text.includes('"to":["c@three"]') ? undefined : text);
    expect(await a.ping("c@three", 150)).toEqual([{ to: "c@three", status: "routed" }]);
    relay.toClient = undefined;
    await c.stop();
    // A receiver whose clock runs a minute and more ahead reads the ping as stale.
    const late = await session(devices[2]!, mesh, relay, { name: "late", now: () => Date.now() + PING.freshMs + 1000 });
    expect(await a.ping("late@three", 150)).toEqual([{ to: "late@three", status: "routed" }]);
    await sleep(30);
    expect(await late.spool.unread()).toEqual([]);
  }, 20_000);

  it("takes only pongs from the sessions it pinged, once each, and logs a pong it could not send", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const lines: string[] = [];
    await session(devices[1]!, mesh, relay, { name: "b", answerMs: 100, log: (l) => void lines.push(l) });
    await session(devices[1]!, mesh, relay, { name: "other" });
    const third = await session(devices[1]!, mesh, relay, { name: "third" });
    const postAs = (s: MeshSession) => (s as unknown as { post: (to: string, text: undefined, o: object) => Promise<unknown> }).post.bind(s);
    // b's pong never reaches the relay.
    relay.toRelay = (text) => (text.startsWith('{"t":"send"') && text.includes('"session":"b"') ? undefined : text);
    // No time budget: the wait ends as soon as the relay has answered. The ping's pong waiter is in
    // place before ping() first awaits, so the pongs are fed to it by hand before the ping is even
    // sent: other's, then other's again and one from third (never pinged), both dropped.
    const pinging = a.ping(["b@two", "other@two"], 0);
    const waiters = (a as unknown as { pongWaiters: Map<string, (device: string, session: string) => void> }).pongWaiters;
    const [id, pong] = [...waiters][0]!;
    const two = devices[1]!.device.id;
    pong(two, "other");
    pong(two, "other");
    pong(two, "third");
    const rows = await pinging;
    expect(rows[0]).toEqual({ to: "b@two", status: "routed" });
    expect(rows[1]).toMatchObject({ to: "other@two", status: "routed", ms: expect.any(Number) });
    expect(waiters.has(id)).toBe(false);
    // A pong for no ping at all is dropped too. a handles what arrives in order, so once the
    // message third sends after it is in a's spool, the pong has been handled.
    await postAs(third)("a@one", undefined, { kind: "pong", reply_to: "01K70000000000000000000B02" });
    await third.send("a@one", "after the stray pong");
    await until(async () => (await a.spool.unread()).some((i) => i.rendered.includes("after the stray pong")));
    await until(() => lines.some((l) => l.startsWith("wim: no pong sent to a@one")));
    relay.toRelay = undefined;
  }, 20_000);
});

describe("wim ping", () => {
  it("pings every live session, or the ones named, and prints the report", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const t = term(devices[0]!.root, relay);
    expect(await run(t, "ping")).toBe(1);
    expect(said(t)).toMatch(/usage: wim ping/);
    expect(await run(t, "ping", "b@two", "--all")).toBe(1);
    expect(await run(t, "ping", "--all", "--timeout", "3s")).toBe(0);
    expect(said(t)).toMatch(/b@two +pong in \d+ ms/);
    expect(said(t)).toMatch(/two +both directions ok \(1 of 1 answered\)/);
    t.out.length = 0;
    // An offline session is listed, not pinged.
    await b.stop();
    open.splice(open.indexOf(b), 1);
    expect(await run(t, "ping", "b@two", "--timeout", "200")).toBe(1);
    expect(said(t)).toMatch(/b@two +offline, not pinged/);
    t.out.length = 0;
    expect(await run(t, "ping", "--all")).toBe(0);
    expect(said(t)).toMatch(/No other live sessions to ping/);
    t.out.length = 0;
    expect(await run(t, "ping", "x@two,*")).toBe(1);
    expect(said(t)).toMatch(/never \* or a room/);
    expect(await run(t, "help", "ping")).toBe(0);
    expect(said(t)).toMatch(/wim ping <address,...> \| --all/);
  }, 30_000);
});
