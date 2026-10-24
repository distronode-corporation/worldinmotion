import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { ulid, ulidTime } from "@worldinmotion/protocol";
import { describe, expect, it } from "vitest";
import { Breaker, pauseNotice } from "../src/breaker.ts";
import { cardFor, cardLabel, readBranch, sameCard } from "../src/cards.ts";
import { mimeFor, safeFileName, saveReceived, secretsInFile, unsendable, wireFileName } from "../src/files.ts";
import { frameEntry, History, renderForAgent, renderForPerson, type HistoryEntry } from "../src/history.ts";
import { DEFAULT_BREAKER, type MeshConfig } from "../src/mesh.ts";
import { CommandNotifier, loadNotifier, quiet } from "../src/notify.ts";
import { noticeText, peerLine, policyFor, policyLevel } from "../src/render.ts";
import { POSIX, scratch } from "./helpers.ts";

const DEV = "A".repeat(22);

describe("Breaker", () => {
  it("pauses a peer past its hourly limit and resumes after the hour or on request", () => {
    let now = 0;
    const limits = { perPeerPerHour: 3, totalPerHour: 100, pingPong: false };
    const b = new Breaker(() => limits, () => now);
    for (let i = 0; i < 3; i++) expect(b.admit("dev1", 500)).toEqual({ ok: true });
    expect(b.admit("dev1", 500)).toEqual({ ok: false, reason: "peer", newly: true });
    expect(b.admit("dev1", 500)).toEqual({ ok: false, reason: "paused", newly: false });
    now += 3_600_001;
    expect(b.admit("dev1", 500)).toEqual({ ok: true });
    for (let i = 0; i < 2; i++) b.admit("dev1", 500);
    expect(b.admit("dev1", 500).ok).toBe(false);
    b.resume("dev1");
    expect(b.admit("dev1", 500)).toEqual({ ok: true });
  });

  it("pauses everyone past the total", () => {
    const b = new Breaker(() => ({ perPeerPerHour: 100, totalPerHour: 2, pingPong: false }), () => 0);
    b.admit("a", 1);
    b.admit("b", 1);
    expect(b.admit("c", 1)).toEqual({ ok: false, reason: "total", newly: true });
  });

  it("pauses a fast ping-pong of short messages, not long or one-way ones", () => {
    let now = 0;
    const b = new Breaker(() => DEFAULT_BREAKER, () => now);
    for (let i = 0; i < 5; i++) {
      now += 1000;
      expect(b.admit("p", 10).ok).toBe(true);
      b.noteSent("p", 10);
    }
    now += 1000;
    expect(b.admit("p", 10)).toEqual({ ok: false, reason: "pingpong", newly: true });
    const c = new Breaker(() => DEFAULT_BREAKER, () => now);
    for (let i = 0; i < 6; i++) {
      now += 1000;
      expect(c.admit("q", 500).ok).toBe(true);
      c.noteSent("q", 10);
    }
    for (let i = 0; i < 6; i++) expect(c.admit("r", 10).ok).toBe(true);
  });

  it("words its notices", () => {
    expect(pauseNotice("a@x", "peer", DEFAULT_BREAKER)).toBe("worldinmotion paused a@x: 20 messages in an hour; /wim to resume");
    expect(pauseNotice("a@x", "total", DEFAULT_BREAKER)).toMatch(/60 messages in an hour from all peers/);
    expect(pauseNotice("a@x", "pingpong", DEFAULT_BREAKER)).toMatch(/fast exchange/);
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
