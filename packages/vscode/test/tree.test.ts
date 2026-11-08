import { describe, expect, it, vi } from "vitest";
import { HeldView, LeasesView, MeshView, Nodes, RoomsView, type Node } from "../src/tree.ts";
import { ThemeIcon, TreeItem, TreeItemCollapsibleState } from "./fake-vscode.ts";
import { device, heldRow, mesh, NOW, session } from "./helpers.ts";

const now = () => NOW;
const item = (v: { getTreeItem(n: Node): unknown }, n: Node) => v.getTreeItem(n) as TreeItem;

describe("Nodes", () => {
  it("returns the same object for the same key, and recognises only its own", () => {
    const n = new Nodes();
    expect(n.device("a")).toBe(n.device("a"));
    expect(n.ours(n.held("a@b", "h"), "held")).toBe(n.held("a@b", "h"));
    expect(n.held("a@b", "h")).not.toBe(n.held("c@b", "h"));
    expect(n.ours({ kind: "held", session: "a@b", id: "h" }, "held")).toBeUndefined();
    expect(n.ours(n.held("a@b", "h"), "device")).toBeUndefined();
    expect(n.ours(null, "held")).toBeUndefined();
    expect(n.ours("h", "held")).toBeUndefined();
    expect(n.member("#r", "a@b")).toEqual({ kind: "member", room: "#r", address: "a@b" });
    expect(n.lease("l")).toEqual({ kind: "lease", name: "l" });
  });
});

describe("MeshView", () => {
  it("lists devices, then their sessions, with presence, card and policy", () => {
    const s = mesh();
    s.apply({ type: "peer", at: NOW, session: session("ghost@attic") });
    const nodes = new Nodes();
    const v = new MeshView(s, nodes, now);
    const roots = v.getChildren();
    expect(roots.map((n) => item(v, n).label)).toEqual(["laptop", "attic", "buildbox"]);

    const laptop = item(v, roots[0]!);
    expect(laptop).toMatchObject({ description: "this device, admin", contextValue: "device.self", collapsibleState: TreeItemCollapsibleState.Expanded });
    expect(laptop.tooltip).not.toContain("Inbound policy");
    const attic = item(v, roots[1]!);
    expect(attic).toMatchObject({ description: "not in the roster", contextValue: "device.unknown" });
    const buildbox = item(v, roots[2]!);
    expect(buildbox).toMatchObject({ description: "held for you", contextValue: "device", id: "device:buildbox" });
    expect((buildbox.iconPath as ThemeIcon).id).toBe("inbox");
    expect(buildbox.tooltip).toContain("Inbound policy: hold (held for you)");

    const onLaptop = v.getChildren(roots[0]!);
    expect(onLaptop.map((n) => item(v, n).label)).toEqual(["reviewer", "vscode"]);
    const reviewer = item(v, onLaptop[0]!);
    expect(reviewer.description).toBe("/home/me/app · review");
    expect((reviewer.iconPath as ThemeIcon).color!.id).toBe("charts.yellow");
    expect(reviewer.command).toEqual({ command: "worldinmotion.openThread", title: "Open Thread", arguments: [onLaptop[0]] });
    expect(item(v, onLaptop[1]!).description).toBe("this window");
    const [coder, tester] = v.getChildren(roots[2]!);
    expect((item(v, coder!).iconPath as ThemeIcon).color!.id).toBe("testing.iconPassed");
    expect(item(v, coder!).tooltip).toMatch(/^coder@buildbox\nKind: claude-code\nStatus: idle since \d{4}-/);
    expect(item(v, coder!).tooltip).toContain("Rooms: #ops\nTitle: Coder\nDirectory: /srv/app\nBranch: main");
    expect((item(v, tester!).iconPath as ThemeIcon).id).toBe("circle-outline");
    expect(v.getChildren(coder!)).toEqual([]);
    expect(v.getParent(coder!)).toBe(roots[2]);
    expect(v.getParent(roots[0]!)).toBeUndefined();
  });

  it("shows a paused peer with its reason, and a vanished session", () => {
    const s = mesh();
    s.apply({ type: "breaker", at: NOW, peer: "coder@buildbox", state: "tripped", reason: "pingpong", until: NOW + 600_000 });
    s.apply({ type: "breaker", at: NOW, peer: "tester@buildbox", state: "tripped" });
    const nodes = new Nodes();
    const v = new MeshView(s, nodes, now);
    const coder = item(v, nodes.session("coder@buildbox"));
    expect(coder).toMatchObject({ contextValue: "session.paused", description: "paused · /srv/app · main" });
    expect(coder.tooltip).toMatch(/Paused by the breaker \(pingpong\) at .*, until /);
    expect(item(v, nodes.session("tester@buildbox")).tooltip).toMatch(/Paused by the breaker at /);
    expect(item(v, nodes.session("gone@nowhere"))).toMatchObject({ description: "gone", contextValue: "session" });
  });

  it("labels every policy and keeps peer text plain", () => {
    const s = mesh();
    const v = new MeshView(s, new Nodes(), now);
    const nodes = new Nodes();
    const w = new MeshView(s, nodes, now);
    for (const [policy, label] of [
      ["deliver", "trusted"],
      ["deliver-relayed", "trusted, relayed text too"],
      ["refuse", "refused"],
    ] as const) {
      s.apply({ type: "device", at: NOW, device: device("buildbox", { policy, role: "admin" }) });
      expect(item(w, nodes.device("buildbox")).description).toBe(`${label}, admin`);
    }
    s.apply({ type: "peer", at: NOW, session: session("x@buildbox", { kind: "$(zap)", card: { cwd: "$(alert) [a](command:b)\n", branch: "" } }) });
    const x = item(v, v.getChildren(v.getChildren()[1]!)[2]!);
    expect(x.description).toBe("$ (alert) [a](command:b)");
    expect(x.tooltip).toContain("Kind: $ (zap)");
    v.dispose();
  });

  it("fires a change on refresh", () => {
    const v = new MeshView(mesh(), new Nodes(), now);
    const fn = vi.fn();
    v.onDidChangeTreeData(fn);
    v.refresh();
    expect(fn).toHaveBeenCalledWith(undefined);
  });
});

describe("RoomsView", () => {
  it("lists rooms and members", () => {
    const s = mesh();
    s.apply({ type: "peer", at: NOW, session: session("solo@buildbox", { rooms: ["#one"] }) });
    const v = new RoomsView(s, new Nodes(), now);
    const rooms = v.getChildren();
    expect(rooms.map((r) => item(v, r).description)).toEqual(["1 member", "2 members"]);
    expect(item(v, rooms[1]!)).toMatchObject({ label: "#ops", contextValue: "room", id: "room:#ops" });
    const members = v.getChildren(rooms[1]!);
    expect(members.map((m) => [item(v, m).label, item(v, m).description])).toEqual([
      ["coder@buildbox", "idle"],
      ["reviewer@laptop", "busy"],
    ]);
    expect(v.getChildren(members[0]!)).toEqual([]);
    // Membership can change between a refresh and a draw.
    s.apply({ type: "peer-removed", at: NOW, address: "solo@buildbox" });
    s.apply({ type: "peer-removed", at: NOW, address: "coder@buildbox" });
    expect(item(v, rooms[0]!).description).toBe("0 members");
    expect(v.getChildren(rooms[0]!)).toEqual([]);
    expect(item(v, members[0]!).description).toBe("");
    expect(v.getParent(rooms[0]!)).toBeUndefined();
  });
});

describe("LeasesView", () => {
  it("lists leases with holder and time left, never the token", () => {
    const s = mesh();
    s.apply({ type: "lease", at: NOW, lease: { name: "old", holder: "a@b", token: 2, expires_at: NOW - 1 } });
    const v = new LeasesView(s, new Nodes(), now);
    const leases = v.getChildren();
    expect(leases.map((l) => [item(v, l).label, item(v, l).description])).toEqual([
      ["deploy", "coder@buildbox, 2 min left"],
      ["old", "a@b, expired"],
    ]);
    expect(item(v, leases[0]!).tooltip).not.toContain("987654321");
    expect(v.getChildren(leases[0]!)).toEqual([]);
    s.apply({ type: "lease-released", at: NOW, name: "old" });
    expect(item(v, leases[1]!).description).toBeUndefined();
  });
});

describe("HeldView", () => {
  it("lists a set per sender, oldest first, each item under it with an inline-action context value", () => {
    const s = mesh();
    s.apply({ type: "held", at: NOW, op: "add", item: heldRow("h0", { at: NOW - 5, reason: "breaker", file: { name: "a.bin", size: 2048, mime: "x/y" } }) });
    const v = new HeldView(s, new Nodes(), now);
    // A client that does not group: each row is a set of its own.
    const sets = v.getChildren();
    expect(sets.map((n) => item(v, n).label)).toEqual(["From coder@buildbox", "From coder@buildbox"]);
    expect(item(v, sets[0]!)).toMatchObject({ contextValue: "heldSet", description: expect.stringMatching(/^1 message, \d\d:\d\d:\d\d$/), collapsibleState: TreeItemCollapsibleState.Expanded });
    expect((item(v, sets[0]!).iconPath as ThemeIcon).id).toBe("debug-pause");
    expect((item(v, sets[1]!).iconPath as ThemeIcon).id).toBe("inbox");
    const held = sets.flatMap((n) => v.getChildren(n));
    expect(held.map((h) => (h as { id: string }).id)).toEqual(["h0", "h1"]);
    expect(held.map((h) => v.getParent(h))).toEqual(sets);
    const file = item(v, held[0]!);
    expect(file).toMatchObject({ label: "coder@buildbox (msg)", description: "a.bin", contextValue: "held", id: "held:vscode@laptop:h0" });
    expect((file.iconPath as ThemeIcon).id).toBe("debug-pause");
    expect(file.tooltip).toContain("Held because the breaker paused this peer.");
    expect(file.tooltip).toContain("File: a.bin, 2.0 KiB, x/y");
    const plain = item(v, held[1]!);
    expect(plain.description).toBe("preview");
    expect(plain.tooltip).toContain("Held by this device's policy");
    expect(plain.tooltip).toContain("Preview (another agent's text):\npreview");
    expect(v.getChildren(held[0]!)).toEqual([]);
    expect(v.getParent(sets[0]!)).toBeUndefined();
    s.apply({ type: "held", at: NOW, op: "remove", item: heldRow("h1") });
    expect(item(v, held[1]!)).toMatchObject({ label: "(decided)", contextValue: undefined, id: "held:vscode@laptop:h1" });
    expect(item(v, sets[1]!)).toMatchObject({ label: "(decided)", contextValue: undefined });
    expect(v.getChildren(sets[1]!)).toEqual([]);
    expect(v.getParent(held[1]!)).toBeUndefined();
  });

  it("groups by the set the client names, with its title, count and span, and marks a CI notice that pins ids", () => {
    const set = { set: "device:dev-buildbox", set_title: "device buildbox (device id dev-buildbox)" };
    const s = mesh({ held: [heldRow("b", { at: NOW + 60_000, ...set }), heldRow("a", { ...set }), heldRow("c", { set: "ci:R1", set_title: "CI rule github  o/r", from: "ci:github:o/r", device: "", ci: "github, o/r, refs/heads/main", pins: "repositoryId=1 ownerId=2" })] });
    const v = new HeldView(s, new Nodes(), now);
    const sets = v.getChildren();
    expect(sets.map((n) => item(v, n).label)).toEqual(["From device buildbox (device id dev-buildbox)", "From CI rule github o/r"]);
    expect(item(v, sets[0]!).description).toMatch(/^2 messages, \d\d:\d\d:\d\d to \d\d:\d\d:\d\d$/);
    expect(item(v, sets[0]!).tooltip).toMatch(/^2 messages held from device buildbox \(device id dev-buildbox\), from .+ to .+\.\nApprove or Refuse shows them all together/);
    expect(item(v, sets[1]!).description).toMatch(/^1 CI notice, /);
    expect(v.getChildren(sets[0]!).map((h) => (h as { id: string }).id)).toEqual(["a", "b"]);
    const ci = item(v, v.getChildren(sets[1]!)[0]!);
    expect(ci.tooltip).toContain("Held by its CI rule.");
    expect(ci.tooltip).toContain("CI: github, o/r, refs/heads/main");
    expect(ci.tooltip).toContain("Approved only on its own, in a terminal: it pins repositoryId=1 ownerId=2");
  });

  it("shows a message held by two local sessions as two rows of one set", () => {
    const s = mesh({ held: [heldRow("x", { session: "agent@laptop", set: "device:b" }), heldRow("x", { set: "device:b" })] });
    const v = new HeldView(s, new Nodes(), now);
    const [set] = v.getChildren();
    const held = v.getChildren(set!);
    expect(item(v, set!).description).toMatch(/^1 message, /);
    expect(held.map((h) => item(v, h).tooltip)).toEqual([expect.stringContaining("For agent@laptop"), expect.stringContaining("For vscode@laptop")]);
    s.apply({ type: "held", at: NOW, op: "remove", item: heldRow("x", { session: "agent@laptop" }) });
    expect(held.map((h) => item(v, h).label)).toEqual(["(decided)", "coder@buildbox (msg)"]);
  });
});
