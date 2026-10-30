// Receipts: recorded in history, a `held` one raised as a notice, and `wim send --wait`, which
// stays connected to print them. What `routed` and `queued` mean is said wherever they show.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ulid } from "@worldinmotion/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { receiptLine, SENT_MEANING } from "../src/cli.ts";
import { heldReceiptLine, MeshSession } from "../src/client.ts";
import { History, parseReceipt, receiptNote, renderForAgent, renderForPerson, type HistoryEntry } from "../src/history.ts";
import { MeshFiles } from "../src/mesh.ts";
import { SessionFiles, takesSends } from "../src/session.ts";
import type { SpoolItem } from "../src/spool.ts";
import { FS, LIVE_PID, makeMesh, openSession, RelayHarness, run, said, scratch, sessionOpts, term, until } from "./helpers.ts";

const open: Array<{ stop(): Promise<unknown> }> = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

const out = (i: number, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({ dir: "out", peer: "b@two", id: ulid(i), kind: "msg", at: i, text: `m${i}`, ...extra });

describe("receipts in history", () => {
  it("are lines of their own, matched to the sent entry whichever was written first", async () => {
    const h = new History(join(await scratch("rcpt"), "history.jsonl"), () => 0);
    const [a, b, c] = [out(1), out(2), out(3, { peer: "c@three" })];
    // b's receipt came while b was still being recorded: it is written before b.
    await h.append(a);
    await h.appendReceipt(a.id, { to: "b@two", status: "held", at: 10 });
    await h.appendReceipt(b.id, { to: "b@two", status: "delivered", at: 11 });
    await h.append(b);
    await h.appendReceipt(b.id, { to: "b@two", status: "refused", at: 12 });
    const inbound: HistoryEntry = { dir: "in", peer: "b@two", device: "D", id: ulid(4), kind: "msg", at: 4, text: "in" };
    await h.append(inbound);
    await h.append(c);
    await h.appendReceipt(a.id, { to: "b@two", status: "delivered", at: 13 });
    await fs.appendFile(h.path, `${JSON.stringify({ t: "receipt", id: a.id, to: "b@two" })}\nnot json\n`);

    const plain = await h.query();
    expect(plain.map((e) => e.id)).toEqual([a.id, b.id, inbound.id, c.id]);
    expect(plain.every((e) => e.receipts === undefined)).toBe(true);
    const withReceipts = await h.query({ receipts: true });
    expect(withReceipts.map((e) => e.receipts?.map((r) => r.status))).toEqual([["held", "delivered"], ["delivered", "refused"], undefined, []]);
    expect(await h.receiptsFrom(a.id, 0)).toEqual([
      { to: "b@two", status: "held", at: 10 },
      { to: "b@two", status: "delivered", at: 13 },
    ]);
    expect(await h.receiptsFrom(ulid(99), 0)).toEqual([]);
    expect(await h.find(b.id)).toEqual(b);
    // The receipt lines never count as entries against a limit.
    expect((await h.query({ limit: 2, receipts: true })).map((e) => e.id)).toEqual([inbound.id, c.id]);
  });

  it("are read from a point on, which a rotation resets, with a line still being written left for later", async () => {
    const h = new History(join(await scratch("rcptfrom"), "history.jsonl"), () => 0);
    expect(await h.size()).toBe(0);
    expect(await h.receiptsFrom("I", 0)).toEqual([]);
    await h.appendReceipt("I", { to: "b@two", status: "held", at: 1 });
    const from = await h.size();
    expect(from).toBeGreaterThan(0);
    // Written after `from`, before the entry it is for: still found.
    await h.appendReceipt("I", { to: "b@two", status: "delivered", at: 2 });
    await h.append(out(3, { id: "I" }));
    await fs.appendFile(h.path, '{"t":"receipt","id":"I","to":"c@thr');
    expect(await h.receiptsFrom("I", from)).toEqual([{ to: "b@two", status: "delivered", at: 2 }]);
    await fs.appendFile(h.path, 'ee","status":"held","at":4}\n');
    expect((await h.receiptsFrom("I", from)).map((r) => r.to)).toEqual(["b@two", "c@three"]);
    // Rotated meanwhile: the new file is shorter than `from`, so it is read whole.
    await fs.writeFile(h.path, `${JSON.stringify({ t: "receipt", id: "I", to: "d@four", status: "refused", at: 5 })}\n`);
    expect(await h.receiptsFrom("I", from + 1000)).toEqual([{ to: "d@four", status: "refused", at: 5 }]);
  });

  it("parse only well-formed receipt lines", () => {
    const good = { t: "receipt", id: "I", to: "b@two", status: "held", at: 1 };
    expect(parseReceipt(JSON.stringify(good))).toEqual(good);
    for (const bad of ["not json", "null", "3", JSON.stringify({ ...good, t: "x" }), JSON.stringify({ ...good, id: 1 }), JSON.stringify({ ...good, to: 1 }), JSON.stringify({ ...good, status: 1 }), JSON.stringify({ ...good, at: "1" })]) {
      expect(parseReceipt(bad)).toBeUndefined();
    }
  });

  it("are shown with what was sent, never as proof it was read", () => {
    const e = out(5);
    expect(receiptNote([])).toBe("no receipt recorded");
    expect(receiptNote([{ to: "b@two", status: "held", at: 1 }, { to: "c@\u0007", status: "delivered", at: 2 }])).toBe("receipts: b@two held, c@<U+0007> delivered");
    expect(renderForAgent({ ...e, receipts: [] })).toMatch(/^\(history: you sent a msg to b@two at .*, id .{26}; no receipt recorded\)\nm5$/);
    expect(renderForAgent({ ...e, receipts: [{ to: "b@two", status: "delivered", at: 1 }] })).toContain("; receipts: b@two delivered)");
    expect(renderForAgent(e)).toMatch(/, id .{26}\)\n/);
    expect(renderForPerson({ ...e, receipts: [{ to: "b@two", status: "held", at: 1 }] })).toMatch(/-> b@two msg \[receipts: b@two held\]: m5$/);
    expect(renderForPerson(e)).toMatch(/-> b@two msg: m5$/);
  });
});

describe("a session's receipts", () => {
  it("are recorded, and a held one becomes a notice naming who holds it", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"], { trust: false });
    const a = await openSession(devices[0]!, mesh, relay, { name: "sender" });
    const b = await openSession(devices[1]!, mesh, relay, { name: "inbox" });
    open.push(a, b);
    const sent = await a.send("inbox@two", "hello");
    await until(async () => (await a.history.receiptsFrom(sent.id, 0)).length === 1);
    expect((await a.history.receiptsFrom(sent.id, 0))[0]).toMatchObject({ to: "inbox@two", status: "held" });
    let notices: SpoolItem[] = [];
    await until(async () => (notices = (await a.spool.unread()).filter((i) => i.heldBy !== undefined)).length === 1);
    expect(notices[0]).toMatchObject({ kind: "notice", from: "inbox@two", heldBy: "inbox@two" });
    expect(notices[0]!.rendered).toContain(heldReceiptLine("inbox@two", sent.id));
    expect(heldReceiptLine("x@y", "I")).toBe(
      "x@y is holding your message I for its person's approval. It is not delivered: it reaches that session only if they approve it on that device (/wim in Claude Code, the Held view in VS Code, or `wim held approve I`).",
    );
  });

  it("delivered is recorded with no notice; a failed history write is logged and nothing else", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const logs: string[] = [];
    const a = await openSession(devices[0]!, mesh, relay, { name: "sender", log: (l) => logs.push(l) });
    const b = await openSession(devices[1]!, mesh, relay, { name: "taker" });
    open.push(a, b);
    b.on("item", (i: SpoolItem) => void b.take(i.cursor));
    const sent = await a.send("taker@two", "hi");
    await until(async () => (await a.history.query({ receipts: true })).some((e) => e.receipts?.some((r) => r.status === "delivered")));
    expect((await a.spool.unread()).filter((i) => i.heldBy !== undefined)).toEqual([]);
    expect((await a.history.query({ receipts: true })).find((e) => e.id === sent.id)!.receipts).toEqual([expect.objectContaining({ to: "taker@two", status: "delivered" })]);
    // A receipt that cannot be recorded (a full disk, say) only costs the record.
    a.history.appendReceipt = () => Promise.reject(new Error("disk full"));
    const second = await a.send("taker@two", "again");
    await until(() => logs.includes("wim: receipt: disk full"));
    expect(a.receipts.get(second.id)).toEqual([{ to: "taker@two", status: "delivered" }]);
  });
});

describe("wim send", () => {
  /** A trusted mesh where `taker@two` takes everything it gets, and a terminal on device one. */
  async function taking(trust = true) {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"], { trust });
    const b = await openSession(devices[1]!, mesh, relay, { name: "taker" });
    open.push(b);
    b.on("item", (i: SpoolItem) => void b.take(i.cursor));
    return { relay, mesh, devices, b, t: term(devices[0]!.root, relay) };
  }

  it("says what routed and queued mean, and that neither is read", async () => {
    const { t } = await taking();
    expect(await run(t, "send", "taker@two", "hi")).toBe(0);
    expect(t.out).toContain(`taker@two: routed (${SENT_MEANING["routed"]})`);
    expect(t.out).toContain("Neither routed nor queued means it was read. `wim send --wait 30s` waits for each recipient's receipt.");
    expect(SENT_MEANING).toEqual({ routed: "handed to a live session; not yet taken or read", queued: "that session is offline; the relay keeps it 24 h" });
  });

  it("--wait stays connected and prints the receipt", async () => {
    const { t } = await taking();
    expect(await run(t, "send", "taker@two", "hi", "--wait", "10s")).toBe(0);
    expect(t.out).toContain("Waiting up to 10s for receipts (Ctrl-C stops waiting; the message stays sent)...");
    expect(t.out.at(-1)).toBe("taker@two: delivered (the session took it; that does not mean anyone read it)");
    expect(t.out).not.toContain("Neither routed nor queued means it was read. `wim send --wait 30s` waits for each recipient's receipt.");
    // The CLI session recorded the receipt in its history while it waited.
    expect(await run(t, "history", "--session", "cli")).toBe(0);
    expect(said(t)).toMatch(/-> taker@two msg \[receipts: taker@two delivered\]: hi/);
  });

  it("--wait says how a held message gets approved", async () => {
    const { t } = await taking(false);
    expect(await run(t, "send", "taker@two", "hi", "--wait", "10s")).toBe(0);
    const id = t.out.find((l) => l.startsWith("id "))!.slice(3);
    expect(t.out.at(-1)).toBe(`taker@two: held for the approval of that device's person. It is not delivered until they approve it there: /wim in Claude Code, the Held view in VS Code, or \`wim held approve ${id}\``);
  });

  it("--wait fails on a refused or expired receipt", async () => {
    for (const status of ["refused", "expired"]) {
      const { relay, t } = await taking();
      relay.toClient = (text) => (text.startsWith('{"t":"receipt"') ? text.replace('"delivered"', `"${status}"`) : text);
      expect(await run(t, "send", "taker@two", "hi", "--wait", "10s")).toBe(1);
      expect(t.out.at(-1)).toBe(status === "refused" ? "taker@two: refused by that device's inbound policy" : "taker@two: expired (no session took it within 24 hours)");
    }
  });

  it("--wait gives up after its time, or on Ctrl-C, saying what is known", async () => {
    const { relay, mesh, devices } = await taking();
    const gone = await openSession(devices[1]!, mesh, relay, { name: "away" });
    await gone.stop();
    const t = term(devices[0]!.root, relay);
    expect(await run(t, "send", "away@two", "hi", "--wait", "60ms")).toBe(0);
    expect(t.out.at(-1)).toBe(`away@two: no receipt yet (still queued: ${SENT_MEANING["queued"]})`);
    const stopped = term(devices[0]!.root, relay);
    stopped.stop.abort();
    expect(await run(stopped, "send", "away@two", "hi", "--wait", "1h")).toBe(0);
    expect(stopped.out.at(-1)).toMatch(/^away@two: no receipt yet \(still queued/);
  });

  it("--wait does not wait when nothing was accepted, and takes 1ms to 1h", async () => {
    const { t } = await taking();
    expect(await run(t, "send", "nobody@two", "hi", "--wait", "10s")).toBe(1);
    expect(said(t)).not.toContain("Waiting up to");
    for (const bad of ["0", "2h", "soon"]) {
      const b = term(t.io.homedir, new RelayHarness());
      expect(await run(b, "send", "taker@two", "hi", "--wait", bad)).toBe(1);
      expect(said(b)).toMatch(bad === "soon" ? /not a duration: soon/ : /--wait takes a duration from 1ms to 1h, such as 30s/);
    }
  });

  it("--wait through a running wim watch reads the receipt from the watch's history", async () => {
    const { relay, mesh, devices } = await taking();
    const w = await MeshSession.open({ ...sessionOpts(devices[0]!, mesh, relay, { name: "cli", kind: "cli", handover: true, env: { ...FS, pid: LIVE_PID } }), sessionKey: "cli:cli" });
    open.push(w);
    w.start();
    await w.ready(3000);
    const t = term(devices[0]!.root, relay);
    expect(await run(t, "send", "taker@two", "via the watch", "--wait", "10s")).toBe(0);
    expect(t.out.at(-1)).toBe("taker@two: delivered (the session took it; that does not mean anyone read it)");
    expect((await w.history.query({ receipts: true })).at(-1)).toMatchObject({ text: "via the watch", receipts: [expect.objectContaining({ status: "delivered" })] });
  });

  it("prints a receipt status it does not know as it is", () => {
    expect(receiptLine("b@two", "read\u0007", "I")).toBe("b@two: read<U+0007>");
  });
});

describe("a name held by wim send --wait", () => {
  it("is not taken for a watch: a second send goes on its own, watch and inbox say the name is busy", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    // Online, and takes nothing, so the first send waits for its receipt until it is stopped.
    open.push(await openSession(devices[1]!, mesh, relay, { name: "slow" }));
    // In "another process" (a live pid that is not this one), as a second terminal would be.
    const first = term(devices[0]!.root, relay, { pid: LIVE_PID });
    const waiting = run(first, "send", "slow@two", "first", "--wait", "1h");
    await until(() => first.out.includes("Waiting up to 1h for receipts (Ctrl-C stops waiting; the message stays sent)..."), undefined, "the first send to wait");

    // A short handover wait: a send wrongly handed to the waiting command would fail fast, not pass.
    const second = term(devices[0]!.root, relay, { handoverMs: 100 });
    expect(await run(second, "send", "slow@two", "second")).toBe(0);
    expect(second.out).toContain(`slow@two: routed (${SENT_MEANING["routed"]})`);
    expect(said(second)).not.toMatch(/did not take|did not report back/);
    const busy = "cli is busy with another wim command on this device (a `wim send --wait`, say): try again when it ends, or use --as <name>";
    const watch = term(devices[0]!.root, relay);
    expect(await run(watch, "watch")).toBe(1);
    expect(said(watch)).toBe(`wim: ${busy}`);
    const inbox = term(devices[0]!.root, relay);
    expect(await run(inbox, "inbox")).toBe(3);
    expect(inbox.out).toEqual([`${busy}.`]);

    first.stop.abort();
    expect(await waiting).toBe(0);
    expect(first.out.at(-1)).toMatch(/^slow@two: no receipt yet \(still routed/);
  });
});

describe("the handover marker", () => {
  it("names the live holder that takes sends; a marker left by another pid does not count", async () => {
    const mesh = new MeshFiles(await scratch("handover"), FS);
    const sid = ulid();
    // The holder is "another process" (a live pid that is not this one); this process looks.
    const holder = new SessionFiles(mesh, sid, { ...FS, pid: LIVE_PID });
    const looker = new SessionFiles(mesh, sid, FS);
    expect(await looker.takesHandoverElsewhere()).toBe(false);
    expect(await holder.claim()).toBe(true);
    expect(await looker.takesHandoverElsewhere()).toBe(false);
    await holder.markHandover(true);
    expect(await fs.readFile(holder.handoverPath, "utf8")).toBe(String(LIVE_PID));
    expect(await looker.takesHandoverElsewhere()).toBe(true);
    // A watch that died left its file; the name's next holder is another process.
    await fs.writeFile(holder.handoverPath, "999999999");
    expect(await looker.takesHandoverElsewhere()).toBe(false);
    await holder.markHandover(false);
    await expect(fs.stat(holder.handoverPath)).rejects.toMatchObject({ code: "ENOENT" });
    await holder.markHandover(false);
    expect(takesSends(true, "7", undefined)).toBe(false);
    expect(takesSends(true, "7\n", "7")).toBe(true);
    expect(takesSends(false, "7", "7")).toBe(false);
  });
});
