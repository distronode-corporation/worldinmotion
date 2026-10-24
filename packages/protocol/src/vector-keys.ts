import { b64u } from "./encoding.ts";

/**
 * Public keys (b64u, signing and box) of every fixed key in the published test vectors (SPEC
 * section 16). Their secrets are public, so a client SHOULD refuse any of them as a device or
 * recovery key. A test keeps this list equal to what the vector generator produces.
 */
export const VECTOR_SEED_PUBLIC_KEYS: readonly string[] = Object.freeze([
  "2QO5h53aLgLg6K6eNajRQeOkKlsa-4lm2Cjsl3_-dvA",
  "6kH3FetGuoP9g0UMRQe150nqCATTZOpnDT4OX9208Ag",
  "OK7WeyfczvI48ifJFH3VcMGtsyxSESxYghViZcVGjiE",
  "RLm8q5SMCoJyhH7zHNev6nWAEtOyyY2B-JOj_RixQBE",
  "bu1IwhsPiNy9wT2jYoGuItKLWLjwX-E2HKYo5_qRrx0",
  "nqg65P-4zxYgqPm6yl7FX9TlEkJL0dB2uv5mlWyq0wM",
  "pqqYKnDgXrIcbjoYMTjxqC5cT1mmTo_K4CxtkVzCXXA",
  "qeQGTgme0RbNMaRN8tNFWceHWsAg58JZrNRKLJZES_Q",
  "sASUvGAkhzvxKkOaRsvJ9Y1Apm5pn7C8X33bUFvHWHg",
  "vt55Zzu0lLrj7NhBBlFLUsF4aQToTO5EHNZtx4qONKo",
]);

const VECTOR_KEYS: ReadonlySet<string> = new Set(VECTOR_SEED_PUBLIC_KEYS);

/** True when a public key (bytes or b64u) is one of the test-vector keys, whose secrets are public. */
export function isVectorKey(pub: Uint8Array | string): boolean {
  return VECTOR_KEYS.has(typeof pub === "string" ? pub : b64u.encode(pub));
}
