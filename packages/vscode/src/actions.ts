// Commands the person runs: send a selection or a file, ask a peer, open a thread, and the
// person-only decisions (approve, refuse, trust, untrust, resume). The decisions run only from a
// click in a view or a command the person invokes, and accept only nodes this extension issued;
// nothing in a message can reach them.

import * as vscode from "vscode";
import { noIcons, notice, oneLine, visible } from "./display.ts";
import { RequestError } from "./process.ts";
import type { Store } from "./state.ts";
import { showThread, type Requester } from "./thread.ts";
import { POLICY_LABEL, type Nodes } from "./tree.ts";

/** `send_file` waits for the upload, so it gets longer than a plain request. */
export const FILE_TIMEOUT_MS = 120_000;

export type Deps = { store: Store; client: Requester; nodes: Nodes; now: () => number };

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
