// `wim ci notify`, the sender (SPEC section 18): the audience check before anything is sent, token
// acquisition on GitHub and GitLab, every relay answer, and one printed line for every outcome.

import { b64u, ciRecipientCode, createPrekey, deviceIdFromSignPub, generateDeviceKeys, githubAudience, gitlabAudience, sha256, utf8 } from "@worldinmotion/protocol";
import { describe, expect, it } from "vitest";
import { ciEndpoint, ciNotify, GITLAB_TOKEN_VAR, RECIPIENT_VAR, type NotifyRequest } from "../src/cisend.ts";
import { TOKEN_URL } from "./ci-fixture.ts";

const NOW = 1_760_000_000_000;
const RELAY_URL = "wss://relay.example";
const MESH = b64u.encode(sha256(utf8("ci send mesh")).subarray(0, 16));
const keys = generateDeviceKeys();
const DEVICE = deviceIdFromSignPub(keys.signPub);
const CODE = ciRecipientCode({ relay: RELAY_URL, mesh: MESH, sign: b64u.encode(keys.signPub) });
const ENDPOINT = `https://relay.example/v1/${MESH}/ci`;
const prekey = createPrekey({ mesh: MESH, deviceId: DEVICE, signSec: keys.signSec, at: NOW - 3_600_000 }).prekey;

/** A token as the sender sees it: only its payload is read, never verified here. */
const jwt = (payload: Record<string, unknown>): string =>
  [{ alg: "RS256", kid: "k", typ: "JWT" }, payload].map((p) => b64u.encode(utf8(JSON.stringify(p)))).join(".") + ".c2lnbmF0dXJl";

type Answer = { status: number; body?: unknown; text?: string; headers?: Record<string, string>; throws?: boolean; textThrows?: boolean };

/** A job's world: GitHub's token service and the relay, each answering as told. */
function job(o: { relay?: (body: Record<string, unknown>) => Answer; token?: (aud: string) => Answer } = {}) {
  const relayCalls: Array<Record<string, unknown>> = [];
  const tokenCalls: string[] = [];
  const respond = (a: Answer): Response => {
    if (a.throws === true) throw new TypeError("fetch failed");
    const res = new Response(a.text ?? JSON.stringify(a.body), { status: a.status, headers: a.headers ?? {} });
    if (a.textThrows === true) Object.defineProperty(res, "text", { value: () => Promise.reject(new Error("body lost")) });
    return res;
  };
  const relay =
    o.relay ??
    ((body) => (body["t"] === "ci.prekey" ? { status: 200, body: { t: "ci.prekey", prekey } } : { status: 200, body: { t: "ci.sent", id: body["id"], status: "routed" } }));
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://token.test/")) {
      const aud = new URL(url).searchParams.get("audience")!;
      tokenCalls.push(aud);
      expect(new Headers(init?.headers).get("authorization")).toBe("bearer runtime-bearer");
      return respond(o.token?.(aud) ?? { status: 200, body: { value: jwt({ aud }) } });
    }
    expect(url).toBe(ENDPOINT);
    const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
    relayCalls.push(body);
    return respond(relay(body));
  }) as typeof fetch;
  return { fetch: fetcher, relayCalls, tokenCalls };
}

const GH_ENV = { GITHUB_ACTIONS: "true", ACTIONS_ID_TOKEN_REQUEST_URL: TOKEN_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runtime-bearer" };
const glEnv = (aud: unknown = gitlabAudience(MESH, DEVICE)) => ({ GITLAB_CI: "true", [GITLAB_TOKEN_VAR]: jwt({ aud }) });

function notify(req: NotifyRequest, env: Record<string, string>, j = job(), now: () => number = () => NOW) {
  return ciNotify({ recipient: CODE, to: "deploys", text: "deployed", ...req }, { env, fetch: j.fetch, now });
}

const notSent = (why: string) => ({ sent: false, line: `wim ci notify: not sent: ${why}.` });

describe("the audience check, before anything is sent", () => {
  it("refuses a token with several audiences, another service's audience, or another device's", async () => {
    const cases: Array<[unknown, RegExp]> = [
      [["wimci1.x", "https://gitlab.com"], /several audiences/],
      ["https://gitlab.com", /not one string starting with wimci1\./],
      ["sts.amazonaws.com", /not one string starting with wimci1\./],
      [gitlabAudience(MESH, "AAAAAAAAAAAAAAAAAAAAAA"), /for another device or mesh/],
    ];
    for (const [aud, why] of cases) {
      const j = job();
      const out = await notify({}, glEnv(aud), j);
      expect(out.sent).toBe(false);
      expect(out.line).toMatch(why);
      expect(out.line).toContain("refusing to send it anywhere");
      expect(j.relayCalls).toEqual([]);
    }
  });

  it("refuses a GitHub token whose audience is not the one-time key's, sending nothing to the relay", async () => {
    for (const aud of [["a", "b"], "api://AzureADTokenExchange", githubAudience(MESH, DEVICE, b64u.encode(new Uint8Array(32)))]) {
      const j = job({ token: () => ({ status: 200, body: { value: jwt({ aud }) } }) });
      expect((await notify({}, GH_ENV, j)).line).toMatch(/refusing to send it anywhere/);
      expect(j.relayCalls).toEqual([]);
    }
  });

  it("refuses a token that does not parse, and a GitLab job with no wim token", async () => {
    expect(await notify({}, { GITLAB_CI: "true", [GITLAB_TOKEN_VAR]: "not.a.token" })).toEqual(notSent("the ID token does not parse"));
    expect((await notify({}, { GITLAB_CI: "true" })).line).toContain(`no ID token in ${GITLAB_TOKEN_VAR}: declare it under the job's id_tokens: with aud ${gitlabAudience(MESH, DEVICE)}`);
  });
});

describe("sending", () => {
  it("asks GitHub for a token naming a fresh one-time key, and sends it with a signed notice", async () => {
    const j = job();
    expect(await notify({}, GH_ENV, j)).toEqual({ sent: true, line: "wim ci notify: sent to deploys, delivered now." });
    expect(j.tokenCalls).toHaveLength(1);
    const send = j.relayCalls[1]!;
    expect(j.relayCalls[0]).toEqual({ t: "ci.prekey", device: DEVICE, via: "github" });
    expect(send).toMatchObject({ t: "ci.send", via: "github", device: DEVICE, to: "deploys", at: NOW });
    expect(j.tokenCalls[0]).toBe(githubAudience(MESH, DEVICE, send["otk"] as string));
    expect(send["sig"]).toEqual(expect.any(String));
  });

  it("sends a GitLab notice with its token only in the box", async () => {
    const j = job();
    const env = glEnv();
    expect((await notify({ via: "gitlab" }, env, j)).sent).toBe(true);
    expect(JSON.stringify(j.relayCalls)).not.toContain(env[GITLAB_TOKEN_VAR]);
    expect(j.relayCalls[1]).not.toHaveProperty("token");
  });

  it("reads the recipient code from WIM_CI_RECIPIENT", async () => {
    const out = await ciNotify({ to: "deploys", text: "x" }, { env: { ...glEnv(), [RECIPIENT_VAR]: CODE }, fetch: job().fetch, now: () => NOW });
    expect(out.sent).toBe(true);
  });

  it("says what the relay did with it", async () => {
    const lines: Record<string, string> = {
      queued: "wim ci notify: sent to deploys, queued (it is offline now; kept up to 24 hours).",
      unknown: "wim ci notify: not delivered: no session named deploys on that device takes CI notices (it is not running, or its client is too old for CI notices).",
      full: "wim ci notify: not delivered: deploys's queue of CI notices is full.",
      limited: "wim ci notify: not delivered: too many notices from this repository for now; try again later.",
    };
    for (const [status, line] of Object.entries(lines)) {
      const j = job({ relay: (b) => (b["t"] === "ci.prekey" ? { status: 200, body: { t: "ci.prekey", prekey } } : { status: 200, body: { t: "ci.sent", id: b["id"], status } }) });
      expect((await notify({}, glEnv(), j)).line).toBe(line);
    }
  });

  it("maps the relay's refusals and failures to a reason", async () => {
    const cases: Array<[Answer, string]> = [
      [{ status: 403, body: { t: "error", code: "unauthorized" } }, "the relay refused: the device takes no CI notices from this provider (on it, run `wim ci allow`), or the token failed the relay's checks"],
      [{ status: 404, body: {} }, "this relay takes no CI senders (it is older, or its operator has not turned them on)"],
      [{ status: 413, body: {} }, "the relay refused: the request is too large"],
      [{ status: 429, body: {}, headers: { "retry-after": "60" } }, "the relay limited this address; retry after 60 s"],
      [{ status: 429, body: {} }, "the relay limited this address; retry after a minute s"],
      [{ status: 502, text: "<html>", textThrows: true }, "the relay answered HTTP 502"],
      [{ status: 200, throws: true }, "the relay could not be reached"],
      [{ status: 200, text: "not json" }, "the relay's answer does not parse"],
      [{ status: 200, body: { t: "ci.prekey" } }, "the relay's prekey answer is malformed"],
      [{ status: 200, body: { t: "ci.prekey", prekey: { ...prekey, device: "AAAAAAAAAAAAAAAAAAAAAA" } } }, "the relay's prekey for that device does not verify (wrong_device)"],
    ];
    for (const [answer, why] of cases) expect(await notify({}, glEnv(), job({ relay: () => answer }))).toEqual(notSent(why));
    const late = () => NOW + 5 * 24 * 3_600_000;
    expect(await notify({}, glEnv(), job(), late)).toEqual(notSent("the device has no usable prekey (it has been offline for more than 48 hours)"));
    for (const sent of [{ t: "ci.sent", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", status: "routed" }, { t: "nope" }]) {
      const j = job({ relay: (b) => (b["t"] === "ci.prekey" ? { status: 200, body: { t: "ci.prekey", prekey } } : { status: 200, body: sent }) });
      expect(await notify({}, glEnv(), j)).toEqual(notSent("the relay's answer is malformed"));
    }
  });

  it("names only the kind of an unforeseen failure", async () => {
    let calls = 0;
    // A clock that goes wrong between checking the prekey and sealing.
    const out = await notify({}, glEnv(), job(), () => (++calls === 1 ? NOW : 1.5));
    expect(out).toEqual(notSent("an unexpected RangeError"));
  });
});

describe("GitHub's token service", () => {
  it("needs id-token: write, a URL, and an answer with a token", async () => {
    const env = { GITHUB_ACTIONS: "true" };
    expect(await notify({}, env)).toEqual(notSent("no ID token: give the job `permissions: id-token: write`"));
    expect(await notify({}, { ...env, ACTIONS_ID_TOKEN_REQUEST_URL: TOKEN_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" })).toEqual(notSent("no ID token: give the job `permissions: id-token: write`"));
    expect(await notify({}, { ...GH_ENV, ACTIONS_ID_TOKEN_REQUEST_URL: "not a url" })).toEqual(notSent("ACTIONS_ID_TOKEN_REQUEST_URL is not a URL"));
    expect(await notify({}, GH_ENV, job({ token: () => ({ status: 200, throws: true }) }))).toEqual(notSent("GitHub's ID token service could not be reached"));
    expect(await notify({}, GH_ENV, job({ token: () => ({ status: 403, body: {} }) }))).toEqual(notSent("GitHub's ID token service answered HTTP 403"));
    expect(await notify({}, GH_ENV, job({ token: () => ({ status: 200, text: "{" }) }))).toEqual(notSent("GitHub's ID token service gave no token"));
    expect(await notify({}, GH_ENV, job({ token: () => ({ status: 200, body: { value: 1 } }) }))).toEqual(notSent("GitHub's ID token service gave no token"));
  });
});

describe("what it refuses before asking for any token", () => {
  it("checks the code, the session name, the text and the provider", async () => {
    const j = job();
    expect(await notify({ recipient: "wim1_nope" }, GH_ENV, j)).toEqual(notSent(`the recipient code is missing or not a wimci1_ code (pass --recipient or set ${RECIPIENT_VAR})`));
    expect(await notify({ to: "Not A Name" }, GH_ENV, j)).toEqual(notSent("--to must name the session, 1 to 32 of a-z, 0-9 and -"));
    expect(await notify({ text: "" }, GH_ENV, j)).toEqual(notSent("no text"));
    expect(await ciNotify({ recipient: CODE, to: "deploys" }, { env: GH_ENV, fetch: j.fetch, now: () => NOW })).toEqual(notSent("no text"));
    expect(await notify({ text: "x".repeat(4097) }, GH_ENV, j)).toEqual(notSent("the text is over 4096 bytes"));
    expect(await notify({ text: "key AKIAABCDEFGHIJKLMNOP" }, GH_ENV, j)).toEqual(notSent("the text appears to contain a secret (aws_access_key_id)"));
    expect(await notify({}, {}, j)).toEqual(notSent("not a GitHub Actions or GitLab CI/CD job (pass --via github or --via gitlab)"));
    expect(await notify({ via: "jenkins" }, GH_ENV, j)).toEqual(notSent("not a GitHub Actions or GitLab CI/CD job (pass --via github or --via gitlab)"));
    expect(j.tokenCalls).toEqual([]);
    expect(j.relayCalls).toEqual([]);
  });
});

describe("ciEndpoint", () => {
  it("reads the relay URL as http(s)", () => {
    expect(ciEndpoint({ relay: RELAY_URL, mesh: MESH })).toBe(ENDPOINT);
    expect(ciEndpoint({ relay: "ws://127.0.0.1:4444", mesh: MESH })).toBe(`http://127.0.0.1:4444/v1/${MESH}/ci`);
  });
});
