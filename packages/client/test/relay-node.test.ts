// End to end over real sockets: the `wim` CLI against relay-node on loopback, plain and pinned TLS.

import { start, type RunningRelay } from "@worldinmotion/relay-node";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inviteCodeOf, RelayHarness, run, said, sasOf, scratch, term, until } from "./helpers.ts";

const relays: RunningRelay[] = [];
afterEach(async () => {
  for (const r of relays.splice(0)) await r.close();
});

async function relayNode(lan: boolean): Promise<RunningRelay> {
  const dir = await scratch("relay-node");
  const r = await start({ db: join(dir, "relay.db"), port: 0, host: "127.0.0.1", lan, log: () => undefined, tickMs: 50 });
  relays.push(r);
  return r;
}

/** Two devices set up through the CLI against a real relay: create, invite, confirm, join, trust. */
async function twoDevices(url: string, tls?: string) {
  const unused = new RelayHarness();
  const a = term(await scratch("rn-a"), unused, { dialer: undefined });
  const b = term(await scratch("rn-b"), unused, { dialer: undefined });
  expect(await run(a, "init", "--name", "laptop")).toBe(0);
  expect(await run(a, "mesh", "create", "--relay", url, "--no-recovery", ...(tls === undefined ? [] : ["--tls", tls]))).toBe(0);
  a.answers.push(() => sasOf(b));
  const inviting = run(a, "invite");
  await until(() => a.out.some((l) => l.includes("wim1_")), 5000);
  const code = inviteCodeOf(a);
  expect(await run(b, "join", code, "--name", "server")).toBe(0);
  expect(await inviting).toBe(0);
  expect(await run(a, "devices", "trust", "server")).toBe(0);
  expect(await run(b, "devices", "trust", "laptop")).toBe(0);
  return { a, b };
}

describe("against relay-node", () => {
  it("creates, invites, joins, sends and watches over ws:// on loopback", async () => {
    const r = await relayNode(false);
    const { a, b } = await twoDevices(r.relayUrls[0]!);
    const watching = run(b, "watch", "--as", "reviewer");
    await until(() => b.out.some((l) => l.startsWith("Watching as reviewer@server")), 5000);
    expect(await run(a, "send", "reviewer@server", "please", "review")).toBe(0);
    await until(() => b.out.some((l) => l.includes("please review")), 5000);
    expect(await run(a, "doctor")).toBe(0);
    b.stop.abort();
    expect(await watching).toBe(0);
  }, 30_000);

  it("connects to a LAN relay only through its pinned certificate", async () => {
    const r = await relayNode(true);
    expect(r.relayUrls[0]).toMatch(/^wss:\/\/127\.0\.0\.1:\d+$/);
    const { a, b } = await twoDevices(r.relayUrls[0]!, r.pin!);
    const watching = run(b, "watch");
    await until(() => b.out.some((l) => l.startsWith("Watching as cli@server")), 5000);
    expect(await run(a, "send", "cli@server", "over pinned tls")).toBe(0);
    await until(() => b.out.some((l) => l.includes("over pinned tls")), 5000);
    b.stop.abort();
    await watching;
    // The doctor reads /v1/info through the same pin (the test's own fetch refuses every call).
    expect(await run(a, "doctor")).toBe(0);
    expect(a.out.filter((l) => l.includes("/v1/info"))).toEqual([]);
    expect(a.out).toContainEqual(expect.stringMatching(/^info {5}mesh \S+: the relay creates meshes /));
    // The wrong pin is refused, and so is no pin (no CA signed this certificate).
    const unused = new RelayHarness();
    const c = term(await scratch("rn-c"), unused, { dialer: undefined });
    await run(c, "init", "--name", "other");
    expect(await run(c, "mesh", "create", "--relay", r.relayUrls[0]!, "--tls", "A".repeat(43), "--no-recovery")).toBe(1);
    expect(said(c)).toMatch(/does not match the pin/);
    expect(await run(c, "mesh", "create", "--relay", r.relayUrls[0]!, "--no-recovery")).toBe(1);
    expect(said(c)).toMatch(/self-signed|certificate/);
  }, 30_000);
});
