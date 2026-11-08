// Decisions on held messages that an agent cannot forge: with the keys in the signer, an approve,
// refuse or resume is taken only signed by the signer after the person confirmed it there. Mark
// files are refused, a decision covers exactly the items it was signed over, a replay releases
// nothing new, and a locked or stopped signer takes no decision. Without a signer nothing changes.

import { b64u, randomBytes, ulid, type DeviceKeys } from "@worldinmotion/protocol";
import { createPrivateKey, type KeyObject } from "node:crypto";
import { promises as fs } from "node:fs";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentError, AgentServer, DECLINE_BACKOFF, Signer, type Desk } from "../src/agent.ts";
import { agentEndpoint, endpointFiles } from "../src/agentpath.ts";
import { desk as signerDesk, encryptDevice, within } from "../src/agentcli.ts";
import type { SignerChecks } from "../src/ancestry.ts";
import { confirmGui, confirmPrompts, kdialogText, type Run, type ToolTrust } from "../src/autostart.ts";
import { MeshSession } from "../src/client.ts";
import { checkDecision, covers, decider, requestDecision as ask2, decisionFor, decisionsFor, idChunks, MAX_DECISION_IDS, MAX_DECISION_ITEMS, decisionView, heldDigest, NEEDS_SIGNER, requestDecision, signDecision, unsignedRefusal, type Decision, type DecideRequest, type HeldCopy } from "../src/decisions.ts";
import { runEvents } from "../src/events.ts";
import { fsOps } from "../src/fsx.ts";
import { HeldBox, useDecision, type HeldItem } from "../src/held.ts";
import { readBreakerFile, savePauses, type PauseRow } from "../src/pauses.ts";
import type { Device } from "../src/home.ts";
import { MeshFiles, RosterBook } from "../src/mesh.ts";
import { decideHeld, listAllHeld, resumeEverywhere, unsignedMarks } from "../src/offline.ts";
import { SessionFiles } from "../src/session.ts";
import { openKeyFile } from "../src/vault.ts";
import { FS, keysOf, LIVE_PID, makeMesh, openSession, RelayHarness, run, said, scratch, term, until as untilEvent, type TestDevice } from "./helpers.ts";

vi.setConfig({ testTimeout: 60_000 });
const until = (check: () => boolean | Promise<boolean>, what?: string): Promise<void> => untilEvent(check, 30_000, what);

const KDF = { N: 1024, r: 8, p: 1 };
const PASS = "pass phrase";
const T = 1_760_000_000_000;
const OK: ToolTrust = async () => "ok";
/** The code the asking process shows, in the tests' requests. */
const CODE = "123456";

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

/** The device key as Node's crypto takes it (a test holds the plaintext keys). */
function signKeyOf(keys: DeviceKeys): KeyObject {
  return createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(keys.signSec)]), format: "der", type: "pkcs8" });
}

const item = (over: Partial<HeldItem> = {}): HeldItem => {
  const id = over.id ?? ulid();
  return { id, from: "a@one", device: "D".repeat(22), kind: "msg", at: T, preview: "hi", rendered: "", reason: "policy", entry: { dir: "in", peer: "a@one", id, kind: "msg", at: T, text: "hello there" }, ...over };
};

/** The person's answers to the signer, in order; each confirm records what it was shown. */
type Answers = { said: string[][]; next: Array<boolean | Promise<boolean>> };

/** A desk like `wim agent`'s own, with a scripted person. */
function scriptedDesk(d: TestDevice, answers: Answers): Desk {
  return {
    device: async (mesh, name) => (await RosterBook.open(new MeshFiles(d.home.meshDir(mesh), FS))).current.devices.find((x) => x.name === name)?.id,
    read: async (mesh, ids) => {
      const rows = await listAllHeld(new MeshFiles(d.home.meshDir(mesh), FS), FS);
      return rows.filter((r) => ids.includes(r.id)).map(({ sid: _s, session, ...i }) => ({ item: i, session }));
    },
    confirm: async (lines) => {
      answers.said.push(lines);
      return answers.next.shift() ?? false;
    },
  };
}

/** Encrypts `d`'s key file and runs its signer in this process, with a scripted person at its desk. */
async function underSigner(d: TestDevice): Promise<{ device: Device; signer: Signer; server: AgentServer; answers: Answers; keys: DeviceKeys }> {
  const keys = keysOf(d.device);
  await encryptDevice(d.home, PASS, KDF);
  const file = await d.home.readKeyFile();
  if (file === undefined || !("sealed" in file)) throw new Error("not encrypted");
  const answers: Answers = { said: [], next: [] };
  const signer = new Signer({ file: file.sealed, unlocked: await openKeyFile(file.sealed, PASS), now: Date.now, pid: process.pid, log: () => undefined, desk: scriptedDesk(d, answers), backoff: { firstMs: 0, maxMs: 0 } });
  const at = (await agentEndpoint(d.home.root, d.home.env, true))!;
  const server = new AgentServer({ signer, endpoint: at, files: endpointFiles(process.platform) });
  await server.listen();
  cleanup.push(() => server.close());
  return { device: (await d.home.loadDevice())!, signer, server, answers, keys };
}

/** Devices one and three send to `inbox` on device two, whose keys are in the signer; nothing is trusted. */
async function world() {
  const relay = new RelayHarness();
  const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"], { trust: false });
  const two = devices[1]!;
  const signed = await underSigner(two);
  const logs: string[] = [];
  const open = async (name: string) => {
    // The same session each time (its id kept by key), so what peers send it waits for it at the relay.
    const s = await openSession(two, mesh, relay, { name, device: signed.device, log: (l) => logs.push(l), sessionKey: `test:${name}` });
    cleanup.push(() => s.stop().catch(() => undefined));
    return s;
  };
  const inbox = await open("inbox");
  const one = await openSession(devices[0]!, mesh, relay, { name: "a" });
  const three = await openSession(devices[2]!, mesh, relay, { name: "c" });
  cleanup.push(() => one.stop(), () => three.stop());
  const files = new MeshFiles(two.home.meshDir(mesh), FS);
  const ask = (req: Omit<DecideRequest, "mesh" | "code">): Promise<Decision> => requestDecision({ root: two.home.root, env: two.home.env, signPub: signed.keys.signPub }, { mesh, code: CODE, ...req });
  return { relay, mesh, devices, two, inbox, one, three, files, logs, open, ask, ...signed };
}

async function heldIn(s: MeshSession, n: number): Promise<HeldItem[]> {
  await until(async () => (await s.held.list()).length === n, `${n} held`);
  return s.held.list();
}

describe("a signed decision", () => {
  it("is good only signed by this device's key, for its device and mesh, and while current", async () => {
    const { generateDeviceKeys, deviceIdFromSignPub } = await import("@worldinmotion/protocol");
    const keys = generateDeviceKeys();
    const device = deviceIdFromSignPub(keys.signPub);
    const mesh = b64u.encode(randomBytes(16));
    const it1 = item();
    const body = { v: 1 as const, device, mesh, verdict: "approve" as const, items: [{ id: it1.id, digest: heldDigest(it1) }], at: T, n: ulid(T) };
    const d = signDecision(body, signKeyOf(keys));
    const o = { signPub: keys.signPub, device, mesh, now: T };
    expect(checkDecision(d, o)).toEqual(d);
    expect(covers(d, it1)).toBe(true);
    // The item changed on disk after the person saw it, or another item: not covered.
    expect(covers(d, { ...it1, entry: { ...it1.entry, text: "changed" } })).toBe(false);
    expect(covers(d, item())).toBe(false);
    expect(checkDecision({ ...d, extra: 1 }, o)).toEqual({ refused: "it is not a decision" });
    expect(checkDecision("nope", o)).toEqual({ refused: "it is not a decision" });
    expect(checkDecision(d, { ...o, mesh: b64u.encode(randomBytes(16)) })).toEqual({ refused: "it is for another device or mesh" });
    expect(checkDecision(d, { ...o, device: "E".repeat(22) })).toEqual({ refused: "it is for another device or mesh" });
    // Any change to what was signed, or another key, breaks it.
    expect(checkDecision({ ...d, verdict: "refuse" }, o)).toEqual({ refused: "its signature is not this device's signer's" });
    expect(checkDecision({ ...d, items: [...d.items, { id: ulid(), digest: d.items[0]!.digest }] }, o)).toEqual({ refused: "its signature is not this device's signer's" });
    expect(checkDecision(d, { ...o, signPub: generateDeviceKeys().signPub })).toEqual({ refused: "its signature is not this device's signer's" });
    expect(checkDecision({ ...d, sig: "!!!" }, o)).toEqual({ refused: "its signature is not this device's signer's" });
    const resume = signDecision({ ...body, verdict: "resume" }, signKeyOf(keys));
    expect(checkDecision(resume, o)).toEqual({ refused: "a resume names no peer" });
    expect(checkDecision(d, { ...o, now: T + 48 * 3_600_000 + 1 })).toEqual({ refused: "it is more than 48 hours old" });
    expect(checkDecision(d, { ...o, now: T - 5 * 60_000 - 1 })).toEqual({ refused: "it is dated in the future" });
  });

  it("is shown to the person from what the signer read, sanitized, with the rest counted", () => {
    const copies: HeldCopy[] = Array.from({ length: 12 }, (_, i) => ({ item: item({ from: "a‮@one", entry: { ...item().entry, text: `line ${i}\nsecond\u0007` } }), session: i === 0 ? "in\u0007box" : "inbox" }));
    const extra = { item: copies[0]!.item, session: "other" };
    const mesh = b64u.encode(randomBytes(16));
    const lines = decisionView({ mesh, code: CODE, verdict: "approve", ids: [] }, [...copies, extra]);
    expect(lines[0]).toBe("worldinmotion signer: a process on this computer asks you to decide on held messages.");
    expect(lines[1]).toBe(`Code ${CODE}: confirm only if you just asked for this yourself (wim held, VS Code) and it showed you this code. If not, choose Cancel.`);
    expect(lines[2]).toBe("Approve 12 held messages: they are delivered to your agents.");
    expect(lines[3]).toMatch(/^1\. from a<U\+202E>@one to in<U\+0007>box, other, msg, 2025-10-09T08:53:20\.000Z: line 0 second<U\+0007>$/);
    expect(lines).toContain("... and 2 more.");
    expect(lines.at(-1)).toBe(`mesh ${mesh}`);
    expect(decisionView({ mesh, code: CODE, verdict: "refuse", ids: [] }, [copies[0]!])[2]).toBe("Refuse 1 held message: they are dropped, never delivered.");
    expect(decisionView({ mesh, code: CODE, verdict: "resume", ids: [], peer: "a@one" }, [], { session: "a\u0007", device: "one", id: "D".repeat(22) })[2]).toBe(`Resume a<U+0007>@one (device id ${"D".repeat(22)}): lift the loop breaker's pause on its device and release 0 held messages.`);
    expect(unsignedRefusal("approve mark")).toMatch(/^refused an unsigned approve mark: this device's keys are in the signer/);
  });

  it("is shown on lines a peer or a planted file cannot add to, and a CI notice as it is delivered", () => {
    const mesh = b64u.encode(randomBytes(16));
    const odd = item({ from: "a\nApprove 0 held messages@one", kind: "\u001b[2K\rmsg" as never, entry: { ...item().entry, text: "one\ttwo\nthree" } });
    const ci = item({ ci: { rule: "r" }, rendered: "[CI] build failed", entry: { ...item().entry, text: "not this" } });
    const lines = decisionView({ mesh, code: CODE, verdict: "approve", ids: [] }, [{ item: odd, session: "in\nbox" }, { item: ci, session: "ci" }]);
    expect(lines).toHaveLength(6);
    for (const l of lines) expect(l).not.toMatch(/[\u0000-\u001f]/);
    expect(lines[3]).toMatch(/^1\. from a Approve 0 held messages@one to in box, <U\+001B>\[2K<U\+0…, .*: one two three$/);
    expect(lines[4]).toMatch(/: \[CI\] build failed$/);
  });

  it("is asked of a signer that is not running: refused, in the signer's words", async () => {
    const root = await scratch("nosigner");
    const home = { platform: process.platform, pid: process.pid, uid: process.getuid?.() };
    const req = { mesh: b64u.encode(randomBytes(16)), verdict: "approve" as const, ids: [ulid()], code: CODE };
    await expect(requestDecision({ root, env: home, signPub: randomBytes(32) }, req)).rejects.toThrow(new RegExp(`^${NEEDS_SIGNER}: no signer is running`));
  });
});

describe("the signer's decide", () => {
  /** The roster's device id for a resume's peer in these tests. */
  const DEV = "D".repeat(22);
  async function bare(given?: Omit<Desk, "device"> & Partial<Pick<Desk, "device">>, backoff?: { firstMs: number; maxMs: number } | "default") {
    const desk: Desk | undefined = given === undefined ? undefined : { device: async (_m, name) => (name === "one" ? DEV : undefined), ...given };
    const { generateDeviceKeys } = await import("@worldinmotion/protocol");
    const { sealKeyFile } = await import("../src/vault.ts");
    const keys = generateDeviceKeys();
    const data = randomBytes(32);
    const file = await sealKeyFile({ name: "laptop", keys, passphrase: PASS, data, kdf: KDF });
    const clock = { now: T };
    const signer = new Signer({ file, unlocked: { keys: { ...keys, signSec: keys.signSec.slice(), boxSec: keys.boxSec.slice() }, data }, now: () => clock.now, pid: 1, log: () => undefined, ...(backoff === "default" ? {} : { backoff: backoff ?? { firstMs: 0, maxMs: 0 } }), ...(desk === undefined ? {} : { desk }) });
    return { signer, keys, file, clock };
  }
  const MESH = b64u.encode(randomBytes(16));
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e: AgentError) => `${e.code}: ${e.message}`);

  it("signs, once the person confirmed it, exactly the copies it read, each once", async () => {
    const a = item();
    const b = item();
    const shown: string[][] = [];
    const reads: string[][] = [];
    const { signer, keys, file } = await bare({
      read: async (_m, ids) => (reads.push([...ids]), [{ item: a, session: "s1" }, { item: a, session: "s2" }, { item: b, session: "s1" }]),
      confirm: async (lines) => (shown.push(lines), true),
    });
    const r = await signer.handle("decide", { code: CODE, mesh: MESH, verdict: "approve", ids: [a.id, b.id] });
    const d = r["decision"] as Decision;
    expect(reads).toEqual([[a.id, b.id]]);
    expect(shown[0]![2]).toBe("Approve 2 held messages: they are delivered to your agents.");
    expect(d.items).toEqual([{ id: a.id, digest: heldDigest(a) }, { id: b.id, digest: heldDigest(b) }]);
    expect(checkDecision(d, { signPub: keys.signPub, device: file.id, mesh: MESH, now: T })).toEqual(d);
    // The decision type is not something the generic sign operation will make.
    expect(await code(signer.handle("sign", { type: "held-decision", obj: { device: file.id } }))).toMatch(/^bad_request/);
    const resume = (await signer.handle("decide", { code: CODE, mesh: MESH, verdict: "resume", ids: [], peer: "a@one" }))["decision"] as Decision;
    expect(resume).toMatchObject({ verdict: "resume", peer: "a@one", items: [] });
  });

  it("refuses without a desk, a desk that cannot ask, a resume with no peer, nothing held, a no, and a second at once", async () => {
    expect(await code((await bare()).signer.handle("decide", { code: CODE, mesh: MESH, verdict: "refuse", ids: [ulid()] }))).toBe("refused: this signer takes no decisions on held messages");
    const cannot = await bare({ read: async () => [], confirm: { cannot: "CLAUDECODE was set where this signer started" } });
    expect(await code(cannot.signer.handle("decide", { code: CODE, mesh: MESH, verdict: "approve", ids: [ulid()] }))).toBe("refused: CLAUDECODE was set where this signer started");
    let release!: (v: boolean) => void;
    const a = item();
    const answers: boolean[] = [false];
    const { signer } = await bare({
      read: async (_m, ids) => (ids.includes(a.id) ? [{ item: a, session: "s" }] : []),
      confirm: () => (answers.length > 0 ? Promise.resolve(answers.shift()!) : new Promise<boolean>((r) => (release = r))),
    });
    expect(await code(signer.handle("decide", { code: CODE, mesh: MESH, verdict: "resume", ids: [a.id] }))).toBe("bad_request: decide: a resume names its peer");
    expect(await code(signer.handle("decide", { code: CODE, mesh: MESH, verdict: "approve", ids: [ulid()] }))).toBe("refused: none of these ids is held on this device");
    expect(await code(signer.handle("decide", { code: CODE, mesh: MESH, verdict: "approve", ids: [a.id] }))).toBe("refused: you declined it in the signer: nothing changed");
    expect(await code(signer.handle("decide", { code: CODE, mesh: MESH, verdict: "approve", ids: ["x"] }))).toMatch(/^bad_request: decide: /);
    // A resume may lift a pause that holds nothing yet.
    const waiting = signer.handle("decide", { code: CODE, mesh: MESH, verdict: "resume", ids: [], peer: "a@one" });
    await until(() => release !== undefined);
    expect(await code(signer.handle("decide", { code: CODE, mesh: MESH, verdict: "approve", ids: [a.id] }))).toBe("refused: the signer is already asking you about another decision: answer that one first");
    release(true);
    expect(((await waiting)["decision"] as Decision).items).toEqual([]);
  });

  it("drops a copy that is no held item, and refuses an id whose copies differ in what the person is shown", async () => {
    const a = item();
    const shown: string[][] = [];
    const copies: HeldCopy[] = [];
    const { signer } = await bare({ read: async () => copies, confirm: async (lines) => (shown.push(lines), true) });
    // A copy whose time no date can show, or whose kind is terminal codes, or that names another id: none is shown or signed.
    copies.push({ item: a, session: "s1" }, { item: { ...a, at: Number.NaN }, session: "planted" }, { item: { ...a, kind: "\u001b[2K\rApprove 0" as never }, session: "planted" }, { item: { ...a, id: ulid() }, session: "other" });
    const d = (await signer.handle("decide", { code: CODE, mesh: MESH, verdict: "approve", ids: [a.id] }))["decision"] as Decision;
    expect(d.items).toEqual([{ id: a.id, digest: heldDigest(a) }]);
    expect(shown[0]!.filter((l) => l.startsWith("1. "))).toEqual([expect.stringContaining("to s1, msg, ")]);
    // Copies that differ only in why or where they are held are one item, each copy signed.
    copies.splice(0, copies.length, { item: a, session: "s1" }, { item: { ...a, reason: "breaker" }, session: "s2" });
    expect(((await signer.handle("decide", { code: CODE, mesh: MESH, verdict: "approve", ids: [a.id] }))["decision"] as Decision).items).toHaveLength(2);
    // A copy that shows other text, sender or time: refused, nothing asked.
    for (const other of [{ ...a, from: "alice@one", at: 1, entry: { ...a.entry, text: "lunch at noon?" } }, { ...a, entry: { ...a.entry, text: "other" } }, { ...a, ci: { rule: "r" }, rendered: "x" }]) {
      copies.splice(0, copies.length, { item: a, session: "s1" }, { item: other, session: "planted" });
      expect(await code(signer.handle("decide", { code: CODE, mesh: MESH, verdict: "approve", ids: [a.id] }))).toBe(`refused: held message ${a.id} is held in copies that differ in what you would be shown: nothing was signed (\`wim held list\` shows them)`);
    }
    expect(shown).toHaveLength(2);
  });

  it("refuses more copies than one decision takes, and a request without its code, before asking", async () => {
    const asked: string[][] = [];
    const ids = Array.from({ length: MAX_DECISION_IDS }, () => ulid());
    const many: HeldCopy[] = ids.flatMap((id) => Array.from({ length: 9 }, (_, k) => ({ item: item({ id, reason: "breaker", pause: { rule: "peer", count: k, limit: 1, minutes: 60, at: T, until: T, auto: false } }), session: "s" })));
    const { signer } = await bare({ read: async () => many, confirm: async (l) => (asked.push(l), true) });
    expect(await code(signer.handle("decide", { code: CODE, mesh: MESH, verdict: "approve", ids }))).toBe(`refused: these ids are held in ${9 * MAX_DECISION_IDS} copies, more than one decision takes (${MAX_DECISION_ITEMS}): ask for fewer at once`);
    many.splice(MAX_DECISION_ITEMS);
    expect(((await signer.handle("decide", { code: CODE, mesh: MESH, verdict: "approve", ids }))["decision"] as Decision).items).toHaveLength(MAX_DECISION_ITEMS);
    for (const bad of [undefined, "12345", "abcdef", "1234567"]) expect(await code(signer.handle("decide", { mesh: MESH, verdict: "approve", ids: [ids[0]!], ...(bad === undefined ? {} : { code: bad }) }))).toMatch(/^bad_request: decide: /);
    expect(asked).toHaveLength(1);
  });

  it("after a decline, takes the next decision only after a wait that doubles, and a yes starts it over", async () => {
    const a = item();
    const answers = [false, false, false, true, false];
    const { signer, clock } = await bare({ read: async () => [{ item: a, session: "s" }], confirm: async () => answers.shift()! }, { firstMs: 10_000, maxMs: 25_000 });
    const decide = () => code(signer.handle("decide", { code: CODE, mesh: MESH, verdict: "approve", ids: [a.id] }));
    const declined = "refused: you declined it in the signer: nothing changed";
    const waiting = (s: number) => `refused: you declined a decision in the signer just now: it takes the next one in ${s} s`;
    expect(await decide()).toBe(declined);
    expect(await decide()).toBe(waiting(10));
    clock.now += 10_000;
    expect(await decide()).toBe(declined);
    clock.now += 19_001;
    expect(await decide()).toBe(waiting(1));
    clock.now += 999;
    expect(await decide()).toBe(declined);
    clock.now += 24_999;
    expect(await decide()).toBe(waiting(1));
    clock.now += 1;
    expect(await decide()).toBe("ok");
    expect(await decide()).toBe(declined);
    clock.now += 9_999;
    expect(await decide()).toBe(waiting(1));
    // An asker that went away starts no wait.
    const away = await bare({ read: async () => [{ item: a, session: "s" }], confirm: async (_l, gone) => (gone as AbortSignal | undefined)?.aborted !== true && false }, { firstMs: 10_000, maxMs: 25_000 });
    const gone = new AbortController();
    gone.abort();
    expect(await code(away.signer.handle("decide", { code: CODE, mesh: MESH, verdict: "approve", ids: [a.id] }, gone.signal))).toBe("refused: the process that asked went away before you answered: nothing was signed");
    expect(await code(away.signer.handle("decide", { code: CODE, mesh: MESH, verdict: "approve", ids: [a.id] }))).toBe(declined);
    // The default wait: 10 s, at most 5 minutes.
    expect(DECLINE_BACKOFF).toEqual({ firstMs: 10_000, maxMs: 300_000 });
    const plain = await bare({ read: async () => [{ item: a, session: "s" }], confirm: async () => false }, "default");
    const again = () => code(plain.signer.handle("decide", { code: CODE, mesh: MESH, verdict: "approve", ids: [a.id] }));
    expect(await again()).toBe(declined);
    plain.clock.now += 9_999;
    expect(await again()).toBe(waiting(1));
    plain.clock.now += 1;
    expect(await again()).toBe(declined);
  });

  it("signs nothing when locked, before or while the person reads it", async () => {
    const a = item();
    let release!: (v: boolean) => void;
    const { signer } = await bare({ read: async () => [{ item: a, session: "s" }], confirm: () => new Promise<boolean>((r) => (release = r)) });
    const waiting = code(signer.handle("decide", { code: CODE, mesh: MESH, verdict: "approve", ids: [a.id] }));
    await until(() => release !== undefined);
    signer.lock();
    release(true);
    expect(await waiting).toBe("locked: the signer was locked before it signed: nothing changed");
    expect(await code(signer.handle("decide", { code: CODE, mesh: MESH, verdict: "approve", ids: [a.id] }))).toMatch(/^locked: the signer is locked/);
  });
});

describe("the signer's own desk (wim agent)", () => {
  async function ctxFor(over: { env?: Record<string, string | undefined>; foreground?: boolean; tty?: boolean; programs?: boolean; answer?: string; prompt?: (q: string) => Promise<string>; checks?: SignerChecks }) {
    const root = await scratch("desk");
    const out: string[] = [];
    const runs: Array<[string, readonly string[]]> = [];
    const options: unknown[] = [];
    const run: Run = async (cmd, args, _input, o) => (runs.push([cmd, args]), options.push(o), { code: 0, stdout: "", stderr: "" });
    const { Home } = await import("../src/home.ts");
    const ctx = {
      home: new Home(root, { platform: process.platform, pid: process.pid, uid: process.getuid?.() }),
      env: over.env ?? {},
      args: ["serve"],
      flags: new Map<string, string | true>(over.foreground === true ? [["foreground", true]] : []),
      io: {
        out: (l: string) => void out.push(l),
        prompt: over.prompt ?? (async () => over.answer ?? ""),
        ...(over.checks === undefined ? {} : { signerChecks: over.checks }),
        isTTY: over.tty ?? true,
        inputIsTTY: over.tty ?? true,
        platform: "linux" as const,
        pid: process.pid,
        ...(over.programs === false ? {} : { programs: { platform: "linux" as const, run, wim: [], trust: OK } }),
      },
    };
    return { ctx: ctx as never as Parameters<typeof signerDesk>[0], out, runs, options, root };
  }
  const ask = (d: Desk, lines: string[] = ["x"], gone?: AbortSignal) => (d.confirm as (l: string[], g?: AbortSignal) => Promise<boolean>)(lines, gone);

  it("takes only a typed y or yes in the foreground", async () => {
    for (const answer of ["yess", "no y", "y y", "ye", ""]) expect(await ask(signerDesk((await ctxFor({ foreground: true, answer })).ctx))).toBe(false);
    for (const answer of ["y", "YES", " yes "]) expect(await ask(signerDesk((await ctxFor({ foreground: true, answer })).ctx))).toBe(true);
  });

  it("ends an ask when the asker goes away, and drops what is typed at a question still open", async () => {
    let answer!: (a: string) => void;
    let prompts = 0;
    const fg = await ctxFor({ foreground: true, prompt: () => (prompts++, new Promise<string>((r) => (answer = r))) });
    const d = signerDesk(fg.ctx);
    const gone = new AbortController();
    const first = ask(d, ["first"], gone.signal);
    await until(() => prompts === 1, "asked");
    gone.abort();
    expect(await first).toBe(false);
    expect(fg.out).toEqual(["first", "No answer in time, or the process that asked went away: declined."]);
    // Asked again: what is typed at the question still open is dropped, never this decision's answer.
    const second = ask(d, ["second"]);
    await until(() => fg.out.includes("second"), "shown");
    expect(fg.out.at(-1)).toBe("An earlier question is still open and counts for nothing: press Enter, then answer this one.");
    answer("y");
    await until(() => prompts === 2, "asked anew");
    answer("n");
    expect(await second).toBe(false);
    // Answered, the next ask is a question of its own; a pre-aborted one declines at once.
    const done = new AbortController();
    done.abort();
    expect(await ask(d, ["third"], done.signal)).toBe(false);
    expect(prompts).toBe(3);
    const fourth = ask(d, ["fourth"]);
    await until(() => fg.out.includes("fourth"), "shown");
    answer("y");
    await until(() => prompts === 4, "asked after the stale one");
    answer("y");
    expect(await fourth).toBe(true);
    // What is waited for: an answer, a time that runs out, or the asker gone.
    expect(await within(Promise.resolve("y"), 1000)).toBe("y");
    expect(await within(new Promise<string>(() => undefined), 20)).toBeUndefined();
    expect(await within(new Promise<string>(() => undefined), 60_000, done.signal)).toBeUndefined();
  });

  it("gives the dialog the asker's going away, and refuses to ask under an agent among its parents or off its own terminal", async () => {
    const gui = await ctxFor({});
    const gone = new AbortController().signal;
    expect(await ask(signerDesk(gui.ctx), ["x"], gone)).toBe(true);
    expect(gui.options).toEqual([{ timeoutMs: 300_000, signal: gone }]);
    const checks = (over: Partial<SignerChecks>): SignerChecks => ({ agentAncestor: async () => undefined, terminal: async () => undefined, askedBy: async () => undefined, ...over });
    const above = "process 7 above this signer (bash) has CLAUDECODE set";
    for (const foreground of [false, true]) {
      const c = await ctxFor({ foreground, answer: "y", checks: checks({ agentAncestor: async () => above }) });
      await expect(ask(signerDesk(c.ctx))).rejects.toThrow(new AgentError("refused", `${above}, so this signer cannot tell you from an agent: a decision on held messages needs a signer you started yourself (\`wim agent start\` in your own terminal, or at log in)`));
      expect([c.runs, c.out]).toEqual([[], []]);
    }
    const lost = await ctxFor({ checks: checks({ agentAncestor: async () => Promise.reject(new Error("EACCES")) }) });
    await expect(ask(signerDesk(lost.ctx))).rejects.toThrow("the processes above this signer could not be read (EACCES), so this signer cannot tell you from an agent");
    const tty = await ctxFor({ foreground: true, answer: "y", checks: checks({ terminal: async () => "this signer's input is not its controlling terminal" }) });
    await expect(ask(signerDesk(tty.ctx))).rejects.toThrow("this signer's input is not its controlling terminal, so this signer cannot tell you from an agent");
    // The terminal is the foreground's check only; with none found, it asks.
    expect(await ask(signerDesk((await ctxFor({ checks: checks({ terminal: async () => "no" }) })).ctx))).toBe(true);
    expect(await ask(signerDesk((await ctxFor({ foreground: true, answer: "y", checks: checks({}) })).ctx))).toBe(true);
  });

  it("finds a resume's device in the mesh's roster, and none in a mesh it does not have", async () => {
    const w = await world();
    const ctx = { home: w.two.home, env: {}, args: ["serve"], flags: new Map(), io: { platform: process.platform, pid: process.pid } } as never as Parameters<typeof signerDesk>[0];
    expect(await signerDesk(ctx).device(w.mesh, "one")).toBe(w.devices[0]!.device.id);
    expect(await signerDesk(ctx).device(w.mesh, "nobody")).toBeUndefined();
    expect(await signerDesk(ctx).device(b64u.encode(randomBytes(16)), "one")).toBeUndefined();
    expect(await signerDesk({ ...(ctx as object), env: { CLAUDECODE: "1" } } as never).device(w.mesh, "one")).toBe(w.devices[0]!.device.id);
  });

  it("asks in its own terminal in the foreground, in a dialog otherwise, and nobody under an agent's variables", async () => {
    const fg = await ctxFor({ foreground: true, answer: " Y " });
    const d1 = signerDesk(fg.ctx);
    expect(await (d1.confirm as (l: string[]) => Promise<boolean>)(["one", "two"])).toBe(true);
    expect(fg.out).toEqual(["one", "two"]);
    expect(await (signerDesk((await ctxFor({ foreground: true, answer: "n" })).ctx).confirm as (l: string[]) => Promise<boolean>)([])).toBe(false);
    // In the foreground but piped: the dialog, not the pipe.
    const piped = await ctxFor({ foreground: true, tty: false });
    expect(await (signerDesk(piped.ctx).confirm as (l: string[]) => Promise<boolean>)(["x"])).toBe(true);
    expect(piped.runs[0]![0]).toBe("/usr/bin/zenity");
    expect(signerDesk((await ctxFor({ programs: false })).ctx).confirm).toEqual({ cannot: expect.stringContaining("no terminal or dialog to ask you in") });
    for (const env of [{ CLAUDECODE: "1" }, { CODEX_SANDBOX: "seatbelt" }, { CURSOR_AGENT: "1" }]) {
      expect(signerDesk((await ctxFor({ foreground: true, env })).ctx).confirm).toEqual({ cannot: expect.stringContaining("runs in an agent's environment and cannot tell you from the agent") });
    }
    // What it reads is the state directory's own held items, only the ids asked.
    const w = await ctxFor({});
    expect(await signerDesk(w.ctx).read(b64u.encode(randomBytes(16)), [ulid()])).toEqual([]);
  });

  it("shows a dialog per platform, with the text only as data, and says why when none can show", async () => {
    const text = 'a <b>&amp;</b>\nquote " end'
    expect(kdialogText(text)).toBe('a (b)+amp;(/b)\nquote " end')
    const mac = confirmPrompts("darwin", text)[0]!;
    expect(mac.cmd).toBe("/usr/bin/osascript");
    expect(mac.args.at(-1)).toBe(text);
    expect(mac.args.slice(0, -1).join(" ")).not.toContain("quote");
    const win = confirmPrompts("win32", "it's")[0]!;
    expect(Buffer.from(win.args.at(-1)!, "base64").toString("utf16le")).toContain("'it''s'");
    const linux = confirmPrompts("linux", text);
    expect(linux.map((p) => p.cmd)).toEqual(["/usr/bin/zenity", "/usr/bin/kdialog"]);
    expect(linux[0]!.args).toContain("--no-markup");
    expect(linux[0]!.args).toContain(`--text=${text}`);
    expect(linux[1]!.args.at(-1)).toBe(kdialogText(text));

    const answers = (...rs: Array<{ code: number | null; stderr?: string } | "missing">): Run => {
      const queue = [...rs];
      return async () => {
        const r = queue.shift()!;
        if (r === "missing") throw Object.assign(new Error("spawn"), { code: "ENOENT" });
        return { code: r.code, stdout: "", stderr: r.stderr ?? "" };
      };
    };
    expect(await confirmGui("linux", answers({ code: 0 }), ["x"], OK)).toBe(true);
    for (const code of [1, 2, 5]) expect(await confirmGui("linux", answers({ code }), ["x"], OK)).toBe(false);
    expect(await confirmGui("linux", answers("missing", { code: 0 }), ["x"], OK)).toBe(true);
    // zenity refusing its arguments (a locale that is not UTF-8), then kdialog: asked there.
    expect(await confirmGui("linux", answers({ code: 255, stderr: "This option is not available." }, { code: 0 }), ["x"], OK)).toBe(true);
    await expect(confirmGui("linux", answers({ code: 1, stderr: "Gtk: cannot open display :9" }, { code: null }), ["x"], OK)).rejects.toThrow(/could not show its dialog \(\/usr\/bin\/kdialog: exit null\)/);
    await expect(confirmGui("linux", answers({ code: 1, stderr: "Gtk: cannot open display :9" }, { code: 1, stderr: "kdialog: cannot open display" }), ["x"], OK)).rejects.toThrow(/could not show its dialog \(\/usr\/bin\/kdialog: kdialog: cannot open display\)/);
    await expect(confirmGui("linux", answers("missing", "missing"), ["x"], OK)).rejects.toThrow(/has no dialog to ask you in/);
    await expect(confirmGui("darwin", async () => Promise.reject(new Error("EPERM")), ["x"], OK)).rejects.toThrow("EPERM");
  });
});

describe("a live session whose keys are in the signer", () => {
  it("refuses a forged mark and a resume marker, keeps the items held, and wim doctor lists one left on disk", async () => {
    const w = await world();
    const m1 = await w.one.send("inbox@two", "first");
    await heldIn(w.inbox, 1);
    const box = new HeldBox(w.inbox.files.heldDir, FS);
    await box.mark(m1.id, "approve");
    await fs.mkdir(w.inbox.files.controlDir, { recursive: true });
    await fs.writeFile(join(w.inbox.files.controlDir, "resume-a@one"), "");
    await until(() => w.logs.some((l) => l.includes(`unsigned approve mark for held message ${m1.id}`)) && w.logs.some((l) => l.includes("unsigned resume of a@one")), "both refused");
    expect(w.logs.find((l) => l.includes("unsigned approve mark"))).toContain("it stays held");
    expect((await w.inbox.held.list()).map((h) => h.id)).toEqual([m1.id]);
    expect((await w.inbox.spool.unread()).filter((i) => i.kind !== "notice")).toEqual([]);
    // Nobody runs the session: a mark stays on disk, and doctor says so.
    await w.inbox.stop();
    await box.mark(m1.id, "refuse");
    expect(await unsignedMarks(w.files, FS)).toEqual([expect.stringMatching(new RegExp(`held[\\\\/]${m1.id}\\.refuse$`))]);
    const t = term(w.two.root, w.relay);
    await run(t, "doctor");
    expect(said(t)).toMatch(/held messages: 1 unsigned decision file, refused while the keys are in the signer \(mesh \S+: sessions[\\/]\S+[\\/]held[\\/]\S+\.refuse\)\. Nothing acts on them/);
    await box.mark(ulid(), "resume");
    await fs.writeFile(join(w.inbox.files.controlDir, "resume-c@three"), "");
    await fs.writeFile(join(w.inbox.files.controlDir, "resume-c@three.tmp"), "");
    await fs.writeFile(join(w.inbox.files.controlDir, `send-${ulid()}.json`), "{}");
    expect((await unsignedMarks(w.files, FS)).filter((p) => p.includes("control"))).toEqual([expect.stringMatching(/control[\\/]resume-c@three$/)]);
    await fs.rm(join(w.inbox.files.controlDir, "resume-c@three"));
    const t2 = term(w.two.root, w.relay);
    await run(t2, "doctor");
    expect(said(t2)).toContain("held messages: 2 unsigned decision files");
  });

  it("releases only what a signed approval covers; a replay or a changed copy releases nothing new", async () => {
    const w = await world();
    const a = [await w.one.send("inbox@two", "a one"), await w.one.send("inbox@two", "a two")];
    const b = await w.three.send("inbox@two", "from three");
    await heldIn(w.inbox, 3);
    w.answers.next.push(true);
    const d = await w.ask({ verdict: "approve", ids: a.map((m) => m.id) });
    expect(w.answers.said[0]!.join("\n")).toContain("a one");
    expect(w.answers.said[0]!.join("\n")).not.toContain("from three");
    // wim agent's own desk reads the same items, and only the ids asked.
    const ctx = { home: w.two.home, env: {}, args: ["serve"], flags: new Map(), io: { platform: process.platform, pid: process.pid } } as never as Parameters<typeof signerDesk>[0];
    expect((await signerDesk(ctx).read(w.mesh, [a[0]!.id])).map((c) => [c.item.id, c.session])).toEqual([[a[0]!.id, "inbox"]]);
    const box = new HeldBox(w.inbox.files.heldDir, FS);
    await box.leaveDecision(d);
    await until(async () => (await w.inbox.held.list()).length === 1, "set A released");
    expect((await w.inbox.held.list()).map((h) => h.id)).toEqual([b.id]);
    expect((await w.inbox.spool.unread()).filter((i) => i.kind !== "notice").map((i) => i.id).sort()).toEqual(a.map((m) => m.id).sort());
    // The same decision again, after another from device one arrived: nothing new is released.
    const a3 = await w.one.send("inbox@two", "a three");
    await heldIn(w.inbox, 2);
    await box.leaveDecision(d);
    await until(async () => (await fs.readdir(w.inbox.files.heldDir)).every((n) => !n.endsWith(".decision")), "replay taken");
    expect((await w.inbox.held.list()).map((h) => h.id).sort()).toEqual([b.id, a3.id].sort());
    // B's copy, rewritten after the person was shown it, is not the copy they approved.
    w.answers.next.push(true);
    const db = await w.ask({ verdict: "approve", ids: [b.id] });
    const held = (await box.get(b.id))!;
    await w.inbox.stop();
    await box.add({ ...held, entry: { ...held.entry, text: "swapped" } });
    const again = await w.open("inbox");
    await new HeldBox(again.files.heldDir, FS).leaveDecision(db);
    await until(async () => (await fs.readdir(again.files.heldDir)).every((n) => !n.endsWith(".decision")), "changed copy taken");
    expect((await again.held.list()).map((h) => h.id).sort()).toEqual([b.id, a3.id].sort());
    // A forged or tampered decision file: refused with why, and logged.
    await new HeldBox(again.files.heldDir, FS).leaveDecision({ ...d, items: [{ id: a3.id, digest: heldDigest((await again.held.get(a3.id))!) }] });
    await until(() => w.logs.some((l) => l.includes("a decision file for held messages: the decision is refused: its signature is not this device's signer's; nothing changed")), "tampered refused");
    await fs.writeFile(join(again.files.heldDir, `${ulid()}.decision`), "not json");
    await until(() => w.logs.some((l) => l.includes("the decision is refused: it is not a decision")), "junk refused");
    expect((await again.held.list()).length).toBe(2);
  });

  it("takes decide and resume from its own process only with the signer's decision for them", async () => {
    const w = await world();
    const m1 = await w.one.send("inbox@two", "one");
    const m2 = await w.one.send("inbox@two", "two");
    await heldIn(w.inbox, 2);
    const box = new HeldBox(w.inbox.files.heldDir, FS);
    for (const id of [m1.id, m2.id]) await box.add({ ...(await box.get(id))!, reason: "breaker" });
    const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code: string; message: string }) => `${e.code}: ${e.message}`);
    expect(await code(w.inbox.decide(m1.id, "approve"))).toMatch(new RegExp(`^needs_signer: ${NEEDS_SIGNER}: the decision is refused: it is not a decision`));
    w.answers.next.push(true, true, true);
    const refuse = await w.ask({ verdict: "refuse", ids: [m1.id] });
    expect(await code(w.inbox.decide(m1.id, "approve", refuse))).toBe(`needs_signer: ${NEEDS_SIGNER}: it does not approve ${m1.id} as it is held`);
    expect(await code(w.inbox.decide(m2.id, "refuse", refuse))).toBe(`needs_signer: ${NEEDS_SIGNER}: it does not refuse ${m2.id} as it is held`);
    expect(await code(w.inbox.decide(ulid(), "refuse", refuse))).toMatch(/^not_found/);
    expect(await code(w.inbox.resumePeer("a@one"))).toMatch(/^needs_signer: .*it is not a decision/);
    expect(await code(w.inbox.resumePeer("a@one", refuse))).toBe(`needs_signer: ${NEEDS_SIGNER}: it does not resume a@one`);
    const resume = await w.ask({ verdict: "resume", ids: [m2.id], peer: "a@one" });
    expect(await code(w.inbox.resumePeer("c@three", resume))).toBe(`needs_signer: ${NEEDS_SIGNER}: it does not resume c@three`);
    // A resume releases what it covers, not everything the pause held.
    expect(await w.inbox.resumePeer("a@one", resume)).toBe(1);
    expect((await w.inbox.held.list()).map((h) => h.id)).toEqual([m1.id]);
    await w.inbox.decide(m1.id, "refuse", refuse);
    expect(await w.inbox.held.list()).toEqual([]);
    // An approve the signer signed with a peer in it resumes nothing.
    const forged = signDecision({ v: 1, device: w.device.id, mesh: w.mesh, verdict: "approve", peer: "a@one", items: [], at: Date.now(), n: ulid() }, signKeyOf(w.keys));
    expect(await code(w.inbox.resumePeer("a@one", forged))).toBe(`needs_signer: ${NEEDS_SIGNER}: it does not resume a@one`);
    // A resume covers only breaker holds from its peer's device: the signer refuses one over any other.
    const m3 = await w.one.send("inbox@two", "three");
    const m4 = await w.three.send("inbox@two", "four");
    await heldIn(w.inbox, 2);
    await box.add({ ...(await box.get(m3.id))!, reason: "breaker" });
    await expect(w.ask({ verdict: "resume", ids: [m3.id, m4.id], peer: "a@one" })).rejects.toThrow(`held message ${m4.id} is not held by the loop breaker from a@one's device: a resume releases only those`);
    await box.add({ ...(await box.get(m4.id))!, reason: "breaker" });
    await expect(w.ask({ verdict: "resume", ids: [m4.id], peer: "a@one" })).rejects.toThrow(`held message ${m4.id} is not held by the loop breaker from a@one's device`);
    w.answers.next.push(true);
    await box.leaveDecision(await w.ask({ verdict: "resume", ids: [m3.id], peer: "a@one" }));
    await until(async () => (await w.inbox.held.list()).length === 1, "resumed");
    expect((await w.inbox.held.list()).map((h) => h.id)).toEqual([m4.id]);
    expect(w.answers.said.at(-1)![2]).toBe(`Resume a@one (device id ${w.devices[0]!.device.id}): lift the loop breaker's pause on its device and release 1 held message.`);
    // A resume signed over a policy hold (no signer of this device's makes one) still releases only breaker holds.
    const policy = (await box.get(m4.id))!;
    await box.add({ ...policy, reason: "policy" });
    const wide = signDecision({ v: 1, device: w.device.id, mesh: w.mesh, verdict: "resume", peer: "c@three", items: [{ id: m4.id, digest: heldDigest({ ...policy, reason: "policy" }) }], at: Date.now(), n: ulid() }, signKeyOf(w.keys));
    expect(await w.inbox.resumePeer("c@three", wide)).toBe(0);
    expect((await w.inbox.held.list()).map((h) => h.id)).toEqual([m4.id]);
    // The peer is an address whose device the roster names, never text the asker made up.
    await expect(w.ask({ verdict: "resume", ids: [], peer: "x@gone" })).rejects.toThrow("no device named gone is in this mesh's roster: nothing to resume");
    await expect(w.ask({ verdict: "resume", ids: [], peer: "nothing (this only refreshes the signer, it is safe to Sign) x@one" })).rejects.toThrow("a resume's peer is a session address (name@device)");
    expect(w.answers.said).toHaveLength(3);
  });

  it("decides nothing while the signer is locked or stopped, and the person may decline", async () => {
    const w = await world();
    const m1 = await w.one.send("inbox@two", "one");
    await heldIn(w.inbox, 1);
    const t = term(w.two.root, w.relay);
    t.answers.push("y");
    expect(await run(t, "held", "approve", m1.id)).toBe(1);
    expect(t.err.join("\n")).toContain(`${NEEDS_SIGNER}: you declined it in the signer: nothing changed`);
    expect(said(t)).toContain("Confirm it in the signer too: its dialog, or the terminal it runs in.");
    w.signer.lock();
    t.answers.push("y");
    expect(await run(t, "held", "approve", m1.id)).toBe(1);
    expect(t.err.join("\n")).toMatch(/the signer is locked/);
    await w.server.close();
    t.answers.push("y");
    expect(await run(t, "held", "refuse", m1.id)).toBe(1);
    expect(t.err.join("\n")).toMatch(/no signer is running|no signer answers/);
    expect((await w.inbox.held.list()).map((h) => h.id)).toEqual([m1.id]);
    expect((await w.inbox.spool.unread()).filter((i) => i.kind !== "notice")).toEqual([]);
  });

  it("refuses a decision asked for under each agent variable or piped I/O, before the signer is asked", async () => {
    const w = await world();
    const m1 = await w.one.send("inbox@two", "one");
    await heldIn(w.inbox, 1);
    for (const env of [{ CLAUDECODE: "1" }, { CODEX_SANDBOX: "seatbelt" }, { CURSOR_AGENT: "1" }, { GEMINI_CLI: "1" }]) {
      const t = term(w.two.root, w.relay, {}, env);
      t.answers.push("y");
      expect(await run(t, "held", "approve", m1.id)).toBe(1);
      expect(t.err.join("\n")).toMatch(/is set: this shell belongs to/);
    }
    for (const io of [{ isTTY: false }, { inputIsTTY: false }]) {
      const t = term(w.two.root, w.relay, io);
      t.answers.push("y");
      expect(await run(t, "held", "approve", m1.id)).toBe(1);
      expect(t.err.join("\n")).toMatch(/not an interactive terminal/);
    }
    expect(w.answers.said).toEqual([]);
    expect((await w.inbox.held.list()).map((h) => h.id)).toEqual([m1.id]);
  });

  it("wim held approves a set, one item, and resumes, each after the signer's confirmation", async () => {
    const w = await world();
    const a = [await w.one.send("inbox@two", "a one"), await w.one.send("inbox@two", "a two")];
    const b = await w.three.send("inbox@two", "b one");
    await heldIn(w.inbox, 3);
    const t = term(w.two.root, w.relay);
    w.answers.next.push(true);
    t.answers.push("all");
    expect(await run(t, "held", "approve", a[0]!.id)).toBe(0);
    await until(async () => (await w.inbox.held.list()).length === 1, "set approved");
    // The code it printed is the one the signer showed.
    const printed = /The signer shows the code (\d{6}): confirm only if it does\./.exec(said(t))![1]!;
    expect(w.answers.said[0]![1]).toContain(`Code ${printed}: `);
    expect(w.answers.said[0]![2]).toBe("Approve 2 held messages: they are delivered to your agents.");
    // Nobody runs the session now: the decision is applied on disk.
    await w.inbox.stop();
    w.answers.next.push(true);
    t.answers.push("y");
    expect(await run(t, "held", "refuse", b.id)).toBe(0);
    expect(await new HeldBox(w.inbox.files.heldDir, FS).list()).toEqual([]);
    // Breaker holds: approve one, then resume the device.
    const again = await w.open("inbox");
    const c = [await w.one.send("inbox@two", "c one"), await w.one.send("inbox@two", "c two"), await w.one.send("inbox@two", "c three")];
    await heldIn(again, 3);
    await again.stop();
    const box = new HeldBox(again.files.heldDir, FS);
    for (const m of c) await box.add({ ...(await box.get(m.id))!, reason: "breaker" });
    w.answers.next.push(true);
    t.answers.push("one", "y");
    expect(await run(t, "held", "approve", c[0]!.id)).toBe(0);
    w.answers.next.push(true);
    t.answers.push("one", "resume");
    expect(await run(t, "held", "approve", c[1]!.id)).toBe(0);
    expect(w.answers.said.at(-1)![2]).toBe(`Resume a@one (device id ${w.devices[0]!.device.id}): lift the loop breaker's pause on its device and release 2 held messages.`);
    expect(await box.list()).toEqual([]);
    const d = await w.open("inbox");
    const e = [await w.one.send("inbox@two", "e one")];
    await heldIn(d, 1);
    await d.stop();
    await box.add({ ...(await box.get(e[0]!.id))!, reason: "breaker" });
    w.answers.next.push(true);
    t.answers.push("y");
    expect(await run(t, "held", "resume", "a@one")).toBe(0);
    expect(said(t)).toContain("Resumed a@one; released 1 held by the breaker.");
  });
});

describe("copies planted where the signer reads, and a decision that fails partway", () => {
  it("refuses an id with a planted copy that shows other text, and signs past a malformed one", async () => {
    const w = await world();
    const m = await w.one.send("inbox@two", "the real text");
    await heldIn(w.inbox, 1);
    const real = (await w.inbox.held.get(m.id))!;
    const planted = new HeldBox(new SessionFiles(w.files, ulid(), FS).heldDir, FS);
    await fs.mkdir(planted.dir, { recursive: true });
    await planted.add({ ...real, at: 1, from: "alice@one", entry: { ...real.entry, text: "lunch at noon?" } });
    await expect(w.ask({ verdict: "approve", ids: [m.id] })).rejects.toThrow(`held message ${m.id} is held in copies that differ in what you would be shown`);
    expect(w.answers.said).toEqual([]);
    // Malformed copies are no copies: the real one alone is shown and signed.
    await planted.add({ ...real, at: Number.NaN });
    await fs.writeFile(join(planted.dir, `${ulid()}.json`), "{}");
    w.answers.next.push(true);
    const d = await w.ask({ verdict: "approve", ids: [m.id] });
    expect(d.items).toEqual([{ id: m.id, digest: heldDigest(real) }]);
    expect(w.answers.said[0]!.filter((l) => /^\d+\. /.test(l))).toEqual([expect.stringMatching(/^1\. from a@one to inbox, msg, .*: the real text$/)]);
  });

  it("decides every other covered item when one of them fails", async () => {
    const w = await world();
    const m = await w.one.send("inbox@two", "plain");
    await heldIn(w.inbox, 1);
    const box = new HeldBox(w.inbox.files.heldDir, FS);
    // A CI notice whose approval pins its rule's ids, held first: only the person's terminal approves it.
    const pinned = item({ at: 1, ci: { rule: "r", pins: { a: "b" } }, rendered: "[CI] pin me" });
    await box.add(pinned);
    w.answers.next.push(true);
    await box.leaveDecision(await w.ask({ verdict: "approve", ids: [pinned.id, m.id] }));
    await until(async () => (await w.inbox.held.list()).length === 1, "the plain one released");
    expect((await w.inbox.held.list()).map((h) => h.id)).toEqual([pinned.id]);
    expect(w.logs.some((l) => l.includes(`wim: held message ${pinned.id}: held CI notice ${pinned.id} pins its rule's ids`) && l.endsWith("; it stays held"))).toBe(true);
  });

  it("on disk, a resume releases only the breaker holds it covers", async () => {
    const w = await world();
    const ms = [await w.one.send("inbox@two", "one"), await w.one.send("inbox@two", "two")];
    await heldIn(w.inbox, 2);
    await w.inbox.stop();
    const box = new HeldBox(w.inbox.files.heldDir, FS);
    for (const m of ms) await box.add({ ...(await box.get(m.id))!, reason: "breaker" });
    w.answers.next.push(true);
    expect(await resumeEverywhere(w.files, "a@one", FS, Date.now, undefined, await w.ask({ verdict: "resume", ids: [ms[0]!.id], peer: "a@one" }))).toBe(1);
    expect((await box.list()).map((h) => h.id)).toEqual([ms[1]!.id]);
  });
});

describe("deciding on disk with a signed decision", () => {
  it("decides only the copies covered, leaves a running session the decision, and a resume the same", async () => {
    const w = await world();
    const m1 = await w.one.send("inbox@two", "one");
    const m2 = await w.one.send("inbox@two", "two");
    await heldIn(w.inbox, 2);
    w.answers.next.push(true, true);
    const d = await w.ask({ verdict: "approve", ids: [m1.id] });
    // The session runs: it gets the decision file, and takes it.
    // As another process would (the session runs in this one): another live pid.
    const cli = { ...FS, pid: LIVE_PID };
    expect(await decideHeld(w.files, m1.id, "approve", cli, Date.now, undefined, d)).toBe(1);
    expect(await decideHeld(w.files, m2.id, "approve", cli, Date.now, undefined, d)).toBe(0);
    await until(async () => (await w.inbox.held.list()).length === 1, "m1 approved");
    const box = new HeldBox(w.inbox.files.heldDir, FS);
    await box.add({ ...(await box.get(m2.id))!, reason: "breaker" });
    const r = await w.ask({ verdict: "resume", ids: [m2.id], peer: "a@one" });
    expect(await resumeEverywhere(w.files, "a@one", cli, Date.now, undefined, r)).toBe(0);
    await until(async () => (await w.inbox.held.list()).length === 0, "resumed in the session");
    // Nobody runs it: a held file's approval is left for the session's next process to fetch.
    await w.inbox.stop();
    const file = item({ fileInfo: { name: "f.txt", size: 3, mime: "text/plain", sha256: "x".repeat(43) } as never, reason: "breaker", from: "a@one", device: w.devices[0]!.device.id });
    await box.add(file);
    w.answers.next.push(true, true);
    const df = await w.ask({ verdict: "approve", ids: [file.id] });
    expect(await decideHeld(w.files, file.id, "approve", FS, Date.now, undefined, df)).toBe(1);
    expect((await fs.readdir(box.dir)).filter((n) => n.endsWith(".decision"))).toEqual([`${df.n}.decision`]);
    const rf = await w.ask({ verdict: "resume", ids: [file.id], peer: "a@one" });
    expect(await resumeEverywhere(w.files, "a@one", FS, Date.now, undefined, rf)).toBe(1);
    expect((await fs.readdir(box.dir)).filter((n) => n.endsWith(".decision")).sort()).toEqual([`${df.n}.decision`, `${rf.n}.decision`].sort());
  });
});

describe("wim events with the keys in the signer", () => {
  async function events(w: Awaited<ReturnType<typeof world>>, withDecide = true, agent?: string) {
    const lines: Array<Record<string, unknown>> = [];
    const input = new PassThrough();
    const stop = new AbortController();
    const session = await MeshSession.open({
      device: w.device,
      mesh: w.files,
      name: "vscode",
      kind: "vscode",
      dialer: w.relay.dialer,
      env: FS,
      tickMs: 20,
      answerMs: 2000,
      reconnectMs: 20,
      random: () => 0.5,
      handover: true,
      sessionKey: "events:vscode",
    });
    const running = runEvents({
      session,
      mesh: w.files,
      env: FS,
      device: w.device,
      version: "t",
      write: (l) => void lines.push(JSON.parse(l) as Record<string, unknown>),
      input,
      signal: stop.signal,
      now: Date.now,
      pollMs: 20,
      leasePollMs: 40,
      ...(withDecide ? { decide: decider({ root: w.two.root, env: w.two.home.env, signPub: w.keys.signPub }) } : {}),
      ...(agent === undefined ? {} : { agent }),
    });
    cleanup.push(async () => {
      stop.abort();
      await running;
      await session.stop();
    });
    let n = 0;
    const request = async (op: string, args: Record<string, unknown>) => {
      const id = `r${++n}`;
      input.write(`${JSON.stringify({ v: 1, id, op, args })}\n`);
      await until(() => lines.some((l) => l["type"] === "response" && l["id"] === id), `response ${id}`);
      return lines.find((l) => l["type"] === "response" && l["id"] === id)!;
    };
    await until(() => lines.some((l) => l["type"] === "snapshot"), "snapshot");
    return { request, session };
  }

  it("approves, refuses and resumes only after the signer's confirmation, and without a way to ask it, not at all", async () => {
    const w = await world();
    const a = [await w.one.send("inbox@two", "a one"), await w.one.send("inbox@two", "a two")];
    const b = await w.three.send("inbox@two", "b one");
    await heldIn(w.inbox, 3);
    await w.inbox.stop();
    const none = await events(w, false);
    expect(await none.request("approve", { held: b.id })).toMatchObject({ ok: false, error: { code: "needs_signer", message: `${NEEDS_SIGNER}, and this process cannot ask it` } });
    await cleanup.pop()!();
    const e = await events(w);
    // Declined in the signer: nothing changes.
    expect(await e.request("approve", { held: a[0]!.id, set: a.map((m) => m.id) })).toMatchObject({ ok: false, error: { message: expect.stringContaining("you declined it in the signer") } });
    w.answers.next.push(true, true);
    expect(await e.request("approve", { held: a[0]!.id, set: a.map((m) => m.id), code: "654321" })).toMatchObject({ ok: true, result: { decided: a.map((m) => m.id), kept: [], gone: [] } });
    expect(w.answers.said.at(-1)![1]).toMatch(/^Code 654321: /);
    expect(w.answers.said[0]![1]).toMatch(/^Code \d{6}: /);
    expect(await e.request("approve", { held: b.id, code: "12" })).toMatchObject({ ok: false, error: { code: "input" } });
    expect(await e.request("refuse", { held: b.id })).toMatchObject({ ok: true, result: {} });
    const box = new HeldBox(new SessionFiles(w.files, w.inbox.sid, FS).heldDir, FS);
    expect(await box.list()).toEqual([]);
    const c = await w.one.send("inbox@two", "c one");
    const again = await w.open("inbox");
    await heldIn(again, 1);
    await again.stop();
    await box.add({ ...(await box.get(c.id))!, reason: "breaker" });
    w.answers.next.push(true);
    expect(await e.request("resume", { peer: "a@one" })).toMatchObject({ ok: true, result: { released: 1 } });
    expect(await box.list()).toEqual([]);
    // Nothing held from it: the signer is still asked, to lift the pause.
    w.answers.next.push(true);
    expect(await e.request("resume", { peer: "a@one" })).toMatchObject({ ok: true, result: { released: 0 } });
    expect(w.answers.said.at(-1)![2]).toContain("release 0 held messages");
  });

  it("is refused under an agent's variables before the signer is asked", async () => {
    const w = await world();
    const m = await w.one.send("inbox@two", "one");
    await heldIn(w.inbox, 1);
    const e = await events(w, true, "CLAUDECODE");
    expect(await e.request("approve", { held: m.id })).toMatchObject({ ok: false, error: { code: "refused", message: expect.stringContaining("CLAUDECODE") } });
    expect(await e.request("resume", { peer: "a@one" })).toMatchObject({ ok: false, error: { code: "refused" } });
    expect(w.answers.said).toEqual([]);
  });
});

describe("without a signer", () => {
  it("takes the person's marks as before, and wim doctor advises the signer", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"], { trust: false });
    const inbox = await openSession(devices[1]!, mesh, relay, { name: "inbox" });
    const one = await openSession(devices[0]!, mesh, relay, { name: "a" });
    cleanup.push(() => inbox.stop(), () => one.stop());
    const m = await one.send("inbox@two", "plain");
    await heldIn(inbox, 1);
    await new HeldBox(inbox.files.heldDir, FS).mark(m.id, "approve");
    await until(async () => (await inbox.held.list()).length === 0, "approved by mark");
    expect((await inbox.spool.unread()).filter((i) => i.kind !== "notice").map((i) => i.id)).toEqual([m.id]);
    const t = term(devices[1]!.root, relay);
    await run(t, "doctor");
    expect(said(t)).toContain("held messages: approved or refused by mark files that any process of yours can write, agents included; with the signer (`wim agent encrypt`, then `wim agent start`) each decision needs its confirmation too (SECURITY-MODEL 7.2)");
  });

  it("wim doctor says nothing of decisions before there are device keys, and with the signer and no marks says they need it", async () => {
    const root = await scratch("doctor");
    const relay = new RelayHarness();
    const t = term(root, relay);
    await run(t, "doctor");
    expect(said(t)).not.toContain("held messages:");
    const w = await world();
    const t2 = term(w.two.root, w.relay);
    await run(t2, "doctor");
    expect(said(t2)).toContain("held messages: each decision needs the signer's confirmation");
  });
});

describe("a decision acted on once", () => {
  it("does nothing the second time, in this session or one opened later; the record is the mesh's, and fails closed", async () => {
    const w = await world();
    const m1 = await w.one.send("inbox@two", "one");
    await heldIn(w.inbox, 1);
    w.answers.next.push(true, true);
    const resume = await w.ask({ verdict: "resume", ids: [], peer: "a@one" });
    expect(await w.inbox.resumePeer("a@one", resume)).toBe(0);
    await expect(w.inbox.resumePeer("a@one", resume)).rejects.toThrow(`decision ${resume.n} was acted on already`);
    const box = new HeldBox(w.inbox.files.heldDir, FS);
    await box.leaveDecision(resume);
    await until(() => w.logs.some((l) => l.includes(`decision ${resume.n} was acted on already (a copy); nothing changed`)), "copy refused");
    expect((await w.inbox.held.list()).map((h) => h.id)).toEqual([m1.id]);
    // The record is in the mesh's directory, by session, and keeps only what is still current.
    const used = join(w.files.dir, "decisions.used");
    const mine = `${w.inbox.sid} ${resume.n}`;
    expect(Object.keys(JSON.parse(await fs.readFile(used, "utf8")))).toEqual([mine]);
    await fs.writeFile(used, JSON.stringify({ [`x ${ulid()}`]: 1, [mine]: Date.now() + 60_000, y: "z" }));
    expect(await useDecision(used, mine, 0, Date.now(), FS)).toBe(false);
    const next = `s ${ulid()}`;
    expect(await useDecision(used, next, Date.now() + 60_000, Date.now(), FS)).toBe(true);
    expect(Object.keys(JSON.parse(await fs.readFile(used, "utf8"))).sort()).toEqual([mine, next].sort());
    // One that cannot be read refuses every decision; it never starts over.
    for (const bad of ["not json", "[]", "1", "null"]) {
      await fs.writeFile(used, bad);
      await expect(useDecision(used, `s ${ulid()}`, Date.now() + 1, Date.now(), FS)).rejects.toThrow(/decisions\.used/);
    }
    w.answers.next.push(true);
    const again = await w.ask({ verdict: "resume", ids: [], peer: "a@one" });
    await expect(w.inbox.resumePeer("a@one", again)).rejects.toThrow(new RegExp(`the record of decisions acted on cannot be read \\(.+\\), so decision ${again.n} is not taken`));
    await box.leaveDecision(again);
    await until(() => w.logs.some((l) => l.includes(`so decision ${again.n} is not taken; nothing changed`)), "refused, unreadable record");
    // A missing record is an empty one.
    await fs.rm(used);
    expect(await useDecision(used, next, Date.now() + 1, Date.now(), FS)).toBe(true);
  });

  it("a resume played again later lifts no pause that started after it was signed, live or on disk", async () => {
    const w = await world();
    w.answers.next.push(true);
    const resume = await w.ask({ verdict: "resume", ids: [], peer: "a@one" });
    await w.inbox.stop();
    const later: PauseRow = { from: "a@one", peer: w.devices[0]!.device.id, rule: "peer", count: 121, limit: 120, minutes: 60, at: resume.at + 1, until: Date.now() + 30 * 60_000, auto: false, told: [] };
    await savePauses(w.inbox.files.breakerPath, { pauses: [later], released: {}, lifts: [], counts: {}, wakes: {} }, FS);
    const { from: _f, told: _t, peer: _p, ...under } = later;
    await new HeldBox(w.inbox.files.heldDir, FS).add(item({ from: "a@one", device: later.peer, reason: "breaker", pause: under }));
    // Nobody runs the session: the pause stays on disk.
    expect(await resumeEverywhere(w.files, "a@one", FS, Date.now, undefined, resume)).toBe(0);
    expect((await readBreakerFile(w.inbox.files.breakerPath)).pauses.map((p) => p.at)).toEqual([later.at]);
    // A session that runs it again, and never saw the decision: the pause stays too.
    const again = await w.open("inbox");
    expect(again.pausedRows().map((r) => r.from)).toEqual(["a@one"]);
    await new HeldBox(again.files.heldDir, FS).leaveDecision(resume);
    await until(async () => (await fs.readdir(again.files.heldDir)).every((n) => !n.endsWith(".decision")), "replay taken");
    await expect(again.resumePeer("a@one", resume)).rejects.toThrow("was acted on already");
    expect(again.pausedRows().map((r) => r.from)).toEqual(["a@one"]);
    // A resume signed after the pause started lifts it.
    await until(() => Date.now() > later.at + 1, "a later time");
    w.answers.next.push(true);
    expect(await again.resumePeer("a@one", await w.ask({ verdict: "resume", ids: [], peer: "a@one" }))).toBe(0);
    expect(again.pausedRows()).toEqual([]);
    // And on disk the same.
    await again.stop();
    await savePauses(w.inbox.files.breakerPath, { pauses: [{ ...later, at: Date.now() - 1000 }], released: {}, lifts: [], counts: {}, wakes: {} }, FS);
    w.answers.next.push(true);
    expect(await resumeEverywhere(w.files, "a@one", FS, Date.now, undefined, await w.ask({ verdict: "resume", ids: [], peer: "a@one" }))).toBe(0);
    expect((await readBreakerFile(w.inbox.files.breakerPath)).pauses).toEqual([]);
  });
});

describe("a decision file that cannot be taken yet", () => {
  it("stays for the next pass (Windows reports it busy)", async () => {
    const dir = await scratch("held");
    const box = new HeldBox(dir, { platform: "win32", pid: process.pid });
    const name = `${ulid()}.decision`;
    await fs.writeFile(join(dir, name), "{}");
    await fs.writeFile(join(dir, "other.txt"), "");
    const rm = fsOps.rm;
    fsOps.rm = async () => Promise.reject(Object.assign(new Error("busy"), { code: "EBUSY" }));
    try {
      expect(await box.takeDecisions()).toEqual([]);
    } finally {
      fsOps.rm = rm;
    }
    expect(await box.takeDecisions()).toEqual([{}]);
    expect(await fs.readdir(dir)).toEqual(["other.txt"]);
  });
});

describe("decisions of any size, and a request queue that keeps answering", () => {
  it("chunks ids at the signer's limit, and the signer takes exactly that many", async () => {
    const ids = (n: number) => Array.from({ length: n }, () => ulid());
    expect(MAX_DECISION_IDS).toBe(1000);
    expect(idChunks([])).toEqual([[]]);
    expect(idChunks(ids(1000)).map((c) => c.length)).toEqual([1000]);
    expect(idChunks(ids(1001)).map((c) => c.length)).toEqual([1000, 1]);
    const asked: number[] = [];
    const fake = (chunk: readonly string[]) => (asked.push(chunk.length), Promise.resolve({ items: chunk.map((id) => ({ id, digest: "" })) } as never as Decision));
    const many = ids(2001);
    const ds = await decisionsFor(fake, many);
    expect(asked).toEqual([1000, 1000, 1]);
    expect(decisionFor(ds, many[1500]!)).toBe(ds[1]);
    // An id none names gets the first, which covers nothing of it; no decisions, none.
    expect(decisionFor(ds, ulid())).toBe(ds[0]);
    expect(decisionFor(undefined, many[0]!)).toBeUndefined();
    await expect(decisionsFor(() => Promise.reject(new Error("declined")), many)).rejects.toThrow("declined");

    const { generateDeviceKeys } = await import("@worldinmotion/protocol");
    const { sealKeyFile } = await import("../src/vault.ts");
    const keys = generateDeviceKeys();
    const data = randomBytes(32);
    const file = await sealKeyFile({ name: "laptop", keys, passphrase: PASS, data, kdf: KDF });
    const signer = new Signer({ file, unlocked: { keys: { ...keys, signSec: keys.signSec.slice(), boxSec: keys.boxSec.slice() }, data }, now: () => T, pid: 1, log: () => undefined, desk: { device: async () => undefined, read: async () => [], confirm: async () => true } });
    const mesh = b64u.encode(randomBytes(16));
    const code = (p: Promise<unknown>) => p.then(() => "ok", (e: AgentError) => e.code);
    // At the limit the request is taken (and finds nothing held); one more is refused as malformed.
    expect(await code(signer.handle("decide", { code: CODE, mesh, verdict: "approve", ids: ids(1000) }))).toBe("refused");
    expect(await code(signer.handle("decide", { code: CODE, mesh, verdict: "approve", ids: ids(1001) }))).toBe("bad_request");
  });

  it("wim held resume of more than one decision's worth asks in parts and releases them all", async () => {
    const w = await world();
    const m = await w.one.send("inbox@two", "one");
    await heldIn(w.inbox, 1);
    await w.inbox.stop();
    const box = new HeldBox(w.inbox.files.heldDir, FS);
    const base = { ...(await box.get(m.id))!, reason: "breaker" as const };
    await box.remove(m.id);
    for (let i = 0; i < MAX_DECISION_IDS + 1; i++) await box.add({ ...base, id: ulid(base.at + i), at: base.at + i });
    const t = term(w.two.root, w.relay);
    w.answers.next.push(true, true);
    t.answers.push("y");
    expect(await run(t, "held", "resume", "a@one")).toBe(0);
    expect(said(t)).toContain(`Confirm it in the signer too, in 2 parts (at most ${MAX_DECISION_IDS} each)`);
    expect(said(t)).toContain(`Resumed a@one; released ${MAX_DECISION_IDS + 1} held by the breaker.`);
    expect(w.answers.said.map((l) => l[2])).toEqual([
      `Resume a@one (device id ${w.devices[0]!.device.id}): lift the loop breaker's pause on its device and release ${MAX_DECISION_IDS} held messages.`,
      `Resume a@one (device id ${w.devices[0]!.device.id}): lift the loop breaker's pause on its device and release 1 held message.`,
    ]);
    expect(await box.list()).toEqual([]);
  }, 120_000);

  it("answers other requests while one waits for the person in the signer, then applies it once, in its turn", async () => {
    const w = await world();
    const m = await w.one.send("inbox@two", "wait for me");
    await heldIn(w.inbox, 1);
    await w.inbox.stop();
    const lines: Array<Record<string, unknown>> = [];
    const input = new PassThrough();
    const stop = new AbortController();
    const session = await MeshSession.open({ device: w.device, mesh: w.files, name: "vscode", kind: "vscode", dialer: w.relay.dialer, env: FS, tickMs: 20, answerMs: 2000, reconnectMs: 20, random: () => 0.5, handover: true, sessionKey: "events:vscode" });
    let open!: () => void;
    const person = new Promise<void>((r) => (open = r));
    let asked = 0;
    const real = decider({ root: w.two.root, env: w.two.home.env, signPub: w.keys.signPub });
    const running = runEvents({
      session, mesh: w.files, env: FS, device: w.device, version: "t", input, signal: stop.signal, now: Date.now, pollMs: 20, leasePollMs: 40,
      write: (l) => void lines.push(JSON.parse(l) as Record<string, unknown>),
      decide: async (req) => {
        asked++;
        await person;
        return real(req);
      },
    });
    cleanup.push(async () => {
      stop.abort();
      await running;
      await session.stop();
    });
    const responses = () => lines.filter((l) => l["type"] === "response").map((l) => l["id"]);
    await until(() => lines.some((l) => l["type"] === "snapshot"), "snapshot");
    const send = (id: string, op: string, args: Record<string, unknown>) => void input.write(`${JSON.stringify({ v: 1, id, op, args })}\n`);
    send("d", "approve", { held: m.id });
    await until(() => asked === 1, "the signer asked");
    send("s", "snapshot", {});
    send("h", "history", { limit: 5 });
    // Both answer while the decision waits for the person, well within a UI's 15 s.
    const started = Date.now();
    await until(() => responses().includes("s") && responses().includes("h"), "answers meanwhile");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(responses()).toEqual(["s", "h"]);
    w.answers.next.push(true);
    open();
    await until(() => responses().includes("d"), "the decision answered");
    expect(lines.find((l) => l["id"] === "d")).toMatchObject({ ok: true, result: {} });
    expect(responses()).toEqual(["s", "h", "d"]);
    expect(asked).toBe(1);
    expect(w.answers.said).toHaveLength(1);
    expect(await new HeldBox(new SessionFiles(w.files, w.inbox.sid, FS).heldDir, FS).list()).toEqual([]);
    expect((await new SessionFiles(w.files, w.inbox.sid, FS).load()) !== undefined).toBe(true);
  });
});

describe("stopping while the person reads the signer, and ids no longer held", () => {
  it("drops the ask when wim events stops: it ends at once, and a later yes signs nothing", async () => {
    const w = await world();
    const m = await w.one.send("inbox@two", "held while we stop");
    await heldIn(w.inbox, 1);
    await w.inbox.stop();
    const lines: Array<Record<string, unknown>> = [];
    const input = new PassThrough();
    const stop = new AbortController();
    const session = await MeshSession.open({ device: w.device, mesh: w.files, name: "vscode", kind: "vscode", dialer: w.relay.dialer, env: FS, tickMs: 20, answerMs: 2000, reconnectMs: 20, random: () => 0.5, handover: true, sessionKey: "events:vscode" });
    const running = runEvents({
      session, mesh: w.files, env: FS, device: w.device, version: "t", input, signal: stop.signal, now: Date.now, pollMs: 20, leasePollMs: 40,
      write: (l) => void lines.push(JSON.parse(l) as Record<string, unknown>),
      decide: decider({ root: w.two.root, env: w.two.home.env, signPub: w.keys.signPub }),
    });
    await until(() => lines.some((l) => l["type"] === "snapshot"), "snapshot");
    let answer!: (yes: boolean) => void;
    w.answers.next.push(new Promise<boolean>((r) => (answer = r)));
    input.write(`${JSON.stringify({ v: 1, id: "d", op: "approve", args: { held: m.id } })}\n`);
    await until(() => w.answers.said.length === 1, "the signer asking");
    const started = Date.now();
    stop.abort();
    await running;
    await session.stop();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(lines.find((l) => l["id"] === "d")).toMatchObject({ ok: false, error: { message: `${NEEDS_SIGNER}: stopped before the signer answered; nothing was decided` } });
    // The person says yes after all: the signer, its asker gone, signs nothing.
    const before = (await w.signer.handle("status", {}))["refused"] as number;
    answer(true);
    await until(async () => ((await w.signer.handle("status", {}))["refused"] as number) === before + 1, "the late yes refused");
    expect((await listAllHeld(w.files, FS)).map((r) => r.id)).toEqual([m.id]);
    // Asked with a stop already given, nothing is sent at all.
    const done = new AbortController();
    done.abort();
    await expect(ask2({ root: w.two.root, env: w.two.home.env, signPub: w.keys.signPub }, { mesh: w.mesh, verdict: "approve", ids: [m.id], code: CODE }, done.signal)).rejects.toThrow(`${NEEDS_SIGNER}: stopped before the signer answered; nothing was decided`);
    expect(w.answers.said).toHaveLength(1);
  });

  it("answers not_found for ids no session holds, without asking the signer", async () => {
    const w = await world();
    const m = await w.one.send("inbox@two", "one");
    await heldIn(w.inbox, 1);
    await w.inbox.stop();
    const lines: Array<Record<string, unknown>> = [];
    const input = new PassThrough();
    const stop = new AbortController();
    const session = await MeshSession.open({ device: w.device, mesh: w.files, name: "vscode", kind: "vscode", dialer: w.relay.dialer, env: FS, tickMs: 20, answerMs: 2000, reconnectMs: 20, random: () => 0.5, handover: true, sessionKey: "events:vscode" });
    const running = runEvents({
      session, mesh: w.files, env: FS, device: w.device, version: "t", input, signal: stop.signal, now: Date.now, pollMs: 20, leasePollMs: 40,
      write: (l) => void lines.push(JSON.parse(l) as Record<string, unknown>),
      decide: decider({ root: w.two.root, env: w.two.home.env, signPub: w.keys.signPub }),
    });
    cleanup.push(async () => {
      stop.abort();
      await running;
      await session.stop();
    });
    await until(() => lines.some((l) => l["type"] === "snapshot"), "snapshot");
    const gone = ulid();
    input.write(`${JSON.stringify({ v: 1, id: "a", op: "approve", args: { held: gone } })}\n`);
    input.write(`${JSON.stringify({ v: 1, id: "r", op: "refuse", args: { held: gone } })}\n`);
    await until(() => lines.filter((l) => l["type"] === "response").length === 2, "answers");
    for (const id of ["a", "r"]) expect(lines.find((l) => l["id"] === id)).toMatchObject({ ok: false, error: { code: "not_found", message: `no held message ${gone}` } });
    expect(w.answers.said).toEqual([]);
    expect((await listAllHeld(w.files, FS)).map((r) => r.id)).toEqual([m.id]);
  });
});

describe("a stop that lands just after the signer proved itself", () => {
  it("sends no decide", async () => {
    const w = await world();
    const { SignerClient } = await import("../src/signer.ts");
    const stop = new AbortController();
    const hello = SignerClient.prototype.hello;
    const close = SignerClient.prototype.close;
    const clients: InstanceType<typeof SignerClient>[] = [];
    // The stop comes once the hello is checked; the connection is kept open, so only the request's own check stops the decide.
    vi.spyOn(SignerClient.prototype, "hello").mockImplementation(async function (this: InstanceType<typeof SignerClient>) {
      const r = await hello.call(this);
      stop.abort();
      return r;
    });
    vi.spyOn(SignerClient.prototype, "close").mockImplementation(function (this: InstanceType<typeof SignerClient>) {
      clients.push(this);
    });
    try {
      await expect(requestDecision({ root: w.two.root, env: w.two.home.env, signPub: w.keys.signPub }, { mesh: w.mesh, verdict: "resume", ids: [], peer: "a@one", code: CODE }, stop.signal)).rejects.toThrow(`${NEEDS_SIGNER}: stopped before the signer answered; nothing was decided`);
    } finally {
      vi.restoreAllMocks();
      for (const c of clients) close.call(c);
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(w.answers.said).toEqual([]);
    expect(((await w.signer.handle("status", {}))["ops"] as Record<string, number>)["decide"]).toBeUndefined();
  });
});

describe("a stop that lands while connecting to the signer", () => {
  it("closes the socket mid-handshake, sends no decide, and returns at once", async () => {
    const { createServer } = await import("node:net");
    const root = await scratch("dialing");
    const env = { platform: process.platform, pid: process.pid, uid: process.getuid?.() };
    const at = (await agentEndpoint(root, env, true))!;
    const seen: string[] = [];
    let closed = false;
    let connected!: () => void;
    const reached = new Promise<void>((r) => (connected = r));
    // Takes the hello and never answers it: the handshake is held open.
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        for (const line of chunk.split("\n").filter((l) => l !== "")) seen.push((JSON.parse(line) as { op: string }).op);
        connected();
      });
      socket.on("error", () => undefined);
      socket.on("close", () => (closed = true));
    });
    await new Promise<void>((r) => server.listen(at, () => r()));
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
    const stop = new AbortController();
    const asked = requestDecision({ root, env, signPub: randomBytes(32) }, { mesh: b64u.encode(randomBytes(16)), verdict: "approve", ids: [ulid()], code: CODE }, stop.signal);
    await reached;
    const started = Date.now();
    stop.abort();
    await expect(asked).rejects.toThrow(`${NEEDS_SIGNER}: stopped before the signer answered; nothing was decided`);
    expect(Date.now() - started).toBeLessThan(2_000);
    await until(() => closed, "the socket closed");
    expect(seen).toEqual(["hello"]);
  });
});
