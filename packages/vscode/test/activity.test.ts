import { describe, expect, it } from "vitest";
import { COLUMN, GAP, HEADER, layout, NODE_GAP, NODE_H, NODE_W, PAD } from "../src/activity/graph.ts";
import { buildState, parseFromWebview, TIMELINE_ROWS } from "../src/activity/model.ts";
import { mesh, message, NOW } from "./helpers.ts";

describe("layout", () => {
  it("puts one column per device and sessions inside it", () => {
    const g = layout(
      [
        { device: "laptop", nodes: ["a@laptop", "b@laptop"] },
        { device: "#", nodes: ["#ops"] },
      ],
      [],
      () => "idle",
    );
    expect(g.width).toBe(PAD * 2 + 2 * COLUMN + GAP);
    expect(g.height).toBe(PAD * 2 + HEADER + 2 * (NODE_H + NODE_GAP) + NODE_GAP);
    expect(g.groups.map((x) => x.device)).toEqual(["laptop", "rooms"]);
    expect(g.nodes.map((n) => n.label)).toEqual(["a", "b", "#ops"]);
    expect(g.nodes[1]!.y - g.nodes[0]!.y).toBe(NODE_H + NODE_GAP);
    expect(g.nodes[2]!.x).toBe(PAD + COLUMN + GAP + (COLUMN - NODE_W) / 2);
  });

  it("is a minimum size with nothing to draw", () => {
    const g = layout([], [], () => "idle");
    expect(g).toEqual({ width: PAD * 2 + COLUMN, height: PAD * 2 + HEADER, groups: [], nodes: [], edges: [] });
  });

  it("draws an edge per direction, bending opposite ways, and skips unknown and self edges", () => {
    const g = layout(
      [
        { device: "x", nodes: ["a@x", "c@x"] },
        { device: "y", nodes: ["b@y"] },
      ],
      [
        { from: "a@x", to: "b@y", count: 4 },
        { from: "b@y", to: "a@x", count: 1 },
        { from: "a@x", to: "c@x", count: 1 },
        { from: "a@x", to: "a@x", count: 9 },
        { from: "a@x", to: "nobody@z", count: 9 },
      ],
      (a) => (a === "b@y" ? "busy" : "idle"),
    );
    expect(g.nodes.map((n) => n.status)).toEqual(["idle", "idle", "busy"]);
    expect(g.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["a@x>b@y", "b@y>a@x", "a@x>c@x"]);
    const [ab, ba, ac] = g.edges as [(typeof g.edges)[0], (typeof g.edges)[0], (typeof g.edges)[0]];
    expect(ab.width).toBe(5);
    expect(ba.width).toBe(3);
    expect(ab.labelY).not.toBe(ba.labelY);
    expect(ab.path).toMatch(/^M [\d.]+ [\d.]+ Q [\d.-]+ [\d.-]+ [\d.]+ [\d.]+$/);
    // Inside one column the edge bends further out to the side.
    expect(Math.abs(ac.labelX - (PAD + COLUMN / 2))).toBe(30);
  });
});

describe("buildState", () => {
  it("carries the timeline and the graph with statuses", () => {
    const s = mesh();
    s.addHistory([message("a", { at: NOW - 1000 }), message("b", { session: "vscode@laptop", dir: "out", to: ["#ops"], at: NOW - 900 })]);
    s.apply({ type: "breaker", at: NOW, peer: "coder@buildbox", state: "tripped" });
    const st = buildState(s, NOW, 5);
    expect(st).toMatchObject({ type: "state", connection: "open", windowMinutes: 5, windows: [5, 15, 60] });
    expect(st.rows.length).toBe(2);
    const status = Object.fromEntries(st.graph.nodes.map((n) => [n.address, n.status]));
    expect(status).toEqual({ "vscode@laptop": "idle", "reviewer@laptop": "busy", "coder@buildbox": "paused", "#ops": "room" });
  });

  it("marks a node with no session row as offline", () => {
    const s = mesh();
    s.addHistory([message("a", { peer: "far@away", at: NOW - 10 })]);
    expect(buildState(s, NOW, 15).graph.nodes.find((n) => n.address === "far@away")!.status).toBe("offline");
    expect(TIMELINE_ROWS).toBe(200);
  });
});

describe("parseFromWebview", () => {
  const s = mesh();
  s.addHistory([message("a")]);

  it("accepts the narrow set", () => {
    expect(parseFromWebview({ type: "ready" }, s)).toEqual({ type: "ready" });
    expect(parseFromWebview({ type: "openThread", peer: "coder@buildbox", session: "vscode@laptop" }, s)).toEqual({
      type: "openThread",
      peer: "coder@buildbox",
      session: "vscode@laptop",
    });
    expect(parseFromWebview({ type: "selectSession", address: "coder@buildbox" }, s)).toEqual({ type: "selectSession", address: "coder@buildbox" });
    expect(parseFromWebview({ type: "window", minutes: 60 }, s)).toEqual({ type: "window", minutes: 60 });
  });

  it("drops anything else", () => {
    for (const bad of [
      null,
      "ready",
      { type: "approve", held: "h1" },
      { type: "trust", device: "buildbox" },
      { type: "openThread", peer: 1, session: "vscode@laptop" },
      { type: "openThread", peer: "coder@buildbox", session: 1 },
      { type: "openThread", peer: "[x](command:y)", session: "vscode@laptop" },
      { type: "openThread", peer: "coder@buildbox", session: "#ops" },
      { type: "openThread", peer: "coder@buildbox", session: "other@laptop" },
      { type: "openThread", peer: "unknown@peer", session: "vscode@laptop" },
      { type: "selectSession", address: "nobody@nowhere" },
      { type: "selectSession", address: 5 },
      { type: "window", minutes: 7 },
    ])
      expect(parseFromWebview(bad, s)).toBeUndefined();
  });
});
