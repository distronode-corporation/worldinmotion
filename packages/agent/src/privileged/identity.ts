// Identity tokens for Anthropic Workload Identity Federation, fetched by the privileged side
// only. Each call returns a fresh token: an exchange may use a token once (AWS STS tokens carry
// a single-use jti), so the broker asks for a new one on every refresh.

import type { Identity } from "./config.ts";

/** What fetching a token needs from the outside world, so tests can stand in for it. */
export interface IdentityDeps {
  /** `GetWebIdentityToken` through @aws-sdk/client-sts, loaded only when a profile uses it. */
  awsWebIdentityToken(input: { region: string; audience: string; durationSeconds: number }): Promise<string>;
  fetch(url: string, init: { method?: string; headers: Record<string, string>; body?: string }): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  readFile(path: string): Promise<string>;
}

const METADATA = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default";
const FLAVOR = { "Metadata-Flavor": "Google" };

export class IdentityError extends Error {
  override readonly name = "IdentityError";
}

async function body(res: { ok: boolean; status: number; text(): Promise<string> }, what: string): Promise<string> {
  // Error bodies can carry project and account ids: the status only.
  if (!res.ok) throw new IdentityError(`${what} answered HTTP ${res.status}`);
  return res.text();
}

function nonEmpty(token: string, what: string): string {
  const t = token.trim();
  if (t === "") throw new IdentityError(`${what} returned an empty token`);
  return t;
}

export async function fetchIdentityToken(identity: Identity, audience: string, deps: IdentityDeps): Promise<string> {
  switch (identity.type) {
    case "aws-sts":
      return nonEmpty(await deps.awsWebIdentityToken({ region: identity.region, audience, durationSeconds: identity.durationSeconds }), "AWS STS");
    case "gcp-metadata": {
      const url = `${METADATA}/identity?audience=${encodeURIComponent(audience)}&format=full`;
      return nonEmpty(await body(await deps.fetch(url, { headers: FLAVOR }), "the GCP metadata server"), "the GCP metadata server");
    }
    case "gcp-impersonate": {
      const access = JSON.parse(await body(await deps.fetch(`${METADATA}/token`, { headers: FLAVOR }), "the GCP metadata server")) as { access_token?: unknown };
      if (typeof access.access_token !== "string") throw new IdentityError("the GCP metadata server returned no access token");
      const url = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(identity.serviceAccount)}:generateIdToken`;
      const res = await deps.fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${access.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ audience, includeEmail: true }),
      });
      const out = JSON.parse(await body(res, "IAM Credentials generateIdToken")) as { token?: unknown };
      if (typeof out.token !== "string") throw new IdentityError("IAM Credentials generateIdToken returned no token");
      return nonEmpty(out.token, "IAM Credentials generateIdToken");
    }
    case "file":
      return nonEmpty(await deps.readFile(identity.path), identity.path);
  }
}

/** The real STS call, loaded on first use so nothing else pulls in the AWS SDK. */
export async function awsWebIdentityToken(input: { region: string; audience: string; durationSeconds: number }): Promise<string> {
  const { STSClient, GetWebIdentityTokenCommand } = await import("@aws-sdk/client-sts");
  const out = await new STSClient({ region: input.region }).send(
    new GetWebIdentityTokenCommand({ Audience: [input.audience], SigningAlgorithm: "RS256", DurationSeconds: input.durationSeconds }),
  );
  return out.WebIdentityToken ?? "";
}
