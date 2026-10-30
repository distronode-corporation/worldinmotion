// The status bar item: connection state, the signer's state, unread and held counts. Clicking it
// opens the activity view, or starts the signer when it is not running. Its text holds only this
// extension's own words and numbers; the tooltip is plain text.

import * as vscode from "vscode";
import { visible } from "./display.ts";
import type { Store } from "./state.ts";

const ICON = { starting: "$(sync~spin)", connecting: "$(sync~spin)", open: "$(broadcast)", closed: "$(debug-disconnect)" } as const;

/**
 * The signer's state as this window can tell it: `running` when the client reached it (its keys are
 * the signer's), `stopped` or `locked` when the client says it cannot reach it or it is locked
 * (packages/client: home.ts and signer.ts word those), undefined for a plaintext key file or while
 * nothing says.
 */
export type SignerState = "running" | "stopped" | "locked";

export function signerState(store: Store): SignerState | undefined {
  const detail = store.connection.detail ?? "";
  if (/no signer (is running|answers)/.test(detail)) return "stopped";
  if (/the signer is locked/.test(detail)) return "locked";
  return store.hello?.keys === "signer" ? "running" : undefined;
}

const SIGNER = {
  running: { part: "$(key)", line: "Signer: running. It keeps running after VS Code closes, and stops at log out or `wim agent stop`." },
  stopped: {
    part: "$(key) signer stopped",
    line: "Signer: not running. This device's keys are encrypted, so nothing here works until it runs. Click to start it in a terminal (it asks for the passphrase there).",
  },
  locked: { part: "$(lock) signer locked", line: "Signer: locked. Click to unlock it in a terminal (it asks for the passphrase there)." },
} as const;

export function statusText(store: Store): { text: string; tooltip: string; warn: boolean; command: string } {
  const { state, detail } = store.connection;
  const signer = signerState(store);
  const parts = [`${ICON[state]} wim`];
  if (signer !== undefined) parts.push(SIGNER[signer].part);
  if (store.unread > 0) parts.push(`$(mail) ${store.unread}`);
  if (store.held.size > 0) parts.push(`$(inbox) ${store.held.size}`);
  const h = store.hello;
  const down = signer === "stopped" || signer === "locked";
  const tooltip = [
    `worldinmotion: ${state === "open" ? "connected" : state}`,
    h === undefined ? undefined : `${visible(h.session)} via ${visible(h.relay)}, mesh ${visible(h.mesh)}`,
    detail === undefined ? undefined : `Last reason: ${visible(detail)}`,
    signer === undefined ? undefined : SIGNER[signer].line,
    `${store.unread} unread, ${store.held.size} held for you`,
    down ? undefined : "Click to open the activity view.",
  ]
    .filter((x) => x !== undefined)
    .join("\n");
  return { text: parts.join("  "), tooltip, warn: store.held.size > 0 || down, command: down ? "worldinmotion.startSigner" : "worldinmotion.showActivity" };
}

export class StatusItem {
  private readonly item = vscode.window.createStatusBarItem("worldinmotion.status", vscode.StatusBarAlignment.Left, 50);

  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
    this.item.name = "worldinmotion";
    this.refresh();
    this.item.show();
  }

  refresh(): void {
    const s = statusText(this.store);
    this.item.text = s.text;
    this.item.tooltip = s.tooltip;
    this.item.command = s.command;
    this.item.backgroundColor = s.warn ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
