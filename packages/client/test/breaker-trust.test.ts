// The loop breaker by trust (issue #59): a trusted peer's pause is a cool-down the client ends by
// itself, the pause shows in `wim held list`, the pane and the events feed with the rule and when
// it ends, the sending side hears it through a `pause` (SPEC section 12) so its sends report
// `held`, and the person can approve one item and resume its device in one step. Nothing an agent
// or a peer can reach approves or resumes anything (#54).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { ulid, type PauseInfo } from "@worldinmotion/protocol";
import { promises as fs, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clock } from "../src/breaker.ts";
import { MeshSession } from "../src/client.ts";
import { HeldBox } from "../src/held.ts";
import { INTERNAL_OPS, PUBLIC_TOOLS, WimMcp } from "../src/mcp.ts";
import { MeshFiles, type BreakerLimits } from "../src/mesh.ts";
import { listAllPauses, PausedBy, readBreakerFile, readPauses, savePauses, SentTo, type PauseRow } from "../src/pauses.ts";
import type { SpoolItem } from "../src/spool.ts";
import { FS, makeMesh, openSession, RelayHarness, run, said, scratch, sessionOpts, spooled, term, until, type TestDevice } from "./helpers.ts";

const open: MeshSession[] = [];
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f().catch(() => undefined);
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

async function session(...args: Parameters<typeof openSession>): Promise<MeshSession> {
  const s = await openSession(...args);
  open.push(s);
  return s;
}

const unread = (s: MeshSession): Promise<SpoolItem[]> => s.spool.unread();
const msgs = async (s: MeshSession): Promise<string[]> => (await unread(s)).filter((i) => i.kind === "msg").map((i) => /\n(\d+)\n/.exec(i.rendered)?.[1] ?? "?");

/** Limits that trip on the second message an hour, with a cool-down of `minutes`. */
function trustedTrip(minutes: number): BreakerLimits {
  return { perPeerPerHour: 1, totalPerHour: 50, pingPong: false, pingPongExchanges: 8, cooldownMinutes: minutes };
}

async function setBreaker(d: TestDevice, mesh: string, breaker: BreakerLimits): Promise<void> {
  await new MeshFiles(d.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, breaker }));
}

async function setPolicy(d: TestDevice, mesh: string, device: string, level: "deliver" | "hold" | "refuse"): Promise<void> {
  await new MeshFiles(d.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, policy: { ...c.policy, [device]: level } }));
}

/** Sends a `pause` from `s` as its client would (tests forge what a peer's client could send). */
function forgePause(s: MeshSession, to: string, pause: PauseInfo): void {
  void (s as unknown as { post(to: string, text: undefined, o: { kind: "pause"; pause: PauseInfo }): Promise<unknown> }).post(to, undefined, { kind: "pause", pause });
}

/**
 * Resolves once `to` has handled everything `from` sent it so far: a later message from the same
 * session (frames from one session are handled in order) has arrived, delivered, held or refused.
 */
async function handled(from: MeshSession, to: MeshSession, address: string): Promise<void> {
  const out = await from.send(address, "after");
  await until(
    async () => (from.receipts.get(out.id) ?? []).some((r) => r.status === "refused") || (await to.spool.unread()).some((i) => i.id === out.id) || (await to.held.list()).some((h) => h.id === out.id),
    10_000,
  );
}

/** Two trusted devices, with `b@two` tripping on `a@one`'s second message and a clock it can move. */
async function pair(minutes = 1) {
  const relay = new RelayHarness();
  const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
  await setBreaker(devices[1]!, mesh, trustedTrip(minutes));
  const clocks = { a: 0, b: 0 };
  const a = await session(devices[0]!, mesh, relay, { name: "a", now: () => Date.now() + clocks.a });
  const b = await session(devices[1]!, mesh, relay, { name: "b", now: () => Date.now() + clocks.b });
  return { relay, mesh, devices, clocks, a, b };
}

describe("a trusted peer's cool-down", () => {
  it("ends by itself: up to the per-peer limit of what it held is delivered, the rest and a second trip wait for the person", async () => {
    const { a, b, clocks } = await pair(1);
    const resumed: unknown[] = [];
    b.on("breaker", (e: { state: string }) => void (e.state === "resumed" && resumed.push(e)));
    for (const t of ["1", "2", "3"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 2);
    const first = (await b.held.list())[0]!.pause!;
    expect(first).toMatchObject({ rule: "peer", count: 2, limit: 1, minutes: 60, auto: true });
    expect(first.until - (await b.held.list())[0]!.at).toBeLessThanOrEqual(61_000);
    expect(await msgs(b)).toEqual(["1"]);
    // The cool-down ends: the next housekeeping pass releases the peer and delivers what it held,
    // at most the per-peer limit (1 here), oldest first; the rest waits for the person, as in 0.1.8.
    clocks.b += 61_000;
    const told = await spooled(b, (i) => i.kind === "notice" && i.rendered.includes("cool-down for a@one ended"));
    expect(told.rendered).toContain(
      `the loop breaker's cool-down for a@one ended at ${clock(first.until)} (it tripped on the per-peer limit: 2 messages from a@one in 60 minutes, limit 1): its messages are delivered again, and 1 message it held is delivered now; 1 message more stays held for the person (a release delivers at most the per-peer limit, and no more than is left under the total).`,
    );
    expect(await msgs(b)).toEqual(["1", "2"]);
    expect((await b.held.list()).map((h) => h.entry.text)).toEqual(["3"]);
    expect(resumed).toEqual([{ peer: "a@one", state: "resumed", auto: true }]);
    expect(await readPauses(b.files.breakerPath, Number.NEGATIVE_INFINITY)).toEqual([]);
    // Its deliveries stay counted through the release, and what it released counts too (1 + 1), so
    // the next message trips again, within the hour of the release: paused for the hour, and it
    // waits for the person.
    await a.send("b@two", "4");
    await until(async () => (await b.held.list()).length === 2);
    expect((await b.held.list())[1]!.pause).toMatchObject({ auto: false });
    const again = await spooled(b, (i) => i.kind === "notice" && i.rendered.includes("what it held waits for the person"));
    expect(again.rendered).toContain("worldinmotion paused a@one: the per-peer limit: 3 messages from a@one in 60 minutes, limit 1; until ");
    clocks.b += 120_000;
    await new Promise((r) => setTimeout(r, 100));
    expect(await b.held.list()).toHaveLength(2);
  }, 30_000);

  it("carries on across a restart of the holding session: the pause, its release, and who hears it lifted", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, trustedTrip(1));
    let offset = 0;
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const holder = { name: "b", sessionKey: "key:b", now: () => Date.now() + offset };
    let b = await session(devices[1]!, mesh, relay, holder);
    for (const t of ["1", "2"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 1);
    await until(async () => Object.keys(await a.pausedBy.active()).length === 1);
    const before = b.pausedRows();
    const sid = b.sid;
    expect(before).toEqual([expect.objectContaining({ from: "a@one", told: ["a@one"], auto: true })]);
    // The session restarts (same session, same files): the pause is taken back as it was.
    await b.stop();
    b = await session(devices[1]!, mesh, relay, holder);
    expect(b.sid).toBe(sid);
    expect(b.pausedRows()).toEqual(before);
    // Its cool-down ends while a process that never runs a pass has the session: the ended pause
    // stays written for the next one, which releases it.
    await b.stop();
    offset += 61_000;
    b = await session(devices[1]!, mesh, relay, { ...holder, tickMs: 3_600_000 });
    expect(b.pausedRows()).toEqual([]);
    expect(await readPauses(b.files.breakerPath, Number.NEGATIVE_INFINITY)).toEqual(before);
    expect(await b.held.list()).toHaveLength(1);
    await b.stop();
    b = await session(devices[1]!, mesh, relay, holder);
    await until(async () => (await b.held.list()).length === 0);
    await until(async () => (await msgs(b)).length === 2);
    expect(b.pausedRows()).toEqual([]);
  }, 30_000);

  it("tells the sessions told before a restart when the person lifts the pause after it", async () => {
    const { a, devices, mesh, relay } = await pair(60);
    await setBreaker(devices[1]!, mesh, trustedTrip(60));
    const holder = { name: "c", sessionKey: "key:c" };
    let c = await session(devices[1]!, mesh, relay, holder);
    for (const t of ["1", "2"]) await a.send("c@two", t);
    await until(async () => Object.keys(await a.pausedBy.active()).length === 1);
    await c.stop();
    c = await session(devices[1]!, mesh, relay, holder);
    await c.resumePeer("a@one");
    await until(async () => Object.keys(await a.pausedBy.active()).length === 0);
  }, 30_000);

  it("keeps reporting held when the person there approves one message alone", async () => {
    const { a, b } = await pair(60);
    for (const t of ["1", "2", "3"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 2);
    await until(async () => Object.keys(await a.pausedBy.active()).length === 1);
    const [one] = await b.held.list();
    await b.decide(one!.id, "approve");
    const item = (await unread(b)).find((i) => i.id === one!.id)!;
    await b.take(item.cursor);
    // Its delivered receipt comes back, and the pause there still runs: sends still say held.
    await until(() => (a.receipts.get(one!.id) ?? []).some((r) => r.status === "delivered"));
    await new Promise((r) => setTimeout(r, 200));
    expect(Object.keys(await a.pausedBy.active())).toHaveLength(1);
    expect((await a.send("b@two", "4")).results[0]!.status).toBe("held");
  }, 30_000);

  it("keeps what it held for the person when the device is no longer trusted at the end", async () => {
    const { a, b, clocks, devices, mesh } = await pair(1);
    for (const t of ["1", "2"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 1);
    await setPolicy(devices[1]!, mesh, devices[0]!.device.id, "hold");
    // Held by policy now: the release passes it by, as it does any hold that is not the breaker's.
    await a.send("b@two", "3");
    await until(async () => (await b.held.list()).length === 2);
    clocks.b += 61_000;
    const told = await spooled(b, (i) => i.kind === "notice" && i.rendered.includes("cool-down for a@one ended"));
    expect(told.rendered).toContain("nothing it held is delivered; its device is no longer trusted here or no longer in the mesh, so the 1 message it held stays held for the person");
    expect((await b.held.list()).map((h) => h.reason)).toEqual(["breaker", "policy"]);
    expect(b.pausedRows()).toEqual([]);
  }, 30_000);

  it("logs a release that fails, and lifts the pause all the same", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, trustedTrip(1));
    let offset = 0;
    const lines: string[] = [];
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b", now: () => Date.now() + offset, log: (l) => void lines.push(l) });
    for (const t of ["1", "2"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 1);
    // mesh.json cannot be read when the cool-down ends: the release fails, and is logged.
    const config = new MeshFiles(devices[1]!.home.meshDir(mesh), FS).configPath;
    const kept = await fs.readFile(config, "utf8");
    await fs.writeFile(config, "{ broken");
    offset += 61_000;
    await until(() => lines.some((l) => l.startsWith("wim: housekeeping:")));
    await fs.writeFile(config, kept);
    expect(b.pausedRows()).toEqual([]);
    expect((await b.held.list()).map((h) => h.reason)).toEqual(["breaker"]);
  }, 30_000);
});

describe("an older mesh.json", () => {
  it("with a 0.1.9 draft's `trusted` block, unknown keys and lowered limits loads, applies the lowered limits, logs nothing, and keeps them when rewritten", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const files = new MeshFiles(devices[1]!.home.meshDir(mesh), FS);
    // Written by hand, as a person or a draft build left it.
    const raw = JSON.parse(await fs.readFile(files.configPath, "utf8")) as Record<string, unknown>;
    raw["breaker"] = { perPeerPerHour: 2, totalPerHour: 60, pingPong: true, pingPongExchanges: 8, perPeerPerMinute: 1, trusted: { perPeerPerHour: 120, totalPerHour: 300, pingPong: true, pingPongExchanges: 32, cooldownMinutes: 60 } };
    await fs.writeFile(files.configPath, JSON.stringify(raw));
    const lines: string[] = [];
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b", log: (l) => void lines.push(l) });
    for (const t of ["1", "2", "3"]) await a.send("b@two", t);
    // The lowered per-peer limit, 2, is the one that applies; the draft's 120 is not.
    await until(async () => (await b.held.list()).length === 1);
    expect(await msgs(b)).toEqual(["1", "2"]);
    expect((await b.held.list())[0]!.pause).toMatchObject({ rule: "peer", limit: 2, auto: true });
    expect(lines.filter((l) => /breaker|mesh\.json|refus|invalid|malformed/i.test(l))).toEqual([]);
    // A later write of mesh.json (trusting a device here) keeps the person's values.
    await files.updateConfig((c) => ({ ...c, policy: { ...c.policy, extra: "hold" } }));
    const after = (await files.loadConfig()).breaker;
    expect(after).toEqual({ perPeerPerHour: 2, totalPerHour: 60, pingPong: true, pingPongExchanges: 8, cooldownMinutes: 60 });
    expect((JSON.parse(await fs.readFile(files.configPath, "utf8")) as { breaker: unknown }).breaker).toEqual(after);
  }, 30_000);
});

describe("the sending side", () => {
  it("reports the send that trips the pause as the relay's routed, while the receiver holds that very message and says so for its id", async () => {
    const { a, b, devices } = await pair(60);
    // What b's client sends of its own: the pause, and what it names.
    const posts: Array<{ to: string; kind?: string; reply_to?: string }> = [];
    const inner = b as unknown as { post(to: string, text: undefined, o: { kind?: string; reply_to?: string }): Promise<unknown> };
    const post = inner.post.bind(b);
    inner.post = (to, text, o) => {
      posts.push({ to, ...(o.kind === undefined ? {} : { kind: o.kind }), ...(o.reply_to === undefined ? {} : { reply_to: o.reply_to }) });
      return post(to, text, o);
    };
    expect((await a.send("b@two", "0")).results).toEqual([{ to: "b@two", status: "routed" }]);
    // The second trips b's breaker (one an hour). The relay answers before b opens it, so this send
    // reports what the relay did with it, and nothing on a's side can know yet that b holds it.
    const tripping = await a.send("b@two", "1");
    expect(tripping.results).toEqual([{ to: "b@two", status: "routed" }]);
    // b holds the tripping message itself: it is not delivered and counted as the last one allowed.
    await until(async () => (await b.held.list()).length === 1);
    expect((await b.held.list()).map((h) => [h.id, h.reason])).toEqual([[tripping.id, "breaker"]]);
    expect(await msgs(b)).toEqual(["0"]);
    // a learns it for that id: the held receipt, and the pause, whose reply_to names it.
    await until(() => (a.receipts.get(tripping.id) ?? []).some((r) => r.status === "held"));
    await spooled(a, (i) => i.kind === "notice" && i.rendered.includes(`b@two is holding your message ${tripping.id}: it is not delivered now.`));
    await until(() => posts.some((p) => p.kind === "pause"));
    expect(posts.filter((p) => p.kind === "pause")).toEqual([{ to: "a@one", kind: "pause", reply_to: tripping.id }]);
    // From then on a's sends there report held.
    await until(async () => (await a.pausedBy.active())[`${devices[1]!.device.id}/b`] !== undefined);
    expect((await a.send("b@two", "2")).results).toEqual([{ to: "b@two", status: "held", relay: "routed", breaker: expect.objectContaining({ rule: "peer", count: 2, limit: 1 }) }]);
    // Two sessions and a relay, like every other test here that has them, so their budget: it was
    // the only one at the 5 s default, which a full suite's load can use up. Every wait is on state.
  }, 30_000);

  it("hears the pause once a session, reports held, and takes a pause only as a label from a session it sent to", async () => {
    const { a, b, clocks, devices, mesh } = await pair(60);
    // Nothing was sent to b yet: a pause from it counts for nothing.
    forgePause(b, "a@one", { state: "paused", rule: "peer", count: 2, limit: 1, minutes: 60, until: Date.now() + 600_000, auto: true });
    await handled(b, a, "a@one");
    expect(await a.pausedBy.active()).toEqual({});
    // Sent to: now it counts, and the agent is told once.
    await a.send("b@two", "0");
    await a.send("b@two", "1");
    await until(async () => (await b.held.list()).length === 1);
    const pairKey = `${devices[1]!.device.id}/b`;
    await until(async () => (await a.pausedBy.active())[pairKey] !== undefined);
    const notices = async (): Promise<number> => (await unread(a)).filter((i) => i.kind === "notice" && i.rendered.includes("loop breaker paused messages from this device")).length;
    await until(async () => (await notices()) === 1);
    expect((await a.send("b@two", "2")).results).toEqual([{ to: "b@two", status: "held", relay: "routed", breaker: expect.objectContaining({ rule: "peer", auto: true }) }]);
    // A second pause from it within 10 minutes is recorded but not told again; after 10 minutes it is.
    forgePause(b, "a@one", { state: "paused", rule: "total", count: 51, limit: 50, minutes: 60, until: Date.now() + 1_200_000, auto: false });
    await until(async () => (await a.pausedBy.active())[pairKey]?.rule === "total");
    expect(await notices()).toBe(1);
    clocks.a += 11 * 60_000;
    forgePause(b, "a@one", { state: "paused", rule: "pingpong", count: 9, limit: 8, minutes: 10, until: Date.now() + 1_200_000, auto: false });
    await until(async () => (await notices()) === 2);
    expect((await unread(a)).filter((i) => i.kind === "notice").at(-1)!.rendered).toContain("until its person releases them; the pause itself lifts at");
    // Lifted: sends there are routed again.
    forgePause(b, "a@one", { state: "lifted" });
    await until(async () => Object.keys(await a.pausedBy.active()).length === 0);
    // From a device this one refuses, or an hour after this device last sent there: not taken.
    await setPolicy(devices[0]!, mesh, devices[1]!.device.id, "refuse");
    forgePause(b, "a@one", { state: "paused", rule: "peer", count: 2, limit: 1, minutes: 60, until: Date.now() + 1_200_000, auto: false });
    // A message b sends after it comes after it (one sender session's order): once a has refused
    // that one, it has handled the pause too, whatever the runner's speed.
    const after = await b.send("a@one", "after");
    await until(() => (b.receipts.get(after.id) ?? []).some((r) => r.status === "refused"), 10_000);
    expect(await a.pausedBy.active()).toEqual({});
    await setPolicy(devices[0]!, mesh, devices[1]!.device.id, "deliver");
    clocks.a += 60 * 60_000;
    forgePause(b, "a@one", { state: "paused", rule: "peer", count: 2, limit: 1, minutes: 60, until: Date.now() + 1_200_000, auto: false });
    await handled(b, a, "a@one");
    expect(await a.pausedBy.active()).toEqual({});
  }, 60_000);

  it("shows a held send at the command line, with the rule and when it ends", async () => {
    const { a, devices, relay } = await pair(60);
    await a.send("b@two", "1");
    await a.send("b@two", "2");
    await until(async () => Object.keys(await a.pausedBy.active()).length === 1);
    // A one-off `wim send` is another session of the device: it reads the device-wide record.
    const t = term(devices[0]!.root, relay);
    expect(await run(t, "send", "b@two", "hello")).toBe(0);
    expect(said(t)).toContain("b@two: held (that session's loop breaker holds this device's messages for now; the line below says until when)");
    expect(said(t)).toContain("  b@two: held there, not delivered: its loop breaker paused this device on the per-peer limit: 2 messages from this device in 60 minutes, limit 1; at ");
  }, 30_000);
});

describe("pauses on disk", () => {
  it("reads only well-formed running pauses, and lists them for every session", async () => {
    const dir = await scratch("pauses");
    const path = join(dir, "breaker.json");
    const row: PauseRow = { from: "a@one", told: ["a@one"], peer: "d", rule: "peer", count: 2, limit: 1, minutes: 60, at: 1, until: 100, auto: true };
    await savePauses(path, { pauses: [row, { ...row, until: 5 }], released: { d: 1 }, lifts: ["x@two"], counts: { d: [1, 2] }, wakes: {} }, FS);
    expect(await readPauses(path, 10)).toEqual([row]);
    expect(await readPauses(join(dir, "missing.json"), 0)).toEqual([]);
    await fs.writeFile(path, JSON.stringify({ pauses: [null, 3, { ...row, rule: "other" }, { ...row, from: 1 }, { ...row, peer: 1 }, { ...row, count: 1.5 }, { ...row, auto: "yes" }, { ...row, told: "a@one" }, { ...row, told: [1] }, row] }));
    expect(await readPauses(path, 10)).toEqual([row]);
    expect(await readBreakerFile(path)).toEqual({ pauses: [row], released: {}, lifts: [], counts: {}, wakes: {} });
    await fs.writeFile(path, JSON.stringify({ pauses: "none", released: { d: 5, e: "soon" }, lifts: ["x@two", 3], counts: { d: [1, "2", 3], e: "x" }, wakes: { d: [4, "5"], e: 6 } }));
    expect(await readPauses(path, 10)).toEqual([]);
    expect(await readBreakerFile(path)).toEqual({ pauses: [], released: { d: 5 }, lifts: ["x@two"], counts: { d: [1, 3] }, wakes: { d: [4] } });
    await fs.writeFile(path, JSON.stringify({ released: null, counts: null, wakes: null }));
    expect(await readBreakerFile(path)).toEqual({ pauses: [], released: {}, lifts: [], counts: {}, wakes: {} });
    await fs.writeFile(path, "{ not json");
    expect(await readPauses(path, 10)).toEqual([]);
    // Every session's, oldest first; a session whose state is gone is named "?".
    const mesh = new MeshFiles(join(dir, "mesh"), FS);
    const [s1, s2] = [ulid(1), ulid(2)];
    for (const [sid, at] of [[s1, 5], [s2, 3]] as const) {
      await fs.mkdir(mesh.sessionDir(sid), { recursive: true });
      await savePauses(join(mesh.sessionDir(sid), "breaker.json"), { pauses: [{ ...row, at }], released: {}, lifts: [], counts: {}, wakes: {} }, FS);
    }
    expect((await listAllPauses(mesh, FS, 10)).map((p) => [p.sid, p.session, p.at])).toEqual([[s2, "?", 3], [s1, "?", 5]]);
  });

  it("keeps what peers said about this device, and drops what is damaged or over", async () => {
    const dir = await scratch("paused-by");
    let now = 1_000;
    const box = new PausedBy(join(dir, "paused-by.json"), FS, () => now);
    expect(await box.active()).toEqual({});
    const info = { state: "paused" as const, rule: "peer" as const, count: 2, limit: 1, minutes: 60, until: 5_000, auto: false };
    await box.note("dev/b", "b@two", info, 1_000);
    expect(await box.active()).toEqual({ "dev/b": { ...info, to: "b@two", at: 1_000 } });
    await box.note("dev/b", "b@two", { state: "lifted" }, 2_000);
    expect(await box.active()).toEqual({});
    await box.note("dev/b", "b@two", info, 1_000);
    now = 5_000;
    expect(await box.active()).toEqual({});
    // An end later than a pause can have (an hour after a send at most 10 minutes ahead), or past
    // what a clock can show, is damaged (Seer, #76): it would make every send to that session throw.
    for (const raw of ["null", "7", "{ not json", JSON.stringify({ x: null, y: { until: "soon", to: "b@two" }, z: { until: 9_000 }, w: { until: 9_000_000_000_000_000, to: "b@two" }, v: { until: 5_000 + 4_200_001, to: "b@two" }, u: { until: 5_500.5, to: "b@two" } })]) {
      await fs.writeFile(join(dir, "paused-by.json"), raw);
      expect(await box.active()).toEqual({});
    }
    // The latest end a pause can have is still read.
    await fs.writeFile(join(dir, "paused-by.json"), JSON.stringify({ t: { ...info, until: 5_000 + 4_200_000, to: "b@two", at: 5_000 } }));
    expect(Object.keys(await box.active())).toEqual(["t"]);
  });
});

describe("the device's sent-to record", () => {
  it("keeps the newest 256 pairs of the last hour, written again at most every 5 minutes, and drops what is damaged", async () => {
    const dir = await scratch("sent-to");
    const path = join(dir, "sent-to.json");
    let now = 1_000_000;
    const box = new SentTo(path, FS, () => now);
    expect(await box.has("d/a")).toBe(false);
    await box.note(["d/a"]);
    expect(await box.has("d/a")).toBe(true);
    // Within 5 minutes the same pair is not written again (the file keeps its first time).
    now += 60_000;
    await box.note(["d/a"]);
    expect(JSON.parse(await fs.readFile(path, "utf8"))).toEqual({ "d/a": 1_000_000 });
    now += 5 * 60_000;
    await box.note(["d/a"]);
    expect(JSON.parse(await fs.readFile(path, "utf8"))).toEqual({ "d/a": now });
    // Another session of the device reads the same record, and an hour later it is gone.
    expect(await new SentTo(path, FS, () => now).has("d/a")).toBe(true);
    now += 3_600_001;
    expect(await box.has("d/a")).toBe(false);
    // The newest 256 are kept.
    const pairs = Array.from({ length: 257 }, (_, i) => `d/s${i}`);
    for (const [i, p] of pairs.entries()) {
      now += 1;
      await box.note([p]);
      void i;
    }
    expect(await box.has("d/s0")).toBe(false);
    expect(await box.has("d/s1")).toBe(true);
    for (const raw of ["null", "{ not json", JSON.stringify({ "d/x": "soon" })]) {
      await fs.writeFile(path, raw);
      expect(await box.has("d/x")).toBe(false);
    }
  });
});

describe("the person's decisions in the pane", () => {
  it("approve and resume lifts the pause on the item's device and releases everything held from it", async () => {
    const { a, b, devices, mesh, relay } = await pair(60);
    for (const t of ["1", "2", "3"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 2);
    await until(async () => Object.keys(await a.pausedBy.active()).length === 1);
    // `wim held list`, in another process, shows the pause with the rule and its end, then the items.
    const t = term(devices[1]!.root, relay);
    expect(await run(t, "held", "list")).toBe(0);
    const end = clock((await b.held.list())[0]!.pause!.until);
    expect(said(t)).toContain(`paused  a@one's device -> b  breaker: the per-peer limit: 2 messages from a@one in 60 minutes, limit 1; until ${end}, when the client releases it and delivers up to its per-peer limit of what it held (a trusted device's cool-down)`);
    expect(said(t)).toMatch(/ {2}a@one -> b {2}msg {2}breaker \(the per-peer limit: 2 messages from a@one in 60 minutes, limit 1\) {2}/);
    expect((await listAllPauses(new MeshFiles(devices[1]!.home.meshDir(mesh), FS), FS, Date.now())).map((p) => p.session)).toEqual(["b"]);
    const [first] = await b.held.list();
    await new HeldBox(b.files.heldDir, FS).mark(first!.id, "resume");
    await until(async () => (await msgs(b)).length === 3 && (await b.held.list()).length === 0);
    expect(b.pausedRows()).toEqual([]);
    // The told sender hears it lifted.
    await until(async () => Object.keys(await a.pausedBy.active()).length === 0);
    expect((await a.send("b@two", "4")).results[0]!.status).toBe("routed");
  }, 30_000);

  it("approve and resume on a policy hold, or an item whose device is gone, approves the item alone", async () => {
    const { a, b, devices, mesh } = await pair(60);
    await setPolicy(devices[1]!, mesh, devices[0]!.device.id, "hold");
    await a.send("b@two", "policy");
    await until(async () => (await b.held.list()).length === 1);
    const box = new HeldBox(b.files.heldDir, FS);
    await box.mark((await b.held.list())[0]!.id, "resume");
    await until(async () => (await msgs(b)).length === 1);
    // A breaker hold whose sender's device is not in the roster any more: no pause to lift.
    const id = ulid();
    const ghost = { id, from: "x@ghost", device: devices[0]!.device.id, kind: "msg" as const, at: Date.now(), preview: "ghost", rendered: "", reason: "breaker" as const, entry: { dir: "in" as const, peer: "x@ghost", device: devices[0]!.device.id, id, kind: "msg" as const, at: Date.now(), text: "9" } };
    await box.add(ghost);
    await box.mark(id, "resume");
    await until(async () => (await b.held.list()).length === 0);
    // A mark for nothing held is let go.
    await box.mark(ulid(), "resume");
    await new Promise((r) => setTimeout(r, 100));
    expect(await b.held.list()).toEqual([]);
  }, 30_000);
});

describe("the pane's view", () => {
  it("lists the pause with the rule and when it ends, and which holds the breaker made", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, trustedTrip(60));
    const server = new WimMcp({ channel: false, internalTools: true, version: "test", session: sessionOpts(devices[1]!, mesh, relay, { name: "pane", kind: "claude-code" }) });
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await server.server.connect(y);
    await client.connect(x);
    cleanup.push(async () => {
      await client.close();
      await server.close();
    });
    const hello = (await client.callTool({ name: "_internal", arguments: { op: "hello", args: { claudeSessionId: "s1" } } }, CallToolResultSchema)) as { structuredContent?: { token?: string; address?: string } };
    const token = hello.structuredContent!.token!;
    const held = async (): Promise<{ held: Array<Record<string, unknown>>; paused: Array<Record<string, unknown>> }> =>
      JSON.parse(((await client.callTool({ name: "_internal", arguments: { op: "held", args: {}, token } }, CallToolResultSchema)) as { content: Array<{ text: string }> }).content[0]!.text) as never;
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    for (const t of ["1", "2"]) await a.send(hello.structuredContent!.address!, t);
    await until(async () => (await held()).held.length === 1);
    const out = await held();
    expect(out.held[0]).toMatchObject({ from: "a@one", reason: "breaker" });
    expect(out.paused).toEqual([
      {
        from: "a@one",
        rule: "peer",
        until: expect.any(Number),
        auto: true,
        why: "the per-peer limit: 2 messages from a@one in 60 minutes, limit 1",
        ends: expect.stringMatching(/^until \S+Z, when the client releases it and delivers up to its per-peer limit of what it held \(a trusted device's cool-down\)$/),
      },
    ]);
  }, 30_000);
});

describe("no agent path approves or resumes (#54)", () => {
  it("a peer's pause, the MCP tools and the internal op release nothing", async () => {
    const { a, b, devices, mesh, relay } = await pair(60);
    for (const t of ["1", "2"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 1);
    await until(async () => Object.keys(await a.pausedBy.active()).length === 1);
    // A peer can say "lifted" to the session that holds its messages: that is a label for what the
    // holder's sends report, never a resume of the holder's own pause.
    forgePause(a, "b@two", { state: "lifted" });
    forgePause(a, "b@two", { state: "paused", rule: "peer", count: 1, limit: 1, minutes: 1, until: Date.now() + 60_000, auto: true });
    // b has handled both once a message a sends after them is held there too.
    await handled(a, b, "b@two");
    expect(b.pausedRows()).toHaveLength(1);
    expect((await b.held.list()).map((h) => h.reason)).toEqual(["breaker", "breaker"]);
    expect(await msgs(b)).toEqual(["1"]);

    // The MCP server an agent on the sending device talks to has no tool or internal op that
    // approves or resumes; the held op decides nothing.
    expect(PUBLIC_TOOLS.map((t) => t.name)).not.toEqual(expect.arrayContaining(["approve", "resume"]));
    expect([...INTERNAL_OPS]).toEqual(["hello", "peers", "route", "held", "leases", "status"]);
    const server = new WimMcp({ channel: false, internalTools: true, version: "test", session: sessionOpts(devices[0]!, mesh, relay, { name: "agent", kind: "claude-code" }) });
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await server.server.connect(y);
    await client.connect(x);
    cleanup.push(async () => {
      await client.close();
      await server.close();
    });
    const call = async (name: string, args: Record<string, unknown>): Promise<string> =>
      ((await client.callTool({ name, arguments: args }, CallToolResultSchema)) as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");
    const id = (await b.held.list())[0]!.id;
    for (const op of ["resume", "approve", "approve_and_resume"]) {
      expect(await call("_internal", { op, args: { held: id, peer: "a@one" } })).toMatch(/invalid input: op/);
      expect(await call(op, { held: id, peer: "a@one" })).toMatch(/unknown tool/);
    }
    const hello = (await client.callTool({ name: "_internal", arguments: { op: "hello", args: { claudeSessionId: "s1" } } }, CallToolResultSchema)) as { structuredContent?: { token?: string } };
    expect(await call("_internal", { op: "held", args: { resume: "a@one", verdict: "resume" }, token: hello.structuredContent!.token! })).toBe('{"held":[],"paused":[]}');
    // The agent's own send names the hold and who can lift it; nothing it can call does.
    const sent = await call("send", { to: "b@two", text: "3" });
    expect(sent).toMatch(/"status":"held"/);
    expect(sent).toMatch(/"held_note":"b@two: held there, not delivered: its loop breaker paused this device on the per-peer limit/);
    await until(async () => (await b.held.list()).length === 3);

    // The approve-or-resume prompt at the command line is the person's: an agent's shell is
    // refused before it is asked anything, and nothing is released.
    const t = term(devices[1]!.root, relay, { isTTY: true, inputIsTTY: true }, { CLAUDECODE: "1" });
    t.answers.push("resume", "resume");
    expect(await run(t, "held", "approve", id)).toBe(1);
    expect(said(t)).toMatch(/CLAUDECODE is set/);
    expect(t.answers).toHaveLength(2);
    expect(b.pausedRows()).toHaveLength(1);
    expect(await b.held.list()).toHaveLength(3);
  }, 30_000);
});

describe("wim held approve for a breaker hold", () => {
  it("offers approve alone or approve and resume, and acts only on a typed answer", async () => {
    const { a, b, devices, relay } = await pair(60);
    for (const t of ["1", "2", "3", "4"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 3);
    const ids = (await b.held.list()).map((h) => h.id);
    await b.stop();
    const t = term(devices[1]!.root, relay);
    // The three are one set; `one` reaches the single-item prompt, which offers the resume.
    t.answers.push("one", "no");
    expect(await run(t, "held", "approve", ids[0]!)).toBe(1);
    expect(said(t)).toContain("Approving them releases these and keeps the loop breaker's pause on; `wim held resume <address>` lifts it.");
    expect(said(t)).toContain(`Type y to approve it, or resume to approve it and resume a@one (lifting the pause on device one and releasing the 2 others held from it) [y/resume/N] `);
    expect(said(t)).toContain("  held     because the loop breaker paused that peer on the per-peer limit: 2 messages from a@one in 60 minutes, limit 1; the pause runs until ");
    expect(t.err).toContain("wim: nothing changed.");
    t.answers.push("one", "y");
    expect(await run(t, "held", "approve", ids[0]!)).toBe(0);
    expect(said(t)).toContain(`Approved ${ids[0]!}. The breaker still pauses a@one: \`wim held resume a@one\` lifts it.`);
    t.answers.push("one", "RESUME");
    expect(await run(t, "held", "approve", ids[1]!)).toBe(0);
    expect(said(t)).toContain(`Approved ${ids[1]!} and resumed a@one; released 2 held by the breaker.`);
    expect(await new HeldBox(b.files.heldDir, FS).list()).toEqual([]);
    // The stopped session's pause on that device is gone from the list too.
    expect(await readPauses(b.files.breakerPath, Date.now())).toEqual([]);
    expect(await run(t, "held", "list")).toBe(0);
    expect(said(t)).toContain("Nothing is held.");
  }, 30_000);

  it("reports an item taken away between the prompt and the answer, not claims it", async () => {
    const { a, b, devices, relay } = await pair(60);
    for (const t of ["1", "2"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 1);
    const id = (await b.held.list())[0]!.id;
    await b.stop();
    const t = term(devices[1]!.root, relay);
    t.answers.push(() => {
      unlinkSync(join(b.files.heldDir, `${id}.json`));
      return "y";
    });
    await expect(run(t, "held", "approve", id)).resolves.toBe(1);
    expect(said(t)).toContain(`no held message ${id}`);
  }, 30_000);
});
