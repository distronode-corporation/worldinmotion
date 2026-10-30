// The `wim events --json` contract (docs/events.md), version 1: types for each event and row,
// and a parser that turns one stdout line into an event, a response, or nothing. A line with any
// `v` other than 1 is refused; an unknown event type or field is ignored, because a newer client
// may add both. Only the fields named here are copied out of a line.

/** The inbound policies, as the client names them (test/contract.test.ts holds the two equal). */
export const POLICIES = ["deliver", "deliver-relayed", "hold", "refuse"] as const;
export type Policy = (typeof POLICIES)[number];
export type Presence = "idle" | "busy" | "offline";
export type MessageKind = "msg" | "task" | "result" | "file";
export type FileInfo = { name: string; size: number; mime: string };

export type DeviceRow = { name: string; id: string; role: "admin" | "member"; policy: Policy; self: boolean };
export type Card = { cwd?: string; branch?: string; title?: string };
export type SessionRow = {
  address: string;
  sid?: string;
  kind: string;
  status: Presence;
  since: number;
  rooms: string[];
  card?: Card;
  local: boolean;
};
export type MessageRow = {
  id: string;
  dir: "in" | "out";
  session: string;
  peer: string;
  device?: string;
  kind: MessageKind;
  text: string;
  reply_to?: string;
  status?: string;
  deadline?: number;
  file?: FileInfo;
  relayed?: true;
  derived?: true;
  unsolicited?: true;
  at: number;
  to?: string[];
};
export type HeldRow = {
  id: string;
  session: string;
  from: string;
  device: string;
  kind: MessageKind;
  at: number;
  preview: string;
  reason: "policy" | "breaker";
  file?: FileInfo;
};
export type RoomRow = { name: string; members: string[] };
export type LeaseRow = { name: string; holder: string; token: number; expires_at: number };
export type BreakerReason = "peer" | "total" | "pingpong";
export type BreakerRow = { peer: string; reason?: BreakerReason; at: number };
export type ReceiptStatus = "delivered" | "held" | "refused" | "expired";
/** Where the device keys are: in the client (a plaintext key file) or in the signer (`wim agent`). */
export type KeysAt = "local" | "signer";

export type WimEvent =
  | { type: "hello"; at: number; version: string; device: { name: string; id: string }; keys?: KeysAt; session: string; relay: string; mesh: string }
  | { type: "connection"; at: number; state: "connecting" | "open" | "closed"; detail?: string }
  | {
      type: "snapshot";
      at: number;
      devices: DeviceRow[];
      sessions: SessionRow[];
      rooms: RoomRow[];
      leases: LeaseRow[];
      held: HeldRow[];
      breakers: BreakerRow[];
    }
  | { type: "device"; at: number; device: DeviceRow }
  | { type: "device-removed"; at: number; name: string; id: string }
  | { type: "peer"; at: number; session: SessionRow }
  | { type: "peer-removed"; at: number; address: string }
  | { type: "message"; at: number; message: MessageRow }
  | { type: "receipt"; at: number; id: string; to: string; status: ReceiptStatus }
  | { type: "held"; at: number; op: "add" | "remove"; item: HeldRow }
  | { type: "lease"; at: number; lease: LeaseRow }
  | { type: "lease-released"; at: number; name: string }
  | { type: "breaker"; at: number; peer: string; state: "tripped" | "resumed"; reason?: BreakerReason };

export type WimResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: { code: string; message: string } };

export type Parsed =
  | { kind: "event"; event: WimEvent }
  | { kind: "response"; response: WimResponse }
  | { kind: "ignored"; type: string }
  | { kind: "invalid"; reason: string };

class ShapeError extends Error {}

type Obj = Record<string, unknown>;

function isObj(x: unknown): x is Obj {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function obj(x: unknown, where: string): Obj {
  if (!isObj(x)) throw new ShapeError(`${where} is not an object`);
  return x;
}

function str(o: Obj, k: string): string {
  const v = o[k];
  if (typeof v !== "string") throw new ShapeError(`${k} is not a string`);
  return v;
}

function num(o: Obj, k: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ShapeError(`${k} is not a number`);
  return v;
}

function bool(o: Obj, k: string): boolean {
  const v = o[k];
  if (typeof v !== "boolean") throw new ShapeError(`${k} is not a boolean`);
  return v;
}

function oneOf<T extends string>(o: Obj, k: string, allowed: readonly T[]): T {
  const v = str(o, k);
  if (!(allowed as readonly string[]).includes(v)) throw new ShapeError(`${k} is not one of ${allowed.join(", ")}`);
  return v as T;
}

function strings(o: Obj, k: string): string[] {
  const v = o[k];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new ShapeError(`${k} is not a list of strings`);
  return [...(v as string[])];
}

function list<T>(o: Obj, k: string, row: (x: unknown) => T): T[] {
  const v = o[k];
  if (!Array.isArray(v)) throw new ShapeError(`${k} is not a list`);
  return v.map(row);
}

/** Copies an optional field only when present; a present field of the wrong type is an error. */
function opt<T>(o: Obj, k: string, read: (o: Obj, k: string) => T): T | undefined {
  return o[k] === undefined ? undefined : read(o, k);
}

/** Builds an object without the keys whose value is undefined. */
function compact<T extends Obj>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

function flag(o: Obj, k: string): true | undefined {
  return o[k] === true ? true : undefined;
}

const KINDS = ["msg", "task", "result", "file"] as const;
const REASONS = ["peer", "total", "pingpong"] as const;

function file(o: Obj, k: string): FileInfo {
  const f = obj(o[k], k);
  return { name: str(f, "name"), size: num(f, "size"), mime: str(f, "mime") };
}

export function deviceRow(x: unknown): DeviceRow {
  const o = obj(x, "device");
  return { name: str(o, "name"), id: str(o, "id"), role: oneOf(o, "role", ["admin", "member"]), policy: oneOf(o, "policy", POLICIES), self: bool(o, "self") };
}

export function sessionRow(x: unknown): SessionRow {
  const o = obj(x, "session");
  const card = opt(o, "card", (o, k) => {
    const c = obj(o[k], k);
    return compact<Card>({ cwd: opt(c, "cwd", str), branch: opt(c, "branch", str), title: opt(c, "title", str) });
  });
  return compact<SessionRow>({
    address: str(o, "address"),
    sid: opt(o, "sid", str),
    kind: str(o, "kind"),
    status: oneOf(o, "status", ["idle", "busy", "offline"]),
    since: num(o, "since"),
    rooms: strings(o, "rooms"),
    card,
    local: bool(o, "local"),
  });
}

export function messageRow(x: unknown): MessageRow {
  const o = obj(x, "message");
  return compact<MessageRow>({
    id: str(o, "id"),
    dir: oneOf(o, "dir", ["in", "out"]),
    session: str(o, "session"),
    peer: str(o, "peer"),
    device: opt(o, "device", str),
    kind: oneOf(o, "kind", KINDS),
    text: str(o, "text"),
    reply_to: opt(o, "reply_to", str),
    status: opt(o, "status", str),
    deadline: opt(o, "deadline", num),
    file: opt(o, "file", file),
    relayed: flag(o, "relayed"),
    derived: flag(o, "derived"),
    unsolicited: flag(o, "unsolicited"),
    at: num(o, "at"),
    to: opt(o, "to", strings),
  });
}

function heldRow(x: unknown): HeldRow {
  const o = obj(x, "held");
  return compact<HeldRow>({
    id: str(o, "id"),
    session: str(o, "session"),
    from: str(o, "from"),
    device: str(o, "device"),
    kind: oneOf(o, "kind", KINDS),
    at: num(o, "at"),
    preview: str(o, "preview"),
    reason: oneOf(o, "reason", ["policy", "breaker"]),
    file: opt(o, "file", file),
  });
}

function roomRow(x: unknown): RoomRow {
  const o = obj(x, "room");
  return { name: str(o, "name"), members: strings(o, "members") };
}

function leaseRow(x: unknown): LeaseRow {
  const o = obj(x, "lease");
  return { name: str(o, "name"), holder: str(o, "holder"), token: num(o, "token"), expires_at: num(o, "expires_at") };
}

function breakerRow(x: unknown): BreakerRow {
  const o = obj(x, "breaker");
  return compact<BreakerRow>({ peer: str(o, "peer"), reason: opt(o, "reason", (o, k) => oneOf(o, k, REASONS)), at: num(o, "at") });
}

function event(o: Obj, type: string, at: number): WimEvent | undefined {
  switch (type) {
    case "hello": {
      const device = obj(o.device, "device");
      return compact({
        type,
        at,
        version: str(o, "version"),
        device: { name: str(device, "name"), id: str(device, "id") },
        // Added later, so optional; a value this extension does not know is ignored.
        keys: o.keys === "local" || o.keys === "signer" ? (o.keys as KeysAt) : undefined,
        session: str(o, "session"),
        relay: str(o, "relay"),
        mesh: str(o, "mesh"),
      });
    }
    case "connection":
      return compact({ type, at, state: oneOf(o, "state", ["connecting", "open", "closed"] as const), detail: opt(o, "detail", str) });
    case "snapshot":
      return {
        type,
        at,
        devices: list(o, "devices", deviceRow),
        sessions: list(o, "sessions", sessionRow),
        rooms: list(o, "rooms", roomRow),
        leases: list(o, "leases", leaseRow),
        held: list(o, "held", heldRow),
        breakers: list(o, "breakers", breakerRow),
      };
    case "device":
      return o.removed === true ? { type: "device-removed", at, name: str(o, "name"), id: str(o, "id") } : { type, at, device: deviceRow(o) };
    case "peer":
      return o.removed === true ? { type: "peer-removed", at, address: str(o, "address") } : { type, at, session: sessionRow(o) };
    case "message":
      return { type, at, message: messageRow(o) };
    case "receipt":
      return { type, at, id: str(o, "id"), to: str(o, "to"), status: oneOf(o, "status", ["delivered", "held", "refused", "expired"]) };
    case "held":
      return { type, at, op: oneOf(o, "op", ["add", "remove"]), item: heldRow(o.item) };
    case "lease":
      return o.released === true ? { type: "lease-released", at, name: str(o, "name") } : { type, at, lease: leaseRow(o) };
    case "breaker":
      return compact({ type, at, peer: str(o, "peer"), state: oneOf(o, "state", ["tripped", "resumed"] as const), reason: opt(o, "reason", (o, k) => oneOf(o, k, REASONS)) });
    default:
      return undefined;
  }
}

function response(o: Obj): WimResponse {
  const id = str(o, "id");
  if (bool(o, "ok")) return { id, ok: true, result: o.result ?? {} };
  const error = obj(o.error, "error");
  return { id, ok: false, error: { code: str(error, "code"), message: str(error, "message") } };
}

/** The messages in a `history` result; a row of the wrong shape makes the whole answer invalid. */
export function historyRows(result: unknown): MessageRow[] {
  const list = isObj(result) ? result.messages : undefined;
  return Array.isArray(list) ? list.map(messageRow) : [];
}

/** Parses one line of `wim events --json` output. */
export function parseLine(line: string): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { kind: "invalid", reason: "not JSON" };
  }
  if (!isObj(raw)) return { kind: "invalid", reason: "not a JSON object" };
  if (raw.v !== 1) return { kind: "invalid", reason: `unsupported version ${JSON.stringify(raw.v)}` };
  const type = raw.type;
  if (typeof type !== "string") return { kind: "invalid", reason: "type is not a string" };
  try {
    if (type === "response") return { kind: "response", response: response(raw) };
    const at = num(raw, "at");
    const ev = event(raw, type, at);
    return ev === undefined ? { kind: "ignored", type } : { kind: "event", event: ev };
  } catch (e) {
    return { kind: "invalid", reason: `${type}: ${(e as ShapeError).message}` };
  }
}
