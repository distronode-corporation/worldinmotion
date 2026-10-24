// The activity webview: a timeline of recent messages and a graph of who talks to whom. The page
// is locked down: CSP `default-src 'none'`, one script from the media folder with a nonce, one
// stylesheet from the same folder, no command URIs, and only the media folder readable.

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { Store } from "../state.ts";
import { buildState, parseFromWebview, type WindowMinutes } from "./model.ts";

export const VIEW_ID = "worldinmotion.activity";

export type ActivityHandlers = {
  openThread(peer: string, session: string): void;
  selectSession(address: string): void;
  log(line: string): void;
};

export function html(cspSource: string, script: string, style: string, nonce: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src ${cspSource}; script-src 'nonce-${nonce}';">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<link rel="stylesheet" href="${style}">`,
    "<title>worldinmotion activity</title>",
    "</head>",
    "<body>",
    '<main id="root"></main>',
    `<script nonce="${nonce}" src="${script}"></script>`,
    "</body>",
    "</html>",
  ].join("\n");
}

export class ActivityView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private windowMinutes: WindowMinutes = 15;

  private readonly extensionUri: vscode.Uri;
  private readonly store: Store;
  private readonly handlers: ActivityHandlers;
  private readonly now: () => number;

  constructor(extensionUri: vscode.Uri, store: Store, handlers: ActivityHandlers, now: () => number) {
    this.extensionUri = extensionUri;
    this.store = store;
    this.handlers = handlers;
    this.now = now;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = { enableScripts: true, enableCommandUris: false, enableForms: false, localResourceRoots: [media] };
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "activity.js")).toString();
    const style = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "activity.css")).toString();
    view.webview.html = html(view.webview.cspSource, script, style, randomBytes(18).toString("base64"));
    view.webview.onDidReceiveMessage((msg: unknown) => this.receive(msg));
    view.onDidChangeVisibility(() => this.shown());
    view.onDidDispose(() => {
      this.view = undefined;
    });
    this.shown();
  }

  private shown(): void {
    if (this.view?.visible !== true) return;
    this.store.markRead();
    this.refresh();
  }

  private receive(raw: unknown): void {
    const msg = parseFromWebview(raw, this.store);
    if (msg === undefined) {
      this.handlers.log("ignored a message from the activity view that is not one it may send");
      return;
    }
    switch (msg.type) {
      case "ready":
        this.refresh();
        return;
      case "openThread":
        this.handlers.openThread(msg.peer, msg.session);
        return;
      case "selectSession":
        this.handlers.selectSession(msg.address);
        return;
      case "window":
        this.windowMinutes = msg.minutes;
        this.refresh();
    }
  }

  /** Redraws the view if it is showing. */
  refresh(): void {
    if (this.view?.visible !== true) return;
    void this.view.webview.postMessage(buildState(this.store, this.now(), this.windowMinutes));
  }
}
