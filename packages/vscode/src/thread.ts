// "Open thread": the conversation with one peer as plain text, in a read-only virtual document
// on the `wim:` scheme. Each message's text is indented under a header line this extension
// writes, so a peer cannot forge a header; the `wim-thread` language turns editor links off.

import * as vscode from "vscode";
import { isTarget, stamp, visible } from "./display.ts";
import { historyRows, type MessageRow } from "./protocol.ts";
import { counterparts } from "./state.ts";

export const SCHEME = "wim";
export const LANGUAGE = "wim-thread";
export const THREAD_LIMIT = 500;

export interface Requester {
  request(op: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

export function threadUri(peer: string, session: string | undefined): vscode.Uri {
  const query = new URLSearchParams({ peer, ...(session === undefined ? {} : { session }) }).toString();
  return vscode.Uri.from({ scheme: SCHEME, path: `/${peer}`, query });
}

export function parseThreadUri(uri: vscode.Uri): { peer: string; session?: string } | undefined {
  if (uri.scheme !== SCHEME) return undefined;
  const q = new URLSearchParams(uri.query);
  const peer = q.get("peer");
  const session = q.get("session");
  if (peer === null || !isTarget(peer)) return undefined;
  if (session !== null && !isTarget(session)) return undefined;
  return session === null ? { peer } : { peer, session };
}

/** The thread as text: a header written here, then each message, its text indented four spaces. */
export function renderThread(peer: string, session: string | undefined, messages: MessageRow[]): string {
  const out = [
    `worldinmotion thread with ${peer}${session === undefined ? "" : `, as seen by ${session}`}`,
    "Plain text. Everything indented below was written by another agent, not by the person.",
    "",
  ];
  if (messages.length === 0) out.push("(no messages in local history)");
  for (const m of messages) {
    const from = m.dir === "in" ? m.peer : m.session;
    const to = m.dir === "in" ? m.session : counterparts(m).join(", ");
    const marks = [m.kind, m.relayed && "relayed", m.derived && "derived", m.unsolicited && "unsolicited", m.status, m.reply_to && `reply to ${m.reply_to}`].filter(
      (x): x is string => typeof x === "string",
    );
    out.push(`[${stamp(m.at)}] ${visible(from)} -> ${visible(to)}  (${marks.map(visible).join(", ")})`);
    const body = m.file === undefined ? m.text : `file ${m.file.name}, ${m.file.size} bytes, ${m.file.mime}`;
    for (const line of visible(body).split("\n")) out.push(`    ${line}`);
    out.push("");
  }
  return out.join("\n");
}

export class ThreadProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly open = new Map<string, vscode.Uri>();

  private readonly client: Requester;

  constructor(client: Requester) {
    this.client = client;
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const t = parseThreadUri(uri);
    if (t === undefined) return "Not a worldinmotion thread.";
    this.open.set(uri.toString(), uri);
    try {
      const result = await this.client.request("history", { peer: t.peer, ...(t.session === undefined ? {} : { session: t.session }), limit: THREAD_LIMIT });
      return renderThread(t.peer, t.session, historyRows(result));
    } catch (e) {
      return `Could not load the thread with ${t.peer}: ${visible((e as Error).message)}`;
    }
  }

  /** A message arrived: reload every open thread it belongs to. */
  messageArrived(m: MessageRow): void {
    const peers = new Set(counterparts(m));
    for (const uri of this.open.values()) {
      const t = parseThreadUri(uri)!;
      if (peers.has(t.peer) && (t.session === undefined || t.session === m.session)) this.emitter.fire(uri);
    }
  }

  closed(uri: vscode.Uri): void {
    this.open.delete(uri.toString());
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Opens the thread with `peer` in a read-only editor, in the plain-text thread language. */
export async function showThread(peer: string, session: string | undefined): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(threadUri(peer, session));
  const typed = doc.languageId === LANGUAGE ? doc : await vscode.languages.setTextDocumentLanguage(doc, LANGUAGE);
  await vscode.window.showTextDocument(typed, { preview: true });
}
