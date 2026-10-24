import { afterEach, describe, expect, it } from "vitest";
import type { MeshSession } from "../src/client.ts";
import { makeMesh, openSession, RelayHarness, until } from "./helpers.ts";

const open: MeshSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop();
});

describe("two devices", () => {
  it("send and reply", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["laptop", "server"]);
    const a = await openSession(devices[0]!, mesh, relay, { name: "writer" });
    const b = await openSession(devices[1]!, mesh, relay, { name: "reviewer" });
    open.push(a, b);
    const sent = await a.send("reviewer@server", "please review");
    expect(sent.results).toEqual([{ to: "reviewer@server", status: "routed" }]);
    await until(async () => (await b.spool.unread()).length === 1, 3000, "delivery");
    const [item] = await b.spool.unread();
    expect(item!.from).toBe("writer@laptop");
    expect(item!.rendered).toContain("please review");
  });
});
