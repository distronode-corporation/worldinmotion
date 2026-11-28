// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { type SendFrame } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { MeshSession } from "../src/client.ts";
import { receiverKey } from "../src/replay.ts";
import { makeMesh, openSession, RelayHarness, until, type TestDevice } from "./helpers.ts";

// The replay stores (seen.json, seq.json) key a receiving session by its session id, never by the
// address the relay's unsigned `ready.name` gives it (SPEC section 6, dedupe): a relay that hands
// out another name, or a rename, must not give the session an empty store.

const open: MeshSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

async function session(d: TestDevice, mesh: string, relay: RelayHarness, name: string, sessionKey?: string): Promise<MeshSession> {
  const s = await openSession(d, mesh, relay, { name, ...(sessionKey === undefined ? {} : { sessionKey }) });
  open.push(s);
  return s;
}

function lastSend(relay: RelayHarness): SendFrame {
  return relay.sentByClients.map((t) => JSON.parse(t) as { t: string }).filter((f): f is SendFrame => f.t === "send").at(-1)!;
}

/** A broadcast from `a` that `b` accepted, and its frame: `*` reaches b under any name it is given. */
async function accepted(relay: RelayHarness, a: MeshSession, b: MeshSession): Promise<SendFrame> {
  await a.send("*", "once");
  const frame = lastSend(relay);
  await until(async () => (await b.spool.unread()).some((i) => i.id === frame.id));
  return frame;
}

/** Has the relay assign `name` at b's next ready, then drops every connection so b reconnects to it. */
async function reReady(relay: RelayHarness, b: MeshSession, name: string): Promise<void> {
  relay.toClient = (text) => (text.startsWith('{"t":"ready"') ? JSON.stringify({ ...(JSON.parse(text) as object), name }) : text);
  relay.dropAll();
  await until(() => b.address.startsWith(`${name}@`), 10_000, "the new name");
}

describe("replay stores keyed by the session, not the relay's name", () => {
  it("drops a broadcast delivered again after the relay gives the session another name", { timeout: 20_000 }, async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, "a");
    const b = await session(devices[1]!, mesh, relay, "b");
    const frame = await accepted(relay, a, b);
    expect(await b.receive(frame)).toBe("dropped");
    await reReady(relay, b, "fresh");
    expect(b.address).toBe("fresh@two");
    expect(await b.receive(frame)).toBe("dropped");
  });

  it("drops a broadcast delivered again after a rename", { timeout: 20_000 }, async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, "a");
    const b = await session(devices[1]!, mesh, relay, "b");
    const frame = await accepted(relay, a, b);
    expect(await b.rename("bee")).toBe("bee@two");
    expect(await b.receive(frame)).toBe("dropped");
  });

  it("carries an older client's address-keyed entries over to the session, so an upgrade reopens no window", { timeout: 20_000 }, async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await session(devices[0]!, mesh, relay, "a");
    const b = await session(devices[1]!, mesh, relay, "b", "key-b");
    const frame = await accepted(relay, a, b);
    const { sid } = b;
    const files = b.mesh;
    await b.stop();
    open.splice(open.indexOf(b), 1);
    // Rewrite both stores as an older client left them: keyed by the address b@two.
    const mine = receiverKey(sid);
    const seen = JSON.parse(await fs.readFile(files.seenPath, "utf8")) as { v: 1; seen: Record<string, number> };
    const legacy = Object.fromEntries(Object.entries(seen.seen).map(([k, t]) => [k.replace(` ${mine}`, " b@two"), t]));
    expect(Object.keys(legacy)).toContain(`${frame.id} b@two`);
    await fs.writeFile(files.seenPath, JSON.stringify({ v: 1, seen: legacy }));
    const seq = JSON.parse(await fs.readFile(files.seqPath, "utf8")) as { v: 1; byAddress: Record<string, unknown> };
    await fs.writeFile(files.seqPath, JSON.stringify({ v: 1, byAddress: { "b@two": seq.byAddress[mine] } }));
    // The same session comes back, and the relay names it something else. The relay's own copies
    // are held back, so the one below is the only delivery.
    relay.toClient = (text) => (text.startsWith('{"t":"ready"') ? JSON.stringify({ ...(JSON.parse(text) as object), name: "other" }) : text.startsWith('{"t":"deliver"') ? undefined : text);
    const back = await session(devices[1]!, mesh, relay, "b", "key-b");
    expect(back.sid).toBe(sid);
    expect(back.address).toBe("other@two");
    expect(await back.receive(frame)).toBe("dropped");
    const migrated = JSON.parse(await fs.readFile(files.seenPath, "utf8")) as { seen: Record<string, number> };
    expect(migrated.seen[`${frame.id} ${mine}`]).toBe(legacy[`${frame.id} b@two`]);
  });
});
