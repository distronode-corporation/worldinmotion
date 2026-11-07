// Activation: starts `wim events --json`, feeds the store, and wires the views, the status bar,
// the activity webview, the thread documents and the commands to it.

import * as vscode from "vscode";
import * as actions from "./actions.ts";
import { VIEW_ID, ActivityView } from "./activity/view.ts";
import { notice, oneLine } from "./display.ts";
import { homedir } from "node:os";
import { clientCommand, clientCwd, crashReportsTerminal, EventsProcess, recoveryTerminal, selfTestCommand, signerTerminal, type SpawnFn } from "./process.ts";
import { runSelfTest } from "./selftest.ts";
import { spawn as nodeSpawn } from "node:child_process";
import { historyRows, type DeviceRef, type JoinedDevice, type MessageRow } from "./protocol.ts";
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
 * Shown with a "not set up" exit, which the extension's own client does not give (it runs in
 * setup mode instead), but a client chosen with worldinmotion.wimPath may. VS Code alone needs
 * no npm: the extension runs its own copy of the client.
 */
export const SETUP_HINT =
  "This extension runs its own copy of wim, so VS Code alone needs no npm: clear the worldinmotion.wimPath setting (or point it at a newer wim) and run worldinmotion: Restart Client, then choose Create a Mesh or Join with a Code in the Mesh view.";

/** Where the device ids the person marked Not Mine are kept (global state: this machine only). */
export const NOT_MINE_KEY = "worldinmotion.notMine";
/** At most this many are kept; the oldest go first. */
export const NOT_MINE_MAX = 1000;

/** The `worldinmotion.state` context key, which the welcome content and menus read. */
export type ViewState = "setup" | "mesh" | "closed";

/** Said when a new mesh's recovery code was not collected, or the client holding it was stopped. */
export const RECOVERY_LOST = "worldinmotion: the recovery code was not collected and is gone. In a terminal: wim recovery rotate";

export type Settings = { sessionName: string; wimPath: string; notifyOnMessage: boolean; notifyForClaudeTabs: boolean };

export function settings(): Settings {
  const c = vscode.workspace.getConfiguration("worldinmotion");
  return {
    sessionName: c.get<string>("sessionName", "vscode"),
    wimPath: c.get<string>("wimPath", ""),
    notifyOnMessage: c.get<boolean>("notifyOnMessage", true),
    notifyForClaudeTabs: c.get<boolean>("notifyForClaudeTabs", false),
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
  const notMine = {
    has: (id: string): boolean => (context.globalState.get<string[]>(NOT_MINE_KEY) ?? []).includes(id),
    add: (id: string): Thenable<void> => context.globalState.update(NOT_MINE_KEY, [...(context.globalState.get<string[]>(NOT_MINE_KEY) ?? []).filter((x) => x !== id), id].slice(-NOT_MINE_MAX)),
  };
  const deps: actions.Deps = { store, client, nodes, now, invited: new Set(), notMine };
  /** Who admitted this device and the other devices, asked about once the client runs in the mesh this device just joined. */
  let trustAfterJoin: { approver: DeviceRef | undefined; others: JoinedDevice[] } | undefined;
  /** Set from a `create` answer until its `created`: the client holds a recovery code. */
  let recoveryWaits = false;
  /**
   * Restarts the client. One that holds a recovery code loses it when stopped, and its last line
   * (`created`) is not read once it is being stopped, so that is said here.
   */
  const restartClient = (): void => {
    if (recoveryWaits) void vscode.window.showWarningMessage(RECOVERY_LOST);
    recoveryWaits = false;
    proc!.restart();
  };

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
  let viewState: ViewState | undefined;
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
    const now: ViewState = store.setup !== undefined ? "setup" : state === "open" || store.sessions.size > 0 ? "mesh" : "closed";
    if (now !== viewState) {
      viewState = now;
      vscode.commands.executeCommand("setContext", "worldinmotion.state", now).then(undefined, failed("set the view state"));
    }
    // In setup mode the view has no text of its own, so its welcome content (package.json
    // `viewsWelcome`: Create a Mesh, Join with a Code) shows instead.
    meshTree.message =
      now !== "closed" ? undefined : `Not connected (${state}${detail === undefined ? "" : `: ${oneLine(detail, 200)}`}).${setup}`;
    roomsTree.message = store.rooms.size === 0 ? "No rooms." : undefined;
    leasesTree.message = store.leases.size === 0 ? "No leases." : undefined;
  };
  const schedule = (): void => {
    redraw ??= setTimeout(draw, REDRAW_MS);
  };
  const tick = setInterval(schedule, TICK_MS);

  const notify = (m: MessageRow): void => {
    // The notification names the sender and the kind, never the text; for another local session
    // (a Claude Code tab), also the address it went to.
    const to = m.session === store.self ? "" : ` to ${m.session}`;
    vscode.window.showInformationMessage(notice(`worldinmotion: a ${m.kind} from ${m.peer}${to}.`, 160), "Open Thread").then((choice) => {
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
      return clientCommand({ extensionPath: context.extensionPath, wimPath: s.wimPath, sessionName: s.sessionName, execPath: process.execPath, env: process.env, telemetry: vscode.env.isTelemetryEnabled, cwd });
    },
    onEvent: (ev) => {
      // A device new to the mesh since the snapshot: asked about when another device added it.
      const added = ev.type === "device" && !store.devices.has(ev.device.name) ? ev.device : undefined;
      store.apply(ev);
      if (added !== undefined && store.askAbout(added, notMine)) void actions.thirdDevice(deps, added);
      if (ev.type === "hello") loadHistory();
      if (ev.type === "join" && ev.op === "add") void actions.joinRequested(deps, ev.request);
      if (ev.type === "join_failed") void vscode.window.showErrorMessage(notice(`worldinmotion: joining the mesh failed: ${ev.message}`));
      if (ev.type === "joined") {
        // The client ends after joining; started again, it runs in the mesh, and its first
        // snapshot is when the person is asked about the other devices.
        trustAfterJoin = { approver: ev.admitted_by, others: ev.devices };
        proc!.restart();
      }
      if (ev.type === "created") {
        // The client ends once the recovery code was collected or its window closed; started
        // again, it runs in the new mesh.
        recoveryWaits = false;
        if (ev.recovery === "not_collected") void vscode.window.showWarningMessage(RECOVERY_LOST);
        proc!.restart();
      }
      if (ev.type === "snapshot" && trustAfterJoin !== undefined) {
        void actions.joinTrust(deps, trustAfterJoin.approver, trustAfterJoin.others);
        trustAfterJoin = undefined;
      }
      if (ev.type === "message") threads.messageArrived(ev.message);
      const s = settings();
      const m = toNotify(store, ev, s.notifyForClaudeTabs);
      if (m !== undefined && s.notifyOnMessage) notify(m);
    },
    onState: (state, detail) => {
      if (state === "starting") return store.reset();
      store.exited(detail!);
      // A client that exited on its own holds no recovery code any more: said once if it held one.
      if (recoveryWaits) void vscode.window.showWarningMessage(RECOVERY_LOST);
      recoveryWaits = false;
    },
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
      signerTerminal({ extensionPath: context.extensionPath, wimPath: s.wimPath, execPath: process.execPath, env: process.env, telemetry: vscode.env.isTelemetryEnabled, locked: signerState(store) === "locked", cwd: homedir() }),
    );
    signer = t;
    t.show();
  };
  /** Opens the terminal where `wim recovery show --wait` shows a new mesh's recovery code. */
  const showRecovery = (): void => {
    const s = settings();
    vscode.window.createTerminal(recoveryTerminal({ extensionPath: context.extensionPath, wimPath: s.wimPath, execPath: process.execPath, env: process.env, telemetry: vscode.env.isTelemetryEnabled, cwd: homedir() })).show();
  };
  /** The crash-reports terminals still open, and whether each turns reports on. */
  const crashTerminals = new Map<vscode.Terminal, boolean>();
  /** Opens a terminal running `wim crash-reports on` (which asks first) or `off`. */
  const crashReports = (on: boolean): void => {
    const s = settings();
    const t = vscode.window.createTerminal(crashReportsTerminal({ extensionPath: context.extensionPath, wimPath: s.wimPath, execPath: process.execPath, env: process.env, telemetry: vscode.env.isTelemetryEnabled, on, cwd: homedir() }));
    crashTerminals.set(t, on);
    t.show();
  };
  /**
   * VS Code closes a terminal as soon as its process exits, taking the client's last line with it,
   * so the outcome is said again here. Closed by the person before it exited: nothing is said.
   */
  const crashReportsClosed = (t: vscode.Terminal): void => {
    const on = crashTerminals.get(t);
    if (on === undefined) return;
    crashTerminals.delete(t);
    const code = t.exitStatus?.code;
    if (code === 0) vscode.window.showInformationMessage(on ? "worldinmotion: crash reports are on. worldinmotion: Turn Crash Reports Off stops them." : "worldinmotion: crash reports are off.");
    else if (code !== undefined) vscode.window.showWarningMessage(`worldinmotion: crash reports were not changed (exit code ${code}).`);
  };
  const signerClosed = (t: vscode.Terminal): void => {
    if (t !== signer) return;
    signer = undefined;
    const code = t.exitStatus?.code;
    if (code === 0) vscode.window.showInformationMessage("worldinmotion: the signer is running. It keeps running after VS Code closes, and stops at log out or `wim agent stop`.");
    else if (code !== undefined) vscode.window.showWarningMessage(`worldinmotion: the signer did not start (exit code ${code}). Run worldinmotion: Start Signer again, or \`wim agent status\` in a terminal.`);
    restartClient();
  };

  /** The self-test's own output channel, made at its first run. */
  let selfTestOut: vscode.OutputChannel | undefined;
  const selfTest = (): Promise<void> => {
    selfTestOut ??= vscode.window.createOutputChannel("worldinmotion self-test");
    return runSelfTest({
      window: vscode.window,
      notification: vscode.ProgressLocation.Notification,
      channel: selfTestOut,
      command: () => selfTestCommand({ extensionPath: context.extensionPath, wimPath: settings().wimPath, execPath: process.execPath, env: process.env, telemetry: vscode.env.isTelemetryEnabled, cwd: homedir() }),
      spawn: nodeSpawn as unknown as SpawnFn,
    });
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
    command("worldinmotion.sendMessage", () => actions.sendMessage(deps)),
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
    command("worldinmotion.addDevice", () => actions.addDevice(deps)),
    command("worldinmotion.admitDevice", () => actions.admitDevice(deps)),
    command("worldinmotion.reviewTrust", () => actions.reviewTrust(deps)),
    command("worldinmotion.joinMesh", () => actions.joinMesh(deps)),
    command("worldinmotion.createMesh", () => actions.createMesh(deps, showRecovery, () => (recoveryWaits = true))),
    command("worldinmotion.refresh", () =>
      client.request("snapshot").catch((e: Error) => vscode.window.showErrorMessage(notice(`worldinmotion: could not refresh: ${e.message}`))),
    ),
    command("worldinmotion.showActivity", async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      store.markRead();
    }),
    command("worldinmotion.showLog", () => out.show(true)),
    command("worldinmotion.restart", restartClient),
    command("worldinmotion.startSigner", startSigner),
    command("worldinmotion.crashReportsOn", () => crashReports(true)),
    command("worldinmotion.crashReportsOff", () => crashReports(false)),
    command("worldinmotion.runSelfTest", selfTest),
    // The client is told at start whether VS Code's telemetry is off (no crash reports then).
    vscode.env.onDidChangeTelemetryEnabled(restartClient),
    vscode.window.onDidCloseTerminal(signerClosed),
    vscode.window.onDidCloseTerminal(crashReportsClosed),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("worldinmotion.sessionName") || e.affectsConfiguration("worldinmotion.wimPath")) restartClient();
    }),
    {
      dispose: () => {
        selfTestOut?.dispose();
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
