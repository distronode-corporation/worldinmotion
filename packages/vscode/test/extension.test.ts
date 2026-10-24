import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activate, deactivate, settings, SETUP_HINT, type TestApi } from "../src/extension.ts";
import { ExtensionMode, fake, Position, Selection, TextDocument, Uri } from "./fake-vscode.ts";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/fake-wim.mjs", import.meta.url));
const HELD = "01JFAKEHELD000000000000001";

type Ctx = { subscriptions: { dispose(): unknown }[]; extensionUri: Uri; extensionPath: string; extensionMode: number };

/** Waits long enough for a loaded machine: the fake client is a real process. */
const waitFor = <T>(check: () => T): Promise<T> => vi.waitFor(check, { timeout: 10_000, interval: 20 });

let dir: string;
let ctx: Ctx | undefined;

function start(mode: number = ExtensionMode.Test): { api: TestApi | undefined; ctx: Ctx } {
  ctx = { subscriptions: [], extensionUri: Uri.file(PKG), extensionPath: PKG, extensionMode: mode };
  return { api: activate(ctx as never), ctx };
}

function stop(): void {
  for (const d of ctx?.subscriptions ?? []) d.dispose();
  ctx = undefined;
}

const requests = (): { op: string; args: Record<string, unknown> }[] =>
  readFileSync(join(dir, "requests.log"), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as { op: string; args: Record<string, unknown> });

beforeEach(() => {
  fake.reset();
  // The real path: the client reports its working directory as the OS resolves it, and on macOS
  // the temp directory is reached through a link (/var is /private/var).
  dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "wim-vscode-")));
  vi.stubEnv("WIM_FAKE_LOG", join(dir, "requests.log"));
  fake.state.config.set("worldinmotion.wimPath", FIXTURE);
});

afterEach(() => {
  stop();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("the client's working directory", () => {
  it("is the home directory without a local folder, and does not follow folder changes", async () => {
    fake.state.workspaceFolders = [{ uri: Uri.from({ scheme: "vscode-remote", authority: "ssh-remote+box", path: "/srv/app" }), name: "app", index: 0 }];
    const { api } = start();
    await waitFor(() => expect(api!.store.sessions.get("vscode@laptop")!.card).toEqual({ cwd: homedir() }));
    // No restart when the folders change: the card keeps the folder the client started in.
    fake.state.workspaceFolders = [{ uri: Uri.file(dir), name: "work", index: 0 }];
    expect(fake.state.output.filter((l) => l.startsWith("starting ")).length).toBe(1);
  });
});

describe("settings", () => {
  it("has defaults", () => {
    fake.reset();
    expect(settings()).toEqual({ sessionName: "vscode", wimPath: "", notifyOnMessage: true });
  });
});

describe("activate", () => {
  it("runs against the fake client: trees, history, approve, notifications, threads and settings", async () => {
    fake.state.workspaceFolders = [{ uri: Uri.file(dir), name: "work", index: 0 }];
    const { api } = start();
    const t = fake.state.treeViews;
    expect(t.get("worldinmotion.mesh")!.message).toBe("Not connected (starting).");
    await waitFor(() => expect(api!.store.messages.length).toBe(2));
    await waitFor(() => expect(t.get("worldinmotion.held")!.badge).toEqual({ value: 1, tooltip: "1 held for you" }));
    expect(t.get("worldinmotion.mesh")!.message).toBeUndefined();
    expect(t.get("worldinmotion.rooms")!.message).toBeUndefined();
    expect(t.get("worldinmotion.leases")!.message).toBeUndefined();
    expect(api!.mesh.getChildren().length).toBe(2);
    // The client runs in this window's first workspace folder, so its card shows that folder.
    expect(api!.store.sessions.get("vscode@laptop")!.card).toEqual({ cwd: dir });
    expect(fake.state.statusItems[0]!.text).toBe("$(broadcast) wim  $(inbox) 1");
    expect(fake.state.output[0]).toMatch(/^starting .*fake-wim\.mjs events --json --as vscode$/);

    // Approve: one click, and the delivered message notifies, naming the sender only.
    fake.state.messageAnswers.push("Open Thread");
    await fake.run("worldinmotion.approve", api!.nodes.held("vscode@laptop", HELD));
    await waitFor(() => expect(fake.state.shown.length).toBe(1));
    expect(requests().find((r) => r.op === "approve")!.args).toEqual({ held: HELD });
    expect(fake.state.messages.find((m) => m.items.includes("Open Thread"))!.message).toBe("worldinmotion: a msg from coder@buildbox.");
    expect(fake.state.shown[0]!.getText()).toContain("    Could you look at the failing test in auth.ts? It fails on main");
    await waitFor(() => expect(t.get("worldinmotion.held")!.message).toBe("Nothing is held for you."));
    expect(t.get("worldinmotion.held")!.badge).toBeUndefined();

    // A send gets a reply; dismissing its notification opens nothing.
    fake.state.activeTextEditor = { document: new TextDocument(Uri.file("/work/a.ts"), "x = 1"), selection: new Selection(new Position(0, 0), new Position(0, 5)) };
    fake.state.quickPickAnswers.push((items) => items.find((i) => (i as { label: string }).label === "coder@buildbox"));
    await fake.run("worldinmotion.sendSelection");
    await waitFor(() => expect(fake.state.messages.filter((m) => m.message === "worldinmotion: a result from coder@buildbox.").length).toBe(1));
    expect(fake.state.shown.length).toBe(1);
    // With notifications off, a reply arrives quietly.
    fake.setConfig("worldinmotion.notifyOnMessage", false);
    fake.state.quickPickAnswers.push((items) => items.find((i) => (i as { label: string }).label === "coder@buildbox"));
    await fake.run("worldinmotion.sendSelection");
    await waitFor(() => expect(api!.store.messages.filter((m) => m.kind === "result" && m.session === "vscode@laptop").length).toBe(2));
    expect(fake.state.messages.filter((m) => m.message.startsWith("worldinmotion: a result")).length).toBe(1);

    // The activity view: select a session in the Mesh tree, open a thread.
    const wv = fake.resolveWebview("worldinmotion.activity");
    wv.webview.receive({ type: "selectSession", address: "coder@buildbox" });
    await waitFor(() => expect(t.get("worldinmotion.mesh")!.revealed).toEqual([api!.nodes.session("coder@buildbox")]));
    wv.webview.receive({ type: "openThread", peer: "coder@buildbox", session: "reviewer@laptop" });
    await waitFor(() => expect(fake.state.shown.length).toBe(2));
    expect(fake.state.shown[1]!.getText()).toContain("Review the auth change, please.");
    fake.state.closeEvents.fire(fake.state.shown[1]!);

    await fake.run("worldinmotion.showActivity");
    expect(fake.state.executed.map((e) => e.id)).toContain("worldinmotion.activity.focus");
    await fake.run("worldinmotion.showLog");
    expect(fake.state.outputShown).toBe(1);
    await fake.run("worldinmotion.refresh");
    expect(requests().some((r) => r.op === "snapshot")).toBe(true);

    // The other commands are registered and reach their actions.
    fake.state.messageAnswers.push("Trust");
    await fake.run("worldinmotion.trust", api!.nodes.device("buildbox"));
    await waitFor(() => expect(api!.store.devices.get("buildbox")!.policy).toBe("deliver"));
    fake.state.messageAnswers.push("Trust, relayed text too");
    await fake.run("worldinmotion.trustRelayed", api!.nodes.device("buildbox"));
    fake.state.messageAnswers.push("Untrust");
    await fake.run("worldinmotion.untrust", api!.nodes.device("buildbox"));
    await fake.run("worldinmotion.resume", api!.nodes.session("coder@buildbox"));
    await fake.run("worldinmotion.refuse", api!.nodes.held("vscode@laptop", "gone"));
    await fake.run("worldinmotion.openThread", api!.nodes.room("#ops"));
    await fake.run("worldinmotion.askAboutSelection");
    await fake.run("worldinmotion.sendFile", Uri.file(FIXTURE));
    expect(requests().map((r) => r.op)).toEqual(expect.arrayContaining(["trust", "untrust", "resume", "refuse"]));

    // A session name or client change restarts the client; other settings do not.
    const starts = () => fake.state.output.filter((l) => l.startsWith("starting ")).length;
    fake.setConfig("worldinmotion.sessionName", "other");
    await waitFor(() => expect(api!.store.self).toBe("other@laptop"));
    fake.setConfig("worldinmotion.wimPath", FIXTURE);
    fake.setConfig("worldinmotion.notifyOnMessage", true);
    expect(starts()).toBe(3);
    await fake.run("worldinmotion.restart");
    expect(starts()).toBe(4);

    // Disposal with a redraw pending.
    api!.store.apply({ type: "connection", at: 1, state: "closed" });
    stop();
    deactivate();
  });

  it("returns nothing outside test mode, and survives a client that exits", async () => {
    vi.stubEnv("WIM_FAKE_SCENARIO", "exit-after-hello");
    const { api } = start(ExtensionMode.Production);
    expect(api).toBeUndefined();
    // The fake exits after hello every time, so the client cycles between starting and closed
    // (restarting after 1 s); each check below holds at some point in that cycle.
    await waitFor(() => expect(fake.state.output).toContain("restarting in 1 s"));
    await waitFor(() => expect(fake.state.output.some((l) => l.startsWith("could not load history: the wim events process"))).toBe(true));
    await waitFor(() => expect(fake.state.statusItems[0]!.text).toBe("$(debug-disconnect) wim"));
    await fake.run("worldinmotion.refresh");
    await waitFor(() => expect(fake.state.messages.at(-1)!.message).toMatch(/^worldinmotion: could not refresh: the wim events process (is not running|exited with code 3: fake wim events for vscode@laptop \(scenario exit-after-hello\))$/));
    await waitFor(() => expect(fake.state.treeViews.get("worldinmotion.mesh")!.message).toBe("Not connected (closed: exited with code 3: fake wim events for vscode@laptop (scenario exit-after-hello))."));
    await waitFor(() => expect(fake.state.treeViews.get("worldinmotion.rooms")!.message).toBe("No rooms."));
    expect(fake.state.treeViews.get("worldinmotion.leases")!.message).toBe("No leases.");
  });

  it("says how to get wim when the device is not set up", async () => {
    vi.stubEnv("WIM_FAKE_SCENARIO", "not-set-up");
    start();
    const mesh = fake.state.treeViews.get("worldinmotion.mesh")!;
    await waitFor(() => expect(mesh.message).toMatch(/^Not connected \(closed: exited with code 2: wim: this device is not set up/));
    expect(mesh.message).toContain(` ${SETUP_HINT}`);
    expect(SETUP_HINT).toContain("download wim.mjs from the worldinmotion GitHub Release");
    expect(SETUP_HINT).toContain("SHA-256");
    expect(SETUP_HINT).toContain("install -m 755 wim.mjs ~/.local/bin/wim");
    expect(SETUP_HINT).toContain("node wim.mjs");
  });

  it("logs and ignores a line of a newer contract version, and keeps going", async () => {
    vi.stubEnv("WIM_FAKE_SCENARIO", "bad-version");
    const { api } = start();
    await waitFor(() => expect(fake.state.output).toContain("ignored a line from wim events: unsupported version 2"));
    expect(api!.store.hello?.version).toBe("0.0.0-fake");
    expect(api!.store.connection.state).toBe("open");
  });
});
