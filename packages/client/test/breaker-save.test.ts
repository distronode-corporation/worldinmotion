// Regression test from the review of PR #76 (F14): breaker.json writes are one at a time, each
// taking its rows when its turn comes, so a slow write of an older picture never lands last. The
// mock delays one write, or fails one.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeshSession } from "../src/client.ts";
import { MeshFiles, type BreakerLimits } from "../src/mesh.ts";
import { FS, makeMesh, openSession, RelayHarness, until, type TestDevice } from "./helpers.ts";

const control = vi.hoisted(() => ({ gate: undefined as Promise<void> | undefined, pending: false, fail: false, failWhen: undefined as ((file: { pauses: unknown[] }) => boolean) | undefined }));

vi.mock("../src/pauses.ts", async (importOriginal) => {
  const m = await importOriginal<typeof import("../src/pauses.ts")>();
  return {
    ...m,
    savePauses: async (...args: Parameters<typeof m.savePauses>) => {
      if (control.fail || control.failWhen?.(args[1]) === true) {
        control.fail = false;
        control.failWhen = undefined;
        throw new Error("ENOSPC: no space left on device");
      }
      const gate = control.gate;
      control.gate = undefined;
      if (gate !== undefined) {
        control.pending = true;
        await gate;
      }
      return m.savePauses(...args);
    },
  };
});

const { readPauses } = await import("../src/pauses.ts");

const open: MeshSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

async function session(...args: Parameters<typeof openSession>): Promise<MeshSession> {
  const s = await openSession(...args);
  open.push(s);
  return s;
}

async function setBreaker(d: TestDevice, mesh: string, breaker: BreakerLimits): Promise<void> {
  await new MeshFiles(d.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, breaker }));
}

describe("F14: concurrent breaker.json writes", () => {
  it("a pause that trips while a resume is writing is still in breaker.json afterwards", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two", "three"]);
    await setBreaker(devices[1]!, mesh, { perPeerPerHour: 1, totalPerHour: 50, pingPong: false, pingPongExchanges: 8, cooldownMinutes: 60 });
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const c = await session(devices[2]!, mesh, relay, { name: "c" });
    let offset = 0;
    const b = await session(devices[1]!, mesh, relay, { name: "b", now: () => Date.now() + offset });
    for (const t of ["a1", "a2"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 1);
    // The person resumes a@one (the pane, or `wim held resume` while b runs): b writes
    // breaker.json without a's pause (slowly, here).
    let open!: () => void;
    control.gate = new Promise<void>((r) => (open = r));
    const resumed = b.resumePeer("a@one");
    await until(() => control.pending);
    // Meanwhile c sends what trips its pause; it is handled after the resume, and written after it.
    for (const t of ["c1", "c2"]) await c.send("b@two", t);
    open();
    await resumed;
    await until(async () => (await readPauses(b.files.breakerPath, Date.now() + offset)).some((r) => r.from === "c@three" && r.told.length === 1));
    await new Promise((r) => setTimeout(r, 300));
    expect(b.pausedRows().map((r) => r.from)).toEqual(["c@three"]);
    expect((await readPauses(b.files.breakerPath, Date.now() + offset)).map((r) => r.from), "breaker.json").toEqual(["c@three"]);
  }, 30_000);

  it("a resume a marker asks for whose write fails is logged, and the held message stays held", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, { perPeerPerHour: 1, totalPerHour: 50, pingPong: false, pingPongExchanges: 8, cooldownMinutes: 60 });
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const lines: string[] = [];
    const b = await session(devices[1]!, mesh, relay, { name: "b", log: (l) => void lines.push(l) });
    for (const t of ["1", "2"]) await a.send("b@two", t);
    await until(async () => (await b.held.list()).length === 1, 10_000);
    // Only the resume's own write fails: the first that lifts the pause.
    control.failWhen = (file) => file.pauses.length === 0;
    await fs.mkdir(b.files.controlDir, { recursive: true });
    await fs.writeFile(join(b.files.controlDir, "resume-a@one"), "");
    await until(() => lines.some((l) => /^wim: housekeeping: .*ENOSPC/.test(l)), 10_000);
    expect((await b.held.list()).map((h) => h.entry.text)).toEqual(["2"]);
  }, 30_000);

  it("a write that fails is reported to the step that asked for it, and the next write goes through", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    await setBreaker(devices[1]!, mesh, { perPeerPerHour: 1, totalPerHour: 50, pingPong: false, pingPongExchanges: 8, cooldownMinutes: 60 });
    const a = await session(devices[0]!, mesh, relay, { name: "a" });
    const lines: string[] = [];
    const b = await session(devices[1]!, mesh, relay, { name: "b", log: (l) => void lines.push(l) });
    await a.send("b@two", "1");
    await until(async () => (await b.spool.unread()).length === 1);
    // The trip's write fails: that message is not taken (it comes again), and the next write works.
    control.fail = true;
    await a.send("b@two", "2");
    await until(async () => (await b.held.list()).length === 1, 10_000);
    await until(async () => (await readPauses(b.files.breakerPath, Date.now())).some((r) => r.from === "a@one"));
    expect(lines.some((l) => /ENOSPC/.test(l))).toBe(true);
  }, 30_000);
});
