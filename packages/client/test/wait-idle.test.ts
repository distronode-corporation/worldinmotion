// `wim wait-idle` and `wim send --wait-idle` (design section 2.4, packet N3): a CLI session arms a
// finished notice for each address and waits. Exit 0 when every address (or one, with --any) has
// its notice, 1 on a refusal (this session's own address, the limit, an address the relay does
// not know), 2 on the timeout.

import { LIMITS } from "@worldinmotion/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { commandUsage, WAIT_IDLE_EXIT } from "../src/cli.ts";
import { MeshSession } from "../src/client.ts";
import { MeshFiles } from "../src/mesh.ts";
import type { SpoolItem } from "../src/spool.ts";
import { FS, LIVE_PID, makeMesh, openSession, RelayHarness, run, said, sessionOpts, term, until, type Term } from "./helpers.ts";

const open: MeshSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
});

/** A trusted mesh with sessions on device two, and a terminal on device one with a clock the test moves. */
async function mesh(names: string[] = ["worker"]) {
  const relay = new RelayHarness();
  const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
  const peers: MeshSession[] = [];
  for (const name of names) {
    const p = await openSession(devices[1]!, mesh, relay, { name });
    p.on("item", (i: SpoolItem) => void p.take(i.cursor));
    open.push(p);
    peers.push(p);
  }
  const clock = { offset: 0 };
  const t = term(devices[0]!.root, relay, { now: () => Date.now() + clock.offset });
  return { relay, mesh, devices, peers, t, clock };
}

const waiting = (t: Term): Promise<void> => until(() => t.out.some((l) => l.startsWith("Waiting up to ")), 10_000, "the wait to start");
/** Until the relay has been sent an arm for `of`. */
const armed = (relay: RelayHarness, of: string): Promise<void> => until(() => relay.sentByClients.includes(JSON.stringify({ t: "notify_idle", of })), 10_000, `the arm for ${of}`);
const idle = (of: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ t: "notice", kind: "idle", of, ...extra });

describe("wim wait-idle", () => {
  it("exits 0 once the watched session ends, saying why, and says what a notice does not prove", async () => {
    const { peers, t } = await mesh();
    const waited = run(t, "wait-idle", "worker@two");
    await waiting(t);
    expect(t.out).toContain("Waiting up to 12h for each of worker@two to finish (Ctrl-C stops waiting). A finished notice is the relay's word that a turn ended, not proof the work is done.");
    await peers[0]!.stop({ ended: true });
    expect(await waited).toBe(WAIT_IDLE_EXIT.finished);
    expect(t.out.at(-1)).toBe("worker@two: finished: it ended");
  });

  it("waits for every address, one line per notice, and --json prints only machine lines", async () => {
    const { relay, mesh: m, t } = await mesh(["a", "b"]);
    const waited = run(t, "wait-idle", "a@two,b@two", "--json");
    await armed(relay, "a@two");
    await armed(relay, "b@two");
    relay.inject(m, idle("a@two", { why: "idle" }));
    await until(() => t.out.length === 1, 10_000);
    // A reason this version does not know still ends the wait; only the reason is unknown.
    relay.inject(m, idle("b@two", { why: "rebooted" }));
    expect(await waited).toBe(0);
    expect(t.out.map((l) => JSON.parse(l) as unknown)).toEqual([
      { of: "a@two", end: "idle", why: "idle", quiet: false },
      { of: "b@two", end: "idle", quiet: false },
    ]);
  });

  it("--any ends at the first notice", async () => {
    const { relay, mesh: m, t } = await mesh(["a", "b"]);
    const waited = run(t, "wait-idle", "a@two,b@two", "--any");
    await waiting(t);
    expect(t.out.at(-1)).toMatch(/^Waiting up to 12h for any of a@two, b@two to finish/);
    relay.inject(m, idle("b@two", { why: "offline" }));
    expect(await waited).toBe(0);
    expect(t.out.at(-1)).toBe("b@two: finished: it has been offline for 60 seconds");
    expect(said(t)).not.toContain("a@two: finished");
  });

  it("says a quiet notice is quiet (a device not trusted), and still ends the wait", async () => {
    const { devices, mesh: m, peers, relay, t } = await mesh();
    await new MeshFiles(devices[0]!.home.meshDir(m), FS).updateConfig((c) => ({ ...c, policy: { ...c.policy, [devices[1]!.device.id]: "hold" } }));
    const waited = run(t, "wait-idle", "worker@two", "--json");
    await armed(relay, "worker@two");
    await peers[0]!.stop({ ended: true });
    expect(await waited).toBe(0);
    expect(JSON.parse(t.out.at(-1)!)).toEqual({ of: "worker@two", end: "idle", why: "ended", quiet: true });
  });

  it("prints the quiet line in words", async () => {
    const { devices, mesh: m, relay, t } = await mesh();
    await new MeshFiles(devices[0]!.home.meshDir(m), FS).updateConfig((c) => ({ ...c, policy: { ...c.policy, [devices[1]!.device.id]: "hold" } }));
    const waited = run(t, "wait-idle", "worker@two");
    await waiting(t);
    relay.inject(m, idle("worker@two"));
    expect(await waited).toBe(0);
    expect(t.out.at(-1)).toBe(
      "worker@two: finished: it is idle or has ended (a quiet notice: it would not start an agent turn, as that device is not trusted, is paused, or is past the loop breaker's limits)",
    );
  });

  it("exits 2 at the timeout, on the terminal's clock", async () => {
    const { t, clock } = await mesh();
    const waited = run(t, "wait-idle", "worker@two", "--timeout", "1h");
    await waiting(t);
    clock.offset += 3_600_000;
    expect(await waited).toBe(WAIT_IDLE_EXIT.timeout);
    expect(t.out.at(-1)).toBe("no finished notice within 1h for worker@two");
  });

  it("--json says the timeout too", async () => {
    const { relay, t, clock } = await mesh(["a", "b"]);
    const waited = run(t, "wait-idle", "a@two,b@two", "--json", "--timeout", "30m");
    // The deadline is set in the same pass as the arms are sent.
    await armed(relay, "b@two");
    clock.offset += 1_800_000;
    expect(await waited).toBe(2);
    expect(JSON.parse(t.out.at(-1)!)).toEqual({ end: "timeout", waiting: ["a@two", "b@two"] });
  });

  it("survives a dropped connection: the relay keeps the notice that fired meanwhile for the next ready", async () => {
    const { relay, mesh: m, peers, t } = await mesh();
    const waited = run(t, "wait-idle", "worker@two");
    await waiting(t);
    await armed(relay, "worker@two");
    const dials = relay.dials.length;
    // Only the waiting command's connection drops (the newest), and it cannot dial again yet.
    relay.down = true;
    const conns = relay.relays.get(m)!.conns;
    const [id, mine] = [...conns.entries()].at(-1)!;
    mine.socket.shut(1006, "dropped");
    expect(conns.has(id)).toBe(false);
    // The watched session ends while the waiting one is offline.
    await peers[0]!.stop({ ended: true });
    relay.down = false;
    expect(await waited).toBe(0);
    expect(relay.dials.length).toBeGreaterThan(dials);
    expect(t.out.at(-1)).toBe("worker@two: finished: it ended");
  }, 30_000);

  it("refuses its own address clearly, and arms nothing", async () => {
    const { relay, t } = await mesh();
    expect(await run(t, "wait-idle", "worker@two,cli@one")).toBe(WAIT_IDLE_EXIT.refused);
    expect(t.out.at(-1)).toBe("cli@one: not watched: this command runs as cli@one, and a session never watches itself. Run it as another session with --as <name>.");
    expect(relay.sentByClients.some((f) => f.startsWith('{"t":"notify_idle"'))).toBe(false);
    t.out.length = 0;
    expect(await run(t, "wait-idle", "cli@one", "--json")).toBe(1);
    expect(JSON.parse(t.out.at(-1)!)).toEqual({ of: "cli@one", end: "refused", code: "self" });
  });

  it("with --any, says its own address is not watched and waits for the others", async () => {
    const { peers, relay, t } = await mesh();
    const waited = run(t, "wait-idle", "worker@two,cli@one", "--any");
    await waiting(t);
    expect(t.out[0]).toBe("cli@one: not watched: this command runs as cli@one, and a session never watches itself. Run it as another session with --as <name>.");
    expect(relay.sentByClients).not.toContain(JSON.stringify({ t: "notify_idle", of: "cli@one" }));
    await armed(relay, "worker@two");
    await peers[0]!.stop({ ended: true });
    expect(await waited).toBe(0);
    expect(t.out.at(-1)).toBe("worker@two: finished: it ended");
    t.out.length = 0;
    // Nothing else to wait for.
    expect(await run(t, "wait-idle", "cli@one", "--any", "--json")).toBe(1);
    expect(t.out.map((l) => JSON.parse(l) as unknown)).toEqual([{ of: "cli@one", end: "refused", code: "self" }]);
  });

  it(`refuses past the ${LIMITS.notifyIdlePerSession}-watch limit`, async () => {
    const { relay, t } = await mesh();
    // The relay never sees the arms, so none is refused there and every watch stays open.
    relay.toRelay = (f) => (f.startsWith('{"t":"notify_idle"') ? undefined : f);
    const many = Array.from({ length: LIMITS.notifyIdlePerSession + 1 }, (_, n) => `s${n}@two`);
    expect(await run(t, "wait-idle", many.join(","), "--json")).toBe(1);
    const last = JSON.parse(t.out.at(-1)!) as { of: string; end: string; code: string; note: string };
    expect(last).toMatchObject({ of: `s${LIMITS.notifyIdlePerSession}@two`, end: "refused", code: "local" });
    expect(last.note).toMatch(/already watches 16 sessions, the most it may/);
    expect(t.out).toHaveLength(1);
    t.out.length = 0;
    expect(await run(t, "wait-idle", "late@two")).toBe(1);
    expect(t.out.at(-1)).toMatch(/^late@two: not watched: This session already watches 16 sessions/);
  });

  it(`with --any, waits for the watches armed below the ${LIMITS.notifyIdlePerSession}-watch limit`, async () => {
    const { relay, mesh: m, t } = await mesh();
    relay.toRelay = (f) => (f.startsWith('{"t":"notify_idle"') ? undefined : f);
    const many = Array.from({ length: LIMITS.notifyIdlePerSession + 1 }, (_, n) => `s${n}@two`);
    const waited = run(t, "wait-idle", many.join(","), "--any");
    await waiting(t);
    expect(t.out[0]).toMatch(new RegExp(`^s${LIMITS.notifyIdlePerSession}@two: not watched: This session already watches 16 sessions`));
    expect(t.out[1]).toMatch(/^Waiting up to 12h for any of s0@two, /);
    expect(t.out[1]).not.toContain(`s${LIMITS.notifyIdlePerSession}@two`);
    relay.inject(m, idle("s3@two"));
    expect(await waited).toBe(0);
    expect(t.out.at(-1)).toBe("s3@two: finished: it is idle or has ended");
  });

  it("exits 1 when the relay knows no such session; --any waits on for the others", async () => {
    const { peers, t } = await mesh();
    expect(await run(t, "wait-idle", "ghost@two")).toBe(1);
    expect(t.out.at(-1)).toBe("ghost@two: not watched: the relay knows no session by that address (it may have ended)");
    t.out.length = 0;
    const waited = run(t, "wait-idle", "ghost@two,worker@two", "--any", "--json");
    await until(() => t.out.length === 1, 10_000);
    expect(JSON.parse(t.out[0]!)).toEqual({ of: "ghost@two", end: "refused", code: "not_found" });
    await peers[0]!.stop({ ended: true });
    expect(await waited).toBe(0);
    t.out.length = 0;
    expect(await run(t, "wait-idle", "ghost@two,phantom@two", "--any")).toBe(1);
    expect(t.out.filter((l) => l.includes("not watched"))).toHaveLength(2);
  });

  it("with an older relay that does not say which arm it refused, --any ends once every arm could be the refused one", async () => {
    const { relay, t } = await mesh();
    relay.toClient = (text) => (text.includes('"ref":"notify_idle"') ? JSON.stringify({ ...(JSON.parse(text) as object), of: undefined }) : text);
    expect(await run(t, "wait-idle", "ghost@two,phantom@two", "--any")).toBe(1);
    expect(t.out.filter((l) => l === "one of ghost@two, phantom@two: not watched: the relay knows no session by that address (it may have ended) (the relay did not say which)")).toHaveLength(2);
    t.out.length = 0;
    // A session of its own, so no older arm is sent again; two arms in flight, so neither is named.
    expect(await run(t, "wait-idle", "ghost@two,phantom@two", "--json", "--as", "other")).toBe(1);
    expect(t.out.map((l) => JSON.parse(l) as unknown)).toEqual([{ end: "refused", code: "not_found" }]);
  });

  it("ignores the notice of an older wait the client armed again", async () => {
    const { relay, mesh: m, t } = await mesh(["a", "b"]);
    // Timed out: its watch stays open, and the next process of this session arms it again.
    expect(await run(t, "wait-idle", "a@two", "--timeout", "1ms")).toBe(2);
    t.out.length = 0;
    const waited = run(t, "wait-idle", "b@two");
    await waiting(t);
    // In order: a's notice is taken (its watch was open) and passed over, then b's ends the wait.
    relay.inject(m, idle("a@two"));
    relay.inject(m, idle("b@two"));
    expect(await waited).toBe(0);
    expect(t.out.at(-1)).toBe("b@two: finished: it is idle or has ended");
    expect(said(t)).not.toContain("a@two: finished");
  });

  it("passes over a notice the relay kept for an older wait on the same address", async () => {
    const { devices, mesh: m, peers, relay, t } = await mesh(["a"]);
    // Timed out with its arm at the relay: the watch stays open while the session is offline.
    expect(await run(t, "wait-idle", "a@two", "--timeout", "1ms")).toBe(2);
    await armed(relay, "a@two");
    // a ends while cli@one is offline, so the relay keeps that notice for cli@one's next ready.
    await peers[0]!.stop({ ended: true });
    const again = await openSession(devices[1]!, m, relay, { name: "a" });
    open.push(again);
    t.out.length = 0;
    const waited = run(t, "wait-idle", "a@two", "--json");
    await until(() => relay.sentByClients.filter((f) => f === JSON.stringify({ t: "notify_idle", of: "a@two" })).length >= 2, 10_000, "the second arm");
    // The kept notice came first and closed the older watch; this wait's own notice ends it.
    relay.inject(m, idle("a@two", { why: "idle" }));
    expect(await waited).toBe(0);
    expect(t.out.map((l) => JSON.parse(l) as unknown)).toEqual([{ of: "a@two", end: "idle", why: "idle", quiet: false }]);
  });

  it("arms all the same when the relay does not answer the first question", async () => {
    const { relay, mesh: m, t } = await mesh();
    relay.toRelay = (f) => (f === JSON.stringify({ t: "peers" }) ? undefined : f);
    const waited = run(t, "wait-idle", "worker@two");
    // The question goes unanswered for the session's answer time (10 seconds), then the arm goes.
    await until(() => relay.sentByClients.includes(JSON.stringify({ t: "notify_idle", of: "worker@two" })), 25_000, "the arm");
    relay.inject(m, idle("worker@two"));
    expect(await waited).toBe(0);
  }, 30_000);

  it("stops at Ctrl-C", async () => {
    const { t } = await mesh();
    const waited = run(t, "wait-idle", "worker@two");
    await waiting(t);
    t.stop.abort();
    expect(await waited).toBe(130);
  });

  it("refuses what it cannot watch and a timeout it cannot keep", async () => {
    const { t } = await mesh();
    const usage = commandUsage("wait-idle")!;
    expect(usage).toBe("wim wait-idle <address,...> [--any] [--timeout 12h] [--json] [--as <name> [--take]]");
    expect(await run(t, "wait-idle")).toBe(1);
    expect(t.err.at(-1)).toBe(`wim: usage: ${usage}`);
    expect(await run(t, "wait-idle", "a@two", "b@two")).toBe(1);
    expect(await run(t, "wait-idle", "#ops,*")).toBe(1);
    expect(t.err.at(-1)).toBe("wim: a session's finished notice is for name@device addresses only, not #ops, *");
    expect(await run(t, "wait-idle", "a@two", "--timeout", "13h")).toBe(1);
    expect(t.err.at(-1)).toBe("wim: --timeout takes a duration from 1ms to 12h (a watch lapses 12 hours after it is armed), such as 30m");
    expect(await run(t, "wait-idle", "a@two", "--timeout", "0")).toBe(1);
    expect(await run(t, "wait-idle", "a@two", "--wait")).toBe(2);
    expect(t.err.at(-1)).toMatch(/^wim: unknown flag --wait for wim wait-idle/);
  });
});

describe("wim send --wait-idle", () => {
  it("arms, sends, and waits for the session to finish", async () => {
    const { relay, peers, t } = await mesh();
    const sent = run(t, "send", "--wait-idle", "worker@two", "do", "the", "work");
    await waiting(t);
    expect(t.out).toContain("worker@two: routed (handed to a live session; not yet taken or read)");
    // The arm went before the message.
    const arm = relay.sentByClients.findIndex((f) => f === JSON.stringify({ t: "notify_idle", of: "worker@two" }));
    const message = relay.sentByClients.findIndex((f) => f.startsWith('{"t":"send"'));
    expect(arm).toBeGreaterThan(-1);
    expect(arm).toBeLessThan(message);
    expect(said(t)).not.toContain("Neither routed nor queued");
    await peers[0]!.stop({ ended: true });
    expect(await sent).toBe(0);
    expect(t.out.at(-1)).toBe("worker@two: finished: it ended");
  });

  it("times out with --timeout, and keeps the send's own failure when a recipient was not taken", async () => {
    const { t, clock } = await mesh();
    const sent = run(t, "send", "worker@two", "hi", "--wait-idle", "--timeout", "5m");
    await waiting(t);
    clock.offset += 300_000;
    expect(await sent).toBe(2);
    t.out.length = 0;
    // Nobody took it: nothing to wait for.
    expect(await run(t, "send", "ghost@two", "hi", "--wait-idle")).toBe(1);
    expect(said(t)).not.toContain("Waiting up to");
  });

  it("sends nothing to watch its own address, and refuses what it cannot wait for", async () => {
    const { relay, t } = await mesh();
    expect(await run(t, "send", "cli@one", "hi", "--wait-idle")).toBe(1);
    expect(t.out.at(-1)).toMatch(/^cli@one: not watched: this command runs as cli@one/);
    expect(relay.sentByClients.some((f) => f.startsWith('{"t":"send"'))).toBe(false);
    expect(await run(t, "send", "#ops", "hi", "--wait-idle")).toBe(1);
    expect(t.err.at(-1)).toBe("wim: a session's finished notice is for name@device addresses only, not #ops");
    expect(await run(t, "send", "worker@two", "hi", "--wait-idle", "--wait", "30s")).toBe(1);
    expect(t.err.at(-1)).toBe("wim: --wait waits for receipts and --wait-idle for the sessions to finish: use one");
    expect(await run(t, "send", "worker@two", "hi", "--timeout", "30s")).toBe(1);
    expect(t.err.at(-1)).toBe("wim: --timeout goes with --wait-idle");
    expect(t.out.length).toBeGreaterThan(0);
    expect(commandUsage("send")).toBe("wim send <to> <text...> [--allow-secret] [--as <name> [--take]] [--wait <30s> | --wait-idle [--timeout 12h]]");
  });

  it("needs a session of its own while a wim watch holds the name", async () => {
    const { relay, mesh: m, devices, t } = await mesh();
    // A watch in another process (a live pid that is not this one).
    const w = await MeshSession.open({ ...sessionOpts(devices[0]!, m, relay, { name: "cli", kind: "cli", handover: true, env: { ...FS, pid: LIVE_PID } }), sessionKey: "cli:cli" });
    open.push(w);
    w.start();
    await w.ready(3000);
    expect(await run(t, "send", "worker@two", "hi", "--wait-idle")).toBe(1);
    expect(t.err.at(-1)).toBe("wim: a `wim watch` is reading as cli on this device, and --wait-idle needs a session of its own to hear the notice: use --as <name>");
    expect(relay.sentByClients.some((f) => f.startsWith('{"t":"notify_idle"'))).toBe(false);
  });
});
