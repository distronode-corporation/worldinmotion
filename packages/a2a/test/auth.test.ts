import { describe, expect, it } from "vitest";
import { bearerMatches, MIN_TOKEN_LENGTH, readToken } from "../src/auth.ts";

const TOKEN = "s3cret-token-0123456789";

describe("readToken", () => {
  it("reads the named variable", () => {
    expect(readToken({ WIM_A2A_TOKEN: TOKEN }, "WIM_A2A_TOKEN")).toBe(TOKEN);
  });

  it("refuses a missing or empty variable, naming the variable and not a value", () => {
    expect(() => readToken({}, "WIM_A2A_TOKEN")).toThrow("environment variable WIM_A2A_TOKEN is not set");
    expect(() => readToken({ WIM_A2A_TOKEN: "" }, "WIM_A2A_TOKEN")).toThrow("is not set");
  });

  it("refuses a short token without echoing it", () => {
    let message = "";
    try {
      readToken({ T: "short-tok" }, "T");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe(`environment variable T must hold at least ${MIN_TOKEN_LENGTH} characters`);
    expect(message).not.toContain("short-tok");
  });
});

describe("bearerMatches", () => {
  it("accepts the token with the Bearer scheme, in any case, with spacing", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer   ${TOKEN} `, TOKEN)).toBe(true);
  });

  it("refuses anything else", () => {
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
    expect(bearerMatches("", TOKEN)).toBe(false);
    expect(bearerMatches(TOKEN, TOKEN)).toBe(false);
    expect(bearerMatches(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN.slice(1)}`, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN} extra`, TOKEN)).toBe(false);
  });
});
