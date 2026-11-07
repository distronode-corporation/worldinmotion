// What a relay says about itself at `GET /v1/info` (SPEC section 11): the relay's claim, never a
// trust input. Unknown keys are dropped, and a field a newer relay added is optional, so an older
// relay's document still parses.

import { z } from "zod";

/** The `/v1/info` document. `ci` and `ciPatterns` are absent from relays older than them, which means false. */
export const relayInfoSchema = z.object({
  v: z.literal(1),
  software: z.literal("worldinmotion-relay"),
  version: z.string().max(64),
  create: z.enum(["key", "open", "closed"]),
  limits: z.object({
    max_meshes: z.number().int().nonnegative().nullable(),
    idle_mesh_days: z.number().int().nonnegative().nullable(),
    blob_bytes_per_mesh_per_day: z.number().int().nonnegative(),
  }),
  offer: z.string().max(280).nullable(),
  /** Whether the relay takes CI senders (SPEC section 18). */
  ci: z.boolean().optional(),
  /** Whether the relay checks ref pattern tags on GitHub CI notices (SPEC section 18). */
  ciPatterns: z.boolean().optional(),
});

export type RelayInfoDocument = z.infer<typeof relayInfoSchema>;
