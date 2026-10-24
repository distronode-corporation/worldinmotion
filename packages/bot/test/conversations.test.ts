import { describe, expect, it } from "vitest";
import { Conversations } from "../src/conversations.ts";
import { clock } from "./helpers.ts";

function make(maxTurns = 20, maxChars = 24_000) {
  const c = clock();
  return { conv: new Conversations({ maxTurns, maxChars, idleMs: 86_400_000, now: c.now }), c };
}

describe("Conversations", () => {
  it("sends history then the new user turn, alternating and starting with user", () => {
    const { conv } = make();
    expect(conv.context("a", "one")).toEqual({
      messages: [{ role: "user", text: "one" }],
      userText: "one",
    });
    conv.commit("a", "one", "r1");
    conv.commit("a", "two", "r2");
    expect(conv.context("a", "three").messages).toEqual([
      { role: "user", text: "one" },
      { role: "assistant", text: "r1" },
      { role: "user", text: "two" },
      { role: "assistant", text: "r2" },
      { role: "user", text: "three" },
    ]);
    expect(conv.context("b", "x").messages).toHaveLength(1);
  });

  it("keeps at most maxTurns turns, dropping the oldest exchange first", () => {
    const { conv } = make(4);
    for (const n of [1, 2, 3]) conv.commit("a", `u${n}`, `r${n}`);
    // 4 turns leave room for one exchange plus the new message.
    expect(conv.context("a", "now").messages.map((m) => m.text)).toEqual(["u3", "r3", "now"]);
  });

  it("with maxTurns 1 sends only the new message and stores nothing", () => {
    const { conv } = make(1);
    conv.commit("a", "u", "r");
    expect(conv.context("a", "now").messages).toEqual([{ role: "user", text: "now" }]);
  });

  it("keeps the transcript within the character budget, oldest first", () => {
    const { conv } = make(20, 10);
    conv.commit("a", "aaa", "bbb"); // 6
    conv.commit("a", "cc", "dd"); // 4, stored total 10
    expect(conv.context("a", "e").messages.map((m) => m.text)).toEqual(["cc", "dd", "e"]);
    expect(conv.context("a", "eeeee").messages.map((m) => m.text)).toEqual(["cc", "dd", "eeeee"]);
    expect(conv.context("a", "eeeeeee").messages.map((m) => m.text)).toEqual(["eeeeeee"]);
    // An exchange larger than the whole budget is not kept.
    conv.commit("a", "x".repeat(20), "y");
    expect(conv.context("a", "z").messages.map((m) => m.text)).toEqual(["z"]);
  });

  it("prefixes notes to the next user turn, then clears them on commit", () => {
    const { conv } = make();
    conv.note("a", "result: done");
    conv.note("a", "x".repeat(3000));
    const { messages, userText } = conv.context("a", "hi");
    expect(userText).toBe(`result: done\n${"x".repeat(2000)}\n\nhi`);
    expect(messages).toEqual([{ role: "user", text: userText }]);
    conv.commit("a", userText, "ok");
    expect(conv.context("a", "next").userText).toBe("next");
  });

  it("keeps only the last five notes", () => {
    const { conv } = make();
    for (let i = 1; i <= 7; i++) conv.note("a", `n${i}`);
    expect(conv.context("a", "hi").userText).toBe("n3\nn4\nn5\nn6\nn7\n\nhi");
  });

  it("forgets a thread after 24 hours idle", () => {
    const { conv, c } = make();
    conv.commit("a", "u", "r");
    conv.commit("b", "u", "r");
    c.advance(86_400_000);
    expect(conv.context("b", "still here").messages).toHaveLength(3);
    expect(conv.size).toBe(2);
    c.advance(1);
    expect(conv.size).toBe(1);
    expect(conv.context("a", "back").messages).toHaveLength(1);
  });
});
