// Runs inside the Extension Development Host, with the fake events process in setup mode (a
// device in no mesh yet). Checks that Create a Mesh... sends `create`, opens the recovery
// terminal running `wim recovery show --wait`, and that the client starts again in the mesh on
// `created`. The dialogs are real VS Code ones that nothing here can click, so each is stubbed for
// this one run and what it was asked to show is checked.

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vscode = require("vscode");

async function waitFor(what, check, ms = 20_000) {
  const until = Date.now() + ms;
  for (;;) {
    let last;
    try {
      if (await check()) return;
    } catch (e) {
      last = e;
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const requests = () =>
  readFileSync(process.env.WIM_FAKE_LOG, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));

exports.run = async function run() {
  const ext = vscode.extensions.getExtension("distronode.worldinmotion");
  assert.ok(ext, "the extension is installed in the development host");
  await waitFor("VS Code to activate the extension at startup", () => ext.isActive);
  const api = await ext.activate();
  await waitFor("setup mode", () => api.store.setup !== undefined);
  console.log("smoke(setup): the client runs in setup mode");
  // The Mesh view is empty, so VS Code shows its welcome content.
  assert.equal(api.mesh.getChildren().length, 0);
  await vscode.commands.executeCommand("worldinmotion.mesh.focus");

  const w = vscode.window;
  const original = { showInputBox: w.showInputBox, showQuickPick: w.showQuickPick, showInformationMessage: w.showInformationMessage };
  const asked = { boxes: [], picks: [], modals: [] };
  w.showInputBox = (options) => (asked.boxes.push(options), Promise.resolve("laptop"));
  w.showQuickPick = (items, options) => (asked.picks.push({ items, options }), Promise.resolve(items[0]));
  w.showInformationMessage = (message, options, ...items) => (asked.modals.push({ message, options, items }), Promise.resolve(items[0]));
  try {
    await vscode.commands.executeCommand("worldinmotion.createMesh");
  } finally {
    Object.assign(w, original);
  }
  assert.equal(asked.boxes[0].title, "Create a mesh: name this device");
  assert.equal(asked.picks[0].items[0].label, "Hosted relay (recommended)");
  assert.deepEqual(
    asked.modals.map((m) => [m.message, m.options.modal, m.items]),
    [
      ["Create a mesh with laptop as its admin?", true, ["Create Mesh"]],
      ["Mesh created. Store your recovery code now.", true, ["Show Recovery Code"]],
    ],
  );
  assert.deepEqual(
    requests().find((r) => r.op === "create").args,
    { name: "laptop", relay: "wss://worldinmotion.distronode.com" },
  );
  console.log("smoke(setup): Create a Mesh... sent create after its dialogs");

  // The recovery terminal runs the same client with `recovery show --wait`; Enter closes it.
  await waitFor("the recovery terminal", () => w.terminals.some((t) => t.name === "worldinmotion recovery code"));
  const terminal = w.terminals.find((t) => t.name === "worldinmotion recovery code");
  assert.deepEqual(terminal.creationOptions.shellArgs.slice(1), ["recovery", "show", "--wait"]);
  await waitFor("the fake to say it shows the code", () => requests().some((r) => r.op === "recovery"));
  terminal.sendText("");
  await waitFor("the recovery terminal to end", () => terminal.exitStatus !== undefined);
  assert.equal(terminal.exitStatus.code, 0);
  console.log("smoke(setup): the recovery terminal ran wim recovery show --wait");

  // `created` restarts the client, which now runs in the mesh.
  await waitFor("the client to start again in the mesh", () => api.store.hello !== undefined && api.store.setup === undefined);
  await waitFor("the Mesh tree", () => api.mesh.getChildren().length === 2);
  console.log("smoke(setup): the client restarted in the mesh after created");
};
