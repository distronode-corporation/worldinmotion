import {
  b64u,
  ciOneTimeKey,
  ciRuleTag,
  createPrekey,
  githubAudience,
  GITHUB_ISSUER,
  gitlabCountingKey,
  LIMITS,
  sealCiNotice,
  sealMessage,
  type CiSendRequest,
  type Prekey,
} from "@worldinmotion/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { CI_NOT_FOUND, CI_UNAUTHORIZED, ciPrecheck, parseCiPath, type CiAnswer } from "../src/index.ts";
import { githubClaims, issuer, type Issuer } from "./ci-issuer.ts";
import { Client, dev, Harness, KINDS, makeStore, MESH, publish, roster, world, type Dev, type World } from "./helpers.ts";

const HOUR = 3_600_000;
let iss: Issuer;
beforeAll(async () => {
  iss = await issuer();
});

const tagFor = (d: Dev, repo = "octo-org/deploys", ref = "refs/heads/main") => ciRuleTag({ mesh: MESH, device: d.id, iss: GITHUB_ISSUER, repo, ref });

/** A card carrying the session's device prekey (SPEC section 17), sealed to every device. */
function cardWith(c: Client, pk: Prekey | undefined) {
  const r = roster(c.h);
  return sealMessage({
    roster: r,
    sender: { deviceId: c.d.id, keys: c.d.keys },
    session: c.name,
    sid: c.sid,
    to: ["*"],
    seq: 0,
    at: c.h.now,
    kind: "card",
    card: {},
    recipients: r.devices.map((d) => d.id),
    ...(pk === undefined ? {} : { prekey: pk }),
  });
}

type Setup = World & { laptop: Dev; deploys: Client; pk: Prekey };

/** A mesh whose laptop runs a `deploys` session that published its prekey and took CI rules. */
function setup(kind: (typeof KINDS)[number], rules: { tags?: string[]; gitlab?: boolean } = {}, limits = {}): Setup {
  const w = world(kind, ["laptop"], { limits, ci: true });
  const laptop = w.members[0]!;
  const deploys = new Client(w.h, laptop, "deploys");
  deploys.connect();
  const pk = createPrekey({ mesh: MESH, deviceId: laptop.id, signSec: laptop.keys.signSec, at: w.h.now - HOUR }).prekey;
  deploys.frame({ t: "card.set", msg: cardWith(deploys, pk) });
  deploys.frame({ t: "ci.rules", tags: rules.tags ?? [tagFor(laptop)], gitlab: rules.gitlab ?? true });
  return { ...w, laptop, deploys, pk };
}

async function github(
  s: Setup,
  opts: { to?: string; over?: Record<string, unknown>; at?: number; id?: string; otk?: ReturnType<typeof ciOneTimeKey>; token?: string } = {},
): Promise<CiSendRequest> {
  const otk = opts.otk ?? ciOneTimeKey();
  const at = opts.at ?? s.h.now;
  const token = opts.token ?? (await iss.mint(githubClaims(githubAudience(MESH, s.laptop.id, otk.pub), s.h.now, opts.over)));
  return sealCiNotice({ mesh: MESH, device: s.laptop.id, prekey: s.pk, to: opts.to ?? "deploys", text: "deployed", token, via: "github", otk, at, ...(opts.id ? { id: opts.id } : {}) }).request;
}

function gitlab(s: Setup, opts: { to?: string; at?: number } = {}): CiSendRequest {
  return sealCiNotice({ mesh: MESH, device: s.laptop.id, prekey: s.pk, to: opts.to ?? "deploys", text: "pipeline passed", token: "a.b.c", via: "gitlab", at: opts.at ?? s.h.now }).request;
}

/** What a host does with a request: the precheck outside the mesh, then the mesh's relay. */
async function post(h: Harness, body: unknown, source = "ci-src", enabled = true): Promise<CiAnswer> {
  const pre = await ciPrecheck(typeof body === "string" ? body : JSON.stringify(body), { enabled, keys: iss.keys, now: h.now });
  if (!pre.ok) return pre.answer;
  return h.relay.ci(pre.req, { source, ...(pre.github === undefined ? {} : { github: pre.github }) });
}

const sent = (id: string, status: string): CiAnswer => ({ status: 200, body: { t: "ci.sent", id, status } });

describe("ciPrecheck and the CI path", () => {
  it("finds the mesh in `<prefix>/v1/<mesh>/ci`, and nothing else", () => {
    expect(parseCiPath(`/v1/${MESH}/ci`)).toEqual({ ok: true, meshId: MESH });
    expect(parseCiPath(`/relay/v1/${MESH}/ci`)).toEqual({ ok: true, meshId: MESH });
    expect(parseCiPath("/v1/nope/ci")).toEqual({ ok: false, status: 400, error: "invalid mesh id" });
    expect(parseCiPath(`/v1/${MESH}`)).toBeUndefined();
  });

  it("answers 404 when the relay takes no CI senders, 413 and 400 for bodies it cannot read", async () => {
    const h = new Harness(makeStore("memory"));
    expect(await post(h, "{}", "s", false)).toEqual(CI_NOT_FOUND);
    expect(await post(h, "x".repeat(LIMITS.ciRequestBytes + 1))).toMatchObject({ status: 413, body: { code: "too_large" } });
    expect(await post(h, "{")).toMatchObject({ status: 400, body: { code: "malformed", message: "not_json" } });
    expect(await post(h, { t: "ci.prekey" })).toMatchObject({ status: 400, body: { code: "malformed" } });
  });

  it("refuses a GitHub send whose token fails any check, with the one 403", async () => {
    const s = setup("memory");
    const good = await github(s);
    const t = good.token!;
    const forged = { ...good, token: `${t.slice(0, -2)}${t.at(-2) === "A" ? "B" : "A"}${t.at(-1)}` };
    const expired = await github(s, { over: { exp: Math.floor(s.h.now / 1000) - 400, iat: Math.floor(s.h.now / 1000) - 700, nbf: undefined } });
    const arrayAud = await github(s, { over: { aud: ["wimci1.x"] } });
    const otherAud = await github(s, { over: { aud: githubAudience(MESH, s.laptop.id, ciOneTimeKey().pub) } });
    for (const r of [forged, expired, arrayAud, otherAud]) expect(await post(s.h, r)).toEqual(CI_UNAUTHORIZED);
    expect(await post(s.h, good)).toEqual(sent(good.id, "routed"));
  });
});

describe.each(KINDS)("CI senders at the relay (%s store)", (kind) => {
  it("ci.rules sets the device's tags once each, marks the session, and answers with the count", () => {
    const s = setup(kind);
    const t = tagFor(s.laptop);
    expect(s.deploys.frame({ t: "ci.rules", tags: [t, t, tagFor(s.laptop, "a/b")], gitlab: false })).toEqual([{ t: "ci.rules", count: 2 }]);
    expect(s.h.store.ciRules(s.laptop.id)).toEqual({ tags: [t, tagFor(s.laptop, "a/b")], gitlab: false });
    expect(s.h.store.getSession(s.deploys.sid)!.ci).toBe(true);
  });

  it("hands out the device's newest prekey, only to a device that takes notices by that provider", async () => {
    const s = setup(kind, { gitlab: false });
    // A second session with a newer prekey, and one with a card that carries none.
    const other = new Client(s.h, s.laptop, "other");
    other.connect();
    s.h.now += 1000;
    const newer = createPrekey({ mesh: MESH, deviceId: s.laptop.id, signSec: s.laptop.keys.signSec, at: s.h.now }).prekey;
    other.frame({ t: "card.set", msg: cardWith(other, newer) });
    const third = new Client(s.h, s.laptop, "third");
    third.connect();
    third.frame({ t: "card.set", msg: cardWith(third, undefined) });
    // Another device's card is never its prekey.
    s.root.frame({ t: "card.set", msg: cardWith(s.root, createPrekey({ mesh: MESH, deviceId: s.admin.id, signSec: s.admin.keys.signSec, at: s.h.now + 5000 }).prekey) });
    expect(await post(s.h, { t: "ci.prekey", device: s.laptop.id, via: "github" })).toEqual({ status: 200, body: { t: "ci.prekey", prekey: newer } });
    expect(await post(s.h, { t: "ci.prekey", device: s.laptop.id, via: "gitlab" })).toEqual(CI_UNAUTHORIZED);
    expect(await post(s.h, { t: "ci.prekey", device: s.admin.id, via: "github" })).toEqual(CI_UNAUTHORIZED);
    expect(await post(s.h, { t: "ci.prekey", device: "AAAAAAAAAAAAAAAAAAAAAA", via: "github" })).toEqual(CI_UNAUTHORIZED);
    const rec = dev("recovery", "admin");
    publish(s, { add: [rec.record] });
    expect(await post(s.h, { t: "ci.prekey", device: rec.id, via: "github" })).toEqual(CI_UNAUTHORIZED);
  });

  it("refuses a device with rules but no card to take a prekey from, and a mesh that does not exist", async () => {
    const w = world(kind, ["laptop"], { ci: true });
    const c = new Client(w.h, w.members[0]!, "deploys");
    c.connect();
    c.frame({ t: "ci.rules", tags: [], gitlab: true });
    expect(await post(w.h, { t: "ci.prekey", device: c.d.id, via: "gitlab" })).toEqual(CI_UNAUTHORIZED);
    // Tags are what a GitHub send needs: an empty set takes none.
    expect(await post(w.h, { t: "ci.prekey", device: c.d.id, via: "github" })).toEqual(CI_UNAUTHORIZED);
    expect(await post(new Harness(makeStore(kind), { ci: true }), { t: "ci.prekey", device: c.d.id, via: "gitlab" })).toEqual(CI_UNAUTHORIZED);
  });

  it("routes a verified GitHub notice to its online session as ci.deliver, without the token", async () => {
    const s = setup(kind);
    const req = await github(s);
    s.deploys.conn.take();
    expect(await post(s.h, req)).toEqual(sent(req.id, "routed"));
    const [deliver] = s.deploys.conn.take();
    const { token: _token, ...notice } = req;
    expect(deliver).toEqual({ t: "ci.deliver", cursor: 1, msg: notice });
    expect(JSON.stringify(s.h.store.queue(s.deploys.sid, 0))).not.toContain(req.token!);
    // Acknowledged like a message.
    s.deploys.frame({ t: "ack", cursor: 1 });
    expect(s.h.store.queue(s.deploys.sid, 0)).toEqual([]);
    // A receipt for a notice reaches nobody, and is not an error.
    expect(s.deploys.frame({ t: "receipt", id: req.id, to: s.deploys.address, status: "delivered" })).toEqual([]);
  });

  it("refuses a replayed GitHub token, a tag the device does not hold, and a send with no verified token", async () => {
    const s = setup(kind);
    const otk = ciOneTimeKey();
    const req = await github(s, { otk });
    expect(await post(s.h, req)).toEqual(sent(req.id, "routed"));
    // The same token in a fresh notice that its one-time key signed again, as the sending job
    // could: every other check passes, and only the spent jti refuses it.
    const replay = await github(s, { otk, token: req.token!, id: "01K7A000000000000000000001" });
    expect(replay.id).not.toBe(req.id);
    expect(await post(s.h, replay)).toEqual(CI_UNAUTHORIZED);
    expect(await post(s.h, await github(s, { over: { repository: "octo-org/other" } }))).toEqual(CI_UNAUTHORIZED);
    expect(await post(s.h, await github(s, { over: { ref: "refs/heads/feature" } }))).toEqual(CI_UNAUTHORIZED);
    // A host that skipped verification gets nothing through.
    const unverified = await github(s);
    expect(s.h.relay.ci(unverified, { source: "x" })).toEqual(CI_UNAUTHORIZED);
  });

  it("takes a GitLab notice for a device that opted in, counted under the device's GitLab share", async () => {
    const s = setup(kind);
    const req = gitlab(s);
    s.deploys.conn.take();
    // Routed to the live session, but answered `queued`: a GitLab answer never says who is online.
    expect(await post(s.h, req)).toEqual(sent(req.id, "queued"));
    expect(s.deploys.conn.take()).toMatchObject([{ t: "ci.deliver", msg: { id: req.id } }]);
    expect(s.h.store.queue(s.deploys.sid, 0)[0]).toMatchObject({ kind: "ci", fromDevice: gitlabCountingKey(s.laptop.id) });
    const off = setup(kind, { gitlab: false });
    expect(await post(off.h, gitlab(off))).toEqual(CI_UNAUTHORIZED);
  });

  it("answers a GitHub sender unknown for a session that is missing, ended, or never asked for CI notices", async () => {
    const s = setup(kind);
    expect(await post(s.h, await github(s, { to: "nobody" }))).toMatchObject({ body: { status: "unknown" } });
    const plain = new Client(s.h, s.laptop, "plain");
    plain.connect();
    expect(await post(s.h, await github(s, { to: "plain" }))).toMatchObject({ body: { status: "unknown" } });
    plain.frame({ t: "bye", ended: true });
    expect(await post(s.h, await github(s, { to: "plain" }))).toMatchObject({ body: { status: "unknown" } });
  });

  it("answers every GitLab notice queued, so a recipient code tells no session name or presence", async () => {
    const s = setup(kind, {}, { ciSendBurst: 5 });
    const plain = new Client(s.h, s.laptop, "plain");
    plain.connect();
    const ended = new Client(s.h, s.laptop, "ended");
    ended.connect();
    ended.frame({ t: "bye", ended: true });
    // A live CI session, a missing one, one that takes no notices and an ended one read the same.
    const answers = [];
    for (const to of ["deploys", "nobody", "plain", "ended"]) answers.push((await post(s.h, gitlab(s, { to }))).body);
    expect(answers.map((b) => b["status"])).toEqual(["queued", "queued", "queued", "queued"]);
    // Only the live one got a notice; the others were dropped, after each spent the device's rate.
    expect(s.h.store.queueCount(s.deploys.sid, "ci")).toBe(1);
    expect(s.h.store.queueCount(plain.sid, "ci")).toBe(0);
    expect(await post(s.h, gitlab(s, { to: "nobody" }))).toMatchObject({ body: { status: "queued" } });
    expect(await post(s.h, gitlab(s, { to: "nobody" }))).toMatchObject({ body: { status: "limited" } });
    expect(await post(s.h, gitlab(s))).toMatchObject({ body: { status: "limited" } });
  });

  it("refuses a notice for another mesh, one whose at is off by more than 5 minutes, and a used id", async () => {
    const s = setup(kind);
    const late = gitlab(s, { at: s.h.now - LIMITS.ciSkewMs - 1 });
    expect(await post(s.h, late)).toMatchObject({ status: 400, body: { code: "malformed" } });
    const other = { ...gitlab(s), mesh: b64u.encode(new Uint8Array(16).fill(9)) };
    expect(await post(s.h, other)).toMatchObject({ status: 400 });
    const first = gitlab(s);
    await post(s.h, first);
    expect(await post(s.h, first)).toMatchObject({ status: 400, body: { message: "notice id already used" } });
    // A notice id may not reuse a message's either.
    const m = s.root.send([s.deploys.address]);
    expect(await post(s.h, { ...gitlab(s), id: m["id"] })).toMatchObject({ status: 400 });
  });

  it("spends a per-source budget before anything else, and answers 429 with Retry-After past it", async () => {
    const s = setup(kind, {}, { ciRequestsPerSourcePerMinute: 2 });
    const ask = { t: "ci.prekey", device: s.laptop.id, via: "gitlab" };
    expect((await post(s.h, ask, "a")).status).toBe(200);
    expect((await post(s.h, ask, "a")).status).toBe(200);
    expect(await post(s.h, ask, "a")).toMatchObject({ status: 429, body: { code: "limited" }, retryAfter: 60 });
    expect((await post(s.h, ask, "b")).status).toBe(200);
    s.h.now += 30_000;
    expect((await post(s.h, ask, "a")).status).toBe(200);
  });

  it("limits each counting key's rate and the CI queue, and never takes a real message's place", async () => {
    const s = setup(kind, {}, { ciSendBurst: 3, ciQueuePerSession: 3, ciQueuePerKey: 2, queuePerSession: 2 });
    s.deploys.conn.close(1000, "away");
    s.h.drop(s.deploys.conn);
    // The message queue fills with two real messages; CI notices still queue beside them.
    expect(s.root.send([s.deploys.address])["results"][0].status).toBe("queued");
    expect(s.root.send([s.deploys.address])["results"][0].status).toBe("queued");
    expect(s.root.send([s.deploys.address])["results"][0].status).toBe("full");
    const a = await github(s);
    const b = await github(s);
    const c = await github(s);
    expect(await post(s.h, a)).toEqual(sent(a.id, "queued"));
    expect(await post(s.h, b)).toEqual(sent(b.id, "queued"));
    // At most 2 queued under one key.
    expect(await post(s.h, c)).toEqual(sent(c.id, "full"));
    // GitLab is its own key: the third CI slot; then the session's CI queue is full, which a
    // GitLab sender is never told (the notice is dropped, answered queued).
    expect(await post(s.h, gitlab(s))).toMatchObject({ body: { status: "queued" } });
    expect(await post(s.h, gitlab(s))).toMatchObject({ body: { status: "queued" } });
    // The repository's burst of 3 was spent by a, b and c? No: c was refused before spending.
    const d = await github(s);
    expect(await post(s.h, d)).toEqual(sent(d.id, "full"));
    expect(s.h.store.queueCount(s.deploys.sid)).toBe(2);
    expect(s.h.store.queueCount(s.deploys.sid, "ci")).toBe(3);
  });

  it("limits a burst of notices from one repository to its rate", async () => {
    const s = setup(kind, {}, { ciSendBurst: 2 });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push(((await post(s.h, await github(s))).body as { status: string }).status);
    expect(statuses).toEqual(["routed", "routed", "limited", "limited"]);
    s.h.now += 1000;
    expect(((await post(s.h, await github(s))).body as { status: string }).status).toBe("routed");
  });

  it("remembers at most so many live token ids, and forgets them after they expire", async () => {
    const s = setup(kind, {}, { ciJtisPerMesh: 1 });
    expect((await post(s.h, await github(s))).body).toMatchObject({ status: "routed" });
    expect(await post(s.h, await github(s))).toMatchObject({ status: 429, body: { code: "limited" } });
    // Past the token's exp plus the skew, the first id is pruned, and there is room again.
    s.h.advance(300_000 + LIMITS.ciSkewMs);
    expect((await post(s.h, await github(s))).body).toMatchObject({ status: "routed" });
  });

  it("delivers queued notices on reconnect in cursor order with messages, and expires them after a day", async () => {
    const s = setup(kind);
    s.h.drop(s.deploys.conn);
    const n = gitlab(s);
    expect(await post(s.h, n)).toMatchObject({ body: { status: "queued" } });
    s.root.send([s.deploys.address]);
    const frames = s.deploys.connect();
    expect(frames.filter((f) => f["t"] === "ci.deliver" || f["t"] === "deliver").map((f) => [f["t"], f["cursor"]])).toEqual([
      ["ci.deliver", 1],
      ["deliver", 2],
    ]);
    // Never acked, a notice expires with the queue; no sender is told, and nothing breaks.
    s.h.drop(s.deploys.conn);
    s.h.advance(LIMITS.queueLifetimeMs + 1000);
    expect(s.h.store.queueCount(s.deploys.sid, "ci")).toBe(0);
  });

  it("keeps an abandoned session while a notice waits for it, as for a message", async () => {
    const s = setup(kind);
    s.h.drop(s.deploys.conn);
    s.h.now += LIMITS.queueLifetimeMs - 1000;
    await post(s.h, gitlab(s));
    s.h.advance(2000);
    expect(s.h.store.getSession(s.deploys.sid)).toBeDefined();
    // The sweep that expires the notice finds the session still holding it; the next one deletes it.
    s.h.advance(LIMITS.queueLifetimeMs);
    s.h.advance(1000);
    expect(s.h.store.getSession(s.deploys.sid)).toBeUndefined();
  });

  it("purges a revoked device's rules", () => {
    const s = setup(kind);
    publish(s, { revoke: [s.laptop.id] });
    expect(s.h.store.ciRules(s.laptop.id)).toBeUndefined();
  });

  it("a hibernated relay keeps the rules and the session's CI mark", async () => {
    const s = setup(kind);
    s.h.hibernate();
    expect(s.h.store.getSession(s.deploys.sid)!.ci).toBe(true);
    expect(await post(s.h, await github(s))).toMatchObject({ body: { status: "routed" } });
  });

  it("with CI senders off, answers ci.rules as an older relay does and stores no tags or mark", async () => {
    const w = world(kind, ["laptop"]);
    const laptop = w.members[0]!;
    const c = new Client(w.h, laptop, "deploys");
    c.connect();
    expect(c.frame({ t: "ci.rules", tags: [tagFor(laptop)], gitlab: true })).toEqual([{ t: "error", code: "unknown_type", message: "unknown_type", ref: "ci.rules" }]);
    expect(w.h.store.ciRules(laptop.id)).toBeUndefined();
    expect(w.h.store.getSession(c.sid)!.ci).toBe(false);
    // The socket stays open, and a relay built without CI senders answers the HTTP path 404 too.
    expect(c.conn.closed).toBeUndefined();
    expect(w.h.relay.ci({ t: "ci.prekey", device: laptop.id, via: "gitlab" }, { source: "s" })).toEqual(CI_NOT_FOUND);
  });
});

describe.each(KINDS)("the CI parts of the store (%s)", (kind) => {
  it("keeps rules per device and token ids until they expire", () => {
    const st = makeStore(kind);
    expect(st.ciRules("d")).toBeUndefined();
    st.putCiRules("d", ["t1"], true);
    st.putCiRules("d", ["t2", "t3"], false);
    expect(st.ciRules("d")).toEqual({ tags: ["t2", "t3"], gitlab: false });
    st.deleteCiRules("d");
    expect(st.ciRules("d")).toBeUndefined();
    st.putJti("j", 100);
    st.putJti("k", 300);
    expect(st.hasJti("j", 99)).toBe(true);
    expect(st.hasJti("j", 100)).toBe(false);
    expect(st.hasJti("x", 0)).toBe(false);
    expect(st.pruneJtis(100)).toBe(1);
    expect(st.hasJti("j", 0)).toBe(false);
  });
});
