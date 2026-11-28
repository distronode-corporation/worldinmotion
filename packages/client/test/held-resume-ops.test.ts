// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

// What `wim held resume` costs per item it releases (#195). On Windows each file call is slow, so
// a long pause with many held items took a minute or more to resume. The count is pinned per
// item, and the resume's result is pinned beside it: the spool, held/, history, the session's
// state and the breaker's pause come out the same, and a resume that stops part way loses nothing
// and delivers nothing twice.

import { ulid } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MeshSession } from "../src/client.ts";
import { listDir } from "../src/fsx.ts";
import { HeldBox } from "../src/held.ts";
import { History } from "../src/history.ts";
import { MeshFiles } from "../src/mesh.ts";
import { readBreakerFile } from "../src/pauses.ts";
import { Spool, type SpoolItem } from "../src/spool.ts";
import { breakerOf, FS, makeMesh, openSession, RelayHarness, run, said, term, until, type TestDevice } from "./helpers.ts";

const open: MeshSession[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

type Fn = (...a: unknown[]) => unknown;

/** Every node:fs promise call that touches the disk, and every call on an opened file's handle but its close. */
const CALLS = ["access", "appendFile", "copyFile", "link", "lstat", "mkdir", "open", "readFile", "readdir", "readlink", "rename", "rm", "stat", "unlink", "utimes", "writeFile"] as const;
const HANDLE = ["read", "readFile", "stat", "sync", "write", "writeFile"] as const;

/** The calls made while `fn` runs, by name. */
async function counted(fn: () => Promise<unknown>): Promise<Record<string, number>> {
  const by: Record<string, number> = {};
  const probe = await fs.open(import.meta.filename, "r");
  const proto = Object.getPrototypeOf(probe) as Record<string, Fn>;
  await probe.close();
  const spy = (target: Record<string, Fn>, name: string, label: string) => {
    const real = target[name]!;
    vi.spyOn(target, name).mockImplementation(function (this: unknown, ...a: unknown[]) {
      by[label] = (by[label] ?? 0) + 1;
      return real.apply(this, a);
    });
  };
  for (const name of CALLS) spy(fs as unknown as Record<string, Fn>, name, name);
  for (const name of HANDLE) spy(proto, name, `handle.${name}`);
  try {
    await fn();
  } finally {
    vi.restoreAllMocks();
  }
  return by;
}

/** A session b@two that no process runs, holding `n` breaker items from a@one, oldest first. */
async function heldBy(n: number) {
  const relay = new RelayHarness();
  const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
  await new MeshFiles(devices[1]!.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, breaker: breakerOf({ perPeerPerHour: 1, totalPerHour: 50, pingPong: false, pingPongExchanges: 32 }) }));
  const a = await openSession(devices[0]!, mesh, relay, { name: "a" });
  const holder = { name: "b", sessionKey: "key:b" };
  const b = await openSession(devices[1]!, mesh, relay, holder);
  for (const x of ["1", "2"]) await a.send("b@two", x);
  await until(async () => (await b.held.list()).length === 1);
  await b.stop();
  await a.stop();
  const box = new HeldBox(b.files.heldDir, FS);
  const [first] = await box.list();
  await box.remove(first!.id);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = ulid(first!.at + i);
    ids.push(id);
    await box.add({ ...first!, id, at: first!.at + i });
  }
  return { relay, mesh, devices, box, b, ids, holder };
}

/** The spool's items on disk, in number order. */
async function spooled(b: MeshSession): Promise<SpoolItem[]> {
  return (await new Spool(b.files.spoolDir, FS, 0).unread()).filter((i) => i.kind === "msg");
}

async function resume(d: TestDevice, relay: RelayHarness): Promise<{ code: number; said: string }> {
  const t = term(d.root, relay);
  t.answers.push("y");
  const code = await run(t, "held", "resume", "a@one");
  return { code, said: said(t) };
}

/** The calls one more released item costs: the difference between resuming 12 items and 4, per item. */
async function perItem(): Promise<{ total: number; by: Record<string, number> }> {
  const calls: Array<Record<string, number>> = [];
  for (const n of [4, 12]) {
    const { relay, devices, box } = await heldBy(n);
    calls.push(await counted(async () => expect((await resume(devices[1]!, relay)).code).toBe(0)));
    expect(await box.list()).toEqual([]);
  }
  const [small, large] = calls as [Record<string, number>, Record<string, number>];
  const by = Object.fromEntries(
    [...new Set([...Object.keys(small), ...Object.keys(large)])]
      .sort()
      .map((k) => [k, ((large[k] ?? 0) - (small[k] ?? 0)) / 8] as const)
      .filter(([, v]) => v !== 0),
  );
  return { total: Object.values(by).reduce((a, b) => a + b, 0), by };
}

describe("wim held resume, per item released (#195)", () => {
  it("costs a fixed number of file calls per item", async () => {
    const { total, by } = await perItem();
    // Before #195 it was 27: the session's state read and written, and its spool opened, for each
    // item; a directory made before each write; and the delivered mark written through a temp file.
    // Each item still writes, in order, its spool file (writeFile, link, rm of the temp), its
    // delivered mark (open, sync), its history line (stat, appendFile), and leaves held/ (rm, rm).
    // Its reads: its held file, at the prompt and again under the session's lock, and the spool's
    // directory and cursor, which another process may move (Spool.write).
    expect(by).toEqual({ appendFile: 1, "handle.sync": 2, link: 1, open: 1, readFile: 3, readdir: 1, rm: 3, stat: 1, writeFile: 1 });
    expect(total).toBe(14);
  }, 60_000);

  // The world is made before the test, so the test's own time, which the test reporter prints, is
  // the resume and a few reads after it.
  describe("of 100 held items", () => {
    let w: Awaited<ReturnType<typeof heldBy>>;
    let before: number;
    let recorded: number;
    const inHistory = async () => (await new History(w.b.files.historyPath, Date.now).query({ limit: 200 })).filter((e) => e.dir === "in");
    beforeAll(async () => {
      w = await heldBy(100);
      before = (await spooled(w.b)).length;
      recorded = (await inHistory()).length;
    }, 60_000);

    it("releases them into the spool in their order, records each in history, and leaves held/ and the pause empty", async () => {
      const out = await resume(w.devices[1]!, w.relay);
      expect(out.code).toBe(0);
      expect(out.said).toContain("released 100 held by the breaker");
      const items = (await spooled(w.b)).slice(before);
      expect(items.map((i) => i.id)).toEqual(w.ids);
      expect(items.every((i) => i.from === "a@one" && i.relayed === undefined)).toBe(true);
      // One number each, in order, and the session's state records the highest.
      const numbers = items.map((i) => i.cursor);
      expect(numbers).toEqual(numbers.map((_, k) => numbers[0]! + k));
      expect((await w.b.files.load())!.spool).toBe(numbers.at(-1));
      expect(await listDir(w.b.files.heldDir)).toEqual([]);
      // Each copy carries the one message's entry, so history holds it once for each released.
      const history = await inHistory();
      expect(history.length - recorded).toBe(100);
      expect(new Set(history.slice(recorded).map((e) => e.text))).toEqual(new Set(["2"]));
      expect((await readBreakerFile(w.b.files.breakerPath)).pauses).toEqual([]);
    }, 120_000);
  });

  it("keeps a change another writer saves to the session's state while the items are released", async () => {
    const { relay, devices, b, ids } = await heldBy(4);
    const proto = HeldBox.prototype as unknown as { settle: (id: string) => Promise<void> };
    const settle = proto.settle;
    let settled = 0;
    // A session this process runs (a UI's events process) saves its own state between two items.
    proto.settle = async function (this: HeldBox, id: string) {
      await settle.call(this, id);
      if (++settled === 2) await b.files.save({ ...(await b.files.load())!, rooms: ["kept"] });
    };
    try {
      expect((await resume(devices[1]!, relay)).code).toBe(0);
    } finally {
      proto.settle = settle;
    }
    const state = (await b.files.load())!;
    expect(state.rooms).toEqual(["kept"]);
    expect(state.spool).toBe((await spooled(b)).find((i) => i.id === ids.at(-1))!.cursor);
  }, 60_000);

  it("stops part way: what was released stays released and recorded, the rest stays held, and the next process delivers each once", async () => {
    const { relay, mesh, devices, b, ids, holder } = await heldBy(5);
    const before = (await spooled(b)).map((i) => i.id);
    const proto = HeldBox.prototype as unknown as { settle: (id: string) => Promise<void> };
    const settle = proto.settle;
    let settled = 0;
    proto.settle = function (this: HeldBox, id: string) {
      // The third item is in the spool and marked delivered when the process stops.
      if (++settled === 3) return Promise.reject(Object.assign(new Error("the process stopped here"), { code: "ECRASH" }));
      return settle.call(this, id);
    };
    try {
      expect((await resume(devices[1]!, relay)).code).toBe(1);
    } finally {
      proto.settle = settle;
    }
    const items = await spooled(b);
    expect(items.map((i) => i.id)).toEqual([...before, ...ids.slice(0, 3)]);
    expect((await b.files.load())!.spool).toBe(items.at(-1)!.cursor);
    expect((await new HeldBox(b.files.heldDir, FS).list()).map((i) => i.id)).toEqual(ids.slice(2));
    expect(await new HeldBox(b.files.heldDir, FS).wasDelivered(ids[2]!)).toBe(true);
    // The next process takes the third out of held/ without delivering it again.
    const again = await openSession(devices[1]!, mesh, relay, holder);
    open.push(again);
    await until(async () => !(await again.held.list()).some((i) => i.id === ids[2]));
    const delivered = (await again.spool.unread()).map((i) => i.id);
    expect(new Set(delivered).size).toBe(delivered.length);
    expect(delivered.filter((id) => ids.includes(id))).toEqual(ids.slice(0, 3));
  }, 60_000);
});

describe("wim held resume, policy holds from the same device (#214)", () => {
  /** A session b@two holding `n` breaker items from a@one plus `m` policy items from a@one. */
  async function heldByWithPolicy(n: number, m: number) {
    const w = await heldBy(n);
    const [first] = await w.box.list();
    for (let i = 0; i < m; i++) {
      const id = ulid(first!.at + 1000 + i);
      await w.box.add({ ...first!, id, at: first!.at + 1000 + i, reason: "policy", pause: undefined });
    }
    return w;
  }

  it("says nothing extra when only the breaker holds items from the device", async () => {
    const { relay, devices } = await heldBy(2);
    const out = await resume(devices[1]!, relay);
    expect(out.code).toBe(0);
    expect(out.said).toContain("released 2 held by the breaker");
    expect(out.said).not.toContain("policy hold");
  }, 60_000);

  it("names the one policy hold it does not release", async () => {
    const { relay, devices, box } = await heldByWithPolicy(2, 1);
    const out = await resume(devices[1]!, relay);
    expect(out.code).toBe(0);
    expect(out.said).toContain(
      "1 other item from this device is a policy hold, which resume does not release: wim held approve <id> or wim held refuse <id> decides each one.",
    );
    const left = await box.list();
    expect(left).toHaveLength(1);
    expect(left[0]!.reason).toBe("policy");
  }, 60_000);

  it("names the policy holds, plural, it does not release", async () => {
    const { relay, devices, box } = await heldByWithPolicy(2, 3);
    const out = await resume(devices[1]!, relay);
    expect(out.code).toBe(0);
    expect(out.said).toContain(
      "3 other items from this device are policy holds, which resume does not release: wim held approve <id> or wim held refuse <id> decides each one.",
    );
    const left = await box.list();
    expect(left).toHaveLength(3);
    expect(left.every((i) => i.reason === "policy")).toBe(true);
  }, 60_000);
});
