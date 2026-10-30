import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { LIMITS, newShortKey, openRdv, sealRdv } from "@worldinmotion/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeshDurableObject, RDV_NAME, type Attachment } from "../src/index.ts";
import { bindings, clock, createMesh, meshStub, ORIGIN, RELAY, Session } from "./helpers.ts";

const HOUR = 3_600_000;

beforeEach(() => clock.install());
afterEach(() => vi.restoreAllMocks());

const rdvStub = () => env.RDV.get(env.RDV.idFromName(RDV_NAME));

/** A box for `wim1_example` under a fresh k, as an admin's `rdv.put` carries it. */
function put(exp = Date.now() + 10 * 60_000) {
  const k = newShortKey();
  return { k, frame: { t: "rdv.put", ...sealRdv(k, "wim1_example"), exp } };
}

/** An admin session on a new mesh. */
async function admin(): Promise<Session> {
  const m = await createMesh();
  m.sock.close();
  const root = new Session(m.mesh, m.admin, "root");
  await root.connect(m.genesis);
  return root;
}

function fetchBox(id: string, ip = "198.51.100.7", method = "GET") {
  return SELF.fetch(`${ORIGIN}/v1/rdv/${id}`, { method, headers: { "cf-connecting-ip": ip } });
}

describe("short invite codes", () => {
  it("stores an admin's box relay-wide and hands it out three times by GET, uncached", async () => {
    const root = await admin();
    const { k, frame } = put();
    expect(await root.sock.ask(frame, "rdv.stored")).toEqual({ t: "rdv.stored", rdv: frame.rdv });
    for (let i = 0; i < LIMITS.rdvGetsPerBox; i++) {
      const res = await fetchBox(frame.rdv);
      expect([res.status, res.headers.get("cache-control"), res.headers.get("content-type")]).toEqual([200, "no-store", "application/json"]);
      expect(openRdv(k, await res.json())).toEqual({ ok: true, value: "wim1_example" });
    }
    const gone = await fetchBox(frame.rdv);
    expect([gone.status, await gone.json()]).toEqual([404, { error: "not found" }]);
    const bad = await fetchBox("nope");
    expect([bad.status, bad.headers.get("cache-control"), await bad.json()]).toEqual([400, "no-store", { error: "invalid id" }]);
    expect((await fetchBox(frame.rdv, "198.51.100.7", "POST")).status).toBe(404);
  });

  it("limits fetches per hashed client address", async () => {
    const id = "B".repeat(22);
    for (let i = 0; i < LIMITS.rdvGetsPerSourcePerHour; i++) expect((await fetchBox(id, "203.0.113.9")).status).toBe(404);
    const limited = await fetchBox(id, "203.0.113.9");
    expect([limited.status, await limited.json()]).toEqual([429, { error: "too many requests from this address; try again later" }]);
    expect((await fetchBox(id, "203.0.113.10")).status).toBe(404);
  });

  it("sweeps expired boxes on its alarm, armed for the next one due, never sooner than a second", async () => {
    const root = await admin();
    const soon = put(Date.now() + 500);
    await root.sock.ask(soon.frame, "rdv.stored");
    const at = Date.now();
    const alarm = await runInDurableObject(rdvStub(), (_o, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThanOrEqual(at + 1000 - 50);
    const later = put(Date.now() + 10 * 60_000);
    await root.sock.ask(later.frame, "rdv.stored");
    clock.advance(10 * 60_000 + 1000);
    expect(await runDurableObjectAlarm(rdvStub())).toBe(true);
    const rows = await runInDurableObject(rdvStub(), (_o, state) => state.storage.sql.exec("SELECT id FROM rdv WHERE id IN (?, ?)", soon.frame.rdv, later.frame.rdv).toArray());
    expect(rows).toEqual([]);
    // Once every bucket is idle for an hour too, the store is empty and no alarm is left.
    clock.advance(HOUR);
    await runInDurableObject(rdvStub(), async (instance, state) => {
      state.storage.sql.exec("DELETE FROM rdv");
      await state.storage.deleteAlarm();
      instance.alarm();
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM rdv_buckets").one()["n"]).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("answers unavailable when the rendezvous object cannot be reached", async () => {
    const root = await admin();
    const { frame } = put();
    const unreachable = {
      idFromName: () => env.RDV.idFromName(RDV_NAME),
      get: () => ({ put: () => Promise.reject(new Error("overloaded")) }),
    } as unknown as typeof env.RDV;
    await runInDurableObject(meshStub(root.mesh), async (_o, state) => {
      const ws = state.getWebSockets().find((w) => (w.deserializeAttachment() as Attachment).state.phase === "authed")!;
      const other = new MeshDurableObject(state, { ...bindings, WIM_RELAY_URLS: RELAY, RDV: unreachable });
      await other.webSocketMessage(ws, JSON.stringify(frame));
    });
    expect(await root.sock.next("error")).toEqual({ t: "error", code: "unavailable", message: "the relay could not store the short invite code", ref: "rdv.put" });
  });
});
