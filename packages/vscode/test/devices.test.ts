// Adding a device from VS Code: Add a Device... (an invite, copied with a button), the admit
// dialog where the person types the comparison code the new device shows, the trust question, and
// Create a Mesh... and Join with a Code... on a device in no mesh yet.

import { beforeEach, describe, expect, it } from "vitest";
import * as actions from "../src/actions.ts";
import { RequestError } from "../src/process.ts";
import type { DeviceRow, JoinRow } from "../src/protocol.ts";
import { Store } from "../src/state.ts";
import { Nodes } from "../src/tree.ts";
import { fake, type InputBoxOptions } from "./fake-vscode.ts";
import { mesh, NOW } from "./helpers.ts";

type Call = { op: string; args: Record<string, unknown>; timeoutMs: number | undefined };

function deps(store: Store = mesh(), answer: (c: Call) => Promise<unknown> = async () => ({})) {
  const calls: Call[] = [];
  const d: actions.Deps = {
    store,
    nodes: new Nodes(),
    now: () => NOW,
    invited: new Set(),
    notMine: new Set<string>(),
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

const request: JoinRow = { name: "newbox", id: "dev-newbox", invite: "inv-1", at: NOW, exp: NOW + 3_600_000 };
const messages = () => fake.state.messages.map((m) => m.message);
const box = (i = 0): InputBoxOptions => fake.state.inputBoxes[i]!;

/** A store whose client runs in setup mode. */
function inSetup(): Store {
  const s = new Store();
  s.apply({ type: "setup", at: NOW, version: "1" });
  return s;
}

/** Answers the next quick pick with the item whose `key` field is `value`. */
const choose = (key: string, value: unknown) => fake.state.quickPickAnswers.push((items) => items.find((i) => (i as Record<string, unknown>)[key] === value));

beforeEach(() => fake.reset());

describe("Add a Device...", () => {
  it("makes an invite and copies its code with a button, never showing it", async () => {
    const { d, calls } = deps(mesh(), async () => ({ code: "wim1_secret", invite: "inv-1", exp: NOW + 3_600_000 }));
    choose("way", "other");
    fake.state.messageAnswers.push("Copy Invite Code");
    await actions.addDevice(d);
    expect(fake.state.quickPicks[0]).toMatchObject({ items: actions.ADD_WAYS, options: { title: "Add a device", ignoreFocusOut: true } });
    expect(calls).toEqual([{ op: "invite", args: { own: false }, timeoutMs: undefined }]);
    expect(fake.state.messages[0]!.options).toMatchObject({ detail: expect.stringContaining("Its messages stay held here until you approve them.") });
    expect(fake.state.clipboard).toBe("wim1_secret");
    expect(JSON.stringify(fake.state.messages)).not.toContain("wim1_secret");
    expect(fake.state.messages[0]!.options).toMatchObject({ modal: true, detail: expect.stringMatching(/^On the new device, in a terminal: wim join <code>.*never through an agent/) });
    expect(messages().at(-1)).toBe("worldinmotion: invite code copied.");
    expect(d.invited.has("inv-1")).toBe(true);
    // Dismissed: nothing is copied.
    fake.state.clipboard = undefined;
    choose("way", "other");
    await actions.addDevice(d);
    expect(fake.state.clipboard).toBeUndefined();
  });

  it("asks whose device it is first: own goes in the request, pairing is not in this version, Escape sends nothing", async () => {
    const { d, calls } = deps(mesh(), async () => ({ code: "wim1_secret", invite: "inv-9", exp: NOW + 3_600_000 }));
    expect(actions.ADD_WAYS.map((w) => w.label)).toEqual(["My device, by pairing code", "My device, by invite code", "Another person's device"]);
    await actions.addDevice(d);
    choose("way", "pair");
    await actions.addDevice(d);
    expect(messages()).toEqual([actions.ADD_PAIRING_LATER]);
    expect(calls).toEqual([]);
    choose("way", "own");
    fake.state.messageAnswers.push(undefined);
    await actions.addDevice(d);
    expect(calls).toEqual([{ op: "invite", args: { own: true }, timeoutMs: undefined }]);
    expect(fake.state.messages.at(-1)!.options).toMatchObject({ detail: expect.stringContaining("Once admitted, its messages are trusted here.") });
  });

  it("offers the full code too when the invite has a short one, for an older device", async () => {
    const short = "wim2-ABCD-EFGH-JKMN-PQRS-TVWX-YZ01";
    const { d } = deps(mesh(), async () => ({ code: short, invite: "inv-2", exp: NOW + 3_600_000, full: "wim1_secret" }));
    choose("way", "own");
    fake.state.messageAnswers.push("Copy Invite Code");
    await actions.addDevice(d);
    expect(fake.state.messages[0]!.items).toEqual(["Copy Invite Code", "Copy Full Code"]);
    expect(fake.state.messages[0]!.options).toMatchObject({ detail: expect.stringMatching(/ A device on wim 0\.1\.10 or older cannot read it: upgrade it to 0\.2\.0 before it joins\.$/) });
    expect(fake.state.clipboard).toBe(short);
    choose("way", "own");
    fake.state.messageAnswers.push("Copy Full Code");
    await actions.addDevice(d);
    expect(fake.state.clipboard).toBe("wim1_secret");
    expect(messages().at(-1)).toBe("worldinmotion: full invite code copied.");
    expect(JSON.stringify(fake.state.messages)).not.toMatch(/wim1_secret|wim2-ABCD/);
  });

  it("says why it cannot invite: no mesh yet, or the client refused", async () => {
    await actions.addDevice(deps(inSetup()).d);
    expect(messages()).toEqual(["worldinmotion: this device is in no mesh yet. Create or join one first (Create a Mesh or Join with a Code in the Mesh view)."]);
    choose("way", "other");
    await actions.addDevice(deps(mesh(), async () => Promise.reject(new RequestError("not_admin", "only an admin device can invite"))).d);
    expect(messages().at(-1)).toBe("worldinmotion: could not make an invite: not_admin: only an admin device can invite");
  });
});

describe("admitting a device", () => {
  it("asks for the code at once for its own invite, admits, and asks nothing more", async () => {
    const { d, calls } = deps(mesh(), async () => ({ device: "newbox", trusted: false }));
    d.invited.add("inv-1");
    fake.state.inputAnswers.push(" abcde-fghjk ");
    await actions.joinRequested(d, request);
    expect(box()).toMatchObject({ title: "Add newbox to the mesh", placeHolder: "XXXXX-XXXXX", ignoreFocusOut: true });
    expect(box().prompt).toMatch(/Type the comparison code the new device shows \(device id dev-newbox\)/);
    expect(box().validateInput!("ABCDE-FGHJK")).toBeUndefined();
    expect(box().validateInput!("abcdefghjk")).toBeUndefined();
    expect(box().validateInput!("ABCDE")).toBe("10 letters and digits, as the new device shows them");
    expect(calls).toEqual([{ op: "admit", args: { device: "newbox", code: "abcde-fghjk" }, timeoutMs: undefined }]);
    expect(d.invited.has("inv-1")).toBe(false);
    expect(messages()).toEqual(["worldinmotion: admitted newbox. Its messages are held for your approval; Trust on it in the Mesh view if it is your own."]);
  });

  it("says in the code box when admitting will trust the device, and only then", async () => {
    const { d } = deps(mesh(), async () => ({ device: "newbox", trusted: true }));
    fake.state.inputAnswers.push(undefined, undefined);
    await actions.admitRequest(d, { ...request, own: true });
    await actions.admitRequest(d, request);
    expect(box(0).prompt).toMatch(/ This invite was for one of your own devices: admitting newbox trusts its messages here\.$/);
    expect(box(1).prompt).not.toMatch(/own devices/);
  });

  it("says an own-device invite trusted the device on admit, and how to undo it", async () => {
    const { d, calls } = deps(mesh(), async () => ({ device: "newbox", trusted: true }));
    fake.state.inputAnswers.push("ABCDE-FGHJK");
    await actions.admitRequest(d, request);
    expect(calls.map((c) => c.op)).toEqual(["admit"]);
    expect(messages()).toEqual(["worldinmotion: admitted newbox. Trusted newbox. Untrust on it in the Mesh view (or wim devices untrust newbox) undoes it."]);
  });

  it("offers a request on someone else's invite, and admits it only when the person asks", async () => {
    const { d, calls } = deps();
    await actions.joinRequested(d, request);
    expect(messages()).toEqual(["worldinmotion: a device named newbox asks to join the mesh."]);
    expect(calls).toEqual([]);
    fake.state.messageAnswers.push("Admit...");
    fake.state.inputAnswers.push(undefined);
    await actions.joinRequested(d, request);
    expect(fake.state.inputBoxes.length).toBe(1);
    expect(calls).toEqual([]);
  });

  it("says a code that does not match, and any other failure", async () => {
    const mismatch = deps(mesh(), async () => Promise.reject(new RequestError("mismatch", "no")));
    fake.state.inputAnswers.push("AAAAA-AAAAA");
    await actions.admitRequest(mismatch.d, request);
    expect(messages().at(-1)).toBe("worldinmotion: that is not the comparison code of newbox's request. Check it on the new device; if it shows another code, do not admit it.");
    const gone = deps(mesh(), async () => Promise.reject(new RequestError("not_found", "no device named newbox is waiting to join")));
    fake.state.inputAnswers.push("AAAAA-AAAAA");
    await actions.admitRequest(gone.d, request);
    expect(messages().at(-1)).toBe("worldinmotion: could not admit newbox: not_found: no device named newbox is waiting to join");
  });

  it("picks a waiting device for Admit a Device..., or says none waits", async () => {
    const { d, calls } = deps();
    await actions.admitDevice(d);
    expect(messages()).toEqual(["worldinmotion: no device is waiting to join."]);
    d.store.apply({ type: "join", at: NOW, op: "add", request });
    fake.state.quickPickAnswers.push(() => undefined);
    await actions.admitDevice(d);
    const items = fake.state.quickPicks[0]!.items as { label: string; description: string; detail: string }[];
    expect(items[0]).toMatchObject({ label: "newbox", description: "dev-newbox", detail: expect.stringMatching(/^Asked /) });
    fake.state.quickPickAnswers.push((list) => list[0]);
    fake.state.inputAnswers.push("ABCDE-FGHJK");
    await actions.admitDevice(d);
    expect(calls[0]).toMatchObject({ op: "admit", args: { device: "newbox", code: "ABCDE-FGHJK" } });
    // Nothing is asked after the admit: the invite's record decided trust.
    expect(calls.length).toBe(1);
  });
});

describe("the joining side's trust questions", () => {
  const laptop = { name: "laptop", id: "dev-laptop" };
  it("asks about the admitting device first, then each other device on its own, naming who added it", async () => {
    const { d, calls } = deps(mesh(), async () => ({ policy: "deliver" }));
    fake.state.messageAnswers.push("Trust", actions.NOT_MINE, undefined);
    await actions.joinTrust(d, laptop, [laptop, { name: "desk", id: "dev-desk", added_by: "laptop" }, { name: "old", id: "dev-old" }]);
    expect(fake.state.messages.filter((m) => m.options !== undefined).map((m) => m.message)).toEqual([
      '"laptop" admitted this device. Is "laptop" your own device?',
      'The mesh also has "desk" (added by "laptop"). Is "desk" your own device?',
      'The mesh also has "old". Is "old" your own device?',
    ]);
    for (const m of fake.state.messages.filter((m) => m.options !== undefined)) expect(m).toMatchObject({ level: "warning", options: { modal: true }, items: ["Trust", "Not Mine"] });
    // Only laptop is trusted; desk is recorded as someone else's here; old is left as it is.
    expect(calls).toEqual([{ op: "trust", args: { device: "laptop", relayed: false }, timeoutMs: undefined }]);
    expect(messages()).toContain("worldinmotion: Trusted laptop. Untrust on it in the Mesh view (or wim devices untrust laptop) undoes it.");
    expect([...(d.notMine as Set<string>)]).toEqual(["dev-desk"]);
  });

  it("says first when the device that admitted this one did not make the invite, and asks about it like the rest", async () => {
    for (const [reason, said] of [
      ["not_issuer", 'worldinmotion: "bob" admitted this device, but the invite was made by another device. If you did not expect "bob" to admit it, it may be someone else\'s: it is asked about like any other device.'],
      ["no_issuer", 'worldinmotion: the invite code does not say which device made it (an older wim), so "bob", which admitted this device, is asked about like any other device.'],
    ] as const) {
      fake.reset();
      const { d, calls } = deps(mesh(), async () => ({ policy: "deliver" }));
      fake.state.messageAnswers.push(undefined, undefined);
      await actions.joinTrust(d, undefined, [{ name: "bob", id: "dev-bob" }, { name: "ann", id: "dev-ann" }], { name: "bob", id: "dev-bob", reason });
      expect(fake.state.messages[0]).toMatchObject({ level: "warning", message: said });
      expect(fake.state.messages.filter((m) => m.options !== undefined).map((m) => m.message)).toEqual(['The mesh also has "bob". Is "bob" your own device?', 'The mesh also has "ann". Is "ann" your own device?']);
      expect(fake.state.messages.some((m) => /admitted this device\. Is/.test(m.message))).toBe(false);
      expect(calls).toEqual([]);
    }
  });

  it("asks each device on its own for a client that names no approver, and says a failed trust", async () => {
    const { d } = deps(mesh(), async () => Promise.reject(new RequestError("not_found", "no device named a")));
    fake.state.messageAnswers.push("Trust");
    await actions.joinTrust(d, undefined, [{ name: "a", id: "dev-a" }]);
    expect(fake.state.messages[0]!.message).toBe('The mesh also has "a". Is "a" your own device?');
    expect(messages().at(-1)).toBe("worldinmotion: could not trust a: not_found: no device named a");
    await actions.joinTrust(d, undefined, []);
  });
});

describe("a device another device added", () => {
  const build: DeviceRow = { name: "build", id: "dev-build", role: "member", policy: "hold", self: false, added_by: "laptop" };

  it("offers Trust... (the trust modal) and Not Mine; dismissed, nothing changes", async () => {
    const { d, calls } = deps(mesh(), async () => ({ policy: "deliver" }));
    fake.state.messageAnswers.push(actions.TRUST_ASK, "Trust");
    await actions.thirdDevice(d, build);
    expect(fake.state.messages[0]).toMatchObject({ level: "info", message: "worldinmotion: laptop added build to this mesh. Is build your own device?", items: ["Trust...", "Not Mine"] });
    expect(fake.state.messages[1]).toMatchObject({ level: "warning", message: 'Trust the device "build"?', options: { modal: true } });
    expect(calls).toEqual([{ op: "trust", args: { device: "build", relayed: false }, timeoutMs: undefined }]);
    fake.state.messageAnswers.push(actions.NOT_MINE);
    await actions.thirdDevice(d, build);
    expect(d.notMine.has("dev-build")).toBe(true);
    fake.state.messageAnswers.push(undefined);
    await actions.thirdDevice(d, build);
    expect(calls).toHaveLength(1);
  });

  it("Review Trust... lists every other device; a trusted one offers Untrust, any other Trust... and Not Mine", async () => {
    const store = mesh();
    const { d, calls } = deps(store, async () => ({ policy: "hold" }));
    await actions.reviewTrust(deps(new Store()).d);
    expect(messages()).toEqual(["worldinmotion: no other devices in the mesh."]);
    store.apply({ type: "device", at: NOW, device: build });
    store.apply({ type: "device", at: NOW, device: { name: "buildbox", id: "dev-buildbox", role: "member", policy: "deliver-relayed", self: false } });
    d.notMine.add("dev-build");
    fake.state.quickPickAnswers.push(() => undefined);
    await actions.reviewTrust(d);
    const items = fake.state.quickPicks[0]!.items as { label: string; description: string; detail: string }[];
    expect(items.find((i) => i.label === "build")).toMatchObject({ description: "hold, added by laptop, not mine", detail: "dev-build" });
    const trusted = items.find((i) => i.description === "deliver-relayed")!;
    fake.state.quickPickAnswers.push((list) => list.find((i) => (i as { label: string }).label === trusted.label), (list) => list.find((i) => (i as { label: string }).label === "build"));
    fake.state.messageAnswers.push("Untrust", actions.NOT_MINE);
    await actions.reviewTrust(d);
    expect(calls).toEqual([{ op: "untrust", args: { device: trusted.label }, timeoutMs: undefined }]);
    await actions.reviewTrust(d);
    expect(fake.state.messages.at(-1)).toMatchObject({ message: "worldinmotion: is build your own device?", items: ["Trust...", "Not Mine"] });
  });
});

describe("Join with a Code...", () => {
  it("joins with a pasted code, never shown, and shows this device's comparison code", async () => {
    const { d, calls } = deps(inSetup(), async () => ({ device: { name: "fresh", id: "dev-fresh" }, code: "ABCDE-FGHJK" }));
    choose("way", "invite");
    fake.state.inputAnswers.push(" wim1_code ");
    await actions.joinMesh(d);
    expect(fake.state.quickPicks[0]).toMatchObject({ items: actions.JOIN_WAYS, options: { title: "Join with a code", ignoreFocusOut: true } });
    expect(actions.JOIN_WAYS.map((w) => w.label)).toEqual(["My other device is already in the mesh", "I have an invite code"]);
    expect(box()).toMatchObject({ title: "Join a mesh", password: true, ignoreFocusOut: true });
    expect(box().validateInput!("wim1_x")).toBeUndefined();
    expect(box().validateInput!(" WIM2-abcd")).toBeUndefined();
    expect(box().validateInput!("hello")).toBe("An invite code starts with wim2- (or wim1_)");
    expect(calls).toEqual([{ op: "join", args: { code: "wim1_code" }, timeoutMs: actions.JOIN_TIMEOUT_MS }]);
    expect(fake.state.messages[0]).toMatchObject({
      message: "worldinmotion: this device's comparison code is ABCDE-FGHJK",
      options: { modal: true, detail: expect.stringContaining("run wim devices admit fresh ABCDE-FGHJK there") },
    });
  });

  it("says the pairing way is not in this version yet, and sends nothing", async () => {
    const { d, calls } = deps(inSetup());
    choose("way", "pair");
    await actions.joinMesh(d);
    expect(messages()).toEqual([actions.PAIRING_LATER]);
    expect(fake.state.inputBoxes).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it("is only for a device in no mesh, and says when it is cancelled or fails", async () => {
    await actions.joinMesh(deps().d);
    expect(messages()).toEqual(["worldinmotion: this device is already in a mesh. To join another, run wim join <code> in a terminal."]);
    const { d, calls } = deps(inSetup(), async () => Promise.reject(new RequestError("input", "not an invite code (wim1_...)")));
    // Cancelled at the pick, then at the code.
    await actions.joinMesh(d);
    choose("way", "invite");
    fake.state.inputAnswers.push(undefined);
    await actions.joinMesh(d);
    expect(calls).toEqual([]);
    choose("way", "invite");
    fake.state.inputAnswers.push("wim1_bad");
    await actions.joinMesh(d);
    expect(messages().at(-1)).toBe("worldinmotion: could not join the mesh: input: not an invite code (wim1_...)");
  });
});

describe("Create a Mesh...", () => {
  const made = { device: { name: "laptop", id: "dev-laptop" }, mesh: "f4ke…", relay: "worldinmotion.distronode.com" };

  it("names the device, picks the hosted relay, confirms, creates, then opens the recovery terminal", async () => {
    const { d, calls } = deps(inSetup(), async () => made);
    let opened = 0;
    fake.state.inputAnswers.push(" laptop ");
    choose("relay", actions.HOSTED_RELAY);
    fake.state.messageAnswers.push("Create Mesh", "Show Recovery Code");
    await actions.createMesh(d, () => void (opened += 1));
    expect(box()).toMatchObject({ title: "Create a mesh: name this device", prompt: "Name this device. Its sessions get addresses like vscode@laptop. Lowercase letters, digits and hyphens.", ignoreFocusOut: true });
    expect(box().validateInput!("desk-2")).toBeUndefined();
    for (const bad of ["", "Laptop", "-x", "a b", "x".repeat(33)]) expect(box().validateInput!(bad)).toMatch(/^Lowercase letters/);
    expect(actions.RELAY_PICKS.map((p) => [p.label, "description" in p ? p.description : ""])).toEqual([
      ["Hosted relay (recommended)", "worldinmotion.distronode.com"],
      ["Another relay...", ""],
    ]);
    expect(fake.state.messages[0]).toMatchObject({
      level: "info",
      message: "Create a mesh with laptop as its admin?",
      options: {
        modal: true,
        detail:
          "On wss://worldinmotion.distronode.com. The relay passes encrypted messages on and cannot read them. It deletes a mesh nobody connects to for 30 days. Terms: docs/hosted-relay.md.\n\nNext comes your recovery code, shown once.",
      },
      items: ["Create Mesh"],
    });
    expect(calls).toEqual([{ op: "create", args: { name: "laptop", relay: actions.HOSTED_RELAY }, timeoutMs: actions.CREATE_TIMEOUT_MS }]);
    expect(fake.state.messages[1]).toMatchObject({
      message: "Mesh created. Store your recovery code now.",
      options: { modal: true, detail: "It is as powerful as this device. Keep it offline (a password manager or paper), never in a chat. It waits 10 minutes in a terminal only you see." },
      items: ["Show Recovery Code"],
    });
    expect(opened).toBe(1);
    // Nothing the client answered is a code, and nothing here showed one.
    expect(JSON.stringify(fake.state.messages)).not.toMatch(/wimrec/);
  });

  it("keeps a device's own name, takes another relay's URL, and offers the code again when the modal is dismissed", async () => {
    const store = new Store();
    store.apply({ type: "setup", at: NOW, version: "1", device: { name: "$(zap)desk", id: "dev-desk" } });
    const { d, calls } = deps(store, async () => made);
    let opened = 0;
    choose("relay", undefined);
    fake.state.inputAnswers.push(" ws://127.0.0.1:8787 ");
    fake.state.messageAnswers.push("Create Mesh", undefined, "Show Recovery Code");
    await actions.createMesh(d, () => void (opened += 1));
    // No name box: the device has keys and a name.
    expect(fake.state.inputBoxes.map((b) => b.title)).toEqual(["Create a mesh: the relay's URL"]);
    expect(box().validateInput!("wss://relay.example.com/x")).toBeUndefined();
    expect(box().validateInput!("https://relay.example.com")).toBe("A relay URL starts with wss:// (or ws:// for one on this machine)");
    expect(fake.state.messages[0]).toMatchObject({
      message: "Create a mesh with $ (zap)desk as its admin?",
      options: { detail: "On ws://127.0.0.1:8787. The relay passes encrypted messages on and cannot read them.\n\nNext comes your recovery code, shown once." },
    });
    expect(calls).toEqual([{ op: "create", args: { relay: "ws://127.0.0.1:8787" }, timeoutMs: actions.CREATE_TIMEOUT_MS }]);
    expect(fake.state.messages[2]).toMatchObject({ level: "warning", message: "worldinmotion: your recovery code waits 10 minutes, then it is gone.", items: ["Show Recovery Code"] });
    expect(opened).toBe(1);
    // Dismissed twice: no terminal.
    choose("relay", actions.HOSTED_RELAY);
    fake.state.messageAnswers.push("Create Mesh", undefined, undefined);
    await actions.createMesh(d, () => void (opened += 1));
    expect(opened).toBe(1);
  });

  it("stops at each cancel, and says a refusal", async () => {
    await actions.createMesh(deps().d, () => undefined);
    expect(messages()).toEqual(["worldinmotion: this device is already in a mesh. To create another, run wim mesh create in a terminal."]);
    const { d, calls } = deps(inSetup(), async () => Promise.reject(new RequestError("unauthorized", "the relay refused to create the mesh")));
    // The name box, the pick, the URL box and the modal.
    fake.state.inputAnswers.push(undefined);
    await actions.createMesh(d, () => undefined);
    fake.state.inputAnswers.push("laptop");
    await actions.createMesh(d, () => undefined);
    fake.state.inputAnswers.push("laptop", undefined);
    choose("relay", undefined);
    await actions.createMesh(d, () => undefined);
    fake.state.inputAnswers.push("laptop");
    choose("relay", actions.HOSTED_RELAY);
    fake.state.messageAnswers.push(undefined);
    await actions.createMesh(d, () => undefined);
    expect(calls).toEqual([]);
    fake.state.inputAnswers.push("laptop");
    choose("relay", actions.HOSTED_RELAY);
    fake.state.messageAnswers.push("Create Mesh");
    await actions.createMesh(d, () => undefined);
    expect(messages().at(-1)).toBe("worldinmotion: could not create the mesh: unauthorized: the relay refused to create the mesh");
    // The failed try may have made the device under that name: the retry asks for none and sends it again.
    expect(d.setupName).toBe("laptop");
    choose("relay", actions.HOSTED_RELAY);
    fake.state.messageAnswers.push("Create Mesh");
    const boxes = fake.state.inputBoxes.length;
    await actions.createMesh(d, () => undefined);
    expect(fake.state.inputBoxes).toHaveLength(boxes);
    expect(calls.at(-1)!.args).toEqual({ name: "laptop", relay: actions.HOSTED_RELAY });
    const plain = deps(inSetup(), async () => Promise.reject(new Error("gone")));
    fake.state.inputAnswers.push("laptop");
    choose("relay", actions.HOSTED_RELAY);
    fake.state.messageAnswers.push("Create Mesh");
    await actions.createMesh(plain.d, () => undefined);
    expect(messages().at(-1)).toBe("worldinmotion: could not create the mesh: gone");
  });
});
