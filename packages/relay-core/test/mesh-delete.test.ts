// `mesh.delete` (SPEC section 11): only an admin device's authenticated session deletes a mesh, and
// then every connection on it closes with 4005 and the host drops everything it holds.

import { CLOSE, hash, signRecoverAuth } from "@worldinmotion/protocol";
import { describe, expect, it } from "vitest";
import { Client, dev, KINDS, MESH, publish, RELAY, world, type World } from "./helpers.ts";

/** A mesh with a member and a recovery record, on a host that can delete it. */
function deletable(kind: (typeof KINDS)[number]) {
  const w = world(kind, ["laptop"]);
  const rec = dev("recovery", "admin");
  publish(w, { add: [rec.record] });
  const deleted: number[] = [];
  Object.assign(w.h.extra, { deleteMesh: () => void deleted.push(w.h.now) });
  w.h.hibernate();
  w.root.connect();
  const member = new Client(w.h, w.members[0]!, "m");
  member.connect();
  return { ...w, rec, member, deleted };
}

/** A recovery connection for the mesh's recovery record. */
function recoverConn(w: World, rec: ReturnType<typeof dev>) {
  const c = w.h.open();
  const nonce = c.take()[0]!["nonce"] as string;
  w.h.sendFrame(c, signRecoverAuth({ relay: RELAY, mesh: MESH, nonce, at: w.h.now, genesis: hash(w.chain[0]!) }, rec.keys));
  c.take();
  return c;
}

describe.each(KINDS)("mesh.delete (%s store)", (kind) => {
  it("is unsupported on a host that cannot delete, and needs auth first", () => {
    const w = world(kind);
    expect(w.root.frame({ t: "mesh.delete", mesh: MESH })).toEqual([{ t: "error", code: "unsupported", message: "this relay does not delete meshes", ref: "mesh.delete" }]);
    expect(w.h.relay.exists()).toBe(true);
    const pre = w.h.open();
    pre.take();
    w.h.sendFrame(pre, { t: "mesh.delete", mesh: MESH });
    expect(pre.take()).toEqual([{ t: "error", code: "unauthorized", message: "authenticate first", ref: "mesh.delete" }]);
  });

  it("refuses a member, another mesh's id and a recovery connection, and deletes nothing", () => {
    const w = deletable(kind);
    expect(w.member.frame({ t: "mesh.delete", mesh: MESH })).toEqual([{ t: "error", code: "unauthorized", message: "only an admin device can delete the mesh", ref: "mesh.delete" }]);
    const other = "B".repeat(21) + "A";
    expect(w.root.frame({ t: "mesh.delete", mesh: other })).toEqual([{ t: "error", code: "malformed", message: "that is not this connection's mesh", ref: "mesh.delete" }]);
    const c = recoverConn(w, w.rec);
    w.h.sendFrame(c, { t: "mesh.delete", mesh: MESH });
    expect(c.take()).toEqual([{ t: "error", code: "unauthorized", message: "a recovery connection only reads and publishes rosters", ref: "mesh.delete" }]);
    expect(w.deleted).toEqual([]);
    expect(w.member.conn.closed).toBeUndefined();
    expect(w.root.frame({ t: "peers" })[0]).toMatchObject({ t: "peers" });
  });

  it("answers an admin, closes every connection with 4005, then has the host delete the mesh", () => {
    const w = deletable(kind);
    const waiting = w.h.open();
    const recovering = recoverConn(w, w.rec);
    expect(w.root.frame({ t: "mesh.delete", mesh: MESH })).toEqual([{ t: "mesh.deleted", mesh: MESH }]);
    for (const c of [w.root.conn, w.member.conn, waiting, recovering]) expect(c.closed).toEqual({ code: CLOSE.deleted, reason: "mesh deleted" });
    expect(w.deleted).toEqual([w.h.now]);
    expect(w.h.logs.at(-1)).toEqual({ event: "deleted", fields: { by: w.admin.id } });
    // Every connection was already closed for the relay: their late close events change nothing.
    for (const c of [w.root.conn, w.member.conn]) w.h.relay.onClose(c);
    expect(w.h.store.sessionsOf(w.members[0]!.id).every((s) => s.conn !== null)).toBe(true);
    // The host's deletion is what removes the state; the relay sweeps nothing more for this mesh.
    w.h.advance(1_000);
  });
});
