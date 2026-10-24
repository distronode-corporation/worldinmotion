import { describe, expect, it } from "vitest";
import { Client, KINDS, world } from "./helpers.ts";

describe.each(KINDS)("flow (%s store)", (kind) => {
  it("creates, authenticates, sends, delivers and acks", () => {
    const w = world(kind, ["laptop"]);
    expect(w.root.ready).toBeDefined();
    const a = new Client(w.h, w.members[0]!, "writer");
    const frames = a.connect();
    expect(frames[0]!["t"]).toBe("ready");
    const sent = w.root.send([a.address]);
    expect(sent).toMatchObject({ t: "sent", results: [{ to: "writer@laptop", status: "routed" }] });
    const d = a.conn.last("deliver");
    expect(d["cursor"]).toBe(1);
    a.frame({ t: "ack", cursor: 1 });
    expect(w.h.store.queueCount(a.sid)).toBe(0);
  });
});
