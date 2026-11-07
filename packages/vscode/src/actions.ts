// Commands the person runs: send a selection or a file, ask a peer, open a thread, the
// person-only decisions (approve, refuse, trust, untrust, resume), and adding a device (invite,
// admit by the comparison code the person types, join). The decisions run only from a click in a
// view, a command the person invokes, or a dialog this extension shows, and accept only nodes this
// extension issued; nothing in a message can reach them.

import * as vscode from "vscode";
import { NAME_RE, noIcons, notice, oneLine, stamp, visible } from "./display.ts";
import type { HeldRow, JoinRow } from "./protocol.ts";
import { RequestError } from "./process.ts";
import { heldKey, heldSetKey, type HeldSet, type Store } from "./state.ts";
import { showThread, type Requester } from "./thread.ts";
import { POLICY_LABEL, setCount, setSpan, type Nodes } from "./tree.ts";

/** `send_file` waits for the upload, so it gets longer than a plain request. */
export const FILE_TIMEOUT_MS = 120_000;

/** A `join` request waits for an admin, up to the invite's expiry (at most 7 days). */
export const JOIN_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

/** `create` dials the relay, creates the mesh and signs in once; each step may take 15 s. */
export const CREATE_TIMEOUT_MS = 60_000;

/** The hosted relay, the default for a new mesh (HOSTED_RELAY in @worldinmotion/protocol; a test holds the two equal). */
export const HOSTED_RELAY = "wss://worldinmotion.distronode.com";

/** How long the client holds a new mesh's recovery code for `wim recovery show`, in minutes (LIMITS.recoveryShowWindowMs). */
export const RECOVERY_MINUTES = 10;

export type Deps = {
  store: Store;
  client: Requester;
  nodes: Nodes;
  now: () => number;
  /** Invites this window made: a request on one asks for its comparison code at once. */
  invited: Set<string>;
  /**
   * The name Create a Mesh... last sent while the device had no keys. A try that failed may have
   * made the device under it, and the client keeps an existing device's name, so a retry sends
   * the same one instead of asking again.
   */
  setupName?: string;
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

/**
 * The set to decide, and the item the person started from (its row in the Held view), if any.
 * From the palette, the person picks a set; a look-alike object or a bare id picks nothing.
 */
async function heldFrom(d: Deps, arg: unknown, verb: string): Promise<{ set: HeldSet; item?: HeldRow } | undefined> {
  const sets = d.store.heldSets();
  const node = d.nodes.ours(arg, "held");
  if (node !== undefined) {
    const item = d.store.held.get(heldKey(node));
    const set = item === undefined ? undefined : sets.find((s) => s.key === heldSetKey(item));
    return set === undefined ? undefined : { set, item: item! };
  }
  const setNode = d.nodes.ours(arg, "heldSet");
  if (setNode !== undefined) {
    const set = sets.find((s) => s.key === setNode.key);
    return set === undefined ? undefined : { set };
  }
  if (arg !== undefined) return undefined;
  if (sets.length === 0) {
    void vscode.window.showInformationMessage("worldinmotion: nothing is held for you.");
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    sets.map((set) => ({
      label: noIcons(`From ${oneLine(set.title, 80)}`),
      description: `${setCount(set)}, ${setSpan(set)}`,
      detail: noIcons(oneLine(set.rows[0]!.file?.name ?? set.rows[0]!.preview, 120)),
      set,
    })),
    { title: `${verb} what is held from one sender` },
  );
  return picked === undefined ? undefined : { set: picked.set };
}

/**
 * The modal's text: every item of the set, in order, with the count and the time span, so a
 * request split across several messages is read as one. Each item's text is folded to one line
 * and escaped, so it cannot draw a heading, a count or another item.
 */
export function setDetail(set: HeldSet, op: "approve" | "refuse"): string {
  const n = set.ids.length;
  const out = [`${setCount(set)} held from ${oneLine(set.title, 200)}, ${setSpan(set)}. Read them together: they are decided as one.`, ""];
  set.ids.forEach((id, i) => {
    const rows = set.rows.filter((r) => r.id === id);
    const h = rows[0]!;
    out.push(`${i + 1} of ${n}.  ${oneLine(h.from, 80)}, ${h.kind}, ${stamp(h.at)}, for ${rows.map((r) => oneLine(r.session, 80)).join(", ")}`);
    if (h.ci !== undefined) out.push(`      CI: ${oneLine(h.ci, 200)}`);
    if (h.file !== undefined) out.push(`      File: ${oneLine(h.file.name, 120)}, ${h.file.size} bytes, fetched once approved`);
    out.push(`      ${h.preview === "" ? "(no text)" : oneLine(h.preview, 160)}`);
    if (h.pins !== undefined && op === "approve") out.push(`      Approve on its own, in a terminal: it pins ${oneLine(h.pins, 120)} (wim held approve ${id})`);
  });
  out.push("");
  const covered = op === "approve" ? approvable(set).length : n;
  out.push(
    op === "approve"
      ? `Approve all delivers exactly ${covered === n ? `these ${n}` : `the ${covered} of these ${n} that do not pin ids`} to your agents. Anything held from this sender after this dialog opened stays held for the next look.`
      : `Refuse all drops exactly these ${covered}, never delivered. Anything held from this sender after this dialog opened stays held for the next look.`,
  );
  if (op === "approve" && set.rows.some((r) => r.reason === "breaker")) {
    out.push("The loop breaker's pause on this sender stays on: Resume on its session in the Mesh view, or wim held resume <address> in a terminal, lifts it.");
  }
  return out.join("\n");
}

/** The ids "approve all" covers: a notice that pins its rule's ids is approved only on its own. */
function approvable(set: HeldSet): string[] {
  return set.ids.filter((id) => set.rows.find((r) => r.id === id)!.pins === undefined);
}

/** "Keep them held": the modal's first button, so Enter decides nothing. */
export const KEEP: vscode.MessageItem = { title: "Keep them held" };
/** The close affordance: Escape and the dialog's close button decide nothing. */
export const CANCEL: vscode.MessageItem = { title: "Cancel", isCloseAffordance: true };

/**
 * The modal's buttons. VS Code makes the first button that is not the close affordance the default
 * (Enter), so that one is KEEP, which decides nothing; Escape is CANCEL. Approving or refusing, all
 * or one, is always a deliberate click.
 */
export function decisionButtons(...decisions: (vscode.MessageItem | undefined)[]): vscode.MessageItem[] {
  return [KEEP, ...decisions.filter((b): b is vscode.MessageItem => b !== undefined), CANCEL];
}

/**
 * Approve or refuse: a modal (an agent driving the editor cannot answer it) that shows the whole
 * set first. "All" decides exactly the ids it showed; "only this one" is offered only when the
 * person started from one item, after the set was shown.
 */
async function decide(d: Deps, arg: unknown, op: "approve" | "refuse"): Promise<void> {
  const chosen = await heldFrom(d, arg, op === "approve" ? "Approve" : "Refuse");
  if (chosen === undefined) return;
  const { set, item } = chosen;
  const covered = op === "approve" ? approvable(set) : set.ids;
  const verb = op === "approve" ? "Approve" : "Refuse";
  const all = covered.length === 0 ? undefined : { title: `${verb} all ${covered.length}` };
  const only = item === undefined || (op === "approve" && item.pins !== undefined) ? undefined : { title: `${verb} only this one` };
  const choice = await vscode.window.showWarningMessage(
    `${verb} ${covered.length === set.ids.length ? setCount(set) : `${covered.length} of ${setCount(set)}`} held from ${oneLine(set.title, 100)}?`,
    { modal: true, detail: setDetail(set, op) },
    ...decisionButtons(all, only),
  );
  if (choice === undefined || (choice !== all && choice !== only)) return;
  try {
    if (choice === only) {
      await d.client.request(op, { held: item!.id });
      void vscode.window.showInformationMessage(op === "approve" ? "worldinmotion: approved and delivered." : "worldinmotion: refused.");
      return;
    }
    const result = (await d.client.request(op, { held: covered[0]!, set: covered })) as { decided?: unknown };
    const n = Array.isArray(result.decided) ? result.decided.length : covered.length;
    void vscode.window.showInformationMessage(op === "approve" ? `worldinmotion: approved and delivered ${n}.` : `worldinmotion: refused ${n}.`);
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
    void vscode.window.showWarningMessage("worldinmotion: this device is in no mesh yet. Create or join one first (Create a Mesh or Join with a Code in the Mesh view).");
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
      detail: `On the new device, in a terminal: wim join <code> (or there in VS Code: worldinmotion: Join with a Code...). The code works once, until ${stamp(made.exp)}. Give it over a channel you trust, never through an agent or a message. When the device asks to join, you type the comparison code it shows.${older}`,
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

/** The two ways of Join with a Code...; the pairing one is not in this version yet. */
export const JOIN_WAYS = [
  { label: "My other device is already in the mesh", detail: "This device shows a pairing code, you type it there.", way: "pair" },
  { label: "I have an invite code", detail: "A wim2-... code from wim invite or Add a Device.", way: "invite" },
] as const;

/** Said for the pairing way until pairing codes ship. */
export const PAIRING_LATER =
  "worldinmotion: pairing codes are not in this version yet. On the device that is in the mesh, run worldinmotion: Add a Device... (or wim invite in a terminal), then choose I have an invite code here.";

/**
 * Join with a Code...: on a device in no mesh yet, joins with an invite code pasted here (never
 * shown), then shows this device's comparison code for the person to type on the admin device.
 */
export async function joinMesh(d: Deps): Promise<void> {
  if (d.store.setup === undefined) {
    void vscode.window.showWarningMessage("worldinmotion: this device is already in a mesh. To join another, run wim join <code> in a terminal.");
    return;
  }
  const way = await vscode.window.showQuickPick(JOIN_WAYS, { title: "Join with a code", placeHolder: "Which code do you have?", ignoreFocusOut: true });
  if (way === undefined) return;
  if (way.way === "pair") {
    void vscode.window.showInformationMessage(PAIRING_LATER);
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

/** The relay choices of Create a Mesh...: the hosted relay, or a URL the person types. */
export const RELAY_PICKS = [
  { label: "Hosted relay (recommended)", description: "worldinmotion.distronode.com", detail: "Free during the preview, no sign-up.", relay: HOSTED_RELAY },
  { label: "Another relay...", detail: "A relay you or your team run (packages/relay-node).", relay: undefined },
] as const;

/** What the confirmation says about the relay. */
function relayDetail(relay: string): string {
  const hosted = relay === HOSTED_RELAY ? " It deletes a mesh nobody connects to for 30 days. Terms: docs/hosted-relay.md." : "";
  return `On ${relay}. The relay passes encrypted messages on and cannot read them.${hosted}`;
}

/**
 * Create a Mesh...: on a device in no mesh yet, a name box (when it has no keys yet), a relay
 * pick, a modal confirmation, then the `create` request. The recovery code never comes here: it
 * waits in the client for `wim recovery show`, which `showRecovery` opens in a terminal the
 * person sees. The client ends with `created`, and the extension starts it again in the mesh.
 */
export async function createMesh(d: Deps, showRecovery: () => void): Promise<void> {
  if (d.store.setup === undefined) {
    void vscode.window.showWarningMessage("worldinmotion: this device is already in a mesh. To create another, run wim mesh create in a terminal.");
    return;
  }
  const known = d.store.setup.device;
  let name = known?.name ?? d.setupName;
  if (name === undefined) {
    const typed = await vscode.window.showInputBox({
      title: "Create a mesh: name this device",
      prompt: "Name this device. Its sessions get addresses like vscode@laptop. Lowercase letters, digits and hyphens.",
      placeHolder: "laptop",
      ignoreFocusOut: true,
      validateInput: (v: string) => (NAME_RE.test(v.trim()) ? undefined : "Lowercase letters, digits and hyphens, up to 32, starting with a letter or digit"),
    });
    if (typed === undefined) return;
    name = typed.trim();
  }
  const pick = await vscode.window.showQuickPick(RELAY_PICKS, { title: "Create a mesh: choose a relay", placeHolder: "Where the mesh's encrypted messages pass", ignoreFocusOut: true });
  if (pick === undefined) return;
  const relay =
    pick.relay ??
    (
      await vscode.window.showInputBox({
        title: "Create a mesh: the relay's URL",
        prompt: "The relay's URL as its operator gives it: wss://..., or ws:// for one on this machine.",
        placeHolder: "wss://relay.example.com",
        ignoreFocusOut: true,
        validateInput: (v: string) => (/^wss?:\/\/[^\s/]+/i.test(v.trim()) ? undefined : "A relay URL starts with wss:// (or ws:// for one on this machine)"),
      })
    )?.trim();
  if (relay === undefined) return;
  const shown = noIcons(oneLine(name, 40));
  const go = await vscode.window.showInformationMessage(
    `Create a mesh with ${shown} as its admin?`,
    { modal: true, detail: noIcons(`${relayDetail(oneLine(relay, 200))}\n\nNext comes your recovery code, shown once.`) },
    "Create Mesh",
  );
  if (go !== "Create Mesh") return;
  if (known === undefined) d.setupName = name;
  try {
    await d.client.request("create", { ...(known === undefined ? { name } : {}), relay }, CREATE_TIMEOUT_MS);
  } catch (e) {
    const code = e instanceof RequestError ? `${e.code}: ` : "";
    void vscode.window.showErrorMessage(notice(`worldinmotion: could not create the mesh: ${code}${(e as Error).message}`));
    return;
  }
  const store = await vscode.window.showInformationMessage(
    "Mesh created. Store your recovery code now.",
    { modal: true, detail: `It is as powerful as this device. Keep it offline (a password manager or paper), never in a chat. It waits ${RECOVERY_MINUTES} minutes in a terminal only you see.` },
    "Show Recovery Code",
  );
  if (store === "Show Recovery Code") return showRecovery();
  // Dismissed: the code still waits, and one more click opens it.
  const later = await vscode.window.showWarningMessage(`worldinmotion: your recovery code waits ${RECOVERY_MINUTES} minutes, then it is gone.`, "Show Recovery Code");
  if (later === "Show Recovery Code") showRecovery();
}
