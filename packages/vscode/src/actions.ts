// Commands the person runs: send a selection or a file, ask a peer, open a thread, the
// person-only decisions (approve, refuse, trust, untrust, resume), and adding a device (invite,
// admit by the comparison code the person types, join). The decisions run only from a click in a
// view, a command the person invokes, or a dialog this extension shows, and accept only nodes this
// extension issued; nothing in a message can reach them.

import * as vscode from "vscode";
import { noIcons, notice, oneLine, stamp, visible } from "./display.ts";
import type { JoinRow } from "./protocol.ts";
import { RequestError } from "./process.ts";
import type { Store } from "./state.ts";
import { showThread, type Requester } from "./thread.ts";
import { POLICY_LABEL, type Nodes } from "./tree.ts";

/** `send_file` waits for the upload, so it gets longer than a plain request. */
export const FILE_TIMEOUT_MS = 120_000;

/** A `join` request waits for an admin, up to the invite's expiry (at most 7 days). */
export const JOIN_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

export type Deps = {
  store: Store;
  client: Requester;
  nodes: Nodes;
  now: () => number;
  /** Invites this window made: a request on one asks for its comparison code at once. */
  invited: Set<string>;
}

function failure(what: string, e: unknown): void {
  if (e instanceof RequestError && e.code === "refused") {
    void vscode.window.showErrorMessage(
      `worldinmotion: the client refused to ${what}: the text looks like it holds a secret. To send it anyway, run wim send --allow-secret in a terminal.`,
    );
    return;
  }
  const code = e instanceof RequestError ? `${e.code}: ` : "";
  void vscode.window.showErrorMessage(notice(`worldinmotion: could not ${what}: ${code}${(e as Error).message}`));
}

/** Asks the person for a live session or a room. */
export async function pickTarget(store: Store, title: string): Promise<string | undefined> {
  const targets = store.targets();
  if (targets.length === 0) {
    void vscode.window.showWarningMessage("worldinmotion: no live sessions or rooms to send to.");
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    targets.map((t) => ({ label: noIcons(oneLine(t.target, 80)), description: noIcons(oneLine(t.detail, 80)), target: t.target })),
    { title, placeHolder: "A session or a room", matchOnDescription: true },
  );
  return picked?.target;
}

type SendResult = { id?: unknown; results?: unknown };

function reportSent(result: unknown): void {
  const r = result as SendResult;
  const rows = Array.isArray(r.results) ? (r.results as { to?: unknown; status?: unknown }[]) : [];
  const parts = rows.map((x) => `${String(x.to)}: ${String(x.status)}`);
  void vscode.window.showInformationMessage(notice(`worldinmotion: sent. ${parts.length > 0 ? parts.join(", ") : "No recipients reported."}`));
}

/** The selection with its place, `path:start-end`, path relative to the workspace. */
export function selectionText(editor: vscode.TextEditor): string | undefined {
  const sel = editor.selection;
  if (sel.isEmpty) return undefined;
  const text = editor.document.getText(sel);
  // A selection that ends at the start of a line does not include that line.
  const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
  const path = vscode.workspace.asRelativePath(editor.document.uri, false);
  return `${path}:${sel.start.line + 1}-${endLine}\n${text}`;
}

async function sendText(d: Deps, title: string, kind: "msg" | "task", build: (selection: string) => Promise<string | undefined>): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const selection = editor === undefined ? undefined : selectionText(editor);
  if (selection === undefined) {
    void vscode.window.showWarningMessage("worldinmotion: select some text first.");
    return;
  }
  const text = await build(selection);
  if (text === undefined) return;
  const to = await pickTarget(d.store, title);
  if (to === undefined) return;
  try {
    reportSent(await d.client.request("send", { to, text, kind }));
  } catch (e) {
    failure("send it", e);
  }
}

/** Sends a line the person types to a session or room they pick. */
export async function sendMessage(d: Deps): Promise<void> {
  const to = await pickTarget(d.store, "Send a message to");
  if (to === undefined) return;
  const text = await vscode.window.showInputBox({ title: `Message to ${oneLine(to, 80)}`, prompt: "The message", ignoreFocusOut: true });
  if (text === undefined || text.trim() === "") return;
  try {
    reportSent(await d.client.request("send", { to, text, kind: "msg" }));
  } catch (e) {
    failure("send it", e);
  }
}

export function sendSelection(d: Deps): Promise<void> {
  return sendText(d, "Send selection to", "msg", async (s) => s);
}

export function askAboutSelection(d: Deps): Promise<void> {
  return sendText(d, "Ask a peer about the selection", "task", async (s) => {
    const question = await vscode.window.showInputBox({ title: "Ask a peer about the selection", prompt: "Your question (optional)", ignoreFocusOut: true });
    if (question === undefined) return undefined;
    return question.trim() === "" ? s : `${question.trim()}\n\n${s}`;
  });
}

/** Sends a file from the explorer, or the active editor's file. Local files only. */
export async function sendFile(d: Deps, arg: unknown): Promise<void> {
  const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
  if (uri === undefined || uri.scheme !== "file") {
    void vscode.window.showWarningMessage("worldinmotion: only a file on this machine can be sent. A remote or unsaved file cannot.");
    return;
  }
  const to = await pickTarget(d.store, `Send ${vscode.workspace.asRelativePath(uri, false)} to`);
  if (to === undefined) return;
  try {
    reportSent(await d.client.request("send_file", { to, path: uri.fsPath }, FILE_TIMEOUT_MS));
  } catch (e) {
    failure("send the file", e);
  }
}

/** Opens a thread from a session or room node, or asks which peer. */
export async function openThread(d: Deps, arg: unknown): Promise<void> {
  const session = d.nodes.ours(arg, "session");
  const room = d.nodes.ours(arg, "room");
  let peer = session?.address ?? room?.name;
  if (peer === undefined) {
    const peers = d.store.threadPeers();
    if (peers.length === 0) {
      void vscode.window.showWarningMessage("worldinmotion: no peers to show a thread with yet.");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      peers.map((p) => ({ label: noIcons(oneLine(p, 80)), peer: p })),
      { title: "Open thread with" },
    );
    peer = picked?.peer;
    if (peer === undefined) return;
  }
  d.store.markRead();
  await showThread(peer, undefined);
}

async function heldFrom(d: Deps, arg: unknown, verb: string): Promise<string | undefined> {
  const node = d.nodes.ours(arg, "held");
  if (node !== undefined) return node.id;
  if (arg !== undefined) return undefined;
  const items = [...d.store.held.values()];
  if (items.length === 0) {
    void vscode.window.showInformationMessage("worldinmotion: nothing is held for you.");
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    items.map((h) => ({
      label: noIcons(`${oneLine(h.from, 80)} (${h.kind})`),
      description: noIcons(oneLine(h.file?.name ?? h.preview, 120)),
      detail: noIcons(`For ${oneLine(h.session, 80)}`),
      id: h.id,
    })),
    { title: `${verb} a held message` },
  );
  return picked?.id;
}

async function decide(d: Deps, arg: unknown, op: "approve" | "refuse"): Promise<void> {
  const id = await heldFrom(d, arg, op === "approve" ? "Approve" : "Refuse");
  if (id === undefined) return;
  try {
    await d.client.request(op, { held: id });
    void vscode.window.showInformationMessage(op === "approve" ? "worldinmotion: approved and delivered." : "worldinmotion: refused.");
  } catch (e) {
    failure(op === "approve" ? "approve it" : "refuse it", e);
  }
}

export const approve = (d: Deps, arg: unknown): Promise<void> => decide(d, arg, "approve");
export const refuse = (d: Deps, arg: unknown): Promise<void> => decide(d, arg, "refuse");

/** What each trust command sets; test/contract.test.ts holds it to the client's `trustLevel`. */
export const TRUST = {
  trust: { button: "Trust", policy: "deliver", explain: "Messages its sessions write themselves are delivered to your agents without being held." },
  trustRelayed: {
    button: "Trust, relayed text too",
    policy: "deliver-relayed",
    explain: "Everything its sessions send is delivered without being held, including text they only pass on from someone else.",
  },
  untrust: { button: "Untrust", policy: "hold", explain: "Messages from its sessions are held until you approve each one." },
} as const;

/** Trust, trust including relayed text, or untrust a device, after a modal confirmation. */
export async function setTrust(d: Deps, arg: unknown, which: keyof typeof TRUST): Promise<void> {
  const node = d.nodes.ours(arg, "device");
  const row = node === undefined ? undefined : d.store.devices.get(node.name);
  if (row === undefined || row.self) return;
  const t = TRUST[which];
  const choice = await vscode.window.showWarningMessage(
    `${t.button} the device "${visible(row.name)}"?`,
    { modal: true, detail: `Its inbound policy changes from ${row.policy} (${POLICY_LABEL[row.policy]}) to ${t.policy} (${POLICY_LABEL[t.policy]}). ${t.explain}` },
    t.button,
  );
  if (choice !== t.button) return;
  try {
    const args = which === "untrust" ? { device: row.name } : { device: row.name, relayed: which === "trustRelayed" };
    const result = (await d.client.request(which === "untrust" ? "untrust" : "trust", args)) as { policy?: unknown };
    void vscode.window.showInformationMessage(notice(`worldinmotion: ${row.name} is now ${String(result.policy)}.`));
  } catch (e) {
    failure(`change the policy for ${row.name}`, e);
  }
}

/** Lifts a breaker pause on a session. */
export async function resume(d: Deps, arg: unknown): Promise<void> {
  const node = d.nodes.ours(arg, "session");
  if (node === undefined) return;
  try {
    const result = (await d.client.request("resume", { peer: node.address })) as { released?: unknown };
    void vscode.window.showInformationMessage(notice(`worldinmotion: resumed ${node.address}; ${String(result.released ?? 0)} held messages released.`));
  } catch (e) {
    failure(`resume ${node.address}`, e);
  }
}

/** A comparison code as the person may type it: 10 letters and digits, with or without the dash. */
const CODE_RE = /^[0-9a-z]{5}[\s-]?[0-9a-z]{5}$/i;

/**
 * Add a Device...: an invite for a new device, copied with a button, never shown in a message.
 * When the device asks to join, the person types the comparison code it shows (admitRequest).
 */
export async function addDevice(d: Deps): Promise<void> {
  if (d.store.setup !== undefined) {
    void vscode.window.showWarningMessage("worldinmotion: this device is in no mesh yet. Join one first (worldinmotion: Join a Mesh...).");
    return;
  }
  // With a short code, `code` is it and `full` the full code, for a device on wim 0.1.4 or older.
  let made: { code: string; invite: string; exp: number; full?: string };
  try {
    made = (await d.client.request("invite")) as typeof made;
  } catch (e) {
    failure("make an invite", e);
    return;
  }
  d.invited.add(made.invite);
  const older = made.full === undefined ? "" : " A device on wim 0.1.4 or older needs the full code instead.";
  const choice = await vscode.window.showInformationMessage(
    "worldinmotion: an invite for the new device is ready.",
    {
      modal: true,
      detail: `On the new device, in a terminal: wim join <code> (or there in VS Code: worldinmotion: Join a Mesh...). The code works once, until ${stamp(made.exp)}. Give it over a channel you trust, never through an agent or a message. When the device asks to join, you type the comparison code it shows.${older}`,
    },
    "Copy Invite Code",
    ...(made.full === undefined ? [] : ["Copy Full Code"]),
  );
  if (choice === "Copy Full Code") {
    await vscode.env.clipboard.writeText(made.full!);
    void vscode.window.showInformationMessage("worldinmotion: full invite code copied.");
    return;
  }
  if (choice !== "Copy Invite Code") return;
  await vscode.env.clipboard.writeText(made.code);
  void vscode.window.showInformationMessage("worldinmotion: invite code copied.");
}

/** A device asks to join: on an invite this window made, its code is asked for at once; otherwise offered. */
export async function joinRequested(d: Deps, row: JoinRow): Promise<void> {
  if (d.invited.has(row.invite)) return admitRequest(d, row);
  const choice = await vscode.window.showInformationMessage(notice(`worldinmotion: a device named ${row.name} asks to join the mesh.`), "Admit...");
  if (choice === "Admit...") await admitRequest(d, row);
}

/** Admit a Device...: picks a waiting device, then admits it by its code. */
export async function admitDevice(d: Deps): Promise<void> {
  const rows = [...d.store.joins.values()];
  if (rows.length === 0) {
    void vscode.window.showInformationMessage("worldinmotion: no device is waiting to join.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    rows.map((r) => ({ label: noIcons(oneLine(r.name, 40)), description: noIcons(oneLine(r.id, 40)), detail: `Asked ${stamp(r.at)}`, row: r })),
    { title: "Admit a device" },
  );
  if (picked !== undefined) await admitRequest(d, picked.row);
}

/**
 * Asks the person for the comparison code the new device shows and admits the request only when
 * it is that request's code (the client compares). The code is never shown here: reading it from
 * the new device is the check.
 */
export async function admitRequest(d: Deps, row: JoinRow): Promise<void> {
  const name = oneLine(row.name, 40);
  const code = await vscode.window.showInputBox({
    title: noIcons(`Add ${name} to the mesh`),
    prompt: noIcons(`Type the comparison code the new device shows (device id ${oneLine(row.id, 40)}). If it shows no code, or another one, press Escape: the request is not from the device you invited.`),
    placeHolder: "XXXXX-XXXXX",
    ignoreFocusOut: true,
    validateInput: (v: string) => (CODE_RE.test(v.trim()) ? undefined : "10 letters and digits, as the new device shows them"),
  });
  if (code === undefined) return;
  try {
    await d.client.request("admit", { device: row.name, code: code.trim() });
  } catch (e) {
    if (e instanceof RequestError && e.code === "mismatch") {
      void vscode.window.showErrorMessage(notice(`worldinmotion: that is not the comparison code of ${name}'s request. Check it on the new device; if it shows another code, do not admit it.`));
    } else failure(`admit ${name}`, e);
    return;
  }
  d.invited.delete(row.invite);
  void vscode.window.showInformationMessage(notice(`worldinmotion: admitted ${name}.`));
  await askTrust(d, [row.name]);
}

/** "Is X your own device?" after an admit or a join; a yes trusts it, as the Trust action does. */
export async function askTrust(d: Deps, names: readonly string[]): Promise<void> {
  if (names.length === 0) return;
  const one = names.length === 1;
  const shown = names.map((n) => `"${visible(n)}"`);
  const list = one ? shown[0]! : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)!}`;
  const choice = await vscode.window.showWarningMessage(
    one ? `Is ${list} your own device?` : `Are ${list} your own devices?`,
    { modal: true, detail: `Trust ${one ? "its" : "their"} messages here: ${TRUST.trust.explain} Only for a device you would let type into your own terminal.` },
    TRUST.trust.button,
  );
  if (choice !== TRUST.trust.button) return;
  for (const name of names) {
    try {
      await d.client.request("trust", { device: name, relayed: false });
    } catch (e) {
      failure(`trust ${oneLine(name, 40)}`, e);
      return;
    }
  }
  void vscode.window.showInformationMessage(notice(`worldinmotion: ${names.join(", ")} trusted.`));
}

/**
 * Join a Mesh...: on a device in no mesh yet, joins with an invite code pasted here (never shown),
 * then shows this device's comparison code for the person to type on the admin device.
 */
export async function joinMesh(d: Deps): Promise<void> {
  if (d.store.setup === undefined) {
    void vscode.window.showWarningMessage("worldinmotion: this device is already in a mesh. To join another, run wim join <code> in a terminal.");
    return;
  }
  const code = await vscode.window.showInputBox({
    title: "Join a mesh",
    prompt: "Paste or type the invite code from the admin device (wim invite there, or its Add a Device...)",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v: string) => (/^(wim1_|wim2-)/i.test(v.trim()) ? undefined : "An invite code starts with wim2- (or wim1_)"),
  });
  if (code === undefined) return;
  let r: { device: { name: string }; code: string };
  try {
    r = (await d.client.request("join", { code: code.trim() }, JOIN_TIMEOUT_MS)) as typeof r;
  } catch (e) {
    failure("join the mesh", e);
    return;
  }
  const name = oneLine(r.device.name, 40);
  const sas = oneLine(r.code, 20);
  void vscode.window.showInformationMessage(notice(`worldinmotion: this device's comparison code is ${sas}`), {
    modal: true,
    detail: noIcons(`On the admin device, type ${sas} where wim invite asks for it, in its Add a Device... dialog, or run wim devices admit ${name} ${sas} there. This window finishes joining once the admin admits it.`),
  });
}
