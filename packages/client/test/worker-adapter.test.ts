// The `wim agent` adapter on its own: what it hands the worker for each item, and how it sends.
// The real session's side is in worker-e2e.test.ts.

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { WorkerItem } from "@worldinmotion/agent";
import { workerIO } from "../src/adapters.ts";
import type { MeshSession } from "../src/client.ts";

function fakeSession(status = "routed") {
  const sent: { to: string; text: string; opts: unknown }[] = [];
  const joined: string[] = [];
  const taken: number[] = [];
  const s = Object.assign(new EventEmitter(), {
    take: async (cursor: number) => void taken.push(cursor),
    send: async (to: string, text: string, opts: unknown) => {
      sent.push({ to, text, opts });
      return { id: "out-1", results: [{ to, status }] };
    },
    joinRoom: async (room: string) => (joined.push(room), []),
  });
  return { s: s as unknown as MeshSession, emit: (m: unknown) => s.emit("message", m), sent, joined, taken };
}

const items = (io: ReturnType<typeof workerIO>): WorkerItem[] => {
  const got: WorkerItem[] = [];
  io.onItem((i) => void got.push(i));
  return got;
};

describe("workerIO", () => {
  it("hands over the signing device, relayed, trust and a deadline, and takes each item", async () => {
    const f = fakeSession();
    const got = items(workerIO(f.s, async (d) => d === "dev-ok"));
    f.emit({ kind: "task", id: "m1", peer: "a@x", device: "dev-ok", text: "t", relayed: true, deadline: 99, frame: { id: "m1" }, cursor: 7 });
    f.emit({ kind: "msg", id: "m2", peer: "b@y", device: "dev-other", text: "u", cursor: 8 });
    await new Promise((r) => setImmediate(r));
    expect(got).toEqual([
      { kind: "task", id: "m1", from: "a@x", device: "dev-ok", text: "t", relayed: true, trusted: true, deadline: 99, frame: { id: "m1" } },
      { kind: "msg", id: "m2", from: "b@y", device: "dev-other", text: "u", relayed: false, trusted: false },
    ]);
    expect(f.taken).toEqual([7, 8]);
  });

  it("an item with no device, or a trust lookup that fails, is untrusted", async () => {
    const f = fakeSession();
    const got = items(
      workerIO(f.s, async () => {
        throw new Error("mesh.json unreadable");
      }),
    );
    f.emit({ kind: "msg", id: "m3", peer: "a@x", text: "t", cursor: 1 });
    f.emit({ kind: "msg", id: "m4", peer: "a@x", device: "d", text: "t", cursor: 2 });
    await new Promise((r) => setImmediate(r));
    expect(got.map((i) => [i.device, i.trusted])).toEqual([
      [undefined, false],
      ["d", false],
    ]);
  });

  it("replies and room copies are always relayed; the room is joined once", async () => {
    const f = fakeSession();
    const io = workerIO(f.s, async () => true);
    await io.send("a@x", "answer", { reply_to: "m1", kind: "result", status: "done" });
    await io.send("a@x", "hi", { reply_to: "m2", kind: "msg" });
    await io.post("#agents", "answer");
    await io.post("#agents", "again");
    expect(f.sent.map((x) => x.opts)).toEqual([
      { relayed: true, kind: "result", reply_to: "m1", status: "done" },
      { relayed: true, kind: "msg", reply_to: "m2" },
      { relayed: true },
      { relayed: true },
    ]);
    expect(f.joined).toEqual(["#agents"]);
  });

  it("a reply nobody accepted is an error, so the worker logs it", async () => {
    const f = fakeSession("unknown_peer");
    await expect(workerIO(f.s, async () => true).send("gone@x", "answer", { reply_to: "m1", kind: "msg" })).rejects.toThrow(/not delivered to gone@x/);
  });
});
