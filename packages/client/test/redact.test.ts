// A session that keeps no message text (`redactStoredText`, used by `wim worker`): whatever
// arrives, delivered, held for the person or refused by the loop breaker, its text (a wake code,
// a task) is never written in plaintext anywhere under the device's home, while ids, history
// entries and receipts still are.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BREAKER_REFUSED, REDACTED_TEXT, type Inbound, type MeshSession } from "../src/client.ts";
import { HeldBox } from "../src/held.ts";
import { History } from "../src/history.ts";
import { MeshFiles, type BreakerLimits } from "../src/mesh.ts";
import { SessionFiles } from "../src/session.ts";
import { verifyObject } from "@worldinmotion/protocol";
import { FS, keysOf, makeMesh, openSession, RelayHarness, until, type TestDevice } from "./helpers.ts";

const open: MeshSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

async function session(...args: Parameters<typeof openSession>): Promise<MeshSession> {
  const s = await openSession(...args);
  open.push(s);
  return s;
}

/** Every file under `dir` whose bytes contain `needle`. */
async function filesHolding(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      // A file renamed away between the listing and the read (an atomic write's temporary) holds nothing.
      else if (e.isFile() && (await fs.readFile(p).catch((err: NodeJS.ErrnoException) => (err.code === "ENOENT" ? Buffer.alloc(0) : Promise.reject(err)))).includes(needle)) hits.push(p);
    }
  };
  await walk(dir);
  return hits;
}

const CODE = "Zq7wakeCODEx91";
const TASK = "summarise the open pull requests";

async function setup(redact: boolean) {
  const relay = new RelayHarness();
  const { mesh, devices } = await makeMesh(relay, ["worker", "laptop"]);
  const [w, l] = devices as [TestDevice, TestDevice];
  const worker = await session(w, mesh, relay, { name: "agents", kind: "worker", ...(redact ? { redactStoredText: true } : {}) });
  const user = await session(l, mesh, relay, { name: "me" });
  const got: Inbound[] = [];
  worker.on("message", (m: Inbound) => {
    got.push(m);
    void worker.take(m.cursor);
  });
  return { relay, mesh, w, l, worker, user, got };
}

describe("redactStoredText", () => {
  it("without it, the text is on disk (the search below would find a leak)", async () => {
    const { w, user, got } = await setup(false);
    await user.send("agents@worker", `${CODE} ${TASK}`);
    await until(() => got.length === 1);
    await until(async () => (await filesHolding(w.root, CODE)).length > 0);
  });

  it("hands the text to consumers in this process and writes none of it", async () => {
    const { w, mesh, worker, user, got } = await setup(true);
    const items: string[] = [];
    worker.on("item", (i: { rendered: string }) => items.push(i.rendered));
    await user.send("agents@worker", `${CODE} ${TASK}`, { kind: "task" });
    await until(() => got.length === 1);
    expect(got[0]!.text).toBe(`${CODE} ${TASK}`);
    expect(items[0]).toContain(CODE);
    await until(async () => (await worker.spool.unread()).length === 0);
    const history = await new History(new SessionFiles(new MeshFiles(w.home.meshDir(mesh), FS), worker.sid, FS).historyPath, Date.now).query();
    const entry = history.find((e) => e.id === got[0]!.id)!;
    expect(entry).toMatchObject({ dir: "in", kind: "task", text: "", redacted: true, device: got[0]!.device });
    expect(await filesHolding(w.root, CODE)).toEqual([]);
    expect(await filesHolding(w.root, TASK)).toEqual([]);
  });

  it("an item spooled for the inbox carries the placeholder, not the frame", async () => {
    const { w, worker, user } = await setup(true);
    worker.removeAllListeners("message");
    await user.send("agents@worker", `${CODE} ${TASK}`);
    await until(async () => (await worker.spool.unread()).length === 1);
    expect((await worker.spool.unread())[0]!.rendered).toBe(REDACTED_TEXT);
    expect(await filesHolding(w.root, CODE)).toEqual([]);
  });

  it("refuses what the loop breaker would hold, tells the sender once, and keeps no text", async () => {
    const { w, l, mesh, worker, user, got } = await setup(true);
    const trip: BreakerLimits = { perPeerPerHour: 1, totalPerHour: 50, pingPong: false, pingPongExchanges: 8, cooldownMinutes: 60 };
    await new MeshFiles(w.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, breaker: trip }));
    // The reply is relayed, so the sender's side delivers it only from a device trusted for that.
    await new MeshFiles(l.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, policy: { ...c.policy, [w.device.id]: "deliver-relayed" } }));
    for (const n of [1, 2, 3]) await user.send("agents@worker", `${CODE} ${TASK} ${n}`);
    await until(async () => (await user.spool.unread()).some((i) => i.rendered.includes("busy: too many")));
    const replies = (await user.spool.unread()).filter((i) => i.rendered.includes("busy: too many"));
    expect(replies).toHaveLength(1);
    expect(replies[0]!.relayed).toBe(true);
    expect(BREAKER_REFUSED).toContain("resend later");
    expect(got).toHaveLength(1);
    expect(await new HeldBox(new SessionFiles(new MeshFiles(w.home.meshDir(mesh), FS), worker.sid, FS).heldDir, FS).list()).toEqual([]);
    expect(await filesHolding(w.root, CODE)).toEqual([]);
    expect(await filesHolding(w.root, TASK)).toEqual([]);
  });

  it("holds an untrusted device's item for the person with its metadata only", async () => {
    const { w, l, mesh, worker, user, got } = await setup(true);
    await new MeshFiles(w.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, policy: { ...c.policy, [l.device.id]: "hold" } }));
    await user.send("agents@worker", `${CODE} ${TASK}`);
    const box = new HeldBox(new SessionFiles(new MeshFiles(w.home.meshDir(mesh), FS), worker.sid, FS).heldDir, FS);
    await until(async () => (await box.list()).length === 1);
    const [held] = await box.list();
    expect(held).toMatchObject({ device: l.device.id, preview: REDACTED_TEXT, entry: { text: "", redacted: true } });
    expect(got).toEqual([]);
    expect(await filesHolding(w.root, CODE)).toEqual([]);
  });

  it("logs a busy reply that could not be sent", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["worker", "laptop"]);
    const [w, l] = devices as [TestDevice, TestDevice];
    const logs: string[] = [];
    const worker = await session(w, mesh, relay, { name: "agents", redactStoredText: true, log: (line) => logs.push(line) });
    const user = await session(l, mesh, relay, { name: "me" });
    worker.on("message", (m: Inbound) => void worker.take(m.cursor));
    const trip: BreakerLimits = { perPeerPerHour: 1, totalPerHour: 50, pingPong: false, pingPongExchanges: 8, cooldownMinutes: 60 };
    await new MeshFiles(w.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, breaker: trip }));
    vi.spyOn(worker, "send").mockRejectedValue(new Error("relay gone"));
    await user.send("agents@worker", "one");
    await user.send("agents@worker", "two");
    await until(() => logs.some((x) => x.includes("no busy reply sent to me@laptop: relay gone")));
  });

  it("withFrame hands the signed frame to consumers in this process, and only while it is accepted", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["worker", "laptop"]);
    const [w, l] = devices as [TestDevice, TestDevice];
    const worker = await session(w, mesh, relay, { name: "agents", redactStoredText: true, withFrame: true });
    const plain = await session(w, mesh, relay, { name: "plain" });
    const user = await session(l, mesh, relay, { name: "me" });
    const got: Inbound[] = [];
    worker.on("message", (m: Inbound) => got.push(m));
    plain.on("message", (m: Inbound) => got.push(m));
    await user.send("agents@worker", `${CODE} ${TASK}`);
    await user.send("plain@worker", "hello");
    await until(() => got.length === 2);
    const withFrame = got.find((m) => m.text.startsWith(CODE))!;
    expect(withFrame.frame).toMatchObject({ id: withFrame.id, from: { device: l.device.id } });
    // It still verifies after a JSON round trip, which is how a runner receives it.
    const sent = JSON.parse(JSON.stringify(withFrame.frame)) as { sig: string };
    expect(verifyObject("send", sent, keysOf(l.device).signPub)).toBe(true);
    expect(verifyObject("send", { ...sent, at: 1 } as { sig: string }, keysOf(l.device).signPub)).toBe(false);
    expect(got.find((m) => m.text === "hello")!.frame).toBeUndefined();
    expect((worker as unknown as { frames: Map<string, unknown> }).frames.size).toBe(0);
    expect(await filesHolding(w.root, CODE)).toEqual([]);
  });
});
