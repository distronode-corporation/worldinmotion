// A held item goes to the spool before it leaves held/ (#76): a process that stops in between, on
// any path that releases a held item (the person's approve, a resume, a cool-down's release, an
// approve at the command line while no process runs the session), loses nothing, and the next
// process never delivers it to the agent a second time.

import { afterEach, describe, expect, it } from "vitest";
import type { MeshSession } from "../src/client.ts";
import { HeldBox } from "../src/held.ts";
import { MeshFiles, type BreakerLimits } from "../src/mesh.ts";
import { decideHeld } from "../src/offline.ts";
import type { SpoolItem } from "../src/spool.ts";
import { FS, makeMesh, openSession, RelayHarness, until, type TestDevice } from "./helpers.ts";

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
const msgs = async (s: MeshSession): Promise<string[]> => (await unread(s)).filter((i) => i.kind === "msg").map((i) => /\n(\d+)\n/.exec(i.rendered)?.[1] ?? "?");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const crash = (): Error => Object.assign(new Error("the process stopped here"), { code: "ECRASH" });

async function setBreaker(d: TestDevice, mesh: string, breaker: BreakerLimits): Promise<void> {
  await new MeshFiles(d.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, breaker }));
}

/** a@one sends "1" and "2" to b@two, whose breaker holds "2" (an hour-long cool-down unless `minutes`). */
async function heldTwo(minutes = 60) {
  const relay = new RelayHarness();
  const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
  await setBreaker(devices[1]!, mesh, { perPeerPerHour: 1, totalPerHour: 50, pingPong: false, pingPongExchanges: 8, cooldownMinutes: minutes });
  const a = await session(devices[0]!, mesh, relay, { name: "a" });
  let offset = 0;
  const holder = { name: "b", sessionKey: "key:b", now: () => Date.now() + offset };
  const b = await session(devices[1]!, mesh, relay, holder);
  for (const t of ["1", "2"]) await a.send("b@two", t);
  await until(async () => (await b.held.list()).length === 1);
  const id = (await b.held.list())[0]!.id;
  return { relay, mesh, devices, a, b, id, holder, move: (ms: number) => void (offset += ms) };
}

/** Stops `b` (as the crash left it) and opens the same session again. */
async function restart(b: MeshSession, d: TestDevice, mesh: string, relay: RelayHarness, holder: Record<string, unknown>): Promise<MeshSession> {
  await b.stop().catch(() => undefined);
  return session(d, mesh, relay, holder);
}

describe("a stop between the spool and held/", () => {
  it("after the item is marked delivered: the next process takes it out of held/, and the agent gets it once", async () => {
    const { relay, mesh, devices, b, id, holder } = await heldTwo();
    // The person approves "2"; the process stops once it is in the spool and marked, before held/.
    const box = b.held as unknown as { settle: (id: string) => Promise<void> };
    box.settle = () => Promise.reject(crash());
    await expect(b.decide(id, "approve")).rejects.toThrow(/stopped here/);
    expect(await msgs(b)).toEqual(["1", "2"]);
    expect(await new HeldBox(b.files.heldDir, FS).wasDelivered(id)).toBe(true);
    const again = await restart(b, devices[1]!, mesh, relay, holder);
    expect(await again.held.list()).toEqual([]);
    expect(await new HeldBox(again.files.heldDir, FS).deliveredMarks()).toEqual([]);
    await sleep(200);
    expect(await msgs(again)).toEqual(["1", "2"]);
  }, 30_000);

  it("before the mark: the item is in the spool, which the next process reads, and it is not delivered again", async () => {
    const { relay, mesh, devices, b, id, holder } = await heldTwo();
    const box = b.held as unknown as { markDelivered: (id: string) => Promise<void> };
    box.markDelivered = () => Promise.reject(crash());
    await expect(b.decide(id, "approve")).rejects.toThrow(/stopped here/);
    expect((await b.held.list()).map((h) => h.id)).toEqual([id]);
    const again = await restart(b, devices[1]!, mesh, relay, holder);
    expect(await again.held.list()).toEqual([]);
    // A resume of the device now finds nothing held, so nothing goes to the agent twice.
    expect(await again.resumePeer("a@one")).toBe(0);
    expect(await msgs(again)).toEqual(["1", "2"]);
  }, 30_000);

  it("in a cool-down's release: the release that stopped is not delivered again by the next process", async () => {
    const { relay, mesh, devices, b, id, holder, move } = await heldTwo(1);
    const box = b.held as unknown as { settle: (id: string) => Promise<void> };
    box.settle = () => Promise.reject(crash());
    move(61_000);
    await until(async () => (await msgs(b)).includes("2"));
    const again = await restart(b, devices[1]!, mesh, relay, { ...holder, now: () => Date.now() + 61_000 });
    expect(await again.held.list()).toEqual([]);
    await sleep(200);
    expect(await msgs(again)).toEqual(["1", "2"]);
    expect(await new HeldBox(again.files.heldDir, FS).wasDelivered(id)).toBe(false);
  }, 30_000);

  it("when the item is marked delivered and still held, an approve only takes it out of held/", async () => {
    const { b, id } = await heldTwo();
    await new HeldBox(b.files.heldDir, FS).markDelivered(id);
    await b.decide(id, "approve");
    expect(await b.held.list()).toEqual([]);
    expect(await msgs(b)).toEqual(["1"]);
  }, 30_000);

  it("a delivered mark whose entry is gone is cleared when the session opens", async () => {
    const { relay, mesh, devices, b, id, holder } = await heldTwo();
    await b.stop();
    const box = new HeldBox(b.files.heldDir, FS);
    await box.remove(id);
    await box.markDelivered(id);
    const again = await session(devices[1]!, mesh, relay, holder);
    expect(await new HeldBox(again.files.heldDir, FS).deliveredMarks()).toEqual([]);
    expect(await msgs(again)).toEqual(["1"]);
  }, 30_000);

  it("at the command line, while no process runs the session: written before it leaves held/, and settled by the next process", async () => {
    const { relay, mesh, devices, b, id, holder } = await heldTwo();
    await b.stop();
    // `wim held approve` stops right after writing the spool: it is still in held/ and marked.
    const files = new MeshFiles(devices[1]!.home.meshDir(mesh), FS);
    const box = HeldBox.prototype as unknown as { settle: (id: string) => Promise<void> };
    const settle = box.settle;
    box.settle = () => Promise.reject(crash());
    try {
      await expect(decideHeld(files, id, "approve", FS, Date.now)).rejects.toThrow(/stopped here/);
    } finally {
      box.settle = settle;
    }
    expect((await new HeldBox(b.files.heldDir, FS).list()).map((h) => h.id)).toEqual([id]);
    const again = await session(devices[1]!, mesh, relay, holder);
    expect(await again.held.list()).toEqual([]);
    expect(await msgs(again)).toEqual(["1", "2"]);
  }, 30_000);
});
