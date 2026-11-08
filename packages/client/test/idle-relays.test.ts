// Idle notices across versions (SPEC section 8): a client of today, and one as 0.1.x reads the
// wire, each against a relay of today and one that behaves as 0.1.10 did. The 0.2.0 relay adds
// `idle.armed`, `why`, `of` on refusals and `presence` on peer rows, fires for a session gone
// offline, and holds a notice for a subscriber that is offline; no client may depend on any of it.
//
// The 0.1.x client: of the relay's new frames and keys, the only one 0.1.10's schemas refuse is
// `idle.armed` (packages/protocol/test/v010-compat.test.ts, against a copy of them), and a 0.1.x
// client ignores a frame it cannot parse. So on the wire it is today's client with `idle.armed`
// dropped before it, which is what `asOldClient` does. Its notice handling is today's too.
//
// The 0.1.10 relay: today's relay with the three 0.2.0 idle steps put back to 0.1.10's code (no
// offline sweep, nothing held, a fired row deleted whether or not it was sent), and every frame
// it sends stripped of the new frame and keys, which is what `asOldRelay` does.

import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS } from "@worldinmotion/protocol";
import { MeshSession } from "../src/client.ts";
import { makeMesh, openSession, RelayHarness, sleep, until } from "./helpers.ts";

const open: MeshSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

async function session(...args: Parameters<typeof openSession>): Promise<MeshSession> {
  const s = await openSession(...args);
  open.push(s);
  return s;
}

type Filter = (text: string, conn: string) => string | undefined;
type Row = { sub: string; target: string; exp: number };
/** The parts of MeshRelay that 0.1.10's idle notice code used, reached past `private`. */
type Internals = {
  store: { idleFor(target: string): Row[]; deleteIdle(sub: string, target: string): void; getSession(sid: string): unknown };
  connFor(s: unknown): unknown;
  emit(c: unknown, frame: Record<string, unknown>): void;
  address(s: unknown): string;
  fireIdle(target: { sid: string }, why: string, now: number): void;
  fireOffline(): void;
  sendHeld(): void;
};

/** Frames to the client pass `outer` and then `inner`, either of which may drop them. */
function chain(relay: RelayHarness, filter: Filter): void {
  const inner = relay.toClient;
  relay.toClient = (text, conn) => {
    const t = filter(text, conn);
    return t === undefined || inner === undefined ? t : inner(t, conn);
  };
}

/** Puts the mesh's relay back to 0.1.10's idle notices, and strips what 0.2.0 added from its frames. */
function asOldRelay(relay: RelayHarness, mesh: string): void {
  const r = relay.relay(mesh) as unknown as Internals;
  r.fireOffline = () => undefined;
  r.sendHeld = () => undefined;
  // 0.1.10's fireIdle, as it was.
  r.fireIdle = function (this: Internals, target, _why, now) {
    for (const sub of this.store.idleFor(target.sid)) {
      this.store.deleteIdle(sub.sub, sub.target);
      const c = sub.exp > now ? this.connFor(this.store.getSession(sub.sub)) : undefined;
      if (c) this.emit(c, { t: "notice", kind: "idle", of: this.address(target) });
    }
  };
  chain(relay, (text) => {
    const f = JSON.parse(text) as Record<string, any>;
    if (f["t"] === "idle.armed") return undefined;
    if (f["t"] === "notice") delete f["why"];
    if (f["t"] === "error") delete f["of"];
    for (const p of [f["peer"], ...((f["peers"] as unknown[]) ?? [])]) if (p !== undefined) delete (p as Record<string, unknown>)["presence"];
    return JSON.stringify(f);
  });
}

/** Makes the connections of session `name` read the wire as a 0.1.x client does: `idle.armed` never reaches it. */
function asOldClient(relay: RelayHarness, name: string): void {
  const conns = new Set<string>();
  const toRelay = relay.toRelay;
  relay.toRelay = (text, conn) => {
    const f = JSON.parse(text) as { t: string; session?: { name: string } };
    if (f.t === "auth" && f.session?.name === name) conns.add(conn);
    return toRelay === undefined ? text : toRelay(text, conn);
  };
  chain(relay, (text, conn) => (conns.has(conn) && (JSON.parse(text) as { t: string }).t === "idle.armed" ? undefined : text));
}

/** Every frame the relay sent to the connections of session `name`, after the filters. */
function seenBy(relay: RelayHarness, name: string): Record<string, any>[] {
  const conns = new Set<string>();
  const seen: Record<string, any>[] = [];
  const toRelay = relay.toRelay;
  relay.toRelay = (text, conn) => {
    const f = JSON.parse(text) as { t: string; session?: { name: string } };
    if (f.t === "auth" && f.session?.name === name) conns.add(conn);
    return toRelay === undefined ? text : toRelay(text, conn);
  };
  const inner = relay.toClient;
  relay.toClient = (text, conn) => {
    const t = inner === undefined ? text : inner(text, conn);
    if (t !== undefined && conns.has(conn)) seen.push(JSON.parse(t) as Record<string, any>);
    return t;
  };
  return seen;
}

const notices = async (s: MeshSession, of: string) =>
  (await s.spool.unread()).filter((i) => i.kind === "notice" && i.rendered.includes(`${of} is now idle`)).length;

const COMBOS = [
  { client: "today's", relay: "today's", oldClient: false, oldRelay: false },
  { client: "a 0.1.x", relay: "today's", oldClient: true, oldRelay: false },
  { client: "today's", relay: "a 0.1.10", oldClient: false, oldRelay: true },
  { client: "a 0.1.x", relay: "a 0.1.10", oldClient: true, oldRelay: true },
] as const;

describe.each(COMBOS)("idle notices: $client client against $relay relay", ({ oldClient, oldRelay }) => {
  async function setup() {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    if (oldRelay) asOldRelay(relay, mesh);
    if (oldClient) asOldClient(relay, "a");
    const seen = seenBy(relay, "a");
    const a = await session(devices[0]!, mesh, relay, { name: "a", sessionKey: "agent-a" });
    const b = await session(devices[1]!, mesh, relay, { name: "b" });
    return { relay, mesh, devices, seen, a, b };
  }

  it("arms, takes the notice when the watched session's turn ends, and is told of a refusal only by a relay that sends one", async () => {
    const { seen, a, b } = await setup();
    expect(await a.notifyWhenIdle(["b@two"])).toBeUndefined();
    await until(() => seen.some((f) => f["t"] === "idle.armed") || oldClient || oldRelay);
    await fs.writeFile(b.files.presencePath, "busy");
    await until(() => a.peers.get("b@two")?.status === "busy");
    await fs.writeFile(b.files.presencePath, "idle");
    await until(async () => (await notices(a, "b@two")) === 1);
    expect(await a.notifyWhenIdle(["x@two"])).toBeUndefined();
    await until(() => seen.some((f) => f["t"] === "error" && f["ref"] === "notify_idle"));
    // The session still works after every new frame: a message goes through both ways.
    expect((await a.send("b@two", "still here")).results[0]!.status).toBe("routed");
    const notice = seen.find((f) => f["t"] === "notice")!;
    const refusal = seen.find((f) => f["t"] === "error" && f["ref"] === "notify_idle")!;
    const row = [...seen].reverse().find((f) => f["t"] === "peer" && f["peer"]["address"] === "b@two")!["peer"];
    if (oldRelay) {
      expect(notice).toEqual({ t: "notice", kind: "idle", of: "b@two" });
      expect(refusal).not.toHaveProperty("of");
      expect(row).not.toHaveProperty("presence");
    } else {
      expect(notice).toEqual({ t: "notice", kind: "idle", of: "b@two", why: "idle" });
      expect(refusal).toMatchObject({ code: "not_found", of: "x@two" });
      expect(row).toMatchObject({ status: "idle", presence: true });
    }
    expect(seen.some((f) => f["t"] === "idle.armed")).toBe(!oldClient && !oldRelay);
  });

  it("hears of a watched session that went away for good only from a relay that fires for it", async () => {
    const { relay, a, b } = await setup();
    await a.notifyWhenIdle(["b@two"]);
    await sleep(50);
    await b.stop();
    await until(() => a.peers.get("b@two")?.status === "offline");
    const start = Date.now();
    relay.now = () => start + LIMITS.idleOfflineGraceMs;
    relay.tick();
    if (oldRelay) {
      await sleep(100);
      expect(await notices(a, "b@two")).toBe(0);
    } else await until(async () => (await notices(a, "b@two")) === 1);
    relay.now = Date.now;
  });

  it("gets a notice that fired while it was offline at its next connection, only from a relay that holds it", async () => {
    const { devices, mesh, relay, a, b } = await setup();
    await a.notifyWhenIdle(["b@two"]);
    await sleep(50);
    await a.stop();
    await until(() => b.peers.get("a@one")?.status === "offline");
    await fs.writeFile(b.files.presencePath, "busy");
    await sleep(50);
    await fs.writeFile(b.files.presencePath, "idle");
    await sleep(100);
    // A later process of the same agent session: the same sid, resume secret and watches.
    const again = await session(devices[0]!, mesh, relay, { name: "a", sessionKey: "agent-a" });
    expect(again.address).toBe("a@one");
    if (oldRelay) {
      await sleep(100);
      expect(await notices(again, "b@two")).toBe(0);
    } else await until(async () => (await notices(again, "b@two")) === 1);
  });
});
