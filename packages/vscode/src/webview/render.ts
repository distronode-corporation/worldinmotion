// Draws the activity view inside the webview. Peer text is only ever set as `textContent` on an
// element made with createElement or createElementNS: no HTML strings, no Markdown, no links.
// Written against the small DOM surface below so it runs under tests without a browser.

import type { ToWebview } from "../activity/model.ts";

export type Listener = (ev: { key?: string; preventDefault(): void }) => void;

export interface El {
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  appendChild(child: El): El;
  replaceChildren(...children: El[]): void;
  addEventListener(type: "click" | "keydown", fn: Listener): void;
}

export interface Doc {
  createElement(tag: string): El;
  createElementNS(ns: string, tag: string): El;
}

export type Post = (msg: unknown) => void;

const SVG = "http://www.w3.org/2000/svg";

function el(doc: Doc, tag: string, attrs: Record<string, string> = {}, text?: string): El {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function svg(doc: Doc, tag: string, attrs: Record<string, string | number>, text?: string): El {
  const e = doc.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Click and Enter (or Space) both activate. */
function activate(e: El, fn: () => void): void {
  e.setAttribute("tabindex", "0");
  e.addEventListener("click", () => fn());
  e.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      fn();
    }
  });
}

function toolbar(doc: Doc, state: ToWebview, post: Post): El {
  const bar = el(doc, "div", { class: "toolbar" });
  bar.appendChild(el(doc, "span", { class: `conn conn-${state.connection}` }, state.connection === "open" ? "connected" : state.connection));
  bar.appendChild(el(doc, "span", { class: "label" }, "Graph window:"));
  for (const minutes of state.windows) {
    const b = el(doc, "button", { type: "button", "aria-pressed": String(minutes === state.windowMinutes) }, `${minutes} min`);
    b.addEventListener("click", () => post({ type: "window", minutes }));
    bar.appendChild(b);
  }
  return bar;
}

function graph(doc: Doc, state: ToWebview, post: Post): El {
  const g = state.graph;
  const root = svg(doc, "svg", { class: "graph", width: g.width, height: g.height, viewBox: `0 0 ${g.width} ${g.height}`, role: "img" });
  root.appendChild(svg(doc, "title", {}, `Messages between sessions over the last ${state.windowMinutes} minutes`));
  const defs = svg(doc, "defs", {});
  const marker = svg(doc, "marker", { id: "arrow", viewBox: "0 0 10 10", refX: 10, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" });
  marker.appendChild(svg(doc, "path", { d: "M 0 0 L 10 5 L 0 10 z", class: "arrow" }));
  defs.appendChild(marker);
  root.appendChild(defs);
  for (const grp of g.groups) {
    root.appendChild(svg(doc, "rect", { class: "group", x: grp.x, y: grp.y, width: grp.w, height: grp.h, rx: 6 }));
    root.appendChild(svg(doc, "text", { class: "group-label", x: grp.x + 10, y: grp.y + 18 }, grp.device));
  }
  for (const e of g.edges) {
    const path = svg(doc, "path", { class: "edge", d: e.path, "stroke-width": e.width, "marker-end": "url(#arrow)" });
    path.appendChild(svg(doc, "title", {}, `${e.from} to ${e.to}: ${e.count}`));
    root.appendChild(path);
    root.appendChild(svg(doc, "text", { class: "edge-label", x: e.labelX, y: e.labelY }, String(e.count)));
  }
  for (const n of g.nodes) {
    const node = svg(doc, "g", { class: `node node-${n.status}`, role: "button", "aria-label": n.address });
    node.appendChild(svg(doc, "title", {}, `${n.address} (${n.status})`));
    node.appendChild(svg(doc, "rect", { x: n.x, y: n.y, width: n.w, height: n.h, rx: 4 }));
    node.appendChild(svg(doc, "text", { x: n.x + 10, y: n.y + n.h / 2 + 4 }, n.label));
    if (!n.address.startsWith("#")) activate(node, () => post({ type: "selectSession", address: n.address }));
    root.appendChild(node);
  }
  return root;
}

const COLUMNS = ["Time", "From", "To", "Kind", "", "Status", "Text"];

function table(doc: Doc, state: ToWebview, post: Post): El {
  if (state.rows.length === 0) return el(doc, "p", { class: "empty" }, "No messages yet. Messages sent or received by sessions on this device appear here.");
  const t = el(doc, "table", { class: "timeline" });
  const head = el(doc, "tr");
  for (const c of COLUMNS) head.appendChild(el(doc, "th", { scope: "col" }, c));
  const thead = el(doc, "thead");
  thead.appendChild(head);
  t.appendChild(thead);
  const body = el(doc, "tbody");
  for (const r of state.rows) {
    const tr = el(doc, "tr", { class: "row" });
    for (const [cls, text] of [
      ["time", r.time],
      ["from", r.from],
      ["to", r.to],
      ["kind", r.kind],
    ] as const)
      tr.appendChild(el(doc, "td", { class: cls }, text));
    const badges = el(doc, "td", { class: "badges" });
    for (const b of r.badges) badges.appendChild(el(doc, "span", { class: `badge badge-${b}` }, b));
    tr.appendChild(badges);
    tr.appendChild(el(doc, "td", { class: "status" }, r.status));
    tr.appendChild(el(doc, "td", { class: "text" }, r.text));
    if (r.peer !== "") activate(tr, () => post({ type: "openThread", peer: r.peer, session: r.session }));
    body.appendChild(tr);
  }
  t.appendChild(body);
  return t;
}

export function render(doc: Doc, root: El, state: ToWebview, post: Post): void {
  const graphBox = el(doc, "section", { class: "graph-box", "aria-label": "Graph" });
  graphBox.appendChild(graph(doc, state, post));
  const list = el(doc, "section", { class: "list", "aria-label": "Timeline" });
  list.appendChild(table(doc, state, post));
  root.replaceChildren(toolbar(doc, state, post), graphBox, list);
}

function isState(x: unknown): x is ToWebview {
  return typeof x === "object" && x !== null && (x as { type?: unknown }).type === "state";
}

export type WebviewGlobals = {
  document: Doc & { getElementById(id: string): El | null };
  addEventListener(type: "message", fn: (ev: { data: unknown }) => void): void;
};

/** Wires the page: draws each `state` message, and says `ready` once listening. */
export function boot(g: WebviewGlobals, api: { postMessage(msg: unknown): void }): void {
  const root = g.document.getElementById("root")!;
  const post: Post = (msg) => api.postMessage(msg);
  g.addEventListener("message", (ev) => {
    if (isState(ev.data)) render(g.document, root, ev.data, post);
  });
  post({ type: "ready" });
}
