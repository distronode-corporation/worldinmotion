// Whose approval a join was, on the joining side (SPEC section 6a): every admin receives a join
// request, so the roster that adds a device may be signed by an admin that did not make its
// invite, another person's in a shared mesh. The joiner asks about the admitting device as its
// approver only when the invite code names it as the maker (`by`); otherwise it says so and asks
// about it like any other device. A code from before 0.2.0 names no maker.

import { admitJoin, b64u, canonBytes, fromUtf8, nextRosterWith, type JoinBody } from "@worldinmotion/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { decideJoin, issueInvite, promoteDevice, publishRoster } from "../src/admin.ts";
import type { MeshSession } from "../src/client.ts";
import { runSetupEvents } from "../src/events.ts";
import { Home } from "../src/home.ts";
import { joinApproval, MeshFiles } from "../src/mesh.ts";
import { PassThrough } from "node:stream";
import { FS, makeMesh, openSession, RelayHarness, run, said, scratch, term, type TestDevice } from "./helpers.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f().catch(() => undefined);
});

/** A mesh with two admins: ann, which makes the invite, and bob. */
async function twoAdmins(relay: RelayHarness): Promise<{ mesh: string; ann: TestDevice; bob: TestDevice }> {
  const { mesh, devices } = await makeMesh(relay, ["ann", "bob"], { trust: false });
  const s = await openSession(devices[0]!, mesh, relay, { name: "promote", kind: "cli" });
  await promoteDevice(s, "bob", Date.now);
  await s.stop({ ended: true });
  return { mesh, ann: devices[0]!, bob: devices[1]! };
}

/** An invite made by `d`, whose session then leaves: nobody on `d` is there to admit. */
async function inviteFrom(d: TestDevice, mesh: string, relay: RelayHarness): Promise<string> {
  const s = await openSession(d, mesh, relay, { name: "inviter", kind: "cli" });
  const inv = await issueInvite(s, { ttlMs: 600_000, auto: false, now: Date.now });
  await s.stop({ ended: true });
  return inv.code;
}

/** `d` adds whatever device asks to join first, invite or not, as a client that skips the checks could. */
async function racingAdmin(d: TestDevice, mesh: string, relay: RelayHarness): Promise<MeshSession> {
  const s = await openSession(d, mesh, relay, { name: "racer", kind: "cli" });
  s.once("join", (body: JoinBody) => void publishRoster(s, (cur) => nextRosterWith(cur, { add: [admitJoin(body.device, Date.now())] }, s.device.keyring, Date.now())));
  return s;
}

/** `d` admits the device as a person who confirmed its code would. */
async function confirmingAdmin(d: TestDevice, mesh: string, relay: RelayHarness): Promise<MeshSession> {
  const s = await openSession(d, mesh, relay, { name: "admitter", kind: "cli" });
  s.once("join", (body: JoinBody) => void decideJoin(s, body, async () => true, Date.now));
  return s;
}

/** The same invite as a client before 0.2.0 wrote it: no `by`. */
function withoutBy(code: string): string {
  const body = JSON.parse(fromUtf8(b64u.decode(code.slice("wim1_".length)))) as Record<string, unknown>;
  delete body["by"];
  return `wim1_${b64u.encode(canonBytes(body))}`;
}

const questions = (t: ReturnType<typeof term>): string[] => t.out.filter((l) => l.endsWith("[y/N] "));

describe("the joining side's approver", () => {
  it("is never an admin that did not make the invite: the joiner is warned and asks about it like any other", async () => {
    const relay = new RelayHarness();
    const { mesh, ann, bob } = await twoAdmins(relay);
    const code = await inviteFrom(ann, mesh, relay);
    const racer = await racingAdmin(bob, mesh, relay);
    cleanup.push(() => racer.stop({ ended: true }));
    const j = term(await scratch("raced"), relay);
    j.answers.push("n", "n");
    expect(await run(j, "join", code, "--name", "alice-new")).toBe(0);
    expect(said(j)).toContain(`Warning: bob admitted this device, but the invite was made by another device (id ${ann.device.id}). If you did not expect bob to admit it, it may be someone else's: it is asked about like any other device.`);
    expect(said(j)).not.toMatch(/admitted this device\. Is/);
    expect(questions(j)).toEqual(["The mesh also has ann. Is ann your own device? [y/N] ", "The mesh also has bob. Is bob your own device? [y/N] "]);
    const files = new MeshFiles(j.env["WIM_HOME"]! + "/meshes/" + mesh, FS);
    expect((await files.loadConfig()).policy).toEqual({});
  }, 30_000);

  it("is never the admitter of a code that names no maker (from before 0.2.0)", async () => {
    const relay = new RelayHarness();
    const { mesh, ann } = await twoAdmins(relay);
    const code = withoutBy(await inviteFrom(ann, mesh, relay));
    const admitter = await confirmingAdmin(ann, mesh, relay);
    cleanup.push(() => admitter.stop({ ended: true }));
    const j = term(await scratch("old-code"), relay);
    j.answers.push("y", "n");
    expect(await run(j, "join", code, "--name", "newer")).toBe(0);
    expect(said(j)).toContain("This invite code does not say which device made it (it is from wim 0.1.x), so ann, which admitted this device, is asked about like any other device.");
    expect(questions(j)).toEqual(["The mesh also has ann. Is ann your own device? [y/N] ", "The mesh also has bob. Is bob your own device? [y/N] "]);
    // Answered yes as any other device: ann is trusted, and only ann.
    expect(said(j)).toContain("Trusted ann. wim devices untrust ann undoes it.");
  }, 30_000);

  it("is the admitter only when the code names it", () => {
    const ann = { id: "ann-id", name: "ann" };
    const adders = new Map([["me", ann]]);
    expect(joinApproval(adders, "me", "ann-id")).toEqual({ admitter: ann, approver: ann });
    expect(joinApproval(adders, "me", "bob-id")).toEqual({ admitter: ann });
    expect(joinApproval(adders, "me", undefined)).toEqual({ admitter: ann });
    // No adder known (nothing to throw on): neither.
    expect(joinApproval(new Map(), "me", "ann-id")).toEqual({});
  });
});

/** `wim events` in setup mode on a fresh device, joining with `code`; resolves with its `joined` line. */
async function eventsJoin(relay: RelayHarness, code: string, name: string): Promise<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  const input = new PassThrough();
  const stop = new AbortController();
  const running = runSetupEvents({
    home: new Home(await scratch("events-join"), { ...FS, uid: process.getuid?.() }),
    defaultName: name,
    dialer: relay.dialer,
    version: "test",
    write: (l) => void lines.push(JSON.parse(l) as Record<string, unknown>),
    input,
    signal: stop.signal,
    now: Date.now,
    fetch: relay.fetch,
    platform: process.platform,
  });
  cleanup.push(async () => {
    stop.abort();
    await running;
  });
  input.write(`${JSON.stringify({ v: 1, id: "j", op: "join", args: { code } })}\n`);
  await running;
  return lines.find((l) => l["type"] === "joined")!;
}

describe("joined, in wim events", () => {
  it("names the approver only when it made the invite; otherwise admitted_other says who and why", async () => {
    const relay = new RelayHarness();
    const { mesh, ann, bob } = await twoAdmins(relay);
    const racer = await racingAdmin(bob, mesh, relay);
    cleanup.push(() => racer.stop({ ended: true }));
    const raced = await eventsJoin(relay, await inviteFrom(ann, mesh, relay), "fresh");
    expect(raced).not.toHaveProperty("admitted_by");
    expect(raced["admitted_other"]).toEqual({ name: "bob", id: bob.device.id, reason: "not_issuer" });
    const code = withoutBy(await inviteFrom(ann, mesh, relay));
    const admitter = await confirmingAdmin(ann, mesh, relay);
    cleanup.push(() => admitter.stop({ ended: true }));
    const old = await eventsJoin(relay, code, "fresher");
    expect(old).not.toHaveProperty("admitted_by");
    expect(old["admitted_other"]).toEqual({ name: "ann", id: ann.device.id, reason: "no_issuer" });
  }, 30_000);
});
