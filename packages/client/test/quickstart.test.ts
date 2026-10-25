// The README quick start, step by step, through the real CLI against the in-process relay:
// init, invite, join, trust both ways, then a first send to the other device's default `cli`
// session before that device has run anything else.

import { describe, expect, it } from "vitest";
import { RELAY, RelayHarness, run, said, scratch, term, until } from "./helpers.ts";

async function quickStart(): Promise<{ a: ReturnType<typeof term>; b: ReturnType<typeof term> }> {
  const relay = new RelayHarness();
  const a = term(await scratch("qs-a"), relay);
  const b = term(await scratch("qs-b"), relay);
  expect(await run(a, "init", "--name", "qs-a", "--relay", RELAY, "--no-recovery")).toBe(0);
  a.answers.push("y");
  const inviting = run(a, "invite");
  await until(() => a.out.some((l) => l.includes("wim1_")));
  const code = a.out.find((l) => l.includes("wim1_"))!.trim();
  expect(await run(b, "join", code, "--name", "qs-b")).toBe(0);
  expect(await inviting).toBe(0);
  expect(await run(a, "devices", "trust", "qs-b")).toBe(0);
  expect(await run(b, "devices", "trust", "qs-a")).toBe(0);
  return { a, b };
}

describe("the README quick start", () => {
  it("queues a first send to the joined device's cli session, and its first inbox delivers it", async () => {
    const { a, b } = await quickStart();
    a.out.length = 0;
    const sent = await run(a, "send", "cli@qs-b", "hello");
    expect(said(a)).toContain("cli@qs-b: queued");
    expect(sent).toBe(0);
    b.out.length = 0;
    expect(await run(b, "inbox")).toBe(0);
    expect(said(b)).toContain("hello");
    // The registered session is listed as what it is: offline, not online.
    a.out.length = 0;
    expect(await run(a, "peers")).toBe(0);
    expect(a.out.find((l) => l.startsWith("cli@qs-b"))).toMatch(/offline/);
  }, 30_000);

  it("queues a first send back to the first device's cli session too", async () => {
    const { a, b } = await quickStart();
    b.out.length = 0;
    const sent = await run(b, "send", "cli@qs-a", "hi back");
    expect(said(b)).toContain("cli@qs-a: queued");
    expect(sent).toBe(0);
    a.out.length = 0;
    expect(await run(a, "inbox")).toBe(0);
    expect(said(a)).toContain("hi back");
  }, 30_000);

  it("shows the recovery code before it registers the cli session, so a slow relay cannot delay or lose it", async () => {
    const relay = new RelayHarness();
    const a = term(await scratch("qs-a"), relay, { isTTY: true });
    // For each sign-in the relay accepts, whether the recovery code was already on screen.
    const shownAtReady: boolean[] = [];
    relay.toClient = (text) => {
      if (text.includes('"t":"ready"')) shownAtReady.push(a.out.some((l) => l.startsWith("Recovery code")));
      return text;
    };
    expect(await run(a, "init", "--name", "qs-a", "--relay", RELAY)).toBe(0);
    expect(said(a)).toMatch(/Recovery code \(shown once/);
    // The last sign-in is the cli registration: by then the code had been shown.
    expect(shownAtReady.at(-1)).toBe(true);
  }, 30_000);

  it("still joins when the relay cannot be reached again to register the cli session, and says what that means", async () => {
    const relay = new RelayHarness();
    const a = term(await scratch("qs-a"), relay);
    const b = term(await scratch("qs-b"), relay, { connectMs: 200 });
    expect(await run(a, "init", "--name", "qs-a", "--relay", RELAY, "--no-recovery")).toBe(0);
    a.answers.push("y");
    const inviting = run(a, "invite");
    await until(() => a.out.some((l) => l.includes("wim1_")));
    const code = a.out.find((l) => l.includes("wim1_"))!.trim();
    // The relay goes away right after it admits the device: the join's own connection still
    // finishes, and the next dial (the registration) fails.
    relay.toClient = (text) => {
      if (text.includes('"t":"joined"')) relay.down = true;
      return text;
    };
    expect(await run(b, "join", code, "--name", "qs-b")).toBe(0);
    expect(await inviting).toBe(0);
    expect(said(b)).toMatch(/Joined mesh/);
    expect(said(b)).toMatch(/could not register cli with the relay .*sends to cli here answer `unknown`/);
  }, 30_000);
});
