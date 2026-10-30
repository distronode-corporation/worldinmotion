// Activation: starts `wim events --json`, feeds the store, and wires the views, the status bar,
// the activity webview, the thread documents and the commands to it.

import * as vscode from "vscode";
import * as actions from "./actions.ts";
import { VIEW_ID, ActivityView } from "./activity/view.ts";
import { notice, oneLine } from "./display.ts";
import { homedir } from "node:os";
import { clientCommand, clientCwd, EventsProcess, signerTerminal } from "./process.ts";
import { historyRows, type MessageRow } from "./protocol.ts";
import { Store, toNotify } from "./state.ts";
import { signerState, StatusItem } from "./status.ts";
import { SCHEME, showThread, ThreadProvider, type Requester } from "./thread.ts";
import { HeldView, LeasesView, MeshView, Nodes, RoomsView } from "./tree.ts";

export const HISTORY_ON_START = 200;
/** Redraws are batched: a burst of events draws once. */
export const REDRAW_MS = 50;
/** Lease countdowns and lapsed breaker pauses are redrawn this often even without events. */
export const TICK_MS = 15_000;

/**
 * Shown with a "not set up" exit. The extension runs its own copy of the client, but setting up
 * a device is a terminal step, and nothing here puts a `wim` command on the PATH.
 */
export const SETUP_HINT =
  "To set up this device, download wim.mjs from the worldinmotion GitHub Release and check its SHA-256 against the one published with it. Install it as wim (for example install -m 755 wim.mjs ~/.local/bin/wim), or run it as node wim.mjs. Then run wim init --relay <url> for a new mesh, or wim init and then wim join <invite> to join one, and restart the client.";

export type Settings = { sessionName: string; wimPath: string; notifyOnMessage: boolean };

export function settings(): Settings {
  const c = vscode.workspace.getConfiguration("worldinmotion");
  return {
    sessionName: c.get<string>("sessionName", "vscode"),
    wimPath: c.get<string>("wimPath", ""),
    notifyOnMessage: c.get<boolean>("notifyOnMessage", true),
  };
}

/** What the integration smoke test may look at; returned only in test mode. */
export type TestApi = { store: Store; nodes: Nodes; mesh: MeshView; held: HeldView };

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  const out = vscode.window.createOutputChannel("worldinmotion");
  const store = new Store();
  const nodes = new Nodes();
  const now = (): number => Date.now();
  const log = (line: string): void => out.appendLine(line);

  // Filled in below; the views and providers only call it after activation.
  let proc: EventsProcess | undefined;
  const client: Requester = { request: (op, args, timeoutMs) => proc!.request(op, args, timeoutMs) };
  const deps: actions.Deps = { store, client, nodes, now };

  const mesh = new MeshView(store, nodes, now);
  const rooms = new RoomsView(store, nodes, now);
  const leases = new LeasesView(store, nodes, now);
  const held = new HeldView(store, nodes, now);
  const meshTree = vscode.window.createTreeView("worldinmotion.mesh", { treeDataProvider: mesh, showCollapseAll: true });
  const roomsTree = vscode.window.createTreeView("worldinmotion.rooms", { treeDataProvider: rooms });
  const leasesTree = vscode.window.createTreeView("worldinmotion.leases", { treeDataProvider: leases });
  const heldTree = vscode.window.createTreeView("worldinmotion.held", { treeDataProvider: held });
  const status = new StatusItem(store);
  const threads = new ThreadProvider(client);

  /** Logs a failed background step; nothing the person asked for directly. */
  const failed =
    (what: string) =>
    (e: Error): void =>
      log(`could not ${what}: ${e.message}`);
  const openThreadAs = (peer: string, session: string | undefined): void => {
    store.markRead();
    showThread(peer, session).catch(failed("open the thread"));
  };
  const activity = new ActivityView(
    context.extensionUri,
    store,
    {
      openThread: openThreadAs,
      selectSession: (address) => {
        meshTree.reveal(nodes.session(address), { select: true, focus: true }).then(undefined, failed(`reveal ${address}`));
      },
      log,
    },
    now,
  );

  let redraw: ReturnType<typeof setTimeout> | undefined;
  const draw = (): void => {
    redraw = undefined;
    for (const v of [mesh, rooms, leases, held]) v.refresh();
    status.refresh();
    activity.refresh();
    const n = store.held.size;
    heldTree.badge = n === 0 ? undefined : { value: n, tooltip: `${n} held for you` };
    heldTree.message = n === 0 ? "Nothing is held for you." : undefined;
    const { state, detail } = store.connection;
    const setup = detail?.includes("not set up") === true ? ` ${SETUP_HINT}` : "";
    meshTree.message = state === "open" || store.sessions.size > 0 ? undefined : `Not connected (${state}${detail === undefined ? "" : `: ${oneLine(detail, 200)}`}).${setup}`;
    roomsTree.message = store.rooms.size === 0 ? "No rooms." : undefined;
    leasesTree.message = store.leases.size === 0 ? "No leases." : undefined;
  };
  const schedule = (): void => {
    redraw ??= setTimeout(draw, REDRAW_MS);
  };
  const tick = setInterval(schedule, TICK_MS);

  const notify = (m: MessageRow): void => {
    // The notification names the sender and the kind, never the text.
    vscode.window.showInformationMessage(notice(`worldinmotion: a ${m.kind} from ${m.peer}.`, 120), "Open Thread").then((choice) => {
      if (choice === "Open Thread") openThreadAs(m.peer, m.session);
    });
  };

  const loadHistory = (): void => {
    client
      .request("history", { limit: HISTORY_ON_START })
      .then((r) => store.addHistory(historyRows(r)))
      .catch(failed("load history"));
  };

  proc = new EventsProcess({
    command: () => {
      const s = settings();
      // Read at each (re)start. A folder added to a multi-root window later does not restart the
      // client, so the card keeps the folder it started with; opening another folder reloads
      // the window, which starts a new client there.
      const cwd = clientCwd(vscode.workspace.workspaceFolders?.map((f) => f.uri), homedir());
      return clientCommand({ extensionPath: context.extensionPath, wimPath: s.wimPath, sessionName: s.sessionName, execPath: process.execPath, env: process.env, cwd });
    },
    onEvent: (ev) => {
      store.apply(ev);
      if (ev.type === "hello") loadHistory();
      if (ev.type === "message") threads.messageArrived(ev.message);
      const m = toNotify(store, ev);
      if (m !== undefined && settings().notifyOnMessage) notify(m);
    },
    onState: (state, detail) => (state === "starting" ? store.reset() : store.exited(detail!)),
    log,
  });
  const stopStore = store.onChange(schedule);

  /**
   * Opens a terminal running `wim agent start` (or `unlock`) with this window's client. When it
   * closes, the client is restarted at once instead of waiting out its backoff.
   */
  let signer: vscode.Terminal | undefined;
  const startSigner = (): void => {
    const s = settings();
    const t = vscode.window.createTerminal(
      signerTerminal({ extensionPath: context.extensionPath, wimPath: s.wimPath, execPath: process.execPath, env: process.env, locked: signerState(store) === "locked", cwd: homedir() }),
    );
    signer = t;
    t.show();
  };
  const signerClosed = (t: vscode.Terminal): void => {
    if (t !== signer) return;
    signer = undefined;
    const code = t.exitStatus?.code;
    if (code === 0) vscode.window.showInformationMessage("worldinmotion: the signer is running. It keeps running after VS Code closes, and stops at log out or `wim agent stop`.");
    else if (code !== undefined) vscode.window.showWarningMessage(`worldinmotion: the signer did not start (exit code ${code}). Run worldinmotion: Start Signer again, or \`wim agent status\` in a terminal.`);
    proc!.restart();
  };

  const command = (id: string, fn: (arg: unknown) => unknown): vscode.Disposable => vscode.commands.registerCommand(id, fn);
  context.subscriptions.push(
    out,
    meshTree,
    roomsTree,
    leasesTree,
    heldTree,
    mesh,
    rooms,
    leases,
    held,
    status,
    threads,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, threads),
    vscode.workspace.onDidCloseTextDocument((doc) => threads.closed(doc.uri)),
    vscode.window.registerWebviewViewProvider(VIEW_ID, activity, { webviewOptions: { retainContextWhenHidden: false } }),
    command("worldinmotion.sendSelection", () => actions.sendSelection(deps)),
    command("worldinmotion.askAboutSelection", () => actions.askAboutSelection(deps)),
    command("worldinmotion.sendFile", (arg) => actions.sendFile(deps, arg)),
    command("worldinmotion.openThread", (arg) => actions.openThread(deps, arg)),
    command("worldinmotion.approve", (arg) => actions.approve(deps, arg)),
    command("worldinmotion.refuse", (arg) => actions.refuse(deps, arg)),
    command("worldinmotion.trust", (arg) => actions.setTrust(deps, arg, "trust")),
    command("worldinmotion.trustRelayed", (arg) => actions.setTrust(deps, arg, "trustRelayed")),
    command("worldinmotion.untrust", (arg) => actions.setTrust(deps, arg, "untrust")),
    command("worldinmotion.resume", (arg) => actions.resume(deps, arg)),
    command("worldinmotion.refresh", () =>
      client.request("snapshot").catch((e: Error) => vscode.window.showErrorMessage(notice(`worldinmotion: could not refresh: ${e.message}`))),
    ),
    command("worldinmotion.showActivity", async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      store.markRead();
    }),
    command("worldinmotion.showLog", () => out.show(true)),
    command("worldinmotion.restart", () => proc!.restart()),
    command("worldinmotion.startSigner", startSigner),
    vscode.window.onDidCloseTerminal(signerClosed),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("worldinmotion.sessionName") || e.affectsConfiguration("worldinmotion.wimPath")) proc!.restart();
    }),
    {
      dispose: () => {
        proc!.stop();
        stopStore();
        clearInterval(tick);
        if (redraw !== undefined) clearTimeout(redraw);
      },
    },
  );

  proc.start();
  draw();
  return context.extensionMode === vscode.ExtensionMode.Test ? { store, nodes, mesh, held } : undefined;
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
