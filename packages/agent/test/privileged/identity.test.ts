import { describe, expect, it, vi } from "vitest";
import { awsWebIdentityToken, fetchIdentityToken, IdentityError, type IdentityDeps } from "../../src/privileged/identity.ts";

const AUD = "https://api.anthropic.com";
const res = (status: number, text: string) => ({ ok: status >= 200 && status < 300, status, text: async () => text });

function deps(over: Partial<IdentityDeps> = {}): IdentityDeps & { calls: Array<{ url: string; init: unknown }> } {
  const calls: Array<{ url: string; init: unknown }> = [];
  return {
    calls,
    awsWebIdentityToken: async () => "aws.jwt",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return res(200, "gcp.jwt");
    },
    readFile: async () => "file.jwt\n",
    ...over,
  };
}

describe("fetchIdentityToken", () => {
  it("asks AWS STS with the region, audience and duration", async () => {
    const aws = vi.fn(async () => " aws.jwt ");
    expect(await fetchIdentityToken({ type: "aws-sts", region: "eu-west-1", durationSeconds: 300 }, AUD, deps({ awsWebIdentityToken: aws }))).toBe("aws.jwt");
    expect(aws).toHaveBeenCalledWith({ region: "eu-west-1", audience: AUD, durationSeconds: 300 });
  });

  it("reads a GCP metadata identity token for the audience", async () => {
    const d = deps();
    expect(await fetchIdentityToken({ type: "gcp-metadata" }, AUD, d)).toBe("gcp.jwt");
    expect(d.calls[0]!.url).toBe(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=https%3A%2F%2Fapi.anthropic.com&format=full",
    );
    expect(d.calls[0]!.init).toEqual({ headers: { "Metadata-Flavor": "Google" }, signal: expect.any(AbortSignal) });
  });

  it("impersonates a service account through IAM Credentials", async () => {
    const answers = [res(200, JSON.stringify({ access_token: "ya29" })), res(200, JSON.stringify({ token: "sa.jwt" }))];
    const d = deps({ fetch: async (url, init) => (d.calls.push({ url, init }), answers.shift()!) });
    expect(await fetchIdentityToken({ type: "gcp-impersonate", serviceAccount: "worker@example.com" }, AUD, d)).toBe("sa.jwt");
    expect(d.calls[1]!.url).toBe("https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/worker%40example.com:generateIdToken");
    expect(d.calls[1]!.init).toEqual({
      method: "POST",
      headers: { Authorization: "Bearer ya29", "Content-Type": "application/json" },
      body: JSON.stringify({ audience: AUD, includeEmail: true }),
      signal: expect.any(AbortSignal),
    });
  });

  it("refuses missing fields and error statuses, naming the status only", async () => {
    const imp = { type: "gcp-impersonate", serviceAccount: "a@b" } as const;
    await expect(fetchIdentityToken(imp, AUD, deps({ fetch: async () => res(200, "{}") }))).rejects.toThrow(/no access token/);
    const second = (r: ReturnType<typeof res>) => {
      const answers = [res(200, JSON.stringify({ access_token: "t" })), r];
      return deps({ fetch: async () => answers.shift()! });
    };
    await expect(fetchIdentityToken(imp, AUD, second(res(200, "{}")))).rejects.toThrow(/returned no token/);
    await expect(fetchIdentityToken(imp, AUD, second(res(403, "secret project 123")))).rejects.toThrow(/^IAM Credentials generateIdToken answered HTTP 403$/);
    await expect(fetchIdentityToken({ type: "gcp-metadata" }, AUD, deps({ fetch: async () => res(404, "") }))).rejects.toThrow(IdentityError);
  });

  it("reads a token file afresh and refuses an empty token", async () => {
    expect(await fetchIdentityToken({ type: "file", path: "/run/t" }, AUD, deps())).toBe("file.jwt");
    await expect(fetchIdentityToken({ type: "file", path: "/run/t" }, AUD, deps({ readFile: async () => " \n" }))).rejects.toThrow(/\/run\/t returned an empty token/);
  });
});

vi.mock("@aws-sdk/client-sts", () => {
  class GetWebIdentityTokenCommand {
    readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class STSClient {
    static last: { region: string; sent: unknown } | undefined;
    readonly region: string;
    constructor(o: { region: string }) {
      this.region = o.region;
    }
    async send(cmd: GetWebIdentityTokenCommand) {
      STSClient.last = { region: this.region, sent: cmd.input };
      return (cmd.input as { DurationSeconds: number }).DurationSeconds === 1 ? {} : { WebIdentityToken: "sts.jwt" };
    }
  }
  return { STSClient, GetWebIdentityTokenCommand };
});

describe("awsWebIdentityToken", () => {
  it("sends GetWebIdentityToken with RS256 for the audience", async () => {
    const sts = (await import("@aws-sdk/client-sts")) as unknown as { STSClient: { last: unknown } };
    expect(await awsWebIdentityToken({ region: "ca-west-1", audience: AUD, durationSeconds: 600 })).toBe("sts.jwt");
    expect(sts.STSClient.last).toEqual({ region: "ca-west-1", sent: { Audience: [AUD], SigningAlgorithm: "RS256", DurationSeconds: 600 } });
  });
  it("returns an empty string when STS returns no token (refused by the caller)", async () => {
    expect(await awsWebIdentityToken({ region: "ca-west-1", audience: AUD, durationSeconds: 1 })).toBe("");
  });
});
