// Receipts: recorded in history, a `held` one raised as a notice, and `wim send --wait`, which
// stays connected to print them. What `routed` and `queued` mean is said wherever they show.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ulid } from "@worldinmotion/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { heldWaitLine, PAUSE_GRACE_MS, receiptLine, SENT_MEANING } from "../src/cli.ts";
import { clock as clock_ } from "../src/breaker.ts";
import { heldForAgentLine, heldReceiptLine, MeshSession, RECEIPT_LOOKUPS_MAX, RECEIPTS_MAX, SENT_IDS_MAX } from "../src/client.ts";
import { History, parseReceipt, receiptNote, renderForAgent, renderForPerson, type HistoryEntry } from "../src/history.ts";
import { MeshFiles } from "../src/mesh.ts";
import { SessionFiles, takesSends } from "../src/session.ts";
import type { SpoolItem } from "../src/spool.ts";
import { FS, LIVE_PID, makeMesh, openSession, RelayHarness, run, said, scratch, sessionOpts, sleep, term, until } from "./helpers.ts";

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
      "x@y is holding your message I. It is not delivered now: it reaches that session if its person approves it on that device (/wim in Claude Code, the Held view in VS Code, or `wim held approve I`), or, when its loop breaker holds it for a cool-down, possibly when that ends.",
    );
  });

  it("tells the sending agent once per recipient that its message is held, again only after one got through (issue #42)", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"], { trust: false });
    const a = await openSession(devices[0]!, mesh, relay, { name: "sender" });
    const b = await openSession(devices[1]!, mesh, relay, { name: "inbox" });
    const c = await openSession(devices[2]!, mesh, relay, { name: "other" });
    open.push(a, b, c);
    // A notice for the agent carries none of the flags the plugin keeps from the model.
    const forAgent = async () => (await a.spool.unread()).filter((i) => i.kind === "notice" && i.heldBy === undefined && i.held === undefined && i.forPerson === undefined);
    const first = await a.send("inbox@two", "one");
    await a.send("inbox@two", "two");
    await a.send("other@three", "three");
    // The agent's notice is written after the person's for the same receipt, outside the inbound queue.
    await until(async () => (await a.spool.unread()).filter((i) => i.heldBy !== undefined).length === 3 && (await forAgent()).length === 2);
    // Nothing more comes for the second hold at inbox@two.
    await sleep(200);
    const told = await forAgent();
    expect(told.map((n) => n.from).sort()).toEqual(["inbox@two", "other@three"]);
    expect(told.find((n) => n.from === "inbox@two")!.rendered).toBe(
      `worldinmotion notice (from the local client, not from a peer or the person): ${heldForAgentLine("inbox@two", first.id)}`,
    );
    expect(heldForAgentLine("x@y", "I")).toBe(
      "x@y is holding your message I: it is not delivered now. It gets through if the person on that device approves it, or, when that device's loop breaker holds it for a cool-down, possibly when the cool-down ends (a notice says which). Resending will not get it through sooner; if it cannot wait, tell your person.",
    );
    // The person there approves one: it is delivered, and a later hold is news again.
    b.on("item", (i: SpoolItem) => void b.take(i.cursor));
    await b.decide(first.id, "approve");
    await until(async () => (await a.history.receiptsFrom(first.id, 0)).some((r) => r.status === "delivered"));
    const later = await a.send("inbox@two", "four");
    await until(async () => (await forAgent()).length === 3);
    expect((await forAgent()).at(-1)!.rendered).toContain(heldForAgentLine("inbox@two", later.id));
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

describe("a receipt for a message this session did not send", () => {
  /** The private steps a receipt goes through, reached as the relay's frame would reach them. */
  type Inside = { onReceipt(f: { id: string; to: string; status: string }): void; sentIds: Set<string>; noteSentId(id: string): void; receiptLookups: number };
  const inside = (s: MeshSession): Inside => s as unknown as Inside;

  it("from the relay is dropped before it is kept, told or recorded, however many come", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"], { trust: false });
    const logs: string[] = [];
    const a = await openSession(devices[0]!, mesh, relay, { name: "sender", log: (l) => logs.push(l) });
    const b = await openSession(devices[1]!, mesh, relay, { name: "inbox" });
    open.push(a, b);
    const told: string[] = [];
    a.on("receipt", (f: { id: string }) => told.push(f.id));
    // The relay names ids this session never sent, held and delivered by turns: one too old for
    // history, one from the future (spelled out: ulid() never goes back), and one history could hold.
    const forged = [`0000000001${"0".repeat(16)}`, `7ZZZZZZZZZ${"0".repeat(16)}`, ulid()];
    let n = 0;
    relay.toClient = (text) => {
      if (!text.startsWith('{"t":"receipt"')) return text;
      const f = JSON.parse(text) as { id: string };
      return JSON.stringify({ ...f, id: forged[n++ % forged.length] });
    };
    for (const text of ["one", "two", "three"]) await a.send("inbox@two", text);
    await until(() => logs.filter((l) => l.startsWith("wim: dropped a receipt for ")).length === 3);
    for (const id of forged) {
      expect(logs).toContain(`wim: dropped a receipt for ${id}: not a message this session sent`);
      expect(await a.history.receiptsFrom(id, 0)).toEqual([]);
      expect(a.receipts.has(id)).toBe(false);
    }
    expect(told).toEqual([]);
    expect((await a.spool.unread()).filter((i) => i.kind === "notice")).toEqual([]);
  });

  it("is looked up in history a few at a time; more at once are dropped", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const logs: string[] = [];
    const a = await openSession(devices[0]!, mesh, relay, { name: "sender", log: (l) => logs.push(l) });
    open.push(a);
    let lookups = 0;
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    a.history.find = async () => {
      lookups++;
      await gate;
      return undefined;
    };
    const ids = Array.from({ length: RECEIPT_LOOKUPS_MAX + 2 }, (_, k) => ulid(Date.now() - 1000 - k));
    for (const id of ids) inside(a).onReceipt({ id, to: "x@two", status: "held" });
    expect(lookups).toBe(RECEIPT_LOOKUPS_MAX);
    expect(logs.filter((l) => l.endsWith(": too many receipts for unknown messages at once"))).toHaveLength(2);
    finish();
    await until(() => inside(a).receiptLookups === 0);
    expect(logs.filter((l) => l.endsWith(": not a message this session sent"))).toHaveLength(RECEIPT_LOOKUPS_MAX);
    // A lookup that fails is logged and frees its place.
    a.history.find = () => Promise.reject(new Error("unreadable"));
    inside(a).onReceipt({ id: ulid(Date.now()), to: "x@two", status: "held" });
    await until(() => logs.includes("wim: receipt: unreadable"));
    await until(() => inside(a).receiptLookups === 0);
  });

  it("is still taken for a message history says this session sent before a restart", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"], { trust: false });
    const a = await openSession(devices[0]!, mesh, relay, { name: "sender" });
    const b = await openSession(devices[1]!, mesh, relay, { name: "inbox" });
    open.push(a, b);
    const sent = await a.send("inbox@two", "hello");
    await until(async () => (await a.history.receiptsFrom(sent.id, 0)).length === 1);
    // As a new process: it knows its earlier sends from history only.
    inside(a).sentIds.clear();
    const told: string[] = [];
    a.on("receipt", (f: { status: string }) => told.push(f.status));
    inside(a).onReceipt({ id: sent.id, to: "inbox@two", status: "delivered" });
    await until(async () => (await a.history.receiptsFrom(sent.id, 0)).length === 2);
    expect((await a.history.receiptsFrom(sent.id, 0)).map((r) => r.status)).toEqual(["held", "delivered"]);
    expect(told).toEqual(["delivered"]);
    // An id history has as received, not sent, is not this session's either.
    const inbound = ulid(Date.now());
    await a.history.append({ dir: "in", peer: "inbox@two", device: "D", id: inbound, kind: "msg", at: 1, text: "in" });
    inside(a).onReceipt({ id: inbound, to: "inbox@two", status: "held" });
    await until(() => inside(a).receiptLookups === 0);
    expect(await a.history.receiptsFrom(inbound, 0)).toEqual([]);
    expect(told).toEqual(["delivered"]);
  });

  it("is judged against at most SENT_IDS_MAX remembered sends, and RECEIPTS_MAX of them keep their receipts", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const a = await openSession(devices[0]!, mesh, relay, { name: "sender" });
    open.push(a);
    const s = inside(a);
    for (let i = 0; i <= SENT_IDS_MAX; i++) s.noteSentId(`id${i}`);
    expect(s.sentIds.size).toBe(SENT_IDS_MAX);
    expect(s.sentIds.has("id0")).toBe(false);
    // Noted again, an id is the newest: the next one forgets id2, not id1.
    s.noteSentId("id1");
    s.noteSentId("another");
    expect(s.sentIds.has("id1")).toBe(true);
    expect(s.sentIds.has("id2")).toBe(false);
    // Receipts in memory: the newest RECEIPTS_MAX ids, one receipt more making an id the newest.
    a.history.appendReceipt = () => Promise.resolve();
    s.onReceipt({ id: "id3", to: "x@two", status: "routed" });
    for (let i = 4; i < 4 + RECEIPTS_MAX; i++) s.onReceipt({ id: `id${i}`, to: "x@two", status: "routed" });
    expect(a.receipts.has("id3")).toBe(false);
    s.onReceipt({ id: "id4", to: "x@two", status: "delivered" });
    s.onReceipt({ id: "another", to: "x@two", status: "routed" });
    expect(a.receipts.size).toBe(RECEIPTS_MAX);
    expect(a.receipts.get("id4")).toEqual([{ to: "x@two", status: "routed" }, { to: "x@two", status: "delivered" }]);
    expect(a.receipts.has("id5")).toBe(false);
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
    expect(SENT_MEANING).toEqual({
      routed: "handed to a live session; not yet taken or read",
      queued: "that session is offline; the relay keeps it 24 h",
      held: "that session's loop breaker holds this device's messages for now; the line below says until when",
    });
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

  it("--wait says how a held message gets approved, and keeps waiting through the hold", async () => {
    const { t } = await taking(false);
    // Past PAUSE_GRACE_MS: a hold with no pause after it is read as one for the person.
    expect(await run(t, "send", "taker@two", "hi", "--wait", "3s")).toBe(0);
    const id = t.out.find((l) => l.startsWith("id "))!.slice(3);
    const progress = `taker@two: held for the approval of that device's person. It is not delivered until they approve it there: /wim in Claude Code, the Held view in VS Code, or \`wim held approve ${id}\`. Still waiting for it to be delivered...`;
    // Said once, however many times the wait looks again, then where the wait ended.
    expect(t.out.filter((l) => l === progress)).toHaveLength(1);
    expect(t.out.at(-1)).toBe("taker@two: still held for the approval of that device's person when the wait ended, so not delivered yet");
  });

  /** b@two trips on one@'s second message an hour; a trusted device's pause is a cool-down of a minute. */
  async function coolingDown() {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const limits = { perPeerPerHour: 1, totalPerHour: 50, pingPong: false, pingPongExchanges: 8, cooldownMinutes: 1 };
    await new MeshFiles(devices[1]!.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, breaker: limits }));
    const clock = { offset: 0 };
    const b = await openSession(devices[1]!, mesh, relay, { name: "taker", now: () => Date.now() + clock.offset });
    open.push(b);
    b.on("item", (i: SpoolItem) => void b.take(i.cursor));
    const t = term(devices[0]!.root, relay);
    expect(await run(t, "send", "taker@two", "first", "--wait", "10s")).toBe(0);
    expect(t.out.at(-1)).toBe("taker@two: delivered (the session took it; that does not mean anyone read it)");
    t.out.length = 0;
    return { relay, mesh, devices, b, t, clock };
  }

  it("--wait says a trusted device's cool-down hold is delivered when the cool-down ends, and reports it delivered then", async () => {
    const { b, t, clock } = await coolingDown();
    const sending = run(t, "send", "taker@two", "second", "--wait", "1m");
    await until(() => t.out.some((l) => l.endsWith("Still waiting for it to be delivered...")), 10_000);
    const id = t.out.find((l) => l.startsWith("id "))!.slice(3);
    const until1 = (await b.held.list())[0]!.pause!.until;
    const progress = t.out.find((l) => l.endsWith("Still waiting for it to be delivered..."))!;
    // The line a held send row prints, not "held for the approval of that device's person".
    expect(progress).toBe(
      `taker@two: held there, not delivered: its loop breaker paused this device on the per-peer limit: 2 messages from this device in 60 minutes, limit 1; at ${clock_(until1)} its client delivers by itself up to its per-peer limit of what it held, and the rest waits for its person. Sending more now only adds to what it holds. Its person can approve it sooner: /wim in Claude Code, the Held view in VS Code, or \`wim held approve ${id}\`. Still waiting for it to be delivered...`,
    );
    expect(said(t)).not.toContain("held for the approval of that device's person");
    // The cool-down ends: b releases it by itself, and the wait ends on its delivered receipt.
    clock.offset += 61_000;
    expect(await sending).toBe(0);
    expect(t.out.at(-1)).toBe("taker@two: delivered (the session took it; that does not mean anyone read it)");
  }, 30_000);

  it("--wait that ends during a cool-down says when it ends, not that the person must approve", async () => {
    const { b, t } = await coolingDown();
    expect(await run(t, "send", "taker@two", "second", "--wait", "4s")).toBe(0);
    const until1 = (await b.held.list())[0]!.pause!.until;
    expect(t.out.at(-1)).toBe(
      `taker@two: held there, not delivered: its loop breaker paused this device on the per-peer limit: 2 messages from this device in 60 minutes, limit 1; at ${clock_(until1)} its client delivers by itself up to its per-peer limit of what it held, and the rest waits for its person. Sending more now only adds to what it holds. The wait ended first, so it is not delivered yet.`,
    );
  }, 30_000);

  it("heldWaitLine: a pause that waits for the person says so, and no pause is a hold for the person", () => {
    const until1 = Date.UTC(2026, 10, 6, 9, 30);
    expect(heldWaitLine("b@two", "ID", { rule: "peer", count: 2, limit: 1, minutes: 60, until: until1, auto: false })).toBe(
      "b@two: held there, not delivered: its loop breaker paused this device on the per-peer limit: 2 messages from this device in 60 minutes, limit 1; what it holds waits for its person (the pause itself lifts at 2026-11-06T09:30:00Z). Sending more now only adds to what it holds. Its person can approve it sooner: /wim in Claude Code, the Held view in VS Code, or `wim held approve ID`",
    );
    expect(heldWaitLine("b@two", "ID", undefined)).toBe(receiptLine("b@two", "held", "ID"));
    expect(PAUSE_GRACE_MS).toBe(2000);
  });

  it("--wait reports delivered once the person there approves a held message", async () => {
    const { t, b } = await taking(false);
    const sending = run(t, "send", "taker@two", "approve me", "--wait", "30s");
    await until(() => t.out.some((l) => l.endsWith("Still waiting for it to be delivered...")), 5000);
    const id = t.out.find((l) => l.startsWith("id "))!.slice(3);
    await b.decide(id, "approve");
    expect(await sending).toBe(0);
    expect(t.out.at(-1)).toBe("taker@two: delivered (the session took it; that does not mean anyone read it)");
    expect(await run(t, "history", "--session", "cli")).toBe(0);
    expect(said(t)).toMatch(/-> taker@two msg \[receipts: taker@two held, taker@two delivered\]: approve me/);
  });

  it("--wait fails when the person there refuses a held message", async () => {
    const { t, b } = await taking(false);
    const sending = run(t, "send", "taker@two", "refuse me", "--wait", "30s");
    await until(() => t.out.some((l) => l.endsWith("Still waiting for it to be delivered...")), 5000);
    await b.decide(t.out.find((l) => l.startsWith("id "))!.slice(3), "refuse");
    expect(await sending).toBe(1);
    expect(t.out.at(-1)).toBe("taker@two: refused by that device's inbound policy");
  });

  it("--wait waits for every recipient until each receipt is final", async () => {
    const { relay, mesh, devices, b } = await taking(false);
    const other = await openSession(devices[1]!, mesh, relay, { name: "other" });
    open.push(other);
    other.on("item", (i: SpoolItem) => void other.take(i.cursor));
    const t = term(devices[0]!.root, relay);
    let done = false;
    const sending = run(t, "send", "taker@two,other@two", "both", "--wait", "30s").finally(() => (done = true));
    await until(() => t.out.filter((l) => l.endsWith("Still waiting for it to be delivered...")).length === 2, 5000);
    const id = t.out.find((l) => l.startsWith("id "))!.slice(3);
    // One approved, so delivered; the wait goes on for the other, which its person then refuses.
    await b.decide(id, "approve");
    await sleep(500);
    expect(done).toBe(false);
    await other.decide(id, "refuse");
    expect(await sending).toBe(1);
    expect(t.out.slice(-2)).toEqual(["taker@two: delivered (the session took it; that does not mean anyone read it)", "other@two: refused by that device's inbound policy"]);
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
