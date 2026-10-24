import { createHash, timingSafeEqual } from "node:crypto";

/** A bearer token shorter than this is refused at startup. */
export const MIN_TOKEN_LENGTH = 16;

/**
 * Reads the inbound bearer token from the environment variable the config names. The token is
 * never logged or echoed: errors name the variable, not its value.
 */
export function readToken(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(`environment variable ${name} is not set`);
  if (value.length < MIN_TOKEN_LENGTH) {
    throw new Error(`environment variable ${name} must hold at least ${MIN_TOKEN_LENGTH} characters`);
  }
  return value;
}

/**
 * Checks an `Authorization` header against the expected bearer token in constant time. Both
 * sides are hashed first, so neither the comparison nor an early length check leaks the token.
 */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header ?? "");
  const presented = match?.[1] ?? "";
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}
