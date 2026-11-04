// The wire schemas of CI senders (SPEC section 18), apart from ci.ts so that frames.ts can use
// them without importing the sealing and token code (which would make an import cycle).

import { z } from "zod";
import { fitsUtf8 } from "./encoding.ts";
import { LIMITS } from "./limits.ts";
import { prekeySchema } from "./prekey.ts";
import { cursorSchema, deviceIdSchema, keySchema, meshIdSchema, nameSchema, seqSchema, sigSchema, timeSchema, ulidSchema } from "./schema.ts";

/** Where a notice comes from. */
export type CiVia = "github" | "gitlab";
export const viaSchema = z.enum(["github", "gitlab"]);

const JWT_TEXT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const tokenSchema = z.string().max(LIMITS.ciTokenBytes).regex(JWT_TEXT);
const ciTextSchema = z.string().refine((s) => fitsUtf8(s, LIMITS.ciTextBytes), { message: "text is over 4 KiB" });

/** A notice's box: scheme 2 only (SPEC section 18). */
const ciBoxSchema = z.strictObject({ s: z.literal(2), p: deviceIdSchema, e: keySchema, c: z.string().min(22).max(LIMITS.ciRequestBytes) });

const noticeFields = {
  t: z.literal("ci.send"),
  mesh: meshIdSchema,
  id: ulidSchema,
  device: deviceIdSchema,
  to: nameSchema,
  at: timeSchema,
  via: viaSchema,
  otk: keySchema.optional(),
  xk: keySchema,
  box: ciBoxSchema,
  sig: sigSchema.optional(),
};

/** A GitHub notice carries its one-time key and signature; a GitLab one carries neither. */
const bound = (n: { via: CiVia; otk?: string; sig?: string }): boolean =>
  n.via === "github" ? n.otk !== undefined && n.sig !== undefined : n.otk === undefined && n.sig === undefined;

/** A notice as the relay stores and delivers it: the `ci.send` request without `token`. */
export const ciNoticeSchema = z.strictObject(noticeFields).refine(bound, { message: "a github notice has otk and sig, a gitlab one neither" });

/** A `ci.send` request: the notice, and for GitHub the token the relay verifies. */
export const ciSendRequestSchema = z
  .strictObject({ ...noticeFields, token: tokenSchema.optional() })
  .refine(bound, { message: "a github notice has otk and sig, a gitlab one neither" })
  .refine((r) => (r.via === "github") === (r.token !== undefined), { message: "a github request carries its token, a gitlab one never" });

/** A `ci.prekey` request. */
export const ciPrekeyRequestSchema = z.strictObject({ t: z.literal("ci.prekey"), device: deviceIdSchema, via: viaSchema });

/** The plaintext inside a notice's box. */
export const ciPlaintextSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal("ci"),
  id: ulidSchema,
  device: deviceIdSchema,
  to: nameSchema,
  at: timeSchema,
  text: ciTextSchema,
  token: tokenSchema,
});

/** `ci.rules` from a session after `ready`: the device's rule tags and whether it takes GitLab notices. */
export const ciRulesFrameSchema = z.strictObject({
  t: z.literal("ci.rules"),
  tags: z.array(deviceIdSchema).max(LIMITS.ciRuleTags),
  gitlab: z.boolean(),
});

/** The relay's answer to `ci.rules`: how many tags it holds for the device. */
export const ciRulesAnswerSchema = z.looseObject({ t: z.literal("ci.rules"), count: cursorSchema });

/** A notice delivered from the session's queue; acknowledged with `ack` like a `deliver`. */
export const ciDeliverFrameSchema = z.looseObject({ t: z.literal("ci.deliver"), cursor: seqSchema, msg: ciNoticeSchema });

/** The relay's HTTP answers to a CI sender. */
export const ciPrekeyAnswerSchema = z.looseObject({ t: z.literal("ci.prekey"), prekey: prekeySchema });
export const CI_SENT_STATUSES = ["routed", "queued", "unknown", "full", "limited"] as const;
export const ciSentSchema = z.looseObject({ t: z.literal("ci.sent"), id: ulidSchema, status: z.enum(CI_SENT_STATUSES) });

export type CiNotice = z.infer<typeof ciNoticeSchema>;
export type CiSendRequest = z.infer<typeof ciSendRequestSchema>;
export type CiPrekeyRequest = z.infer<typeof ciPrekeyRequestSchema>;
export type CiRequest = CiSendRequest | CiPrekeyRequest;
export type CiPlaintext = z.infer<typeof ciPlaintextSchema>;
export type CiRulesFrame = z.infer<typeof ciRulesFrameSchema>;
export type CiDeliverFrame = z.infer<typeof ciDeliverFrameSchema>;
export type CiSentStatus = (typeof CI_SENT_STATUSES)[number];

