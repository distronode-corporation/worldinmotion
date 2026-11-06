import { createServer, request } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  ciOneTimeKey,
  ciRuleTag,
  createGenesisRoster,
  createPrekey,
  deviceIdFromSignPub,
  generateDeviceKeys,
  githubAudience,
  GITHUB_ISSUER,
  JWKS_URLS,
  LIMITS,
  makeDeviceRecord,
  nextRoster,
  sealCiNotice,
  sealMessage,
  type DeviceKeys,
  type Prekey,
  type Roster,
} from "@worldinmotion/protocol";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { start, type RunningRelay } from "../src/index.ts";
import { fetchJwks } from "../src/server.ts";
import { githubClaims, issuer, type Issuer } from "./ci-issuer.ts";
import { Dial, scratchDir } from "./helpers.ts";
import { b64u, randomBytes, rosterRef, signAuth, ulid } from "@worldinmotion/protocol";

let iss: Issuer;
const fetched: string[] = [];
beforeAll(async () => {
  iss = await issuer();
});

const running: RunningRelay[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.close();
});

async function relay(config: Partial<Parameters<typeof start>[0]> = {}): Promise<RunningRelay> {
  const r = await start({
    db: join(await scratchDir(), "relay.db"),
    port: 0,
    log: () => undefined,
    ci: true,
    jwksFetch: async (url) => (fetched.push(url), { status: 200, text: async () => iss.jwks }),
    ...config,
  });
  running.push(r);
  return r;
}

type Device = { name: string; keys: DeviceKeys; id: string };
const device = (name: string): Device => {
  const keys = generateDeviceKeys();
  return { name, keys, id: deviceIdFromSignPub(keys.signPub) };
};

async function session(url: string, d: Device, r: Roster, name: string) {
  const c = new Dial(`${url}/v1/${r.mesh}`);
  const hello = await c.next();
  const sid = ulid();
  c.send(signAuth({ relay: url, mesh: r.mesh, nonce: hello["nonce"], at: Date.now(), session: { name, kind: "cli", sid, resume: b64u.encode(randomBytes(32)) }, pin: rosterRef(r) }, d.keys));
  await c.nextOf("ready");
  return { c, sid, name };
}

/**
 * A mesh whose laptop runs a `deploys` session with its prekey in a card and a CI rule. On a
 * relay without CI senders (`ci` false) the rule is answered `unknown_type` instead.
 */
async function ciMesh(url: string, ci = true) {
  const admin = device("admin");
  const laptop = device("laptop");
  const genesis = createGenesisRoster({ name: "admin", keys: admin.keys, now: Date.now() });
  const creator = new Dial(`${url}/v1/${genesis.mesh}`);
  await creator.next();
  creator.send({ t: "create", roster: genesis });
  await creator.nextOf("roster");
  creator.ws.close();
  const r = nextRoster(genesis, { add: [makeDeviceRecord("laptop", laptop.keys, "member", Date.now())] }, admin, Date.now());
  const root = await session(url, admin, genesis, "root");
  root.c.send({ t: "roster.publish", roster: r });
  await root.c.nextOf("roster");
  const deploys = await session(url, laptop, r, "deploys");
  const pk = createPrekey({ mesh: r.mesh, deviceId: laptop.id, signSec: laptop.keys.signSec, at: Date.now() - 60_000 }).prekey;
  const card = sealMessage({ roster: r, sender: { deviceId: laptop.id, keys: laptop.keys }, session: "deploys", sid: deploys.sid, to: ["*"], seq: 0, at: Date.now(), kind: "card", card: {}, recipients: r.devices.map((d) => d.id), prekey: pk });
  deploys.c.send({ t: "card.set", msg: card });
  deploys.c.send({ t: "ci.rules", tags: [ciRuleTag({ mesh: r.mesh, device: laptop.id, iss: GITHUB_ISSUER, repo: "octo-org/deploys", ref: "refs/heads/main" })], gitlab: false });
  if (ci) expect(await deploys.c.nextOf("ci.rules")).toEqual({ t: "ci.rules", count: 1 });
  else expect(await deploys.c.nextOf("error")).toEqual({ t: "error", code: "unknown_type", message: "unknown_type", ref: "ci.rules" });
  return { r, laptop, deploys, pk };
}

/** A POST to the relay; the answer's status, headers and JSON body. */
function post(port: number, path: string, body: string, headers: Record<string, string> = {}, method = "POST"): Promise<{ status: number; headers: Record<string, unknown>; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { "content-type": "application/json", ...headers } }, (res) => {
      let text = "";
      res.on("data", (d: Buffer) => (text += d.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, json: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function githubSend(m: { r: Roster; laptop: Device; pk: Prekey }, otk = ciOneTimeKey(), reuse?: string, over?: Record<string, unknown>) {
  const token = reuse ?? (await iss.mint(githubClaims(githubAudience(m.r.mesh, m.laptop.id, otk.pub), Date.now(), over)));
  return sealCiNotice({ mesh: m.r.mesh, device: m.laptop.id, prekey: m.pk, to: "deploys", text: "deployed", token, via: "github", otk, at: Date.now() }).request;
}

describe("relay-node CI senders", () => {
  it("answers 404 when CI senders are off, as an older relay does", async () => {
    const r = await relay({ ci: undefined });
    const a = await post(r.port, `/v1/${b64u.encode(new Uint8Array(16))}/ci`, "{}");
    expect(a).toMatchObject({ status: 404, json: { t: "error", code: "not_found" } });
  });

  it("with CI senders off (WIM_CI unset), refuses ci.rules and stores no tags and no session mark", async () => {
    const db = join(await scratchDir(), "relay.db");
    const r = await relay({ ci: undefined, db });
    const m = await ciMesh(r.relayUrls[0]!, false);
    // The socket stays open and serves as before.
    m.deploys.c.send({ t: "ping" });
    expect(await m.deploys.c.nextOf("pong")).toEqual({ t: "pong" });
    const raw = new DatabaseSync(db, { readOnly: true });
    try {
      expect(raw.prepare("SELECT count(*) AS n FROM ci_rules").get()).toEqual({ n: 0 });
      expect(raw.prepare("SELECT count(*) AS n FROM sessions WHERE ci = 1").get()).toEqual({ n: 0 });
      expect(raw.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 2 });
    } finally {
      raw.close();
    }
  });

  it("hands out the prekey and routes a verified GitHub notice to its session, fetching only GitHub's keys", async () => {
    const r = await relay();
    const url = r.relayUrls[0]!;
    const m = await ciMesh(url);
    const path = `/v1/${m.r.mesh}/ci`;
    expect(await post(r.port, path, JSON.stringify({ t: "ci.prekey", device: m.laptop.id, via: "github" }))).toMatchObject({ status: 200, json: { t: "ci.prekey", prekey: m.pk } });
    const otk = ciOneTimeKey();
    const req = await githubSend(m, otk);
    expect(await post(r.port, path, JSON.stringify(req))).toMatchObject({ status: 200, json: { t: "ci.sent", id: req.id, status: "routed" } });
    const deliver = await m.deploys.c.nextOf("ci.deliver");
    expect(deliver["msg"]["id"]).toBe(req.id);
    expect(deliver["msg"]["token"]).toBeUndefined();
    expect(fetched.every((u) => u === JWKS_URLS[GITHUB_ISSUER])).toBe(true);
    // The same token again, in a notice its one-time key signed again, is refused by its jti, with the one 403.
    const replay = await githubSend(m, otk, req.token!);
    expect(replay.id).not.toBe(req.id);
    expect(await post(r.port, path, JSON.stringify(replay))).toMatchObject({ status: 403, json: { code: "unauthorized" } });
  });

  it("routes a GitHub notice whose ref falls under a pattern tag the device holds", async () => {
    const r = await relay();
    const m = await ciMesh(r.relayUrls[0]!);
    const path = `/v1/${m.r.mesh}/ci`;
    m.deploys.c.send({ t: "ci.rules", tags: [ciRuleTag({ mesh: m.r.mesh, device: m.laptop.id, iss: GITHUB_ISSUER, repo: "octo-org/deploys", ref: "refs/tags/v*" })], gitlab: false });
    expect(await m.deploys.c.nextOf("ci.rules")).toEqual({ t: "ci.rules", count: 1 });
    const req = await githubSend(m, ciOneTimeKey(), undefined, { ref: "refs/tags/v3.3.0" });
    expect(await post(r.port, path, JSON.stringify(req))).toMatchObject({ status: 200, json: { t: "ci.sent", id: req.id, status: "routed" } });
    expect((await m.deploys.c.nextOf("ci.deliver"))["msg"]["id"]).toBe(req.id);
    const outside = await githubSend(m, ciOneTimeKey(), undefined, { ref: "refs/heads/main" });
    expect(await post(r.port, path, JSON.stringify(outside))).toMatchObject({ status: 403, json: { code: "unauthorized" } });
  });

  it("answers 400, 413 and 403 for a bad path, body or mesh, and keeps nothing for an unknown mesh", async () => {
    const r = await relay();
    expect(await post(r.port, "/v1/not-a-mesh/ci", "{}")).toMatchObject({ status: 400, json: { code: "malformed" } });
    const path = `/v1/${b64u.encode(new Uint8Array(16).fill(3))}/ci`;
    expect(await post(r.port, path, "{")).toMatchObject({ status: 400, json: { code: "malformed" } });
    expect(await post(r.port, path, "x".repeat(LIMITS.ciRequestBytes + 1))).toMatchObject({ status: 413, json: { code: "too_large" } });
    expect(await post(r.port, path, JSON.stringify({ t: "ci.prekey", device: "AAAAAAAAAAAAAAAAAAAAAA", via: "gitlab" }))).toMatchObject({ status: 403 });
    expect(r.loadedMeshes()).toBe(0);
    // A GET on the CI path is not a CI request.
    expect((await post(r.port, path, "", {}, "GET")).status).toBe(404);
  });

  it("spends the per-source dial budget on CI requests, answering 429 with Retry-After", async () => {
    const r = await relay({ trustProxy: true, limits: { dialsPerSourcePerMinute: 1 } });
    const path = `/v1/${b64u.encode(new Uint8Array(16).fill(4))}/ci`;
    const from = { "x-forwarded-for": "198.51.100.7" };
    expect((await post(r.port, path, "{}", from)).status).toBe(400);
    const refused = await post(r.port, path, "{}", from);
    expect(refused).toMatchObject({ status: 429, json: { code: "limited" } });
    expect(refused.headers["retry-after"]).toBe("60");
  });
});

describe("fetchJwks", () => {
  it("fetches with no redirects", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/keys") res.end('{"keys":[]}');
      else res.writeHead(302, { location: "/keys" }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetchJwks(`http://127.0.0.1:${port}/keys`);
      expect([res.status, await res.text()]).toEqual([200, '{"keys":[]}']);
      await expect(fetchJwks(`http://127.0.0.1:${port}/elsewhere`)).rejects.toThrow();
    } finally {
      server.close();
    }
  });
});
