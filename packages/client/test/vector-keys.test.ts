// SPEC section 16: the published test vectors' secret keys are public, so the client refuses any
// of them as its own device key, a joiner's key, a recovery key, or a sender's key.

import { b64u, createJoin, deviceKeysFromSecrets, randomBytes, encodeKeys, hash, makeDeviceRecord, nextRoster, parseInvite, recoveryCode, sealMessage, ulid } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { decideJoin, issueInvite, publishRoster, recoverMesh } from "../src/admin.ts";
import { MeshFiles } from "../src/mesh.ts";
import { FS, makeMesh, newDevice, openSession, RELAY, RelayHarness } from "./helpers.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f().catch(() => undefined);
});

const hex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));
/** "alice" from packages/protocol/vectors/keys.json. */
const ALICE = deviceKeysFromSecrets(hex("f29e4dbfbca62fb64b51dbc3ecf2429581cc3006db6d4c31e5a00c067fa93cbf"), hex("6b23b2d70814d1c745ee964663d8788aaa3d45922e8c518bc24a34da87d049eb"));

describe("published test-vector keys", () => {
  it("are refused as this device's own key file", async () => {
    const d = await newDevice("real");
    await fs.writeFile(d.home.devicePath, `${JSON.stringify({ ...(JSON.parse(encodeKeys(ALICE)) as object), name: "alice" })}\n`, { mode: 0o600 });
    await expect(d.home.loadDevice()).rejects.toThrow(/holds a published test-vector key/);
  });

  it("are refused for a joining device", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const admin = await openSession(devices[0]!, mesh, relay, { name: "inviter", kind: "cli" });
    cleanup.push(() => admin.stop());
    const inv = await issueInvite(admin, { ttlMs: 60_000, auto: true, now: Date.now });
    const body = createJoin(parseInvite(inv.code), "alice", ALICE, b64u.encode(randomBytes(32)));
    expect(await decideJoin(admin, body, async () => true, Date.now)).toEqual({ outcome: "refused", reason: "the device holds a published test-vector key" });
  });

  it("are refused as a recovery code", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const genesis = (await new MeshFiles(devices[0]!.home.meshDir(mesh), FS).loadRoster(1))!;
    const code = recoveryCode(ALICE, { mesh, genesis: hash(genesis) });
    const fresh = await newDevice("fresh");
    await expect(recoverMesh({ home: fresh.home, device: fresh.device, code, relay: RELAY, revoke: [], dialer: relay.dialer, now: Date.now, confirm: async () => true })).rejects.toThrow(
      /refusing a recovery code built from a published test-vector key/,
    );
  });

  it("make a sender's messages dropped, even when an admin put the key in the roster", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one"]);
    const s = await openSession(devices[0]!, mesh, relay, { name: "agent" });
    cleanup.push(() => s.stop());
    const record = makeDeviceRecord("alice", ALICE, "member", Date.now());
    await publishRoster(s, (current) => nextRoster(current, { add: [record] }, { keys: s.device.keys }, Date.now()));
    const frame = sealMessage({
      roster: s.roster,
      sender: { deviceId: record.id, keys: ALICE },
      session: "x",
      sid: ulid(),
      to: ["agent@one"],
      seq: 1,
      at: Date.now(),
      id: ulid(),
      kind: "msg",
      text: "hi",
      recipients: [s.device.id],
    });
    expect(await s.receive(frame)).toBe("dropped");
  });
});
