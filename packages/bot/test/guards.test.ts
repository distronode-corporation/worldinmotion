import { describe, expect, it } from "vitest";
import { Gate, Guards, MAX_TEXT_BYTES } from "../src/guards.ts";
import { clock } from "./helpers.ts";

function guards(over: { replyToBots?: boolean; perPeerPerHour?: number } = {}) {
  const c = clock();
  const g = new Guards({ replyToBots: false, perPeerPerHour: 30, now: c.now, ...over });
  return { g, c };
}

const item = (text: string, from = "a@x", fromKind = "claude-code") => ({ from, fromKind, text });

describe("Guards", () => {
  it("refuses bots unless configured", () => {
    expect(guards().g.admit(item("hi", "b@y", "bot"))).toEqual({ ok: false, reason: "bot" });
    expect(guards({ replyToBots: true }).g.admit(item("hi", "b@y", "bot"))).toEqual({ ok: true });
  });

  it("refuses texts over 32 KiB, measured in UTF-8 bytes", () => {
    const { g } = guards();
    expect(g.admit(item("a".repeat(MAX_TEXT_BYTES)))).toEqual({ ok: true });
    // 'é' is two bytes, so half as many characters already overflow.
    expect(g.admit(item("é".repeat(MAX_TEXT_BYTES / 2 + 1)))).toEqual({ ok: false, reason: "too_long" });
  });

  it("ignores the same text from the same sender within 60 seconds", () => {
    const { g, c } = guards();
    expect(g.admit(item("ping"))).toEqual({ ok: true });
    expect(g.admit(item("ping"))).toEqual({ ok: false, reason: "duplicate" });
    expect(g.admit(item("ping", "other@x"))).toEqual({ ok: true });
    expect(g.admit(item("pong"))).toEqual({ ok: true });
    c.advance(59_999);
    expect(g.admit(item("ping"))).toEqual({ ok: false, reason: "duplicate" });
    c.advance(1);
    expect(g.admit(item("ping"))).toEqual({ ok: true });
  });

  it("allows perPeerPerHour replies per sender in a sliding hour", () => {
    const { g, c } = guards({ perPeerPerHour: 2 });
    expect(g.admit(item("1"))).toEqual({ ok: true });
    c.advance(1000);
    expect(g.admit(item("2"))).toEqual({ ok: true });
    expect(g.admit(item("3"))).toEqual({ ok: false, reason: "rate" });
    expect(g.admit(item("3", "b@x"))).toEqual({ ok: true });
    c.advance(3_600_000 - 1000);
    expect(g.admit(item("4"))).toEqual({ ok: true });
    expect(g.admit(item("5"))).toEqual({ ok: false, reason: "rate" });
  });
});

describe("Gate", () => {
  it("runs maxConcurrent at once, queues the rest in order, and drops past maxQueue", async () => {
    const gate = new Gate(1, 2);
    const order: string[] = [];
    await gate.enter();
    expect(gate.running).toBe(1);
    const b = gate.enter()!.then(() => order.push("b"));
    const c = gate.enter()!.then(() => order.push("c"));
    expect(gate.enter()).toBeNull();
    expect(gate.queued).toBe(2);
    gate.leave();
    await b;
    expect(gate.running).toBe(1);
    gate.leave();
    await c;
    gate.leave();
    expect(order).toEqual(["b", "c"]);
    expect(gate.running).toBe(0);
    expect(gate.queued).toBe(0);
  });
});
