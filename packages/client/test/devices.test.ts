// Adding a device without the y/N dance (SPEC section 5, SECURITY-MODEL section 5.6): the person
// types the comparison code the new device shows, only at an interactive terminal with no agent's
// variables; admin-device sessions keep join requests on disk for `wim devices pending` and
// `wim devices admit`; and both sides are asked whether the other device is the person's own.

import { b64u, createJoin, generateDeviceKeys, parseInvite, sasFor, type JoinBody } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitPending, issueInvite, joinMesh } from "../src/admin.ts";
import { ClientError, MeshSession } from "../src/client.ts";
import { Invites, PENDING_MAX, PendingJoins, sameCode } from "../src/joins.ts";
import { MeshFiles } from "../src/mesh.ts";
import { canConfirm } from "../src/secretout.ts";
import { FS, inviteCodeOf, makeMesh, newDevice, openSession, RELAY, RelayHarness, run, said, sasOf, scratch, term, until, type TestDevice } from "./helpers.ts";

const open: MeshSession[] = [];
const later: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop({ ended: true }).catch(() => undefined);
  for (const f of later.splice(0)) await f().catch(() => undefined);
});

async function session(...args: Parameters<typeof openSession>): Promise<MeshSession> {
  const s = await openSession(...args);
  open.push(s);
  return s;
}

/** An invite issued from a short admin session that then ends: nobody is at `wim invite`. */
async function inviteAndLeave(relay: RelayHarness, admin: TestDevice, mesh: string, auto = false): Promise<string> {
  const s = await openSession(admin, mesh, relay, { name: "inviter", kind: "cli" });
  const inv = await issueInvite(s, { ttlMs: 3_600_000, auto, now: Date.now });
  await s.stop({ ended: true });
  return inv.code;
}

/** A device joining with `code`, waiting for an admin; resolves its comparison code once shown. */
async function joining(relay: RelayHarness, name: string, code: string) {
  const d = await newDevice(name);
  let sas = "";
  const done = joinMesh({ home: d.home, device: d.device, code, dialer: relay.dialer, now: Date.now, showSas: (s) => (sas = s) });
  done.catch(() => undefined);
  await until(() => sas !== "");
  return { d, sas, done };
}

describe("the comparison code", () => {
  it("is compared without case, dashes or spaces, reading I and L as 1 and O as 0", () => {
    expect(sameCode("7kq2m-x4d9p", "7KQ2M-X4D9P")).toBe(true);
    expect(sameCode(" 7KQ2M X4D9P ", "7KQ2M-X4D9P")).toBe(true);
    expect(sameCode("1l1i0-o0000", "11110-00000")).toBe(true);
    expect(sameCode("7KQ2M-X4D9Q", "7KQ2M-X4D9P")).toBe(false);
    expect(sameCode("7KQ2M", "7KQ2M-X4D9P")).toBe(false);
  });

  it("is taken only from a terminal on both ends with no agent's variables", () => {
    expect(canConfirm({}, { isTTY: true, inputIsTTY: true })).toBe(true);
    expect(canConfirm({}, { isTTY: true, inputIsTTY: false })).toBe(false);
    expect(canConfirm({}, { isTTY: false, inputIsTTY: true })).toBe(false);
    expect(canConfirm({ CLAUDECODE: "1" }, { isTTY: true, inputIsTTY: true })).toBe(false);
  });
});

describe("join requests kept on an admin device", () => {
  it("are kept by any admin session, told once, and admitted only with the new device's code", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["admin"]);
    // An `--auto` invite gets no exception: admitting a kept request still takes the code.
    const code = await inviteAndLeave(relay, devices[0]!, mesh, true);
    const j = await joining(relay, "newbox", code);
    // The relay queued the request; the next admin session takes it and keeps it.
    const notes: string[] = [];
    const s = await session(devices[0]!, mesh, relay, { name: "watcher", notifier: { notify: async (t) => void notes.push(t) } });
    const pending = new PendingJoins(s.mesh, FS);
    const invites = new Invites(s.mesh, FS, Date.now);
    await until(async () => (await pending.list(s.roster, invites, Date.now())).length === 1);
    expect(notes).toEqual(["worldinmotion: a device named newbox asks to join the mesh (wim devices pending)"]);
    // A second session gets the same request: kept once, told once.
    const s2 = await session(devices[0]!, mesh, relay, { name: "second" });
    await s2.listPeers();
    await s2.settled();
    expect(notes.length).toBe(1);
    const [row] = await pending.list(s.roster, invites, Date.now());
    expect(row).toMatchObject({ name: "newbox", id: j.d.device.id });
    // The kept file holds no comparison code.
    for (const name of await fs.readdir(s.mesh.joinsDir)) expect(await fs.readFile(join(s.mesh.joinsDir, name), "utf8")).not.toContain(j.sas);
    await expect(admitPending(s, "ghost", j.sas, Date.now)).rejects.toMatchObject({ code: "not_found" });
    await expect(admitPending(s, "newbox", "AAAAA-AAAAA", Date.now)).rejects.toMatchObject({ code: "mismatch" });
    expect(await admitPending(s, "newbox", j.sas.toLowerCase(), Date.now)).toMatchObject({ outcome: "admitted", name: "newbox" });
    expect((await j.done).roster.devices.some((x) => x.name === "newbox")).toBe(true);
    expect(await pending.list(s.roster, invites, Date.now())).toEqual([]);
  }, 20_000);

  it("drop what can no longer be admitted, keep at most 16, and skip what does not read", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["admin", "member"]);
    const s = await session(devices[0]!, mesh, relay, { name: "a" });
    const files = s.mesh;
    const invites = new Invites(files, FS, Date.now);
    const pending = new PendingJoins(files, FS);
    const inv = await issueInvite(s, { ttlMs: 3_600_000, auto: false, now: Date.now });
    const parsed = parseInvite(inv.code);
    const nonce = b64u.encode(new Uint8Array(32).fill(4));
    const body = (name: string, keys = generateDeviceKeys()): JoinBody => {
      const { t: _t, ...rest } = createJoin(parsed, name, keys, nonce);
      return rest;
    };
    const now = Date.now();
    for (let i = 0; i <= PENDING_MAX; i++) expect(await pending.save(body(`d${i}`), inv.exp, now + i)).toBe(true);
    let rows = await pending.list(s.roster, invites, now);
    expect(rows.length).toBe(PENDING_MAX);
    expect(rows[0]!.name).toBe("d1");
    // Saving the same request again is not new.
    const again = body("again");
    // A kept file that no longer reads counts as not kept: the request is new.
    await fs.writeFile(join(files.joinsDir, `${again.invite}.${again.device.id}.json`), "{");
    expect(await pending.save(again, inv.exp, now + 100)).toBe(true);
    expect(await pending.save(again, inv.exp, now + 101)).toBe(false);
    // What does not read, or does not verify, is dropped; other names are left alone.
    await fs.writeFile(join(files.joinsDir, "broken.json"), "{");
    await fs.writeFile(join(files.joinsDir, "odd.json"), JSON.stringify({ v: 1, at: now, exp: inv.exp, body: { ...again, sig: again.proof } }));
    await fs.writeFile(join(files.joinsDir, "partial.json"), JSON.stringify({ v: 1, exp: inv.exp, body: again }));
    await fs.writeFile(join(files.joinsDir, "notes.txt"), "kept");
    rows = await pending.list(s.roster, invites, now);
    expect(rows.length).toBe(PENDING_MAX);
    expect((await fs.readdir(files.joinsDir)).sort().filter((n) => !n.startsWith(inv.inviteId))).toEqual(["notes.txt"]);
    // Past the invite's expiry, every request on it is dropped.
    expect(await pending.list(s.roster, invites, inv.exp)).toEqual([]);
    // A request from a device the roster lists, or on an invite this device does not hold, is dropped.
    await pending.save(body("member", (devices[1]!.device as unknown as { keys: ReturnType<typeof generateDeviceKeys> }).keys), inv.exp, now);
    const unknown = body("stray");
    await pending.save({ ...unknown, invite: "Z".repeat(22) }, inv.exp, now);
    await pending.save(body("left"), inv.exp, now + 200);
    expect((await pending.list(s.roster, invites, now)).map((r) => r.name)).toEqual(["left"]);
    // A used invite takes its requests with it; remove() drops one device's or all.
    await pending.save(body("other"), inv.exp, now + 201);
    const [left, other] = await pending.list(s.roster, invites, now);
    await pending.remove(inv.inviteId, left!.id);
    expect((await pending.list(s.roster, invites, now)).map((r) => r.name)).toEqual(["other"]);
    await invites.markUsed(inv.inviteId);
    expect(await pending.list(s.roster, invites, now)).toEqual([]);
    void other;
  }, 20_000);

  it("are logged, not kept, when the invite record does not read", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["admin"]);
    const lines: string[] = [];
    const s = await session(devices[0]!, mesh, relay, { name: "a", log: (l) => void lines.push(l) });
    const inv = await issueInvite(s, { ttlMs: 3_600_000, auto: false, now: Date.now });
    await fs.writeFile(join(s.mesh.invitesDir, `${inv.inviteId}.json`), "{");
    const { t: _t, ...body } = createJoin(parseInvite(inv.code), "newbox", generateDeviceKeys(), b64u.encode(new Uint8Array(32).fill(4)));
    relay.inject(mesh, JSON.stringify({ t: "join.request", join: body }));
    await until(() => lines.some((l) => l.startsWith("wim: join request not kept:")));
  });

  it("ignore a request for an invite this device did not issue", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["admin", "admin2"]);
    const other = await session(devices[1]!, mesh, relay, { name: "x" });
    // Only admins issue invites: promote the second device first.
    const s = await session(devices[0]!, mesh, relay, { name: "a" });
    const { promoteDevice } = await import("../src/admin.ts");
    await promoteDevice(s, "admin2", Date.now);
    await until(() => other.roster.devices.find((d) => d.name === "admin2")!.role === "admin");
    const code = await inviteAndLeave(relay, devices[1]!, mesh);
    await joining(relay, "newbox", code);
    await s.listPeers();
    await s.settled();
    expect(await new PendingJoins(s.mesh, FS).list(s.roster, new Invites(s.mesh, FS, Date.now), Date.now())).toEqual([]);
    await until(async () => (await new PendingJoins(other.mesh, FS).list(other.roster, new Invites(other.mesh, FS, Date.now), Date.now())).length === 1);
  }, 20_000);
});

describe("wim invite, join and devices", () => {
  it("refuse a confirmation from an agent or a pipe, before any invite exists", async () => {
    const relay = new RelayHarness();
    const { devices } = await makeMesh(relay, ["admin"]);
    const agent = term(devices[0]!.root, relay, {}, { CLAUDECODE: "1" });
    expect(await run(agent, "invite")).toBe(1);
    expect(said(agent)).toMatch(/run `wim invite` in your own terminal: .*an agent is running this command\. For an unattended device you control, `wim invite --auto`/);
    expect(said(agent)).not.toContain("wim1_");
    const piped = term(devices[0]!.root, relay, { inputIsTTY: false });
    expect(await run(piped, "invite")).toBe(1);
    expect(said(piped)).toMatch(/this is not an interactive terminal/);
    expect(await run(piped, "devices", "admit", "x", "AAAAA-AAAAA")).toBe(1);
    expect(said(piped)).toMatch(/run `wim devices admit` in your own terminal/);
    expect(await run(agent, "devices", "admit", "x")).toBe(1);
    expect(said(agent)).toMatch(/usage: wim devices admit <name> <code>/);
  });

  it("admits unattended with --auto, even from an agent, and asks nobody anything", async () => {
    const relay = new RelayHarness();
    const { devices } = await makeMesh(relay, ["admin"]);
    const agent = term(devices[0]!.root, relay, { isTTY: false }, { CLAUDECODE: "1" });
    const b = term(await scratch("auto-b"), relay, {}, { CLAUDECODE: "1" });
    const inviting = run(agent, "invite", "--auto");
    await until(() => said(agent).includes("wim1_"));
    expect(await run(b, "join", inviteCodeOf(agent), "--name", "bot")).toBe(0);
    expect(await inviting).toBe(0);
    expect(said(agent)).toContain("Admitted bot.");
    expect(said(agent)).not.toContain("[y/N]");
    expect(said(agent)).toContain("Messages from bot are held for your approval. If it is your own: wim devices trust bot");
    expect(said(b)).toContain("Messages from admin are held for your approval.");
  }, 20_000);

  it("says when an invite expired unused, and refuses a request whose code the person will not confirm", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["admin"]);
    const a = term(devices[0]!.root, relay);
    expect(await run(a, "invite", "--exp", "150")).toBe(1);
    expect(said(a)).toContain("wim: the invite expired unused.");
    a.out.length = 0;
    a.err.length = 0;
    // Three wrong codes refuse it, and the request is not kept for later.
    a.answers.push("AAAAA-AAAAA", "BBBBB-BBBBB", "CCCCC-CCCCC");
    const inviting = run(a, "invite");
    await until(() => said(a).includes("wim1_"));
    const j = await joining(relay, "newbox", inviteCodeOf(a));
    expect(await inviting).toBe(1);
    expect(said(a)).toMatch(/refused the join: the person did not confirm/);
    expect(said(a)).toMatch(/someone else used the invite: make a new one/);
    const files = new MeshFiles(devices[0]!.home.meshDir(mesh), FS);
    expect((await fs.readdir(files.joinsDir).catch(() => [])).filter((n) => n.includes(j.d.device.id))).toEqual([]);
  }, 20_000);

  it("lists waiting devices and admits one by its code, then asks about trust", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["admin", "member"]);
    const a = term(devices[0]!.root, relay);
    expect(await run(a, "devices", "pending")).toBe(0);
    expect(said(a)).toContain("No device is waiting to join.");
    const m = term(devices[1]!.root, relay);
    expect(await run(m, "devices", "pending")).toBe(0);
    expect(said(m)).toContain("This device is not an admin, so no join requests come here.");
    // `wim invite` stopped before anyone joined: the invite stays valid.
    const inviting = run(a, "invite");
    await until(() => said(a).includes("wim1_"));
    const code = inviteCodeOf(a);
    a.stop.abort();
    expect(await inviting).toBe(1);
    const j = await joining(relay, "newbox", code);
    const p = term(devices[0]!.root, relay);
    expect(await run(p, "devices", "pending")).toBe(0);
    expect(said(p)).toMatch(new RegExp(`^newbox  ${j.d.device.id}  asked \\S+  invite expires \\S+$`, "m"));
    expect(said(p)).toContain("admit one with the comparison code it shows: wim devices admit <name> <code>");
    expect(said(p)).not.toContain(j.sas);
    expect(await run(p, "devices", "admit", "newbox", "AAAAA-AAAAA")).toBe(1);
    expect(said(p)).toMatch(/that is not the comparison code of newbox's request/);
    p.answers.push("yes");
    expect(await run(p, "devices", "admit", "newbox", j.sas)).toBe(0);
    expect(said(p)).toContain("Admitted newbox.");
    expect(said(p)).toContain("Messages from newbox are delivered here; text it relays from others is still held.");
    expect((await new MeshFiles(devices[0]!.home.meshDir(mesh), FS).loadConfig()).policy[j.d.device.id]).toBe("deliver");
    await j.done;
    void sasFor;
  }, 30_000);

  it("refuses to admit a second device under a name the first one took", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["admin"]);
    const first = await joining(relay, "twin", await inviteAndLeave(relay, devices[0]!, mesh));
    const second = await joining(relay, "twin", await inviteAndLeave(relay, devices[0]!, mesh));
    const p = term(devices[0]!.root, relay);
    expect(await run(p, "devices", "admit", "twin", first.sas)).toBe(0);
    await first.done;
    expect(await run(p, "devices", "admit", "twin", second.sas)).toBe(1);
    expect(said(p)).toContain("could not admit twin: the name twin is taken");
  }, 20_000);

  it("asks a joining person about every other device at once, and trusts or untrusts them all", async () => {
    const relay = new RelayHarness();
    const { devices } = await makeMesh(relay, ["admin", "member"], { trust: false });
    const a = term(devices[0]!.root, relay);
    const b = term(await scratch("all-b"), relay);
    a.answers.push(() => sasOf(b), "n");
    b.answers.push("y");
    const inviting = run(a, "invite");
    await until(() => said(a).includes("wim1_"));
    expect(await run(b, "join", inviteCodeOf(a), "--name", "third")).toBe(0);
    expect(await inviting).toBe(0);
    expect(said(b)).toContain("Are admin and member your own devices? Trust their messages here? [y/N] ");
    expect(said(b)).toContain("Messages from admin and member are delivered here; text they relay from others is still held.");
    // A person who says no, or an agent, is told the command.
    const c = term(await scratch("all-c"), relay, {}, { CLAUDECODE: "1" });
    a.answers.push(() => sasOf(c));
    const again = run(a, "invite");
    await until(() => (said(a).match(/wim1_/g) ?? []).length === 2);
    const second = [...said(a).matchAll(/wim1_\S+/g)][1]![0];
    expect(await run(c, "join", second, "--name", "fourth")).toBe(0);
    expect(await again).toBe(0);
    expect(said(c)).not.toContain("[y/N]");
    expect(said(c)).toContain("Messages from admin, member and third are held for your approval. If they are your own: wim devices trust --all");
    // trust --all and untrust --all; --all with a name, or for another action, is a usage error.
    expect(await run(c, "devices", "trust", "--all", "--relayed")).toBe(0);
    expect(said(c)).toContain("Messages from third are delivered, including text it relays from others (bots, CI, external agents).");
    expect(await run(c, "devices", "untrust", "--all")).toBe(0);
    expect(said(c)).toContain("Messages from member are held for approval.");
    expect(await run(c, "devices", "trust", "member", "--all")).toBe(1);
    expect(said(c)).toContain("usage: wim devices trust <name> | --all");
    expect(await run(c, "devices", "revoke", "--all")).toBe(1);
    expect(said(c)).toContain("usage: wim devices revoke <name>");
  }, 30_000);

  it("trusts --all with nobody else in the mesh", async () => {
    const relay = new RelayHarness();
    const { devices } = await makeMesh(relay, ["alone"]);
    const t = term(devices[0]!.root, relay);
    expect(await run(t, "devices", "trust", "--all")).toBe(0);
    expect(said(t)).toContain("No other devices in the mesh.");
    void RELAY;
    void ClientError;
  });
});
