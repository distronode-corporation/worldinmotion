import { DatabaseSync } from "node:sqlite";
import { LIMITS, newShortKey, openRdv, sealRdv } from "@worldinmotion/protocol";
import { describe, expect, it } from "vitest";
import { parseRdvPath, RDV_HEADERS, Rendezvous, type Limits, type RdvOutcome, type RdvPut } from "../src/index.ts";
import { Client, KINDS, sqlDb, T0, world, type World } from "./helpers.ts";

const HOUR = 3_600_000;
const FULL = "wim1_" + "A".repeat(300);

function box(source = "src-1", exp = T0 + HOUR): RdvPut & { k: string } {
  const k = newShortKey();
  return { k, ...sealRdv(k, FULL), exp, source };
}

function store(limits: Partial<Limits> = {}): { rv: Rendezvous; db: ReturnType<typeof sqlDb> } {
  const db = sqlDb(new DatabaseSync(":memory:"));
  return { rv: new Rendezvous(db, limits), db };
}

describe("Rendezvous", () => {
  it("hands a box out three times, then forgets it", () => {
    const { rv } = store();
    const b = box();
    expect(rv.put(b, T0)).toBe("stored");
    for (let i = 0; i < LIMITS.rdvGetsPerBox; i++) {
      const got = rv.get(b.rdv, `getter-${i}`, T0 + 1);
      expect(got).toEqual({ status: 200, body: { v: 1, rdv: b.rdv, exp: b.exp, n: b.n, c: b.c } });
      expect(openRdv(b.k, got.body)).toEqual({ ok: true, value: FULL });
    }
    expect(rv.get(b.rdv, "getter-x", T0 + 2)).toEqual({ status: 404, body: { error: "not found" } });
    // The box is gone; the put's bucket, used at T0, is the first thing left to sweep.
    expect(rv.nextDue()).toBe(T0 + HOUR);
  });

  it("keeps a box until its expiry, refuses a live id twice, and replaces an expired one", () => {
    const { rv } = store();
    const b = box();
    expect(rv.put(b, T0)).toBe("stored");
    expect(rv.put({ ...b, source: "src-2" }, T0 + 1)).toBe("exists");
    expect(rv.get(b.rdv, "g", b.exp - 1).status).toBe(200);
    expect(rv.get(b.rdv, "g", b.exp)).toEqual({ status: 404, body: { error: "not found" } });
    // Not swept yet, so the row is still there: a new put under the id replaces it, with a fresh count.
    const again = { ...b, exp: b.exp + HOUR };
    expect(rv.put(again, b.exp)).toBe("stored");
    for (let i = 0; i < LIMITS.rdvGetsPerBox; i++) expect(rv.get(b.rdv, `h${i}`, b.exp + 1).status).toBe(200);
  });

  it("holds at most rdvBoxesPerRelay live boxes in all", () => {
    const { rv } = store({ rdvBoxesPerRelay: 2 });
    expect(rv.put(box("a"), T0)).toBe("stored");
    expect(rv.put(box("b", T0 + 10), T0)).toBe("stored");
    expect(rv.put(box("c"), T0)).toBe("full");
    // An expired box no longer counts, swept or not.
    expect(rv.put(box("c"), T0 + 10)).toBe("stored");
  });

  it("limits puts and fetches per source address, refilling over the hour", () => {
    const { rv } = store({ rdvPutsPerSourcePerHour: 2, rdvGetsPerSourcePerHour: 2 });
    expect(rv.put(box("a"), T0)).toBe("stored");
    expect(rv.put(box("a"), T0)).toBe("stored");
    expect(rv.put(box("a"), T0)).toBe("limited");
    expect(rv.put(box("b"), T0)).toBe("stored");
    expect(rv.put(box("a"), T0 + HOUR / 2)).toBe("stored");
    const b = box("c");
    rv.put(b, T0);
    // Misses spend from the budget too: guessing ids costs the same as fetching.
    expect(rv.get("AAAAAAAAAAAAAAAAAAAAAA", "g", T0).status).toBe(404);
    expect(rv.get(b.rdv, "g", T0).status).toBe(200);
    expect(rv.get(b.rdv, "g", T0)).toEqual({ status: 429, body: { error: "too many requests from this address; try again later" } });
    expect(rv.get(b.rdv, "other", T0).status).toBe(200);
  });

  it("sweeps expired boxes and idle buckets, and says when the next sweep is due", () => {
    const { rv, db } = store();
    expect(rv.nextDue()).toBeUndefined();
    const b = box("a", T0 + 10 * 60_000);
    rv.put(b, T0);
    expect(rv.nextDue()).toBe(b.exp);
    rv.sweep(b.exp);
    expect(db.all("SELECT id FROM rdv")).toEqual([]);
    // The put's bucket is left: it goes an hour after its last use.
    expect(rv.nextDue()).toBe(T0 + HOUR);
    rv.sweep(T0 + HOUR - 1);
    expect(db.all("SELECT k FROM rdv_buckets")).toHaveLength(1);
    rv.sweep(T0 + HOUR);
    expect(rv.nextDue()).toBeUndefined();
    // A second store over the same database keeps what the first wrote.
    const c = box("a", T0 + 2 * HOUR);
    rv.put(c, T0 + HOUR);
    expect(new Rendezvous(db).get(c.rdv, "g", T0 + HOUR).status).toBe(200);
  });
});

describe("parseRdvPath", () => {
  it("reads the id from /v1/rdv/<id> under any prefix, and refuses a bad id", () => {
    const id = box().rdv;
    expect(parseRdvPath(`/v1/rdv/${id}`)).toEqual({ ok: true, rdv: id });
    expect(parseRdvPath(`/relay/v1/rdv/${id}`)).toEqual({ ok: true, rdv: id });
    for (const bad of ["", "short", `${id}x`, "AAAAAAAAAAAAAAAAAAAAA="]) expect(parseRdvPath(`/v1/rdv/${bad}`), bad).toEqual({ ok: false, status: 400, error: "invalid id" });
    for (const other of ["/v1/rdv", `/v1/rdv/${id}/x`, `/v1/${id}`, "/healthz"]) expect(parseRdvPath(other), other).toBeUndefined();
    expect(RDV_HEADERS).toEqual({ "content-type": "application/json", "cache-control": "no-store" });
  });
});

/** A mesh whose host has a relay-wide store; `answers` holds the deferred answers when `later`. */
function rdvWorld(kind: (typeof KINDS)[number], opts: { later?: boolean; limits?: Partial<Limits>; outcome?: RdvOutcome } = {}) {
  const w = world(kind, ["laptop"], { limits: opts.limits ?? {} });
  const puts: RdvPut[] = [];
  const answers: (() => void)[] = [];
  Object.assign(w.h.extra, {
    rdvPut: (put: RdvPut, answer: (o: RdvOutcome) => void) => {
      puts.push(put);
      const o = opts.outcome ?? "stored";
      if (opts.later === true) answers.push(() => answer(o));
      else answer(o);
    },
  });
  w.h.hibernate();
  const member = new Client(w.h, w.members[0]!, "m");
  member.connect();
  w.root.conn.take();
  return { ...w, puts, answers, member };
}

function frame(w: World, exp = w.h.now + HOUR) {
  const { k: _k, source: _s, ...b } = box("x", exp);
  return { t: "rdv.put", ...b };
}

describe.each(KINDS)("rdv.put (%s store)", (kind) => {
  it("is unsupported on a host without a relay-wide store, and needs auth first", () => {
    const w = world(kind);
    const f = frame(w);
    expect(w.root.frame(f)).toEqual([{ t: "error", code: "unsupported", message: "this relay keeps no short invite codes", ref: "rdv.put" }]);
    const pre = w.h.open();
    pre.take();
    w.h.sendFrame(pre, f);
    expect(pre.take()).toEqual([{ t: "error", code: "unauthorized", message: "authenticate first", ref: "rdv.put" }]);
  });

  it("stores an admin's box through the host, with the connection's source", () => {
    const w = rdvWorld(kind);
    const f = frame(w);
    expect(w.root.frame(f)).toEqual([{ t: "rdv.stored", rdv: f.rdv }]);
    expect(w.puts).toEqual([{ rdv: f.rdv, exp: f.exp, n: f.n, c: f.c, source: "src-1" }]);
  });

  it("refuses a member, and an expiry that is past or more than an hour away", () => {
    const w = rdvWorld(kind);
    expect(w.member.frame(frame(w))).toEqual([{ t: "error", code: "unauthorized", message: "only admin devices store short invite codes", ref: "rdv.put" }]);
    const bad = { t: "error", code: "malformed", message: "exp must be in the next hour", ref: "rdv.put" };
    expect(w.root.frame(frame(w, w.h.now))).toEqual([bad]);
    expect(w.root.frame(frame(w, w.h.now + HOUR + 1))).toEqual([bad]);
    expect(w.root.frame(frame(w, w.h.now + HOUR))[0]!["t"]).toBe("rdv.stored");
    expect(w.puts).toHaveLength(1);
  });

  it("limits puts per device and per mesh, refilling over the hour", () => {
    const limited = { t: "error", code: "limited", message: "too many short invite codes for now; try again later", ref: "rdv.put" };
    const w = rdvWorld(kind, { limits: { rdvPutsPerDevicePerHour: 1 } });
    expect(w.root.frame(frame(w))[0]!["t"]).toBe("rdv.stored");
    expect(w.root.frame(frame(w))).toEqual([limited]);
    w.h.now += HOUR + 1000;
    expect(w.root.frame(frame(w))[0]!["t"]).toBe("rdv.stored");
    const m = rdvWorld(kind, { limits: { rdvPutsPerMeshPerHour: 1 } });
    expect(m.root.frame(frame(m))[0]!["t"]).toBe("rdv.stored");
    expect(m.root.frame(frame(m))).toEqual([limited]);
  });

  it("answers each refusal of the relay-wide store with its own code", () => {
    const cases: Array<[RdvOutcome, string]> = [
      ["exists", "rdv_exists"],
      ["limited", "limited"],
      ["full", "full"],
      ["unavailable", "unavailable"],
    ];
    for (const [outcome, code] of cases) {
      const w = rdvWorld(kind, { outcome });
      expect(w.root.frame(frame(w))[0], outcome).toMatchObject({ t: "error", code, ref: "rdv.put" });
    }
  });

  it("answers later when the store does, but not on a connection that closed meanwhile", () => {
    const w = rdvWorld(kind, { later: true });
    const f = frame(w);
    expect(w.root.frame(f)).toEqual([]);
    w.answers.shift()!();
    expect(w.root.conn.take()).toEqual([{ t: "rdv.stored", rdv: f.rdv }]);
    w.root.frame(frame(w));
    const conn = w.root.conn;
    w.h.drop(conn);
    w.answers.shift()!();
    expect(conn.take()).toEqual([]);
  });
});
