// Layout for the activity graph: one column per device, its sessions stacked inside, and a
// curved edge per direction between two sessions. Pure geometry; the webview only draws it.

import { nameOf } from "../display.ts";
import type { Edge } from "../state.ts";

export const COLUMN = 200;
export const GAP = 48;
export const HEADER = 28;
export const NODE_W = 168;
export const NODE_H = 28;
export const NODE_GAP = 12;
export const PAD = 16;

export type GraphGroup = { device: string; x: number; y: number; w: number; h: number };
export type GraphNode = { address: string; label: string; x: number; y: number; w: number; h: number; status: string };
export type GraphEdge = { from: string; to: string; count: number; path: string; labelX: number; labelY: number; width: number };
export type GraphLayout = { width: number; height: number; groups: GraphGroup[]; nodes: GraphNode[]; edges: GraphEdge[] };

const round = (n: number): number => Math.round(n * 10) / 10;

export function layout(groups: { device: string; nodes: string[] }[], edges: Edge[], status: (address: string) => string): GraphLayout {
  const centers = new Map<string, { x: number; y: number }>();
  const outGroups: GraphGroup[] = [];
  const nodes: GraphNode[] = [];
  let tallest = 0;
  groups.forEach((g, col) => {
    const x = PAD + col * (COLUMN + GAP);
    const h = HEADER + g.nodes.length * (NODE_H + NODE_GAP) + NODE_GAP;
    tallest = Math.max(tallest, h);
    outGroups.push({ device: g.device === "#" ? "rooms" : g.device, x, y: PAD, w: COLUMN, h });
    g.nodes.forEach((address, row) => {
      const nx = x + (COLUMN - NODE_W) / 2;
      const ny = PAD + HEADER + NODE_GAP + row * (NODE_H + NODE_GAP);
      nodes.push({ address, label: address.startsWith("#") ? address : nameOf(address), x: nx, y: ny, w: NODE_W, h: NODE_H, status: status(address) });
      centers.set(address, { x: nx + NODE_W / 2, y: ny + NODE_H / 2 });
    });
  });
  const drawn = edges.filter((e) => e.from !== e.to && centers.has(e.from) && centers.has(e.to));
  const most = Math.max(1, ...drawn.map((e) => e.count));
  const outEdges: GraphEdge[] = [];
  for (const e of drawn) {
    const a = centers.get(e.from)!;
    const b = centers.get(e.to)!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    // Bend to the left of the direction of travel, so A to B and B to A never overlap; edges
    // inside one column bend further, clear of the nodes between them.
    const bend = dx === 0 ? 60 : 24;
    const cx = (a.x + b.x) / 2 - (dy / len) * bend;
    const cy = (a.y + b.y) / 2 + (dx / len) * bend;
    outEdges.push({
      from: e.from,
      to: e.to,
      count: e.count,
      path: `M ${round(a.x)} ${round(a.y)} Q ${round(cx)} ${round(cy)} ${round(b.x)} ${round(b.y)}`,
      // The midpoint of a quadratic curve is halfway between the chord's midpoint and the control.
      labelX: round(((a.x + b.x) / 2 + cx) / 2),
      labelY: round(((a.y + b.y) / 2 + cy) / 2),
      width: round(1 + 4 * Math.sqrt(e.count / most)),
    });
  }
  return {
    width: PAD * 2 + Math.max(1, groups.length) * COLUMN + Math.max(0, groups.length - 1) * GAP,
    height: PAD * 2 + Math.max(tallest, HEADER),
    groups: outGroups,
    nodes,
    edges: outEdges,
  };
}
