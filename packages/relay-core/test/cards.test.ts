import { sealMessage, type SendFrame } from "@worldinmotion/protocol";
import { describe, expect, it } from "vitest";
import { Client, KINDS, publish, roster, world } from "./helpers.ts";

/** A card sealed to every roster device, as SPEC section 17 describes. */
function card(c: Client, title: string, cwd?: string): SendFrame {
  const r = roster(c.h);
  return sealMessage({
    roster: r,
    sender: { deviceId: c.d.id, keys: c.d.keys },
    session: c.name,
    sid: c.sid,
    to: ["*"],
    seq: ++c.seq,
    at: c.h.now,
    kind: "card",
    card: { title, cwd },
    recipients: r.devices.map((d) => d.id),
  });
}

describe.each(KINDS)("peer cards (%s store)", (kind) => {
  it("stores the newest card per session, pushes changes, and sends every card after ready", () => {
    const w = world(kind, ["laptop", "server"]);
    const a = new Client(w.h, w.members[0]!, "a");
    const b = new Client(w.h, w.members[1]!, "b");
    expect(a.connect()[1]).toEqual({ t: "cards", cards: [], more: false });
    b.connect();
    const first = card(a, "first");
    expect(a.frame({ t: "card.set", msg: first })).toEqual([]);
    expect(b.conn.last()).toEqual({ t: "card", msg: first });
    const second = card(a, "second");
    a.frame({ t: "card.set", msg: second });
    // Never a message: nothing delivered, nothing queued.
    expect(b.conn.of("deliver")).toEqual([]);
    w.h.drop(a.conn);
    expect(w.h.store.queueCount(a.sid)).toBe(0);
    const late = new Client(w.h, w.members[1]!, "late");
    // Offline sessions keep their card.
    expect(late.connect().find((f) => f["t"] === "cards")).toEqual({ t: "cards", cards: [second], more: false });
  });

  it("caps the card bytes one device stores across its sessions", () => {
    const w = world(kind, ["laptop"], { limits: { cardBytesPerDevice: 2000 } });
    const a = new Client(w.h, w.members[0]!, "a");
    const b = new Client(w.h, w.members[0]!, "b");
    a.connect();
    b.connect();
    expect(a.frame({ t: "card.set", msg: card(a, "a") })).toEqual([]);
    // Replacing one's own card counts only the new one.
    expect(a.frame({ t: "card.set", msg: card(a, "a2") })).toEqual([]);
    expect(b.frame({ t: "card.set", msg: card(b, "b") })[0]).toMatchObject({ code: "limited", message: "too many card bytes for this device" });
  });

  it("checks from, the mesh-wide address, the size and the update rate", () => {
    const w = world(kind, ["laptop"], { limits: { cardFrameBytes: 2500 } });
    const a = new Client(w.h, w.members[0]!, "a");
    a.connect();
    const forged = { ...card(a, "x"), from: { device: a.d.id, session: "other", sid: a.sid } };
    expect(a.frame({ t: "card.set", msg: forged })[0]).toMatchObject({ code: "unauthorized", ref: "card.set" });
    // The relay checks the address only (receivers check the signature it would break).
    expect(a.frame({ t: "card.set", msg: { ...card(a, "x"), to: ["root@admin"] } })[0]).toMatchObject({ code: "malformed", ref: "card.set" });
    expect(a.frame({ t: "card.set", msg: { ...card(a, "x"), to: ["*", "root@admin"] } })[0]!["code"]).toBe("malformed");
    expect(a.frame({ t: "card.set", msg: { ...card(a, "x"), mesh: "AAAAAAAAAAAAAAAAAAAAAA" } })[0]!["code"]).toBe("malformed");
    expect(a.frame({ t: "card.set", msg: card(a, "y") })).toEqual([]);
    expect(a.frame({ t: "card.set", msg: card(a, "z") })).toEqual([]);
    expect(a.frame({ t: "card.set", msg: card(a, "z") })[0]).toMatchObject({ code: "limited" });
    w.h.now += 60_000;
    expect(a.frame({ t: "card.set", msg: card(a, "z") })).toEqual([]);
    expect(a.frame({ t: "card.set", msg: card(a, "q", "/".repeat(512)) })).toEqual([
      { t: "error", code: "too_large", message: "card is too large", ref: "card.set" },
    ]);
  });

  it("pages cards with cards.get, and drops a card on bye, revocation and takeover moves it", () => {
    const w = world(kind, ["laptop", "server"], { limits: { cardsPageBytes: 3000 } });
    const a = new Client(w.h, w.members[0]!, "a");
    const b = new Client(w.h, w.members[1]!, "b");
    a.connect();
    b.connect();
    a.frame({ t: "card.set", msg: card(a, "a") });
    b.frame({ t: "card.set", msg: card(b, "b") });
    const viewer = new Client(w.h, w.admin, "viewer");
    const first = viewer.connect().find((f) => f["t"] === "cards")!;
    expect(first["cards"]).toHaveLength(1);
    expect(first["more"]).toBe(true);
    const after = first["cards"][0]["from"]["sid"] as string;
    const rest = viewer.frame({ t: "cards.get", after })[0]!;
    expect(rest).toMatchObject({ t: "cards", more: false });
    expect(rest["cards"][0]["from"]["sid"] > after).toBe(true);
    expect(viewer.frame({ t: "cards.get" })[0]!["cards"]).toHaveLength(1);
    w.h.drop(b.conn);
    const again = new Client(w.h, b.d, "b", { resume: b.resume });
    again.connect();
    expect(w.h.store.cards().map((c) => c.sid).sort()).toEqual([a.sid, again.sid].sort());
    a.frame({ t: "bye", ended: true });
    publish(w, { revoke: [b.d.id] });
    expect(w.h.store.cards()).toEqual([]);
  });
});
