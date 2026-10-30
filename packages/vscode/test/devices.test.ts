// Adding a device from VS Code: Add a Device... (an invite, copied with a button), the admit
// dialog where the person types the comparison code the new device shows, the trust question, and
// Join a Mesh... on a device in no mesh yet.

import { beforeEach, describe, expect, it } from "vitest";
import * as actions from "../src/actions.ts";
import { RequestError } from "../src/process.ts";
import type { JoinRow } from "../src/protocol.ts";
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

beforeEach(() => fake.reset());

describe("Add a Device...", () => {
  it("makes an invite and copies its code with a button, never showing it", async () => {
    const { d, calls } = deps(mesh(), async () => ({ code: "wim1_secret", invite: "inv-1", exp: NOW + 3_600_000 }));
    fake.state.messageAnswers.push("Copy Invite Code");
    await actions.addDevice(d);
    expect(calls).toEqual([{ op: "invite", args: {}, timeoutMs: undefined }]);
    expect(fake.state.clipboard).toBe("wim1_secret");
    expect(JSON.stringify(fake.state.messages)).not.toContain("wim1_secret");
    expect(fake.state.messages[0]!.options).toMatchObject({ modal: true, detail: expect.stringMatching(/^On the new device, in a terminal: wim join <code>.*never through an agent/) });
    expect(messages().at(-1)).toBe("worldinmotion: invite code copied.");
    expect(d.invited.has("inv-1")).toBe(true);
    // Dismissed: nothing is copied.
    fake.state.clipboard = undefined;
    await actions.addDevice(d);
    expect(fake.state.clipboard).toBeUndefined();
  });

  it("offers the full code too when the invite has a short one, for an older device", async () => {
    const short = "wim2-ABCD-EFGH-JKMN-PQRS-TVWX-YZ01";
    const { d } = deps(mesh(), async () => ({ code: short, invite: "inv-2", exp: NOW + 3_600_000, full: "wim1_secret" }));
    fake.state.messageAnswers.push("Copy Invite Code");
    await actions.addDevice(d);
    expect(fake.state.messages[0]!.items).toEqual(["Copy Invite Code", "Copy Full Code"]);
    expect(fake.state.messages[0]!.options).toMatchObject({ detail: expect.stringMatching(/older needs the full code instead\.$/) });
    expect(fake.state.clipboard).toBe(short);
    fake.state.messageAnswers.push("Copy Full Code");
    await actions.addDevice(d);
    expect(fake.state.clipboard).toBe("wim1_secret");
    expect(messages().at(-1)).toBe("worldinmotion: full invite code copied.");
    expect(JSON.stringify(fake.state.messages)).not.toMatch(/wim1_secret|wim2-ABCD/);
  });

  it("says why it cannot invite: no mesh yet, or the client refused", async () => {
    await actions.addDevice(deps(inSetup()).d);
    expect(messages()).toEqual(["worldinmotion: this device is in no mesh yet. Join one first (worldinmotion: Join a Mesh...)."]);
    await actions.addDevice(deps(mesh(), async () => Promise.reject(new RequestError("not_admin", "only an admin device can invite"))).d);
    expect(messages().at(-1)).toBe("worldinmotion: could not make an invite: not_admin: only an admin device can invite");
  });
});

describe("admitting a device", () => {
  it("asks for the code at once for its own invite, admits, and asks about trust", async () => {
    const { d, calls } = deps();
    d.invited.add("inv-1");
    fake.state.inputAnswers.push(" abcde-fghjk ");
    fake.state.messageAnswers.push("Trust");
    await actions.joinRequested(d, request);
    expect(box()).toMatchObject({ title: "Add newbox to the mesh", placeHolder: "XXXXX-XXXXX", ignoreFocusOut: true });
    expect(box().prompt).toMatch(/Type the comparison code the new device shows \(device id dev-newbox\)/);
    expect(box().validateInput!("ABCDE-FGHJK")).toBeUndefined();
    expect(box().validateInput!("abcdefghjk")).toBeUndefined();
    expect(box().validateInput!("ABCDE")).toBe("10 letters and digits, as the new device shows them");
    expect(calls).toEqual([
      { op: "admit", args: { device: "newbox", code: "abcde-fghjk" }, timeoutMs: undefined },
      { op: "trust", args: { device: "newbox", relayed: false }, timeoutMs: undefined },
    ]);
    expect(d.invited.has("inv-1")).toBe(false);
    expect(fake.state.messages.find((m) => m.message === 'Is "newbox" your own device?')!.options).toMatchObject({ modal: true });
    expect(messages().at(-1)).toBe("worldinmotion: newbox trusted.");
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
    // Not trusted: the trust question was dismissed.
    expect(calls.length).toBe(1);
  });
});

describe("the trust question", () => {
  it("names every device, trusts each, and stops at a failure", async () => {
    await actions.askTrust(deps().d, []);
    expect(fake.state.messages).toEqual([]);
    const { d, calls } = deps(mesh(), async (c) => (c.args["device"] === "b" ? Promise.reject(new RequestError("not_found", "no device named b")) : { policy: "deliver" }));
    fake.state.messageAnswers.push("Trust");
    await actions.askTrust(d, ["a", "b", "c"]);
    expect(fake.state.messages[0]!.message).toBe('Are "a", "b" and "c" your own devices?');
    expect(calls.map((c) => c.args["device"])).toEqual(["a", "b"]);
    expect(messages().at(-1)).toBe("worldinmotion: could not trust b: not_found: no device named b");
  });
});

describe("Join a Mesh...", () => {
  it("joins with a pasted code, never shown, and shows this device's comparison code", async () => {
    const { d, calls } = deps(inSetup(), async () => ({ device: { name: "fresh", id: "dev-fresh" }, code: "ABCDE-FGHJK" }));
    fake.state.inputAnswers.push(" wim1_code ");
    await actions.joinMesh(d);
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

  it("is only for a device in no mesh, and says when it is cancelled or fails", async () => {
    await actions.joinMesh(deps().d);
    expect(messages()).toEqual(["worldinmotion: this device is already in a mesh. To join another, run wim join <code> in a terminal."]);
    const { d, calls } = deps(inSetup(), async () => Promise.reject(new RequestError("input", "not an invite code (wim1_...)")));
    fake.state.inputAnswers.push(undefined);
    await actions.joinMesh(d);
    expect(calls).toEqual([]);
    fake.state.inputAnswers.push("wim1_bad");
    await actions.joinMesh(d);
    expect(messages().at(-1)).toBe("worldinmotion: could not join the mesh: input: not an invite code (wim1_...)");
  });
});
