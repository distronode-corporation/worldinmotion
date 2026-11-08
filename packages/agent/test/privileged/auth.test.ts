import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { AUTH_TIMEOUT_MS, loadAnthropicCredentials, OAUTH_BETA, upstreamAuth, within, type AuthDeps } from "../../src/privileged/auth.ts";
import { parsePrivilegedConfig } from "../../src/privileged/config.ts";
import { minimal, WIF } from "./helpers.ts";

const wif = (over: Record<string, unknown> = {}) => parsePrivilegedConfig(minimal({ profiles: { a: { auth: { ...WIF, ...over } } } })).profiles["a"]!.auth;

/** A token endpoint on loopback that answers like /v1/oauth/token, recording each exchange. */
async function tokenEndpoint(answer: (n: number) => { status: number; body: unknown }) {
  const seen: Array<{ url: string; headers: Record<string, unknown>; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      seen.push({ url: req.url!, headers: req.headers, body: JSON.parse(b) });
      const a = answer(seen.length);
      res.writeHead(a.status, { "content-type": "application/json" });
      res.end(JSON.stringify(a.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function deps(over: Partial<AuthDeps> = {}): AuthDeps & { logs: string[]; minted: number } {
  const d: { logs: string[]; minted: number } & Record<string, unknown> = {
    logs: [] as string[],
    minted: 0,
    identity: {
      awsWebIdentityToken: async (): Promise<string> => `id.jwt.${++d.minted}`,
      fetch: async () => ({ ok: true, status: 200, text: async () => "" }),
      readFile: async () => "",
    },
    credentials: loadAnthropicCredentials,
    fetch: (url: string, init?: RequestInit) => fetch(url, init),
    log: (l: string) => void d.logs.push(l),
    ...over,
  };
  return d as never;
}

describe("upstreamAuth", () => {
  it("adds an API key profile's key as x-api-key", async () => {
    const a = await upstreamAuth({ type: "api-key", keyFile: "/k" }, "sk-real", "https://api.example.test", deps());
    expect(await a()).toEqual({ "x-api-key": "sk-real" });
  });

  it("exchanges a fresh identity token with the SDK's own jwt-bearer exchange, once, and reuses the access token", async () => {
    const ep = await tokenEndpoint(() => ({ status: 200, body: { access_token: "sk-ant-oat-access", token_type: "Bearer", expires_in: 3600 } }));
    try {
      const d = deps();
      const auth = await upstreamAuth(wif(), undefined, ep.url, d);
      expect(ep.seen.length).toBe(1);
      expect(await auth()).toEqual({ authorization: "Bearer sk-ant-oat-access", "anthropic-beta": OAUTH_BETA });
      expect(await auth()).toEqual({ authorization: "Bearer sk-ant-oat-access", "anthropic-beta": OAUTH_BETA });
      expect(ep.seen.length).toBe(1);
      expect(ep.seen[0]!.url).toBe("/v1/oauth/token");
      expect(ep.seen[0]!.body).toEqual({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: "id.jwt.1",
        federation_rule_id: "fdrl_1",
        organization_id: "org-1",
        service_account_id: "svac_1",
        workspace_id: "wrkspc_1",
      });
    } finally {
      await ep.close();
    }
  });

  it("leaves out the workspace when the profile has none, and fails before any job when the exchange is refused", async () => {
    const ep = await tokenEndpoint(() => ({ status: 401, body: { error: "invalid_grant" } }));
    try {
      await expect(upstreamAuth(wif({ workspaceId: undefined }), undefined, ep.url, deps())).rejects.toThrow(/401/);
      expect(ep.seen[0]!.body["workspace_id"]).toBeUndefined();
    } finally {
      await ep.close();
    }
  });

  it("logs an advisory refresh failure by its name only", async () => {
    let made: ((err: unknown) => void) | undefined;
    const fake = deps({
      credentials: async () => ({
        oidcFederationProvider: () => "provider",
        TokenCache: class {
          constructor(_p: never, onErr?: (err: unknown) => void) {
            made = onErr;
          }
          async getToken() {
            return "t";
          }
        },
      }),
    });
    await upstreamAuth(wif(), undefined, "https://api.example.test", fake);
    made!(new RangeError("eyJ secret"));
    expect(fake.logs).toEqual(["token refresh failed: RangeError"]);
  });

  it("bounds the identity mint and every exchange call by time", async () => {
    let signal: AbortSignal | undefined;
    const fake = deps({
      fetch: (async (_u: string, init?: RequestInit) => {
        signal = init!.signal!;
        return new Response(JSON.stringify({ access_token: "a", expires_in: 60 }), { status: 200 });
      }) as never,
    });
    await upstreamAuth(wif(), undefined, "http://127.0.0.1:9", fake);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(AUTH_TIMEOUT_MS).toBe(30_000);
  });
});

describe("within", () => {
  it("passes a value through and rejects a promise that takes too long", async () => {
    expect(await within(Promise.resolve(1), 50, "x")).toBe(1);
    await expect(within(new Promise(() => undefined), 5, "the identity token")).rejects.toThrow(/the identity token took longer than 0.005 s/);
  });
});
