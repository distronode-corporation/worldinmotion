// A session that lost a lease is told, and holds no stale token (SPEC section 14): an expiry the
// relay sends, one that passed while the session was away, a refused renew or release, the lease's
// own `until`; and a same-project takeover says which leases came with it.

import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { inheritedLeasesLine, leaseLostLine, type MeshSession } from "../src/client.ts";
import { parseSessionState } from "../src/session.ts";
import { makeMesh, openSession, RelayHarness, scratch, until, type TestDevice } from "./helpers.ts";

const open: MeshSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0).reverse()) await s.stop().catch(() => undefined);
});

async function live(d: TestDevice, mesh: string, relay: RelayHarness, extra: Parameters<typeof openSession>[3] = {}): Promise<MeshSession> {
  const s = await openSession(d, mesh, relay, extra);
  open.push(s);
  return s;
}

/** The notices in a session's spool that mention leases. */
async function leaseNotices(s: MeshSession): Promise<string[]> {
  return (await s.spool.unread()).filter((i) => i.kind === "notice" && i.rendered.includes("lease")).map((i) => i.rendered);
}

/** A relay whose clock runs `shift` ms ahead of real time. */
function shifted(): { relay: RelayHarness; ahead: (ms: number) => void } {
  const relay = new RelayHarness();
  let shift = 0;
  relay.now = () => Date.now() + shift;
  return { relay, ahead: (ms) => void (shift += ms) };
}

const MIN = 60_000;

describe("a holder that lost its lease", () => {
  it("drops its token and tells the agent when the relay says the lease expired", async () => {
    const { relay, ahead } = shifted();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const a = await live(devices[0]!, mesh, relay, { name: "a" });
    const got = await a.acquireLease("deploy", MIN, false);
    expect(a.state.leaseUntil).toEqual({ [Object.keys(a.state.leases)[0]!]: got.until });
    ahead(MIN + 1000);
    relay.tick();
    await until(async () => (await leaseNotices(a)).length === 1);
    expect(a.state.leases).toEqual({});
    expect(a.state.leaseUntil).toEqual({});
    expect((await leaseNotices(a))[0]).toContain(leaseLostLine('"deploy"', "expired"));
    expect(await a.holdsNothing()).toBe(true);
    // An expiry for a token this session no longer has is no news.
    relay.inject(mesh, JSON.stringify({ t: "lease", key: got.key, status: "expired", token: got.token }));
    await a.settled();
    expect(await leaseNotices(a)).toHaveLength(1);
  });

  it("logs an expiry notice it cannot write", async () => {
    const { relay, ahead } = shifted();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const logs: string[] = [];
    const a = await live(devices[0]!, mesh, relay, { name: "a", log: (l) => void logs.push(l) });
    await a.acquireLease("deploy", MIN, false);
    // A file where the spool directory should be: the notice cannot be written.
    await fs.rm(a.files.spoolDir, { recursive: true, force: true });
    await fs.writeFile(a.files.spoolDir, "");
    ahead(MIN + 1000);
    relay.tick();
    await until(() => logs.some((l) => l.startsWith("wim: lease: ")));
    expect(a.state.leases).toEqual({});
  });

  it("drops a token whose until passed, offline too, so the session holds nothing", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    let shift = 0;
    const a = await live(devices[0]!, mesh, relay, { name: "a", now: () => Date.now() + shift });
    await a.acquireLease("deploy", MIN, false);
    expect(await a.holdsNothing()).toBe(false);
    relay.down = true;
    relay.dropAll();
    shift = MIN + 1000;
    expect(await a.holdsNothing()).toBe(true);
    await until(async () => (await leaseNotices(a)).length === 1);
    expect(a.state.leases).toEqual({});
    expect((await leaseNotices(a))[0]).toContain(leaseLostLine('"deploy"', "expired"));
  });

  it("answers a re-acquire after the until with the new grant, not the expiry before it", async () => {
    const { relay, ahead } = shifted();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const a = await live(devices[0]!, mesh, relay, { name: "a" });
    const first = await a.acquireLease("deploy", MIN, false);
    ahead(MIN + 1000);
    const again = await a.acquireLease("deploy", MIN, false);
    expect(again).toMatchObject({ status: "granted", token: first.token! + 1 });
    await a.settled();
    expect(Object.values(a.state.leases)).toEqual([first.token! + 1]);
  });

  it("asking again while it holds the lease gets the lease and its token back", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const a = await live(devices[0]!, mesh, relay, { name: "a" });
    const first = await a.acquireLease("deploy", MIN, false);
    expect(await a.acquireLease("deploy", MIN, true)).toMatchObject({ status: "granted", token: first.token, until: first.until });
  });

  it("checks a refused renew: a lost lease is dropped, one refused for its ttl is kept", async () => {
    const { relay, ahead } = shifted();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const a = await live(devices[0]!, mesh, relay, { name: "a", answerMs: 300 });
    await a.acquireLease("deploy", MIN, false);
    // Refused for something else (here a token the relay does not know), the lease is still this session's.
    const garble = (t: string): string => (t.includes('"t":"lease.renew"') ? t.replace(/"token":\d+/, '"token":999') : t);
    relay.toRelay = garble;
    expect((await a.renewLease("deploy", MIN)).status).toBe("refused");
    expect(Object.keys(a.state.leases)).toHaveLength(1);
    // The check itself gets no answer: the token is kept.
    relay.toRelay = (t) => (t.includes('"t":"lease.list"') ? undefined : garble(t));
    expect((await a.renewLease("deploy", MIN)).status).toBe("refused");
    expect(Object.keys(a.state.leases)).toHaveLength(1);
    relay.toRelay = undefined;
    // Expired, the renew is refused (the expiry the relay sends first is not taken as the answer).
    ahead(MIN + 1000);
    expect((await a.renewLease("deploy", MIN)).status).toBe("refused");
    expect(a.state.leases).toEqual({});
    await until(async () => (await leaseNotices(a)).length === 1);
    // The renew was refused before the expiry frame was handled, or after: one notice either way.
    await a.settled();
    expect(await leaseNotices(a)).toHaveLength(1);
  });

  it("is told when the relay refuses a release, and the lease's until follows a renew", async () => {
    const { relay, ahead } = shifted();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const a = await live(devices[0]!, mesh, relay, { name: "a" });
    await a.acquireLease("deploy", MIN, false);
    const key = Object.keys(a.state.leases)[0]!;
    const renewed = await a.renewLease("deploy", 2 * MIN);
    expect(a.state.leaseUntil).toEqual({ [key]: renewed.until });
    // The relay's expiry frame is lost: the refused release is how the session learns.
    relay.toClient = (t) => (t.includes('"status":"expired"') ? undefined : t);
    ahead(2 * MIN + 1000);
    expect((await a.releaseLease("deploy")).status).toBe("refused");
    expect(a.state.leases).toEqual({});
    expect(await leaseNotices(a)).toEqual([expect.stringContaining(leaseLostLine('"deploy"', "release"))]);
  });

  it("keeps a grant whose frame carries no until, until the relay says otherwise", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const a = await live(devices[0]!, mesh, relay, { name: "a" });
    relay.toClient = (t) => (t.includes('"status":"granted"') ? t.replace(/,"until":\d+/, "") : t);
    expect((await a.acquireLease("deploy", MIN, false)).until).toBeUndefined();
    expect(a.state.leaseUntil).toEqual({});
    expect(await a.holdsNothing()).toBe(false);
  });
});

describe("a lease wait", () => {
  it("waits up to its own timeout, not the lease ttl", async () => {
    const { relay, ahead } = shifted();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = await live(devices[0]!, mesh, relay, { name: "a" });
    const b = await live(devices[1]!, mesh, relay, { name: "b" });
    await a.acquireLease("deploy", 10 * MIN, false);
    const sent: string[] = [];
    relay.toRelay = (t) => (sent.push(t), t);
    const waiting = b.acquireLease("deploy", 10 * MIN, true, 1000);
    await until(() => sent.some((t) => t.includes('"t":"lease.acquire"')));
    expect(JSON.parse(sent.find((t) => t.includes('"t":"lease.acquire"'))!)).toMatchObject({ wait: true, timeout: 1000, ttl: 10 * MIN });
    ahead(1500);
    relay.tick();
    expect(await waiting).toMatchObject({ status: "expired" });
    expect(b.state.leases).toEqual({});
  });

  it("asks again without the timeout when an older relay refuses it", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const logs: string[] = [];
    const b = await live(devices[1]!, mesh, relay, { name: "b", log: (l) => void logs.push(l) });
    // An older relay knows no `timeout`: the strict frame check refuses it as malformed.
    relay.toRelay = (t) => t.replace('"timeout":', '"unknown":');
    expect(await b.acquireLease("deploy", MIN, true, 1000)).toMatchObject({ status: "granted" });
    expect(logs).toContain("wim: the relay does not take a lease wait timeout; waiting up to the lease ttl instead");
  });
});

describe("a session that comes back", () => {
  it("drops a lease that expired while it was away, and is told", async () => {
    const { relay, ahead } = shifted();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const cwd = await scratch("proj");
    const old = await openSession(devices[0]!, mesh, relay, { name: "a", cwd });
    await old.acquireLease("deploy", MIN, false);
    await old.stop();
    // A session saved before expiry times were kept has only the token.
    const saved = JSON.parse(await fs.readFile(old.files.statePath, "utf8"));
    delete saved.leaseUntil;
    await fs.writeFile(old.files.statePath, JSON.stringify(saved));
    ahead(MIN + 1000);
    relay.tick();
    const back = await live(devices[0]!, mesh, relay, { name: "a", cwd });
    expect(back.sid).toBe(old.sid);
    await until(async () => (await leaseNotices(back)).length === 1);
    expect((await leaseNotices(back))[0]).toContain(leaseLostLine('"deploy"', "away"));
    expect(back.state.leases).toEqual({});
  });

  it("after a same-project takeover, says which leases came with it, and keeps the relay's tokens", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const cwd = await scratch("proj");
    const old = await openSession(devices[0]!, mesh, relay, { name: "a", cwd });
    const got = await old.acquireLease("deploy", MIN, false);
    const other = await old.acquireLease("other", MIN, false);
    await old.stop();
    // This device forgot one lease's token, and its names (another process, a lost write).
    const saved = JSON.parse(await fs.readFile(old.files.statePath, "utf8"));
    delete saved.leases[other.key];
    saved.leases[got.key] = 999;
    await fs.writeFile(old.files.statePath, JSON.stringify(saved));
    await fs.rm(old.mesh.leaseNamesPath);
    const back = await live(devices[0]!, mesh, relay, { name: "a", cwd });
    await until(async () => (await leaseNotices(back)).length === 1);
    expect((await leaseNotices(back))[0]).toContain(inheritedLeasesLine([JSON.stringify(got.key), JSON.stringify(other.key)]));
    expect(back.state.leases).toEqual({ [got.key]: got.token, [other.key]: other.token });
    expect(back.state.leaseUntil).toEqual({ [got.key]: got.until, [other.key]: other.until });
    // Told once: a reconnect does not repeat it.
    relay.dropAll();
    await until(() => back.link?.isOpen === true);
    await back.settled();
    expect(await leaseNotices(back)).toHaveLength(1);
  });

  it("says nothing after a same-project takeover that brought no lease", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const cwd = await scratch("proj");
    const old = await openSession(devices[0]!, mesh, relay, { name: "a", cwd });
    await old.stop();
    const sent: string[] = [];
    relay.toRelay = (t) => (sent.push(t), t);
    const back = await live(devices[0]!, mesh, relay, { name: "a", cwd });
    await until(() => sent.some((t) => t.includes('"t":"lease.list"')));
    await back.stop();
    expect(await leaseNotices(back)).toEqual([]);
  });

  it("logs a lease check that got no answer, and asks again at the next ready", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const cwd = await scratch("proj");
    const old = await openSession(devices[0]!, mesh, relay, { name: "a", cwd });
    await old.acquireLease("deploy", MIN, false);
    await old.stop();
    relay.toRelay = (t) => (t.includes('"t":"lease.list"') ? undefined : t);
    const logs: string[] = [];
    const back = await live(devices[0]!, mesh, relay, { name: "a", cwd, answerMs: 300, log: (l) => void logs.push(l) });
    await until(() => logs.some((l) => l.startsWith("wim: leases not checked:")));
    relay.toRelay = undefined;
    relay.dropAll();
    await until(async () => (await leaseNotices(back)).length === 1);
    expect((await leaseNotices(back))[0]).toContain(inheritedLeasesLine(['"deploy"']));
  });
});

describe("lease notices and state", () => {
  it("words each loss, and counts inherited leases", () => {
    expect(leaseLostLine('"x"', "expired")).toContain("no longer holds the lease \"x\": it expired");
    expect(leaseLostLine('"x"', "away")).toContain("while this session was offline");
    expect(leaseLostLine('"x"', "renew")).toContain("refused to renew");
    expect(leaseLostLine('"x"', "release")).toContain("refused the release");
    expect(inheritedLeasesLine(['"a"'])).toContain("with it 1 lease: \"a\".");
    expect(inheritedLeasesLine(['"a"', '"b"'])).toContain("with it 2 leases: \"a\", \"b\".");
  });

  it("parses leaseUntil only when it is an object", () => {
    const base = { v: 1, sid: "01J0000000000000000000000A", name: "a", kind: "mcp", resume: "x" };
    expect(parseSessionState({ ...base, leaseUntil: { k: 5 } })?.leaseUntil).toEqual({ k: 5 });
    expect(parseSessionState({ ...base, leaseUntil: null })).not.toHaveProperty("leaseUntil");
    expect(parseSessionState({ ...base, leaseUntil: 5 })).not.toHaveProperty("leaseUntil");
  });
});
