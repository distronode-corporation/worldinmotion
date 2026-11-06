// A `pause` the sending side keeps ends when a message it sent after hearing of the pause is
// delivered there (issue #59). Its own file: message ids carry their time, and the ULID
// generator stays monotonic within a process, so a test elsewhere in the same file that moves a
// session's clock forward would date these ids after the pause.

import { afterEach, describe, expect, it } from "vitest";
import type { MeshSession } from "../src/client.ts";
import { MeshFiles, type BreakerLimits } from "../src/mesh.ts";
import type { SpoolItem } from "../src/spool.ts";
import { FS, makeMesh, openSession, RelayHarness, until } from "./helpers.ts";

const open: MeshSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

const unread = (s: MeshSession): Promise<SpoolItem[]> => s.spool.unread();
const msgs = async (s: MeshSession): Promise<string[]> => (await unread(s)).filter((i) => i.kind === "msg").map((i) => /\n(\d+)\n/.exec(i.rendered)?.[1] ?? "?");

describe("the sending side", () => {
  it("stops reporting held once a message sent after the pause is delivered there", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const tier = { perPeerPerHour: 1, totalPerHour: 50, pingPong: false, pingPongExchanges: 8 };
    const breaker: BreakerLimits = { ...tier, perPeerPerHour: 50, trusted: { ...tier, cooldownMinutes: 60 } };
    await new MeshFiles(devices[1]!.home.meshDir(mesh), FS).updateConfig((c) => ({ ...c, breaker }));
    const a = await openSession(devices[0]!, mesh, relay, { name: "a" });
    const b = await openSession(devices[1]!, mesh, relay, { name: "b" });
    open.push(a, b);
    for (const t of ["1", "2"]) await a.send("b@two", t);
    await until(async () => Object.keys(await a.pausedBy.active()).length === 1);
    // The holding side loses its pause without saying lifted (as a restart of its session would).
    b.breaker.resume(devices[0]!.device.id);
    // Message 1 was delivered before the pause: its late receipt says nothing about the pause.
    const first = (await unread(b)).find((i) => i.kind === "msg")!;
    await b.take(first.cursor);
    await new Promise((r) => setTimeout(r, 200));
    expect(Object.keys(await a.pausedBy.active())).toHaveLength(1);
    // Message 3, sent after a heard of the pause, gets through and is taken: the pause is over.
    expect((await a.send("b@two", "3")).results[0]!.status).toBe("held");
    await until(async () => (await msgs(b)).includes("3"));
    const third = (await unread(b)).find((i) => i.kind === "msg" && i.rendered.includes("\n3\n"))!;
    await b.take(third.cursor);
    await until(async () => Object.keys(await a.pausedBy.active()).length === 0);
    expect((await a.send("b@two", "4")).results[0]!.status).toBe("routed");
  }, 30_000);
});
