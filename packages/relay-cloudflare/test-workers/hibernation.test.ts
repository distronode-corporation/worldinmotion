import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { nextRoster, type Roster } from "@worldinmotion/protocol";
import { describe, expect, it } from "vitest";
import type { Attachment, MeshDurableObject } from "../src/index.ts";
import { createMesh, dev, meshStub, Session, Socket } from "./helpers.ts";

type Marked = MeshDurableObject & { marker?: string };

describe("hibernation", () => {
  it("rebuilds the relay from SQLite and the sockets' attachments after an eviction, and carries on", async () => {
    const m = await createMesh();
    const laptop = dev("laptop");
    const root = new Session(m.mesh, m.admin, "root");
    await root.connect(m.genesis);
    const r2: Roster = nextRoster(m.genesis, { add: [laptop.record] }, m.admin, Date.now());
    root.sock.send({ t: "roster.publish", roster: r2 });
    await root.sock.next("roster");
    const writer = new Session(m.mesh, laptop, "writer");
    await writer.connect(r2);
    // A third socket that has had hello but not authenticated yet.
    const late = new Session(m.mesh, laptop, "late");
    const lateSock = await Socket.open(m.mesh);
    const lateNonce = (await lateSock.next("hello"))["nonce"] as string;

    const stub = meshStub(m.mesh);
    await runInDurableObject(stub, (o: Marked) => void (o.marker = "before"));
    const before = await runInDurableObject(stub, (_o, state) => state.getWebSockets().map((ws) => ws.deserializeAttachment() as Attachment));

    await evictDurableObject(stub);

    // A new instance (the marker is gone) with the same sockets and the same attachments.
    const after = await runInDurableObject(stub, (o: Marked, state) => ({
      marker: o.marker,
      attachments: state.getWebSockets().map((ws) => ws.deserializeAttachment() as Attachment),
    }));
    expect(after.marker).toBeUndefined();
    expect(after.attachments).toEqual(before);
    // root and writer, the create socket (still unauthenticated) and the late one.
    expect(after.attachments.map((a) => a.state.phase).sort()).toEqual(["authed", "authed", "pre", "pre"]);

    // The sessions stay online through the rebuild, and messages flow both ways.
    const peers = await root.sock.ask({ t: "peers" }, "peers");
    expect(peers["peers"]).toEqual([expect.objectContaining({ address: "writer@laptop", status: "idle" })]);
    const f = root.seal(r2, [writer.address], [laptop.id]);
    expect(await root.sock.ask(f, "sent")).toMatchObject({ results: [{ status: "routed" }] });
    expect(await writer.sock.next("deliver")).toEqual({ t: "deliver", cursor: 1, msg: f });
    const back = writer.seal(r2, [root.address], [m.admin.id]);
    await writer.sock.ask(back, "sent");
    expect((await root.sock.next("deliver"))["msg"]).toEqual(back);

    // The socket that was mid-handshake authenticates with the nonce from before the eviction.
    expect(await late.connect(r2, { sock: lateSock, nonce: lateNonce })).toMatchObject({ t: "ready", name: "late" });

    // A second eviction, then a disconnect handled by a fresh instance marks only that session offline.
    await evictDurableObject(stub);
    writer.sock.close();
    const offline = await root.sock.next((f) => f["t"] === "peer" && f["peer"]["status"] === "offline");
    expect(offline["peer"]["address"]).toBe("writer@laptop");
  });

  it("marks sessions offline whose sockets closed while the object was evicted", async () => {
    const m = await createMesh();
    const root = new Session(m.mesh, m.admin, "root");
    await root.connect(m.genesis);
    const stub = meshStub(m.mesh);
    await evictDurableObject(stub, { webSockets: "close" });
    const s = new Session(m.mesh, m.admin, "other");
    await s.connect(m.genesis);
    const peers = await s.sock.ask({ t: "peers" }, "peers");
    expect(peers["peers"]).toEqual([expect.objectContaining({ address: "root@admin", status: "offline" })]);
  });
});
