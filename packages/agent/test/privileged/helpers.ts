// Shared fixtures for the privileged runner's tests.

export const WIF = {
  type: "wif",
  organizationId: "org-1",
  federationRuleId: "fdrl_1",
  serviceAccountId: "svac_1",
  workspaceId: "wrkspc_1",
  identity: { type: "aws-sts", region: "us-east-1" },
};

export function minimal(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, defaultProfile: "a", profiles: { a: { auth: WIF } }, ...extra };
}

export const DEVICE = "Kq2SjZ8JWIx6Ui6N7hzit7";

export const request = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  id: "m-1",
  from: { device: DEVICE, address: "dev@laptop" },
  profile: "",
  text: "hello",
  ...over,
});
