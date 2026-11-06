// Regression tests from the independent review of PR #76 (issue #59), findings F1 to F17, adapted
// to the final design: one set of limits (only trusted devices reach the breaker), a written
// mesh.json honoured as written, a cool-down's release capped at the per-peer limit, and every
// change to the breaker's pauses serialised on the inbound queue. "proof" marks a claim checked.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { revokeDevice } from "../src/admin.ts";
import { MeshSession } from "../src/client.ts";
import { HeldBox } from "../src/held.ts";
import { runEvents } from "../src/events.ts";
import { MeshFiles, parseMeshConfig, type BreakerLimits, type MeshConfig, type Policy } from "../src/mesh.ts";
import { readBreakerFile, readPauses, savePauses, type PauseRow } from "../src/pauses.ts";
import { isTrusted, policyFor } from "../src/render.ts";
import type { SpoolItem } from "../src/spool.ts";
import { FS, makeMesh, openSession, RelayHarness, run, said, scratch, sessionOpts, term, until, type TestDevice } from "./helpers.ts";

const open: MeshSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

async function session(...args: Parameters<typeof openSession>): Promise<MeshSession> {
  const s = await openSession(...args);
  open.push(s);
  return s;
}

const unread = (s: MeshSession): Promise<SpoolItem[]> => s.spool.unread();
const msgs = async (s: MeshSession): Promise<string[]> => (await unread(s)).filter((i) => i.kind === "msg").map((i) => /\n([a-z]?\d+)\n/.exec(i.rendered)?.[1] ?? "?");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function trustedTrip(minutes: number, extra: Partial<BreakerLimits> = {}): BreakerLimits {
  return { perPeerPerHour: 1, totalPerHour: 50, pingPong: false, pingPongExchanges: 8, cooldownMinutes: minutes, ...extra };
}

async function setBreaker(d: TestDevice, mesh: string, breaker: unknown): Promise<void> {
  await new MeshFiles(d.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, breaker: breaker as BreakerLimits }));
}

async function setPolicy(d: TestDevice, mesh: string, device: string, level: Policy): Promise<void> {
  await new MeshFiles(d.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, policy: { ...c.policy, [device]: level } }));
}

const pausedByCount = async (s: MeshSession): Promise<number> => Object.keys(await s.pausedBy.active()).length;

// ---------------------------------------------------------------------------------------------
describe("F1: the untrusted tier is never reached by a delivered message", () => {
  it("proof: every policy that delivers is a trusted one, so admit(..., trusted=false) never runs for a message", () => {
    const levels: Array<Policy | undefined> = [undefined, "deliver", "deliver-relayed", "hold", "refuse"];
    for (const level of levels) {
      for (const relayed of [false, true]) {
        const config = { device: "SELF", policy: level === undefined ? {} : { DEV: level } } as unknown as MeshConfig;
        if (policyFor(config, "DEV", relayed) === "deliver") expect(isTrusted(config, "DEV"), `${level} relayed=${relayed}`).toBe(true);
      }
    }
  });

  it("a device the person does not trust is held by policy, never counted by the breaker (SECURITY-MODEL 7.3)", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"], { trust: false });
    await setBreaker(devices[1]!, mesh, { perPeerPerHour: 2, totalPerHour: 60, pingPong: true, pingPongExchanges: 8, cooldownMinutes: 10 });
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    for (const t of ["1", "2", "3"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 3);
    expect((await b.held.list()).map((h) => h.reason)).toEqual(["policy", "policy", "policy"]);
    expect(b.pausedRows()).toEqual([]);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
describe("F2: a mesh.json written before 0.1.9 no longer keeps its written limits", () => {
  it("a per-peer limit the person lowered to 2 in an old mesh.json still pauses a delivering peer at 3", async () => {
    const parsed = parseMeshConfig({ v: 1, mesh: "m", relay: "wss://r", device: "D", pin: { seq: 1, hash: "h" }, policy: {}, breaker: { perPeerPerHour: 2, totalPerHour: 60, pingPong: true } }, "p");
    expect(parsed.breaker.perPeerPerHour, "the limit the file was written with").toBe(2);
  });

  it("proof: a mesh created by 0.1.8 (breaker 120/300/32 written) keeps 120/300/32", () => {
    const parsed = parseMeshConfig({ v: 1, mesh: "m", relay: "wss://r", device: "D", pin: { seq: 1, hash: "h" }, policy: {}, breaker: { perPeerPerHour: 120, totalPerHour: 300, pingPong: true, pingPongExchanges: 32 } }, "p");
    expect([parsed.breaker.perPeerPerHour, parsed.breaker.totalPerHour, parsed.breaker.pingPongExchanges]).toEqual([120, 300, 32]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("F3: an offline `wim held resume` erases other peers' ended cool-downs from breaker.json", () => {
  it("the cool-down of c@three that ended while no process ran still releases at the next start", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"]);
    await setBreaker(devices[1]!, mesh, trustedTrip(1));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const c = await session(devices[2]!, mesh, relay, { name: "c" });
    let offset = 0;
    const holder = { name: "b", sessionKey: "key:b", now: () => Date.now() + offset };
    let b = await session(devices[1]!, mesh, relay, holder);
    for (const t of ["a1", "a2"]) await a.send("b@two", t);
    for (const t of ["c1", "c2"]) await c.send("b@two", t);
    await until(async () => (await b.held.list()).length === 2);
    await until(async () => (await pausedByCount(a)) === 1);
    await b.stop();
    // Both cool-downs end while nobody runs the session; then the person resumes a@one only.
    offset += 61_000;
    const t = term(devices[1]!.root, relay, { now: () => Date.now() + 61_000 });
    t.answers.push("y");
    expect(await run(t, "held", "resume", "a@one")).toBe(0);
    expect(await readPauses(b.files.breakerPath, Number.NEGATIVE_INFINITY), "c@three's ended cool-down is kept for the next process").toEqual([expect.objectContaining({ from: "c@three", auto: true })]);
    b = await session(devices[1]!, mesh, relay, holder);
    await until(async () => (await msgs(b)).includes("c2"), 10_000, "c2 released by its cool-down");
  }, 30_000);

  it("the sender told about a@one's pause hears it lifted after an offline resume", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, trustedTrip(60));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b", sessionKey: "key:b" });
    for (const t of ["1", "2"]) await a.send("b@two", t);
    await until(async () => (await pausedByCount(a)) === 1);
    await b.stop();
    const t = term(devices[1]!.root, relay);
    t.answers.push("y");
    expect(await run(t, "held", "resume", "a@one")).toBe(0);
    // No process runs b to send it: the lift waits in breaker.json for the session's next process.
    expect((await readBreakerFile(b.files.breakerPath)).lifts).toEqual(["a@one"]);
    const again = await session(devices[1]!, mesh, relay, { name: "b", sessionKey: "key:b" });
    await until(async () => (await pausedByCount(a)) === 0);
    expect((await readBreakerFile(again.files.breakerPath)).lifts).toEqual([]);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
describe("F4: a sending session that restarted drops the `lifted` (and any `pause`) meant for it", () => {
  it("after the person there resumes, the restarted sender reports routed again", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, trustedTrip(60));
    const sender = { name: "a", sessionKey: "key:a" };
    let a = await session(devices[0]!, mesh, relay, sender);
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    for (const t of ["1", "2"]) await a.send("b@two", t);
    await until(async () => (await pausedByCount(a)) === 1);
    // The sender's MCP server restarts (same session, same address).
    await a.stop();
    a = await session(devices[0]!, mesh, relay, sender);
    expect(a.address).toBe("a@one");
    await b.resumePeer("a@one");
    await until(async () => (await pausedByCount(a)) === 0);
    expect((await a.send("b@two", "3")).results[0]!.status).toBe("routed");
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
describe("F5: a restored pause is not bounded by its tier (clock moved back, or a bad clock)", () => {
  it("a 1-minute cool-down written while the clock ran 5 hours ahead lasts at most an hour after the clock is fixed", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, trustedTrip(1));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    let offset = 0;
    const holder = { name: "b", sessionKey: "key:b", now: () => Date.now() + offset };
    let b = await session(devices[1]!, mesh, relay, holder);
    // The clock jumps 5 hours ahead while the session is connected (a bad RTC, a manual change).
    offset = 5 * 3_600_000;
    for (const t of ["1", "2"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 1);
    await b.stop();
    offset = 0; // NTP fixes the clock; the session restarts.
    b = await session(devices[1]!, mesh, relay, holder);
    const [p] = b.pausedRows();
    expect(p, "the pause is still running").toBeDefined();
    expect(p!.until - Date.now(), "a cool-down of 1 minute, at most an hour").toBeLessThanOrEqual(3_600_000);
    // The bound keeps the pause's \`at\`, so its release still finds what it held (Seer, #76).
    offset = 61_000;
    await until(async () => (await msgs(b)).length === 2);
    expect(await msgs(b)).toEqual(["1", "2"]);
    expect(await b.held.list()).toEqual([]);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
describe("F6: a revoked device's breaker holds are delivered when its cool-down ends", () => {
  it("what a revoked device held stays held for the person", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"]);
    await setBreaker(devices[1]!, mesh, trustedTrip(1));
    const admin = await session(devices[0]!, mesh, relay, { name: "admin" });
    const c = await session(devices[2]!, mesh, relay, { name: "c" });
    let offset = 0;
    const b = await session(devices[1]!, mesh, relay, { name: "b", now: () => Date.now() + offset });
    c.on("fatal", () => undefined);
    for (const t of ["1", "2"]) await c.send("b@two", t);
    await until(async () => (await b.held.list()).length === 1);
    // The admin revokes device three (lost laptop, runaway agent). Its policy entry on two stays.
    await revokeDevice(admin, "three", Date.now);
    await until(() => b.roster.revoked.includes(devices[2]!.device.id));
    offset += 61_000;
    await sleep(500);
    expect(await msgs(b), "the revoked device's held message is not delivered").toEqual(["1"]);
    expect(await b.held.list()).toHaveLength(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
describe("F7: a cool-down's end races the inbound queue", () => {
  it("A: a message that admit() sees after the end, before takeDue(), re-pauses instead of releasing", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, trustedTrip(1));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    let offset = 0;
    const b = await session(devices[1]!, mesh, relay, { name: "b", now: () => Date.now() + offset });
    for (const t of ["1", "2"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 1);
    // The cool-down ends while accept() reads mesh.json (after its releaseDue(), before admit()).
    const files = b.mesh;
    const orig = files.loadConfig.bind(files);
    let armed = true;
    files.loadConfig = async () => {
      const caller = new Error().stack ?? "";
      const cfg = await orig();
      if (armed && caller.includes("MeshSession.accept")) {
        armed = false;
        offset += 61_000;
      }
      return cfg;
    };
    await a.send("b@two", "3");
    await until(async () => (await msgs(b)).length === 2 && (await b.held.list()).length === 1);
    // The release runs before "3" is admitted: "2" is delivered (the per-peer limit, 1) and counted,
    // so "3" trips again within the hour of that release and waits for the person, never a fresh
    // cool-down over the old one.
    expect(await msgs(b)).toEqual(["1", "2"]);
    expect((await b.held.list()).map((h) => [h.entry.text, h.pause?.auto])).toEqual([["3", false]]);
  }, 30_000);

  it("B: the release of an ended cool-down never delivers a message held under the newer, person-only pause", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"]);
    // Trusted total of 3: c fills it, so a trips the total rule on its first message.
    await setBreaker(devices[1]!, mesh, trustedTrip(1, { perPeerPerHour: 50, totalPerHour: 3 }));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const c = await session(devices[2]!, mesh, relay, { name: "c" });
    let offset = 0;
    const b = await session(devices[1]!, mesh, relay, { name: "b", now: () => Date.now() + offset });
    for (const t of ["c1", "c2", "c3"]) await c.send("b@two", t);
    await until(async () => (await msgs(b)).length === 3);
    await a.send("b@two", "a1");
    await until(async () => (await b.held.list()).length === 1);
    expect((await b.held.list())[0]!.pause).toMatchObject({ rule: "total", auto: true });
    // accept(a2) reads mesh.json; the cool-down of a1's pause ends meanwhile. The release runs on
    // the inbound queue, inside accept(a2) before a2 is admitted, so a2 is decided after it.
    const files = b.mesh;
    const orig = files.loadConfig.bind(files);
    let armed = true;
    files.loadConfig = async () => {
      const caller = new Error().stack ?? "";
      const cfg = await orig();
      if (armed && caller.includes("MeshSession.accept")) {
        armed = false;
        offset += 61_000;
      }
      return cfg;
    };
    await a.send("b@two", "a2");
    await until(async () => b.pausedRows().length === 1 && (await b.held.list()).length === 2);
    // c's three still fill the total, so a1's release delivers nothing (#76 max review, M2), and
    // a2 trips the total again within the hour of that release: both wait for the person.
    const told = (await unread(b)).find((i) => i.kind === "notice" && i.rendered.includes("cool-down for a@one ended"))!;
    expect(told.rendered).toContain("nothing it held is delivered; 1 message more stays held for the person");
    expect(b.pausedRows()[0]).toMatchObject({ auto: false });
    expect((await b.held.list()).map((h) => [h.entry.text, h.pause?.auto])).toEqual([["a1", true], ["a2", false]]);
    expect(await msgs(b), "a1 and a2 wait for the person").toEqual(["c1", "c2", "c3"]);
  }, 30_000);

  it("C: when two cool-downs end together, both releases run, and every later save and message is handled", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"]);
    await setBreaker(devices[1]!, mesh, trustedTrip(1, { perPeerPerHour: 50, totalPerHour: 3 }));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const c = await session(devices[2]!, mesh, relay, { name: "c" });
    // d: another session on device two itself (trusted), which fills the trusted total.
    const d = await session(devices[1]!, mesh, relay, { name: "d" });
    let offset = 0;
    const lines: string[] = [];
    const b = await session(devices[1]!, mesh, relay, { name: "b", now: () => Date.now() + offset, log: (l) => void lines.push(l) });
    for (const t of ["d1", "d2", "d3"]) await d.send("b@two", t);
    await until(async () => (await msgs(b)).length === 3);
    await c.send("b@two", "c1");
    await until(async () => (await b.held.list()).length === 1);
    await a.send("b@two", "a1");
    await until(async () => (await b.held.list()).length === 2);
    // Both cool-downs end while accept(a2) reads mesh.json; both releases run before a2 is admitted.
    const files = b.mesh;
    const orig = files.loadConfig.bind(files);
    let armed = true;
    files.loadConfig = async () => {
      const caller = new Error().stack ?? "";
      const cfg = await orig();
      if (armed && caller.includes("MeshSession.accept")) {
        armed = false;
        offset += 61_000;
      }
      return cfg;
    };
    await a.send("b@two", "a2");
    // d's three fill the total, so neither release delivers anything (M2); both run and say so.
    await until(async () => (await unread(b)).filter((i) => i.kind === "notice" && i.rendered.includes("ended at") && i.rendered.includes("nothing it held is delivered")).length === 2);
    // A later message from a is handled too, and breaker.json still says what runs.
    await a.send("b@two", "a3");
    await until(async () => (await b.held.list()).some((h) => h.entry.text === "a3"), 10_000);
    expect({ errors: lines.filter((l) => /housekeeping|inbound/.test(l)), onDisk: (await readPauses(b.files.breakerPath, Date.now() + offset)).length, running: (b as unknown as { breaker: { pauses(): unknown[] } }).breaker.pauses().length }).toEqual({ errors: [], onDisk: 1, running: 1 });
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
describe("F8: a pause tripped by a room message never reaches the sender", () => {
  it("the sender of #ops messages hears b@two's pause and reports held", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, trustedTrip(60));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    await a.joinRoom("#ops");
    await b.joinRoom("#ops");
    for (const t of ["1", "2"]) await a.send("#ops", t);
    await until(async () => (await b.held.list()).length === 1);
    await sleep(500);
    expect(await pausedByCount(a), "a@one took the pause b@two sent it").toBe(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
describe("F9: a `pause` that fails to send is never sent again", () => {
  it("the next hold from the same session retries the pause", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, trustedTrip(60));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const inner = b as unknown as { post: (...args: unknown[]) => Promise<unknown> };
    const post = inner.post.bind(b);
    let fail = true;
    inner.post = (...args: unknown[]) => {
      if (fail && (args[2] as { kind?: string }).kind === "pause") {
        fail = false;
        return Promise.reject(new Error("not connected to the relay"));
      }
      return post(...args);
    };
    for (const t of ["1", "2", "3"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 2);
    // Waited for, not slept on: a slow runner (Windows CI) takes longer than a fixed half second.
    await until(async () => (await pausedByCount(a)) === 1, 10_000, "a@one learned of the pause from the second hold");
    // A lift that cannot be sent waits for the next pass.
    fail = true;
    const lines: string[] = [];
    (b as unknown as { log: (l: string) => void }).log = (l) => void lines.push(l);
    await b.resumePeer("a@one");
    await until(async () => (await pausedByCount(a)) === 0);
    expect(lines.some((l) => l.startsWith("wim: no pause sent to a@one"))).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
describe("F10: a trip whose hold fails loses the pause notices for good", () => {
  it("the agent and the person still get the pause notice once the next message is held", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, trustedTrip(60));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const box = b.held as unknown as { add: (i: unknown) => Promise<void> };
    const add = box.add.bind(b.held);
    let fail = true;
    box.add = (i: unknown) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error("ENOSPC: no space left on device"));
      }
      return add(i);
    };
    for (const t of ["1", "2", "3"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 1);
    await until(async () => (await unread(b)).some((i) => i.kind === "notice" && i.rendered.includes("this device's loop breaker paused a@one")), 10_000);
    const notices = (await unread(b)).filter((i) => i.kind === "notice").map((i) => i.rendered);
    expect(notices.some((n) => n.includes("worldinmotion paused a@one")), "the person's pause notice").toBe(true);
    expect(notices.some((n) => n.includes("this device's loop breaker paused a@one")), "the agent's pause notice").toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
describe("F11: a restart forgets the cool-down's release, so a second trip is auto again", () => {
  it("a trip within the hour of a release waits for the person, across a restart of the holder", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, trustedTrip(1));
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
    for (const t of ["3", "4"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 1);
    expect((await b.held.list())[0]!.pause, "second trip within the hour").toMatchObject({ auto: false });
    // The person resumes it at the command line while the session is stopped: its release is
    // forgotten with it (the next trip is a cool-down again), another device's is kept.
    await b.stop();
    const file = await readBreakerFile(b.files.breakerPath);
    expect(Object.keys(file.released)).toEqual([devices[0]!.device.id]);
    await savePauses(b.files.breakerPath, { ...file, released: { ...file.released, other: Date.now() + offset } }, FS);
    const t = term(devices[1]!.root, relay);
    t.answers.push("y");
    expect(await run(t, "held", "resume", "a@one")).toBe(0);
    expect(Object.keys((await readBreakerFile(b.files.breakerPath)).released)).toEqual(["other"]);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
describe("F12: the pane's Approve and resume resumes one session, the CLI's resume every session", () => {
  it("Approve and resume this device lifts the pause in the device's other sessions too, as `resume` at the CLI does", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, trustedTrip(60));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b1 = await session(devices[1]!, mesh, relay, { name: "b1" });
    // b2 runs as if in another process (the usual case: one process per session), so b1 hands it the resume.
    const b2 = await session(devices[1]!, mesh, relay, { name: "b2", env: { ...FS, pid: process.ppid } });
    for (const t of ["1", "2"]) await a.send("b1@two", t);
    for (const t of ["1", "2"]) await a.send("b2@two", t);
    await until(async () => (await b1.held.list()).length === 1 && (await b2.held.list()).length === 1);
    await new HeldBox(b1.files.heldDir, FS).mark((await b1.held.list())[0]!.id, "resume");
    await until(async () => (await b1.held.list()).length === 0);
    await until(() => b2.pausedRows().length === 0, 10_000, "device one is resumed on this device");
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
describe("F13: `wim held list` and `wim events` disagree once a pause has nothing held", () => {
  it("a running pause whose one item was approved alone shows in `wim held list` and in the events snapshot", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, trustedTrip(60));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    for (const t of ["1", "2"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 1);
    await b.decide((await b.held.list())[0]!.id, "approve");
    const t = term(devices[1]!.root, relay);
    expect(await run(t, "held", "list")).toBe(0);
    expect(said(t)).toContain("paused  a@one's device -> b");
    // `wim events` (the VS Code view) on the same device, started now.
    const lines: Array<Record<string, unknown>> = [];
    const input = new PassThrough();
    const stop = new AbortController();
    const vs = await MeshSession.open({ ...sessionOpts(devices[1]!, mesh, relay, { name: "vscode", kind: "vscode", cwd: devices[1]!.root }), handover: true, sessionKey: "events:vscode" });
    open.push(vs);
    const running = runEvents({ session: vs, mesh: new MeshFiles(devices[1]!.home.meshDir(mesh), FS), env: FS, device: devices[1]!.device, version: "test", write: (l) => void lines.push(JSON.parse(l) as Record<string, unknown>), input, signal: stop.signal, now: Date.now, pollMs: 20, leasePollMs: 40 });
    try {
      await until(() => lines.some((l) => l["type"] === "snapshot"), 5000);
      const snap = lines.find((l) => l["type"] === "snapshot")!;
      expect(snap["breakers"], "the running pause").toEqual([expect.objectContaining({ peer: "a@one" })]);
    } finally {
      stop.abort();
      await running.catch(() => undefined);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
describe("pauses.ts on disk", () => {
  it("proof: breaker.json rows read as written; the bound applies when a session takes them back (F5)", async () => {
    const dir = await scratch("rv76");
    const row: PauseRow = { from: "a@one", told: [], peer: "d", rule: "peer", count: 2, limit: 1, minutes: 60, at: 0, until: Number.MAX_SAFE_INTEGER, auto: true };
    await savePauses(join(dir, "breaker.json"), { pauses: [row], released: {}, lifts: [], counts: {} }, FS);
    expect(await readPauses(join(dir, "breaker.json"), Date.now())).toEqual([row]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("F15: the cool-down's release delivers at most the per-peer limit, counted", () => {
  it("with a limit of 1 an hour, a peer that keeps sending through its cool-down gets 1 + 1 delivered", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, trustedTrip(1));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    let offset = 0;
    const b = await session(devices[1]!, mesh, relay, { name: "b", now: () => Date.now() + offset });
    await a.send("b@two", "1");
    const statuses: string[] = [];
    for (let i = 2; i <= 16; i++) {
      statuses.push((await a.send("b@two", String(i))).results[0]!.status);
      await until(async () => (await b.held.list()).length === i - 1);
    }
    await until(async () => (await b.held.list()).length === 15).catch(async () => {
      throw new Error(`held ${(await b.held.list()).length}, delivered ${(await msgs(b)).join(",")}, sent ${statuses.join(",")}`);
    });
    offset += 61_000;
    await until(async () => (await unread(b)).some((i) => i.kind === "notice" && i.rendered.includes("cool-down for a@one ended")));
    // At most the per-peer limit is released (1), oldest first; the other 14 wait for the person.
    expect(await msgs(b), "deliveries in the hour, limit 1").toEqual(["1", "2"]);
    expect(await b.held.list()).toHaveLength(14);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
describe("F7 (continued): the release and the person's decisions are not serialized", () => {
  it("D: a refuse that lands while the release runs leaves the rest held, with no notice", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, trustedTrip(1));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    let offset = 0;
    const lines: string[] = [];
    const b = await session(devices[1]!, mesh, relay, { name: "b", now: () => Date.now() + offset, log: (l) => void lines.push(l) });
    for (const t of ["1", "2", "3", "4"]) {
      await a.send("b@two", t);
      await until(async () => (await msgs(b)).length + (await b.held.list()).length === Number(t));
    }
    const box = b.held as unknown as { list: () => Promise<Array<{ id: string; entry: { text: string } }>> };
    const list = box.list.bind(b.held);
    let reached!: () => void;
    const inRelease = new Promise<void>((r) => (reached = r));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let armed = true;
    box.list = async () => {
      const caller = new Error().stack ?? "";
      const out = await list();
      if (armed && caller.includes("MeshSession.autoRelease")) {
        armed = false;
        reached();
        await gate;
      }
      return out;
    };
    offset += 61_000;
    await inRelease;
    // The person refuses "3" (a mark applied by another pass, or the VS Code view) meanwhile: the
    // decision waits for the release on the inbound queue, and neither disturbs the other.
    const three = (await list()).find((h) => h.entry.text === "3")!;
    let refused = false;
    const refusing = b.decide(three.id, "refuse").then(() => (refused = true));
    await sleep(100);
    expect(refused, "the decision waits for the release").toBe(false);
    open();
    await refusing;
    // The release delivered "2" (the per-peer limit, 1); "4" waits for the person.
    expect({ held: (await list()).map((h) => h.entry.text), delivered: await msgs(b), errors: lines.filter((l) => /housekeeping|inbound/.test(l)) }).toEqual({ held: ["4"], delivered: ["1", "2"], errors: [] });
  }, 30_000);
});

describe("F7 (continued): a hold in flight when the cool-down ends", () => {
  it("E: the message is handled once: no TypeError, acked, and delivered once after a reconnect", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    // A limit of 2, so the release at the end delivers the one message held.
    await setBreaker(devices[1]!, mesh, trustedTrip(1, { perPeerPerHour: 2 }));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    let offset = 0;
    const lines: string[] = [];
    const b = await session(devices[1]!, mesh, relay, { name: "b", now: () => Date.now() + offset, log: (l) => void lines.push(l) });
    for (const t of ["1", "2"]) await a.send("b@two", t);
    await until(async () => (await msgs(b)).length === 2);
    const box = b.held as unknown as { add: (i: { entry: { text: string } }) => Promise<void> };
    const add = box.add.bind(b.held);
    box.add = async (i) => {
      await add(i as never);
      // "3" trips the pause; its cool-down ends while this hold is still being written. The pass
      // that releases it waits on the inbound queue until this message is handled.
      if (i.entry.text === "3") offset += 61_000;
    };
    await a.send("b@two", "3");
    await until(async () => (await msgs(b)).includes("3"));
    await sleep(300);
    relay.dropAll();
    await sleep(1500);
    expect({ delivered: await msgs(b), errors: lines.filter((l) => /inbound|housekeeping/.test(l)) }).toEqual({ delivered: ["1", "2", "3"], errors: [] });
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
describe("F17: a `wim` CLI older than the plugin's bundled client resumes offline, and the pause comes back", () => {
  it("after 0.1.8's `wim held resume a@one` on a stopped session, the restarted session does not pause a@one again", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, trustedTrip(60));
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const holder = { name: "b", sessionKey: "key:b" };
    let b = await session(devices[1]!, mesh, relay, holder);
    for (const t of ["1", "2"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 1);
    await b.stop();
    // The person's terminal runs the npm/brew `wim` 0.1.8 while the plugin bundles 0.1.9: it
    // releases what was held from the session's files and does not know breaker.json.
    const box = new HeldBox(b.files.heldDir, FS);
    for (const h of await box.list()) await box.remove(h.id);
    expect(await readPauses(b.files.breakerPath, Date.now())).toHaveLength(1);
    b = await session(devices[1]!, mesh, relay, holder);
    expect(b.pausedRows(), "a@one was resumed").toEqual([]);
    // The sender told about it hears it lifted.
    await until(async () => (await pausedByCount(a)) === 0);
  }, 30_000);
});
