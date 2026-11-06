import { describe, expect, it } from "vitest";
import { relayInfoSchema } from "../src/index.ts";

const doc = {
  v: 1,
  software: "worldinmotion-relay",
  version: "0.1.10",
  create: "open",
  limits: { max_meshes: null, idle_mesh_days: 90, blob_bytes_per_mesh_per_day: 1024 },
  offer: null,
};

describe("relayInfoSchema", () => {
  it("reads a relay older than CI senders and ref patterns, the flags absent", () => {
    const parsed = relayInfoSchema.parse(doc);
    expect(parsed.ci).toBeUndefined();
    expect(parsed.ciPatterns).toBeUndefined();
    expect(relayInfoSchema.parse({ ...doc, ci: true })).toEqual({ ...doc, ci: true });
  });

  it("reads both flags, and drops keys it does not know", () => {
    expect(relayInfoSchema.parse({ ...doc, ci: true, ciPatterns: true, future: 1 })).toEqual({ ...doc, ci: true, ciPatterns: true });
  });

  it("refuses a flag that is not a boolean, and a document that is not one", () => {
    expect(relayInfoSchema.safeParse({ ...doc, ciPatterns: "true" }).success).toBe(false);
    expect(relayInfoSchema.safeParse({ ...doc, ci: 1 }).success).toBe(false);
    expect(relayInfoSchema.safeParse({ ...doc, software: "other" }).success).toBe(false);
  });
});
