import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { ulid, ulidTime } from "@worldinmotion/protocol";
import { describe, expect, it } from "vitest";
import { Breaker, clock, pauseNotice, pauseNoticeForAgent, pauseRule, releasedNotice, type Pause } from "../src/breaker.ts";
import { cardFor, cardLabel, readBranch, sameCard } from "../src/cards.ts";
import { mimeFor, safeFileName, saveReceived, secretsInFile, unsendable, wireFileName } from "../src/files.ts";
import { frameEntry, History, renderForAgent, renderForPerson, type HistoryEntry } from "../src/history.ts";
import { DEFAULT_BREAKER, type MeshConfig } from "../src/mesh.ts";
import { CommandNotifier, loadNotifier, quiet } from "../src/notify.ts";
import { noticeText, peerLine, policyFor, policyLevel } from "../src/render.ts";
import { POSIX, scratch } from "./helpers.ts";

const DEV = "A".repeat(22);
/** The breaker every mesh.json written before 0.1.8 holds, read back. */
const BEFORE_018 = { perPeerPerHour: 20, totalPerHour: 60, pingPong: true, pingPongExchanges: 8 };
/** The trusted tier's defaults. */
const TRUSTED = DEFAULT_BREAKER.trusted;

describe("Breaker", () => {
  it("pauses a peer past its hourly limit and resumes after the hour or on request", () => {
    let now = 0;
    const limits = { perPeerPerHour: 3, totalPerHour: 100, pingPong: false, pingPongExchanges: 8 };
    const b = new Breaker(() => limits, () => now);
    for (let i = 0; i < 3; i++) expect(b.admit("dev1", 500)).toEqual({ ok: true });
    const tripped = b.admit("dev1", 500);
    expect(tripped).toEqual({
      ok: false,
      reason: "peer",
      newly: true,
      pause: { peer: "dev1", rule: "peer", count: 4, limit: 3, minutes: 60, trusted: false, at: 0, until: 3_600_000, auto: false },
    });
    expect(b.admit("dev1", 500)).toMatchObject({ ok: false, reason: "paused", newly: false, pause: { rule: "peer" } });
    expect(b.pauses()).toHaveLength(1);
    // An untrusted peer's pause is never released by the client: it only lapses.
    now = 3_600_000;
    expect(b.takeDue()).toEqual([]);
    expect(b.pauses()).toEqual([]);
    now += 1;
    expect(b.admit("dev1", 500)).toEqual({ ok: true });
    for (let i = 0; i < 2; i++) b.admit("dev1", 500);
    expect(b.admit("dev1", 500).ok).toBe(false);
    b.resume("dev1");
    expect(b.admit("dev1", 500)).toEqual({ ok: true });
  });

  it("pauses everyone past the total, counting each tier on its own", () => {
    const b = new Breaker(() => ({ perPeerPerHour: 100, totalPerHour: 2, pingPong: false, pingPongExchanges: 8, trusted: { ...TRUSTED, totalPerHour: 3 } }), () => 0);
    b.admit("a", 1);
    b.admit("b", 1);
    expect(b.admit("c", 1)).toMatchObject({ ok: false, reason: "total", pause: { count: 3, limit: 2, trusted: false } });
    // Trusted deliveries are counted apart: the untrusted total does not stop them.
    for (let i = 0; i < 3; i++) expect(b.admit(`t${i}`, 1, true)).toEqual({ ok: true });
    expect(b.admit("t9", 1, true)).toMatchObject({ ok: false, reason: "total", pause: { count: 4, limit: 3, trusted: true, auto: true } });
  });

  it("pauses a fast ping-pong of short messages, not long or one-way ones", () => {
    let now = 0;
    const b = new Breaker(() => BEFORE_018, () => now);
    for (let i = 0; i < 5; i++) {
      now += 1000;
      expect(b.admit("p", 10).ok).toBe(true);
      b.noteSent("p", 10);
    }
    now += 1000;
    expect(b.admit("p", 10)).toMatchObject({ ok: false, reason: "pingpong", newly: true, pause: { count: 10, limit: 8, minutes: 10 } });
    const c = new Breaker(() => BEFORE_018, () => now);
    for (let i = 0; i < 6; i++) {
      now += 1000;
      expect(c.admit("q", 500).ok).toBe(true);
      c.noteSent("q", 10);
    }
    for (let i = 0; i < 6; i++) expect(c.admit("r", 10).ok).toBe(true);
  });

  it("counts ping-pong exchanges against the tier's threshold", () => {
    let now = 0;
    // The trusted default, 32: 17 incoming short messages answered in turn make 32 alternating
    // exchanges and pass; the 18th makes 34 and trips it. The untrusted 8 would have tripped at 10.
    const b = new Breaker(() => DEFAULT_BREAKER, () => now);
    for (let i = 0; i < 16; i++) {
      now += 1000;
      expect(b.admit("p", 10, true).ok).toBe(true);
      b.noteSent("p", 10);
    }
    now += 1000;
    expect(b.admit("p", 10, true).ok).toBe(true);
    b.noteSent("p", 10);
    now += 1000;
    expect(b.admit("p", 10, true)).toMatchObject({ ok: false, reason: "pingpong", newly: true, pause: { count: 34, limit: 32, trusted: true } });
    // A tier that turns ping-pong off never trips on it, whatever the threshold.
    const off = new Breaker(() => ({ ...DEFAULT_BREAKER, trusted: { ...TRUSTED, pingPong: false, pingPongExchanges: 1 } }), () => now);
    for (let i = 0; i < 40; i++) {
      now += 1000;
      expect(off.admit("q", 10, true).ok).toBe(true);
      off.noteSent("q", 10);
    }
  });

  it("gives a trusted peer its own ceiling and a cool-down the client ends, once an hour", () => {
    let now = 0;
    const limits = { perPeerPerHour: 1, totalPerHour: 100, pingPong: false, pingPongExchanges: 8, trusted: { ...TRUSTED, perPeerPerHour: 3, cooldownMinutes: 5 } };
    const b = new Breaker(() => limits, () => now);
    // Untrusted, the same device would trip on its second message; trusted, on its fourth.
    for (let i = 0; i < 3; i++) expect(b.admit("own", 10, true)).toEqual({ ok: true });
    const first = b.admit("own", 10, true);
    expect(first).toMatchObject({ ok: false, reason: "peer", pause: { count: 4, limit: 3, trusted: true, until: 5 * 60_000, auto: true } });
    now = 5 * 60_000 - 1;
    expect(b.takeDue()).toEqual([]);
    now = 5 * 60_000;
    // Due once: taking it lifts the pause and starts the counts over, so a second caller gets nothing.
    expect(b.takeDue()).toEqual([(first as { pause: unknown }).pause]);
    expect(b.takeDue()).toEqual([]);
    expect(b.pauses()).toEqual([]);
    for (let i = 0; i < 3; i++) expect(b.admit("own", 10, true)).toEqual({ ok: true });
    // A second trip within the hour of that release waits the hour for the person.
    expect(b.admit("own", 10, true)).toMatchObject({ ok: false, pause: { auto: false, until: 5 * 60_000 + 3_600_000 } });
    now += 3_600_000;
    expect(b.takeDue()).toEqual([]);
    // The person's resume starts the allowance over: the next trip is a cool-down again.
    b.resume("own");
    for (let i = 0; i < 3; i++) b.admit("own", 10, true);
    expect(b.admit("own", 10, true)).toMatchObject({ ok: false, pause: { auto: true } });
    // An hour after an automatic release, a trip is a cool-down again too.
    now += 5 * 60_000;
    expect(b.takeDue()).toHaveLength(1);
    now += 3_600_000;
    for (let i = 0; i < 3; i++) b.admit("own", 10, true);
    expect(b.admit("own", 10, true)).toMatchObject({ ok: false, pause: { auto: true } });
  });

  it("lists running pauses oldest first", () => {
    let now = 0;
    const b = new Breaker(() => ({ perPeerPerHour: 1, totalPerHour: 10, pingPong: false, pingPongExchanges: 8 }), () => now);
    for (const peer of ["x", "y"]) {
      b.admit(peer, 1);
      now += 1;
      b.admit(peer, 1);
    }
    expect(b.pauses().map((p) => [p.peer, p.at])).toEqual([["x", 1], ["y", 2]]);
  });

  it("applies one tier when it has no trusted limits, as the CI bucket does", () => {
    const b = new Breaker(() => ({ perPeerPerHour: 1, totalPerHour: 10, pingPong: false, pingPongExchanges: 8 }), () => 0);
    expect(b.admit("x", 1, true)).toEqual({ ok: true });
    expect(b.admit("x", 1, true)).toMatchObject({ ok: false, pause: { trusted: false, auto: false } });
  });

  it("words its notices with the rule that tripped, its numbers and how the pause ends", () => {
    const peer: Pause = { peer: "d", rule: "peer", count: 21, limit: 20, minutes: 60, trusted: false, at: 0, until: 3_600_000, auto: false };
    expect(pauseNotice("a@x", peer)).toBe(
      "worldinmotion paused a@x: the per-peer limit: 21 messages from a@x in 60 minutes, limit 20; until 1970-01-01T01:00:00Z; what it held waits for the person. /wim to approve, or to approve and resume it now",
    );
    const total: Pause = { ...peer, rule: "total", count: 301, limit: 300, trusted: true, until: 600_000, auto: true };
    expect(pauseNotice("a@x", total)).toBe(
      "worldinmotion paused a@x: the total limit: 301 messages from all trusted peers in 60 minutes, limit 300; until 1970-01-01T00:10:00Z, when the client releases it and delivers what it held (a trusted device's cool-down). /wim to approve, or to approve and resume it now",
    );
    expect(pauseRule("a@x", { ...total, trusted: false })).toBe("the total limit: 301 messages from all untrusted peers in 60 minutes, limit 300");
    expect(pauseRule("this device", { rule: "total", count: 3, limit: 2, minutes: 60 })).toBe("the total limit: 3 messages from all peers in 60 minutes, limit 2");
    const ping: Pause = { ...peer, rule: "pingpong", count: 10, limit: 8, minutes: 10 };
    expect(pauseNotice("a@x", ping)).toMatch(/the ping-pong rule: 10 alternating short messages with a@x in 10 minutes, limit 8/);
    expect(pauseNoticeForAgent("a@x", ping)).toMatch(/^this device's loop breaker paused a@x \(the ping-pong rule: 10 alternating .*until your person releases them\. .*The pause lifts at 1970-01-01T01:00:00Z; what was held stays held until the person decides\./);
    expect(pauseNoticeForAgent("a@x", total)).toMatch(/until the cool-down ends or your person releases them\. .*The client releases a@x by itself at 1970-01-01T00:10:00Z/);
    expect(releasedNotice("a@x", total, 2, 0)).toMatch(/^the loop breaker's cool-down for a@x ended at 1970-01-01T00:10:00Z \(it tripped on the total limit: .*\): its messages are delivered again, and the 2 messages it held are delivered now\. If it trips again within the hour, it waits for your person\.$/);
    expect(releasedNotice("a@x", total, 1, 0)).toMatch(/the 1 message it held is delivered now/);
    expect(releasedNotice("a@x", total, 0, 1)).toMatch(/its device is no longer trusted here, so the 1 message it held stays held for the person/);
    expect(releasedNotice("a@x", total, 0, 2)).toMatch(/so the 2 messages it held stay held for the person/);
    expect(clock(1_000)).toBe("1970-01-01T00:00:01Z");
  });
});

describe("cards", () => {
  it("reads the branch from .git/HEAD, a worktree pointer, or a detached head", async () => {
    const root = await scratch("git");
    expect(await readBranch(root)).toBeUndefined();
    await fs.mkdir(join(root, "repo", ".git"), { recursive: true });
    await fs.writeFile(join(root, "repo", ".git", "HEAD"), "ref: refs/heads/feature/x\n");
    await fs.mkdir(join(root, "repo", "sub"), { recursive: true });
    expect(await readBranch(join(root, "repo", "sub"))).toBe("feature/x");
    await fs.writeFile(join(root, "repo", ".git", "HEAD"), "0123456789abcdef0123\n");
    expect(await readBranch(join(root, "repo"))).toBe("detached 0123456789ab");
    await fs.writeFile(join(root, "repo", ".git", "HEAD"), "garbage\n");
    expect(await readBranch(join(root, "repo"))).toBeUndefined();
    await fs.mkdir(join(root, "wt"), { recursive: true });
    await fs.mkdir(join(root, "gitdirs", "wt"), { recursive: true });
    await fs.writeFile(join(root, "gitdirs", "wt", "HEAD"), "ref: refs/heads/wt-branch\n");
    await fs.writeFile(join(root, "wt", ".git"), "gitdir: ../gitdirs/wt\n");
    expect(await readBranch(join(root, "wt"))).toBe("wt-branch");
    await fs.writeFile(join(root, "wt", ".git"), `gitdir: ${join(root, "gitdirs", "wt")}\n`);
    expect(await readBranch(join(root, "wt"))).toBe("wt-branch");
    await fs.mkdir(join(root, "odd"), { recursive: true });
    await fs.writeFile(join(root, "odd", ".git"), "nothing useful");
    await fs.mkdir(join(root, "odd2", ".git"), { recursive: true });
    expect(await readBranch(join(root, "odd2"))).toBeUndefined();
    // A HEAD that cannot be read (a directory, which fails to read on every OS) is no branch.
    await fs.mkdir(join(root, "dirhead", ".git", "HEAD"), { recursive: true });
    expect(await readBranch(join(root, "dirhead"))).toBeUndefined();
    await fs.mkdir(join(root, "gitdirs", "dirhead", "HEAD"), { recursive: true });
    await fs.mkdir(join(root, "wt2"), { recursive: true });
    await fs.writeFile(join(root, "wt2", ".git"), "gitdir: ../gitdirs/dirhead\n");
    expect(await readBranch(join(root, "wt2"))).toBeUndefined();
  });

  it("makes cards with the base name or the full path, and labels them safely", async () => {
    const root = await scratch("card");
    const card = await cardFor(root, false, "/elsewhere");
    expect(card.cwd).toBe(basename(root));
    expect((await cardFor(root, true, "/elsewhere")).cwd).toBe(root);
    // A session in the home directory shows no directory: its name is usually the OS user name.
    expect(await cardFor(root, false, root)).toEqual({});
    expect(sameCard(undefined, card)).toBe(false);
    expect(sameCard(card, { ...card })).toBe(true);
    expect(cardLabel(undefined)).toBe("");
    expect(cardLabel({ cwd: "my dir", branch: "b‮x", title: "T" })).toBe('cwd=my_dir branch=b<U+202E>x title="T"');
  });
});

describe("files", () => {
  it("names saved files safely and never replaces one", async () => {
    expect(safeFileName("ID", "../../etc/passwd")).toBe("ID-etc_passwd");
    expect(safeFileName("ID", "...")).toBe("ID-file");
    const dir = await scratch("files");
    const path = await saveReceived(join(dir, "f"), "ID", "a.sh", new Uint8Array([1]));
    // Windows has no POSIX mode bits to check.
    if (POSIX) expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    await expect(saveReceived(join(dir, "f"), "ID", "a.sh", new Uint8Array([1]))).rejects.toThrow();
  });

  it("labels MIME types and wire names", () => {
    expect(mimeFor("a.TXT")).toBe("text/plain");
    expect(mimeFor("a.bin")).toBe("application/octet-stream");
    expect(wireFileName("a\u0001b")).toBe("a_b");
    expect(wireFileName("")).toBe("file");
    expect(wireFileName("..")).toBe("file");
  });

  it("refuses credential paths and finds secrets in text files", () => {
    const h = "/home/u";
    expect(unsendable("/home/u/.config/worldinmotion/device.json", "/home/u/.config/worldinmotion", h)).toMatch(/state directory/);
    expect(unsendable("/home/u/.ssh/config", "/w", h)).toMatch(/\.ssh/);
    expect(unsendable("/home/u/.config/gcloud/creds.db", "/w", h)).toMatch(/gcloud/);
    expect(unsendable("/p/.env", "/w", h)).toMatch(/environment/);
    expect(unsendable("/p/.env.local", "/w", h)).toMatch(/environment/);
    expect(unsendable("/p/server.pem", "/w", h)).toMatch(/key or certificate/);
    expect(unsendable("/p/id_ed25519", "/w", h)).toMatch(/SSH key/);
    expect(unsendable("/p/id_rsa.pub", "/w", h)).toMatch(/SSH key/);
    expect(unsendable("/p/notes.md", "/w", h)).toBeUndefined();
    expect(secretsInFile(new TextEncoder().encode("token ghp_" + "a".repeat(36)))).toEqual(["github_token"]);
    expect(secretsInFile(new Uint8Array([0, 1, 2]))).toEqual([]);
  });
});

describe("History", () => {
  const entry = (i: number, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({ dir: "in", peer: "a@x", device: DEV, id: ulid(i), kind: "msg", at: i, text: `m${i}`, ...extra });

  it("appends, queries newest last, filters, and rotates", async () => {
    const dir = await scratch("hist");
    let now = 1_000;
    const h = new History(join(dir, "history.jsonl"), () => now, 200);
    expect(await h.query()).toEqual([]);
    for (let i = 1; i <= 6; i++) await h.append(entry(i, i % 2 === 0 ? { peer: "b@x" } : {}));
    await h.append({ ...entry(7), dir: "out", peer: "a@x,b@x" });
    await fs.appendFile(join(dir, "history.jsonl"), "not json\n");
    const all = await h.query({ limit: 500 });
    expect(all.map((e) => e.at)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect((await h.query({ limit: 2 })).map((e) => e.at)).toEqual([6, 7]);
    expect((await h.query({ peer: "b@x" })).map((e) => e.at)).toEqual([2, 4, 6, 7]);
    expect((await h.query({ before: 3 })).map((e) => e.at)).toEqual([1, 2]);
    expect((await h.query({ limit: 0 })).length).toBe(1);
    expect((await fs.readdir(dir)).filter((n) => n.startsWith("history-")).length).toBeGreaterThan(0);
    // Rotated files older than 30 days go.
    now += 31 * 24 * 3600 * 1000;
    for (let i = 8; i <= 12; i++) await h.append(entry(i));
    await fs.writeFile(join(dir, "history-junk.jsonl"), "");
    await h.append(entry(13));
    for (let i = 14; i <= 20; i++) await h.append(entry(i));
    const left = (await fs.readdir(dir)).filter((n) => n.startsWith("history-"));
    expect(left.every((n) => ulidTime(n.slice(8, -6)) >= now - 1000)).toBe(true);
  });

  it("renders for the agent and for a person", () => {
    const e = entry(5, { text: "hi‮" });
    expect(renderForAgent(e)).toMatch(/^\(history: received earlier/);
    expect(renderForAgent({ ...e, kind: "result", reply_to: ulid(1), status: "done" })).toContain("result");
    expect(renderForAgent({ ...e, kind: "task", deadline: 99 })).toContain("Deadline");
    expect(renderForAgent({ ...e, kind: "file", file: { name: "a.txt", size: 1, mime: "text/plain" } })).toContain("(not saved)");
    expect(renderForAgent({ ...e, kind: "file", file: { name: "a.txt", size: 1, mime: "text/plain" }, savedTo: "/x" })).toContain("/x");
    expect(renderForAgent({ ...e, device: undefined })).toMatch(/unreadable entry/);
    expect(renderForAgent({ ...e, dir: "out" })).toMatch(/you sent a msg to a@x/);
    expect(renderForAgent({ ...e, dir: "out", kind: "result" })).toMatch(/result \(done\) for \?/);
    expect(renderForAgent({ ...e, dir: "out", kind: "result", status: "failed", reply_to: "T" })).toMatch(/result \(failed\) for T/);
    expect(frameEntry({ ...e, kind: "result", reply_to: ulid(1), status: "done", unsolicited: true })).toMatch(/unsolicited result/);
    expect(frameEntry({ ...e, relayed: true })).toMatch(/third party/);
    expect(renderForPerson(e)).toMatch(/<- a@x msg: hi<U\+202E>$/);
    expect(renderForPerson({ ...e, dir: "out", file: { name: "f", size: 2, mime: "x" } })).toMatch(/-> a@x msg \[file f 2 bytes\]/);
  });
});

describe("render", () => {
  const config = { device: "me", policy: { trusted: "deliver", relays: "deliver-relayed", blocked: "refuse", me: "deliver-relayed" } } as unknown as MeshConfig;

  it("applies policy levels with the relayed flag", () => {
    expect(policyLevel({ ...config, policy: {} }, "me")).toBe("deliver");
    expect(policyLevel(config, "me")).toBe("deliver-relayed");
    expect(policyLevel(config, "stranger")).toBe("hold");
    expect(policyFor(config, "trusted", false)).toBe("deliver");
    expect(policyFor(config, "trusted", true)).toBe("hold");
    expect(policyFor(config, "relays", true)).toBe("deliver");
    expect(policyFor(config, "blocked", false)).toBe("refuse");
    expect(policyFor(config, "stranger", false)).toBe("hold");
  });

  it("writes notices and peer lines", () => {
    expect(noticeText("x\u0007")).toMatch(/^worldinmotion notice \(from the local client.*x<U\+0007>$/);
    expect(peerLine({ address: "a@x", kind: "mcp", status: "idle", since: 0, rooms: [] })).toBe("a@x  mcp  idle  -");
    expect(peerLine({ address: "a@x", kind: "mcp", status: "busy", since: 0, rooms: ["#a", "#b"], card: { cwd: "w" } })).toBe("a@x  mcp  busy  #a,#b  cwd=w");
  });
});

describe("notify", () => {
  it("runs the command without a shell, with a short printable line, rate limited", async () => {
    const calls: Array<{ file: string; args: string[]; shell: unknown }> = [];
    let now = 0;
    const run = ((file: string, args: string[], opts: { shell: unknown }, cb: (e: Error | null) => void) => {
      calls.push({ file, args, shell: opts.shell });
      cb(args.at(-1)!.includes("fail") ? new Error("boom") : null);
    }) as never;
    const n = new CommandNotifier(["/bin/notify", "--to", "me"], 1000, () => now, run);
    await n.notify("1 message\u0007 held é");
    await n.notify("again");
    expect(calls).toEqual([{ file: "/bin/notify", args: ["--to", "me", "1 message  held  "], shell: false }]);
    now = 2000;
    await expect(n.notify("fail")).rejects.toThrow("boom");
    await n.notify("forced", true);
    expect(calls.length).toBe(3);
    const logs: string[] = [];
    await quiet({ notify: () => Promise.reject(new Error("down")) }, (l) => logs.push(l)).notify("x");
    expect(logs).toEqual(["wim: notification failed: down"]);
    expect(() => new CommandNotifier([])).toThrow(/non-empty/);
    expect(() => new CommandNotifier([""])).toThrow(/non-empty/);
  });

  it("loads notify.json", async () => {
    const dir = await scratch("notify");
    expect(await loadNotifier(dir)).toBeUndefined();
    await fs.writeFile(join(dir, "notify.json"), JSON.stringify({ provider: "email" }));
    await expect(loadNotifier(dir)).rejects.toThrow(/provider must be/);
    await fs.writeFile(join(dir, "notify.json"), JSON.stringify({ provider: "command", command: ["/bin/true"] }));
    expect(await loadNotifier(dir)).toBeInstanceOf(CommandNotifier);
    await fs.writeFile(join(dir, "notify.json"), JSON.stringify({ provider: "command", command: ["/bin/true"], minIntervalMs: 5 }));
    expect(await loadNotifier(dir)).toBeInstanceOf(CommandNotifier);
  });

  it("really runs a program", async () => {
    await new CommandNotifier(["true"]).notify("x");
  });
});
