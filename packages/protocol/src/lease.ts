import { b64u, sha256, utf8 } from "./encoding.ts";
import { PROTOCOL } from "./limits.ts";
import { meshIdSchema } from "./schema.ts";

/**
 * The key a relay knows a lease by (SPEC section 14):
 * `b64u(SHA-256(UTF-8("wim/1 lease " + meshId + " " + name)))`, first 22 characters. The relay
 * never sees the name, but a short or guessable name can be found by trying candidates, so the
 * key hides only names that are hard to guess.
 */
export function leaseKey(meshId: string, name: string): string {
  if (!meshIdSchema.safeParse(meshId).success) throw new TypeError("leaseKey: invalid mesh id");
  if (typeof name !== "string" || name.length === 0 || name.length > 256) {
    throw new TypeError("leaseKey: name must be 1 to 256 characters");
  }
  return b64u.encode(sha256(utf8(`${PROTOCOL} lease ${meshId} ${name}`))).slice(0, 22);
}
