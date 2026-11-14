// The end of the downgrade window (SPEC section 6b, SECURITY-MODEL section 6.14): from 1.0 a device
// refuses v0.1 boxes by default, never sends one and drops every one it receives. Reopening the
// window on a device (`wim legacy-boxes accept`) is the person's alone; closing it again is anyone's.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { legacyBoxSchema, sendFrameSchema, type SendFrame } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ClientError, MeshSession } from "../src/client.ts";
import { LEGACY_ACCEPT_TERMS } from "../src/cli.ts";
import { countDropped, droppedCount, droppedLine, droppedNotice, droppedPath, LEGACY_BOXES_FILE, LEGACY_DROPPED_FILE, legacyBoxesLine, refusesLegacy, setLegacyBoxes, skippedNote } from "../src/legacyboxes.ts";
import { noticeText } from "../src/render.ts";
import { INTERNAL_OPS, PUBLIC_TOOLS, WimMcp } from "../src/mcp.ts";
import { MeshFiles } from "../src/mesh.ts";
import { AGENT_ENV_VARS } from "../src/secretout.ts";
import { FS, makeMesh, openSession, RelayHarness, run, said, scratch, sessionOpts, term, until, windowOpen, type TestDevice } from "./helpers.ts";

const LONG = 30_000;
/** Housekeeping only when a test calls tick(): nothing runs on a timer behind the test's back. */
const HAND = { tickMs: 3_600_000 };

const open: Array<{ stop(): Promise<unknown> }> = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

async function session(...args: Parameters<typeof openSession>): Promise<MeshSession> {
  const s = await openSession(...args);
  open.push(s);
  return s;
}

const fileOf = (d: TestDevice): string => join(d.root, LEGACY_BOXES_FILE);
const refuse = (d: TestDevice): Promise<void> => setLegacyBoxes(fileOf(d), true, FS);

/** 0.1.2's send frame: strict, no `pk`, and every box a scheme 1 box. */
const v01SendFrame = sendFrameSchema.omit({ pk: true }).extend({ boxes: z.record(z.string(), legacyBoxSchema) });

/**
 * Makes each `old` device seal as a v0.1 client does: it publishes no prekey (its cards never reach the
 * relay) and learns none (no card reaches it), so what it sends holds scheme 1 boxes only.
 */
function noCards(relay: RelayHarness, ...old: TestDevice[]): void {
  const conns = new Set<string>();
  relay.toRelay = (text, conn) => {
    const f = JSON.parse(text) as { t: string; device?: string };
    if (f.t === "auth" && old.some((d) => d.device.id === f.device)) conns.add(conn);
    return conns.has(conn) && f.t === "card.set" ? undefined : text;
  };
  relay.toClient = (text, conn) => (conns.has(conn) && text.startsWith('{"t":"card') ? undefined : text);
}

async function forgetPrekeys(mesh: string, devices: TestDevice[]): Promise<void> {
  for (const d of devices) await fs.rm(new MeshFiles(d.home.meshDir(mesh), FS).peerPrekeysPath, { force: true });
}

const framesFrom = (relay: RelayHarness, sid: string): SendFrame[] =>
  relay.sentByClients
    .map((t) => JSON.parse(t) as { t: string; msg?: SendFrame })
    .flatMap((f) => (f.t === "send" ? [f as unknown as SendFrame] : f.t === "card.set" ? [f.msg!] : []))
    .filter((f) => f.from.sid === sid);

const has = async (s: MeshSession, re: RegExp): Promise<boolean> => (await s.spool.unread()).some((i) => re.test(i.rendered));

/**
 * Upgraded devices one (with no setting, so it refuses v0.1 boxes as from 1.0) and two (which
 * reopened the window), and old, a v0.1 device; all in #ops. With `strict: false`, one reopened
 * the window too.
 */
async function mixed(opts: { strict?: boolean; older?: boolean } = {}) {
  const relay = new RelayHarness();
  // `older`: a second v0.1 device, after old.
  const { mesh, devices } = await makeMesh(relay, ["one", "two", "old", ...(opts.older === true ? ["older"] : [])]);
  await forgetPrekeys(mesh, devices);
  noCards(relay, ...devices.slice(2));
  // A v0.1 client seals v0.1 boxes only; the fake one is a current client in the window with no cards.
  for (const d of devices.slice(1)) await windowOpen(d);
  if (opts.strict === false) await windowOpen(devices[0]!);
  const logs: string[] = [];
  const old = await session(devices[2]!, mesh, relay, { name: "o", ...HAND, legacyBoxesPath: fileOf(devices[2]!) });
  const b = await session(devices[1]!, mesh, relay, { name: "b", ...HAND, legacyBoxesPath: fileOf(devices[1]!) });
  const a = await session(devices[0]!, mesh, relay, { name: "a", ...HAND, legacyBoxesPath: fileOf(devices[0]!), log: (l) => void logs.push(l) });
  for (const s of [old, b, a]) await s.joinRoom("#ops");
  return { relay, mesh, devices, old, b, a, logs };
}

describe("a device that refuses v0.1 boxes, sending", () => {
  it("refuses a direct send to a device with no prekey, and sends nothing", async () => {
    const { relay, a } = await mixed();
    const before = framesFrom(relay, a.sid).length;
    const refused = await a.send("o@old", "hello old client").catch((e: unknown) => e as ClientError);
    expect(refused).toBeInstanceOf(ClientError);
    expect((refused as ClientError).code).toBe("invalid");
    expect((refused as ClientError).message).toBe(
      "refused: no current prekey for old (a v0.1 client, or offline for over 48 hours), and this device refuses v0.1 boxes, so nothing was sent. It goes once that device is online with a current client; `wim legacy-boxes` shows the setting.",
    );
    expect(framesFrom(relay, a.sid).length).toBe(before);
    // Naming an upgraded device beside it changes nothing: still refused whole.
    await expect(a.send(["b@two", "o@old"], "both")).rejects.toThrow(/^refused: no current prekey for old /);
  }, LONG);

  it("seals a room send for the devices with a prekey only, and says which it skipped", async () => {
    const { relay, devices, old, b, a } = await mixed();
    const out = await a.send("#ops", "for the room");
    expect(out.unprotected).toBeUndefined();
    expect(out.no_prekey).toEqual(["old"]);
    const frame = framesFrom(relay, a.sid).at(-1)!;
    expect(frame.pk?.device).toBe(devices[0]!.device.id);
    expect(Object.keys(frame.boxes).sort()).toEqual([devices[0]!.device.id, devices[1]!.device.id].sort());
    for (const box of Object.values(frame.boxes)) expect(box).toMatchObject({ s: 2 });
    await until(() => has(b, /for the room/), undefined, "two reads it");
    expect(await has(old, /for the room/)).toBe(false);
    // Between upgraded devices nothing changes.
    expect(await a.send("b@two", "direct")).not.toHaveProperty("no_prekey");
  }, LONG);

  it("gives a v0.1 device no box in its card either", async () => {
    const { relay, devices, a } = await mixed();
    const card = framesFrom(relay, a.sid).find((f) => f.seq === 0)!;
    expect(Object.keys(card.boxes)).not.toContain(devices[2]!.device.id);
    expect(Object.values(card.boxes).every((box) => "s" in box)).toBe(true);
  }, LONG);

  it("still waits for the first cards page: a prekey learned there lets the direct send go", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await session(devices[1]!, mesh, relay, { name: "b" });
    await forgetPrekeys(mesh, [devices[0]!]);
    // No setting file: the 1.0 default.
    const a = await MeshSession.open(sessionOpts(devices[0]!, mesh, relay, { name: "a", legacyBoxesPath: fileOf(devices[0]!) }));
    open.push(a);
    a.start();
    // Sealed before the connection is ready: two's prekey is not known yet.
    const out = await a.send("b@two", "first words");
    expect(out).not.toHaveProperty("no_prekey");
    expect(framesFrom(relay, a.sid).at(-1)!.boxes[devices[1]!.device.id]).toMatchObject({ s: 2 });
  }, LONG);

  it("waits, within the answer time, for the card of a session that came online a moment ago", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await forgetPrekeys(mesh, devices);
    const a = await session(devices[0]!, mesh, relay, { name: "a", ...HAND, answerMs: 60_000 });
    // Two's card reaches the relay, but its push to one is held: one's send cannot know two's prekey yet.
    const held: string[] = [];
    relay.toClient = (text) => {
      const f = JSON.parse(text) as { t: string; msg?: SendFrame };
      if (f.t !== "card" || f.msg?.from.device !== devices[1]!.device.id) return text;
      held.push(text);
      return undefined;
    };
    await session(devices[1]!, mesh, relay, { name: "b", ...HAND });
    await until(() => held.length === 1, undefined, "two's card held");
    const sending = a.send("b@two", "just after you came online");
    // The send waits for that prekey, not for its timeout: the card is let through once it waits.
    const waits = (a as unknown as { prekeyWaits: Set<unknown> }).prekeyWaits;
    await until(() => waits.size === 1, undefined, "the send waits");
    relay.toClient = undefined;
    relay.inject(mesh, held[0]!);
    const out = await sending;
    expect(out).not.toHaveProperty("no_prekey");
    expect(framesFrom(relay, a.sid).at(-1)!.boxes[devices[1]!.device.id]).toMatchObject({ s: 2 });
    expect(waits.size).toBe(0);
  }, LONG);

  it("waits for a prekey outside the send queue: other sends go meanwhile (Seer)", async () => {
    const { a } = await mixed();
    let settled = false;
    const waiting = a.send("o@old", "waits for a prekey that never comes").finally(() => void (settled = true));
    const waits = (a as unknown as { prekeyWaits: Set<unknown> }).prekeyWaits;
    await until(() => waits.size === 1, undefined, "the send waits");
    // Another send is sealed and answered while the first still waits.
    expect(await a.send("b@two", "meanwhile")).not.toHaveProperty("no_prekey");
    expect(settled).toBe(false);
    await expect(waiting).rejects.toThrow(/^refused: no current prekey for old /);
    expect(waits.size).toBe(0);
  }, LONG);

  it("reads the setting at each send, so a running session closes the window at once", async () => {
    const { devices, a } = await mixed({ strict: false });
    expect(await a.send("o@old", "while the window is open")).toMatchObject({ unprotected: ["old"], no_prekey: ["old"] });
    await refuse(devices[0]!);
    await expect(a.send("o@old", "now refused")).rejects.toThrow(/^refused: no current prekey for old /);
  }, LONG);
});

describe("a device that refuses v0.1 boxes, receiving", () => {
  it("drops a v0.1 box as legacy_box, the reason 1.0 gives, while a device in the window reads it", async () => {
    const { old, b, a, logs } = await mixed();
    const direct = await old.send("a@one", "old to one");
    await old.send("#ops", "old in the room");
    await until(() => has(b, /old in the room/), undefined, "two, in the window, reads it");
    await until(() => logs.some((l) => l === `wim: dropped ${direct.id}: legacy_box`), undefined, "one drops the direct one");
    // The room box is a frame of its own, dropped after the direct one.
    await until(() => logs.filter((l) => / legacy_box$/.test(l)).length >= 2, undefined, "one drops the room one too");
    expect(logs.filter((l) => / legacy_box$/.test(l)).length).toBe(2);
    expect(await has(a, /old to one|old in the room/)).toBe(false);
    // An upgraded sender's message still reads.
    await b.send("a@one", "from two");
    await until(() => has(a, /from two/), undefined, "one reads two");
  }, LONG);
});

describe("a session given no setting file", () => {
  it("refuses v0.1 boxes as from 1.0, on send and on receive, and counts nothing", async () => {
    const { relay, mesh, devices, old } = await mixed();
    const logs: string[] = [];
    const lib = await session(devices[0]!, mesh, relay, { name: "lib", ...HAND, log: (l) => void logs.push(l) });
    await expect(lib.send("o@old", "no file, no window")).rejects.toThrow(/^refused: no current prekey for old /);
    const sent = await old.send("lib@one", "old to a library session");
    await until(() => logs.includes(`wim: dropped ${sent.id}: legacy_box`), undefined, "lib drops it");
    expect(await has(lib, /old to a library session/)).toBe(false);
    // With no state directory named, there is no count beside it.
    await expect(fs.stat(join(devices[0]!.root, LEGACY_DROPPED_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  }, LONG);
});

describe("a dropped v0.1 box, told and counted", () => {
  const notices = async (s: MeshSession): Promise<string[]> => (await s.spool.unread()).map((i) => i.rendered).filter((r) => r.includes("old box format"));
  const drops = (logs: string[]): number => logs.filter((l) => / legacy_box$/.test(l)).length;

  it("tells the session once per sender device, with no message text, and counts every drop for wim status", async () => {
    const { relay, mesh, devices, a, old, logs } = await mixed({ older: true });
    await old.send("a@one", "first secret words");
    await old.send("a@one", "second secret words");
    await until(async () => drops(logs) === 2, undefined, "one drops both");
    // A second drop from the same sender adds no notice.
    expect(await notices(a)).toEqual([noticeText(droppedNotice("o@old"))]);
    // Quiet, with no watch named: a sender the person may not trust cannot start a turn with it.
    expect((await a.spool.unread()).filter((i) => i.rendered.includes("old box format")).map((i) => [i.quiet, i.watched])).toEqual([[true, undefined]]);
    expect(noticeText(droppedNotice("o@old"))).toContain("A message from o@old was dropped because it used the old box format");
    // Another session of the same device adds none: the session name is the sender's to choose,
    // so a notice per name would let one device flood the spool.
    const sibling = await session(devices[2]!, mesh, relay, { name: "p", ...HAND, legacyBoxesPath: fileOf(devices[2]!) });
    await sibling.send("a@one", "third secret words");
    await until(async () => drops(logs) === 3, undefined, "one drops the third");
    expect(await notices(a)).toEqual([noticeText(droppedNotice("o@old"))]);
    // Another v0.1 device gets its own.
    const other = await session(devices[3]!, mesh, relay, { name: "q", ...HAND, legacyBoxesPath: fileOf(devices[3]!) });
    await other.send("a@one", "fourth secret words");
    await until(async () => drops(logs) === 4, undefined, "one drops the fourth");
    expect(await notices(a)).toEqual([noticeText(droppedNotice("o@old")), noticeText(droppedNotice("q@older"))]);
    // No notice, nor the count, carries anything of what was sent.
    const items = await a.spool.unread();
    expect(items.some((i) => /secret words/.test(JSON.stringify(i)))).toBe(false);
    const countFile = join(devices[0]!.root, LEGACY_DROPPED_FILE);
    expect(await fs.readFile(countFile, "utf8")).toBe("4\n");
    const t = term(devices[0]!.root, relay);
    expect(await run(t, "status")).toBe(0);
    expect(t.out).toContain(droppedLine(4));
  }, LONG);

  it("does nothing while the device accepts v0.1 boxes", async () => {
    const { relay, devices, a, old, logs } = await mixed({ strict: false });
    await old.send("a@one", "read in the window");
    await until(() => has(a, /read in the window/), undefined, "one reads it");
    expect(drops(logs)).toBe(0);
    expect(await notices(a)).toEqual([]);
    const countFile = join(devices[0]!.root, LEGACY_DROPPED_FILE);
    await expect(fs.stat(countFile)).rejects.toMatchObject({ code: "ENOENT" });
    const t = term(devices[0]!.root, relay);
    expect(await run(t, "status")).toBe(0);
    expect(t.out.some((l) => l.includes("dropped on this device"))).toBe(false);
    // A count from before the window was reopened is still shown.
    await fs.writeFile(countFile, "2\n");
    t.out.length = 0;
    expect(await run(t, "status")).toBe(0);
    expect(t.out).toContain(droppedLine(2));
  }, LONG);

  it("keeps the count beside the setting, counts concurrent drops once each, and reads a file without a count as none", async () => {
    const home = await scratch("lb");
    const path = droppedPath(join(home, LEGACY_BOXES_FILE));
    expect(path).toBe(join(home, LEGACY_DROPPED_FILE));
    expect(await droppedCount(path)).toBe(0);
    await Promise.all(Array.from({ length: 5 }, () => countDropped(path, FS)));
    expect(await droppedCount(path)).toBe(5);
    await fs.writeFile(path, " 7\n");
    expect(await droppedCount(path)).toBe(7);
    for (const text of ["many", "-1", "1.5", "1e400", "9007199254740993"]) {
      await fs.writeFile(path, text);
      expect(await droppedCount(path), text).toBe(0);
    }
    await countDropped(path, FS);
    expect(await droppedCount(path)).toBe(1);
  });
});

describe("a hostile relay that withholds prekeys", () => {
  /** Two upgraded devices; the relay serves no cards page and strips `pk` from every card it pushes. */
  async function withheld() {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    await forgetPrekeys(mesh, [devices[0]!]);
    relay.toClient = (text) => (text.startsWith('{"t":"cards"') ? undefined : text.startsWith('{"t":"card"') ? text.replace(/,"pk":\{[^}]*\}/g, "") : text);
    return { relay, mesh, devices, b };
  }

  it("downgrades a device in the window, and cannot downgrade one that refuses v0.1 boxes", async () => {
    const { relay, mesh, devices, b } = await withheld();
    // In the window, the downgrade works: the send goes without forward secrecy.
    const open1 = await session(devices[0]!, mesh, relay, { name: "w", answerMs: 300, ...(await windowOpen(devices[0]!)) });
    expect((await open1.send("b@two", "downgraded")).unprotected).toEqual(["two"]);
    expect(v01SendFrame.safeParse(framesFrom(relay, open1.sid).at(-1)).success).toBe(true);

    await refuse(devices[0]!);
    const a = await session(devices[0]!, mesh, relay, { name: "a", answerMs: 300, legacyBoxesPath: fileOf(devices[0]!) });
    await expect(a.send("b@two", "not downgraded")).rejects.toThrow(/^refused: no current prekey for two /);
    const room = await a.send("*", "to everyone");
    expect(room).toMatchObject({ no_prekey: ["two"] });
    expect(room).not.toHaveProperty("unprotected");
    // Nothing a refusing device sent holds a scheme 1 box.
    for (const f of framesFrom(relay, a.sid)) for (const box of Object.values(f.boxes)) expect(box).toMatchObject({ s: 2 });
    expect(await has(b, /not downgraded|to everyone/)).toBe(false);
  }, LONG);
});

describe("what the person and the agent are told", () => {
  it("wim send and MCP send say which devices a room send skipped, and wim send refuses a direct one", async () => {
    const { relay, mesh, devices } = await mixed();
    const t = term(devices[0]!.root, relay);
    // The relay reports the room member it got no box for as `invalid`, so not every row was taken.
    expect(await run(t, "send", "#ops", "via the cli")).toBe(1);
    expect(t.out).toContain("o@old: invalid");
    expect(said(t)).toContain(skippedNote(["old"]));
    expect(said(t)).toContain("Not sent to old: no current prekey (a v0.1 client, or offline for over 48 hours), and this device refuses v0.1 boxes (`wim legacy-boxes`).");
    expect(said(t)).not.toContain("without forward secrecy");
    const t2 = term(devices[0]!.root, relay);
    expect(await run(t2, "send", "o@old", "refused")).toBe(1);
    expect(said(t2)).toMatch(/refused: no current prekey for old /);

    const server = new WimMcp({ channel: false, internalTools: false, version: "test", session: { ...sessionOpts(devices[0]!, mesh, relay, { name: "agent", kind: "claude-code", ...HAND }), legacyBoxesPath: fileOf(devices[0]!) } });
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await server.server.connect(y);
    await client.connect(x);
    open.push({ stop: async () => (await client.close(), await server.close()) });
    const call = async (args: Record<string, unknown>) => (await client.callTool({ name: "send", arguments: args }, CallToolResultSchema)) as { structuredContent?: Record<string, unknown>; isError?: boolean; content: Array<{ text: string }> };
    expect((await call({ to: "#ops", text: "via mcp" })).structuredContent).toMatchObject({ no_prekey: ["old"], note: skippedNote(["old"]) });
    const direct = await call({ to: "o@old", text: "refused via mcp" });
    expect(direct.isError).toBe(true);
    expect(direct.content[0]!.text).toMatch(/refused: no current prekey for old /);
  }, LONG);

  it("no MCP tool or internal op changes the setting", () => {
    expect(PUBLIC_TOOLS.map((t) => t.name).filter((n) => /legacy|secrecy|downgrade/.test(n))).toEqual([]);
    expect([...INTERNAL_OPS].filter((n) => /legacy|secrecy|downgrade/.test(n))).toEqual([]);
  });
});

describe("wim legacy-boxes", () => {
  it("refuses by default from 1.0; anyone may close a reopened window again, agents included", async () => {
    const home = await scratch("lb");
    const t = term(home, new RelayHarness());
    expect(await run(t, "legacy-boxes")).toBe(0);
    expect(t.out).toEqual([`${legacyBoxesLine(true)}.`]);
    await setLegacyBoxes(join(home, LEGACY_BOXES_FILE), false, FS);
    expect(await run(t, "legacy-boxes")).toBe(0);
    expect(t.out.at(-1)).toBe(`${legacyBoxesLine(false)}.`);
    const agent = term(home, new RelayHarness(), { isTTY: false, inputIsTTY: false }, { CLAUDECODE: "1" });
    expect(await run(agent, "legacy-boxes", "refuse")).toBe(0);
    expect(agent.out).toEqual([`${legacyBoxesLine(true)}.`]);
    expect(await fs.readFile(join(home, LEGACY_BOXES_FILE), "utf8")).toBe("refuse\n");
    expect(await run(t, "legacy-boxes", "status")).toBe(0);
    expect(t.out.at(-1)).toBe(`${legacyBoxesLine(true)}.`);
  });

  it("refuses to accept them again under every agent variable and over piped I/O, before asking", async () => {
    const home = await scratch("lb");
    const file = join(home, LEGACY_BOXES_FILE);
    await setLegacyBoxes(file, true, FS);
    const hostile = [
      ...AGENT_ENV_VARS.map((k) => term(home, new RelayHarness(), {}, { [k]: "1" })),
      term(home, new RelayHarness(), {}, { CODEX_SANDBOX: "seatbelt" }),
      term(home, new RelayHarness(), { inputIsTTY: false }),
      term(home, new RelayHarness(), { isTTY: false }),
      term(home, new RelayHarness(), { isTTY: false, inputIsTTY: false }, { TERM: "xterm-256color", FORCE_TTY: "1", WIM_PERSON: "1" }),
    ];
    expect(hostile.length).toBe(AGENT_ENV_VARS.length + 4);
    for (const t of hostile) {
      t.answers.push("y");
      expect(await run(t, "legacy-boxes", "accept"), JSON.stringify(t.env)).toBe(1);
      expect(t.err.at(-1)).toMatch(/run `wim legacy-boxes accept` there/);
      expect(t.out).toEqual([]);
      expect(t.answers).toEqual(["y"]);
    }
    expect(await refusesLegacy(file)).toEqual({ refuse: true });
  });

  it("accepts them again only on a typed yes from the person, after saying what it weakens", async () => {
    const home = await scratch("lb");
    const file = join(home, LEGACY_BOXES_FILE);
    await setLegacyBoxes(file, true, FS);
    const t = term(home, new RelayHarness());
    for (const answer of ["", "n", "no", "sure"]) {
      t.answers.push(answer);
      expect(await run(t, "legacy-boxes", "accept")).toBe(1);
      expect(t.err.at(-1)).toBe("wim: nothing changed.");
    }
    expect(await refusesLegacy(file)).toEqual({ refuse: true });
    expect(t.out).toEqual(expect.arrayContaining([...LEGACY_ACCEPT_TERMS, "Accept v0.1 boxes again? [y/N] "]));
    t.answers.push("y");
    expect(await run(t, "legacy-boxes", "accept")).toBe(0);
    expect(t.out.at(-1)).toBe(`${legacyBoxesLine(false)}.`);
    expect(await fs.readFile(file, "utf8")).toBe("accept\n");
  });

  it("refuses an unknown action and any flag", async () => {
    const t = term(await scratch("lb"), new RelayHarness());
    expect(await run(t, "legacy-boxes", "off")).toBe(1);
    expect(t.err.at(-1)).toBe("wim: usage: wim legacy-boxes [status | refuse | accept]");
    expect(await run(t, "legacy-boxes", "refuse", "--all")).toBe(2);
    expect(await run(t, "help", "legacy-boxes")).toBe(0);
    expect(said(t)).toContain("wim legacy-boxes [status | refuse | accept]");
  });

  it("reads accept as the window, a missing file and refuse as refuse, and anything else as refuse with a problem", async () => {
    const home = await scratch("lb");
    const file = join(home, LEGACY_BOXES_FILE);
    // No file is the 1.0 default, with nothing to report.
    expect(await refusesLegacy(file)).toEqual({ refuse: true });
    await fs.writeFile(file, "accept\n");
    expect(await refusesLegacy(file)).toEqual({ refuse: false });
    await fs.writeFile(file, "  refuse \n");
    expect(await refusesLegacy(file)).toEqual({ refuse: true });
    const neither = `${file}: it says neither refuse nor accept, so this device refuses v0.1 boxes. \`wim legacy-boxes refuse\` or \`wim legacy-boxes accept\` rewrites it`;
    for (const text of ["refuse please", "REFUSE", "off", `${" ".repeat(16)}accept`, ""]) {
      await fs.writeFile(file, text);
      expect(await refusesLegacy(file), JSON.stringify(text)).toEqual({ refuse: true, problem: neither });
    }
    // One that cannot be read (here a directory) refuses too, and names why.
    await fs.rm(file);
    await fs.mkdir(file);
    expect(await refusesLegacy(file)).toEqual({ refuse: true, problem: expect.stringMatching(/: it cannot be read: EISDIR, so this device refuses v0\.1 boxes\. /) });
  });

  it("an error without a code still refuses", async () => {
    const { promises } = await import("node:fs");
    const real = promises.readFile;
    (promises as { readFile: unknown }).readFile = () => Promise.reject(new Error("odd"));
    try {
      expect(await refusesLegacy(join(await scratch("lb"), LEGACY_BOXES_FILE))).toMatchObject({ refuse: true, problem: expect.stringContaining("it cannot be read: error,") });
    } finally {
      (promises as { readFile: unknown }).readFile = real;
    }
  });

  it("wim status, wim doctor and wim legacy-boxes show a garbage file as a problem, and a running session refuses", async () => {
    const { relay, devices, a } = await mixed({ strict: false });
    await fs.writeFile(fileOf(devices[0]!), "maybe\n");
    await expect(a.send("o@old", "garbage refuses")).rejects.toThrow(/^refused: no current prekey for old /);
    const t = term(devices[0]!.root, relay);
    expect(await run(t, "status")).toBe(1);
    expect(t.out).toContain(`${legacyBoxesLine(true)}.`);
    expect(t.out.some((l) => l.startsWith("problem  ") && l.includes(`${fileOf(devices[0]!)}: it says neither refuse nor accept`) && l.includes("`wim legacy-boxes refuse` or `wim legacy-boxes accept` rewrites it"))).toBe(true);
    t.out.length = 0;
    expect(await run(t, "doctor")).toBe(1);
    expect(t.out.some((l) => l.startsWith("problem  ") && l.includes("it says neither refuse nor accept"))).toBe(true);
    t.out.length = 0;
    expect(await run(t, "legacy-boxes")).toBe(0);
    expect(t.out).toEqual([`${legacyBoxesLine(true)}.`, expect.stringMatching(/it says neither refuse nor accept, .* rewrites it\.$/)]);
    expect(await run(t, "legacy-boxes", "refuse")).toBe(0);
    expect(t.out.at(-1)).toBe(`${legacyBoxesLine(true)}.`);
  }, LONG);
});

describe("wim status and wim doctor", () => {
  it("show the setting, refused by default, and doctor says how to close a reopened window", async () => {
    const relay = new RelayHarness();
    const { devices } = await makeMesh(relay, ["solo"]);
    const t = term(devices[0]!.root, relay);
    expect(await run(t, "status")).toBe(0);
    expect(t.out).toContain(`${legacyBoxesLine(true)}.`);
    // A count of none is no news, though the device refuses.
    expect(t.out.some((l) => l.includes("dropped on this device"))).toBe(false);
    expect(await run(t, "doctor")).toBe(0);
    expect(t.out).toContain(`info     ${legacyBoxesLine(true)}`);
    await setLegacyBoxes(fileOf(devices[0]!), false, FS);
    t.out.length = 0;
    expect(await run(t, "status")).toBe(0);
    expect(t.out).toContain(`${legacyBoxesLine(false)}.`);
    expect(await run(t, "doctor")).toBe(0);
    expect(t.out).toContain(`info     ${legacyBoxesLine(false)}`);
    expect(legacyBoxesLine(false)).toContain("`wim legacy-boxes refuse` closes that again");
  }, LONG);
});
