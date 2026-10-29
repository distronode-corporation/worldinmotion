// The channel between a session and an unlocked signer: keys from the hello, a counter as nonce.

import { b64u } from "@worldinmotion/protocol";
import { describe, expect, it } from "vitest";
import { Channel, channelFor, ephemeral, helloTranscript } from "../src/channel.ts";
import { unseal } from "../src/signer.ts";

function pair() {
  const client = ephemeral();
  const signer = ephemeral();
  const transcript = helloTranscript(new Uint8Array(32).fill(7), client.pub, signer.pub, { id: "i", name: "n", signPub: "s", boxPub: "b", locked: false, pid: 1 });
  return { client: channelFor("client", client.privateKey, signer.pub, transcript), signer: channelFor("signer", signer.privateKey, client.pub, transcript) };
}

describe("Channel", () => {
  it("opens what the other side sealed, in order, each way", () => {
    const { client, signer } = pair();
    expect(signer.open(client.seal("one"))).toBe("one");
    expect(signer.open(client.seal("two"))).toBe("two");
    expect(client.open(signer.seal("back"))).toBe("back");
  });

  it("refuses a line out of order, repeated, changed, from another channel, or not a sealed line at all", () => {
    const { client, signer } = pair();
    const first = client.seal("first");
    const second = client.seal("second");
    expect(signer.open(second)).toBeUndefined();
    expect(signer.open(first)).toBe("first");
    expect(signer.open(first)).toBeUndefined();
    const bytes = b64u.decode(second);
    bytes[0] = bytes[0]! ^ 1;
    expect(signer.open(b64u.encode(bytes))).toBeUndefined();
    expect(signer.open(pair().client.seal("second"))).toBeUndefined();
    expect(signer.open(second)).toBe("second");
    for (const junk of [undefined, 5, "!!", ""]) expect(signer.open(junk)).toBeUndefined();
    // Its own side's seal never opens on the same side.
    expect(client.open(client.seal("echo"))).toBeUndefined();
  });

  it("unseal takes a sealed line `{x}` and nothing else", () => {
    const { client, signer } = pair();
    expect(unseal(signer, JSON.stringify({ x: client.seal("text") }))).toBe("text");
    for (const line of ["not json", "null", "[1]", JSON.stringify({ y: 1 })]) expect(unseal(signer, line)).toBeUndefined();
  });

  it("a key pair's public half is 32 bytes and differs each time", () => {
    const a = ephemeral();
    const b = ephemeral();
    expect(a.pub).toHaveLength(32);
    expect(b64u.encode(a.pub)).not.toBe(b64u.encode(b.pub));
    expect(new Channel(new Uint8Array(32), new Uint8Array(32)).open(new Channel(new Uint8Array(32), new Uint8Array(32)).seal("same keys"))).toBe("same keys");
  });
});
