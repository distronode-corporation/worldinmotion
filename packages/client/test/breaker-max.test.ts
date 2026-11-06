// Regression tests from the max review of PR #76 (issue #59): one per finding, M1, M2 and L1 to
// L9, each stating the fixed behaviour, and the compatibility proof for older mesh.json files.
import { ulid, type PauseInfo } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { SENT_MEANING } from "../src/cli.ts";
import { heldSendLine, MeshSession, pausedThereLine } from "../src/client.ts";
import type { HistoryEntry } from "../src/history.ts";
import { MeshFiles, parseMeshConfig, type BreakerLimits, type Policy } from "../src/mesh.ts";
import type { SpoolItem } from "../src/spool.ts";
import { FS, LIVE_PID, makeMesh, openSession, RelayHarness, until, type TestDevice } from "./helpers.ts";

const open: MeshSession[] = [];
afterEach(async () => { for (const s of open.splice(0)) await s.stop().catch(() => undefined); });
async function session(...a: Parameters<typeof openSession>): Promise<MeshSession> { const s = await openSession(...a); open.push(s); return s; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const unread = (s: MeshSession): Promise<SpoolItem[]> => s.spool.unread();
const msgs = async (s: MeshSession) => (await unread(s)).filter((i) => i.kind === "msg").map((i) => /\n([a-z]?\d+|slow)\n/.exec(i.rendered)?.[1] ?? "?");
const forModel = async (s: MeshSession) => (await unread(s)).filter((i) => i.kind === "notice" && i.held === undefined && i.heldBy === undefined && i.forPerson !== true);
const pausedByCount = async (s: MeshSession) => Object.keys(await s.pausedBy.active()).length;
const limits = (x: Partial<BreakerLimits> = {}): BreakerLimits => ({ perPeerPerHour: 1, totalPerHour: 50, pingPong: false, pingPongExchanges: 8, cooldownMinutes: 1, ...x });
const setBreaker = (d: TestDevice, m: string, b: BreakerLimits) => new MeshFiles(d.home.meshDir(m), FS).updateConfig((c) => ({ ...c, breaker: b }));
const setPolicy = (d: TestDevice, m: string, id: string, p: Policy) => new MeshFiles(d.home.meshDir(m), FS).updateConfig((c) => ({ ...c, policy: { ...c.policy, [id]: p } }));
function forgePause(s: MeshSession, to: string, pause: PauseInfo): void {
  void (s as unknown as { post(t: string, x: undefined, o: { kind: "pause"; pause: PauseInfo }): Promise<unknown> }).post(to, undefined, { kind: "pause", pause });
}
const enospc = () => Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });

describe("M1", () => {
  it("three sessions of a device held by policy each wake a@one's agent with a pause", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setPolicy(devices[0]!, mesh, devices[1]!.device.id, "hold");
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const bs: MeshSession[] = [];
    for (const name of ["b1", "b2", "b3"]) bs.push(await session(devices[1]!, mesh, relay, { name }));
    await a.joinRoom("#ops");
    for (const b of bs) await b.joinRoom("#ops");
    await until(() => [...a.peers.values()].filter((p) => p.rooms.includes("#ops")).length === 3);
    await a.send("#ops", "status?");
    for (const b of bs) forgePause(b, "a@one", { state: "paused", rule: "peer", count: 2, limit: 1, minutes: 60, until: Date.now() + 600_000, auto: true });
    await until(async () => (await pausedByCount(a)) === 3);
    await sleep(200);
    expect((await forModel(a)).map((i) => i.rendered), "SPEC 12: starts no agent turn").toEqual([]);
  }, 30_000);
});

describe("M2", () => {
  it("three trusted devices tripping a total of 2 get at most about twice the total in the hour", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two", "three", "four"]);
    await setBreaker(devices[1]!, mesh, limits({ perPeerPerHour: 2, totalPerHour: 2 }));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const c = await session(devices[2]!, mesh, relay, { name: "c" });
    const e = await session(devices[3]!, mesh, relay, { name: "e" });
    let offset = 0;
    const b = await session(devices[1]!, mesh, relay, { name: "b", now: () => Date.now() + offset });
    for (const t of ["a1", "a2"]) await a.send("b@two", t);
    await until(async () => (await msgs(b)).length === 2);
    for (const [s, p] of [[c, "c"], [e, "e"], [a, "a"]] as const) for (const n of [3, 4, 5]) await s.send("b@two", `${p}${n}`);
    await until(async () => (await b.held.list()).length === 9);
    offset += 61_000;
    await until(async () => (await unread(b)).filter((i) => i.kind === "notice" && i.rendered.includes("cool-down for")).length === 3);
    expect((await msgs(b)).length).toBeLessThanOrEqual(4); // 8 on 069e17c
  }, 30_000);
});

describe("L1", () => {
  it("a release that fails partway loses nothing and counts what it delivered", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, limits({ perPeerPerHour: 2 }));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    let offset = 0;
    const b = await session(devices[1]!, mesh, relay, { name: "b", now: () => Date.now() + offset });
    for (const t of ["1", "2", "3", "4", "5"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 3);
    const sp = b.spool as unknown as { write: (i: Omit<SpoolItem, "cursor">) => Promise<SpoolItem> };
    const write = sp.write.bind(b.spool);
    let fail = true;
    sp.write = async (i) => { if (fail && i.kind === "msg" && /\n4\n/.test(i.rendered)) { fail = false; throw enospc(); } return write(i); };
    offset += 61_000;
    await until(async () => (await msgs(b)).includes("3"));
    await until(async () => (await b.held.list()).length === 2, 10_000);
    const held = (await b.held.list()).map((h) => h.entry.text);
    expect([...(await msgs(b)), ...held].sort(), "delivered or still held").toEqual(["1", "2", "3", "4", "5"]);
    for (const t of ["6", "7"]) await a.send("b@two", t);
    await sleep(500);
    expect((await msgs(b)).length, "2 x limit 2").toBeLessThanOrEqual(4);
  }, 30_000);
});

describe("L2", () => {
  it("a held message whose seen record failed, back after its cool-down ended, is delivered once", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, limits({ perPeerPerHour: 2 }));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    let offset = 0;
    const b = await session(devices[1]!, mesh, relay, { name: "b", now: () => Date.now() + offset });
    for (const t of ["1", "2"]) await a.send("b@two", t);
    await until(async () => (await msgs(b)).length === 2);
    const seen = (b as unknown as { seen: { add: (...x: unknown[]) => Promise<void> } }).seen;
    const add = seen.add.bind(seen);
    let fail = true;
    // "3" trips the pause and is held; recording it as seen fails, so its frame is not
    // acknowledged and comes again, after the cool-down ended.
    const id = ulid();
    seen.add = async (...x: unknown[]) => { if (fail && x[0] === id) { fail = false; offset += 61_000; throw enospc(); } return add(...x); };
    await a.send("b@two", "3", { id });
    await until(async () => (await msgs(b)).includes("3"), 10_000);
    await sleep(1500);
    expect((await msgs(b)).filter((t) => t === "3")).toHaveLength(1);
    expect(await b.held.list()).toEqual([]);
  }, 30_000);
});

describe("L2 (continued)", () => {
  it("a copy that comes back before the pass releases the pause is released by accept itself, and delivered once", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, limits({ perPeerPerHour: 2 }));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    let offset = 0;
    // No housekeeping pass runs here, so only the copy's own accept can release the pause.
    const b = await session(devices[1]!, mesh, relay, { name: "b", now: () => Date.now() + offset, tickMs: 3_600_000 });
    for (const t of ["1", "2"]) await a.send("b@two", t);
    await until(async () => (await msgs(b)).length === 2);
    const seen = (b as unknown as { seen: { add: (...x: unknown[]) => Promise<void> } }).seen;
    const add = seen.add.bind(seen);
    let fail = true;
    const id = ulid();
    seen.add = async (...x: unknown[]) => { if (fail && x[0] === id) { fail = false; offset += 61_000; throw enospc(); } return add(...x); };
    await a.send("b@two", "3", { id });
    await until(async () => (await msgs(b)).includes("3"), 10_000);
    await sleep(500);
    expect((await msgs(b)).filter((t) => t === "3")).toHaveLength(1);
    expect(await b.held.list()).toEqual([]);
  }, 30_000);
});

describe("L1 (continued)", () => {
  it("an item gone from held/ when the release reaches it is passed over, not counted", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, limits({ perPeerPerHour: 2 }));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    let offset = 0;
    const b = await session(devices[1]!, mesh, relay, { name: "b", now: () => Date.now() + offset });
    for (const t of ["1", "2", "3", "4"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 2);
    // Another process takes "3" out of held/ just as the release lists what it holds.
    const box = b.held as unknown as { list: () => Promise<Array<{ id: string; entry: { text: string } }>> };
    const list = box.list.bind(b.held);
    let armed = true;
    box.list = async () => {
      const out = await list();
      if (armed && (new Error().stack ?? "").includes("MeshSession.autoRelease")) {
        armed = false;
        await fs.unlink(`${b.files.heldDir}/${out.find((h) => h.entry.text === "3")!.id}.json`);
      }
      return out;
    };
    offset += 61_000;
    await until(async () => (await unread(b)).some((i) => i.kind === "notice" && i.rendered.includes("cool-down for a@one ended")));
    expect(await msgs(b)).toEqual(["1", "2", "4"]);
    expect((await unread(b)).find((i) => i.kind === "notice" && i.rendered.includes("cool-down for a@one ended"))!.rendered).toContain("1 message it held is delivered now; 1 message more stays held");
  }, 30_000);

  it("a resume a marker asks for that fails is logged, and what it could not deliver stays held", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, limits({ cooldownMinutes: 60 }));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const lines: string[] = [];
    const b = await session(devices[1]!, mesh, relay, { name: "b", log: (l) => void lines.push(l) });
    for (const t of ["1", "2"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 1);
    const sp = b.spool as unknown as { write: (i: Omit<SpoolItem, "cursor">) => Promise<SpoolItem> };
    const write = sp.write.bind(b.spool);
    let fail = true;
    sp.write = async (i) => { if (fail && i.kind === "msg") { fail = false; throw enospc(); } return write(i); };
    await fs.mkdir(b.files.controlDir, { recursive: true });
    await fs.writeFile(`${b.files.controlDir}/resume-a@one`, "");
    await until(() => lines.some((l) => l.startsWith("wim: housekeeping: ENOSPC")));
    expect((await b.held.list()).map((h) => h.entry.text)).toEqual(["2"]);
  }, 30_000);
});

describe("L3", () => {
  it("a restart after a release does not admit another per-peer limit within the hour", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, limits());
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    let offset = 0;
    const holder = { name: "b", sessionKey: "key:b", now: () => Date.now() + offset };
    let b = await session(devices[1]!, mesh, relay, holder);
    for (const t of ["1", "2"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 1);
    offset += 61_000;
    await until(async () => (await msgs(b)).length === 2);
    await b.stop();
    b = await session(devices[1]!, mesh, relay, holder);
    await a.send("b@two", "3");
    await sleep(500);
    expect(await msgs(b), "7.3: about twice the limit (1)").toEqual(["1", "2"]);
  }, 30_000);
});

describe("L4", () => {
  it("a lift owed from an earlier pause does not clear a newer pause's label", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, limits({ perPeerPerHour: 50, totalPerHour: 1, cooldownMinutes: 60 }));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const d = await session(devices[1]!, mesh, relay, { name: "d" });
    const b = await session(devices[1]!, mesh, relay, { name: "b", tickMs: 3_600_000 });
    await d.send("b@two", "d1");
    await until(async () => (await msgs(b)).length === 1);
    await a.send("b@two", "a1");
    await until(async () => (await pausedByCount(a)) === 1);
    await b.resumePeer("a@one");
    await a.send("b@two", "a2");
    await until(async () => (await b.held.list()).length === 1 && b.pausedRows().length === 1);
    await sleep(300);
    await b.tick();
    await sleep(300);
    expect(await pausedByCount(a)).toBe(1);
    expect((await a.send("b@two", "a3")).results[0]!.status).toBe("held");
  }, 30_000);
});

describe("L5", () => {
  it("a slow frame on the inbound queue does not hold up the sweep and its receipts", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const sent = await a.send("b@two", "1");
    await until(async () => (await msgs(b)).length === 1);
    const h = b.history as unknown as { append: (e: HistoryEntry) => Promise<void> };
    const append = h.append.bind(b.history);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.append = async (e) => { if (e.text === "slow") await gate; return append(e); };
    await a.send("b@two", "slow");
    await sleep(100);
    const one = (await unread(b)).find((i) => i.id === sent.id)!;
    await b.spool.take(one.cursor);
    await sleep(1000);
    const delivered = (a.receipts.get(sent.id) ?? []).some((r) => r.status === "delivered");
    release();
    expect(delivered).toBe(true);
  }, 30_000);
});

describe("L6", () => {
  it("a 1-minute cool-down ends about a minute after the clock moves back 5 hours, peer quiet", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, limits());
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    let offset = 0;
    const b = await session(devices[1]!, mesh, relay, { name: "b", now: () => Date.now() + offset });
    for (const t of ["1", "2"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 1);
    offset = -5 * 3_600_000;
    await sleep(200);
    offset += 61_000;
    await until(async () => (await msgs(b)).length === 2, 10_000);
    expect(await msgs(b)).toEqual(["1", "2"]);
  }, 30_000);
});

describe("L7", () => {
  it("a send the relay took is not reported as failed when sent-to.json cannot be written", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    await fs.writeFile(`${a.mesh.sentToPath}.lock`, String(LIVE_PID));
    const out = await a.send("b@two", "1").then((o) => o.results[0]!.status, (e: Error) => `threw: ${e.message}`);
    await until(async () => (await msgs(b)).includes("1"));
    expect(out).toBe("routed");
  }, 30_000);
});

describe("L8", () => {
  it("the sending side names the cap, and does not send the agent to the person for a cool-down", () => {
    const p = { rule: "total" as const, count: 301, limit: 300, minutes: 60, until: Date.now() + 600_000, auto: true };
    expect(heldSendLine("b@two", p)).toMatch(/up to|at most/);
    expect(pausedThereLine("b@two", { state: "paused", ...p })).toMatch(/up to|at most/);
    expect(SENT_MEANING["held"]).not.toContain("waits for that device's person");
  });
});

describe("L9", () => {
  it("a paused that arrives after its until is not told to the agent", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    let offset = 0;
    const a = await session(devices[0]!, mesh, relay, { name: "a", now: () => Date.now() + offset });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    await a.send("b@two", "0");
    offset = 30 * 60_000;
    forgePause(b, "a@one", { state: "paused", rule: "peer", count: 2, limit: 1, minutes: 60, until: Date.now() + 600_000, auto: true });
    await sleep(500);
    expect((await forModel(a)).filter((i) => i.rendered.includes("loop breaker paused messages from this device"))).toEqual([]);
  }, 30_000);
});

describe("proof: compatibility (8e5e666)", () => {
  it("a draft breaker loads, odd values never refuse, a draft's own default reads as its top level", () => {
    const base = { v: 1, mesh: "m", relay: "wss://r", device: "D", pin: { seq: 1, hash: "h" }, policy: {} };
    const draft = { perPeerPerHour: 20, totalPerHour: 60, pingPong: true, pingPongExchanges: 8, trusted: { perPeerPerHour: 120, totalPerHour: 300, pingPong: true, pingPongExchanges: 32, cooldownMinutes: 10 } };
    expect(parseMeshConfig({ ...base, breaker: draft }, "p").breaker).toEqual({ perPeerPerHour: 20, totalPerHour: 60, pingPong: true, pingPongExchanges: 8, cooldownMinutes: 10 });
    for (const odd of [null, false, "off", [], { trusted: "x", autoRelease: false }]) expect(() => parseMeshConfig({ ...base, breaker: odd }, "p")).not.toThrow();
  });
});
