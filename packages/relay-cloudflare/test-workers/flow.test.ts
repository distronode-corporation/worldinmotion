import { runInDurableObject } from "cloudflare:test";
import { admitJoin, createInvite, createJoin, nextRoster, rosterRef, type Roster } from "@worldinmotion/protocol";
import { describe, expect, it } from "vitest";
import { createMesh, dev, meshStub, RELAY, Session, Socket } from "./helpers.ts";

describe("a whole mesh over real WebSockets", () => {
  it("creates, invites, joins, authenticates, sends, delivers and acks", async () => {
    // create: the admin's first connection sends the genesis roster.
    const m = await createMesh();
    const root = new Session(m.mesh, m.admin, "root");
    expect(await root.connect(m.genesis)).toMatchObject({ t: "ready", name: "root", cursor: 0, more: false });

    // invite: the admin registers an invite id with the relay.
    const inv = createInvite({ relay: RELAY, mesh: m.mesh, pin: rosterRef(m.genesis), now: Date.now() });
    root.sock.send({ t: "invite.create", invite: inv.inviteId, exp: inv.exp });

    // join: a new device dials with the invite; the request reaches the online admin.
    const laptop = dev("laptop");
    const joinSock = await Socket.open(m.mesh);
    const nonce = (await joinSock.next("hello"))["nonce"] as string;
    const join = createJoin({ relay: RELAY, mesh: m.mesh, secret: inv.secret, pin: rosterRef(m.genesis), exp: inv.exp, inviteId: inv.inviteId }, "laptop", laptop.keys, nonce);
    joinSock.send(join);
    const { t: _t, ...body } = join;
    expect(await root.sock.next("join.request")).toEqual({ t: "join.request", join: body });

    // The admin approves by publishing the next roster; the joiner gets the chain.
    const next: Roster = nextRoster(m.genesis, { add: [admitJoin(join.device, Date.now())] }, m.admin, Date.now());
    root.sock.send({ t: "roster.publish", roster: next });
    expect(await joinSock.next("joined")).toEqual({ t: "joined", chain: [m.genesis, next], more: false });

    // auth: the joiner authenticates on the same connection.
    const writer = new Session(m.mesh, laptop, "writer");
    expect(await writer.connect(next, { sock: joinSock, nonce })).toMatchObject({ t: "ready", name: "writer" });

    // send, deliver, ack.
    const frame = root.seal(next, [writer.address], [laptop.id], "hi from root");
    const sent = await root.sock.ask(frame, "sent");
    expect(sent).toMatchObject({ t: "sent", id: frame.id, results: [{ to: "writer@laptop", status: "routed" }] });
    const d = await writer.sock.next("deliver");
    expect(d).toEqual({ t: "deliver", cursor: 1, msg: frame });
    writer.sock.send({ t: "ack", cursor: 1 });
    // A peers request after the ack answers once the ack is handled (frames run in order; a ping
    // would not do, since the runtime answers it without the object).
    await writer.sock.ask({ t: "peers" }, "peers");
    const queued = await runInDurableObject(meshStub(m.mesh), (_o, state) => state.storage.sql.exec("SELECT COUNT(*) AS n FROM queue").one()["n"]);
    expect(queued).toBe(0);
    root.sock.close();
    writer.sock.close();
  });

  it("logs a pinned-roster fork as an operator event", async () => {
    const m = await createMesh();
    const root = new Session(m.mesh, m.admin, "root");
    const forged = { seq: 1, hash: "A".repeat(43) };
    expect(await root.connect(m.genesis, { pin: forged })).toMatchObject({ t: "ready" });
    const forks = await runInDurableObject(meshStub(m.mesh), (_o, state) => state.storage.sql.exec("SELECT kind, b FROM forks").toArray());
    expect(forks).toEqual([{ kind: "pin", b: forged.hash }]);
  });

  it("refuses a second create of the same mesh id", async () => {
    const m = await createMesh();
    const again = await Socket.open(m.mesh);
    await again.next("hello");
    expect(await again.ask({ t: "create", roster: m.genesis }, "error")).toMatchObject({ code: "mesh_exists", ref: "create" });
  });
});
