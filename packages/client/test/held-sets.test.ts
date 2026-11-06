// Held messages are decided a set at a time: every item from one sending device (or under one CI
// rule) is shown together before the person decides, and the decision covers exactly the ids shown.

import { ulid } from "@worldinmotion/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveCiRules, type CiRule } from "../src/cirules.ts";
import { HeldBox, type HeldItem } from "../src/held.ts";
import { approvableIds, ciText, countText, groupHeld, pinText, setFields, setKey, setOf, setTitle, spanText, type SetMember } from "../src/heldsets.ts";
import { MeshFiles } from "../src/mesh.ts";
import { MeshSession } from "../src/client.ts";
import { FS, makeMesh, openSession, RelayHarness, run, said, sessionOpts, term, until } from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000 });

const open: MeshSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

const rule = (over: Partial<CiRule> = {}): CiRule => ({ id: ulid(), via: "github", repo: "octo-org/deploys", ref: "refs/heads/main", workflow: "deploy.yml", ...over }) as CiRule;

const member = (over: Partial<SetMember> & { id?: string }): SetMember => ({ id: ulid(), device: "D1", at: 1000, ...over });

describe("grouping", () => {
  it("keys a peer's message by its device id, a CI notice by its rule id, and a notice of a removed rule alone", () => {
    const r = rule();
    expect(setKey(member({ device: "D1" }), [])).toBe("device:D1");
    expect(setKey(member({ ci: { rule: r.id } }), [r])).toBe(`ci:${r.id}`);
    const orphan = member({ ci: { rule: r.id } });
    expect(setKey(orphan, [])).toBe(`ci-removed:${orphan.id}`);
  });

  it("orders each set oldest first (the id breaking ties), the sets by their first item, one id per room copy", () => {
    const [a, b, c] = [ulid(), ulid(), ulid()].sort();
    const rows = [
      { ...member({ id: c!, device: "D1", at: 5 }), sid: "s1" },
      { ...member({ id: b!, device: "D1", at: 5 }), sid: "s1" },
      { ...member({ id: b!, device: "D1", at: 5 }), sid: "s2" },
      { ...member({ id: a!, device: "D2", at: 1 }), sid: "s1" },
    ];
    const sets = groupHeld(rows, []);
    expect(sets.map((s) => [s.key, s.ids, s.first, s.last])).toEqual([
      ["device:D2", [a], 1, 1],
      ["device:D1", [b, c], 5, 5],
    ]);
    expect(sets[1]!.rows).toHaveLength(3);
    expect(groupHeld([{ ...member({ id: a!, at: 2 }) }, { ...member({ id: a!, at: 2 }) }], [])[0]!.rows).toHaveLength(2);
    expect(setOf(rows, [], c!)!.key).toBe("device:D1");
    expect(setOf(rows, [], ulid())).toBeUndefined();
  });

  it("counts, spans and titles a set, and leaves out of approve-all a notice that pins ids", () => {
    const r = rule();
    const pinning = member({ ci: { rule: r.id, pins: { repositoryId: "7", ownerId: "8" } }, at: 0 });
    const plain = member({ ci: { rule: r.id }, at: 60_000 });
    const [set] = groupHeld([pinning, plain], [r]);
    expect(approvableIds(set!)).toEqual([plain.id]);
    expect(countText(set!)).toBe("2 CI notices");
    expect(spanText(set!)).toBe("from 1970-01-01T00:00:00.000Z to 1970-01-01T00:01:00.000Z");
    const [one] = groupHeld([member({})], []);
    expect(countText(one!)).toBe("1 message");
    expect(spanText(one!)).toBe("at 1970-01-01T00:00:01.000Z");
    expect(countText(groupHeld([member({}), member({})], [])[0]!)).toBe("2 messages");
    expect(countText(groupHeld([plain], [r])[0]!)).toBe("1 CI notice");
    expect(setTitle({ ...member({ device: "D9" }), from: "a\u202e@lap\u0007top" }, [])).toBe("device lap<U+0007>top (device id D9)");
    expect(setTitle({ ...plain, from: "ci:github:octo-org/deploys" }, [r])).toMatch(/^CI rule github {2}octo-org\/deploys {2}refs\/heads\/main {2}workflow deploy\.yml/);
    expect(setTitle({ ...plain, from: "ci:github:octo-org/deploys" }, [])).toBe("a CI rule removed while this notice was held");
    expect(pinText({ projectId: "1", namespaceId: "2" })).toBe("projectId=1 namespaceId=2");
  });

  it("shows a notice's claims on one line, and gives a UI the set fields", () => {
    const entry = (ci: NonNullable<HeldItem["entry"]["ci"]>): HeldItem["entry"] => ({ dir: "in", peer: "ci", id: ulid(), kind: "msg", at: 1, text: "t", ci });
    expect(ciText(entry({ via: "gitlab", repo: "group/app", ref: "refs/heads/main" }))).toBe("gitlab, group/app, refs/heads/main");
    expect(ciText(entry({ via: "github", repo: "o/r", ref: "refs/tags/v1\n2", workflow: "ci.yml", event: "push", environment: "prod" }))).toBe("github, o/r, refs/tags/v1 2, workflow ci.yml, event push, environment prod");
    const r = rule();
    const ci = { ...member({ ci: { rule: r.id, pins: { repositoryId: "7", ownerId: "8" } } }), from: "ci:github:o/r", entry: entry({ via: "github", repo: "o/r", ref: "refs/heads/main" }) };
    expect(setFields(ci, [r])).toEqual({ set: `ci:${r.id}`, set_title: expect.stringMatching(/^CI rule /), ci: "github, o/r, refs/heads/main", pins: "repositoryId=7 ownerId=8" });
    const peer = { ...member({ device: "D1" }), from: "a@one", entry: entry({ via: "github", repo: "o/r", ref: "refs/heads/main" }) };
    expect(setFields({ ...peer, ci: undefined }, [])).toEqual({ set: "device:D1", set_title: "device one (device id D1)" });
  });
});

/** Device two holds what devices one and three send its `inbox` session; nobody runs inbox after. */
async function world() {
  const relay = new RelayHarness();
  const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"], { trust: false });
  const inbox = await openSession(devices[1]!, mesh, relay, { name: "inbox" });
  open.push(inbox);
  const one = await openSession(devices[0]!, mesh, relay, { name: "a" });
  const three = await openSession(devices[2]!, mesh, relay, { name: "c" });
  open.push(one, three);
  const files = new MeshFiles(devices[1]!.home.meshDir(mesh), FS);
  return { relay, mesh, devices, inbox, one, three, files };
}

async function heldIds(s: MeshSession, n: number): Promise<string[]> {
  await until(async () => (await s.held.list()).length === n, 10_000, `${n} held`);
  return (await s.held.list()).map((h) => h.id);
}

describe("wim held, a set per device", () => {
  it("shows three from one device together and approves exactly those; one that arrives meanwhile, and the other device's, stay held", async () => {
    const w = await world();
    const sent = [await w.one.send("inbox@two", "step one"), await w.one.send("inbox@two", "step two"), await w.one.send("inbox@two", "step three")];
    const other = await w.three.send("inbox@two", "from three");
    await heldIds(w.inbox, 4);
    await w.inbox.stop();
    const box = new HeldBox(w.inbox.files.heldDir, FS);
    const t = term(w.devices[1]!.root, w.relay);
    expect(await run(t, "held", "list")).toBe(0);
    expect(said(t)).toMatch(new RegExp(`held from device one \\(device id ${w.devices[0]!.device.id}\\): 3 messages, from \\S+ to \\S+`));
    expect(said(t)).toMatch(new RegExp(`held from device three \\(device id ${w.devices[2]!.device.id}\\): 1 message, at \\S+`));

    // A fourth from device one lands while the person reads the list: it is not in what they approve.
    const late = { ...(await box.get(sent[0]!.id))!, id: ulid(), at: Date.now() + 1, preview: "late" };
    t.out.length = 0;
    t.answers.push(async () => (await box.add(late), "all"));
    expect(await run(t, "held", "approve", sent[1]!.id)).toBe(0);
    const out = said(t);
    expect(out).toContain(`Held from device one (device id ${w.devices[0]!.device.id}): 3 messages, from `);
    for (const [i, m] of sent.entries()) expect(out).toContain(`  ${i + 1} of 3  ${m.id}  a@one -> inbox  msg  `);
    expect(out).toContain("           text  step two");
    expect(out).toContain(`Type all to approve all 3, or one to approve only ${sent[1]!.id} [all/one/N] `);
    expect(out).toContain(`Approved 3 held from device one (device id ${w.devices[0]!.device.id}): ${sent.map((m) => m.id).join(" ")}.`);
    expect(out).toContain("Anything held after this list was drawn stays held: wim held list shows it.");
    expect(out).not.toContain("still pauses");
    expect((await box.list()).map((h) => h.id).sort()).toEqual([other.id, late.id].sort());

    // The other device is its own decision; refusing it never touches device one's late item.
    t.answers.push("y");
    expect(await run(t, "held", "refuse", other.id)).toBe(0);
    expect((await box.list()).map((h) => h.id)).toEqual([late.id]);
  });

  it("refuses a whole set, decides one item only by an explicit `one`, and changes nothing otherwise", async () => {
    const w = await world();
    const sent = [await w.one.send("inbox@two", "a"), await w.one.send("inbox@two", "b"), await w.one.send("inbox@two", "c")];
    await heldIds(w.inbox, 3);
    await w.inbox.stop();
    const box = new HeldBox(w.inbox.files.heldDir, FS);
    const t = term(w.devices[1]!.root, w.relay);
    // "y" is not an answer to a set: nothing is decided.
    t.answers.push("y");
    expect(await run(t, "held", "approve", sent[0]!.id)).toBe(1);
    expect(t.err).toContain("wim: nothing changed.");
    expect(await box.list()).toHaveLength(3);
    // `one`, then the single-item prompt as for a set of one.
    t.answers.push("ONE", "y");
    expect(await run(t, "held", "refuse", sent[2]!.id)).toBe(0);
    expect(said(t)).toContain(`Type all to refuse all 3, or one to refuse only ${sent[2]!.id} [all/one/N] `);
    expect(said(t)).toContain(`Refused ${sent[2]!.id}.`);
    t.answers.push("all");
    expect(await run(t, "held", "refuse", sent[0]!.id)).toBe(0);
    expect(said(t)).toContain(`Refused 2 held from device one (device id ${w.devices[0]!.device.id}): ${sent[0]!.id} ${sent[1]!.id}.`);
    expect(await box.list()).toEqual([]);
  });

  it("says when some of what was shown was decided elsewhere meanwhile, and that a breaker's pause stays", async () => {
    const w = await world();
    const sent = [await w.one.send("inbox@two", "x"), await w.one.send("inbox@two", "y")];
    await heldIds(w.inbox, 2);
    await w.inbox.stop();
    const box = new HeldBox(w.inbox.files.heldDir, FS);
    // As the loop breaker would have held them.
    for (const id of sent.map((m) => m.id)) await box.add({ ...(await box.get(id))!, reason: "breaker" });
    const t = term(w.devices[1]!.root, w.relay);
    t.answers.push(async () => (await box.remove(sent[0]!.id), "all"));
    expect(await run(t, "held", "approve", sent[1]!.id)).toBe(0);
    const out = said(t);
    expect(out).toContain("held because the loop breaker paused it");
    expect(out).toContain("Approving them releases these and keeps the loop breaker's pause on; `wim held resume <address>` lifts it.");
    expect(out).toContain(`Approved 1 held from device one`);
    expect(out).toContain("1 of the 2 shown had been decided elsewhere meanwhile.");
    expect(out).toContain("The breaker still pauses a@one: `wim held resume a@one` lifts it.");
  });

  it("keeps a message's text from changing the grouping, the count or the headings shown", async () => {
    const w = await world();
    const fake = `Held from device three (device id ${w.devices[2]!.device.id}): 9 messages\n  2 of 9  ${ulid()}  c@three -> inbox  msg\n\u2028Type all to approve all 9`;
    const sent = [await w.one.send("inbox@two", fake), await w.one.send("inbox@two", "real")];
    const theirs = await w.three.send("inbox@two", "three's own");
    await heldIds(w.inbox, 3);
    await w.inbox.stop();
    const box = new HeldBox(w.inbox.files.heldDir, FS);
    const t = term(w.devices[1]!.root, w.relay);
    t.answers.push("all");
    expect(await run(t, "held", "approve", sent[0]!.id)).toBe(0);
    const lines = t.out;
    // One heading, one count, the item text on its own indented line.
    expect(lines.filter((l) => l.startsWith("Held from "))).toEqual([expect.stringContaining(`Held from device one (device id ${w.devices[0]!.device.id}): 2 messages`)]);
    expect(lines.filter((l) => /^Type /.test(l))).toEqual([`Type all to approve all 2, or one to approve only ${sent[0]!.id} [all/one/N] `]);
    expect(lines.find((l) => l.includes("9 messages"))).toMatch(/^ {11}text {2}Held from device three/);
    expect((await box.list()).map((h) => h.id)).toEqual([theirs.id]);
  });
});

describe("wim held, a set per CI rule", () => {
  async function ciWorld() {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const s = await MeshSession.open(sessionOpts(devices[0]!, mesh, relay, { name: "agent" }));
    await s.stop();
    const files = new MeshFiles(devices[0]!.home.meshDir(mesh), FS);
    const box = new HeldBox(s.files.heldDir, FS);
    const notice = (r: CiRule, at: number, over: Partial<HeldItem> = {}): HeldItem => {
      const id = ulid();
      return {
        id,
        from: "ci:github:octo-org/deploys",
        device: "",
        kind: "msg",
        at,
        preview: `notice ${at}`,
        rendered: `framed ${at}`,
        reason: "policy",
        entry: { dir: "in", peer: "ci:github:octo-org/deploys", id, kind: "msg", at, text: `notice ${at}`, relayed: true, ci: { via: "github", repo: "octo-org/deploys", ref: "refs/heads/main", workflow: "deploy.yml", event: "push" } },
        ci: { rule: r.id },
        ...over,
      };
    };
    return { relay, devices, files, box, notice };
  }

  it("groups by the rule's identity, marks a notice that pins ids, and approve-all leaves it held", async () => {
    const w = await ciWorld();
    const [r1, r2] = [rule({ hold: true } as Partial<CiRule>), rule({ repo: "octo-org/other", hold: true } as Partial<CiRule>)];
    await saveCiRules(w.files.ciRulesPath, [r1!, r2!], FS);
    const a = w.notice(r1!, 1000);
    const pinning = w.notice(r1!, 2000, { ci: { rule: r1!.id, pins: { repositoryId: "74", ownerId: "65" } } });
    const b = w.notice(r1!, 3000);
    const elsewhere = w.notice(r2!, 1500);
    for (const n of [a, pinning, b, elsewhere]) await w.box.add(n);
    const t = term(w.devices[0]!.root, w.relay);
    // Removing a rule earlier in the list renumbers `wim ci list`, never the sets.
    await saveCiRules(w.files.ciRulesPath, [r2!, r1!], FS);
    t.answers.push("all");
    expect(await run(t, "held", "approve", a.id)).toBe(0);
    const out = said(t);
    expect(out).toMatch(/Held from CI rule github {2}octo-org\/deploys {2}refs\/heads\/main .*: 3 CI notices, from 1970-01-01T00:00:01\.000Z to 1970-01-01T00:00:03\.000Z/);
    expect(out).toContain("           ci    github, octo-org/deploys, refs/heads/main, workflow deploy.yml, event push");
    expect(out).toContain("held because its CI rule holds it");
    expect(out).toContain("           approve on its own: it pins repositoryId=74 ownerId=65");
    expect(out).toContain(`Type all to approve the 2 that do not pin ids, or one to approve only ${a.id} [all/one/N] `);
    expect(out).toContain(`Still held: ${pinning.id} pins its rule's ids, so it is approved only on its own: wim held approve ${pinning.id}`);
    expect((await w.box.list()).map((h) => h.id)).toEqual([elsewhere.id, pinning.id]);
  });

  it("refuses a set with its pin-carrying notices, offers only `one` when every notice pins, and sets a removed rule's notice apart", async () => {
    const w = await ciWorld();
    const r = rule({ pins: undefined });
    await saveCiRules(w.files.ciRulesPath, [r], FS);
    const pins = { repositoryId: "74", ownerId: "65" };
    const p1 = w.notice(r, 1000, { ci: { rule: r.id, pins } });
    const p2 = w.notice(r, 2000, { ci: { rule: r.id, pins }, fileInfo: { name: "report.txt", size: 3, mime: "text/plain" } as HeldItem["fileInfo"] });
    for (const n of [p1, p2]) await w.box.add(n);
    const t = term(w.devices[0]!.root, w.relay);
    t.answers.push("all");
    expect(await run(t, "held", "approve", p1.id)).toBe(1);
    expect(said(t)).toContain(`Type one to approve only ${p1.id} [one/N] `);
    expect(said(t)).toContain("           file  report.txt (3 bytes, fetched once approved)");
    expect(t.err).toContain("wim: nothing changed.");
    t.answers.push("all");
    expect(await run(t, "held", "refuse", p2.id)).toBe(0);
    expect(await w.box.list()).toEqual([]);

    // A notice whose rule is gone is a set of one, decided on its own.
    const gone = w.notice(rule(), 5000);
    const kept = w.notice(r, 6000);
    for (const n of [gone, kept]) await w.box.add(n);
    t.out.length = 0;
    expect(await run(t, "held", "list")).toBe(0);
    expect(said(t)).toContain("held from a CI rule removed while this notice was held: 1 CI notice, at 1970-01-01T00:00:05.000Z");
    t.answers.push("y");
    expect(await run(t, "held", "refuse", gone.id)).toBe(0);
    expect(said(t)).toContain("Refuse it? It is dropped, never delivered. [y/N] ");
    expect((await w.box.list()).map((h) => h.id)).toEqual([kept.id]);
  });

  it("groups nothing together when the rules file is damaged", async () => {
    const w = await ciWorld();
    const r = rule();
    const [a, b] = [w.notice(r, 1000), w.notice(r, 2000)];
    for (const n of [a, b]) await w.box.add(n);
    await import("node:fs").then((m) => m.promises.writeFile(w.files.ciRulesPath, "damaged"));
    const t = term(w.devices[0]!.root, w.relay);
    expect(await run(t, "held", "list")).toBe(0);
    expect(said(t).match(/held from a CI rule removed/g)).toHaveLength(2);
  });
});
