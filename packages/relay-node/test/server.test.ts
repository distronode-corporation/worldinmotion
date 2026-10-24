import { join } from "node:path";
import { request } from "node:http";
import {
  b64u,
  createGenesisRoster,
  deviceIdFromSignPub,
  generateDeviceKeys,
  makeDeviceRecord,
  nextRoster,
  randomBytes,
  rosterRef,
  sealMessage,
  signAuth,
  ulid,
  type DeviceKeys,
  type Roster,
} from "@worldinmotion/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RELAY_VERSION } from "@worldinmotion/relay-core";
import { runUntilSignal, start, type RunningRelay } from "../src/index.ts";
import { Dial, scratchDir } from "./helpers.ts";

const running: RunningRelay[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.close();
});

async function relay(config: Partial<Parameters<typeof start>[0]> = {}): Promise<RunningRelay & { lines: string[] }> {
  const lines: string[] = [];
  const r = await start({ db: join(await scratchDir(), "relay.db"), port: 0, log: (l) => void lines.push(l), ...config });
  running.push(r);
  return Object.assign(r, { lines });
}

type Device = { name: string; keys: DeviceKeys; id: string };
const device = (name: string): Device => {
  const keys = generateDeviceKeys();
  return { name, keys, id: deviceIdFromSignPub(keys.signPub) };
};

/** Opens a session over a real socket: hello, auth, ready. */
async function session(url: string, d: Device, r: Roster, name: string, opts: { sid?: string; resume?: string; cursor?: number } = {}) {
  const c = new Dial(`${url}/v1/${r.mesh}`);
  const hello = await c.next();
  const sid = opts.sid ?? ulid();
  const resume = opts.resume ?? b64u.encode(randomBytes(32));
  c.send(
    signAuth(
      {
        relay: url,
        mesh: r.mesh,
        nonce: hello["nonce"],
        at: Date.now(),
        session: { name, kind: "cli", sid, resume },
        resume: opts.cursor === undefined ? undefined : { cursor: opts.cursor },
        pin: rosterRef(r),
      },
      d.keys,
    ),
  );
  const ready = await c.nextOf("ready");
  return { c, sid, resume, ready, name };
}

/** A mesh of an admin device and one member, created and published over the wire. */
async function mesh(url: string) {
  const admin = device("admin");
  const member = device("laptop");
  const genesis = createGenesisRoster({ name: "admin", keys: admin.keys, now: Date.now() });
  const creator = new Dial(`${url}/v1/${genesis.mesh}`);
  await creator.next();
  creator.send({ t: "create", roster: genesis });
  expect((await creator.next())["t"]).toBe("roster");
  creator.ws.close();
  const r2 = nextRoster(genesis, { add: [makeDeviceRecord("laptop", member.keys, "member", Date.now())] }, admin, Date.now());
  const root = await session(url, admin, genesis, "root");
  root.c.send({ t: "roster.publish", roster: r2 });
  expect((await root.c.nextOf("roster"))["chain"][0]).toEqual(r2);
  return { admin, member, roster: r2, root };
}

const seal = (r: Roster, d: Device, s: { sid: string; name: string }, to: string[], seq: number, recipient: string) =>
  sealMessage({ roster: r, sender: { deviceId: d.id, keys: d.keys }, session: s.name, sid: s.sid, to, seq, at: Date.now(), text: "hi", recipients: [recipient] });

describe("relay-node", () => {
  it("creates a mesh and lets two devices exchange messages", async () => {
    const r = await relay();
    const url = r.relayUrls[0]!;
    expect(url).toBe(`ws://127.0.0.1:${r.port}`);
    const { admin, member, roster, root } = await mesh(url);
    const writer = await session(url, member, roster, "writer");
    root.c.send(seal(roster, admin, root, ["writer@laptop"], 1, member.id));
    expect((await root.c.nextOf("sent"))["results"]).toEqual([{ to: "writer@laptop", status: "routed" }]);
    const d = await writer.c.nextOf("deliver");
    expect(d["cursor"]).toBe(1);
    writer.c.send({ t: "ack", cursor: 1 });
    writer.c.send(seal(roster, member, writer, ["root@admin"], 1, admin.id));
    expect((await root.c.nextOf("deliver"))["msg"]["from"]["session"]).toBe("writer");
    expect(r.lines[0]).toBe(`wim-relay listening on ${url}`);
  });

  it("keeps state across a restart on the same database and resumes the queue", async () => {
    const dir = await scratchDir();
    const db = join(dir, "relay.db");
    const first = await start({ db, port: 0, log: () => {} });
    const url = first.relayUrls[0]!;
    const { admin, member, roster, root } = await mesh(url);
    const writer = await session(url, member, roster, "writer");
    writer.c.ws.close();
    await writer.c.closed;
    root.c.send(seal(roster, admin, root, ["writer@laptop"], 1, member.id));
    expect((await root.c.nextOf("sent"))["results"][0]["status"]).toBe("queued");
    await first.close();

    const second = await start({ db, port: first.port, log: () => {} });
    running.push(second);
    const back = await session(url, member, roster, "writer", { resume: writer.resume });
    expect(back.ready["name"]).toBe("writer");
    expect((await back.c.nextOf("deliver"))["cursor"]).toBe(1);
  });

  const get = (port: number, path: string, method = "GET") =>
    new Promise<{ status: number; body: unknown }>((resolve) =>
      request({ host: "127.0.0.1", port, path, method }, (res) => {
        let text = "";
        res.on("data", (d: Buffer) => void (text += d.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) as unknown }));
      }).end(),
    );

  /** The status line and JSON body a refused upgrade gets. */
  const refusedUpgrade = (port: number, path: string) =>
    new Promise<{ status: number; body: unknown }>((resolve) => {
      const req = request({ host: "127.0.0.1", port, path, headers: { connection: "upgrade", upgrade: "websocket" } });
      req.on("response", (res) => {
        let text = "";
        res.on("data", (d: Buffer) => void (text += d.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) as unknown }));
      });
      req.end();
    });

  it("answers healthz, 404 for other paths, and refuses upgrades to anything but a mesh", async () => {
    const r = await relay();
    expect(await get(r.port, "/healthz")).toEqual({ status: 200, body: { ok: true } });
    expect(await get(r.port, "/nope")).toEqual({ status: 404, body: { error: "not found" } });
    expect((await get(r.port, "/healthz", "POST")).status).toBe(404);
    // As the Cloudflare relay answers: 404 for a path that is not a dial path, 400 for a bad mesh id.
    expect(await refusedUpgrade(r.port, "/nope")).toEqual({ status: 404, body: { error: "not found" } });
    expect(await refusedUpgrade(r.port, "/v1/not-a-mesh-id")).toEqual({ status: 400, body: { error: "invalid mesh id" } });
    await expect(new Dial(`${r.relayUrls[0]}/v1/not-a-mesh-id`).opened()).rejects.toThrow(/400/);
  });

  it("reports a configuration problem in healthz with 503, logs it, and refuses creation", async () => {
    const r = await relay({ createRefused: "this relay cannot create meshes", problem: "WIM_CREATE_KEY is set but empty" });
    expect(await get(r.port, "/healthz")).toEqual({ status: 503, body: { ok: false, error: "WIM_CREATE_KEY is set but empty" } });
    expect(r.lines).toContain("configuration problem: WIM_CREATE_KEY is set but empty; creating meshes is refused until it is fixed");
    expect(await createFrom(r.relayUrls[0]!, "x")).toBe("unauthorized");
  });

  it("logs how it answers create", async () => {
    expect((await relay()).lines).toContain("creating meshes is open to anyone");
    expect((await relay({ createKey: "k" })).lines).toContain("creating a mesh needs the operator key (WIM_CREATE_KEY)");
    const closed = await relay({ createRefused: "this relay does not accept new meshes" });
    expect(closed.lines).toContain("creating meshes is closed: set WIM_CREATE_KEY, or WIM_OPEN_CREATE=1 to let anyone create one");
    expect(await get(closed.port, "/healthz")).toEqual({ status: 200, body: { ok: true } });
    expect(await createFrom(closed.relayUrls[0]!, "x")).toBe("unauthorized");
  });

  it("keeps nothing in memory for a mesh id that was only dialled, and keeps a mesh that exists", async () => {
    const r = await relay();
    const url = r.relayUrls[0]!;
    const dialled = b64u.encode(randomBytes(16));
    const a = new Dial(`${url}/v1/${dialled}`);
    const b = new Dial(`${url}/v1/${dialled}`);
    await a.next();
    await b.next();
    expect(r.loadedMeshes()).toBe(1);
    a.ws.close();
    await a.closed;
    // One socket is still open on it, so it stays.
    expect(r.loadedMeshes()).toBe(1);
    b.ws.close();
    await vi.waitFor(() => expect(r.loadedMeshes()).toBe(0));

    const { root } = await mesh(url);
    root.c.ws.close();
    await root.c.closed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.loadedMeshes()).toBe(1);
  });

  it("closes a socket that sends binary frames", async () => {
    const r = await relay();
    const c = new Dial(`${r.relayUrls[0]}/v1/${b64u.encode(new Uint8Array(16))}`);
    await c.next();
    c.ws.send(Buffer.from([1, 2, 3]));
    expect(await c.closed).toEqual({ code: 1003, reason: "text frames only" });
  });

  it("drops a socket that stops answering pings", async () => {
    const r = await relay({ heartbeatMs: 50 });
    const c = new Dial(`${r.relayUrls[0]}/v1/${b64u.encode(new Uint8Array(16))}`, { autoPong: false });
    await c.next();
    expect((await c.closed).code).toBe(1006);
  });

  it("keeps a socket that answers pings", async () => {
    const r = await relay({ heartbeatMs: 20 });
    const c = new Dial(`${r.relayUrls[0]}/v1/${b64u.encode(new Uint8Array(16))}`);
    await c.next();
    let pings = 0;
    c.ws.on("ping", () => void pings++);
    await vi.waitFor(() => expect(pings).toBeGreaterThanOrEqual(3));
    expect(c.ws.readyState).toBe(c.ws.OPEN);
  });

  it("runs expiry sweeps on a timer", async () => {
    const r = await relay({ tickMs: 20, limits: { authDeadlineMs: 30 } });
    const c = new Dial(`${r.relayUrls[0]}/v1/${b64u.encode(new Uint8Array(16))}`);
    await c.next();
    expect(await c.closed).toEqual({ code: 4001, reason: "auth timeout" });
  });

  const createFrom = async (url: string, xff: string) => {
    const g = createGenesisRoster({ name: "admin", keys: generateDeviceKeys(), now: Date.now() });
    const c = new Dial(`${url}/v1/${g.mesh}`, { headers: { "x-forwarded-for": xff } });
    await c.next();
    c.send({ t: "create", roster: g });
    const f = await c.next();
    c.ws.close();
    return f["t"] === "roster" ? "ok" : (f["code"] as string);
  };

  it("ignores X-Forwarded-For by default, so the socket address is the rate-limit source", async () => {
    const r = await relay();
    const results: string[] = [];
    for (let i = 0; i < 11; i++) results.push(await createFrom(r.relayUrls[0]!, `10.0.0.${i}`));
    // Each create named a different mesh: the budget is shared across meshes.
    expect(results.at(-1)).toBe("limited");
  });

  it("refills the shared budget over time and forgets idle addresses", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const r = await relay({ tickMs: 10, limits: { createJoinPerSourcePerHour: 1 } });
      expect(await createFrom(r.relayUrls[0]!, "x")).toBe("ok");
      expect(await createFrom(r.relayUrls[0]!, "x")).toBe("limited");
      vi.setSystemTime(Date.now() + 3_600_000);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await createFrom(r.relayUrls[0]!, "x")).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the last X-Forwarded-For entry when trustProxy is on", async () => {
    const r = await relay({ trustProxy: true });
    const results: string[] = [];
    for (let i = 0; i < 11; i++) results.push(await createFrom(r.relayUrls[0]!, `1.2.3.4, 10.0.0.${i}`));
    expect(results).toEqual(Array(11).fill("ok"));
    // Without the header it falls back to the socket address.
    const g = createGenesisRoster({ name: "admin", keys: generateDeviceKeys(), now: Date.now() });
    const c = new Dial(`${r.relayUrls[0]}/v1/${g.mesh}`);
    await c.next();
    c.send({ t: "create", roster: g });
    expect((await c.next())["t"]).toBe("roster");
  });

  it("counts an IPv6 client by its /64, so rotating addresses inside it draws no fresh budget", async () => {
    const r = await relay({ trustProxy: true });
    const results: string[] = [];
    for (let i = 0; i < 11; i++) results.push(await createFrom(r.relayUrls[0]!, `2001:db8:5:6::${i + 1}`));
    expect(results.at(-1)).toBe("limited");
    // Another /64 is another budget.
    expect(await createFrom(r.relayUrls[0]!, "2001:db8:5:7::1")).toBe("ok");
  });

  it("serves its public description at /v1/info, with or without a path prefix", async () => {
    const r = await relay({ createKey: "s3cret", maxMeshes: 2000, idleMeshDays: 90, limits: { blobBytesPerMeshPerDay: 25 * 1024 * 1024 }, offer: "Free during the preview" });
    const info = {
      v: 1,
      software: "worldinmotion-relay",
      version: RELAY_VERSION,
      create: "key",
      limits: { max_meshes: 2000, idle_mesh_days: 90, blob_bytes_per_mesh_per_day: 25 * 1024 * 1024 },
      offer: "Free during the preview",
    };
    expect(await get(r.port, "/v1/info")).toEqual({ status: 200, body: info });
    expect(await get(r.port, "/wim/v1/info?x=1")).toEqual({ status: 200, body: info });
    expect(JSON.stringify(await get(r.port, "/v1/info"))).not.toContain("s3cret");
    expect((await get(r.port, "/v1/info", "POST")).status).toBe(404);
    expect((await get((await relay()).port, "/v1/info")).body).toMatchObject({ create: "open", limits: { max_meshes: null, idle_mesh_days: null }, offer: null });
  });

  it("refuses create with full at the mesh cap, and keeps serving the meshes it holds", async () => {
    const r = await relay({ maxMeshes: 1 });
    const url = r.relayUrls[0]!;
    const { admin, roster } = await mesh(url);
    expect(await createFrom(url, "x")).toBe("full");
    const again = await session(url, admin, roster, "again");
    expect(again.ready["t"]).toBe("ready");
  });

  it("deletes a mesh no session has used for WIM_IDLE_MESH_DAYS, and keeps one in use", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const DAY = 86_400_000;
      const r = await relay({ idleMeshDays: 1, tickMs: 10 });
      const url = r.relayUrls[0]!;
      const idle = await mesh(url);
      idle.root.c.ws.close();
      await idle.root.c.closed;
      const busy = await mesh(url);
      // A socket still before auth on the idle mesh does not keep it alive; it is closed with it.
      const waiting = new Dial(`${url}/v1/${idle.roster.mesh}`);
      await waiting.next();
      vi.setSystemTime(Date.now() + DAY + 1_000);
      expect(await waiting.closed).toEqual({ code: 1001, reason: "mesh expired" });
      await vi.waitFor(() => expect(r.lines.some((l) => l.includes('"event":"expired"') && l.includes(idle.roster.mesh))).toBe(true));
      // The idle mesh is gone: its devices must create a new one.
      const gone = new Dial(`${url}/v1/${idle.roster.mesh}`);
      const hello = await gone.next();
      gone.send(signAuth({ relay: url, mesh: idle.roster.mesh, nonce: hello["nonce"], at: Date.now(), session: { name: "root", kind: "cli", sid: ulid(), resume: b64u.encode(randomBytes(32)) }, pin: rosterRef(idle.roster) }, idle.admin.keys));
      expect(await gone.nextOf("error")).toMatchObject({ code: "unauthorized", message: "unknown mesh" });
      // The mesh with a session online is kept, and its idle time starts when the session leaves.
      expect((await session(url, busy.admin, busy.roster, "still")).ready["t"]).toBe("ready");
      expect(r.lines.some((l) => l.includes('"event":"expired"') && l.includes(busy.roster.mesh))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the idle clock at start for meshes it already holds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const db = join(await scratchDir(), "relay.db");
      const first = await start({ db, port: 0, log: () => {} });
      const { roster } = await mesh(first.relayUrls[0]!);
      await first.close();
      const lines: string[] = [];
      const second = await start({ db, port: 0, idleMeshDays: 2, tickMs: 10, log: (l) => void lines.push(l) });
      running.push(second);
      vi.setSystemTime(Date.now() + 86_400_000);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(lines.some((l) => l.includes('"event":"expired"'))).toBe(false);
      vi.setSystemTime(Date.now() + 86_400_000 + 1_000);
      await vi.waitFor(() => expect(lines.some((l) => l.includes('"event":"expired"') && l.includes(roster.mesh))).toBe(true));
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs relay events with the mesh id", async () => {
    const r = await relay();
    const url = r.relayUrls[0]!;
    const { admin, roster, root } = await mesh(url);
    root.c.send({ t: "roster.publish", roster: nextRoster(roster, { revoke: [roster.devices[1]!.id] }, admin, Date.now()) });
    await root.c.nextOf("roster");
    await vi.waitFor(() => expect(r.lines.some((l) => l.includes('"event":"revoked"') && l.includes(roster.mesh))).toBe(true));
  });

  it("checks its configuration before listening", async () => {
    const db = join(await scratchDir(), "x.db");
    await expect(start({ db, port: 0, relayUrls: ["https://x"] })).rejects.toThrow(/invalid relay URL/);
    await expect(start({ db, port: 0, host: "10.1.2.3" })).rejects.toThrow(/set relayUrls/);
    await expect(start({ db, port: 0, lan: true, host: "127.0.0.1", relayUrls: ["ws://127.0.0.1:1"] })).rejects.toThrow(/wss only/);
    await expect(start({ db: ":memory:", port: 0, lan: true, host: "127.0.0.1" })).rejects.toThrow(/needs a database file/);
    const r = await relay();
    await expect(start({ db: ":memory:", port: r.port, log: () => {} })).rejects.toThrow(/EADDRINUSE/);
  });

  it("closes on SIGINT or SIGTERM and then exits", async () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const r = await start({ db: ":memory:", port: 0, log: () => {} });
      const listeners = new Map<string, () => void>();
      const exited = new Promise<number>((resolve) => {
        runUntilSignal(r, { once: (s, fn) => listeners.set(s, fn), exit: (code) => resolve(code) });
      });
      expect([...listeners.keys()]).toEqual(["SIGINT", "SIGTERM"]);
      listeners.get(signal)!();
      expect(await exited).toBe(0);
      const c = new Dial(`ws://127.0.0.1:${r.port}/v1/${b64u.encode(new Uint8Array(16))}`);
      await expect(c.opened()).rejects.toThrow();
    }
  });

  it("logs to the console by default and accepts explicit relay URLs", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await start({ db: ":memory:", port: 0, relayUrls: ["wss://relay.example"] });
    running.push(r);
    expect(r.relayUrls).toEqual(["wss://relay.example"]);
    expect(spy).toHaveBeenCalledWith("wim-relay listening on wss://relay.example");
    spy.mockRestore();
  });
});
