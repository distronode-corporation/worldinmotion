import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityView, html, VIEW_ID } from "../src/activity/view.ts";
import { fake, Uri, window } from "./fake-vscode.ts";
import { mesh, message, NOW } from "./helpers.ts";

beforeEach(() => fake.reset());

describe("html", () => {
  it("locks the page down with a nonce and no inline anything", () => {
    const page = html("https://cdn", "https://cdn/a.js", "https://cdn/a.css", "N0nce");
    expect(page).toContain(`content="default-src 'none'; img-src https://cdn; style-src https://cdn; script-src 'nonce-N0nce';"`);
    expect(page).toContain('<script nonce="N0nce" src="https://cdn/a.js"></script>');
    expect(page).toContain('<link rel="stylesheet" href="https://cdn/a.css">');
    expect(page).not.toMatch(/\son\w+=/);
    expect(page).not.toContain("<style");
  });
});

function setup() {
  const store = mesh();
  store.addHistory([message("a", { at: NOW - 1000 })]);
  store.apply({ type: "message", at: NOW, message: message("b") });
  const handlers = { openThread: vi.fn(), selectSession: vi.fn(), log: vi.fn() };
  const view = new ActivityView(Uri.file("/ext"), store, handlers, () => NOW);
  window.registerWebviewViewProvider(VIEW_ID, view as never);
  const wv = fake.resolveWebview(VIEW_ID);
  return { store, handlers, view, wv };
}

describe("ActivityView", () => {
  it("sets safe options and only the media folder as a resource root", () => {
    const { wv } = setup();
    expect(wv.webview.options).toEqual({ enableScripts: true, enableCommandUris: false, enableForms: false, localResourceRoots: [Uri.file("/ext/media")] });
    expect(wv.webview.html).toContain("https://file+.vscode-resource.fake.vscode-cdn.net/ext/media/activity.js");
    expect(wv.webview.html).toMatch(/script-src 'nonce-[A-Za-z0-9+/]{24}'/);
  });

  it("posts state when shown, and marks messages read", () => {
    const { store, wv } = setup();
    expect(store.unread).toBe(0);
    expect(wv.webview.posted.length).toBe(1);
    expect(wv.webview.posted[0]).toMatchObject({ type: "state", windowMinutes: 15 });
  });

  it("handles the narrow set of messages and logs anything else", () => {
    const { handlers, wv } = setup();
    wv.webview.receive({ type: "ready" });
    wv.webview.receive({ type: "window", minutes: 60 });
    expect(wv.webview.posted.at(-1)).toMatchObject({ windowMinutes: 60 });
    wv.webview.receive({ type: "openThread", peer: "coder@buildbox", session: "vscode@laptop" });
    wv.webview.receive({ type: "selectSession", address: "coder@buildbox" });
    wv.webview.receive({ type: "approve", held: "h1" });
    expect(handlers.openThread).toHaveBeenCalledWith("coder@buildbox", "vscode@laptop");
    expect(handlers.selectSession).toHaveBeenCalledWith("coder@buildbox");
    expect(handlers.log).toHaveBeenCalledWith("ignored a message from the activity view that is not one it may send");
    expect(wv.webview.posted.length).toBe(3);
  });

  it("does not post while hidden or after disposal", () => {
    const { view, wv, store } = setup();
    wv.setVisible(false);
    view.refresh();
    store.apply({ type: "message", at: NOW, message: message("c") });
    expect(store.unread).toBe(1);
    wv.setVisible(true);
    expect(store.unread).toBe(0);
    expect(wv.webview.posted.length).toBe(2);
    wv.dispose();
    view.refresh();
    expect(wv.webview.posted.length).toBe(2);
  });
});
