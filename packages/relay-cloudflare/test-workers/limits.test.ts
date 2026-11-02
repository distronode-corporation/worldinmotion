import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { b64u, createGenesisRoster, LIMITS, randomBytes, signRecoverAuth } from "@worldinmotion/protocol";
import { describe, expect, it } from "vitest";
import { sourceKey } from "@worldinmotion/relay-core";
import { createMesh, dev, meshId, RELAY, Session, Socket } from "./helpers.ts";

const MiB = 1024 * 1024;

/** A frame of exactly `bytes` UTF-8 bytes. */
function padded(t: string, bytes: number): string {
  const head = `{"t":"${t}","x":"`;
  return head + "a".repeat(bytes - head.length - 2) + '"}';
}

function limiter(ip: string) {
  return env.SOURCES.get(env.SOURCES.idFromName(sourceKey(ip)));
}

async function limiterRows(ip: string): Promise<unknown[]> {
  return runInDurableObject(limiter(ip), (_o, state) => state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'bucket'").toArray());
}

/** Opens a socket from `ip` on a fresh mesh and sends a create; returns the answer and the socket. */
async function createFrom(ip: string): Promise<{ answer: Record<string, any>; sock: Socket }> {
  const mesh = meshId();
  const admin = dev("admin", "admin");
  const sock = await Socket.open(mesh, { "cf-connecting-ip": ip });
  await sock.next("hello");
  sock.send({ t: "create", roster: createGenesisRoster({ name: "admin", keys: admin.keys, now: Date.now(), meshId: mesh }) });
  return { answer: await sock.next(), sock };
}

describe("frame size limits", () => {
  it("refuses a frame over 16 KiB before auth, and closes the connection", async () => {
    const s = await Socket.open(meshId());
    await s.next("hello");
    s.send(padded("create", LIMITS.preAuthFrameBytes + 1));
    expect(await s.next("error")).toMatchObject({ code: "too_large" });
    expect(await s.closedWith()).toMatchObject({ code: 4008 });
  });

  it("takes a 1 MiB frame after auth and refuses one byte more, keeping the connection", async () => {
    const m = await createMesh();
    const root = new Session(m.mesh, m.admin, "root");
    await root.connect(m.genesis);
    // Exactly the limit is read (and is malformed here); one byte over is refused unparsed.
    expect(await root.sock.ask(padded("ping", LIMITS.frameBytes), "error")).toMatchObject({ code: "malformed" });
    expect(await root.sock.ask(padded("ping", LIMITS.frameBytes + 1), "error")).toMatchObject({ code: "too_large", message: "frame is too large" });
    expect(await root.sock.ask(padded("ping", 2 * MiB), "error")).toMatchObject({ code: "too_large" });
    expect(await root.sock.ask({ t: "ping" }, "pong")).toEqual({ t: "pong" });
  });
});

describe("the create and join limit per source address", () => {
  it("counts creates from one address across meshes, then refuses, until the bucket expires", async () => {
    const ip = "198.51.100.9";
    for (let i = 0; i < LIMITS.createJoinPerSourcePerHour; i++) {
      const { answer, sock } = await createFrom(ip);
      expect(answer, `create ${i}`).toMatchObject({ t: "roster" });
      sock.close();
    }
    const { answer, sock } = await createFrom(ip);
    expect(answer).toMatchObject({ t: "error", code: "limited", ref: "create" });
    expect(await sock.closedWith()).toMatchObject({ code: 4029 });

    // A join from the same address on another existing mesh is limited too.
    const m = await createMesh();
    const joiner = await Socket.open(m.mesh, { "cf-connecting-ip": ip });
    await joiner.next("hello");
    const body = { t: "join", mesh: m.mesh, invite: "A".repeat(22), device: { id: "A".repeat(22), name: "x", sign: "A".repeat(43), box: "A".repeat(43) }, nonce: "A".repeat(43), sig: "A".repeat(86), proof: "A".repeat(43) };
    joiner.send(body);
    expect(await joiner.next("error")).toMatchObject({ code: "limited", ref: "join" });

    // Another address is unaffected.
    expect((await createFrom("198.51.100.10")).answer).toMatchObject({ t: "roster" });

    // The bucket's alarm deletes it an hour after its last use; the address starts afresh.
    expect(await runDurableObjectAlarm(limiter(ip))).toBe(true);
    expect(await limiterRows(ip)).toEqual([]);
    expect((await createFrom(ip)).answer).toMatchObject({ t: "roster" });
  });

  it("counts every recovery attempt from one address, before its signature is checked", async () => {
    const ip = "198.51.100.30";
    const m = await createMesh();
    const recoverFrom = async (from: string): Promise<Record<string, any>> => {
      const sock = await Socket.open(m.mesh, { "cf-connecting-ip": from });
      const nonce = (await sock.next("hello"))["nonce"] as string;
      sock.send(signRecoverAuth({ relay: RELAY, mesh: m.mesh, nonce, at: Date.now(), genesis: b64u.encode(randomBytes(32)) }, m.admin.keys));
      return sock.next("error");
    };
    for (let i = 0; i < LIMITS.createJoinPerSourcePerHour; i++) {
      expect(await recoverFrom(ip), `attempt ${i}`).toMatchObject({ code: "unauthorized", ref: "auth" });
    }
    expect(await recoverFrom(ip)).toMatchObject({ code: "limited", message: "too many recovery attempts from this address", ref: "auth" });
    // Another address is unaffected, and its attempt is checked as usual.
    expect(await recoverFrom("198.51.100.31")).toMatchObject({ code: "unauthorized", ref: "auth" });
  });

  it("spends nothing on auth, on malformed frames or after auth", async () => {
    const ip = "198.51.100.20";
    const m = await createMesh();
    // A malformed create is refused before the limiter is asked.
    const bad = await Socket.open(m.mesh, { "cf-connecting-ip": ip });
    await bad.next("hello");
    bad.send({ t: "create" });
    expect(await bad.next("error")).toMatchObject({ code: "malformed" });
    // An auth is not a create or join.
    const root = new Session(m.mesh, m.admin, "root");
    const sock = await Socket.open(m.mesh, { "cf-connecting-ip": ip });
    await root.connect(m.genesis, { sock });
    // After auth, a create is answered by the relay without a source check.
    expect(await root.sock.ask({ t: "create", roster: m.genesis }, "error")).toMatchObject({ code: "unauthorized", ref: "create" });
    expect(await limiterRows(ip)).toEqual([]);
  });
});
