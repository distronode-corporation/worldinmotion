// `wim events` follows every local session's history file: rotation, damaged lines, links and
// large files, and the bounded `history` request.

import { ulid } from "@worldinmotion/protocol";
import { appendFileSync, constants, renameSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { MeshSession } from "../src/client.ts";
import { FOLLOW_READ_MAX, runEvents } from "../src/events.ts";
import { noFollow, openNoFollow } from "../src/fsx.ts";
import { parseEntry } from "../src/history.ts";
import { MeshFiles } from "../src/mesh.ts";
import { SessionFiles } from "../src/session.ts";
import { FS, makeMesh, RelayHarness, scratch, sessionOpts, sleep, until, type TestDevice } from "./helpers.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f().catch(() => undefined);
});

type Line = Record<string, unknown> & { type: string };

async function start(d: TestDevice, mesh: string, relay: RelayHarness) {
  const lines: Line[] = [];
  const input = new PassThrough();
  const stop = new AbortController();
  const files = new MeshFiles(d.home.meshDir(mesh), FS);
  const session = await MeshSession.open({ ...sessionOpts(d, mesh, relay, { name: "vscode", kind: "vscode" }), sessionKey: "events:vscode" });
  const running = runEvents({ session, mesh: files, env: FS, device: d.device, version: "test", write: (l) => void lines.push(JSON.parse(l) as Line), input, signal: stop.signal, now: Date.now, pollMs: 20, leasePollMs: 1000 });
  cleanup.push(async () => {
    stop.abort();
    await running;
    await session.stop();
  });
  let n = 0;
  const request = async (op: string, args?: Record<string, unknown>): Promise<Line> => {
    const id = `r${++n}`;
    input.write(`${JSON.stringify({ v: 1, id, op, ...(args === undefined ? {} : { args }) })}\n`);
    await until(() => lines.some((l) => l.type === "response" && l["id"] === id), 5000, `response ${id}`);
    return lines.find((l) => l.type === "response" && l["id"] === id)!;
  };
  const texts = (): string[] => lines.filter((l) => l.type === "message").map((l) => l["text"] as string);
  await until(() => lines.some((l) => l.type === "snapshot"), 5000, "first snapshot");
  return { lines, texts, request };
}

/** A local session's files, with a history file that already has one line. */
async function otherSession(d: TestDevice, mesh: string, relay: RelayHarness): Promise<SessionFiles> {
  const s = await MeshSession.open(sessionOpts(d, mesh, relay, { name: "other" }));
  await s.stop();
  writeFileSync(s.files.historyPath, entry("before start", 1));
  return s.files;
}

const entry = (text: string, at = Date.now()): string => `${JSON.stringify({ dir: "in", peer: "p@two", device: "d", id: ulid(), kind: "msg", at, text })}\n`;

describe("the history follower", () => {
  it("reads the lines written to a history file just before it rotated, and its successor from the start", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const files = await otherSession(devices[0]!, mesh, relay);
    const e = await start(devices[0]!, mesh, relay);
    appendFileSync(files.historyPath, entry("seen"));
    await until(() => e.texts().includes("seen"));
    // One more line, then a rotation and a successor longer than the old file, all between two polls.
    appendFileSync(files.historyPath, entry("last before rotation"));
    renameSync(files.historyPath, join(files.dir, `history-${ulid()}.jsonl`));
    writeFileSync(files.historyPath, entry("after rotation ".repeat(30)) + entry("second after"));
    await until(() => e.texts().includes("second after"), 3000, "successor");
    expect(e.texts()).toEqual(["seen", "last before rotation", "after rotation ".repeat(30), "second after"]);
  });

  it("skips a damaged line and keeps the rest of the pass", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const files = await otherSession(devices[0]!, mesh, relay);
    const e = await start(devices[0]!, mesh, relay);
    appendFileSync(files.historyPath, `${JSON.stringify({ dir: "out", id: "x" })}\nnull\n{"dir":"in"\n${entry("good")}`);
    await until(() => e.texts().includes("good"), 3000, "the good line");
    expect(e.texts()).toEqual(["good"]);
  });

  it("does not follow a history file that is a symbolic link", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const files = await otherSession(devices[0]!, mesh, relay);
    const outside = join(await scratch("outside"), "big.jsonl");
    writeFileSync(outside, entry("planted"));
    const e = await start(devices[0]!, mesh, relay);
    await fs.rm(files.historyPath);
    await fs.symlink(outside, files.historyPath);
    appendFileSync(outside, entry("planted again"));
    await sleep(200);
    expect(e.texts()).toEqual([]);
  });

  it("reads a large burst in bounded passes without losing a line", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const files = await otherSession(devices[0]!, mesh, relay);
    const e = await start(devices[0]!, mesh, relay);
    const big = "y".repeat(100_000);
    let burst = "";
    for (let i = 0; i < 30; i++) burst += entry(`${i} ${big}`);
    appendFileSync(files.historyPath, burst);
    await until(() => e.texts().length === 30, 5000, "the burst");
    expect(e.texts().map((t) => Number(t.split(" ")[0]))).toEqual([...Array(30).keys()]);
  });
});

describe("the history follower, edges", () => {
  it("skips a line longer than one read pass, and keeps the next one", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const files = await otherSession(devices[0]!, mesh, relay);
    const e = await start(devices[0]!, mesh, relay);
    appendFileSync(files.historyPath, `${"z".repeat(FOLLOW_READ_MAX + 1000)}\n${entry("after the long line")}`);
    await until(() => e.texts().includes("after the long line"), 5000, "the next line");
    expect(e.texts()).toEqual(["after the long line"]);
  });

  it("finds the rotated file by inode among others, ignores links, and reads a successor of a drained file", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const files = await otherSession(devices[0]!, mesh, relay);
    // An older rotated file and a planted link with rotated names.
    writeFileSync(join(files.dir, `history-${ulid(1000)}.jsonl`), entry("very old"));
    await fs.symlink(files.historyPath, join(files.dir, `history-${ulid(2000)}.jsonl`));
    const e = await start(devices[0]!, mesh, relay);
    // A rotation with nothing new in the old file.
    renameSync(files.historyPath, join(files.dir, `history-${ulid()}.jsonl`));
    writeFileSync(files.historyPath, entry("first of the successor"));
    await until(() => e.texts().includes("first of the successor"), 3000, "successor");
    expect(e.texts()).toEqual(["first of the successor"]);
  });

  it("keeps following other sessions when one history path cannot be read", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const broken = await otherSession(devices[0]!, mesh, relay);
    const files = await otherSession(devices[0]!, mesh, relay);
    const e = await start(devices[0]!, mesh, relay);
    await fs.rm(broken.historyPath);
    await fs.mkdir(broken.historyPath);
    // Not empty, so its size is not 0 on any file system, and reading it fails.
    await fs.writeFile(join(broken.historyPath, "some-entry-name"), "");
    appendFileSync(files.historyPath, entry("still read"));
    await until(() => e.texts().includes("still read"), 3000, "the other session");
  });

  it("noFollow is 0 where the platform has no O_NOFOLLOW", () => {
    expect(noFollow({})).toBe(0);
    expect(noFollow({ O_NOFOLLOW: 0x20000 })).toBe(0x20000);
  });

  it("openNoFollow refuses a link also when the open itself would follow it, as on Windows", async () => {
    const dir = await scratch("open");
    const real = join(dir, "real.jsonl");
    writeFileSync(real, entry("real"));
    await fs.symlink(real, join(dir, "link.jsonl"));
    // Flags without O_NOFOLLOW, as Windows has none.
    expect(await openNoFollow(join(dir, "link.jsonl"), constants.O_RDONLY)).toBeUndefined();
    const handle = await openNoFollow(real, constants.O_RDONLY);
    expect(handle).toBeDefined();
    await handle!.close();
    expect(await openNoFollow(join(dir, "missing.jsonl"), constants.O_RDONLY)).toBeUndefined();
  });

  it("parseEntry accepts only entries", () => {
    const ok = { dir: "in", peer: "p@x", id: "i", at: 1, text: "t" };
    expect(parseEntry(JSON.stringify(ok))).toEqual(ok);
    for (const bad of ["{", "null", "3", JSON.stringify({ ...ok, dir: "sideways" }), JSON.stringify({ ...ok, peer: 1 }), JSON.stringify({ ...ok, id: 2 }), JSON.stringify({ ...ok, at: "1" }), JSON.stringify({ ...ok, text: null })]) {
      expect(parseEntry(bad)).toBeUndefined();
    }
    expect(parseEntry(JSON.stringify({ ...ok, dir: "out" }))).toBeDefined();
  });
});

describe("the history request", () => {
  it("pages back with limit and before across sessions", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const files = await otherSession(devices[0]!, mesh, relay);
    const e = await start(devices[0]!, mesh, relay);
    const lines = Array.from({ length: 5 }, (_, i) => JSON.parse(entry(`m${i}`, 1000 + i)) as { id: string });
    appendFileSync(files.historyPath, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
    const texts = (r: Line): string[] => ((r["result"] as { messages: Array<{ text: string }> }).messages).map((m) => m.text);
    expect(texts(await e.request("history", { limit: 2 }))).toEqual(["m3", "m4"]);
    expect(texts(await e.request("history", { limit: 2, before: lines[3]!.id }))).toEqual(["m1", "m2"]);
    expect(texts(await e.request("history", { before: lines[0]!.id }))).toEqual(["before start"]);
    expect(texts(await e.request("history", { limit: 1, before: ulid() }))).toEqual(["m4"]);
    // With a peer filter, the cut must be one of that peer's entries.
    expect(texts(await e.request("history", { limit: 2, before: lines[3]!.id, peer: "p@two" }))).toEqual(["m1", "m2"]);
    expect(texts(await e.request("history", { limit: 2, before: lines[3]!.id, peer: "nobody@x" }))).toEqual([]);
  });
});
