// Shared fixtures for the privileged runner's tests: configs, requests, and real signed frames
// between real device keys, so the sender check runs the protocol's own code.

import { b64u, createPrekey, deviceIdFromSignPub, encodeKeys, generateDeviceKeys, hash, sealMessage, type DeviceKeys, type Prekey, type Roster } from "@worldinmotion/protocol";

export const WIF = {
  type: "wif",
  organizationId: "org-1",
  federationRuleId: "fdrl_1",
  serviceAccountId: "svac_1",
  workspaceId: "wrkspc_1",
  identity: { type: "aws-sts", region: "us-east-1" },
};

export const MESH = "BwcHBwcHBwcHBwcHBwcHBw";
export const ADDRESS = "agents@server";

export interface Device {
  id: string;
  keys: DeviceKeys;
  sign: string;
  box: string;
}

export function device(): Device {
  const keys = generateDeviceKeys();
  return { id: deviceIdFromSignPub(keys.signPub), keys, sign: b64u.encode(keys.signPub), box: b64u.encode(keys.boxPub) };
}

export const SENDER = device();
export const RECIPIENT = device();
export const DEVICE = SENDER.id;

/** The recipient's key file, as the peer keeps it (plaintext, version 1). */
export const recipientKeyFile = (d: Device = RECIPIENT): string => `${JSON.stringify({ ...JSON.parse(encodeKeys(d.keys)), name: "server" })}\n`;

export function roster(devices: Device[] = [SENDER, RECIPIENT]): Roster {
  return {
    mesh: MESH,
    seq: 3,
    prev: "0".repeat(43),
    devices: devices.map((d, i) => ({ id: d.id, name: i === 0 ? "laptop" : `d${i}`, sign: d.sign, box: d.box, role: "member", added: 1 })),
    revoked: [],
    by: devices[0]!.id,
    at: 1,
    sig: "x".repeat(86),
  } as unknown as Roster;
}
void hash;

let seq = 0;
/** A frame from `from` to the recipient's session, as the relay would deliver it. */
export function seal(text: string, o: { from?: Device; to?: string; at?: number; kind?: "msg" | "task" | "result"; relayed?: boolean; derived?: boolean; prekey?: Prekey; reply_to?: string } = {}) {
  const from = o.from ?? SENDER;
  return sealMessage({
    roster: roster([from, RECIPIENT]),
    session: "dev",
    sid: "01JB0000000000000000000000",
    to: [o.to ?? ADDRESS],
    seq: ++seq,
    at: o.at ?? Date.now(),
    kind: o.kind ?? "msg",
    text,
    recipients: [RECIPIENT.id],
    ...(o.relayed === true ? { relayed: true } : {}),
    ...(o.derived === true ? { derived: true } : {}),
    ...(o.reply_to === undefined ? {} : { reply_to: o.reply_to }),
    ...(o.kind === "result" ? { status: "done" as const } : {}),
    ...(o.prekey === undefined ? {} : { prekeys: { [RECIPIENT.id]: o.prekey } }),
    sender: { deviceId: from.id, keys: from.keys },
  });
}

/** A prekey of the recipient and its prekey file. */
export function recipientPrekey(at = Date.now()): { prekey: Prekey; file: string } {
  const { prekey, secret } = createPrekey({ mesh: MESH, deviceId: RECIPIENT.id, signSec: RECIPIENT.keys.signSec, at });
  return { prekey, file: JSON.stringify({ v: 1, keys: [{ prekey, secret: b64u.encode(secret) }] }) };
}

export const SENDERS = { [SENDER.id]: { sign: SENDER.sign, box: SENDER.box } };
export const RECIPIENT_CFG = { home: "/var/lib/wim-agent", mesh: MESH, address: ADDRESS, user: "wim-agent" };

export function minimal(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, defaultProfile: "a", senders: SENDERS, recipient: RECIPIENT_CFG, profiles: { a: { auth: WIF } }, ...extra };
}

/** A v2 request carrying `frame`, with hints that agree with it. */
export function requestFor(frame: { id: string; [k: string]: unknown }, text: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 2, id: frame.id, from: { device: DEVICE, address: "dev@laptop" }, profile: "", text, frame, ...over };
}

export const request = (over: Record<string, unknown> = {}): Record<string, unknown> => {
  const frame = seal("hello");
  return requestFor(frame, "hello", over);
};
