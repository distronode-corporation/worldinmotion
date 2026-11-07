// `wim events --json` in setup mode creating a mesh (docs/events.md): the `create` request is the
// person's, the recovery code waits for `wim recovery show` and never appears in a line, and
// `created` says whether it was collected before the process ends.

import { HOSTED_RELAY } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runSetupEvents } from "../src/events.ts";
import { Home } from "../src/home.ts";
import { fetchHeldCode, showPaths } from "../src/secretout.ts";
import type { Dialer } from "../src/wire.ts";
import { issueInvite } from "../src/admin.ts";
import { MeshSession } from "../src/client.ts";
import { FS, makeMesh, POSIX, RELAY, RelayHarness, run, said, scratch, sessionOpts, term, until } from "./helpers.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f().catch(() => undefined);
});

type Line = Record<string, unknown> & { type: string };

/** Records each dial and refuses it, as an unreachable relay would: no test reaches the real one. */
function unreachable(dialled: string[]): Dialer {
  return (url) => {
    dialled.push(url);
    return Promise.reject(new Error("connect ECONNREFUSED"));
  };
}

async function setup(o: { relay: RelayHarness; dialer?: Dialer; agent?: string; recoveryMs?: number; root?: string }) {
  const root = o.root ?? (await scratch("create"));
  const home = new Home(root, { ...FS, uid: process.getuid?.() });
  const lines: Line[] = [];
  const input = new PassThrough();
  const stop = new AbortController();
  let n = 0;
  let over = false;
  const running = runSetupEvents({
    home,
    defaultName: "fresh",
    dialer: o.dialer ?? o.relay.dialer,
    version: "test",
    write: (l) => void lines.push(JSON.parse(l) as Line),
    input,
    signal: stop.signal,
    now: Date.now,
    fetch: o.relay.fetch,
    platform: process.platform,
    ...(o.recoveryMs === undefined ? {} : { recoveryMs: o.recoveryMs }),
    ...(o.agent === undefined ? {} : { agent: o.agent }),
  }).finally(() => (over = true));
  cleanup.push(async () => {
    stop.abort();
    await running;
  });
  const request = async (op: string, args?: Record<string, unknown>): Promise<Line> => {
    const id = `r${++n}`;
    input.write(`${JSON.stringify({ v: 1, id, op, ...(args === undefined ? {} : { args }) })}\n`);
    await until(() => lines.some((l) => l.type === "response" && l["id"] === id), 10_000, `response ${id}`);
    return lines.find((l) => l.type === "response" && l["id"] === id)!;
  };
  const of = (type: string): Line[] => lines.filter((l) => l.type === type);
  return { home, root, lines, input, stop, running, request, of, ended: () => over };
}

const paths = (root: string) => showPaths(new Home(root, { ...FS, uid: process.getuid?.() }).root, process.platform);

describe("setup mode: create", () => {
  it("dials the hosted relay when the request names none", async () => {
    const dialled: string[] = [];
    const s = await setup({ relay: new RelayHarness(), dialer: unreachable(dialled) });
    expect(await s.request("create")).toMatchObject({ ok: false, error: { code: "error", message: "connect ECONNREFUSED" } });
    expect(dialled).toHaveLength(1);
    expect(dialled[0]!.startsWith(`${HOSTED_RELAY}/v1/`)).toBe(true);
  });

  it("creates a mesh, holds the code for wim recovery show, says created, then ends", async () => {
    const relay = new RelayHarness();
    const s = await setup({ relay });
    await until(() => s.of("setup").length > 0);
    const answer = await s.request("create", { relay: RELAY });
    expect(answer).toMatchObject({ ok: true, result: { device: { name: "fresh", id: expect.any(String) }, mesh: expect.stringMatching(/^.{4}…$/), relay: "127.0.0.1:4444" } });
    expect(await s.home.meshIds()).toHaveLength(1);
    // While the code waits, nothing else starts here.
    expect(await s.request("create")).toMatchObject({ ok: false, error: { code: "busy", message: "a mesh is already being created on this device" } });
    expect(await s.request("join", { code: "wim1_x" })).toMatchObject({ ok: false, error: { code: "busy", message: "a mesh is being created on this device" } });
    expect(s.ended()).toBe(false);
    // The person collects it, and only that reader ever sees it.
    const code = await fetchHeldCode(paths(s.root));
    expect(code).toMatch(/^wimrec1_/);
    await s.running;
    expect(s.of("created")).toEqual([expect.objectContaining({ v: 1, mesh: (answer["result"] as { mesh: string }).mesh, recovery: "shown" })]);
    expect(JSON.stringify(s.lines)).not.toContain(code);
  }, 20_000);

  it("is what `wim recovery show --wait` collects, for a named device on another relay", async () => {
    const relay = new RelayHarness();
    const s = await setup({ relay });
    expect(await s.request("create", { name: "desk", relay: RELAY })).toMatchObject({ ok: true, result: { device: { name: "desk" }, relay: "127.0.0.1:4444" } });
    const person = term(s.root, relay);
    person.answers.push(() => "");
    expect(await run(person, "recovery", "show", "--wait")).toBe(0);
    expect(said(person)).toMatch(/wimrec1_/);
    await s.running;
    expect(s.of("created")[0]).toMatchObject({ recovery: "shown" });
  }, 20_000);

  it("says not_collected when the window closes, and keeps the code held after stdin closes", async () => {
    const relay = new RelayHarness();
    const s = await setup({ relay, recoveryMs: 300 });
    expect(await s.request("create", { relay: RELAY })).toMatchObject({ ok: true });
    s.input.end();
    await s.running;
    expect(s.of("created")[0]).toMatchObject({ recovery: "not_collected" });
    await expect(fetchHeldCode(paths(s.root))).rejects.toThrow(/no recovery code is waiting/);
  }, 20_000);

  it("says not_collected when the process is stopped while the code waits", async () => {
    const relay = new RelayHarness();
    const s = await setup({ relay });
    expect(await s.request("create", { relay: RELAY })).toMatchObject({ ok: true });
    s.stop.abort();
    await s.running;
    expect(s.of("created")[0]).toMatchObject({ recovery: "not_collected" });
  }, 20_000);

  it("is refused under an agent's variables, before anything is made", async () => {
    const relay = new RelayHarness();
    const s = await setup({ relay, agent: "CLAUDECODE" });
    expect(await s.request("create", { relay: RELAY })).toMatchObject({ ok: false, error: { code: "refused", message: expect.stringMatching(/^creating a mesh is the person's/) } });
    expect(await s.home.loadDevice()).toBeUndefined();
    s.input.end();
    await s.running;
    expect(s.of("created")).toHaveLength(0);
  });

  it("refuses a wrong relay URL or device name with no device made, and tries again after a failed dial", async () => {
    const relay = new RelayHarness();
    const s = await setup({ relay });
    expect(await s.request("create", { relay: "http://relay.example" })).toMatchObject({ ok: false, error: { code: "input", message: expect.stringMatching(/refusing relay URL/) } });
    expect(await s.request("create", { relay: RELAY, name: "Not A Name" })).toMatchObject({ ok: false, error: { code: "input", message: expect.stringMatching(/invalid device name/) } });
    expect(await s.request("create", { relay: 7 })).toMatchObject({ ok: false, error: { code: "input" } });
    expect(await s.request("snapshot")).toMatchObject({ ok: false, error: { code: "setup", message: "this device is in no mesh yet: create or join one first" } });
    expect(await s.home.loadDevice()).toBeUndefined();
    // The relay cannot be reached: the device is made, no mesh, and the next try works.
    relay.down = true;
    expect(await s.request("create", { relay: RELAY })).toMatchObject({ ok: false, error: { code: "error" } });
    expect((await s.home.loadDevice())?.name).toBe("fresh");
    expect(await s.home.meshIds()).toHaveLength(0);
    relay.down = false;
    expect(await s.request("create", { relay: RELAY, name: "ignored" })).toMatchObject({ ok: true, result: { device: { name: "fresh" } } });
  }, 20_000);

  it("is busy while a join waits for an admin", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["admin"]);
    const admin = await MeshSession.open({ ...sessionOpts(devices[0]!, mesh, relay, { name: "a" }) });
    admin.start();
    await admin.ready(3000);
    cleanup.push(() => admin.stop({ ended: true }));
    const inv = await issueInvite(admin, { ttlMs: 600_000, auto: false, now: Date.now });
    const s = await setup({ relay });
    expect(await s.request("join", { code: inv.code })).toMatchObject({ ok: true });
    expect(await s.request("create", { relay: RELAY })).toMatchObject({ ok: false, error: { code: "busy", message: "a join is already waiting for an admin" } });
  }, 20_000);

  it("says a relay's refusal in the client's own words", async () => {
    const keyed = new RelayHarness({ createKey: "k" });
    const s = await setup({ relay: keyed });
    expect(await s.request("create", { relay: RELAY })).toMatchObject({ ok: false, error: { code: "unauthorized", message: expect.stringMatching(/needs an operator key, which only wim mesh create --key-env NAME/) } });
    const full = new RelayHarness();
    full.toClient = (text) => (text.startsWith('{"t":"roster"') ? JSON.stringify({ t: "error", code: "full", message: "\u001b]0;relay text\u0007", ref: "create" }) : text);
    const f = await setup({ relay: full });
    const refused = await f.request("create", { relay: RELAY });
    expect(refused).toMatchObject({ ok: false, error: { code: "full", message: expect.stringMatching(/reached its limit of new meshes/) } });
    expect(JSON.stringify(refused)).not.toContain("relay text");
  }, 20_000);

  it.skipIf(!POSIX)("ends after saying so when the code cannot be held", async () => {
    const relay = new RelayHarness();
    const root = await scratch("create-nohold");
    // Something that is not a socket sits where the code would wait.
    await fs.mkdir(join(root, "recovery.sock"), { recursive: true });
    const s = await setup({ relay, root });
    expect(await s.request("create", { relay: RELAY })).toMatchObject({ ok: false, error: { code: "error", message: expect.stringMatching(/the mesh was created, but its recovery code could not be held .* wim recovery rotate/) } });
    await s.running;
    expect(s.of("created")).toHaveLength(0);
    expect(await s.home.meshIds()).toHaveLength(1);
  }, 20_000);
});
