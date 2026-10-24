import { afterEach, describe, expect, it, vi } from "vitest";
import { buildState } from "../src/activity/model.ts";
import { boot, render } from "../src/webview/render.ts";
import { FakeDoc, FakeEl } from "./fake-dom.ts";
import { mesh, message, NOW } from "./helpers.ts";

const HOSTILE = '<img src=x onerror="alert(1)"> [run](command:workbench.action.terminal.new) $(zap)';

function setup() {
  const s = mesh();
  s.addHistory([
    message("a", { text: HOSTILE, relayed: true, at: NOW - 1000 }),
    message("b", { dir: "out", to: ["coder@buildbox"], peer: "coder@buildbox", at: NOW - 500 }),
    message("c", { dir: "out", to: ["#ops"], peer: "#ops", at: NOW - 400 }),
    message("d", { dir: "out", peer: "", at: NOW - 300 }),
  ]);
  const doc = new FakeDoc();
  const root = new FakeEl("main");
  const posted: unknown[] = [];
  render(doc, root, buildState(s, NOW, 15), (m) => posted.push(m));
  return { root, posted };
}

describe("render", () => {
  it("sets peer text only as text, and makes no elements from it", () => {
    const { root } = setup();
    const tags = new Set(root.all().map((e) => e.tag));
    expect(tags.has("img")).toBe(false);
    expect(tags.has("a")).toBe(false);
    const cell = root.find((e) => e.attrs.get("class") === "text")[3]!;
    expect(cell.textContent).toBe(HOSTILE);
    for (const e of root.all()) for (const name of e.attrs.keys()) expect(name.startsWith("on")).toBe(false);
  });

  it("draws the graph in SVG", () => {
    const { root } = setup();
    const svgs = root.find((e) => e.ns === "http://www.w3.org/2000/svg");
    expect(svgs.some((e) => e.tag === "svg")).toBe(true);
    expect(root.find((e) => e.attrs.get("class") === "edge").length).toBeGreaterThan(0);
    expect(root.find((e) => e.attrs.get("class") === "group-label").map((e) => e.textContent)).toEqual(["laptop", "rooms", "buildbox"]);
    const badge = root.find((e) => e.attrs.get("class") === "badge badge-relayed");
    expect(badge.map((e) => e.textContent)).toEqual(["relayed"]);
  });

  it("posts the window choice, a thread on a row, and a session on a node", () => {
    const { root, posted } = setup();
    const buttons = root.find((e) => e.tag === "button");
    expect(buttons.map((b) => [b.textContent, b.attrs.get("aria-pressed")])).toEqual([
      ["5 min", "false"],
      ["15 min", "true"],
      ["60 min", "false"],
    ]);
    buttons[2]!.dispatch("click");
    const rows = root.find((e) => e.attrs.get("class") === "row");
    expect(rows.length).toBe(4);
    // Newest first: d (no peer, not clickable), c, b, a.
    expect(rows[0]!.listeners.size).toBe(0);
    rows[3]!.dispatch("click");
    expect(rows[2]!.dispatch("keydown", "Enter")).toBe(true);
    expect(rows[2]!.dispatch("keydown", " ")).toBe(true);
    expect(rows[2]!.dispatch("keydown", "a")).toBe(false);
    const nodes = root.find((e) => e.tag === "g");
    const room = nodes.find((n) => n.attrs.get("aria-label") === "#ops")!;
    expect(room.listeners.size).toBe(0);
    nodes.find((n) => n.attrs.get("aria-label") === "coder@buildbox")!.dispatch("click");
    expect(posted).toEqual([
      { type: "window", minutes: 60 },
      { type: "openThread", peer: "coder@buildbox", session: "vscode@laptop" },
      { type: "openThread", peer: "coder@buildbox", session: "vscode@laptop" },
      { type: "openThread", peer: "coder@buildbox", session: "vscode@laptop" },
      { type: "selectSession", address: "coder@buildbox" },
    ]);
  });

  it("says so when there are no messages, and names a closed connection", () => {
    const s = mesh();
    s.exited("gone");
    const root = new FakeEl("main");
    render(new FakeDoc(), root, buildState(s, NOW, 15), () => undefined);
    expect(root.find((e) => e.attrs.get("class") === "empty").length).toBe(1);
    expect(root.find((e) => e.attrs.get("class") === "conn conn-closed")[0]!.textContent).toBe("closed");
  });
});

describe("boot", () => {
  it("draws each state message, ignores others, and says ready", () => {
    const doc = new FakeDoc();
    const root = new FakeEl("main");
    doc.byId.set("root", root);
    let listener: (ev: { data: unknown }) => void = () => undefined;
    const posted: unknown[] = [];
    boot({ document: doc, addEventListener: (_t, fn) => (listener = fn) }, { postMessage: (m) => posted.push(m) });
    expect(posted).toEqual([{ type: "ready" }]);
    listener({ data: { type: "nope" } });
    listener({ data: null });
    expect(root.children.length).toBe(0);
    listener({ data: buildState(mesh(), NOW, 15) });
    expect(root.children.length).toBe(3);
  });
});

describe("main", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("boots with the webview's API", async () => {
    const doc = new FakeDoc();
    doc.byId.set("root", new FakeEl("main"));
    const posted: unknown[] = [];
    vi.stubGlobal("document", doc);
    vi.stubGlobal("addEventListener", () => undefined);
    vi.stubGlobal("acquireVsCodeApi", () => ({ postMessage: (m: unknown) => posted.push(m) }));
    await import("../src/webview/main.ts");
    expect(posted).toEqual([{ type: "ready" }]);
  });
});
