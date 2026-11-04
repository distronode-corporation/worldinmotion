import { env, SELF } from "cloudflare:test";
import {
  b64u,
  ciOneTimeKey,
  ciRuleTag,
  createPrekey,
  GITHUB_ISSUER,
  githubAudience,
  JWKS_URLS,
  LIMITS,
  makeDeviceRecord,
  nextRoster,
  sealCiNotice,
  sealMessage,
  utf8,
  type Prekey,
  type Roster,
} from "@worldinmotion/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import worker, { jwks, resetCiKeys } from "../src/index.ts";
import { bindings, createMesh, dev, meshId, ORIGIN, RELAY, Session, sourceKeyOf, type Dev } from "./helpers.ts";

const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const KID = "workerd-test-1";
let sign: (input: string) => Promise<string>;
let jwksText = "";
const fetched: string[] = [];
const defaultFetch = jwks.fetch;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ ...ALG, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as { n: string; e: string };
  jwksText = JSON.stringify({ keys: [{ kty: "RSA", kid: KID, n: pub.n, e: pub.e }] });
  sign = async (input) => b64u.encode(new Uint8Array(await crypto.subtle.sign(ALG, pair.privateKey, utf8(input))));
  jwks.fetch = async (url) => (fetched.push(url), { status: 200, text: async () => jwksText });
  resetCiKeys();
});

const part = (v: unknown) => b64u.encode(utf8(JSON.stringify(v)));

async function token(aud: string): Promise<string> {
  const iat = Math.floor(Date.now() / 1000) - 60;
  const payload = {
    iss: GITHUB_ISSUER,
    aud,
    jti: crypto.randomUUID(),
    iat,
    nbf: iat - 600,
    exp: iat + 300,
    repository: "octo-org/deploys",
    repository_id: "74",
    repository_owner_id: "65",
    ref: "refs/heads/main",
    workflow_ref: "octo-org/deploys/.github/workflows/deploy.yml@refs/heads/main",
    event_name: "push",
    sha: "e3b0c44",
    run_id: "1",
  };
  const input = `${part({ alg: "RS256", kid: KID, typ: "JWT" })}.${part(payload)}`;
  return `${input}.${await sign(input)}`;
}

/** A mesh whose laptop runs `deploys`, with its prekey in a card and a GitHub rule. */
async function ciMesh(): Promise<{ mesh: string; r: Roster; laptop: Dev; deploys: Session; pk: Prekey }> {
  const m = await createMesh();
  const root = new Session(m.mesh, m.admin, "root");
  await root.connect(m.genesis);
  const laptop = dev("laptop");
  const r = nextRoster(m.genesis, { add: [makeDeviceRecord("laptop", laptop.keys, "member", Date.now())] }, m.admin, Date.now());
  await root.sock.ask({ t: "roster.publish", roster: r }, "roster");
  const deploys = new Session(m.mesh, laptop, "deploys");
  await deploys.connect(r);
  const pk = createPrekey({ mesh: m.mesh, deviceId: laptop.id, signSec: laptop.keys.signSec, at: Date.now() - 60_000 }).prekey;
  const card = sealMessage({ roster: r, sender: { deviceId: laptop.id, keys: laptop.keys }, session: "deploys", sid: deploys.sid, to: ["*"], seq: 0, at: Date.now(), kind: "card", card: {}, recipients: r.devices.map((d) => d.id), prekey: pk });
  deploys.sock.send({ t: "card.set", msg: card });
  const tag = ciRuleTag({ mesh: m.mesh, device: laptop.id, iss: GITHUB_ISSUER, repo: "octo-org/deploys", ref: "refs/heads/main" });
  expect(await deploys.sock.ask({ t: "ci.rules", tags: [tag], gitlab: false }, "ci.rules")).toEqual({ t: "ci.rules", count: 1 });
  return { mesh: m.mesh, r, laptop, deploys, pk };
}

function post(mesh: string, body: unknown, ip = "203.0.113.9"): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/v1/${mesh}/ci`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

describe("CI senders on the Workers relay", () => {
  it("hands out the prekey and routes a verified GitHub notice, fetching only GitHub's keys", async () => {
    const m = await ciMesh();
    const pkRes = await post(m.mesh, { t: "ci.prekey", device: m.laptop.id, via: "github" });
    expect([pkRes.status, await pkRes.json()]).toEqual([200, { t: "ci.prekey", prekey: m.pk }]);
    const otk = ciOneTimeKey();
    const t = await token(githubAudience(m.mesh, m.laptop.id, otk.pub));
    const { request } = sealCiNotice({ mesh: m.mesh, device: m.laptop.id, prekey: m.pk, to: "deploys", text: "deployed", token: t, via: "github", otk, at: Date.now() });
    const res = await post(m.mesh, request);
    expect([res.status, await res.json()]).toEqual([200, { t: "ci.sent", id: request.id, status: "routed" }]);
    const deliver = await m.deploys.sock.next("ci.deliver");
    expect(deliver["msg"]["id"]).toBe(request.id);
    expect(JSON.stringify(deliver)).not.toContain(t);
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every((u) => u === JWKS_URLS[GITHUB_ISSUER])).toBe(true);
    // The same token in a new notice is refused with the one 403; a GitLab notice too, for a device that did not opt in.
    expect((await post(m.mesh, { ...request, id: "01K7A000000000000000000099" })).status).toBe(403);
    const gl = sealCiNotice({ mesh: m.mesh, device: m.laptop.id, prekey: m.pk, to: "deploys", text: "x", token: "a.b.c", via: "gitlab", at: Date.now() }).request;
    expect((await post(m.mesh, gl)).status).toBe(403);
  });

  it("refuses junk before any Durable Object: a bad path, a body over 32 KiB, a malformed one, a forged token", async () => {
    expect((await post("not-a-mesh", "{}")).status).toBe(400);
    expect((await post(meshId(), "x".repeat(LIMITS.ciRequestBytes + 1))).status).toBe(413);
    expect((await post(meshId(), "{")).status).toBe(400);
    const otk = ciOneTimeKey();
    const forged = `${(await token(githubAudience(meshId(), "AAAAAAAAAAAAAAAAAAAAAA", otk.pub))).slice(0, -4)}AAAA`;
    const m = meshId();
    const x = dev("x");
    const pk = createPrekey({ mesh: m, deviceId: x.id, signSec: x.keys.signSec, at: Date.now() }).prekey;
    const req = sealCiNotice({ mesh: m, device: "AAAAAAAAAAAAAAAAAAAAAA", prekey: pk, to: "deploys", text: "x", token: forged, via: "github", otk, at: Date.now() }).request;
    expect((await post(m, req)).status).toBe(403);
  });

  it("never reads more than 32 KiB of a body: refused by its declared length, or as the bytes pass the cap", async () => {
    const url = `${ORIGIN}/v1/${meshId()}/ci`;
    const vars = { ...bindings, WIM_RELAY_URLS: RELAY, WIM_CI: "1" };
    const declared = await worker.fetch(new Request(url, { method: "POST", headers: { "content-length": String(LIMITS.ciRequestBytes + 1) }, body: "{}" }), vars);
    expect(declared.status).toBe(413);
    // A streamed body carries no length; the reader stops once the bytes pass the cap.
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(16 * 1024).fill(0x20));
        if (pulled > 100) c.close();
      },
    });
    const streamed = await worker.fetch(new Request(url, { method: "POST", body: stream }), vars);
    expect([streamed.status, await streamed.json()]).toEqual([413, { t: "error", code: "too_large", message: "the request is over 32 KiB" }]);
    expect(pulled).toBeLessThan(10);
    // No body at all is just not a request.
    expect((await worker.fetch(new Request(url, { method: "POST" }), vars)).status).toBe(400);
    // A body in several chunks under the cap is read whole.
    const parts = ['{"t":"ci.pre', 'key","device":"AAAAAAAAAAAAAAAAAAAAAA","via":"gitlab"}'];
    const chunked = new ReadableStream<Uint8Array>({
      pull(c) {
        const next = parts.shift();
        if (next === undefined) c.close();
        else c.enqueue(new TextEncoder().encode(next));
      },
    });
    expect((await worker.fetch(new Request(url, { method: "POST", body: chunked }), vars)).status).toBe(403);
  });

  it("answers 404 when CI senders are off, and 429 past the source's rate limit", async () => {
    const off = await worker.fetch(new Request(`${ORIGIN}/v1/${meshId()}/ci`, { method: "POST", body: "{}" }), { ...bindings, WIM_RELAY_URLS: RELAY });
    expect([off.status, await off.json()]).toEqual([404, { t: "error", code: "not_found", message: "this relay takes no CI senders" }]);
    // Spend the address's whole allowance in the Worker's rate limiter, as many requests would.
    const key = await sourceKeyOf("203.0.113.77");
    for (let i = 0; i < 3 * LIMITS.dialsPerSourcePerMinute && (await env.DIALS!.limit({ key })).success; i++);
    const limited = await post(meshId(), "{}", "203.0.113.77");
    expect([limited.status, limited.headers.get("retry-after")]).toEqual([429, "60"]);
  });

  // Sixty-one requests through the Worker and an object take a while under coverage.
  it("passes the mesh's own 429 on with Retry-After", { timeout: 60_000 }, async () => {
    const m = await ciMesh();
    let last: Response | undefined;
    // The mesh's per-source CI budget is 60 a minute and refills as the loop runs; the test rate
    // limiter allows 100, so the mesh's own limit is the one reached.
    for (let i = 0; i < 95 && last?.status !== 429; i++) last = await post(m.mesh, { t: "ci.prekey", device: m.laptop.id, via: "github" }, "203.0.113.50");
    expect(last!.status).toBe(429);
    expect(await last!.json()).toMatchObject({ code: "limited" });
    expect(last!.headers.get("retry-after")).toBe("60");
  });

  it("fetches keys with no redirects by default", async () => {
    await expect(defaultFetch("http://127.0.0.1:1/keys")).rejects.toThrow();
  });
});
