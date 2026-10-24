import { describe, expect, it } from "vitest";
import { isMeshId, isRelayUrl, relayDialUrl } from "../src/index.ts";
import { mesh } from "./helpers.ts";

describe("relay URLs", () => {
  it("accepts wss anywhere and ws only to loopback", () => {
    for (const good of [
      "wss://relay.example",
      "wss://relay.example:8443",
      "wss://relay.example/wim",
      "ws://localhost:8787",
      "ws://127.0.0.1",
      "ws://127.9.8.7:1",
      "ws://[::1]:8787",
    ]) {
      expect(isRelayUrl(good), good).toBe(true);
    }
  });

  it("refuses other spellings rather than normalising them", () => {
    for (const bad of [
      "ws://relay.example",
      "ws://localhost.evil.example",
      "ws://128.0.0.1",
      "https://relay.example",
      "wss://relay.example/",
      "wss://relay.example?x=1",
      "wss://relay.example#x",
      "wss://user:pw@relay.example",
      "wss://relay example",
      "wss://[bad",
      "wss://",
      "wss://" + "a".repeat(2050),
      5,
    ]) {
      expect(isRelayUrl(bad), String(bad)).toBe(false);
    }
  });

  it("relayDialUrl appends /v1/<mesh id>", () => {
    const meshId = mesh().chain[0]!.mesh;
    expect(relayDialUrl("wss://relay.example", meshId)).toBe(`wss://relay.example/v1/${meshId}`);
    expect(() => relayDialUrl("wss://relay.example/", meshId)).toThrow(/relay URL/);
    expect(() => relayDialUrl("wss://relay.example", "nope")).toThrow(/mesh id/);
  });

  it("isMeshId takes exactly 16 bytes of canonical base64url", () => {
    expect(isMeshId(mesh().chain[0]!.mesh)).toBe(true);
    // 22 characters, but the last one carries bits that 16 bytes do not have (not canonical).
    for (const bad of ["", "short", "A".repeat(21), "A".repeat(23), "AAAAAAAAAAAAAAAAAAAAA!", "AAAAAAAAAAAAAAAAAAAAAB", 16, null]) {
      expect(isMeshId(bad), String(bad)).toBe(false);
    }
  });
});
