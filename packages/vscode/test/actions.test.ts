import { beforeEach, describe, expect, it } from "vitest";
import * as actions from "../src/actions.ts";
import { RequestError } from "../src/process.ts";
import { Store } from "../src/state.ts";
import { SCHEME, ThreadProvider } from "../src/thread.ts";
import { Nodes } from "../src/tree.ts";
import { fake, Position, Selection, TextDocument, Uri } from "./fake-vscode.ts";
import { device, flush, heldRow, mesh, NOW } from "./helpers.ts";

type Call = { op: string; args: Record<string, unknown>; timeoutMs: number | undefined };

function deps(store: Store = mesh(), answer: (c: Call) => Promise<unknown> = async () => ({ id: "m", results: [{ to: "coder@buildbox", status: "routed" }] })) {
  const calls: Call[] = [];
  const d: actions.Deps = {
    store,
    nodes: new Nodes(),
    now: () => NOW,
    invited: new Set(),
    client: {
      request: (op, args = {}, timeoutMs) => {
        const c = { op, args, timeoutMs };
        calls.push(c);
        return answer(c);
      },
    },
  };
  return { d, calls };
}

const pick = (label: string) => (items: readonly unknown[]) => items.find((i) => (i as { label: string }).label === label);
const editor = (text: string, sel: Selection, path = "/work/src/a.ts") => ({ document: new TextDocument(Uri.file(path), text), selection: sel });
const sel = (a: number, b: number, c: number, e: number) => new Selection(new Position(a, b), new Position(c, e));
const last = () => fake.state.messages.at(-1);

beforeEach(() => fake.reset());

describe("pickTarget", () => {
  it("warns when there is no one to send to", async () => {
    expect(await actions.pickTarget(new Store(), "t")).toBeUndefined();
    expect(last()).toMatchObject({ level: "warning", message: "worldinmotion: no live sessions or rooms to send to." });
  });

  it("offers live sessions and rooms with icon syntax broken", async () => {
    const s = mesh();
    s.apply({ type: "peer", at: NOW, session: { address: "x@buildbox", kind: "$(zap)", status: "idle", since: NOW, rooms: [], local: false } });
    fake.state.quickPickAnswers.push(pick("#ops"));
    expect(await actions.pickTarget(s, "Send to")).toBe("#ops");
    const items = fake.state.quickPicks[0]!.items as { label: string; description: string }[];
    expect(items.map((i) => i.label)).toEqual(["coder@buildbox", "reviewer@laptop", "x@buildbox", "#ops"]);
    expect(items[2]!.description).toBe("$ (zap), idle");
    expect(await actions.pickTarget(s, "Send to")).toBeUndefined();
  });
});

describe("sendMessage", () => {
  it("sends a typed line to a picked target, and stops when either is not given", async () => {
    const { d, calls } = deps();
    fake.state.quickPickAnswers.push(pick("coder@buildbox"));
    fake.state.inputAnswers.push("hello there");
    await actions.sendMessage(d);
    expect(calls).toEqual([{ op: "send", args: { to: "coder@buildbox", text: "hello there", kind: "msg" }, timeoutMs: undefined }]);
    expect(last()).toMatchObject({ level: "info", message: "worldinmotion: sent. coder@buildbox: routed" });
    expect(fake.state.quickPicks[0]!.options).toMatchObject({ title: "Send a message to" });
    // No target, no text, or blank text: nothing is sent.
    await actions.sendMessage(d);
    fake.state.quickPickAnswers.push(pick("coder@buildbox"));
    await actions.sendMessage(d);
    fake.state.quickPickAnswers.push(pick("coder@buildbox"));
    fake.state.inputAnswers.push("   ");
    await actions.sendMessage(d);
    expect(calls).toHaveLength(1);
  });

  it("reports a failed send", async () => {
    const { d } = deps(mesh(), async () => {
      throw new RequestError("refused", "secret");
    });
    fake.state.quickPickAnswers.push(pick("coder@buildbox"));
    fake.state.inputAnswers.push("sk-ant-x");
    await actions.sendMessage(d);
    expect(last()!.message).toMatch(/the text looks like it holds a secret/);
  });
});

describe("selectionText", () => {
  it("names the path and lines; a selection ending at a line start excludes that line", () => {
    expect(actions.selectionText(editor("a\nb\nc", sel(0, 0, 2, 0)) as never)).toBe("src/a.ts:1-2\na\nb\n");
    expect(actions.selectionText(editor("a\nb\nc", sel(1, 0, 1, 1)) as never)).toBe("src/a.ts:2-2\nb");
    expect(actions.selectionText(editor("abc", sel(0, 1, 0, 1)) as never)).toBeUndefined();
    expect(actions.selectionText(editor("abc", sel(0, 0, 0, 3), "/elsewhere/b.ts") as never)).toBe("/elsewhere/b.ts:1-1\nabc");
  });
});

describe("sendSelection and askAboutSelection", () => {
  it("needs a selection", async () => {
    const { d, calls } = deps();
    await actions.sendSelection(d);
    fake.state.activeTextEditor = editor("abc", sel(0, 1, 0, 1)) as never;
    await actions.sendSelection(d);
    expect(fake.state.messages.map((m) => m.message)).toEqual(["worldinmotion: select some text first.", "worldinmotion: select some text first."]);
    expect(calls).toEqual([]);
  });

  it("sends the selection with its place as a msg, and reports the result", async () => {
    const { d, calls } = deps();
    fake.state.activeTextEditor = editor("one\ntwo", sel(0, 0, 1, 3)) as never;
    fake.state.quickPickAnswers.push(pick("coder@buildbox"));
    await actions.sendSelection(d);
    expect(calls).toEqual([{ op: "send", args: { to: "coder@buildbox", text: "src/a.ts:1-2\none\ntwo", kind: "msg" }, timeoutMs: undefined }]);
    expect(last()).toMatchObject({ level: "info", message: "worldinmotion: sent. coder@buildbox: routed" });
  });

  it("stops when the person cancels the pick", async () => {
    const { d, calls } = deps();
    fake.state.activeTextEditor = editor("one", sel(0, 0, 0, 3)) as never;
    await actions.sendSelection(d);
    expect(calls).toEqual([]);
  });

  it("asks a question as a task, or sends the selection alone, or stops on Escape", async () => {
    const { d, calls } = deps(mesh(), async () => ({}));
    fake.state.activeTextEditor = editor("one", sel(0, 0, 0, 3)) as never;
    fake.state.inputAnswers.push(" Why does this fail? ", "", undefined);
    fake.state.quickPickAnswers.push(pick("#ops"), pick("#ops"));
    await actions.askAboutSelection(d);
    await actions.askAboutSelection(d);
    await actions.askAboutSelection(d);
    expect(calls.map((c) => c.args)).toEqual([
      { to: "#ops", text: "Why does this fail?\n\nsrc/a.ts:1-1\none", kind: "task" },
      { to: "#ops", text: "src/a.ts:1-1\none", kind: "task" },
    ]);
    expect(last()).toMatchObject({ message: "worldinmotion: sent. No recipients reported." });
  });

  it("explains a send the secrets check refused, and other failures plainly", async () => {
    const errors = [new RequestError("refused", "secret"), new RequestError("input", "bad [x](command:y)"), new Error("boom")];
    const { d } = deps(mesh(), async () => Promise.reject(errors.shift()));
    fake.state.activeTextEditor = editor("one", sel(0, 0, 0, 3)) as never;
    for (let i = 0; i < 3; i += 1) {
      fake.state.quickPickAnswers.push(pick("coder@buildbox"));
      await actions.sendSelection(d);
    }
    expect(fake.state.messages.map((m) => m.message)).toEqual([
      "worldinmotion: the client refused to send it: the text looks like it holds a secret. To send it anyway, run wim send --allow-secret in a terminal.",
      "worldinmotion: could not send it: input: bad [x] (command:y)",
      "worldinmotion: could not send it: boom",
    ]);
  });
});

describe("sendFile", () => {
  it("sends a local file from the explorer or the editor, with a longer timeout", async () => {
    const { d, calls } = deps();
    fake.state.quickPickAnswers.push(pick("coder@buildbox"), pick("coder@buildbox"));
    await actions.sendFile(d, Uri.file("/work/notes.txt"));
    fake.state.activeTextEditor = editor("x", sel(0, 0, 0, 0), "/work/b.ts") as never;
    await actions.sendFile(d, undefined);
    expect(calls).toEqual([
      { op: "send_file", args: { to: "coder@buildbox", path: "/work/notes.txt" }, timeoutMs: actions.FILE_TIMEOUT_MS },
      { op: "send_file", args: { to: "coder@buildbox", path: "/work/b.ts" }, timeoutMs: actions.FILE_TIMEOUT_MS },
    ]);
    expect((fake.state.quickPicks[0]!.options as { title: string }).title).toBe("Send notes.txt to");
  });

  it("refuses anything that is not a local file, and stops on cancel or failure", async () => {
    const { d, calls } = deps(mesh(), async () => Promise.reject(new RequestError("input", "not a readable file")));
    await actions.sendFile(d, undefined);
    await actions.sendFile(d, Uri.from({ scheme: "vscode-remote", path: "/x" }));
    expect(fake.state.messages.map((m) => m.level)).toEqual(["warning", "warning"]);
    await actions.sendFile(d, Uri.file("/work/a"));
    expect(calls).toEqual([]);
    fake.state.quickPickAnswers.push(pick("coder@buildbox"));
    await actions.sendFile(d, Uri.file("/work/a"));
    expect(last()!.message).toBe("worldinmotion: could not send the file: input: not a readable file");
  });
});

describe("openThread", () => {
  function withThreads(store: Store) {
    const r = deps(store, async () => ({ messages: [] }));
    fake.state.providers.set(SCHEME, new ThreadProvider(r.d.client));
    return r;
  }

  it("opens from a session or room node, marking messages read", async () => {
    const s = mesh();
    s.apply({ type: "message", at: NOW, message: { id: "m", dir: "in", session: "vscode@laptop", peer: "coder@buildbox", kind: "msg", text: "t", at: NOW } });
    const { d } = withThreads(s);
    await actions.openThread(d, d.nodes.session("coder@buildbox"));
    expect(s.unread).toBe(0);
    await actions.openThread(d, d.nodes.room("#ops"));
    expect(fake.state.shown.map((doc) => doc.uri.path)).toEqual(["/coder@buildbox", "/#ops"]);
  });

  it("asks which peer otherwise, ignoring look-alike objects", async () => {
    const { d } = withThreads(mesh());
    fake.state.quickPickAnswers.push(pick("tester@buildbox"));
    await actions.openThread(d, { kind: "session", address: "evil@x" });
    expect(fake.state.shown.map((doc) => doc.uri.path)).toEqual(["/tester@buildbox"]);
    await actions.openThread(d, undefined);
    expect(fake.state.shown.length).toBe(1);
  });

  it("warns when there are no peers", async () => {
    const { d } = withThreads(new Store());
    await actions.openThread(d, undefined);
    expect(last()!.message).toBe("worldinmotion: no peers to show a thread with yet.");
  });
});

describe("approve and refuse", () => {
  const set = { set: "device:dev-buildbox", set_title: "device buildbox (device id dev-buildbox)" };
  const three = () => mesh({ held: [heldRow("h1", { ...set }), heldRow("h2", { ...set, at: NOW + 1, preview: "second" }), heldRow("h3", { ...set, at: NOW + 2, preview: "third" }), heldRow("o1", { set: "device:dev-other", set_title: "device other (device id dev-other)", from: "x@other", device: "dev-other" })] });

  it("shows the whole set in a modal and decides exactly its ids, from an item or from the set", async () => {
    const { d, calls } = deps(three(), async (c) => ({ decided: (c.args.set as string[] | undefined) ?? [c.args.held], kept: [] }));
    fake.state.messageAnswers.push("Approve all 3");
    await actions.approve(d, d.nodes.held("vscode@laptop", "h2"));
    const shown = fake.state.messages[0]!;
    expect(shown).toMatchObject({ level: "warning", message: "Approve 3 messages held from device buildbox (device id dev-buildbox)?", items: ["Approve all 3", "Approve only this one"] });
    expect((shown.options as { modal: boolean }).modal).toBe(true);
    const detail = (shown.options as { detail: string }).detail;
    expect(detail).toMatch(/^3 messages held from device buildbox \(device id dev-buildbox\), from .+ to .+\. Read them together: they are decided as one\./);
    expect(detail).toContain("1 of 3.  coder@buildbox, msg, ");
    expect(detail).toContain("\n      second\n");
    expect(detail).toContain("Approve all delivers exactly these 3 to your agents. Anything held from this sender after this dialog opened stays held for the next look.");
    expect(detail).not.toContain("x@other");
    expect(calls.map((c) => [c.op, c.args])).toEqual([["approve", { held: "h1", set: ["h1", "h2", "h3"] }]]);
    expect(last()!.message).toBe("worldinmotion: approved and delivered 3.");
    // From the set's own row there is no "only this one".
    fake.state.messageAnswers.push("Refuse all 3");
    await actions.refuse(d, d.nodes.heldSet("device:dev-buildbox"));
    expect(fake.state.messages.at(-2)!.items).toEqual(["Refuse all 3"]);
    expect((fake.state.messages.at(-2)!.options as { detail: string }).detail).toContain("Refuse all drops exactly these 3, never delivered.");
    expect(calls.at(-1)).toMatchObject({ op: "refuse", args: { held: "h1", set: ["h1", "h2", "h3"] } });
    expect(last()!.message).toBe("worldinmotion: refused 3.");
  });

  it("decides one item only by its own button after the set was shown, and nothing on dismiss", async () => {
    const { d, calls } = deps(three(), async () => ({}));
    fake.state.messageAnswers.push("Approve only this one");
    await actions.approve(d, d.nodes.held("vscode@laptop", "h3"));
    fake.state.messageAnswers.push("Refuse only this one");
    await actions.refuse(d, d.nodes.held("vscode@laptop", "h2"));
    expect(calls.map((c) => [c.op, c.args])).toEqual([
      ["approve", { held: "h3" }],
      ["refuse", { held: "h2" }],
    ]);
    expect(fake.state.messages.filter((m) => m.level === "info").map((m) => m.message)).toEqual(["worldinmotion: approved and delivered.", "worldinmotion: refused."]);
    await actions.approve(d, d.nodes.held("vscode@laptop", "h1"));
    expect(calls).toHaveLength(2);
    // An older client answers without `decided`: the count shown is what was asked.
    fake.state.messageAnswers.push("Approve all 1");
    await actions.approve(d, d.nodes.held("vscode@laptop", "o1"));
    expect(last()!.message).toBe("worldinmotion: approved and delivered 1.");
  });

  it("never approves a notice that pins ids in a set or alone, says the pause stays, and refuses it with the set", async () => {
    const ci = { set: "ci:R1", set_title: "CI rule github  o/r", from: "ci:github:o/r", device: "" };
    const s = mesh({ held: [heldRow("c1", { ...ci, ci: "github, o/r, refs/heads/main", pins: "repositoryId=1 ownerId=2", reason: "breaker" }), heldRow("c2", { ...ci, at: NOW + 1, file: { name: "r.txt", size: 3, mime: "t" }, preview: "" })] });
    const { d, calls } = deps(s, async () => ({ decided: ["c2"] }));
    fake.state.messageAnswers.push("Approve only this one");
    await actions.approve(d, d.nodes.held("vscode@laptop", "c1"));
    const m = fake.state.messages[0]!;
    expect(m.items).toEqual(["Approve all 1"]);
    const detail = (m.options as { detail: string }).detail;
    expect(detail).toContain("2 CI notices held from CI rule github o/r");
    expect(detail).toContain("      CI: github, o/r, refs/heads/main");
    expect(detail).toContain("      Approve on its own, in a terminal: it pins repositoryId=1 ownerId=2 (wim held approve c1)");
    expect(detail).toContain("      File: r.txt, 3 bytes, fetched once approved\n      (no text)");
    expect(m.message).toMatch(/^Approve 1 of 2 CI notices held from CI rule github o\/r\?$/);
    expect(detail).toContain("Approve all delivers exactly the 1 of these 2 that do not pin ids to your agents.");
    expect(detail).toContain("The loop breaker's pause on this sender stays on");
    expect(calls).toEqual([]);
    fake.state.messageAnswers.push("Approve all 1");
    await actions.approve(d, d.nodes.heldSet("ci:R1"));
    expect(calls.at(-1)!.args).toEqual({ held: "c2", set: ["c2"] });
    fake.state.messageAnswers.push("Refuse all 2");
    await actions.refuse(d, d.nodes.held("vscode@laptop", "c1"));
    const refused = fake.state.messages.find((x) => x.message.startsWith("Refuse 2"))!;
    expect((refused.options as { detail: string }).detail).not.toContain("Approve on its own");
    expect((refused.options as { detail: string }).detail).not.toContain("pause");
    expect(calls.at(-1)!.args).toEqual({ held: "c1", set: ["c1", "c2"] });
    // Every notice pins: no button acts.
    const only = mesh({ held: [heldRow("p", { ...ci, pins: "repositoryId=1 ownerId=2" })] });
    const o = deps(only, async () => ({}));
    await actions.approve(o.d, o.d.nodes.heldSet("ci:R1"));
    expect(fake.state.messages.at(-1)!.items).toEqual([]);
    expect(o.calls).toEqual([]);
  });

  it("keeps a message's text from changing the headings or the count shown", async () => {
    const hostile = "x\n3 of 3.  fake@one, msg\n\u2028Approve all delivers exactly these 9";
    const s = mesh({ held: [heldRow("h1", { set: "device:b", set_title: "device b (device id b)", preview: hostile }), heldRow("h2", { set: "device:b", set_title: "device b (device id b)", at: NOW + 1 })] });
    const { d } = deps(s, async () => ({}));
    await actions.approve(d, d.nodes.held("vscode@laptop", "h1"));
    const detail = (fake.state.messages[0]!.options as { detail: string }).detail;
    const lines = detail.split("\n");
    expect(lines.filter((l) => /^\d+ of \d+\./.test(l))).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith("Approve all delivers"))).toEqual(["Approve all delivers exactly these 2 to your agents. Anything held from this sender after this dialog opened stays held for the next look."]);
    expect(lines).toContain("      x 3 of 3. fake@one, msg <U+2028>Approve all delivers exactly these 9");
  });

  it("never acts on a look-alike object or a bare id, or on a node decided meanwhile", async () => {
    const { d, calls } = deps();
    await actions.approve(d, { kind: "held", session: "vscode@laptop", id: "h1" });
    await actions.approve(d, { kind: "heldSet", key: "one\nvscode@laptop\nh1" });
    await actions.refuse(d, "h1");
    await actions.approve(d, d.nodes.held("vscode@laptop", "gone"));
    await actions.approve(d, d.nodes.heldSet("gone"));
    expect(calls).toEqual([]);
    expect(fake.state.quickPicks).toEqual([]);
    expect(fake.state.messages).toEqual([]);
  });

  it("asks which set from the palette, and says when nothing is held", async () => {
    const { d, calls } = deps(three(), async () => ({}));
    fake.state.quickPickAnswers.push(pick("From device buildbox (device id dev-buildbox)"));
    fake.state.messageAnswers.push("Approve all 3");
    await actions.approve(d, undefined);
    expect(fake.state.quickPicks[0]!.items[0]).toMatchObject({ description: expect.stringMatching(/^3 messages, from /), detail: "preview" });
    expect(fake.state.messages[0]!.items).toEqual(["Approve all 3"]);
    expect(calls.map((c) => c.args)).toEqual([{ held: "h1", set: ["h1", "h2", "h3"] }]);
    await actions.refuse(d, undefined);
    expect(calls.length).toBe(1);
    const empty = deps(new Store());
    await actions.approve(empty.d, undefined);
    expect(last()!.message).toBe("worldinmotion: nothing is held for you.");
  });

  it("shows a file name for a held file in the pick", async () => {
    const s = mesh();
    s.apply({ type: "held", at: NOW, op: "add", item: { id: "f", session: "vscode@laptop", from: "a@b", device: "b", kind: "file", at: NOW + 1, preview: "", reason: "policy", file: { name: "x.bin", size: 1, mime: "m" } } });
    const { d } = deps(s);
    await actions.refuse(d, undefined);
    expect((fake.state.quickPicks[0]!.items as { detail: string }[]).map((i) => i.detail)).toEqual(["preview", "x.bin"]);
  });

  it("reports a failure", async () => {
    const { d } = deps(mesh(), async () => Promise.reject(new RequestError("not_found", "no held message h1")));
    fake.state.messageAnswers.push("Approve all 1", "Refuse only this one");
    await actions.approve(d, d.nodes.held("vscode@laptop", "h1"));
    await actions.refuse(d, d.nodes.held("vscode@laptop", "h1"));
    expect(fake.state.messages.filter((m) => m.level === "error").map((m) => m.message)).toEqual([
      "worldinmotion: could not approve it: not_found: no held message h1",
      "worldinmotion: could not refuse it: not_found: no held message h1",
    ]);
  });
});

describe("setTrust", () => {
  it("asks a modal confirmation naming the device and the new policy, then sends", async () => {
    const { d, calls } = deps(mesh(), async (c) => ({ policy: c.op === "untrust" ? "hold" : c.args.relayed === true ? "deliver-relayed" : "deliver" }));
    fake.state.messageAnswers.push("Trust", "Trust, relayed text too", "Untrust");
    await actions.setTrust(d, d.nodes.device("buildbox"), "trust");
    await actions.setTrust(d, d.nodes.device("buildbox"), "trustRelayed");
    await actions.setTrust(d, d.nodes.device("buildbox"), "untrust");
    const asks = fake.state.messages.filter((m) => m.level === "warning");
    expect(asks.map((m) => [m.message, m.items])).toEqual([
      ['Trust the device "buildbox"?', ["Trust"]],
      ['Trust, relayed text too the device "buildbox"?', ["Trust, relayed text too"]],
      ['Untrust the device "buildbox"?', ["Untrust"]],
    ]);
    expect(asks[0]!.options).toMatchObject({ modal: true, detail: expect.stringContaining("from hold (held for you) to deliver (trusted)") });
    expect(asks[1]!.options).toMatchObject({ detail: expect.stringContaining("to deliver-relayed (trusted, relayed text too)") });
    expect(calls.map((c) => [c.op, c.args])).toEqual([
      ["trust", { device: "buildbox", relayed: false }],
      ["trust", { device: "buildbox", relayed: true }],
      ["untrust", { device: "buildbox" }],
    ]);
    expect(last()!.message).toBe("worldinmotion: buildbox is now hold.");
  });

  it("does nothing when the person cancels, or for this device, a stranger or a look-alike", async () => {
    const s = mesh();
    s.apply({ type: "peer", at: NOW, session: { address: "g@attic", kind: "x", status: "idle", since: NOW, rooms: [], local: false } });
    const { d, calls } = deps(s);
    await actions.setTrust(d, d.nodes.device("buildbox"), "trust");
    await actions.setTrust(d, d.nodes.device("laptop"), "trust");
    await actions.setTrust(d, d.nodes.device("attic"), "trust");
    await actions.setTrust(d, { kind: "device", name: "buildbox" }, "trust");
    expect(calls).toEqual([]);
    expect(fake.state.messages.length).toBe(1);
  });

  it("reports a failure", async () => {
    const s = mesh();
    s.apply({ type: "device", at: NOW, device: device("buildbox") });
    const { d } = deps(s, async () => Promise.reject(new RequestError("not_found", "no device named buildbox")));
    fake.state.messageAnswers.push("Untrust");
    await actions.setTrust(d, d.nodes.device("buildbox"), "untrust");
    expect(last()!.message).toBe("worldinmotion: could not change the policy for buildbox: not_found: no device named buildbox");
  });
});

describe("resume", () => {
  it("lifts a pause on a session node only", async () => {
    const answers = [{ released: 2 }, {}];
    const { d, calls } = deps(mesh(), async () => answers.shift());
    await actions.resume(d, d.nodes.session("coder@buildbox"));
    await actions.resume(d, d.nodes.session("coder@buildbox"));
    await actions.resume(d, { kind: "session", address: "coder@buildbox" });
    await actions.resume(d, undefined);
    expect(calls.map((c) => [c.op, c.args])).toEqual([
      ["resume", { peer: "coder@buildbox" }],
      ["resume", { peer: "coder@buildbox" }],
    ]);
    expect(fake.state.messages.map((m) => m.message)).toEqual([
      "worldinmotion: resumed coder@buildbox; 2 held messages released.",
      "worldinmotion: resumed coder@buildbox; 0 held messages released.",
    ]);
  });

  it("reports a failure", async () => {
    const { d } = deps(mesh(), async () => Promise.reject(new RequestError("closed", "not running")));
    await actions.resume(d, d.nodes.session("coder@buildbox"));
    await flush();
    expect(last()!.message).toBe("worldinmotion: could not resume coder@buildbox: closed: not running");
  });
});
