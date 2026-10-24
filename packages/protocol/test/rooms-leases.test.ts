import { describe, expect, it } from "vitest";
import { b64u, isRoom, leaseKey, roomName, sha256, utf8 } from "../src/index.ts";
import { mesh } from "./helpers.ts";

describe("rooms", () => {
  it("isRoom and roomName", () => {
    expect(isRoom("#ops")).toBe(true);
    expect(isRoom("#" + "a".repeat(32))).toBe(true);
    for (const bad of ["ops", "#", "#Ops", "#-ops", "#" + "a".repeat(33), "*", "a@b", 5]) expect(isRoom(bad), String(bad)).toBe(false);
    expect(roomName("#ops")).toBe("ops");
    expect(() => roomName("ops")).toThrow(/not a room/);
  });
});

describe("leaseKey", () => {
  const meshId = mesh().chain[0]!.mesh;

  it("is b64u(sha256('wim/1 lease ' + mesh + ' ' + name)) cut to 22", () => {
    expect(leaseKey(meshId, "deploy")).toBe(b64u.encode(sha256(utf8(`wim/1 lease ${meshId} deploy`))).slice(0, 22));
    expect(leaseKey(meshId, "deploy")).not.toBe(leaseKey(meshId, "deploy2"));
    expect(leaseKey(meshId, "x".repeat(256))).toHaveLength(22);
  });

  it("refuses a bad mesh id or name", () => {
    expect(() => leaseKey("x", "deploy")).toThrow(/mesh id/);
    expect(() => leaseKey(meshId, "")).toThrow(/name/);
    expect(() => leaseKey(meshId, "x".repeat(257))).toThrow(/name/);
    expect(() => leaseKey(meshId, 5 as unknown as string)).toThrow(/name/);
  });
});
