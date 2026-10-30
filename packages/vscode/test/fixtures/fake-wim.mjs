#!/usr/bin/env node
// A stand-in for `wim events --json` (docs/events.md, v 1), for the extension's tests and the
// integration smoke test. It holds a small fixed mesh, answers every request in the contract,
// and never touches keys or a relay.
//
//   WIM_FAKE_LOG       a file to append each request line to, so a test can see what arrived
//   WIM_FAKE_SCENARIO  "default"; "bad-version" (also writes a v 2 line); "exit-after-hello"
//                      (exits with code 3 after hello); "not-set-up" (exits with code 2 and the
//                      real client's line for a device that is not set up); "setup" (setup mode:
//                      a device in no mesh yet, whose `join` succeeds and ends the process, after
//                      which it starts in the mesh); "setup-fail" (setup mode, whose join fails
//                      after its code was shown)

import { appendFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const as = argv.includes("--as") ? argv[argv.indexOf("--as") + 1] : "vscode";
const scenario = process.env.WIM_FAKE_SCENARIO ?? "default";
const log = process.env.WIM_FAKE_LOG;
const self = `${as}@laptop`;
const start = Date.now();

const emit = (type, fields = {}) => process.stdout.write(`${JSON.stringify({ v: 1, type, at: Date.now(), ...fields })}\n`);
const respond = (id, result) => emit("response", { id, ok: true, result });
const fail = (id, code, message) => emit("response", { ...(id === undefined ? {} : { id }), ok: false, error: { code, message } });

const devices = new Map(
  [
    { name: "laptop", id: "dev-laptop", role: "admin", policy: "deliver", self: true },
    { name: "buildbox", id: "dev-buildbox", role: "member", policy: "hold", self: false },
  ].map((d) => [d.name, d]),
);
const sessions = [
  // Like the real client, its own card carries the directory it was started in.
  { address: self, kind: "vscode", status: "idle", since: start, rooms: [], card: { cwd: process.cwd() }, local: true },
  { address: "reviewer@laptop", sid: "s-reviewer", kind: "claude-code", status: "busy", since: start - 60_000, rooms: ["#ops"], card: { cwd: "/home/me/app", branch: "review" }, local: true },
  { address: "coder@buildbox", sid: "s-coder", kind: "gemini-cli", status: "idle", since: start - 120_000, rooms: ["#ops"], card: { cwd: "/srv/app", branch: "main", title: "Coder" }, local: false },
  { address: "tester@buildbox", kind: "bot", status: "offline", since: start - 3_600_000, rooms: [], local: false },
];
const held = new Map(
  [
    {
      id: "01JFAKEHELD000000000000001",
      session: self,
      from: "coder@buildbox",
      device: "buildbox",
      kind: "msg",
      at: start - 30_000,
      preview: "Could you look at the failing test in auth.ts?",
      reason: "policy",
    },
  ].map((h) => [h.id, h]),
);
// Devices waiting to join, by invite/id; the comparison code the fake admits is FAKE_CODE.
const joins = new Map();
const FAKE_CODE = "ABCDE-FGHJK";
const heldText = new Map([["01JFAKEHELD000000000000001", "Could you look at the failing test in auth.ts? It fails on main since this morning."]]);
const history = [
  { id: "01JFAKEMSG0000000000000001", dir: "in", session: "reviewer@laptop", peer: "coder@buildbox", device: "dev-buildbox", kind: "task", text: "Review the auth change, please.", at: start - 50_000 },
  { id: "01JFAKEMSG0000000000000002", dir: "out", session: "reviewer@laptop", peer: "coder@buildbox", to: ["coder@buildbox"], kind: "result", text: "Looks fine, one nit.", status: "done", reply_to: "01JFAKEMSG0000000000000001", at: start - 40_000 },
];
let nextMessage = 100;
const messageId = () => `01JFAKEMSG00000000000${String(nextMessage++).padStart(5, "0")}`;

const rooms = () => {
  const byRoom = new Map();
  for (const s of sessions) for (const r of s.rooms) byRoom.set(r, [...(byRoom.get(r) ?? []), s.address]);
  return [...byRoom].map(([name, members]) => ({ name, members }));
};
const snapshot = () =>
  emit("snapshot", {
    devices: [...devices.values()],
    sessions,
    rooms: rooms(),
    leases: [{ name: "deploy", holder: "coder@buildbox", token: 1, expires_at: Date.now() + 5 * 60_000 }],
    held: [...held.values()],
    breakers: [],
    joins: [...joins.values()],
  });

const record = (message) => {
  history.push(message);
  emit("message", message);
};

function send(id, to, kind, text, extra = {}) {
  const list = Array.isArray(to) ? to : [to];
  const message = { id: messageId(), dir: "out", session: self, peer: list.join(","), to: list, kind, text, at: Date.now(), ...extra };
  record(message);
  respond(id, { id: message.id, results: list.map((t) => ({ to: t, status: "routed" })) });
  setTimeout(() => {
    for (const t of list) emit("receipt", { id: message.id, to: t, status: "delivered" });
  }, 25);
  // Each session it went to answers, so a UI sees an incoming message for its own session.
  setTimeout(() => {
    for (const t of list.filter((t) => !t.startsWith("#"))) {
      record({ id: messageId(), dir: "in", session: self, peer: t, device: `dev-${t.split("@")[1]}`, kind: "result", text: `Got it: ${text.slice(0, 40)}`, reply_to: message.id, at: Date.now() });
    }
  }, 50);
}

function handle(line) {
  if (log !== undefined) appendFileSync(log, `${line}\n`);
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return fail(undefined, "input", "not JSON");
  }
  const { id, op, args = {} } = req;
  if (req.v !== 1 || typeof id !== "string") return fail(typeof id === "string" ? id : undefined, "input", "a request is { v: 1, id, op, args? }");
  switch (op) {
    case "snapshot":
      snapshot();
      return respond(id, {});
    case "history": {
      const limit = Math.min(args.limit ?? 50, 500);
      const rows = history.filter((m) => (args.session === undefined || m.session === args.session) && (args.peer === undefined || m.peer.split(",").includes(args.peer)));
      return respond(id, { messages: rows.slice(-limit) });
    }
    case "send":
      if (typeof args.text !== "string" || args.to === undefined) return fail(id, "input", "send needs to and text");
      if (/AKIA[0-9A-Z]{16}/.test(args.text)) return fail(id, "refused", "the text looks like it holds a secret");
      return send(id, args.to, args.kind ?? "msg", args.text);
    case "send_file": {
      if (typeof args.path !== "string" || !isAbsolute(args.path)) return fail(id, "input", "path must be absolute");
      let size;
      try {
        size = statSync(args.path).size;
      } catch {
        return fail(id, "input", "not a readable file");
      }
      const name = args.path.split(/[\\/]/).pop();
      return send(id, args.to, "file", "", { file: { name, size, mime: "application/octet-stream" } });
    }
    case "approve":
    case "refuse": {
      const item = held.get(args.held);
      if (item === undefined) return fail(id, "not_found", `no held message ${args.held}`);
      held.delete(item.id);
      emit("held", { op: "remove", item });
      if (op === "approve") record({ id: messageId(), dir: "in", session: item.session, peer: item.from, device: `dev-${item.device}`, kind: item.kind, text: heldText.get(item.id) ?? item.preview, at: Date.now() });
      return respond(id, {});
    }
    case "trust":
    case "untrust": {
      const d = devices.get(args.device);
      if (d === undefined || d.self) return fail(id, "not_found", `no device named ${args.device}`);
      d.policy = op === "untrust" ? "hold" : args.relayed === true ? "deliver-relayed" : "deliver";
      emit("device", d);
      return respond(id, { policy: d.policy });
    }
    case "resume":
      emit("breaker", { peer: args.peer, state: "resumed" });
      return respond(id, { released: 0 });
    case "invite": {
      const invite = `inv-${nextMessage++}`;
      respond(id, { code: `wim1_fake${invite}`, invite, exp: Date.now() + 3_600_000 });
      // The new device asks to join soon after.
      setTimeout(() => {
        const request = { name: "newbox", id: "dev-newbox", invite, at: Date.now(), exp: Date.now() + 3_600_000 };
        joins.set(`${invite}/dev-newbox`, request);
        emit("join", { op: "add", request });
      }, 30);
      return;
    }
    case "admit": {
      const request = [...joins.values()].find((j) => j.name === args.device);
      if (request === undefined) return fail(id, "not_found", `no device named ${args.device} is waiting to join`);
      if (String(args.code).toUpperCase() !== FAKE_CODE) return fail(id, "mismatch", "that is not the comparison code of this request");
      joins.delete(`${request.invite}/${request.id}`);
      emit("join", { op: "remove", request });
      const d = { name: request.name, id: request.id, role: "member", policy: "hold", self: false };
      devices.set(d.name, d);
      emit("device", d);
      return respond(id, { device: request.name });
    }
    default:
      return fail(id, "input", `unknown op ${op}`);
  }
}

process.stderr.write(`fake wim events for ${self} (scenario ${scenario})\n`);
if (scenario === "not-set-up") {
  process.stderr.write("wim: this device is not set up: run `wim init` first\n");
  process.exit(2);
}

const joinedMarker = log === undefined ? undefined : `${log}.joined`;
if ((scenario === "setup" || scenario === "setup-fail") && (joinedMarker === undefined || !existsSync(joinedMarker))) {
  setupMode();
} else {
  inMesh();
}

/** Setup mode (docs/events.md): a device in no mesh yet; only `join`. */
function setupMode() {
  emit("setup", { version: "0.0.0-fake", device: null });
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line.trim() === "") return;
    if (log !== undefined) appendFileSync(log, `${line}\n`);
    const { id, op } = JSON.parse(line);
    if (op !== "join") return fail(id, "setup", "this device is in no mesh yet: join one first");
    respond(id, { device: { name: "fresh", id: "dev-fresh" }, code: FAKE_CODE });
    setTimeout(() => {
      if (scenario === "setup-fail") return emit("join_failed", { message: "the relay went away" });
      if (joinedMarker !== undefined) writeFileSync(joinedMarker, "");
      emit("joined", { mesh: "f4ke…", devices: [{ name: "buildbox", id: "dev-buildbox" }] });
      process.exit(0);
    }, 30);
  });
  rl.on("close", () => process.exit(0));
}

function inMesh() {
  emit("hello", { version: "0.0.0-fake", device: { name: "laptop", id: "dev-laptop" }, session: self, relay: "relay.invalid", mesh: "f4ke…" });
  if (scenario === "exit-after-hello") process.exit(3);
  emit("connection", { state: "connecting" });
  emit("connection", { state: "open" });
  snapshot();
  // A newer client may add event types and fields; a UI ignores both.
  emit("weather", { sky: "clear" });
  emit("peer", { ...sessions[2], mood: "fine" });
  if (scenario === "bad-version") process.stdout.write(`${JSON.stringify({ v: 2, type: "hello", at: Date.now() })}\n`);
  // A message for a Claude Code tab on this device, not for this window's own session.
  if (scenario === "tab-message") record({ id: messageId(), dir: "in", session: "reviewer@laptop", peer: "coder@buildbox", device: "dev-buildbox", kind: "msg", text: "for the tab", at: Date.now() });

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line.trim() !== "") handle(line);
  });
  rl.on("close", () => process.exit(0));
}
