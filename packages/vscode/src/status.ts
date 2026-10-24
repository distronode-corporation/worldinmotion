// The status bar item: connection state, unread and held counts. Clicking it opens the activity
// view. Its text holds only this extension's own words and numbers; the tooltip is plain text.

import * as vscode from "vscode";
import { visible } from "./display.ts";
import type { Store } from "./state.ts";

const ICON = { starting: "$(sync~spin)", connecting: "$(sync~spin)", open: "$(broadcast)", closed: "$(debug-disconnect)" } as const;

export function statusText(store: Store): { text: string; tooltip: string; warn: boolean } {
  const { state, detail } = store.connection;
  const parts = [`${ICON[state]} wim`];
  if (store.unread > 0) parts.push(`$(mail) ${store.unread}`);
  if (store.held.size > 0) parts.push(`$(inbox) ${store.held.size}`);
  const h = store.hello;
  const tooltip = [
    `worldinmotion: ${state === "open" ? "connected" : state}`,
    h === undefined ? undefined : `${visible(h.session)} via ${visible(h.relay)}, mesh ${visible(h.mesh)}`,
    detail === undefined ? undefined : `Last reason: ${visible(detail)}`,
    `${store.unread} unread, ${store.held.size} held for you`,
    "Click to open the activity view.",
  ]
    .filter((x) => x !== undefined)
    .join("\n");
  return { text: parts.join("  "), tooltip, warn: store.held.size > 0 };
}

export class StatusItem {
  private readonly item = vscode.window.createStatusBarItem("worldinmotion.status", vscode.StatusBarAlignment.Left, 50);

  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
    this.item.name = "worldinmotion";
    this.item.command = "worldinmotion.showActivity";
    this.refresh();
    this.item.show();
  }

  refresh(): void {
    const s = statusText(this.store);
    this.item.text = s.text;
    this.item.tooltip = s.tooltip;
    this.item.backgroundColor = s.warn ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
