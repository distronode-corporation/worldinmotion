// `wim ci notify`: a CI job's one notice to one session (SPEC section 18). The GitHub Action and
// the GitLab component wrap this. It never fails the job: every outcome is one printed line and
// exit code 0. Before it transmits anything it checks that the token it holds is wim's own (one
// audience, `wimci1.`, for this recipient), so it never hands the relay a credential a cloud
// provider would accept. The token is never printed.

import {
  checkSendAudience,
  ciOneTimeKey,
  ciPrekeyAnswerSchema,
  ciSentSchema,
  findSecrets,
  fitsUtf8,
  githubAudience,
  gitlabAudience,
  isName,
  LIMITS,
  parseCiRecipientCode,
  parseJson,
  relayDialUrl,
  sealCiNotice,
  unverifiedPayload,
  verifyCiPrekey,
  type CiRecipient,
  type CiVia,
} from "@worldinmotion/protocol";

/** The variable a GitLab job declares under `id_tokens:` for wim; no other token variable is ever read. */
export const GITLAB_TOKEN_VAR = "WIM_CI_ID_TOKEN";
/** Where a job may keep the recipient code instead of passing `--recipient`. */
export const RECIPIENT_VAR = "WIM_CI_RECIPIENT";

export type NotifyRequest = { recipient?: string; to?: string; text?: string; via?: string };
export type NotifyIO = { env: Record<string, string | undefined>; fetch: typeof fetch; now: () => number };
/** One line for the job's log; `sent` when the relay took the notice. */
export type NotifyOutcome = { sent: boolean; line: string };

/** A refusal before or while sending, with the line the job's log shows. */
class NotSent extends Error {}

const notSent = (why: string): never => {
  throw new NotSent(why);
};

/** What each relay status means for the job's log. */
const SENT_LINES: Readonly<Record<string, (to: string) => NotifyOutcome>> = {
  routed: (to) => ({ sent: true, line: `wim ci notify: sent to ${to}, delivered now.` }),
  queued: (to) => ({ sent: true, line: `wim ci notify: sent to ${to}, queued (it is offline now; kept up to 24 hours).` }),
  unknown: (to) => ({
    sent: false,
    line: `wim ci notify: not delivered: no session named ${to} on that device takes CI notices (it is not running, or its client is too old for CI notices).`,
  }),
  full: (to) => ({ sent: false, line: `wim ci notify: not delivered: ${to}'s queue of CI notices is full.` }),
  limited: () => ({ sent: false, line: "wim ci notify: not delivered: too many notices from this repository for now; try again later." }),
};

/** Which provider the job runs on: `--via`, else the provider's own variables. */
function viaOf(req: NotifyRequest, env: Record<string, string | undefined>): CiVia {
  const via = req.via ?? (env["GITHUB_ACTIONS"] === "true" ? "github" : env["GITLAB_CI"] === "true" ? "gitlab" : undefined);
  if (via !== "github" && via !== "gitlab") return notSent("not a GitHub Actions or GitLab CI/CD job (pass --via github or --via gitlab)");
  return via;
}

/** Asks GitHub for a token whose audience names the one-time key (the job needs `id-token: write`). */
async function githubToken(io: NotifyIO, aud: string): Promise<string> {
  const url = io.env["ACTIONS_ID_TOKEN_REQUEST_URL"];
  const bearer = io.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  if (url === undefined || url === "" || bearer === undefined || bearer === "") {
    return notSent("no ID token: give the job `permissions: id-token: write`");
  }
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return notSent("ACTIONS_ID_TOKEN_REQUEST_URL is not a URL");
  }
  target.searchParams.set("audience", aud);
  const res = await io.fetch(target, { headers: { authorization: `bearer ${bearer}`, accept: "application/json" }, redirect: "error" }).catch(() => notSent("GitHub's ID token service could not be reached"));
  if (res.status !== 200) return notSent(`GitHub's ID token service answered HTTP ${res.status}`);
  const body = parseJson(await res.text());
  const value = body.ok ? (body.value as { value?: unknown } | null)?.value : undefined;
  return typeof value === "string" ? value : notSent("GitHub's ID token service gave no token");
}

/** The token, checked to be wim's own for this recipient before anything is transmitted. */
async function tokenFor(via: CiVia, r: CiRecipient, io: NotifyIO): Promise<{ token: string; otk?: { pub: string; sec: Uint8Array } }> {
  const otk = via === "github" ? ciOneTimeKey() : undefined;
  const expected = otk === undefined ? gitlabAudience(r.mesh, r.device) : githubAudience(r.mesh, r.device, otk.pub);
  const token = otk === undefined ? (io.env[GITLAB_TOKEN_VAR] ?? "") : await githubToken(io, expected);
  if (token === "") return notSent(`no ID token in ${GITLAB_TOKEN_VAR}: declare it under the job's id_tokens: with aud ${expected}`);
  const payload = unverifiedPayload(token);
  if (!payload.ok) return notSent("the ID token does not parse");
  const aud = checkSendAudience(payload.value, expected);
  if (!aud.ok) {
    const why: Record<string, string> = {
      aud_array: "the ID token has several audiences",
      not_wim_audience: "the ID token's audience is not one string starting with wimci1.",
      wrong_audience: "the ID token's audience is for another device or mesh",
    };
    // Such a token may be a credential some service accepts: it is sent nowhere.
    return notSent(`${why[aud.reason]!}; refusing to send it anywhere`);
  }
  return otk === undefined ? { token } : { token, otk };
}

/** One POST to the relay's CI endpoint; the JSON answer, or a refusal line for any error status. */
async function post(io: NotifyIO, url: string, body: object): Promise<unknown> {
  const res = await io.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error" }).catch(() => notSent("the relay could not be reached"));
  const text = await res.text().catch(() => "");
  if (res.status === 200) {
    const json = parseJson(text);
    return json.ok ? json.value : notSent("the relay's answer does not parse");
  }
  const why: Record<number, string> = {
    403: "the relay refused: the device takes no CI notices from this provider (on it, run `wim ci allow`), or the token failed the relay's checks",
    404: "this relay takes no CI senders (it is older, or its operator has not turned them on)",
    413: "the relay refused: the request is too large",
    429: `the relay limited this address; retry after ${res.headers.get("retry-after") ?? "a minute"} s`,
  };
  return notSent(why[res.status] ?? `the relay answered HTTP ${res.status}`);
}

/** The relay's CI endpoint for a recipient: its URL read as http(s), then `/v1/<mesh>/ci`. */
export function ciEndpoint(r: { relay: string; mesh: string }): string {
  return `${relayDialUrl(r.relay, r.mesh).replace(/^ws/, "http")}/ci`;
}

async function send(req: NotifyRequest, io: NotifyIO): Promise<NotifyOutcome> {
  const code = parseCiRecipientCode(req.recipient ?? io.env[RECIPIENT_VAR]);
  if (!code.ok) return notSent(`the recipient code is missing or not a wimci1_ code (pass --recipient or set ${RECIPIENT_VAR})`);
  const r = code.value;
  const to = req.to;
  if (!isName(to)) return notSent("--to must name the session, 1 to 32 of a-z, 0-9 and -");
  const text = req.text ?? "";
  if (text === "") return notSent("no text");
  if (!fitsUtf8(text, LIMITS.ciTextBytes)) return notSent(`the text is over ${LIMITS.ciTextBytes} bytes`);
  const secrets = findSecrets(text);
  if (secrets.length > 0) return notSent(`the text appears to contain a secret (${secrets.join(", ")})`);
  const via = viaOf(req, io.env);
  const { token, otk } = await tokenFor(via, r, io);
  const url = ciEndpoint(r);
  const pkAnswer = ciPrekeyAnswerSchema.safeParse(await post(io, url, { t: "ci.prekey", device: r.device, via }));
  if (!pkAnswer.success) return notSent("the relay's prekey answer is malformed");
  const prekey = verifyCiPrekey(pkAnswer.data.prekey, r, io.now());
  if (!prekey.ok) {
    if (prekey.reason === "expired") return notSent("the device has no usable prekey (it has been offline for more than 48 hours)");
    return notSent(`the relay's prekey for that device does not verify (${prekey.reason})`);
  }
  const { request } = sealCiNotice({ mesh: r.mesh, device: r.device, prekey: prekey.value, to, text, token, via, ...(otk === undefined ? {} : { otk }), at: io.now() });
  const sent = ciSentSchema.safeParse(await post(io, url, request));
  if (!sent.success || sent.data.id !== request.id) return notSent("the relay's answer is malformed");
  return SENT_LINES[sent.data.status]!(to);
}

/**
 * Sends one CI notice. Never throws and never prints the token: every outcome, a refusal
 * included, comes back as one line for the job's log.
 */
export async function ciNotify(req: NotifyRequest, io: NotifyIO): Promise<NotifyOutcome> {
  try {
    return await send(req, io);
  } catch (error) {
    // Anything not foreseen (a seal that throws) is named by its kind only.
    const why = error instanceof NotSent ? error.message : `an unexpected ${(error as Error).name}`;
    return { sent: false, line: `wim ci notify: not sent: ${why}.` };
  }
}
