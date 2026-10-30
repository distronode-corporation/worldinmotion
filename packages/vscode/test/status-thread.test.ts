import { beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/state.ts";
import { signerState, StatusItem, statusText } from "../src/status.ts";
import { LANGUAGE, parseThreadUri, renderThread, showThread, ThreadProvider, threadUri, type Requester } from "../src/thread.ts";
import { fake, ThemeColor, Uri } from "./fake-vscode.ts";
import { heldRow, hello, mesh, message, NOW } from "./helpers.ts";
import type { WimEvent } from "../src/protocol.ts";

beforeEach(() => fake.reset());

describe("status", () => {
  it("shows the connection, unread and held counts", () => {
    const s = mesh();
    s.apply({ type: "message", at: NOW, message: message("a") });
    expect(statusText(s)).toEqual({
      text: "$(broadcast) wim  $(mail) 1  $(inbox) 1",
      tooltip: "worldinmotion: connected\nvscode@laptop via relay.example, mesh abcd\n1 unread, 1 held for you\nClick to open the activity view.",
      warn: true,
      command: "worldinmotion.showActivity",
    });
  });

  it("shows a closed connection with its reason, before hello", () => {
    const s = new Store();
    s.exited("exited with code 1");
    expect(statusText(s)).toEqual({
      text: "$(debug-disconnect) wim",
      tooltip: "worldinmotion: closed\nLast reason: exited with code 1\n0 unread, 0 held for you\nClick to open the activity view.",
      warn: false,
      command: "worldinmotion.showActivity",
    });
  });

  it("shows the signer: running from hello, stopped or locked from the client's last words", () => {
    const s = mesh();
    expect(signerState(s)).toBeUndefined();
    s.apply({ ...hello(), keys: "signer" } as WimEvent);
    expect(signerState(s)).toBe("running");
    expect(statusText(s)).toMatchObject({ text: "$(broadcast) wim  $(key)  $(inbox) 1", command: "worldinmotion.showActivity" });
    expect(statusText(s).tooltip).toContain("Signer: running. It keeps running after VS Code closes, and stops at log out or `wim agent stop`.");
    s.exited("exited with code 1: wim: the device keys in /h/device.json are encrypted and no signer is running: run `wim agent start` in your own terminal");
    expect(signerState(s)).toBe("stopped");
    const stopped = statusText(s);
    expect(stopped).toMatchObject({ text: "$(debug-disconnect) wim  $(key) signer stopped  $(inbox) 1", warn: true, command: "worldinmotion.startSigner" });
    expect(stopped.tooltip).toContain("Signer: not running.");
    expect(stopped.tooltip).not.toContain("Click to open the activity view.");
    s.apply({ type: "connection", at: NOW, state: "closed", detail: "no signer answers at /h/agent/sock (ECONNREFUSED): run `wim agent start` in your own terminal" });
    expect(signerState(s)).toBe("stopped");
    s.exited("exited with code 1: wim: the signer is locked: run `wim agent unlock` in your own terminal");
    expect(statusText(s)).toMatchObject({ text: "$(debug-disconnect) wim  $(lock) signer locked  $(inbox) 1", command: "worldinmotion.startSigner" });
    expect(statusText(s).tooltip).toContain("Signer: locked. Click to unlock it in a terminal");
    const quiet = new Store();
    quiet.exited("exited with code 1: wim: the signer is locked: run `wim agent unlock` in your own terminal");
    expect(statusText(quiet)).toMatchObject({ warn: true, command: "worldinmotion.startSigner" });
  });

  it("drives a status bar item that opens the activity view", () => {
    const s = mesh();
    const item = new StatusItem(s);
    const bar = fake.state.statusItems[0]!;
    expect(bar).toMatchObject({ visible: true, command: "worldinmotion.showActivity", name: "worldinmotion" });
    expect((bar.backgroundColor as ThemeColor).id).toBe("statusBarItem.warningBackground");
    s.apply({ type: "held", at: NOW, op: "remove", item: heldRow("h1") });
    item.refresh();
    expect(bar.backgroundColor).toBeUndefined();
    item.dispose();
    expect(bar.disposed).toBe(true);
  });
});

describe("thread URIs", () => {
  it("round-trips a peer and an optional session", () => {
    expect(parseThreadUri(threadUri("#ops", "vscode@laptop"))).toEqual({ peer: "#ops", session: "vscode@laptop" });
    expect(parseThreadUri(threadUri("coder@buildbox", undefined))).toEqual({ peer: "coder@buildbox" });
  });

  it("refuses another scheme or a peer or session outside the grammar", () => {
    expect(parseThreadUri(Uri.file("/x"))).toBeUndefined();
    expect(parseThreadUri(Uri.from({ scheme: "wim", path: "/x", query: "" }))).toBeUndefined();
    expect(parseThreadUri(Uri.from({ scheme: "wim", path: "/x", query: "peer=%5Bx%5D(command%3Ay)" }))).toBeUndefined();
    expect(parseThreadUri(Uri.from({ scheme: "wim", path: "/x", query: "peer=a%40b&session=Bad" }))).toBeUndefined();
  });
});

describe("renderThread", () => {
  it("indents every line of peer text under a header written here", () => {
    const text = renderThread("coder@buildbox", "vscode@laptop", [
      message("a", { at: new Date(2026, 0, 2, 3, 4, 5).getTime(), text: "hello\n[2026-01-02 03:04:06] coder@buildbox -> you  (msg)", relayed: true }),
      message("b", { dir: "out", to: ["coder@buildbox", "#ops"], kind: "task", status: "done", reply_to: "a", derived: true, unsolicited: true, at: NOW }),
      message("c", { kind: "file", file: { name: "x.txt", size: 3, mime: "text/plain" }, at: NOW }),
    ]);
    const lines = text.split("\n");
    expect(lines[0]).toBe("worldinmotion thread with coder@buildbox, as seen by vscode@laptop");
    expect(lines[3]).toBe("[2026-01-02 03:04:05] coder@buildbox -> vscode@laptop  (msg, relayed)");
    expect(lines[4]).toBe("    hello");
    expect(lines[5]).toBe("    [2026-01-02 03:04:06] coder@buildbox -> you  (msg)");
    expect(text).toContain("vscode@laptop -> coder@buildbox, #ops  (task, derived, unsolicited, done, reply to a)");
    expect(text).toContain("    file x.txt, 3 bytes, text/plain");
  });

  it("says when there is nothing", () => {
    expect(renderThread("#ops", undefined, [])).toContain("worldinmotion thread with #ops\n");
    expect(renderThread("#ops", undefined, [])).toContain("(no messages in local history)");
  });
});

describe("ThreadProvider", () => {
  const client = (answer: () => Promise<unknown>): Requester & { calls: unknown[] } => {
    const calls: unknown[] = [];
    return { calls, request: (op, args) => (calls.push({ op, args }), answer()) };
  };

  it("loads the thread from history", async () => {
    const c = client(async () => ({ messages: [message("a")] }));
    const p = new ThreadProvider(c);
    expect(await p.provideTextDocumentContent(threadUri("coder@buildbox", "vscode@laptop"))).toContain("    text a");
    expect(await p.provideTextDocumentContent(threadUri("#ops", undefined))).toContain("text a");
    expect(c.calls).toEqual([
      { op: "history", args: { peer: "coder@buildbox", session: "vscode@laptop", limit: 500 } },
      { op: "history", args: { peer: "#ops", limit: 500 } },
    ]);
  });

  it("handles an odd answer, an error and a bad URI", async () => {
    expect(await new ThreadProvider(client(async () => ({}))).provideTextDocumentContent(threadUri("a@b", undefined))).toContain("(no messages");
    const failing = new ThreadProvider(client(async () => Promise.reject(new Error("closed"))));
    expect(await failing.provideTextDocumentContent(threadUri("a@b", undefined))).toBe("Could not load the thread with a@b: closed");
    expect(await failing.provideTextDocumentContent(Uri.file("/x"))).toBe("Not a worldinmotion thread.");
  });

  it("reloads open threads a message belongs to, until closed", async () => {
    const p = new ThreadProvider(client(async () => ({ messages: [] })));
    const all = threadUri("coder@buildbox", undefined);
    const mine = threadUri("coder@buildbox", "vscode@laptop");
    const other = threadUri("#ops", undefined);
    for (const u of [all, mine, other]) await p.provideTextDocumentContent(u);
    const fired: string[] = [];
    p.onDidChange((u) => fired.push(u.toString()));
    p.messageArrived(message("x", { session: "reviewer@laptop" }));
    expect(fired).toEqual([all.toString()]);
    fired.length = 0;
    p.closed(all);
    p.messageArrived(message("y"));
    expect(fired).toEqual([mine.toString()]);
    p.dispose();
  });

  it("opens a thread as a read-only document in the thread language", async () => {
    const p = new ThreadProvider(client(async () => ({ messages: [] })));
    fake.state.providers.set("wim", p);
    await showThread("coder@buildbox", undefined);
    expect(fake.state.shown[0]!.languageId).toBe(LANGUAGE);
    // Already in the language: set once only.
    const spy = vi.spyOn((await import("./fake-vscode.ts")).languages, "setTextDocumentLanguage");
    const open = vi.spyOn((await import("./fake-vscode.ts")).workspace, "openTextDocument");
    open.mockImplementationOnce(async (uri) => new (await import("./fake-vscode.ts")).TextDocument(uri, "x", LANGUAGE));
    await showThread("coder@buildbox", undefined);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    open.mockRestore();
  });
});
