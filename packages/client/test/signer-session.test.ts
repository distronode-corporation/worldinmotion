// End to end through the signer: a device whose key file is encrypted runs sessions whose every
// secret-key operation is a call to `wim agent`, against the in-process relay. Lock, unlock,
// fallback to a plaintext key file, require_signer, and the way back (decrypt).

import { b64u, createPrekey, generateDeviceKeys, randomBytes, sealMessage, type PrekeyBox, type SendFrame } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentServer, Signer, type LogEntry } from "../src/agent.ts";
import { agentDir, agentEndpoint, endpointFiles, writeAgentSettings } from "../src/agentpath.ts";
import { decryptDevice, encryptDevice } from "../src/agentcli.ts";
import { promoteDevice } from "../src/admin.ts";
import type { MeshSession } from "../src/client.ts";
import { fsOps } from "../src/fsx.ts";
import { Home, type Device } from "../src/home.ts";
import { localDeviceKeyring, NeedsSigner } from "../src/keyring.ts";
import { MeshFiles } from "../src/mesh.ts";
import { SignerError } from "../src/signer.ts";
import { openKeyFile, sealKeyFile } from "../src/vault.ts";
import { FS, keysOf, makeMesh, newDevice, openSession, RelayHarness, until, type TestDevice } from "./helpers.ts";

const KDF = { N: 1024, r: 8, p: 1 };
const PASS = "pass phrase";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

async function session(...args: Parameters<typeof openSession>): Promise<MeshSession> {
  const s = await openSession(...args);
  cleanup.push(() => s.stop());
  return s;
}

/** Runs a signer in this process for a test device whose key file is encrypted. */
async function serve(d: TestDevice, log: LogEntry[] = []): Promise<{ signer: Signer; server: AgentServer }> {
  const file = await d.home.readKeyFile();
  if (file === undefined || !("sealed" in file)) throw new Error("not encrypted");
  const signer = new Signer({ file: file.sealed, unlocked: await openKeyFile(file.sealed, PASS), now: Date.now, pid: process.pid, log: (e) => log.push(e) });
  const at = (await agentEndpoint(d.home.root, d.home.env, true))!;
  const server = new AgentServer({ signer, endpoint: at, files: endpointFiles(process.platform) });
  await server.listen();
  cleanup.push(() => server.close());
  return { signer, server };
}

/** Encrypts a test device's key file and runs a signer for it in this process. */
async function underSigner(d: TestDevice): Promise<{ device: Device; signer: Signer; log: LogEntry[]; server: AgentServer }> {
  await encryptDevice(d.home, PASS, KDF);
  const log: LogEntry[] = [];
  const { signer, server } = await serve(d, log);
  const device = (await d.home.loadDevice())!;
  return { device, signer, log, server };
}

const sentFrames = (relay: RelayHarness): SendFrame[] => relay.sentByClients.map((t) => JSON.parse(t) as { t: string }).filter((f): f is SendFrame => f.t === "send");

describe("sessions through the signer", () => {
  it("send and receive with forward secrecy, and no secret of the device on disk", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const one = devices[0]!;
    const files = new MeshFiles(one.home.meshDir(mesh), FS);
    const { device, log } = await underSigner(one);
    expect(device.keyring.kind).toBe("signer");
    expect(device.id).toBe(one.device.id);
    // A prekey a process with the plaintext keys left in the clear, written after the encryption.
    const clear = createPrekey({ mesh, deviceId: one.device.id, signSec: keysOf(one.device).signSec, at: Date.now() - 1000 });
    const before = JSON.parse(await fs.readFile(files.prekeysPath, "utf8")) as { v: 1; keys: unknown[] };
    await fs.writeFile(files.prekeysPath, JSON.stringify({ v: 1, keys: [...before.keys, { prekey: clear.prekey, secret: b64u.encode(clear.secret) }] }));

    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const a = await session(one, mesh, relay, { name: "a", device });
    // The signer sealed the clear one when the session ran the prekey schedule.
    const kept = await fs.readFile(files.prekeysPath, "utf8");
    expect(kept).not.toContain('"secret"');
    expect(kept).toContain(clear.prekey.id);

    const out = await a.send("b@two", "through the signer");
    expect(out.unprotected).toBeUndefined();
    await until(async () => (await b.spool.unread()).length === 1);
    await b.send("a@one", "and back");
    await until(async () => (await a.spool.unread()).length === 1);
    expect((await a.spool.unread())[0]!.rendered).toContain("and back");
    const back = sentFrames(relay).at(-1)!;
    expect((back.boxes[one.device.id] as PrekeyBox).s).toBe(2);

    const text = await fs.readFile(one.home.devicePath, "utf8");
    expect(text).not.toMatch(/signSec|boxSec/);
    expect(log.map((e) => e.op)).toEqual(expect.arrayContaining(["hello", "sign", "seal", "open2", "adopt"]));
    expect(log.every((e) => e.ok || e.code !== undefined)).toBe(true);
  });

  it("locked: sends are refused, and every message that arrives meanwhile is delivered once it is unlocked", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const { device, signer, server } = await underSigner(devices[0]!);
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const logs: string[] = [];
    const a = await session(devices[0]!, mesh, relay, { name: "a", device, log: (l) => logs.push(l) });
    await a.send("b@two", "warm up");
    signer.lock();
    await expect(a.send("b@two", "while locked")).rejects.toThrow(/locked/);
    // Its card cannot be sealed either: said in the log, and sent again once it can be.
    const inner = a as unknown as { sendCard(link: Awaited<ReturnType<typeof a.ready>>, force: boolean): Promise<void> };
    await inner.sendCard(await a.ready(3000), true);
    expect(logs.some((l) => /peer card not sent: .*locked/.test(l))).toBe(true);
    // A card that arrives meanwhile is not read either.
    const card = sealMessage({ roster: b.roster, sender: { deviceId: devices[1]!.device.id, keys: keysOf(devices[1]!.device) }, session: "b", sid: b.sid, to: ["*"], seq: 0, at: Date.now(), kind: "card", card: {}, recipients: b.roster.devices.map((d) => d.id) });
    relay.inject(mesh, JSON.stringify({ t: "card", msg: card }));
    await until(() => logs.some((l) => /peer card not read: .*locked/.test(l)), undefined, "the unread card");
    // Two messages arrive while it is locked: neither opens, neither is acknowledged.
    await b.send("a@one", "first while locked");
    await b.send("a@one", "second while locked");
    await until(() => logs.some((l) => /inbound: .*locked/.test(l)), undefined, "the refused open");
    expect(await a.spool.unread()).toHaveLength(0);
    // Unlocking is a new signer at the same endpoint. Nothing here drops a's relay connection.
    await server.close();
    await serve(devices[0]!);
    await b.send("a@one", "after the unlock");
    const texts = async () => (await a.spool.unread()).map((i) => i.rendered);
    await until(async () => (await texts()).length === 3, undefined, "all three messages");
    const got = (await texts()).join("\n");
    for (const t of ["first while locked", "second while locked", "after the unlock"]) expect(got).toContain(t);
  });

  it("a card the locked signer could not seal is not recorded as sent, and goes on the next pass", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const { device, signer, server } = await underSigner(devices[0]!);
    const a = await session(devices[0]!, mesh, relay, { name: "a", device, tickMs: 3_600_000 });
    type CardState = { cardAt: number; cardPk: string | undefined; sendCard(link: Awaited<ReturnType<typeof a.ready>>, force: boolean): Promise<void> };
    const inner = a as unknown as CardState;
    const cards = (): number => relay.sentByClients.filter((t) => t.startsWith('{"t":"card.set"') && t.includes('"session":"a"')).length;
    await until(() => cards() === 1, undefined, "the first card");
    const sentAt = inner.cardAt;
    const pk = inner.cardPk;
    // As if the prekey had just rotated: the card must go out.
    inner.cardPk = "an older prekey";
    signer.lock();
    await inner.sendCard(await a.ready(3000), false);
    expect(cards()).toBe(1);
    expect(inner.cardAt).toBe(sentAt);
    expect(inner.cardPk).toBe("an older prekey");
    await server.close();
    await serve(devices[0]!);
    await inner.sendCard(await a.ready(3000), false);
    expect(cards()).toBe(2);
    expect(inner.cardPk).toBe(pk);
    expect(inner.cardAt).toBeGreaterThanOrEqual(sentAt);
  });

  it("a failure without a connection, or not the signer's, only logs", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const logs: string[] = [];
    const a = await openSession(devices[0]!, mesh, relay, { name: "a", log: (l) => logs.push(l) });
    const inner = a as unknown as { inboundFailed(error: unknown): void; ack(cursor: number): void; state: { cursor: number }; heldLink: unknown };
    inner.inboundFailed(new Error("disk full"));
    // A frame that waits for the signer: the connection is dropped, and until it is gone nothing
    // more is acknowledged on it, so the relay delivers that frame again.
    const acks = (): number => relay.sentByClients.filter((t) => t.startsWith('{"t":"ack"')).length;
    const before = { acks: acks(), cursor: inner.state.cursor };
    inner.inboundFailed(new SignerError("timeout", "the signer did not answer"));
    inner.ack(before.cursor + 5);
    expect(acks()).toBe(before.acks);
    expect(inner.state.cursor).toBe(before.cursor);
    // The next connection acknowledges again.
    await until(() => a.link !== undefined && a.link.isOpen && a.link !== inner.heldLink, undefined, "a new connection");
    inner.ack(before.cursor + 5);
    expect(acks()).toBe(before.acks + 1);
    await a.stop();
    inner.inboundFailed(new SignerError("locked", "the signer is locked"));
    expect(logs.filter((l) => l.startsWith("wim: inbound: "))).toEqual(["wim: inbound: disk full", "wim: inbound: the signer did not answer", "wim: inbound: the signer is locked"]);
  });

  it("a session running when the key file is encrypted acks nothing it cannot open, and a restart through the signer delivers it", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const one = devices[0]!;
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    const logs: string[] = [];
    // A session on the plaintext key file, taken back after its restart by the same key.
    const before = await openSession(one, mesh, relay, { name: "a", sessionKey: "agent-a", log: (l) => logs.push(l) });
    await b.send("a@one", "before");
    await until(async () => (await before.spool.unread()).length === 1);
    await encryptDevice(one.home, PASS, KDF);
    // It reads the prekey file again (a sibling's rotation, its own schedule): now sealed.
    await (before as unknown as { prekeys: { reload(): Promise<void> } }).prekeys.reload();
    const acks = (): number => relay.sentByClients.filter((t) => t.startsWith('{"t":"ack"')).length;
    const acked = acks();
    let delivered = 0;
    relay.toClient = (text) => {
      if (text.startsWith('{"t":"deliver"')) delivered++;
      return text;
    };
    await b.send("a@one", "sealed after the encrypt");
    await b.send("a@one", "and another");
    await until(() => delivered === 2, undefined, "both delivered to the session");
    // Every frame handed over is on the session's inbound queue; wait for the queue to drain.
    const inner = before as unknown as { inbound: Promise<void> };
    for (let seen: Promise<void> | undefined; seen !== inner.inbound; ) {
      seen = inner.inbound;
      await seen;
      await new Promise((r) => setImmediate(r));
    }
    relay.toClient = undefined;
    // Both are refused alike, said once, and neither is acknowledged or dropped.
    expect(logs.filter((l) => l.includes("while this session was running"))).toHaveLength(1);
    expect(acks()).toBe(acked);
    expect(await before.spool.unread()).toHaveLength(1);
    await before.stop();
    await serve(one);
    const device = (await one.home.loadDevice())!;
    const after = await session(one, mesh, relay, { name: "a", sessionKey: "agent-a", device });
    expect(after.sid).toBe(before.sid);
    await until(async () => (await after.spool.unread()).length === 3, undefined, "both messages, delivered again");
    const texts = (await after.spool.unread()).map((i) => i.rendered).join("\n");
    expect(texts).toContain("sealed after the encrypt");
    expect(texts).toContain("and another");
  });

  it("signs roster changes for an admin device", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const { device } = await underSigner(devices[0]!);
    const a = await session(devices[0]!, mesh, relay, { name: "a", device });
    const next = await promoteDevice(a, "two", Date.now);
    expect(next.by).toBe(device.id);
    expect(next.devices.find((d) => d.name === "two")!.role).toBe("admin");
  });

  it("decrypt brings the plaintext key file back with the same identity and opens the sealed prekeys", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const one = devices[0]!;
    const { server } = await underSigner(one);
    await expect(decryptDevice(one.home, PASS)).rejects.toThrow(/wim agent stop/);
    await server.close();
    const files = new MeshFiles(one.home.meshDir(mesh), FS);
    // A sealed entry that no longer opens, and one that is not a prekey, are dropped on the way.
    const raw = JSON.parse(await fs.readFile(files.prekeysPath, "utf8")) as { v: 1; keys: Array<{ prekey: unknown; sealed: string }> };
    const sealedCount = raw.keys.length;
    await fs.writeFile(files.prekeysPath, JSON.stringify({ v: 1, keys: [...raw.keys, { ...raw.keys[0]!, sealed: "AAAA" }, { nonsense: true }] }));
    await expect(decryptDevice(one.home, "wrong")).rejects.toThrow(/does not open/);
    await decryptDevice(one.home, PASS);
    const back = await one.home.loadDevice();
    expect(back).toMatchObject({ id: one.device.id, name: "one" });
    expect(back!.keyring.kind).toBe("local");
    const kept = JSON.parse(await fs.readFile(files.prekeysPath, "utf8")) as { keys: Array<Record<string, unknown>> };
    expect(kept.keys).toHaveLength(sealedCount);
    expect(kept.keys.every((k) => typeof k["secret"] === "string")).toBe(true);
    const a = await session(one, mesh, relay, { name: "a", device: back! });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    await b.send("a@one", "plaintext again");
    await until(async () => (await a.spool.unread()).length === 1);
  });
});

describe("loading the device: fallback and require_signer", () => {
  it("a plaintext key file is used as before, unless the signer is required", async () => {
    const d = await newDevice("plain");
    expect((await d.home.loadDevice())!.keyring.kind).toBe("local");
    await expect(new Home(d.home.root, { ...d.home.env, requireSigner: true }).loadDevice()).rejects.toThrow(/requires the signer.*wim agent encrypt/);
    await writeAgentSettings(d.home.root, { require_signer: true }, FS);
    await expect(d.home.loadDevice()).rejects.toThrow(/requires the signer/);
  });

  it("an encrypted key file needs a running, unlocked signer holding this very device's keys", async () => {
    const d = await newDevice("sealed");
    await encryptDevice(d.home, PASS, KDF);
    await expect(d.home.createDevice("again")).rejects.toThrow(/already exists/);
    await expect(encryptDevice(d.home, PASS, KDF)).rejects.toThrow(/already encrypted/);
    // The endpoint is known (on Windows: the pipe token exists) and nothing listens there.
    await agentEndpoint(d.home.root, d.home.env, true);
    await expect(d.home.loadDevice()).rejects.toThrow(/no signer is running: run `wim agent start`/);
    await fs.rm(agentDir(d.home.root), { recursive: true });
    await expect(d.home.loadDevice()).rejects.toThrow(/no signer is running/);
    // A signer for another device answers at this device's endpoint.
    const other = generateDeviceKeys();
    const file = await sealKeyFile({ name: "other", keys: other, passphrase: PASS, kdf: KDF });
    const signer = new Signer({ file, unlocked: { keys: other, data: randomBytes(32) }, now: Date.now, pid: 1, log: () => undefined });
    const at = (await agentEndpoint(d.home.root, d.home.env, true))!;
    const server = new AgentServer({ signer, endpoint: at, files: endpointFiles(process.platform) });
    await server.listen();
    cleanup.push(() => server.close());
    await expect(d.home.loadDevice()).rejects.toThrow(/holds another device's keys/);
    await server.close();
    // This device's own signer, locked: refused as locked before anything is asked of it.
    const own = await d.home.readKeyFile();
    if (own === undefined || !("sealed" in own)) throw new Error("not encrypted");
    const mine = new Signer({ file: own.sealed, unlocked: await openKeyFile(own.sealed, PASS), now: Date.now, pid: 1, log: () => undefined });
    mine.lock();
    const locked = new AgentServer({ signer: mine, endpoint: at, files: endpointFiles(process.platform) });
    await locked.listen();
    cleanup.push(() => locked.close());
    await expect(d.home.loadDevice()).rejects.toThrow(/the signer is locked: run `wim agent unlock`/);
  });

  it("refuses a malformed encrypted key file and one with no device", async () => {
    const d = await newDevice("bad");
    const encrypted = await encryptDevice(d.home, PASS, KDF);
    await fs.writeFile(d.home.devicePath, JSON.stringify({ ...encrypted, sealed: "" }), { mode: 0o600 });
    await expect(d.home.loadDevice()).rejects.toThrow(/malformed/);
    await fs.rm(d.home.devicePath);
    await expect(encryptDevice(d.home, PASS, KDF)).rejects.toThrow(/wim init/);
    await expect(decryptDevice(d.home, PASS)).rejects.toThrow(/wim init/);
    const plain = await newDevice("plain2");
    await expect(decryptDevice(plain.home, PASS)).rejects.toThrow(/is not encrypted/);
  });

  it("encrypt and decrypt take each mesh's prekey file as it is: missing, unreadable, another version, mixed", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    // Device two never ran a session: no prekey file. Others are added by hand.
    const two = devices[1]!;
    const dir = (m: string): string => two.home.meshDir(m);
    for (const [m, text] of [
      ["AAAAAAAAAAAAAAAAAAAAAA", "not json"],
      ["BBBBBBBBBBBBBBBBBBBBBA", JSON.stringify({ v: 2, keys: [] })],
    ] as const) {
      await fs.mkdir(dir(m), { recursive: true });
      await fs.writeFile(join(dir(m), "mesh.json"), JSON.stringify({ v: 1 }));
      await fs.writeFile(join(dir(m), "prekeys.json"), text);
    }
    const own = createPrekey({ mesh, deviceId: two.device.id, signSec: keysOf(two.device).signSec, at: Date.now() });
    const prekeys = join(dir(mesh), "prekeys.json");
    expect(await two.home.meshIds()).toContain(mesh);
    await encryptDevice(two.home, PASS, KDF);
    // A sealed entry passes through decrypt's opposite, and a clear one through encrypt's.
    await fs.writeFile(prekeys, JSON.stringify({ v: 1, keys: [{ prekey: own.prekey, sealed: "kept as it is" }] }));
    await fs.writeFile(join(dir("AAAAAAAAAAAAAAAAAAAAAA"), "prekeys.json"), JSON.stringify({ v: 1, keys: [{ prekey: own.prekey, secret: b64u.encode(own.secret) }] }));
    await decryptDevice(two.home, PASS);
    expect(await fs.readFile(join(dir("AAAAAAAAAAAAAAAAAAAAAA"), "prekeys.json"), "utf8")).toContain('"secret"');
    expect(await fs.readFile(prekeys, "utf8")).not.toContain("kept as it is");
    await fs.writeFile(prekeys, JSON.stringify({ v: 1, keys: [{ prekey: own.prekey, sealed: "already sealed" }] }));
    await encryptDevice(two.home, PASS, KDF);
    expect(await fs.readFile(prekeys, "utf8")).toContain("already sealed");
    expect(await fs.readFile(join(dir("BBBBBBBBBBBBBBBBBBBBBA"), "prekeys.json"), "utf8")).toContain('"v":2');
  });

  it("decrypt passes on a key file that opens but does not match itself", async () => {
    const d = await newDevice("odd");
    const other = generateDeviceKeys();
    const mixed = await sealKeyFile({ name: "odd", keys: { ...keysOf(d.device), boxPub: other.boxPub }, passphrase: PASS, kdf: KDF });
    await fs.writeFile(d.home.devicePath, JSON.stringify(mixed), { mode: 0o600 });
    await expect(decryptDevice(d.home, PASS)).rejects.toThrow(/public keys do not match/);
  });

  it("a local keyring cannot open a prekey the signer sealed", async () => {
    const keys = generateDeviceKeys();
    const ring = localDeviceKeyring(keys);
    const pk = await ring.newPrekey(b64u.encode(randomBytes(16)), Date.now());
    const box = { s: 2 as const, p: pk.prekey.id, e: b64u.encode(randomBytes(32)), c: b64u.encode(randomBytes(40)) };
    const req = { mesh: pk.prekey.mesh, sender: "s".repeat(22), recipient: pk.prekey.device, aad: randomBytes(32), senderBox: keys.boxPub, box };
    // Not "key_expired" (the message would be dropped): this process needs a restart.
    await expect(ring.openPrekey({ prekey: pk.prekey, sealed: "x" }, req)).rejects.toBeInstanceOf(NeedsSigner);
    expect(await ring.adopt(pk)).toBe(pk);
  });

  it("encrypting keeps the identity even if sealing the prekeys is interrupted", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const one = devices[0]!;
    const realRename = fsOps.rename;
    let renames = 0;
    // The key file goes first; the next rename (the settings file) fails.
    fsOps.rename = async (from, to) => {
      if (++renames === 2) throw new Error("disk full");
      return realRename(from, to);
    };
    try {
      await expect(encryptDevice(one.home, PASS, KDF)).rejects.toThrow(/disk full/);
    } finally {
      fsOps.rename = realRename;
    }
    const file = await one.home.readKeyFile();
    expect(file !== undefined && "sealed" in file && file.sealed.id).toBe(one.device.id);
    // The prekeys stayed in the clear; a signer seals them on the next schedule.
    expect(await fs.readFile(join(one.home.meshDir(mesh), "prekeys.json"), "utf8")).toContain('"secret"');
  });
});
